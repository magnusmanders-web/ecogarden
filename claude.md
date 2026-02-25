# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Reviving an EcoGarden (Kickstarter by Ecobloom) after their cloud service was decommissioned. Custom Mongoose OS firmware restores local control via HTTP RPC and MQTT. Raspberry Pi runs a Flask dashboard with photo capture, AI plant analysis, and timelapse generation.

**GitHub:** https://github.com/magnusmanders-web/ecogarden

## Architecture

```
EcoGarden ESP8266 ──MQTT──► Pi Monitor ──► InfluxDB ──► Grafana
        │                       │
        └──HTTP fallback──►     ├── Claude API (AI analysis)
                                │
                          Flask dashboard (:8080)
```

**Three main components:**

- **`firmware/`** — ESP8266 Mongoose OS firmware (C). Single `main.c` with RPC handlers, HTTP hooks, MQTT pub/sub, GPIO control, DS18B20 temperature, TSL2561 lux sensor.
- **`monitor/`** — Raspberry Pi plant monitoring (Python 3, Flask). Photo capture, AI health analysis, timelapse generation, web dashboard with REST API.
- **`homeassistant/`** — Docker Compose stack: Home Assistant + InfluxDB 2.7 + Grafana.

### Firmware Patterns (`firmware/src/main.c`)

- **RPC handlers** (`LED.Set`, `LED.Get`, `LED.Toggle`, `Temp.Scan`, `Temp.Read`): Parse JSON args → perform action → send JSON response.
- **HTTP hooks** at `/hooks/*`: Single `http_handler()` dispatcher routes by URI string comparison to individual functions (`light_sensor`, `water_temperature`, `set_led_brightness`, `set_automatic_led_brightness`, `feed_now`).
- **MQTT**: Publishes `{water_temperature, lux, led, brightness}` to `/devices/{id}/events` every 5s. Subscribes to `/devices/{id}/config` and `/devices/{id}/commands/#` for control.
- **Config schema** in `mos.yml` under `ecogarden.*`: `led_pin` (default 4), `sensor_interval_ms` (default 5000), `onewire_pin` (default 13).
- **Note:** `mos.yml.example` is outdated (v1.1.0) — missing `onewire` lib and `ecogarden.onewire_pin`. Actual firmware is v1.3.0.

### Monitor Patterns (`monitor/`)

- **Entry point** `app.py`: Loads `config.yaml`, creates shared `state` dict passed to all modules, starts MQTT client thread + scheduler thread + Flask server.
- **Scheduler** (`scheduler.py`): Uses `schedule` library in daemon thread (30s poll). Jobs: capture (every 30min, 06:00-22:00) → timelapse (22:30 daily, Sunday 23:00 weekly) → analysis (10:00/18:00) → cleanup (01:00).
- **Config**: `config.yaml` for settings, `herbs.yaml` for herb care knowledge (12 species). Secrets via env vars (`ANTHROPIC_API_KEY`, `INFLUXDB_TOKEN`).
- **Analysis** (`analyzer.py`): Uses `claude-sonnet-4-5-20250929`. Output files: `analysis/YYYY-MM-DD_HH-MM.json` (includes time to avoid overwrite on twice-daily runs).
- **Web** (`web.py`): Flask REST API + Jinja2 dashboard. No authentication (local network). Temperature history in-memory buffer (up to 1440 points/24h). Light history via InfluxDB Flux queries. Path traversal prevention on file-serving routes via `os.realpath` + `startswith` check.
- **Frontend** (`static/app.js` + `style.css` + `templates/index.html`): Vanilla JS, no framework. Custom SVG charts. Polling: status every 60s, temp history every 60s, latest photo every 5min. Creature animations (koi fish, sea turtle, shark easter egg) spawned on timed delays.

### No Tests, CI, or Linting

This project has no test suite, no CI/CD pipeline, and no linter configuration. Manual testing against live hardware.

## Device Info

- **Device ID:** esp8266_5A604B
- **IP:** 192.168.1.196 (MAC: 8EAAB55A604B)
- **Firmware:** v1.3.0 (custom Mongoose OS 2.20.0)
- **Pi Monitor:** 192.168.1.58:8080
- **MQTT broker:** 192.168.1.5:1883 (currently down — monitor uses HTTP fallback)

## Commands

### Firmware

```bash
# Build (requires mos tool)
cd firmware && mos build --platform esp8266

# OTA flash (direct upload - works without Mongoose OS license)
curl -F "file=@build/fw.zip" http://192.168.1.196/update

# Serial flash (bricked device) - see docs/FLASHING.md
mos flash --port /dev/ttyUSB0

# Note: OTA.Update RPC requires Mongoose license; use /update endpoint instead
```

