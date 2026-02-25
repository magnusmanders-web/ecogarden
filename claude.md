# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Reviving an EcoGarden (Kickstarter by Ecobloom) after their cloud service was decommissioned. Custom Mongoose OS firmware restores local control via HTTP RPC and MQTT.

**GitHub:** https://github.com/magnusmanders-web/ecogarden

## Device Info

- **Device ID:** esp8266_5A604B
- **MAC:** 8EAAB55A604B
- **IP:** 192.168.1.196
- **Firmware:** v1.3.0 (custom Mongoose OS 2.20.0)
- **MQTT broker:** 192.168.1.5:1883 (currently down — monitor uses HTTP fallback)
- **WiFi:** Configured via web portal (no hardcoded credentials)

## Current Status (Feb 2026)

**Working:**
- LED/Growlight control (GPIO 4) via HTTP and MQTT
- Light sensor (TSL2561 on I2C 0x39) - real lux values
- Water temperature sensor (DS18B20 on GPIO 13) - real readings (~25°C)
- Home Assistant integration at ~/homeassistant
- OTA firmware updates via /update endpoint
- RPi plant monitor dashboard with live temperature, temp chart, light history
- Photo capture every 30min with timelapse generation (daily/weekly/all-photos)
- AI plant health analysis via Claude API (twice daily)
- Dashboard creature animations (koi fish, sea turtle, shark)

**Working:**
- Feeder (GPIO 1 / TX0) - confirmed via audible testing, pulses DC motor

**Not working / Unknown:**
- MQTT broker at 192.168.1.5 - currently not running, monitor falls back to direct HTTP

**Not needed:**
- Pump - runs continuously when powered, no control required
- Water level microswitches - hardwired inline with pump circuit as dry-run safety cutoff (not software-readable)

## Architecture

```
firmware/
├── src/main.c       # C firmware: RPC handlers, MQTT pub/sub, GPIO, DS18B20
├── mos.yml          # Mongoose OS config (not in git - contains credentials)
├── mos.yml.example  # Template config (in git)
└── fs/index.html    # WiFi provisioning web UI served by device

monitor/             # Raspberry Pi plant monitoring (Python 3, Flask)
├── app.py           # Entry point: loads config, starts MQTT + scheduler + Flask
├── config.py        # YAML config loader with validation
├── config.yaml      # Plants, capture schedule, MQTT, InfluxDB settings
├── herbs.yaml       # Herb care knowledge base (12 species)
├── scheduler.py     # Background task scheduling (capture/timelapse/analysis/cleanup)
├── capture.py       # Photo capture via fswebcam or OpenCV
├── analyzer.py      # AI plant health analysis via Claude Sonnet
├── timelapse.py     # Daily/weekly video generation with ffmpeg
├── mqtt_client.py   # MQTT integration with EcoGarden ESP8266
├── influxdb_writer.py # Health score metrics to InfluxDB
├── knowledge.py     # Growth stage tracking from herbs.yaml
├── cleanup.py       # 30-day photo retention with noon archives
├── web.py           # Flask web dashboard + REST API + MJPEG stream
├── deploy.sh        # Raspberry Pi deployment script (idempotent)
├── requirements.txt # Python dependencies
├── templates/       # Jinja2 dashboard template
└── static/          # Frontend JS + CSS (vanilla, no framework)

homeassistant/
├── docker-compose.yml          # HA + InfluxDB 2.7 + Grafana stack
├── config/configuration.yaml   # HA sensors, lights, REST commands for EcoGarden
├── config/automations.yaml     # Light schedule, feeding, alerts
└── grafana/provisioning/       # InfluxDB datasource + EcoGarden dashboard

backup/              # Original device config/code for reference
├── config.json      # Original device settings (I2C config, GCP settings)
└── init.js          # Original mJS firmware (used GPIO 2 for LED)

docs/FLASHING.md     # Serial and OTA flashing guide
```

**Data flow:**
```
EcoGarden ESP8266 ──MQTT──► Pi Monitor ──► InfluxDB ──► Grafana
        │                       │
        └──HTTP fallback──►     ├── Claude API (AI analysis)
                                │
                          Flask dashboard (:8080)
```

**Firmware pattern:** RPC handlers in `main.c` follow: parse JSON args → perform action → send JSON response. HTTP hooks at `/hooks/*` are routed through a single `http_handler()` dispatcher. MQTT handler subscribes to `/devices/{id}/config` and `/devices/{id}/commands/#`.

**Monitor pattern:** `app.py` creates a shared `state` dict passed to all modules. Scheduler runs background tasks on a `schedule` library thread: capture (every 30min, 06:00-22:00) → timelapse (22:30) → analysis (10:00/18:00) → cleanup (01:00). Config is loaded from `config.yaml`; secrets come from env vars. Analysis output files use `YYYY-MM-DD_HH-MM.json` format (includes time to avoid overwrite on twice-daily runs).

