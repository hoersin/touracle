# User Manual

## Concepts
- **Tour Planning**: route-centric. You work with a GPX track, build a roadbook, and weather is sampled along the route.
- **Simulation Run**: departure-window wizard. Given a prepared roadbook, it evaluates all candidate start weeks and ranks them by weather comfort score.
- **Climatic Map**: area-centric. You explore climatology layers over the map for a chosen calendar day.

---

## Tour Planning (route mode)

### 1) Start
- Open the app in your browser.
- By default, a demo GPX route is available (configured server-side).

### 2) Import a GPX route
- Use **Import GPX** in the Tour Project panel (top of sidebar) or the upload control.
- Both paths apply the same defaults on import: start date `2026-06-01`, tour days `7`. This resets the plan to a clean state every time.
- The server stores uploads under `project/data/`.

### 3) Choose date range and sampling settings
Typical controls you can adjust (names may vary slightly in the UI):
- **Start date**: first day of the tour
- **Tour days**: how many days are visualized
- **Weather stations separation / sampling step**: distance between sampled route points
- **Active time**: the daytime window used where the app distinguishes activity-focused values from all-day values

The sidebar can be resized by dragging its right edge.

### 4) Fetch / refresh weather
- Click the main **Fetch Weather** button.
- The map and profile update as data arrives via SSE.

### 5) Read the map
The map shows your route with weather visuals at sampled points.
Depending on settings, overlays can represent: temperature, rain probability / typical amount, or wind (direction + speed).

**Tour day cards** appear next to the route — one per day, placed perpendicular to the route direction. Each card shows:
- a coloured dot (green = lucky day, grey = not lucky)
- temperature (°C, daytime median)
- a weather icon (sun / partly cloudy / rain)
- rain total (mm)
- weekday name

The legend always includes units: `Temperature (°C)`, `Rain (mm)`, `Wind (m/s)`, `Head/Tail-Wind (m/s)`.

Hover and click interactions:
- **Hover anywhere on the map** to see a location tooltip (place name + coordinates).
- **Click within ~1 mm of the GPX route** to sync the profile cursor to that position. Hovering does *not* trigger sync — only a click does.

### 6) Read the profile strip
Below the map, the profile canvas provides an at-a-glance strip of the same data along distance.
- **Tour day cards** are drawn at the top of the strip at each day's midpoint distance (temperature, weather icon, rain total, weekday).
- Hovering the profile shows the same information as hovering the map.
- Wind is visualized with direction indicators and a lane whose intensity reflects effective wind relative to the route heading.

### 7) Tour summary band
Between map and profile, a persistent summary band hosts:
- the hover tooltip
- the overlay selector (Temperature / Rain / Wind / Head-Tail Wind)
- aggregate badges: total days, rain days, headwind/tailwind days, lucky days, median temperature, total precipitation, mean wind

---

## Roadbook and stage planning

### Roadbook panel
The roadbook panel (accessible from the sidebar) lists all days as cards:
- **Ride day cards**: show stage name, start/end location, distance (km), ascent (m), date, weather summary.
- **Rest day cards**: zero-distance anchor points used as base camps or transit days.

### Inserting rest days
Insert zones appear between every pair of cards. Click the `+` button in an insert zone to add a rest stop at that position.

### Stage boundaries
Day-split positions (the km along the route where each day ends) are draggable on the profile strip. Drag a boundary marker left or right to redistribute distance between days.

### Reversing the tour
- **Reverse button** in the tour summary: flips the route direction and immediately re-fetches weather.
- **Reverse checkbox** in Preferences: marks data stale but does not re-fetch immediately.

---

## Tour Plan and Project management

### Multiple TourPlans
Inside a single session you can keep several named plans (e.g., "Option A — fast", "Option B — scenic"). Use the Tour Plan manager (sidebar) to:
- **Save** — write the current state to a named slot (autosaves after 1800 ms of inactivity too)
- **Load** — restore a saved plan including boundaries, rest days, start date, and weather context
- **Duplicate** — clone the active plan under a new name
- **Rename** / **Delete** (delete requires confirmation)

