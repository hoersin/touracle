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
    variant: str = "",
) -> str:
    la0, la1, lo0, lo1 = _quant_bbox(lat_min, lat_max, lon_min, lon_max)
    v = str(variant or "")
    return f"{int(year)}|{str(timescale)}|{int(center_doy)}|{la0},{la1},{lo0},{lo1}|{v}"


def _lucky_variant(temp_cold: Optional[float], temp_hot: Optional[float], rain_max: Optional[float], wind_max: Optional[float]) -> str:
    if temp_cold is None and temp_hot is None and rain_max is None and wind_max is None:
        return ""
    def q1(x: Optional[float]) -> str:
        try:
            if x is None:
                return "nan"
            v = float(x)
            if not math.isfinite(v):
                return "nan"
            return f"{round(v, 1):.1f}"
        except Exception:
            return "nan"
    return f"lucky:t{q1(temp_cold)}..{q1(temp_hot)}|r{q1(rain_max)}|w{q1(wind_max)}"


def _iter_mmdd_for_window(year: int, center_doy: int, timescale: Timescale) -> Iterable[Tuple[int, int]]:
    start_doy, end_doy, _canon = _bin_doy_range(int(year), int(center_doy), str(timescale or "daily"))
    for d in range(int(start_doy), int(end_doy) + 1):
        yield _month_day_from_doy(year, d)


def _median(vals: List[float]) -> Optional[float]:
    try:
        xs = [float(v) for v in vals if v is not None and math.isfinite(float(v))]
    except Exception:
        xs = []
    if not xs:
        return None
    xs.sort()
    n = len(xs)
    mid = n // 2
    if (n % 2) == 1:
        return float(xs[mid])
    return 0.5 * (float(xs[mid - 1]) + float(xs[mid]))


def _cache_key_range(
    year: int,
    start_date: str,
    duration_days: int,
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
    variant: str = "",
) -> str:
    la0, la1, lo0, lo1 = _quant_bbox(lat_min, lat_max, lon_min, lon_max)
    v = str(variant or "")
    return f"{int(year)}|range|{str(start_date)}|{int(duration_days)}|{la0},{la1},{lo0},{lo1}|{v}"