**Dashboard features:** Temperature history chart (in-memory buffer, up to 1440 points/24h), light sensor history (InfluxDB Flux queries), photo gallery with date browsing, timelapse viewer with on-demand generation, plant health cards with growth stage progress, growlight toggle. Creature animations: Gill the koi fish, sea turtle, shark attack easter egg. Frontend is vanilla JS with SVG charts — no framework.

## Commands

```bash
# Build firmware (requires mos tool)
cd firmware && mos build --platform esp8266

# OTA flash (direct upload - works without Mongoose OS license)
curl -F "file=@build/fw.zip" http://192.168.1.196/update

# Serial flash (new device or bricked) - see docs/FLASHING.md
mos flash --port /dev/ttyUSB0

# Note: OTA.Update RPC requires Mongoose OS license, use /update endpoint instead
```

## Monitor Commands

```bash
# Run locally (development)
cd monitor && python app.py

# Deploy to Raspberry Pi (installs deps, systemd service, starts)
cd monitor && ./deploy.sh

# On Pi: manage service
sudo systemctl status ecogarden-monitor
sudo systemctl restart ecogarden-monitor
journalctl -u ecogarden-monitor -f

# Set secrets on Pi
sudo nano /etc/ecogarden-monitor.env   # ANTHROPIC_API_KEY, INFLUXDB_TOKEN
sudo systemctl restart ecogarden-monitor

# Install Python dependencies (development)
cd monitor && python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt
```

Dashboard: http://192.168.1.58:8080 | MJPEG stream: http://192.168.1.58:8080/stream

