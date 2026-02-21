#!/usr/bin/env python3
"""
Generate classic weather condition bitmap icons.
- Output size: 48x48 px, transparent background
- Icons: sunny, partly_cloudy, cloudy, light_rain, rain
- Style: bright sun, soft gray clouds, blue raindrops, consistent geometry
Requires: Pillow (PIL)
"""
from PIL import Image, ImageDraw
import os

W, H = 48, 48
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'assets', 'glyphs', 'weather')

# Colors
SUN_YELLOW = (255, 213, 0, 255)
SUN_CORE = (255, 235, 120, 255)
CLOUD_GRAY = (200, 200, 200, 255)
CLOUD_DARK = (170, 170, 170, 255)
DROP_BLUE = (60, 130, 220, 255)


def draw_sun(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int):
    # Rays
    for i in range(8):
        ang = i * (360 / 8)
        dx = int(r * 1.8 * __import__('math').cos(__import__('math').radians(ang)))
        dy = int(r * 1.8 * __import__('math').sin(__import__('math').radians(ang)))
        draw.line((cx, cy, cx + dx, cy + dy), fill=SUN_YELLOW, width=3)
    # Core
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=SUN_YELLOW, outline=None)
    draw.ellipse((cx - r + 3, cy - r + 3, cx + r - 3, cy + r - 3), fill=SUN_CORE, outline=None)


def draw_cloud(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int):
    # Base cloud shape from overlapping circles
    cx1, cy1, r1 = x + int(w * 0.30), y + int(h * 0.50), int(h * 0.38)
    cx2, cy2, r2 = x + int(w * 0.55), y + int(h * 0.40), int(h * 0.30)
    cx3, cy3, r3 = x + int(w * 0.75), y + int(h * 0.55), int(h * 0.32)
    draw.ellipse((cx1 - r1, cy1 - r1, cx1 + r1, cy1 + r1), fill=CLOUD_GRAY, outline=None)
    draw.ellipse((cx2 - r2, cy2 - r2, cx2 + r2, cy2 + r2), fill=CLOUD_GRAY, outline=None)
    draw.ellipse((cx3 - r3, cy3 - r3, cx3 + r3, cy3 + r3), fill=CLOUD_GRAY, outline=None)
    # Flatten bottom
    draw.rectangle((x + int(w * 0.25), y + int(h * 0.60), x + int(w * 0.85), y + int(h * 0.75)), fill=CLOUD_GRAY, outline=None)
    # Subtle shading line
    draw.line((x + int(w * 0.25), y + int(h * 0.60), x + int(w * 0.85), y + int(h * 0.60)), fill=CLOUD_DARK, width=1)


def draw_drop(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int):
    # Teardrop (circle + triangle)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=DROP_BLUE, outline=None)
    draw.polygon((cx, cy - r - 2, cx - r, cy, cx + r, cy), fill=DROP_BLUE)


def icon_sunny():
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_sun(d, cx=24, cy=24, r=10)
    return img


def icon_partly_cloudy():
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_sun(d, cx=16, cy=16, r=9)
    draw_cloud(d, x=8, y=16, w=32, h=18)
    return img


def icon_cloudy():
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_cloud(d, x=6, y=14, w=36, h=20)
    return img


def icon_light_rain():
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_cloud(d, x=6, y=12, w=36, h=20)
    for i in range(3):
        draw_drop(d, cx=14 + i * 10, cy=36, r=3)
    return img


def icon_rain():
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_cloud(d, x=6, y=10, w=36, h=20)
    for i in range(5):
        draw_drop(d, cx=10 + i * 7, cy=36, r=3)
    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    icons = {
        'weather_sunny.png': icon_sunny(),
        'weather_partly_cloudy.png': icon_partly_cloudy(),
        'weather_cloudy.png': icon_cloudy(),
        'weather_light_rain.png': icon_light_rain(),
        'weather_rain.png': icon_rain(),
    }
    for name, img in icons.items():
        img.save(os.path.join(OUT_DIR, name), format='PNG')
    files = sorted(os.listdir(OUT_DIR))
    print(f"Generated {len(icons)} icons.")
    print("Folder:", OUT_DIR)
    print("Files:", files)


if __name__ == '__main__':
    main()
