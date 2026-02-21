"""Precise geometric weather glyph rendering module.
Focus: 64x64 canvas, center (32,32), fixed radii, layered rendering.
"""
from __future__ import annotations
from typing import Dict, Tuple
from math import cos, sin, radians
import logging
log = logging.getLogger('pipeline.glyph')
from glyph_wind import render_wind

# Canvas and geometry constants
CENTER_X = 32.0
CENTER_Y = 32.0
SIZE = 64

PRECIP_RADIUS = 9.0
TEMP_RADIUS_INNER = 14.0
TEMP_RADIUS_OUTER = 22.0
WIND_RADIUS = 22.0
MAX_RADIUS = 28.0

DEBUG_GLYPH = False
# Relax upper-only: start at +120°, sweep clockwise across 300° to -180°
TEMP_ARC_START_DEG = 120.0
TEMP_ARC_END_DEG = -180.0
# Global rotation (counterclockwise) applied to entire temperature scale
TEMP_ARC_ROTATE_DEG = 120.0


def _polar_to_cart(r: float, a_deg: float) -> Tuple[float, float]:
    a = radians(a_deg)
    # Flip Y so positive angles map to upper semicircle
    return CENTER_X + r * cos(a), CENTER_Y - r * sin(a)


def angle_from_temperature(temp_c: float) -> float:
    """Deprecated: use `temperature_to_angle`. Kept for compatibility if needed."""
    return temperature_to_angle(temp_c)


def temperature_to_angle(temp_c: float) -> float:
    """Map -20..+40°C to fixed arc angles: start +120°, end -180° (clockwise, 300° sweep), then rotate CCW by TEMP_ARC_ROTATE_DEG."""
    t = max(-20.0, min(40.0, float(temp_c)))
    span = TEMP_ARC_END_DEG - TEMP_ARC_START_DEG
    base = TEMP_ARC_START_DEG + ((t + 20.0) / 60.0) * span
    return base + TEMP_ARC_ROTATE_DEG


def _hex_to_rgb(hex_str: str) -> Tuple[int, int, int]:
    hex_str = hex_str.lstrip('#')
    return int(hex_str[0:2], 16), int(hex_str[2:4], 16), int(hex_str[4:6], 16)


def _rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
    r, g, b = rgb
    return f"#{r:02x}{g:02x}{b:02x}"


def color_from_temperature(temp_c: float) -> str:
    """Interpolate color across anchors specified in the design."""
    anchors = [
        (-20.0, _hex_to_rgb('#1f4e8c')),  # dark blue
        (-10.0, _hex_to_rgb('#2c7bb6')),  # blue
        (0.0,   _hex_to_rgb('#00a6ca')),  # cyan
        (15.0,  _hex_to_rgb('#4daf4a')),  # green
        (20.0,  _hex_to_rgb('#ffff33')),  # yellow
        (25.0,  _hex_to_rgb('#fdae61')),  # orange
        (30.0,  _hex_to_rgb('#d7191c')),  # red
        (40.0,  _hex_to_rgb('#d7191c')),  # red
    ]
    t = max(anchors[0][0], min(anchors[-1][0], float(temp_c)))
    for i in range(len(anchors) - 1):
        t0, c0 = anchors[i]
        t1, c1 = anchors[i + 1]
        if t0 <= t <= t1:
            if t1 == t0:
                return _rgb_to_hex(c1)
            u = (t - t0) / (t1 - t0)
            r = int(round(c0[0] + u * (c1[0] - c0[0])))
            g = int(round(c0[1] + u * (c1[1] - c0[1])))
            b = int(round(c0[2] + u * (c1[2] - c0[2])))
            return _rgb_to_hex((r, g, b))
    return _rgb_to_hex(anchors[-1][1])


def _water_color_for_mm(mm: float) -> str:
    """Map typical rain amount to fill color intensity: light→medium→dark blue."""
    m = float(mm)
    if m < 1.0:
        return '#a9d6ff'  # light blue
    if m < 5.0:
        return '#6bb7ff'  # medium blue
    if m < 15.0:
        return '#3e97e6'  # medium-dark blue
    return '#1f6fb8'      # dark blue


def _darker_hex(hex_str: str, factor: float = 0.85) -> str:
    """Return a darker variant of the given hex color by scaling channels."""
    r, g, b = _hex_to_rgb(hex_str)
    r = int(max(0, min(255, round(r * factor))))
    g = int(max(0, min(255, round(g * factor))))
    b = int(max(0, min(255, round(b * factor))))
    return _rgb_to_hex((r, g, b))


