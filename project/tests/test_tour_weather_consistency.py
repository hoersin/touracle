import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote

import pandas as pd
import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore
import weather  # type: ignore
import weather_openmeteo  # type: ignore


GPX_PATH = str(BASE_DIR / 'data' / '2026-02-13_2781422668_von Montpellier nach Bayonne.gpx')


def _parse_first_station_props(sse_text: str) -> dict:
    for block in sse_text.split('\n\n'):
        if not block.strip():
            continue
        event_type = None
        payload = None
        for line in block.split('\n'):
            if line.startswith('event:'):
                event_type = line.split(':', 1)[1].strip()
            elif line.startswith('data:'):
                payload = line.split(':', 1)[1].strip()
        if event_type != 'station' or not payload:
            continue
        msg = json.loads(payload)
        feature = msg.get('feature') or {}
        props = feature.get('properties') or {}
        if props:
            return props
    raise AssertionError('No station feature found in SSE stream')


def _fake_daily_window(lat, lon, start_month, start_day, span_days, years_window=10, start_year=None, end_year=None):
    assert start_year is not None
    assert end_year is not None
    rows = []
    for y in range(int(start_year), int(end_year) + 1):
        d0 = date(y, int(start_month), int(start_day))
        year_offset = (y - int(start_year)) * 10.0
        for i in range(int(span_days)):
            d = d0 + timedelta(days=i)
            rows.append(
                {
                    'date': pd.Timestamp(d),
                    'tavg': float(year_offset + (d.month * 0.5) + d.day + i),
                    'prcp': float((year_offset / 10.0) + (d.month * 0.25) + (d.day * 0.05) + i),
                    'wspd': float(18.0 + year_offset / 5.0 + i),
                    'wdir': float((90 + i * 15) % 360),
                }
            )
    df = pd.DataFrame(rows)
    df['_provider'] = 'test-provider'
    return df


def _fake_daily_same_day(lat, lon, month, day, years_window=10, start_year=None, end_year=None):
    assert start_year is not None
    assert end_year is not None
    rows = []
    for y in range(int(start_year), int(end_year) + 1):
        year_offset = (y - int(start_year)) * 10.0
        d = date(y, int(month), int(day))
        rows.append(
            {
                'date': pd.Timestamp(d),
                'tavg': float(year_offset + (d.month * 0.5) + d.day),
                'prcp': float((year_offset / 10.0) + (d.month * 0.25) + (d.day * 0.05)),
                'wspd': float(18.0 + year_offset / 5.0),
                'wdir': float(120.0),
            }
        )
    df = pd.DataFrame(rows)
    df['_provider'] = 'test-provider'
    return df


def _fake_hourly_same_day(lat, lon, month, day, years_window=10, start_year=None, end_year=None):
    assert start_year is not None
    assert end_year is not None
    rows = []
    for y in range(int(start_year), int(end_year) + 1):
        year_offset = (y - int(start_year)) * 5.0
        base = float(year_offset + month + (day / 10.0))
        for h, extra in zip((10, 12, 14, 16), (0.0, 2.0, 4.0, 6.0)):
            rows.append(
                {
                    'time': pd.Timestamp(y, int(month), int(day), h),
                    'temperature_2m': base + extra,
                }
            )
    df = pd.DataFrame(rows)
    df['_provider'] = 'test-provider'
    return df


@pytest.fixture
def isolated_backend(monkeypatch, tmp_path):
    stats_dir = tmp_path / 'stats'
    stats_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(backend_app, 'STATS_CACHE_DIR', stats_dir)
    monkeypatch.setattr(backend_app, '_get_offline_stats', lambda *args, **kwargs: None)
    monkeypatch.setattr(backend_app, '_get_offline_store', lambda *args, **kwargs: None)
    monkeypatch.setattr(backend_app, '_offline_strict_enabled', lambda: False)
    monkeypatch.setattr(backend_app, 'generate_glyph_v2', lambda stats, debug=False: '<svg/>')
    monkeypatch.setattr(backend_app, 'fetch_daily_weather_window', _fake_daily_window)
    monkeypatch.setattr(backend_app, 'fetch_daily_weather_same_day', _fake_daily_same_day)
    monkeypatch.setattr(backend_app, 'fetch_daily_weather', _fake_daily_same_day)
    monkeypatch.setattr(backend_app, 'fetch_hourly_weather_same_day', _fake_hourly_same_day)
    return stats_dir


