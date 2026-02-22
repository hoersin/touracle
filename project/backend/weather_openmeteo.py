"""Open-Meteo historical daily weather retrieval.
Provides a unified interface `fetch_daily_weather(lat, lon, month, day, years_window=10)`
which returns a pandas DataFrame with columns: date, tavg, prcp, wspd, wdir.
Requests only single calendar days per year (no multi-year windows).
"""
from datetime import date, timedelta
from typing import Tuple, Optional
import logging
import requests
import time as time_module
import random
import pandas as pd
from pathlib import Path
import json
import calendar
import threading
from weather_service import WeatherService
from weather_meteostat import (
    fetch_daily_weather_same_day_meteostat,
    fetch_daily_weather_window_meteostat,
)

log = logging.getLogger('pipeline.weather.openmeteo')

# Rate limiting state with adaptive backoff
_LAST_REQUEST_TS: float = 0.0
_BASE_INTERVAL_SEC: float = 1.00  # Max 1 request per second
_MIN_INTERVAL_SEC: float = _BASE_INTERVAL_SEC
_MAX_INTERVAL_SEC: float = 1.0

# Circuit breaker: temporarily disable outbound API calls after 429s
_API_DISABLED_UNTIL: float = 0.0
_FORCE_ONLINE: bool = False

# Cache directory for raw daily responses
BASE_DIR = Path(__file__).resolve().parents[1]
CACHE_DIR = BASE_DIR / 'cache' / 'openmeteo_daily'
CACHE_DIR.mkdir(parents=True, exist_ok=True)
CB_FILE = CACHE_DIR / 'api_disabled_until.txt'

# Global rate limiter and de-duplication structures
_RATE_LOCK = threading.Lock()
_PENDING_REQUESTS: dict = {}

class _Pending:
    def __init__(self):
        self.event = threading.Event()
        self.response: Optional[requests.Response] = None
        self.error: Optional[Exception] = None

def _mark_api_disabled(seconds: float = 60.0):
    """Disable real HTTP requests for a period to avoid hammering the API."""
    global _API_DISABLED_UNTIL
    _API_DISABLED_UNTIL = time_module.time() + max(0.0, float(seconds))
    until_s = int(_API_DISABLED_UNTIL - time_module.time())
    log.warning('[API] disabled for ~%ds due to 429', until_s)
    # Persist disabled-until to file for debug reloader multi-process
    try:
        with open(CB_FILE, 'w', encoding='utf-8') as f:
            f.write(str(_API_DISABLED_UNTIL))
    except Exception:
        pass

def reset_api_disable():
    """Manually re-enable outbound API calls and reset pacing to defaults."""
    global _API_DISABLED_UNTIL, _MIN_INTERVAL_SEC, _LAST_REQUEST_TS
    _API_DISABLED_UNTIL = 0.0
    _MIN_INTERVAL_SEC = _BASE_INTERVAL_SEC
    _LAST_REQUEST_TS = 0.0
    log.info('[API] circuit breaker reset; online requests re-enabled')
    # Clear persisted disabled state file
    try:
        if CB_FILE.exists():
            CB_FILE.unlink()
    except Exception:
        pass

def set_force_online(flag: bool):
    global _FORCE_ONLINE
    _FORCE_ONLINE = bool(flag)
    log.info('[API] force_online=%s', _FORCE_ONLINE)

def _sync_disabled_from_file():
    global _API_DISABLED_UNTIL
    try:
        if CB_FILE.exists():
            txt = CB_FILE.read_text(encoding='utf-8').strip()
            val = float(txt) if txt else 0.0
            _API_DISABLED_UNTIL = max(_API_DISABLED_UNTIL, val)
    except Exception:
        pass

def perform_request_dedup(url: str) -> requests.Response:
    """Perform a request with de-duplication: if the same URL is in-flight,
    wait for the existing result. Uses global rate limiter under the hood.
    """
    key = str(url)
    # Check for in-flight duplicate
    with _RATE_LOCK:
        pending = _PENDING_REQUESTS.get(key)
        if pending is not None:
            log.info('[API] duplicate detected; waiting for result url=%s', url)
            wait_event = pending.event
        else:
            # Register new pending
            pending = _Pending()
            _PENDING_REQUESTS[key] = pending
            wait_event = None
    if wait_event is not None:
        wait_event.wait()
        if pending.error:
            raise pending.error
        return pending.response  # type: ignore
    # Execute fresh request
    try:
        resp = rate_limited_request(url)
        with _RATE_LOCK:
            pending.response = resp
            pending.event.set()
        return resp
    except Exception as e:
        with _RATE_LOCK:
            pending.error = e
            pending.event.set()
        raise

