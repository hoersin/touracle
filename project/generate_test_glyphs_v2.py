"""Generate v2 temperature-focused test glyphs.
Run: python project/generate_test_glyphs_v2.py
"""
from pathlib import Path
from backend.glyph_geometry import generate_glyph_v2


def save_svg(name: str, svg: str, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.svg").write_text(svg, encoding="utf-8")


def main() -> None:
    out = Path(__file__).resolve().parents[1] / "project" / "debug_output" / "test_glyphs_v2"
    cases = [
        ("cold_range", {
            "temp_p25": -5.0,
            "temp_p75": 5.0,
            "temperature_c": 0.0,
            "precipitation_mm": 0.0,
            "wind_dir_deg": 30.0,
        }),
        ("warm_range", {
            "temp_p25": 18.0,
            "temp_p75": 28.0,
            "temperature_c": 23.0,
            "precipitation_mm": 1.0,
            "wind_dir_deg": 180.0,
        }),
        ("wide_variance", {
            "temp_p25": -5.0,
            "temp_p75": 25.0,
            "temperature_c": 10.0,
            "precipitation_mm": 10.0,
            "wind_dir_deg": 300.0,
        }),
        ("hot_stable", {
            "temp_p25": 30.0,
            "temp_p75": 34.0,
            "temperature_c": 32.0,
            "precipitation_mm": 0.0,
            "wind_dir_deg": 90.0,
        }),
    ]

    for name, stats in cases:
        svg = generate_glyph_v2(stats, debug=True)
        save_svg(name, svg, out)

    print(f"Generated {len(cases)} glyphs to {out}")


if __name__ == "__main__":
    main()
