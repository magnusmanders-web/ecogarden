# EcoGarden Plant Monitor - Design

## Overview

A plant monitoring system running on a Raspberry Pi 3 (192.168.1.127) with a Logitech HD USB camera, mounted at an angle above the EcoGarden growing pod. Provides growth tracking via timelapse photography, AI-powered health analysis via Claude API, herb care guides, and integration with the existing Home Assistant + Grafana stack.

**Hardware:**
- Raspberry Pi 3 (192.168.1.127)
- Logitech HD USB camera (angled from above, looking down at growing pod)
- EcoGarden ESP8266 (192.168.1.196) providing light/temp sensor data via MQTT

**Current plants:** Greek oregano (Origanum vulgare hirtum), fine-leaf basil (Ocimum basilicum), lettuce (Lactuca sativa). System designed to support adding/removing herbs via config.

## Architecture

```
Logitech USB Cam → Raspberry Pi 3 (192.168.1.127)
                      ├── Photo capture service (cron, every 30 min during 06:00-22:00)
                      ├── Timelapse generator (ffmpeg, nightly at 22:30)
                      ├── AI health analyzer (Claude API, 1-2x daily)
                      ├── Web dashboard (Flask, port 8080)
                      └── MQTT → Home Assistant (camera + alerts)
                                    ├── EcoGarden sensors (light, temp)
                                    └── Grafana/InfluxDB (health trends)
```

**Language:** Python. Best library support for camera, image processing, MQTT, and web serving on Pi 3.

**MQTT broker:** 192.168.1.5:1883 (same as EcoGarden)

## Photo Capture & Storage

### Capture Schedule

Photos every 30 minutes during grow light hours (06:00-22:00) = 32 photos per day. Approximately 150MB/day at 1080p JPEG quality 85. Cron-triggered using `fswebcam` or OpenCV. Each photo gets a timestamp overlay in the corner.

### Directory Structure

```
~/ecogarden-monitor/
├── photos/
│   ├── 2026-02-08/
│   │   ├── 2026-02-08_06-00.jpg
│   │   ├── 2026-02-08_06-30.jpg
│   │   └── ...
│   └── 2026-02-09/
├── timelapse/
│   ├── daily/
│   │   ├── 2026-02-08.mp4
│   │   └── ...
│   └── weekly/
│       └── 2026-W06.mp4
├── analysis/
│   └── 2026-02-08.json
└── config.yaml
```

### Retention Policy

- Full-res photos: 30 days rolling, then keep one per day (noon shot) as archive
- Timelapse videos: kept indefinitely
- 32GB SD card provides ~6 months of rolling storage before cleanup

### Timelapse Generation

`ffmpeg` runs at 22:30 nightly, stitching the day's photos into a ~10-second MP4 at 30fps (interpolates the 32 frames). Weekly compilation generated Sunday night from daily noon shots.

## Plant Configuration

### Config File (`config.yaml`)

```yaml
plants:
  - name: "Greek Oregano"
    species: "Origanum vulgare hirtum"
    planted_date: "2026-02-08"
    position: "left"
    notes: "Perennial, slow starter"
  - name: "Fine-leaf Basil"
    species: "Ocimum basilicum"
    planted_date: "2026-02-08"
    position: "center"
  - name: "Lettuce"
    species: "Lactuca sativa"
    planted_date: "2026-02-08"
    position: "right"

capture:
  interval_minutes: 30
  start_hour: 6
  end_hour: 22
  resolution: "1920x1080"
  quality: 85

analysis:
  frequency: "twice_daily"  # once_daily or twice_daily
  times: ["10:00", "18:00"]

mqtt:
  broker: "192.168.1.5"
  port: 1883
  ecogarden_topic: "/devices/esp8266_5A604B/events"
  publish_topic: "/devices/ecogarden-monitor/events"
```

Adding new herbs = add an entry to the plants list. No code changes needed.

### Herb Care Knowledge Base (`herbs.yaml`)

Ships with common herbs. Per-herb data:
- Ideal temperature range (cross-referenced with EcoGarden water temp sensor)
- Light needs in lux (cross-referenced with TSL2561 data via MQTT)
- Growth stages and expected timeline (sprout, seedling, vegetative, mature, harvest-ready)
- Harvest tips (when and how to pick)
- Common problems for aquaponic growing

