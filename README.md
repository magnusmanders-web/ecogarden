# EcoGarden Rescue Firmware

Custom firmware to revive EcoGarden (Kickstarter by Ecobloom) after their cloud service was decommissioned. Restores local control via HTTP and MQTT.

## Features

- Local HTTP API compatible with original EcoGarden `/hooks/*` endpoints
- MQTT sensor publishing
- RPC control interface
- OTA firmware updates
- Home Assistant ready

## Hardware Status

| Component | Status |
|-----------|--------|
| LED/Growlight | Working (GPIO 4) |
| Light Sensor (TSL2561) | Working (I2C 0x39) |
| Water Temperature | Placeholder (sensor not found) |
| Feeder | Not implemented (see below) |
| Pump | Runs continuously (no control needed) |

### Feeder Status

Extensive investigation found no way to control the feeder:
- Original firmware only contained LED control code
- No motor driver ICs found on I2C bus
- All available GPIO pins tested with no result
- The [farstreet HA integration](https://github.com/farstreet/HA_ecobloom_ecogarden) notes Ecobloom was "still creating the endpoints"

The feeder may have been cloud-only (GCP IoT Core) or controlled by separate hardware. The `/hooks/feed_now` endpoint exists but returns a stub response. If you discover the feeder GPIO, please open an issue or PR!

## Quick Start

### Prerequisites

- [Mongoose OS mos tool](https://mongoose-os.com/docs/mongoose-os/quickstart/setup.md)
- Device connected to your WiFi network

### Configure WiFi

Edit `firmware/mos.yml` and set your WiFi credentials:

```yaml
config_schema:
  - ["wifi.sta.ssid", "YOUR_SSID"]
  - ["wifi.sta.pass", "YOUR_PASSWORD"]
```

### Build and Flash

```bash
cd firmware
mos build --platform esp8266

# OTA flash (replace IP with your device's IP)
curl -F "file=@build/fw.zip" http://YOUR_DEVICE_IP/update
```

## API Reference

### Home Assistant Compatible Endpoints

```bash
# Light sensor (returns 0.0-1.0)
curl http://DEVICE_IP/hooks/light_sensor

# Water temperature
curl http://DEVICE_IP/hooks/water_temperature

# Set LED brightness (0.0-1.0)
curl "http://DEVICE_IP/hooks/set_led_brightness?value=0.8"

# Enable auto brightness
curl "http://DEVICE_IP/hooks/set_automatic_led_brightness?value=1"

# Feed fish (stub - not yet functional)
curl http://DEVICE_IP/hooks/feed_now
```

### RPC Endpoints

```bash
# LED control
curl http://DEVICE_IP/rpc/LED.Set -d '{"state":true}'
curl http://DEVICE_IP/rpc/LED.Toggle
curl http://DEVICE_IP/rpc/LED.Get

# GPIO testing
curl "http://DEVICE_IP/rpc/GPIO.Write?pin=4&value=1"
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

### Confirmed GPIO Mapping

- **GPIO 4**: LED/Growlight (HIGH = on)
- **GPIO 0**: Button
- **GPIO 12**: I2C SDA
- **GPIO 14**: I2C SCL

### I2C Devices

- **0x39 (57)**: TSL2561 Light Sensor

### Unknown Hardware

The feeder servo and temperature sensor GPIOs are not documented in the original firmware. If you discover these, please open an issue or PR!

Tested GPIOs that are NOT the feeder: 1, 2, 3, 5, 9, 10, 13, 15, 16

## Contributing

Contributions welcome! Especially:
- Feeder servo GPIO discovery
- Temperature sensor identification
- Additional EcoGarden/EcoBloom hardware documentation

## License

MIT

## Acknowledgments

- Original EcoGarden by [Ecobloom](https://ecobloom.se/)
- Home Assistant integration inspired by [farstreet/HA_ecobloom_ecogarden](https://github.com/farstreet/HA_ecobloom_ecogarden)
