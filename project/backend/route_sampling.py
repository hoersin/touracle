import math
from typing import List, Tuple, Dict, Any
import gpxpy
from gpxpy.gpx import GPX

EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Compute haversine distance between two lat/lon points in kilometers."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_KM * c


def load_gpx(gpx_path: str) -> List[Tuple[float, float]]:
    """Load GPX file and return list of (lat, lon) coordinates from tracks/routes."""
    with open(gpx_path, 'r', encoding='utf-8') as f:
        gpx: GPX = gpxpy.parse(f)

    coords: List[Tuple[float, float]] = []
    for track in gpx.tracks:
        for seg in track.segments:
            for p in seg.points:
                coords.append((p.latitude, p.longitude))

    for route in gpx.routes:
        for p in route.points:
            coords.append((p.latitude, p.longitude))

    if len(coords) < 2:
        raise ValueError("GPX must contain at least two points")
    return coords


def sample_route(gpx_path: str, step_km: float = 25.0) -> Tuple[List[Tuple[float, float]], Dict[str, Any]]:
    """
    Load a GPX file, sample points every step_km along the route, and return:
    - sampled_points: list of (lat, lon)
    - route_geojson: Feature with LineString geometry of the route
    """
    coords = load_gpx(gpx_path)

    # Compute cumulative distances and sample
    sampled: List[Tuple[float, float]] = []
    accumulated = 0.0
    next_mark = 0.0

    sampled.append(coords[0])
    for i in range(1, len(coords)):
        lat1, lon1 = coords[i - 1]
        lat2, lon2 = coords[i]
        seg_km = haversine_km(lat1, lon1, lat2, lon2)
        if seg_km <= 0:
            continue
        while next_mark <= accumulated + seg_km:
            # proportion along segment
            remain = next_mark - accumulated
            t = max(0.0, min(1.0, remain / seg_km))
            lat = lat1 + (lat2 - lat1) * t
            lon = lon1 + (lon2 - lon1) * t
            sampled.append((lat, lon))
            next_mark += step_km
        accumulated += seg_km

    # Ensure last point included
    if sampled[-1] != coords[-1]:
        sampled.append(coords[-1])

    # Build route GeoJSON Feature
    line_coords = [[lon, lat] for (lat, lon) in coords]
    route_geojson = {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": line_coords},
        "properties": {}
    }

    return sampled, route_geojson
