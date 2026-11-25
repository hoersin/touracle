import sys
import threading
import time
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore


class _FakeStore:
    def __init__(self, tile_ids: list[str] | None = None):
        self.tile_ids = set(tile_ids or ['r0_c0'])


def _mk_row(
    month: int,
    day: int,
    *,
    tmean: float | None = None,
    tp25: float | None = None,
    tp75: float | None = None,
    rain: float | None = None,
    ws: float | None = None,
    wd: float | None = None,
    samples_daily: int = 1,
    samples_rain: int = 1,
    samples_wind: int = 1,
    samples_day_means: int = 1,
    samples_day_hours: int = 4,
):
    return {
        'month': int(month),
        'day': int(day),
        'temp_day_median': tmean,
        'temp_day_p25': tp25,
        'temp_day_p75': tp75,
        'precipitation_mm': rain,
        'wind_speed_ms': ws,
        'wind_dir_deg': wd,
        'samples_daily': int(samples_daily),
        'samples_rain': int(samples_rain),
        'samples_wind': int(samples_wind),
        'samples_day_means': int(samples_day_means),
        'samples_day_hours': int(samples_day_hours),
    }


def test_reference_years_resolve_latest_three_complete():
    years, audits = backend_app._resolve_complete_reference_years(3)
    assert years == [2025, 2024, 2023]
    years_seen = {int(a['year']) for a in audits if a.get('year') is not None}
    assert {2023, 2024, 2025}.issubset(years_seen)
    y2026 = [a for a in audits if a.get('year') == 2026]
    assert y2026
    assert y2026[0]['complete'] is False


def test_reference_years_resolve_latest_four_and_five_complete():
    years4, _audits4 = backend_app._resolve_complete_reference_years(4)
    years5, _audits5 = backend_app._resolve_complete_reference_years(5)
    assert years4 == [2025, 2024, 2023, 2022]
    assert years5 == [2025, 2024, 2023, 2022, 2021]


def test_reference_years_insufficient_returns_empty(monkeypatch):
    monkeypatch.setattr(
        backend_app,
        '_discover_offline_year_databases',
        lambda: {2024: Path('/tmp/offline_weather_2024.sqlite'), 2025: Path('/tmp/offline_weather_2025.sqlite')},
    )

    def _eval(path: Path):
        year = int(path.stem.split('_')[-1])
        return {'year': year, 'complete': True, 'reason': 'complete'}

    monkeypatch.setattr(backend_app, '_evaluate_offline_year_database', _eval)
    years, audits = backend_app._resolve_complete_reference_years(3)
    assert years == []
    assert sorted([a['year'] for a in audits], reverse=True) == [2025, 2024]


def test_reference_years_scan_cached_across_requested_counts(monkeypatch):
    monkeypatch.setattr(
        backend_app,
        '_discover_offline_year_databases',
        lambda: {
            2021: Path('/tmp/offline_weather_2021.sqlite'),
            2022: Path('/tmp/offline_weather_2022.sqlite'),
            2023: Path('/tmp/offline_weather_2023.sqlite'),
            2024: Path('/tmp/offline_weather_2024.sqlite'),
            2025: Path('/tmp/offline_weather_2025.sqlite'),
        },
    )
    calls = {'n': 0}

    def _eval(path: Path):
        calls['n'] += 1
        year = int(path.stem.split('_')[-1])
        return {'year': year, 'complete': True, 'reason': 'complete'}

    monkeypatch.setattr(backend_app, '_evaluate_offline_year_database', _eval)
    with backend_app._OFFLINE_REFERENCE_YEARS_CACHE_COND:
        backend_app._OFFLINE_REFERENCE_YEARS_CACHE.clear()
        backend_app._OFFLINE_REFERENCE_YEARS_CACHE_IN_FLIGHT.clear()

    years3, _ = backend_app._resolve_complete_reference_years(3)
    years4, _ = backend_app._resolve_complete_reference_years(4)
    years5, _ = backend_app._resolve_complete_reference_years(5)
    assert years3 == [2025, 2024, 2023]
    assert years4 == [2025, 2024, 2023, 2022]
    assert years5 == [2025, 2024, 2023, 2022, 2021]
    assert calls['n'] == 5