def precip_fill_fraction(mm: float) -> float:
    """Return 0..1 fraction based on thresholds.
    0 → 0%; 0–1 → 12.5%; 1–3 → 25%; 3–8 → 50%; 8–20 → 75%; >20 → 100%
    """
    m = float(mm)
    if m <= 0.0:
        return 0.0
    if 0.0 < m < 1.0:
        return 0.125
    if 1.0 <= m <= 3.0:
        return 0.25
    if 3.0 < m <= 8.0:
        return 0.5
    if 8.0 < m <= 20.0:
        return 0.75
    return 1.0


def draw_temperature_arc(temp_c: float) -> str:
    """Donut sector from rotated start to rotated temp angle, between inner/outer radii."""
    end_angle = temperature_to_angle(temp_c)
    start_angle = TEMP_ARC_START_DEG + TEMP_ARC_ROTATE_DEG
    if abs(end_angle - start_angle) <= 0.1:
        return ''
    # Clockwise delta for large-arc flag
    cw_delta = (start_angle - end_angle) % 360.0
    large_arc = 1 if cw_delta > 180.0 else 0
    # Outer arc
    ox1, oy1 = _polar_to_cart(TEMP_RADIUS_OUTER, start_angle)
    ox2, oy2 = _polar_to_cart(TEMP_RADIUS_OUTER, end_angle)
    # Inner arc (reverse)
    ix2, iy2 = _polar_to_cart(TEMP_RADIUS_INNER, end_angle)
    ix1, iy1 = _polar_to_cart(TEMP_RADIUS_INNER, start_angle)
    path = (
        f"M {ox1:.2f},{oy1:.2f} "
        f"A {TEMP_RADIUS_OUTER:.2f},{TEMP_RADIUS_OUTER:.2f} 0 {large_arc} 1 {ox2:.2f},{oy2:.2f} "
        f"L {ix2:.2f},{iy2:.2f} "
        f"A {TEMP_RADIUS_INNER:.2f},{TEMP_RADIUS_INNER:.2f} 0 {large_arc} 0 {ix1:.2f},{iy1:.2f} Z"
    )
    color = color_from_temperature(temp_c)
    return f"<path d=\"{path}\" fill=\"{color}\" stroke=\"none\"/>"


def draw_temperature_reference_ring(alpha: float = 0.30) -> str:
    """Render full reference ring in 5°C segments from -20°C to +40°C,
    as concentric ring sectors that share a single center (CENTER_X, CENTER_Y)
    and consistent inner/outer radii (TEMP_RADIUS_INNER, TEMP_RADIUS_OUTER).
    """
    segments = []
    step = 5
    cx, cy = CENTER_X, CENTER_Y
    Ro, Ri = TEMP_RADIUS_OUTER, TEMP_RADIUS_INNER
    for t in range(-20, 40, step):
        t0 = float(t)
        t1 = float(t + step)
        a0 = temperature_to_angle(t0)
        a1 = temperature_to_angle(t1)
        # Restore older behavior: swap to ensure ordering and force small-arc
        if a1 < a0:
            a0, a1 = a1, a0
        large_arc = 0
        # Precompute the four endpoints from center using x=cx+r*cos, y=cy - r*sin
        ox1, oy1 = _polar_to_cart(Ro, a0)
        ox2, oy2 = _polar_to_cart(Ro, a1)
        ix2, iy2 = _polar_to_cart(Ri, a1)
        ix1, iy1 = _polar_to_cart(Ri, a0)
        # Sweep is clockwise on outer (sweep-flag=1), reverse on inner (sweep-flag=0)
        path = (
            f"M {ox1:.2f},{oy1:.2f} "
            f"A {Ro:.2f},{Ro:.2f} 0 {large_arc} 1 {ox2:.2f},{oy2:.2f} "
            f"L {ix2:.2f},{iy2:.2f} "
            f"A {Ri:.2f},{Ri:.2f} 0 {large_arc} 0 {ix1:.2f},{iy1:.2f} Z"
        )
        col = color_from_temperature((t0 + t1) / 2.0)
        segments.append(f"<path d=\"{path}\" fill=\"{col}\" fill-opacity=\"{alpha}\" stroke=\"none\"/>")
    return ''.join(segments)


