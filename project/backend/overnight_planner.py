from __future__ import annotations

import math
import os
import time
from typing import Any, Callable, Dict, Iterable, List, Tuple

import requests

from route_sampling import haversine_km


OverpassFetcher = Callable[[str, int], Dict[str, Any]]

SUPPORTED_TYPES = {
    'camping',
    'hotel',
    'hostel',
    'guesthouse',
    'bivouac',
    'other',
}

OSM_TOURISM_REGEX = 'camp_site|caravan_site|hostel|hotel|guest_house|motel|alpine_hut|wilderness_hut'
CATEGORY_TO_TOURISM = {
    'camping': ('camp_site', 'caravan_site'),
    'hotel': ('hotel', 'guest_house', 'motel'),
    'hostel': ('hostel',),
    'bivouac': ('alpine_hut', 'wilderness_hut'),
}
DISCOURAGED_OVERPASS_HOSTS = {
    'z.overpass-api.de',
}
DEFAULT_OVERPASS_ENDPOINTS = (
    'https://overpass.openstreetmap.fr/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
)
_OVERPASS_ENDPOINT_COOLDOWN_UNTIL: Dict[str, float] = {}


class OverpassRequestError(requests.RequestException):
    def __init__(self, message: str, *, attempts: List[Dict[str, Any]] | None = None):
        super().__init__(message)
        self.attempts = list(attempts or [])


def _normalize_type(raw: Any) -> str:
    value = str(raw or '').strip().lower()
    return value if value in SUPPORTED_TYPES else 'other'


def _coerce_lat_lon(element: Dict[str, Any]) -> Tuple[float | None, float | None]:
    try:
        if 'lat' in element and 'lon' in element:
            lat = float(element.get('lat'))
            lon = float(element.get('lon'))
            if math.isfinite(lat) and math.isfinite(lon):
                return lat, lon
    except Exception:
        pass
    center = element.get('center')
    if isinstance(center, dict):
        try:
            lat = float(center.get('lat'))
            lon = float(center.get('lon'))
            if math.isfinite(lat) and math.isfinite(lon):
                return lat, lon
        except Exception:
            pass
    return None, None


def _classify_osm_type(tags: Dict[str, Any]) -> str:
    tourism = str(tags.get('tourism') or '').strip().lower()
    if tourism in ('camp_site', 'caravan_site'):
        return 'camping'
    if tourism in ('hotel', 'motel'):
        return 'hotel'
    if tourism == 'hostel':
        return 'hostel'
    if tourism == 'guest_house':
        return 'guesthouse'
    if tourism in ('alpine_hut', 'wilderness_hut'):
        return 'bivouac'
    return 'other'


def _sample_route_points(points: Iterable[Tuple[float, float]], sample_step_km: float, max_points: int) -> List[Tuple[float, float]]:
    source = list(points)
    if len(source) <= 2:
        return source
    out: List[Tuple[float, float]] = [source[0]]
    step = max(0.5, float(sample_step_km))
    max_n = max(8, int(max_points))
    carried = 0.0
    for idx in range(1, len(source)):
        lat1, lon1 = source[idx - 1]
        lat2, lon2 = source[idx]
        seg = haversine_km(lat1, lon1, lat2, lon2)
        if not math.isfinite(seg) or seg <= 0:
            continue
        carried += seg
        if carried >= step:
            out.append((lat2, lon2))
            carried = 0.0
            if len(out) >= max_n:
                break
    if out[-1] != source[-1] and len(out) < max_n:
        out.append(source[-1])
    return out


def _tourism_regex_for_categories(categories: Iterable[str] | None) -> str:
    selected = [str(c or '').strip().lower() for c in (categories or []) if str(c or '').strip()]
    allowed: List[str] = []
    for category in selected:
        allowed.extend(CATEGORY_TO_TOURISM.get(category, ()))
    if not allowed:
        return OSM_TOURISM_REGEX
    deduped = []
    seen = set()
    for value in allowed:
        if value in seen:
            continue
        seen.add(value)
        deduped.append(value)
    return '|'.join(deduped) if deduped else OSM_TOURISM_REGEX


def _build_overpass_query(samples: List[Tuple[float, float]], radius_m: int, tourism_regex: str, per_query_limit: int) -> str:
    parts: List[str] = []
    for lat, lon in samples:
        parts.append(f'nw["tourism"~"{tourism_regex}"](around:{radius_m},{lat:.6f},{lon:.6f});')
    out_limit = max(10, min(500, int(per_query_limit)))
    return f'[out:json][timeout:25];({"".join(parts)});out center tags {out_limit};'


def _configured_overpass_endpoints() -> Tuple[str, ...]:
    raw = str(os.environ.get('TOURACLE_OVERPASS_ENDPOINTS') or '').strip()
    if not raw:
        return DEFAULT_OVERPASS_ENDPOINTS
    values = [entry.strip() for entry in raw.split(',') if entry.strip()]
    filtered = []
    for endpoint in values:
        host = ''
        try:
            host = str(requests.utils.urlparse(endpoint).hostname or '').strip().lower()
        except Exception:
            host = ''
        if host in DISCOURAGED_OVERPASS_HOSTS:
            continue
        filtered.append(endpoint)
    return tuple(filtered) if filtered else DEFAULT_OVERPASS_ENDPOINTS


