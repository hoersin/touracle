from typing import Dict
import math
from pathlib import Path
import uuid

SIZE = 64
CENTER = SIZE / 2
PRECIP_R = 9.0
TEMP_INNER_R = 14.0
TEMP_OUTER_R = 22.0
WIND_R = 22.0


def _precip_level(mm: float) -> int:
    """Map precipitation to 5 levels: 0, low, medium, high, very high."""
    if mm <= 0.0:
        return 0
    if mm < 1.0:
        return 1
    if mm < 5.0:
        return 2
    if mm < 15.0:
        return 3
    return 4


def _precip_fraction(level: int) -> float:
    """Return vertical fill fraction for the 5 levels: 0%,25%,50%,75%,100%."""
    levels = [0.0, 0.25, 0.5, 0.75, 1.0]
    return levels[max(0, min(4, level))]


def _temp_arc_path(temp_c: float, inner_r: float = TEMP_INNER_R, outer_r: float = TEMP_OUTER_R) -> str:
    """Return SVG path for a temperature arc rotated CCW by 120°: start at 240° sweeping clockwise across up to 300° (to -60°)."""
    t = max(-20.0, min(40.0, float(temp_c)))
    rotate = 120.0
    start_angle = 120.0 + rotate
    # Map -20..40°C → 120..-180° (span -300°), then rotate
    end_angle = (120.0 + ((t + 20.0) / 60.0) * (-180.0 - 120.0)) + rotate

    def polar_to_cart(r: float, a_deg: float):
        a = math.radians(a_deg)
        # Flip Y so angles render on upper semicircle
        return CENTER + r * math.cos(a), CENTER - r * math.sin(a)

    # Build ring sector path
    x1, y1 = polar_to_cart(outer_r, start_angle)
    x2, y2 = polar_to_cart(outer_r, end_angle)
    x3, y3 = polar_to_cart(inner_r, end_angle)
    x4, y4 = polar_to_cart(inner_r, start_angle)
    # Clockwise delta for large-arc flag (rotation cancels out)
    cw_delta = (start_angle - end_angle) % 360.0
    large_arc = 1 if cw_delta > 180.0 else 0
    sweep = 1
    path = (
        f"M {x1:.2f},{y1:.2f} "
        f"A {outer_r:.2f},{outer_r:.2f} 0 {large_arc} {sweep} {x2:.2f},{y2:.2f} "
        f"L {x3:.2f},{y3:.2f} "
        f"A {inner_r:.2f},{inner_r:.2f} 0 {large_arc} {0 if sweep==1 else 1} {x4:.2f},{y4:.2f} Z"
    )
    return path


def _temp_color(temp_c: float) -> str:
    """Interpolate color across anchors: 0 blue, 10 cyan, 15 green, 20 yellow, 25 orange, 30 red."""
    anchors = [
        (0.0, (0, 102, 255)),   # blue
        (10.0, (0, 255, 255)),  # cyan
        (15.0, (0, 200, 102)),  # green
        (20.0, (255, 204, 0)),  # yellow
        (25.0, (255, 136, 0)),  # orange
        (30.0, (255, 0, 0)),    # red
    ]
    t = max(anchors[0][0], min(anchors[-1][0], float(temp_c)))
    for i in range(len(anchors) - 1):
        t0, c0 = anchors[i]
        t1, c1 = anchors[i + 1]
        if t0 <= t <= t1:
            if t1 == t0:
                r, g, b = c1
            else:
                u = (t - t0) / (t1 - t0)
                r = int(round(c0[0] + u * (c1[0] - c0[0])))
                g = int(round(c0[1] + u * (c1[1] - c0[1])))
                b = int(round(c0[2] + u * (c1[2] - c0[2])))
            return f"rgb({r},{g},{b})"
    r, g, b = anchors[-1][1]
    return f"rgb({r},{g},{b})"


def _wind_arrow(wind_dir_deg: float, wind_speed_ms: float, max_speed: float = 25.0) -> str:
    """Return a group with a rotated arrow indicating wind direction and scaled length by speed."""
    length = 12.0 + 10.0 * min(1.0, wind_speed_ms / max_speed)
    # Arrow from center pointing to direction
    x2 = CENTER + length
    y2 = CENTER
    arrow = (
        f"<g transform=\"rotate({wind_dir_deg:.1f},{CENTER},{CENTER})\">"
        f"<line x1=\"{CENTER}\" y1=\"{CENTER}\" x2=\"{x2:.2f}\" y2=\"{y2:.2f}\" stroke=\"#111\" stroke-width=\"2\"/>"
        # Arrowhead
        f"<polygon points=\"{x2:.2f},{y2:.2f} {x2-6:.2f},{y2-3:.2f} {x2-6:.2f},{y2+3:.2f}\" fill=\"#111\"/>"
        f"</g>"
    )
    return arrow