**Manual deploy to Pi (when deploy.sh isn't suitable):**
```bash
sshpass -p 'REDACTED' scp monitor/web.py pi@192.168.1.58:/home/pi/ecogarden/monitor/
sshpass -p 'REDACTED' scp monitor/static/app.js pi@192.168.1.58:/home/pi/ecogarden/monitor/static/
sshpass -p 'REDACTED' scp monitor/templates/index.html pi@192.168.1.58:/home/pi/ecogarden/monitor/templates/
sshpass -p 'REDACTED' ssh pi@192.168.1.58 "sudo systemctl restart ecogarden-monitor"
```

**Ad-hoc timelapse from all photos:**
```bash
sshpass -p 'REDACTED' ssh pi@192.168.1.58 "find /home/pi/ecogarden/monitor/photos -name '*.jpg' | sort > /tmp/tl.txt && ffmpeg -y -f concat -safe 0 -i <(awk '{print \"file \x27\" \$0 \"\x27\"}' /tmp/tl.txt) -vf 'scale=1280:-2' -r 15 -c:v libx264 -pix_fmt yuv420p -preset fast /home/pi/ecogarden/monitor/timelapse/daily/all-photos-timelapse.mp4"
```

## Home Assistant API

HTTP endpoints compatible with original EcoGarden firmware (use with farstreet/HA_ecobloom_ecogarden configs):

```bash
# Sensors
curl http://192.168.1.196/hooks/light_sensor        # {"value": 0.0-1.0}
curl http://192.168.1.196/hooks/water_temperature   # {"value": 25.38} (real DS18B20)

# LED control (value: 0.0-1.0)
curl "http://192.168.1.196/hooks/set_led_brightness?value=0.8"
curl "http://192.168.1.196/hooks/set_automatic_led_brightness?value=1"

# Feeder (pulses GPIO 1 HIGH for 2 seconds)
curl http://192.168.1.196/hooks/feed_now
```

## RPC API

```bash
# LED control
curl http://192.168.1.196/rpc/LED.Set -d '{"state":true}'
curl http://192.168.1.196/rpc/LED.Toggle
curl http://192.168.1.196/rpc/LED.Get

# Temperature sensor (DS18B20 on GPIO 13, auto-initialized at boot)
curl http://192.168.1.196/rpc/Temp.Scan           # Re-scan 1-Wire bus
curl http://192.168.1.196/rpc/Temp.Read            # Read current temperature

# GPIO testing (for discovering unknown pins)
curl "http://192.168.1.196/rpc/GPIO.Write?pin=4&value=1"
curl "http://192.168.1.196/rpc/GPIO.Read?pin=4"

# I2C scan
curl http://192.168.1.196/rpc/I2C.Scan

# LED control via MQTT
mosquitto_pub -h localhost -t '/devices/esp8266_5A604B/config' -m '{"led":1}'
```

## Hardware

| Component | GPIO | Status |
|-----------|------|--------|
| LED/Growlight | 4 | Working (HIGH=on) |
| Button | 0 | Confirmed |
| I2C SDA | 12 | Confirmed |
| I2C SCL | 14 | Confirmed |
| Temp sensor (DS18B20) | 13 | Working - 1-Wire, addr 28:FF:67:4F:75:A0:4C:A3 |
| Feeder | 1 (TX0) | Working - confirmed via audible test, 2s HIGH pulse |
| Lux sensor | I2C 0x39 | TSL2561 - working via /hooks/light_sensor |
| Pump | N/A | Runs continuously when powered, no control needed |
| Water level microswitches | N/A | Hardwired inline with pump circuit (dry-run safety, not GPIO-connected) |

### Temperature Sensor Discovery (Feb 2026)

GPIO 13 was originally configured as UART1 RX for TuyaMCU communication. A full-GPIO 1-Wire scan discovered a DS18B20 temperature sensor on GPIO 13 (address `28:FF:67:4F:75:A0:4C:A3`). The TuyaMCU assumption was a red herring - there is no secondary MCU. The DS18B20 is now auto-initialized at boot and reads every 5 seconds.

### Feeder Discovery (Feb 2026)

**GPIO 1 (TX0) confirmed** as feeder pin via audible testing — motor sound heard on each pulse. This was hidden because UART0 TX was used for serial logging in development, masking feeder signals.

**Testing done:**
- GPIO 15, 5, 2, 16, 3 — no motor response
- GPIO 1 (TX0) — motor sound confirmed on HIGH pulse, reproducible
- Feeder is a simple DC motor: HIGH = on, LOW = off, 2-second pulse per feeding

**Original firmware:** Feeder was cloud-only via Firebase/GCP IoT Core. No local `/hooks/feed_now` endpoint existed.

### Water Level Microswitches (Feb 2026)

**From founder schematics:** Two 1P2T microswitches (2A 24V DC) with COM + N.O. wiring to 2-pin JST connectors.

**Testing:** GPIO monitoring during water level change (low → normal) showed no state changes on any available GPIO (2, 3, 5, 16). GPIO 9/10 inaccessible (flash-connected).

**Conclusion:** Microswitches are hardwired inline with the pump power circuit as a dry-run safety cutoff. When water drops below the switch level, the circuit opens and cuts pump power. Not software-readable — purely electrical protection.

## Config Schema

Custom settings in `mos.yml` under `ecogarden.*`:
- `ecogarden.led_pin` (int, default 4) - LED/growlight GPIO
- `ecogarden.sensor_interval_ms` (int, default 5000) - MQTT sensor publish interval
- `ecogarden.onewire_pin` (int, default 13) - 1-Wire GPIO for DS18B20

## Home Assistant Setup

```bash
cd homeassistant
docker compose up -d
# HA: http://localhost:8123 | Grafana: http://localhost:3000 | InfluxDB: http://localhost:8086
```

Main HA setup (with all your devices): `~/homeassistant`
Example HA config for EcoGarden: `./homeassistant/` (in this repo)

The config provides:
- Light sensor (0-100%) and water temperature sensor
- Growlight on/off control and auto brightness toggle
- Feed fish button (pulses GPIO 1)
- InfluxDB time-series storage for sensor data
- Grafana dashboard for EcoGarden monitoring
- Automations: growlight sunrise/sunset ramp (06:00-07:00 up, 20:30-22:00 down), feeding (08:00 + 18:00), temp/light alerts

## WiFi Provisioning

The firmware supports WiFi configuration via a captive portal - no hardcoded credentials needed.

**First-time setup:**
1. Device creates WiFi hotspot: `EcoGarden-Setup` (password: `ecogarden`)
2. Connect to the hotspot with your phone/laptop
3. Open http://192.168.4.1 in browser
4. Select your WiFi network and enter password
5. Device reboots and connects to your network
6. AP automatically turns off when connected

**To reconfigure WiFi:**
- If device can't connect (e.g., wrong password, network changed), it falls back to AP mode after 15 seconds
- Or factory reset: Connect via serial and run `mos config-set wifi.sta.ssid="" wifi.sta.pass=""`

## Current Plants (planted 2026-02-08)

- **Greek Oregano** (left position) - sprout stage
- **Fine-leaf Basil** (center position) - sprout stage, leading in growth
- **Lettuce** (right position) - seedling stage, sensitive to water temp >24°C

## TODO

1. **MQTT broker:** Investigate why broker at 192.168.1.5 is down. Monitor works via HTTP fallback but loses real-time sensor push.
2. **Feeder tuning:** Test optimal pulse duration for portion control (currently 2 seconds). May need adjustment based on food dispensed per pulse.
3. **Build and OTA flash** updated firmware with GPIO 1 feeder pin: `cd firmware && mos build --platform esp8266 && curl -F "file=@build/fw.zip" http://192.168.1.196/update`
