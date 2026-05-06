import sys
import json
import math
import csv
from datetime import date, datetime, timedelta
from pathlib import Path
import argparse
from typing import Any, Dict, Iterable, List, Optional, Tuple
import cairosvg
import gpxpy

# Ensure backend modules are importable
BASE = Path(__file__).resolve().parent
BACKEND = BASE / 'backend'
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from route_sampling import sample_route, haversine_km
from weather_openmeteo import fetch_daily_weather
from weather import compute_weather_statistics
from glyph import generate_svg_glyph
from offline_weather_store import OfflineWeatherStore
from app import _get_offline_store_for_year

DATA_DIR = BASE / 'data'
DEFAULT_GPX = DATA_DIR / '2026-02-13_2781422668_von Montpellier nach Bayonne.gpx'
DEBUG_DIR = BASE / 'debug_output'
GLYPHS_DIR = DEBUG_DIR / 'glyphs'
DEBUG_DIR.mkdir(exist_ok=True)
GLYPHS_DIR.mkdir(exist_ok=True)
DEFAULT_START_DATE = date(2025, 5, 20)
DEFAULT_END_DATE = date(2025, 6, 4)
DEFAULT_OFFLINE_YEAR = 2025
DEFAULT_CSV = DEBUG_DIR / 'route_weather_comparison_2025_montpellier_bayonne.csv'


def load_gpx_points_with_elevation(gpx_path: Path) -> List[Tuple[float, float, Optional[float]]]:
    with open(gpx_path, 'r', encoding='utf-8') as handle:
        gpx = gpxpy.parse(handle)

    points: List[Tuple[float, float, Optional[float]]] = []
    for track in gpx.tracks:
        for segment in track.segments:
            for point in segment.points:
                points.append((float(point.latitude), float(point.longitude), float(point.elevation) if point.elevation is not None else None))

    for route in gpx.routes:
        for point in route.points:
            points.append((float(point.latitude), float(point.longitude), float(point.elevation) if point.elevation is not None else None))

    if len(points) < 2:
        raise ValueError('GPX must contain at least two points with coordinates')
    return points


def cumulative_route_distances(points: List[Tuple[float, float, Optional[float]]]) -> List[float]:
    distances: List[float] = [0.0]
    total_km = 0.0
    for idx in range(1, len(points)):
        lat1, lon1, _ = points[idx - 1]
        lat2, lon2, _ = points[idx]
        total_km += haversine_km(lat1, lon1, lat2, lon2)
        distances.append(total_km)
    return distances


def nearest_route_distance_km(lat: float, lon: float, route_points: List[Tuple[float, float, Optional[float]]], route_cum_km: List[float]) -> float:
    best_idx = 0
    best_d2 = float('inf')
    for idx, (route_lat, route_lon, _) in enumerate(route_points):
        mean_lat = (lat + route_lat) * 0.5
        dx = (route_lon - lon) * (math.pi / 180.0) * max(0.1, abs(math.cos(mean_lat * math.pi / 180.0)))
        dy = (route_lat - lat) * (math.pi / 180.0)
        d2 = dx * dx + dy * dy
        if d2 < best_d2:
            best_d2 = d2
            best_idx = idx
    return float(route_cum_km[best_idx])


def sample_elevation_m(lat: float, lon: float, route_points: List[Tuple[float, float, Optional[float]]]) -> Optional[float]:
    best_elevation: Optional[float] = None
    best_d2 = float('inf')
    for route_lat, route_lon, elevation_m in route_points:
        if elevation_m is None:
            continue
        mean_lat = (lat + route_lat) * 0.5
        dx = (route_lon - lon) * (math.pi / 180.0) * max(0.1, abs(math.cos(mean_lat * math.pi / 180.0)))
        dy = (route_lat - lat) * (math.pi / 180.0)
        d2 = dx * dx + dy * dy
        if d2 < best_d2:
            best_d2 = d2
            best_elevation = float(elevation_m)
    return best_elevation


def assign_tour_date(point_distance_km: float, total_distance_km: float, start_date: date, total_days: int) -> date:
    if total_days <= 1 or total_distance_km <= 0.0:
        return start_date
    segment_length_km = max(0.0001, total_distance_km / total_days)
    day_index = int(min(total_days - 1, max(0, math.floor(point_distance_km / segment_length_km))))
    return start_date + timedelta(days=day_index)


