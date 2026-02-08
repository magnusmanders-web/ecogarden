import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)

_client = None
_write_api = None


def _get_write_api(config):
    """Lazy-initialize the InfluxDB write API."""
    global _client, _write_api
    if _write_api is not None:
        return _write_api

    influx_config = config.get("influxdb")
    if not influx_config:
        log.warning("InfluxDB not configured, skipping writes")
        return None

    try:
        from influxdb_client import InfluxDBClient
        from influxdb_client.client.write_api import SYNCHRONOUS

        _client = InfluxDBClient(
            url=influx_config["url"],
            token=influx_config["token"],
            org=influx_config["org"],
        )
        _write_api = _client.write_api(write_options=SYNCHRONOUS)
        log.info("Connected to InfluxDB at %s", influx_config["url"])
        return _write_api
    except Exception as e:
        log.error("Failed to connect to InfluxDB: %s", e)
        return None


def write_health_scores(config, analysis):
    """Write plant health scores to InfluxDB.

    Args:
        config: App config dict.
        analysis: Analysis result dict with 'plants' list.
    """
    write_api = _get_write_api(config)
    if not write_api:
        return

    bucket = config["influxdb"]["bucket"]
    org = config["influxdb"]["org"]

    from influxdb_client import Point

    try:
        for plant in analysis.get("plants", []):
            point = (
                Point("plant_health")
                .tag("plant_name", plant["name"])
                .tag("growth_stage", plant.get("observed_stage", "unknown"))
                .field("health_score", plant.get("health_score", 0))
                .time(datetime.now(timezone.utc))
            )

            days_to_harvest = plant.get("days_to_harvest")
            if isinstance(days_to_harvest, (int, float)):
                point = point.field("days_to_harvest", int(days_to_harvest))

            write_api.write(bucket=bucket, org=org, record=point)

        # Write overall health
        overall = analysis.get("overall_health")
        if overall is not None:
            point = (
                Point("plant_health")
                .tag("plant_name", "_overall")
                .field("health_score", overall)
                .time(datetime.now(timezone.utc))
            )
            write_api.write(bucket=bucket, org=org, record=point)

        log.info("Wrote health scores to InfluxDB")
    except Exception as e:
        log.error("Failed to write to InfluxDB: %s", e)
