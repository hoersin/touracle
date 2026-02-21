"""Generate test SVGs for advanced wind glyphs.
Cases:
1. 0.5 m/s (calm)
2. 3.5 m/s (light)
3. 7.5 m/s (moderate)
4. 12.0 m/s (strong)
5. 18.0 m/s (very strong — warning)
6. 25.0 m/s (extreme — warning)
"""
from pathlib import Path
from backend.glyph_wind import render_wind, CENTER_X, CENTER_Y

OUT_DIR = Path(__file__).resolve().parents[1] / 'debug_output' / 'test_wind_glyphs'
OUT_DIR.mkdir(parents=True, exist_ok=True)

CASES = [0.5, 3.5, 7.5, 12.0, 18.0, 25.0]
MEDIAN_DIR = 135.0  # SE, arbitrary fixed for tests
VAR_STD = 30.0

SVG_HEADER = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
BG = f'<circle cx="{CENTER_X}" cy="{CENTER_Y}" r="30" fill="#fff" stroke="#ddd"/>'

for idx, speed in enumerate(CASES, start=1):
    svg, warn, bf = render_wind(MEDIAN_DIR, speed, VAR_STD, gust_max_ms=20.0 if speed>=20.0 else None)
    content = SVG_HEADER + BG + svg + '</svg>'
    (OUT_DIR / f'wind_case_{idx}.svg').write_text(content)
