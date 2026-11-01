from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence


WeatherLookup = Callable[[float, float, int, int, Sequence[int]], Optional[Dict[str, Any]]]
ProgressCallback = Callable[[], None]

TEMP_COLD_C = 8.0
TEMP_HOT_C = 30.0
TEMP_COLD_WEIGHT = 0.8
TEMP_HOT_WEIGHT = 1.1
RAIN_MM_WEIGHT = 0.9
RAIN_PROB_WEIGHT = 3.5
WIND_HEAD_WEIGHT = 1.4
WIND_TAIL_BONUS = 0.35


@dataclass
class Segment:
    start_km: float
    end_km: float
    mid_km: float
    lat: float
    lon: float
    heading_deg: float
    distance_km: float
    ascent_m: float
    weight: float


@dataclass
class DayContext:
    logical_day_index: int
    day_type: str  # ride | rest
    segment_index: int
    lat: float
    lon: float
    heading_deg: float
    weight: float


@dataclass
class CandidateScore:
    direction: str
    start_date: dt.date
    end_date: dt.date
    score: float
    missing_ratio: float
    summary: Dict[str, Any]


def _finite(value: Any) -> Optional[float]:
    try:
        out = float(value)
    except Exception:
        return None
    return out if math.isfinite(out) else None


def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1 = math.radians(float(lat1))
    phi2 = math.radians(float(lat2))
    dl = math.radians(float(lon2) - float(lon1))
    y = math.sin(dl) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dl)
    out = math.degrees(math.atan2(y, x))
    if out < 0.0:
        out += 360.0
    return float(out)


def _route_point_at_km(route_data: Dict[str, Any], target_km: float) -> tuple[float, float]:
    points = list(route_data.get("points") or [])
    cum_km = [float(v) for v in list(route_data.get("cum_km") or [])]
    if len(points) < 2 or len(cum_km) != len(points):
        raise ValueError("Route data missing points/cum_km alignment")

    total = float(cum_km[-1])
    d = max(0.0, min(total, float(target_km)))

    lo = 0
    hi = len(cum_km) - 1
    while lo < hi:
        mid = (lo + hi) >> 1
        if float(cum_km[mid]) < d:
            lo = mid + 1
        else:
            hi = mid

    i = lo
    if i <= 0:
        lat, lon, _e = points[0]
        return float(lat), float(lon)
    if i >= len(points):
        lat, lon, _e = points[-1]
        return float(lat), float(lon)

    d1 = float(cum_km[i - 1])
    d2 = float(cum_km[i])
    t = 0.0 if d2 <= d1 else max(0.0, min(1.0, (d - d1) / (d2 - d1)))
    lat1, lon1, _e1 = points[i - 1]
    lat2, lon2, _e2 = points[i]
    lat = float(lat1) + (float(lat2) - float(lat1)) * t
    lon = float(lon1) + (float(lon2) - float(lon1)) * t
    return lat, lon


def _segment_ascent(route_data: Dict[str, Any], start_km: float, end_km: float) -> float:
    points = list(route_data.get("points") or [])
    cum_km = [float(v) for v in list(route_data.get("cum_km") or [])]
    if len(points) < 2 or len(cum_km) != len(points):
        return 0.0

    s = float(min(start_km, end_km))
    e = float(max(start_km, end_km))
    if e <= s:
        return 0.0

    ascent = 0.0
    prev_elev = None
    for i, (_lat, _lon, elev) in enumerate(points):
        d = float(cum_km[i])
        if d < s or d > e:
            continue
        ev = _finite(elev)
        if ev is None:
            continue
        if prev_elev is not None and ev > prev_elev:
            ascent += (ev - prev_elev)
        prev_elev = ev

    return float(ascent)


def _slot_starts_for_year(anchor_year: int, step_days: int) -> List[dt.date]:
    starts: List[dt.date] = []
    step_i = max(1, int(step_days))
    d = dt.date(int(anchor_year), 1, 1)
    end = dt.date(int(anchor_year), 12, 31)
    while d <= end:
        starts.append(d)
        d += dt.timedelta(days=step_i)
    return starts


def _sanitize_rest_days(rest_day_indexes: Sequence[int], total_days: int) -> List[int]:
    out: List[int] = []
    seen: set[int] = set()
    for raw in rest_day_indexes or []:
        try:
            idx = int(raw)
        except Exception:
            continue
        if idx < 0 or idx >= int(total_days):
            continue
        if idx in seen:
            continue
        seen.add(idx)
        out.append(idx)
    out.sort()
    return out


