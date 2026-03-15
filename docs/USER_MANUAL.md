# User Manual

## Concepts
- **Tour Planning**: route-centric. You work with a GPX track and weather is sampled along the route.
- **Climatic Map**: area-centric. You explore climatology layers over the map for a chosen calendar day.

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

### 4) Fetch / refresh weather
- Click the main **Fetch Weather** button.
- The map and profile update as data arrives.

### 5) Read the map
The map shows your route with weather visuals at sampled points.
Depending on settings, overlays can represent:
- temperature
- rain probability / rain typical amount
- wind (direction + speed)

Hover interactions:
- Hover points/segments to see a compact tooltip with the underlying statistics.
- Temperature tooltips distinguish between:
	- **Historical median/range**: the per-year daytime mean summarized across the selected historical span
	- **Typical daytime variation**: the median daytime min/max inside the selected riding hours

### 6) Read the profile strip
Below the map, the profile canvas provides an “at-a-glance” strip of the same data along distance.
- Hovering the profile shows the same information as hovering the map.
- Wind is typically visualized with direction indicators and a lane whose intensity reflects effective wind relative to route direction.

### 7) Tour summary band
Between map and profile, the UI contains a persistent “summary band” that hosts:
- the hover tooltip
- the overlay selector (e.g., Temperature / Rain / Wind)

The Tour hover tooltip labels these separately, so even a single-year selection can still show a meaningful **Typical daytime variation** without implying multi-year uncertainty.

## Climatic Map (strategic/climate mode)
### 1) Switch to Climatic Map
Use the top mode switch (segmented control) to enter **Climatic Map**.

### 2) Choose layer + year
A climate control box appears (bottom-right inside the map). It typically lets you choose:
- **Layer** (e.g., Temperature (Ride), Rain (Ride), Wind, Comfort)
- **Year** (selects which offline DB to query if you have per-year stores)

### 3) Choose calendar day
A timeline/slider at the bottom of the map lets you pick a day-of-year (month/day). The app then visualizes climatology for that day.

### 4) Interpreting layers
- Temperature layers show typical values and/or distributions depending on implementation.
- Rain layers emphasize probability and typical precipitation.
- Wind layers show wind direction and speed.
- Comfort layers combine thresholds into a “ride comfort” heuristic.

## Troubleshooting (user-facing)
- If the app shows missing data in Climate mode, confirm you have an offline DB available (see Installation Guide).
- If downloads fail with rate limiting, rerun offline builder with a higher `--min-interval-s`.

