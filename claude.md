# EcoGarden Rescue Project

## Overview
Reviving an EcoGarden (Kickstarter by Ecobloom) after their cloud service was decommissioned. Built custom Mongoose OS firmware to restore local control.

## Hardware
- **Device:** ESP8266 (esp8266_5A604B)
- **IP:** 192.168.1.196
- **Original firmware:** EcoGarden v0.1.2 (Mongoose OS 2.15.0)
- **Custom firmware:** v1.0.0 (Mongoose OS 2.20.0)

## GPIO Mapping (confirmed)
- **LED/Growlight:** GPIO 4 (HIGH = on)
- **Button:** GPIO 0
- **I2C SDA:** GPIO 12
- **I2C SCL:** GPIO 14

## GPIO Mapping (to discover)
- Pump: unknown
- Feeder: unknown
- Temp sensor: likely I2C
- Lux sensor: likely I2C

## Current Status
- LED control working via HTTP RPC and MQTT
- Device connected to local MQTT broker (192.168.1.5:1883)
- OTA update capability preserved
- Original config backed up in `/backup/`

## TODO (Next Session)
1. **Discover all hardware**
   - Find pump GPIO pin
   - Find feeder GPIO pin
   - Identify I2C devices (temp sensor, lux sensor)
   - Test each component

2. **Build complete firmware**
   - Add pump control RPC
   - Add feeder control RPC
   - Add real sensor readings (replace hardcoded values)
   - Add Bluetooth/WiFi provisioning (remove hardcoded credentials!)

3. **Home Assistant Integration**
   - Implement MQTT auto-discovery protocol
   - Entities: light, pump, feeder, water_temp sensor, lux sensor
   - Auto-configure in HASS

4. **Publish to GitHub**
   - Clean up code
   - Write setup instructions
   - Document OTA flash process
   - Add BLE provisioning guide

## Commands
```bash
# LED Control
curl http://192.168.1.196/rpc/LED.Set -d '{"state":true}'
curl http://192.168.1.196/rpc/LED.Toggle

# MQTT
mosquitto_pub -h localhost -t '/devices/esp8266_5A604B/config' -m '{"led":1}'

# GPIO Testing
curl "http://192.168.1.196/rpc/GPIO.Write?pin=4&value=1"
curl "http://192.168.1.196/rpc/GPIO.Read?pin=4"

# Build & Flash
cd firmware && mos build --platform esp8266
curl -X POST -d '{"url":"http://192.168.1.5:8765/firmware-esp8266-1.0.0.zip"}' http://192.168.1.196/rpc/OTA.Update
```

## WiFi
- SSID: Skynet
- Credentials in device config (security risk - need BLE provisioning)
