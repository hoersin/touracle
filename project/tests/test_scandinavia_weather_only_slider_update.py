import io
import json
import sys
from pathlib import Path
from urllib.parse import quote

import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = BASE_DIR / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app as backend_app  # type: ignore


def _collect_event_payloads(sse_text: str, event_name: str) -> list[dict]:
    marker = f'event: {event_name}\ndata: '
    out: list[dict] = []
    start = 0
    while True:
        idx = sse_text.find(marker, start)
        if idx == -1:
            return out
        idx += len(marker)
        end = sse_text.find('\n\n', idx)
        if end == -1:
            end = len(sse_text)
        out.append(json.loads(sse_text[idx:end]))
        start = end + 2


def _find_scandinavia_tour_gpx() -> Path | None:
    data_dir = BASE_DIR / 'data'
    session_file = data_dir / 'session_state.json'
    try:
        if session_file.exists():
            payload = json.loads(session_file.read_text(encoding='utf-8'))
            sessions = payload.get('sessions') if isinstance(payload, dict) else None
            if isinstance(sessions, dict):
                for session in sessions.values():
                    if not isinstance(session, dict):
                        continue
                    name = str(session.get('last_gpx_name') or '')
                    if 'Kolding' not in name or 'Kopenhagen' not in name:
                        continue
                    p = Path(str(session.get('last_gpx_path') or '')).expanduser()
                    if p.exists() and p.suffix.lower() == '.gpx':
                        return p
    except Exception:
        pass

    patterns = [
        '*Kolding*Kopenhagen*komoot*.gpx',
        '*kolding*kopenhagen*komoot*.gpx',
        '*Kolding*komoot*.gpx',
        '*kolding*komoot*.gpx',
    ]
    for pattern in patterns:
        matches = sorted(data_dir.glob(pattern))
        if matches:
            return matches[-1]
    return None


@pytest.fixture
def isolated_slider_backend(monkeypatch, tmp_path):
    data_dir = tmp_path / 'data'
    session_file = data_dir / 'session_state.json'
    data_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backend_app, 'DATA_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'UPLOAD_DIR', data_dir)
    monkeypatch.setattr(backend_app, 'SESSION_FILE', session_file)
    monkeypatch.setattr(backend_app, 'SESSION_STORE', {})
    monkeypatch.setattr(backend_app, 'SESSION_STORE_LOADED', False)
    monkeypatch.setattr(backend_app, 'STATS_CACHE_DIR', tmp_path / 'stats')
    backend_app.STATS_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backend_app, '_get_offline_store', lambda *args, **kwargs: None)
    monkeypatch.setattr(backend_app, '_offline_strict_enabled', lambda: False)
    monkeypatch.setattr(backend_app, 'generate_glyph_v2', lambda stats, debug=False: '<svg class="wm-test-glyph"></svg>')

    def _fake_offline_stats(lat, lon, month, day, **kwargs):
        base = float(int(month) * 100 + int(day))
        return {
            '_offline': True,
            '_provider': 'openmeteo',
            '_years_start': 2025,
            '_years_end': 2025,
            '_match_days': 1,
            '_weather_source': 'climatology',
            'temperature_c': base / 10.0,
            'temp_hist_median': base / 10.0,
            'temp_hist_min': (base - 4.0) / 10.0,
            'temp_hist_max': (base + 4.0) / 10.0,
            'temp_hist_p25': (base - 2.0) / 10.0,
            'temp_hist_p75': (base + 2.0) / 10.0,
            'temp_day_median': (base + 1.0) / 10.0,
            'temp_day_typical_min': (base - 3.0) / 10.0,
            'temp_day_typical_max': (base + 3.0) / 10.0,
            'temp_day_p25': (base - 1.5) / 10.0,
            'temp_day_p75': (base + 1.5) / 10.0,
            'precipitation_mm': (int(day) % 7) + 0.5,
            'rain_probability': min(0.95, max(0.05, int(day) / 31.0)),
            'rain_typical_mm': (int(day) % 9) + 0.3,
            'rain_hist_p25_mm': 0.1,
            'rain_hist_p75_mm': 2.1,
            'rain_hist_p90_mm': 3.3,
            'wind_speed_ms': 3.2 + ((int(day) % 5) * 0.2),
            'wind_dir_deg': 180.0,
            'wind_var_deg': 18.0,
            '_tile_id': 'test_tile',
        }

    monkeypatch.setattr(backend_app, '_get_offline_stats', _fake_offline_stats)
    return backend_app.app.test_client()


def test_scandinavia_timeline_shift_weather_only_updates_map_labels(isolated_slider_backend):
    client = isolated_slider_backend
    gpx = _find_scandinavia_tour_gpx()
    if gpx is None:
        pytest.skip('missing Scandinavia tour GPX fixture (Kolding->Kopenhagen)')

    upload = client.post(
        '/api/upload_gpx',
        data={'file': (io.BytesIO(gpx.read_bytes()), gpx.name)},
        content_type='multipart/form-data',
    )
    assert upload.status_code == 200
    payload = upload.get_json() or {}
    gpx_path = str(payload.get('path') or '')
    assert gpx_path

    base_query = (
        '&step_km=120&profile_step_km=30'
        '&tour_planning=1&mode=single_day'
        '&total_days=21'
        '&hist_years=1&hist_start=2025&years=2025'
        '&tour_weather_mode=climatology&offline_only=1'
    )

    first = client.get(
        f'/api/map_stream?date=06-30&start_date=2026-06-30{base_query}&gpx_path={quote(gpx_path)}'
    )
    assert first.status_code == 200
    first_text = first.data.decode('utf-8')

    route_events = _collect_event_payloads(first_text, 'route')
    profile_events = _collect_event_payloads(first_text, 'profile')
    station_events = _collect_event_payloads(first_text, 'station')
    assert route_events, 'expected initial stream to emit route event'
    assert profile_events, 'expected initial stream to emit profile event'
    station_features = [e.get('feature') for e in station_events if isinstance(e, dict) and e.get('feature')]
    assert station_features, 'expected station features in initial stream'

    first_props = station_features[0].get('properties') or {}
    assert first_props.get('svg'), 'expected weather label glyph payload for map marker'
    first_temp = float(first_props.get('temperature_c'))
    first_date = str(first_props.get('date') or '')

    shifted = client.get(
        f'/api/map_stream?date=07-14&start_date=2026-07-14{base_query}&weather_only=1&gpx_path={quote(gpx_path)}'
    )
    assert shifted.status_code == 200
    shifted_text = shifted.data.decode('utf-8')

    shifted_route_events = _collect_event_payloads(shifted_text, 'route')
    shifted_profile_events = _collect_event_payloads(shifted_text, 'profile')
    shifted_station_events = _collect_event_payloads(shifted_text, 'station')

    # Weather-only update must not rely on a page reload route/profile cycle.
    assert shifted_route_events == []
    assert shifted_profile_events == []

    shifted_features = [e.get('feature') for e in shifted_station_events if isinstance(e, dict) and e.get('feature')]
    assert shifted_features, 'expected station features during weather-only timeline update'

    shifted_props = shifted_features[0].get('properties') or {}
    assert shifted_props.get('svg'), 'expected weather label glyph payload after timeline shift'
    shifted_temp = float(shifted_props.get('temperature_c'))
    shifted_date = str(shifted_props.get('date') or '')

    assert first_date != shifted_date
    assert first_temp != shifted_temp
