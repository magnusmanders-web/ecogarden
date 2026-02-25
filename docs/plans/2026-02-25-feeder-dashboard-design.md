# Feeder Dashboard Integration

**Date:** 2026-02-25

## Summary

Add a "Feed" button to the dashboard header bar, next to the existing growlight toggle and camera capture buttons. Follows the identical pattern: glass-morphism button → JS fetch → Flask proxy → ESP8266 HTTP endpoint.

## Chain

```
Feed button click (JS)
  → fetch("/api/feed", POST)
  → Flask: api_feed()
  → HTTP proxy: http://192.168.1.196/hooks/feed_now
  → ESP8266: GPIO 1 HIGH for 2 seconds
  → Response: {"ok": true, "pin": 1, "pulse_ms": 2000}
  → Button: pulse animation for 2s, disabled during request
```

## Changes

1. **`web.py`** — `POST /api/feed` route proxying to device `/hooks/feed_now`
2. **`templates/index.html`** — Third button in header controls with fish SVG icon
3. **`static/app.js`** — `feedNow()` function (disable → POST → animate → re-enable)
4. **`static/style.css`** — `.ctrl-btn.feeding` state with green pulse glow

## Visual

- Default: glass button, dim fish icon (matches light/camera buttons)
- Feeding: green pulse glow for 2 seconds, button disabled
- Error: silent fail, re-enable button