def draw_temperature_range(temp_p25: float, temp_p75: float, alpha: float = 0.95) -> str:
    """Render a bold arc from p25 to p75 as concentric ring sectors (5°C steps)
    that share a single center and consistent inner/outer radii.
    """
    t_start = float(min(temp_p25, temp_p75))
    t_end = float(max(temp_p25, temp_p75))
    step = 5.0
    segments = []
    cx, cy = CENTER_X, CENTER_Y
    Ro, Ri = TEMP_RADIUS_OUTER, TEMP_RADIUS_INNER
    t = t_start
    while t < t_end - 1e-6:
        t0 = t
        t1 = min(t + step, t_end)
        a0 = temperature_to_angle(t0)
        a1 = temperature_to_angle(t1)
        # Restore older behavior: swap to ensure ordering and force small-arc
        if a1 < a0:
            a0, a1 = a1, a0
        large_arc = 0
        # Four endpoints from the same center
        ox1, oy1 = _polar_to_cart(Ro, a0)
        ox2, oy2 = _polar_to_cart(Ro, a1)
        ix2, iy2 = _polar_to_cart(Ri, a1)
        ix1, iy1 = _polar_to_cart(Ri, a0)
        path = (
            f"M {ox1:.2f},{oy1:.2f} "
            f"A {Ro:.2f},{Ro:.2f} 0 {large_arc} 1 {ox2:.2f},{oy2:.2f} "
            f"L {ix2:.2f},{iy2:.2f} "
            f"A {Ri:.2f},{Ri:.2f} 0 {large_arc} 0 {ix1:.2f},{iy1:.2f} Z"
        )
        mid_t = (t0 + t1) / 2.0
        col = color_from_temperature(mid_t)
        segments.append(f"<path d=\"{path}\" fill=\"{col}\" fill-opacity=\"{alpha}\" stroke=\"none\"/>")
        # Label at mid-radius
        am = temperature_to_angle(mid_t)
        r_mid = (Ri + Ro) / 2.0
        tx, ty = _polar_to_cart(r_mid, am)
        label = f"{int(round(mid_t))}"
        segments.append(
            f"<text x=\"{tx:.2f}\" y=\"{ty:.2f}\" font-size=\"5\" fill=\"#777\" text-anchor=\"middle\" dominant-baseline=\"central\" style=\"pointer-events:none\">{label}</text>"
        )
        t = t1
    return ''.join(segments)


def _debug_temperature_ticks() -> str:
    if not DEBUG_GLYPH:
        return ''
    # Show extended sequence for 300° sweep, rotated by TEMP_ARC_ROTATE_DEG
    base_ticks = [
        (120.0, "+120°"), (60.0, "+60°"), (0.0, "0°"), (-60.0, "-60°"), (-120.0, "-120°"), (-180.0, "-180°")
    ]
    ticks = [(a + TEMP_ARC_ROTATE_DEG, label) for a, label in base_ticks]
    elems = []
    for a, label in ticks:
        # Tick mark at outer radius
        x1, y1 = _polar_to_cart(TEMP_RADIUS_OUTER - 2.0, a)
        x2, y2 = _polar_to_cart(TEMP_RADIUS_OUTER + 2.0, a)
        elems.append(f"<line x1=\"{x1:.2f}\" y1=\"{y1:.2f}\" x2=\"{x2:.2f}\" y2=\"{y2:.2f}\" stroke=\"#888\" stroke-width=\"1\"/>")
        # Label slightly outside the outer radius
        tx, ty = _polar_to_cart(TEMP_RADIUS_OUTER + 8.0, a)
        elems.append(f"<text x=\"{tx:.2f}\" y=\"{ty:.2f}\" font-size=\"8\" fill=\"#555\" text-anchor=\"middle\" dominant-baseline=\"central\">{label}</text>")
    return ''.join(elems)


def draw_temperature_median(temp_med: float) -> str:
    """Small black dot centered radially within the temperature band (mid-radius)."""
    a = temperature_to_angle(temp_med)
    r_mid = (TEMP_RADIUS_INNER + TEMP_RADIUS_OUTER) / 2.0
    x, y = _polar_to_cart(r_mid, a)
    # Increase size by 30% and make it hollow (stroke only)
    return f"<circle cx=\"{x:.2f}\" cy=\"{y:.2f}\" r=\"2.6\" fill=\"none\" stroke=\"#000\" stroke-width=\"1\"/>"


def _wave_path(fill_top_y: float, width: float = 2 * PRECIP_RADIUS, amp: float = 0.8, cycles: int = 4) -> str:
    """Create a small sine-like wave path centered across the circle width."""
    x0 = CENTER_X - PRECIP_RADIUS
    step = width / (cycles * 8)
    pts = []
    for i in range(int(cycles * 8) + 1):
        x = x0 + i * step
        # crude wave using sin approximations with piecewise control points
        y = fill_top_y - amp * sin((i / (cycles * 8)) * (3.14159 * cycles))
        pts.append(f"{x:.2f},{y:.2f}")
    return "M " + " ".join(pts)
