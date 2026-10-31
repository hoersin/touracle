# Elevation Engine Validation and Diagnostics

This document describes how elevation is processed end-to-end in WeatherMap, where precision can be lost, and how diagnostics make that loss measurable and explainable.

## Goals

- Keep scientific traceability for elevation/ascent calculations.
- Expose exactly which geometry is used for totals and stages.
- Detect and quantify ascent/descent loss introduced by resampling.
- Provide reproducible diagnostics in backend logs and frontend diagnostics UI.

## Data Pipeline

### 1) Original GPX import (highest fidelity)

Backend loads GPX route points with original elevations.

- Source: GPX file points
- Representation: distance/elevation arrays (`dist_km`, `elev_m`)
- Key metric: reference ascent/descent at full available fidelity

### 2) Weather sampling geometry

Route is sampled for weather query points (controlled by `step_km`).

- Purpose: weather station/data interpolation
- Side effect: geometry simplification can smooth local peaks
- Risk: potential ascent underestimation relative to original GPX

### 3) Profile sampling geometry

Profile visualization and route-profile sync may use an additional sampling step (`profile_step_km`).

- Purpose: keep profile rendering responsive
- Side effect: further smoothing
- Risk: additional ascent/descent loss

### 4) Tour/day statistics

Frontend computes stage gains by accumulating positive elevation deltas inside each stage boundary.

- Current strategy: prefer source elevation geometry (`profile.elevation_source`) when available.
- Fallback: sampled profile geometry.

## Why Ascent Loss Happens

Ascent is the sum of all positive local elevation differences:

$$
A = \sum_i \max(0, h_i - h_{i-1})
$$

If short climbs are skipped by larger sampling steps, some positive local deltas disappear. The total ascent decreases even when total route distance remains close.

## Backend Diagnostics Payload

`/api/map_stream` profile event now includes `elevation_diagnostics` with:

- `stages`: stats for
  - original GPX geometry
  - weather-sampled geometry
  - profile-sampled geometry
- per stage fields:
  - `points`, `distance_km`, `ascent_m`, `descent_m`, `missing_elevation_points`
  - optional loss fields: `ascent_loss_m`, `ascent_loss_pct`, `descent_loss_m`, `descent_loss_pct`
- `comparisons`:
  - weather vs original
  - profile vs original
- `validation` booleans:
  - distance conservation (weather/profile)
  - missing-elevation checks
  - stage ascent sum consistency
- `timings_ms`:
  - GPX import
  - weather sampling
  - profile sampling
- `ascent_source_geometry_key`:
  - geometry used as reference for ascent/statistics provenance

## Frontend Diagnostics Integration

Frontend consumes `profile.elevation_diagnostics` and exposes:

- compact stage lines in diagnostics console
- validation lines (`OK`/`WARN`) for consistency checks
- performance line for elevation stage timings
- status summary fields:
  - elevation loss percent
  - ascent source geometry

Diagnostics filters include `Elevation` and `Validation` for quick triage.

## Validation Mode

Frontend sends `elevation_validation=1` in stream requests to ensure validation diagnostics are always enabled for normal interactive usage.

## Traceability Decisions

- Preserve original GPX elevation arrays and distances through stream lifecycle.
- Reverse mode also reverses source geometry arrays so diagnostics remain direction-consistent.
- Stage ascent checks compare sum of day climbs with route-level climb to detect partitioning or boundary issues.

## Regression Coverage

Tests in `project/tests/test_elevation_engine_diagnostics.py` cover:

- flat route (zero ascent/descent)
- rolling hills (positive/negative accumulation)
- alpine route (large climb/descent)
- dense vs sparse sampling (measurable ascent loss)
- stage ascent sum consistency with boundaries

## Interpretation Guidance

- Small distance differences with larger ascent loss usually indicate smoothing of short climbs.
- If `missing_elevation_points` is non-zero in source stage, GPX data quality limits confidence.
- If stage-sum validation fails, inspect stage boundaries and route/profile distance alignment.
