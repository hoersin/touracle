import math
from typing import List, Tuple, Dict, Any, Optional
import gpxpy
from gpxpy.gpx import GPX

EARTH_RADIUS_KM = 6371.0088
RoutePoint = Tuple[float, float, Optional[float]]


def _finite_or_none(value: Any) -> Optional[float]:
    try:
        num = float(value)
    except Exception:
        return None
    return num if math.isfinite(num) else None


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Compute haversine distance between two lat/lon points in kilometers."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_KM * c


def load_gpx_route(gpx_path: str) -> Dict[str, Any]:
    """Load GPX file once and return raw points, cumulative distance, and route geometry."""
    with open(gpx_path, 'r', encoding='utf-8') as f:
        gpx: GPX = gpxpy.parse(f)

    points: List[RoutePoint] = []
    for track in gpx.tracks:
        for seg in track.segments:
            for p in seg.points:
                points.append((p.latitude, p.longitude, p.elevation))

    for route in gpx.routes:
        for p in route.points:
            points.append((p.latitude, p.longitude, p.elevation))

    if len(points) < 2:
        raise ValueError("GPX must contain at least two points")

    cum_km: List[float] = [0.0]
    total_km = 0.0
    line_coords = []
    for idx, (lat, lon, _elev) in enumerate(points):
        line_coords.append([lon, lat])
        if idx == 0:
            continue
        prev_lat, prev_lon, _prev_elev = points[idx - 1]
        total_km += haversine_km(prev_lat, prev_lon, lat, lon)
        cum_km.append(total_km)

    return {
        "points": points,
        "cum_km": cum_km,
        "total_km": total_km,
        "route_geojson": {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": line_coords},
            "properties": {}
        },
    }


def load_gpx(gpx_path: str) -> List[Tuple[float, float]]:
    """Load GPX file and return list of (lat, lon) coordinates from tracks/routes."""
    route_data = load_gpx_route(gpx_path)
    return [(lat, lon) for (lat, lon, _elev) in route_data["points"]]


def _interpolate_elevation(elev1: Optional[float], elev2: Optional[float], t: float) -> Optional[float]:
    if elev1 is None and elev2 is None:
        return None
    if elev1 is None:
        return float(elev2) if elev2 is not None else None
    if elev2 is None:
        return float(elev1)
    return float(elev1 + (elev2 - elev1) * t)


def sample_route_data(route_data: Dict[str, Any], step_km: float = 25.0) -> Dict[str, Any]:
    """Sample a parsed route and retain sampled distance/elevation metadata."""
    points: List[RoutePoint] = route_data["points"]
    cum_km: List[float] = route_data["cum_km"]

    sampled_points: List[Tuple[float, float]] = []
    sampled_dist_km: List[float] = []
    sampled_elev_m: List[Optional[float]] = []
    next_mark = 0.0

    first_lat, first_lon, first_elev = points[0]
    sampled_points.append((first_lat, first_lon))
    sampled_dist_km.append(0.0)
    sampled_elev_m.append(float(first_elev) if first_elev is not None else None)

    for i in range(1, len(points)):
        lat1, lon1, elev1 = points[i - 1]
        lat2, lon2, elev2 = points[i]
        accumulated = cum_km[i - 1]
        seg_km = cum_km[i] - cum_km[i - 1]
        if seg_km <= 0:
            continue
        while next_mark <= accumulated + seg_km:
            remain = next_mark - accumulated
            t = max(0.0, min(1.0, remain / seg_km))
            lat = lat1 + (lat2 - lat1) * t
            lon = lon1 + (lon2 - lon1) * t
            sampled_points.append((lat, lon))
            sampled_dist_km.append(next_mark)
            sampled_elev_m.append(_interpolate_elevation(elev1, elev2, t))
            next_mark += step_km

    last_lat, last_lon, last_elev = points[-1]
    if sampled_points[-1] != (last_lat, last_lon):
        sampled_points.append((last_lat, last_lon))
        sampled_dist_km.append(float(cum_km[-1]))
        sampled_elev_m.append(float(last_elev) if last_elev is not None else None)

    return {
        "sampled_points": sampled_points,
        "sampled_dist_km": sampled_dist_km,
        "sampled_elev_m": sampled_elev_m,
        "route_geojson": route_data["route_geojson"],
    }


def sample_route(gpx_path: str, step_km: float = 25.0) -> Tuple[List[Tuple[float, float]], Dict[str, Any]]:
    """
    Load a GPX file, sample points every step_km along the route, and return:
    - sampled_points: list of (lat, lon)
    - route_geojson: Feature with LineString geometry of the route
    """
    route_data = load_gpx_route(gpx_path)
    sampled = sample_route_data(route_data, step_km=step_km)
    return sampled["sampled_points"], sampled["route_geojson"]