def test_hourly_single_day_cache_respects_requested_year_span(monkeypatch, tmp_path):
    monkeypatch.setattr(weather_openmeteo, 'CACHE_DIR', tmp_path)
    tmp_path.mkdir(parents=True, exist_ok=True)

    def fake_get_weather(lat2, lon2, year, month, day, dry_run=False, kind='hourly'):
        assert kind == 'hourly'
        times = [f'{year}-{month:02d}-{day:02d}T10:00', f'{year}-{month:02d}-{day:02d}T12:00', f'{year}-{month:02d}-{day:02d}T14:00', f'{year}-{month:02d}-{day:02d}T16:00']
        base = (year - 2000) * 1.0
        temps = [base + 0.0, base + 2.0, base + 4.0, base + 6.0]
        return {'hourly': {'time': times, 'temperature_2m': temps}}

    monkeypatch.setattr(weather_openmeteo.WeatherService, 'get_weather', fake_get_weather)

    df_one_year = weather_openmeteo.fetch_hourly_weather_same_day(43.6, 3.9, 5, 10, start_year=2024, end_year=2024)
    assert len(df_one_year) == 4
    assert set(pd.to_datetime(df_one_year['time']).dt.year.unique()) == {2024}

    df_four_years = weather_openmeteo.fetch_hourly_weather_same_day(43.6, 3.9, 5, 10, start_year=2021, end_year=2024)
    assert len(df_four_years) == 16
    assert set(pd.to_datetime(df_four_years['time']).dt.year.unique()) == {2021, 2022, 2023, 2024}


def test_daytime_statistics_expose_historical_and_typical_day_ranges():
    df = pd.DataFrame(
        {
            'time': [
                pd.Timestamp(2021, 5, 10, 10), pd.Timestamp(2021, 5, 10, 12), pd.Timestamp(2021, 5, 10, 14), pd.Timestamp(2021, 5, 10, 16), pd.Timestamp(2021, 5, 10, 18),
                pd.Timestamp(2022, 5, 10, 10), pd.Timestamp(2022, 5, 10, 12), pd.Timestamp(2022, 5, 10, 14), pd.Timestamp(2022, 5, 10, 16), pd.Timestamp(2022, 5, 10, 18),
                pd.Timestamp(2023, 5, 10, 10), pd.Timestamp(2023, 5, 10, 12), pd.Timestamp(2023, 5, 10, 14), pd.Timestamp(2023, 5, 10, 16), pd.Timestamp(2023, 5, 10, 18),
            ],
            'temperature_2m': [12, 14, 15, 14, 12, 5, 6, 7, 6, 5, 16, 18, 20, 20, 18],
        }
    )

    stats, n = weather.compute_daytime_temperature_statistics(df, 5, 10)

    assert n == 3
    assert pytest.approx(stats['temp_hist_median'], rel=0, abs=1e-9) == 13.75
    assert pytest.approx(stats['temp_hist_min'], rel=0, abs=1e-9) == 6.0
    assert pytest.approx(stats['temp_hist_max'], rel=0, abs=1e-9) == 18.5
    assert pytest.approx(stats['temp_day_typical_min'], rel=0, abs=1e-9) == 12.0
    assert pytest.approx(stats['temp_day_typical_max'], rel=0, abs=1e-9) == 15.0


def test_map_stream_station_year_span_changes_stats(isolated_backend):
    client = backend_app.app.test_client()

    def get_first_props(hist_start: int, hist_years: int) -> dict:
        url = (
            '/api/map_stream?date=05-10'
            '&step_km=200&profile_step_km=50'
            '&tour_planning=1&mode=single_day'
            '&total_days=3&start_date=2025-05-10'
            f'&hist_years={hist_years}&hist_start={hist_start}'
            f'&gpx_path={quote(GPX_PATH)}'
        )
        resp = client.get(url)
        assert resp.status_code == 200
        return _parse_first_station_props(resp.data.decode('utf-8'))

    p1 = get_first_props(2024, 1)
    p4 = get_first_props(2021, 4)

    assert int(p1['_years_start']) == 2024
    assert int(p1['_years_end']) == 2024
    assert int(p4['_years_start']) == 2021
    assert int(p4['_years_end']) == 2024

    for props in (p1, p4):
        assert 'temp_hist_median' in props
        assert 'temp_hist_min' in props
        assert 'temp_hist_max' in props
        assert 'temp_day_typical_min' in props
        assert 'temp_day_typical_max' in props

    span1 = float(p1['temp_day_p75']) - float(p1['temp_day_p25'])
    span4 = float(p4['temp_day_p75']) - float(p4['temp_day_p25'])
    assert span4 > span1, f'Expected wider daytime spread for 4-year span, got {span1} vs {span4}'

    assert float(p4['temperature_c']) != float(p1['temperature_c'])
    assert float(p4['rain_typical_mm']) != float(p1['rain_typical_mm'])


def test_map_stream_station_date_changes_stats(isolated_backend):
    client = backend_app.app.test_client()

    def get_first_props(start_date_str: str, mmdd: str) -> dict:
        url = (
            f'/api/map_stream?date={mmdd}'
            '&step_km=200&profile_step_km=50'
            '&tour_planning=1&mode=single_day'
            f'&total_days=3&start_date={start_date_str}'
            '&hist_years=3&hist_start=2021'
            f'&gpx_path={quote(GPX_PATH)}'
        )
        resp = client.get(url)
        assert resp.status_code == 200
        return _parse_first_station_props(resp.data.decode('utf-8'))

    may = get_first_props('2025-05-10', '05-10')
    jun = get_first_props('2025-06-10', '06-10')

    assert may['date'] == '2025-05-10'
    assert jun['date'] == '2025-06-10'
    assert float(may['temperature_c']) != float(jun['temperature_c'])
    assert float(may['temp_day_p25']) != float(jun['temp_day_p25'])
    assert float(may['rain_typical_mm']) != float(jun['rain_typical_mm'])
