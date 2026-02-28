"""Meteostat-backed daily weather retrieval.

This module is used as a fallback when Open-Meteo is unavailable (e.g. hard 429/day limit).
It returns DataFrames compatible with the Open-Meteo daily schema used in this project:
columns: date, tavg, prcp, wspd, wdir.

Notes:
- Meteostat Daily `wspd` is km/h. The rest of the pipeline converts km/h → m/s at stats time.
- Disk caching is implemented under `project/cache/meteostat_daily`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional
import logging

import pandas as pd

log = logging.getLogger('pipeline.weather.meteostat')

BASE_DIR = Path(__file__).resolve().parents[1]
CACHE_DIR = BASE_DIR / 'cache' / 'meteostat_daily'
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _as_float(v) -> float:
    try:
        return float(v)
    except Exception:
        return float('nan')


def _cache_path_range(lat: float, lon: float, start: date, end: date) -> Path:
    lat2 = round(float(lat), 2)
    lon2 = round(float(lon), 2)
    s = start.isoformat().replace('-', '')
    e = end.isoformat().replace('-', '')
    return CACHE_DIR / f"daily_range_lat{lat2:.2f}_lon{lon2:.2f}_{s}_{e}.csv"


def _load_range_cache(path: Path) -> Optional[pd.DataFrame]:
    if not path.exists():
        return None
    try:
        df = pd.read_csv(path)
        # Treat empty caches as stale/invalid: refetch upstream.
        if df is None or df.empty:
            return None
        if 'date' not in df.columns:
            return None
        df['date'] = pd.to_datetime(df['date'], errors='coerce')
        for c in ['tavg', 'prcp', 'wspd', 'wdir']:
            if c in df.columns:
                df[c] = pd.to_numeric(df[c], errors='coerce')
        df['_provider'] = 'meteostat'
        log.info('[CACHE] hit %s', path.name)
        return df
    except Exception as e:
        log.warning('[CACHE] read failed %s: %s', path.name, e)
        return None


def _save_range_cache(path: Path, df: pd.DataFrame) -> None:
    try:
        if df is None or df.empty:
            return
        # Only persist core columns.
        cols = [c for c in ['date', 'tavg', 'prcp', 'wspd', 'wdir'] if c in df.columns]
        df2 = df[cols].copy()
        df2.to_csv(path, index=False)
        log.info('[CACHE] save %s', path.name)
    except Exception:
        pass


def _fetch_daily_range_meteostat(lat: float, lon: float, start: date, end: date) -> pd.DataFrame:
    """Fetch Meteostat Daily for a concrete [start, end] range (single year window).

    Returns a DataFrame with columns date,tavg,prcp,wspd,wdir.
    """
    try:
        # Meteostat v2.x exposes functional APIs: `daily(station_id, start, end)`.
        from meteostat import Point, daily  # type: ignore
        from meteostat.api.stations import stations  # type: ignore
    except Exception as e:
        raise RuntimeError('meteostat is not available') from e

    path = _cache_path_range(lat, lon, start, end)
    cached = _load_range_cache(path)
    if cached is not None:
        return cached

    def _normalize_columns(df_in: pd.DataFrame) -> pd.DataFrame:
        # Meteostat sometimes uses enum values as column keys; normalize to plain strings.
        cols = []
        for c in df_in.columns:
            if hasattr(c, 'value'):
                cols.append(getattr(c, 'value'))
            else:
                cols.append(str(c).strip())
        df_in = df_in.copy()
        df_in.columns = cols
        return df_in

    pt = Point(float(lat), float(lon))
    log.info('[METEOSTAT] fetching lat=%.4f lon=%.4f %s..%s', float(lat), float(lon), start.isoformat(), end.isoformat())

    # IMPORTANT: `daily(Point(...))` converts the point into a *virtual* station ($0001)
    # which has no file in the central repository. We therefore select nearby real stations.
    station_candidates = []
    try:
        nearby = stations.nearby(pt, radius=75000, limit=10)
        station_candidates = list(nearby.index.astype(str))
    except Exception as e:
        log.warning('[METEOSTAT] stations.nearby failed: %s', e)

    if not station_candidates:
        return pd.DataFrame(columns=['date', 'tavg', 'prcp', 'wspd', 'wdir'])

    df_source = None
    used_station = None
    for station_id in station_candidates:
        try:
            ts = daily(station_id, start, end)
            df_try = ts.fetch(sources=False)
            if df_try is None or df_try.empty:
                continue
            df_source = _normalize_columns(df_try)
            used_station = station_id
            break
        except Exception as e:
            log.info('[METEOSTAT] station %s failed: %s', station_id, e)
            continue

    if df_source is None or df_source.empty:
        return pd.DataFrame(columns=['date', 'tavg', 'prcp', 'wspd', 'wdir'])

    # Meteostat daily schema uses `temp` for mean temperature.
    df_source = df_source.copy()
    if 'time' in df_source.columns:
        df_source = df_source.rename(columns={'time': 'date'})

    if isinstance(df_source.index, pd.DatetimeIndex):
        date_series = df_source.index
    else:
        date_series = pd.to_datetime(df_source.get('date'), errors='coerce')

    tavg = df_source['temp'] if 'temp' in df_source.columns else df_source.get('tavg')
    if tavg is None:
        if {'tmin', 'tmax'}.issubset(df_source.columns):
            tavg = (pd.to_numeric(df_source['tmin'], errors='coerce') + pd.to_numeric(df_source['tmax'], errors='coerce')) / 2.0
        else:
            tavg = pd.Series([float('nan')] * len(df_source))

    out = pd.DataFrame({
        'date': pd.to_datetime(date_series, errors='coerce'),
        'tavg': pd.to_numeric(tavg, errors='coerce'),
        'prcp': pd.to_numeric(df_source['prcp'], errors='coerce') if 'prcp' in df_source.columns else float('nan'),
        # Meteostat Daily `wspd` is km/h.
        'wspd': pd.to_numeric(df_source['wspd'], errors='coerce') if 'wspd' in df_source.columns else float('nan'),
        'wdir': pd.to_numeric(df_source['wdir'], errors='coerce') if 'wdir' in df_source.columns else float('nan'),
    })
    out['_provider'] = 'meteostat'
    if used_station is not None:
        out['_meteostat_station'] = used_station

    _save_range_cache(path, out)
    return out


def fetch_daily_weather_same_day_meteostat(
    lat: float,
    lon: float,
    month: int,
    day: int,
    years_window: int = 10,
    start_year: int | None = None,
    end_year: int | None = None,
) -> pd.DataFrame:
    """Fetch only the specific calendar day per year across the requested years via Meteostat."""
    today = date.today()
    default_end = today.year - 1
    if end_year is None:
        end_year = default_end
    else:
        end_year = min(int(end_year), default_end)
    if start_year is None:
        start_year = int(end_year) - int(years_window) + 1
    else:
        start_year = int(start_year)
    if int(end_year) < int(start_year):
        return pd.DataFrame([])

    rows = []
    for y in range(int(start_year), int(end_year) + 1):
        try:
            d0 = date(y, int(month), int(day))
        except ValueError:
            continue
        dfy = _fetch_daily_range_meteostat(lat, lon, d0, d0)
        if dfy is None or dfy.empty:
            continue
        # Expect 1 row.
        for _, r in dfy.iterrows():
            rows.append({
                'date': pd.to_datetime(r.get('date'), errors='coerce'),
                'tavg': _as_float(r.get('tavg')),
                'prcp': _as_float(r.get('prcp')),
                'wspd': _as_float(r.get('wspd')),
                'wdir': _as_float(r.get('wdir')),
                '_provider': 'meteostat',
            })

    df = pd.DataFrame(rows)
    if df.empty:
        log.info('[METEOSTAT] Rows retrieved (oneday per-year): 0')
        return df
    df['date'] = pd.to_datetime(df['date'], errors='coerce')
    for c in ['tavg', 'prcp', 'wspd', 'wdir']:
        df[c] = pd.to_numeric(df[c], errors='coerce')
    log.info('[METEOSTAT] Rows retrieved (oneday per-year): %d', len(df))
    return df


def fetch_daily_weather_window_meteostat(
    lat: float,
    lon: float,
    start_month: int,
    start_day: int,
    span_days: int,
    years_window: int = 10,
    start_year: int | None = None,
    end_year: int | None = None,
) -> pd.DataFrame:
    """Fetch daily weather for a contiguous date window per year across the requested years via Meteostat."""
    span_days = int(span_days)
    if span_days < 1:
        raise ValueError('span_days must be >= 1')
    if span_days > 180:
        log.warning('[METEOSTAT] tour span_days=%d capped to 180', span_days)
        span_days = 180

    today = date.today()
    default_end = today.year - 1
    if end_year is None:
        end_year = default_end
    else:
        end_year = min(int(end_year), default_end)
    if start_year is None:
        start_year = int(end_year) - int(years_window) + 1
    else:
        start_year = int(start_year)
    if int(end_year) < int(start_year):
        return pd.DataFrame([])

    rows = []
    for y in range(int(start_year), int(end_year) + 1):
        try:
            d0 = date(y, int(start_month), int(start_day))
        except ValueError:
            continue
        d1 = d0 + timedelta(days=span_days - 1)
        dfy = _fetch_daily_range_meteostat(lat, lon, d0, d1)
        if dfy is None or dfy.empty:
            continue
        for _, r in dfy.iterrows():
            rows.append({
                'date': pd.to_datetime(r.get('date'), errors='coerce'),
                'tavg': _as_float(r.get('tavg')),
                'prcp': _as_float(r.get('prcp')),
                'wspd': _as_float(r.get('wspd')),
                'wdir': _as_float(r.get('wdir')),
                '_provider': 'meteostat',
            })

    df = pd.DataFrame(rows)
    if df.empty:
        log.info('[METEOSTAT] Rows retrieved (window per-year): 0')
        return df
    df['date'] = pd.to_datetime(df['date'], errors='coerce')
    for c in ['tavg', 'prcp', 'wspd', 'wdir']:
        df[c] = pd.to_numeric(df[c], errors='coerce')
    log.info('[METEOSTAT] Rows retrieved (window per-year): %d', len(df))
    return df
