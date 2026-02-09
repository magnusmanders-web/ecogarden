import logging
import os
import shutil
from datetime import date, datetime, timedelta

log = logging.getLogger(__name__)


def run_cleanup(config):
    """Delete photos older than retention period, keeping noon shots as archive."""
    retention_days = config["storage"].get("retention_days", 30)
    photo_dir = config["storage"]["photo_dir"]

    if not os.path.isdir(photo_dir):
        return

    cutoff = date.today() - timedelta(days=retention_days)
    cleaned_count = 0
    kept_count = 0

    for date_dir_name in os.listdir(photo_dir):
        date_path = os.path.join(photo_dir, date_dir_name)
        if not os.path.isdir(date_path):
            continue

        try:
            dir_date = datetime.strptime(date_dir_name, "%Y-%m-%d").date()
        except ValueError:
            continue

        if dir_date >= cutoff:
            continue

        # Find the noon photo to keep
        photos = sorted(os.listdir(date_path))
        noon_photo = _find_noon_photo(photos)

        for photo in photos:
            photo_path = os.path.join(date_path, photo)
            if photo == noon_photo:
                kept_count += 1
                continue
            os.remove(photo_path)
            cleaned_count += 1

        # Remove directory if only noon shot (or empty)
        remaining = os.listdir(date_path)
        if not remaining:
            os.rmdir(date_path)

    if cleaned_count > 0:
        log.info("Cleanup: removed %d old photos, kept %d noon archives", cleaned_count, kept_count)


def _find_noon_photo(photo_filenames):
    """Find the photo closest to noon from a list of filenames."""
    best = None
    best_diff = float("inf")

    for fname in photo_filenames:
        if not fname.endswith(".jpg"):
            continue
        try:
            parts = fname.replace(".jpg", "").split("_")
            time_parts = parts[-1].split("-")
            hour = int(time_parts[0])
            minute = int(time_parts[1])
            diff = abs((hour * 60 + minute) - 720)
            if diff < best_diff:
                best_diff = diff
                best = fname
        except (IndexError, ValueError):
            continue

    return best


def get_storage_stats(config):
    """Get storage usage statistics for the dashboard."""
    stats = {
        "photos": {"count": 0, "size_mb": 0, "days": 0},
        "timelapse": {"daily": 0, "weekly": 0, "size_mb": 0},
        "analysis": {"count": 0},
    }

    # Photos
    photo_dir = config["storage"]["photo_dir"]
    if os.path.isdir(photo_dir):
        date_dirs = [d for d in os.listdir(photo_dir)
                     if os.path.isdir(os.path.join(photo_dir, d))]
        stats["photos"]["days"] = len(date_dirs)
        for dd in date_dirs:
            dp = os.path.join(photo_dir, dd)
            for f in os.listdir(dp):
                fp = os.path.join(dp, f)
                if f.endswith(".jpg"):
                    stats["photos"]["count"] += 1
                    stats["photos"]["size_mb"] += os.path.getsize(fp) / (1024 * 1024)

    # Timelapse
    tl_dir = config["storage"]["timelapse_dir"]
    for kind in ("daily", "weekly"):
        kd = os.path.join(tl_dir, kind)
        if os.path.isdir(kd):
            files = [f for f in os.listdir(kd) if f.endswith(".mp4")]
            stats["timelapse"][kind] = len(files)
            for f in files:
                stats["timelapse"]["size_mb"] += os.path.getsize(os.path.join(kd, f)) / (1024 * 1024)

    # Analysis
    analysis_dir = config["storage"]["analysis_dir"]
    if os.path.isdir(analysis_dir):
        stats["analysis"]["count"] = len(
            [f for f in os.listdir(analysis_dir) if f.endswith(".json")]
        )

    stats["photos"]["size_mb"] = round(stats["photos"]["size_mb"], 1)
    stats["timelapse"]["size_mb"] = round(stats["timelapse"]["size_mb"], 1)

    # Totals and forecast
    total_mb = stats["photos"]["size_mb"] + stats["timelapse"]["size_mb"]
    stats["total_size_mb"] = round(total_mb, 1)
    stats["max_storage_mb"] = config["storage"].get("max_storage_mb", 8192)

    days_tracked = stats["photos"]["days"]
    if days_tracked > 0:
        stats["daily_avg_mb"] = round(total_mb / days_tracked, 1)
        remaining = stats["max_storage_mb"] - total_mb
        if stats["daily_avg_mb"] > 0 and remaining > 0:
            stats["forecast_days_to_full"] = int(remaining / stats["daily_avg_mb"])
        else:
            stats["forecast_days_to_full"] = None
    else:
        stats["daily_avg_mb"] = 0
        stats["forecast_days_to_full"] = None

    return stats
