"""WeatherService: serialized, cache-first weather retrieval via a worker queue.
- Memory cache
- Disk cache reuse
- Pending request de-duplication
- Single worker thread with global rate limit
- Circuit breaker on 429
"""
from __future__ import annotations
import threading
import time
import logging
import requests
import json
from queue import Queue
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Dict, Tuple
from datetime import date as _date

log = logging.getLogger('pipeline.weather.service')

BASE_DIR = Path(__file__).resolve().parents[1]
CACHE_DIR = BASE_DIR / 'cache' / 'openmeteo_daily'
CACHE_DIR.mkdir(parents=True, exist_ok=True)

RATE_LIMIT_SECONDS = 1.15
_api_disabled_until: float = 0.0
_worker_started = False
_worker_lock = threading.Lock()


def reset_api_disable() -> None:
    """Reset WeatherService's in-process circuit breaker.

    Note: this is separate from the legacy breaker in `weather_openmeteo.py`.
    """
    global _api_disabled_until
    _api_disabled_until = 0.0
    try:
        WeatherService.last_request_ts = 0.0
    except Exception:
        pass
    log.info('[API] WeatherService circuit breaker reset; requests re-enabled')

@dataclass
class _Pending:
    event: threading.Event
    result: Optional[dict] = None
    error: Optional[Exception] = None

class TemporaryAPIUnavailable(Exception):
    pass

