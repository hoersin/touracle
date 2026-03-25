# Weather Value Reference

This document is the compact reference for how user-facing weather values are calculated and where they appear in the app.

It is organized by:

1. window: Climatic Map or Tour Planning
2. year selection: single year or multiple selected years / historical span
3. mode: 24h or Active where the UI supports that distinction
4. metric: temperature, rain, rain sum, wind, Lucky Days

## Global rules

- Climatic Map values come from `GET /api/strategic_grid` and are tile-based.
- Tour Planning values come from `/api/map_stream` and are station-based.
- In Tour Planning, glyphs, map tooltips, and profile overlays all derive from the same station payload. The profile uses a subset of those fields.
- In Climatic Map, the tooltip shows the same aggregated tile values that drive the raster.
- In Tour Planning, there is no single top-level `24h / Active` toggle. The payload carries historical and daytime fields in parallel, and different UI elements use different subsets of them.

## Climatic Map

### Important nuance

- `Temp` in 24h mode uses `temperature_c`.
- `Temp` in Active mode uses `temp_day_median`.
- `Rain` in the tooltip is always `precipitation_mm` in `mm/day`.
- `Rain sum` in the tooltip is `precipitation_mm * visible_period_days`.
- `Wind` uses `wind_speed_ms`, `wind_dir_deg`, and `wind_var_deg`.
- `Lucky Days` uses `lucky_day_count` in 24h mode and `lucky_ride_count` in Active mode, normalized by `sample_days`.

### Aggregation reference

| Years | Mode | Temp | Rain | Rain sum | Wind | Lucky Days | Where shown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Single selected year | 24h | `temperature_c` from the selected yearly store, aggregated over the chosen day / timescale / range | `precipitation_mm` averaged over valid sample-days in the selected window | `precipitation_mm * visible_period_days` | `wind_speed_ms` mean, `wind_dir_deg` circular mean, `wind_var_deg` mean | `lucky_day_count / sample_days` | Map raster + climate cursor tooltip |
| Single selected year | Active | `temp_day_median` from the selected yearly store, aggregated over the chosen window | `precipitation_mm` averaged over valid sample-days in the selected window | `precipitation_mm * visible_period_days` | `wind_speed_ms` mean, `wind_dir_deg` circular mean, `wind_var_deg` mean | `lucky_ride_count / sample_days` | Map raster + climate cursor tooltip |
| Multiple selected years | 24h | median of full-day samples across `(selected years × selected calendar days)`; uses `temp_24h_c` when available, otherwise `temperature_c` | `precipitation_mm` mean across valid samples | `precipitation_mm * visible_period_days` | `wind_speed_ms` mean, `wind_dir_deg` circular mean, `wind_var_deg` mean across all samples | `lucky_day_count / sample_days` | Map raster + climate cursor tooltip |
| Multiple selected years | Active | median of active-hour samples across `(selected years × selected calendar days)`; uses `temp_day_median` when available, otherwise `temperature_c` | `precipitation_mm` mean across valid samples | `precipitation_mm * visible_period_days` | `wind_speed_ms` mean, `wind_dir_deg` circular mean, `wind_var_deg` mean across all samples | `lucky_ride_count / sample_days` | Map raster + climate cursor tooltip |

### Rain-specific note

- `rain_probability` is available in the aggregated tile data and is used for interpretation and classification.
- In multi-year aggregation it is recomputed from precipitation samples using the backend rain threshold, rather than just averaging stored probabilities.
- The climate tooltip currently highlights `Rain` and `Rain sum`; it does not print `rain_probability` directly.

## Tour Planning

### Important nuance

- Tour Planning does not expose a single `24h / Active` switch like Climatic Map.
- Instead, the backend emits both historical and daytime fields together:
  - `temp_hist_median`, `temp_hist_min`, `temp_hist_max`
  - `temp_day_typical_min`, `temp_day_typical_max`
  - legacy profile spread fields `temp_day_p25`, `temp_day_p75`
- The profile wind overlay is route-relative, not a raw station wind plot.

### Tour values by surface

| Years | Surface | Temp | Rain | Rain sum | Wind | Lucky Days | Where shown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Single historical year (`hist_years = 1`) | Glyph + map tooltip | `temp_hist_median` plus `temp_hist_min/max`; daytime spread still shown separately via `temp_day_typical_min/max` | `rain_probability` and `rain_typical_mm` | not shown as a dedicated Tour tooltip line | `wind_speed_ms`, `wind_dir_deg`, `wind_var_deg` | not shown as a per-glyph metric | Route glyphs + hover tooltip |
| Multiple historical years (`hist_years > 1`) | Glyph + map tooltip | same fields as above, but now span-sensitive across the selected historical years | `rain_probability` and `rain_typical_mm`, both span-sensitive | not shown as a dedicated Tour tooltip line | `wind_speed_ms`, `wind_dir_deg`, `wind_var_deg`, all span-sensitive | not shown as a per-glyph metric | Route glyphs + hover tooltip |
| Any year span | Profile overlay: Temperature | median line uses the Tour temperature reference; spread uses `temp_day_p25/temp_day_p75` | not used | not used | not used | not used | Profile canvas |
| Any year span | Profile overlay: Rain | not used | bars use `rain_typical_mm`; filled area uses `rain_typical_mm * rain_probability` | implicit in the area height, but no separate sum label | not used | not used | Profile canvas |
| Any year span | Profile overlay: Wind | not used | not used | not used | effective wind along the route computed from `wind_speed_ms`, `wind_dir_deg`, and local route heading; tolerance band comes from `wind_var_deg` | not used | Profile canvas |

### Tour tooltip contract

The Tour hover tooltip intentionally separates:

- **Historical median**: `temp_hist_median`
- **Historical range**: `temp_hist_min` to `temp_hist_max`
- **Typical daytime variation**: `temp_day_typical_min` to `temp_day_typical_max`

This matters because the tooltip should stay numerically explicit even when the visible map band is visually simplified.

## Quick reading guide

- If you are in Climatic Map, start with: selected years -> mode -> metric.
- If you are in Tour Planning, start with: historical span -> surface (`glyph / tooltip / profile`) -> metric.
- If you are debugging a mismatch, check the backend payload first:
  - Climatic Map: `strategic_grid`
  - Tour Planning: `map_stream`
