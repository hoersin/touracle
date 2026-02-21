"""Generate 10 SVGs for centered wind arrows per new spec.
Arrow total length = 1.2×temp outer diameter; hollow black shaft; colored head; barbs at tail.
Includes parameter annotation in each SVG.
"""
from pathlib import Path
from backend.glyph_wind import render_wind, CENTER_X, CENTER_Y
from backend.glyph_geometry import TEMP_RADIUS_OUTER

OUT_DIR = Path(__file__).resolve().parents[1] / 'debug_output' / 'test_wind_glyphs_centered'
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Ten cases with varying speed/direction
CASES = [
    {'speed': 0.5, 'dir': 0,   'var': 10},
    {'speed': 2.0, 'dir': 30,  'var': 15},
    {'speed': 3.5, 'dir': 60,  'var': 20},
    {'speed': 5.0, 'dir': 90,  'var': 25},
    {'speed': 7.5, 'dir': 120, 'var': 30},
    {'speed': 10.0,'dir': 150, 'var': 35},
    {'speed': 12.0,'dir': 180, 'var': 40},
    {'speed': 15.0,'dir': 210, 'var': 45},
    {'speed': 18.0,'dir': 240, 'var': 50},
    {'speed': 22.0,'dir': 300, 'var': 60},
]

SVG_HEADER = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
BG = f'<circle cx="{CENTER_X}" cy="{CENTER_Y}" r="30" fill="#fff" stroke="#ddd"/>'

for idx, case in enumerate(CASES, start=1):
    speed = case['speed']
    dir_deg = case['dir']
    var = case['var']
    svg, warn, bf = render_wind(dir_deg, speed, var, gust_max_ms=20.0 if speed>=20.0 else None, temp_outer_radius=TEMP_RADIUS_OUTER)
    label = f"speed={speed:.1f} m/s (Bft {bf}), dir={dir_deg}°, std={var}°"
    text = f"<text x=\"{CENTER_X}\" y=\"{CENTER_Y+28}\" font-size=\"6\" text-anchor=\"middle\" fill=\"#333\">{label}</text>"
    content = SVG_HEADER + BG + svg + text + '</svg>'
    (OUT_DIR / f'wind_centered_{idx}.svg').write_text(content)
