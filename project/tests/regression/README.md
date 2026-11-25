# Regression tests F-01 to F-04

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

## Documented contract gap (F-03)

`/api/map_stream` accepts `start_date` and `total_days` only. It splits the route into equal stages on
consecutive days, so it cannot represent rest days or user-defined stage boundaries. The tests that need this
are strict `xfail`s. No new contract is introduced here.