def _cache_path(lat2: float, lon2: float, month: int, day: int) -> Path:
    name = f"daily_lat{lat2:.1f}_lon{lon2:.1f}_m{month:02d}_d{day:02d}.json"
    return CACHE_DIR / name

def _cache_path_oneday_year(lat2: float, lon2: float, year: int, month: int, day: int) -> Path:
    name = f"daily_oneday_lat{lat2:.1f}_lon{lon2:.1f}_y{year}_m{month:02d}_d{day:02d}.json"
    return CACHE_DIR / name


def _build_url(lat: float, lon: float, start: date, end: date) -> str:
    base = "https://archive-api.open-meteo.com/v1/archive"
    params = (
        f"latitude={lat:.6f}&longitude={lon:.6f}"
        f"&start_date={start.isoformat()}&end_date={end.isoformat()}"
        "&daily=temperature_2m_mean,precipitation_sum,windspeed_10m_mean,winddirection_10m_dominant"
        "&timezone=UTC"
    )
    return f"{base}?{params}"


def _adjust_interval_on_429():
    global _MIN_INTERVAL_SEC
    _MIN_INTERVAL_SEC = min(_MIN_INTERVAL_SEC * 2.0, _MAX_INTERVAL_SEC)
    log.warning('[API] backoff: interval=%.2fs', _MIN_INTERVAL_SEC)

def _adjust_interval_on_success():
    global _MIN_INTERVAL_SEC
    if _MIN_INTERVAL_SEC > _BASE_INTERVAL_SEC:
        _MIN_INTERVAL_SEC = max(_BASE_INTERVAL_SEC, _MIN_INTERVAL_SEC * 0.9)
        log.info('[API] interval relaxed: %.2fs', _MIN_INTERVAL_SEC)

def rate_limited_request(url: str) -> requests.Response:
    """Perform a GET request with global 1 rps pacing and 429 backoff.
    Retries with delays 1s, 2s, 4s (max 3 retries). After that, enable 60s circuit breaker.
    """
    global _LAST_REQUEST_TS
    _sync_disabled_from_file()
    if (not _FORCE_ONLINE) and (time_module.time() < _API_DISABLED_UNTIL):
        class _DummyResp:
            status_code = 429
            def json(self):
                return {}
        log.warning('[API] skipped (circuit breaker active)')
        return _DummyResp()
    # Global rate limiter: max 1 request/sec
    with _RATE_LOCK:
        now = time_module.time()
        elapsed = now - _LAST_REQUEST_TS
        if elapsed < _MIN_INTERVAL_SEC:
            sleep_s = (_MIN_INTERVAL_SEC - elapsed)
            log.info('[API] queued (rate limiter) sleep=%.2fs', sleep_s)
            time_module.sleep(max(0.0, sleep_s))
        _LAST_REQUEST_TS = time_module.time()

    attempts = 0
    delays = [1, 2, 4]
    while True:
        log.info('[API] start %s', url)
        resp = requests.get(url, timeout=30)
        if resp.status_code != 429:
            _adjust_interval_on_success()
            return resp
        _adjust_interval_on_429()
        if attempts < len(delays):
            delay = delays[attempts]
            log.warning('[API] 429; retrying in %ds (attempt %d)', delay, attempts+1)
            time_module.sleep(delay)
            attempts += 1
            continue
        # After retries, open circuit for 60s
        try:
            _mark_api_disabled(60.0)
        except Exception:
            pass
        return resp


def _load_cache(lat2: float, lon2: float, month: int, day: int) -> Optional[dict]:
    path = _cache_path(lat2, lon2, month, day)
    if path.exists():
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            log.info('[CACHE] hit %s', path.name)
            return data
        except Exception:
            pass
    log.info('[CACHE] miss lat=%.2f lon=%.2f m=%02d d=%02d', lat2, lon2, month, day)
    return None


