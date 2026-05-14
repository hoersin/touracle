import io
import json
import sys
import threading
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore


REALISTIC_ROUTE_DIR = BASE_DIR / 'data' / 'realistic_routes'


def _route_payloads(sse_text: str, event_name: str) -> list[dict]:
    marker = f'event: {event_name}\ndata: '
    payloads = []
    start = 0
    while True:
        idx = sse_text.find(marker, start)
        if idx == -1:
            return payloads
        idx += len(marker)
        end = sse_text.find('\n\n', idx)
        if end == -1:
            end = len(sse_text)
        payloads.append(json.loads(sse_text[idx:end]))
        start = end + 2


@pytest.fixture
def realistic_offline_backend(monkeypatch, tmp_path):
    data_dir = tmp_path / 'data'
    session_file = data_dir / 'session_state.json'
    data_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backend_app, 'DATA_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'UPLOAD_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'SESSION_FILE', session_file)
    monkeypatch.setattr(backend_app, 'SESSION_STORE', {})
    monkeypatch.setattr(backend_app, 'SESSION_STORE_LOADED', False)
    monkeypatch.setattr(backend_app, 'STATS_CACHE_DIR', tmp_path / 'stats')
    backend_app.STATS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(backend_app, '_OFFLINE_STORE', None)
    monkeypatch.setattr(backend_app, '_OFFLINE_STORE_TRIED', False)
    monkeypatch.setattr(backend_app, '_OFFLINE_STORES_BY_YEAR', {})
    monkeypatch.setattr(backend_app, '_OFFLINE_STORES_BY_PATH', {})
    return [backend_app.app.test_client() for _ in range(2)]


def test_get_offline_store_initialization_is_thread_safe(monkeypatch):
    calls = []
    init_entered = threading.Event()
    release_init = threading.Event()
    store = object()

    def fake_default_from_env():
        calls.append('called')
        init_entered.set()
        assert release_init.wait(timeout=1.0)
        return store

    fake_cls = SimpleNamespace(default_from_env=staticmethod(fake_default_from_env))

    monkeypatch.setattr(backend_app, 'OfflineWeatherStore', fake_cls)
    monkeypatch.setattr(backend_app, '_OFFLINE_STORE', None)
    monkeypatch.setattr(backend_app, '_OFFLINE_STORE_TRIED', False)

    results = [None] * 6

    def worker(index: int):
        results[index] = backend_app._get_offline_store()

    threads = [threading.Thread(target=worker, args=(index,), name=f'offline-store-{index}') for index in range(len(results))]
    for thread in threads:
        thread.start()

    assert init_entered.wait(timeout=1.0)
    release_init.set()

    for thread in threads:
        thread.join(timeout=1.0)
        assert not thread.is_alive(), f'{thread.name} did not finish'

    assert calls == ['called']
    assert all(result is store for result in results)


def test_get_offline_stats_prefers_requested_exact_year_store(monkeypatch):
    class FakeStore:
        def __init__(self, year: int):
            self.cfg = SimpleNamespace(years=(year, year), bbox=(34.0, 72.0, -28.0, 33.0))
            self.year = year

        def get_stats(self, lat: float, lon: float, month: int, day: int):
            return {
                '_offline': True,
                '_provider': 'openmeteo',
                'temperature_c': float(self.year),
                'rain_probability': 1.0,
            }

    default_store = FakeStore(2025)
    year_2024_store = FakeStore(2024)

    monkeypatch.setattr(backend_app, '_get_offline_store', lambda: default_store)
    monkeypatch.setattr(
        backend_app,
        '_resolve_offline_store_for_year',
        lambda year, point=None, bounds=None: year_2024_store if int(year) == 2024 else default_store,
    )

    stats = backend_app._get_offline_stats(45.0, 10.0, 5, 12, start_year=2024, end_year=2024)

    assert stats is not None
    assert stats['_years_start'] == 2024
    assert stats['_years_end'] == 2024
    assert stats['temperature_c'] == pytest.approx(2024.0)
    assert stats['rain_probability'] == pytest.approx(1.0)


