from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass
import math
from meteostat import stations as stations_fn


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0088
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


@dataclass
class Station:
    id: str
    name: str
    lat: float
    lon: float


class KDNode:
    __slots__ = ("point", "index", "left", "right", "axis")
    def __init__(self, point: Tuple[float, float], index: int, axis: int):
        self.point = point
        self.index = index
        self.left = None
        self.right = None
        self.axis = axis


class SimpleKDTree:
    def __init__(self, points: List[Tuple[float, float]]):
        self.root = self._build(points, list(range(len(points))), depth=0)
        self.points = points

    def _build(self, points: List[Tuple[float, float]], idxs: List[int], depth: int) -> Optional[KDNode]:
        if not idxs:
            return None
        axis = depth % 2
        idxs.sort(key=lambda i: points[i][axis])
        mid = len(idxs) // 2
        node = KDNode(points[idxs[mid]], idxs[mid], axis)
        node.left = self._build(points, idxs[:mid], depth + 1)
        node.right = self._build(points, idxs[mid + 1 :], depth + 1)
        return node

    def nearest(self, query: Tuple[float, float]) -> int:
        best_dist2 = float("inf")
        best_idx = -1

        def dist2(a: Tuple[float, float], b: Tuple[float, float]) -> float:
            dx = a[0] - b[0]
            dy = a[1] - b[1]
            return dx * dx + dy * dy

        def search(node: Optional[KDNode]):
            nonlocal best_dist2, best_idx
            if node is None:
                return
            d2 = dist2(query, node.point)
            if d2 < best_dist2:
                best_dist2 = d2
                best_idx = node.index
            axis = node.axis
            diff = query[axis] - node.point[axis]
            first = node.left if diff < 0 else node.right
            second = node.right if diff < 0 else node.left
            search(first)
            if diff * diff < best_dist2:
                search(second)

        search(self.root)
        return best_idx


class StationIndex:
    def __init__(self):
        self.stations: List[Station] = []
        self.points: List[Tuple[float, float]] = []
        self.tree: Optional[SimpleKDTree] = None

    def load_for_bounds(self, min_lat: float, min_lon: float, max_lat: float, max_lon: float, margin_deg: float = 0.5):
        min_lat -= margin_deg
        min_lon -= margin_deg
        max_lat += margin_deg
        max_lon += margin_deg
        try:
            df = stations_fn(bounds=(min_lat, min_lon, max_lat, max_lon))
            if df is None or df.empty:
                # Fallback: load all stations then filter locally
                df = stations_fn()
                if df is not None and not df.empty:
                    df = df[(df['latitude'] >= min_lat) & (df['latitude'] <= max_lat) &
                            (df['longitude'] >= min_lon) & (df['longitude'] <= max_lon)]
        except Exception:
            df = None
        self.stations.clear()
        self.points.clear()
        if df is None or df.empty:
            # Dynamic fallback stations within bounds: center and corners
            center_lat = (min_lat + max_lat) / 2.0
            center_lon = (min_lon + max_lon) / 2.0
            fallback = [
                Station('FALLBACK_C', 'Fallback Center', center_lat, center_lon),
                Station('FALLBACK_SW', 'Fallback SW', min_lat + 0.1, min_lon + 0.1),
                Station('FALLBACK_NE', 'Fallback NE', max_lat - 0.1, max_lon - 0.1),
            ]
            self.stations = fallback
            self.points = [(s.lat, s.lon) for s in fallback]
            self.tree = SimpleKDTree(self.points)
            return
        for _, row in df.iterrows():
            sid = str(row.get("id"))
            name = str(row.get("name", ""))
            lat = float(row.get("latitude"))
            lon = float(row.get("longitude"))
            self.stations.append(Station(sid, name, lat, lon))
            self.points.append((lat, lon))
        self.tree = SimpleKDTree(self.points)

    def nearest_station(self, lat: float, lon: float) -> Optional[Tuple[Station, float]]:
        if not self.tree or not self.points:
            return None
        idx = self.tree.nearest((lat, lon))
        st = self.stations[idx]
        dist_km = haversine_km(lat, lon, st.lat, st.lon)
        return st, dist_km


def find_nearest_station(lat: float, lon: float, index: StationIndex) -> Optional[Tuple[Station, float]]:
    """Convenience wrapper to find nearest station using a provided index."""
    return index.nearest_station(lat, lon)
