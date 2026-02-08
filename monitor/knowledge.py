import logging
import os
from datetime import date, datetime

import yaml

log = logging.getLogger(__name__)

_herbs_cache = None


def load_herbs(path=None):
    """Load herb knowledge base from YAML."""
    global _herbs_cache
    if _herbs_cache is not None:
        return _herbs_cache

    if path is None:
        path = os.path.join(os.path.dirname(__file__), "herbs.yaml")

    with open(path) as f:
        _herbs_cache = yaml.safe_load(f)
    return _herbs_cache


def get_plant_age(planted_date):
    """Calculate days since planting."""
    if isinstance(planted_date, str):
        planted_date = datetime.strptime(planted_date, "%Y-%m-%d").date()
    return (date.today() - planted_date).days


def get_growth_stage(species, days):
    """Determine current growth stage for a species at a given age.

    Returns:
        (stage_name, progress_pct) where progress_pct is how far through the stage.
    """
    herbs = load_herbs()
    herb = herbs.get(species)
    if not herb:
        return "unknown", 0

    stages = herb.get("growth_stages", {})
    current_stage = "mature"
    progress = 100

    for stage_name, (start, end) in stages.items():
        if end is None:
            if days >= start:
                current_stage = stage_name
                progress = 100
                break
        elif start <= days < end:
            current_stage = stage_name
            progress = int((days - start) / (end - start) * 100)
            break

    return current_stage, progress


def get_care_advice(species, days, temp_c=None):
    """Get context-specific care advice for a plant.

    Returns:
        List of advice strings.
    """
    herbs = load_herbs()
    herb = herbs.get(species)
    if not herb:
        return []

    stage, _ = get_growth_stage(species, days)
    advice = []

    # Germination period advice
    germ = herb.get("germination_days", [7, 14])
    if days < germ[0]:
        advice.append(f"Seeds planted {days} days ago. Germination expected in {germ[0]}-{germ[1]} days.")
    elif days < germ[1] and stage == "sprout":
        advice.append(f"Within germination window ({germ[0]}-{germ[1]} days). Be patient.")

    # Growth stage advice
    harvest = herb.get("days_to_harvest", [60, 90])
    if stage == "mature":
        advice.append(f"Ready to harvest! {herb.get('harvest_tips', '')}")
    elif stage == "vegetative":
        days_remaining = max(0, harvest[0] - days)
        if days_remaining > 0:
            advice.append(f"Growing well. Approximately {days_remaining} days to first harvest.")
        else:
            advice.append("Approaching harvest time. Watch for mature leaf size.")

    # Sensor-based warnings
    if temp_c is not None:
        if temp_c < herb.get("temp_min_c", 10):
            advice.append(f"WARNING: Water temp {temp_c}C is below minimum {herb['temp_min_c']}C for {herb['display_name']}.")
        elif temp_c > herb.get("temp_max_c", 30):
            advice.append(f"WARNING: Water temp {temp_c}C exceeds maximum {herb['temp_max_c']}C for {herb['display_name']}.")

    return advice


def check_conditions(plants, sensors, herbs=None):
    """Check all plant conditions against sensor data.

    Args:
        plants: List of plant config dicts.
        sensors: Dict with 'lux' and 'temp_c' keys.
        herbs: Herb knowledge base (loaded if None).

    Returns:
        List of warning dicts: {"plant": name, "type": "temp"|"light", "message": str}
    """
    if herbs is None:
        herbs = load_herbs()

    warnings = []
    temp_c = sensors.get("temp_c")

    for plant in plants:
        species = plant["species"]
        herb = herbs.get(species)
        if not herb:
            continue

        name = plant["name"]

        if temp_c is not None:
            if temp_c < herb.get("temp_min_c", 10):
                warnings.append({
                    "plant": name,
                    "type": "temp",
                    "message": f"Water temperature ({temp_c}C) too cold for {name} (min {herb['temp_min_c']}C)",
                })
            elif temp_c > herb.get("temp_max_c", 30):
                warnings.append({
                    "plant": name,
                    "type": "temp",
                    "message": f"Water temperature ({temp_c}C) too warm for {name} (max {herb['temp_max_c']}C)",
                })

    return warnings
