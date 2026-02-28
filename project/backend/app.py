from flask import Flask, jsonify, send_from_directory, request, Response
from pathlib import Path
from typing import Dict, Any, Optional
import os
import time
import threading
import pandas as pd
import datetime as _dt


def _json_default(obj: Any):
    """Best-effort conversion for JSON cache writes (numpy scalars, etc.)."""
    try:
        # numpy scalar / array
        import numpy as _np  # type: ignore

        if isinstance(obj, _np.integer):
            return int(obj)
        if isinstance(obj, _np.floating):
            return float(obj)
        if isinstance(obj, _np.ndarray):
            return obj.tolist()
    except Exception:
        pass
    try:
        # generic scalar protocol
        if hasattr(obj, 'item'):
            return obj.item()
    except Exception:
        pass
    return str(obj)

# Import sibling modules when running as a script
import logging
from route_sampling import sample_route, haversine_km
from weather import compute_weather_statistics
from glyph_geometry import generate_glyph_v2
from weather_openmeteo import fetch_daily_weather, fetch_daily_weather_same_day, fetch_daily_weather_window, fetch_hourly_weather_same_day, reset_api_disable, set_force_online
from weather_service import WeatherService, reset_api_disable as reset_service_api_disable
from weather import compute_daytime_temperature_statistics

try:
    from offline_weather_store import OfflineWeatherStore
except Exception:  # pragma: no cover
    OfflineWeatherStore = None  # type: ignore

app = Flask(__name__, static_folder=str(Path(__file__).resolve().parents[1] / 'frontend'))
# Development: disable static file caching to ensure fresh frontend assets
try:
    app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
except Exception:
    pass
try:
    WeatherService.ensure_started()
except Exception:
    pass
BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / 'data'
ENV_GPX = os.environ.get('GPX_PATH')
GPX_FILE = Path(ENV_GPX) if ENV_GPX else (DATA_DIR / '2026-02-13_2781422668_von Montpellier nach Bayonne.gpx')
DEBUG_DIR = BASE_DIR / 'debug_output'
DEBUG_DIR.mkdir(exist_ok=True)
STATS_CACHE_DIR = BASE_DIR / 'cache' / 'stats'
STATS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR = BASE_DIR / 'data'
UPLOAD_DIR.mkdir(exist_ok=True)
SESSION_FILE = DATA_DIR / 'session_state.json'
SESSION_STATE: Dict[str, Any] = {
    "last_gpx_path": "",
    "start_date": "",
    "tour_days": 7,
    "glyph_spacing_km": 60,
    "first_year": 2016,
    "num_years": 10,
    "reverse": False,
}

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
log = logging.getLogger('pipeline')

_OFFLINE_STORE: Optional[Any] = None
_OFFLINE_STORE_TRIED = False
_OFFLINE_STORES_BY_YEAR: Dict[int, Any] = {}
_OFFLINE_STORES_BY_YEAR_LOCK = threading.Lock()


def _offline_strict_enabled() -> bool:
    return str(os.environ.get('OFFLINE_STRICT', '')).strip().lower() in ('1', 'true', 'yes', 'on')


def _get_offline_store() -> Optional[Any]:
    global _OFFLINE_STORE, _OFFLINE_STORE_TRIED
    if _OFFLINE_STORE_TRIED:
        return _OFFLINE_STORE
    _OFFLINE_STORE_TRIED = True

    if OfflineWeatherStore is None:
        _OFFLINE_STORE = None
        return None

    try:
        _OFFLINE_STORE = OfflineWeatherStore.default_from_env()
    except Exception:
        _OFFLINE_STORE = None

    if _OFFLINE_STORE is not None:
        try:
            log.info('[OFFLINE] enabled db=%s tile_km=%.1f', _OFFLINE_STORE.cfg.db_path, float(_OFFLINE_STORE.cfg.tile_km))
        except Exception:
            log.info('[OFFLINE] enabled')
    else:
        # Only warn if user explicitly asked for offline.
        if os.environ.get('OFFLINE_WEATHER_DB') or _offline_strict_enabled():
            log.warning('[OFFLINE] requested but unavailable (db missing/invalid)')
    return _OFFLINE_STORE


def _get_offline_store_for_year(year: int | None) -> Optional[Any]:
    """Return an OfflineWeatherStore for a specific year DB if present.

    This is used by the Strategic/Climatic map, which defaults to year=2025.
    Falls back to the default offline store selection when the year-specific DB
    doesn't exist.
    """
    # If caller doesn't specify a year, use default selection logic.
    if year is None:
        return _get_offline_store()

    try:
        y = int(year)
    except Exception:
        return _get_offline_store()

    with _OFFLINE_STORES_BY_YEAR_LOCK:
        if y in _OFFLINE_STORES_BY_YEAR:
            return _OFFLINE_STORES_BY_YEAR[y]

    # Build candidate path: project/cache/offline_weather_<year>.sqlite
    try:
        if OfflineWeatherStore is not None:
            p = Path('project/cache') / f'offline_weather_{y}.sqlite'
            if p.exists():
                cfg = OfflineWeatherStore._load_config(p)  # type: ignore[attr-defined]
                if cfg is not None:
                    store = OfflineWeatherStore(cfg)
                    with _OFFLINE_STORES_BY_YEAR_LOCK:
                        _OFFLINE_STORES_BY_YEAR[y] = store
                    try:
                        log.info('[OFFLINE][STRATEGIC] enabled year=%d db=%s', y, p)
                    except Exception:
                        pass
                    return store
    except Exception:
        pass

    # Fallback
    return _get_offline_store()


def _parse_mmdd_or_date(raw: str) -> tuple[int, int]:
    s = str(raw).strip()
    if len(s) == 10 and s[4] == '-' and s[7] == '-':
        d = _dt.date.fromisoformat(s)
        return int(d.month), int(d.day)
    if len(s) == 5 and s[2] == '-':
        m, d = s.split('-', 1)
        return int(m), int(d)
    raise ValueError('Invalid date; expected YYYY-MM-DD or MM-DD')


@app.route('/api/strategic_grid')
def api_strategic_grid():
    """Strategic/Climatic map: return offline grid nodes + climatology for a day.

    Query params:
      - date: YYYY-MM-DD or MM-DD (required)
      - year: int (optional; default 2025)
      - lat_min, lat_max, lon_min, lon_max: viewport bounds (required)
    """
    if OfflineWeatherStore is None:
        return jsonify({"error": "Offline store unavailable"}), 400

    date_raw = request.args.get('date')
    if not date_raw:
        return jsonify({"error": "Missing 'date'"}), 400

    try:
        year_raw = request.args.get('year')
        year = int(year_raw) if year_raw is not None else 2025
    except Exception:
        year = 2025

    try:
        month, day = _parse_mmdd_or_date(date_raw)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    def _f(name: str) -> float:
        v = request.args.get(name)
        if v is None:
            raise ValueError(f"Missing '{name}'")
        return float(v)

    try:
        lat_min = _f('lat_min')
        lat_max = _f('lat_max')
        lon_min = _f('lon_min')
        lon_max = _f('lon_max')
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    # Expand bounds slightly to support interpolation near edges.
    try:
        pad_lat = 0.6  # ~65km
        pad_lon = 0.8
        lat_min_q = min(lat_min, lat_max) - pad_lat
        lat_max_q = max(lat_min, lat_max) + pad_lat
        lon_min_q = min(lon_min, lon_max) - pad_lon
        lon_max_q = max(lon_min, lon_max) + pad_lon
    except Exception:
        lat_min_q, lat_max_q, lon_min_q, lon_max_q = lat_min, lat_max, lon_min, lon_max

    store = _get_offline_store_for_year(year)
    if store is None:
        return jsonify({"error": "Offline store not configured"}), 400

    try:
        cfg = getattr(store, 'cfg', None)
        bbox = cfg.bbox if cfg is not None else None
        tile_km = float(cfg.tile_km) if cfg is not None else 50.0
        years = cfg.years if cfg is not None else None
    except Exception:
        bbox = None
        tile_km = 50.0
        years = None

    try:
        pts = store.get_climatology_grid(lat_min_q, lat_max_q, lon_min_q, lon_max_q, month, day)
    except Exception as e:
        return jsonify({"error": f"Query failed: {e}"}), 500

    return jsonify(
        {
            "year": int(year),
            "month": int(month),
            "day": int(day),
            "tile_km": float(tile_km),
            "bbox": bbox,
            "years": {"start": int(years[0]), "end": int(years[1])} if years else None,
            "count": int(len(pts)),
            "points": pts,
        }
    )


def _get_offline_stats(lat: float, lon: float, month: int, day: int) -> Optional[Dict[str, Any]]:
    store = _get_offline_store()
    if store is None:
        return None
    try:
        st = store.get_stats(float(lat), float(lon), int(month), int(day))
        if st is None:
            return None
        try:
            if getattr(store, 'cfg', None) is not None and getattr(store.cfg, 'years', None):
                ys, ye = store.cfg.years  # type: ignore[misc]
                st = dict(st)
                st['_years_start'] = int(ys)
                st['_years_end'] = int(ye)
        except Exception:
            pass
        return st
    except Exception:
        return None

# In-memory progress tracking for SSE
PROGRESS: Dict[str, Dict[str, Any]] = {}
PROGRESS_LOCK = threading.Lock()

# Global SSE stream control to prevent parallel heavy streams
STREAM_LOCK = threading.Lock()
STREAM_TOKEN = 0

def progress_init(job_id: str, total: int) -> None:
    with PROGRESS_LOCK:
        PROGRESS[job_id] = {"total": int(total), "completed": 0, "done": False}

def progress_tick(job_id: str, inc: int = 1) -> None:
    with PROGRESS_LOCK:
        st = PROGRESS.get(job_id)
        if st:
            st["completed"] = min(st["completed"] + inc, st["total"])

def progress_done(job_id: str) -> None:
    with PROGRESS_LOCK:
        st = PROGRESS.get(job_id)
        if st:
            st["completed"] = st.get("total", st.get("completed", 0))
            st["done"] = True

def _get_progress(job_id: str) -> Dict[str, Any]:
    with PROGRESS_LOCK:
        return dict(PROGRESS.get(job_id, {"total": 0, "completed": 0, "done": False}))


# -------------------- Session persistence --------------------
def load_session_state() -> Dict[str, Any]:
    import json
    global SESSION_STATE
    try:
        if SESSION_FILE.exists():
            with open(SESSION_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, dict):
                    SESSION_STATE.update(data)
                    logging.getLogger('pipeline').info('[SESSION] Restored state')
        else:
            # Create with defaults
            try:
                with open(SESSION_FILE, 'w', encoding='utf-8') as f:
                    json.dump(SESSION_STATE, f, ensure_ascii=False, indent=2)
            except Exception:
                pass
    except Exception:
        logging.getLogger('pipeline').warning('[SESSION] Corrupted session JSON; starting fresh')
    return dict(SESSION_STATE)


