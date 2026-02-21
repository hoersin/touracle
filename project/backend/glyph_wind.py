"""Advanced wind glyph rendering helpers.
Encodes direction, speed via arrow length+color, barbs, variability sector, and warnings.
"""
from __future__ import annotations
from typing import Tuple
import math
import logging

log = logging.getLogger('pipeline.glyph.wind')

# Geometry constants (keep in sync with glyph_geometry)
CENTER_X = 32.0
CENTER_Y = 32.0
WIND_RADIUS = 22.0
MAX_EXTRA_LENGTH_PX = 18.0
MAX_VISUAL_SPEED_MS = 20.0
SECTOR_ALPHA = 0.12


def _polar_to_cart(r: float, a_deg: float) -> Tuple[float, float]:
    a = math.radians(a_deg)
    return CENTER_X + r * math.cos(a), CENTER_Y - r * math.sin(a)


def fixed_arrow_total_length(temp_outer_radius: float) -> float:
    """Total arrow length = 1.4 × outer diameter of temperature scale."""
    return 1.4 * (2.0 * float(temp_outer_radius))


def speed_to_color(speed_ms: float) -> str:
    s = float(speed_ms)
    if s < 5.0:
        return '#2ca02c'  # green
    if s < 10.0:
        return '#f2c744'  # yellow
    if s < 15.0:
        return '#f28e2b'  # orange
    if s < 20.0:
        return '#d62728'  # red
    return '#8b0000'      # dark red


def compute_barbs(speed_ms: float) -> Tuple[int, int]:
    s = max(0.0, float(speed_ms))
    full = int(min(4, math.floor(s / 5.0)))
    half = 1 if (s - 5.0 * full) >= 2.5 else 0
    return full, half


def beaufort_from_ms(speed_ms: float) -> int:
    s = float(speed_ms)
    # Simple rounding to Beaufort; thresholds approximate
    # 0: <0.3, 1: <1.6, 2: <3.4, 3: <5.5, 4: <8.0, 5: <10.8, 6: <13.9, 7: <17.2, 8: <20.8, 9: <24.5, 10+: >=24.5
    thresholds = [0.3,1.6,3.4,5.5,8.0,10.8,13.9,17.2,20.8,24.5]
    for i, t in enumerate(thresholds):
        if s < t:
            return i
    return 10


def draw_variability_sector(median_dir_deg: float, circ_std_deg: float) -> str:
    width = max(0.0, float(circ_std_deg))
    half = width / 2.0
    start = median_dir_deg - half
    end = median_dir_deg + half
    x1, y1 = _polar_to_cart(WIND_RADIUS, start)
    x2, y2 = _polar_to_cart(WIND_RADIUS, end)
    large_arc = 1 if (end - start) > 180.0 else 0
    path = (
        f"M {CENTER_X},{CENTER_Y} L {x1:.2f},{y1:.2f} "
        f"A {WIND_RADIUS:.2f},{WIND_RADIUS:.2f} 0 {large_arc} 1 {x2:.2f},{y2:.2f} Z"
    )
    return f"<path d=\"{path}\" fill=\"rgba(120,120,120,{SECTOR_ALPHA})\" stroke=\"none\"/>"


def draw_wind_arrow_centered(median_dir_deg: float, speed_ms: float, temp_outer_radius: float) -> Tuple[str, Tuple[float, float], Tuple[float, float]]:
    """Return SVG for centered wind arrow, plus tip and tail coordinates (pre-rotation).
    Arrow total length fixed to 1.4×outer diameter; line in black; head scaled and dual-outlined for contrast.
    Median dir is meteorological (from). For display, rotate +90° to point to where wind is going.
    """
    total_len = fixed_arrow_total_length(temp_outer_radius)
    half = total_len / 2.0
    color = speed_to_color(speed_ms)
    # Baseline centered across the origin before rotation
    x1 = CENTER_X - half
    y1 = CENTER_Y
    x2 = CENTER_X + half
    y2 = CENTER_Y
    # Arrowhead dimensions scaled by temperature ring radius, with sensible minimums
    head_w = max(9.0, float(temp_outer_radius) * 0.25)   # back from tip
    head_h = max(5.0, head_w * 0.6)                      # total height
    p_tip = f"{x2:.2f},{y2:.2f}"
    p_up = f"{(x2 - head_w):.2f},{(y2 - head_h/2.0):.2f}"
    p_dn = f"{(x2 - head_w):.2f},{(y2 + head_h/2.0):.2f}"
    pts = f"{p_tip} {p_up} {p_dn}"
    rot = (float(median_dir_deg) + 90.0) % 360.0
    svg = (
        f"<g transform=\"rotate({rot:.1f},{CENTER_X},{CENTER_Y})\">"
        # Arrow shaft slightly thicker for better legibility
        f"<line x1=\"{x1:.2f}\" y1=\"{y1:.2f}\" x2=\"{x2:.2f}\" y2=\"{y2:.2f}\" stroke=\"#000\" stroke-width=\"1.4\"/>"
        # Arrowhead: white halo stroke under black stroke to pop on any background
        f"<polygon points=\"{pts}\" fill=\"{color}\" stroke=\"#ffffff\" stroke-width=\"2.2\" style=\"paint-order:stroke\"/>"
        f"<polygon points=\"{pts}\" fill=\"{color}\" stroke=\"#000000\" stroke-width=\"1.2\" style=\"paint-order:stroke\"/>"
        f"</g>"
    )
    return svg, (x2, y2), (x1, y1)


