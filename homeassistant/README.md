# Home Assistant + Grafana Setup for EcoGarden

This folder contains the Home Assistant configuration for monitoring and controlling the EcoGarden.

## Quick Start

```bash
cd homeassistant
docker compose up -d
```

## Services

| Service | URL | Default Login |
|---------|-----|---------------|
| Home Assistant | http://localhost:8123 | (create on first run) |
| Grafana | http://localhost:3000 | admin / ecogarden |
| InfluxDB | http://localhost:8086 | admin / ecogarden123 |

## Features

### Automations
- **Grow light schedule**: ON at 06:00, OFF at 22:00 (16 hours for optimal plant growth)
- **Fish feeding**: 08:00 and 18:00 daily
- **Temperature alerts**: Warning if water < 18°C or > 28°C
- **Low light warning**: Alert if light level drops below 10% for 30 minutes

### Grafana Dashboard
- Water temperature over time with safe zone thresholds
- Light level monitoring
- Current gauges for temperature and light
- Grow light status

## Configuration

### EcoGarden Device
The EcoGarden ESP8266 device should be at `192.168.1.196`. Update `config/configuration.yaml` if your device has a different IP.

### Timezone
Set to `Europe/Stockholm`. Change in `config/configuration.yaml` if needed.

## Security Note
The default passwords in this config are for local development. Change them for production use:
- InfluxDB: `DOCKER_INFLUXDB_INIT_PASSWORD` in docker-compose.yml
- Grafana: `GF_SECURITY_ADMIN_PASSWORD` in docker-compose.yml
- InfluxDB token: Update in all three places (docker-compose.yml, configuration.yaml, influxdb.yaml)

## File Structure
```
homeassistant/
├── docker-compose.yml      # Container definitions
├── config/
│   ├── configuration.yaml  # Home Assistant config
│   └── automations.yaml    # Automation rules
└── grafana/
    └── provisioning/
        ├── datasources/    # InfluxDB connection
        └── dashboards/     # EcoGarden dashboard
```
