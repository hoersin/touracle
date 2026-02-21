import json
from typing import Tuple

from flask.testing import FlaskClient

import sys
from pathlib import Path
backend_dir = Path(__file__).resolve().parents[1] / 'backend'
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))
from app import app


def _collect_events(client: FlaskClient, url: str) -> Tuple[dict, dict]:
    resp = client.get(url)
    assert resp.status_code == 200
    data = resp.data.decode('utf-8')
    route_ev = None
    profile_ev = None
    for block in data.split('\n\n'):
        if not block.strip():
            continue
        lines = block.split('\n')
        if len(lines) < 2:
            continue
        typ = None
        payload = None
        for ln in lines:
            if ln.startswith('event:'):
                typ = ln.split(':', 1)[1].strip()
            elif ln.startswith('data:'):
                payload = ln.split(':', 1)[1].strip()
        if not typ or not payload:
            continue
        j = json.loads(payload)
        if typ == 'route' and route_ev is None:
            route_ev = j
        elif typ == 'profile' and profile_ev is None:
            profile_ev = j
        if route_ev and profile_ev:
            break
    return route_ev, profile_ev


def test_montpellier_profile_distance_matches_full_route_length():
    client = app.test_client()
    gpx = '/Users/ingolfhorsch/Projekte/WeatherMap/project/data/2026-02-13_2781422668_von Montpellier nach Bayonne.gpx'
    url = (
        f'/api/map_stream?date=02-15&mode=single_day&dry_run=1'
        f'&gpx_path={gpx}'
        '&step_km=60&profile_step_km=30'
    )
    route_ev, profile_ev = _collect_events(client, url)
    assert route_ev is not None, 'route event missing'
    assert profile_ev is not None, 'profile event missing'

    # Compute full route length from route geometry
    coords = route_ev['route']['geometry']['coordinates']
    from route_sampling import haversine_km
    total_km = 0.0
    for i in range(1, len(coords)):
        lon1, lat1 = coords[i-1]
        lon2, lat2 = coords[i]
        total_km += haversine_km(lat1, lon1, lat2, lon2)

    # Expectation: Montpellier route ~1060 km; allow small tolerance
    assert 900 <= total_km <= 1200, f'Unexpected route length: {total_km:.1f} km'

    # Check last sampled distance is close to total_km (within 1%)
    dist = profile_ev['profile']['sampled_dist_km']
    assert isinstance(dist, list) and len(dist) > 1, 'invalid profile distances'
    last = float(dist[-1])
    assert abs(last - total_km) / max(1.0, total_km) < 0.01, (
        f'Profile last distance {last:.2f} km deviates from route {total_km:.2f} km')

    # Check midpoint logic: the display mapping in frontend is linear, center should read ~half
    # This backend test asserts mid distance value approximately halves last distance
    mid_idx = len(dist) // 2
    mid_km = float(dist[mid_idx])
    assert abs(mid_km - (last * 0.5)) / max(1.0, last) < 0.05, (
        f'Midpoint {mid_km:.2f} km not near half of total {last:.2f} km')
