# Installation Guide (GitHub download / clone)

This guide assumes you run Touracle locally.

## Prerequisites
- Python **3.11+** (3.12+ recommended)
- `git` (if cloning)
- (Optional, but recommended) **Git LFS** — this repo can store offline SQLite databases via LFS

## Option A — Clone via Git (recommended)
```bash
git clone <YOUR_REPO_URL>
cd WeatherMap
```

If the repository uses Git LFS (offline DBs / Windows bundles):
```bash
git lfs install
git lfs pull
```

## Option B — Download ZIP from GitHub
1. GitHub → Code → Download ZIP
2. Unzip locally
3. Open the folder in VS Code (or your editor)

If the ZIP download does not include LFS objects, you may need to either:
- clone with Git + LFS instead, or
- build offline DBs yourself (see “Offline tiles” below).

## Create a virtual environment
macOS / Linux:
```bash
python -m venv .venv
source .venv/bin/activate
```

Windows (PowerShell):
```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
```

## Install dependencies
```bash
pip install -r project/requirements.txt
```

## Run the server
Touracle is a Flask app served by `project/backend/app.py`.

macOS / Linux:
```bash
PORT=5002 python project/backend/app.py
```

Windows (PowerShell):
```powershell
$env:PORT=5002; python project/backend/app.py
```

Then open:
- http://127.0.0.1:5002/

## Environment variables (optional)
- `PORT`: set server port (default depends on environment)
- `GPX_PATH`: default GPX route path (if not set, uses `project/data/milano_to_rome_demo.gpx`)
- `OFFLINE_WEATHER_DB`: explicit path to an offline sqlite tile store
- `OFFLINE_STRICT`: if set to `1/true`, the backend will avoid online fallback when offline mode is requested/available

Examples:
```bash
export OFFLINE_WEATHER_DB=project/cache/offline_weather_2025.sqlite
export OFFLINE_STRICT=1
PORT=5002 python project/backend/app.py
```

## Offline tiles (optional, but important for Climate mode)
The offline store builder is:
- `project/offline/build_offline_tiles_openmeteo.py`

It builds a SQLite DB (schema in `project/offline/offline_store_schema.sql`) for a tile grid over a bounding box.

Example (Europe-ish bbox, 50km tiles):
```bash
python -u project/offline/build_offline_tiles_openmeteo.py \
  --db project/cache/offline_weather_2025.sqlite \
  --start-year 2025 --end-year 2025 \
  --tile-km 50 \
  --lat-min 34 --lat-max 72 \
  --lon-min -11 --lon-max 33 \
  --min-interval-s 2.0 \
  --chunk-count 1 --chunk-index 0
```

Notes:
- The provider can rate limit (`HTTP 429`). If that happens, retry with a higher `--min-interval-s`.
- Builds are restart-safe: tiles are committed individually to `build_state` so you can rerun the command to continue.

## VS Code tasks (repo convenience)
If you open this repository in VS Code, you may have tasks such as:
- Start server (port 5002)
- Stop server

(Tasks are not required; they just wrap the commands above.)

