"""Generate four test weather glyphs using backend.glyph_geometry.
Run: python project/generate_test_glyphs.py
"""
from pathlib import Path
from backend.glyph_geometry import generate_glyph


def save_svg(name: str, svg: str, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.svg").write_text(svg, encoding="utf-8")


def main() -> None:
    out = Path(__file__).resolve().parents[1] / "project" / "debug_output" / "test_glyphs"
    cases = [
        ("cold_dry_calm", {
            "temperature_c": 5.0,
            "precipitation_mm": 0.0,
            "wind_speed_ms": 0.0,
            "wind_dir_deg": 0.0,
            "wind_var_deg": 10.0,
        }),
        ("hot_dry_windy", {
            "temperature_c": 30.0,
            "precipitation_mm": 0.0,
            "wind_speed_ms": 15.0,
            "wind_dir_deg": 270.0,
            "wind_var_deg": 20.0,
        }),
        ("moderate_rain", {
            "temperature_c": 18.0,
            "precipitation_mm": 10.0,
            "wind_speed_ms": 5.0,
            "wind_dir_deg": 180.0,
            "wind_var_deg": 40.0,
        }),
        ("variable_wind", {
            "temperature_c": 15.0,
            "precipitation_mm": 2.0,
            "wind_speed_ms": 6.0,
            "wind_dir_deg": 120.0,
            "wind_var_deg": 90.0,
        }),
    ]

    for name, stats in cases:
        svg = generate_glyph(stats, debug=True)
        save_svg(name, svg, out)

    print(f"Generated {len(cases)} glyphs to {out}")


if __name__ == "__main__":
    main()
