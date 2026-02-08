import logging
import os
import shutil
import subprocess
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont, ImageOps

log = logging.getLogger(__name__)


def capture_photo(config):
    """Capture a photo from the USB camera. Returns the saved file path."""
    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%Y-%m-%d_%H-%M")

    photo_dir = os.path.join(config["storage"]["photo_dir"], date_str)
    os.makedirs(photo_dir, exist_ok=True)
    filepath = os.path.join(photo_dir, f"{time_str}.jpg")

    resolution = config["capture"].get("resolution", "1920x1080")
    quality = config["capture"].get("quality", 85)

    # Primary: fswebcam (Linux/Pi)
    if shutil.which("fswebcam"):
        try:
            subprocess.run(
                [
                    "fswebcam",
                    "-r", resolution,
                    "--jpeg", str(quality),
                    "--no-banner",
                    "-S", "10",  # skip first 10 frames for auto-exposure
                    filepath,
                ],
                capture_output=True,
                check=True,
                timeout=30,
            )
            _rotate_if_needed(filepath, config)
            _add_timestamp(filepath)
            log.info("Captured photo: %s", filepath)
            return filepath
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            log.warning("fswebcam failed: %s, trying OpenCV", e)

    # Fallback: OpenCV (Mac dev / if fswebcam unavailable)
    try:
        import cv2

        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            log.error("Cannot open camera")
            return None

        # Set resolution
        w, h = resolution.split("x")
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(w))
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(h))

        # Skip frames for auto-exposure
        for _ in range(10):
            cap.read()

        ret, frame = cap.read()
        cap.release()

        if not ret:
            log.error("Failed to read frame from camera")
            return None

        params = [cv2.IMWRITE_JPEG_QUALITY, quality]
        cv2.imwrite(filepath, frame, params)
        _rotate_if_needed(filepath, config)
        _add_timestamp(filepath)
        log.info("Captured photo (OpenCV): %s", filepath)
        return filepath

    except ImportError:
        log.error("No camera backend available (fswebcam or OpenCV)")
        return None


def _rotate_if_needed(filepath, config):
    """Rotate photo if rotation is configured."""
    rotation = config["capture"].get("rotation", 0)
    if rotation == 0:
        return
    try:
        img = Image.open(filepath)
        img = img.rotate(rotation, expand=True)
        img.save(filepath, quality=85)
    except Exception as e:
        log.warning("Failed to rotate photo: %s", e)


def _add_timestamp(filepath):
    """Add timestamp overlay to bottom-right of photo."""
    try:
        img = Image.open(filepath)
        draw = ImageDraw.Draw(img)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")

        # Try to use a monospace font, fall back to default
        font_size = max(20, img.width // 60)
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", font_size)
        except OSError:
            try:
                font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", font_size)
            except OSError:
                font = ImageFont.load_default()

        bbox = draw.textbbox((0, 0), timestamp, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]

        margin = 10
        x = img.width - text_w - margin
        y = img.height - text_h - margin

        # Black outline
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx or dy:
                    draw.text((x + dx, y + dy), timestamp, fill="black", font=font)
        # White text
        draw.text((x, y), timestamp, fill="white", font=font)

        img.save(filepath, quality=85)
    except Exception as e:
        log.warning("Failed to add timestamp overlay: %s", e)


def get_latest_photo(config):
    """Return the path to the most recent photo, or None."""
    photo_dir = config["storage"]["photo_dir"]
    if not os.path.isdir(photo_dir):
        return None

    # Get most recent date directory
    dates = sorted(
        [d for d in os.listdir(photo_dir) if os.path.isdir(os.path.join(photo_dir, d))],
        reverse=True,
    )
    for date_dir in dates:
        full_dir = os.path.join(photo_dir, date_dir)
        photos = sorted(
            [f for f in os.listdir(full_dir) if f.endswith(".jpg")],
            reverse=True,
        )
        if photos:
            return os.path.join(full_dir, photos[0])
    return None


def get_photos_for_date(config, date_str):
    """Return sorted list of photo paths for a given date (YYYY-MM-DD)."""
    date_dir = os.path.join(config["storage"]["photo_dir"], date_str)
    if not os.path.isdir(date_dir):
        return []
    return sorted(
        os.path.join(date_dir, f)
        for f in os.listdir(date_dir)
        if f.endswith(".jpg")
    )
