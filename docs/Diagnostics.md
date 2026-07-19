# Diagnostics and Performance Framework

This document describes the frontend diagnostics framework introduced for Touracle Sprint 5.2.

## Goals

- Centralize diagnostics and performance logging for route loading and rendering.
- Keep instrumentation non-intrusive and safe if diagnostics are disabled.
- Provide a developer-facing console and status bar for live inspection.
- Support nested performance timings so expensive phases are easy to identify.

## Architecture

The diagnostics runtime is implemented in [project/frontend/diagnostics.js](project/frontend/diagnostics.js) and exposed as `window.TouracleDiagnostics`.

The UI shell is defined in [project/frontend/index.html](project/frontend/index.html):

- Developer Tools toggles:
  - `devDiagnosticsEnabled`
  - `devPerformanceEnabled`
- Diagnostics dock:
  - `diagnosticsDock`
  - `diagnosticsStatusBar`
  - `diagnosticsFilterChips`
  - `diagnosticsRows`

Integration and instrumentation live in [project/frontend/map.js](project/frontend/map.js).

## Diagnostics Entry Model

Each entry contains:

- timestamp and formatted timestamp text
- level (`INFO`, `WARNING`, `ERROR`, `PERFORMANCE`)
- subsystem (for example: `GPX Import`, `Offline Weather Sampling`)
- event/message text
- optional duration in milliseconds
- optional metadata object
- optional parent id and depth (for nested scopes)

Entries are kept in-memory with a bounded session cap (configured to 1000 in `map.js`).

## Core API

The diagnostics module provides:

- `configure({ enabled, performanceEnabled, maxEntries })`
- `log({ level, subsystem, event, message, duration, metadata, parentId })`
- `start({ event, subsystem, message, metadata, parentId })`
- `end(token, { message, subsystem, metadata })`
- `measure(fn, options)`
- `getEntries()`
- `clear()`
- `subscribe(listener)`
- `updateStatus(statusPatch)`
- `getStatus()`
- `subscribeStatus(listener)`

## Frontend Wiring in map.js

The following helper layer wraps direct diagnostics access to avoid failures when the module is missing or disabled:

- `_diagLog(...)`
- `_diagStartMeasure(...)`
- `_diagEndMeasure(...)`
- `_diagUpdateStatus(...)`

UI management helpers:

- `_diagInitUi()`
- `_diagApplyToggles()`
- `_diagRenderFilterChips()`
- `_diagRefreshRows()`
- `_diagRenderStatus(status)`

Load-scoped state and summary:

- `CURRENT_LOAD_DIAG`
- `_diagStartLoadContext(meta)`
- `_diagFinalizeLoadContext(ok, message)`

## Instrumented Pipeline Phases

Current instrumentation covers:

- Total loading
- GPX import
- Elevation processing/profile generation
- Offline weather sampling
- Forecast retrieval
- Reverse geocoding lookups
- TourBook generation
- Statistics/summary rendering
- Map route rendering

On stream completion, a compact performance summary is appended to diagnostics rows, including per-phase durations and total elapsed load time.

## Status Bar Fields

The diagnostics status bar reports live values:

- state (`Loading`, `Processing`, `Rendering`, `Ready`, `Idle`)
- GPX points
- ride days
- weather sample count
- cache hit ratio
- last load duration
- approximate memory usage (when supported by browser runtime)

## Filter Chips

The diagnostics console supports subsystem-oriented chips:

- All
- GPX
- Weather
- Forecast
- Reverse Geo
- Rendering
- Performance
- Cache

Filtering is local UI logic and does not mutate stored entries.

## How to Instrument New Code

1. Pick a clear subsystem and event name.
2. Wrap expensive work with a nested measure:
   - `const token = _diagStartMeasure('My phase', 'My Subsystem', metadata, parentId)`
   - run code
   - `_diagEndMeasure(token, { message: 'My phase complete' })`
3. Store key values in metadata (counts, mode flags), not large payloads.
4. Update status for meaningful user-facing progress (`_diagUpdateStatus`).
5. Keep diagnostics tolerant to failures with `try/catch` in hot paths.

## Best Practices

- Keep logging volume moderate in high-frequency loops.
- Use `PERFORMANCE` level only for measured durations.
- Prefer small metadata objects with scalar fields.
- Never let diagnostics alter core route/weather behavior.
- Ensure disabled diagnostics path is near-zero overhead.

## Regression Expectations

Instrumentation should not change:

- route geometry generation
- weather retrieval semantics
- profile rendering output
- TourBook segmentation logic

Any regression investigation should compare behavior with diagnostics disabled and enabled.
