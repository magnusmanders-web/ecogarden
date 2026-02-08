import logging
import os

from flask import Flask, Response, jsonify, render_template, send_file

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
        return render_template("index.html")

    @app.route("/api/status")
    def api_status():
        mqtt = state.get("mqtt_client")
        sensors = mqtt.get_latest_sensor_data() if mqtt else {}

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
                lux=sensors.get("lux"),
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

    @app.route("/capture", methods=["POST"])
    def manual_capture():
        """Trigger a manual photo capture."""
        from capture import capture_photo
        path = capture_photo(config)
        if path:
            state["last_capture"] = path
            return jsonify({"status": "ok", "path": os.path.basename(path)})
        return jsonify({"status": "error", "message": "Capture failed"}), 500

    return app
