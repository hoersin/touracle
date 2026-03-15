# Touracle / WeatherMap — App Description

## Purpose
Touracle (a.k.a. “WeatherMap” in this repository) is a local-first web application for planning cycling and bikepacking routes with weather awareness.

It combines:
- A **Tour Planning** view: you upload a GPX route and the app samples points along the route, then visualizes weather statistics along the route and across days.
- A **Climatic Map** view: you explore climatology (temperature / rain / wind / comfort) as a map layer for a chosen calendar day.

The core design intent is to make route/date decisions easier by showing *spatially-resolved* weather signals (not just a single city forecast) and by keeping map + profile visuals consistent.

## What the app shows
The app focuses on weather that strongly affects cycling:
- **Temperature** (typical/median and historical spread)
- **Rain** (probability, typical amount, and historical percentiles)
- **Wind** (speed and direction; in Tour mode also “effective wind” vs route heading)

The UI uses weather symbols/overlays on the map and a route profile strip to present the same underlying statistics from two angles.

## Data sources and modes
### Online mode
When running online, the backend fetches data from provider APIs (e.g. Open‑Meteo archive API; Meteostat is also in dependencies).

### Offline mode (tile store)
For fast and reproducible results, the app can optionally read from a prebuilt offline SQLite tile store (one DB per year is common in this repo, e.g. `project/cache/offline_weather_2025.sqlite`).

Offline mode is used primarily by the Climatic Map (“strategic”) view, and can also be used to reduce network calls.

## Privacy and locality
- The app is intended to run on your own machine.
- GPX uploads and cached data are stored locally inside the repository’s `project/` subtree.

## Non-goals (current scope)
This repository is a prototype-style app. It does **not** currently aim to provide:
- user accounts / authentication
- a hosted SaaS deployment
- a long-term data retention policy beyond local files
- perfect meteorological correctness in all edge cases

## Repository naming
- The top-level folder name may be `WeatherMap`.
- The app name in the README and UI is “Touracle / Bikepacking Weather Map”.