A dirty-state dot in the sidebar header indicates unsaved changes.

### Tour Project file (.tour)
To transfer a tour between machines or archive it, use the Tour Project panel:
- **Save / Save As** — writes a `.tour` file containing the embedded GPX, all TourPlans, and the active plan ID.
- **Open** — loads a `.tour` (or legacy `.json`) file and restores the full state.
- **Import GPX** — replaces only the route, applying import defaults.

The `.tour` format is JSON (schema version 1). A legacy bridge reads older single-plan snapshots automatically.

---

## Export

### Excel TourBook
Downloads a styled `.xlsx` with one row per day:
- Ride days: stage name, start → end, distance, cumulative distance, ascent, date, temperature, rain, notes column.
- Rest days: highlighted in orange with "Rest Day" label.
- Features: freeze panes (header + date column), autofilter, alternating row colours.

### PDF TourBook
Downloads a PDF table with the same content:
- Landscape or portrait selected automatically based on stage name length.
- Rest-day rows highlighted in amber.
- Page `N / Total` footer with "Generated by Touracle".

---

## Climatic Map (strategic/climate mode)

### 1) Switch to Climatic Map
Use the top mode switch (segmented control) to enter **Climatic Map**.

For a compact explanation of how each displayed value is derived, open the **How Values Are Calculated** fold-out in the sidebar, or see `docs/WEATHER_VALUE_REFERENCE.md`.

### 2) Choose layer + year
A climate control box appears (bottom-right inside the map):
- **Layer**: Temperature (Ride), Rain (Ride), Wind, Comfort
- **Year**: selects which offline DB to query

The Preferences section also exposes **Active time** for Climatic Map. That setting matches the Tour Planning sidebar field.

### 3) Choose calendar day
A timeline/slider at the bottom of the map lets you pick a day-of-year (month/day). The app then visualizes climatology for that day.

### 4) Interpreting layers
- Temperature layers show typical values and/or distributions.
- Rain layers emphasize probability and typical precipitation.
- Wind layers show direction and speed.
- Comfort layers combine thresholds into a "ride comfort" heuristic.

---

## Simulation Run (Tour Slot Optimizer)

### When to use it
After you have set up your roadbook (ride days, rest days, stage boundaries), use the Simulation Run to find the best departure week without manually trying every date.

### Controls
In the Tour Planning sidebar, find the **Simulation Run** section:
- **Direction mode**: `Forward`, `Reverse`, or `Compare both`
- **Slot granularity**: week (default)
- **Climatology horizon**: 1, 3, or 5 years

### Running
1. Click **Start Simulation Run**.
2. The backend evaluates ~52 week-aligned start dates (and both directions if selected), scoring each by: rain probability (dominant), headwind, temperature outside comfort range.
3. Progress is shown in the status line.
4. Results appear as ranked candidate slots, each with a penalty-curve chart, score breakdown, and "Years actually used / requested" provenance.

### Applying a result
Click **Apply Selected Slot** on any candidate to:
- set the tour start date and direction
- immediately re-fetch weather for that window

### Score model
Lower score = better conditions. Main factors (weights):
- Rain probability: 3.5×
- Headwind: 1.4×
- Temperature above hot threshold: 1.1×
- Temperature below cold threshold: 0.8×
- Tailwind: −0.35× (bonus, reduces score)

---

## Troubleshooting (user-facing)
- If the app shows missing data in Climate mode, confirm you have an offline DB available (see Installation Guide).
- If downloads fail with rate limiting, rerun the offline builder with a higher `--min-interval-s`.
- If a tour day shows no weather card, check the server log for `[PLAN] Missing-day sample augmentation failed`.
- After changing frontend JS, hard-refresh the browser or the cache-buster may need bumping (see Development & Testing).