def test_get_offline_stats_offline_only_aggregates_available_requested_years(monkeypatch):
    class FakeStore:
        def __init__(self, year: int):
            self.cfg = SimpleNamespace(years=(year, year), bbox=(34.0, 72.0, -28.0, 33.0))
            self.year = year

        def get_stats(self, lat: float, lon: float, month: int, day: int):
            return {
                '_offline': True,
                '_provider': 'openmeteo',
                'temperature_c': float(self.year),
                'temp_day_median': float(self.year),
                'precipitation_mm': 1.0,
                'rain_probability': 1.0 if self.year == 2025 else 0.0,
                'rain_typical_mm': 1.0,
                '_match_days': 1,
                '_samples_rain': 1,
            }

    default_store = FakeStore(2025)
    stores = {2024: FakeStore(2024), 2025: FakeStore(2025)}

    monkeypatch.setattr(backend_app, '_get_offline_store', lambda: default_store)
    monkeypatch.setattr(
        backend_app,
        '_resolve_offline_store_for_year',
        lambda year, point=None, bounds=None: stores.get(int(year)),
    )

    stats = backend_app._get_offline_stats(
        45.0,
        10.0,
        5,
        12,
        start_year=2024,
        end_year=2025,
        allow_span_mismatch=True,
    )

    assert stats is not None
    assert stats['_years_start'] == 2024
    assert stats['_years_end'] == 2025
    assert stats['temperature_c'] == pytest.approx(2024.5)
    assert stats['rain_probability'] == pytest.approx(0.5)


def test_get_offline_stats_noncontiguous_requested_years_use_all_available_selected_years(monkeypatch):
    class FakeStore:
        def __init__(self, year: int):
            self.cfg = SimpleNamespace(years=(year, year), bbox=(34.0, 72.0, -28.0, 33.0))
            self.year = year

        def get_stats(self, lat: float, lon: float, month: int, day: int):
            return {
                '_offline': True,
                '_provider': 'openmeteo',
                'temperature_c': float(self.year),
                'temp_day_median': float(self.year),
                'precipitation_mm': 2.0 if self.year == 2025 else 0.0,
                'rain_probability': 1.0 if self.year == 2025 else 0.0,
                'rain_typical_mm': 2.0 if self.year == 2025 else 0.0,
                '_match_days': 1,
                '_samples_rain': 1,
            }

    default_store = FakeStore(2025)
    stores = {2021: FakeStore(2021), 2024: FakeStore(2024), 2025: FakeStore(2025)}

    monkeypatch.setattr(backend_app, '_get_offline_store', lambda: default_store)
    monkeypatch.setattr(
        backend_app,
        '_resolve_offline_store_for_year',
        lambda year, point=None, bounds=None: stores.get(int(year)),
    )

    stats = backend_app._get_offline_stats(
        45.0,
        10.0,
        5,
        12,
        years_selected=[2025, 2024, 2023, 2021],
        allow_span_mismatch=True,
    )

    assert stats is not None
    assert stats['_years_start'] == 2021
    assert stats['_years_end'] == 2025
    assert stats['_years_used'] == [2025, 2024, 2021]
    assert stats['temperature_c'] == pytest.approx(2024.0)
    assert stats['rain_probability'] == pytest.approx(1.0 / 3.0)


def test_get_offline_stats_explicit_year_list_skips_missing_tile_year(monkeypatch):
    class FakeStore:
        def __init__(self, year: int, *, missing_points: set[tuple[float, float]] | None = None):
            self.cfg = SimpleNamespace(years=(year, year), bbox=(34.0, 72.0, -28.0, 33.0))
            self.year = year
            self.missing_points = missing_points or set()

        def get_stats(self, lat: float, lon: float, month: int, day: int):
            point = (round(float(lat), 4), round(float(lon), 4))
            if point in self.missing_points:
                return None
            return {'_offline': True, '_provider': 'openmeteo', 'temperature_c': float(self.year)}

    missing_point = (45.0, 10.0)
    default_store = FakeStore(2025, missing_points={missing_point})
    stores = {
        2025: default_store,
        2023: FakeStore(2023),
    }

    monkeypatch.setattr(backend_app, '_get_offline_store', lambda: default_store)
    monkeypatch.setattr(
        backend_app,
        '_resolve_offline_store_for_year',
        lambda year, point=None, bounds=None: stores.get(int(year)),
    )

    stats = backend_app._get_offline_stats(
        45.0,
        10.0,
        5,
        12,
        years_selected=[2025, 2023, 2021],
        allow_span_mismatch=True,
    )

    assert stats is not None
    assert stats['_years_start'] == 2023
    assert stats['_years_end'] == 2023
    assert stats['temperature_c'] == pytest.approx(2023.0)


