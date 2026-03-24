# Strategic Grid Aggregation (Multi‑Year + Timescale/Range)

This document describes how the **Strategic / Climate** map computes per-tile values when you select **Years**, **Mode (24h vs Active)**, and a **Timescale** (or explicit **Range**).

Code: backend aggregation lives in `project/backend/climate_aggregation.py`, served via `GET /api/strategic_grid` in `project/backend/app.py`.

---

## 1) Inputs and outputs

### Request inputs (high level)

The frontend sends (among others):

- `years=2025,2024,...` (multi-select)
- `mode=full_day|active`
- either:
  - **timescale mode**: `timescale=daily|week|two_week|month|quarter|year` + `date=MM-DD` (or equivalent)
  - **range mode**: `start_date=YYYY-MM-DD` + `duration_days=N` (the year in `start_date` is a *seasonal anchor*; the selected `year`/`years` control which offline DBs are used)
- viewport bounds: `lat_min,lat_max,lon_min,lon_max` (expanded slightly server-side for edge interpolation)
- optional Lucky Days thresholds (always sent by the frontend for tooltips):
  - `lucky_temp_cold`, `lucky_temp_hot`, `lucky_rain_max`, `lucky_wind_max`

### Response (simplified)

The server returns:

- `points`: list of tile-center points with aggregated fields (see below)
- metadata:
  - `years_selected`, `mode`, `timescale`
  - for range: `start_date`, `end_date`, `duration_days`
  - `sample_days`: an estimate of how many “sample-days” were aggregated per tile (see §4)

Each `point` contains tile identity and the aggregated climate fields, e.g.:

- `temperature_c` (full-day)
- `temp_day_median` (active-hours)
- `precipitation_mm`
- `rain_probability`
- `wind_speed_ms`, `wind_dir_deg`, `wind_var_deg`
- optional: `lucky_day_count`, `lucky_ride_count`

---

## 2) Tile model

The offline database is organized as:

- table `tiles`: defines a fixed grid of tile centers (`tile_id`, `lat`, `lon`, `row`, `col`)
- table `climatology`: per tile and per calendar day (`month`, `day`) it stores the climate fields

The query shape is (conceptually):

1. select all `tiles` within the viewport
2. LEFT JOIN `climatology` rows for the selected **set of (month, day)** values

This yields multiple joined rows per tile (one per included calendar day), which are then reduced into one aggregated value per field.

---

## 3) Time selection → set of calendar days

There are two ways to choose the set of calendar days included in the aggregation:

### A) Timescale aggregation (daily/week/two_week/month/quarter/year)

The backend derives a calendar-aligned day-of-year bin:

- `daily`: exactly one day
- `week`: a 7-day bin starting at Jan 1 (bins of size 7)
- `two_week`: a 14-day bin starting at Jan 1
- `month`: calendar month
- `quarter`: calendar quarter
- `year`: full year

Then it converts the resulting day-of-year range into a list of `(month, day)` pairs.

### B) Explicit range aggregation (`start_date` + `duration_days`)

The backend:

- parses `start_date`
- **re-anchors it to the selected strategic year** (seasonal alignment)
- clamps `duration_days` so the range stays within the year
- converts those consecutive days to `(month, day)` pairs

---

## 4) “Sample-days” and missing data

A **sample-day** is one joined climatology row that participates in the aggregation.

- With multiple years selected, the aggregator iterates **(year-store) × (calendar days)**.
- Some tiles/days can be missing (`NULL` values). The backend ignores non-finite values per field.

`sample_days` in the API response is an **estimate** used mainly as a tooltip denominator:

- range mode: `sample_days ≈ duration_days × (#years_selected)`
- timescale mode: a fixed window-size estimate per timescale (e.g. 7 for week, 31 for month) times the number of years

Important nuance:

- `sample_days` is not a per-tile exact count (because different fields may have different amounts of missing data). It’s a consistent global denominator for UI percentages.

---

## 5) Field aggregation (math)

Important: the **offline DB values are already derived statistics** computed from raw Open‑Meteo archive responses during the offline build step (see `project/offline/build_offline_tiles_openmeteo.py`). The request-time “aggregation” in `project/backend/climate_aggregation.py` then further reduces those per-(tile, month, day) rows across the selected **calendar-day window** and optionally across **multiple year-stores**.

