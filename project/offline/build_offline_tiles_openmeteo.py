#!/usr/bin/env python3
"""Build an offline, processed Open‑Meteo tile climatology store.

Design goals:
- restart-safe: commits per tile; partially processed tiles are retried
- low request count: download daily/hourly in multi-year chunks
- store only derived stats needed by the app (no raw provider responses)

This is intentionally conservative and uses a single-threaded request loop.

Usage (10-night split):
  ./.venv/bin/python project/offline/build_offline_tiles_openmeteo.py --chunk-count 10 --chunk-index 0
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests

# Allow running from repo root by adding `project/backend` to sys.path
_BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

# Reuse existing circular wind math (backend module is designed for sys.path imports)
from weather import compute_wind_statistics  # type: ignore


OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clamp_lat(lat: float) -> float:
    return max(-90.0, min(90.0, float(lat)))


@dataclass(frozen=True)
class Tile:
    tile_id: str
    row: int
    col: int
    lat: float
    lon: float


class RateLimiter:
    def __init__(self, min_interval_s: float) -> None:
        self.min_interval_s = float(min_interval_s)
        self._last_ts = 0.0

    def bump(self, factor: float = 1.25, max_interval_s: float = 30.0) -> None:
        """Increase the pacing interval (used when we observe rate limiting)."""
        try:
            self.min_interval_s = min(float(max_interval_s), float(self.min_interval_s) * float(factor))
        except Exception:
            pass

    def wait(self) -> None:
        now = time.time()
        elapsed = now - self._last_ts
        if elapsed < self.min_interval_s:
            time.sleep(self.min_interval_s - elapsed)
        self._last_ts = time.time()


def build_url_daily(lat: float, lon: float, start: date, end: date) -> str:
    params = (
        f"latitude={lat:.6f}&longitude={lon:.6f}"
        f"&start_date={start.isoformat()}&end_date={end.isoformat()}"
        "&daily=temperature_2m_mean,precipitation_sum,windspeed_10m_mean,winddirection_10m_dominant"
        "&timezone=UTC"
    )
    return f"{OPEN_METEO_ARCHIVE}?{params}"


def build_url_hourly(lat: float, lon: float, start: date, end: date) -> str:
    params = (
        f"latitude={lat:.6f}&longitude={lon:.6f}"
        f"&start_date={start.isoformat()}&end_date={end.isoformat()}"
        "&hourly=temperature_2m"
        "&timezone=auto"
    )
    return f"{OPEN_METEO_ARCHIVE}?{params}"


def get_json_with_retries(url: str, rl: RateLimiter, timeout_s: int = 90) -> dict:
    """GET JSON with retries.

    - On HTTP 429: exponentially back off and also slow down subsequent requests via RateLimiter.bump().
    - On transient network errors/timeouts: retry with backoff.
    """
    # Conservative backoff ladder (seconds). Keeps us from burning tiles into permanent 'error' during short bursts.
    delays = [2, 5, 10, 20, 40, 80]
    last_err: Exception | None = None
    for attempt in range(len(delays) + 1):
        rl.wait()
        try:
            resp = requests.get(url, timeout=timeout_s)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            last_err = e
            if attempt < len(delays):
                time.sleep(delays[attempt])
                continue
            raise RuntimeError(f"Network error: {e}")

        if resp.status_code == 200:
            return resp.json()

        if resp.status_code == 429:
            # We are being rate-limited; slow down future requests.
            rl.bump(factor=1.35)
            if attempt < len(delays):
                # Add small jitter to avoid synchronizing with other clients.
                jitter = 0.25 * (1.0 + (attempt % 3))
                time.sleep(delays[attempt] + jitter)
                continue
            raise RuntimeError("HTTP 429 rate-limited")

        # Retry on transient server errors.
        if resp.status_code in (500, 502, 503, 504):
            if attempt < len(delays):
                time.sleep(delays[attempt])
                continue
            raise RuntimeError(f"HTTP {resp.status_code} server error")

        raise RuntimeError(f"HTTP {resp.status_code}")

    raise RuntimeError(f"unreachable (last_err={last_err})")


def iter_year_chunks(start_year: int, end_year: int, chunk_years: int) -> Iterable[Tuple[date, date]]:
    y = int(start_year)
    while y <= end_year:
        y2 = min(end_year, y + int(chunk_years) - 1)
        d0 = date(y, 1, 1)
        d1 = date(y2, 12, 31)
        yield d0, d1
        y = y2 + 1


def _all_mmdd() -> List[Tuple[int, int]]:
    # Use a leap year reference so Feb 29 is included.
    d0 = date(2020, 1, 1)
    out: List[Tuple[int, int]] = []
    for i in range(366):
        d = d0 + timedelta(days=i)
        out.append((d.month, d.day))
    return out


_MMDD_ALL = _all_mmdd()


def percentile(values: List[float], p: float) -> float:
    arr = np.array([v for v in values if v is not None and np.isfinite(v)], dtype=float)
    if arr.size == 0:
        return float("nan")
    return float(np.nanpercentile(arr, p))


def median(values: List[float]) -> float:
    return percentile(values, 50)


def std(values: List[float]) -> float:
    arr = np.array([v for v in values if v is not None and np.isfinite(v)], dtype=float)
    if arr.size == 0:
        return float("nan")
    return float(np.nanstd(arr))


def tile_grid_approx_50km(
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
    tile_km: float,
) -> List[Tile]:
    """Build a roughly 50×50 km grid.

    - Latitude step is constant: tile_km / 111.32
    - Longitude step is adjusted per latitude band: tile_km / (111.32 * cos(lat))

    This yields tiles that are approximately square in km on the Earth surface.
    """
    lat_min = float(lat_min)
    lat_max = float(lat_max)
    lon_min = float(lon_min)
    lon_max = float(lon_max)
    if lat_max <= lat_min or lon_max <= lon_min:
        raise ValueError("Invalid bbox")

    km = float(tile_km)
    step_lat = km / 111.32
    n_rows = int(math.ceil((lat_max - lat_min) / step_lat))

    tiles: List[Tile] = []
    for row in range(n_rows):
        lat_c = lat_min + (row + 0.5) * step_lat
        if lat_c > lat_max:
            break
        # Avoid division by 0 at poles; bbox should not include near-polar.
        c = max(0.05, math.cos(math.radians(lat_c)))
        step_lon = km / (111.32 * c)
        n_cols = int(math.ceil((lon_max - lon_min) / step_lon))
        for col in range(n_cols):
            lon_c = lon_min + (col + 0.5) * step_lon
            if lon_c > lon_max:
                break
            tile_id = f"r{row}_c{col}"
            tiles.append(Tile(tile_id=tile_id, row=row, col=col, lat=clamp_lat(lat_c), lon=float(lon_c)))
    return tiles


def _try_make_is_land_fn():
    """Return a callable is_land(lat, lon) -> bool, or None if unavailable."""
    try:
        from global_land_mask import globe  # type: ignore

        def _is_land(lat: float, lon: float) -> bool:
            return bool(globe.is_land(float(lat), float(lon)))

        return _is_land
    except Exception:
        return None


def _is_coastal_sea(lat: float, lon: float, coastal_km: float, is_land_fn) -> bool:
    """Heuristic: if any sampled point within `coastal_km` is land, treat as coastal sea."""
    try:
        radius = float(coastal_km)
        if radius <= 0:
            return False
        # Sample multiple radii to reduce false negatives on small coastlines.
        radii = (radius, radius * 0.66, radius * 0.33)
        bearings = [i * (360.0 / 16.0) for i in range(16)]
        for r_km in radii:
            for b in bearings:
                br = math.radians(b)
                dlat = (r_km * math.cos(br)) / 111.32
                c = max(0.05, math.cos(math.radians(lat)))
                dlon = (r_km * math.sin(br)) / (111.32 * c)
                if is_land_fn(lat + dlat, lon + dlon):
                    return True
        return False
    except Exception:
        return False


def ensure_schema(conn: sqlite3.Connection, schema_sql_path: Path) -> None:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    sql = schema_sql_path.read_text(encoding="utf-8")
    conn.executescript(sql)


def meta_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(key), str(value)),
    )


def tile_mark_state(conn: sqlite3.Connection, tile_id: str, status: str, error: Optional[str] = None) -> None:
    conn.execute(
        "INSERT INTO build_state(tile_id, status, updated_at, error) VALUES(?,?,?,?) "
        "ON CONFLICT(tile_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, error=excluded.error",
        (tile_id, status, utc_now_iso(), error),
    )


def tile_is_done(conn: sqlite3.Connection, tile_id: str) -> bool:
    row = conn.execute("SELECT status FROM build_state WHERE tile_id=?", (tile_id,)).fetchone()
    return bool(row and row[0] == "done")


def upsert_tile(conn: sqlite3.Connection, t: Tile) -> None:
    conn.execute(
        "INSERT INTO tiles(tile_id, lat, lon, row, col) VALUES(?,?,?,?,?) "
        "ON CONFLICT(tile_id) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, row=excluded.row, col=excluded.col",
        (t.tile_id, t.lat, t.lon, t.row, t.col),
    )


def replace_climatology_rows(conn: sqlite3.Connection, tile_id: str, rows: List[dict]) -> None:
    conn.execute("DELETE FROM climatology WHERE tile_id=?", (tile_id,))
    conn.executemany(
        """
        INSERT INTO climatology(
                    tile_id, month, day,
          temperature_c, temp_p25, temp_p75, temp_std,
          precipitation_mm, rain_probability, rain_typical_mm,
          wind_speed_ms, wind_dir_deg, wind_var_deg,
          temp_hist_p25, temp_hist_p75, temp_day_p25, temp_day_p75, temp_day_median,
          samples_daily, samples_rain, samples_wind, samples_day_means, samples_day_hours
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        [
            (
                tile_id,
            int(r["month"]),
            int(r["day"]),
                r.get("temperature_c"),
                r.get("temp_p25"),
                r.get("temp_p75"),
                r.get("temp_std"),
                r.get("precipitation_mm"),
                r.get("rain_probability"),
                r.get("rain_typical_mm"),
                r.get("wind_speed_ms"),
                r.get("wind_dir_deg"),
                r.get("wind_var_deg"),
                r.get("temp_hist_p25"),
                r.get("temp_hist_p75"),
                r.get("temp_day_p25"),
                r.get("temp_day_p75"),
                r.get("temp_day_median"),
                r.get("samples_daily"),
                r.get("samples_rain"),
                r.get("samples_wind"),
                r.get("samples_day_means"),
                r.get("samples_day_hours"),
            )
            for r in rows
        ],
    )


