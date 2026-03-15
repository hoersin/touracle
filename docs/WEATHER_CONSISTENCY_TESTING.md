# Weather Consistency Testing

This document describes how to verify that **Tour weather** stays consistent with the selected:
- start date
- calendar day
- historical year span (`hist_start` + `hist_years`)

## Scope
We currently care about three user-visible Tour weather outputs:
1. **Tour route weather points / glyph properties** returned by `/api/map_stream`
2. **Tooltip values** (fed from the same station properties in the frontend)
3. **Profile overlay values** (temperature/rain/wind bands and lines)

## Source-of-truth model
The Tour frontend ultimately renders from station properties emitted by the backend SSE stream.
That means the most stable test boundary is:
- call `/api/map_stream`
- parse the first `station` event
- assert that the emitted median/percentile fields match the requested date/span

This avoids brittle browser-UI screenshot assertions and tests the actual weather contract.

## Current regression tests
### 1) Hourly cache must be span-scoped
File: `project/tests/test_tour_weather_consistency.py`

Why it exists:
- `temp_day_p25/temp_day_p75` come from hourly data.
- If the raw hourly cache ignores the requested year span, the profile tolerance can stay stale even when the user changes preferences.

Additional interpretation:
- `temp_hist_median/temp_hist_min/temp_hist_max` describe the historical daytime mean across years.
- `temp_day_typical_min/temp_day_typical_max` describe the typical min/max inside the selected riding hours.
- Legacy `temp_day_p25/temp_day_p75` are still kept for the existing profile overlay visuals.

### 2) `/api/map_stream` must change with requested year span
The stream test asserts that widening the year span changes:
- `_years_start/_years_end`
- `temperature_c`
- `rain_typical_mm`
- `temp_day_p25/temp_day_p75` spread
- and that explicit historical/daytime tooltip fields are present

### 3) `/api/map_stream` must change with requested date
The stream test also asserts that changing the selected date changes emitted weather stats.

## Run the regression tests
From repo root:
```bash
.venv/bin/python -m pytest project/tests/test_tour_weather_consistency.py -q
.venv/bin/python -m pytest project/tests/test_years_span_stream.py -q
.venv/bin/python -m pytest project/tests/test_profile_distance_scale.py -q
```

## Important interpretation note
The **map Tour temperature band** is currently rendered with a fixed visual width for UX reasons.
So:
- it is **not** a reliable visual indicator of wider vs narrower uncertainty
- the **profile overlay** is the correct place to verify percentile/tolerance spread visually
- tooltips should always show the numeric spread explicitly, with separate labels for historical range vs typical daytime variation

## Recommended next step
If the product decision is that the **map Tour band itself** should reflect uncertainty width, then the frontend rendering in `project/frontend/map.js` should be changed so band thickness is derived from percentile spread rather than a fixed constant.