def compute_elevation_stats_from_series(
    distances_km: List[float],
    elevations_m: List[Optional[float]],
    *,
    stage_key: str,
    label: str,
) -> Dict[str, Any]:
    """Compute robust route/elevation stats for a distance/elevation series."""
    n = min(len(distances_km), len(elevations_m))
    if n <= 0:
        return {
            "key": stage_key,
            "label": label,
            "points": 0,
            "distance_km": 0.0,
            "min_elevation_m": None,
            "max_elevation_m": None,
            "ascent_m": 0.0,
            "descent_m": 0.0,
            "missing_elevation_points": 0,
            "missing_elevation_ratio": 0.0,
        }

    finite_elevs: List[float] = []
    ascent_m = 0.0
    descent_m = 0.0
    prev_elev: Optional[float] = None
    missing_count = 0

    for i in range(n):
        elev = _finite_or_none(elevations_m[i])
        if elev is None:
            missing_count += 1
            continue
        finite_elevs.append(elev)
        if prev_elev is not None:
            delta = elev - prev_elev
            if delta > 0:
                ascent_m += delta
            elif delta < 0:
                descent_m += -delta
        prev_elev = elev

    distance_km = _finite_or_none(distances_km[n - 1])
    if distance_km is None:
        distance_km = 0.0

    return {
        "key": stage_key,
        "label": label,
        "points": int(n),
        "distance_km": float(distance_km),
        "min_elevation_m": (float(min(finite_elevs)) if finite_elevs else None),
        "max_elevation_m": (float(max(finite_elevs)) if finite_elevs else None),
        "ascent_m": float(ascent_m),
        "descent_m": float(descent_m),
        "missing_elevation_points": int(missing_count),
        "missing_elevation_ratio": float(missing_count / max(1, n)),
    }


def compute_elevation_stats_from_route_data(
    route_data: Dict[str, Any],
    *,
    stage_key: str = "original_gpx",
    label: str = "Original GPX",
) -> Dict[str, Any]:
    points = list(route_data.get("points") or [])
    cum_km = list(route_data.get("cum_km") or [])
    distances = [float(v) for v in cum_km[: len(points)]]
    elevs: List[Optional[float]] = [
        _finite_or_none(pt[2] if isinstance(pt, (tuple, list)) and len(pt) >= 3 else None)
        for pt in points
    ]
    return compute_elevation_stats_from_series(distances, elevs, stage_key=stage_key, label=label)


def compare_elevation_stats(reference: Dict[str, Any], current: Dict[str, Any]) -> Dict[str, Any]:
    ref_ascent = _finite_or_none(reference.get("ascent_m")) or 0.0
    cur_ascent = _finite_or_none(current.get("ascent_m")) or 0.0
    ref_descent = _finite_or_none(reference.get("descent_m")) or 0.0
    cur_descent = _finite_or_none(current.get("descent_m")) or 0.0
    ascent_loss = ref_ascent - cur_ascent
    descent_loss = ref_descent - cur_descent
    ascent_loss_pct = (ascent_loss / ref_ascent * 100.0) if ref_ascent > 0 else 0.0
    descent_loss_pct = (descent_loss / ref_descent * 100.0) if ref_descent > 0 else 0.0
    return {
        "reference_key": str(reference.get("key") or "reference"),
        "current_key": str(current.get("key") or "current"),
        "ascent_loss_m": float(ascent_loss),
        "ascent_loss_pct": float(ascent_loss_pct),
        "descent_loss_m": float(descent_loss),
        "descent_loss_pct": float(descent_loss_pct),
    }


def compute_segment_ascent_sum(
    distances_km: List[float],
    elevations_m: List[Optional[float]],
    boundaries_km: List[float],
) -> Dict[str, Any]:
    """Compute ascent totals per segment and aggregate for consistency checks."""
    n = min(len(distances_km), len(elevations_m))
    if n <= 1:
        return {"segment_ascent_m": [], "sum_ascent_m": 0.0}

    marks = sorted(float(v) for v in boundaries_km)
    bounds = [0.0] + marks + [float(distances_km[n - 1])]
    seg_count = max(0, len(bounds) - 1)
    segment_ascent = [0.0 for _ in range(seg_count)]
    seg_idx = 0
    prev_elev: Optional[float] = _finite_or_none(elevations_m[0])

    for i in range(1, n):
        d = _finite_or_none(distances_km[i])
        elev = _finite_or_none(elevations_m[i])
        if d is None:
            continue
        while seg_idx < seg_count - 1 and d > bounds[seg_idx + 1]:
            seg_idx += 1
        if elev is None:
            continue
        if prev_elev is not None and elev > prev_elev and 0 <= seg_idx < seg_count:
            segment_ascent[seg_idx] += (elev - prev_elev)
        prev_elev = elev

    return {
        "segment_ascent_m": [float(v) for v in segment_ascent],
        "sum_ascent_m": float(sum(segment_ascent)),
    }
