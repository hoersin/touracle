import os
import sys
import threading
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import weather_openmeteo  # type: ignore


def test_force_online_is_thread_local(monkeypatch):
    captured = []

    class _Resp:
        status_code = 200

        def json(self):
            return {}

    def fake_get(url, timeout=30):
        captured.append((threading.current_thread().name, url, timeout))
        return _Resp()

    monkeypatch.setattr(weather_openmeteo.requests, 'get', fake_get)
    monkeypatch.setattr(weather_openmeteo, '_sync_disabled_from_file', lambda: None)
    monkeypatch.setattr(weather_openmeteo, '_LAST_REQUEST_TS', 0.0)
    monkeypatch.setattr(weather_openmeteo, '_MIN_INTERVAL_SEC', 0.0)
    monkeypatch.setattr(weather_openmeteo, '_API_DISABLED_UNTIL', time.time() + 60.0)
    weather_openmeteo.set_force_online(False)

    results = {}

    def worker_force_online():
        weather_openmeteo.set_force_online(True)
        resp = weather_openmeteo.rate_limited_request('https://example.com/force-online')
        results['force_online_status'] = resp.status_code
        weather_openmeteo.set_force_online(False)

    def worker_normal():
        resp = weather_openmeteo.rate_limited_request('https://example.com/normal')
        results['normal_status'] = resp.status_code

    thread_a = threading.Thread(target=worker_force_online, name='force-online-thread')
    thread_b = threading.Thread(target=worker_normal, name='normal-thread')
    thread_a.start()
    thread_b.start()
    thread_a.join(timeout=2.0)
    thread_b.join(timeout=2.0)

    assert results['force_online_status'] == 200
    assert results['normal_status'] == 429
    assert len(captured) == 1
    assert captured[0][0] == 'force-online-thread'