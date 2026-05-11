import io
import json
import os
import re
import sys
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore


@pytest.fixture
def isolated_session_backend(monkeypatch, tmp_path):
    data_dir = tmp_path / 'data'
    upload_dir = data_dir
    session_file = data_dir / 'session_state.json'
    data_dir.mkdir(parents=True, exist_ok=True)
    upload_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backend_app, 'DATA_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'UPLOAD_DIR', upload_dir)
    monkeypatch.setattr(backend_app, 'SESSION_FILE', session_file)
    monkeypatch.setattr(backend_app, 'SESSION_STORE', {})
    monkeypatch.setattr(backend_app, 'SESSION_STORE_LOADED', False)

    def fake_sample_route(path_value, step_km=25.0):
        route_feature = {
            'type': 'Feature',
            'geometry': {
                'type': 'LineString',
                'coordinates': [[8.0, 45.0], [8.1, 45.1]],
            },
            'properties': {
                'source_path': str(path_value),
            },
        }
        return [(45.0, 8.0), (45.1, 8.1)], route_feature

    monkeypatch.setattr(backend_app, 'sample_route', fake_sample_route)
    return backend_app.app.test_client(), backend_app.app.test_client(), session_file


def _route_event_payload(sse_text: str) -> dict:
    match = re.search(r"event: route\s*data:\s*(\{.*\})", sse_text)
    assert match, f'route event missing from SSE body: {sse_text[:400]}'
    return json.loads(match.group(1))


def test_session_cookie_and_upload_state_are_isolated(isolated_session_backend):
    client_a, client_b, _ = isolated_session_backend

    resp_a = client_a.get('/api/session')
    resp_b = client_b.get('/api/session')

    assert resp_a.status_code == 200
    assert resp_b.status_code == 200

    session_a = resp_a.get_json()
    session_b = resp_b.get_json()
    assert session_a['session_id'] != session_b['session_id']
    assert 'touracle_session_id=' in resp_a.headers.get('Set-Cookie', '')
    assert 'touracle_session_id=' in resp_b.headers.get('Set-Cookie', '')

    upload_a = client_a.post(
        '/api/upload_gpx',
        data={'file': (io.BytesIO(b'<gpx><trk><name>A</name></trk></gpx>'), 'alpha.gpx')},
        content_type='multipart/form-data',
    )
    upload_b = client_b.post(
        '/api/upload_gpx',
        data={'file': (io.BytesIO(b'<gpx><trk><name>B</name></trk></gpx>'), 'beta.gpx')},
        content_type='multipart/form-data',
    )

    assert upload_a.status_code == 200
    assert upload_b.status_code == 200

    payload_a = upload_a.get_json()
    payload_b = upload_b.get_json()
    assert payload_a['path'] != payload_b['path']
    assert session_a['session_id'] in payload_a['path']
    assert session_b['session_id'] in payload_b['path']
    assert Path(payload_a['path']).exists()
    assert Path(payload_b['path']).exists()

    state_a = client_a.get('/api/session').get_json()
    state_b = client_b.get('/api/session').get_json()

    assert state_a['last_gpx_name'] == 'alpha.gpx'
    assert state_b['last_gpx_name'] == 'beta.gpx'
    assert state_a['last_gpx_path'] == payload_a['path']
    assert state_b['last_gpx_path'] == payload_b['path']
    assert state_a['last_gpx_path'] != state_b['last_gpx_path']


def test_map_stream_uses_session_specific_default_gpx(isolated_session_backend):
    client_a, client_b, _ = isolated_session_backend

    session_a = client_a.get('/api/session').get_json()
    session_b = client_b.get('/api/session').get_json()

    upload_a = client_a.post(
        '/api/upload_gpx',
        data={'file': (io.BytesIO(b'<gpx><trk><name>A</name></trk></gpx>'), 'alpha.gpx')},
        content_type='multipart/form-data',
    ).get_json()
    upload_b = client_b.post(
        '/api/upload_gpx',
        data={'file': (io.BytesIO(b'<gpx><trk><name>B</name></trk></gpx>'), 'beta.gpx')},
        content_type='multipart/form-data',
    ).get_json()

    resp_a = client_a.get('/api/map_stream?date=02-24&tour_planning=0&mode=single_day&dry_run=1')
    resp_b = client_b.get('/api/map_stream?date=02-24&tour_planning=0&mode=single_day&dry_run=1')

    assert resp_a.status_code == 200
    assert resp_b.status_code == 200

    route_a = _route_event_payload(resp_a.data.decode('utf-8'))
    route_b = _route_event_payload(resp_b.data.decode('utf-8'))

    assert route_a['gpx_path'] == upload_a['path']
    assert route_b['gpx_path'] == upload_b['path']
    assert route_a['gpx_path'] != route_b['gpx_path']
    assert session_a['session_id'] in route_a['gpx_path']
    assert session_b['session_id'] in route_b['gpx_path']