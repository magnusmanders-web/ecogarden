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
- **WiFi:** Skynet (credentials in mos.yml, gitignored)

## Current Status (Feb 2026)

**Working:**
- LED/Growlight control (GPIO 4) via HTTP and MQTT
- Light sensor (TSL2561 on I2C 0x39) - real lux values
- Home Assistant integration at ~/homeassistant
- OTA firmware updates via /update endpoint

**Not working / Unknown:**
- Feeder servo - GPIO unknown, extensive testing failed (see investigation below)
- Temperature sensor - not on I2C, likely 1-Wire DS18B20, returns placeholder 24.75°C

**Not needed:**
- Pump - runs continuously when powered, no control required

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
- **OTA revert**: Slot 0 checked but original firmware not recoverable
- **Ecobloom contact** (hello@ecobloom.se) - unresponsive

**Conclusion:** The original firmware binary (which contained the GPIO→feeder mapping) was overwritten when we flashed custom firmware. The GPIO pin cannot be recovered via software. Physical inspection required.

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
3. **Security:** Replace hardcoded WiFi credentials with BLE provisioning

## When Photos Are Available

When you have photos of the internals, look for and document:

1. **Main PCB** - Identify ESP8266 module, trace all wires
2. **Feeder motor** - What type? (servo with 3 wires, DC motor with 2, stepper with 4+)
3. **Motor driver** - Any IC near the motor? (L298N, DRV8833, TB6612, etc.)
4. **Secondary PCB** - Is there another microcontroller board?
5. **Wire colors** - Which wires go from feeder to main board, and to which pins?
6. **Temp sensor** - Look for small probe with 3 wires (DS18B20) or 2 wires (thermistor)

**To add feeder support once GPIO is found:**
1. Edit `firmware/src/main.c` - add GPIO control in `hook_feed_now()` function (line ~209)
2. Add to `mos.yml` config schema: `ecogarden.feeder_pin`
3. Build and OTA flash: `cd firmware && mos build --platform esp8266 && curl -F "file=@build/fw.zip" http://192.168.1.196/update`

## Home Assistant Location

Main HA setup (with all your devices): `~/homeassistant`
Example HA config for EcoGarden: `./homeassistant/` (in this repo)

Start HA: `cd ~/homeassistant && docker compose up -d`
Access: http://localhost:8123
