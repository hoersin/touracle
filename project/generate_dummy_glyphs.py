#!/usr/bin/env python3
"""Generate dummy SVG weather glyphs without server/API dependencies.
Writes an HTML gallery to project/debug_output/glyphs_dummy.html.
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / 'backend'
sys.path.insert(0, str(BACKEND))

from glyph_geometry import (
    SIZE,
    draw_temperature_reference_ring,
    draw_temperature_range,
    draw_temperature_median,
    draw_precipitation,
    draw_wind_arrow,
    draw_variability_sector,
)


def compose_svg(stats: dict) -> str:
    temp_med = float(stats.get('temperature_c', 15.0))
    t25 = float(stats.get('temp_p25', temp_med - 2.0))
    t75 = float(stats.get('temp_p75', temp_med + 2.0))
    prcp = float(stats.get('precipitation_mm', 0.0))
    wdir = float(stats.get('wind_dir_deg', 0.0))
    wvar = float(stats.get('wind_var_deg', 0.0))

    ref = draw_temperature_reference_ring(alpha=0.30)
    rng = draw_temperature_range(t25, t75, alpha=0.95)
    med = draw_temperature_median(temp_med)
    precip = draw_precipitation(prcp, add_wave=True)
    arrow = draw_wind_arrow(wdir)
    sector = draw_variability_sector(wdir, wvar)

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">' \
        f'{ref}{precip}{rng}{med}{sector}{arrow}' \
        f'</svg>'
    )


def main() -> None:
    samples = [
        {
            'name': 'Cold',
            'temperature_c': -10.0,
            'temp_p25': -12.0,
            'temp_p75': -8.0,
            'precipitation_mm': 0.2,
            'wind_dir_deg': 45.0,
            'wind_var_deg': 10.0,
        },
        {
            'name': 'Cool',
            'temperature_c': 5.0,
            'temp_p25': 2.0,
            'temp_p75': 8.0,
            'precipitation_mm': 2.0,
            'wind_dir_deg': 90.0,
            'wind_var_deg': 20.0,
        },
        {
            'name': 'Mild',
            'temperature_c': 15.0,
            'temp_p25': 12.0,
            'temp_p75': 18.0,
            'precipitation_mm': 6.0,
            'wind_dir_deg': 180.0,
            'wind_var_deg': 30.0,
        },
        {
            'name': 'Warm',
            'temperature_c': 25.0,
            'temp_p25': 22.0,
            'temp_p75': 28.0,
            'precipitation_mm': 12.0,
            'wind_dir_deg': 225.0,
            'wind_var_deg': 40.0,
        },
        {
            'name': 'Hot',
            'temperature_c': 35.0,
            'temp_p25': 33.0,
            'temp_p75': 38.0,
            'precipitation_mm': 25.0,
            'wind_dir_deg': 300.0,
            'wind_var_deg': 60.0,
        },
    ]

    out_dir = ROOT / 'debug_output'
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / 'glyphs_dummy.html'

    rows = []
    for s in samples:
        svg = compose_svg(s)
        # write individual SVG per sample
        slug = str(s['name']).lower().replace(' ', '_')
        svg_file = out_dir / f"glyph_dummy_{slug}.svg"
        svg_file.write_text(svg, encoding='utf-8')
        cap = (
            f"{s['name']} — T={s['temperature_c']}°C, "
            f"P25..P75={s['temp_p25']}..{s['temp_p75']}°C, "
            f"Rain={s['precipitation_mm']} mm, "
            f"Wind={s['wind_dir_deg']}°, Var={s['wind_var_deg']}°"
        )
        rows.append(f'<div class="item"><div class="svg">{svg}</div><div class="caption">{cap}</div></div>')

    html = f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Dummy Weather Glyphs</title>
<style>
body {{ font-family: -apple-system, system-ui, sans-serif; margin: 20px; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 16px; }}
.item {{ display:flex; flex-direction:column; align-items:center; border: 1px solid #eee; padding: 8px; border-radius: 8px; }}
.svg {{ width: 64px; height: 64px; }}
.caption {{ margin-top: 6px; font-size: 12px; color: #555; text-align: center; }}
</style>
</head>
<body>
<h1>Dummy Weather Glyphs</h1>
<div class="grid">
{''.join(rows)}
</div>
</body>
</html>"""

    out_file.write_text(html, encoding='utf-8')
    print(f"Wrote {out_file}")
    print("Also wrote individual SVGs:")
    for s in samples:
        slug = str(s['name']).lower().replace(' ', '_')
        svg_file = out_dir / f"glyph_dummy_{slug}.svg"
        print(f" - {svg_file}")


if __name__ == '__main__':
    main()
