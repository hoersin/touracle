import io
import json
import re
import sys
import threading
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore


def _make_clients(count: int):
    return [backend_app.app.test_client() for _ in range(int(count))]


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
    monkeypatch.setattr(backend_app, 'STATS_CACHE_DIR', tmp_path / 'stats')
    backend_app.STATS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(backend_app, '_get_offline_stats', lambda *args, **kwargs: None)
    monkeypatch.setattr(backend_app, '_get_offline_store', lambda *args, **kwargs: None)
    monkeypatch.setattr(backend_app, '_offline_strict_enabled', lambda: False)

    def fake_daily_same_day(lat, lon, month, day, years_window=10, start_year=None, end_year=None):
        sy = int(start_year or 2024)
        ey = int(end_year or sy)
        rows = []
        for year in range(sy, ey + 1):
            rows.append(
                {
                    'date': pd.Timestamp(date(year, int(month), int(day))),
                    'tavg': float(15 + (year - sy)),
                    'prcp': float(0.5 + (year - sy) * 0.1),
                    'wspd': 4.0,
                    'wdir': 120.0,
                }
            )
        df = pd.DataFrame(rows)
        df['_provider'] = 'test-provider'
        return df

    def fake_daily_window(lat, lon, start_month, start_day, span_days, years_window=10, start_year=None, end_year=None):
        sy = int(start_year or 2024)
        ey = int(end_year or sy)
        rows = []
        for year in range(sy, ey + 1):
            base_date = date(year, int(start_month), int(start_day))
            for offset in range(int(span_days)):
                current = base_date + timedelta(days=offset)
                rows.append(
                    {
                        'date': pd.Timestamp(current),
                        'tavg': float(15 + offset + (year - sy)),
                        'prcp': float(0.5 + offset * 0.1),
                        'wspd': 4.0,
                        'wdir': 120.0,
                    }
                )
        df = pd.DataFrame(rows)
        df['_provider'] = 'test-provider'
        return df

    def fake_hourly_same_day(lat, lon, month, day, years_window=10, start_year=None, end_year=None):
        sy = int(start_year or 2024)
        ey = int(end_year or sy)
        rows = []
        for year in range(sy, ey + 1):
            for hour, temp in ((10, 14.0), (12, 16.0), (14, 18.0), (16, 17.0)):
                rows.append(
                    {
                        'time': pd.Timestamp(year, int(month), int(day), hour),
                        'temperature_2m': temp,
                    }
                )
        df = pd.DataFrame(rows)
        df['_provider'] = 'test-provider'
        return df

    monkeypatch.setattr(backend_app, 'fetch_daily_weather_same_day', fake_daily_same_day)
    monkeypatch.setattr(backend_app, 'fetch_daily_weather', fake_daily_same_day)
    monkeypatch.setattr(backend_app, 'fetch_daily_weather_window', fake_daily_window)
    monkeypatch.setattr(backend_app, 'fetch_hourly_weather_same_day', fake_hourly_same_day)
    monkeypatch.setattr(backend_app, 'generate_glyph_v2', lambda stats, debug=False: '<svg/>')

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


def _done_event_payload(sse_text: str) -> dict:
    match = re.search(r"event: done\s*data:\s*(\{.*\})", sse_text)
    assert match, f'done event missing from SSE body: {sse_text[:400]}'
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


def test_progress_is_isolated_for_same_job_id(isolated_session_backend):
    client_a, client_b, _ = isolated_session_backend

    session_a = client_a.get('/api/session').get_json()['session_id']
    session_b = client_b.get('/api/session').get_json()['session_id']

    backend_app.progress_init('shared-job', 7, session_id=session_a)
    backend_app.progress_tick('shared-job', 3, session_id=session_a)
    backend_app.progress_done('shared-job', session_id=session_a)
    backend_app.progress_init('shared-job', 9, session_id=session_b)
    backend_app.progress_tick('shared-job', 1, session_id=session_b)
    backend_app.progress_done('shared-job', session_id=session_b)

    progress_a = client_a.get('/api/progress/shared-job').data.decode('utf-8')
    progress_b = client_b.get('/api/progress/shared-job').data.decode('utf-8')

    payload_a = json.loads(progress_a.split('data: ', 1)[1].split('\n\n', 1)[0])
    payload_b = json.loads(progress_b.split('data: ', 1)[1].split('\n\n', 1)[0])

    assert payload_a['total'] == 7
    assert payload_a['completed'] == 7
    assert payload_a['done'] is True
    assert payload_a['session_id'] == session_a
    assert payload_b['total'] == 9
    assert payload_b['completed'] == 9
    assert payload_b['done'] is True
    assert payload_b['session_id'] == session_b


