import sys
import json
from pathlib import Path
import argparse
import cairosvg

# Ensure backend modules are importable
BASE = Path(__file__).resolve().parent
BACKEND = BASE / 'backend'
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from route_sampling import sample_route
from weather_openmeteo import fetch_daily_weather
from weather import compute_weather_statistics
from glyph import generate_svg_glyph

DATA_DIR = BASE / 'data'
DEFAULT_GPX = DATA_DIR / '2026-02-13_2781422668_von Montpellier nach Bayonne.gpx'
DEBUG_DIR = BASE / 'debug_output'
GLYPHS_DIR = DEBUG_DIR / 'glyphs'
DEBUG_DIR.mkdir(exist_ok=True)
GLYPHS_DIR.mkdir(exist_ok=True)


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
    parser.add_argument('--samples', type=int, default=5)
    parser.add_argument('--gpx', type=str, default=str(DEFAULT_GPX))
    args = parser.parse_args()
    main(month=args.month, day=args.day, sample_count=args.samples, gpx_path=Path(args.gpx))
