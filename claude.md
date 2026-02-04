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

# OTA flash (serve firmware zip on local HTTP server first)
curl -X POST -d '{"url":"http://192.168.1.5:8765/firmware-esp8266-1.0.0.zip"}' \
  http://192.168.1.196/rpc/OTA.Update

# LED control via HTTP RPC
curl http://192.168.1.196/rpc/LED.Set -d '{"state":true}'
curl http://192.168.1.196/rpc/LED.Toggle
curl http://192.168.1.196/rpc/LED.Get

# LED control via MQTT
mosquitto_pub -h localhost -t '/devices/esp8266_5A604B/config' -m '{"led":1}'

# GPIO testing (for discovering unknown pins)
curl "http://192.168.1.196/rpc/GPIO.Write?pin=4&value=1"
curl "http://192.168.1.196/rpc/GPIO.Read?pin=4"

# I2C scan (for finding sensors)
curl http://192.168.1.196/rpc/I2C.Scan
```

## Hardware

| Component | GPIO | Status |
|-----------|------|--------|
| LED/Growlight | 4 | Working (HIGH=on, code inverts for ESP8266) |
| Button | 0 | Confirmed |
| I2C SDA | 12 | Confirmed |
| I2C SCL | 14 | Confirmed |
| Pump | ? | Unknown |
| Feeder | ? | Unknown |
| Temp sensor | I2C | Unknown address |
| Lux sensor | I2C | Unknown address |

Device IP: 192.168.1.196 | MQTT broker: 192.168.1.5:1883

## Config Schema

Custom settings in `mos.yml` under `ecogarden.*`:
- `ecogarden.led_pin` (int, default 4)
- `ecogarden.sensor_interval_ms` (int, default 5000)

## TODO

1. **Hardware discovery:** Find pump/feeder GPIOs, identify I2C sensor addresses
2. **Complete firmware:** Add pump/feeder RPC, implement real sensor readings (currently hardcoded)
3. **Home Assistant:** MQTT auto-discovery for light, pump, feeder, sensors
4. **Security:** Replace hardcoded WiFi credentials with BLE provisioning
