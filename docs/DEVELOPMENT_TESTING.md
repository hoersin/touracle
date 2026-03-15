# Development & Testing

## Running locally
See `docs/INSTALLATION_GUIDE.md`.

## Project layout
- `project/backend/`: Flask backend + weather/statistics logic
- `project/frontend/`: static frontend (Leaflet + canvas rendering)
- `project/offline/`: offline tile store builder + schema
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

## Offline builder workflows
### Resume a partially built DB
Rerun the same builder command; tiles are committed individually.

### Retry “error” tiles caused by rate limiting
Run again with slower pacing:
```bash
python -u project/offline/build_offline_tiles_openmeteo.py \
  --db project/cache/offline_weather_2023.sqlite \
  --start-year 2023 --end-year 2023 \
  --tile-km 50 --lat-min 34 --lat-max 72 --lon-min -11 --lon-max 33 \
  --min-interval-s 4.0
```

## Operational tips
- Large sqlite files are commonly tracked with Git LFS.
- If you change frontend JS/CSS and your browser caches aggressively, hard-refresh or bump a cache-buster query parameter in `index.html`.

