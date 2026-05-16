import io
import json
import math
import sys
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore


REALISTIC_ROUTE_DIR = BASE_DIR / 'data' / 'realistic_routes'
TOUR_START_DATE = '2026-05-12'
TOUR_TOTAL_DAYS = 10
TOUR_THRESHOLDS = {
    'temp_cold': 5,
    'temp_hot': 30,
    'rain_high': 10,
    'wind_head_comfort': 4,
    'wind_tail_comfort': 10,
}


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


def _median(values: list[float]) -> float | None:
    nums = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not nums:
        return None
    mid = len(nums) // 2
    if len(nums) % 2:
        return nums[mid]
    return (nums[mid - 1] + nums[mid]) / 2.0


def _mean(values: list[float]) -> float | None:
    nums = [float(value) for value in values if math.isfinite(float(value))]
    if not nums:
        return None
    return sum(nums) / len(nums)


def _summary_from_day_summaries(day_summaries: list[dict]) -> dict:
    day_temps: list[float] = []
    day_winds: list[float] = []
    day_precip: list[float] = []
    rain_days = 0
    headwind_days = 0
    tailwind_days = 0
    lucky_days = 0

    for day_summary in day_summaries:
        temp_median = day_summary.get('temp_median')
        wind_mean = day_summary.get('wind_mean')
        precip_sum = day_summary.get('precip_sum')
        eff_mean = day_summary.get('eff_mean')
        lucky = day_summary.get('lucky') is True

        if temp_median is not None:
            day_temps.append(float(temp_median))
        if wind_mean is not None:
            day_winds.append(float(wind_mean))
        precip_num = float(precip_sum or 0.0)
        day_precip.append(precip_num)
        if precip_num >= 1.0:
            rain_days += 1
        if eff_mean is not None:
            eff_num = float(eff_mean)
            if eff_num <= -0.33:
                headwind_days += 1
            elif eff_num >= 0.33:
                tailwind_days += 1
        if lucky:
            lucky_days += 1

    return {
        'total_days': len(day_summaries),
        'rain_days': rain_days,
        'headwind_days': headwind_days,
        'tailwind_days': tailwind_days,
        'lucky_days': lucky_days,
        'median_temperature': _median(day_temps),
        'total_precipitation': sum(day_precip),
        'mean_wind_speed': _mean(day_winds),
    }


@pytest.fixture
def realistic_summary_backend(monkeypatch, tmp_path):
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
    return backend_app.app.test_client()


@pytest.mark.parametrize(
    'route_name',
    [
        'real_route_1_freiburg_bern.gpx',
        'real_route_2_milano_rome.gpx',
        'real_route_3_vienna_berlin.gpx',
        'real_route_4_barcelona_warsaw.gpx',
        'real_route_5_porto_bucharest.gpx',
    ],
)
def test_realistic_tour_summary_matches_day_aggregates(realistic_summary_backend, route_name):
    route_path = REALISTIC_ROUTE_DIR / route_name
    if not route_path.exists():
        pytest.skip(f'missing routed GPX fixture: {route_name}')

    client = realistic_summary_backend
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
            'start_date': TOUR_START_DATE,
            'total_days': str(TOUR_TOTAL_DAYS),
            'gpx_path': upload_payload['path'],
            'step_km': '25',
            'profile_step_km': '8',
            'reuse_per_day': '1',
            'offline_only': '1',
            'hist_years': '1',
            'hist_start': '2025',
            'temp_cold': str(TOUR_THRESHOLDS['temp_cold']),
            'temp_hot': str(TOUR_THRESHOLDS['temp_hot']),
            'rain_high': str(TOUR_THRESHOLDS['rain_high']),
            'wind_head_comfort': str(TOUR_THRESHOLDS['wind_head_comfort']),
            'wind_tail_comfort': str(TOUR_THRESHOLDS['wind_tail_comfort']),
        },
    )
    assert response.status_code == 200

    sse_text = response.data.decode('utf-8')
    assert 'event: error' not in sse_text

    station_payloads = _event_payloads(sse_text, 'station')
    summary_payloads = _event_payloads(sse_text, 'tour_summary')
    done_payloads = _event_payloads(sse_text, 'done')

    assert station_payloads, route_name
    assert summary_payloads, route_name
    assert done_payloads, route_name

    backend_summary = done_payloads[-1].get('tour_summary') or summary_payloads[-1]
    day_summaries = done_payloads[-1].get('tour_day_summaries') or backend_summary.get('day_summaries') or []
    rebuilt_summary = _summary_from_day_summaries(day_summaries)

    assert int(backend_summary['total_days']) == TOUR_TOTAL_DAYS, route_name
    assert rebuilt_summary['total_days'] == TOUR_TOTAL_DAYS, route_name
    assert int(backend_summary['rain_days']) == rebuilt_summary['rain_days'], route_name
    assert int(backend_summary['headwind_days']) == rebuilt_summary['headwind_days'], route_name
    assert int(backend_summary['tailwind_days']) == rebuilt_summary['tailwind_days'], route_name
    assert int(backend_summary['lucky_days']) == rebuilt_summary['lucky_days'], route_name
    assert float(backend_summary['median_temperature']) == pytest.approx(rebuilt_summary['median_temperature'], abs=1e-9), route_name
    assert float(backend_summary['total_precipitation']) == pytest.approx(rebuilt_summary['total_precipitation'], abs=1e-9), route_name
    assert float(backend_summary['mean_wind_speed']) == pytest.approx(rebuilt_summary['mean_wind_speed'], abs=1e-9), route_name