def test_get_offline_stats_explicit_year_list_falls_back_to_newest_available_default_store(monkeypatch):
    class FakeStore:
        def __init__(self, year: int):
            self.cfg = SimpleNamespace(years=(year, year), bbox=(34.0, 72.0, -28.0, 33.0))
            self.year = year

        def get_stats(self, lat: float, lon: float, month: int, day: int):
            return {'_offline': True, '_provider': 'openmeteo', 'temperature_c': float(self.year)}

    default_store = FakeStore(2025)

    monkeypatch.setattr(backend_app, '_get_offline_store', lambda: default_store)
    monkeypatch.setattr(
        backend_app,
        '_resolve_offline_store_for_year',
        lambda year, point=None, bounds=None: None,
    )

    stats = backend_app._get_offline_stats(
        45.0,
        10.0,
        5,
        12,
        years_selected=[2021],
        allow_span_mismatch=True,
    )

    assert stats is not None
    assert stats['_years_start'] == 2025
    assert stats['_years_end'] == 2025
    assert stats['temperature_c'] == pytest.approx(2025.0)


def test_get_offline_stats_explicit_year_list_falls_back_to_default_when_selected_tile_missing(monkeypatch):
    class FakeStore:
        def __init__(self, year: int, *, missing_points: set[tuple[float, float]] | None = None):
            self.cfg = SimpleNamespace(years=(year, year), bbox=(34.0, 72.0, -28.0, 33.0))
            self.year = year
            self.missing_points = missing_points or set()

        def get_stats(self, lat: float, lon: float, month: int, day: int):
            point = (round(float(lat), 4), round(float(lon), 4))
            if point in self.missing_points:
                return None
            return {'_offline': True, '_provider': 'openmeteo', 'temperature_c': float(self.year)}

    missing_point = (45.0, 10.0)
    default_store = FakeStore(2025)
    stores = {
        2023: FakeStore(2023, missing_points={missing_point}),
    }

    monkeypatch.setattr(backend_app, '_get_offline_store', lambda: default_store)
    monkeypatch.setattr(
        backend_app,
        '_resolve_offline_store_for_year',
        lambda year, point=None, bounds=None: stores.get(int(year)),
    )

    stats = backend_app._get_offline_stats(
        45.0,
        10.0,
        5,
        12,
        years_selected=[2023, 2021],
        allow_span_mismatch=True,
    )

    assert stats is not None
    assert stats['_years_start'] == 2025
    assert stats['_years_end'] == 2025
    assert stats['temperature_c'] == pytest.approx(2025.0)


def test_realistic_route_respects_requested_offline_year_span(realistic_offline_backend):
    route_path = REALISTIC_ROUTE_DIR / 'real_route_2_milano_rome.gpx'
    if not route_path.exists():
        pytest.skip('missing routed GPX fixture: real_route_2_milano_rome.gpx')

    client = realistic_offline_backend[0]
    client.get('/api/session')
    upload_resp = client.post(
        '/api/upload_gpx',
        data={'file': (io.BytesIO(route_path.read_bytes()), route_path.name)},
        content_type='multipart/form-data',
    )
    assert upload_resp.status_code == 200
    upload_payload = upload_resp.get_json()

    response = client.get(
        '/api/map_stream',
        query_string={
            'date': '05-12',
            'tour_planning': '1',
            'mode': 'single_day',
            'start_date': '2026-05-12',
            'total_days': '8',
            'gpx_path': upload_payload['path'],
            'step_km': '25',
            'profile_step_km': '8',
            'reuse_per_day': '1',
            'offline_only': '1',
            'hist_years': '1',
            'hist_start': '2024',
        },
    )
    assert response.status_code == 200

    sse_text = response.data.decode('utf-8')
    assert 'event: error' not in sse_text
    station_payloads = _route_payloads(sse_text, 'station')
    feature_payloads = [payload['feature'] for payload in station_payloads if 'feature' in payload]
    assert feature_payloads
    assert {feature['properties'].get('_years_start') for feature in feature_payloads} == {2024}
    assert {feature['properties'].get('_years_end') for feature in feature_payloads} == {2024}
    assert {str(feature['properties'].get('_source_mode')) for feature in feature_payloads} == {'tour_planning_offline'}


