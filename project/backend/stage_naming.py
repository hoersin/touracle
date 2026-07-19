"""
Stage Naming Engine: Generate meaningful stage descriptions using priority-based logic.

Priority hierarchy:
1. Scenic regions/landscapes (Bardenas Reales, Black Forest, Vercors, etc.)
2. Meaningful start/destination towns (avoid duplicates, tiny villages, industrial zones)
3. Larger nearby towns if endpoints are insignificant
4. Coordinates as absolute fallback

Maintains continuity: Day N destination = Day N+1 start.
Handles duplicates: If start==destination, searches nearby or uses scenic region.
"""

import math
from typing import Dict, List, Tuple, Optional, Any

# Database of well-known scenic regions by geographic region (lat/lon bounding boxes)
# Format: (name, min_lat, max_lat, min_lon, max_lon, priority_boost)
SCENIC_REGIONS = [
    # European regions
    ("Bardenas Reales", 42.0, 42.6, -1.8, -1.0, 3.0),
    ("Black Forest", 48.3, 49.0, 7.8, 9.0, 3.0),
    ("Vercors", 44.7, 45.4, 5.2, 5.9, 3.0),
    ("Massif Central", 44.0, 45.5, 2.5, 4.5, 3.0),
    ("Pyrenees", 42.2, 43.3, -2.5, 1.5, 3.5),
    ("Alps", 43.5, 48.5, 4.5, 16.0, 3.5),
    ("Apennines", 41.0, 44.0, 11.0, 15.0, 3.0),
    ("Carpathians", 45.0, 49.0, 19.0, 28.0, 3.0),
    ("Dolomites", 45.9, 46.7, 11.0, 12.8, 3.0),
    ("Lake District", 54.0, 54.6, -3.5, -2.9, 2.5),
    ("Scottish Highlands", 56.0, 58.0, -5.0, -2.0, 2.5),
    ("Peak District", 52.8, 53.5, -2.0, -1.2, 2.0),
    ("Cotswolds", 51.5, 52.2, -2.2, -1.5, 2.0),
    ("Lake Garda", 45.3, 45.7, 10.5, 11.0, 2.5),
    ("Tuscany", 42.5, 43.5, 11.0, 13.0, 2.5),
    ("Dutch Lowlands", 50.7, 53.5, 3.5, 7.5, 1.5),
    ("Danube Valley", 48.0, 48.5, 14.5, 15.5, 2.0),
    ("Swiss Alps", 46.2, 47.0, 7.5, 9.5, 3.5),
    ("Jura Mountains", 46.0, 47.2, 5.0, 6.5, 2.5),
    ("Provence", 43.5, 44.5, 4.5, 6.5, 2.5),
]

# Size thresholds for town selection
TOWN_SIZE_THRESHOLD = 500  # Minimum population for meaningful towns
TINY_VILLAGE_THRESHOLD = 50  # Villages below this are considered "tiny"
LARGE_TOWN_THRESHOLD = 50000  # Towns above this are considered "large"


