# Offline Open‑Meteo tile store (design + build strategy)

Last updated: 2026-03-23

Goal: build a fully offline weather dataset for Europe (no offline OSM), using **Open‑Meteo archive** as the source, but store only **processed/derived statistics** per tile and calendar day.

Default region: Europe + nearby seas **including Iceland (Reykjavik)**.
The builder defaults are:
- `lat_min=34`, `lat_max=72`
- `lon_min=-28`, `lon_max=33`

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

### Backend (optional integration)

This repo includes an offline store reader at `project/backend/offline_weather_store.py`.

At the moment, the main Flask app does **not** automatically use the offline store; wiring it into the existing endpoints is a small, separate change.

When/if you wire it in, the intended environment variables are:
- `OFFLINE_WEATHER_DB`: SQLite path (default: `project/cache/offline_weather.sqlite`)
- `OFFLINE_STRICT=1`: disable any online API fallback

Note: tile IDs (and therefore DB contents) depend on the chosen bbox. If you built older DBs with a different bbox
(e.g. `lon_min=-11` without Iceland), keep them as separate files and build a new DB for the wider bbox.

### Builder

See `build_offline_tiles_openmeteo.py` for CLI flags.

If you want to spread load across the whole night but still finish the selected chunk by **07:00 local time (Berlin)**, use:

- Night 1 (first 10%): `--chunk-index 0 --chunk-count 10 --pace-until-berlin-7am`

This auto-adjusts the request pacing based on remaining time and expected request count.

## Region downloads (Africa) and the central request scheduler

Added 2026-11-28.

### Region on the existing grid

A region is a fixed tile list (`regions/<slug>.csv`, generated by `regions.py`) on
the **same** ~50 km grid as the yearly databases: origin 34 N / 28 W (the databases'
`bbox`), latitude step 50/111.32 deg, longitude step 50/(111.32 cos lat) deg. South of
34 N the rows continue with negative numbers (`r-1_c70` lies directly south of
`r0_c70`), so ids, centres and the map's row-wise interpolation work across the seam.

Africa (`regions/africa.csv`): 12,593 tiles south of 34 N, 11,884 land + 709 coastal
sea (builder rule `--ocean coastal`, 50 km), assigned to Africa by country (offline
GeoNames via `reverse_geocoder`): all African states and territories incl. Cape
Verde, São Tomé, Comoros, Madagascar, Mauritius, Réunion, Mayotte, Seychelles,
St Helena, plus the Canary Islands and Madeira. The 340 North African tiles north of
34 N are already part of every European yearly database. Not included: Socotra,
sub-antarctic islands.

### Download job

```
./.venv/bin/python project/offline/region_job.py --region africa --years 2023,2024,2025
./.venv/bin/python project/offline/region_job.py --status        # last status JSON
touch project/cache/offline_jobs/africa-2023-2025.stop            # graceful stop
```

Or in the Tile Manager (`python project/offline/manager_app.py`, port 5003), section
*Region Downloads*: start/resume, stop, per-year progress, rates, ETA, request
counts, cooldowns and the log. The job runs in its own session (`start_new_session`)
and keeps running when the manager or the browser is closed.

- Per tile one daily and one hourly request cover all three years; each year is then
  computed exactly like a single-year build (same rows, verified against a one-year
  build).
- Writes only complete tiles into `offline_weather_<year>.sqlite`: tile row, 366
  climatology rows, 1,464 riding-hour rows and `build_state='done'` in one
  transaction per batch (25 tiles / 5 min). European rows are never updated or
  deleted; each database keeps passing the app's reference-year audit.
- Before the first write each yearly database is copied to
  `project/cache/backups/offline_weather_<year>.before-africa.sqlite`.
- Meta additions only: `grid_origin` (`{"lat": 34, "lon": -28}`) and
  `coverage_bboxes` (Europe box + Africa box). `bbox` is unchanged; the backend uses
  `grid_origin` for row numbers and `coverage_bboxes` for "is this point covered".
- Progress, attempts and errors: `project/cache/offline_jobs/africa-2023-2025.sqlite`
  and `.status.json`; log: `project/debug_output/offline_region_africa-2023-2025.log`.
  On start the job reconciles with the yearly databases, so it never downloads a
  finished tile/year again, also after a crash.
- WAL auto-checkpoints are off for the job; it checkpoints every 6 h and on exit, so
  the app's derived caches (keyed on the database file) are not rebuilt every few
  minutes. New tiles are visible to the app's SQL lookups immediately; the Explore
  period arrays pick them up after the next checkpoint. A running Touracle server
  reads the new `grid_origin`/`coverage_bboxes` meta after a restart.

### Central request scheduler (`openmeteo_scheduler.py`)

Every request of every downloader process (region job and the classic builder) is
reserved in `project/cache/openmeteo_request_ledger.sqlite` first, with its Open-Meteo
call weight: locations x max(1, variables/10) x max(1, days/14) (one year of one
location = 26 calls, three years = 78). Default budget, global across processes and
rolling: 40% of the free limits (240 calls/min, 2,000/h, 4,000/day), plus request
spacing (20 requests/min). The remaining 60% stays available to Touracle's own live
Open-Meteo requests, which share the IP.

Measured 2026-11-28: at 20 three-year requests per minute (~1,560 calls/min) Open-Meteo
answered "Hourly API request limit exceeded" after ~230 requests; Touracle's live
tests on the same IP then received 429 until the next hour. The weighted counting is
therefore enforced, at least per hour. Consequence for the free tier: one African tile
(3 years) costs ~157 calls, i.e. ~25 tiles per day at the default budget, ~490 days
for all of Africa. An API key (`OPEN_METEO_API_KEY`, customer API) with a matching
`--calls-per-day` is the realistic way to finish within weeks.

HTTP 429 sets a global cooldown from `Retry-After` and the limit named in Open-Meteo's
reason (minutely: 60 s, hourly: to the next hour, daily: to the next UTC day),
escalating with jitter, and halves the rate until 30 quiet minutes have passed. 5xx and
network errors: jittered exponential backoff; after 8 attempts the job pauses 10
minutes and retries the same tile (no "error" state for temporary failures). Only real
client errors (400, 404, ...) mark a tile/year as error (in the job state, never in the
yearly database); `--retry-errors` retries them. Waits happen in 5 s slices, so a stop
request (stop file, SIGTERM, Tile Manager) takes effect within seconds; while waiting,
the job refreshes its status every minute.

### Measured performance (12 Kenyan tiles x 2023-2025, 2026-11-28)

| | before (per-year builder) | after, same pace | after, conservative default |
|---|---|---|---|
| requests | 72 | 24 | 24 |
| requests/min | 22.6 | 30.4 | 15.6 |
| tile-years/min | 11.3 | 45.7 | 23.3 |
| mean / median latency | 192 / 138 ms | 194 / 167 ms | 134 / 114 ms |
| retries / 429 | 0 / 0 | 0 / 0 | 0 / 0 |
| DB write per tile-year | 6.3 ms | 7.0 ms | 7.1 ms |

Hourly parsing (`pd.to_datetime` per value) took 3.2 s per tile-year; string slicing
gives identical results in ~0.03 s.
