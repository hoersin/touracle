
# Touracle: Bikepacking Weather Planning Map

Touracle is an interactive tool for planning long-distance bikepacking or cycling tours with weather awareness. Upload a GPX route and instantly visualize historical and forecasted weather conditions—temperature, rain probability, and wind—at sampled points along your journey. The app helps you pick the best dates, prepare for weather risks, and share route insights with others.

## Features

- Upload or use the included Milano-to-Rome demo GPX route
- Visualize route on an interactive map (Leaflet-based UI)
- See weather glyphs (temperature, rain, wind) at sampled points along the route
- Select any day-of-year to view typical and historical weather (uses Open-Meteo/Meteostat)
- Download and share weather summaries
- Works locally—no private data leaves your machine

## Quick Start

## Quick Start

Mac/Linux

1. Create and activate Python 3.11+ environment
	```bash
	python -m venv .venv
	source .venv/bin/activate
	```
2. Install dependencies
	```bash
	pip install -r project/requirements.txt
	```
3. Run the server on port 5002
	```bash
	PORT=5002 python project/backend/app.py
	```
4. Open http://localhost:5002 in your browser

Windows (PowerShell)

1. Create and activate Python 3.11+ environment
	```powershell
	py -3 -m venv .venv
	.\.venv\Scripts\Activate.ps1
	```
2. Install dependencies
	```powershell
	pip install -r project/requirements.txt
	```
3. Run the server on port 5002
	```powershell
	$env:PORT=5002; python project/backend/app.py
	```
4. Open http://localhost:5002 in your browser

## Windows executable (.exe)

This repo includes a GitHub Actions workflow that builds a Windows executable using PyInstaller.

- Trigger it manually: GitHub → **Actions** → **Build Windows EXE** → **Run workflow**
- Or tag a release (e.g. `v1.0.0`) to build on tag push

The build output is published as an Actions artifact named **Touracle-windows** (download it from the workflow run). The executable is `Touracle.exe` inside the `releases/windows/Touracle/` folder.

If you want to commit the built Windows bundle into the repository, place it under `releases/windows/Touracle/`.

### Git LFS (offline SQL + Windows binaries)

This repo is configured to store offline weather databases (`project/cache/offline_weather*.sqlite`) in **Git LFS**.

On your machine (once):

```bash
git lfs install
```

Then you can commit the offline DB (example):

```bash
git add project/cache/offline_weather_2025.sqlite
git commit -m "Add offline weather DB (LFS)"
git push
```

Windows build outputs under `releases/windows/` are also tracked via Git LFS.

Note: committing `.exe` binaries directly into the git repo is usually discouraged (large diffs, repo bloat). A common alternative is attaching the artifact to a GitHub Release.


## Project Structure

- `project/backend/`: Flask API, route sampling, weather, glyph generation
- `project/frontend/`: Leaflet UI (map, upload, weather display)
- `project/data/`: Demo GPX route (milano_to_rome_demo.gpx)


## Notes

- Uses Open-Meteo/Meteostat; requires internet for live data. Falls back to historical data where possible.
- Date selector uses month-day; year is for historical span.
- Example GPX: see `project/data/milano_to_rome_demo.gpx`. Upload your own via the UI or replace the demo file.


## Demo & Sharing

- On the same Wi‑Fi: Share http://YOUR_IP:5002 so others can access your running app.
- For remote demos: Use Cloudflare Tunnel or Ngrok to expose http://localhost:5002 with an HTTPS URL.
- For private demos: Screen share your browser window.

## Contributing & Testing

Anyone can clone and test the app. For private repositories, invite collaborators via GitHub. For public repos, simply share the link.

Optional dev/debug dependencies (not required to run the app):

```bash
pip install -r project/requirements-dev.txt
```

---
Touracle is a prototype—feedback and contributions are welcome!
