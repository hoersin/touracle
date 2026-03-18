"""Temporal climate aggregation for Strategic/Climatic map.

Extends the existing daily Strategic map by aggregating over a moving window
around a center day-of-year. Output points match the existing
`OfflineWeatherStore.get_climatology_grid()` shape so the frontend renderer
pipeline remains unchanged.

Caching:
  - In-memory cache keyed by (year, timescale, center_doy, quantized bbox)
    to keep slider scrubbing smooth.
"""

from __future__ import annotations

import datetime as _dt
import math
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, Iterable, List, Optional, Tuple


Timescale = str

ALLOWED_TIMESCALES: Tuple[str, ...] = (
    "daily",
    "week",
    "two_week",
    "month",
    "quarter",
    "year",
)


def _is_leap_year(year: int) -> bool:
    try:
        return _dt.date(int(year), 3, 1).toordinal() - _dt.date(int(year), 2, 1).toordinal() == 29
    except Exception:
        return False


def _doy_from_month_day(year: int, month: int, day: int) -> int:
    d = _dt.date(int(year), int(month), int(day))
    start = _dt.date(int(year), 1, 1)
    return 1 + (d - start).days


def _month_day_from_doy(year: int, doy: int) -> Tuple[int, int]:
    start = _dt.date(int(year), 1, 1)
    d = start + _dt.timedelta(days=int(doy) - 1)
    return int(d.month), int(d.day)


def _window_half_span_days(timescale: Timescale) -> Optional[int]:
    ts = str(timescale or "daily")
    if ts == "daily":
        return 0
    if ts == "week":
        return 3
    if ts == "two_week":
        return 7
    if ts == "month":
        return 15
    if ts == "quarter":
        return 45
    if ts == "year":
        return None
    raise ValueError(f"Invalid timescale '{timescale}'. Allowed: {', '.join(ALLOWED_TIMESCALES)}")


def _year_len(year: int) -> int:
    return 366 if _is_leap_year(year) else 365


def _last_day_of_month(year: int, month: int) -> int:
    y = int(year)
    m = int(month)
    if m == 12:
        nxt = _dt.date(y + 1, 1, 1)
    else:
        nxt = _dt.date(y, m + 1, 1)
    return int((nxt - _dt.timedelta(days=1)).day)


