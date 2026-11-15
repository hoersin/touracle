# Architecture

## High-level components
Touracle is a classic single-repo “static frontend + Flask backend” app.

### Frontend (browser)
Location: `project/frontend/`
- `index.html`: application shell, layout, CSS; exposes all sidebar controls
- `map.js`: Leaflet map logic, UI state, route/profile rendering, all tour workflows (v151+)
- `profile.js` / `profile_hover_utils.js` / `profile_zoom.js`: elevation profile canvas and interactions
- `sidebar.js`: sidebar collapse/resize, preference bindings
- `temperature_scale.js`: colour-scale definitions

Core frontend responsibilities:
- render base maps (Leaflet; switches to Carto Light in Climatic Map mode)
- render route geometry and weather overlays/glyphs
- render **Tour day cards** on the map (one per day, perpendicular to route, re-rendered on `zoomend`) and on the profile strip
- render the editable **roadbook panel** (ride days, rest days, insert zones, stage-boundary drag handles)
- render coastline/land masks for the Climatic Map (Natural Earth GeoJSON; zoom-dependent resolution)
- manage the **Tour Project** lifecycle: `createTourPlan`, `serializeTourPlan`, `deserializeTourPlan`, open/save `.tour` files, `TourPlanStorageService` (localStorage), autosave
- orchestrate the **Simulation Run** wizard: collect payload, POST to `/api/tour_slot_optimizer/start`, poll result, render penalty-curve SVGs, apply selected slot
- manage `TOUR_PLAN` (central roadbook + settings object) and `WEATHER_CONTEXT` (mode, year, forecast date)
- manage user preferences in local storage (`touracle_settings`)
- fetch data from backend endpoints (including SSE streaming)

### Backend (Flask)
Location: `project/backend/`
Entry point: `project/backend/app.py`

Core backend responsibilities:
- serve static frontend assets
- serve cached coastline GeoJSON endpoints used by the frontend for land/shore rendering
- accept GPX uploads (`/api/upload_gpx`), serve embedded GPX content (`/api/gpx_content`, `/api/upload_gpx_text`) for `.tour` file round-trips
- persist session state
- sample routes into evenly spaced points; **guarantee at least one representative point per tour day** even when the sampling step exceeds the day-segment length
- fetch weather data from providers or offline stores
- compute derived, app-facing statistics; `_append_day_aggr` aggregates per-day stats across all emission branches
- run the **Tour Slot Optimizer** (`tour_slot_optimizer.py`): sweep week-aligned start candidates, score with composite weather penalty, return ranked results
- stream incremental results to the frontend (SSE)

Key backend modules:

| File | Purpose |
|---|---|
| `app.py` | Flask routes, session management, GPX upload/serve, all API endpoints |
| `route_sampling.py` | Sample GPX at regular km intervals; haversine distances |
| `weather_openmeteo.py` | Open-Meteo API; caching, circuit breaker, 429 backoff |
| `weather_meteostat.py` | Meteostat fallback provider |
| `weather_service.py` | Thread-safe provider wrapper |
| `weather.py` | Per-point statistics (percentiles, daily aggregates) |
| `climate_aggregation.py` | Multi-year climatology aggregation |
| `offline_weather_store.py` | SQLite tile DB reader; spatial lat/lon → tile lookup |
| `tour_slot_optimizer.py` | Candidate sweep, scoring model, ranked result serialiser |
| `stations.py` | Weather station index; reverse-geocoding fallback |
| `glyph.py` / `glyph_geometry.py` / `glyph_wind.py` | SVG glyph generation |

### Offline tile store
Builder: `project/offline/build_offline_tiles_openmeteo.py`
Reader: `project/backend/offline_weather_store.py`

This provides a precomputed, restart-safe SQLite dataset so the Climatic Map can query climatology for many map points quickly without doing live API calls.

## Key data flows

### Tour planning (route-based)
1. Frontend uploads/chooses GPX route
2. Backend samples the route at a configured step (km); missing day buckets are filled with representative midpoint coordinates
3. Backend fetches weather (online APIs and/or cached results)
4. Backend computes statistics per sampled point and day; aggregates per-day summary via `_append_day_aggr`
5. Backend returns results to frontend via SSE (`/api/map_stream`)
6. Frontend renders map + profile; day cards placed at each day's midpoint perpendicular to the route, re-rendered on zoom

### Simulation Run (Tour Slot Optimizer)
1. Frontend collects TourBook shape (ride/rest day sequence, boundaries, direction mode, horizon years)
2. `POST /api/tour_slot_optimizer/start` → returns `job_id`
3. Backend (`tour_slot_optimizer.py`) sweeps ~52 week-aligned start dates; scores each using historical weather from offline tiles or API; evaluates configured direction modes
4. Frontend polls `GET /api/tour_slot_optimizer/result/<job_id>` until done
5. Results returned as ranked candidate list with penalty curves; frontend renders SVG curves and "Apply Selected Slot" action
6. Applying a slot updates `WEATHER_CONTEXT.forecastStartDate` and direction flag, then re-runs the weather map stream

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
- TourPlans (multiple named plans): browser `localStorage['touracle_tour_plans_*']`
- Tour Project files (`.tour`): user filesystem; embedded GPX + all TourPlans + active plan ID
- Weather context (`WEATHER_CONTEXT`) and preferences (`touracle_settings`): browser localStorage

## Tech stack summary

| Layer | Stack |
|---|---|
| Backend | Python 3.11+, Flask, pandas, gpxpy, numpy, sqlite3 |
| Frontend | Vanilla JS + Leaflet 1.9.4, Canvas 2D (profile / glyphs) |
| Export | xlsx-js-style 1.2.0 (Excel), jsPDF + jsPDF-autoTable (PDF) |
| Testing | pytest; 40+ snapshot + SSE + integration tests |
| Packaging | PyInstaller Windows EXE via GitHub Actions |

## Operational considerations
- Offline builder is single-threaded by design and can be rate-limited (HTTP 429). It is restart-safe using `build_state`.
- The repo supports Git LFS for large SQLite artifacts.

