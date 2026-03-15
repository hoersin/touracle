# Offline Tile Store (SQLite) — Database Documentation

The offline tile store is a SQLite database built from the Open‑Meteo Archive API. It stores **derived** statistics needed by the app (not raw provider responses).

## Files
- Schema: `project/offline/offline_store_schema.sql`
- Builder: `project/offline/build_offline_tiles_openmeteo.py`
- Reader: `project/backend/offline_weather_store.py`
- Typical DB location(s): `project/cache/offline_weather_YYYY.sqlite`

## Purpose
The tile store is optimized for:
- fast queries for “climate/strategic” map rendering
- reproducibility (offline, provider-independent at runtime)
- transparency via sample counts

## Tables
### `meta`
Key/value metadata describing how the DB was built.

Important keys include:
- `provider` (expected: `open-meteo`)
- `provider_only` (expected: `true`)
- `bbox` (JSON: `{lat_min, lat_max, lon_min, lon_max}`)
- `tile_km` (tile size)
- `years` (JSON: `{start, end}`)
- `chunk_years` (builder chunk size)
- `min_interval_s_effective` (effective request pacing)
- attribution and provider URLs

### `tiles`
Defines the tile grid.
- `tile_id` is a string like `r12_c34`
- `lat/lon` are tile center coordinates
- `row/col` are grid indices

### `climatology`
Stores derived statistics per (tile, month, day).
Key columns include:
- temperature: `temperature_c`, `temp_p25`, `temp_p75`, `temp_std`
- rain: `precipitation_mm`, `rain_probability`, `rain_typical_mm`, plus `rain_hist_p25_mm/p75_mm/p90_mm`
- wind: `wind_speed_ms`, `wind_dir_deg`, `wind_var_deg`
- riding/daytime temperature distribution: `temp_hist_p25`, `temp_hist_p75`, `temp_day_p25`, `temp_day_p75`, `temp_day_median`

Note:
- The live Tour SSE path now also derives explicit tooltip-oriented fields from hourly data: `temp_hist_median`, `temp_hist_min`, `temp_hist_max`, `temp_day_typical_min`, `temp_day_typical_max`.
- These live fields are computed in backend memory/cache for Tour rendering and are not part of the persisted offline SQLite schema above.
- sample counters: `samples_*`

### `riding_hourly` (optional)
Stores temperature distributions for selected hours (e.g., 10/12/14/16 local time).
- `(tile_id, month, day, hour)` primary key
- `temp_median/temp_p25/temp_p75`, `samples`

### `build_state`
Tracks tile processing state so builds are restart-safe.
- `status` is one of: `building`, `done`, `error`
- `updated_at` is an ISO UTC timestamp
- `error` stores the last failure message (frequently `HTTP 429 rate-limited`)

## Common queries
### Progress by status
```sql
SELECT status, COUNT(*)
FROM build_state
GROUP BY status
ORDER BY status;
```

### Find most common errors
```sql
SELECT error, COUNT(*) AS n
FROM build_state
WHERE status='error'
GROUP BY error
ORDER BY n DESC;
```

### Inspect one tile/day
```sql
SELECT *
FROM climatology
WHERE tile_id='r0_c0' AND month=1 AND day=1;
```

## Data quality notes
- A DB can be “complete” (all tiles `done`) but still have missing values in some columns if the provider did not return data for a location/time span.
- Rain hist percentiles include zero-precip days; they describe the distribution for that calendar day across the DB year span.