def _save_cache(lat2: float, lon2: float, month: int, day: int, data: dict) -> None:
    path = _cache_path(lat2, lon2, month, day)
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f)
    except Exception:
        pass

def _load_cache_oneday_year(lat2: float, lon2: float, year: int, month: int, day: int) -> Optional[dict]:
    path = _cache_path_oneday_year(lat2, lon2, year, month, day)
    if path.exists():
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            log.info('[API] cache hit %s', path.name)
            log.info('[API] skipped (cached)')
            return data
        except Exception:
            pass
    log.info('[CACHE] miss (oneday) lat=%.1f lon=%.1f y=%04d m=%02d d=%02d', lat2, lon2, year, month, day)
    return None

def _save_cache_oneday_year(lat2: float, lon2: float, year: int, month: int, day: int, data: dict) -> None:
    path = _cache_path_oneday_year(lat2, lon2, year, month, day)
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f)
    except Exception:
        pass


def fetch_daily_weather(lat: float, lon: float, month: int, day: int, years_window: int = 10) -> Optional[pd.DataFrame]:
    """Wrapper to enforce single-day-per-year fetching.
    Delegates to `fetch_daily_weather_same_day` to avoid multi-year windows.
    """
    return fetch_daily_weather_same_day(lat, lon, month, day, years_window=years_window)

# --- Hourly single-day helpers and fetcher ---
def _cache_path_hourly_oneday(lat2: float, lon2: float, month: int, day: int) -> Path:
    name = f"hourly_oneday_lat{lat2:.1f}_lon{lon2:.1f}_m{month:02d}_d{day:02d}.json"
    return CACHE_DIR / name

def _load_cache_hourly_oneday(lat2: float, lon2: float, month: int, day: int) -> Optional[dict]:
    path = _cache_path_hourly_oneday(lat2, lon2, month, day)
    if path.exists():
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            log.info('[CACHE] hit %s', path.name)
            return data
        except Exception:
            pass
    log.info('[CACHE] miss (hourly oneday) lat=%.1f lon=%.1f m=%02d d=%02d', lat2, lon2, month, day)
    return None

def _save_cache_hourly_oneday(lat2: float, lon2: float, month: int, day: int, data: dict) -> None:
    path = _cache_path_hourly_oneday(lat2, lon2, month, day)
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f)
    except Exception:
        pass

def _build_url_hourly(lat: float, lon: float, d: date) -> str:
    base = "https://archive-api.open-meteo.com/v1/archive"
    params = (
        f"latitude={lat:.6f}&longitude={lon:.6f}"
        f"&start_date={d.isoformat()}&end_date={d.isoformat()}"
        "&hourly=temperature_2m"
        "&timezone=auto"
    )
    return f"{base}?{params}"

def _build_url_hourly_range(lat: float, lon: float, start: date, end: date) -> str:
    base = "https://archive-api.open-meteo.com/v1/archive"
    params = (
        f"latitude={lat:.6f}&longitude={lon:.6f}"
        f"&start_date={start.isoformat()}&end_date={end.isoformat()}"
        "&hourly=temperature_2m"
        "&timezone=auto"
    )
    return f"{base}?{params}"

def fetch_hourly_weather_same_day(lat: float, lon: float, month: int, day: int, years_window: int = 10) -> Optional[pd.DataFrame]:
    """Fetch hourly temperature for the specific calendar day per year.
    One request per year: start_date=end_date=YYYY-MM-DD. Aggregates rows across years.
    """
    lat2 = round(lat, 1)
    lon2 = round(lon, 1)
    cached = _load_cache_hourly_oneday(lat2, lon2, month, day)
    if cached is not None:
        data_all = cached
    else:
        today = date.today()
        start_year = today.year - years_window
        end_year = today.year - 1
        rows = []
        for y in range(start_year, end_year + 1):
            try:
                d = date(y, month, day)
            except ValueError:
                log.warning('[API] Skipping invalid date %04d-%02d-%02d', y, month, day)
                continue
            try:
                j = WeatherService.get_weather(lat2, lon2, y, month, day, dry_run=False, kind='hourly')
            except Exception as e:
                log.warning('[API] hourly fetch failed y=%d: %s', y, e)
                continue
            hourly = j.get('hourly', {}) or {}
            times = hourly.get('time', [])
            temps = hourly.get('temperature_2m', [])
            if times and temps and len(times) == len(temps):
                for t, temp in zip(times, temps):
                    try:
                        dt = pd.to_datetime(t)
                        rows.append({'time': t, 'temperature_2m': temp, 'date': dt.date().isoformat()})
                    except Exception:
                        continue
        data_all = {'rows': rows}
        try:
            _save_cache_hourly_oneday(lat2, lon2, month, day, data_all)
        except Exception:
            pass
    df = pd.DataFrame(data_all.get('rows', []))
    if len(df) == 0:
        raise Exception('Open-Meteo returned zero rows for hourly single-day mode')
    try:
        df['time'] = pd.to_datetime(df['time'])
    except Exception:
        pass
    return df

