import logging
import os
import re
import threading

from flask import Flask, Response, jsonify, render_template, request, send_file

log = logging.getLogger(__name__)


def create_app(config, state):
    """Create and configure the Flask app."""
    app = Flask(
        __name__,
        template_folder=os.path.join(os.path.dirname(__file__), "templates"),
        static_folder=os.path.join(os.path.dirname(__file__), "static"),
    )

    @app.route("/")
    def index():
        import time
        return render_template("index.html", v=int(time.time()))

    @app.route("/api/status")
    def api_status():
        import json as _json
        import urllib.request

        mqtt = state.get("mqtt_client")
        sensors = mqtt.get_latest_sensor_data() if mqtt else {}

        # Fallback: fetch temperature directly from device if MQTT has no data
        if sensors.get("temp_c") is None:
            try:
                with urllib.request.urlopen(
                    f"http://{config['ecogarden']['device_ip']}/hooks/water_temperature",
                    timeout=3,
                ) as resp:
                    sensors["temp_c"] = _json.loads(resp.read()).get("value")
            except Exception:
                pass

        # Load latest analysis
        from analyzer import _load_previous_analysis
        analysis = _load_previous_analysis(config)

        # Build plant info
        from knowledge import get_growth_stage, get_plant_age, load_herbs, get_care_advice
        herbs = load_herbs()
        plants = []
        for plant in config["plants"]:
            age = get_plant_age(plant["planted_date"])
            stage, progress = get_growth_stage(plant["species"], age)
            herb = herbs.get(plant["species"], {})

            plant_analysis = None
            if analysis:
                for pa in analysis.get("plants", []):
                    if pa["name"] == plant["name"]:
                        plant_analysis = pa
                        break

            advice = get_care_advice(
                plant["species"], age,
                temp_c=sensors.get("temp_c"),
            )

            plants.append({
                "name": plant["name"],
                "species": plant["species"],
                "position": plant["position"],
                "planted_date": plant["planted_date"],
                "age_days": age,
                "growth_stage": stage,
                "stage_progress": progress,
                "harvest_range": herb.get("days_to_harvest", [60, 90]),
                "harvest_tips": herb.get("harvest_tips", ""),
                "health_score": plant_analysis["health_score"] if plant_analysis else None,
                "observations": plant_analysis["observations"] if plant_analysis else None,
                "concerns": plant_analysis.get("concerns", "") if plant_analysis else None,
                "days_to_harvest": plant_analysis.get("days_to_harvest") if plant_analysis else None,
                "advice": advice,
            })

        return jsonify({
            "plants": plants,
            "sensors": sensors,
            "mqtt_connected": mqtt.is_connected() if mqtt else False,
            "analysis_date": analysis.get("date") if analysis else None,
            "overall_health": analysis.get("overall_health") if analysis else None,
            "summary": analysis.get("summary") if analysis else None,
            "alerts": analysis.get("alerts", []) if analysis else [],
        })

    @app.route("/api/photos/<date_str>")
    def api_photos(date_str):
        from capture import get_photos_for_date
        photos = get_photos_for_date(config, date_str)
        return jsonify([
            {
                "filename": os.path.basename(p),
                "url": f"/photos/{date_str}/{os.path.basename(p)}",
                "time": os.path.basename(p).replace(".jpg", "").split("_")[-1].replace("-", ":"),
            }
            for p in photos
        ])

    @app.route("/api/photos/latest")
    def api_photos_latest():
        from capture import get_latest_photo
        photo = get_latest_photo(config)
        if not photo:
            return jsonify({"error": "No photos available"}), 404

        date_str = os.path.basename(os.path.dirname(photo))
        filename = os.path.basename(photo)
        return jsonify({
            "filename": filename,
            "url": f"/photos/{date_str}/{filename}",
            "date": date_str,
        })

    @app.route("/api/analysis/latest")
    def api_analysis_latest():
        from analyzer import _load_previous_analysis
        analysis = _load_previous_analysis(config)
        if not analysis:
            return jsonify({"error": "No analysis available"}), 404
        return jsonify(analysis)

    @app.route("/api/plants")
    def api_plants():
        from knowledge import load_herbs
        herbs = load_herbs()
        result = {}
        for plant in config["plants"]:
            species = plant["species"]
            herb = herbs.get(species, {})
            result[plant["name"]] = {
                "species": species,
                "herb_info": herb,
            }
        return jsonify(result)

    @app.route("/api/timelapse")
    def api_timelapse():
        from timelapse import get_available_timelapses
        return jsonify(get_available_timelapses(config))

    @app.route("/api/storage")
    def api_storage():
        from cleanup import get_storage_stats
        return jsonify(get_storage_stats(config))

    @app.route("/api/dates")
    def api_dates():
        """List available photo dates."""
        photo_dir = config["storage"]["photo_dir"]
        if not os.path.isdir(photo_dir):
            return jsonify([])
        dates = sorted(
            [d for d in os.listdir(photo_dir)
             if os.path.isdir(os.path.join(photo_dir, d))],
            reverse=True,
        )
        return jsonify(dates)

    @app.route("/photos/<date_str>/<filename>")
    def serve_photo(date_str, filename):
        base_dir = os.path.realpath(config["storage"]["photo_dir"])
        filepath = os.path.realpath(os.path.join(base_dir, date_str, filename))
        if not filepath.startswith(base_dir + os.sep) or not os.path.isfile(filepath):
            return "Not found", 404
        return send_file(filepath, mimetype="image/jpeg")

    @app.route("/timelapse/<kind>/<filename>")
    def serve_timelapse(kind, filename):
        if kind not in ("daily", "weekly"):
            return "Not found", 404
        base_dir = os.path.realpath(config["storage"]["timelapse_dir"])
        filepath = os.path.realpath(os.path.join(base_dir, kind, filename))
        if not filepath.startswith(base_dir + os.sep) or not os.path.isfile(filepath):
            return "Not found", 404
        return send_file(filepath, mimetype="video/mp4")

    @app.route("/latest.jpg")
    def latest_jpg():
        """Serve the latest photo as raw JPEG (for Home Assistant camera entity)."""
        from capture import get_latest_photo
        photo = get_latest_photo(config)
        if not photo or not os.path.isfile(photo):
            return "No photo available", 404
        return send_file(photo, mimetype="image/jpeg")

    @app.route("/stream")
    def stream():
        """Serve latest photo as MJPEG single frame for Home Assistant camera entity."""
        from capture import get_latest_photo
        photo = get_latest_photo(config)
        if not photo or not os.path.isfile(photo):
            return "No photo available", 404

        with open(photo, "rb") as f:
            frame = f.read()

        return Response(
            b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n",
            mimetype="multipart/x-mixed-replace; boundary=frame",
        )

    @app.route("/api/light", methods=["GET"])
    def api_light():
        """Get current growlight state from EcoGarden device."""
        import urllib.request
        try:
            with urllib.request.urlopen(
                f"http://{config['ecogarden']['device_ip']}/rpc/LED.Get", timeout=5
            ) as resp:
                return Response(resp.read(), mimetype="application/json")
        except Exception:
            return jsonify({"state": None, "error": "Device unreachable"}), 503

    @app.route("/api/light/toggle", methods=["POST"])
    def api_light_toggle():
        """Toggle the EcoGarden growlight."""
        import urllib.request
        try:
            with urllib.request.urlopen(
                f"http://{config['ecogarden']['device_ip']}/rpc/LED.Toggle", timeout=5
            ) as resp:
                return Response(resp.read(), mimetype="application/json")
        except Exception:
            return jsonify({"error": "Device unreachable"}), 503

    @app.route("/capture", methods=["POST"])
    def manual_capture():
        """Trigger a manual photo capture."""
        from capture import capture_photo
        path = capture_photo(config)
        if path:
            state["last_capture"] = path
            return jsonify({"status": "ok", "path": os.path.basename(path)})
        return jsonify({"status": "error", "message": "Capture failed"}), 500

    # --- Feature: Delete Photos ---

    @app.route("/api/photos/<date_str>/<filename>", methods=["DELETE"])
    def api_delete_photo(date_str, filename):
        """Delete a single photo. Path traversal protection via realpath."""
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
            return jsonify({"error": "Invalid date format"}), 400
        if not re.match(r"^[\w\-]+\.jpg$", filename):
            return jsonify({"error": "Invalid filename"}), 400

        base_dir = os.path.realpath(config["storage"]["photo_dir"])
        filepath = os.path.realpath(os.path.join(base_dir, date_str, filename))
        if not filepath.startswith(base_dir + os.sep) or not os.path.isfile(filepath):
            return "Not found", 404

        os.remove(filepath)

        # Remove empty date directory
        date_dir = os.path.dirname(filepath)
        if os.path.isdir(date_dir) and not os.listdir(date_dir):
            os.rmdir(date_dir)

        return jsonify({"status": "ok"})

    # --- Feature: Light Sensor History ---

    @app.route("/api/sensors/light/history")
    def api_light_history():
        """Query InfluxDB for light sensor history."""
        range_param = request.args.get("range", "24h")
        if range_param not in ("24h", "7d"):
            return jsonify({"error": "range must be 24h or 7d"}), 400

        influx = config.get("influxdb")
        if not influx or not influx.get("token"):
            return jsonify({"range": range_param, "points": [], "error": "InfluxDB not configured"})

        window = "5m" if range_param == "24h" else "30m"
        flux_range = "-24h" if range_param == "24h" else "-7d"

        flux_query = f'''
from(bucket: "{influx['bucket']}")
  |> range(start: {flux_range})
  |> filter(fn: (r) => r["entity_id"] == "ecogarden_light_level")
  |> filter(fn: (r) => r["_field"] == "value")
  |> aggregateWindow(every: {window}, fn: mean, createEmpty: false)
  |> yield(name: "mean")
'''

        try:
            import urllib.request
            url = f"{influx['url']}/api/v2/query?org={influx['org']}"
            req = urllib.request.Request(
                url,
                data=flux_query.encode(),
                headers={
                    "Authorization": f"Token {influx['token']}",
                    "Content-Type": "application/vnd.flux",
                    "Accept": "application/csv",
                },
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                csv_data = resp.read().decode()

            # Parse InfluxDB annotated CSV:
            # Lines starting with '#' are annotations (skip)
            # First non-annotation line is header (find column indices)
            # Data rows start with empty first field
            points = []
            header = None
            for line in csv_data.strip().split("\n"):
                if not line or line.startswith("#"):
                    continue
                parts = line.split(",")
                if header is None:
                    # This is the header row
                    header = {col: idx for idx, col in enumerate(parts)}
                    continue
                # Data row - must start with empty field
                if parts[0] != "":
                    continue
                try:
                    time_idx = header.get("_time")
                    value_idx = header.get("_value")
                    if time_idx is not None and value_idx is not None:
                        time_val = parts[time_idx]
                        value = parts[value_idx]
                        if time_val and value:
                            points.append({"time": time_val, "value": round(float(value), 2)})
                except (ValueError, IndexError):
                    continue

            return jsonify({"range": range_param, "points": points})

        except Exception as e:
            log.warning("InfluxDB light history query failed: %s", e)
            return jsonify({"range": range_param, "points": [], "error": str(e)})

    # --- Feature: On-demand Timelapse Generation ---

    timelapse_status = {"generating": False, "type": None, "label": None, "error": None, "result": None}
    timelapse_lock = threading.Lock()

    @app.route("/api/timelapse/generate", methods=["POST"])
    def api_timelapse_generate():
        """Start background timelapse generation."""
        with timelapse_lock:
            if timelapse_status["generating"]:
                return jsonify({"error": "Already generating", "label": timelapse_status["label"]}), 409

        data = request.get_json(silent=True) or {}

        if "date" in data:
            gen_type = "daily"
            label = data["date"]
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", label):
                return jsonify({"error": "Invalid date format"}), 400
        elif "year" in data and "week" in data:
            gen_type = "weekly"
            try:
                year = int(data["year"])
                week = int(data["week"])
            except (ValueError, TypeError):
                return jsonify({"error": "Invalid year/week"}), 400
            label = f"{year}-W{week:02d}"
        else:
            return jsonify({"error": "Provide 'date' or 'year'+'week'"}), 400

        with timelapse_lock:
            timelapse_status.update({
                "generating": True,
                "type": gen_type,
                "label": label,
                "error": None,
                "result": None,
            })

        def _generate():
            try:
                from timelapse import generate_daily_timelapse, generate_weekly_timelapse
                if gen_type == "daily":
                    result = generate_daily_timelapse(config, label)
                else:
                    result = generate_weekly_timelapse(config, year, week)

                with timelapse_lock:
                    timelapse_status["result"] = os.path.basename(result) if result else None
                    if not result:
                        timelapse_status["error"] = "Not enough photos"
            except Exception as e:
                log.error("Timelapse generation failed: %s", e)
                with timelapse_lock:
                    timelapse_status["error"] = str(e)
            finally:
                with timelapse_lock:
                    timelapse_status["generating"] = False

        thread = threading.Thread(target=_generate, daemon=True)
        thread.start()

        return jsonify({"status": "started", "type": gen_type, "label": label})

    @app.route("/api/timelapse/status")
    def api_timelapse_status():
        """Get current timelapse generation status."""
        with timelapse_lock:
            return jsonify(dict(timelapse_status))

    return app
