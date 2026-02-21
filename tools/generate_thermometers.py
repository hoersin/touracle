#!/usr/bin/env python3
"""
Generate thermometer bitmap icons for map glyphs.
- Output sizes: 48x96 px, transparent background
- Temperatures: -20°C to 40°C in 2°C steps
- Visual style: Black outer body, glossy glass tube, colored liquid, round bulb, light ticks

Requires: Pillow (PIL)
"""
from PIL import Image, ImageDraw
import os
import math

# Canvas
W, H = 48, 96

# Geometry
BULB_R = 12
TUBE_W = 10
TUBE_H = 58

# Temperature range
MIN_TEMP = -20
MAX_TEMP = 40

# Output folder
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'assets', 'glyphs', 'thermometers')

# Colors
BLACK = (0, 0, 0, 255)
LIGHT_GRAY = (230, 230, 230, 255)
TICK_GRAY = (200, 200, 200, 255)
HIGHLIGHT_WHITE = (255, 255, 255, 110)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def lerp_color(c0, c1, t):
    t = max(0.0, min(1.0, float(t)))
    return (
        int(round(lerp(c0[0], c1[0], t))),
        int(round(lerp(c0[1], c1[1], t))),
        int(round(lerp(c0[2], c1[2], t))),
        255,
    )


def temperature_to_color(temp: float):
    """Map temperature to color using linear stops."""
    stops = [
        ( -20.0, (0x1f, 0x4e, 0x8c)),  # deep blue
        (   0.0, (0x00, 0xa6, 0xca)),  # cyan
        (  10.0, (0x4d, 0xaf, 0x4a)),  # green
        (  20.0, (0xff, 0xff, 0x33)),  # yellow
        (  25.0, (0xfd, 0xae, 0x61)),  # orange
        (  30.0, (0xd7, 0x19, 0x1c)),  # red
        (  40.0, (0x8b, 0x00, 0x00)),  # dark red
    ]
    # Clamp to bounds
    t = max(stops[0][0], min(stops[-1][0], float(temp)))
    for i in range(len(stops) - 1):
        (t0, c0), (t1, c1) = stops[i], stops[i + 1]
        if t0 <= t <= t1:
            u = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            return lerp_color(c0, c1, u)
    # Fallback
    return stops[-1][1] + (255,)


def draw_thermometer(temp: int, out_path: str):
    # Fill fraction
    frac = (float(temp) - MIN_TEMP) / (MAX_TEMP - MIN_TEMP)
    frac = max(0.0, min(1.0, frac))
    fluid_h = frac * TUBE_H

    # Create canvas
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Centers and bounds
    cx = W // 2
    bulb_cy = H - BULB_R  # bulb touches bottom margin
    tube_bottom = bulb_cy - BULB_R
    tube_top = tube_bottom - TUBE_H
    tube_x0 = cx - (TUBE_W // 2)
    tube_x1 = cx + (TUBE_W // 2)

    # Outer body (black): tube + bulb
    # Slightly wider than tube for body casing
    body_pad = 3
    d.rounded_rectangle(
        (tube_x0 - body_pad, tube_top - body_pad, tube_x1 + body_pad, tube_bottom + body_pad),
        radius=(TUBE_W // 2) + 2,
        fill=BLACK,
        outline=None,
    )
    d.ellipse(
        (cx - (BULB_R + 2), bulb_cy - (BULB_R + 2), cx + (BULB_R + 2), bulb_cy + (BULB_R + 2)),
        fill=BLACK,
        outline=None,
    )

    # Glass tube (inner): light gray with slight outline
    d.rounded_rectangle(
        (tube_x0, tube_top, tube_x1, tube_bottom),
        radius=TUBE_W // 2,
        fill=LIGHT_GRAY,
        outline=(210, 210, 210, 255),
        width=1,
    )

    # Fluid color
    fluid_col = temperature_to_color(temp)

    # Fluid fill in tube (inner)
    inner_pad = 2
    fx0 = tube_x0 + inner_pad
    fx1 = tube_x1 - inner_pad
    fy1 = tube_bottom - inner_pad
    fy0 = max(tube_top + inner_pad, fy1 - int(round(fluid_h)))
    if fy0 < fy1:
        d.rounded_rectangle(
            (fx0, fy0, fx1, fy1),
            radius=(TUBE_W // 2) - inner_pad,
            fill=fluid_col,
            outline=None,
        )

    # Fluid fill in bulb (inner circle)
    inner_bulb_r = BULB_R - inner_pad
    d.ellipse(
        (cx - inner_bulb_r, bulb_cy - inner_bulb_r, cx + inner_bulb_r, bulb_cy + inner_bulb_r),
        fill=fluid_col,
        outline=None,
    )

    # Tick marks (thin, light gray) along right side
    tick_x0 = tube_x1 + 4
    tick_x1 = tick_x0 + 6
    ticks = 12
    for i in range(ticks + 1):
        y = int(round(lerp(tube_top + 2, tube_bottom - 2, i / ticks)))
        d.line((tick_x0, y, tick_x1, y), fill=TICK_GRAY, width=1)

    # Subtle highlight on glass (left side stripe)
    hl_x0 = tube_x0 + 1
    hl_x1 = tube_x0 + 3
    d.rounded_rectangle((hl_x0, tube_top + 2, hl_x1, tube_bottom - 2), radius=2, fill=HIGHLIGHT_WHITE, outline=None)

    # Slight highlight arc on upper-left of bulb
    arc_r = inner_bulb_r - 2
    d.pieslice((cx - arc_r, bulb_cy - arc_r, cx + arc_r, bulb_cy + arc_r), start=200, end=260, fill=None, outline=HIGHLIGHT_WHITE, width=1)

    # Save PNG
    img.save(out_path, format='PNG')


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    count = 0
    for temp in range(MIN_TEMP, MAX_TEMP + 2, 2):  # -20 to 40 inclusive
        fn = f"thermo_{temp}.png"
        out_path = os.path.join(OUT_DIR, fn)
        draw_thermometer(temp, out_path)
        count += 1
    files = sorted([f for f in os.listdir(OUT_DIR) if f.startswith('thermo_') and f.endswith('.png')])
    print(f"Generated {count} icons.")
    print("Folder:", OUT_DIR)
    print("Files sample:", files[:5], "...", files[-5:])


if __name__ == "__main__":
    main()