### Monitor

```bash
# Run locally (development)
cd monitor && python app.py

# Install Python dependencies
cd monitor && python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt

# Deploy to Raspberry Pi (idempotent: installs deps, creates systemd service, starts)
cd monitor && ./deploy.sh

# On Pi: manage service
sudo systemctl {status|restart} ecogarden-monitor
journalctl -u ecogarden-monitor -f

# Secrets on Pi (mode 600, read by systemd EnvironmentFile)
sudo nano /etc/ecogarden-monitor.env   # ANTHROPIC_API_KEY, INFLUXDB_TOKEN
```

### Manual Deploy to Pi

```bash
sshpass -p 'REDACTED' scp monitor/web.py pi@192.168.1.58:/home/pi/ecogarden/monitor/
sshpass -p 'REDACTED' scp monitor/static/app.js pi@192.168.1.58:/home/pi/ecogarden/monitor/static/
sshpass -p 'REDACTED' scp monitor/templates/index.html pi@192.168.1.58:/home/pi/ecogarden/monitor/templates/
sshpass -p 'REDACTED' ssh pi@192.168.1.58 "sudo systemctl restart ecogarden-monitor"
```

### Home Assistant

```bash
cd homeassistant && docker compose up -d
# HA: http://localhost:8123 | Grafana: http://localhost:3000 | InfluxDB: http://localhost:8086
```

Main HA setup (with all your devices): `~/homeassistant`

## HTTP API (ESP8266)

```bash
# Sensors
curl http://192.168.1.196/hooks/light_sensor        # {"value": 0.0-1.0}
curl http://192.168.1.196/hooks/water_temperature   # {"value": 25.38}

# LED control
curl "http://192.168.1.196/hooks/set_led_brightness?value=0.8"
curl "http://192.168.1.196/hooks/set_automatic_led_brightness?value=1"

# Feeder (pulses GPIO 1 HIGH for 2 seconds)
curl http://192.168.1.196/hooks/feed_now
```

## RPC API (ESP8266)

```bash
curl http://192.168.1.196/rpc/LED.Set -d '{"state":true}'
curl http://192.168.1.196/rpc/LED.Toggle
curl http://192.168.1.196/rpc/LED.Get
curl http://192.168.1.196/rpc/Temp.Scan    # Re-scan 1-Wire bus
curl http://192.168.1.196/rpc/Temp.Read    # Read current temperature
curl "http://192.168.1.196/rpc/GPIO.Write?pin=4&value=1"
curl "http://192.168.1.196/rpc/GPIO.Read?pin=4"
curl http://192.168.1.196/rpc/I2C.Scan

# MQTT control
mosquitto_pub -h localhost -t '/devices/esp8266_5A604B/config' -m '{"led":1}'
```

## Hardware

| Component | GPIO | Notes |
|-----------|------|-------|
| LED/Growlight | 4 | HIGH=on |
| Button | 0 | |
| I2C SDA/SCL | 12/14 | TSL2561 lux sensor at 0x39 |
| DS18B20 temp | 13 | 1-Wire, addr 28:FF:67:4F:75:A0:4C:A3, auto-init at boot |
| Feeder | 1 (TX0) | DC motor, 2s HIGH pulse. Hidden during dev because TX0 is serial logging |
| Pump | N/A | Runs continuously when powered, no GPIO control |
| Water level switches | N/A | Hardwired inline with pump circuit (dry-run safety cutoff, not software-readable) |

## WiFi Provisioning

Device creates AP `EcoGarden-Setup` (password: `ecogarden`) on first boot or when STA connection fails (15s timeout). Configure at http://192.168.4.1. AP turns off once STA connects. Factory reset: `mos config-set wifi.sta.ssid="" wifi.sta.pass=""`

## Home Assistant Automations

Growlight sunrise/sunset ramp (06:00-07:00 up, 20:30-22:00 down), feeding (08:00 + 18:00), temp/light alerts. Config in `homeassistant/config/automations.yaml` (note: this file also contains unrelated home automations).

## TODO

1. **MQTT broker:** Investigate why broker at 192.168.1.5 is down. Monitor works via HTTP fallback but loses real-time sensor push.
2. **Feeder tuning:** Test optimal pulse duration for portion control (currently 2 seconds).
3. **Build and OTA flash** updated firmware: `cd firmware && mos build --platform esp8266 && curl -F "file=@build/fw.zip" http://192.168.1.196/update`
4. **Update `mos.yml.example`** to match v1.3.0 (add `onewire` lib, `ecogarden.onewire_pin` config).