def _build_segments(route_data: Dict[str, Any], ride_days: int, boundaries_km: Sequence[float]) -> List[Segment]:
    cum_km = [float(v) for v in list(route_data.get("cum_km") or [])]
    if len(cum_km) < 2:
        raise ValueError("Route cumulative distances unavailable")
    total_km = float(cum_km[-1])
    if not (total_km > 0):
        raise ValueError("Route distance is zero")

    target_boundaries = max(0, int(ride_days) - 1)
    boundaries: List[float] = []
    for raw in boundaries_km or []:
        v = _finite(raw)
        if v is None:
            continue
        vv = max(0.0, min(total_km, float(v)))
        if vv <= 0.0 or vv >= total_km:
            continue
        boundaries.append(vv)
    boundaries = sorted(boundaries)

    if len(boundaries) != target_boundaries:
        boundaries = []
        for i in range(1, int(ride_days)):
            boundaries.append((total_km * i) / float(max(1, int(ride_days))))

    marks = [0.0] + boundaries + [total_km]
    segments: List[Segment] = []
    for i in range(len(marks) - 1):
        s = float(marks[i])
        e = float(marks[i + 1])
        m = s + max(0.0, e - s) * 0.5
        lat_s, lon_s = _route_point_at_km(route_data, s)
        lat_e, lon_e = _route_point_at_km(route_data, e)
        lat_m, lon_m = _route_point_at_km(route_data, m)
        heading = _bearing_deg(lat_s, lon_s, lat_e, lon_e)
        dist = max(0.0, e - s)
        ascent = _segment_ascent(route_data, s, e)
        segments.append(Segment(
            start_km=s,
            end_km=e,
            mid_km=m,
            lat=lat_m,
            lon=lon_m,
            heading_deg=heading,
            distance_km=dist,
            ascent_m=max(0.0, ascent),
            weight=1.0,
        ))

    dist_vals = [seg.distance_km for seg in segments if seg.distance_km > 0]
    asc_vals = [seg.ascent_m for seg in segments if seg.ascent_m > 0]
    mean_dist = sum(dist_vals) / len(dist_vals) if dist_vals else 1.0
    mean_asc = sum(asc_vals) / len(asc_vals) if asc_vals else 1.0

    weighted: List[Segment] = []
    for seg in segments:
        norm_dist = seg.distance_km / max(1e-6, mean_dist)
        norm_asc = seg.ascent_m / max(1e-6, mean_asc)
        w = 1.0 + 0.6 * norm_dist + 0.8 * norm_asc
        weighted.append(Segment(**{**seg.__dict__, "weight": float(max(0.5, w))}))
    return weighted


def _build_day_context(total_days: int, rest_day_indexes: Sequence[int], segments: Sequence[Segment], reverse: bool) -> List[DayContext]:
    rests = set(_sanitize_rest_days(rest_day_indexes, int(total_days)))
    if reverse:
        segs = [
            Segment(**{
                **seg.__dict__,
                "heading_deg": float((float(seg.heading_deg) + 180.0) % 360.0),
            })
            for seg in reversed(list(segments))
        ]
    else:
        segs = list(segments)
    if not segs:
        raise ValueError("No ride segments available")

    out: List[DayContext] = []
    ride_ptr = 0
    for day_idx in range(int(total_days)):
        if day_idx in rests:
            seg_idx = max(0, min(len(segs) - 1, ride_ptr - 1))
            seg = segs[seg_idx]
            out.append(DayContext(
                logical_day_index=day_idx,
                day_type="rest",
                segment_index=seg_idx,
                lat=float(seg.lat),
                lon=float(seg.lon),
                heading_deg=float(seg.heading_deg),
                weight=0.35,
            ))
            continue

        seg_idx = max(0, min(len(segs) - 1, ride_ptr))
        seg = segs[seg_idx]
        out.append(DayContext(
            logical_day_index=day_idx,
            day_type="ride",
            segment_index=seg_idx,
            lat=float(seg.lat),
            lon=float(seg.lon),
            heading_deg=float(seg.heading_deg),
            weight=float(seg.weight),
        ))
        ride_ptr += 1

    return out


