import sys
from pathlib import Path

# Ensure backend modules are importable when running from project root
BASE = Path(__file__).resolve().parent
BACKEND = BASE / 'backend'
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from route_sampling import load_gpx, sample_route
from stations import StationIndex, find_nearest_station
from weather import fetch_weather_data, compute_weather_statistics
from glyph import generate_svg_glyph

DATA_DIR = BASE / 'data'
GPX_FILE = DATA_DIR / '2026-02-13_2781422668_von Montpellier nach Bayonne.gpx'
DEBUG_DIR = BASE / 'debug_output'
DEBUG_DIR.mkdir(exist_ok=True)


def test_load_gpx():
    coords = load_gpx(str(GPX_FILE))
    print(f"[test_load_gpx] points={len(coords)} first={coords[0]}")


def test_sample_route():
    sampled, route = sample_route(str(GPX_FILE), step_km=25.0)
    print(f"[test_sample_route] sampled={len(sampled)} first={sampled[0]} last={sampled[-1]}")


def test_find_nearest_station():
    _, route = sample_route(str(GPX_FILE), step_km=25.0)
    coords = route['geometry']['coordinates']
    lats = [lat for lon, lat in coords]
    lons = [lon for lon, lat in coords]
    min_lat, max_lat = min(lats), max(lats)
    min_lon, max_lon = min(lons), max(lons)

    index = StationIndex()
    index.load_for_bounds(min_lat, min_lon, max_lat, max_lon, margin_deg=1.0)
    if not index.stations:
        print("[test_find_nearest_station] WARNING: no stations found")
        return
    sampled, _ = sample_route(str(GPX_FILE), step_km=25.0)
    lat, lon = sampled[0]
    res = find_nearest_station(lat, lon, index)
    if res is None:
        print("[test_find_nearest_station] WARNING: nearest station not found")
        return
    station, dist_km = res
    print(f"[test_find_nearest_station] station={station.name} id={station.id} dist_km={dist_km:.1f}")


def test_fetch_weather():
    # Use first station near first sampled point
    sampled, route = sample_route(str(GPX_FILE), step_km=25.0)
    coords = route['geometry']['coordinates']
    lats = [lat for lon, lat in coords]
    lons = [lon for lon, lat in coords]
    index = StationIndex()
    index.load_for_bounds(min(lats), min(lons), max(lats), max(lons), margin_deg=1.0)
    if not index.stations:
        print("[test_fetch_weather] WARNING: no stations found")
        return
    lat, lon = sampled[0]
    res = find_nearest_station(lat, lon, index)
    if res is None:
        print("[test_fetch_weather] WARNING: nearest station not found")
        return
    station, _ = res
    df, meta = fetch_weather_data(station.id, month=5, day=15)
    print(f"[test_fetch_weather] records={len(df)} days_found={meta.get('days_found')} years={meta.get('years_covered')}")


def test_compute_statistics():
    # Fetch then compute
    sampled, route = sample_route(str(GPX_FILE), step_km=25.0)
    coords = route['geometry']['coordinates']
    lats = [lat for lon, lat in coords]
    lons = [lon for lon, lat in coords]
    index = StationIndex()
    index.load_for_bounds(min(lats), min(lons), max(lats), max(lons), margin_deg=1.0)
    if not index.stations:
        print("[test_compute_statistics] WARNING: no stations found")
        return
    lat, lon = sampled[0]
    res = find_nearest_station(lat, lon, index)
    if res is None:
        print("[test_compute_statistics] WARNING: nearest station not found")
        return
    station, _ = res
    df, meta = fetch_weather_data(station.id, month=5, day=15)
    stats = compute_weather_statistics(df)
    print(f"[test_compute_statistics] stats={stats}")


def test_generate_glyph():
    # Compute stats then generate SVG and save
    sampled, route = sample_route(str(GPX_FILE), step_km=25.0)
    coords = route['geometry']['coordinates']
    lats = [lat for lon, lat in coords]
    lons = [lon for lon, lat in coords]
    index = StationIndex()
    index.load_for_bounds(min(lats), min(lons), max(lats), max(lons), margin_deg=1.0)
    if not index.stations:
        print("[test_generate_glyph] WARNING: no stations found")
        return
    lat, lon = sampled[0]
    res = find_nearest_station(lat, lon, index)
    if res is None:
        print("[test_generate_glyph] WARNING: nearest station not found")
        return
    station, _ = res
    df, meta = fetch_weather_data(station.id, month=5, day=15)
    stats = compute_weather_statistics(df)
    svg = generate_svg_glyph(stats)
    out = DEBUG_DIR / 'glyph_test.svg'
    out.write_text(svg, encoding='utf-8')
    print(f"[test_generate_glyph] saved={out} size={len(svg)}")


if __name__ == '__main__':
    # Run all tests independently
    test_load_gpx()
    test_sample_route()
    test_find_nearest_station()
    test_fetch_weather()
    test_compute_statistics()
    test_generate_glyph()
