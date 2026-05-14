import json
import sys
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore


@pytest.fixture
def isolated_route_backend(monkeypatch, tmp_path):
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

    return backend_app


def _write_invalid_gpx(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('not valid gpx', encoding='utf-8')


def _parse_sse_blocks(raw_text: str):
    events = []
    for block in raw_text.split('\n\n'):
        if not block.strip():
            continue
        event_name = None
        payload = None
        for line in block.split('\n'):
            if line.startswith('event:'):
                event_name = line.split(':', 1)[1].strip()
            elif line.startswith('data:'):
                payload = line.split(':', 1)[1].strip()
        if not event_name or payload is None:
            continue
        events.append((event_name, json.loads(payload)))
    return events


def test_api_session_clears_invalid_stored_gpx(isolated_route_backend):
    client = isolated_route_backend.app.test_client()
    session_id = client.get('/api/session').get_json()['session_id']
    invalid_gpx = isolated_route_backend._session_upload_dir(session_id) / 'uploaded_invalid.gpx'
    _write_invalid_gpx(invalid_gpx)

    isolated_route_backend.save_session_state(
        {'last_gpx_path': str(invalid_gpx), 'last_gpx_name': 'uploaded_invalid.gpx'},
        session_id=session_id,
    )

    payload = client.get('/api/session').get_json()

    assert payload['gpx_exists'] is False
    assert payload['last_gpx_path'] == ''
    assert payload['last_gpx_name'] == ''

    stored = isolated_route_backend.load_session_state(session_id=session_id)
    assert stored['last_gpx_path'] == ''
    assert stored['last_gpx_name'] == ''


def test_map_stream_emits_fatal_stream_error_for_invalid_gpx(isolated_route_backend):
    client = isolated_route_backend.app.test_client()
    session_id = client.get('/api/session').get_json()['session_id']
    invalid_gpx = isolated_route_backend._session_upload_dir(session_id) / 'uploaded_invalid.gpx'
    _write_invalid_gpx(invalid_gpx)

    response = client.get(
        '/api/map_stream',
        query_string={
            'date': '05-14',
            'dry_run': '1',
            'gpx_path': str(invalid_gpx),
        },
        buffered=True,
    )

    assert response.status_code == 200
    events = _parse_sse_blocks(response.data.decode('utf-8'))
    event_names = [name for name, _ in events]

    assert 'stream_error' in event_names
    assert 'route' not in event_names

    stream_error_payload = next(payload for name, payload in events if name == 'stream_error')
    assert stream_error_payload['code'] == 'route_setup_failed'
    assert stream_error_payload['fatal'] is True
    assert stream_error_payload['gpx_path'] == str(invalid_gpx)
