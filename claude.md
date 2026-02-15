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
- **MQTT broker:** 192.168.1.5:1883
- **WiFi:** Configured via web portal (no hardcoded credentials)

## Current Status (Feb 2026)

**Working:**
- LED/Growlight control (GPIO 4) via HTTP and MQTT
- Light sensor (TSL2561 on I2C 0x39) - real lux values
- Water temperature sensor (DS18B20 on GPIO 13) - real readings (~25°C)
- Home Assistant integration at ~/homeassistant
- OTA firmware updates via /update endpoint
- RPi plant monitor dashboard with live temperature

**Not working / Unknown:**
- Feeder - GPIO 15 pulse test added (was UART1 TX), physical inspection still needed

**Not needed:**
- Pump - runs continuously when powered, no control required

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
                                │
                          Claude API (AI analysis)
                                │
                          Flask dashboard (:8080)
```

**Firmware pattern:** RPC handlers in `main.c` follow: parse JSON args → perform action → send JSON response. HTTP hooks at `/hooks/*` are routed through a single `http_handler()` dispatcher. MQTT handler subscribes to `/devices/{id}/config` and `/devices/{id}/commands/#`.

**Monitor pattern:** `app.py` creates a shared `state` dict passed to all modules. Scheduler runs background tasks on a `schedule` library thread: capture (every 30min, 06:00-22:00) → timelapse (22:30) → analysis (10:00/18:00) → cleanup (01:00). Config is loaded from `config.yaml`; secrets come from env vars. Analysis output files use `YYYY-MM-DD_HH-MM.json` format (includes time to avoid overwrite on twice-daily runs).

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

## Home Assistant API

HTTP endpoints compatible with original EcoGarden firmware (use with farstreet/HA_ecobloom_ecogarden configs):

```bash
# Sensors
curl http://192.168.1.196/hooks/light_sensor        # {"value": 0.0-1.0}
curl http://192.168.1.196/hooks/water_temperature   # {"value": 25.38} (real DS18B20)

# LED control (value: 0.0-1.0)
curl "http://192.168.1.196/hooks/set_led_brightness?value=0.8"
curl "http://192.168.1.196/hooks/set_automatic_led_brightness?value=1"

# Feeder (pulses GPIO 15 HIGH for 2 seconds)
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
| Feeder (test) | 15 | Pulse test added, physical inspection needed |
| Lux sensor | I2C 0x39 | TSL2561 - working via /hooks/light_sensor |
| Pump | N/A | Runs continuously when powered, no control needed |

### Temperature Sensor Discovery (Feb 2026)

GPIO 13 was originally configured as UART1 RX for TuyaMCU communication. A full-GPIO 1-Wire scan discovered a DS18B20 temperature sensor on GPIO 13 (address `28:FF:67:4F:75:A0:4C:A3`). The TuyaMCU assumption was a red herring - there is no secondary MCU. The DS18B20 is now auto-initialized at boot and reads every 5 seconds.

### Feeder Investigation (Feb 2026)

**APK Analysis:** Feeder was cloud-only via Firebase/GCP IoT Core. No local `/hooks/feed_now` endpoint existed in the original firmware.

**Testing done:**
- GPIO 1,2,3,5,9,10,16 tested with servo PWM, DC pulses, active-low - nothing moved
- GPIO 13 turned out to be DS18B20 temp sensor (not UART1 RX)
- GPIO 15 (was UART1 TX) now has a pulse test in `/hooks/feed_now` - untested physically
- I2C scan: only TSL2561 (0x39), no motor driver ICs
- TuyaMCU heartbeat/datapoint commands: no response (there is no secondary MCU)
- Original firmware not recoverable from OTA slot

**Next step:** Photograph internals during tank maintenance to trace feeder wiring, test GPIO 15 pulse physically

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
- Feed fish button (pulses GPIO 15)
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

## TODO

1. **Feeder:** Photograph internals during maintenance, trace feeder wiring. GPIO 15 pulse test is ready (`/hooks/feed_now`), needs physical verification.

## When Photos Are Available

When you have photos of the internals, look for and document:

1. **Main PCB** - Identify ESP8266 module, trace all wires
2. **Feeder motor** - What type? (servo with 3 wires, DC motor with 2, stepper with 4+)
3. **Motor driver** - Any IC near the motor? (L298N, DRV8833, TB6612, etc.)
4. **Wire colors** - Which wires go from feeder to main board, and to which pins?
5. **Confirm DS18B20** - Should be visible as small probe with 3 wires on GPIO 13

**To update feeder GPIO once confirmed:**
1. Edit `firmware/src/main.c` - update `s_feeder_pin` in `mgos_app_init()` (currently GPIO 15)
2. Build and OTA flash: `cd firmware && mos build --platform esp8266 && curl -F "file=@build/fw.zip" http://192.168.1.196/update`