def _weighted_average(values: Iterable[Tuple[Optional[float], float]]) -> Optional[float]:
    numerator = 0.0
    denominator = 0.0
    for value, weight in values:
        if value is None:
            continue
        numerator += float(value) * float(weight)
        denominator += float(weight)
    if denominator <= 0.0:
        return None
    return numerator / denominator


def _weighted_circular_mean_deg(values: Iterable[Tuple[Optional[float], float]]) -> Optional[float]:
    x = 0.0
    y = 0.0
    total_weight = 0.0
    for value, weight in values:
        if value is None:
            continue
        radians = math.radians(float(value))
        x += math.cos(radians) * float(weight)
        y += math.sin(radians) * float(weight)
        total_weight += float(weight)
    if total_weight <= 0.0:
        return None
    if abs(x) < 1e-12 and abs(y) < 1e-12:
        return 0.0
    direction = math.degrees(math.atan2(y, x))
    if direction < 0.0:
        direction += 360.0
    return direction


def bilinear_offline_stats(store: OfflineWeatherStore, lat: float, lon: float, month: int, day: int) -> Tuple[Optional[Dict[str, Any]], str]:
    tile_id = store._tile_id_for_point(float(lat), float(lon))
    if tile_id is None:
        return None, 'outside_bbox'

    tile_row: Optional[int] = None
    tile_col: Optional[int] = None
    tile_lat: Optional[float] = None
    tile_lon: Optional[float] = None
    with store._lock:
        row = store._conn.execute(
            'SELECT row, col, lat, lon FROM tiles WHERE tile_id=?',
            (str(tile_id),),
        ).fetchone()
    if not row:
        return None, 'missing_tile'
    tile_row, tile_col, tile_lat, tile_lon = int(row[0]), int(row[1]), float(row[2]), float(row[3])

    lat_min, _, lon_min, _ = store.cfg.bbox
    step_lat = float(store.cfg.tile_km) / 111.32
    row_origin_lat = lat_min + tile_row * step_lat
    row_fraction = ((float(lat) - row_origin_lat) / step_lat) if step_lat > 0 else 0.0
    row_fraction = max(0.0, min(0.999999, row_fraction))
    north_row = tile_row + 1
    south_row = tile_row

    cos_lat = max(0.05, math.cos(math.radians(tile_lat)))
    step_lon = float(store.cfg.tile_km) / (111.32 * cos_lat)
    col_origin_lon = lon_min + tile_col * step_lon
    col_fraction = ((float(lon) - col_origin_lon) / step_lon) if step_lon > 0 else 0.0
    col_fraction = max(0.0, min(0.999999, col_fraction))
    west_col = tile_col
    east_col = tile_col + 1

    neighbor_specs = [
        ('sw', south_row, west_col, (1.0 - row_fraction) * (1.0 - col_fraction)),
        ('se', south_row, east_col, (1.0 - row_fraction) * col_fraction),
        ('nw', north_row, west_col, row_fraction * (1.0 - col_fraction)),
        ('ne', north_row, east_col, row_fraction * col_fraction),
    ]
    neighbors: List[Tuple[str, Dict[str, Any], float]] = []
    fallback_candidates: List[Tuple[float, Dict[str, Any]]] = []
    for label, row_idx, col_idx, weight in neighbor_specs:
        neighbor_tile_id = f'r{row_idx}_c{col_idx}'
        with store._lock:
            center_row = store._conn.execute(
                'SELECT lat, lon FROM tiles WHERE tile_id=?',
                (neighbor_tile_id,),
            ).fetchone()
        stats = store.get_stats_for_tile(neighbor_tile_id, int(month), int(day))
        if stats is None:
            continue
        stats = dict(stats)
        stats['_tile_id'] = neighbor_tile_id
        neighbors.append((label, stats, float(weight)))
        if center_row:
            center_lat, center_lon = float(center_row[0]), float(center_row[1])
            fallback_distance = haversine_km(float(lat), float(lon), center_lat, center_lon)
        else:
            fallback_distance = 1e9
        fallback_candidates.append((fallback_distance, stats))

    if len(neighbors) == 4:
        scalar_keys = [
            'temperature_c', 'temp_p25', 'temp_p75', 'temp_std',
            'precipitation_mm', 'rain_probability', 'rain_typical_mm',
            'rain_hist_p25_mm', 'rain_hist_p75_mm', 'rain_hist_p90_mm',
            'wind_speed_ms', 'wind_var_deg', 'temp_hist_p25', 'temp_hist_p75',
            'temp_day_p25', 'temp_day_p75', 'temp_day_median',
            'samples_daily', 'samples_rain', 'samples_wind', 'samples_day_means', 'samples_day_hours',
        ]
        blended: Dict[str, Any] = {'_source_mode': 'offline_bilinear', '_tile_id': tile_id}
        for key in scalar_keys:
            blended[key] = _weighted_average((stats.get(key), weight) for _, stats, weight in neighbors)
        blended['wind_dir_deg'] = _weighted_circular_mean_deg((stats.get('wind_dir_deg'), weight) for _, stats, weight in neighbors)
        blended['_neighbor_tiles'] = ','.join(stats.get('_tile_id', '') for _, stats, _ in neighbors)
        return blended, 'bilinear'

    if fallback_candidates:
        fallback_candidates.sort(key=lambda item: item[0])
        fallback = dict(fallback_candidates[0][1])
        fallback['_source_mode'] = 'offline_nearest_fallback'
        fallback['_tile_id'] = fallback.get('_tile_id') or tile_id
        return fallback, 'nearest_fallback'

    return None, 'missing_neighbors'


