import os
import yaml


def load_config(path="config.yaml"):
    """Load and validate configuration from YAML file."""
    if not os.path.isabs(path):
        path = os.path.join(os.path.dirname(__file__), path)

    with open(path) as f:
        config = yaml.safe_load(f)

    # Validate required sections
    required = ["plants", "capture", "mqtt", "storage"]
    for key in required:
        if key not in config:
            raise ValueError(f"Missing required config section: {key}")

    # Validate plants have required fields
    for i, plant in enumerate(config["plants"]):
        for field in ["name", "species", "planted_date", "position"]:
            if field not in plant:
                raise ValueError(f"Plant {i} missing required field: {field}")

    # Set defaults
    config.setdefault("timelapse", {})
    config["timelapse"].setdefault("daily_time", "22:30")
    config["timelapse"].setdefault("weekly_day", "sunday")
    config["timelapse"].setdefault("weekly_time", "23:00")
    config["timelapse"].setdefault("fps", 3)
    config["timelapse"].setdefault("min_photos", 5)

    config.setdefault("analysis", {})
    config["analysis"].setdefault("times", ["10:00", "18:00"])

    config.setdefault("web", {})
    config["web"].setdefault("host", "0.0.0.0")
    config["web"].setdefault("port", 8080)

    config["storage"].setdefault("photo_dir", "photos")
    config["storage"].setdefault("timelapse_dir", "timelapse")
    config["storage"].setdefault("analysis_dir", "analysis")
    config["storage"].setdefault("retention_days", 30)

    # Resolve storage paths relative to monitor directory
    base_dir = os.path.dirname(__file__)
    for key in ["photo_dir", "timelapse_dir", "analysis_dir"]:
        if not os.path.isabs(config["storage"][key]):
            config["storage"][key] = os.path.join(base_dir, config["storage"][key])

    # Load InfluxDB token from environment (never hardcode secrets in config)
    influx = config.get("influxdb")
    if influx:
        token = os.environ.get("INFLUXDB_TOKEN", influx.get("token", ""))
        influx["token"] = token

    return config