def test_reference_years_concurrent_first_request_avoids_duplicate_scan(monkeypatch):
    monkeypatch.setattr(
        backend_app,
        '_discover_offline_year_databases',
        lambda: {
            2024: Path('/tmp/offline_weather_2024.sqlite'),
            2025: Path('/tmp/offline_weather_2025.sqlite'),
        },
    )
    calls = {'n': 0}

    def _eval(path: Path):
        time.sleep(0.05)
        calls['n'] += 1
        year = int(path.stem.split('_')[-1])
        return {'year': year, 'complete': True, 'reason': 'complete'}

    monkeypatch.setattr(backend_app, '_evaluate_offline_year_database', _eval)
    with backend_app._OFFLINE_REFERENCE_YEARS_CACHE_COND:
        backend_app._OFFLINE_REFERENCE_YEARS_CACHE.clear()
        backend_app._OFFLINE_REFERENCE_YEARS_CACHE_IN_FLIGHT.clear()

    results: list[list[int]] = []
    errors: list[Exception] = []

    def _worker():
        try:
            years, _ = backend_app._resolve_complete_reference_years(2)
            results.append(years)
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    t1 = threading.Thread(target=_worker)
    t2 = threading.Thread(target=_worker)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert not errors
    assert results == [[2025, 2024], [2025, 2024]]
    assert calls['n'] == 2


def test_temperature_aggregation_month_thirds_and_leap_handling():
    rows_2024 = []
    rows_2025 = []
    for day in range(1, 30):
        rows_2024.append(_mk_row(2, day, tmean=float(day), tp25=float(day) - 1.0, tp75=float(day) + 1.0))
    for day in range(1, 29):
        rows_2025.append(_mk_row(2, day, tmean=float(day) + 10.0, tp25=float(day) + 9.0, tp75=float(day) + 11.0))
    rows_2025.append(_mk_row(2, 29, tmean=None, tp25=None, tp75=None, rain=None, ws=None, wd=None, samples_daily=0, samples_rain=0, samples_wind=0, samples_day_means=0, samples_day_hours=0))

    out = backend_app._aggregate_temperature_thirds({2024: rows_2024, 2025: rows_2025})
    feb = out[1]
    p1, p2, p3 = feb['periods']

    assert p1['day_start'] == 1 and p1['day_end'] == 10
    assert p2['day_start'] == 11 and p2['day_end'] == 20
    assert p3['day_start'] == 21 and p3['day_end'] == 29

    # Year means: 2024 -> 5.5, 2025 -> 15.5
    assert p1['mean_c'] == pytest.approx(10.5)
    assert p1['p25_c'] == pytest.approx(9.5)
    assert p1['p75_c'] == pytest.approx(11.5)
    assert p1['valid_years'] == 2
    assert p1['valid_days'] == 20

    # Late period includes Feb 29 only from leap year; non-leap placeholder skipped
    assert p3['valid_days'] == 17  # 9 days (2024) + 8 days (2025)


def test_precipitation_aggregation_sums_then_year_average():
    rows_2024 = [_mk_row(1, d, rain=1.0) for d in range(1, 32)]
    rows_2025 = [_mk_row(1, d, rain=2.0) for d in range(1, 32)]
    out = backend_app._aggregate_precipitation_thirds({2024: rows_2024, 2025: rows_2025})
    jan = out['months'][0]
    p1, p2, p3 = jan['periods']
    assert p1['period_mm'] == pytest.approx(15.0)  # mean(10,20)
    assert p2['period_mm'] == pytest.approx(15.0)
    assert p3['period_mm'] == pytest.approx(16.5)  # mean(11,22)
    assert jan['monthly_total_mm'] == pytest.approx(p1['period_mm'] + p2['period_mm'] + p3['period_mm'])


def test_precipitation_annual_total_equals_monthly_sums():
    rows_2024 = []
    rows_2025 = []
    for month in range(1, 13):
        for day in range(1, 29):
            rows_2024.append(_mk_row(month, day, rain=1.0))
            rows_2025.append(_mk_row(month, day, rain=2.0))
    out = backend_app._aggregate_precipitation_thirds({2024: rows_2024, 2025: rows_2025})
    monthly_sum = sum(m['monthly_total_mm'] for m in out['months'])
    assert out['annual_total_mm'] == pytest.approx(monthly_sum)


