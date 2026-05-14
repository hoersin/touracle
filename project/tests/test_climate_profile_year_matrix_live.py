import sys
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore


PROFILE_START_DATE = '2026-05-14'
PROFILE_END_DATE = '2026-05-27'
PROFILE_TOTAL_DAYS = 14

YEAR_SETS = [
    [2025],
    [2025, 2024],
    [2025, 2024, 2023],
    [2021, 2024],
    [2021, 2024, 2025],
]

LOCATIONS = [
    pytest.param(47.3769, 8.5417, 'zurich', id='zurich'),
    pytest.param(45.4642, 9.1900, 'milan', id='milan'),
    pytest.param(48.2082, 16.3738, 'vienna', id='vienna'),
]


def _climate_profile_cases() -> list[pytest.ParamSpec]:
    params = []
    for years in YEAR_SETS:
        years_label = '-'.join(str(year) for year in years)
        for lat, lon, label in [(47.3769, 8.5417, 'zurich'), (45.4642, 9.1900, 'milan'), (48.2082, 16.3738, 'vienna')]:
            params.append(pytest.param(lat, lon, label, years, id=f'{label}-{years_label}'))
    return params


@pytest.fixture
def live_climate_profile_backend(monkeypatch, tmp_path):
    data_dir = tmp_path / 'data'
    session_file = data_dir / 'session_state.json'

    data_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backend_app, 'DATA_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'UPLOAD_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'SESSION_FILE', session_file)
    monkeypatch.setattr(backend_app, 'SESSION_STORE', {})
    monkeypatch.setattr(backend_app, 'SESSION_STORE_LOADED', False)
    monkeypatch.setattr(backend_app, '_OFFLINE_STORE', None)
    monkeypatch.setattr(backend_app, '_OFFLINE_STORE_TRIED', False)
    monkeypatch.setattr(backend_app, '_OFFLINE_STORES_BY_YEAR', {})
    monkeypatch.setattr(backend_app, '_OFFLINE_STORES_BY_PATH', {})

    return backend_app.app.test_client()


def _assert_years_available(years_selected):
    missing_years = []
    for year in years_selected:
        try:
            store = backend_app._resolve_offline_store_for_year(int(year))
        except Exception:
            store = None
        if store is None:
            missing_years.append(int(year))
    if missing_years:
        pytest.skip(f'missing offline store(s) for climate profile matrix: {missing_years}')


@pytest.mark.parametrize(('lat', 'lon', 'label', 'years_selected'), _climate_profile_cases())
def test_weather_profile_year_switch_matrix_live(live_climate_profile_backend, lat, lon, label, years_selected):
    _assert_years_available(years_selected)
    anchor_year = max(int(year) for year in years_selected)

    client = live_climate_profile_backend
    response = client.get(
        '/api/weather_profile',
        query_string={
            'lat': str(lat),
            'lon': str(lon),
            'years': ','.join(str(year) for year in years_selected),
            'mode': 'active',
            'start_date': PROFILE_START_DATE,
            'end_date': PROFILE_END_DATE,
        },
    )

    assert response.status_code == 200, (label, years_selected, response.get_data(as_text=True))

    payload = response.get_json()
    assert payload['meta']['years'] == years_selected, (label, years_selected, payload['meta'])
    assert payload['meta']['point'] == {'lat': float(lat), 'lon': float(lon)}
    assert payload['meta']['location']
    assert payload['meta']['tile_center']['lat'] is not None
    assert payload['meta']['tile_center']['lon'] is not None
    assert payload['summary']['total_days'] == PROFILE_TOTAL_DAYS
    assert len(payload['series']) == PROFILE_TOTAL_DAYS
    assert 0 <= int(payload['summary']['lucky_days']) <= PROFILE_TOTAL_DAYS
    assert 0 <= int(payload['summary']['rain_days']) <= PROFILE_TOTAL_DAYS
    assert 0 <= int(payload['summary']['calm_days']) <= PROFILE_TOTAL_DAYS
    assert payload['summary']['temp_mean'] is not None
    assert payload['summary']['rain_mean'] is not None
    assert payload['summary']['wind_speed'] is not None

    complete_days = [
        day for day in payload['series']
        if day.get('temp') is not None and day.get('rain') is not None and day.get('wind_speed') is not None
    ]
    assert complete_days, (label, years_selected)

    for day in complete_days:
        assert day['date'].startswith(f'{anchor_year}-')
        assert isinstance(day['lucky'], bool)