def replace_riding_hourly_rows(conn: sqlite3.Connection, tile_id: str, rows: List[dict]) -> None:
    conn.execute("DELETE FROM riding_hourly WHERE tile_id=?", (tile_id,))
    conn.executemany(
        """
        INSERT INTO riding_hourly(
                    tile_id, month, day, hour,
          temp_median, temp_p25, temp_p75,
          samples
        ) VALUES (?,?,?,?,?,?,?,?)
        """,
        [
            (
                tile_id,
                int(r["month"]),
                int(r["day"]),
                int(r["hour"]),
                r.get("temp_median"),
                r.get("temp_p25"),
                r.get("temp_p75"),
                r.get("samples"),
            )
            for r in rows
        ],
    )


def parse_daily_into_accumulators(j: dict, acc: dict) -> None:
    daily = (j or {}).get("daily", {}) or {}
    times = daily.get("time") or []
    tavg = daily.get("temperature_2m_mean") or []
    prcp = daily.get("precipitation_sum") or []
    wspd = daily.get("windspeed_10m_mean") or []
    wdir = daily.get("winddirection_10m_dominant") or []

    n = min(len(times), len(tavg), len(prcp), len(wspd), len(wdir))
    for i in range(n):
        try:
            d = date.fromisoformat(str(times[i]))
        except Exception:
            continue
        key = (int(d.month), int(d.day))
        try:
            tv = float(tavg[i])
        except Exception:
            tv = float("nan")
        try:
            pv = float(prcp[i])
        except Exception:
            pv = float("nan")
        try:
            ws_kmh = float(wspd[i])
        except Exception:
            ws_kmh = float("nan")
        try:
            wd = float(wdir[i])
        except Exception:
            wd = float("nan")

        if np.isfinite(tv):
            acc["tavg"][key].append(tv)
        if np.isfinite(pv):
            acc["prcp"][key].append(pv)
        if np.isfinite(ws_kmh):
            acc["wspd_kmh"][key].append(ws_kmh)
        if np.isfinite(wd):
            acc["wdir"][key].append(wd)