def test_non_dry_run_streams_do_not_cancel_across_sessions(isolated_session_backend, monkeypatch):
    client_a, client_b, _ = isolated_session_backend

    client_a.get('/api/session')
    client_b.get('/api/session')

    slow_started = threading.Event()
    allow_finish = threading.Event()
    original_generate = backend_app.generate_glyph_v2

    def slow_generate(stats, debug=False):
        if not slow_started.is_set():
            slow_started.set()
            allow_finish.wait(timeout=2.0)
        return original_generate(stats, debug=debug)

    monkeypatch.setattr(backend_app, 'generate_glyph_v2', slow_generate)

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

    results = {}

    def run_stream(label, client):
        resp = client.get(f'/api/map_stream?date=02-24&tour_planning=0&mode=single_day&gpx_path={upload_a["path"] if label == "a" else upload_b["path"]}')
        results[label] = resp.data.decode('utf-8')

    thread_a = threading.Thread(target=run_stream, args=('a', client_a))
    thread_a.start()
    assert slow_started.wait(timeout=2.0), 'stream A did not start in time'

    resp_b = client_b.get(f'/api/map_stream?date=02-24&tour_planning=0&mode=single_day&gpx_path={upload_b["path"]}')
    allow_finish.set()
    thread_a.join(timeout=2.0)
    assert not thread_a.is_alive(), 'stream A did not finish'

    body_a = results['a']
    body_b = resp_b.data.decode('utf-8')

    assert 'stream cancelled' not in body_a.lower()
    assert _route_event_payload(body_a)['gpx_path'] == upload_a['path']
    assert _route_event_payload(body_b)['gpx_path'] == upload_b['path']
    assert isinstance(_done_event_payload(body_a).get('stations_count'), int)
    assert isinstance(_done_event_payload(body_b).get('stations_count'), int)


def test_parallel_uploads_keep_many_sessions_isolated(isolated_session_backend):
    _, _, session_file = isolated_session_backend
    clients = _make_clients(6)
    session_ids = []
    for client in clients:
        session_ids.append(client.get('/api/session').get_json()['session_id'])

    assert len(set(session_ids)) == len(session_ids)

    barrier = threading.Barrier(len(clients))
    results = [None] * len(clients)

    def worker(index: int, client):
        barrier.wait(timeout=3.0)
        upload_resp = client.post(
            '/api/upload_gpx',
            data={'file': (io.BytesIO(f'<gpx><trk><name>{index}</name></trk></gpx>'.encode('utf-8')), f'route_{index}.gpx')},
            content_type='multipart/form-data',
        )
        session_resp = client.get('/api/session')
        results[index] = (upload_resp, session_resp)

    threads = [threading.Thread(target=worker, args=(idx, client), name=f'upload-worker-{idx}') for idx, client in enumerate(clients)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5.0)
        assert not thread.is_alive(), f'{thread.name} did not finish'

    upload_paths = []
    for idx, pair in enumerate(results):
        assert pair is not None
        upload_resp, session_resp = pair
        assert upload_resp.status_code == 200
        assert session_resp.status_code == 200
        upload_payload = upload_resp.get_json()
        session_payload = session_resp.get_json()
        upload_paths.append(upload_payload['path'])
        assert session_payload['session_id'] == session_ids[idx]
        assert session_payload['last_gpx_name'] == f'route_{idx}.gpx'
        assert session_payload['last_gpx_path'] == upload_payload['path']
        assert session_ids[idx] in upload_payload['path']
        assert Path(upload_payload['path']).exists()

    assert len(set(upload_paths)) == len(upload_paths)

    persisted = json.loads(session_file.read_text(encoding='utf-8'))
    sessions = persisted.get('sessions') or {}
    for idx, session_id in enumerate(session_ids):
        assert session_id in sessions
        assert sessions[session_id]['last_gpx_name'] == f'route_{idx}.gpx'
        assert sessions[session_id]['last_gpx_path'] in upload_paths


def test_many_non_dry_run_streams_do_not_interfere_across_sessions(isolated_session_backend, monkeypatch):
    clients = _make_clients(4)
    session_ids = [client.get('/api/session').get_json()['session_id'] for client in clients]
    uploads = []
    for idx, client in enumerate(clients):
        payload = client.post(
            '/api/upload_gpx',
            data={'file': (io.BytesIO(f'<gpx><trk><name>{idx}</name></trk></gpx>'.encode('utf-8')), f'route_{idx}.gpx')},
            content_type='multipart/form-data',
        ).get_json()
        uploads.append(payload)

    barrier = threading.Barrier(len(clients))
    original_generate = backend_app.generate_glyph_v2
    first_call_seen = set()
    first_call_lock = threading.Lock()

    def synchronized_generate(stats, debug=False):
        thread_name = threading.current_thread().name
        wait_here = False
        with first_call_lock:
            if thread_name not in first_call_seen:
                first_call_seen.add(thread_name)
                wait_here = True
        if wait_here:
            barrier.wait(timeout=5.0)
        return original_generate(stats, debug=debug)

    monkeypatch.setattr(backend_app, 'generate_glyph_v2', synchronized_generate)

    results = [None] * len(clients)

    def run_stream(index: int, client):
        response = client.get(
            f'/api/map_stream?date=02-24&tour_planning=0&mode=single_day&gpx_path={uploads[index]["path"]}'
        )
        results[index] = response.data.decode('utf-8')

    threads = [threading.Thread(target=run_stream, args=(idx, client), name=f'stream-worker-{idx}') for idx, client in enumerate(clients)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=8.0)
        assert not thread.is_alive(), f'{thread.name} did not finish'

    for idx, body in enumerate(results):
        assert body is not None
        route_payload = _route_event_payload(body)
        done_payload = _done_event_payload(body)
        assert 'stream cancelled' not in body.lower()
        assert route_payload['gpx_path'] == uploads[idx]['path']
        assert session_ids[idx] in route_payload['gpx_path']
        assert isinstance(done_payload.get('stations_count'), int)