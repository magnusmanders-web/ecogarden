# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Reviving an EcoGarden (Kickstarter by Ecobloom) after their cloud service was decommissioned. Custom Mongoose OS firmware restores local control via HTTP RPC and MQTT.

**GitHub:** https://github.com/magnusmanders-web/ecogarden

## Device Info

- **Device ID:** esp8266_5A604B
- **MAC:** 8EAAB55A604B
- **IP:** 192.168.1.196
- **Firmware:** v1.1.0 (custom Mongoose OS 2.20.0)
- **MQTT broker:** 192.168.1.5:1883
- **WiFi:** Configured via web portal (no hardcoded credentials)

## Current Status (Feb 2026)

**Working:**
- LED/Growlight control (GPIO 4) via HTTP and MQTT
- Light sensor (TSL2561 on I2C 0x39) - real lux values
- Home Assistant integration at ~/homeassistant
- OTA firmware updates via /update endpoint
- TuyaMCU UART communication (sends commands, no MCU response detected yet)

**Not working / Unknown:**
- Feeder servo - GPIO unknown, extensive testing failed (see investigation below)
- Temperature sensor - not on I2C, likely 1-Wire DS18B20, returns placeholder 24.75°C (1-Wire lib disabled to save memory for OTA)

**Not needed:**
- Pump - runs continuously when powered, no control required

## Architecture

```
firmware/
├── src/main.c       # C firmware: RPC handlers, MQTT pub/sub, GPIO, TuyaMCU
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

**TuyaMCU pattern:** The firmware includes a TuyaMCU protocol implementation for communicating with a potential secondary MCU over UART1 (9600 baud, GPIO 13 RX / GPIO 15 TX). Used to attempt feeder control via datapoint commands. MCU detection checked via heartbeat response (header 0x55 0xAA).

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
curl http://192.168.1.196/hooks/water_temperature   # {"value": 24.75}

# LED control (value: 0.0-1.0)
curl "http://192.168.1.196/hooks/set_led_brightness?value=0.8"
curl "http://192.168.1.196/hooks/set_automatic_led_brightness?value=1"

# Feeder (attempts TuyaMCU command)
curl http://192.168.1.196/hooks/feed_now
```

## RPC API

```bash
# LED control
curl http://192.168.1.196/rpc/LED.Set -d '{"state":true}'
curl http://192.168.1.196/rpc/LED.Toggle
curl http://192.168.1.196/rpc/LED.Get

# TuyaMCU / secondary MCU (for feeder investigation)
curl http://192.168.1.196/rpc/MCU.Heartbeat      # Detect MCU presence
curl http://192.168.1.196/rpc/MCU.Query           # Query MCU state
curl http://192.168.1.196/rpc/MCU.SendDP -d '{"dpid":1,"value":1}'  # Send datapoint
curl http://192.168.1.196/rpc/MCU.Feed            # Trigger feeder (tries dpIds 1,3,101-104)

# Temperature sensor (1-Wire disabled, returns placeholder)
curl http://192.168.1.196/rpc/Temp.Scan
curl http://192.168.1.196/rpc/Temp.Read

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
| UART1 RX (MCU) | 13 | TuyaMCU communication, 9600 baud |
| UART1 TX (MCU) | 15 | TuyaMCU communication, 9600 baud |
| Lux sensor | I2C 0x39 | TSL2561 - working via /hooks/light_sensor |
| Pump | N/A | Runs continuously when powered, no control needed |
| Feeder | Unknown | See investigation notes below |
| Temp sensor | 5 (configured, disabled) | 1-Wire DS18B20, lib disabled to save memory |

### Feeder Investigation (Feb 2026)

**APK Analysis (EcoGarden App v1.2):**
Decompiled the Android app and found the feeder control architecture:

```
App → Firebase → GCP IoT Core → MQTT → ESP8266 → GPIO → Feeder
```

Firebase paths used:
- `device/{deviceId}/component/feeder/feed_now` = true (triggers feed)
- `device/{deviceId}/component/feeder/schedule` (feeding schedule)
- `device/{deviceId}/component/feeder/automatic_feeding` (auto mode)
- `device/{deviceId}/component/feeder/history` (feed history)

**Key finding:** No local `/hooks/feed_now` endpoint ever existed in the original firmware. The feeder was **cloud-only** via Firebase/GCP IoT Core. The endpoint was "still being created" according to farstreet repo - it was never finished.

**Device-level testing:**
- **Original firmware** (`backup/init.js`, `backup/config.json`) only has LED control - no feeder code or GPIO
- **I2C scan** found only TSL2561 (0x39) - no motor driver ICs at common addresses (0x0F, 0x20-0x27, 0x38-0x3F, 0x40, 0x60, 0x68)
- **GPIO tested**: 1,2,3,5,9,10,13,15,16 with servo PWM, DC pulses, active-low - nothing moved
- **TuyaMCU tested**: Heartbeat/datapoint commands sent over UART1 - no response detected
- **OTA revert**: Slot 0 checked but original firmware not recoverable
- **Ecobloom contact** (hello@ecobloom.se) - unresponsive

**Conclusion:** The original firmware binary (which contained the GPIO→feeder mapping) was overwritten when we flashed custom firmware. The GPIO pin cannot be recovered via software. Physical inspection required.

**Next step:** Photograph internals during tank maintenance to trace feeder wiring

## Config Schema

Custom settings in `mos.yml` under `ecogarden.*`:
- `ecogarden.led_pin` (int, default 4) - LED/growlight GPIO
- `ecogarden.sensor_interval_ms` (int, default 5000) - MQTT sensor publish interval
- `ecogarden.mcu_uart` (int, default 1) - UART number for TuyaMCU communication
- `ecogarden.onewire_pin` (int, default 5) - 1-Wire GPIO for DS18B20 (currently disabled in code)

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
- Feed fish button (sends TuyaMCU command)
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

1. **Feeder:** Photograph internals during maintenance, trace feeder wiring to identify control method
2. **Temp sensor:** May be 1-Wire DS18B20, not visible in tank. Re-enable 1-Wire lib once confirmed (disabled to save memory for OTA)

## When Photos Are Available

When you have photos of the internals, look for and document:

1. **Main PCB** - Identify ESP8266 module, trace all wires
2. **Feeder motor** - What type? (servo with 3 wires, DC motor with 2, stepper with 4+)
3. **Motor driver** - Any IC near the motor? (L298N, DRV8833, TB6612, etc.)
4. **Secondary PCB** - Is there another microcontroller board?
5. **Wire colors** - Which wires go from feeder to main board, and to which pins?
6. **Temp sensor** - Look for small probe with 3 wires (DS18B20) or 2 wires (thermistor)

**To add feeder support once GPIO is found:**
1. Edit `firmware/src/main.c` - add GPIO control in `hook_feed_now()` function (line ~402)
2. Add to `mos.yml` config schema: `ecogarden.feeder_pin`
3. Build and OTA flash: `cd firmware && mos build --platform esp8266 && curl -F "file=@build/fw.zip" http://192.168.1.196/update`