def _variability_sector(wind_dir_deg: float, wind_var_deg: float, radius: float = WIND_R) -> str:
    """Return a translucent sector centered at wind_dir with half-width derived from variability."""
    half = max(5.0, min(90.0, wind_var_deg / 2.0))
    start = wind_dir_deg - half
    end = wind_dir_deg + half

    def polar(r, a_deg):
        a = math.radians(a_deg)
        return CENTER + r * math.cos(a), CENTER + r * math.sin(a)

    x1, y1 = polar(radius, start)
    x2, y2 = polar(radius, end)
    large_arc = 1 if (end - start) > 180.0 else 0
    path = (
        f"M {CENTER},{CENTER} L {x1:.2f},{y1:.2f} "
        f"A {radius:.2f},{radius:.2f} 0 {large_arc} 1 {x2:.2f},{y2:.2f} Z"
    )
    return f"<path d=\"{path}\" fill=\"rgba(128,128,128,0.25)\" stroke=\"none\"/>"


def generate_svg_glyph(stats: Dict[str, float]) -> str:
    """
    Generate a 64x64 SVG glyph visualizing precipitation (inner circle), temperature arc, wind arrow, and variability sector.
    Transparent background; minimal stroke for clarity.
    """
    temp = float(stats.get("temperature_c", 15.0))
    prcp = float(stats.get("precipitation_mm", 0.0))
    wspd = float(stats.get("wind_speed_ms", 2.0))
    wdir = float(stats.get("wind_dir_deg", 0.0))
    wvar = float(stats.get("wind_var_deg", 90.0))

    level = _precip_level(prcp)
    frac = _precip_fraction(level)
    # Temperature arc path and color
    temp_path = _temp_arc_path(temp)
    temp_color = _temp_color(temp)
    arrow = _wind_arrow(wdir, wspd)
    sector = _variability_sector(wdir, wvar)
    # Precipitation: draw circle outline and fill rising from bottom via clipPath
    clip_id = f"clip_precip_{uuid.uuid4().hex[:8]}"
    fill_height = frac * (2.0 * PRECIP_R)
    fill_top = CENTER + PRECIP_R - fill_height
    svg = (
        f"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{SIZE}\" height=\"{SIZE}\" viewBox=\"0 0 {SIZE} {SIZE}\">"
        f"<defs>"
        f"<clipPath id=\"{clip_id}\"><circle cx=\"{CENTER}\" cy=\"{CENTER}\" r=\"{PRECIP_R}\"/></clipPath>"
        f"</defs>"
        f"<circle cx=\"{CENTER}\" cy=\"{CENTER}\" r=\"{PRECIP_R}\" fill=\"none\" stroke=\"#9bd7ff\" stroke-width=\"1\"/>"
        f"<rect x=\"{CENTER-PRECIP_R}\" y=\"{fill_top:.2f}\" width=\"{2*PRECIP_R}\" height=\"{fill_height:.2f}\" fill=\"#9bd7ff\" clip-path=\"url(#{clip_id})\"/>"
        f"<path d=\"{temp_path}\" fill=\"{temp_color}\" stroke=\"none\"/>"
        f"{sector}"
        f"{arrow}"
        f"</svg>"
    )
    return svg


def generate_test_glyphs() -> None:
    """Generate 4 synthetic test glyphs and write them to debug_output/test_glyphs/."""
    base = Path(__file__).resolve().parents[1] / 'debug_output' / 'test_glyphs'
    base.mkdir(parents=True, exist_ok=True)
    cases = [
        ('cold_dry_calm', {
            'temperature_c': 2.0,
            'precipitation_mm': 0.0,
            'wind_speed_ms': 1.0,
            'wind_dir_deg': 45.0,
            'wind_var_deg': 10.0,
        }),
        ('hot_dry_windy', {
            'temperature_c': 32.0,
            'precipitation_mm': 0.0,
            'wind_speed_ms': 15.0,
            'wind_dir_deg': 270.0,
            'wind_var_deg': 20.0,
        }),
        ('moderate_rain', {
            'temperature_c': 16.0,
            'precipitation_mm': 6.0,
            'wind_speed_ms': 5.0,
            'wind_dir_deg': 180.0,
            'wind_var_deg': 40.0,
        }),
        ('variable_wind', {
            'temperature_c': 18.0,
            'precipitation_mm': 0.5,
            'wind_speed_ms': 6.0,
            'wind_dir_deg': 120.0,
            'wind_var_deg': 120.0,
        }),
    ]
    for name, stats in cases:
        svg = generate_svg_glyph(stats)
        (base / f'{name}.svg').write_text(svg, encoding='utf-8')


if __name__ == '__main__':
    generate_test_glyphs()
