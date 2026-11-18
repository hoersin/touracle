import sys
from pathlib import Path

import pytest
import requests

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore
import overnight_planner  # type: ignore


_MINI_GPX = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="pytest" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Overnight Test</name><trkseg>
    <trkpt lat="48.1000" lon="11.5000"><ele>10</ele></trkpt>
    <trkpt lat="48.2000" lon="11.7000"><ele>14</ele></trkpt>
    <trkpt lat="48.3200" lon="11.9200"><ele>22</ele></trkpt>
  </trkseg></trk>
</gpx>
"""


@pytest.fixture
def isolated_backend(monkeypatch, tmp_path):
    data_dir = tmp_path / 'data'
    session_file = data_dir / 'session_state.json'
    data_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backend_app, 'DATA_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'UPLOAD_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'SESSION_FILE', session_file)
    monkeypatch.setattr(backend_app, 'SESSION_STORE', {})
    monkeypatch.setattr(backend_app, 'SESSION_STORE_LOADED', False)
    return backend_app.app.test_client()


def test_overnight_discover_endpoint_returns_items(isolated_backend, monkeypatch):
    client = isolated_backend
    upload_resp = client.post('/api/upload_gpx_text', json={'name': 'overnight-test.gpx', 'content': _MINI_GPX})
    assert upload_resp.status_code == 200

    def _fake_discover(points, **kwargs):
        pts = list(points)
        assert len(pts) >= 2
        assert kwargs.get('corridor_km') == 4.0
        return {
            'items': [{
                'id': 'overnight-osm-node-123',
                'name': 'Camping Isar',
                'type': 'camping',
                'lat': 48.19,
                'lon': 11.66,
                'source': 'osm',
                'sourceType': 'node',
                'sourceId': '123',
                'status': 'option',
                'linkedStageId': None,
                'notes': '',
                'website': None,
            }],
            'meta': {'samplePoints': 3, 'radiusMeters': 4000},
        }

    monkeypatch.setattr(backend_app, 'discover_overnight_stops', _fake_discover)
    resp = client.post('/api/overnight/discover', json={'corridorKm': 4.0, 'sampleStepKm': 9.0})
    assert resp.status_code == 200
    payload = resp.get_json() or {}
    items = payload.get('items') or []
    assert len(items) == 1
    assert items[0].get('name') == 'Camping Isar'
    assert payload.get('meta', {}).get('radiusMeters') == 4000


def test_overnight_discover_endpoint_degrades_gracefully_on_upstream_failure(isolated_backend, monkeypatch):
    client = isolated_backend
    upload_resp = client.post('/api/upload_gpx_text', json={'name': 'overnight-test.gpx', 'content': _MINI_GPX})
    assert upload_resp.status_code == 200

    def _failing_discover(points, **kwargs):
        raise requests.RequestException('overpass timeout')

    monkeypatch.setattr(backend_app, 'discover_overnight_stops', _failing_discover)
    resp = client.post('/api/overnight/discover', json={'corridorKm': 5.0})
    assert resp.status_code == 200
    payload = resp.get_json() or {}
    assert payload.get('items') == []
    assert payload.get('meta', {}).get('degraded') is True
    assert 'Overpass request failed' in str(payload.get('meta', {}).get('warning') or '')
    assert isinstance(payload.get('meta', {}).get('overpassAttempts'), list)


def test_overnight_discover_accepts_route_points_payload(isolated_backend, monkeypatch):
    client = isolated_backend

    def _fake_discover(points, **kwargs):
        pts = list(points)
        assert pts == [(48.1, 11.5)]
        assert kwargs.get('sample_step_km') == 8.0
        assert kwargs.get('categories') == ['camping', 'hotel']
        return {'items': [], 'meta': {'samplePoints': len(pts)}}

    monkeypatch.setattr(backend_app, 'discover_overnight_stops', _fake_discover)
    resp = client.post('/api/overnight/discover', json={
        'corridorKm': 30.0,
        'sampleStepKm': 8.0,
        'categories': ['camping', 'hotel'],
        'routePoints': [
            {'lat': 48.1, 'lon': 11.5},
        ],
    })
    assert resp.status_code == 200
    payload = resp.get_json() or {}
    assert payload.get('meta', {}).get('samplePoints') == 1


def test_overnight_discover_accepts_route_points_with_lng_key(isolated_backend, monkeypatch):
    client = isolated_backend

    def _fake_discover(points, **kwargs):
        pts = list(points)
        assert pts == [(37.1773, -3.5986)]
        return {'items': [], 'meta': {'samplePoints': len(pts)}}

    monkeypatch.setattr(backend_app, 'discover_overnight_stops', _fake_discover)
    resp = client.post('/api/overnight/discover', json={
        'corridorKm': 20.0,
        'sampleStepKm': 8.0,
        'categories': ['camping', 'hotel', 'hostel', 'bivouac'],
        'routePoints': [
            {'lat': 37.1773, 'lng': -3.5986},
        ],
    })
    assert resp.status_code == 200
    payload = resp.get_json() or {}
    assert payload.get('meta', {}).get('samplePoints') == 1


def test_discover_overnight_stops_drops_outside_radius_results():
    route_points = [(48.1000, 11.5000)]

    def _fake_fetcher(_query, _timeout):
        return {
            'elements': [
                {
                    'type': 'node',
                    'id': 1,
                    'lat': 48.1200,
                    'lon': 11.5200,
                    'tags': {'tourism': 'camp_site', 'name': 'Near Camping'},
                },
                {
                    'type': 'way',
                    'id': 2,
                    'center': {'lat': 48.7000, 'lon': 12.4000},
                    'tags': {'tourism': 'hotel', 'name': 'Far Hotel'},
                },
            ],
        }

    result = overnight_planner.discover_overnight_stops(
        route_points,
        corridor_km=8.0,
        sample_step_km=8.0,
        timeout_seconds=5,
        categories=['camping', 'hotel'],
        fetcher=_fake_fetcher,
    )
    items = result.get('items') or []
    assert len(items) == 1
    assert items[0].get('name') == 'Near Camping'
    meta = result.get('meta') or {}
    assert meta.get('normalizedCount') == 2
    assert meta.get('withinRadiusCount') == 1
    assert meta.get('outsideRadiusDropped') == 1


def test_discover_overnight_stops_returns_partial_results_when_chunk_fails():
    route_points = [
        (37.2100, -3.7200),
        (37.2050, -3.7000),
        (37.2000, -3.6800),
        (37.1950, -3.6600),
        (37.1900, -3.6400),
        (37.1850, -3.6200),
        (37.1800, -3.6000),
        (37.1750, -3.5800),
        (37.1700, -3.5600),
        (37.1650, -3.5400),
        (37.1600, -3.5200),
        (37.1550, -3.5000),
        (37.1500, -3.4800),
    ]
    calls = {'n': 0}

    def _flaky_fetcher(_query, _timeout):
        calls['n'] += 1
        if calls['n'] == 1:
            raise requests.RequestException('simulated timeout')
        return {
            'elements': [
                {
                    'type': 'node',
                    'id': 100 + calls['n'],
                    'lat': 37.1773,
                    'lon': -3.5986,
                    'tags': {'tourism': 'hotel', 'name': f'Hotel {calls["n"]}'},
                },
            ],
        }

    result = overnight_planner.discover_overnight_stops(
        route_points,
        corridor_km=20.0,
        sample_step_km=1.0,
        timeout_seconds=5,
        categories=['hotel'],
        fetcher=_flaky_fetcher,
    )
    items = result.get('items') or []
    meta = result.get('meta') or {}
    assert calls['n'] >= 2
    assert len(items) >= 1
    assert meta.get('degraded') is True
    assert meta.get('failedChunks') == 1
    assert isinstance(meta.get('chunkFailures'), list)
    assert 'Overpass request failed' in str(meta.get('warning') or '')


def test_configured_overpass_endpoints_filters_discouraged_hosts(monkeypatch):
    monkeypatch.setenv(
        'TOURACLE_OVERPASS_ENDPOINTS',
        'https://z.overpass-api.de/api/interpreter,https://overpass-api.de/api/interpreter',
    )
    endpoints = overnight_planner._configured_overpass_endpoints()  # type: ignore[attr-defined]
    assert endpoints == ('https://overpass-api.de/api/interpreter',)
