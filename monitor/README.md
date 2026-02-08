# EcoGarden Plant Monitor

Raspberry Pi-based plant monitoring for the EcoGarden aquaponic system. Captures photos, generates timelapses, runs AI health analysis via Claude, and serves a web dashboard.

## Hardware

- Raspberry Pi 3 (192.168.1.58)
- Logitech HD USB camera (pointed at growing pod)
- EcoGarden ESP8266 providing sensor data via MQTT

## Quick Setup

### On the Raspberry Pi

```bash
# Clone the repo
git clone https://github.com/magnusmanders-web/ecogarden.git
cd ecogarden/monitor

# Run the deploy script (installs everything)
chmod +x deploy.sh
./deploy.sh
```

### Manual Setup

```bash
# Install system dependencies
sudo apt-get install -y fswebcam ffmpeg python3-venv

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install Python dependencies
pip install -r requirements.txt

# Set API key for AI analysis
export ANTHROPIC_API_KEY="your-key-here"

# Edit config
nano config.yaml  # Update plant info, dates, MQTT broker, etc.

# Run
python app.py
```

## Access

- **Dashboard:** http://192.168.1.58:8080
- **Latest photo:** http://192.168.1.58:8080/api/photos/latest
- **MJPEG stream (for HA):** http://192.168.1.58:8080/stream

## Configuration

Edit `config.yaml` to:
- Add/remove plants (name, species, planted date, position)
- Change capture schedule (interval, hours)
- Set AI analysis times
- Configure MQTT broker and InfluxDB

## Home Assistant Integration

See `ha_config_snippet.yaml` for the configuration to add to your Home Assistant `configuration.yaml`.

## Systemd Service

```bash
# Install service
sudo cp ecogarden-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ecogarden-monitor
sudo systemctl start ecogarden-monitor

# Check status
sudo systemctl status ecogarden-monitor

# View logs
journalctl -u ecogarden-monitor -f
```

## Directory Structure

```
photos/YYYY-MM-DD/YYYY-MM-DD_HH-MM.jpg   # Captured photos
timelapse/daily/YYYY-MM-DD.mp4            # Daily timelapse videos
timelapse/weekly/YYYY-Www.mp4             # Weekly compilations
analysis/YYYY-MM-DD.json                  # AI analysis results
```

## Storage

- Photos: 30-day rolling retention, noon shot kept as archive
- Timelapses: kept indefinitely
- ~150MB/day at 1080p JPEG quality 85
