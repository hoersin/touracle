import json
import sys
import time
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore


_MINI_GPX = """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<gpx version=\"1.1\" creator=\"pytest\" xmlns=\"http://www.topografix.com/GPX/1/1\">
  <trk>
    <name>Optimizer Test Route</name>
    <trkseg>
      <trkpt lat=\"55.0000\" lon=\"10.0000\"><ele>12</ele></trkpt>
      <trkpt lat=\"55.1000\" lon=\"10.7000\"><ele>24</ele></trkpt>
      <trkpt lat=\"55.1500\" lon=\"11.3000\"><ele>18</ele></trkpt>
    </trkseg>
  </trk>
</gpx>
"""


@pytest.fixture
def isolated_optimizer_backend(monkeypatch, tmp_path):
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

    def _fake_offline_stats(lat, lon, month, day, **kwargs):
        return {
            '_offline': True,
            'temperature_c': 17.0,
            'temp_day_median': 18.0,
            'precipitation_mm': 0.4,
            'rain_probability': 0.12,
            'wind_speed_ms': 6.5,
            'wind_dir_deg': 90.0,
        }

    monkeypatch.setattr(backend_app, '_get_offline_stats', _fake_offline_stats)
    return backend_app.app.test_client()


def test_tour_slot_optimizer_api_start_and_result(isolated_optimizer_backend):
    client = isolated_optimizer_backend

    upload_resp = client.post('/api/upload_gpx_text', json={'name': 'optimizer-test.gpx', 'content': _MINI_GPX})
    assert upload_resp.status_code == 200

    start_resp = client.post('/api/tour_slot_optimizer/start', json={
        'totalDays': 7,
        'restDayIndexes': [3],
        'directionMode': 'auto_compare',
        'objectiveMode': 'lowest_precip_sum',
        'slotGranularity': 'day',
        'horizonYears': 3,
        'topN': 3,
        'anchorYear': 2026,
    })
    assert start_resp.status_code == 200
    start_payload = start_resp.get_json() or {}
    job_id = str(start_payload.get('job_id') or '')
    assert job_id

    done_payload = None
    for _ in range(80):
        res = client.get(f'/api/tour_slot_optimizer/result/{job_id}')
        assert res.status_code == 200
        payload = res.get_json() or {}
        status = str(payload.get('status') or '')
        if status in ('done', 'error'):
            done_payload = payload
            break
        time.sleep(0.05)

    assert done_payload is not None
    assert done_payload.get('status') == 'done'
    result = done_payload.get('result') or {}
    assert result.get('candidates')
    assert result.get('meta', {}).get('direction_mode') == 'auto_compare'
    assert result.get('meta', {}).get('objective_mode') == 'lowest_precip_sum'
    assert result.get('meta', {}).get('slot_granularity') == 'day'
    assert int(result.get('meta', {}).get('slot_step_days') or 0) == 1
    assert isinstance(result.get('meta', {}).get('slot_sensitivity'), dict)
    assert isinstance(result.get('meta', {}).get('year_penalty_curve'), dict)
    assert isinstance(result.get('meta', {}).get('year_penalty_curve_bundle'), dict)
    assert result.get('candidates')[0].get('direction') in ('forward', 'reverse')
