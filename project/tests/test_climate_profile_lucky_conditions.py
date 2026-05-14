import sys
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore


class _FakeStore:
    def __init__(self, stats_by_mmdd):
        self._stats_by_mmdd = dict(stats_by_mmdd)

    def get_stats_for_tile(self, tile_id, month, day):
        return self._stats_by_mmdd.get((int(month), int(day)))


def test_is_lucky_profile_day_accepts_values_within_thresholds():
    assert backend_app._is_lucky_profile_day(
        20.0,
        4.0,
        4.0,
        temp_cold=5.0,
        temp_hot=30.0,
        rain_max=4.0,
        wind_max=4.0,
    ) is True


@pytest.mark.parametrize(
    ('temp_c', 'rain_mm', 'wind_ms'),
    [
        (4.9, 0.0, 0.0),
        (30.1, 0.0, 0.0),
        (20.0, 4.1, 0.0),
        (20.0, 0.0, 4.1),
        (None, 0.0, 0.0),
        (20.0, None, 0.0),
        (20.0, 0.0, None),
    ],
)
def test_is_lucky_profile_day_rejects_each_failed_condition(temp_c, rain_mm, wind_ms):
    assert backend_app._is_lucky_profile_day(
        temp_c,
        rain_mm,
        wind_ms,
        temp_cold=5.0,
        temp_hot=30.0,
        rain_max=4.0,
        wind_max=4.0,
    ) is False