def save_session_state(updates: Dict[str, Any]) -> None:
    import json
    global SESSION_STATE
    try:
        log.info('[SESSION] Saving state')
        # Merge updates into current state and normalize types
        st = dict(SESSION_STATE)
        st.update({
            k: (v if not isinstance(v, str) else v)
            for k, v in updates.items()
            if v is not None
        })
        # Normalize booleans/ints for known keys
        if 'tour_days' in st:
            try: st['tour_days'] = int(st['tour_days'])
            except Exception: pass
        if 'glyph_spacing_km' in st:
            try: st['glyph_spacing_km'] = float(st['glyph_spacing_km'])
            except Exception: pass
        if 'first_year' in st:
            try: st['first_year'] = int(st['first_year'])
            except Exception: pass
        if 'num_years' in st:
            try: st['num_years'] = int(st['num_years'])
            except Exception: pass
        if 'reverse' in st:
            st['reverse'] = bool(st['reverse'])
        SESSION_STATE.update(st)
        with open(SESSION_FILE, 'w', encoding='utf-8') as f:
            json.dump(SESSION_STATE, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log.warning('[SESSION] Save failed: %s', e)


def restore_gpx_on_start() -> None:
    """If a last GPX path exists, try sampling to verify and warm up."""
    try:
        st = load_session_state()
        p = st.get('last_gpx_path')
        if p:
            path = Path(p)
            if path.exists():
                log.info('[SESSION] Restored previous session')
                log.info('[SESSION] GPX loaded: %s', path)
                step_km = float(st.get('glyph_spacing_km') or 60.0)
                try:
                    sampled_points, route_feature = sample_route(str(path), step_km=step_km)
                    # Warm debug artifacts minimally
                    import json
                    with open(DEBUG_DIR / 'sampled_points.json', 'w', encoding='utf-8') as fsp:
                        json.dump([{"lat": lat, "lon": lon} for (lat, lon) in sampled_points], fsp, ensure_ascii=False, indent=2)
                    log.info('[SESSION] GPX restored successfully')
                except Exception as e:
                    log.warning('[SESSION] GPX restore sampling failed: %s', e)
            else:
                log.warning('[SESSION] Last GPX missing: %s', path)
        else:
            # No prior session
            pass
    except Exception as e:
        log.warning('[SESSION] Restore failed: %s', e)


@app.route('/')
def index():
    resp = send_from_directory(app.static_folder, 'index.html')
    try:
        resp.headers['Cache-Control'] = 'no-store, max-age=0'
        resp.headers['Pragma'] = 'no-cache'
    except Exception:
        pass
    return resp


@app.route('/map.js')
def map_js():
    resp = send_from_directory(app.static_folder, 'map.js')
    try:
        resp.headers['Cache-Control'] = 'no-store, max-age=0'
        resp.headers['Pragma'] = 'no-cache'
    except Exception:
        pass
    return resp


@app.route('/profile.js')
def profile_js():
    resp = send_from_directory(app.static_folder, 'profile.js')
    try:
        resp.headers['Cache-Control'] = 'no-store, max-age=0'
        resp.headers['Pragma'] = 'no-cache'
    except Exception:
        pass
    return resp


@app.route('/api/upload_gpx', methods=['POST'])
def upload_gpx():
    try:
        f = request.files.get('file')
        if not f:
            return jsonify({"error": "No file uploaded"}), 400
        name = f.filename or 'route.gpx'
        if not name.lower().endswith('.gpx'):
            return jsonify({"error": "Only .gpx files allowed"}), 400
        ts = int(time.time())
        safe_name = f"uploaded_{ts}.gpx"
        out_path = UPLOAD_DIR / safe_name
        f.save(str(out_path))
        log.info('[UPLOAD] Saved %s', out_path)
        # Persist session update
        try:
            save_session_state({"last_gpx_path": str(out_path)})
        except Exception:
            pass
        return jsonify({"path": str(out_path), "name": safe_name})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/map')
def api_map():
    date = request.args.get('date', None)  # expected MM-DD
    gpx_override = request.args.get('gpx_path')
    tour_planning_param = request.args.get('tour_planning', '1')  # default ON
    job_id = request.args.get('job_id')
    if not date or len(date) != 5 or '-' not in date:
        return jsonify({"error": "Provide date as MM-DD"}), 400
    try:
        month, day = map(int, date.split('-'))
    except Exception:
        return jsonify({"error": "Invalid date format"}), 400

    try:
        gpx_path = GPX_FILE
        if gpx_override and gpx_override.endswith('.gpx') and Path(gpx_override).exists():
            gpx_path = Path(gpx_override)
        log.info('[STEP] Loading GPX track: %s', gpx_path)
        # Optional sampling controls
        step_km_param = request.args.get('step_km')
        max_points_param = request.args.get('max_points')
        grid_deg_param = request.args.get('grid_deg')
        fetch_mode = request.args.get('mode', 'single_day')  # default to 'single_day'
        try:
            step_km = float(step_km_param) if step_km_param else 25.0
        except Exception:
            step_km = 25.0
        sampled_points, route_feature = sample_route(str(gpx_path), step_km=step_km)
        if max_points_param:
            try:
                max_points = int(max_points_param)
                if max_points > 0:
                    sampled_points = sampled_points[:max_points]
            except Exception:
                pass
        try:
            grid_deg = float(grid_deg_param) if grid_deg_param else 0.25
            if grid_deg <= 0:
                grid_deg = 0.25
        except Exception:
            grid_deg = 0.25
        log.info('[STEP] Sampling route points: %d points sampled; first=%s', len(sampled_points), sampled_points[0])
        if job_id:
            progress_init(job_id, len(sampled_points))
    except Exception as e:
        return jsonify({"error": f"Route error: {e}"}), 500

    # Point-based weather retrieval for each sampled route point using Open-Meteo
    stations_features = []
    links_collection = {"type": "FeatureCollection", "features": []}  # No links in point-based approach
    debug_first = []

    # Simple in-memory cache to reduce API calls for nearby points
    df_cache: Dict[str, Any] = {}

    # Tour planning optimization: compute stats once per day and reuse
    tour_planning = tour_planning_param not in ('0', 'false', 'False')
    if tour_planning and sampled_points:
        log.info('[PLAN] Tour planning mode: single fetch per day (reuse stats)')
        # Representative point: midpoint of route
        idx = len(sampled_points) // 2
        rep_lat, rep_lon = sampled_points[idx]
        # Stats cache key by rounded lat/lon + month/day
        key_latlon = f"{round(rep_lat, 2)},{round(rep_lon, 2)}"
        stats_cache_name = f"stats_lat{round(rep_lat,2):.2f}_lon{round(rep_lon,2):.2f}_m{month:02d}_d{day:02d}.json"
        stats_cache_path = STATS_CACHE_DIR / stats_cache_name
        stats: Dict[str, Any]
        matches: int
        if stats_cache_path.exists():
            try:
                stats = __import__('json').load(open(stats_cache_path, 'r', encoding='utf-8'))
                matches = int(stats.get('_match_days', 0))
                log.info('[CACHE] hit %s', stats_cache_name)
            except Exception:
                stats = {}
                matches = 0
        else:
            # Offline-first: try tile store before any online requests
            offline_stats = _get_offline_stats(rep_lat, rep_lon, month, day)
            if offline_stats is not None:
                stats = dict(offline_stats)
                matches = int(stats.get('_match_days', 0) or 0)
                log.info('[OFFLINE] Representative hit tile=%s match_days=%d', stats.get('_tile_id'), matches)
            else:
                if _offline_strict_enabled() and _get_offline_store() is not None:
                    log.warning('[OFFLINE] strict mode: representative point not covered by offline DB')
                    stations_collection = {"type": "FeatureCollection", "features": []}
                    return jsonify({
                        "route": route_feature,
                        "stations": stations_collection,
                        "links": links_collection,
                        "note": "Offline strict mode: no offline data for representative point/day."
                    }), 503

                # Build date range and fetch using Open-Meteo with built-in caching/rate-limit
                log.info('[STEP] Fetching Open-Meteo daily: representative (%.5f, %.5f) mode=%s', rep_lat, rep_lon, fetch_mode)
                if fetch_mode == 'single_day':
                    df = fetch_daily_weather_same_day(rep_lat, rep_lon, month, day)
                else:
                    df = fetch_daily_weather(rep_lat, rep_lon, month, day)
                # Threshold depends on mode: in single-day mode expect ~years_window rows
                min_rows = 1 if fetch_mode == 'single_day' else 30
                if df is None or len(df) < min_rows:
                    log.warning('[PLAN] Representative fetch unavailable (429/cache miss); returning empty stations')
                    stations_collection = {"type": "FeatureCollection", "features": []}
                    return jsonify({
                        "route": route_feature,
                        "stations": stations_collection,
                        "links": links_collection,
                        "note": "Weather temporarily unavailable; try again shortly."
                    })
                stats, matches = compute_weather_statistics(df, month, day)
                # Compute daytime temperature from hourly data and override temp fields
                try:
                    dfh = fetch_hourly_weather_same_day(rep_lat, rep_lon, month, day)
                    dt_stats, dt_points = compute_daytime_temperature_statistics(dfh, month, day)
                    stats.update(dt_stats)
                    stats['_temp_source'] = 'hourly_daytime'
                except Exception as e:
                    log.warning('[WEATHER] Daytime temp unavailable: %s', e)
                # Save stats to cache
                try:
                    s = {**stats, '_match_days': matches}
                    __import__('json').dump(s, open(stats_cache_path, 'w', encoding='utf-8'))
                    log.info('[CACHE] miss -> saved %s', stats_cache_name)
                except Exception:
                    pass

        # Reuse stats for all points (single tour day)
        for i, (lat, lon) in enumerate(sampled_points):
            try:
                svg = generate_glyph_v2(stats, debug=False)
                feature = {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {
                        **stats,
                        "svg": svg,
                        "station_id": f"point_{i}",
                        "station_name": f"Route Point {i}",
                        "station_lat": lat,
                        "station_lon": lon,
                        "min_distance_to_route_km": 0.0,
                        "usage_count": 1,
                        "_match_days": matches,
                        "_source_mode": "tour_planning_reused"
                    }
                }
                stations_features.append(feature)
                if i < 5:
                    debug_first.append({
                        "route_point": {"lat": lat, "lon": lon},
                        "stats_preview": feature["properties"],
                    })
            except Exception as e:
                log.warning('Point %d: stats compose error: %s', i, e)
        # Skip individual per-point fetching in tour planning mode
    else:
        # Per-point mode: provider already uses monthly window
        def _quantize(v: float, g: float) -> float:
            return round(v / g) * g

        for i, (lat, lon) in enumerate(sampled_points):
            try:
                # Priority: (1) disk stats cache, (2) offline SQLite tile DB, (3) online API.
                qlat = _quantize(lat, grid_deg)
                qlon = _quantize(lon, grid_deg)
                stats_name = f"stats_lat{qlat:.2f}_lon{qlon:.2f}_m{month:02d}_d{day:02d}_{fetch_mode}.json"
                stats_path = STATS_CACHE_DIR / stats_name

                cache_hit = False
                stats: Dict[str, Any]
                matching: int
                if stats_path.exists():
                    try:
                        stats = __import__('json').load(open(stats_path, 'r', encoding='utf-8'))
                        matching = int(stats.get('_match_days', 0) or 0)
                        cache_hit = True
                        log.info('[CACHE] hit %s', stats_name)
                    except Exception:
                        cache_hit = False

                if not cache_hit:
                    offline_stats = _get_offline_stats(lat, lon, month, day)
                    if offline_stats is not None:
                        stats = dict(offline_stats)
                        matching = int(stats.get('_match_days', 0) or 0)
                        log.info('[OFFLINE] Point %d hit tile=%s match_days=%d', i, stats.get('_tile_id'), matching)
                        # Persist offline stats into disk cache to avoid re-checking the DB next time.
                        try:
                            s = {**stats, '_match_days': matching}
                            import json as _json
                            _json.dump(s, open(stats_path, 'w', encoding='utf-8'), default=_json_default)
                            log.info('[CACHE] offline -> saved %s', stats_name)
                        except Exception:
                            pass
                    else:
                        if _offline_strict_enabled() and _get_offline_store() is not None:
                            log.warning('[OFFLINE] strict mode: no offline data for point %d; skipping', i)
                            continue

                        log.info('[STEP] Fetching Open-Meteo daily: point #%d (%.5f, %.5f) mode=%s grid=%.2f', i, lat, lon, fetch_mode, grid_deg)
                        key = f"{qlat:.4f},{qlon:.4f}:{fetch_mode}"
                        if key in df_cache:
                            df = df_cache[key]
                        else:
                            if fetch_mode == 'single_day':
                                df = fetch_daily_weather_same_day(qlat, qlon, month, day)
                            else:
                                df = fetch_daily_weather(qlat, qlon, month, day)
                            df_cache[key] = df
                        min_rows = 1 if fetch_mode == 'single_day' else 30
                        if df is None or len(df) < min_rows:
                            log.warning('Point %d: insufficient rows (%s); skipping', i, len(df) if df is not None else 0)
                            continue

                        stats, matching = compute_weather_statistics(df, month, day)
                        # Compute daytime temperature from hourly data and override temp (online only).
                        try:
                            dfh = fetch_hourly_weather_same_day(qlat, qlon, month, day)
                            dt_stats, dt_points = compute_daytime_temperature_statistics(dfh, month, day)
                            stats.update(dt_stats)
                            stats['_temp_source'] = 'hourly_daytime'
                        except Exception as e:
                            log.warning('Point %d: daytime temp unavailable: %s', i, e)

                        # Save stats to disk cache AFTER daytime adjustments.
                        try:
                            s = {**stats, '_match_days': matching}
                            import json as _json
                            _json.dump(s, open(stats_path, 'w', encoding='utf-8'), default=_json_default)
                            log.info('[CACHE] miss -> saved %s', stats_name)
                        except Exception:
                            pass

                log.info('[STEP] Stats computed: match_days=%d temp=%.2f wind=%.2f', matching, stats.get('temperature_c', 0.0), stats.get('wind_speed_ms', 0.0))
                svg = generate_glyph_v2(stats, debug=False)
                feature = {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {
                        **stats,
                        "svg": svg,
                        "station_id": f"point_{i}",
                        "station_name": f"Route Point {i}",
                        "station_lat": lat,
                        "station_lon": lon,
                        "min_distance_to_route_km": 0.0,
                        "usage_count": 1,
                        "_match_days": matching,
                        "_source_mode": ("offline_tile" if bool(stats.get('_offline')) else f"per_point_{fetch_mode}"),
                        "_grid_deg": grid_deg
                    }
                }
                # Wind warning flag for tooltip highlight
                try:
                    wspd = float(stats.get('wind_speed_ms', 0.0))
                    gmax = float(stats.get('wind_gust_ms', 0.0)) if 'wind_gust_ms' in stats else 0.0
                    feature['properties']['_wind_warning'] = (wspd >= 17.2) or (gmax >= 20.0)
                except Exception:
                    feature['properties']['_wind_warning'] = False
                stations_features.append(feature)
                if i < 5:
                    debug_first.append({
                        "route_point": {"lat": lat, "lon": lon},
                        "stats_preview": feature["properties"],
                    })
                if job_id:
                    progress_tick(job_id, 1)
                # Write per-point debug artifacts
                try:
                    (DEBUG_DIR / f'weather_raw_point_{i}.csv').write_text(df.to_csv(index=False))
                    (DEBUG_DIR / f'glyph_preview_point_{i}.svg').write_text(svg)
                except Exception:
                    pass
            except Exception as e:
                log.warning('Point %d: weather/stats error: %s', i, e)
                if job_id:
                    progress_tick(job_id, 1)
                continue

    stations_collection = {"type": "FeatureCollection", "features": stations_features}

    # Save intermediate artifacts
    try:
        import json
        # sampled points
        with open(DEBUG_DIR / 'sampled_points.json', 'w', encoding='utf-8') as fsp:
            json.dump([{"lat": lat, "lon": lon} for (lat, lon) in sampled_points], fsp, ensure_ascii=False, indent=2)
        # links (empty)
        with open(DEBUG_DIR / 'links.json', 'w', encoding='utf-8') as fl:
            json.dump(links_collection, fl, ensure_ascii=False, indent=2)
        # stations collection
        with open(DEBUG_DIR / 'stations.json', 'w', encoding='utf-8') as fs:
            json.dump(stations_collection, fs, ensure_ascii=False, indent=2)
        # debug summary
        with open(DEBUG_DIR / 'debug_summary.json', 'w', encoding='utf-8') as fd:
            json.dump({"first_points": debug_first}, fd, ensure_ascii=False, indent=2)
        log.info('[STEP] Writing GeoJSON output: stations=%d links=%d', len(stations_features), len(links_collection))
    except Exception:
        pass

    if job_id:
        progress_done(job_id)
    return jsonify({
        "route": route_feature,
        "stations": stations_collection,
        "links": links_collection,
    })


@app.route('/debug/<path:filename>')
def debug_files(filename: str):
    # Serve debug_output artifacts (PNGs, JSON)
    return send_from_directory(str(DEBUG_DIR), filename)


@app.route('/api/progress/<job_id>')
def api_progress(job_id: str):
    def event_stream():
        # Emit progress until done
        while True:
            st = _get_progress(job_id)
            msg = __import__('json').dumps(st)
            yield f"data: {msg}\n\n"
            if st.get('done'):
                break
            time.sleep(0.5)
    headers = {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    }
    return Response(event_stream(), headers=headers)


@app.route('/api/session', methods=['GET'])
def api_session():
    """Return persisted session state. Includes a convenience flag if GPX exists."""
    import json
    try:
        st = load_session_state()
        p = st.get('last_gpx_path')
        exists = bool(p) and Path(p).exists()
        st_out = {**st, 'gpx_exists': exists}
        return Response(json.dumps(st_out), mimetype='application/json')
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/map_stream')
def api_map_stream():
    date = request.args.get('date', None)
    gpx_override = request.args.get('gpx_path')
    tour_planning_param = request.args.get('tour_planning', '1')
    offline_only_param = request.args.get('offline_only')
    step_km_param = request.args.get('step_km')
    max_points_param = request.args.get('max_points')
    grid_deg_param = request.args.get('grid_deg')
    fetch_mode = request.args.get('mode', 'single_day')
    profile_step_km_param = request.args.get('profile_step_km')
    # Tour-day assignment params
    start_date_param = request.args.get('start_date')  # YYYY-MM-DD
    tour_days_param = request.args.get('total_days')
    hist_years_param = request.args.get('hist_years')
    hist_start_param = request.args.get('hist_start')
    reverse_param = request.args.get('reverse')
    dry_run_param = request.args.get('dry_run')
    reset_api_param = request.args.get('reset_api')
    force_online_param = request.args.get('force_online')
    # Comfort thresholds from frontend settings
    temp_cold_param = request.args.get('temp_cold')
    temp_hot_param = request.args.get('temp_hot')
    rain_high_param = request.args.get('rain_high')
    wind_head_comfort_param = request.args.get('wind_head_comfort')
    wind_tail_comfort_param = request.args.get('wind_tail_comfort')

    if not date or len(date) != 5 or '-' not in date:
        return Response("data: {\"error\": \"Provide date as MM-DD\"}\n\n", mimetype='text/event-stream')
    try:
        month, day = map(int, date.split('-'))
    except Exception:
        return Response("data: {\"error\": \"Invalid date format\"}\n\n", mimetype='text/event-stream')

    def _quantize(v: float, g: float) -> float:
        return round(v / g) * g

    def _parse_tour_days(val: Any) -> int | None:
        try:
            s = str(val).strip()
            n = int(s)
            if n < 1:
                return None
            # Clamp to a reasonable upper bound to avoid extreme segmentation
            return min(n, 365)
        except Exception:
            return None

    def event_stream():
        log.info('[SSE] map_stream start date=%s mode=%s', date, fetch_mode)
        # Prevent parallel heavy streams: assign token; dry-run streams do not cancel main
        local_token = None
        is_dry_run = str(dry_run_param).lower() in ('1','true','yes')
        offline_only = str(offline_only_param).lower() in ('1', 'true', 'yes', 'on')
        with STREAM_LOCK:
            global STREAM_TOKEN
            if not is_dry_run:
                STREAM_TOKEN += 1
            local_token = STREAM_TOKEN
        try:
            gpx_path = GPX_FILE
            if gpx_override and gpx_override.endswith('.gpx') and Path(gpx_override).exists():
                gpx_path = Path(gpx_override)
            # Optional: reset circuit breaker to re-enable online requests
            try:
                if str(reset_api_param).lower() in ('1','true','yes'):
                    reset_api_disable()
                    reset_service_api_disable()
            except Exception:
                try:
                    td = _parse_tour_days(tour_days_param)
                    if td is None:
                        td = int(SESSION_STATE.get('tour_days', 7))
                    save_session_state({
                        "last_gpx_path": str(gpx_path),
                        "glyph_spacing_km": float(step_km),
                        "reverse": (str(reverse_param).lower() in ('1','true','yes')),
                        "start_date": (start_date_param or SESSION_STATE.get('start_date') or ''),
                        "tour_days": int(td),
                        "first_year": int(first_year),
                        "num_years": int(num_years)
                    })
                except Exception:
                    pass
            # Optional: force online/offline for debugging.
            # IMPORTANT: `set_force_online` is global state in `weather_openmeteo`, so
            # we must reset it when not explicitly requested to avoid sticky behavior
            # across requests.
            try:
                if force_online_param is not None:
                    set_force_online(str(force_online_param).lower() in ('1', 'true', 'yes'))
                else:
                    set_force_online(False)
            except Exception:
                pass
            step_km = float(step_km_param) if step_km_param else 25.0
            sampled_points, route_feature = sample_route(str(gpx_path), step_km=step_km)
            # Denser sampling for elevation profile (no weather fetching)
            # Increase sampling density by 2x: halve step_km, with sensible bounds
            try:
                if profile_step_km_param:
                    profile_step_km = float(profile_step_km_param)
                else:
                    profile_step_km = max(2.5, min(step_km / 2.0, 10.0))
            except Exception:
                profile_step_km = max(2.5, min(step_km / 2.0, 10.0))
            try:
                profile_points, _ = sample_route(str(gpx_path), step_km=profile_step_km)
            except Exception:
                profile_points = sampled_points
            # Persist session change (gpx, spacing, reverse flag are known here)
            if not is_dry_run:
                try:
                    # Derive years start if provided; otherwise compute from current year
                    import datetime as _dt
                    num_years = int(hist_years_param) if hist_years_param else SESSION_STATE.get('num_years', 10)
                    first_year = None
                    if hist_start_param:
                        try:
                            first_year = int(hist_start_param)
                        except Exception:
                            first_year = None
                    if first_year is None:
                        try:
                            today_year = _dt.date.today().year
                            first_year = today_year - num_years
                        except Exception:
                            first_year = SESSION_STATE.get('first_year', 2016)
                    save_session_state({
                        "last_gpx_path": str(gpx_path),
                        "glyph_spacing_km": float(step_km),
                        "reverse": (str(reverse_param).lower() in ('1','true','yes')),
                        "start_date": (start_date_param or SESSION_STATE.get('start_date') or ''),
                        "tour_days": (int(tour_days_param) if (tour_days_param and tour_days_param.isdigit()) else SESSION_STATE.get('tour_days', 7)),
                        "first_year": int(first_year),
                        "num_years": int(num_years)
                    })
                except Exception:
                    pass
            # Optional reverse tour order
            try:
                reversed_tour = True if str(reverse_param).lower() in ('1', 'true', 'yes') else False
            except Exception:
                reversed_tour = False
            if reversed_tour:
                try:
                    route_feature['geometry']['coordinates'] = list(reversed(route_feature['geometry']['coordinates']))
                    sampled_points = list(reversed(sampled_points))
                    # Also reverse profile sampling points to preserve forward progression in the profile
                    try:
                        profile_points = list(reversed(profile_points))
                    except Exception:
                        pass
                    log.info('[PLAN] Reversed route and sampled points for tour')
                except Exception as e:
                    log.warning('[PLAN] Reverse failed: %s', e)
            # Frontend no longer caps points; ignore max_points_param
            try:
                grid_deg = float(grid_deg_param) if grid_deg_param else 0.25
                if grid_deg <= 0:
                    grid_deg = 0.25
            except Exception:
                grid_deg = 0.25
        except Exception as e:
            yield f"data: {{\"error\": \"Route error: {str(e)}\"}}\n\n"
            return

        total = len(sampled_points)
        # Compute total route distance and tour-day setup BEFORE emitting route
        try:
            coords_all = route_feature['geometry']['coordinates']
            total_distance_km = 0.0
            for i in range(1, len(coords_all)):
                lon1, lat1 = coords_all[i-1]
                lon2, lat2 = coords_all[i]
                total_distance_km += haversine_km(lat1, lon1, lat2, lon2)
        except Exception:
            total_distance_km = None
        import datetime as _dt
        tour_days = _parse_tour_days(tour_days_param)
        start_date = None
        if start_date_param:
            try:
                start_date = _dt.date.fromisoformat(start_date_param)
            except Exception:
                start_date = None
        segment_length = None
        if total_distance_km and tour_days and tour_days > 0:
            segment_length = max(0.0001, total_distance_km / tour_days)
            log.info('[PLAN] Total distance=%.1f km, Total days=%d, Segment length=%.2f km', total_distance_km, tour_days, segment_length)

        # Emit route first
        try:
            import json
            # Build day-segmented route if tour params available
            route_segments = None
            start_marker = None
            end_marker = None
            day_headings: Dict[int, float] = {}
            try:
                coords = route_feature['geometry']['coordinates']
                if coords and len(coords) >= 2:
                    if not is_dry_run:
                        # Always provide start/end markers when start_date is known
                        if start_date is not None:
                            start_marker = {
                                "type": "Feature",
                                "geometry": {"type": "Point", "coordinates": coords[0]},
                                "properties": {"date": start_date.isoformat(), "label": start_date.isoformat()}
                            }
                            try:
                                log.info('[FLAGS] Start flag rendered at %.5f, %.5f', coords[0][1], coords[0][0])
                            except Exception:
                                pass
                            end_date = start_date + _dt.timedelta(days=(tour_days - 1)) if tour_days else start_date
                            end_marker = {
                                "type": "Feature",
                                "geometry": {"type": "Point", "coordinates": coords[-1]},
                                "properties": {"date": end_date.isoformat(), "label": end_date.isoformat()}
                            }
                            try:
                                log.info('[FLAGS] Finish flag rendered at %.5f, %.5f', coords[-1][1], coords[-1][0])
                            except Exception:
                                pass
                        # Exact split into `tour_days` segments using distance marks
                        if segment_length and start_date is not None and tour_days and tour_days > 0:
                            marks = [segment_length * k for k in range(1, int(tour_days))]
                            segs = []
                            acc = 0.0
                            cur = [coords[0]]
                            next_mark_idx = 0
                            def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
                                import math as _m
                                phi1 = _m.radians(lat1); phi2 = _m.radians(lat2)
                                dl = _m.radians(lon2 - lon1)
                                y = _m.sin(dl) * _m.cos(phi2)
                                x = _m.cos(phi1)*_m.sin(phi2) - _m.sin(phi1)*_m.cos(phi2)*_m.cos(dl)
                                ang = (_m.degrees(_m.atan2(y, x)) + 360.0) % 360.0
                                return ang
                            for i in range(1, len(coords)):
                                lon1, lat1 = coords[i-1]
                                lon2, lat2 = coords[i]
                                seg_km = haversine_km(lat1, lon1, lat2, lon2)
                                if seg_km <= 0:
                                    cur.append(coords[i])
                                    continue
                                # Process any marks that lie within this segment
                                while next_mark_idx < len(marks) and (acc + seg_km) >= marks[next_mark_idx]:
                                    mark_dist = marks[next_mark_idx]
                                    t = max(0.0, min(1.0, (mark_dist - acc) / seg_km))
                                    split_lon = lon1 + (lon2 - lon1) * t
                                    split_lat = lat1 + (lat2 - lat1) * t
                                    split_pt = [split_lon, split_lat]
                                    # close current segment at split point
                                    cur.append(split_pt)
                                    day_idx = next_mark_idx  # 0-based day index
                                    d = start_date + _dt.timedelta(days=int(day_idx))
                                    # compute representative heading for this segment (start->end)
                                    try:
                                        seg_coords = cur
                                        h = _bearing_deg(seg_coords[0][1], seg_coords[0][0], seg_coords[-1][1], seg_coords[-1][0])
                                        day_headings[int(day_idx)] = float(h)
                                    except Exception:
                                        pass
                                    segs.append({
                                        "type": "Feature",
                                        "geometry": {"type": "LineString", "coordinates": cur},
                                        "properties": {"day_index": int(day_idx), "date": d.isoformat()}
                                    })
                                    # start new segment from split point
                                    cur = [split_pt]
                                    next_mark_idx += 1
                                # add the segment end point
                                cur.append(coords[i])
                                acc += seg_km
                            # Append last segment
                            last_day_idx = int(tour_days) - 1
                            dlast = start_date + _dt.timedelta(days=last_day_idx)
                            try:
                                hlast = _bearing_deg(cur[0][1], cur[0][0], cur[-1][1], cur[-1][0])
                                day_headings[int(last_day_idx)] = float(hlast)
                            except Exception:
                                pass
                            segs.append({
                                "type": "Feature",
                                "geometry": {"type": "LineString", "coordinates": cur},
                                "properties": {"day_index": last_day_idx, "date": dlast.isoformat()}
                            })
                            route_segments = {"type": "FeatureCollection", "features": segs}
                            log.info('[PLAN] Route segmentation created: %d segments for %d days', len(segs), tour_days)
            except Exception as e:
                log.warning('[SSE] route segmentation error: %s', e)
            # Years span used by fetchers
            try:
                # Derive span from request params if provided; fallback to recent years ending last year
                num_years = int(hist_years_param) if hist_years_param else SESSION_STATE.get('num_years', 10)
                start_year = None
                if hist_start_param:
                    try:
                        start_year = int(hist_start_param)
                    except Exception:
                        start_year = None
                if start_year is None:
                    today_year = _dt.date.today().year
                    years_end = today_year - 1
                    years_start = years_end - int(num_years) + 1
                else:
                    years_start = int(start_year)
                    years_end = years_start + int(num_years) - 1
            except Exception:
                years_start = None
                years_end = None
            route_msg = json.dumps({
                "route": route_feature,
                "route_segments": route_segments,
                "start_marker": start_marker,
                "end_marker": end_marker,
                "years_start": years_start,
                "years_end": years_end,
                "total": total
            })
            # Abort if a newer non-dry-run stream started
            if (not is_dry_run) and (local_token != STREAM_TOKEN):
                log.info('[SSE] stream cancelled before route emit')
                return
            yield f"event: route\ndata: {route_msg}\n\n"
            log.info('[SSE] route emitted: points=%d', total)
        except Exception:
            pass
        # Compute cumulative distances along the full route geometry
        coords = route_feature['geometry']['coordinates']
        cum_route_km = []
        try:
            acc_full = 0.0
            cum_route_km.append(0.0)
            for i in range(1, len(coords)):
                lon1, lat1 = coords[i-1]
                lon2, lat2 = coords[i]
                acc_full += haversine_km(lat1, lon1, lat2, lon2)
                cum_route_km.append(acc_full)
            full_total_km = acc_full
        except Exception:
            # Fallback: use previously computed total_distance_km
            full_total_km = total_distance_km or 0.0
            cum_route_km = [full_total_km]

        # Map each profile sampled point to nearest route coordinate distance
        def _nearest_route_index(lat: float, lon: float) -> int:
            try:
                import math as _m
                best_i = 0
                best_d2 = float('inf')
                for j in range(len(coords)):
                    lonR, latR = coords[j]
                    mx = (lat + latR) * 0.5
                    dx = (lonR - lon) * (3.141592653589793 / 180.0) * max(0.1, abs(_m.cos(mx * 3.141592653589793 / 180.0)))
                    dy = (latR - lat) * (3.141592653589793 / 180.0)
                    d2 = dx*dx + dy*dy
                    if d2 < best_d2:
                        best_d2 = d2
                        best_i = j
                return best_i
            except Exception:
                return 0

        distances_from_start = {}
        for i, (plat, plon) in enumerate(profile_points):
            try:
                ridx = _nearest_route_index(plat, plon)
                distances_from_start[i] = float(cum_route_km[ridx]) if (0 <= ridx < len(cum_route_km)) else 0.0
            except Exception:
                distances_from_start[i] = 0.0

        # Scaling factor becomes 1.0 because distances are on full route scale
        sampled_total_km = float(distances_from_start.get(len(profile_points)-1, 0.0)) if profile_points else 0.0
        scale_factor = 1.0

        # Compute simple route heading at each sampled point (bearing prev→next)
        def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
            import math as _m
            phi1 = _m.radians(lat1); phi2 = _m.radians(lat2)
            dl = _m.radians(lon2 - lon1)
            y = _m.sin(dl) * _m.cos(phi2)
            x = _m.cos(phi1)*_m.sin(phi2) - _m.sin(phi1)*_m.cos(phi2)*_m.cos(dl)
            ang = (_m.degrees(_m.atan2(y, x)) + 360.0) % 360.0
            return ang
        sampled_heading_deg = []
        for i in range(len(profile_points)):
            if i == 0 and len(profile_points) > 1:
                lat1, lon1 = profile_points[i]
                lat2, lon2 = profile_points[i+1]
            elif i == len(profile_points)-1 and len(profile_points) > 1:
                lat1, lon1 = profile_points[i-1]
                lat2, lon2 = profile_points[i]
            else:
                lat1, lon1 = profile_points[i-1]
                lat2, lon2 = profile_points[i+1]
            sampled_heading_deg.append(_bearing_deg(lat1, lon1, lat2, lon2))

        # Distances for glyph points: map each glyph to nearest route coordinate cumulative distance
        glyph_route_dist_km: Dict[int, float] = {}
        try:
            for i, (glat, glon) in enumerate(sampled_points):
                ridx = _nearest_route_index(glat, glon)
                glyph_route_dist_km[i] = float(cum_route_km[ridx]) if (0 <= ridx < len(cum_route_km)) else 0.0
        except Exception:
            glyph_route_dist_km = {i: 0.0 for i in range(len(sampled_points))}

        # Day boundaries marks (distance in km from start)
        day_boundaries = []
        try:
            if segment_length and start_date is not None and tour_days and tour_days > 0:
                marks = [segment_length * k for k in range(1, int(tour_days))]
                for k, m in enumerate(marks):
                    d = start_date + _dt.timedelta(days=int(k))
                    day_boundaries.append({"distance_km": float(m), "day_index": int(k), "date": d.isoformat()})
        except Exception:
            pass

        # Elevation per profile point via nearest GPX track point (use active gpx_path)
        elev_m = []
        try:
            import gpxpy
            # Read the same GPX used for this stream
            with open(str(gpx_path), 'r', encoding='utf-8') as _f:
                _g = gpxpy.parse(_f)
            raw = []
            for tr in _g.tracks:
                for seg in tr.segments:
                    for p in seg.points:
                        raw.append((float(p.latitude), float(p.longitude), float(p.elevation) if (p.elevation is not None) else None))
            for rt in _g.routes:
                for p in rt.points:
                    raw.append((float(p.latitude), float(p.longitude), float(p.elevation) if (p.elevation is not None) else None))
            def _nearest_ele(lat: float, lon: float) -> float:
                best = None; best_d = 1e9
                for (la, lo, el) in raw:
                    d = haversine_km(lat, lon, la, lo)
                    if d < best_d:
                        best_d = d; best = el
                try:
                    return float(best) if best is not None else None
                except Exception:
                    return None
            for (lat, lon) in profile_points:
                elev_m.append(_nearest_ele(lat, lon))
        except Exception:
            elev_m = [None for _ in profile_points]

        # Emit profile event with necessary arrays
        try:
            prof_msg = json.dumps({
                "profile": {
                    "sampled_points": [[float(lon), float(lat)] for (lat, lon) in profile_points],
                    "sampled_dist_km": [float(distances_from_start[i] * scale_factor) for i in range(len(profile_points))],
                    "sampled_heading_deg": sampled_heading_deg,
                    "elev_m": elev_m,
                    "day_boundaries": day_boundaries
                }
            })
            # Cancel check before profile emit
            if (not is_dry_run) and (local_token != STREAM_TOKEN):
                log.info('[SSE] stream cancelled before profile emit')
                return
            yield f"event: profile\ndata: {prof_msg}\n\n"
            # Optional dry-run: after sending profile, finish without station fetching
            try:
                if str(dry_run_param).lower() in ('1','true','yes'):
                    yield "event: done\ndata: {\"stations_count\": 0}\n\n"
                    log.info('[SSE] dry-run done (profile only)')
                    return
            except Exception:
                pass
        except Exception as _e:
            log.warning('[SSE] profile emit failed: %s', _e)

        # Helper: nearest segment day assignment using route_segments
        def _nearest_segment_day(lat: float, lon: float):
            try:
                rs = route_segments
            except Exception:
                rs = None
            if not rs or not rs.get('features'):
                return None
            import math
            best_d2 = float('inf')
            best_day = None
            for seg in rs['features']:
                try:
                    day_val = seg['properties'].get('day_index')
                    if day_val is None:
                        continue
                    coords_seg = seg['geometry']['coordinates']
                    # Use simple equirectangular projection for distance
                    for j in range(1, len(coords_seg)):
                        lon1, lat1 = coords_seg[j-1]
                        lon2, lat2 = coords_seg[j]
                        mx = (lat1 + lat2) * 0.5
                        dx = (lon2 - lon1) * (3.141592653589793 / 180.0) * max(0.1, abs(math.cos(mx * 3.141592653589793 / 180.0)))
                        dy = (lat2 - lat1) * (3.141592653589793 / 180.0)
                        # segment vector
                        sx = dx
                        sy = dy
                        # point vector
                        px = (lon - lon1) * (3.141592653589793 / 180.0) * max(0.1, abs(math.cos(mx * 3.141592653589793 / 180.0)))
                        py = (lat - lat1) * (3.141592653589793 / 180.0)
                        denom = sx * sx + sy * sy
                        t = 0.0 if denom <= 1e-12 else max(0.0, min(1.0, (px * sx + py * sy) / denom))
                        cx = sx * t
                        cy = sy * t
                        rx = px - cx
                        ry = py - cy
                        d2 = rx * rx + ry * ry
                        if d2 < best_d2:
                            best_d2 = d2
                            best_day = int(day_val)
                except Exception:
                    continue
            return best_day

        tour_planning = tour_planning_param not in ('0', 'false', 'False')
        df_cache: Dict[str, Any] = {}
        completed = 0

        # Optional override for historical years window
        try:
            years_window = int(hist_years_param) if hist_years_param else 10
            if years_window < 1:
                years_window = 10
        except Exception:
            years_window = 10

        # Requested historical year span (aligns with frontend settings).
        # Used both for cache keying and for providers that support explicit year ranges.
        try:
            import datetime as _dt
            years_end_req = _dt.date.today().year - 1
            if hist_start_param:
                years_start_req = int(hist_start_param)
                years_end_req = min(years_end_req, years_start_req + int(years_window) - 1)
            else:
                years_start_req = years_end_req - int(years_window) + 1
            years_start_req = int(years_start_req)
            years_end_req = int(years_end_req)
        except Exception:
            years_start_req = None
            years_end_req = None

        def _span_tag() -> str:
            if years_start_req is None or years_end_req is None:
                return f"yspan{int(years_window)}"
            return f"y{int(years_start_req)}-{int(years_end_req)}"

        def _years_span_from_stats(st: Any) -> int:
            try:
                if not isinstance(st, dict):
                    return 0
                ys = st.get('_years_start')
                ye = st.get('_years_end')
                if ys is not None and ye is not None:
                    ys_i = int(ys)
                    ye_i = int(ye)
                    if ye_i >= ys_i:
                        return int(ye_i - ys_i + 1)
                md = st.get('_match_days')
                if isinstance(md, (int, float)):
                    return int(md)
                return 0
            except Exception:
                return 0

        # Track what data was actually used (for accurate UI messaging).
        provenance_counts: Dict[str, int] = {
            'disk_cache': 0,
            'offline_tile': 0,
            'api': 0,
            'dummy': 0,
        }
        provenance_providers: set[str] = set()
        years_used_min: int | None = None
        years_used_max: int | None = None

        def _record_years(ys: Any, ye: Any) -> None:
            nonlocal years_used_min, years_used_max
            try:
                ys_i = int(ys)
                ye_i = int(ye)
            except Exception:
                return
            if years_used_min is None or ys_i < years_used_min:
                years_used_min = ys_i
            if years_used_max is None or ye_i > years_used_max:
                years_used_max = ye_i

        def _record_provider(p: Any) -> None:
            try:
                if p is None:
                    return
                s = str(p).strip()
                if not s:
                    return
                provenance_providers.add(s)
            except Exception:
                return

        def _df_year_span(df: Any) -> tuple[int, int] | None:
            try:
                if df is None or getattr(df, 'empty', False):
                    return None
                ser = None
                if isinstance(df, pd.DataFrame):
                    if 'date' in df.columns:
                        ser = pd.to_datetime(df['date'], errors='coerce')
                    elif 'time' in df.columns:
                        ser = pd.to_datetime(df['time'], errors='coerce')
                if ser is None:
                    try:
                        ser = pd.to_datetime(getattr(df, 'index', None), errors='coerce')
                    except Exception:
                        ser = None
                if ser is None:
                    return None
                years = pd.Series(ser).dropna().dt.year
                years = years[pd.notna(years)]
                if len(years) == 0:
                    return None
                return (int(years.min()), int(years.max()))
            except Exception:
                return None

        def _df_provider(df: Any) -> str | None:
            try:
                if df is None or getattr(df, 'empty', False):
                    return None
                if isinstance(df, pd.DataFrame) and '_provider' in df.columns:
                    vals = df['_provider'].dropna().astype(str)
                    if len(vals) == 0:
                        return None
                    return str(vals.iloc[0])
            except Exception:
                return None
            return None

        def _format_years_span(ys: int | None, ye: int | None) -> str | None:
            if ys is None or ye is None:
                return None
            try:
                if int(ys) == int(ye):
                    return f"{int(ys)}"
                return f"{int(ys)}..{int(ye)}"
            except Exception:
                return None

        def _station_source_text() -> str | None:
            used = [k for k, v in provenance_counts.items() if int(v) > 0]
            if not used:
                return None

            years_txt = _format_years_span(years_used_min, years_used_max)
            providers = sorted(list(provenance_providers))
            provider_txt = None
            if len(providers) == 1:
                p = providers[0].lower()
                if p in ('openmeteo', 'open-meteo', 'open_meteo'):
                    provider_txt = 'Open-Meteo'
                elif p == 'meteostat':
                    provider_txt = 'Meteostat'
                else:
                    provider_txt = providers[0]

            if used == ['offline_tile']:
                base = 'offline Open-Meteo tile DB'
            elif used == ['disk_cache']:
                base = f"cached {provider_txt} station stats" if provider_txt else 'cached station stats'
            elif used == ['api']:
                base = f"historical {provider_txt} weather data" if provider_txt else 'historical weather data'
            elif used == ['dummy']:
                base = 'fallback dummy data'
            else:
                parts = []
                if provenance_counts.get('offline_tile', 0) > 0:
                    parts.append('offline tiles')
                if provenance_counts.get('disk_cache', 0) > 0:
                    parts.append('cached stats')
                if provenance_counts.get('api', 0) > 0:
                    parts.append('historical data')
                if provenance_counts.get('dummy', 0) > 0:
                    parts.append('dummy fallback')
                base = 'mixed sources' + (f" ({' / '.join(parts)})" if parts else '')

            if years_txt and 'dummy' not in used:
                base = f"{base} {years_txt}"
            return f"from {base}"

        if tour_planning and sampled_points:
            # Tour Planning: reuse stats PER DAY (not for the whole tour).
            # If we don't have tour segmentation info, fall back to legacy single-stats reuse.
            use_per_day = bool(segment_length and start_date is not None and tour_days is not None and tour_days > 0)

            def _dummy_stats(m: int, d: int) -> Dict[str, Any]:
                base_t = 15.0 if m in (4, 5, 6, 9, 10) else (25.0 if m in (7, 8) else (5.0 if m in (1, 2, 12) else 12.0))
                return {
                    'temperature_c': base_t,
                    'temp_p25': base_t - 2.0,
                    'temp_p75': base_t + 2.0,
                    'precipitation_mm': 0.0,
                    'wind_dir_deg': 180.0,
                    'wind_var_deg': 20.0,
                    'wind_speed_ms': 4.0,
                    '_temp_source': 'dummy_offline',
                }

            stats_by_day: Dict[int, Tuple[Dict[str, Any], int]] = {}
            rep_by_day: Dict[int, Tuple[float, float]] = {}
            source_by_day: Dict[int, Dict[str, Any]] = {}

            if use_per_day:
                # Choose a representative glyph point per day by distance-to-midpoint of day segment.
                for d_idx in range(int(tour_days)):
                    target_km = (float(d_idx) + 0.5) * float(segment_length)
                    best_i = 0
                    best_abs = float('inf')
                    for i in range(len(sampled_points)):
                        dk = float(glyph_route_dist_km.get(i, 0.0))
                        a = abs(dk - target_km)
                        if a < best_abs:
                            best_abs = a
                            best_i = i
                    rep_by_day[d_idx] = (float(sampled_points[best_i][0]), float(sampled_points[best_i][1]))
            else:
                # Legacy: single representative point.
                idx = len(sampled_points) // 2
                rep_by_day[0] = (float(sampled_points[idx][0]), float(sampled_points[idx][1]))

            for d_idx, (rep_lat, rep_lon) in rep_by_day.items():
                if use_per_day and start_date is not None:
                    assigned_date = start_date + _dt.timedelta(days=int(d_idx))
                    mm = int(assigned_date.month)
                    dd = int(assigned_date.day)
                else:
                    assigned_date = None
                    mm = int(month)
                    dd = int(day)

                rep_qlat = _quantize(rep_lat, grid_deg)
                rep_qlon = _quantize(rep_lon, grid_deg)
                rep_stats_name = f"stats_lat{rep_qlat:.2f}_lon{rep_qlon:.2f}_m{mm:02d}_d{dd:02d}_{fetch_mode}_{_span_tag()}.json"
                rep_stats_path = STATS_CACHE_DIR / rep_stats_name

                rep_cache_hit = False
                offline_stats = None
                stats: Dict[str, Any] | None = None
                matches = 0
                try:
                    if rep_stats_path.exists():
                        stats = __import__('json').load(open(rep_stats_path, 'r', encoding='utf-8'))
                        matches = int(stats.get('_match_days', 0) or 0)
                        rep_cache_hit = True
                        log.info('[CACHE][SSE] hit %s', rep_stats_name)
                except Exception:
                    rep_cache_hit = False

                # Prefer multi-year if requested: cached may be single-year from an offline DB.
                cached_span = _years_span_from_stats(stats) if rep_cache_hit else 0

                # Always probe offline availability (cheap) to support fallback when API is unavailable.
                offline_stats = _get_offline_stats(rep_lat, rep_lon, mm, dd)
                offline_span = _years_span_from_stats(offline_stats) if offline_stats is not None else 0

                need_multi = int(years_window) >= 2
                has_multi_cached = cached_span >= 2
                has_multi_offline = offline_span >= 2

                # If we don't have multi-year cached, and offline is only single-year, we will try online
                # to warm the stats cache (unless offline-strict prevents outbound requests).
                if (not rep_cache_hit) and (offline_stats is not None) and (not need_multi):
                    # Simple path: no multi-year requested; offline is good enough.
                    stats = dict(offline_stats)
                    matches = int(stats.get('_match_days', 0) or 0)
                    log.info('[OFFLINE][SSE] Representative hit tile=%s match_days=%d', stats.get('_tile_id'), matches)
                    try:
                        s = {**stats, '_match_days': matches}
                        import json as _json
                        _json.dump(s, open(rep_stats_path, 'w', encoding='utf-8'), default=_json_default)
                        log.info('[CACHE][SSE] offline -> saved %s', rep_stats_name)
                    except Exception:
                        pass
                    # Continue to provenance tracking below.
                elif rep_cache_hit and (has_multi_cached or (not need_multi)):
                    # Cached stats already satisfy requested multi-year-ness.
                    pass
                elif (offline_stats is not None) and has_multi_offline:
                    # Multi-year offline DB (rare): use it.
                    stats = dict(offline_stats)
                    matches = int(stats.get('_match_days', 0) or 0)
                    log.info('[OFFLINE][SSE] Representative hit tile=%s match_days=%d (multi-year)', stats.get('_tile_id'), matches)
                    try:
                        s = {**stats, '_match_days': matches}
                        import json as _json
                        _json.dump(s, open(rep_stats_path, 'w', encoding='utf-8'), default=_json_default)
                        log.info('[CACHE][SSE] offline -> saved %s', rep_stats_name)
                    except Exception:
                        pass

                df = None

                # If cache does not satisfy the requested multi-year window, try online (warm cache).
                # If offline strict is enabled, we can only use offline/cached data.
                must_skip_online = bool(offline_only or (_offline_strict_enabled() and _get_offline_store() is not None))

                if ((not rep_cache_hit) or (need_multi and (not has_multi_cached))) and (stats is None) and (not must_skip_online):
                    if _offline_strict_enabled() and _get_offline_store() is not None:
                        yield "event: error\ndata: {\"error\": \"Offline strict mode: no offline data for representative point/day.\"}\n\n"
                        return
                    if fetch_mode == 'single_day':
                        df = fetch_daily_weather_same_day(
                            rep_lat,
                            rep_lon,
                            mm,
                            dd,
                            years_window=years_window,
                            start_year=years_start_req,
                            end_year=years_end_req,
                        )
                    else:
                        df = fetch_daily_weather(
                            rep_lat,
                            rep_lon,
                            mm,
                            dd,
                            years_window=years_window,
                            start_year=years_start_req,
                            end_year=years_end_req,
                        )

                df_span = _df_year_span(df)
                df_prov = _df_provider(df)
                if df_span is not None:
                    _record_years(df_span[0], df_span[1])
                _record_provider(df_prov)

                if (stats is None) and (df is None or len(df) < (1 if fetch_mode == 'single_day' else 30)):
                    # If API is unavailable, fall back to offline single-year if present.
                    if offline_stats is not None:
                        stats = dict(offline_stats)
                        matches = int(stats.get('_match_days', 0) or 0)
                        log.info('[OFFLINE][SSE] Representative fallback tile=%s match_days=%d', stats.get('_tile_id'), matches)
                    else:
                        stats = _dummy_stats(mm, dd)
                        matches = 0
                elif rep_cache_hit and isinstance(stats, dict) and (has_multi_cached or (not need_multi)):
                    pass
                elif stats is not None and isinstance(stats, dict) and (offline_stats is not None) and (not need_multi):
                    # already handled above
                    pass
                else:
                    stats, matches = compute_weather_statistics(df, mm, dd)
                    # Attach provenance for later accurate UI messaging.
                    try:
                        if df_span is not None:
                            stats['_years_start'] = int(df_span[0])
                            stats['_years_end'] = int(df_span[1])
                        if df_prov:
                            stats['_provider'] = str(df_prov)
                    except Exception:
                        pass
                    # Representative daytime temperature from hourly data (online only).
                    try:
                        dfh = fetch_hourly_weather_same_day(
                            rep_lat,
                            rep_lon,
                            mm,
                            dd,
                            years_window=years_window,
                            start_year=years_start_req,
                            end_year=years_end_req,
                        )
                        dt_stats, _dt_points = compute_daytime_temperature_statistics(dfh, mm, dd)
                        stats.update(dt_stats)
                        stats['_temp_source'] = 'hourly_daytime'
                    except Exception as e:
                        log.warning('[SSE] Daytime temp unavailable (rep): %s', e)
                    try:
                        s = {**stats, '_match_days': matches}
                        import json as _json
                        _json.dump(s, open(rep_stats_path, 'w', encoding='utf-8'), default=_json_default)
                        log.info('[CACHE][SSE] miss -> saved %s', rep_stats_name)
                    except Exception:
                        pass

                if stats is None:
                    stats = _dummy_stats(mm, dd)
                    matches = 0

                # Attach date metadata to reused stats (safe to override per day).
                try:
                    stats = dict(stats)
                    if assigned_date is not None:
                        stats['_assigned_date'] = assigned_date.isoformat()
                except Exception:
                    pass
                stats_by_day[int(d_idx)] = (dict(stats), int(matches))

                # Track per-day provenance so per-glyph counts are accurate.
                try:
                    src = 'dummy' if str(stats.get('_temp_source', '')).startswith('dummy') else ('offline_tile' if bool(stats.get('_offline')) else ('disk_cache' if rep_cache_hit else 'api'))
                    ys = stats.get('_years_start')
                    ye = stats.get('_years_end')
                    if ys is not None and ye is not None:
                        _record_years(ys, ye)
                    _record_provider(stats.get('_provider'))
                    source_by_day[int(d_idx)] = {
                        'source': src,
                        'years_start': ys,
                        'years_end': ye,
                        'provider': stats.get('_provider'),
                    }
                except Exception:
                    source_by_day[int(d_idx)] = {'source': 'unknown'}

            if not stats_by_day:
                # Should not happen, but keep UI responsive.
                stats_by_day[0] = (_dummy_stats(month, day), 0)

            for i, (lat, lon) in enumerate(sampled_points):
                # Cancel check to prevent parallel streams
                if (not is_dry_run) and (local_token != STREAM_TOKEN):
                    log.info('[SSE] stream cancelled during station loop')
                    return
                try:
                    day_idx = 0
                    assigned_date = None
                    if use_per_day and start_date is not None:
                        try:
                            day_idx = _nearest_segment_day(lat, lon)
                        except Exception:
                            day_idx = None
                        if day_idx is None:
                            try:
                                import bisect as _bisect
                                d_km = float(glyph_route_dist_km.get(i, 0.0))
                                marks = [float(segment_length) * k for k in range(1, int(tour_days))]
                                day_idx = int(max(0, min(int(tour_days) - 1, _bisect.bisect_left(marks, d_km))))
                            except Exception:
                                day_idx = 0
                        day_idx = int(max(0, min(int(tour_days) - 1, int(day_idx))))
                        assigned_date = start_date + _dt.timedelta(days=day_idx)

                    stats, matches = stats_by_day.get(int(day_idx), next(iter(stats_by_day.values())))

                    # Count provenance per glyph based on its assigned day.
                    try:
                        sm = source_by_day.get(int(day_idx), {})
                        src = str(sm.get('source', '') or '')
                        if src in provenance_counts:
                            provenance_counts[src] += 1
                        ys = sm.get('years_start')
                        ye = sm.get('years_end')
                        if ys is not None and ye is not None:
                            _record_years(ys, ye)
                        _record_provider(sm.get('provider'))
                    except Exception:
                        pass

                    svg = generate_glyph_v2(stats, debug=False)
                    feature = {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "properties": {
                            **stats,
                            "svg": svg,
                            "station_id": f"point_{i}",
                            "station_name": f"Route Point {i}",
                            "station_lat": lat,
                            "station_lon": lon,
                            "min_distance_to_route_km": 0.0,
                            "usage_count": 1,
                            "_match_days": matches,
                            "_source_mode": ("tour_planning_offline" if bool(stats.get('_offline')) else "tour_planning_reused"),
                            "distance_from_start_km": float(glyph_route_dist_km.get(i, 0.0))
                        }
                    }
                    if use_per_day and assigned_date is not None:
                        feature['properties']['tour_day_index'] = int(day_idx)
                        feature['properties']['tour_total_days'] = int(tour_days)
                        feature['properties']['date'] = assigned_date.isoformat()
                    try:
                        wspd = float(stats.get('wind_speed_ms', 0.0))
                        gmax = float(stats.get('wind_gust_ms', 0.0)) if 'wind_gust_ms' in stats else 0.0
                        feature['properties']['_wind_warning'] = (wspd >= 17.2) or (gmax >= 20.0)
                    except Exception:
                        feature['properties']['_wind_warning'] = False
                    completed += 1
                    msg = json.dumps({"feature": feature, "completed": completed, "total": total})
                    yield f"event: station\ndata: {msg}\n\n"
                    if completed % 5 == 0 or completed == total:
                        log.info('[SSE] station emitted %d/%d', completed, total)
                except Exception:
                    completed += 1
                    yield f"event: station\ndata: {{\"error\": \"compose error\", \"completed\": {completed}, \"total\": {total}}}\n\n"
            # Aggregate tour summary (reused stats per day)
            try:
                import numpy as _np, math as _m, json as _json
                total_days_val = int(tour_days) if tour_days else 0
                def _cos_rel(wdir_deg: float, route_deg: float) -> float:
                    # wind dir is FROM; convert to TO
                    wto = (float(wdir_deg) + 180.0) % 360.0
                    ang = _m.radians(wto - float(route_deg))
                    return float(_m.cos(ang))
                # Comfort thresholds
                T_COLD = float(temp_cold_param) if temp_cold_param is not None else 15.0
                T_HOT = float(temp_hot_param) if temp_hot_param is not None else 25.0
                R_MAX = float(rain_high_param) if rain_high_param is not None else 1.0
                W_HEAD = float(wind_head_comfort_param) if wind_head_comfort_param is not None else 4.0
                W_TAIL = float(wind_tail_comfort_param) if wind_tail_comfort_param is not None else 10.0
                rain_days = 0; headwind_days = 0; tailwind_days = 0; comfort_days = 0; extreme_hot = 0; extreme_cold = 0
                temps = []; winds = []; precs = []
                for d_idx in range(total_days_val):
                    st, _mch = stats_by_day.get(int(d_idx), next(iter(stats_by_day.values())))
                    t = float(st.get('temperature_c', 0.0))
                    w = float(st.get('wind_speed_ms', 0.0))
                    pmm = float(st.get('precipitation_mm', 0.0))
                    temps.append(t); winds.append(w); precs.append(pmm)
                    if pmm >= 1.0: rain_days += 1
                    # relative wind sign vs segment heading
                    seg_head = float(day_headings.get(d_idx, st.get('wind_dir_deg', 0.0)))
                    eff = _cos_rel(float(st.get('wind_dir_deg', 0.0)), seg_head)
                    if eff > 0.33: tailwind_days += 1
                    elif eff < -0.33: headwind_days += 1
                    # comfort criteria
                    # Comfort: temp within [T_COLD..T_HOT], rain below R_MAX, wind threshold varies by effective wind direction
                    if (T_COLD <= t <= T_HOT) and (pmm < R_MAX):
                        # eff < -0.33 → headwind, eff > 0.33 → tailwind, else crosswind → treat like headwind
                        if eff < -0.33:
                            if w < W_HEAD:
                                comfort_days += 1
                        elif eff > 0.33:
                            if w < W_TAIL:
                                comfort_days += 1
                        else:
                            if w < W_HEAD:
                                comfort_days += 1
                    if t >= 30.0: extreme_hot += 1
                    if t <= 5.0: extreme_cold += 1
                med_t = float(_np.nanmedian(temps)) if temps else None
                max_t = float(_np.nanmax(temps)) if temps else None
                min_t = float(_np.nanmin(temps)) if temps else None
                total_prec = float(_np.nansum(precs)) if precs else 0.0
                mean_wind = float(_np.nanmean(winds)) if winds else None
                tour_summary = {
                    "total_days": total_days_val,
                    "rain_days": int(rain_days),
                    "headwind_days": int(headwind_days),
                    "tailwind_days": int(tailwind_days),
                    "comfort_days": int(comfort_days),
                    "extreme_days_hot": int(extreme_hot),
                    "extreme_days_cold": int(extreme_cold),
                    "median_temperature": med_t,
                    "max_temperature": max_t,
                    "min_temperature": min_t,
                    "total_precipitation": total_prec,
                    "mean_wind_speed": mean_wind
                }
                try:
                    save_session_state({"tour_summary": tour_summary})
                except Exception:
                    pass
                yield f"event: tour_summary\ndata: {_json.dumps(tour_summary)}\n\n"
            except Exception as e:
                log.warning('[SSE] summary aggregation (reused) failed: %s', e)
        else:
            # Per-point mode
            # Prepare per-day aggregation containers
            day_aggr: Dict[int, Dict[str, Any]] = {}
            for i, (lat, lon) in enumerate(sampled_points):
                # Cancel check to prevent parallel streams
                if (not is_dry_run) and (local_token != STREAM_TOKEN):
                    log.info('[SSE] stream cancelled during station loop')
                    return
                try:
                    qlat = _quantize(lat, grid_deg)
                    qlon = _quantize(lon, grid_deg)
                    # Assign per-glyph date if tour planning provided
                    assigned_date = None
                    if segment_length and start_date is not None:
                        # Prefer mapping via precomputed route segments for robust boundary assignment
                        day_idx = _nearest_segment_day(lat, lon)
                        d_km = float(distances_from_start.get(i, 0.0)) * float(scale_factor)
                        if day_idx is None:
                            # Fallback: scaled distance marks
                            try:
                                import bisect as _bisect
                                marks = [segment_length * k for k in range(1, int(tour_days))]
                                day_idx = int(max(0, min(tour_days - 1, _bisect.bisect_left(marks, d_km))))
                            except Exception:
                                day_idx = int(max(0, min(tour_days - 1, int(d_km // segment_length))))
                        assigned_date = start_date + _dt.timedelta(days=day_idx)
                        log.info('[SSE][PLAN] Glyph #%d: dist=%.1f km → day %d date %s', i, d_km, day_idx, assigned_date.isoformat())
                    mm = month
                    dd = day
                    if assigned_date is not None:
                        mm = assigned_date.month
                        dd = assigned_date.day

                    # Disk cache by quantized lat/lon + month/day + fetch_mode
                    stats_name = f"stats_lat{qlat:.2f}_lon{qlon:.2f}_m{mm:02d}_d{dd:02d}_{fetch_mode}_{_span_tag()}.json"
                    stats_path = STATS_CACHE_DIR / stats_name
                    if stats_path.exists():
                        try:
                            stats = __import__('json').load(open(stats_path, 'r', encoding='utf-8'))
                            matching = int(stats.get('_match_days', 0) or 0)
                            try:
                                provenance_counts['disk_cache'] += 1
                                ys = stats.get('_years_start')
                                ye = stats.get('_years_end')
                                if ys is not None and ye is not None:
                                    _record_years(ys, ye)
                                _record_provider(stats.get('_provider'))
                            except Exception:
                                pass
                            svg = generate_glyph_v2(stats, debug=False)
                            feature = {
                                "type": "Feature",
                                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                                "properties": {
                                    **stats,
                                    "svg": svg,
                                    "station_id": f"point_{i}",
                                    "station_name": f"Route Point {i}",
                                    "station_lat": lat,
                                    "station_lon": lon,
                                    "min_distance_to_route_km": 0.0,
                                    "usage_count": 1,
                                    "_match_days": matching,
                                    "_source_mode": "disk_cache",
                                    "_grid_deg": grid_deg,
                                    "distance_from_start_km": float(glyph_route_dist_km.get(i, 0.0))
                                }
                            }
                            if segment_length and start_date is not None and assigned_date is not None:
                                feature['properties']['tour_day_index'] = day_idx
                                feature['properties']['tour_total_days'] = tour_days
                                feature['properties']['date'] = assigned_date.isoformat()
                            completed += 1
                            msg = json.dumps({"feature": feature, "completed": completed, "total": total})
                            yield f"event: station\ndata: {msg}\n\n"
                            if completed % 5 == 0 or completed == total:
                                log.info('[SSE] station emitted %d/%d (cache)', completed, total)
                            continue
                        except Exception:
                            pass

                    # Offline-first per point/day: if tile stats exist, skip any network requests.
                    offline_stats = _get_offline_stats(lat, lon, mm, dd)
                    offline_fallback_stats = None
                    try:
                        want_multi_year = (years_start_req is not None and years_end_req is not None and int(years_end_req) - int(years_start_req) + 1 >= 2)
                    except Exception:
                        want_multi_year = False

                    if offline_stats is not None:
                        stats = dict(offline_stats)
                        matching = int(stats.get('_match_days', 0) or 0)
                        offline_span = _years_span_from_stats(stats)
                        if (not want_multi_year) or offline_span >= 2:
                            try:
                                provenance_counts['offline_tile'] += 1
                                ys = stats.get('_years_start')
                                ye = stats.get('_years_end')
                                if ys is not None and ye is not None:
                                    _record_years(ys, ye)
                                _record_provider(stats.get('_provider'))
                            except Exception:
                                pass
                            try:
                                s = {**stats, '_match_days': matching}
                                import json as _json
                                _json.dump(s, open(stats_path, 'w', encoding='utf-8'), default=_json_default)
                                log.info('[CACHE][SSE] offline -> saved %s', stats_name)
                            except Exception:
                                pass
                            svg = generate_glyph_v2(stats, debug=False)
                            feature = {
                                "type": "Feature",
                                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                                "properties": {
                                    **stats,
                                    "svg": svg,
                                    "station_id": f"point_{i}",
                                    "station_name": f"Route Point {i}",
                                    "station_lat": lat,
                                    "station_lon": lon,
                                    "min_distance_to_route_km": 0.0,
                                    "usage_count": 1,
                                    "_match_days": matching,
                                    "_source_mode": "offline_tile",
                                    "_grid_deg": grid_deg,
                                    "distance_from_start_km": float(glyph_route_dist_km.get(i, 0.0))
                                }
                            }
                            if segment_length and start_date is not None and assigned_date is not None:
                                feature['properties']['tour_day_index'] = day_idx
                                feature['properties']['tour_total_days'] = tour_days
                                feature['properties']['date'] = assigned_date.isoformat()
                            completed += 1
                            msg = json.dumps({"feature": feature, "completed": completed, "total": total})
                            yield f"event: station\ndata: {msg}\n\n"
                            if completed % 5 == 0 or completed == total:
                                log.info('[SSE] station emitted %d/%d (offline)', completed, total)
                            continue
                        # Multi-year requested but offline is single-year: keep offline as fallback and continue to online/cached fetch.
                        offline_fallback_stats = stats

                    if _offline_strict_enabled() and _get_offline_store() is not None:
                        # Strict mode: do not use online fallback or dummy glyphs.
                        if offline_fallback_stats is not None:
                            stats = dict(offline_fallback_stats)
                            matching = int(stats.get('_match_days', 0) or 0)
                            try:
                                provenance_counts['offline_tile'] += 1
                                ys = stats.get('_years_start')
                                ye = stats.get('_years_end')
                                if ys is not None and ye is not None:
                                    _record_years(ys, ye)
                                _record_provider(stats.get('_provider'))
                            except Exception:
                                pass
                            svg = generate_glyph_v2(stats, debug=False)
                            feature = {
                                "type": "Feature",
                                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                                "properties": {
                                    **stats,
                                    "svg": svg,
                                    "station_id": f"point_{i}",
                                    "station_name": f"Route Point {i}",
                                    "station_lat": lat,
                                    "station_lon": lon,
                                    "min_distance_to_route_km": 0.0,
                                    "usage_count": 1,
                                    "_match_days": matching,
                                    "_source_mode": "offline_tile",
                                    "_grid_deg": grid_deg,
                                    "distance_from_start_km": float(glyph_route_dist_km.get(i, 0.0))
                                }
                            }
                            if segment_length and start_date is not None and assigned_date is not None:
                                feature['properties']['tour_day_index'] = day_idx
                                feature['properties']['tour_total_days'] = tour_days
                                feature['properties']['date'] = assigned_date.isoformat()
                            completed += 1
                            msg = json.dumps({"feature": feature, "completed": completed, "total": total})
                            yield f"event: station\ndata: {msg}\n\n"
                            continue
                        completed += 1
                        yield f"event: station\ndata: {{\"error\": \"Offline strict mode: no offline data for this point/day\", \"completed\": {completed}, \"total\": {total}}}\n\n"
                        continue

                    if offline_only:
                        # Request-level offline mode: never perform online fetches.
                        if offline_fallback_stats is not None:
                            stats = dict(offline_fallback_stats)
                            matching = int(stats.get('_match_days', 0) or 0)
                            try:
                                provenance_counts['offline_tile'] += 1
                                ys = stats.get('_years_start')
                                ye = stats.get('_years_end')
                                if ys is not None and ye is not None:
                                    _record_years(ys, ye)
                                _record_provider(stats.get('_provider'))
                            except Exception:
                                pass
                            src_mode = 'offline_tile'
                        else:
                            stats = _dummy_stats(mm, dd)
                            matching = 0
                            try:
                                provenance_counts['dummy'] += 1
                            except Exception:
                                pass
                            src_mode = 'dummy'
                        svg = generate_glyph_v2(stats, debug=False)
                        feature = {
                            "type": "Feature",
                            "geometry": {"type": "Point", "coordinates": [lon, lat]},
                            "properties": {
                                **stats,
                                "svg": svg,
                                "station_id": f"point_{i}",
                                "station_name": f"Route Point {i}",
                                "station_lat": lat,
                                "station_lon": lon,
                                "min_distance_to_route_km": 0.0,
                                "usage_count": 1,
                                "_match_days": matching,
                                "_source_mode": src_mode,
                                "_grid_deg": grid_deg,
                                "distance_from_start_km": float(glyph_route_dist_km.get(i, 0.0))
                            }
                        }
                        if segment_length and start_date is not None and assigned_date is not None:
                            feature['properties']['tour_day_index'] = day_idx
                            feature['properties']['tour_total_days'] = tour_days
                            feature['properties']['date'] = assigned_date.isoformat()
                        completed += 1
                        msg = json.dumps({"feature": feature, "completed": completed, "total": total})
                        yield f"event: station\ndata: {msg}\n\n"
                        continue

                    # Tour optimization: when start_date+tour_days is known, fetch ONE contiguous
                    # daily window per year for the whole tour, then reuse it for all points.
                    use_tour_window = bool(segment_length and start_date is not None and tour_days is not None)
                    if use_tour_window:
                        span_days = int(tour_days)
                        window_key = f"{qlat:.4f},{qlon:.4f}:{fetch_mode}:window:{start_date.isoformat()}:{span_days}:{_span_tag()}"
                        if window_key in df_cache:
                            df = df_cache[window_key]
                        else:
                            df = fetch_daily_weather_window(
                                qlat,
                                qlon,
                                start_date.month,
                                start_date.day,
                                span_days,
                                years_window=years_window,
                                start_year=years_start_req,
                                end_year=years_end_req,
                            )
                            df_cache[window_key] = df
                        min_rows = max(1, int(span_days))
                    else:
                        # Fetch daily data using assigned mm/dd and cache per date
                        key = f"{qlat:.4f},{qlon:.4f}:{fetch_mode}:{mm:02d}-{dd:02d}:{_span_tag()}"
                        if key in df_cache:
                            df = df_cache[key]
                        else:
                            if fetch_mode == 'single_day':
                                df = fetch_daily_weather_same_day(
                                    qlat,
                                    qlon,
                                    mm,
                                    dd,
                                    years_window=years_window,
                                    start_year=years_start_req,
                                    end_year=years_end_req,
                                )
                            else:
                                df = fetch_daily_weather(
                                    qlat,
                                    qlon,
                                    mm,
                                    dd,
                                    years_window=years_window,
                                    start_year=years_start_req,
                                    end_year=years_end_req,
                                )
                            df_cache[key] = df
                        min_rows = (1 if fetch_mode == 'single_day' else 30)

                    if df is None or len(df) < int(min_rows):
                        if offline_fallback_stats is not None:
                            stats = dict(offline_fallback_stats)
                            matching = int(stats.get('_match_days', 0) or 0)
                            try:
                                provenance_counts['offline_tile'] += 1
                                ys = stats.get('_years_start')
                                ye = stats.get('_years_end')
                                if ys is not None and ye is not None:
                                    _record_years(ys, ye)
                                _record_provider(stats.get('_provider'))
                            except Exception:
                                pass
                            try:
                                s = {**stats, '_match_days': matching}
                                import json as _json
                                _json.dump(s, open(stats_path, 'w', encoding='utf-8'), default=_json_default)
                                log.info('[CACHE][SSE] offline-fallback -> saved %s', stats_name)
                            except Exception:
                                pass
                            svg = generate_glyph_v2(stats, debug=False)
                            feature = {
                                "type": "Feature",
                                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                                "properties": {
                                    **stats,
                                    "svg": svg,
                                    "station_id": f"point_{i}",
                                    "station_name": f"Route Point {i}",
                                    "station_lat": lat,
                                    "station_lon": lon,
                                    "min_distance_to_route_km": 0.0,
                                    "usage_count": 1,
                                    "_match_days": matching,
                                    "_source_mode": "offline_tile",
                                    "_grid_deg": grid_deg,
                                    "distance_from_start_km": float(glyph_route_dist_km.get(i, 0.0))
                                }
                            }
                            if segment_length and start_date is not None and assigned_date is not None:
                                feature['properties']['tour_day_index'] = day_idx
                                feature['properties']['tour_total_days'] = tour_days
                                feature['properties']['date'] = assigned_date.isoformat()
                            completed += 1
                            msg = json.dumps({"feature": feature, "completed": completed, "total": total})
                            yield f"event: station\ndata: {msg}\n\n"
                            if completed % 5 == 0 or completed == total:
                                log.info('[SSE] station emitted %d/%d (offline fallback)', completed, total)
                            continue
                        # Emit a dummy glyph for this point
                        try:
                            provenance_counts['dummy'] += 1
                        except Exception:
                            pass
                        base_t = 15.0 if mm in (4,5,6,9,10) else (25.0 if mm in (7,8) else (5.0 if mm in (1,2,12) else 12.0))
                        stats = {
                            'temperature_c': base_t,
                            'temp_p25': base_t - 2.0,
                            'temp_p75': base_t + 2.0,
                            'precipitation_mm': 0.0,
                            'wind_dir_deg': 180.0,
                            'wind_var_deg': 20.0,
                            'wind_speed_ms': 4.0,
                            '_temp_source': 'dummy_offline',
                        }
                        svg = generate_glyph_v2(stats, debug=False)
                        feature = {
                            "type": "Feature",
                            "geometry": {"type": "Point", "coordinates": [lon, lat]},
                            "properties": {
                                **stats,
                                "svg": svg,
                                "station_id": f"point_{i}",
                                "station_name": f"Route Point {i}",
                                "station_lat": lat,
                                "station_lon": lon,
                                "min_distance_to_route_km": 0.0,
                                "usage_count": 1,
                                "_match_days": [],
                                "_source_mode": f"per_point_{fetch_mode}_window_dummy" if use_tour_window else f"per_point_{fetch_mode}_dummy",
                                "_grid_deg": grid_deg,
                                "distance_from_start_km": float(glyph_route_dist_km.get(i, 0.0))
                            }
                        }
                        if segment_length and start_date is not None and assigned_date is not None:
                            feature['properties']['tour_day_index'] = day_idx
                            feature['properties']['tour_total_days'] = tour_days
                            feature['properties']['date'] = assigned_date.isoformat()
                        completed += 1
                        msg = json.dumps({"feature": feature, "completed": completed, "total": total})
                        yield f"event: station\ndata: {msg}\n\n"
                        if completed % 5 == 0 or completed == total:
                            log.info('[SSE] station emitted %d/%d (dummy)', completed, total)
                        continue
                    # Compute stats for this mm/dd
                    stats, matching = compute_weather_statistics(df, mm, dd)
                    # Attach provenance and count usage.
                    try:
                        provenance_counts['api'] += 1
                        span = _df_year_span(df)
                        prov = _df_provider(df)
                        if span is not None:
                            stats['_years_start'] = int(span[0])
                            stats['_years_end'] = int(span[1])
                            _record_years(span[0], span[1])
                        if prov:
                            stats['_provider'] = str(prov)
                            _record_provider(prov)
                    except Exception:
                        pass
                    # Daytime variability (hourly across years) — cache by quantized lat/lon and date
                    try:
                        dt_key = f"{qlat:.4f},{qlon:.4f}:{mm:02d}-{dd:02d}:hourly:{_span_tag()}"
                        dfh = df_cache.get(dt_key)
                        if dfh is None:
                            dfh = fetch_hourly_weather_same_day(
                                qlat,
                                qlon,
                                mm,
                                dd,
                                years_window=years_window,
                                start_year=years_start_req,
                                end_year=years_end_req,
                            )
                            df_cache[dt_key] = dfh
                        if dfh is not None and len(dfh) >= 4:
                            dt_stats, _dt_points = compute_daytime_temperature_statistics(dfh, mm, dd)
                            # Add daytime percentile keys and median for overlay rendering
                            for k in ('temp_day_p25', 'temp_day_p75', 'temp_day_median'):
                                if k in dt_stats:
                                    stats[k] = dt_stats[k]
                            if 'temp_hist_p25' in dt_stats and 'temp_hist_p75' in dt_stats:
                                # Ensure historical keys are present for clarity (duplicate of temp_p25/temp_p75)
                                stats['temp_hist_p25'] = dt_stats['temp_hist_p25']
                                stats['temp_hist_p75'] = dt_stats['temp_hist_p75']
                            stats['_temp_source'] = 'daily+hourly'
                    except Exception as e:
                        log.warning('[SSE] Daytime temp unavailable (per-point %s,%s m%d d%d): %s', qlat, qlon, mm, dd, e)
                    # Save computed stats to disk cache AFTER daytime adjustments.
                    try:
                        s = {**stats, '_match_days': matching}
                        import json as _json
                        _json.dump(s, open(stats_path, 'w', encoding='utf-8'), default=_json_default)
                        log.info('[CACHE][SSE] miss -> saved %s', stats_name)
                    except Exception:
                        pass
                    # Optional: Skip per-point hourly to reduce request load
                    # (Representative hourly is computed in tour_planning mode)
                    svg = generate_glyph_v2(stats, debug=False)
                    feature = {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "properties": {
                            **stats,
                            "svg": svg,
                            "station_id": f"point_{i}",
                            "station_name": f"Route Point {i}",
                            "station_lat": lat,
                            "station_lon": lon,
                            "min_distance_to_route_km": 0.0,
                            "usage_count": 1,
                            "_match_days": matching,
                            "_source_mode": f"per_point_{fetch_mode}_window" if use_tour_window else f"per_point_{fetch_mode}",
                            "_grid_deg": grid_deg,
                            "distance_from_start_km": float(glyph_route_dist_km.get(i, 0.0))
                        }
                    }
                    if segment_length and start_date is not None and assigned_date is not None:
                        feature['properties']['tour_day_index'] = day_idx
                        feature['properties']['tour_total_days'] = tour_days
                        feature['properties']['date'] = assigned_date.isoformat()
                    # Aggregate per-day stats
                    try:
                        dkey = int(day_idx) if (segment_length and start_date is not None and assigned_date is not None) else None
                    except Exception:
                        dkey = None
                    if dkey is not None:
                        ag = day_aggr.get(dkey)
                        if ag is None:
                            ag = {"temps": [], "winds": [], "precs": [], "effs": []}
                            day_aggr[dkey] = ag
                        try:
                            # Prefer daytime median temperature if available, else fallback to daily mean
                            _t_day = stats.get('temp_day_median')
                            _t_use = _t_day if (_t_day is not None) else stats.get('temperature_c', 0.0)
                            ag["temps"].append(float(_t_use))
                            ag["winds"].append(float(stats.get('wind_speed_ms', 0.0)))
                            ag["precs"].append(float(stats.get('precipitation_mm', 0.0)))
                            # eff relative vs segment heading
                            seg_head = float(day_headings.get(dkey, 0.0))
                            import math as _m
                            wdir_to = (float(stats.get('wind_dir_deg', 0.0)) + 180.0) % 360.0
                            eff = _m.cos(_m.radians(wdir_to - seg_head))
                            ag["effs"].append(float(eff))
                        except Exception:
                            pass
                    completed += 1
                    msg = json.dumps({"feature": feature, "completed": completed, "total": total})
                    yield f"event: station\ndata: {msg}\n\n"
                    if completed % 5 == 0 or completed == total:
                        log.info('[SSE] station emitted %d/%d', completed, total)
                except Exception:
                    completed += 1
                    yield f"event: station\ndata: {{\"error\": \"weather/stats error\", \"completed\": {completed}, \"total\": {total}}}\n\n"
            # After station loop: compute tour summary from day_aggr
            try:
                import numpy as _np, json as _json
                total_days_val = int(tour_days) if tour_days else (len(day_aggr) if day_aggr else 0)
                # Comfort thresholds
                T_COLD = float(temp_cold_param) if temp_cold_param is not None else 15.0
                T_HOT = float(temp_hot_param) if temp_hot_param is not None else 25.0
                R_MAX = float(rain_high_param) if rain_high_param is not None else 1.0
                W_HEAD = float(wind_head_comfort_param) if wind_head_comfort_param is not None else 4.0
                W_TAIL = float(wind_tail_comfort_param) if wind_tail_comfort_param is not None else 10.0
                rain_days = 0; headwind_days = 0; tailwind_days = 0; comfort_days = 0; extreme_hot = 0; extreme_cold = 0
                day_meds = []
                winds_means = []
                prec_sums = []
                for dkey, ag in sorted(day_aggr.items()):
                    t_med = float(_np.nanmedian(ag["temps"])) if ag["temps"] else float('nan')
                    w_mean = float(_np.nanmean(ag["winds"])) if ag["winds"] else float('nan')
                    p_sum = float(_np.nansum(ag["precs"])) if ag["precs"] else 0.0
                    e_mean = float(_np.nanmean(ag["effs"])) if ag["effs"] else float('nan')
                    day_meds.append(t_med)
                    winds_means.append(w_mean)
                    prec_sums.append(p_sum)
                    if p_sum >= 1.0: rain_days += 1
                    if _np.isfinite(e_mean):
                        if e_mean > 0.33: tailwind_days += 1
                        elif e_mean < -0.33: headwind_days += 1
                    # Comfort: temp within [T_COLD..T_HOT], rain below R_MAX, wind varies by effective wind
                    if (_np.isfinite(t_med) and T_COLD <= t_med <= T_HOT) and (p_sum < R_MAX):
                        # eff < -0.33 → headwind, eff > 0.33 → tailwind, else crosswind → treat as headwind
                        if _np.isfinite(e_mean):
                            if e_mean < -0.33:
                                if _np.isfinite(w_mean) and w_mean < W_HEAD:
                                    comfort_days += 1
                            elif e_mean > 0.33:
                                if _np.isfinite(w_mean) and w_mean < W_TAIL:
                                    comfort_days += 1
                            else:
                                if _np.isfinite(w_mean) and w_mean < W_HEAD:
                                    comfort_days += 1
                        else:
                            if _np.isfinite(w_mean) and w_mean < W_HEAD:
                                comfort_days += 1
                    if _np.isfinite(t_med) and t_med >= 30.0: extreme_hot += 1
                    if _np.isfinite(t_med) and t_med <= 5.0: extreme_cold += 1
                med_t = float(_np.nanmedian(day_meds)) if day_meds else None
                max_t = float(_np.nanmax(day_meds)) if day_meds else None
                min_t = float(_np.nanmin(day_meds)) if day_meds else None
                total_prec = float(_np.nansum(prec_sums)) if prec_sums else 0.0
                mean_wind = float(_np.nanmean(winds_means)) if winds_means else None
                tour_summary = {
                    "total_days": total_days_val,
                    "rain_days": int(rain_days),
                    "headwind_days": int(headwind_days),
                    "tailwind_days": int(tailwind_days),
                    "comfort_days": int(comfort_days),
                    "extreme_days_hot": int(extreme_hot),
                    "extreme_days_cold": int(extreme_cold),
                    "median_temperature": med_t,
                    "max_temperature": max_t,
                    "min_temperature": min_t,
                    "total_precipitation": total_prec,
                    "mean_wind_speed": mean_wind
                }
                try:
                    save_session_state({"tour_summary": tour_summary})
                except Exception:
                    pass
                yield f"event: tour_summary\ndata: {_json.dumps(tour_summary)}\n\n"
            except Exception as e:
                log.warning('[SSE] summary aggregation failed: %s', e)
        # Emit done with optional summary echo
        try:
            import json as _json
            done_payload = {"stations_count": completed}
            try:
                done_payload["tour_summary"] = SESSION_STATE.get('tour_summary')
            except Exception:
                pass
            try:
                done_payload['provenance'] = {
                    'counts': dict(provenance_counts),
                    'providers': sorted(list(provenance_providers)),
                    'years_used_start': years_used_min,
                    'years_used_end': years_used_max,
                }
                done_payload['station_source_text'] = _station_source_text()
            except Exception:
                pass
            yield f"event: done\ndata: {_json.dumps(done_payload)}\n\n"
        except Exception:
            yield f"event: done\ndata: {{\"stations_count\": {completed}}}\n\n"
        log.info('[SSE] done, stations=%d', completed)

    headers = {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    }
    return Response(event_stream(), headers=headers, mimetype='text/event-stream')


@app.route('/table')
def table_view():
    # Query params
    date = request.args.get('date')
    idx_param = request.args.get('index', '1')  # 1-based index per user wording
    step_km_param = request.args.get('step_km')
    max_points_param = request.args.get('max_points')
    grid_deg_param = request.args.get('grid_deg')
    fetch_mode = request.args.get('mode', 'single_day')

    if not date or len(date) != 5 or '-' not in date:
        return Response('<h3>Error: Provide date as MM-DD</h3>', mimetype='text/html')
    try:
        month, day = map(int, date.split('-'))
    except Exception:
        return Response('<h3>Error: Invalid date format</h3>', mimetype='text/html')
    try:
        idx1 = max(1, int(idx_param))
        idx0 = idx1 - 1
    except Exception:
        idx0 = 0

    def _quantize(v: float, g: float) -> float:
        return round(v / g) * g

    # Sample route with same parameters used in the map
    try:
        gpx_path = GPX_FILE
        step_km = float(step_km_param) if step_km_param else 60.0
        sampled_points, route_feature = sample_route(str(gpx_path), step_km=step_km)
        if max_points_param:
            try:
                max_points = int(max_points_param)
                if max_points > 0:
                    sampled_points = sampled_points[:max_points]
            except Exception:
                pass
        try:
            grid_deg = float(grid_deg_param) if grid_deg_param else 0.25
            if grid_deg <= 0:
                grid_deg = 0.25
        except Exception:
            grid_deg = 0.25
    except Exception as e:
        return Response(f'<h3>Route error: {e}</h3>', mimetype='text/html')

    if not sampled_points or idx0 >= len(sampled_points):
        return Response('<h3>Error: Waypoint index out of range</h3>', mimetype='text/html')

    lat, lon = sampled_points[idx0]
    qlat = _quantize(lat, grid_deg)
    qlon = _quantize(lon, grid_deg)

    # Offline strict mode: avoid any online requests.
    if _offline_strict_enabled() and _get_offline_store() is not None:
        stats_off = _get_offline_stats(lat, lon, month, day)
        if stats_off is None:
            return Response('<h3>Offline strict mode: no offline data for selected waypoint</h3>', mimetype='text/html'), 503
        stats = dict(stats_off)
        svg = generate_glyph_v2(stats, debug=False)
        html = (
            f"<html><head><title>Waypoint {idx1} Offline Stats</title>"
            f"<style>body{{font-family:system-ui, -apple-system, sans-serif;padding:12px}}.glyph{{width:64px;height:64px;vertical-align:middle;margin-left:10px}}</style>"
            f"</head><body>"
            f"<div><strong>Waypoint:</strong> {idx1} &nbsp; <strong>Lat/Lon:</strong> {lat:.5f}, {lon:.5f} &nbsp; <strong>Date:</strong> {month:02d}-{day:02d}</div>"
            f"<div><strong>Offline Tile:</strong> {stats.get('_tile_id','-')} &nbsp; <strong>Match days:</strong> {int(stats.get('_match_days',0) or 0)}</div>"
            f"<div><strong>Stats:</strong> Temp {float(stats.get('temperature_c',0) or 0):.2f} °C, Rain {float(stats.get('precipitation_mm',0) or 0):.2f} mm, Wind {float(stats.get('wind_speed_ms',0) or 0):.2f} m/s @ {float(stats.get('wind_dir_deg',0) or 0):.0f}° <span class='glyph'>{svg}</span></div>"
            f"<div><em>Detailed daily/hourly tables are not available in offline strict mode.</em></div>"
            f"</body></html>"
        )
        return Response(html, mimetype='text/html')

    # Fetch the daily data for this quantized cell
    if fetch_mode == 'single_day':
        df = fetch_daily_weather_same_day(qlat, qlon, month, day)
    else:
        df = fetch_daily_weather(qlat, qlon, month, day)
    if df is None or len(df) == 0:
        return Response('<h3>Weather unavailable for selected waypoint</h3>', mimetype='text/html')

    # Compute stats and glyph for consistency with the map
    stats, matching = compute_weather_statistics(df, month, day)
    svg = generate_glyph_v2(stats, debug=False)

    # Build HTML table (daily rows)
    def _fmt(x, digits=2):
        try:
            return f"{float(x):.{digits}f}"
        except Exception:
            return '-' 

    rows = []
    try:
        # Normalize columns names from fetchers
        times = df['date'] if 'date' in df.columns else df['time']
        for i in range(len(df)):
            dt = str(pd.to_datetime(times.iloc[i]).date())
            tavg = df['tavg'].iloc[i] if 'tavg' in df.columns else None
            prcp = df['prcp'].iloc[i] if 'prcp' in df.columns else None
            wspd = df['wspd'].iloc[i] if 'wspd' in df.columns else None
            wdir = df['wdir'].iloc[i] if 'wdir' in df.columns else None
            rows.append((dt, tavg, prcp, wspd, wdir))
    except Exception as e:
        rows.append((f'Error building rows: {e}', None, None, None, None))

    # Minimal HTML with inline styling for clarity
    html_rows = ''.join([
        f"<tr><td>{dt}</td><td>{_fmt(tavg)}</td><td>{_fmt(prcp)}</td><td>{_fmt(wspd)}</td><td>{_fmt(wdir,0)}</td></tr>"
        for (dt, tavg, prcp, wspd, wdir) in rows
    ])
    # Fetch hourly data for the same quantized cell and build per-day hourly table
    hourly_section = ''
    try:
        dfh = fetch_hourly_weather_same_day(qlat, qlon, month, day)
        # Prepare mapping from daily tavg by date string
        daily_tavg = {}
        try:
            dtmp = df.copy()
            dtmp['date_str'] = pd.to_datetime(dtmp['date']).dt.date.astype(str)
            for _, r in dtmp.iterrows():
                daily_tavg[str(pd.to_datetime(r['date']).date())] = r.get('tavg')
        except Exception:
            pass
        ts = pd.to_datetime(dfh['time'])
        dfh = pd.DataFrame({
            'date': ts.dt.date.astype(str),
            'hour': ts.dt.hour,
            'temp': pd.to_numeric(dfh['temperature_2m'], errors='coerce')
        })
        # Build wide table: Date | t_avg_24hrs | tavg_daily | h00 ... h23
        hours_cols = [f"h{h:02d}" for h in range(24)]
        rows_hourly = []
        for d, g in dfh.groupby('date'):
            row = {'Date': d}
            # Fill hour temps
            for h in range(24):
                v = g.loc[g['hour'] == h, 'temp']
                row[f"h{h:02d}"] = float(v.iloc[0]) if len(v) > 0 and pd.notna(v.iloc[0]) else None
            # Compute t_avg_24hrs
            valid = g['temp'].dropna()
            row['t_avg_24hrs'] = float(valid.mean()) if len(valid) > 0 else None
            # Daily mean from daily dataset, if available
            row['tavg_daily'] = float(daily_tavg.get(d)) if d in daily_tavg and pd.notna(daily_tavg.get(d)) else None
            rows_hourly.append(row)
        def _fmt_or_blank(x, digits=1):
            return (f"{float(x):.{digits}f}" if x is not None else '')
        # Header
        hdr = ''.join([f"<th>{c}</th>" for c in (['Date','t_avg_24hrs','tavg_daily'] + hours_cols)])
        body_rows = []
        for r in rows_hourly:
            cells = [
                f"<td>{r['Date']}</td>",
                f"<td>{_fmt_or_blank(r.get('t_avg_24hrs'),1)}</td>",
                f"<td>{_fmt_or_blank(r.get('tavg_daily'),1)}</td>"
            ] + [f"<td>{_fmt_or_blank(r.get(h),1)}</td>" for h in hours_cols]
            body_rows.append('<tr>' + ''.join(cells) + '</tr>')
        hourly_table = (
            f"<div class='hdr'><strong>Hourly Data:</strong> {len(rows_hourly)} matching days</div>"
            f"<div class='hrtable'><table><thead><tr>{hdr}</tr></thead><tbody>{''.join(body_rows)}</tbody></table></div>"
        )
        hourly_section = hourly_table
    except Exception as e:
        hourly_section = f"<div class='hdr'><em>Hourly data unavailable: {e}</em></div>"

    html = (
        f"<html><head><title>Waypoint {idx1} Weather Table</title>"
        f"<style>body{{font-family:system-ui, -apple-system, sans-serif;padding:12px}}table{{border-collapse:collapse}}td,th{{border:1px solid #ccc;padding:4px 6px}}.hdr{{margin-bottom:8px}}.glyph{{width:64px;height:64px;vertical-align:middle;margin-left:10px}}.hrtable{{overflow-x:auto;max-width:100%}}</style>"
        f"</head><body>"
        f"<div class='hdr'><strong>Waypoint:</strong> {idx1} &nbsp; <strong>Lat/Lon:</strong> {lat:.5f}, {lon:.5f} &nbsp; <strong>Quantized:</strong> {qlat:.5f}, {qlon:.5f} &nbsp; <strong>Date:</strong> {month:02d}-{day:02d} &nbsp; <strong>Mode:</strong> {fetch_mode} &nbsp; <strong>Grid:</strong> {grid_deg:.2f}</div>"
        f"<div class='hdr'><strong>Stats:</strong> Temp {stats.get('temperature_c',0):.2f} °C, Rain {stats.get('precipitation_mm',0):.2f} mm, Wind {stats.get('wind_speed_ms',0):.2f} m/s @ {stats.get('wind_dir_deg',0):.0f}° <span class='glyph'>{svg}</span></div>"
        f"<table><thead><tr><th>Date</th><th>tavg (°C)</th><th>prcp (mm)</th><th>wspd (m/s)</th><th>wdir (°)</th></tr></thead><tbody>{html_rows}</tbody></table>"
        f"{hourly_section}"
        f"</body></html>"
    )
    return Response(html, mimetype='text/html')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    # Attempt restoring session on startup
    restore_gpx_on_start()
    app.run(host='0.0.0.0', port=port, debug=True, use_reloader=False)