def parse_hourly_into_accumulators(j: dict, acc: dict) -> None:
    hourly = (j or {}).get("hourly", {}) or {}
    times = hourly.get("time") or []
    temps = hourly.get("temperature_2m") or []
    n = min(len(times), len(temps))
    if n <= 0:
        return

    # We select hours like backend does: 10,12,14,16 local time.
    target_hours = {10, 12, 14, 16}
    by_date: Dict[date, List[float]] = {}

    for i in range(n):
        try:
            dt = pd.to_datetime(times[i])
        except Exception:
            continue
        try:
            temp = float(temps[i])
        except Exception:
            temp = float("nan")
        if not np.isfinite(temp):
            continue
        h = int(dt.hour)
        if h not in target_hours:
            continue
        d = dt.date()
        by_date.setdefault(d, []).append(float(temp))
        key = (int(d.month), int(d.day))
        acc["hourly_by_hour"][h][key].append(float(temp))

    for d, vals in by_date.items():
        key = (int(d.month), int(d.day))
        # hour samples
        acc["day_hours"][key].extend(vals)
        # per-date mean (needs >=2 samples like backend)
        if len(vals) >= 2:
            acc["day_means"][key].append(float(np.mean(vals)))


def compute_climatology_rows(acc: dict) -> List[dict]:
    rows: List[dict] = []
    for (month, day) in _MMDD_ALL:
        key = (month, day)
        tavg = acc["tavg"][key]
        prcp = acc["prcp"][key]
        wspd_kmh = acc["wspd_kmh"][key]
        wdir = acc["wdir"][key]
        day_means = acc["day_means"][key]
        day_hours = acc["day_hours"][key]

        # Base daily stats
        temperature_c = median(tavg)
        temp_p25 = percentile(tavg, 25)
        temp_p75 = percentile(tavg, 75)
        temp_std = std(tavg)

        precipitation_mm = median(prcp)
        prcp_arr = np.array([v for v in prcp if np.isfinite(v)], dtype=float)
        if prcp_arr.size > 0:
            rain_probability = float(np.mean(prcp_arr > 0.1))
            typical_candidates = prcp_arr[prcp_arr > 0.1]
            rain_typical_mm = float(np.nanmedian(typical_candidates)) if typical_candidates.size else 0.0
        else:
            rain_probability = float("nan")
            rain_typical_mm = float("nan")

        wind_speed_ms = float("nan")
        if wspd_kmh:
            wind_speed_ms = median(wspd_kmh) / 3.6
        wind_stats = compute_wind_statistics(pd.Series(wdir, dtype=float))

        # Daytime overrides (same semantics as compute_daytime_temperature_statistics)
        # - temperature_c becomes median of per-date daytime means
        # - temp_p25/temp_p75 reflect historical percentiles of per-date means
        # - temp_day_* reflect distribution across all selected-hour samples
        temp_hist_p25 = percentile(day_means, 25)
        temp_hist_p75 = percentile(day_means, 75)
        temp_day_median = median(day_hours)
        temp_day_p25 = percentile(day_hours, 25)
        temp_day_p75 = percentile(day_hours, 75)

        if np.isfinite(median(day_means)):
            temperature_c = median(day_means)
            temp_p25 = temp_hist_p25
            temp_p75 = temp_hist_p75
            temp_std = std(day_means)

        rows.append(
            {
                "month": month,
                "day": day,
                "temperature_c": float(temperature_c) if np.isfinite(temperature_c) else None,
                "temp_p25": float(temp_p25) if np.isfinite(temp_p25) else None,
                "temp_p75": float(temp_p75) if np.isfinite(temp_p75) else None,
                "temp_std": float(temp_std) if np.isfinite(temp_std) else None,
                "precipitation_mm": float(precipitation_mm) if np.isfinite(precipitation_mm) else None,
                "rain_probability": float(rain_probability) if np.isfinite(rain_probability) else None,
                "rain_typical_mm": float(rain_typical_mm) if np.isfinite(rain_typical_mm) else None,
                "wind_speed_ms": float(wind_speed_ms) if np.isfinite(wind_speed_ms) else None,
                "wind_dir_deg": float(wind_stats.get("wind_dir_deg", float("nan"))) if wind_stats else None,
                "wind_var_deg": float(wind_stats.get("wind_var_deg", float("nan"))) if wind_stats else None,
                "temp_hist_p25": float(temp_hist_p25) if np.isfinite(temp_hist_p25) else None,
                "temp_hist_p75": float(temp_hist_p75) if np.isfinite(temp_hist_p75) else None,
                "temp_day_p25": float(temp_day_p25) if np.isfinite(temp_day_p25) else None,
                "temp_day_p75": float(temp_day_p75) if np.isfinite(temp_day_p75) else None,
                "temp_day_median": float(temp_day_median) if np.isfinite(temp_day_median) else None,
                "samples_daily": int(len(tavg)),
                "samples_rain": int(len(prcp)),
                "samples_wind": int(len(wdir)),
                "samples_day_means": int(len(day_means)),
                "samples_day_hours": int(len(day_hours)),
            }
        )
    return rows