Let $S$ be the set of sample-days included for a given tile.

### Temperature (Mode-aware)

The backend computes *two* robust temperature aggregates per tile:

- **Full-day** temperature: `temperature_c`
  - multi-year path: median over samples of `temp_24h_c` when available, otherwise falls back to `temperature_c`
- **Active-hours** temperature: `temp_day_median`
  - median over samples of `temp_day_median` when available, otherwise falls back to `temperature_c`

Formally (median ignores non-finite values):

- $T_{24h} = \operatorname{median}({t_i})$
- $T_{active} = \operatorname{median}({a_i})$

The frontend chooses which one to display based on `mode`:

- `mode=full_day` → use `temperature_c`
- `mode=active` → use `temp_day_median`

### Rain / precipitation

Most rain-related numeric fields are **means** over valid sample values:

- `precipitation_mm` (mean mm/day)
- `rain_typical_mm` (mean)

For multi-year aggregation, `rain_probability` is computed from samples using a threshold:

- choose a threshold $\tau$ (code uses `rain_prob_threshold_mm`, default 0.5 mm)
- count $k = |\{i \in S : r_i > \tau\}|$
- count $n = |\{i \in S : r_i \text{ is valid}\}|$
- $P(\text{rain}) = k / n$

This is more stable than averaging per-day stored probabilities across years.

### Wind speed and variability

- `wind_speed_ms`: mean
- `wind_var_deg`: mean

### Wind direction (circular mean)

Wind direction is averaged using a **circular mean**:

For each valid direction angle $\theta_i$ (degrees):

- $x = \sum_i \cos(\theta_i)$
- $y = \sum_i \sin(\theta_i)$
- $\bar{\theta} = \operatorname{atan2}(y, x)$

Converted back to degrees in $[0, 360)$.

If $x$ and $y$ are both ~0 (directions cancel), the result is treated as missing.

### Lucky Days counts (both variants are always computed)

Given user thresholds:

- temperature in $[t_{cold}, t_{hot}]$
- rain $\le r_{max}$
- wind $\le w_{max}$

The backend computes two counters per tile:

- `lucky_day_count`: counts days where **full-day** temperature is lucky
- `lucky_ride_count`: counts days where **active-hours** temperature is lucky

The frontend chooses which count to visualize based on `mode`:

- `mode=full_day` → show `lucky_day_count / sample_days`
- `mode=active` → show `lucky_ride_count / sample_days`

---

## 6) Caching and performance

### Backend

`project/backend/climate_aggregation.py` maintains an in-memory **LRU + TTL** cache keyed by:

- year or anchor year
- timescale (or `range` + `start_date` + `duration_days`)
- quantized viewport bbox
- plus a “variant” string that includes:
  - selected years list (for multi-year)
  - Lucky Days thresholds (because they affect `lucky_*_count`)

### Frontend

The frontend also caches `/api/strategic_grid` responses using a key that includes:

- `years` selection
- `mode`
- `timescale` / range params
- quantized viewport bbox
- Lucky Days thresholds

This is primarily to keep slider scrubbing smooth.

---

## 7) End-to-end flow diagram

This section focuses on what you asked for: **where data comes from (raw Open‑Meteo fields) and the exact selection/filtering/grouping + math** that leads to the final map fields.

Each diagram has two phases:

- **Offline build phase (once)**: Open‑Meteo archive → derived per-tile/per-(month,day) climatology rows stored in SQLite.
- **Request-time phase (per request)**: select years + time window + bbox → SQL join → per-tile reductions → JSON → frontend field choice + rendering.

### 7.1) Temperature (Temp)

**Raw provider inputs (Open‑Meteo archive)**

- Daily: `temperature_2m_mean` (°C)
- Hourly: `temperature_2m` (°C)

Note: request-time aggregation supports an optional DB column `temp_24h_c` (true 24h mean) when present. In the currently checked-in offline schema, this column does not exist, so the “full_day” sample falls back to `temperature_c`.