def draw_wind_barbs(median_dir_deg: float, arrow_tail_xy: Tuple[float, float], n_full: int, half: int) -> str:
    # Place barbs at the tail end, pre-rotation
    x1, y1 = arrow_tail_xy
    rot = (float(median_dir_deg) + 90.0) % 360.0
    # Barb geometry
    barb_len = 7.0
    barb_spacing = 3.5
    elems = []
    for i in range(n_full):
        bx = x1 + (i + 1) * barb_spacing
        by = y1
        elems.append(f"<line x1=\"{bx:.2f}\" y1=\"{by:.2f}\" x2=\"{bx:.2f}\" y2=\"{by-barb_len:.2f}\" stroke=\"#000\" stroke-width=\"1.2\"/>")
    if half:
        bx = x1 + (n_full + 1) * barb_spacing
        by = y1
        elems.append(f"<line x1=\"{bx:.2f}\" y1=\"{by:.2f}\" x2=\"{bx:.2f}\" y2=\"{by-(barb_len/2):.2f}\" stroke=\"#000\" stroke-width=\"1.2\"/>")
    inner = ''.join(elems)
    return f"<g transform=\"rotate({rot:.1f},{CENTER_X},{CENTER_Y})\">{inner}</g>"


def draw_warning_pennant(median_dir_deg: float) -> str:
    # Small red triangle at the perimeter in the arrow direction, with outline for contrast
    rot = (float(median_dir_deg) + 90.0) % 360.0
    tip_x, tip_y = _polar_to_cart(WIND_RADIUS + MAX_EXTRA_LENGTH_PX + 2.0, 0.0)
    p1 = (tip_x, tip_y)
    p2 = (tip_x - 6.0, tip_y - 3.0)
    p3 = (tip_x - 6.0, tip_y + 3.0)
    pts = f"{p1[0]:.2f},{p1[1]:.2f} {p2[0]:.2f},{p2[1]:.2f} {p3[0]:.2f},{p3[1]:.2f}"
    return (
        f"<g transform=\"rotate({rot:.1f},{CENTER_X},{CENTER_Y})\">"
        f"<polygon points=\"{pts}\" fill=\"#d62728\" stroke=\"#ffffff\" stroke-width=\"2.0\" style=\"paint-order:stroke\"/>"
        f"<polygon points=\"{pts}\" fill=\"#d62728\" stroke=\"#000000\" stroke-width=\"1.0\" style=\"paint-order:stroke\"/>"
        f"</g>"
    )


def render_wind(median_dir_deg: float, speed_ms: float, circ_std_deg: float, gust_max_ms: float | None = None, temp_outer_radius: float = 22.0) -> Tuple[str, bool, int]:
    """Compose wind elements and return (svg_str, warning_flag, beaufort)."""
    svg_arrow, tip, tail = draw_wind_arrow_centered(median_dir_deg, speed_ms, temp_outer_radius)
    full, half = compute_barbs(speed_ms)
    svg_barbs = draw_wind_barbs(median_dir_deg, tail, full, half)
    svg_sector = draw_variability_sector(median_dir_deg, circ_std_deg)
    warning = (speed_ms >= 17.2) or ((gust_max_ms or 0.0) >= 20.0)
    svg_warn = draw_warning_pennant(median_dir_deg) if warning else ''
    bf = beaufort_from_ms(speed_ms)
    log.info('[WIND] median_speed=%.1f m/s, gust_max=%s m/s, dir=%.0f°, circ_std=%.0f°', speed_ms, f"{gust_max_ms:.1f}" if gust_max_ms is not None else '-', float(median_dir_deg), float(circ_std_deg))
    if warning:
        log.warning('[WIND] WARNING: high winds — median >= 17.2 m/s or gusts >= 20 m/s')
    return svg_sector + svg_arrow + svg_barbs + svg_warn, warning, bf