def test_wind_aggregation_sectors_speed_classes_and_calm():
    rows = [
        _mk_row(1, 1, ws=1.0, wd=0.0),        # N, class 0
        _mk_row(1, 2, ws=3.0, wd=11.24),      # N, class 1
        _mk_row(1, 3, ws=6.0, wd=11.25),      # NNE, class 2
        _mk_row(1, 4, ws=9.0, wd=359.9),      # N, class 3
        _mk_row(1, 5, ws=0.2, wd=200.0),      # calm
        _mk_row(1, 6, ws=3.0, wd=None),       # invalid direction -> excluded
    ]
    out = backend_app._aggregate_wind_monthly_roses({2025: rows})
    jan = out[0]
    assert jan['total_valid_observations'] == 5
    assert jan['calm_count'] == 1
    assert jan['calm_pct'] == pytest.approx(20.0)

    n_sector = jan['sectors'][0]
    nne_sector = jan['sectors'][1]
    assert n_sector['count'] == 3
    assert nne_sector['count'] == 1
    assert n_sector['speed_classes'][0]['count'] == 1
    assert n_sector['speed_classes'][1]['count'] == 1
    assert n_sector['speed_classes'][3]['count'] == 1
    assert nne_sector['speed_classes'][2]['count'] == 1
    assert jan['sectors'][2]['pct_total'] == pytest.approx(0.0)
    assert jan['sectors'][2]['speed_classes'][0]['pct_sector'] is None


def test_wind_aggregation_empty_month_uses_null_percentages():
    out = backend_app._aggregate_wind_monthly_roses({2025: []})
    jan = out[0]
    assert jan['total_valid_observations'] == 0
    assert jan['calm_pct'] is None
    assert jan['sectors'][0]['pct_total'] is None
    assert jan['sectors'][0]['speed_classes'][0]['pct_total'] is None
    assert jan['sectors'][0]['speed_classes'][0]['pct_sector'] is None


def test_explore_climate_profile_api_success(monkeypatch):
    years = [2025, 2024, 2023]
    stores = {y: _FakeStore(['r0_c0']) for y in years}
    per_year_rows = {
        2025: [_mk_row(1, d, tmean=10.0, tp25=8.0, tp75=12.0, rain=1.0, ws=3.0, wd=90.0) for d in range(1, 32)],
        2024: [_mk_row(1, d, tmean=12.0, tp25=10.0, tp75=14.0, rain=2.0, ws=4.0, wd=90.0) for d in range(1, 32)],
        2023: [_mk_row(1, d, tmean=14.0, tp25=12.0, tp75=16.0, rain=3.0, ws=5.0, wd=90.0) for d in range(1, 32)],
    }

    monkeypatch.setattr(backend_app, '_resolve_complete_reference_years', lambda count=3: (years, []))
    monkeypatch.setattr(backend_app, '_resolve_offline_store_for_year', lambda year, point=None, bounds=None: stores[int(year)])
    monkeypatch.setattr(backend_app, '_tile_id_for_point_or_edge', lambda store, lat, lon, max_distance_km=1400.0: 'r0_c0')
    monkeypatch.setattr(backend_app, '_lookup_tile_center', lambda store, tile_id: (48.77, 9.18))
    monkeypatch.setattr(backend_app, '_fetch_tile_climatology_rows', lambda store, tile_id: per_year_rows[next(y for y, s in stores.items() if s is store)])

    client = backend_app.app.test_client()
    res = client.get('/api/explore/climate_profile', query_string={'lat': '48.7758', 'lon': '9.1829'})
    assert res.status_code == 200
    payload = res.get_json()
    assert payload['meta']['reference_years'] == years
    assert payload['meta']['tile_id'] == 'r0_c0'
    assert len(payload['temperature']['months']) == 12
    assert len(payload['temperature']['months'][0]['periods']) == 3
    assert len(payload['wind']['months']) == 12
    assert len(payload['wind']['months'][0]['sectors']) == 16


def test_explore_climate_profile_api_structured_error_insufficient_years(monkeypatch):
    monkeypatch.setattr(backend_app, '_resolve_complete_reference_years', lambda count=3: ([], [{'year': 2025, 'complete': True}]))
    client = backend_app.app.test_client()
    res = client.get('/api/explore/climate_profile', query_string={'lat': '48.7758', 'lon': '9.1829'})
    assert res.status_code == 422
    payload = res.get_json()
    assert payload['error']['code'] == 'insufficient-complete-reference-years'