def _score_day(ctx: DayContext, stats: Optional[Dict[str, Any]]) -> tuple[float, Dict[str, float]]:
    if not isinstance(stats, dict):
        return (18.0 * float(ctx.weight), {"temp": 0.0, "rain": 0.0, "wind": 0.0, "missing": 1.0})

    temp = _finite(stats.get("temp_day_median"))
    if temp is None:
        temp = _finite(stats.get("temperature_c"))
    rain_mm = _finite(stats.get("precipitation_mm"))
    rain_prob = _finite(stats.get("rain_probability"))
    wind_ms = _finite(stats.get("wind_speed_ms"))
    wind_from = _finite(stats.get("wind_dir_deg"))

    temp_pen = 0.0
    if temp is not None:
        if temp < TEMP_COLD_C:
            temp_pen = (TEMP_COLD_C - temp) * TEMP_COLD_WEIGHT
        elif temp > TEMP_HOT_C:
            temp_pen = (temp - TEMP_HOT_C) * TEMP_HOT_WEIGHT

    rain_pen = 0.0
    if rain_mm is not None:
        rain_pen += max(0.0, rain_mm) * RAIN_MM_WEIGHT
    if rain_prob is not None:
        rain_pen += max(0.0, min(1.0, rain_prob)) * RAIN_PROB_WEIGHT

    wind_pen = 0.0
    if ctx.day_type == "ride" and wind_ms is not None and wind_from is not None:
        wind_to = (float(wind_from) + 180.0) % 360.0
        ang = math.radians(float(wind_to) - float(ctx.heading_deg))
        eff = math.cos(ang)  # + tailwind, - headwind
        head = max(0.0, -eff)
        tail = max(0.0, eff)
        wind_pen = float(wind_ms) * ((WIND_HEAD_WEIGHT * head) - (WIND_TAIL_BONUS * tail))

    raw = temp_pen + rain_pen + wind_pen
    day_score = max(0.0, raw) * float(ctx.weight)
    missing = 0.0 if any(v is not None for v in (temp, rain_mm, rain_prob, wind_ms)) else 1.0
    return (day_score, {"temp": temp_pen, "rain": rain_pen, "wind": wind_pen, "missing": missing})


def _score_candidate(
    start_date: dt.date,
    years_selected: Sequence[int],
    day_context: Sequence[DayContext],
    weather_lookup: WeatherLookup,
    lucky_thresholds: Dict[str, float],
) -> CandidateScore:
    total = 0.0
    day_count = 0
    missing_days = 0
    sum_temp_pen = 0.0
    sum_rain_pen = 0.0
    sum_wind_pen = 0.0
    years_used_seen: set[int] = set()
    temp_count = 0
    temp_sum = 0.0
    precip_sum = 0.0
    headwind_sum = 0.0
    lucky_days = 0
    lucky_temp_cold = float(lucky_thresholds.get("temp_cold", 5.0))
    lucky_temp_hot = float(lucky_thresholds.get("temp_hot", 30.0))
    lucky_rain_high = float(lucky_thresholds.get("rain_high", 10.0))
    lucky_wind_head = float(lucky_thresholds.get("wind_head_comfort", 4.0))
    lucky_wind_tail = float(lucky_thresholds.get("wind_tail_comfort", 10.0))

    for ctx in day_context:
        d = start_date + dt.timedelta(days=int(ctx.logical_day_index))
        stats = weather_lookup(float(ctx.lat), float(ctx.lon), int(d.month), int(d.day), years_selected)
        try:
            if isinstance(stats, dict):
                yrs = stats.get('_years_used')
                if isinstance(yrs, (list, tuple)) and yrs:
                    for y in yrs:
                        yy = _finite(y)
                        if yy is not None:
                            years_used_seen.add(int(round(yy)))
                else:
                    ys = _finite(stats.get('_years_start'))
                    ye = _finite(stats.get('_years_end'))
                    if ys is not None:
                        years_used_seen.add(int(round(ys)))
                    if ye is not None:
                        years_used_seen.add(int(round(ye)))
        except Exception:
            pass
        day_score, parts = _score_day(ctx, stats)
        total += float(day_score)
        day_count += 1
        if parts.get("missing", 0.0) > 0.5:
            missing_days += 1
        sum_temp_pen += float(parts.get("temp", 0.0))
        sum_rain_pen += float(parts.get("rain", 0.0))
        sum_wind_pen += float(parts.get("wind", 0.0))

        # Objective metrics (independent from balanced-penalty score)
        temp_val = _finite((stats or {}).get("temp_day_median") if isinstance(stats, dict) else None)
        if temp_val is None:
            temp_val = _finite((stats or {}).get("temperature_c") if isinstance(stats, dict) else None)
        if temp_val is not None:
            temp_sum += float(temp_val)
            temp_count += 1

        rain_mm = _finite((stats or {}).get("precipitation_mm") if isinstance(stats, dict) else None)
        if rain_mm is not None:
            precip_sum += max(0.0, float(rain_mm))

        if ctx.day_type == "ride" and isinstance(stats, dict):
            wind_ms = _finite(stats.get("wind_speed_ms"))
            wind_from = _finite(stats.get("wind_dir_deg"))
            if wind_ms is not None and wind_from is not None:
                wind_to = (float(wind_from) + 180.0) % 360.0
                ang = math.radians(float(wind_to) - float(ctx.heading_deg))
                eff = math.cos(ang)
                head = max(0.0, -eff)
                headwind_sum += float(wind_ms) * head

        # Lucky-day heuristic aligned with client-side route-day comfort logic.
        temp_for_lucky = temp_val
        rain_for_lucky = _finite((stats or {}).get("precipitation_mm") if isinstance(stats, dict) else None)
        wind_ms_for_lucky = _finite((stats or {}).get("wind_speed_ms") if isinstance(stats, dict) else None)
        wind_dir_for_lucky = _finite((stats or {}).get("wind_dir_deg") if isinstance(stats, dict) else None)
        eff_for_lucky = None
        if wind_ms_for_lucky is not None and wind_dir_for_lucky is not None:
            wind_to = (float(wind_dir_for_lucky) + 180.0) % 360.0
            ang = math.radians(float(wind_to) - float(ctx.heading_deg))
            eff_for_lucky = float(math.cos(ang))

        if (
            temp_for_lucky is not None
            and rain_for_lucky is not None
            and wind_ms_for_lucky is not None
            and float(temp_for_lucky) >= float(lucky_temp_cold)
            and float(temp_for_lucky) <= float(lucky_temp_hot)
            and float(rain_for_lucky) < float(lucky_rain_high)
        ):
            if eff_for_lucky is not None and float(eff_for_lucky) > 0.33:
                lucky = float(wind_ms_for_lucky) < float(lucky_wind_tail)
            else:
                lucky = float(wind_ms_for_lucky) < float(lucky_wind_head)
            if lucky:
                lucky_days += 1

    missing_ratio = float(missing_days / max(1, day_count))
    return CandidateScore(
        direction="forward",
        start_date=start_date,
        end_date=start_date + dt.timedelta(days=max(0, len(day_context) - 1)),
        score=float(total),
        missing_ratio=missing_ratio,
        summary={
            "temp_penalty": float(sum_temp_pen),
            "rain_penalty": float(sum_rain_pen),
            "wind_penalty": float(sum_wind_pen),
            "missing_days": int(missing_days),
            "day_count": int(day_count),
            "lucky_days": int(lucky_days),
            "avg_temp_c": (float(temp_sum / max(1, temp_count)) if temp_count > 0 else None),
            "precip_sum_mm": float(precip_sum),
            "headwind_sum_ms": float(headwind_sum),
            "years_used": sorted(int(v) for v in years_used_seen),
        },
    )


