# EcoGarden Future Ideas

## Ready Now (just needs config)
- [x] LED on at boot
- [ ] Sunrise/sunset light schedules via Home Assistant
- [ ] Low light warnings (cloudy days) - TSL2561 already working
- [ ] MQTT dashboard with Grafana

## Needs Founder Info (feeder/pump GPIOs)
- [ ] Auto water circulation schedule
- [ ] Feeding schedule with portion control

## Needs New Hardware

| Feature | Sensor Needed | Est. Cost |
|---------|--------------|-----------|
| Water temp alerts | DS18B20 (may exist!) | ~$3 |
| Water level monitoring | Ultrasonic HC-SR04 or float switch | ~$5 |
| Nutrition/EC measuring | TDS/EC sensor module | ~$10-15 |
| pH monitoring | pH sensor module | ~$15-30 |
| AI plant monitoring | ESP32-CAM or USB camera | ~$8-15 |

## AI Plant Monitoring Vision
- Daily photos to track growth
- Detect yellowing leaves (nutrient deficiency)
- Spot pests or disease early
- Measure plant height over time
- Compare against healthy reference images
- Machine learning model for plant health assessment

## Architecture Vision
```
EcoGarden ESP8266 ──MQTT──► Home Assistant ──► Grafana
                                │
ESP32-CAM (plants) ────────────►│
                                │
                           ◄────┴────► Notifications
                                       (phone/email)
```

## Notes
- Location: Sweden (very little natural sunlight, plants 100% dependent on growlight)
- Constraint: Someone sleeps in the room with the EcoGarden
- Light schedule must balance plant growth needs vs sleep schedule