def with_lapse_rate(stats: Optional[Dict[str, Any]], elevation_m: Optional[float], lapse_rate_c_per_100m: float = -0.6) -> Optional[Dict[str, Any]]:
    if stats is None:
        return None
    adjusted = dict(stats)
    adjusted['_source_mode'] = 'offline_bilinear_lapse'
    adjusted['_route_elevation_m'] = elevation_m
    if elevation_m is None:
        return adjusted
    delta_c = (float(elevation_m) / 100.0) * float(lapse_rate_c_per_100m)
    for key in ('temperature_c', 'temp_p25', 'temp_p75', 'temp_hist_p25', 'temp_hist_p75', 'temp_day_p25', 'temp_day_p75', 'temp_day_median'):
        value = adjusted.get(key)
        if value is not None:
            adjusted[key] = float(value) + delta_c
    adjusted['_temperature_delta_c'] = delta_c
    return adjusted


def current_stats_for_points(sampled_points: List[Tuple[float, float]], assigned_dates: List[date], sample_count: Optional[int] = None) -> List[Optional[Dict[str, Any]]]:
    max_points = len(sampled_points) if sample_count is None else min(len(sampled_points), int(sample_count))
    current_stats: List[Optional[Dict[str, Any]]] = [None] * max_points
    stats_cache: Dict[Tuple[float, float, date], Dict[str, Any]] = {}

    for idx in range(max_points):
        lat, lon = sampled_points[idx]
        day_value = assigned_dates[idx]
        cache_key = (round(float(lat), 6), round(float(lon), 6), day_value)
        if cache_key not in stats_cache:
            df = fetch_daily_weather(float(lat), float(lon), int(day_value.month), int(day_value.day))
            stats, matches = compute_weather_statistics(df, int(day_value.month), int(day_value.day))
            stats = dict(stats)
            stats['_match_days'] = int(matches)
            stats['_source_mode'] = 'current_route_weather'
            stats_cache[cache_key] = stats
        current_stats[idx] = stats_cache[cache_key]
    return current_stats


def value_or_blank(mapping: Optional[Dict[str, Any]], key: str) -> Any:
    if mapping is None:
        return ''
    value = mapping.get(key)
    if value is None:
        return ''
    return value


def delta_or_blank(left: Optional[Dict[str, Any]], left_key: str, right: Optional[Dict[str, Any]], right_key: str) -> Any:
    if left is None or right is None:
        return ''
    left_value = left.get(left_key)
    right_value = right.get(right_key)
    if left_value is None or right_value is None:
        return ''
    try:
        return float(left_value) - float(right_value)
    except Exception:
        return ''