def _objective_score(item: CandidateScore, objective_mode: str) -> float:
    mode = str(objective_mode or "most_lucky_days").strip().lower()
    if mode == "most_lucky_days":
        lucky = float(item.summary.get("lucky_days") or 0)
        return lucky
    if mode == "highest_avg_temperature":
        avg_temp = _finite(item.summary.get("avg_temp_c"))
        return float(avg_temp) if avg_temp is not None else float("-inf")
    if mode == "lowest_precip_sum":
        return float(item.summary.get("precip_sum_mm") or 0.0)
    if mode == "lowest_headwind_sum":
        return float(item.summary.get("headwind_sum_ms") or 0.0)
    return float(item.score)


def _build_slot_sensitivity(
    *,
    best: CandidateScore,
    anchor_year: int,
    years_selected: Sequence[int],
    day_ctx_forward: Sequence[DayContext],
    day_ctx_reverse: Sequence[DayContext],
    weather_lookup: WeatherLookup,
    objective_mode: str,
    higher_is_better: bool,
    score_values: Sequence[float],
    lucky_thresholds: Dict[str, float],
) -> Dict[str, Any]:
    offsets = [-3, -2, -1, 1, 2, 3]
    ctx = day_ctx_reverse if str(best.direction) == "reverse" else day_ctx_forward

    finite_scores = [float(v) for v in score_values if math.isfinite(float(v))]
    if finite_scores:
        spread = max(finite_scores) - min(finite_scores)
    else:
        spread = 0.0
    denom = max(1e-6, spread, abs(float(best.score)) * 0.1, 1.0)

    details: List[Dict[str, Any]] = []
    norm_losses: List[float] = []
    better_count = 0
    available_count = 0

    for off in offsets:
        probe_date = best.start_date + dt.timedelta(days=int(off))
        if int(probe_date.year) != int(anchor_year):
            details.append({
                "offset_days": int(off),
                "available": False,
                "reason": "outside_anchor_year",
            })
            continue

        probe = _score_candidate(probe_date, years_selected, ctx, weather_lookup, lucky_thresholds)
        probe.direction = str(best.direction)
        probe_score = float(_objective_score(probe, objective_mode))
        probe.score = probe_score
        available_count += 1

        if higher_is_better:
            loss = max(0.0, float(best.score) - probe_score)
            better = bool(probe_score > float(best.score))
        else:
            loss = max(0.0, probe_score - float(best.score))
            better = bool(probe_score < float(best.score))

        if better:
            better_count += 1

        norm_loss = float(loss / denom)
        norm_losses.append(norm_loss)
        score_delta = float(probe_score - float(best.score))
        details.append({
            "offset_days": int(off),
            "available": True,
            "score": float(round(probe_score, 4)),
            "score_delta": float(round(score_delta, 4)),
            "normalized_loss": float(round(norm_loss, 4)),
            "better_than_best": bool(better),
            "missing_ratio": float(round(probe.missing_ratio, 4)),
        })

    avg_norm_loss = float(sum(norm_losses) / max(1, len(norm_losses)))
    max_norm_loss = float(max(norm_losses) if norm_losses else 0.0)

    if available_count == 0:
        label = "unknown"
    elif better_count == 0 and avg_norm_loss <= 0.10 and max_norm_loss <= 0.25:
        label = "stable"
    elif better_count <= 1 and avg_norm_loss <= 0.25 and max_norm_loss <= 0.50:
        label = "moderate"
    else:
        label = "fragile"

    return {
        "label": str(label),
        "window_days": 3,
        "available_offsets": int(available_count),
        "better_neighbor_count": int(better_count),
        "avg_normalized_loss": float(round(avg_norm_loss, 4)),
        "max_normalized_loss": float(round(max_norm_loss, 4)),
        "offsets": details,
        "score_spread_reference": float(round(denom, 4)),
    }