def draw_precipitation(mm: float, add_wave: bool = True) -> str:
    """Backward-compatible precipitation renderer using mm to approximate probability.
    Probability proxy: rp = clamp(mm/20, 0..1). Intensity uses mm.
    """
    rp = max(0.0, min(1.0, float(mm) / 20.0))
    return draw_precipitation_prob_intensity(rp, float(mm), add_wave=add_wave)


def draw_precipitation_prob_intensity(rain_probability: float, typical_mm: float, add_wave: bool = True) -> str:
    """Render precipitation with probability→water level and typical amount→wave style/color."""
    # Continuous mapping 0..1 → fill fraction
    rp = max(0.0, min(1.0, float(rain_probability)))
    frac = rp
    height = frac * (2.0 * PRECIP_RADIUS)
    top = CENTER_Y + PRECIP_RADIUS - height
    clip = "precip_clip"
    fill_col = _water_color_for_mm(typical_mm)
    stroke_col = _darker_hex(fill_col, 0.80)
    waves = ''
    if add_wave and frac > 0:
        # Amplitude buckets based on typical rain amount
        m = float(typical_mm)
        if m < 1.0:
            amp = 0.4
        elif m < 5.0:
            amp = 0.8
        elif m < 15.0:
            amp = 1.2
        else:
            amp = 1.8
        try:
            log.info('[GLYPH] Rain prob=%.2f → fill=%.2f; typical=%.2f mm → amp=%.2f', rp, frac, m, amp)
        except Exception:
            pass
        # Three small waves, slightly offset vertically, clipped to circle
        w1 = _wave_path(top, amp=amp, cycles=4)
        w2 = _wave_path(min(CENTER_Y + PRECIP_RADIUS, top + 1.5), amp=amp * 0.9, cycles=4)
        w3 = _wave_path(min(CENTER_Y + PRECIP_RADIUS, top + 3.0), amp=amp * 0.8, cycles=4)
        waves = (
            f"<path d=\"{w1}\" stroke=\"{stroke_col}\" stroke-width=\"1.8\" fill=\"none\" clip-path=\"url(#{clip})\"/>"
            f"<path d=\"{w2}\" stroke=\"{stroke_col}\" stroke-width=\"1.6\" fill=\"none\" clip-path=\"url(#{clip})\"/>"
            f"<path d=\"{w3}\" stroke=\"{stroke_col}\" stroke-width=\"1.4\" fill=\"none\" clip-path=\"url(#{clip})\"/>"
        )
    rect = (
        f"<rect x=\"{CENTER_X-PRECIP_RADIUS:.2f}\" y=\"{top:.2f}\" width=\"{2*PRECIP_RADIUS:.2f}\" height=\"{height:.2f}\" fill=\"{fill_col}\" clip-path=\"url(#{clip})\"/>"
    )
    outline = (
        f"<circle cx=\"{CENTER_X}\" cy=\"{CENTER_Y}\" r=\"{PRECIP_RADIUS}\" fill=\"none\" stroke=\"#666\" stroke-width=\"1\"/>"
    )
    return (
        f"<defs><clipPath id=\"{clip}\"><circle cx=\"{CENTER_X}\" cy=\"{CENTER_Y}\" r=\"{PRECIP_RADIUS}\"/></clipPath></defs>"
        f"{rect}{waves}{outline}"
    )


def draw_wind_arrow(wind_dir_deg: float) -> str:
    """Arrow from WIND_RADIUS to WIND_RADIUS+10, rotated to "to" direction.
    `wind_dir_deg` is meteorological (0°=N, clockwise), indicating where wind comes FROM.
    For display, point arrow to where wind is GOING: rotate by (wind_dir_deg + 90°).
    """
    x1 = CENTER_X + WIND_RADIUS
    y1 = CENTER_Y
    x2 = CENTER_X + WIND_RADIUS + 10.0
    y2 = CENTER_Y
    rot = (float(wind_dir_deg) + 90.0) % 360.0
    return (
        f"<g transform=\"rotate({rot:.1f},{CENTER_X},{CENTER_Y})\">"
        f"<line x1=\"{x1:.2f}\" y1=\"{y1:.2f}\" x2=\"{x2:.2f}\" y2=\"{y2:.2f}\" stroke=\"#222\" stroke-width=\"2\"/>"
        f"<polygon points=\"{x2:.2f},{y2:.2f} {x2-6:.2f},{y2-3:.2f} {x2-6:.2f},{y2+3:.2f}\" fill=\"#222\"/>"
        f"</g>"
    )