def compute_riding_hourly_rows(acc: dict) -> List[dict]:
    rows: List[dict] = []
    for (month, day) in _MMDD_ALL:
        key = (month, day)
        for hour in (10, 12, 14, 16):
            vals = acc["hourly_by_hour"][hour][key]
            med = median(vals)
            p25 = percentile(vals, 25)
            p75 = percentile(vals, 75)
            rows.append(
                {
                    "month": month,
                    "day": day,
                    "hour": hour,
                    "temp_median": float(med) if np.isfinite(med) else None,
                    "temp_p25": float(p25) if np.isfinite(p25) else None,
                    "temp_p75": float(p75) if np.isfinite(p75) else None,
                    "samples": int(len(vals)),
                }
            )
    return rows


def make_empty_accumulators() -> dict:
    return {
        "tavg": {k: [] for k in _MMDD_ALL},
        "prcp": {k: [] for k in _MMDD_ALL},
        "wspd_kmh": {k: [] for k in _MMDD_ALL},
        "wdir": {k: [] for k in _MMDD_ALL},
        "day_means": {k: [] for k in _MMDD_ALL},
        "day_hours": {k: [] for k in _MMDD_ALL},
        "hourly_by_hour": {
            10: {k: [] for k in _MMDD_ALL},
            12: {k: [] for k in _MMDD_ALL},
            14: {k: [] for k in _MMDD_ALL},
            16: {k: [] for k in _MMDD_ALL},
        },
    }