def _bin_doy_range(year: int, center_doy: int, timescale: Timescale) -> Tuple[int, int, int]:
    """Return (start_doy, end_doy, canonical_doy) for the requested timescale.

    For non-daily timescales, the range is calendar-aligned:
      - week/two_week: contiguous bins starting at Jan 1
      - month: calendar month
      - quarter: calendar quarter
      - year: full year

    canonical_doy is stable within a bin and is used for caching.
    """
    ts = str(timescale or "daily")
    yl = _year_len(year)
    cd = int(center_doy)
    if cd < 1:
        cd = 1
    if cd > yl:
        cd = yl

    if ts == "daily":
        return (cd, cd, cd)

    if ts == "week":
        start = 1 + 7 * ((cd - 1) // 7)
        end = min(yl, start + 6)
        return (start, end, start)

    if ts == "two_week":
        start = 1 + 14 * ((cd - 1) // 14)
        end = min(yl, start + 13)
        return (start, end, start)

    if ts == "month":
        m, _d = _month_day_from_doy(year, cd)
        start = _doy_from_month_day(year, m, 1)
        end = _doy_from_month_day(year, m, _last_day_of_month(year, m))
        return (start, end, start)

    if ts == "quarter":
        m, _d = _month_day_from_doy(year, cd)
        q_start_month = 1 + 3 * ((m - 1) // 3)
        q_end_month = q_start_month + 2
        start = _doy_from_month_day(year, q_start_month, 1)
        end = _doy_from_month_day(year, q_end_month, _last_day_of_month(year, q_end_month))
        return (start, end, start)

    if ts == "year":
        return (1, yl, 1)

    raise ValueError(f"Invalid timescale '{timescale}'. Allowed: {', '.join(ALLOWED_TIMESCALES)}")


def _quant_bbox(lat_min: float, lat_max: float, lon_min: float, lon_max: float) -> Tuple[float, float, float, float]:
    """Quantize bbox to stabilize cache keys during tiny pan/zoom movements."""
    def q(x: float) -> float:
        return round(float(x) * 1000.0) / 1000.0

    a0, a1 = sorted((float(lat_min), float(lat_max)))
    b0, b1 = sorted((float(lon_min), float(lon_max)))
    return (q(a0), q(a1), q(b0), q(b1))


class _LRUTTLCache:
    def __init__(self, max_items: int = 96, ttl_s: float = 180.0):
        self._max = int(max_items)
        self._ttl = float(ttl_s)
        self._lock = threading.Lock()
        self._m: "OrderedDict[str, tuple[float, Any]]" = OrderedDict()

    def get(self, key: str) -> Any:
        now = time.time()
        with self._lock:
            ent = self._m.get(key)
            if ent is None:
                return None
            t, val = ent
            if (now - t) > self._ttl:
                try:
                    del self._m[key]
                except Exception:
                    pass
                return None
            # Touch
            try:
                self._m.move_to_end(key)
            except Exception:
                pass
            return val

    def set(self, key: str, val: Any) -> None:
        now = time.time()
        with self._lock:
            self._m[key] = (now, val)
            try:
                self._m.move_to_end(key)
            except Exception:
                pass
            while len(self._m) > self._max:
                try:
                    self._m.popitem(last=False)
                except Exception:
                    break


_CACHE = _LRUTTLCache(max_items=128, ttl_s=5 * 60.0)


def _cache_key(
    year: int,
    timescale: Timescale,
    center_doy: int,
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
) -> str:
    la0, la1, lo0, lo1 = _quant_bbox(lat_min, lat_max, lon_min, lon_max)
    return f"{int(year)}|{str(timescale)}|{int(center_doy)}|{la0},{la1},{lo0},{lo1}"


def _iter_mmdd_for_window(year: int, center_doy: int, timescale: Timescale) -> Iterable[Tuple[int, int]]:
    start_doy, end_doy, _canon = _bin_doy_range(int(year), int(center_doy), str(timescale or "daily"))
    for d in range(int(start_doy), int(end_doy) + 1):
        yield _month_day_from_doy(year, d)


def aggregate_climate(
    timescale: Timescale,
    target_day: int,
    selected_year: int,
    *,
    store: Any,
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
) -> List[Dict[str, Any]]:
    """Aggregate climatology fields over a temporal window.

    Args:
      timescale: daily|week|two_week|month|quarter|year
      target_day: day-of-year center (1..365/366)
      selected_year: year of the offline DB (used for leap handling)
      store: OfflineWeatherStore instance
      lat_min/lat_max/lon_min/lon_max: viewport bounds for tile selection

    Returns:
      List of tile point dicts compatible with the existing strategic renderer.
    """
    ts = str(timescale or "daily")
    if ts not in ALLOWED_TIMESCALES:
        raise ValueError(f"Invalid timescale '{timescale}'. Allowed: {', '.join(ALLOWED_TIMESCALES)}")

    year = int(selected_year)
    center_doy = int(target_day)

    # Canonicalize the cache key to the start of the selected bin so that
    # all dates within the same week/month/quarter map to the same cached result.
    try:
        _start_doy, _end_doy, canon_doy = _bin_doy_range(year, center_doy, ts)
    except Exception:
        canon_doy = center_doy

    cache_key = _cache_key(year, ts, int(canon_doy), lat_min, lat_max, lon_min, lon_max)
    cached = _CACHE.get(cache_key)
    if cached is not None:
        return cached

    mmdd = list(_iter_mmdd_for_window(year, center_doy, ts))

    # Build query: tile centers within bbox LEFT JOIN climatology rows in the window.
    # Special-case year: no month/day filtering needed.
    if ts == "year":
        join_filter = ""
        md_params: List[Any] = []
    else:
        parts = []
        md_params = []
        for (m, d) in mmdd:
            parts.append("(c.month = ? AND c.day = ?)")
            md_params.extend([int(m), int(d)])
        join_filter = " AND (" + " OR ".join(parts) + ")"

    sql = (
        "SELECT "
        "  t.tile_id, t.lat, t.lon, t.row, t.col, "
        "  c.temperature_c, c.precipitation_mm, c.rain_probability, c.rain_typical_mm, "
        "  c.wind_speed_ms, c.wind_dir_deg, c.wind_var_deg, "
        "  c.temp_day_median, c.temp_day_p25, c.temp_day_p75 "
        "FROM tiles t "
        "LEFT JOIN climatology c "
        "  ON c.tile_id = t.tile_id" + join_filter + " "
        "WHERE t.lat BETWEEN ? AND ? AND t.lon BETWEEN ? AND ? "
        "ORDER BY t.row, t.col"
    )

    # Use store lock/connection for thread-safety.
    lock = getattr(store, "_lock", None)
    conn = getattr(store, "_conn", None)
    if conn is None:
        raise RuntimeError("Offline store connection unavailable")

    params: List[Any] = []
    params.extend(md_params)
    params.extend([float(lat_min), float(lat_max), float(lon_min), float(lon_max)])

    if lock is None:
        rows = conn.execute(sql, tuple(params)).fetchall()
    else:
        with lock:
            rows = conn.execute(sql, tuple(params)).fetchall()

    # Aggregate per tile.
    order: List[str] = []
    base: Dict[str, Dict[str, Any]] = {}
    acc: Dict[str, Dict[str, float]] = {}
    cnt: Dict[str, Dict[str, int]] = {}
    dir_sum: Dict[str, Tuple[float, float, int]] = {}  # tile -> (sum_cos, sum_sin, n)

    num_keys = (
        "temperature_c",
        "precipitation_mm",
        "rain_probability",
        "rain_typical_mm",
        "wind_speed_ms",
        "wind_var_deg",
        "temp_day_median",
        "temp_day_p25",
        "temp_day_p75",
    )

    def add_num(tile_id: str, k: str, v: Any) -> None:
        try:
            if v is None:
                return
            x = float(v)
            if not math.isfinite(x):
                return
        except Exception:
            return
        acc.setdefault(tile_id, {})
        cnt.setdefault(tile_id, {})
        acc[tile_id][k] = acc[tile_id].get(k, 0.0) + x
        cnt[tile_id][k] = cnt[tile_id].get(k, 0) + 1

    def add_dir(tile_id: str, deg: Any) -> None:
        try:
            if deg is None:
                return
            a = float(deg)
            if not math.isfinite(a):
                return
        except Exception:
            return
        r = math.radians(a)
        c0, s0, n0 = dir_sum.get(tile_id, (0.0, 0.0, 0))
        dir_sum[tile_id] = (c0 + math.cos(r), s0 + math.sin(r), n0 + 1)

    for r in rows or []:
        try:
            (
                tile_id,
                lat,
                lon,
                row,
                col,
                temperature_c,
                precipitation_mm,
                rain_probability,
                rain_typical_mm,
                wind_speed_ms,
                wind_dir_deg,
                wind_var_deg,
                temp_day_median,
                temp_day_p25,
                temp_day_p75,
            ) = r
        except Exception:
            continue

        tid = str(tile_id)
        if tid not in base:
            base[tid] = {
                "tile_id": tid,
                "lat": float(lat),
                "lon": float(lon),
                "row": int(row),
                "col": int(col),
            }
            order.append(tid)

        # Numeric keys
        add_num(tid, "temperature_c", temperature_c)
        add_num(tid, "precipitation_mm", precipitation_mm)
        add_num(tid, "rain_probability", rain_probability)
        add_num(tid, "rain_typical_mm", rain_typical_mm)
        add_num(tid, "wind_speed_ms", wind_speed_ms)
        add_num(tid, "wind_var_deg", wind_var_deg)
        add_num(tid, "temp_day_median", temp_day_median)
        add_num(tid, "temp_day_p25", temp_day_p25)
        add_num(tid, "temp_day_p75", temp_day_p75)
        add_dir(tid, wind_dir_deg)

    out: List[Dict[str, Any]] = []
    for tid in order:
        d = dict(base.get(tid, {"tile_id": tid}))

        # Means
        for k in num_keys:
            n = cnt.get(tid, {}).get(k, 0)
            if n <= 0:
                d[k] = None
            else:
                d[k] = acc.get(tid, {}).get(k, 0.0) / float(n)

        # Circular mean for wind direction
        c0, s0, n0 = dir_sum.get(tid, (0.0, 0.0, 0))
        if n0 <= 0:
            d["wind_dir_deg"] = None
        else:
            if abs(c0) < 1e-12 and abs(s0) < 1e-12:
                d["wind_dir_deg"] = None
            else:
                deg = math.degrees(math.atan2(s0, c0))
                if deg < 0:
                    deg += 360.0
                d["wind_dir_deg"] = deg

        out.append(d)

    _CACHE.set(cache_key, out)
    return out