```mermaid
flowchart TD
  %% =====================
  %% Temperature pipeline
  %% =====================

  subgraph OFFLINE[Offline build phase (project/offline/build_offline_tiles_openmeteo.py)]
    OM_D[Open‑Meteo daily
    temperature_2m_mean (°C)
    per date] --> F_MMDD[Group across historical years
    by (month,day)]

    OM_H[Open‑Meteo hourly
    temperature_2m (°C)
    per hour] --> F_HOURS[Filter local hours
    {10,12,14,16}] --> G_DATE[Group by date]
    G_DATE --> DAY_MEAN[Per-date daytime mean
    mean(hours) if >=2 samples]
    G_DATE --> DAY_HOURS[Pooled daytime samples
    all selected-hour temps]

    F_MMDD --> BASE_TAVG[Base: tavg_samples = daily means]
    DAY_MEAN --> OVERRIDE_T[Override:
    temperature_c = median(daytime_means)
    (else median(daily_means))]
    DAY_HOURS --> ACTIVE_T[temp_day_median = median(daytime_hour_samples)
    temp_day_p25/p75 from percentiles]
  end

  subgraph REQUEST[Request-time phase (project/backend/app.py + climate_aggregation.py)]
    UI[Frontend selects:
    years[], mode, timescale or range,
    bbox] --> MMDD[Compute included (month,day) list
    from timescale/range]

    MMDD --> SQL[SQL:
    tiles in bbox
    LEFT JOIN climatology
    WHERE (month,day) in window]

    SQL --> CLEAN[Per joined row:
    ignore NULL/NaN values]

    CLEAN --> REDUCE_SINGLE[If 1 store:
    timescale path: mean over window for temperature_c/temp_day_median
    range path: median over window for temperature_c/temp_day_median]

    CLEAN --> REDUCE_MULTI[If multiple stores:
    per sample define
    full_sample = temp_24h_c if present else temperature_c
    active_sample = temp_day_median if present else temperature_c
    output uses median(full_sample) and median(active_sample)]
  end

  subgraph FRONTEND[Frontend field choice + display (project/frontend/map.js)]
    REDUCE_SINGLE --> PICK
    REDUCE_MULTI --> PICK
    PICK[Mode decides value key:
    full_day → temperature_c
    active → temp_day_median] --> RENDER[Interpolate/bucket into raster
    and render legend/tooltip]
  end
```

### 7.2) Rain (Rain)

**Raw provider inputs (Open‑Meteo archive)**

- Daily: `precipitation_sum` (mm/day)

Note on thresholds:

- Offline build stores `rain_probability` using a light threshold **0.1 mm** ("any measurable rain").
- Request-time **multi-store** aggregation recomputes `rain_probability` from `precipitation_mm` samples using **0.5 mm** (see `rain_prob_threshold_mm` in `project/backend/climate_aggregation.py`) to reduce drizzle noise.

```mermaid
flowchart TD
  %% =====================
  %% Rain pipeline
  %% =====================

  subgraph OFFLINE[Offline build phase (project/offline/build_offline_tiles_openmeteo.py)]
    OM_R[Open‑Meteo daily
    precipitation_sum (mm/day)
    per date] --> G_MMDD[Group across historical years
    by (month,day)]

    G_MMDD --> P_MED[precipitation_mm = median(prcp_samples)]
    G_MMDD --> P_PROB[rain_probability = mean(prcp > 0.1 mm)]
    G_MMDD --> P_TYP[rain_typical_mm = median(prcp | prcp > 0.1 mm)
    (else 0)]
  end

  subgraph REQUEST[Request-time phase (project/backend/app.py + climate_aggregation.py)]
    UI[Frontend selects:
    years[], timescale/range,
    bbox] --> MMDD[Compute (month,day) window]

    MMDD --> SQL[SQL join tiles×climatology
    restricted to bbox + window]
    SQL --> CLEAN[Ignore NULL/NaN]

    CLEAN --> REDUCE_R[Reduce per tile]

    REDUCE_R --> R_MM[precipitation_mm:
    mean over valid samples]
    REDUCE_R --> R_TYP[rain_typical_mm:
    mean over valid samples]

    REDUCE_R --> R_PROB_SINGLE[If 1 store (timescale/range):
    rain_probability = mean of stored rain_probability over samples]
    REDUCE_R --> R_PROB_MULTI[If multiple stores:
    recompute from precipitation_mm samples:
    P(rain) = k/n with threshold τ=0.5 mm
    (k: count precip>τ)]
  end

  subgraph FRONTEND[Frontend display (project/frontend/map.js)]
    R_MM --> DISPLAY[Rain layer uses precipitation_mm
    (smoothed/scaled field for raster)
    and uses rain_probability + rain_typical_mm for legend/tooltip classification]
    R_PROB_SINGLE --> DISPLAY
    R_PROB_MULTI --> DISPLAY
    R_TYP --> DISPLAY
  end
```