def process_tile(
    t: Tile,
    start_year: int,
    end_year: int,
    chunk_years: int,
    rl: RateLimiter,
) -> Tuple[List[dict], List[dict]]:
    """Download inputs for one tile and compute all derived outputs.

    Returns:
    - climatology rows (366)
    - riding-hour rows (366 * 4)
    """
    acc = make_empty_accumulators()
    for d0, d1 in iter_year_chunks(start_year, end_year, chunk_years):
        j_daily = get_json_with_retries(build_url_daily(t.lat, t.lon, d0, d1), rl)
        parse_daily_into_accumulators(j_daily, acc)
        j_hourly = get_json_with_retries(build_url_hourly(t.lat, t.lon, d0, d1), rl)
        parse_hourly_into_accumulators(j_hourly, acc)
    return compute_climatology_rows(acc), compute_riding_hourly_rows(acc)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()

    p.add_argument("--db", default="project/cache/offline_weather.sqlite", help="SQLite output path")

    p.add_argument("--lat-min", type=float, default=34.0)
    p.add_argument("--lat-max", type=float, default=72.0)
    p.add_argument("--lon-min", type=float, default=-11.0)
    p.add_argument("--lon-max", type=float, default=33.0)

    p.add_argument("--tile-km", type=float, default=50.0)

    # Ocean handling:
    # - all: keep all tiles (including open ocean)
    # - coastal: keep land + sea within `--coastal-sea-km` of land
    # - none: keep land only
    p.add_argument("--ocean", choices=["all", "coastal", "none"], default="coastal")
    p.add_argument("--coastal-sea-km", type=float, default=50.0)

    # Historical window (inclusive)
    p.add_argument("--start-year", type=int, default=date.today().year - 10)
    p.add_argument("--end-year", type=int, default=date.today().year - 1)

    p.add_argument("--chunk-years", type=int, default=2, help="Years per Open‑Meteo request")

    p.add_argument("--min-interval-s", type=float, default=1.15, help="Rate limit between requests")

    p.add_argument(
        "--pace-until-berlin-7am",
        action="store_true",
        help=(
            "Auto-adjust --min-interval-s to finish the selected chunk by the next 07:00 in Europe/Berlin, "
            "based on remaining time and expected request count (daily+hourly year-chunks)."
        ),
    )

    p.add_argument("--chunk-count", type=int, default=10)
    p.add_argument("--chunk-index", type=int, default=0)

    p.add_argument("--max-tiles", type=int, default=0, help="Debug: cap processed tile count")

    return p.parse_args()


