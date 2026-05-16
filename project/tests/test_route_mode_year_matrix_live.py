import io
import json
import sys
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore
import weather_openmeteo  # type: ignore
import weather_service  # type: ignore


REALISTIC_ROUTE_DIR = BASE_DIR / 'data' / 'realistic_routes'
TOUR_START_DATE = '2026-06-15'
TOUR_TOTAL_DAYS = 5
STEP_KM = 110
PROFILE_STEP_KM = 20


def _event_payloads(sse_text: str, event_name: str) -> list[dict]:
    marker = f'event: {event_name}\ndata: '
    payloads: list[dict] = []
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


def _route_matrix_cases() -> list[pytest.ParamSpec]:
    routes = [
        'real_route_2_milano_rome.gpx',
        'real_route_3_vienna_berlin.gpx',
        'real_route_6_iceland_south_coast.gpx',
    ]
    year_sets = [
        [2025],
        [2025, 2024],
        [2025, 2023],
        [2023, 2022],
        [2021],
    ]

    params = []
    case_index = 0
    for route_name in routes:
        for years in year_sets:
            premium = bool(case_index % 2)
            mode_label = 'premium' if premium else 'standard'
            years_label = '-'.join(str(year) for year in years)
            params.append(pytest.param(route_name, years, premium, id=f'{Path(route_name).stem}-{years_label}-{mode_label}'))
            case_index += 1
    return params


@pytest.fixture
def live_route_matrix_backend(monkeypatch, tmp_path):
    data_dir = tmp_path / 'data'
    session_file = data_dir / 'session_state.json'
    stats_dir = tmp_path / 'stats'
    openmeteo_cache_dir = tmp_path / 'openmeteo_daily'

    data_dir.mkdir(parents=True, exist_ok=True)
    stats_dir.mkdir(parents=True, exist_ok=True)
    openmeteo_cache_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backend_app, 'DATA_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'UPLOAD_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'SESSION_FILE', session_file)
    monkeypatch.setattr(backend_app, 'SESSION_STORE', {})
    monkeypatch.setattr(backend_app, 'SESSION_STORE_LOADED', False)
    monkeypatch.setattr(backend_app, 'STATS_CACHE_DIR', stats_dir)
    monkeypatch.setattr(backend_app, '_OFFLINE_STORE', None)
    monkeypatch.setattr(backend_app, '_OFFLINE_STORE_TRIED', False)
    monkeypatch.setattr(backend_app, '_OFFLINE_STORES_BY_YEAR', {})
    monkeypatch.setattr(backend_app, '_OFFLINE_STORES_BY_PATH', {})

    monkeypatch.setattr(weather_openmeteo, 'CACHE_DIR', openmeteo_cache_dir)
    monkeypatch.setattr(weather_openmeteo, 'CB_FILE', openmeteo_cache_dir / 'api_disabled_until.txt')
    monkeypatch.setattr(weather_service, 'CACHE_DIR', openmeteo_cache_dir)

    weather_service.WeatherService.memory_cache = {}
    weather_service.WeatherService.pending = {}
    weather_service.WeatherService.last_request_ts = 0.0
    weather_openmeteo.reset_api_disable()
    weather_service.reset_api_disable()

    return backend_app.app.test_client()


@pytest.mark.parametrize(('route_name', 'years_selected', 'premium'), _route_matrix_cases())
def test_route_mode_year_matrix_live(live_route_matrix_backend, route_name, years_selected, premium):
    route_path = REALISTIC_ROUTE_DIR / route_name
    if not route_path.exists():
        pytest.skip(f'missing routed GPX fixture: {route_name}')

    client = live_route_matrix_backend
    client.get('/api/session')
    upload_resp = client.post(
        '/api/upload_gpx',
        data={'file': (io.BytesIO(route_path.read_bytes()), route_path.name)},
        content_type='multipart/form-data',
    )
    assert upload_resp.status_code == 200
    upload_payload = upload_resp.get_json()

    hist_start = min(int(year) for year in years_selected)
    hist_end = max(int(year) for year in years_selected)
    query = {
        'date': TOUR_START_DATE[5:7] + '-' + TOUR_START_DATE[8:10],
        'tour_planning': '1',
        'mode': 'single_day',
        'start_date': TOUR_START_DATE,
        'total_days': str(TOUR_TOTAL_DAYS),
        'gpx_path': upload_payload['path'],
        'step_km': str(STEP_KM),
        'profile_step_km': str(PROFILE_STEP_KM),
        'hist_years': str(hist_end - hist_start + 1),
        'hist_start': str(hist_start),
        'years': ','.join(str(int(year)) for year in years_selected),
        'reset_api': '1',
        'temp_cold': '5',
        'temp_hot': '30',
        'rain_high': '10',
        'wind_head_comfort': '4',
        'wind_tail_comfort': '10',
    }
    if premium:
        query['force_online'] = '1'
        query['reuse_per_day'] = '1'
    else:
        query['offline_only'] = '1'

    response = client.get('/api/map_stream', query_string=query)
    assert response.status_code == 200

    sse_text = response.data.decode('utf-8')
    assert 'event: error' not in sse_text

    station_payloads = _event_payloads(sse_text, 'station')
    done_payloads = _event_payloads(sse_text, 'done')
    summary_payloads = _event_payloads(sse_text, 'tour_summary')

    feature_payloads = [payload['feature'] for payload in station_payloads if 'feature' in payload]
    assert feature_payloads, route_name
    assert done_payloads, route_name
    assert summary_payloads, route_name

    done_payload = done_payloads[-1]
    tour_summary = done_payload.get('tour_summary') or summary_payloads[-1]
    provenance = done_payload.get('provenance') or {}

    assert int(tour_summary['total_days']) == TOUR_TOTAL_DAYS, (route_name, years_selected, premium)
    assert provenance.get('requested_years') == [int(year) for year in years_selected]
    assert provenance.get('used_years'), (route_name, years_selected, premium)

    source_modes = {str(feature['properties'].get('_source_mode')) for feature in feature_payloads}
    providers = {str(feature['properties'].get('_provider')) for feature in feature_payloads if feature['properties'].get('_provider')}

    assert not any('dummy' in source_mode for source_mode in source_modes), (route_name, years_selected, premium, source_modes)

    if premium:
        assert source_modes == {'tour_planning_reused'}, (route_name, years_selected, premium, source_modes)
        assert all(not bool(feature['properties'].get('_offline')) for feature in feature_payloads)
        assert providers == {'openmeteo'}, (route_name, years_selected, premium, providers)
    else:
        assert source_modes <= {'offline_tile', 'disk_cache'}, (route_name, years_selected, premium, source_modes)
        assert all(bool(feature['properties'].get('_offline')) for feature in feature_payloads)

    print(
        f"CASE route={route_name} years={','.join(str(y) for y in years_selected)} premium={premium} "
        f"used={provenance.get('used_years')} missing={provenance.get('missing_requested_years')} "
        f"unrequested={provenance.get('used_unrequested_years')} summary={provenance.get('summary_text')}"
    )