class WeatherService:
    memory_cache: Dict[str, dict] = {}
    pending: Dict[str, _Pending] = {}
    request_queue: Queue = Queue()
    worker_thread: Optional[threading.Thread] = None
    last_request_ts: float = 0.0

    @staticmethod
    def _quantize(v: float) -> float:
        # Quantize coordinates to 0.1° exactly
        return round(v, 1)

    @staticmethod
    def _key(lat: float, lon: float, year: int, month: int, day: int, kind: str) -> str:
        qlat = WeatherService._quantize(lat)
        qlon = WeatherService._quantize(lon)
        # Deterministic key with two decimals for display consistency
        return f"{kind}:{qlat:.2f}_{qlon:.2f}_{year}_{month:02d}_{day:02d}"

    @staticmethod
    def _disk_path_daily(lat: float, lon: float, year: int, month: int, day: int) -> Path:
        # Maintain existing disk cache naming with .1f
        qlat = WeatherService._quantize(lat)
        qlon = WeatherService._quantize(lon)
        name = f"daily_oneday_lat{qlat:.1f}_lon{qlon:.1f}_y{year}_m{month:02d}_d{day:02d}.json"
        return CACHE_DIR / name

    @staticmethod
    def _disk_path_daily_range(lat: float, lon: float, start: _date, end: _date) -> Path:
        qlat = WeatherService._quantize(lat)
        qlon = WeatherService._quantize(lon)
        s = start.isoformat().replace('-', '')
        e = end.isoformat().replace('-', '')
        name = f"daily_range_lat{qlat:.1f}_lon{qlon:.1f}_{s}_{e}.json"
        return CACHE_DIR / name

    @staticmethod
    def _build_url_daily(lat: float, lon: float, d: _date) -> str:
        base = "https://archive-api.open-meteo.com/v1/archive"
        params = (
            f"latitude={lat:.6f}&longitude={lon:.6f}"
            f"&start_date={d.isoformat()}&end_date={d.isoformat()}"
            "&daily=temperature_2m_mean,precipitation_sum,windspeed_10m_mean,winddirection_10m_dominant"
            "&timezone=UTC"
        )
        return f"{base}?{params}"

    @staticmethod
    def _build_url_daily_range(lat: float, lon: float, start: _date, end: _date) -> str:
        base = "https://archive-api.open-meteo.com/v1/archive"
        params = (
            f"latitude={lat:.6f}&longitude={lon:.6f}"
            f"&start_date={start.isoformat()}&end_date={end.isoformat()}"
            "&daily=temperature_2m_mean,precipitation_sum,windspeed_10m_mean,winddirection_10m_dominant"
            "&timezone=UTC"
        )
        return f"{base}?{params}"

    @staticmethod
    def _build_url_hourly(lat: float, lon: float, d: _date) -> str:
        base = "https://archive-api.open-meteo.com/v1/archive"
        params = (
            f"latitude={lat:.6f}&longitude={lon:.6f}"
            f"&start_date={d.isoformat()}&end_date={d.isoformat()}"
            "&hourly=temperature_2m"
            "&timezone=auto"
        )
        return f"{base}?{params}"

    @classmethod
    def ensure_started(cls) -> None:
        global _worker_started
        with _worker_lock:
            if _worker_started:
                return
            _worker_started = True
            cls.worker_thread = threading.Thread(target=cls._worker_loop, name='WeatherServiceWorker', daemon=True)
            cls.worker_thread.start()
            log.info('[WORKER] started WeatherService worker')

    @classmethod
    def _worker_loop(cls) -> None:
        global _api_disabled_until
        while True:
            key, params, pending = cls.request_queue.get()
            # Circuit breaker check
            if time.time() < _api_disabled_until:
                log.warning('[API] circuit breaker active; skipping key=%s', key)
                pending.error = TemporaryAPIUnavailable('Circuit breaker active')
                pending.event.set()
                continue
            # Global serialized pace
            now = time.time()
            elapsed = now - cls.last_request_ts
            if elapsed < RATE_LIMIT_SECONDS:
                sleep_s = RATE_LIMIT_SECONDS - elapsed
                log.info('[QUEUE] rate limit wait %.2fs key=%s', sleep_s, key)
                time.sleep(sleep_s)
            cls.last_request_ts = time.time()
            # Build request
            kind = params['kind']
            lat = float(params['lat'])
            lon = float(params['lon'])
            qlat = cls._quantize(lat)
            qlon = cls._quantize(lon)
            if kind in ('daily', 'hourly'):
                d = _date(int(params['year']), int(params['month']), int(params['day']))
                url = cls._build_url_daily(qlat, qlon, d) if kind == 'daily' else cls._build_url_hourly(qlat, qlon, d)
            elif kind == 'daily_range':
                start = _date.fromisoformat(str(params['start']))
                end = _date.fromisoformat(str(params['end']))
                url = cls._build_url_daily_range(qlat, qlon, start, end)
            else:
                pending.error = ValueError(f"Unsupported kind: {kind}")
                pending.event.set()
                continue
            log.info('[WORKER] fetching key=%s url=%s', key, url)
            # Perform with retries
            delays = [1, 2, 4]
            resp = None
            for attempt in range(len(delays) + 1):
                try:
                    resp = requests.get(url, timeout=30)
                    if resp.status_code != 429:
                        break
                    # 429: backoff and continue
                    if attempt < len(delays):
                        delay = delays[attempt]
                        log.warning('[API] 429; backoff %ds (attempt %d) key=%s', delay, attempt+1, key)
                        time.sleep(delay)
                        continue
                except Exception as e:
                    # Network error; last attempt will propagate
                    log.warning('[API] network error: %s key=%s', e, key)
                    if attempt < len(delays):
                        time.sleep(delays[attempt])
                        continue
                    resp = None
                    break
            # Final 429 sets breaker
            if resp is not None and resp.status_code == 429:
                _api_disabled_until = time.time() + 60.0
                log.error('[API] circuit breaker activated for 60s (429)')
                pending.error = TemporaryAPIUnavailable('429 rate-limited')
                pending.event.set()
                continue
            if resp is None:
                pending.error = RuntimeError('Request failed')
                pending.event.set()
                continue
            if resp.status_code != 200:
                pending.error = RuntimeError(f"HTTP {resp.status_code}")
                pending.event.set()
                continue
            try:
                j = resp.json()
            except Exception as e:
                pending.error = e
                pending.event.set()
                continue
            # Persist daily to disk cache (unchanged format)
            if kind == 'daily':
                try:
                    path = cls._disk_path_daily(lat, lon, int(params['year']), int(params['month']), int(params['day']))
                    with open(path, 'w', encoding='utf-8') as f:
                        json.dump(j, f)
                    log.info('[CACHE] disk save %s', path.name)
                except Exception:
                    pass
            elif kind == 'daily_range':
                try:
                    start = _date.fromisoformat(str(params['start']))
                    end = _date.fromisoformat(str(params['end']))
                    path = cls._disk_path_daily_range(lat, lon, start, end)
                    with open(path, 'w', encoding='utf-8') as f:
                        json.dump(j, f)
                    log.info('[CACHE] disk save %s', path.name)
                except Exception:
                    pass
            # Resolve
            pending.result = j
            pending.event.set()
            # Store memory cache
            try:
                cls.memory_cache[key] = j
            except Exception:
                pass

    @classmethod
    def get_weather(cls, lat: float, lon: float, year: int, month: int, day: int, dry_run: bool = False, kind: str = 'daily') -> Optional[dict]:
        """Single entry point for weather fetches. Cache-first, deduped, queued, serialized.
        Returns raw JSON dict or None in dry_run.
        """
        if dry_run:
            log.info('[DRYRUN] skip weather key=%s', f"{lat},{lon}:{year}-{month}-{day}:{kind}")
            return None
        cls.ensure_started()
        key = cls._key(lat, lon, year, month, day, kind)
        # Memory cache
        if key in cls.memory_cache:
            log.info('[CACHE] memory hit key=%s', key)
            return cls.memory_cache[key]
        # Disk cache (daily only)
        if kind == 'daily':
            path = cls._disk_path_daily(lat, lon, year, month, day)
            if path.exists():
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    log.info('[CACHE] disk hit key=%s', key)
                    cls.memory_cache[key] = data
                    return data
                except Exception:
                    pass
        # Pending dedup
        pending = cls.pending.get(key)
        if pending is not None:
            log.info('[QUEUE] duplicate wait key=%s', key)
            pending.event.wait()
            if pending.error:
                raise pending.error
            return pending.result
        # Enqueue new
        pending = _Pending(event=threading.Event())
        cls.pending[key] = pending
        params = {
            'lat': float(lat), 'lon': float(lon), 'year': int(year), 'month': int(month), 'day': int(day), 'kind': kind
        }
        cls.request_queue.put((key, params, pending))
        log.info('[QUEUE] enqueued key=%s', key)
        pending.event.wait()
        # Cleanup pending entry
        try:
            cls.pending.pop(key, None)
        except Exception:
            pass
        if pending.error:
            raise pending.error
        return pending.result

    @classmethod
    def get_daily_range(cls, lat: float, lon: float, start: _date, end: _date, dry_run: bool = False) -> Optional[dict]:
        """Fetch daily archive data for a contiguous date range.
        Cache-first, serialized through the same worker.
        """
        if dry_run:
            log.info('[DRYRUN] skip daily_range lat=%s lon=%s start=%s end=%s', lat, lon, start, end)
            return None
        cls.ensure_started()
        qlat = cls._quantize(float(lat))
        qlon = cls._quantize(float(lon))
        key = f"daily_range:{qlat:.2f}_{qlon:.2f}_{start.isoformat()}_{end.isoformat()}"
        if key in cls.memory_cache:
            log.info('[CACHE] memory hit key=%s', key)
            return cls.memory_cache[key]
        path = cls._disk_path_daily_range(lat, lon, start, end)
        if path.exists():
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                log.info('[CACHE] disk hit key=%s', key)
                cls.memory_cache[key] = data
                return data
            except Exception:
                pass
        pending = cls.pending.get(key)
        if pending is not None:
            log.info('[QUEUE] duplicate wait key=%s', key)
            pending.event.wait()
            if pending.error:
                raise pending.error
            return pending.result
        pending = _Pending(event=threading.Event())
        cls.pending[key] = pending
        params = {
            'lat': float(lat),
            'lon': float(lon),
            'kind': 'daily_range',
            'start': start.isoformat(),
            'end': end.isoformat(),
        }
        cls.request_queue.put((key, params, pending))
        log.info('[QUEUE] enqueued key=%s', key)
        pending.event.wait()
        try:
            cls.pending.pop(key, None)
        except Exception:
            pass
        if pending.error:
            raise pending.error
        try:
            cls.memory_cache[key] = pending.result  # type: ignore[assignment]
        except Exception:
            pass
        return pending.result
