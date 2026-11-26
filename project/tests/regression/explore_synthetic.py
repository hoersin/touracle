"""Synthetic Explore grid that mimics the real offline stores.

Geometry follows the store layout (50 km tiles, rows from lat 34), but the column
origin deliberately differs from the reported bbox, as in the real yearly databases
(their column 0 does not start at the bbox lon_min). Values are chosen so the
selected month, the overlay and the spatial position can be read back from the
rendered map colours.
"""
from __future__ import annotations

import math

BBOX = [34.0, 72.0, -28.0, 33.0]
TILE_KM = 50.0
LON_ORIGIN = -11.0          # column origin of the points, not BBOX[2]
STEP_LAT = TILE_KM / 111.32

# Monthly base temperature, chosen to fall clearly inside one temperature bin.
MONTH_TEMP = {1: -2.0, 2: 1.0, 3: 7.5, 4: 11.0, 5: 13.0, 6: 17.5,
              7: 27.5, 8: 22.5, 9: 17.5, 10: 12.5, 11: 7.5, 12: 2.0}
YEAR_TEMP = 12.5
MONTH_RAIN = {m: 1.0 + m for m in range(1, 13)}
YEAR_RAIN = 6.0


def period_month(args) -> int | None:
    """Month that defines the requested period (None for the full year)."""
    ts = args.get('timescale', 'year')
    if ts == 'year':
        return None
    mm = int(str(args.get('date', '01-01')).split('-')[0])
    if ts == 'quarter':
        return 1 + 3 * ((mm - 1) // 3)
    return mm


def temperature(month, lon, gradient):
    base = YEAR_TEMP if month is None else MONTH_TEMP[month]
    return base + gradient * (lon - 10.0)


# Rows in this band mix two layouts, as in the real databases: tiles east of 8 E use
# the bbox origin (-28 deg) while the rest of the row uses LON_ORIGIN.
MIXED_LAT = (44.0, 46.5)
MIXED_FROM_LON = 8.0


def grid(args, *, gradient=0.0, mixed=False):
    lat_min = float(args['lat_min']) - 0.6
    lat_max = float(args['lat_max']) + 0.6
    lon_min = float(args['lon_min']) - 0.8
    lon_max = float(args['lon_max']) + 0.8
    month = period_month(args)
    rain = YEAR_RAIN if month is None else MONTH_RAIN[month]
    points = []
    row = 0
    while True:
        lat = BBOX[0] + (row + 0.5) * STEP_LAT
        if lat > BBOX[1]:
            break
        if lat_min <= lat <= lat_max:
            step_lon = TILE_KM / (111.32 * max(0.05, math.cos(math.radians(lat))))
            mix = mixed and MIXED_LAT[0] <= lat <= MIXED_LAT[1]
            cells = []          # (col, lon) of the row, in the layout(s) the row uses
            col = 0
            while LON_ORIGIN + (col + 0.5) * step_lon <= BBOX[3]:
                lon = LON_ORIGIN + (col + 0.5) * step_lon
                if mix and lon >= MIXED_FROM_LON:
                    break
                cells.append((col, lon))
                col += 1
            if mix:
                last_lon = cells[-1][1] if cells else MIXED_FROM_LON
                col = math.floor((last_lon - BBOX[2]) / step_lon - 0.5) + 1   # first B tile east of A's last
                while BBOX[2] + (col + 0.5) * step_lon <= BBOX[3]:
                    cells.append((col, BBOX[2] + (col + 0.5) * step_lon))
                    col += 1
            for tile_col, lon in cells:
                if lon_min <= lon <= lon_max:
                    t = temperature(month, lon, gradient)
                    points.append({
                        'tile_id': f'r{row}_c{tile_col}', 'row': row, 'col': tile_col, 'lat': lat, 'lon': lon,
                        'temperature_c': t, 'temp_day_median': t, 'temp_day_p25': t - 1, 'temp_day_p75': t + 1,
                        'precipitation_mm': rain, 'rain_probability': 0.4, 'rain_typical_mm': rain,
                        'wind_speed_ms': 7.0, 'wind_dir_deg': 270.0, 'wind_var_deg': 0.5,
                        'lucky_day_count': 10, 'lucky_ride_count': 10,
                    })
        row += 1
    ts = args.get('timescale', 'year')
    return {
        'bbox': BBOX, 'tile_km': TILE_KM, 'mode': 'full_day', 'timescale': ts,
        'month': month or 1, 'day': 1, 'year': 2025, 'years_selected': [2025],
        'years': {'start': 2025, 'end': 2025}, 'sample_days': 30, 'count': len(points), 'points': points,
    }
