# Development & Testing

## Running locally
See `docs/INSTALLATION_GUIDE.md`.

## Project layout
- `project/backend/`: Flask backend + weather/statistics logic + Tour Slot Optimizer
- `project/frontend/`: static frontend (Leaflet + canvas rendering; `map.js`, `profile.js`, `sidebar.js`, …)
- `project/offline/`: offline tile store builder + manager web UI + schema
- `project/tests/`: automated tests (pytest-style)
- `project/debug_output/`: logs and debug artifacts

## Running tests
This repository contains tests under `project/tests/`.

### Install a test runner
The repo does not pin a dev test runner by default. If you want to run tests:
```bash
pip install pytest
```

### Run the tests
From repo root:
```bash
pytest -q
```

Notes:
- Some tests may access external services depending on your configuration and network.

## Debug scripts
- `project/debug_pipeline.py` and `project/tests_pipeline.py` are standalone scripts for manual inspection and debugging.

## Test suite highlights
The `project/tests/` directory contains 40+ test files. Key groups:

| Group | Key files |
|---|---|
| Weather consistency | `test_tour_weather_consistency.py`, `test_years_span_stream.py` |
| Tour architecture | `test_sprint53_tour_project_architecture.py`, `test_frontend_p3a_architecture_refactor.py`, `test_frontend_p3b_persistence_foundation.py` |
| Tour Plan management | `test_frontend_p3_5_tour_plan_management.py` |
| Import / export | `test_tour_import_defaults_frontend.py`, `test_sprint55_professional_tourbook_export.py` |
| Simulation Run | `test_tour_slot_optimizer.py`, `test_tour_slot_optimizer_api.py`, `test_tour_slot_optimizer_frontend_hooks.py` |
| Roadbook / rest days | `test_frontend_p2_5_rest_days.py`, `test_day_assignment.py` |
| Profile + distance | `test_profile_distance_scale.py`, `test_profile_distance_reverse.py` |
| Offline / concurrency | `test_realistic_route_offline_concurrency.py`, `test_weather_service_stress.py` |
| Tile layout | `test_sprint54_unified_weather_tile_layout.py` |

## Offline builder workflows
### Resume a partially built DB
Rerun the same builder command; tiles are committed individually.

### Retry “error” tiles caused by rate limiting
Run again with slower pacing:
```bash
python -u project/offline/build_offline_tiles_openmeteo.py \
  --db project/cache/offline_weather_2023.sqlite \
  --start-year 2023 --end-year 2023 \
  --tile-km 50 --lat-min 34 --lat-max 72 \
  --lon-min -28 --lon-max 33 \
  --min-interval-s 4.0
```

Note: `--lon-min -28` is the current default and covers Iceland. Older builds used `--lon-min -11`.

### Nightly launchd runner (macOS)
`tools/macos/run_offline_tiles_nightly.sh` selects the most incomplete DB in `project/cache/`, rotates the `--chunk-index` by day-of-year, and uses `--pace-until-berlin-7am` to auto-pace the build so it finishes by 07:00 Europe/Berlin. See `tools/macos/OFFLINE_TILES_LAUNCHD.md` for setup.

## Operational tips
- Large sqlite files are commonly tracked with Git LFS.
- If you change frontend JS/CSS and your browser caches aggressively, hard-refresh or **bump the cache-buster** query parameter in `project/frontend/index.html`:
  ```js
  const mapSrc = '/map.js?v=NNN'; // increment NNN
  ```
  The current version counter is in the `bootMap()` function near the bottom of `index.html`.
- The backend guarantees at least one representative sampled point per tour day even when `--step-km` exceeds the day-segment length. If you see a day with no station, look for `[PLAN] Missing-day sample augmentation failed` in the server log.

