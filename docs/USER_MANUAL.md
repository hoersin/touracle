# User Manual

## Concepts
- **Tour Planning**: route-centric. You work with a GPX track and weather is sampled along the route.
- **Climatic Map**: area-centric. You explore climatology layers over the map for a chosen calendar day.
- **Tour Project**: the main working object. A Tour can contain one route GPX plus multiple Tour Plans.

## Tour Files
Touracle now uses a native project file format (`.tour`) for primary save/load workflows.

Typical workflow:
- New Tour
- Import GPX
- Edit one or more Tour Plans
- Save Tour (`.tour`)

Available file actions:
- New Tour
- Open Tour
- Save Tour
- Save Tour As
- Import GPX / Replace GPX
- Export GPX
- Export TourBook (Excel/PDF)

## Tour Planning (route mode)
### 1) Start
- Open the app in your browser.
- By default, a demo GPX route is available (configured server-side).

### 2) Upload a GPX route
- Use the upload control in the sidebar to upload a `.gpx` file.
- The server stores uploads under `project/data/` and remembers the last used file in `project/data/session_state.json`.

### 3) Choose date range and sampling settings
Typical controls you can adjust (names may vary slightly in the UI):
- **Start date**: first day of the tour
- **Tour days**: how many days are visualized
- **Weather stations separation / sampling step**: distance between sampled route points for weather symbols and summary statistics
- **Active time**: the daytime window used where the app distinguishes activity-focused values from all-day values

The sidebar can be resized by dragging its right edge. The same **Active time** value is available in both the Tour Planning and Climatic Map preference groups so the two modes stay aligned.

### 4) Fetch / refresh weather
- Click the main **Fetch Weather** button.
- The map and profile update as data arrives.

### 5) Read the map
The map shows your route with weather visuals at sampled points.
Depending on settings, overlays can represent:
- temperature
- rain probability / rain typical amount
- wind (direction + speed)

**Tour day cards** appear next to the route — one per day, placed perpendicular to the route direction. Each card shows:
- a coloured dot (green = lucky day, grey = not lucky)
- temperature (median for that day)
- a weather icon (sun / partly cloudy / rain)
- rain total in mm
- weekday-only date context (`Mon` ... `Sun`)

The legend below the mode selector always includes units: `Temperature (°C)`, `Rain (mm)`, `Wind (m/s)`, `Head/Tail-Wind (m/s)`.

Hover and click interactions:
- **Hover anywhere on the map** to see a location tooltip (place name + coordinates). The tooltip uses a short debounce to avoid network spam.
- **Click within ~1 mm of the GPX route** to sync the profile cursor and grey-dot marker to that position along the route. Hovering the route does *not* trigger cursor sync — only a click does.

Location labels and endpoint accuracy:
- Cursor readout labels and TourBook start/end labels are reverse-geocoded independently, but both now prefer nearby local places (for example: villages/communes close to the sampled point) over broader metro-city labels.
- TourBook endpoint labels are generated from offline reverse geocoding first, then formatted as `Start (CC) -> End (CC)` where country code is available.
- If a point cannot be resolved to a nearby named place, the UI falls back to coordinates.

### 6) Read the profile strip
Below the map, the profile canvas provides an “at-a-glance” strip of the same data along distance.
- **Tour day cards** are drawn at the top of the profile at each day’s midpoint distance. The weather tile itself contains only weather values (temperature, icon, rain).
- A centered 3-line calendar block appears below each profile tile:
	- `Day N`
	- `Wed Jul 12` style short date
	- `2026` (year)
- Hovering the profile shows the same information as hovering the map.
- Wind is typically visualized with direction indicators and a lane whose intensity reflects effective wind relative to route direction.

### 7) Tour summary band
Between map and profile, the UI contains a persistent “summary band” that hosts:
- the hover tooltip
- the overlay selector (e.g., Temperature / Rain / Wind)

The Tour hover tooltip labels these separately, so even a single-year selection can still show a meaningful **Typical daytime variation** without implying multi-year uncertainty.

**Reversing the tour** — the Reverse button in the tour summary flips the route direction and immediately re-fetches with the reversed heading. The "Reverse" checkbox in Preferences does the same but only marks data stale without re-fetching immediately.

## Climatic Map (strategic/climate mode)
### 1) Switch to Climatic Map
Use the top mode switch (segmented control) to enter **Climatic Map**.

If you want a compact explanation of how each displayed value is derived, open the **How Values Are Calculated** fold-out below Preferences in the sidebar, or see `docs/WEATHER_VALUE_REFERENCE.md`.

### 2) Choose layer + year
A climate control box appears (bottom-right inside the map). It typically lets you choose:
- **Layer** (e.g., Temperature (Ride), Rain (Ride), Wind, Comfort)
- **Year** (selects which offline DB to query if you have per-year stores)

The Preferences section also exposes **Active time** for Climatic Map. That setting matches the Tour Planning sidebar field, so changing it in one place updates the other.

### 3) Choose calendar day
A timeline/slider at the bottom of the map lets you pick a day-of-year (month/day). The app then visualizes climatology for that day.

### 4) Interpreting layers
- Temperature layers show typical values and/or distributions depending on implementation.
- Rain layers emphasize probability and typical precipitation.
- Wind layers show wind direction and speed.
- Comfort layers combine thresholds into a “ride comfort” heuristic.

If you open **How Values Are Calculated**, the sidebar shows only the explanation that matches the current mode: the Climatic Map table in Climatic Map mode, and the Tour Planning table in Tour Planning mode.

## Troubleshooting (user-facing)
- If the app shows missing data in Climate mode, confirm you have an offline DB available (see Installation Guide).
- If downloads fail with rate limiting, rerun offline builder with a higher `--min-interval-s`.
- If a TourBook endpoint label looks too far away from the visible route position, refresh weather/tour data once to rebuild endpoint labels with the latest reverse-geocoding logic.