def build_route_weather_comparison(
    gpx_path: Path,
    start_date: date,
    end_date: date,
    offline_year: int,
    csv_path: Path,
    step_km: float = 25.0,
    sample_limit: Optional[int] = None,
) -> Path:
    sampled_points, _ = sample_route(str(gpx_path), step_km=step_km)
    route_points = load_gpx_points_with_elevation(gpx_path)
    route_cum_km = cumulative_route_distances(route_points)
    total_distance_km = route_cum_km[-1]
    total_days = int((end_date - start_date).days) + 1
    assigned_dates: List[date] = []
    point_distances_km: List[float] = []
    elevations_m: List[Optional[float]] = []

    for lat, lon in sampled_points:
        route_distance_km = nearest_route_distance_km(float(lat), float(lon), route_points, route_cum_km)
        assigned_dates.append(assign_tour_date(route_distance_km, total_distance_km, start_date, total_days))
        point_distances_km.append(route_distance_km)
        elevations_m.append(sample_elevation_m(float(lat), float(lon), route_points))

    current_stats_by_point = current_stats_for_points(sampled_points, assigned_dates, sample_limit)
    store = _get_offline_store_for_year(int(offline_year))
    if store is None:
        raise RuntimeError(f'Offline store for year {offline_year} is unavailable')

    row_limit = len(sampled_points) if sample_limit is None else min(len(sampled_points), int(sample_limit))
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with open(csv_path, 'w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=[
            'point_index', 'distance_km', 'assigned_date', 'latitude', 'longitude', 'route_elevation_m',
            'current_temperature_c', 'current_precipitation_mm', 'current_wind_speed_ms', 'current_wind_dir_deg', 'current_source_mode',
            'offline_bilinear_temperature_c', 'offline_bilinear_precipitation_mm', 'offline_bilinear_wind_speed_ms', 'offline_bilinear_wind_dir_deg', 'offline_bilinear_quality', 'offline_bilinear_tile_id', 'offline_bilinear_neighbor_tiles',
            'att_minus_offline_temperature_delta_c', 'att_minus_offline_precipitation_delta_mm', 'att_minus_offline_wind_speed_delta_ms',
        ])
        writer.writeheader()
        for idx in range(row_limit):
            lat, lon = sampled_points[idx]
            assigned_day = assigned_dates[idx]
            current_stats = current_stats_by_point[idx]
            offline_stats, offline_quality = bilinear_offline_stats(store, float(lat), float(lon), assigned_day.month, assigned_day.day)
            writer.writerow({
                'point_index': idx + 1,
                'distance_km': round(point_distances_km[idx], 3),
                'assigned_date': assigned_day.isoformat(),
                'latitude': round(float(lat), 6),
                'longitude': round(float(lon), 6),
                'route_elevation_m': '' if elevations_m[idx] is None else round(float(elevations_m[idx]), 1),
                'current_temperature_c': value_or_blank(current_stats, 'temperature_c'),
                'current_precipitation_mm': value_or_blank(current_stats, 'precipitation_mm'),
                'current_wind_speed_ms': value_or_blank(current_stats, 'wind_speed_ms'),
                'current_wind_dir_deg': value_or_blank(current_stats, 'wind_dir_deg'),
                'current_source_mode': value_or_blank(current_stats, '_source_mode'),
                'offline_bilinear_temperature_c': value_or_blank(offline_stats, 'temperature_c'),
                'offline_bilinear_precipitation_mm': value_or_blank(offline_stats, 'precipitation_mm'),
                'offline_bilinear_wind_speed_ms': value_or_blank(offline_stats, 'wind_speed_ms'),
                'offline_bilinear_wind_dir_deg': value_or_blank(offline_stats, 'wind_dir_deg'),
                'offline_bilinear_quality': offline_quality,
                'offline_bilinear_tile_id': value_or_blank(offline_stats, '_tile_id'),
                'offline_bilinear_neighbor_tiles': value_or_blank(offline_stats, '_neighbor_tiles'),
                'att_minus_offline_temperature_delta_c': delta_or_blank(current_stats, 'temperature_c', offline_stats, 'temperature_c'),
                'att_minus_offline_precipitation_delta_mm': delta_or_blank(current_stats, 'precipitation_mm', offline_stats, 'precipitation_mm'),
                'att_minus_offline_wind_speed_delta_ms': delta_or_blank(current_stats, 'wind_speed_ms', offline_stats, 'wind_speed_ms'),
            })
    return csv_path


