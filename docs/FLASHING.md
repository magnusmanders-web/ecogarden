# Flashing the EcoGarden Firmware

This guide covers both OTA (over-the-air) and serial flashing methods.

## Method 1: OTA Flash (Recommended)

If your device is already connected to WiFi and responding:

```bash
cd firmware
mos build --platform esp8266
curl -X POST -F "filedata=@build/fw.zip;type=application/zip" "http://192.168.1.196/update"
```

Replace `192.168.1.196` with your device's IP address.

---

## Method 2: Serial Flash (USB-to-Serial Adapter)

Use this method when:
- Device has no WiFi configured
- WiFi credentials are wrong
- Device is bricked or unresponsive
- First-time flash on new ESP8266

### What You Need

| Item | Example | Price | Link |
|------|---------|-------|------|
| USB-to-Serial adapter | FTDI FT232RL or CP2102 | ~$5-10 | [Amazon](https://www.amazon.com/s?k=ftdi+usb+serial+adapter) |
| Jumper wires (female-female) | Dupont wires | ~$5 | [Amazon](https://www.amazon.com/s?k=dupont+jumper+wires) |
| **Optional:** Breadboard | For easier connections | ~$5 | |

**Recommended adapters:**
- FTDI FT232RL (most reliable)
- CP2102 (cheaper, works well)
- CH340G (cheapest, may need driver)

> **Important:** Make sure the adapter supports **3.3V**! The ESP8266 is 3.3V and will be damaged by 5V.

### Wiring

Connect the USB-to-Serial adapter to the ESP8266:

```
USB-Serial Adapter          ESP8266 (EcoGarden)
┌─────────────────┐        ┌─────────────────┐
│                 │        │                 │
│  GND  ──────────┼────────┼── GND           │
│  TX   ──────────┼────────┼── RX (GPIO 3)   │
│  RX   ──────────┼────────┼── TX (GPIO 1)   │
│  3.3V ──────────┼────────┼── 3.3V          │
│                 │        │                 │
└─────────────────┘        └─────────────────┘

For flashing, also connect:
│  GND  ──────────┼────────┼── GPIO 0        │  (hold LOW during boot)
```

**Pin locations on EcoGarden:**
You'll need to open the device to access the ESP8266 module. Look for:
- TX/RX pins (may be labeled or need to trace from ESP8266 chip)
- GND (ground)
- 3.3V or VCC
- GPIO 0 (for flash mode)

### Entering Flash Mode

The ESP8266 must be in flash mode to receive firmware:

1. **Disconnect power** from the EcoGarden
2. **Connect GPIO 0 to GND** (using a jumper wire)
3. **Connect the USB-serial adapter** to your computer
4. **Power on** the EcoGarden (or connect 3.3V from the adapter)
5. The ESP8266 is now in flash mode

### Install mos Tool

If you haven't already, install the Mongoose OS tool:

**macOS:**
```bash
brew install mos
```

**Linux:**
```bash
curl -fsSL https://mongoose-os.com/downloads/mos/install.sh | /bin/bash
```

**Windows:**
Download from: https://mongoose-os.com/docs/mongoose-os/quickstart/setup.md

### Flash Commands

1. **Build the firmware:**
```bash
cd firmware
mos build --platform esp8266
```

2. **Find your serial port:**
```bash
# macOS
ls /dev/tty.usb*

# Linux
ls /dev/ttyUSB*

# Windows
# Check Device Manager for COM port
```

3. **Flash the firmware:**
```bash
mos flash --port /dev/tty.usbserial-XXXX
```

Replace `/dev/tty.usbserial-XXXX` with your actual port.

4. **After flashing:**
   - Disconnect GPIO 0 from GND
   - Power cycle the device
   - Device will boot into normal mode

### Configure WiFi via Serial

After flashing, you can configure WiFi via serial:

```bash
# Connect to device console
mos --port /dev/tty.usbserial-XXXX console

# Set WiFi credentials (in another terminal)
mos --port /dev/tty.usbserial-XXXX config-set wifi.sta.ssid="YourNetwork" wifi.sta.pass="YourPassword"

# Reboot
mos --port /dev/tty.usbserial-XXXX call Sys.Reboot
```

Or use the web portal:
1. Connect to `EcoGarden-Setup` WiFi (password: `ecogarden`)
2. Open http://192.168.4.1
3. Configure your WiFi

---

## Troubleshooting

### "No serial port found"
- Check USB cable (some cables are charge-only, no data)
- Install driver for your adapter:
  - FTDI: https://ftdichip.com/drivers/
  - CP2102: https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers
  - CH340: http://www.wch-ic.com/downloads/CH341SER_MAC_ZIP.html

### "Failed to connect to ESP8266"
- Ensure GPIO 0 is connected to GND during power-on
- Check TX/RX connections (try swapping them)
- Verify 3.3V power (not 5V!)
- Try lower baud rate: `mos flash --port /dev/tty.xxx --esp-baud-rate 115200`

### "Device boots but no WiFi"
- Check serial console for errors: `mos console`
- Reset WiFi config: `mos config-set wifi.sta.ssid="" wifi.sta.pass=""`
- Device should start AP mode for configuration

### Device is completely bricked
1. Erase flash completely:
   ```bash
   esptool.py --port /dev/tty.xxx erase_flash
   ```
2. Flash fresh firmware:
   ```bash
   mos flash --port /dev/tty.xxx
   ```

---

## Safety Notes

- **Always use 3.3V** - The ESP8266 will be damaged by 5V on any pin
- **Disconnect mains power** before opening the EcoGarden
- **Don't touch the water** while the device is connected to USB
- **Keep the fish tank powered** separately if fish are present

---

## Quick Reference

| Task | Command |
|------|---------|
| Build firmware | `mos build --platform esp8266` |
| Flash via serial | `mos flash --port /dev/tty.xxx` |
| Flash via OTA | `curl -F "filedata=@build/fw.zip" http://IP/update` |
| Serial console | `mos --port /dev/tty.xxx console` |
| Set WiFi | `mos config-set wifi.sta.ssid="X" wifi.sta.pass="Y"` |
| Reboot | `mos call Sys.Reboot` |