def fetch_daily_weather_same_day(lat: float, lon: float, month: int, day: int, years_window: int = 10) -> Optional[pd.DataFrame]:
    """Fetch only the specific calendar day per year across the last `years_window` years.
    One request per year: start_date=end_date=YYYY-MM-DD. Uses 0.1° rounded coords and per-year cache.
    """
    lat2 = round(lat, 1)
    lon2 = round(lon, 1)
    today = date.today()
    start_year = today.year - years_window
    end_year = today.year - 1
    rows = []
    for y in range(start_year, end_year + 1):
        # Check per-year cache first
        cached = _load_cache_oneday_year(lat2, lon2, y, month, day)
        if cached is not None:
            daily = cached.get('daily', {}) or {}
            times = daily.get('time', [])
            tavg = daily.get('temperature_2m_mean', [])
            prcp = daily.get('precipitation_sum', [])
            wspd = daily.get('windspeed_10m_mean', [])
            wdir = daily.get('winddirection_10m_dominant', [])
            if times:
                rows.append({
                    'date': pd.to_datetime(times[0]),
                    'tavg': pd.to_numeric(pd.Series(tavg), errors='coerce')[0] if tavg else pd.NA,
                    'prcp': pd.to_numeric(pd.Series(prcp), errors='coerce')[0] if prcp else pd.NA,
                    'wspd': pd.to_numeric(pd.Series(wspd), errors='coerce')[0] if wspd else pd.NA,
                    'wdir': pd.to_numeric(pd.Series(wdir), errors='coerce')[0] if wdir else pd.NA,
                })
            continue
        try:
            d = date(y, month, day)
        except ValueError:
            log.warning('[API] Skipping invalid date %04d-%02d-%02d', y, month, day)
            continue
        try:
            j = WeatherService.get_weather(lat2, lon2, y, month, day, dry_run=False, kind='daily')
        except Exception as e:
            log.warning('[API] daily fetch failed y=%d: %s', y, e)
            continue
        daily = j.get('daily', {}) or {}
        times = daily.get('time', [])
        tavg = daily.get('temperature_2m_mean', [])
        prcp = daily.get('precipitation_sum', [])
        wspd = daily.get('windspeed_10m_mean', [])
        wdir = daily.get('winddirection_10m_dominant', [])
        if times:
            rows.append({
                'date': pd.to_datetime(times[0]),
                'tavg': pd.to_numeric(pd.Series(tavg), errors='coerce')[0] if tavg else pd.NA,
                'prcp': pd.to_numeric(pd.Series(prcp), errors='coerce')[0] if prcp else pd.NA,
                'wspd': pd.to_numeric(pd.Series(wspd), errors='coerce')[0] if wspd else pd.NA,
                'wdir': pd.to_numeric(pd.Series(wdir), errors='coerce')[0] if wdir else pd.NA,
            })
        # Save cache per year
        # Disk cache is handled inside WeatherService for daily
    df = pd.DataFrame(rows)
    if len(df) == 0:
        log.info('[WEATHER] Rows retrieved (oneday per-year): 0')
        # Fallback: Meteostat (useful when Open-Meteo is hard rate-limited)
        try:
            df2 = fetch_daily_weather_same_day_meteostat(lat, lon, month, day, years_window=years_window)
            if df2 is not None and len(df2) > 0:
                log.info('[WEATHER] Fallback provider=Meteostat rows=%d', len(df2))
                return df2
        except Exception as e:
            log.warning('[WEATHER] Meteostat fallback failed: %s', e)
        return df
    df['date'] = pd.to_datetime(df['date'])
    for c in ['tavg','prcp','wspd','wdir']:
        df[c] = pd.to_numeric(df[c], errors='coerce')
    df['_provider'] = 'openmeteo'
    log.info('[WEATHER] Rows retrieved (oneday per-year): %d', len(df))
    return df