def _fetch_overpass_with_debug(query: str, timeout_seconds: int) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    now = time.time()
    endpoints = tuple(
        endpoint for endpoint in _configured_overpass_endpoints()
        if _OVERPASS_ENDPOINT_COOLDOWN_UNTIL.get(endpoint, 0.0) <= now
    ) or _configured_overpass_endpoints()
    attempts: List[Dict[str, Any]] = []
    last_error: Exception | None = None
    started = time.time()
    budget_seconds = max(10.0, float(timeout_seconds))
    for endpoint in endpoints:
        for attempt in range(2):
            remaining = max(2.0, budget_seconds - (time.time() - started))
            call_timeout = max(8.0, min(30.0, remaining))
            run_started = time.time()
            try:
                resp = requests.post(
                    endpoint,
                    data={'data': query},
                    headers={'User-Agent': 'Touracle/1.0'},
                    timeout=call_timeout,
                )
                status = int(resp.status_code or 0)
                if status in (429, 502, 503, 504):
                    if attempt == 0:
                        _OVERPASS_ENDPOINT_COOLDOWN_UNTIL[endpoint] = time.time() + 120.0
                        attempts.append({
                            'endpoint': endpoint,
                            'attempt': attempt + 1,
                            'status': status,
                            'durationMs': int(max(0.0, (time.time() - run_started) * 1000.0)),
                            'retry': True,
                            'error': f'HTTP {status}',
                        })
                        time.sleep(0.35)
                        continue
                resp.raise_for_status()
                try:
                    payload = resp.json()
                except Exception as err:
                    _OVERPASS_ENDPOINT_COOLDOWN_UNTIL[endpoint] = time.time() + 120.0
                    attempts.append({
                        'endpoint': endpoint,
                        'attempt': attempt + 1,
                        'status': status,
                        'durationMs': int(max(0.0, (time.time() - run_started) * 1000.0)),
                        'retry': False,
                        'error': f'Invalid JSON payload: {err}',
                    })
                    last_error = requests.RequestException(f'Invalid Overpass payload from {endpoint}: {err}')
                    break
                if not isinstance(payload, dict):
                    raise ValueError('Invalid Overpass payload')
                attempts.append({
                    'endpoint': endpoint,
                    'attempt': attempt + 1,
                    'status': status,
                    'durationMs': int(max(0.0, (time.time() - run_started) * 1000.0)),
                    'retry': False,
                    'ok': True,
                })
                return payload, {
                    'endpoint': endpoint,
                    'attempts': attempts,
                }
            except requests.RequestException as err:
                last_error = err
                status = int(getattr(getattr(err, 'response', None), 'status_code', 0) or 0)
                transient = status in (429, 502, 503, 504)
                if transient:
                    _OVERPASS_ENDPOINT_COOLDOWN_UNTIL[endpoint] = time.time() + 120.0
                attempts.append({
                    'endpoint': endpoint,
                    'attempt': attempt + 1,
                    'status': status or None,
                    'durationMs': int(max(0.0, (time.time() - run_started) * 1000.0)),
                    'retry': transient and attempt == 0,
                    'error': str(err),
                })
                if transient and attempt == 0:
                    time.sleep(0.35)
                    continue
                break
            except Exception as err:
                last_error = err
                attempts.append({
                    'endpoint': endpoint,
                    'attempt': attempt + 1,
                    'status': None,
                    'durationMs': int(max(0.0, (time.time() - run_started) * 1000.0)),
                    'retry': False,
                    'error': str(err),
                })
                break
    if last_error is not None:
        raise OverpassRequestError(f'Overpass request failed: {last_error}', attempts=attempts)
    raise OverpassRequestError('Overpass request failed', attempts=attempts)


def _default_fetcher(query: str, timeout_seconds: int) -> Dict[str, Any]:
    payload, _ = _fetch_overpass_with_debug(query, timeout_seconds)
    return payload


def _normalize_element(element: Dict[str, Any]) -> Dict[str, Any] | None:
    kind = str(element.get('type') or '').strip().lower()
    osm_id = element.get('id')
    tags = element.get('tags') if isinstance(element.get('tags'), dict) else {}
    lat, lon = _coerce_lat_lon(element)
    if kind not in ('node', 'way', 'relation') or osm_id is None or lat is None or lon is None:
        return None
    return {
        'id': f'overnight-osm-{kind}-{osm_id}',
        'name': str(tags.get('name') or '').strip() or 'Unnamed accommodation',
        'type': _normalize_type(_classify_osm_type(tags)),
        'lat': float(lat),
        'lon': float(lon),
        'linkedStageId': None,
        'status': 'option',
        'website': str(tags.get('website') or tags.get('contact:website') or '').strip() or None,
        'notes': '',
        'phone': str(tags.get('phone') or tags.get('contact:phone') or '').strip() or None,
        'address': str(tags.get('addr:full') or tags.get('addr:street') or '').strip() or None,
        'source': 'osm',
        'sourceType': kind,
        'sourceId': str(osm_id),
        'sourceTags': tags,
    }