def generate_glyph_v2(stats: Dict[str, float], debug: bool = False) -> str:
    """Compose a glyph with temperature reference ring, range, median, precipitation, and wind arrow."""
    temp_med = float(stats.get('temperature_c', 15.0))
    temp_p25 = float(stats.get('temp_p25', temp_med - 2.0))
    temp_p75 = float(stats.get('temp_p75', temp_med + 2.0))
    prcp = float(stats.get('precipitation_mm', 0.0))
    wdir = float(stats.get('wind_dir_deg', 0.0))
    wvar = float(stats.get('wind_var_deg', 0.0))
    wspd = float(stats.get('wind_speed_ms', 0.0))

    global DEBUG_GLYPH
    DEBUG_GLYPH = bool(debug)

    # Increase contrast slightly
    ref_ring = draw_temperature_reference_ring(alpha=0.30)
    rng_arc = draw_temperature_range(temp_p25, temp_p75, alpha=0.90)
    med_dot = draw_temperature_median(temp_med)
    if 'rain_probability' in stats and 'rain_typical_mm' in stats:
        precip = draw_precipitation_prob_intensity(float(stats.get('rain_probability', 0.0)), float(stats.get('rain_typical_mm', 0.0)), add_wave=True)
    else:
        precip = draw_precipitation(prcp, add_wave=True)
    wind_svg, wind_warn, bf = render_wind(wdir, wspd, wvar, None, TEMP_RADIUS_OUTER)
    dbg = _debug_rings() + _debug_temperature_ticks()

    svg = (
        f"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{SIZE}\" height=\"{SIZE}\" viewBox=\"0 0 {SIZE} {SIZE}\">"
        f"{ref_ring}{precip}{rng_arc}{med_dot}{wind_svg}{dbg}"
        f"</svg>"
    )
    return svg


def _sector_width_from_variance(variance_deg: float) -> float:
    """Map 0→10°, 90→120° (full width)."""
    v = max(0.0, min(90.0, float(variance_deg)))
    return 10.0 + (v / 90.0) * (120.0 - 10.0)


def draw_variability_sector(wind_dir_deg: float, variance_deg: float) -> str:
    width = _sector_width_from_variance(variance_deg)
    half = width / 2.0
    start = wind_dir_deg - half
    end = wind_dir_deg + half
    x1, y1 = _polar_to_cart(WIND_RADIUS, start)
    x2, y2 = _polar_to_cart(WIND_RADIUS, end)
    large_arc = 1 if (end - start) > 180.0 else 0
    path = (
        f"M {CENTER_X},{CENTER_Y} L {x1:.2f},{y1:.2f} "
        f"A {WIND_RADIUS:.2f},{WIND_RADIUS:.2f} 0 {large_arc} 1 {x2:.2f},{y2:.2f} Z"
    )
    return f"<path d=\"{path}\" fill=\"rgba(120,120,120,0.25)\" stroke=\"none\"/>"


def _debug_rings() -> str:
    if not DEBUG_GLYPH:
        return ''
    rings = []
    for r in (PRECIP_RADIUS, TEMP_RADIUS_OUTER, WIND_RADIUS):
        rings.append(
            f"<circle cx=\"{CENTER_X}\" cy=\"{CENTER_Y}\" r=\"{r}\" fill=\"none\" stroke=\"#dddddd\" stroke-width=\"1\"/>"
        )
    return ''.join(rings)


def generate_glyph(stats: Dict[str, float], debug: bool = False) -> str:
    """Compose layers into a single SVG string following the strict order."""
    temp = float(stats.get('temperature_c', 15.0))
    prcp = float(stats.get('precipitation_mm', 0.0))
    wdir = float(stats.get('wind_dir_deg', 0.0))
    wvar = float(stats.get('wind_var_deg', 30.0))

    global DEBUG_GLYPH
    DEBUG_GLYPH = bool(debug)

    sector = draw_variability_sector(wdir, wvar)
    if 'rain_probability' in stats and 'rain_typical_mm' in stats:
        precip = draw_precipitation_prob_intensity(float(stats.get('rain_probability', 0.0)), float(stats.get('rain_typical_mm', 0.0)), add_wave=True)
    else:
        precip = draw_precipitation(prcp, add_wave=True)
    temp_arc = draw_temperature_arc(temp)
    arrow = draw_wind_arrow(wdir)
    dbg = _debug_rings()

    # Compose SVG with max radius guard (elements already respect fixed radii)
    svg = (
        f"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{SIZE}\" height=\"{SIZE}\" viewBox=\"0 0 {SIZE} {SIZE}\">"
        f"{sector}{precip}{temp_arc}{arrow}{dbg}"
        f"</svg>"
    )
    return svg