def test_explore_climate_profile_api_structured_error_missing_database(monkeypatch):
    years = [2025, 2024, 2023]
    monkeypatch.setattr(backend_app, '_resolve_complete_reference_years', lambda count=3: (years, []))
    monkeypatch.setattr(
        backend_app,
        '_resolve_offline_store_for_year',
        lambda year, point=None, bounds=None: None if int(year) == 2024 else _FakeStore(['r0_c0']),
    )
    monkeypatch.setattr(backend_app, '_tile_id_for_point_or_edge', lambda store, lat, lon, max_distance_km=1400.0: 'r0_c0')
    client = backend_app.app.test_client()
    res = client.get('/api/explore/climate_profile', query_string={'lat': '48.7758', 'lon': '9.1829'})
    assert res.status_code == 422
    payload = res.get_json()
    assert payload['error']['code'] == 'missing-database'


def test_location_label_stays_offline_only(monkeypatch):
    def _unexpected_requests_get(*args, **kwargs):
        raise AssertionError('location_label must not call online reverse geocoding')

    monkeypatch.setattr(backend_app.requests, 'get', _unexpected_requests_get)
    monkeypatch.setattr(
        backend_app,
        '_reverse_offline_fallback',
        lambda lat, lon, include_station=False: {
            'name': 'Reykjavík',
            'region': 'Capital Region',
            'country': 'IS',
            'label': 'Reykjavík, Capital Region, IS',
            'source': 'offline-city',
            'distance_km': '0.000',
        },
    )

    client = backend_app.app.test_client()
    res = client.get('/api/location_label', query_string={'lat': '64.1466', 'lon': '-21.9426'})
    assert res.status_code == 200
    payload = res.get_json()
    assert payload['location'] == 'Reykjavík, Capital Region, IS'
    assert payload['location_name'] == 'Reykjavík'
    assert payload['location_region'] == 'Capital Region'
    assert payload['location_country'] == 'IS'


def test_explore_missing_offline_data_does_not_block_followup_valid_request():
    client = backend_app.app.test_client()

    missing = client.get('/api/explore/climate_profile', query_string={'lat': '0', 'lon': '-30', 'reference_years': 3})
    assert missing.status_code in (404, 422)
    missing_payload = missing.get_json() or {}
    err = missing_payload.get('error') or {}
    assert err.get('code') in ('tile-not-found', 'missing-climatology-data', 'tile-mismatch-across-years')

    valid = client.get('/api/explore/climate_profile', query_string={'lat': '43.9493', 'lon': '4.8055', 'reference_years': 3})
    assert valid.status_code == 200
    payload = valid.get_json()
    assert payload['meta']['tile_id']
    assert len(payload['temperature']['months']) == 12
    assert len(payload['precipitation']['months']) == 12
    assert len(payload['wind']['months']) == 12


def test_wind_sector_mapping_uses_meteorological_from_direction():
    labels = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
    assert labels[backend_app._sector_index_16(0.0)] == 'N'
    assert labels[backend_app._sector_index_16(360.0)] == 'N'
    assert labels[backend_app._sector_index_16(45.0)] == 'NE'
    assert labels[backend_app._sector_index_16(90.0)] == 'E'
    assert labels[backend_app._sector_index_16(180.0)] == 'S'
    assert labels[backend_app._sector_index_16(270.0)] == 'W'
    assert labels[backend_app._sector_index_16(315.0)] == 'NW'


def _reset_strategic_grid_admission():
    with backend_app._STRATEGIC_GRID_ADMISSION_LOCK:
        backend_app._STRATEGIC_GRID_ACTIVE_KEY = None
        backend_app._STRATEGIC_GRID_ACTIVE_COUNT = 0
        backend_app._STRATEGIC_GRID_IN_FLIGHT.clear()
        backend_app._STRATEGIC_GRID_PEAK_CONCURRENCY = 0


def test_strategic_grid_identical_requests_are_coalesced(monkeypatch):
    _reset_strategic_grid_admission()
    started = threading.Event()
    release = threading.Event()
    calls = {'n': 0}

    def _impl():
        calls['n'] += 1
        started.set()
        assert release.wait(timeout=2.0)
        return backend_app.jsonify({'points': [], 'count': 0})

    monkeypatch.setattr(backend_app, '_api_strategic_grid_impl', _impl)
    results = []

    def _request(path):
        with backend_app.app.test_request_context(path):
            response = backend_app.api_strategic_grid()
            if isinstance(response, tuple):
                response = response[0]
            results.append(response.status_code)

    url = '/api/strategic_grid?date=01-01&lat_min=1&lat_max=2&lon_min=3&lon_max=4'
    t1 = threading.Thread(target=_request, args=(url,))
    t2 = threading.Thread(target=_request, args=(url,))
    t1.start()
    assert started.wait(timeout=1.0)
    t2.start()
    time.sleep(0.05)

    assert calls['n'] == 1
    assert t2.is_alive()
    release.set()
    t1.join(timeout=2.0)
    t2.join(timeout=2.0)

    assert sorted(results) == [200, 200]
    assert backend_app._STRATEGIC_GRID_PEAK_CONCURRENCY == 1