The system tracks plant age from `planted_date` and surfaces relevant advice based on current growth stage: "Your basil is 14 days old - expect first true leaves this week" or "Greek oregano is slow to germinate, don't worry if you don't see sprouts for 10-14 days."

**Sensor correlation:** The Pi subscribes to the EcoGarden's MQTT topic (`/devices/esp8266_5A604B/events`) and cross-references light and temperature readings with each herb's ideal ranges. Flags warnings when conditions are outside recommended parameters.

## AI Health Analysis

### How It Works

Once or twice daily (configurable), the system sends the latest photo to Claude's vision API with context about the plants, their age, and current sensor readings.

### Prompt Structure

```
You are analyzing an aquaponic herb garden. The photo shows
the growing pod from an angled-above view.

Current plants:
- Greek Oregano (left position, 14 days old, seedling stage)
- Fine-leaf Basil (center, 14 days old, seedling stage)
- Lettuce (right, 14 days old, seedling stage)

Current sensor data:
- Light: 450 lux | Water temp: 24.75°C

Analyze each plant for:
1. Growth stage (sprout/seedling/vegetative/mature)
2. Health indicators (leaf color, wilting, spots, pests)
3. Any concerns or action items
4. Estimated days until harvest-ready
```

### Response Storage

Stored as structured JSON in `analysis/YYYY-MM-DD.json` with:
- Per-plant assessments (growth stage, health observations, concerns)
- Overall health score (1-5)
- Alerts (if any)
- Comparison notes vs previous analysis

Builds a history that provides context for trend detection: "The yellowing on the basil observed yesterday has improved."

### Cost

Claude Sonnet with vision: ~$0.01-0.03 per analysis. At twice daily: ~$1-2/month.

### Alerts

If the AI flags something concerning (health score drops below 3, pest detected, nutrient deficiency signs), it publishes an alert via MQTT that Home Assistant picks up as a notification.

## Web Dashboard

### Tech Stack

Flask app running on the Pi at `http://192.168.1.127:8080`. Plain HTML/CSS/JS (no frontend framework). MQTT.js for live sensor updates via WebSocket. No database - reads directly from photo directories, JSON analysis files, and MQTT. No authentication (local network only).

### Layout

**Live view & recent photos**
- Latest photo at the top, auto-refreshes every 30 minutes
- Thumbnail strip of today's captures, click to enlarge

**Timelapse player**
- Select daily or weekly timelapse videos
- Date picker to browse history
- Play/pause, speed control

**Plant cards**
- One card per plant: name, age in days, current growth stage, health score, most recent AI observation
- Color-coded: green (healthy), yellow (attention needed), red (problem detected)
- Click to expand: full care guide, analysis history, growth timeline

**Sensor sidebar**
- Current lux and water temperature from EcoGarden via MQTT
- Sparkline charts showing last 24 hours

## Home Assistant Integration

### Camera Entity

The Pi serves an MJPEG stream endpoint at `http://192.168.1.127:8080/stream` showing the latest captured photo (not continuous video). HA picks this up as a generic camera entity.

### MQTT Sensors

Published to `/devices/ecogarden-monitor/events`:

```json
{
  "plant_count": 3,
  "overall_health": 4,
  "days_since_planted": 14,
  "next_harvest": "Lettuce (~7 days)",
  "alerts": []
}
```

### HA Entities

- `camera.ecogarden_plants` - latest photo from the growing pod
- `sensor.ecogarden_plant_health` - overall health score (1-5)
- `sensor.ecogarden_next_harvest` - which plant is closest to harvest
- `binary_sensor.ecogarden_plant_alert` - true when AI flags a problem

### Suggested Automations

- Push notification when plant health drops below 3
- Push notification when a plant is harvest-ready
- Weekly timelapse summary notification with link to dashboard

### Grafana

Health scores written to InfluxDB alongside existing EcoGarden sensor data. Enables correlation views: plant health trends vs light levels and water temperature over time.

## Summary

| Component | Technology | Schedule |
|-----------|-----------|----------|
| Photo capture | fswebcam/OpenCV + cron | Every 30 min, 06:00-22:00 |
| Timelapse | ffmpeg | Nightly 22:30 + weekly Sunday |
| AI analysis | Claude Sonnet vision API | 1-2x daily |
| Care guides | Static YAML knowledge base | On-demand |
| Web dashboard | Flask + plain HTML/JS | Always running |
| HA integration | MQTT + MJPEG stream | Real-time |
| Storage cleanup | Cron | Daily, 30-day retention |