### 7.3) Wind (Wind)

**Raw provider inputs (Open‑Meteo archive)**

- Daily: `windspeed_10m_mean` (typically km/h in the pipeline → converted to m/s)
- Daily: `winddirection_10m_dominant` (degrees)

```mermaid
flowchart TD
  %% =====================
  %% Wind pipeline
  %% =====================

  subgraph OFFLINE[Offline build phase (project/offline/build_offline_tiles_openmeteo.py)]
    OM_WSPD[Open‑Meteo daily
    windspeed_10m_mean] --> G_MMDD[Group across historical years
    by (month,day)]
    OM_WDIR[Open‑Meteo daily
    winddirection_10m_dominant (deg)] --> G_MMDD

    G_MMDD --> W_SPD[wind_speed_ms = median(wspd_kmh)/3.6]
    G_MMDD --> W_DIR[circular mean direction:
    atan2(mean(sin θ), mean(cos θ))]
    G_MMDD --> W_VAR[circular std dev (deg)
    from resultant length R]
  end

  subgraph REQUEST[Request-time phase (project/backend/climate_aggregation.py)]
    UI[Frontend selects:
    years[], window, bbox] --> SQL[SQL join tiles×climatology
    in bbox + window]
    SQL --> CLEAN[Ignore NULL/NaN]

    CLEAN --> SPD[wind_speed_ms = mean over samples]
    CLEAN --> VAR[wind_var_deg = mean over samples]
    CLEAN --> DIR[wind_dir_deg = circular mean over sample directions
    (sum cos/sin; atan2)]
  end

  subgraph FRONTEND[Frontend display (project/frontend/map.js)]
    SPD --> DRAW[Wind layer draws vectors:
    magnitude from wind_speed_ms,
    direction from wind_dir_deg (converted FROM→TO)]
    DIR --> DRAW
    VAR --> DRAW
  end
```

### 7.4) Lucky Days (Lucky)

Lucky is **not** stored in the offline DB; it is computed at request-time because it depends on user thresholds.

**Inputs used per sample-day**

- temperature: uses `temperature_c` (full_day) and `temp_day_median` (active)
- rain: `precipitation_mm`
- wind: `wind_speed_ms`

```mermaid
flowchart TD
  %% =====================
  %% Lucky pipeline
  %% =====================

  subgraph REQUEST[Request-time phase (project/backend/app.py + climate_aggregation.py)]
    UI[Frontend sends thresholds:
    t_cold, t_hot, rain_max, wind_max
    and selects years[], window, bbox] --> SQL[SQL join tiles×climatology
    in bbox + window]
    SQL --> CLEAN[Ignore rows with non-finite inputs]

    CLEAN --> TEST[Per sample-day compute:
    is_lucky(t,r,w) =
    t_cold ≤ t ≤ t_hot AND
    r ≤ rain_max AND
    w ≤ wind_max]

    TEST --> CNT1[lucky_day_count += 1
    using t = full_sample]
    TEST --> CNT2[lucky_ride_count += 1
    using t = active_sample]

    CNT1 --> RESP[JSON includes both counts]
    CNT2 --> RESP
  end

  subgraph FRONTEND[Frontend display (project/frontend/map.js)]
    RESP --> PICK[Mode selects which count:
    full_day → lucky_day_count
    active → lucky_ride_count]

    PICK --> PCT[Convert to percent:
    p = 100 * count / sample_days
    clamp to 0..100]
    PCT --> RENDER[Render Lucky Days raster + tooltip]
  end
```

---

## 8) Practical implications

- **Mode affects temperature and Lucky Days** (and is also included in caching keys).
- **Years selection affects the distribution** (medians/means/probabilities) and increases the effective sample size.
- **Missing tiles/values are tolerated**: aggregation ignores non-finite values, and the UI clamps percentages to stable ranges.
