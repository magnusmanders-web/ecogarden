# EcoGarden Rescue Firmware

Custom firmware to revive the [EcoGarden](https://ecobloom.se/) (Kickstarter by Ecobloom) after their cloud service was decommissioned. Restores **full local control** via HTTP and MQTT — no cloud dependency.

## Features

- **Local HTTP API** — compatible with original `/hooks/*` endpoints (works with [farstreet's HA integration](https://github.com/farstreet/HA_ecobloom_ecogarden))
- **MQTT sensor publishing** — water temperature, light level, LED state
- **RPC control interface** — LED, temperature, GPIO, I2C
- **Growlight control** — on/off, brightness, auto-brightness
- **Fish feeder** — local feeding via GPIO 1 (TX0), was cloud-only in original firmware
- **Water temperature** — DS18B20 sensor on GPIO 13 (auto-discovered, was hidden behind UART config)
- **OTA firmware updates** — flash over WiFi, no serial adapter needed
- **WiFi provisioning** — captive portal for setup, no config file editing
- **Home Assistant + InfluxDB + Grafana** — Docker stack included
- **Raspberry Pi monitor dashboard** — photo capture, AI plant health analysis, timelapse generation

## Quick Start

### 1. Build and Flash

Requires the [Mongoose OS mos tool](https://mongoose-os.com/docs/mongoose-os/quickstart/setup.md).

```bash
cd firmware
mos build --platform esp8266

# OTA flash (device already on your network)
curl -F "file=@build/fw.zip" http://DEVICE_IP/update
```

For serial flashing (new device or bricked), see [docs/FLASHING.md](docs/FLASHING.md).

### 2. Configure WiFi

1. Connect to the device's hotspot: **EcoGarden-Setup** (password: `ecogarden`)
2. Open http://192.168.4.1
3. Select your WiFi network and enter password
4. Device reboots and connects — AP turns off automatically

Falls back to AP mode after 15 seconds if connection fails.

### 3. Verify

```bash
# Check light sensor
curl http://DEVICE_IP/hooks/light_sensor

# Check water temperature
curl http://DEVICE_IP/hooks/water_temperature

# Toggle growlight
curl http://DEVICE_IP/rpc/LED.Toggle

# Feed fish
curl http://DEVICE_IP/hooks/feed_now
```

## Hardware

| Component | GPIO | Notes |
|-----------|------|-------|
| LED/Growlight | 4 | HIGH = on, supports brightness control |
| Button | 0 | Boot mode select |
| I2C SDA / SCL | 12 / 14 | Shared bus |
| Light sensor (TSL2561) | I2C 0x39 | Real lux values, returned as 0.0–1.0 |
| Water temp (DS18B20) | 13 | 1-Wire, auto-init at boot, reads every 5s |
| Feeder | 1 (TX0) | DC motor, 2s HIGH pulse per feeding |
| Pump | N/A | Runs continuously when powered, no GPIO control |
| Water level switches | N/A | Hardwired inline with pump circuit as dry-run safety cutoff (not software-readable) |

### Discovery Notes

**Temperature sensor (GPIO 13):** Originally configured as UART1 RX for assumed TuyaMCU communication. A full-GPIO 1-Wire scan revealed a DS18B20 sensor — there is no secondary MCU.

**Feeder (GPIO 1 / TX0):** Was cloud-only via Firebase → GCP IoT Core → MQTT in the original firmware. No local feed endpoint existed. GPIO 1 was masked during development because UART0 TX uses the same pin for serial logging. Confirmed via audible motor testing.

**Water level microswitches:** Two 1P2T microswitches (from founder schematics) are wired inline with the pump power circuit. They cut pump power when water is low — purely electrical, not readable via GPIO.

## API Reference

### HTTP Endpoints (`/hooks/*`)

Compatible with the original EcoGarden API and [farstreet's HA integration](https://github.com/farstreet/HA_ecobloom_ecogarden).

```bash
# Sensors
curl http://DEVICE_IP/hooks/light_sensor            # {"value": 0.0-1.0}
curl http://DEVICE_IP/hooks/water_temperature       # {"value": 25.38}

# LED control (value: 0.0-1.0)
curl "http://DEVICE_IP/hooks/set_led_brightness?value=0.8"
curl "http://DEVICE_IP/hooks/set_automatic_led_brightness?value=1"

# Feeder (pulses GPIO 1 HIGH for 2 seconds)
curl http://DEVICE_IP/hooks/feed_now
```

### RPC Endpoints

```bash
curl http://DEVICE_IP/rpc/LED.Set -d '{"state":true}'
curl http://DEVICE_IP/rpc/LED.Toggle
curl http://DEVICE_IP/rpc/LED.Get
curl http://DEVICE_IP/rpc/Temp.Read       # Current temperature
curl http://DEVICE_IP/rpc/Temp.Scan       # Re-scan 1-Wire bus
curl http://DEVICE_IP/rpc/I2C.Scan        # List I2C devices
curl "http://DEVICE_IP/rpc/GPIO.Write?pin=4&value=1"
curl "http://DEVICE_IP/rpc/GPIO.Read?pin=4"
```

### MQTT

Publishes `{water_temperature, lux, led, brightness}` to `/devices/{device_id}/events` every 5 seconds.

Subscribes to:
- `/devices/{device_id}/config` — e.g. `{"led":1}`, `{"brightness":0.5}`
- `/devices/{device_id}/commands/#` — e.g. `{"on":true}`

```bash
mosquitto_pub -h BROKER -t '/devices/esp8266_XXXX/config' -m '{"led":1}'
```

### Firmware Config

Custom settings in `mos.yml` under `ecogarden.*`:

| Setting | Default | Description |
|---------|---------|-------------|
| `ecogarden.led_pin` | 4 | Growlight GPIO |
| `ecogarden.sensor_interval_ms` | 5000 | MQTT publish interval (ms) |
| `ecogarden.onewire_pin` | 13 | DS18B20 1-Wire GPIO |

## Home Assistant Setup

A Docker-based stack is included (Home Assistant + InfluxDB 2.7 + Grafana):

```bash
cd homeassistant
docker compose up -d
# HA: http://localhost:8123 | Grafana: http://localhost:3000 | InfluxDB: http://localhost:8086
```

Or add to your existing Home Assistant — see `homeassistant/config/configuration.yaml` for sensor/switch/button configs.

The included automations provide:
- Growlight sunrise/sunset ramp (06:00–07:00 up, 20:30–22:00 down)
- Twice-daily feeding (08:00 + 18:00)
- Temperature and light level alerts

## Raspberry Pi Monitor

An optional plant monitoring dashboard for a Raspberry Pi with a USB camera pointed at the garden.

**Features:**
- Web dashboard on port 8080 with live sensor data and SVG charts
- Photo capture every 30 minutes (06:00–22:00) with automatic daily/weekly timelapse
- AI plant health analysis via Claude API (twice daily at 10:00 and 18:00)
- Photo gallery with date browsing, fullscreen view, and on-demand timelapse
- Plant health cards with growth stage tracking (12 herb species knowledge base)
- Growlight toggle and fish feeder controls
- MJPEG stream for Home Assistant camera entity
- Temperature and light sensor history charts

```bash
# Run locally
cd monitor && python app.py

# Deploy to Pi (installs deps, creates systemd service)
cd monitor && ./deploy.sh
```

The monitor connects to the EcoGarden via MQTT (with HTTP fallback) and stores metrics in InfluxDB.

## Project Structure

```
firmware/          ESP8266 Mongoose OS firmware (C)
├── src/main.c     RPC handlers, HTTP hooks, MQTT, GPIO, sensors
├── mos.yml        Device config (not in git)
└── fs/index.html  WiFi provisioning portal

monitor/           Raspberry Pi dashboard (Python 3, Flask)
├── app.py         Entry point
├── web.py         Flask routes + REST API
├── analyzer.py    AI plant health analysis (Claude API)
├── capture.py     Photo capture (fswebcam / OpenCV)
├── timelapse.py   Video generation (ffmpeg)
├── scheduler.py   Background task scheduling
├── config.yaml    Settings (plants, schedule, MQTT, InfluxDB)
├── herbs.yaml     Herb care knowledge base
├── static/        Frontend JS + CSS (vanilla, no framework)
└── templates/     Jinja2 dashboard template

homeassistant/     Docker stack
├── docker-compose.yml    HA + InfluxDB 2.7 + Grafana
├── config/               HA sensors, switches, automations
└── grafana/              Dashboard provisioning

docs/              Flashing guide, schematics
```

## Contributing

Contributions welcome! Areas of interest:
- Additional EcoGarden/EcoBloom hardware documentation and teardown photos
- Feeder pulse duration tuning for different food types
- Water quality sensor integration (EC/pH)

If you have an EcoGarden and discover something new about the hardware, please open an issue or PR.

## License

MIT

## Acknowledgments

- Original EcoGarden by [Ecobloom](https://ecobloom.se/)
- Home Assistant integration inspired by [farstreet/HA_ecobloom_ecogarden](https://github.com/farstreet/HA_ecobloom_ecogarden)