def aggregate_range(
    *,
    store: Any,
    selected_year: int,
    start_date: str,
    duration_days: int,
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
    lucky_temp_cold: Optional[float] = None,
    lucky_temp_hot: Optional[float] = None,
    lucky_rain_max: Optional[float] = None,
    lucky_wind_max: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """Aggregate climatology fields over an explicit start_date + duration_days range.

    Output points match `OfflineWeatherStore.get_climatology_grid()` so the frontend renderer
    pipeline remains unchanged.
    """

    year = int(selected_year)
    try:
        d0_in = _dt.date.fromisoformat(str(start_date).strip())
        # Force the selected strategic year; month/day are the seasonal anchor.
        d0 = _dt.date(year, int(d0_in.month), int(d0_in.day))
    except Exception:
        # Fallback: Jan 1
        d0 = _dt.date(year, 1, 1)

    yl = _year_len(year)
    try:
        start_doy = 1 + (d0 - _dt.date(year, 1, 1)).days
    except Exception:
        start_doy = 1
    if start_doy < 1:
        start_doy = 1
    if start_doy > yl:
        start_doy = yl

    try:
        dur = int(duration_days)
    except Exception:
        dur = 1
    if dur < 1:
        dur = 1
    # Clamp to within year bounds (frontend also clamps; backend safety).
    dur = min(dur, int(yl - start_doy + 1))

    try:
        mmdd: List[Tuple[int, int]] = [
            _month_day_from_doy(year, start_doy + i)
            for i in range(dur)
        ]
    except Exception:
        mmdd = [(int(d0.month), int(d0.day))]
        dur = 1

    want_lucky = (
        lucky_temp_cold is not None
        and lucky_temp_hot is not None
        and lucky_rain_max is not None
        and lucky_wind_max is not None
    )

    cache_key = _cache_key_range(
        year,
        d0.isoformat(),
        int(dur),
        lat_min,
        lat_max,
        lon_min,
        lon_max,
        _lucky_variant(lucky_temp_cold, lucky_temp_hot, lucky_rain_max, lucky_wind_max),
    )
    cached = _CACHE.get(cache_key)
    if cached is not None:
        return cached

    # Build join filter for selected days.
    parts: List[str] = []
    md_params: List[Any] = []
    for (m, d) in mmdd:
        parts.append("(c.month = ? AND c.day = ?)")
        md_params.extend([int(m), int(d)])
    join_filter = " AND (" + " OR ".join(parts) + ")" if parts else ""

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

    order: List[str] = []
    base: Dict[str, Dict[str, Any]] = {}

    # Means for most fields.
    acc: Dict[str, Dict[str, float]] = {}
    cnt: Dict[str, Dict[str, int]] = {}
    dir_sum: Dict[str, Tuple[float, float, int]] = {}

    # Medians for temperature fields.
    temps: Dict[str, List[float]] = {}
    ride_temps: Dict[str, List[float]] = {}

    lucky_day_cnt: Dict[str, int] = {}
    lucky_ride_cnt: Dict[str, int] = {}

    mean_keys = (
        "precipitation_mm",
        "rain_probability",
        "rain_typical_mm",
        "wind_speed_ms",
        "wind_var_deg",
        "temp_day_p25",
        "temp_day_p75",
    )

    def add_mean(tile_id: str, k: str, v: Any) -> None:
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

    def add_median(lst_map: Dict[str, List[float]], tile_id: str, v: Any) -> None:
        try:
            if v is None:
                return
            x = float(v)
            if not math.isfinite(x):
                return
        except Exception:
            return
        lst_map.setdefault(tile_id, []).append(float(x))

    def _is_lucky(temp_c: Any, rain_mm: Any, wind_ms: Any) -> bool:
        try:
            t = float(temp_c)
            r = float(rain_mm)
            w = float(wind_ms)
            if not (math.isfinite(t) and math.isfinite(r) and math.isfinite(w)):
                return False
        except Exception:
            return False
        return (
            float(lucky_temp_cold) <= t <= float(lucky_temp_hot)
            and float(r) <= float(lucky_rain_max)
            and float(w) <= float(lucky_wind_max)
        )

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

        add_median(temps, tid, temperature_c)
        add_median(ride_temps, tid, temp_day_median)
        for k, v in (
            ("precipitation_mm", precipitation_mm),
            ("rain_probability", rain_probability),
            ("rain_typical_mm", rain_typical_mm),
            ("wind_speed_ms", wind_speed_ms),
            ("wind_var_deg", wind_var_deg),
            ("temp_day_p25", temp_day_p25),
            ("temp_day_p75", temp_day_p75),
        ):
            add_mean(tid, k, v)
        add_dir(tid, wind_dir_deg)

        if want_lucky:
            try:
                if _is_lucky(temperature_c, precipitation_mm, wind_speed_ms):
                    lucky_day_cnt[tid] = lucky_day_cnt.get(tid, 0) + 1
                if _is_lucky(temp_day_median, precipitation_mm, wind_speed_ms):
                    lucky_ride_cnt[tid] = lucky_ride_cnt.get(tid, 0) + 1
            except Exception:
                pass

    out: List[Dict[str, Any]] = []
    for tid in order:
        d = dict(base.get(tid, {"tile_id": tid}))

        # Medians
        d["temperature_c"] = _median(temps.get(tid, []))
        d["temp_day_median"] = _median(ride_temps.get(tid, []))

        # Means
        for k in mean_keys:
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

        if want_lucky:
            d["lucky_day_count"] = int(lucky_day_cnt.get(tid, 0))
            d["lucky_ride_count"] = int(lucky_ride_cnt.get(tid, 0))

        out.append(d)

    _CACHE.set(cache_key, out)
    return out


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
    lucky_temp_cold: Optional[float] = None,
    lucky_temp_hot: Optional[float] = None,
    lucky_rain_max: Optional[float] = None,
    lucky_wind_max: Optional[float] = None,
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

    cache_key = _cache_key(
        year,
        ts,
        int(canon_doy),
        lat_min,
        lat_max,
        lon_min,
        lon_max,
        _lucky_variant(lucky_temp_cold, lucky_temp_hot, lucky_rain_max, lucky_wind_max),
    )
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

    want_lucky = (
        lucky_temp_cold is not None
        and lucky_temp_hot is not None
        and lucky_rain_max is not None
        and lucky_wind_max is not None
    )
    lucky_day_cnt: Dict[str, int] = {}
    lucky_ride_cnt: Dict[str, int] = {}

    def _is_lucky(temp_c: Any, rain_mm: Any, wind_ms: Any) -> bool:
        try:
            t = float(temp_c)
            r = float(rain_mm)
            w = float(wind_ms)
            if not (math.isfinite(t) and math.isfinite(r) and math.isfinite(w)):
                return False
        except Exception:
            return False
        return (
            float(lucky_temp_cold) <= t <= float(lucky_temp_hot)
            and float(r) <= float(lucky_rain_max)
            and float(w) <= float(lucky_wind_max)
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

        if want_lucky:
            try:
                if _is_lucky(temperature_c, precipitation_mm, wind_speed_ms):
                    lucky_day_cnt[tid] = lucky_day_cnt.get(tid, 0) + 1
                if _is_lucky(temp_day_median, precipitation_mm, wind_speed_ms):
                    lucky_ride_cnt[tid] = lucky_ride_cnt.get(tid, 0) + 1
            except Exception:
                pass

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

        if want_lucky:
            # Counts across the joined rows in the selected interval.
            d["lucky_day_count"] = int(lucky_day_cnt.get(tid, 0))
            d["lucky_ride_count"] = int(lucky_ride_cnt.get(tid, 0))

    _CACHE.set(cache_key, out)
    return out


def _years_key(stores: List[Tuple[int, Any]]) -> str:
    ys = []
    for y, _st in stores or []:
        try:
            ys.append(int(y))
        except Exception:
            continue
    ys = sorted(set(ys), reverse=True)
    return ",".join(str(y) for y in ys)


def _store_has_temp_24h(store: Any) -> bool:
    try:
        return bool(getattr(store, "_has_temp_24h", False))
    except Exception:
        return False


def _fetch_rows_for_mmdd_multi(
    *,
    store: Any,
    mmdd: List[Tuple[int, int]],
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
) -> List[tuple]:
    """Fetch raw climatology rows for a store for a list of month/day pairs."""
    # Build join filter for selected days.
    parts: List[str] = []
    md_params: List[Any] = []
    for (m, d) in mmdd:
        parts.append("(c.month = ? AND c.day = ?)")
        md_params.extend([int(m), int(d)])
    join_filter = " AND (" + " OR ".join(parts) + ")" if parts else ""

    has_temp24 = _store_has_temp_24h(store)
    temp24_expr = "c.temp_24h_c" if has_temp24 else "NULL"

    sql = (
        "SELECT "
        "  t.tile_id, t.lat, t.lon, t.row, t.col, "
        "  c.temperature_c, "
        f"  {temp24_expr} AS temp_24h_c, "
        "  c.precipitation_mm, c.rain_probability, c.rain_typical_mm, "
        "  c.wind_speed_ms, c.wind_dir_deg, c.wind_var_deg, "
        "  c.temp_day_median, c.temp_day_p25, c.temp_day_p75 "
        "FROM tiles t "
        "LEFT JOIN climatology c "
        "  ON c.tile_id = t.tile_id" + join_filter + " "
        "WHERE t.lat BETWEEN ? AND ? AND t.lon BETWEEN ? AND ? "
        "ORDER BY t.row, t.col"
    )

    lock = getattr(store, "_lock", None)
    conn = getattr(store, "_conn", None)
    if conn is None:
        raise RuntimeError("Offline store connection unavailable")

    params: List[Any] = []
    params.extend(md_params)
    params.extend([float(lat_min), float(lat_max), float(lon_min), float(lon_max)])

    if lock is None:
        return conn.execute(sql, tuple(params)).fetchall()
    with lock:
        return conn.execute(sql, tuple(params)).fetchall()


def _aggregate_multi_for_mmdd(
    *,
    stores: List[Tuple[int, Any]],
    mmdd: List[Tuple[int, int]],
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
    lucky_temp_cold: Optional[float] = None,
    lucky_temp_hot: Optional[float] = None,
    lucky_rain_max: Optional[float] = None,
    lucky_wind_max: Optional[float] = None,
    rain_prob_threshold_mm: float = 0.5,
) -> List[Dict[str, Any]]:
    """Aggregate across (year-store) x (month/day list).

    Output points match `OfflineWeatherStore.get_climatology_grid()` so the frontend
    renderer pipeline remains unchanged.
    """
    want_lucky = (
        lucky_temp_cold is not None
        and lucky_temp_hot is not None
        and lucky_rain_max is not None
        and lucky_wind_max is not None
    )

    # Base rows + stable order come from the first store.
    order: List[str] = []
    base: Dict[str, Dict[str, Any]] = {}

    # Aggregation accumulators.
    temp_full: Dict[str, List[float]] = {}
    temp_active: Dict[str, List[float]] = {}

    sum_fields: Dict[str, Dict[str, float]] = {}
    cnt_fields: Dict[str, Dict[str, int]] = {}

    # Rain probability from sample-days: P(rain > threshold).
    rain_n: Dict[str, int] = {}
    rain_k: Dict[str, int] = {}

    # Wind direction circular mean.
    dir_sum: Dict[str, Tuple[float, float, int]] = {}

    lucky_day_cnt: Dict[str, int] = {}
    lucky_ride_cnt: Dict[str, int] = {}

    mean_keys = (
        "precipitation_mm",
        "rain_typical_mm",
        "wind_speed_ms",
        "wind_var_deg",
        "temp_day_p25",
        "temp_day_p75",
    )

    def add_mean(tile_id: str, k: str, v: Any) -> None:
        try:
            if v is None:
                return
            x = float(v)
            if not math.isfinite(x):
                return
        except Exception:
            return
        sum_fields.setdefault(tile_id, {})
        cnt_fields.setdefault(tile_id, {})
        sum_fields[tile_id][k] = sum_fields[tile_id].get(k, 0.0) + x
        cnt_fields[tile_id][k] = cnt_fields[tile_id].get(k, 0) + 1

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

    def add_median(dst: Dict[str, List[float]], tile_id: str, v: Any) -> None:
        try:
            if v is None:
                return
            x = float(v)
            if not math.isfinite(x):
                return
        except Exception:
            return
        dst.setdefault(tile_id, []).append(float(x))

    def add_rain_prob(tile_id: str, precip_mm: Any) -> None:
        try:
            if precip_mm is None:
                return
            r = float(precip_mm)
            if not math.isfinite(r):
                return
        except Exception:
            return
        rain_n[tile_id] = rain_n.get(tile_id, 0) + 1
        if r > float(rain_prob_threshold_mm):
            rain_k[tile_id] = rain_k.get(tile_id, 0) + 1

    def _is_lucky(temp_c: Any, rain_mm: Any, wind_ms: Any) -> bool:
        try:
            t = float(temp_c)
            r = float(rain_mm)
            w = float(wind_ms)
            if not (math.isfinite(t) and math.isfinite(r) and math.isfinite(w)):
                return False
        except Exception:
            return False
        return (
            float(lucky_temp_cold) <= t <= float(lucky_temp_hot)
            and float(r) <= float(lucky_rain_max)
            and float(w) <= float(lucky_wind_max)
        )

    # Query and accumulate per store.
    for idx, (_y, st) in enumerate(stores or []):
        rows = _fetch_rows_for_mmdd_multi(
            store=st,
            mmdd=mmdd,
            lat_min=float(lat_min),
            lat_max=float(lat_max),
            lon_min=float(lon_min),
            lon_max=float(lon_max),
        )

        for r in rows or []:
            try:
                (
                    tile_id,
                    lat,
                    lon,
                    row,
                    col,
                    temperature_c,
                    temp_24h_c,
                    precipitation_mm,
                    _rain_probability_db,
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
                # Preserve a stable tile order (first store wins).
                order.append(tid)

            # Temperature samples
            # full-day: prefer temp_24h_c when DB has it; otherwise fall back.
            full_sample = temp_24h_c if temp_24h_c is not None else temperature_c
            active_sample = temp_day_median if temp_day_median is not None else temperature_c
            add_median(temp_full, tid, full_sample)
            add_median(temp_active, tid, active_sample)

            # Mean fields
            for k, v in (
                ("precipitation_mm", precipitation_mm),
                ("rain_typical_mm", rain_typical_mm),
                ("wind_speed_ms", wind_speed_ms),
                ("wind_var_deg", wind_var_deg),
                ("temp_day_p25", temp_day_p25),
                ("temp_day_p75", temp_day_p75),
            ):
                add_mean(tid, k, v)

            # Rain probability from samples
            add_rain_prob(tid, precipitation_mm)

            # Wind direction circular mean
            add_dir(tid, wind_dir_deg)

            if want_lucky:
                try:
                    if _is_lucky(full_sample, precipitation_mm, wind_speed_ms):
                        lucky_day_cnt[tid] = lucky_day_cnt.get(tid, 0) + 1
                    if _is_lucky(active_sample, precipitation_mm, wind_speed_ms):
                        lucky_ride_cnt[tid] = lucky_ride_cnt.get(tid, 0) + 1
                except Exception:
                    pass

    out: List[Dict[str, Any]] = []
    for tid in order:
        d = dict(base.get(tid, {"tile_id": tid}))

        # Medians
        d["temperature_c"] = _median(temp_full.get(tid, []))
        d["temp_day_median"] = _median(temp_active.get(tid, []))

        # Means
        for k in mean_keys:
            n = cnt_fields.get(tid, {}).get(k, 0)
            d[k] = (sum_fields.get(tid, {}).get(k, 0.0) / float(n)) if n > 0 else None

        # Rain probability (threshold-based)
        n_r = int(rain_n.get(tid, 0))
        k_r = int(rain_k.get(tid, 0))
        d["rain_probability"] = (float(k_r) / float(n_r)) if n_r > 0 else None

        # Circular mean for wind direction
        c0, s0, n0 = dir_sum.get(tid, (0.0, 0.0, 0))
        if n0 <= 0 or (abs(c0) < 1e-12 and abs(s0) < 1e-12):
            d["wind_dir_deg"] = None
        else:
            deg = math.degrees(math.atan2(s0, c0))
            if deg < 0:
                deg += 360.0
            d["wind_dir_deg"] = deg

        if want_lucky:
            d["lucky_day_count"] = int(lucky_day_cnt.get(tid, 0))
            d["lucky_ride_count"] = int(lucky_ride_cnt.get(tid, 0))

        out.append(d)
    return out


def aggregate_daily_multi(
    *,
    stores: List[Tuple[int, Any]],
    month: int,
    day: int,
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
    lucky_temp_cold: Optional[float] = None,
    lucky_temp_hot: Optional[float] = None,
    lucky_rain_max: Optional[float] = None,
    lucky_wind_max: Optional[float] = None,
) -> List[Dict[str, Any]]:
    key = _cache_key(
        # Use the newest year as cache year component; the years list is in variant.
        max([int(y) for (y, _st) in (stores or [(2025, None)])]),
        "daily",
        int(_doy_from_month_day(max([int(y) for (y, _st) in (stores or [(2025, None)])]), int(month), int(day))),
        lat_min,
        lat_max,
        lon_min,
        lon_max,
        variant=f"multi|years:{_years_key(stores)}|{_lucky_variant(lucky_temp_cold, lucky_temp_hot, lucky_rain_max, lucky_wind_max)}",
    )
    cached = _CACHE.get(key)
    if cached is not None:
        return cached

    pts = _aggregate_multi_for_mmdd(
        stores=stores,
        mmdd=[(int(month), int(day))],
        lat_min=float(lat_min),
        lat_max=float(lat_max),
        lon_min=float(lon_min),
        lon_max=float(lon_max),
        lucky_temp_cold=lucky_temp_cold,
        lucky_temp_hot=lucky_temp_hot,
        lucky_rain_max=lucky_rain_max,
        lucky_wind_max=lucky_wind_max,
    )
    _CACHE.set(key, pts)
    return pts


def aggregate_range_multi(
    *,
    stores: List[Tuple[int, Any]],
    anchor_year: int,
    start_date: str,
    duration_days: int,
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
    lucky_temp_cold: Optional[float] = None,
    lucky_temp_hot: Optional[float] = None,
    lucky_rain_max: Optional[float] = None,
    lucky_wind_max: Optional[float] = None,
) -> List[Dict[str, Any]]:
    # Compute month/day window based on anchor year (seasonal alignment).
    year = int(anchor_year)
    try:
        d0_in = _dt.date.fromisoformat(str(start_date).strip())
        d0 = _dt.date(year, int(d0_in.month), int(d0_in.day))
    except Exception:
        d0 = _dt.date(year, 1, 1)

    yl = _year_len(year)
    try:
        start_doy = 1 + (d0 - _dt.date(year, 1, 1)).days
    except Exception:
        start_doy = 1
    start_doy = max(1, min(int(start_doy), int(yl)))

    try:
        dur = int(duration_days)
    except Exception:
        dur = 1
    dur = max(1, dur)
    dur = min(dur, int(yl - start_doy + 1))

    mmdd = [
        _month_day_from_doy(year, start_doy + i)
        for i in range(int(dur))
    ]

    cache_key = _cache_key_range(
        year,
        d0.isoformat(),
        int(dur),
        lat_min,
        lat_max,
        lon_min,
        lon_max,
        variant=f"multi|years:{_years_key(stores)}|{_lucky_variant(lucky_temp_cold, lucky_temp_hot, lucky_rain_max, lucky_wind_max)}",
    )
    cached = _CACHE.get(cache_key)
    if cached is not None:
        return cached

    pts = _aggregate_multi_for_mmdd(
        stores=stores,
        mmdd=mmdd,
        lat_min=float(lat_min),
        lat_max=float(lat_max),
        lon_min=float(lon_min),
        lon_max=float(lon_max),
        lucky_temp_cold=lucky_temp_cold,
        lucky_temp_hot=lucky_temp_hot,
        lucky_rain_max=lucky_rain_max,
        lucky_wind_max=lucky_wind_max,
    )
    _CACHE.set(cache_key, pts)
    return pts


def aggregate_climate_multi(
    timescale: Timescale,
    target_day: int,
    selected_year: int,
    *,
    stores: List[Tuple[int, Any]],
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
    lucky_temp_cold: Optional[float] = None,
    lucky_temp_hot: Optional[float] = None,
    lucky_rain_max: Optional[float] = None,
    lucky_wind_max: Optional[float] = None,
) -> List[Dict[str, Any]]:
    ts = str(timescale or "daily")
    if ts not in ALLOWED_TIMESCALES:
        raise ValueError(f"Invalid timescale '{timescale}'. Allowed: {', '.join(ALLOWED_TIMESCALES)}")

    year = int(selected_year)
    center_doy = int(target_day)
    try:
        _start_doy, _end_doy, canon_doy = _bin_doy_range(year, center_doy, ts)
    except Exception:
        canon_doy = center_doy

    cache_key = _cache_key(
        year,
        ts,
        int(canon_doy),
        lat_min,
        lat_max,
        lon_min,
        lon_max,
        variant=f"multi|years:{_years_key(stores)}|{_lucky_variant(lucky_temp_cold, lucky_temp_hot, lucky_rain_max, lucky_wind_max)}",
    )
    cached = _CACHE.get(cache_key)
    if cached is not None:
        return cached

    mmdd = list(_iter_mmdd_for_window(year, center_doy, ts))
    pts = _aggregate_multi_for_mmdd(
        stores=stores,
        mmdd=mmdd,
        lat_min=float(lat_min),
        lat_max=float(lat_max),
        lon_min=float(lon_min),
        lon_max=float(lon_max),
        lucky_temp_cold=lucky_temp_cold,
        lucky_temp_hot=lucky_temp_hot,
        lucky_rain_max=lucky_rain_max,
        lucky_wind_max=lucky_wind_max,
    )
    _CACHE.set(cache_key, pts)
    return pts
