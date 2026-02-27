# Offline Open‑Meteo tile store (design + build strategy)

Last updated: 2026-02-23

Goal: build a fully offline weather dataset for Europe (no offline OSM), using **Open‑Meteo archive** as the source, but store only **processed/derived statistics** per tile and calendar day.

This builder is **Open‑Meteo only** by design (no Meteostat fallback/mixing).

This is designed to be:
- restart-safe (tile-by-tile commits)
- split across multiple nights
- reasonably within Open‑Meteo free API limits (non-commercial) if configured conservatively

## Dataset shape

- Grid: ~50×50 km tiles (approximate on Earth surface)
  - Implemented as latitude bands (fixed lat step), with longitude step adjusted by cos(latitude) so tiles are roughly square in km.
- Stored values: final stats used by the app (daily stats + daytime overrides).
- Indexing: `(tile_id, month, day)`
  - This avoids leap-year mixing issues (Feb 29 vs Mar 1) that happen with day-of-year keys.

### Coastal sea tiles (≤ 50 km from shore)

The builder can include near-shore sea regions so routes close to the coast still get valid glyphs.

- Default behavior: keep **land + coastal sea** (`--ocean coastal --coastal-sea-km 50`)
- Options:
  - `--ocean all`: keep all tiles (including open ocean)
  - `--ocean none`: land only

Implementation note: precise coastal filtering uses an optional land-mask dependency (`global_land_mask`).
If it is not installed, the builder will warn and fall back to `--ocean all`.

## SQLite schema

Created by the builder script in `offline_weather.sqlite`:

- `meta(key TEXT PRIMARY KEY, value TEXT)`
  - Provider, URLs, build timestamps, bbox, years range, tile size, attribution, etc.
- `tiles(tile_id TEXT PRIMARY KEY, lat REAL, lon REAL, row INT, col INT)`
- `climatology(tile_id TEXT, month INT, day INT, ... stats ..., PRIMARY KEY(tile_id, month, day))`
  - Stores the app-facing keys like `temperature_c`, `temp_p25`, `temp_p75`, `temp_std`, `rain_probability`, `rain_typical_mm`, `wind_speed_ms`, `wind_dir_deg`, `wind_var_deg`, `temp_day_median`, `temp_day_p25`, `temp_day_p75`, `temp_hist_p25`, `temp_hist_p75`.
  - Also stores `samples_*` counts for transparency.
- `build_state(tile_id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, error TEXT)`

Optional (for route glyphs / riding-hours features):

- `riding_hourly(tile_id TEXT, month INT, day INT, hour INT, temp_median, temp_p25, temp_p75, samples, PRIMARY KEY(tile_id, month, day, hour))`
  - Stores temperature distributions at hours **10/12/14/16** local time.
  - This is compatible with later UX changes where glyphs consider a specific riding time instead of the aggregated daytime distribution.

## Download strategy (Open‑Meteo)

For each tile center point:
- Download **daily** archive data in multi-year chunks (default 2 years per request)
  - daily: temperature_2m_mean, precipitation_sum, windspeed_10m_mean, winddirection_10m_dominant
- Download **hourly** archive data in multi-year chunks (default 2 years per request)
  - hourly: temperature_2m

Then compute per day-of-year statistics across the full year-window.

### Why 2-year chunks?

- Keeps request count low enough for the free tier.
- Keeps response sizes moderate vs single huge 10-year hourly response.

## Splitting across 10 nights

The builder supports `--chunk-index` and `--chunk-count`.

Example (10 nights):

- Night 1: `--chunk-index 0 --chunk-count 10`
- Night 2: `--chunk-index 1 --chunk-count 10`
- ...
- Night 10: `--chunk-index 9 --chunk-count 10`

Each run processes only its subset of tiles and can be safely re-run.

## Realism check (23:00–07:00)

With an EU-ish bbox and ~50 km tiles, tile count is typically ~5k.

If you use:
- 10 historical years
- 2-year chunks
- daily + hourly

Then requests per tile ≈ `2 kinds * (10 years / 2 years-per-chunk) = 10 requests/tile`.

Total requests ≈ `5000 tiles * 10 = 50,000`.

- Over 10 nights: ~5,000 requests/night.
- Time at 1 request/sec: ~5,000 seconds ≈ 1.4 hours/night.

Even with retries/backoff and slower pacing (e.g. 1.2–1.5 sec/request), 10 nights at 8 hours/night is realistic.

## Usage

### Backend (offline-first)

The Flask backend prefers offline tiles automatically when an offline DB is configured.

- Set `OFFLINE_WEATHER_DB` to the SQLite path (default: `project/cache/offline_weather.sqlite`).
- Optional: set `OFFLINE_STRICT=1` to disable any online API fallback.

### Builder

See `build_offline_tiles_openmeteo.py` for CLI flags.

If you want to spread load across the whole night but still finish the selected chunk by **07:00 local time (Berlin)**, use:

- Night 1 (first 10%): `--chunk-index 0 --chunk-count 10 --pace-until-berlin-7am`

This auto-adjusts the request pacing based on remaining time and expected request count.
