import time
from datetime import date
from backend.weather_service import WeatherService, RATE_LIMIT_SECONDS


def test_sequential_daily_no_overlap():
    WeatherService.ensure_started()
    lat, lon = 43.5, -1.5
    end_year = date.today().year - 1
    start_year = end_year - 3
    stamps = []
    for y in range(start_year, end_year + 1):
        t0 = time.time()
        WeatherService.get_weather(lat, lon, y, 3, 12, dry_run=False, kind='daily')
        t1 = time.time()
        stamps.append(t1)
    deltas = [stamps[i] - stamps[i-1] for i in range(1, len(stamps))]
    assert all(d >= RATE_LIMIT_SECONDS * 0.95 for d in deltas)


def test_mixed_daily_hourly_no_overlap():
    WeatherService.ensure_started()
    lat, lon = 43.5, -1.5
    y = date.today().year - 1
    t0 = time.time()
    WeatherService.get_weather(lat, lon, y, 3, 12, dry_run=False, kind='daily')
    t1 = time.time()
    WeatherService.get_weather(lat, lon, y, 3, 12, dry_run=False, kind='hourly')
    t2 = time.time()
    assert (t2 - t1) >= RATE_LIMIT_SECONDS * 0.95
