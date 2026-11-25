from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
APP_PY = BASE_DIR / "backend" / "app.py"


def test_weather_profile_payload_includes_monthly_climate_series():
    source = APP_PY.read_text(encoding="utf-8")
    assert '"monthly": {' in source
    assert '"temp_mean_c": monthly_temp_means' in source
    assert '"rain_total_mm": monthly_rain_totals' in source
    assert '"month_labels": [\'Jan\'' in source