def fetch_daily_weather_window(lat: float, lon: float, start_month: int, start_day: int, span_days: int, years_window: int = 10) -> Optional[pd.DataFrame]:
    """Fetch daily weather for a contiguous date window per year across the last `years_window` years.

    This is an optimization for tour mode: instead of one API call per (year, day), it does
    one API call per year for the full window and builds a DataFrame with columns:
    date, tavg, prcp, wspd, wdir.

    The resulting DataFrame can be filtered by (month, day) to compute per-tour-day stats.
    """
    lat2 = round(lat, 1)
    lon2 = round(lon, 1)
    span_days = int(span_days)
    if span_days < 1:
        raise ValueError('span_days must be >= 1')
    # Avoid extremely large window fetches; tours are typically far smaller.
    if span_days > 180:
        log.warning('[API] tour span_days=%d capped to 180', span_days)
        span_days = 180

    def _to_float(v):
        try:
            fv = float(v)
            return fv
        except Exception:
            return float('nan')

    today = date.today()
    start_year = today.year - years_window
    end_year = today.year - 1
    rows = []

    for y in range(start_year, end_year + 1):
        try:
            d0 = date(y, int(start_month), int(start_day))
        except ValueError:
            log.warning('[API] Skipping invalid window start %04d-%02d-%02d', y, int(start_month), int(start_day))
            continue
        d1 = d0 + timedelta(days=span_days - 1)
        try:
            j = WeatherService.get_daily_range(lat2, lon2, d0, d1, dry_run=False)
        except Exception as e:
            log.warning('[API] daily range fetch failed y=%d: %s', y, e)
            continue

        daily = (j or {}).get('daily', {}) or {}
        times = daily.get('time', []) or []
        tavg = daily.get('temperature_2m_mean', []) or []
        prcp = daily.get('precipitation_sum', []) or []
        wspd = daily.get('windspeed_10m_mean', []) or []
        wdir = daily.get('winddirection_10m_dominant', []) or []

        if not times:
            continue
        n = min(len(times), len(tavg) if tavg else 0, len(prcp) if prcp else 0, len(wspd) if wspd else 0, len(wdir) if wdir else 0)
        if n <= 0:
            continue

        for i in range(n):
            try:
                dt = pd.to_datetime(times[i])
            except Exception:
                continue
            rows.append({
                'date': dt,
                'tavg': _to_float(tavg[i]) if tavg else float('nan'),
                'prcp': _to_float(prcp[i]) if prcp else float('nan'),
                'wspd': _to_float(wspd[i]) if wspd else float('nan'),
                'wdir': _to_float(wdir[i]) if wdir else float('nan'),
            })

    df = pd.DataFrame(rows)
    if len(df) == 0:
        log.info('[WEATHER] Rows retrieved (window per-year): 0')
        # Fallback: Meteostat (useful when Open-Meteo is hard rate-limited)
        try:
            df2 = fetch_daily_weather_window_meteostat(lat, lon, start_month, start_day, span_days, years_window=years_window)
            if df2 is not None and len(df2) > 0:
                log.info('[WEATHER] Fallback provider=Meteostat rows=%d', len(df2))
                return df2
        except Exception as e:
            log.warning('[WEATHER] Meteostat fallback failed: %s', e)
        return df
    try:
        df['date'] = pd.to_datetime(df['date'])
    except Exception:
        pass
    for c in ['tavg', 'prcp', 'wspd', 'wdir']:
        try:
            df[c] = pd.to_numeric(df[c], errors='coerce')
        except Exception:
            pass
    df['_provider'] = 'openmeteo'
    log.info('[WEATHER] Rows retrieved (window per-year): %d', len(df))
    return df
