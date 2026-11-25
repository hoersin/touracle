"""Deterministic route and weather fixtures shared by the F-01..F-04 tests.

Weather is a pure function of (position, calendar day), so every displayed
value can be traced back to the place and date it claims to describe:

* temperature encodes the calendar day only:  5 °C + 0.1 °C per day of year
* precipitation encodes the longitude only:   see ``rain_at_lon``
"""
from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path

LAT = 48.0
LON0 = 5.0
START = dt.date(2026, 6, 1)
KM_PER_DEG_LON = math.radians(1.0) * 6371.0 * math.cos(math.radians(LAT))


def lon_at_km(km: float) -> float:
    return LON0 + km / KM_PER_DEG_LON


def km_at_lon(lon: float) -> float:
    return (lon - LON0) * KM_PER_DEG_LON


def write_gpx(path: Path, total_km: float, *, spacing_km: float = 1.0, elevation: bool = True) -> Path:
    """Straight west-to-east route with evenly spaced points."""
    n = int(round(total_km / spacing_km))
    pts = []
    for i in range(n + 1):
        km = total_km * i / n
        ele = f'<ele>{200 + 100 * math.sin(km / 10):.1f}</ele>' if elevation else ''
        pts.append(f'<trkpt lat="{LAT}" lon="{lon_at_km(km):.8f}">{ele}</trkpt>')
    path.write_text(
        '<?xml version="1.0"?><gpx version="1.1" creator="test" '
        'xmlns="http://www.topografix.com/GPX/1/1"><trk><name>synthetic</name><trkseg>'
        + ''.join(pts) + '</trkseg></trk></gpx>', encoding='utf-8')
    return path


def temp_on(day: dt.date) -> float:
    return round(5.0 + 0.1 * dt.date(2025, day.month, day.day).timetuple().tm_yday, 3)


def rain_at_lon(lon: float) -> float:
    """2 mm at the start, +0.01 mm per route kilometre (gentle gradient)."""
    return 2.0 + 0.01 * km_at_lon(lon)


def make_stats(lat: float, lon: float, month: int, day: int, *, rain_fn=rain_at_lon) -> dict:
    t = temp_on(dt.date(2025, month, day))
    r = float(rain_fn(lon))
    return {
        'temperature_c': t, 'temp_p25': t - 1, 'temp_p75': t + 1, 'temp_std': 0.5,
        'precipitation_mm': r, 'rain_probability': 0.5, 'rain_typical_mm': r,
        'rain_hist_p25_mm': 0.0, 'rain_hist_p75_mm': r, 'rain_hist_p90_mm': r,
        'wind_speed_ms': 2.0, 'wind_dir_deg': 270.0, 'wind_var_deg': 10.0,
        'temp_hist_median': t, 'temp_hist_min': t - 2, 'temp_hist_max': t + 2,
        'temp_hist_p25': t - 1, 'temp_hist_p75': t + 1,
        'temp_day_typical_min': t - 1, 'temp_day_typical_max': t + 1,
        'temp_day_p25': t - 1, 'temp_day_p75': t + 1, 'temp_day_median': t,
        '_offline': True, '_provider': 'open-meteo', '_tile_id': 'synthetic',
        '_match_days': 1, '_years_start': 2025, '_years_end': 2025, '_years_used': [2025],
    }


def parse_sse(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.split('\n\n'):
        event, data = 'message', None
        for line in block.split('\n'):
            if line.startswith('event:'):
                event = line[6:].strip()
            elif line.startswith('data:'):
                data = line[5:].strip()
        if data is not None:
            out.append((event, json.loads(data)))
    return out
