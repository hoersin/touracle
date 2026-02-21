# Bikepacking Weather Planning Map (Prototype)

Minimal prototype showing a GPX route and weather glyphs along sampled points for a selected day-of-year.

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
4. Open http://localhost:5002

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
4. Open http://localhost:5002

## Structure

- project/backend: Flask API, route sampling, weather, glyph generation
- project/frontend: Leaflet UI
- project/data: Example GPX route

## Notes

- Uses Open-Meteo/Meteostat; requires internet for live data. Falls back where possible.
- Date selector uses month-day; year is for historical span.
- Example GPX: see `project/data/example_route.gpx`. Upload via the UI or replace with your own.

## Demo & Sharing

- Same Wi‑Fi: Share http://YOUR_IP:5002 to colleagues on the same network.
- Quick tunnel: Cloudflare Tunnel or Ngrok can expose http://localhost:5002 with an HTTPS URL.
- No network exposure: screen share a local demo.