def test_weather_profile_lucky_follows_displayed_daily_aggregate(monkeypatch, tmp_path):
    data_dir = tmp_path / 'data'
    session_file = data_dir / 'session_state.json'
    data_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backend_app, 'DATA_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'UPLOAD_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'SESSION_FILE', session_file)
    monkeypatch.setattr(backend_app, 'SESSION_STORE', {})
    monkeypatch.setattr(backend_app, 'SESSION_STORE_LOADED', False)

    years = [2025, 2024, 2023, 2022, 2021]
    rain_by_year = {
        2025: 0.0,
        2024: 0.0,
        2023: 0.0,
        2022: 0.0,
        2021: 29.0,
    }

    def _resolve_store_for_year(year, point=None, bounds=None):
        year = int(year)
        return _FakeStore({
            (5, 16): {
                'temp_day_median': 20.0,
                'temp_day_p25': 18.0,
                'temp_day_p75': 22.0,
                'temperature_c': 20.0,
                'temp_hist_p25': 18.0,
                'temp_hist_p75': 22.0,
                'precipitation_mm': rain_by_year[year],
                'rain_typical_mm': rain_by_year[year],
                'wind_speed_ms': 2.0,
                'wind_dir_deg': 120.0,
            }
        })

    monkeypatch.setattr(backend_app, '_resolve_offline_store_for_year', _resolve_store_for_year)
    monkeypatch.setattr(backend_app, '_tile_id_for_point_or_edge', lambda store, lat, lon: 'r0_c0')
    monkeypatch.setattr(backend_app, '_lookup_tile_center', lambda store, tile_id: (48.12, 11.58))
    monkeypatch.setattr(
        backend_app,
        '_reverse_geocode_location',
        lambda lat, lon, **kwargs: {'label': 'Munich (DE)'},
    )

    client = backend_app.app.test_client()
    response = client.get(
        '/api/weather_profile',
        query_string={
            'lat': '48.12',
            'lon': '11.58',
            'years': ','.join(str(year) for year in years),
            'mode': 'active',
            'start_date': '2026-05-16',
            'end_date': '2026-05-16',
            'lucky_temp_cold': '5',
            'lucky_temp_hot': '30',
            'lucky_rain_max': '4',
            'lucky_wind_max': '4',
        },
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload['meta']['years'] == years
    assert payload['series'][0]['date'].endswith('05-16')
    assert payload['series'][0]['rain'] == pytest.approx(5.8)
    assert payload['series'][0]['temp'] == pytest.approx(20.0)
    assert payload['series'][0]['wind_speed'] == pytest.approx(2.0)
    assert payload['series'][0]['lucky'] is False
    assert payload['summary']['lucky_days'] == 0


def test_weather_profile_uses_offline_reverse_geocode_only(monkeypatch, tmp_path):
    data_dir = tmp_path / 'data'
    session_file = data_dir / 'session_state.json'
    data_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backend_app, 'DATA_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'UPLOAD_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'SESSION_FILE', session_file)
    monkeypatch.setattr(backend_app, 'SESSION_STORE', {})
    monkeypatch.setattr(backend_app, 'SESSION_STORE_LOADED', False)

    monkeypatch.setattr(
        backend_app,
        '_resolve_offline_store_for_year',
        lambda year, point=None, bounds=None: _FakeStore({
            (5, 16): {
                'temp_day_median': 20.0,
                'temp_day_p25': 18.0,
                'temp_day_p75': 22.0,
                'temperature_c': 20.0,
                'temp_hist_p25': 18.0,
                'temp_hist_p75': 22.0,
                'precipitation_mm': 1.5,
                'rain_typical_mm': 1.5,
                'wind_speed_ms': 2.0,
                'wind_dir_deg': 120.0,
            }
        }),
    )
    monkeypatch.setattr(backend_app, '_tile_id_for_point_or_edge', lambda store, lat, lon: 'r0_c0')
    monkeypatch.setattr(backend_app, '_lookup_tile_center', lambda store, tile_id: (48.12, 11.58))
    monkeypatch.setattr(
        backend_app,
        '_reverse_offline_fallback',
        lambda lat, lon: {'name': 'Munich', 'country': 'DE', 'label': 'Munich (DE)'},
    )

    def _unexpected_requests_get(*args, **kwargs):
        raise AssertionError('weather_profile should not call online reverse geocoding')

    monkeypatch.setattr(backend_app.requests, 'get', _unexpected_requests_get)

    client = backend_app.app.test_client()
    response = client.get(
        '/api/weather_profile',
        query_string={
            'lat': '48.12',
            'lon': '11.58',
            'years': '2025,2024',
            'mode': 'active',
            'start_date': '2026-05-16',
            'end_date': '2026-05-18',
        },
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload['meta']['location'] == 'Munich (DE)'
    assert payload['meta']['location_name'] == 'Munich'
    assert payload['meta']['location_country'] == 'DE'


def test_weather_profile_updates_progress_job(monkeypatch, tmp_path):
    data_dir = tmp_path / 'data'
    session_file = data_dir / 'session_state.json'
    data_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backend_app, 'DATA_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'UPLOAD_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'SESSION_FILE', session_file)
    monkeypatch.setattr(backend_app, 'SESSION_STORE', {})
    monkeypatch.setattr(backend_app, 'SESSION_STORE_LOADED', False)

    session_id = 'test-session-progress-1234'
    monkeypatch.setattr(backend_app, '_resolve_request_session_id', lambda create=True: session_id)

    daily_stats = {
        (5, 16): {
            'temp_day_median': 20.0,
            'temp_day_p25': 18.0,
            'temp_day_p75': 22.0,
            'precipitation_mm': 1.0,
            'wind_speed_ms': 2.0,
            'wind_dir_deg': 120.0,
        },
        (5, 17): {
            'temp_day_median': 19.0,
            'temp_day_p25': 17.0,
            'temp_day_p75': 21.0,
            'precipitation_mm': 0.5,
            'wind_speed_ms': 1.5,
            'wind_dir_deg': 125.0,
        },
    }

    monkeypatch.setattr(
        backend_app,
        '_resolve_offline_store_for_year',
        lambda year, point=None, bounds=None: _FakeStore(daily_stats),
    )
    monkeypatch.setattr(backend_app, '_tile_id_for_point_or_edge', lambda store, lat, lon: 'r0_c0')
    monkeypatch.setattr(backend_app, '_lookup_tile_center', lambda store, tile_id: (48.12, 11.58))
    monkeypatch.setattr(
        backend_app,
        '_reverse_geocode_location',
        lambda lat, lon, **kwargs: {'label': 'Munich (DE)'},
    )

    client = backend_app.app.test_client()
    job_id = 'climate-progress-job'
    response = client.get(
        '/api/weather_profile',
        query_string={
            'lat': '48.12',
            'lon': '11.58',
            'years': '2025,2024',
            'mode': 'active',
            'start_date': '2026-05-16',
            'end_date': '2026-05-17',
            'job_id': job_id,
        },
    )

    assert response.status_code == 200
    progress = backend_app._get_progress(job_id, session_id=session_id)
    assert progress['known'] is True
    assert progress['done'] is True
    assert progress['total'] == 4
    assert progress['completed'] == 4