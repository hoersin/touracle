
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

---
Touracle is a prototype—feedback and contributions are welcome!
