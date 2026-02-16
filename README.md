# EcoGarden Rescue Firmware

Custom firmware to revive EcoGarden (Kickstarter by Ecobloom) after their cloud service was decommissioned. Restores local control via HTTP and MQTT, with a Raspberry Pi plant monitoring dashboard.

## Features

- Local HTTP API compatible with original EcoGarden `/hooks/*` endpoints
- MQTT sensor publishing (temperature, light level)
- RPC control interface
- OTA firmware updates
- WiFi provisioning via captive portal
- Home Assistant + InfluxDB + Grafana stack
- Raspberry Pi monitoring dashboard with AI plant health analysis

## Hardware Status

| Component | GPIO | Status |
|-----------|------|--------|
| LED/Growlight | 4 | Working (HIGH = on) |
| Light Sensor (TSL2561) | I2C 0x39 | Working - real lux values |
| Water Temperature (DS18B20) | 13 (1-Wire) | Working - real readings (~25°C) |
| Feeder | Unknown | GPIO not identified (see below) |
| Pump | N/A | Runs continuously (no control needed) |

### Temperature Sensor Discovery

GPIO 13 was originally assumed to be UART1 RX for TuyaMCU communication with a secondary MCU. A full 1-Wire scan discovered a **DS18B20 temperature sensor** on GPIO 13 (address `28:FF:67:4F:75:A0:4C:A3`). There is no secondary MCU — the TuyaMCU assumption was a red herring. The sensor is auto-initialized at boot and reads every 5 seconds.

### Feeder Status

The feeder was **cloud-only** via Firebase/GCP IoT Core in the original firmware. APK decompilation of the EcoGarden Android app (v1.2) confirmed the control flow:

```
App → Firebase → GCP IoT Core → MQTT → ESP8266 → GPIO → Feeder
```

No local `/hooks/feed_now` endpoint ever existed — the [farstreet HA integration](https://github.com/farstreet/HA_ecobloom_ecogarden) notes it was "still being created."

**Testing done:**
- GPIOs 1, 2, 3, 5, 9, 10, 15, 16 tested with servo PWM, DC motor pulses, active-low — nothing moved
- I2C scan: only TSL2561 (0x39), no motor driver ICs
- TuyaMCU heartbeat/datapoint commands over UART1: no response (no secondary MCU exists)
- GPIO 15 has a test pulse in `/hooks/feed_now` — needs physical verification

**Next step:** Photograph internals during tank maintenance to trace feeder wiring. If you discover the feeder GPIO, please open an issue or PR!

## Quick Start

### Prerequisites

- [Mongoose OS mos tool](https://mongoose-os.com/docs/mongoose-os/quickstart/setup.md)

### Build and Flash

```bash
cd firmware
mos build --platform esp8266

# OTA flash (if device is already on your network)
curl -X POST -F "filedata=@build/fw.zip;type=application/zip" http://DEVICE_IP/update
```

For serial flashing (new device or bricked), see [docs/FLASHING.md](docs/FLASHING.md).

### Configure WiFi

The firmware includes a WiFi provisioning portal - no need to edit config files!

1. **Connect to the device's hotspot:** `EcoGarden-Setup` (password: `ecogarden`)
2. **Open** http://192.168.4.1 in your browser
3. **Select your WiFi network** and enter password
4. **Save** - device reboots and connects to your network

The AP automatically turns off once connected. If connection fails, it falls back to AP mode after 15 seconds.

## API Reference

### Home Assistant Compatible Endpoints

```bash
# Light sensor (returns 0.0-1.0)
curl http://DEVICE_IP/hooks/light_sensor

# Water temperature (real DS18B20 reading)
curl http://DEVICE_IP/hooks/water_temperature

# Set LED brightness (0.0-1.0)
curl "http://DEVICE_IP/hooks/set_led_brightness?value=0.8"

# Enable auto brightness
curl "http://DEVICE_IP/hooks/set_automatic_led_brightness?value=1"

# Feed fish (pulses GPIO 15 HIGH for 2 seconds - unverified)
curl http://DEVICE_IP/hooks/feed_now
```

### RPC Endpoints

```bash
# LED control
curl http://DEVICE_IP/rpc/LED.Set -d '{"state":true}'
curl http://DEVICE_IP/rpc/LED.Toggle
curl http://DEVICE_IP/rpc/LED.Get

# Temperature sensor
curl http://DEVICE_IP/rpc/Temp.Read    # Read current temperature
curl http://DEVICE_IP/rpc/Temp.Scan    # Re-scan 1-Wire bus

# GPIO testing
curl "http://DEVICE_IP/rpc/GPIO.Write?pin=4&value=1"
curl "http://DEVICE_IP/rpc/GPIO.Read?pin=4"
curl http://DEVICE_IP/rpc/I2C.Scan
```

### MQTT

The device publishes sensor data to `/devices/{device_id}/events` and subscribes to:
- `/devices/{device_id}/config` - Configuration updates
- `/devices/{device_id}/commands/#` - Command messages

Control LED via MQTT:
```bash
mosquitto_pub -h BROKER -t '/devices/esp8266_XXXX/config' -m '{"led":1}'
mosquitto_pub -h BROKER -t '/devices/esp8266_XXXX/config' -m '{"brightness":0.5}'
```

## Home Assistant Setup

A Docker-based Home Assistant configuration is included:

```bash
cd homeassistant
docker compose up -d
# Access at http://localhost:8123
```

Or add to your existing Home Assistant - see `homeassistant/config/configuration.yaml`.

## Hardware Notes

### GPIO Mapping

| GPIO | Function | Notes |
|------|----------|-------|
| 0 | Button | Boot mode select |
| 4 | LED/Growlight | HIGH = on |
| 12 | I2C SDA | Shared bus |
| 13 | DS18B20 Temperature | 1-Wire, addr `28:FF:67:4F:75:A0:4C:A3` |
| 14 | I2C SCL | Shared bus |
| 15 | Feeder (test) | Pulse test added, unverified physically |

### I2C Devices

- **0x39 (57)**: TSL2561 Light Sensor

Tested GPIOs that are NOT the feeder: 1, 2, 3, 5, 9, 10, 16

## Raspberry Pi Monitor

A plant monitoring dashboard runs on a Raspberry Pi with a USB camera pointed at the garden:

- **Web dashboard** on port 8080 with live temperature, light level, and photo gallery
- **AI plant health analysis** via Claude API (twice daily)
- **Photo capture** every 30 minutes with automatic timelapse generation
- **Temperature history chart** with in-memory buffering
- **Light sensor history** via InfluxDB queries

```bash
cd monitor && python app.py        # Run locally
cd monitor && ./deploy.sh          # Deploy to Pi
```

See `monitor/` directory for full source.

## Contributing

Contributions welcome! Especially:
- Feeder GPIO discovery (photograph internals, trace wiring)
- Additional EcoGarden/EcoBloom hardware documentation

## License

MIT

## Acknowledgments

- Original EcoGarden by [Ecobloom](https://ecobloom.se/)
- Home Assistant integration inspired by [farstreet/HA_ecobloom_ecogarden](https://github.com/farstreet/HA_ecobloom_ecogarden)
