import sys
import time
from datetime import date
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import weather_service as weather_service_module  # type: ignore
from weather_service import WeatherService  # type: ignore


@pytest.fixture
def isolated_weather_service(monkeypatch, tmp_path):
    cache_dir = tmp_path / 'openmeteo_daily'
    cache_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(weather_service_module, 'CACHE_DIR', cache_dir)
    monkeypatch.setattr(weather_service_module, 'RATE_LIMIT_SECONDS', 0.05)
    monkeypatch.setattr(weather_service_module, '_api_disabled_until', 0.0)

    class _Resp:
        status_code = 200

        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    request_stamps = []

    def fake_get(url, timeout=30):
        request_stamps.append(time.time())
        return _Resp({'daily': {'time': ['2025-03-12']}})

    monkeypatch.setattr(weather_service_module.requests, 'get', fake_get)

    WeatherService.memory_cache = {}
    WeatherService.pending = {}
    WeatherService.last_request_ts = 0.0
    weather_service_module.reset_api_disable()
    WeatherService.ensure_started()

    return request_stamps


def test_sequential_daily_no_overlap(isolated_weather_service):
    request_stamps = isolated_weather_service
    lat, lon = 43.5, -1.5
    end_year = date.today().year - 1
    start_year = end_year - 3
    stamps = []
    for year in range(start_year, end_year + 1):
        WeatherService.get_weather(lat, lon, year, 3, 12, dry_run=False, kind='daily')
        stamps.append(time.time())
    deltas = [request_stamps[i] - request_stamps[i - 1] for i in range(1, len(request_stamps))]
    assert len(request_stamps) == (end_year - start_year + 1)
    assert all(delta >= weather_service_module.RATE_LIMIT_SECONDS * 0.95 for delta in deltas)
    assert len(stamps) == (end_year - start_year + 1)


def test_mixed_daily_hourly_no_overlap(isolated_weather_service):
    request_stamps = isolated_weather_service
    lat, lon = 43.5, -1.5
    year = date.today().year - 1
    WeatherService.get_weather(lat, lon, year, 3, 12, dry_run=False, kind='daily')
    WeatherService.get_weather(lat, lon, year, 3, 12, dry_run=False, kind='hourly')
    assert len(request_stamps) == 2
    assert (request_stamps[1] - request_stamps[0]) >= weather_service_module.RATE_LIMIT_SECONDS * 0.95