def _scenic_region_score(lat: float, lon: float) -> Tuple[Optional[str], float]:
    """
    Check if coordinates are within a scenic region.
    Returns (region_name, score_bonus).
    """
    for name, min_lat, max_lat, min_lon, max_lon, priority in SCENIC_REGIONS:
        if min_lat <= lat <= max_lat and min_lon <= lon <= max_lon:
            return (name, priority)
    return (None, 0.0)


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance in km between two lat/lon points."""
    R = 6371.0  # Earth radius in km
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    delta_lat = math.radians(lat2 - lat1)
    delta_lon = math.radians(lon2 - lon1)
    a = math.sin(delta_lat / 2) ** 2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon / 2) ** 2
    c = 2 * math.asin(math.sqrt(a))
    return R * c


def _location_quality_score(
    location: Dict[str, Any],
    reference_lat: float,
    reference_lon: float,
    is_start: bool = True,
) -> float:
    """
    Score a location candidate based on:
    - Population (larger towns preferred)
    - Distance (closer preferred)
    - Type importance (towns > villages > hamlets)
    - Quality filters (avoid industrial zones, suburbs, etc.)
    
    Returns a score where higher is better.
    """
    try:
        name = str(location.get("name") or "").strip()
        if not name:
            return 0.0

        pop = max(0, int(location.get("population") or 0))
        admin_type = str(location.get("admin_type") or "").lower()
        distance_km = location.get("distance_km", 0.0)

        # Disqualify tiny villages for start/end (unless no alternatives)
        if pop < TINY_VILLAGE_THRESHOLD and admin_type in ("hamlet", "suburb", "city_district"):
            return 0.1

        # Disqualify obvious industrial/administrative zones
        if admin_type in ("industrial_zone", "commercial_zone"):
            return 0.0

        # Population score (logarithmic)
        pop_score = min(10.0, math.log10(max(1, pop)) * 2.0) if pop > 0 else 2.0

        # Distance score (closer is better, but start/end can be farther if quality is high)
        distance_weight = 20.0 if is_start else 15.0
        distance_score = max(0.0, distance_weight - (distance_km * 0.5))

        # Type importance
        type_scores = {
            "city": 8.0,
            "town": 7.0,
            "municipality": 6.0,
            "locality": 5.0,
            "village": 3.0,
            "suburb": 1.0,
            "hamlet": 0.5,
        }
        type_score = type_scores.get(admin_type, 2.0)

        # Combine scores
        total = pop_score + distance_score + type_score

        return max(0.0, total)

    except Exception:
        return 0.0


def compute_stage_name(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    start_candidates: Optional[List[Dict[str, Any]]] = None,
    end_candidates: Optional[List[Dict[str, Any]]] = None,
    previous_stage_end_name: Optional[str] = None,
) -> str:
    """
    Compute a meaningful stage name using priority-based logic.
    
    Args:
        start_lat, start_lon: Stage start coordinates
        end_lat, end_lon: Stage end coordinates
        start_candidates: List of reverse-geocoded location candidates for start
        end_candidates: List of reverse-geocoded location candidates for end
        previous_stage_end_name: Name of previous stage's endpoint (for continuity)
    
    Returns:
        A formatted stage description string.
    """
    
    # Priority 1: Scenic regions — only used when candidates do not supply a real name.
    scenic_start, scenic_start_score = _scenic_region_score(start_lat, start_lon)
    scenic_end, scenic_end_score = _scenic_region_score(end_lat, end_lon)

    # Resolve geocoded names from candidates first.
    geo_start = _pick_endpoint_name(start_lat, start_lon, start_candidates, 'start',
                                     avoid_name=previous_stage_end_name)
    geo_end = _pick_endpoint_name(end_lat, end_lon, end_candidates, 'end')

    # Use scenic regions only when the geocoded name is absent (no candidates supplied).
    effective_start = geo_start or (scenic_start if scenic_start else '')
    effective_end = geo_end or (scenic_end if scenic_end else '')

    # If both endpoints landed in the same scenic region and have no geocoded names, return region.
    if not geo_start and not geo_end and scenic_start and scenic_end:
        if scenic_start == scenic_end:
            return scenic_start
        return f"{scenic_start} → {scenic_end}"

    # Priority 2: Meaningful start/destination towns
    start_name = effective_start
    end_name = effective_end
    
    # Priority 3: Handle duplicates or insignificant endpoints
    if start_name == end_name or start_name == previous_stage_end_name:
        # Try to find a nearby larger town
        alt_start = _find_nearby_significant_town(start_lat, start_lon, start_candidates, avoid_name=start_name)
        if alt_start:
            start_name = alt_start
    
    if not end_name or end_name == start_name:
        alt_end = _find_nearby_significant_town(end_lat, end_lon, end_candidates, avoid_name=start_name)
        if alt_end:
            end_name = alt_end

    if start_name and end_name and start_name == end_name:
        alt_end = _find_nearby_meaningful_place(end_lat, end_lon, end_candidates, avoid_name=start_name)
        if alt_end:
            end_name = alt_end
        else:
            alt_start = _find_nearby_meaningful_place(start_lat, start_lon, start_candidates, avoid_name=end_name)
            if alt_start:
                start_name = alt_start

    if start_name and end_name and start_name == end_name:
        alt_end_wide = _find_nearby_meaningful_place(
            end_lat,
            end_lon,
            end_candidates,
            avoid_name=start_name,
            min_population=TINY_VILLAGE_THRESHOLD,
            max_distance_km=90.0,
        )
        if alt_end_wide:
            end_name = alt_end_wide
        else:
            alt_start_wide = _find_nearby_meaningful_place(
                start_lat,
                start_lon,
                start_candidates,
                avoid_name=end_name,
                min_population=TINY_VILLAGE_THRESHOLD,
                max_distance_km=90.0,
            )
            if alt_start_wide:
                start_name = alt_start_wide

    if start_name and end_name and start_name == end_name:
        scenic_start, _ = _scenic_region_score(start_lat, start_lon)
        scenic_end, _ = _scenic_region_score(end_lat, end_lon)
        if scenic_start and scenic_start != end_name:
            start_name = scenic_start
        elif scenic_end and scenic_end != start_name:
            end_name = scenic_end
    
    # Priority 4: Fallback to coordinates
    if not start_name:
        start_name = f"({start_lat:.2f}, {start_lon:.2f})"
    if not end_name:
        end_name = f"({end_lat:.2f}, {end_lon:.2f})"
    
    return f"{start_name} → {end_name}"


def _pick_endpoint_name(
    lat: float,
    lon: float,
    candidates: Optional[List[Dict[str, Any]]] = None,
    endpoint_type: str = "end",
    avoid_name: Optional[str] = None,
) -> str:
    """
    Pick the best location name from a list of reverse-geocoding candidates.
    
    Args:
        lat, lon: Coordinates
        candidates: List of locations with 'name', 'population', 'admin_type', etc.
        endpoint_type: 'start' or 'end' (affects distance weighting)
        avoid_name: Skip this name if present
    
    Returns:
        Best location name or empty string if none found.
    """
    if not candidates or not isinstance(candidates, list):
        return ""
    
    best_name = ""
    best_score = 0.0
    
    for candidate in candidates:
        name = str(candidate.get("name") or "").strip()
        
        # Skip if matches avoid_name or is too short
        if not name or (avoid_name and name.lower() == avoid_name.lower()):
            continue
        
        # Skip tiny villages unless they're the only option
        pop = int(candidate.get("population") or 0)
        admin_type = str(candidate.get("admin_type") or "").lower()
        
        if pop < TINY_VILLAGE_THRESHOLD and admin_type == "hamlet":
            continue
        
        # Calculate distance for weighting
        cand_lat = float(candidate.get("lat", lat))
        cand_lon = float(candidate.get("lon", lon))
        distance_km = _haversine_km(lat, lon, cand_lat, cand_lon)
        
        candidate_copy = dict(candidate)
        candidate_copy["distance_km"] = distance_km
        
        score = _location_quality_score(
            candidate_copy, lat, lon, is_start=(endpoint_type == "start")
        )
        
        if score > best_score:
            best_score = score
            best_name = name
    
    return best_name


def _find_nearby_significant_town(
    lat: float,
    lon: float,
    candidates: Optional[List[Dict[str, Any]]] = None,
    avoid_name: Optional[str] = None,
    max_distance_km: float = 50.0,
) -> Optional[str]:
    """
    Find a nearby town of reasonable size (>50k population) different from avoid_name.
    Used to resolve duplicates or insignificant endpoints.
    """
    if not candidates or not isinstance(candidates, list):
        return None
    
    best_name = None
    best_score = 0.0
    
    for candidate in candidates:
        name = str(candidate.get("name") or "").strip()
        pop = int(candidate.get("population") or 0)
        
        # Skip if too small, matches avoid_name, or too far
        if pop < LARGE_TOWN_THRESHOLD or (avoid_name and name.lower() == avoid_name.lower()):
            continue
        
        cand_lat = float(candidate.get("lat", lat))
        cand_lon = float(candidate.get("lon", lon))
        distance_km = _haversine_km(lat, lon, cand_lat, cand_lon)
        
        if distance_km > max_distance_km:
            continue
        
        # Score: prefer closer and larger
        score = (pop / LARGE_TOWN_THRESHOLD) * (max_distance_km - distance_km) / max_distance_km
        
        if score > best_score:
            best_score = score
            best_name = name
    
    return best_name


def _find_nearby_meaningful_place(
    lat: float,
    lon: float,
    candidates: Optional[List[Dict[str, Any]]] = None,
    avoid_name: Optional[str] = None,
    min_population: int = TOWN_SIZE_THRESHOLD,
    max_distance_km: float = 35.0,
) -> Optional[str]:
    """Find a meaningful nearby place when strict large-town fallback fails."""
    if not candidates or not isinstance(candidates, list):
        return None

    best_name = None
    best_score = -1.0

    for candidate in candidates:
        name = str(candidate.get("name") or "").strip()
        if not name:
            continue
        if avoid_name and name.lower() == avoid_name.lower():
            continue

        pop = int(candidate.get("population") or 0)
        admin_type = str(candidate.get("admin_type") or "").lower()
        if pop < min_population and admin_type not in ("town", "city", "municipality"):
            continue

        cand_lat = float(candidate.get("lat", lat))
        cand_lon = float(candidate.get("lon", lon))
        distance_km = _haversine_km(lat, lon, cand_lat, cand_lon)
        if distance_km > max_distance_km:
            continue

        distance_score = max(0.0, max_distance_km - distance_km)
        population_score = math.log10(max(1, pop)) if pop > 0 else 0.0
        type_bonus = 1.2 if admin_type in ("city", "town") else 0.8 if admin_type == "municipality" else 0.0
        score = distance_score + population_score + type_bonus
        if score > best_score:
            best_score = score
            best_name = name

    return best_name


def build_stage_names(
    stage_coords: List[Tuple[float, float, float, float]],
    stage_candidates: Optional[List[Optional[List[Dict[str, Any]]]]] = None,
) -> List[str]:
    """
    Build stage names for an entire tour, ensuring continuity.
    
    Args:
        stage_coords: List of (start_lat, start_lon, end_lat, end_lon) tuples
        stage_candidates: Optional list of (start_candidates, end_candidates) lists
    
    Returns:
        List of formatted stage names with continuity maintained.
    """
    names = []
    previous_end_name = None
    
    for i, coords in enumerate(stage_coords):
        start_lat, start_lon, end_lat, end_lon = coords
        
        start_cands = None
        end_cands = None
        if stage_candidates and i < len(stage_candidates) and stage_candidates[i]:
            start_cands, end_cands = stage_candidates[i]
        
        name = compute_stage_name(
            start_lat, start_lon, end_lat, end_lon,
            start_candidates=start_cands,
            end_candidates=end_cands,
            previous_stage_end_name=previous_end_name,
        )
        
        names.append(name)
        
        # Extract end name for continuity check
        if " → " in name:
            previous_end_name = name.split(" → ")[-1].strip()
        else:
            previous_end_name = name
    
    return names
