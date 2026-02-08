#!/usr/bin/env python3
"""EcoGarden Plant Monitor - Main entry point."""

import logging
import os
import sys

from config import load_config
from scheduler import start_scheduler
from mqtt_client import MQTTClient
from web import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("ecogarden-monitor")


def main():
    config = load_config()

    # Shared state between modules
    state = {
        "last_capture": None,
        "mqtt_client": None,
    }

    # Ensure storage directories exist
    for key in ["photo_dir", "timelapse_dir", "analysis_dir"]:
        os.makedirs(config["storage"][key], exist_ok=True)
    os.makedirs(os.path.join(config["storage"]["timelapse_dir"], "daily"), exist_ok=True)
    os.makedirs(os.path.join(config["storage"]["timelapse_dir"], "weekly"), exist_ok=True)

    # Start MQTT client
    mqtt = MQTTClient(config)
    mqtt.start()
    state["mqtt_client"] = mqtt

    # Start scheduler (capture, timelapse, analysis, cleanup)
    start_scheduler(config, state)

    # Start Flask web server
    app = create_app(config, state)
    log.info("Starting web dashboard on %s:%d", config["web"]["host"], config["web"]["port"])
    app.run(
        host=config["web"]["host"],
        port=config["web"]["port"],
        threaded=True,
    )


if __name__ == "__main__":
    main()
