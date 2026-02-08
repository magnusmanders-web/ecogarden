import logging
import os
import subprocess

from capture import get_photos_for_date

log = logging.getLogger(__name__)


def generate_daily_timelapse(config, date_str):
    """Generate a timelapse video from a day's photos.

    Args:
        config: App config dict.
        date_str: Date string (YYYY-MM-DD).

    Returns:
        Output file path, or None if skipped.
    """
    photos = get_photos_for_date(config, date_str)
    min_photos = config["timelapse"].get("min_photos", 5)

    if len(photos) < min_photos:
        log.info("Skipping timelapse for %s: only %d photos (need %d)",
                 date_str, len(photos), min_photos)
        return None

    output_dir = os.path.join(config["storage"]["timelapse_dir"], "daily")
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"{date_str}.mp4")

    fps = config["timelapse"].get("fps", 3)

    # Create a temporary file list for ffmpeg concat demuxer
    list_path = os.path.join(output_dir, f".{date_str}_files.txt")
    try:
        with open(list_path, "w") as f:
            for photo in photos:
                f.write(f"file '{os.path.abspath(photo)}'\n")
                f.write(f"duration {1.0 / fps}\n")
            # Repeat last frame to avoid ffmpeg cutting it short
            f.write(f"file '{os.path.abspath(photos[-1])}'\n")

        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", list_path,
                "-vf", f"fps={fps},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1",
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "28",
                "-pix_fmt", "yuv420p",
                output_path,
            ],
            capture_output=True,
            timeout=300,
        )

        if result.returncode != 0:
            log.error("ffmpeg failed: %s", result.stderr.decode(errors="replace"))
            return None

        log.info("Generated daily timelapse: %s (%d photos)", output_path, len(photos))
        return output_path

    finally:
        if os.path.exists(list_path):
            os.remove(list_path)


def generate_weekly_timelapse(config, year, week):
    """Generate a weekly timelapse from noon photos of each day.

    Args:
        config: App config dict.
        year: ISO year.
        week: ISO week number.

    Returns:
        Output file path, or None if skipped.
    """
    from datetime import date, timedelta

    # Find the Monday of this ISO week
    jan4 = date(year, 1, 4)
    start_of_week1 = jan4 - timedelta(days=jan4.isoweekday() - 1)
    monday = start_of_week1 + timedelta(weeks=week - 1)

    noon_photos = []
    for day_offset in range(7):
        day = monday + timedelta(days=day_offset)
        date_str = day.strftime("%Y-%m-%d")
        photos = get_photos_for_date(config, date_str)

        # Find the photo closest to noon
        best = None
        best_diff = float("inf")
        for p in photos:
            fname = os.path.basename(p)
            # Parse YYYY-MM-DD_HH-MM.jpg
            try:
                parts = fname.replace(".jpg", "").split("_")
                time_parts = parts[-1].split("-")
                hour = int(time_parts[0])
                minute = int(time_parts[1])
                diff = abs((hour * 60 + minute) - 720)  # 720 = noon
                if diff < best_diff:
                    best_diff = diff
                    best = p
            except (IndexError, ValueError):
                continue
        if best:
            noon_photos.append(best)

    min_photos = config["timelapse"].get("min_photos", 5)
    if len(noon_photos) < min_photos:
        log.info("Skipping weekly timelapse for %d-W%02d: only %d photos",
                 year, week, len(noon_photos))
        return None

    output_dir = os.path.join(config["storage"]["timelapse_dir"], "weekly")
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"{year}-W{week:02d}.mp4")

    fps = config["timelapse"].get("fps", 3)

    list_path = os.path.join(output_dir, f".{year}-W{week:02d}_files.txt")
    try:
        with open(list_path, "w") as f:
            for photo in noon_photos:
                f.write(f"file '{os.path.abspath(photo)}'\n")
                f.write(f"duration {1.0 / fps}\n")
            f.write(f"file '{os.path.abspath(noon_photos[-1])}'\n")

        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", list_path,
                "-vf", f"fps={fps},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1",
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "28",
                "-pix_fmt", "yuv420p",
                output_path,
            ],
            capture_output=True,
            timeout=300,
        )

        if result.returncode != 0:
            log.error("ffmpeg failed: %s", result.stderr.decode(errors="replace"))
            return None

        log.info("Generated weekly timelapse: %s (%d photos)", output_path, len(noon_photos))
        return output_path

    finally:
        if os.path.exists(list_path):
            os.remove(list_path)


def get_available_timelapses(config):
    """List available timelapse videos.

    Returns:
        {"daily": ["2026-02-08.mp4", ...], "weekly": ["2026-W06.mp4", ...]}
    """
    result = {"daily": [], "weekly": []}

    for kind in ("daily", "weekly"):
        d = os.path.join(config["storage"]["timelapse_dir"], kind)
        if os.path.isdir(d):
            result[kind] = sorted(
                [f for f in os.listdir(d) if f.endswith(".mp4")],
                reverse=True,
            )

    return result