def discover_overnight_stops(
    route_points: Iterable[Tuple[float, float]],
    *,
    corridor_km: float = 5.0,
    sample_step_km: float = 12.0,
    max_sample_points: int = 28,
    timeout_seconds: int = 30,
    categories: Iterable[str] | None = None,
    max_results_per_query: int = 120,
    fetcher: OverpassFetcher | None = None,
) -> Dict[str, Any]:
    points = [(float(lat), float(lon)) for lat, lon in route_points]
    if len(points) < 1:
        return {'items': [], 'meta': {'samplePoints': 0}}
    samples = _sample_route_points(points, sample_step_km=sample_step_km, max_points=max_sample_points)
    radius_m = int(max(500, min(60000, round(float(corridor_km) * 1000.0))))
    tourism_regex = _tourism_regex_for_categories(categories)
    chunks: List[List[Tuple[float, float]]] = []
    chunk_size = 6
    for i in range(0, len(samples), chunk_size):
        chunks.append(samples[i:i + chunk_size])
    elements: List[Dict[str, Any]] = []
    fetch_debug: List[Dict[str, Any]] = []
    chunk_failures: List[Dict[str, Any]] = []
    for chunk_index, chunk in enumerate(chunks):
        query = _build_overpass_query(chunk, radius_m, tourism_regex, max_results_per_query)
        try:
            if fetcher is None:
                payload, debug_meta = _fetch_overpass_with_debug(query, timeout_seconds)
                fetch_debug.append({
                    'chunkIndex': chunk_index,
                    'endpoint': debug_meta.get('endpoint'),
                    'attemptCount': len(debug_meta.get('attempts') or []),
                    'attempts': list(debug_meta.get('attempts') or []),
                })
            else:
                payload = fetcher(query, timeout_seconds)
        except requests.RequestException as err:
            chunk_failures.append({
                'chunkIndex': chunk_index,
                'error': str(err),
                'attempts': list(getattr(err, 'attempts', []) or []),
            })
            continue
        except Exception as err:
            chunk_failures.append({
                'chunkIndex': chunk_index,
                'error': str(err),
                'attempts': [],
            })
            continue
        chunk_elements = payload.get('elements') if isinstance(payload, dict) else []
        if isinstance(chunk_elements, list):
            elements.extend([item for item in chunk_elements if isinstance(item, dict)])
    latitudes = [pt[0] for pt in samples]
    longitudes = [pt[1] for pt in samples]
    bbox = {
        'minLat': min(latitudes) if latitudes else None,
        'maxLat': max(latitudes) if latitudes else None,
        'minLon': min(longitudes) if longitudes else None,
        'maxLon': max(longitudes) if longitudes else None,
    }
    normalized: List[Dict[str, Any]] = []
    seen: set[Tuple[str, str]] = set()
    for item in elements:
        rec = _normalize_element(item)
        if not rec:
            continue
        key = (str(rec.get('sourceType') or ''), str(rec.get('sourceId') or ''))
        if key in seen:
            continue
        seen.add(key)
        normalized.append(rec)
    strict_radius_km = max(0.5, min(60.0, float(corridor_km)))
    within_radius: List[Dict[str, Any]] = []
    filtered_outside_radius = 0
    for rec in normalized:
        lat = rec.get('lat')
        lon = rec.get('lon')
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            filtered_outside_radius += 1
            continue
        include = False
        for sample_lat, sample_lon in samples:
            dist = haversine_km(float(lat), float(lon), sample_lat, sample_lon)
            if math.isfinite(dist) and dist <= strict_radius_km + 0.05:
                include = True
                break
        if include:
            within_radius.append(rec)
        else:
            filtered_outside_radius += 1
    return {
        'items': within_radius,
        'meta': {
            'samplePoints': len(samples),
            'queryChunks': len(chunks),
            'failedChunks': len(chunk_failures),
            'degraded': len(chunk_failures) > 0,
            'warning': (
                f'Overpass request failed for {len(chunk_failures)}/{len(chunks)} chunk(s): '
                f'{chunk_failures[0].get("error")}'
            ) if chunk_failures else None,
            'radiusMeters': radius_m,
            'rawCount': len(elements),
            'normalizedCount': len(normalized),
            'withinRadiusCount': len(within_radius),
            'outsideRadiusDropped': filtered_outside_radius,
            'searchBBox': bbox,
            'fetchDebug': fetch_debug,
            'chunkFailures': chunk_failures,
            'categories': [str(c or '').strip().lower() for c in (categories or []) if str(c or '').strip()],
            'queryResultLimit': int(max_results_per_query),
        },
    }
