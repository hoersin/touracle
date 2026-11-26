# Regression tests F-01 to F-04 and Explore (Phase 2)

Run from the repository root (needs `playwright` with Chromium, as already used by `tools/verify_*.py`):

    .venv/bin/python -m pytest project/tests/regression

All data are synthetic (`synthetic.py`). The real Flask app and the real frontend run; storage goes to a
temporary directory, and every external request is blocked. `vendor/` holds an unmodified Leaflet 1.9.4
(BSD-2-Clause) because the app otherwise loads it from a CDN.

| File | Invariant |
|---|---|
| `test_f01_rain_density.py` | Daily rain = mean over the day's route points, independent of sampling density |
| `test_f02_short_stage_points.py` | Inserted points keep true distance, day and date |
| `test_f03_schedule.py` | Displayed schedule, weather dates and simulation agree |
| `test_f04_plan_preservation.py` | Loading weather never changes user-authored structure |
| `test_explore_overlays.py` | Explore map: initial load, busy server, interpolation, one draw per change, honest progress, controls, period/overlay persistence, Wind field |
| `test_explore_year_audit.py` | Reference-year audit behind the climate profile: same results, warmed after start |

## Schedule contract (F-03)

`/api/map_stream` accepts two optional parameters; without them it behaves as before (equal stages, consecutive days):

* `boundaries_km`: comma-separated stage ends in km along the travelled direction, one per transition between
  ride stages. Unusable input (wrong count, not increasing, outside the route) means equal stages.
* `rest_days`: comma-separated zero-based calendar positions of rest days.

`total_days` still counts ride stages. `tour_day_index` is the stage number; rest-day stations carry indexes from
`tour_total_days` upwards. Rest-day weather (place: end of the previous stage) is reported in
`tour_summary.rest_day_summaries` and is not part of the ride-day totals.

## Explore tests

The real Strategic Grid admission lock runs (one computation at a time, HTTP 429 for a different concurrent
request); only the aggregation is replaced by `explore_synthetic.py`, whose column origin differs from the
reported bbox exactly as in the real yearly offline stores. Rendering is checked on the map canvas pixels.
`window.__WM_EXPLORE_DIAG__` (read-only: draw count, last draw time, `sampleAt(lat, lon)`) exists for these tests.