def test_realistic_route_incomplete_offline_year_span_stays_stable(realistic_offline_backend):
    route_path = REALISTIC_ROUTE_DIR / 'real_route_3_vienna_berlin.gpx'
    if not route_path.exists():
        pytest.skip('missing routed GPX fixture: real_route_3_vienna_berlin.gpx')

    client = realistic_offline_backend[0]
    client.get('/api/session')
    upload_resp = client.post(
        '/api/upload_gpx',
        data={'file': (io.BytesIO(route_path.read_bytes()), route_path.name)},
        content_type='multipart/form-data',
    )
    assert upload_resp.status_code == 200
    upload_payload = upload_resp.get_json()

    response = client.get(
        '/api/map_stream',
        query_string={
            'date': '05-12',
            'tour_planning': '1',
            'mode': 'single_day',
            'start_date': '2026-05-12',
            'total_days': '9',
            'gpx_path': upload_payload['path'],
            'step_km': '25',
            'profile_step_km': '8',
            'reuse_per_day': '1',
            'offline_only': '1',
            'hist_years': '2',
            'hist_start': '2024',
        },
    )
    assert response.status_code == 200

    sse_text = response.data.decode('utf-8')
    assert 'event: error' not in sse_text
    station_payloads = _route_payloads(sse_text, 'station')
    feature_payloads = [payload['feature'] for payload in station_payloads if 'feature' in payload]
    assert feature_payloads
    assert {feature['properties'].get('_years_start') for feature in feature_payloads} == {2024}
    assert {feature['properties'].get('_years_end') for feature in feature_payloads} == {2025}
    assert all(bool(feature['properties'].get('_offline')) for feature in feature_payloads)


def test_realistic_route_force_online_bypasses_offline_tiles(realistic_offline_backend, monkeypatch):
    route_path = REALISTIC_ROUTE_DIR / 'real_route_2_milano_rome.gpx'
    if not route_path.exists():
        pytest.skip('missing routed GPX fixture: real_route_2_milano_rome.gpx')

    offline_calls: list[tuple[float, float, int, int]] = []

    def fake_offline_stats(lat, lon, month, day, **kwargs):
        offline_calls.append((float(lat), float(lon), int(month), int(day)))
        return {
            '_offline': True,
            '_provider': 'offline-test',
            '_years_start': 2025,
            '_years_end': 2025,
            'temperature_c': 7.0,
            'temp_p25': 6.0,
            'temp_p75': 8.0,
            'precipitation_mm': 0.0,
            'wind_dir_deg': 180.0,
            'wind_speed_ms': 2.0,
            'wind_var_deg': 10.0,
        }

    def fake_daily_same_day(lat, lon, month, day, years_window=10, start_year=None, end_year=None):
        rows = []
        for year in range(int(start_year), int(end_year) + 1):
            rows.append(
                {
                    'date': pd.Timestamp(date(year, int(month), int(day))),
                    'tavg': 21.0,
                    'prcp': 1.5,
                    'wspd': 5.0,
                    'wdir': 95.0,
                }
            )
        df = pd.DataFrame(rows)
        df['_provider'] = 'test-openmeteo'
        return df

    def fake_hourly_same_day(lat, lon, month, day, years_window=10, start_year=None, end_year=None):
        rows = []
        for year in range(int(start_year), int(end_year) + 1):
            for hour, temp in ((10, 18.0), (12, 20.0), (14, 22.0), (16, 21.0)):
                rows.append(
                    {
                        'time': pd.Timestamp(year, int(month), int(day), hour),
                        'temperature_2m': temp,
                    }
                )
        df = pd.DataFrame(rows)
        df['_provider'] = 'test-openmeteo'
        return df

    monkeypatch.setattr(backend_app, '_get_offline_stats', fake_offline_stats)
    monkeypatch.setattr(backend_app, 'fetch_daily_weather_same_day', fake_daily_same_day)
    monkeypatch.setattr(backend_app, 'fetch_daily_weather', fake_daily_same_day)
    monkeypatch.setattr(backend_app, 'fetch_hourly_weather_same_day', fake_hourly_same_day)

    client = realistic_offline_backend[0]
    client.get('/api/session')
    upload_resp = client.post(
        '/api/upload_gpx',
        data={'file': (io.BytesIO(route_path.read_bytes()), route_path.name)},
        content_type='multipart/form-data',
    )
    assert upload_resp.status_code == 200
    upload_payload = upload_resp.get_json()

    response = client.get(
        '/api/map_stream',
        query_string={
            'date': '05-12',
            'tour_planning': '1',
            'mode': 'single_day',
            'start_date': '2026-05-12',
            'total_days': '5',
            'gpx_path': upload_payload['path'],
            'step_km': '80',
            'profile_step_km': '8',
            'reuse_per_day': '1',
            'force_online': '1',
            'hist_years': '1',
            'hist_start': '2025',
        },
    )
    assert response.status_code == 200

    sse_text = response.data.decode('utf-8')
    assert 'event: error' not in sse_text
    station_payloads = _route_payloads(sse_text, 'station')
    feature_payloads = [payload['feature'] for payload in station_payloads if 'feature' in payload]
    assert feature_payloads
    assert all(feature['properties'].get('_source_mode') == 'tour_planning_reused' for feature in feature_payloads)
    assert all(not feature['properties'].get('_offline') for feature in feature_payloads)
    assert {feature['properties'].get('_provider') for feature in feature_payloads} == {'test-openmeteo'}
    assert offline_calls == []