def test_strategic_grid_non_identical_request_is_rejected(monkeypatch):
    _reset_strategic_grid_admission()
    started = threading.Event()
    release = threading.Event()

    def _impl():
        started.set()
        assert release.wait(timeout=2.0)
        return backend_app.jsonify({'points': [], 'count': 0})

    monkeypatch.setattr(backend_app, '_api_strategic_grid_impl', _impl)
    first_result = []

    def _first():
        with backend_app.app.test_request_context(
            '/api/strategic_grid?date=01-01&lat_min=1&lat_max=2&lon_min=3&lon_max=4'
        ):
            response = backend_app.api_strategic_grid()
            if isinstance(response, tuple):
                response = response[0]
            first_result.append(response.status_code)

    thread = threading.Thread(target=_first)
    thread.start()
    assert started.wait(timeout=1.0)

    with backend_app.app.test_request_context(
        '/api/strategic_grid?date=01-02&lat_min=1&lat_max=2&lon_min=3&lon_max=4'
    ):
        rejected = backend_app.api_strategic_grid()

    if isinstance(rejected, tuple):
        rejected_response, rejected_status = rejected
        assert rejected_status == 429
    else:
        rejected_response = rejected
        assert rejected.status_code == 429
    assert rejected_response.headers.get('Retry-After') == '1'
    assert rejected_response.get_json()['code'] == 'strategic-grid-busy'

    release.set()
    thread.join(timeout=2.0)
    assert first_result == [200]


def test_strategic_grid_admission_releases_after_exception(monkeypatch):
    _reset_strategic_grid_admission()
    calls = {'n': 0}

    def _impl():
        calls['n'] += 1
        if calls['n'] == 1:
            raise RuntimeError('simulated aggregation failure')
        return backend_app.jsonify({'points': [], 'count': 0})

    monkeypatch.setattr(backend_app, '_api_strategic_grid_impl', _impl)
    url = '/api/strategic_grid?date=01-01&lat_min=1&lat_max=2&lon_min=3&lon_max=4'

    with backend_app.app.test_request_context(url):
        failed = backend_app.api_strategic_grid()
    if isinstance(failed, tuple):
        failed_response, failed_status = failed
        assert failed_status == 500
    else:
        failed_response = failed
        assert failed.status_code == 500

    with backend_app.app.test_request_context(url):
        recovered = backend_app.api_strategic_grid()
    if isinstance(recovered, tuple):
        recovered_response, recovered_status = recovered
        assert recovered_status == 200
    else:
        recovered_response = recovered
        assert recovered.status_code == 200

    assert recovered_response.get_json()['count'] == 0


def test_strategic_grid_identical_waiter_limit(monkeypatch):
    _reset_strategic_grid_admission()
    started = threading.Event()
    release = threading.Event()

    def _impl():
        started.set()
        assert release.wait(timeout=3.0)
        return backend_app.jsonify({'points': [], 'count': 0})

    monkeypatch.setattr(backend_app, '_api_strategic_grid_impl', _impl)
    url = '/api/strategic_grid?date=01-01&lat_min=1&lat_max=2&lon_min=3&lon_max=4'
    results = []
    threads = []

    def _request():
        with backend_app.app.test_request_context(url):
            response = backend_app.api_strategic_grid()
            if isinstance(response, tuple):
                response_obj, status = response
                results.append(status)
            else:
                results.append(response.status_code)

    first = threading.Thread(target=_request)
    first.start()
    assert started.wait(timeout=1.0)

    for _ in range(backend_app._STRATEGIC_GRID_MAX_WAITERS):
        thread = threading.Thread(target=_request)
        thread.start()
        threads.append(thread)
        time.sleep(0.02)

    sixth_rejected = threading.Thread(target=_request)
    sixth_rejected.start()
    sixth_rejected.join(timeout=1.0)

    release.set()
    first.join(timeout=3.0)
    for thread in threads:
        thread.join(timeout=3.0)

    assert 429 in results
    assert results.count(429) == 1
    assert results.count(200) == backend_app._STRATEGIC_GRID_MAX_WAITERS + 1
