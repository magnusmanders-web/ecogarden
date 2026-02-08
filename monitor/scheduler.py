import logging
import threading
import time
from datetime import datetime

import schedule

from capture import capture_photo
from timelapse import generate_daily_timelapse, generate_weekly_timelapse
from analyzer import analyze_plants
from cleanup import run_cleanup

log = logging.getLogger(__name__)


def _is_capture_hour(config):
    """Check if current hour is within configured capture window."""
    hour = datetime.now().hour
    return config["capture"]["start_hour"] <= hour < config["capture"]["end_hour"]


def _capture_job(config, state):
    """Capture a photo if within scheduled hours."""
    if not _is_capture_hour(config):
        return
    path = capture_photo(config)
    if path:
        state["last_capture"] = path


def _analysis_job(config, state):
    """Run AI plant analysis."""
    try:
        analyze_plants(config, state)
    except Exception as e:
        log.error("Analysis failed: %s", e)


def _daily_timelapse_job(config):
    """Generate timelapse for today."""
    try:
        date_str = datetime.now().strftime("%Y-%m-%d")
        generate_daily_timelapse(config, date_str)
    except Exception as e:
        log.error("Daily timelapse failed: %s", e)


def _weekly_timelapse_job(config):
    """Generate weekly timelapse."""
    try:
        now = datetime.now()
        year, week, _ = now.isocalendar()
        generate_weekly_timelapse(config, year, week)
    except Exception as e:
        log.error("Weekly timelapse failed: %s", e)


def _cleanup_job(config):
    """Run storage cleanup."""
    try:
        run_cleanup(config)
    except Exception as e:
        log.error("Cleanup failed: %s", e)


def start_scheduler(config, state):
    """Start the scheduler in a background thread."""
    interval = config["capture"].get("interval_minutes", 30)

    # Photo capture
    schedule.every(interval).minutes.do(_capture_job, config, state)

    # AI analysis at configured times
    for t in config["analysis"]["times"]:
        schedule.every().day.at(t).do(_analysis_job, config, state)

    # Daily timelapse
    daily_time = config["timelapse"]["daily_time"]
    schedule.every().day.at(daily_time).do(_daily_timelapse_job, config)

    # Weekly timelapse
    weekly_day = config["timelapse"]["weekly_day"]
    weekly_time = config["timelapse"]["weekly_time"]
    getattr(schedule.every(), weekly_day).at(weekly_time).do(
        _weekly_timelapse_job, config
    )

    # Daily cleanup at 01:00
    schedule.every().day.at("01:00").do(_cleanup_job, config)

    def _run():
        log.info("Scheduler started (capture every %d min, %s-%s)",
                 interval,
                 f"{config['capture']['start_hour']:02d}:00",
                 f"{config['capture']['end_hour']:02d}:00")
        while True:
            schedule.run_pending()
            time.sleep(30)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()

    # Take an initial capture if within hours
    if _is_capture_hour(config):
        _capture_job(config, state)

    return thread
