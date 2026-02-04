# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Reviving an EcoGarden (Kickstarter by Ecobloom) after their cloud service was decommissioned. Custom Mongoose OS firmware restores local control via HTTP RPC and MQTT.

## Architecture

```
firmware/
├── src/main.c       # C firmware: RPC handlers, MQTT pub/sub, GPIO control
├── mos.yml          # Mongoose OS config: libs, config schema, WiFi/MQTT settings
└── fs/index.html    # Web UI served by device

backup/              # Original device config/code for reference
├── config.json      # Original device settings (includes I2C config, GCP settings)
└── init.js          # Original mJS firmware (used GPIO 2 for LED)
```

**Firmware pattern:** RPC handlers in `main.c` follow the pattern: parse JSON args → perform action → send JSON response. MQTT handler subscribes to `/devices/{id}/config` and `/devices/{id}/commands/#`.

## Commands

```bash
# Build firmware (requires mos tool)
cd firmware && mos build --platform esp8266

# OTA flash (direct upload to device - this works without license)
curl -F "file=@build/fw.zip" http://192.168.1.196/update

# Note: OTA.Update RPC requires Mongoose OS license, use /update endpoint instead
```

## Home Assistant API

HTTP endpoints compatible with original EcoGarden firmware (use with farstreet/HA_ecobloom_ecogarden configs):

```bash
# Sensors
curl http://192.168.1.196/hooks/light_sensor        # {"value": 0.0-1.0}
curl http://192.168.1.196/hooks/water_temperature   # {"value": 24.75}

# LED control (value: 0.0-1.0)
curl "http://192.168.1.196/hooks/set_led_brightness?value=0.8"
curl "http://192.168.1.196/hooks/set_automatic_led_brightness?value=1"

# Feeder (stub - GPIO not yet discovered)
curl http://192.168.1.196/hooks/feed_now
```

## RPC API

```bash
# LED control via HTTP RPC
curl http://192.168.1.196/rpc/LED.Set -d '{"state":true}'
curl http://192.168.1.196/rpc/LED.Toggle
curl http://192.168.1.196/rpc/LED.Get

# LED control via MQTT
mosquitto_pub -h localhost -t '/devices/esp8266_5A604B/config' -m '{"led":1}'

# GPIO testing (for discovering unknown pins)
curl "http://192.168.1.196/rpc/GPIO.Write?pin=4&value=1"
curl "http://192.168.1.196/rpc/GPIO.Read?pin=4"

# I2C scan
curl http://192.168.1.196/rpc/I2C.Scan
```

## Hardware

| Component | GPIO | Status |
|-----------|------|--------|
| LED/Growlight | 4 | Working (HIGH=on) |
| Button | 0 | Confirmed |
| I2C SDA | 12 | Confirmed |
| I2C SCL | 14 | Confirmed |
| Lux sensor | I2C 0x39 | TSL2561 - working via /hooks/light_sensor |
| Pump | N/A | Runs continuously when powered, no control needed |
| Feeder | Unknown | See investigation notes below |
| Temp sensor | Unknown | Not on I2C, placeholder value used |

### Feeder Investigation (2024-02)

Extensive diagnostics found no feeder control:

- **Original firmware** (`backup/init.js`, `backup/config.json`) only has LED control - no feeder code or GPIO
- **I2C scan** found only TSL2561 (0x39) - no motor driver ICs
- **GPIO tested**: 1,2,3,5,9,10,13,15,16 with servo PWM, DC pulses, active-low - nothing moved
- **Web research**: [farstreet/HA_ecobloom_ecogarden](https://github.com/farstreet/HA_ecobloom_ecogarden) notes "Ecobloom is still creating the endpoints" - feeder may never have been fully implemented
- **Ecobloom contact** (hello@ecobloom.se) - unresponsive

**Likely scenarios:**
1. Feeder was cloud-only (GCP IoT Core) with no local control
2. Separate MCU controls feeder, not accessible from ESP8266
3. Hardware not connected to accessible GPIO

**Next step:** Photograph internals during tank maintenance to trace feeder wiring

Device IP: 192.168.1.196 | MQTT broker: 192.168.1.5:1883

## Config Schema

Custom settings in `mos.yml` under `ecogarden.*`:
- `ecogarden.led_pin` (int, default 4)
- `ecogarden.sensor_interval_ms` (int, default 5000)

## Home Assistant Setup

```bash
cd homeassistant
docker compose up -d
# Access at http://localhost:8123
```

The config provides:
- Light sensor (0-100%)
- Water temperature sensor
- Growlight on/off control
- Feed fish button (stub until GPIO found)
- Auto brightness toggle

## TODO

1. **Feeder:** Photograph internals during maintenance, trace feeder wiring to identify control method
2. **Temp sensor:** May be 1-Wire DS18B20, not visible in tank
3. **Security:** Replace hardcoded WiFi credentials with BLE provisioning before GitHub release
4. **GitHub:** Create repo and push (mos.yml with credentials is gitignored)