def optimize_tour_slots(
    *,
    route_data: Dict[str, Any],
    total_days: int,
    rest_day_indexes: Sequence[int],
    boundaries_km: Sequence[float],
    years_selected: Sequence[int],
    anchor_year: int,
    direction_mode: str,
    objective_mode: str,
    top_n: int,
    weather_lookup: WeatherLookup,
    slot_step_days: int = 7,
    lucky_thresholds: Optional[Dict[str, float]] = None,
    progress_cb: Optional[ProgressCallback] = None,
) -> Dict[str, Any]:
    thresholds = dict(lucky_thresholds or {})
    try:
        if not math.isfinite(float(thresholds.get("temp_cold", 5.0))):
            thresholds["temp_cold"] = 5.0
    except Exception:
        thresholds["temp_cold"] = 5.0
    try:
        if not math.isfinite(float(thresholds.get("temp_hot", 30.0))):
            thresholds["temp_hot"] = 30.0
    except Exception:
        thresholds["temp_hot"] = 30.0
    try:
        if not math.isfinite(float(thresholds.get("rain_high", 10.0))):
            thresholds["rain_high"] = 10.0
    except Exception:
        thresholds["rain_high"] = 10.0
    try:
        if not math.isfinite(float(thresholds.get("wind_head_comfort", 4.0))):
            thresholds["wind_head_comfort"] = 4.0
    except Exception:
        thresholds["wind_head_comfort"] = 4.0
    try:
        if not math.isfinite(float(thresholds.get("wind_tail_comfort", 10.0))):
            thresholds["wind_tail_comfort"] = 10.0
    except Exception:
        thresholds["wind_tail_comfort"] = 10.0
    total_days_i = max(1, int(total_days))
    rests = _sanitize_rest_days(rest_day_indexes, total_days_i)
    ride_days = max(1, total_days_i - len(rests))

    segments = _build_segments(route_data, ride_days, boundaries_km)
    day_ctx_forward = _build_day_context(total_days_i, rests, segments, reverse=False)
    day_ctx_reverse = _build_day_context(total_days_i, rests, segments, reverse=True)

    direction_norm = str(direction_mode or "auto_compare").strip().lower()
    if direction_norm not in ("forward", "reverse", "auto_compare"):
        direction_norm = "auto_compare"

    objective_norm = str(objective_mode or "most_lucky_days").strip().lower()
    if objective_norm not in (
        "most_lucky_days",
        "highest_avg_temperature",
        "lowest_precip_sum",
        "lowest_headwind_sum",
    ):
        objective_norm = "most_lucky_days"
    try:
        slot_step_i = 1 if int(slot_step_days or 7) <= 1 else 7
    except Exception:
        slot_step_i = 7

    directions: List[str]
    if direction_norm == "auto_compare":
        directions = ["forward", "reverse"]
    elif direction_norm == "reverse":
        directions = ["reverse"]
    else:
        directions = ["forward"]

    starts = _slot_starts_for_year(int(anchor_year), slot_step_i)
    all_scores: List[CandidateScore] = []

    for direction in directions:
        ctx = day_ctx_reverse if direction == "reverse" else day_ctx_forward
        for start in starts:
            sc = _score_candidate(start, years_selected, ctx, weather_lookup, thresholds)
            all_scores.append(CandidateScore(
                direction=direction,
                start_date=sc.start_date,
                end_date=sc.end_date,
                score=sc.score,
                missing_ratio=sc.missing_ratio,
                summary=dict(sc.summary),
            ))
            if progress_cb is not None:
                progress_cb()

    all_scores.sort(key=lambda item: (float(item.score), float(item.missing_ratio), item.start_date.toordinal()))
    higher_is_better = objective_norm in ("most_lucky_days", "highest_avg_temperature")

    for item in all_scores:
        item.score = float(_objective_score(item, objective_norm))

    score_values = [float(item.score) for item in all_scores]

    if higher_is_better:
        all_scores.sort(key=lambda item: (-float(item.score), float(item.missing_ratio), item.start_date.toordinal()))
    else:
        all_scores.sort(key=lambda item: (float(item.score), float(item.missing_ratio), item.start_date.toordinal()))

    top_n_i = max(1, min(20, int(top_n)))
    top = all_scores[:top_n_i]

    slot_sensitivity = _build_slot_sensitivity(
        best=top[0],
        anchor_year=int(anchor_year),
        years_selected=years_selected,
        day_ctx_forward=day_ctx_forward,
        day_ctx_reverse=day_ctx_reverse,
        weather_lookup=weather_lookup,
        objective_mode=objective_norm,
        higher_is_better=higher_is_better,
        score_values=score_values,
        lucky_thresholds=thresholds,
    ) if top else {
        "label": "unknown",
        "window_days": 3,
        "available_offsets": 0,
        "better_neighbor_count": 0,
        "avg_normalized_loss": 0.0,
        "max_normalized_loss": 0.0,
        "offsets": [],
        "score_spread_reference": 1.0,
    }

    second_score = float(top[1].score) if len(top) > 1 else float(top[0].score if top else 0.0)
    best_score = float(top[0].score) if top else 0.0
    gap = float(best_score - second_score) if higher_is_better else float(second_score - best_score)
    best_missing = float(top[0].missing_ratio) if top else 1.0

    if best_missing <= 0.15 and gap >= 6.0:
        confidence = "high"
    elif best_missing <= 0.35 and gap >= 2.0:
        confidence = "medium"
    else:
        confidence = "low"

    requested_years_set = {int(y) for y in years_selected}
    actual_years_used_set: set[int] = set()
    for item in all_scores:
      try:
          years_used = item.summary.get("years_used") if isinstance(item.summary, dict) else None
          if isinstance(years_used, list):
              for y in years_used:
                  yy = _finite(y)
                  if yy is not None:
                      actual_years_used_set.add(int(round(yy)))
      except Exception:
          continue
    missing_requested_years = sorted(y for y in requested_years_set if y not in actual_years_used_set)

    def _is_better(a: CandidateScore, b: CandidateScore) -> bool:
        if higher_is_better:
            if float(a.score) != float(b.score):
                return float(a.score) > float(b.score)
        else:
            if float(a.score) != float(b.score):
                return float(a.score) < float(b.score)
        if float(a.missing_ratio) != float(b.missing_ratio):
            return float(a.missing_ratio) < float(b.missing_ratio)
        return a.start_date.toordinal() < b.start_date.toordinal()

    best_per_date: Dict[str, CandidateScore] = {}
    for item in all_scores:
        key = item.start_date.isoformat()
        cur = best_per_date.get(key)
        if cur is None or _is_better(item, cur):
            best_per_date[key] = item

    def _curve_unit_label(mode: str) -> str:
        if mode == "most_lucky_days":
            return "days"
        if mode == "highest_avg_temperature":
            return "deg C"
        if mode == "lowest_precip_sum":
            return "mm"
        if mode == "lowest_headwind_sum":
            return "days*m/s"
        return "score"

    def _curve_value_label(mode: str) -> str:
        if mode == "most_lucky_days":
            return "Lucky days"
        if mode == "highest_avg_temperature":
            return "Average temperature"
        if mode == "lowest_precip_sum":
            return "Precipitation sum"
        if mode == "lowest_headwind_sum":
            return "Headwind sum"
        return "Score"

    def _objective_value(item: CandidateScore, mode: str) -> float:
        if mode == "most_lucky_days":
            return float(item.summary.get("lucky_days") or 0.0)
        if mode == "highest_avg_temperature":
            avg_temp = _finite(item.summary.get("avg_temp_c"))
            return float(avg_temp) if avg_temp is not None else float("nan")
        if mode == "lowest_precip_sum":
            return float(item.summary.get("precip_sum_mm") or 0.0)
        if mode == "lowest_headwind_sum":
            return float(item.summary.get("headwind_sum_ms") or 0.0)
        return float(item.score)

    def _objective_higher_is_better(mode: str) -> bool:
        return mode in ("most_lucky_days", "highest_avg_temperature")

    objective_modes_all = [
        "most_lucky_days",
        "highest_avg_temperature",
        "lowest_precip_sum",
        "lowest_headwind_sum",
    ]

    curve_bundle: List[Dict[str, Any]] = []

    for curve_mode in objective_modes_all:
        curve_higher = _objective_higher_is_better(curve_mode)
        by_date_mode: Dict[str, Dict[str, Any]] = {}
        for item in all_scores:
            curve_score = float(_objective_score(item, curve_mode))
            d_iso = item.start_date.isoformat()
            cur = by_date_mode.get(d_iso)
            if cur is None:
                by_date_mode[d_iso] = {"item": item, "score": curve_score}
                continue
            cur_item = cur.get("item")
            cur_score = float(cur.get("score", 0.0))
            better = False
            if curve_higher:
                if curve_score != cur_score:
                    better = curve_score > cur_score
                elif float(item.missing_ratio) != float(cur_item.missing_ratio):
                    better = float(item.missing_ratio) < float(cur_item.missing_ratio)
                else:
                    better = str(item.direction) < str(cur_item.direction)
            else:
                if curve_score != cur_score:
                    better = curve_score < cur_score
                elif float(item.missing_ratio) != float(cur_item.missing_ratio):
                    better = float(item.missing_ratio) < float(cur_item.missing_ratio)
                else:
                    better = str(item.direction) < str(cur_item.direction)
            if better:
                by_date_mode[d_iso] = {"item": item, "score": curve_score}

        if not by_date_mode:
            continue

        entries = [(d_iso, rec["item"], float(rec["score"])) for d_iso, rec in by_date_mode.items()]
        if curve_higher:
            best_curve_score = max(v for (_d, _i, v) in entries)
        else:
            best_curve_score = min(v for (_d, _i, v) in entries)

        curve_points: List[Dict[str, Any]] = []
        for d_iso, item, v in sorted(entries, key=lambda t: t[0]):
            value = _objective_value(item, curve_mode)
            if curve_mode == "most_lucky_days":
                day_count = max(1.0, float(item.summary.get("day_count") or 1.0))
                penalty = max(0.0, (best_curve_score - v) * day_count / 100.0)
            elif curve_higher:
                penalty = max(0.0, best_curve_score - v)
            else:
                penalty = max(0.0, v - best_curve_score)
            curve_points.append({
                "start_date": str(d_iso),
                "direction": str(item.direction),
                "score": float(round(v, 4)),
                "value": (float(round(value, 4)) if math.isfinite(float(value)) else None),
                "penalty": float(round(float(penalty), 4)),
                "missing_ratio": float(round(float(item.missing_ratio), 4)),
            })

        ranked = sorted(
            entries,
            key=(
                (lambda t: (-t[2], float(t[1].missing_ratio), t[1].start_date.toordinal()))
                if curve_higher
                else (lambda t: (t[2], float(t[1].missing_ratio), t[1].start_date.toordinal()))
            ),
        )
        top_optima: List[Dict[str, Any]] = []
        for idx, (d_iso, item, v) in enumerate(ranked[:5]):
            point = next((p for p in curve_points if str(p.get("start_date")) == d_iso), None)
            top_optima.append({
                "rank": int(idx + 1),
                "start_date": str(d_iso),
                "direction": str(item.direction),
                "score": float(round(v, 4)),
                "value": (point.get("value") if isinstance(point, dict) else None),
                "penalty": float(point.get("penalty")) if isinstance(point, dict) else None,
            })

        curve_bundle.append({
            "id": str(curve_mode),
            "objective_mode": str(curve_mode),
            "objective_label": (
                "Lucky days"
                if curve_mode == "most_lucky_days"
                else "Average temperature"
                if curve_mode == "highest_avg_temperature"
                else "Precipitation sum"
                if curve_mode == "lowest_precip_sum"
                else "Headwind sum"
                if curve_mode == "lowest_headwind_sum"
                else "Lucky days"
            ),
            "unit": _curve_unit_label(curve_mode),
            "value_label": _curve_value_label(curve_mode),
            "penalty_label": _curve_value_label(curve_mode),
            "higher_is_better": bool(curve_higher),
            "points": curve_points,
            "optima": top_optima,
        })

    selected_curve = next((c for c in curve_bundle if str(c.get("id")) == str(objective_norm)), None)
    if selected_curve is None and curve_bundle:
        selected_curve = curve_bundle[0]

    def _candidate_to_json(item: CandidateScore) -> Dict[str, Any]:
        candidate_slot_sensitivity = _build_slot_sensitivity(
            best=item,
            anchor_year=int(anchor_year),
            years_selected=years_selected,
            day_ctx_forward=day_ctx_forward,
            day_ctx_reverse=day_ctx_reverse,
            weather_lookup=weather_lookup,
            objective_mode=objective_norm,
            higher_is_better=higher_is_better,
            score_values=score_values,
            lucky_thresholds=thresholds,
        )
        return {
            "direction": str(item.direction),
            "start_date": item.start_date.isoformat(),
            "end_date": item.end_date.isoformat(),
            "score": float(round(item.score, 3)),
            "missing_ratio": float(round(item.missing_ratio, 4)),
            "summary": dict(item.summary),
            "slot_sensitivity": candidate_slot_sensitivity,
            "reason": {
                "wind": "better tailwind alignment" if float(item.summary.get("wind_penalty", 0.0)) <= 0.0 else "headwind exposure present",
                "rain": "lower rain burden" if float(item.summary.get("rain_penalty", 0.0)) < 20.0 else "rain burden elevated",
                "temperature": "moderate thermal stress" if float(item.summary.get("temp_penalty", 0.0)) < 15.0 else "thermal stress elevated",
            },
        }

    return {
        "confidence": confidence,
        "meta": {
            "anchor_year": int(anchor_year),
            "years_selected": [int(y) for y in years_selected],
            "total_days": int(total_days_i),
            "ride_days": int(ride_days),
            "rest_day_indexes": list(rests),
            "direction_mode": direction_norm,
            "objective_mode": objective_norm,
            "slot_step_days": int(slot_step_i),
            "slot_granularity": "day" if int(slot_step_i) == 1 else "week",
            "objective_label": (
                "Lucky days"
                if objective_norm == "most_lucky_days"
                else "Average temperature"
                if objective_norm == "highest_avg_temperature"
                else "Precipitation sum"
                if objective_norm == "lowest_precip_sum"
                else "Headwind sum"
                if objective_norm == "lowest_headwind_sum"
                else "Lucky days"
            ),
            "candidate_count": int(len(all_scores)),
            "score_interpretation": "higher_is_better" if higher_is_better else "lower_is_better",
            "score_formula": (
                "score = lucky_days"
                if objective_norm == "most_lucky_days"
                else "score = avg_temp_c"
                if objective_norm == "highest_avg_temperature"
                else "score = precip_sum_mm"
                if objective_norm == "lowest_precip_sum"
                else "score = headwind_sum_ms"
                if objective_norm == "lowest_headwind_sum"
                else "score = lucky_days"
            ),
            "score_formula_human": (
                "Lucky-day count over the complete tour"
                if objective_norm == "most_lucky_days"
                else "Average daily temperature in C"
                if objective_norm == "highest_avg_temperature"
                else "Total precipitation across tour days in mm"
                if objective_norm == "lowest_precip_sum"
                else "Total headwind exposure across ride days"
                if objective_norm == "lowest_headwind_sum"
                else "Lucky-day count over the complete tour"
            ),
            "requested_years": sorted(int(y) for y in requested_years_set),
            "actual_years_used": sorted(int(y) for y in actual_years_used_set),
            "missing_requested_years": missing_requested_years,
            "year_penalty_curve": {
                "anchor_year": int(anchor_year),
                "unit": str((selected_curve or {}).get("unit") or "score"),
                "penalty_label": str((selected_curve or {}).get("value_label") or "Score"),
                "value_label": str((selected_curve or {}).get("value_label") or "Score"),
                "points": list((selected_curve or {}).get("points") or []),
                "optima": list((selected_curve or {}).get("optima") or []),
            },
            "year_penalty_curve_bundle": {
                "anchor_year": int(anchor_year),
                "default_curve_id": str((selected_curve or {}).get("id") or objective_norm),
                "curves": curve_bundle,
            },
            "slot_sensitivity": slot_sensitivity,
            "score_components": {
                "temperature": {
                    "cold_below_c": float(TEMP_COLD_C),
                    "hot_above_c": float(TEMP_HOT_C),
                    "cold_weight": float(TEMP_COLD_WEIGHT),
                    "hot_weight": float(TEMP_HOT_WEIGHT),
                },
                "rain": {
                    "mm_weight": float(RAIN_MM_WEIGHT),
                    "probability_weight": float(RAIN_PROB_WEIGHT),
                },
                "wind": {
                    "headwind_weight": float(WIND_HEAD_WEIGHT),
                    "tailwind_bonus_weight": float(WIND_TAIL_BONUS),
                },
                "missing_data_note": "days without usable weather add fallback penalty",
            },
        },
        "candidates": [_candidate_to_json(item) for item in top],
    }