def test_realistic_route_passes_explicit_year_list_to_offline_lookup(monkeypatch, realistic_offline_backend):
    route_path = REALISTIC_ROUTE_DIR / 'real_route_1_freiburg_bern.gpx'
    if not route_path.exists():
        pytest.skip('missing routed GPX fixture: real_route_1_freiburg_bern.gpx')

    years_seen: list[tuple[int, ...]] = []

    def fake_get_offline_stats(lat, lon, month, day, *, start_year=None, end_year=None, years_selected=None, allow_span_mismatch=False):
        years_seen.append(tuple(int(year) for year in (years_selected or [])))
        return {
            '_offline': True,
            '_provider': 'openmeteo',
            '_years_start': 2021,
            '_years_end': 2025,
            '_years_used': [2025, 2021],
            'temperature_c': 18.0,
            'temp_p25': 16.0,
            'temp_p75': 20.0,
            'precipitation_mm': 1.5,
            'rain_probability': 0.3,
            'rain_typical_mm': 1.5,
            'wind_speed_ms': 3.0,
            'wind_dir_deg': 180.0,
            'wind_var_deg': 20.0,
            'temp_day_median': 18.0,
            'temp_day_p25': 16.0,
            'temp_day_p75': 20.0,
            '_temp_source': 'offline_tile',
            '_match_days': 1,
        }

    monkeypatch.setattr(backend_app, '_get_offline_stats', fake_get_offline_stats)
    monkeypatch.setattr(backend_app, 'generate_glyph_v2', lambda stats, debug=False: '<svg/>')

    client = realistic_offline_backend[0]
    client.get('/api/session')
    upload_resp = client.post(
        '/api/upload_gpx',
        data={'file': (io.BytesIO(route_path.read_bytes()), route_path.name)},
        content_type='multipart/form-data',
    )
    assert upload_resp.status_code == 200
    upload_payload = upload_resp.get_json()

    response = client.get(
        '/api/map_stream',
        query_string={
            'date': '05-12',
            'tour_planning': '1',
            'mode': 'single_day',
            'start_date': '2026-05-12',
            'total_days': '6',
            'gpx_path': upload_payload['path'],
            'step_km': '25',
            'profile_step_km': '8',
            'reuse_per_day': '1',
            'offline_only': '1',
            'hist_years': '5',
            'hist_start': '2021',
            'years': '2025,2023,2021',
        },
    )
    assert response.status_code == 200
    sse_text = response.data.decode('utf-8')
    assert years_seen
    assert all(years == (2025, 2023, 2021) for years in years_seen)
    done_payloads = _route_payloads(sse_text, 'done')
    assert done_payloads
    provenance = done_payloads[-1].get('provenance') or {}
    assert provenance.get('requested_years') == [2025, 2023, 2021]
    assert provenance.get('used_years') == [2025, 2021]
    assert provenance.get('missing_requested_years') == [2023]
    assert provenance.get('used_unrequested_years') == []
    assert 'Requested years:' not in str(provenance.get('summary_text') or '')


