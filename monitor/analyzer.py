import base64
import json
import logging
import os
from datetime import date, datetime

from knowledge import get_growth_stage, get_plant_age, load_herbs

log = logging.getLogger(__name__)


def _load_previous_analysis(config):
    """Load the most recent analysis for comparison context."""
    analysis_dir = config["storage"]["analysis_dir"]
    if not os.path.isdir(analysis_dir):
        return None

    files = sorted(
        [f for f in os.listdir(analysis_dir) if f.endswith(".json")],
        reverse=True,
    )
    if not files:
        return None

    try:
        with open(os.path.join(analysis_dir, files[0])) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _build_prompt(plants, sensors, herbs, previous):
    """Build the analysis prompt with plant context."""
    plant_lines = []
    for plant in plants:
        age = get_plant_age(plant["planted_date"])
        stage, progress = get_growth_stage(plant["species"], age)
        herb = herbs.get(plant["species"], {})
        harvest = herb.get("days_to_harvest", [60, 90])

        plant_lines.append(
            f"- {plant['name']} ({herb.get('scientific_name', plant['species'])}): "
            f"{plant['position']} position, {age} days old, {stage} stage ({progress}% through), "
            f"harvest expected at {harvest[0]}-{harvest[1]} days"
        )

    sensor_lines = []
    if sensors.get("temp_c") is not None:
        sensor_lines.append(f"- Water temp: {sensors['temp_c']}C")

    previous_context = ""
    if previous:
        prev_date = previous.get("date", "unknown")
        prev_summary = previous.get("summary", "")
        if prev_summary:
            previous_context = f"\n\nPrevious analysis ({prev_date}):\n{prev_summary}\nNote any changes since then."

    return f"""You are analyzing an aquaponic herb garden (EcoGarden). The photo shows the growing pod from an angled-above view.

Current plants:
{chr(10).join(plant_lines)}

Current sensor data:
{chr(10).join(sensor_lines) if sensor_lines else "- No sensor data available"}
{previous_context}

For each plant, provide:
1. Visible growth stage (sprout/seedling/vegetative/mature) based on what you see
2. Health score (1-5): 1=dead/dying, 2=poor, 3=fair, 4=good, 5=excellent
3. Specific observations (leaf color, size, any visible issues)
4. Any concerns or recommended actions
5. Estimated days until harvest-ready (or "ready now" if mature)

Also provide:
- Overall garden health score (1-5)
- A brief 1-2 sentence summary
- Any alerts that need immediate attention (empty list if none)

Respond in JSON format:
{{
  "plants": [
    {{
      "name": "Plant Name",
      "observed_stage": "seedling",
      "health_score": 4,
      "observations": "Description of what you see",
      "concerns": "Any issues or empty string",
      "days_to_harvest": 30
    }}
  ],
  "overall_health": 4,
  "summary": "Brief overall assessment",
  "alerts": []
}}"""


def analyze_plants(config, state):
    """Run AI analysis on the latest photo.

    Args:
        config: App config dict.
        state: Shared state dict (reads mqtt_client for sensors, last_capture for photo).

    Returns:
        Analysis dict, or None if failed.
    """
    import anthropic

    # Get latest photo
    from capture import get_latest_photo
    photo_path = state.get("last_capture") or get_latest_photo(config)
    if not photo_path or not os.path.exists(photo_path):
        log.warning("No photo available for analysis")
        return None

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log.error("ANTHROPIC_API_KEY not set, skipping analysis")
        return None

    herbs = load_herbs()

    # Get sensor data from MQTT
    sensors = {}
    mqtt = state.get("mqtt_client")
    if mqtt:
        sensors = mqtt.get_latest_sensor_data()

    # Load previous analysis for comparison
    previous = _load_previous_analysis(config)

    # Build prompt
    prompt = _build_prompt(config["plants"], sensors, herbs, previous)

    # Read and encode photo
    with open(photo_path, "rb") as f:
        image_data = base64.b64encode(f.read()).decode("utf-8")

    # Call Claude API
    try:
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=2000,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": image_data,
                            },
                        },
                        {
                            "type": "text",
                            "text": prompt,
                        },
                    ],
                }
            ],
        )
    except Exception as e:
        log.error("Claude API call failed: %s", e)
        return None

    # Parse response
    try:
        text = response.content[0].text
        # Strip markdown code fences if present
        if text.strip().startswith("```"):
            lines = text.strip().split("\n")
            text = "\n".join(lines[1:-1])
        analysis = json.loads(text)
    except (json.JSONDecodeError, IndexError) as e:
        log.error("Failed to parse analysis response: %s", e)
        log.debug("Raw response: %s", response.content[0].text if response.content else "empty")
        return None

    # Add metadata
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H-%M")
    analysis["date"] = today
    analysis["time"] = now.strftime("%H:%M")
    analysis["photo"] = os.path.basename(photo_path)
    analysis["sensors"] = sensors

    # Save to file (include time so twice-daily runs don't overwrite)
    analysis_dir = config["storage"]["analysis_dir"]
    os.makedirs(analysis_dir, exist_ok=True)
    analysis_path = os.path.join(analysis_dir, f"{today}_{time_str}.json")
    with open(analysis_path, "w") as f:
        json.dump(analysis, f, indent=2)

    log.info("Analysis saved: %s (overall health: %s/5)", analysis_path,
             analysis.get("overall_health", "?"))

    # Write health scores to InfluxDB
    try:
        from influxdb_writer import write_health_scores
        write_health_scores(config, analysis)
    except Exception as e:
        log.warning("Failed to write to InfluxDB: %s", e)

    # Publish via MQTT if available
    if mqtt:
        mqtt.publish_analysis(analysis, config["plants"])

    return analysis