def main(month=5, day=15, sample_count=5, gpx_path: Path = DEFAULT_GPX):
    print('[STEP] Loading GPX track')
    sampled, route = sample_route(str(gpx_path), step_km=25.0)
    print(f"[STEP] Sampling route points: total={len(sampled)} first={sampled[0]}")

    # Build station index for route bounds
    # Using point-based retrieval; no station index required

    results = []
    # Define date range: last 10 full years
    from datetime import date
    today = date.today()
    end = date(today.year - 1, 12, 31)
    start = date(end.year - 9, 1, 1)

    for i, (lat, lon) in enumerate(sampled[:sample_count]):
        print(f"\nPOINT {i+1}")
        print(f"Route: {lat:.4f}, {lon:.4f}")
        try:
            df = fetch_daily_weather(lat, lon, start, end)
        except Exception as e:
            print(f"[ERROR] Weather fetch failed: {e}")
            continue
        print(f"Weather rows retrieved: {len(df)}")
        if len(df) < 30:
            print('[WARNING] Insufficient data rows; skipping glyph generation for this point')
            continue
        try:
            stats, matches = compute_weather_statistics(df, month, day)
        except Exception as e:
            print(f"[WARNING] Weather stats skipped: {e}")
            continue
        print(f"Matching days: {matches}")
        print(f"Median Temp: {stats['temperature_c']:.1f}°C")
        print(f"Median Precip: {stats['precipitation_mm']:.1f} mm")
        print(f"Median Wind: {stats['wind_speed_ms']:.1f} m/s")
        print(f"Wind Dir Var: {stats['wind_var_deg']:.0f}°")
        svg = generate_svg_glyph(stats)
        svg_path = GLYPHS_DIR / f'glyph_point_{i+1}.svg'
        try:
            svg_path.write_text(svg, encoding='utf-8')
            print('Glyph: OK')
        except Exception as e:
            print(f"Glyph: FAILED ({e})")
        # Convert to PNG for viewing
        try:
            png_path = GLYPHS_DIR / f'glyph_point_{i+1}.png'
            cairosvg.svg2png(bytestring=svg.encode('utf-8'), write_to=str(png_path), output_width=256, output_height=256)
            print(f"Glyph saved: {png_path}")
        except Exception as e:
            print(f"PNG: FAILED ({e})")
        results.append({
            'route_lat': lat,
            'route_lon': lon,
            'stats': stats
        })

    # Save intermediate artifacts
    (DEBUG_DIR / 'sampled_points.json').write_text(json.dumps([{'lat': lat, 'lon': lon} for (lat, lon) in sampled], indent=2), encoding='utf-8')
    (DEBUG_DIR / 'debug_summary.json').write_text(json.dumps({'results': results}, indent=2), encoding='utf-8')

    # Generate static glyphs.html listing PNGs
    html_path = DEBUG_DIR / 'glyphs.html'
    items = []
    for i, r in enumerate(results, start=1):
        png = GLYPHS_DIR / f'glyph_point_{i}.png'
        if png.exists():
            items.append((png.name, r['route_lat'], r['route_lon']))
    html = [
        '<!DOCTYPE html>', '<html><head><meta charset="utf-8"><title>Glyphs Preview</title>',
        '<style>body{font-family:system-ui;margin:20px} .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px} .card{border:1px solid #ddd;border-radius:8px;padding:8px} .card img{width:100%;height:auto}</style>',
        '</head><body><h1>Glyph Preview</h1><div class="grid">'
    ]
    for name, lat, lon in items:
        html.append(f'<div class="card"><img src="glyphs/{name}" alt="{name}"><div>{name}<br>Lat {lat:.4f} Lon {lon:.4f}</div></div>')
    html.append('</div></body></html>')
    html_path.write_text('\n'.join(html), encoding='utf-8')
    print(f"\nPreview: open {html_path}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Debug weather glyph pipeline')
    parser.add_argument('--month', type=int, default=5)
    parser.add_argument('--day', type=int, default=15)
    parser.add_argument('--samples', type=int, default=0)
    parser.add_argument('--gpx', type=str, default=str(DEFAULT_GPX))
    parser.add_argument('--compare-route-weather', action='store_true')
    parser.add_argument('--start-date', type=str, default=DEFAULT_START_DATE.isoformat())
    parser.add_argument('--end-date', type=str, default=DEFAULT_END_DATE.isoformat())
    parser.add_argument('--offline-year', type=int, default=DEFAULT_OFFLINE_YEAR)
    parser.add_argument('--csv', type=str, default=str(DEFAULT_CSV))
    parser.add_argument('--step-km', type=float, default=25.0)
    args = parser.parse_args()
    if args.compare_route_weather:
        csv_path = build_route_weather_comparison(
            gpx_path=Path(args.gpx),
            start_date=datetime.strptime(args.start_date, '%Y-%m-%d').date(),
            end_date=datetime.strptime(args.end_date, '%Y-%m-%d').date(),
            offline_year=int(args.offline_year),
            csv_path=Path(args.csv),
            step_km=float(args.step_km),
            sample_limit=(int(args.samples) if args.samples > 0 else None),
        )
        print(f'[OK] Comparison CSV written to {csv_path}')
    else:
        main(month=args.month, day=args.day, sample_count=(args.samples if args.samples > 0 else 5), gpx_path=Path(args.gpx))
