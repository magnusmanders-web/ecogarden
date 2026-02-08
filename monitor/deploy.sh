#!/usr/bin/env bash
# EcoGarden Plant Monitor - Deployment Script
# Run on the Raspberry Pi to set up the monitor service.
#
# Usage: ./deploy.sh
# Idempotent - safe to run multiple times.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== EcoGarden Plant Monitor Setup ==="

# 1. Install system packages
echo ""
echo "--- Installing system packages ---"
sudo apt-get update -qq
sudo apt-get install -y -qq fswebcam ffmpeg python3-venv python3-dev

# 2. Create Python virtual environment
echo ""
echo "--- Setting up Python environment ---"
if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo "Created virtual environment"
else
    echo "Virtual environment already exists"
fi

source venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
echo "Python dependencies installed"

# 3. Create data directories
echo ""
echo "--- Creating data directories ---"
mkdir -p photos timelapse/daily timelapse/weekly analysis

# 4. Test camera
echo ""
echo "--- Testing camera ---"
if command -v fswebcam &>/dev/null; then
    if fswebcam --test -q 2>/dev/null; then
        echo "Camera detected via fswebcam"
    else
        echo "WARNING: No camera detected. Connect USB camera and re-run."
    fi
else
    echo "WARNING: fswebcam not available"
fi

# 5. Check for API key
echo ""
echo "--- Checking configuration ---"
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "NOTE: ANTHROPIC_API_KEY not set."
    echo "  Set it in the systemd service file or export before running."
    echo "  AI analysis will be skipped until the key is configured."
fi

# 6. Create environment file for secrets
echo ""
echo "--- Setting up environment file ---"
ENV_FILE="/etc/ecogarden-monitor.env"
if [ ! -f "$ENV_FILE" ]; then
    sudo tee "$ENV_FILE" > /dev/null <<EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
INFLUXDB_TOKEN=${INFLUXDB_TOKEN:-}
EOF
    sudo chmod 600 "$ENV_FILE"
    echo "Created $ENV_FILE (mode 600)"
else
    echo "Environment file already exists at $ENV_FILE"
fi

# 7. Install systemd service
echo ""
echo "--- Installing systemd service ---"
SERVICE_FILE="/etc/systemd/system/ecogarden-monitor.service"

# Update paths in service file to match actual install location
WORKING_DIR="$SCRIPT_DIR"
PYTHON_PATH="$SCRIPT_DIR/venv/bin/python"
CURRENT_USER="$(whoami)"

sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=EcoGarden Plant Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$WORKING_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$PYTHON_PATH app.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ecogarden-monitor
echo "Systemd service installed and enabled"

# 8. Start or restart service
echo ""
echo "--- Starting service ---"
sudo systemctl restart ecogarden-monitor
sleep 2

if systemctl is-active --quiet ecogarden-monitor; then
    echo "Service is running!"
else
    echo "WARNING: Service failed to start. Check logs:"
    echo "  journalctl -u ecogarden-monitor -n 20"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Dashboard: http://$(hostname -I | awk '{print $1}'):8080"
echo "Logs:      journalctl -u ecogarden-monitor -f"
echo ""
echo "To set API keys:"
echo "  sudo nano /etc/ecogarden-monitor.env"
echo "  Then: sudo systemctl restart ecogarden-monitor"