def test_realistic_route_offline_only_skips_points_without_valid_weather(monkeypatch, realistic_offline_backend):
    route_path = REALISTIC_ROUTE_DIR / 'real_route_1_freiburg_bern.gpx'
    if not route_path.exists():
        pytest.skip('missing routed GPX fixture: real_route_1_freiburg_bern.gpx')

    monkeypatch.setattr(backend_app, '_get_offline_stats', lambda *args, **kwargs: None)

    client = realistic_offline_backend[0]
    client.get('/api/session')
    upload_resp = client.post(
        '/api/upload_gpx',
        data={'file': (io.BytesIO(route_path.read_bytes()), route_path.name)},
        content_type='multipart/form-data',
    )
    assert upload_resp.status_code == 200
    upload_payload = upload_resp.get_json()

    response = client.get(
        '/api/map_stream',
        query_string={
            'date': '05-12',
            'tour_planning': '1',
            'mode': 'single_day',
            'start_date': '2026-05-12',
            'total_days': '6',
            'gpx_path': upload_payload['path'],
            'step_km': '25',
            'profile_step_km': '8',
            'reuse_per_day': '1',
            'offline_only': '1',
            'hist_years': '5',
            'hist_start': '2021',
            'years': '2025,2024,2023,2021',
        },
    )
    assert response.status_code == 200

    sse_text = response.data.decode('utf-8')
    station_payloads = _route_payloads(sse_text, 'station')
    assert station_payloads
    assert all('feature' not in payload for payload in station_payloads)
    assert all(bool(payload.get('skipped')) for payload in station_payloads)
    done_payloads = _route_payloads(sse_text, 'done')
    assert done_payloads
    provenance = done_payloads[-1].get('provenance') or {}
    assert provenance.get('skipped_points') == len(station_payloads)
    assert int((provenance.get('counts') or {}).get('dummy', 0) or 0) == 0


def test_parallel_realistic_routes_keep_offline_data(realistic_offline_backend):
    if not REALISTIC_ROUTE_DIR.exists():
        pytest.skip('realistic routed GPX fixtures are unavailable')

    route_specs = [
        ('real_route_2_milano_rome.gpx', 8),
        ('real_route_3_vienna_berlin.gpx', 9),
    ]
    for filename, _ in route_specs:
        if not (REALISTIC_ROUTE_DIR / filename).exists():
            pytest.skip(f'missing routed GPX fixture: {filename}')

    clients = realistic_offline_backend
    barrier = threading.Barrier(len(route_specs))
    results = [None] * len(route_specs)

    def worker(index: int, client, filename: str, total_days: int):
        client.get('/api/session')
        route_path = REALISTIC_ROUTE_DIR / filename
        upload_resp = client.post(
            '/api/upload_gpx',
            data={'file': (io.BytesIO(route_path.read_bytes()), filename)},
            content_type='multipart/form-data',
        )
        assert upload_resp.status_code == 200
        upload_payload = upload_resp.get_json()
        barrier.wait(timeout=3.0)
        response = client.get(
            '/api/map_stream',
            query_string={
                'date': '05-12',
                'tour_planning': '1',
                'mode': 'single_day',
                'start_date': '2026-05-12',
                'total_days': str(total_days),
                'gpx_path': upload_payload['path'],
                'step_km': '25',
                'profile_step_km': '8',
                'reuse_per_day': '1',
                'offline_only': '1',
                'hist_years': '10',
            },
        )
        assert response.status_code == 200
        results[index] = response.data.decode('utf-8')

    threads = [
        threading.Thread(target=worker, args=(index, clients[index], filename, total_days), name=f'realistic-route-{index}')
        for index, (filename, total_days) in enumerate(route_specs)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20.0)
        assert not thread.is_alive(), f'{thread.name} did not finish'

    for sse_text in results:
        assert sse_text is not None
        assert 'event: error' not in sse_text
        station_payloads = _route_payloads(sse_text, 'station')
        feature_payloads = [payload['feature'] for payload in station_payloads if 'feature' in payload]
        assert feature_payloads, 'expected weather features in SSE stream'
        assert all(bool(feature['properties'].get('_offline')) for feature in feature_payloads)
        assert all(not str(feature['properties'].get('_temp_source', '')).startswith('dummy') for feature in feature_payloads)
        assert {str(feature['properties'].get('_source_mode')) for feature in feature_payloads} == {'tour_planning_offline'}
