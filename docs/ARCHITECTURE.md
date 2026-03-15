# Architecture

## High-level components
Touracle is a classic single-repo “static frontend + Flask backend” app.

### Frontend (browser)
Location: `project/frontend/`
- `index.html`: application shell, layout, CSS
- `map.js`: Leaflet map logic, UI state, and route/profile rendering

Core frontend responsibilities:
- render base maps (Leaflet)
- render route geometry
- render weather overlays/glyphs on the map
- render the route profile strip and handle hover/tooltip
- manage user preferences in local storage
- fetch data from backend endpoints (including SSE streaming)

### Backend (Flask)
Location: `project/backend/`
Entry point: `project/backend/app.py`

Core backend responsibilities:
- serve static frontend assets
- accept GPX uploads and persist session state
- sample routes into evenly spaced points
- fetch weather data from providers or offline stores
- compute derived, app-facing statistics
- stream incremental results to the frontend (SSE)

### Offline tile store
Builder: `project/offline/build_offline_tiles_openmeteo.py`
Reader: `project/backend/offline_weather_store.py`

This provides a precomputed, restart-safe SQLite dataset so the Climatic Map can query climatology for many map points quickly without doing live API calls.

## Key data flows
### Tour planning (route-based)
1. Frontend uploads/chooses GPX route
2. Backend samples the route at a configured step (km)
3. Backend fetches weather (online APIs and/or cached results)
4. Backend computes statistics per sampled point and day
5. Backend returns results to frontend (in some cases via SSE)
6. Frontend renders map + profile, and keeps hover semantics consistent

### Climatic map (tile grid)
1. Frontend chooses layer + year + calendar day
2. Frontend requests `GET /api/strategic_grid?date=MM-DD&year=YYYY&lat_min=...&lat_max=...&lon_min=...&lon_max=...`
3. Backend loads the offline DB for the selected year (if present)
4. Backend returns tile centers + climatology stats for the viewport
5. Frontend interpolates/visualizes the layer in the map view

## Caching and persistence
- Uploaded GPX files: `project/data/uploaded_*.gpx`
- Session state: `project/data/session_state.json`
- Debug artifacts: `project/debug_output/`
- Stats caches (online requests / derived stats): `project/cache/stats/` (backend-managed)
- Offline tile DBs: `project/cache/offline_weather_*.sqlite`

## Operational considerations
- Offline builder is single-threaded by design and can be rate-limited (HTTP 429). It is restart-safe using `build_state`.
- The repo supports Git LFS for large SQLite artifacts.