def main() -> None:
    args = parse_args()

    db_path = Path(args.db)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    schema_path = Path(__file__).with_name("offline_store_schema.sql")

    tiles = tile_grid_approx_50km(args.lat_min, args.lat_max, args.lon_min, args.lon_max, args.tile_km)
    tiles.sort(key=lambda t: (t.row, t.col))

    # Filter ocean tiles if requested (requires optional land mask dependency).
    ocean_mode = str(args.ocean).strip().lower()
    is_land_fn = None
    if ocean_mode in ("coastal", "none"):
        is_land_fn = _try_make_is_land_fn()
        if is_land_fn is None:
            print(
                "[WARN] Ocean filtering requested but 'global_land_mask' is not installed; proceeding without ocean filtering.",
                file=sys.stderr,
            )
            ocean_mode = "all"

    if ocean_mode != "all" and is_land_fn is not None:
        kept: List[Tile] = []
        coastal_km = float(args.coastal_sea_km)
        for t in tiles:
            if is_land_fn(t.lat, t.lon):
                kept.append(t)
                continue
            # It's sea.
            if ocean_mode == "none":
                continue
            if ocean_mode == "coastal" and _is_coastal_sea(t.lat, t.lon, coastal_km, is_land_fn):
                kept.append(t)
        tiles = kept

    # Split tiles into N chunks deterministically
    chunk_count = int(max(1, args.chunk_count))
    chunk_index = int(args.chunk_index)
    if not (0 <= chunk_index < chunk_count):
        raise SystemExit("chunk-index must be in [0, chunk-count)")

    selected = [t for i, t in enumerate(tiles) if (i % chunk_count) == chunk_index]
    if args.max_tiles and int(args.max_tiles) > 0:
        selected = selected[: int(args.max_tiles)]

    # Optional: auto pace so the selected chunk finishes by 07:00 Europe/Berlin.
    # Note: the computed value is a *maximum* interval to still finish by the deadline.
    # We therefore never slow down beyond the configured --min-interval-s; we only speed up if needed.
    min_interval_s_effective = float(args.min_interval_s)
    try:
        if bool(args.pace_until_berlin_7am) and len(selected) > 0:
            now_local = datetime.now(ZoneInfo("Europe/Berlin"))
            deadline = now_local.replace(hour=7, minute=0, second=0, microsecond=0)
            if deadline <= now_local:
                deadline = deadline + timedelta(days=1)
            remaining_s = max(0.0, (deadline - now_local).total_seconds())

            years = int(args.end_year) - int(args.start_year) + 1
            year_chunks = int(math.ceil(max(1, years) / max(1, int(args.chunk_years))))
            expected_requests_per_tile = 2 * year_chunks  # daily + hourly
            expected_requests = int(len(selected) * expected_requests_per_tile)

            if expected_requests > 0 and remaining_s > 0:
                # Slightly faster than the theoretical minimum to leave slack for JSON parsing, DB writes, retries.
                slack = 0.90
                required_interval = max(0.25, (remaining_s / float(expected_requests)) * slack)
                min_interval_s_effective = min(float(args.min_interval_s), required_interval)
    except Exception:
        min_interval_s_effective = float(args.min_interval_s)

    print(
        json.dumps(
            {
                "tiles_total": len(tiles),
                "tiles_selected": len(selected),
                "chunk_index": chunk_index,
                "chunk_count": chunk_count,
                "years": {"start": int(args.start_year), "end": int(args.end_year)},
                "chunk_years": int(args.chunk_years),
                "min_interval_s": float(min_interval_s_effective),
                "ocean": {
                    "mode": str(args.ocean),
                    "coastal_sea_km": float(args.coastal_sea_km),
                },
                "bbox": {
                    "lat_min": float(args.lat_min),
                    "lat_max": float(args.lat_max),
                    "lon_min": float(args.lon_min),
                    "lon_max": float(args.lon_max),
                },
                "tile_km": float(args.tile_km),
                "db": str(db_path),
                "started_at": utc_now_iso(),
            },
            indent=2,
        )
    )

    rl = RateLimiter(min_interval_s_effective)

    conn = sqlite3.connect(str(db_path))
    try:
        ensure_schema(conn, schema_path)

        # Meta
        meta_set(conn, "provider", "open-meteo")
        meta_set(conn, "provider_only", "true")
        meta_set(conn, "provider_terms_url", "https://open-meteo.com/en/terms")
        meta_set(conn, "provider_licence_url", "https://open-meteo.com/en/licence")
        meta_set(conn, "provider_attribution", "Weather data by Open-Meteo.com (CC BY 4.0)")
        meta_set(conn, "provider_notes", "This database is built exclusively from Open-Meteo archive API responses; no fallback providers are used.")
        meta_set(conn, "tile_km", str(args.tile_km))
        meta_set(conn, "bbox", json.dumps({"lat_min": args.lat_min, "lat_max": args.lat_max, "lon_min": args.lon_min, "lon_max": args.lon_max}))
        meta_set(conn, "years", json.dumps({"start": args.start_year, "end": args.end_year}))
        meta_set(conn, "chunk_years", str(args.chunk_years))
        meta_set(conn, "hourly_riding_hours", json.dumps([10, 12, 14, 16]))
        meta_set(conn, "min_interval_s_effective", str(float(min_interval_s_effective)))
        meta_set(conn, "last_build_started_at", utc_now_iso())
        conn.commit()

        processed = 0
        errors = 0
        attempted = 0
        t_start = time.time()
        last_progress_len = 0
        for idx, t in enumerate(selected, start=1):
            if tile_is_done(conn, t.tile_id):
                continue
            upsert_tile(conn, t)
            tile_mark_state(conn, t.tile_id, "building", error=None)
            conn.commit()
            try:
                t0 = time.time()
                rows, riding_rows = process_tile(t, args.start_year, args.end_year, args.chunk_years, rl)
                # Atomic replace per tile
                conn.execute("BEGIN")
                replace_climatology_rows(conn, t.tile_id, rows)
                replace_riding_hourly_rows(conn, t.tile_id, riding_rows)
                tile_mark_state(conn, t.tile_id, "done", error=None)
                conn.commit()
                processed += 1
                attempted += 1
                dt = time.time() - t0
                # Live progress (single line)
                try:
                    done = processed + errors
                    total = len(selected)
                    elapsed = max(0.001, time.time() - t_start)
                    rate = float(done) / elapsed
                    eta_s = (float(total - done) / rate) if rate > 1e-9 else 0.0
                    pct = (100.0 * float(done) / float(total)) if total > 0 else 100.0
                    msg = f"Progress: {done}/{total} ({pct:5.1f}%) ok={processed} err={errors} tile={t.tile_id} eta={eta_s/3600.0:4.1f}h"
                    pad = max(0, last_progress_len - len(msg))
                    sys.stdout.write("\r" + msg + (" " * pad))
                    sys.stdout.flush()
                    last_progress_len = len(msg)
                except Exception:
                    pass
            except Exception as e:
                try:
                    conn.rollback()
                except Exception:
                    pass
                tile_mark_state(conn, t.tile_id, "error", error=str(e))
                conn.commit()
                errors += 1
                attempted += 1
                try:
                    done = processed + errors
                    total = len(selected)
                    pct = (100.0 * float(done) / float(total)) if total > 0 else 100.0
                    sys.stdout.write("\n" + f"[ERR] tile {t.tile_id} ({done}/{total}, {pct:.1f}%): {e}" + "\n")
                    sys.stdout.flush()
                    last_progress_len = 0
                except Exception:
                    print(f"[ERR] tile {t.tile_id} ({idx}/{len(selected)}): {e}")

        # Finish progress line cleanly
        try:
            if last_progress_len:
                sys.stdout.write("\n")
                sys.stdout.flush()
        except Exception:
            pass

        meta_set(conn, "last_build_finished_at", utc_now_iso())
        conn.commit()
        print(json.dumps({"processed_tiles": processed, "finished_at": utc_now_iso()}, indent=2))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
