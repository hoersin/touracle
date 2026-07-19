import math
from typing import List, Tuple, Dict, Any, Optional
import gpxpy
from gpxpy.gpx import GPX

EARTH_RADIUS_KM = 6371.0088
RoutePoint = Tuple[float, float, Optional[float]]


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
