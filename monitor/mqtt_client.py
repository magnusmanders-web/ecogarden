import json
import logging
import threading
import time

import paho.mqtt.client as mqtt

log = logging.getLogger(__name__)


class MQTTClient:
    """MQTT client for EcoGarden sensor data and monitor events."""

    def __init__(self, config):
        self.config = config
        self.broker = config["mqtt"]["broker"]
        self.port = config["mqtt"]["port"]
        self.ecogarden_topic = config["mqtt"]["ecogarden_topic"]
        self.publish_topic = config["mqtt"]["publish_topic"]

        self._sensor_data = {"lux": None, "temp_c": None}
        self._lock = threading.Lock()
        self._connected = False

        self.client = mqtt.Client(
            client_id="ecogarden-monitor",
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        )
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect

    def _on_connect(self, client, userdata, flags, rc, properties=None):
        if rc == 0:
            log.info("Connected to MQTT broker %s:%d", self.broker, self.port)
            self._connected = True
            client.subscribe(self.ecogarden_topic)
            log.info("Subscribed to %s", self.ecogarden_topic)
        else:
            log.error("MQTT connection failed with code %d", rc)

    def _on_disconnect(self, client, userdata, flags, rc, properties=None):
        self._connected = False
        if rc != 0:
            log.warning("Unexpected MQTT disconnect (rc=%d), will reconnect", rc)

    def _on_message(self, client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
        except (json.JSONDecodeError, UnicodeDecodeError):
            return

        with self._lock:
            if "lux" in payload:
                self._sensor_data["lux"] = payload["lux"]
            if "light" in payload:
                # EcoGarden sends light as 0.0-1.0, convert to approximate lux
                # TSL2561 max is ~40000 lux, sensor value is normalized
                self._sensor_data["lux"] = round(payload["light"] * 40000, 1)
            if "temp" in payload:
                self._sensor_data["temp_c"] = payload["temp"]
            if "temperature" in payload:
                self._sensor_data["temp_c"] = payload["temperature"]

    def start(self):
        """Connect to broker and start the network loop in a background thread."""
        try:
            self.client.connect(self.broker, self.port, keepalive=60)
            self.client.loop_start()
            log.info("MQTT client started")

            # Start heartbeat thread
            thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
            thread.start()
        except Exception as e:
            log.error("Failed to connect to MQTT broker: %s", e)
            log.info("Monitor will run without MQTT sensor data")

    def stop(self):
        """Disconnect from broker."""
        self.client.loop_stop()
        self.client.disconnect()

    def get_latest_sensor_data(self):
        """Return a copy of the latest sensor readings."""
        with self._lock:
            return dict(self._sensor_data)

    def is_connected(self):
        return self._connected

    def publish_analysis(self, analysis, plants):
        """Publish analysis results to MQTT."""
        if not self._connected:
            return

        # Find plant closest to harvest
        next_harvest = None
        min_days = float("inf")
        for p in analysis.get("plants", []):
            days = p.get("days_to_harvest")
            if isinstance(days, (int, float)) and days < min_days:
                min_days = days
                next_harvest = f"{p['name']} (~{int(days)} days)"
            elif isinstance(days, str) and "ready" in days.lower():
                next_harvest = f"{p['name']} (ready now!)"
                min_days = 0

        payload = {
            "plant_count": len(plants),
            "overall_health": analysis.get("overall_health", 0),
            "days_since_planted": None,
            "next_harvest": next_harvest or "unknown",
            "alerts": analysis.get("alerts", []),
        }

        # Calculate days since earliest planting
        from knowledge import get_plant_age
        ages = [get_plant_age(p["planted_date"]) for p in plants]
        if ages:
            payload["days_since_planted"] = max(ages)

        try:
            self.client.publish(
                self.publish_topic,
                json.dumps(payload),
                retain=True,
            )
            log.info("Published analysis to MQTT")
        except Exception as e:
            log.error("Failed to publish analysis: %s", e)

    def _heartbeat_loop(self):
        """Publish heartbeat every 5 minutes."""
        while True:
            time.sleep(300)
            if self._connected:
                try:
                    self.client.publish(
                        self.publish_topic + "/heartbeat",
                        json.dumps({"status": "online", "timestamp": time.time()}),
                    )
                except Exception:
                    pass
