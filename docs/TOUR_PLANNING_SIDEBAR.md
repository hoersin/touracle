# Tour Planning sidebar (Sectors 1–3) and UI languages

Status: implemented on `explore/phase3-controls`, refined in the UI consolidation (see section 6), awaiting review. Phase 4 has not started.

## 1. Architecture

The sidebar (`#wmSidebarZones` in `project/frontend/index.html`) has three zones. Explore uses the same zones.

| Zone element | Tour Planning sector | Scrolls |
|---|---|---|
| `#wmZonePrimary` | Sector 1: Tour & TourBook (`.wm-s1`) | no |
| `#wmZoneContext` | Sector 2: Tasks (`.wm-s2`, four tabs) | no |
| `#wmSidebarScroll` | Sector 3: Preferences (`details.wm-pgroup`) | yes, the only scroll area |

- **Mode switching:** mode-specific parts use `.wm-zone-part[data-zone-mode]` and `[data-mode-only]`, as before.
- **Settings scope:** all settings blocks keep the `.wm-settings-scope` class, so slider initialisation and live-apply listeners (the `settingsView` shim in `map.js`) are unchanged.
- **Sidebar module:** the new code is in `map.js`, in the block that starts at `_closeSidebarMenus`:
  - menus: `_initSidebarMenus`, `_closeSidebarMenus`
  - TourBook button: `_syncTourBookButton`, `_showTourBook`
  - tabs: `_setTourTab`, `_initTourTabs`
  - preference groups: `_initPreferenceGroups`
  - summaries: `_renderTourWeatherYears`, `_renderTourWeatherSummary`, `_renderTourAnalysis`, `_renderTourInsights`
  - simulation results panel: `_setSimResultsPanel`
- **Read-only summaries:** the summaries only read existing state (`ROADBOOK_CACHE.days`, `LAST_PROFILE.gradient_sections`, the loaded weather). They never start a request or a calculation.
- **Stored UI state:** the active tab is stored in `localStorage['touracle_tour_tab']`; the open preference groups in `localStorage['touracle_pref_groups']`.
- **Unchanged:** backend, weather, simulation and gradient algorithms, the GPX and TourBook data model, and the persistence formats (`.tour` files, `touracle_settings`, the local plan store).

## 2. Control inventory and mapping

### Sector 1: Tour & TourBook

| Element | Control(s) | Before |
|---|---|---|
| Header | `#tourProjectTitle`, `#tourProjectStatus` (Saved / Modified), `#tourPlanFileInfo` | Tour project panel and TourBook header |
| Menu **Tour** | Open `#tourProjectOpenBtn`, Save `#tourProjectSaveBtn`, Save As `#tourProjectSaveAsBtn`, Import GPX `#tourProjectImportGpxBtn`, Export GPX `#prefsExportGpx` | Tour project panel; Export GPX was in the Preferences file toolbar |
| Menu **Route** | Reverse `#reverse`, Fit tour `#tourSummaryFitAll`, Route colors Stage/Gradient (`[data-route-coloring]`, `#routeColoringMode`) | Primary zone rows and the Context zone |
| **TourBook** button | `#tourBookShowBtn` shows or hides the TourBook panel | new; the panel had no toggle before |
| Menu **Export** | TourBook as PDF `#tourPlanExportPdfBtn`, as Excel `#tourPlanExportExcelBtn`, Tour days CSV `#prefsExportTourCsv` | TourBook plan manager and the Preferences file toolbar |
| Metadata | start → destination, distance, ascent, ride/rest days `#tourSidebarDays`, GPX file name, departure `#startDate`, arrival `#arrivalDate`, duration `#tourDays` | Route summary and schedule rows |

### Sector 2: Tasks (tabs; switching only shows or hides panels)

| Tab | Contents | Before |
|---|---|---|
| Overnight | category chips, radius, Search `#overnightSearchBtn`, scope, result filters, own stops, `#overnightStatus` | Overnight planner panel in Zone 3 |
| Weather | Source Historical/Forecast, reference years `#tourWeatherYears`, Load `#fetchWeather` / Stop, progress, stream status, summary `#tourWeatherSummary` | Primary and Context zones; years came from the hidden Explore year control |
| Simulation | step / direction / years, Start `#tourSlotOptimizeBtn`, status, "Show results" `#simResultsShowBtn` | Tour slot panel in Zone 3 |
| Analysis | `#tourAnalysis`: distance, elevation gain, mean climb gradient, ride/rest days, stage lengths, gradient distribution, weather of the loaded data | new; it only uses existing values |

Simulation results (chart and table) open in the floating panel `#simResultsPanel` over the map. Inside the sidebar the chart had less than the 320 px of width it needs, and Sector 2 grew to 746 px.

### Sector 3: Preferences (collapsible groups)

| Group | Contents |
|---|---|
| A Language & Region | `#uiLanguage` |
| B Map & Display | wind look, interpolation, include sea, basemap |
| C Route & GPX (Tour only) | GPX drop zone `#dropZone`, sampling step `#setStepKm` |
| D Weather Preferences (Tour only) | Lucky Day thresholds, Data Selection, Wind Settings, progress details |
| G Data & Export | settings snapshot save/load `#settingsSave`, `#settingsLoad` |
| H Developer Tools | diagnostics and the calculation guide |

**E Overnight and F Simulation preferences are omitted.** There are no persistent default settings for either. Their parameters are part of the task itself and stay in their tabs. Adding empty groups would invent settings.

### Removed (duplicates or the separate TourBook management)

| Removed | Function remains available through |
|---|---|
| `wmPrefsGlobalSection` file toolbar: `prefsSaveSettings`, `prefsLoadSettings` | `#settingsSave`, `#settingsLoad` (group G) |
| `prefsSaveTourAs` | Tour ▸ Save As |
| `prefsImportGpx` | Tour ▸ Import GPX, drop zone |
| `prefsExportTourXls`, `prefsPrintTourPdf` | Export ▸ Excel / PDF |
| `prefsShareSnapshot` | the share button on the map |
| Plan Variants manager (`tourPlanManageBtn`, `tourPlanManager`, `tourPlanList`: load / duplicate / rename / delete / new local variants) | Removed together with its code (UI consolidation): one tour = one TourBook. Tours are files: Open / Save / Save As. |
| `advancedWeatherPrefs` wrapper, `strategicControls`, `tour*Row` wrappers | contents moved into groups D and Sectors 1/2 |

The JavaScript handlers for removed elements are null-guarded. They were left in place and can be removed in a later cleanup.

## 3. Internationalisation

```
project/frontend/i18n/
  i18n.js     core: window.WM_I18N
  en.js       reference language (all keys)
  de.js  fr.js  es.js  zh-CN.js
```

### Resources

- Each locale file sets `window.WM_I18N_RESOURCES[lang]`. Keys are stable and dotted: `tabs.weather`, `menu.tour.save`, `status.sim.progressComplete`, …
- Placeholders use the form `{name}`.

### API (`window.WM_I18N`)

| Member | Purpose |
|---|---|
| `t(key, params)` | Looks up a key in the active language, then English, then returns the key itself. Missing keys are recorded in `WM_I18N.missing`. |
| `setLanguage(lang)` | Applies the language immediately, stores it in `localStorage['touracle_language']`, sets `<html lang>` and fires the `wm:languagechange` event. |
| `getLanguage()`, `locale()` | Active language and locale. |
| `formatNumber`, `formatDate`, `monthName` | `Intl` formatting with the active locale. |
| `apply(root)` | Fills the elements marked with the attributes below. |

### HTML attributes

- `data-i18n` (text), `data-i18n-html` (calculation guide)
- `data-i18n-title`, `data-i18n-aria-label`, `data-i18n-placeholder`

The static English text in `index.html` is the fallback shown before the scripts run. A test keeps it identical to `en.js`.

### Dynamic texts in `map.js`

- `i18nT(key, params)` translates a key.
- `fmtN` formats numbers.
- `i18nMsg` and `_setI18nText` store the key on the element (`data-i18n-dyn`), so status, progress and error messages are re-rendered when the language changes.
- On `wm:languagechange`, the panels that build HTML are re-rendered: TourBook, simulation results, legends, summaries, Explore status.

### Not translated

- Technical identifiers: field names such as `temp_hist_*`, file names, IDs.
- Place names from the data.
- Proper names: "TourBook", the app name.

### Adding a key or a language

1. Add the English text to `en.js`.
2. Add the same key to every other locale. `tests/test_i18n_resources.py` fails if a locale is missing a key or changes its placeholders or markup.
3. For a new language, add the file, a `<script>` tag before `i18n.js`, the `SUPPORTED` entry and an `<option>` in `#uiLanguage`.

### Deliberately not translated

- Technical field names in the calculation guide (`temp_hist_*`, `precipitation_mm`, …).
- The Leaflet / OpenStreetMap / OpenTopoMap attribution.
- Developer Tools diagnostics (log entries and subsystem names).
- The PDF export with the Chinese UI uses English texts and dates: the standard PDF fonts
  cannot draw Chinese characters. Excel and CSV are fully translated (CSV with UTF-8 BOM).

## 4. Design system

Tokens are defined in `index.html`:

| Token | Value |
|---|---|
| `--wm-accent` | `#0f766e` (one accent colour) |
| `--wm-accent-strong` | `#115e59` |
| `--wm-accent-soft` | `rgba(15,118,110,.09)` |
| Sector backgrounds | `#f7f9fb`, `#f1f4f7` |
| `--wm-r` (radius) | 8 px |
| `--wm-ctl-h` (control height) | 28 px |

- In the sidebar, every primary or selected state uses the accent: load button, segmented controls, year chips, tabs, menus, progress bar.
- Below 380 px sidebar width a container query hides the tab icons.

## 5. Tests

- `tests/test_i18n_resources.py`:
  - completeness of every locale, placeholders and markup;
  - HTML text equal to `en.js`;
  - every key used in `map.js` exists;
  - identifiers are not translated.
- `tests/regression/test_tour_sidebar_redesign.py`:
  - tabs make no requests and are remembered;
  - menus;
  - the TourBook toggle;
  - PDF and Excel export without GPX export;
  - summaries and analysis;
  - language switching, persistence and locale formatting;
  - English fallback;
  - dynamic texts.
- `tests/regression/test_sidebar_zones.py`:
  - sector contents;
  - only Sector 3 scrolls in every tab at 1280×800 and 1440×900;
  - removed controls are gone.

## 6. UI consolidation (before Phase 4)

### Header and sectors

- **Mode selector:** the Explore / Tour Planning selector (`#modeNav`) is in the sidebar header (`#wmSidebarHeader`), next to the sidebar toggle and the product name. The map no longer has a mode switch (`#topNav` removed).
- **Sector headers:** each zone starts with a `header.wm-sector-head`. Its title depends on the mode:

  | Sector | Tour Planning | Explore | Header style |
  |---|---|---|---|
  | 1 | Tour | Climate map | teal band |
  | 2 | Tasks | Reference data | pale teal |
  | 3 | Preferences | Preferences | neutral grey, sticky |

- **Separation:** the sidebar ground (`--wm-ground`) shows between the sectors (`--wm-sector-gap`: 16 px, 10 px at heights up to 1000 px, 8 px at heights up to 860 px).
- **Backgrounds:** S1 white, S2 `#f2f7f7`, S3 `#f5f6f8`.
- **Vertical space:** the duration badge sits right of its slider; the GPX file name is no longer shown in Sector 1.
- **One visual language:** one font stack (`--wm-font`) and the teal accent for every selected or primary state: mode pill, tabs, chips, segmented controls, sliders, progress bar. The temperature, rain and wind gradient sliders keep their meaningful colours.

### Reference years

Seven mutually exclusive options in two rows, built by `_renderStrategicYearsButtons` (a radio group):

- Row 1: All years, Last three years.
- Row 2: 2025, 2024, 2023, 2022, 2021.

How the selection is used:

- **One state:** the selection is stored as its year list (`SETTINGS.strategicYears`). `_normalizeRefYears` maps any older combination to one option.
- **Shared by both modes:** the same state drives the map overlay (`years=`), the Explore climate profile (`/api/explore/climate_profile?years=`), every climate label (derived from the years the server reports), the charts and the wind roses, and the Tour weather years.

### Explore point climate

`/api/explore/climate_profile` interpolates the clicked point bilinearly between the surrounding tile centres, the same scheme the map overlay draws (`_interpolation_tiles`, `_blend_climatology_rows`; wind as u/v vectors).

- **Why:** before, it used the single nearest 50 km tile. Freiburg lies halfway between a Rhine-plain tile (7.51° E) and a Black Forest tile (8.19° E), so 500 m changed the annual mean by 2.6 K.
- **`meta.spatial`:** lists the tiles, weights and distances.
- **UI note:** the panel states that values come from a ~50 km grid and do not resolve local terrain.
- **`years` parameter:** requests exact reference years. An incomplete year is rejected with HTTP 422.

### Legend

The climate legend is shown in Explore only (`_updateStrategicLegend`); Tour Planning never shows it.

### One TourBook

- **Tour files:** a tour file holds the GPX and one `tourPlan`, with no `tourPlans` and no `activePlanId`. An older file with several plans opens its active plan only.
- **Browser storage:** the browser keeps one working copy (`wm_tour_plan_store_v1`). A store with several plans from the former variant manager is backed up once, unchanged, to `wm_tour_plan_store_v1_variants_backup`.

### Tests

- `tests/regression/test_ui_refinement.py`:
  - header selector;
  - sectors at 1280×800 and 1440×900;
  - the seven reference-year options and their propagation to the overlay, the climate profile and the labels;
  - no legend in Tour Planning;
  - one TourBook: files, legacy file, variant backup;
  - no missing translation or raw key in any of the five languages.
- `tests/regression/test_offline_tile_lookup.py`: spatial continuity and explicit reference years.

## 7. Simulation: one reference period, decision-support results

### Single source of truth

- **The setting:** the reference years are the Weather tab's selection (`SETTINGS.strategicYears` via `_strategicGetSelectedYears()`). It has seven exclusive options: All years, Last three years, 2025 … 2021.
- **The Simulation tab** has no years selector of its own. It shows the period read-only (`#tourSlotReference`, e.g. "Historical reference: 2023–2025 (Last three years)") and sends exactly these years (`yearsSelected`) to `/api/tour_slot_optimizer/start`.
- **The backend** keeps the old `horizonYears` fallback for other API clients only.
- **Outdated results:** if the Weather selection changes after a run, the results panel says which period the results use and asks for a new run.

### What the optimizer provides (methodology unchanged)

- **Ranking:** start dates are scored and ranked as before.
  - Objective: lucky days, tie-break on missing data, then on date.
  - Same thresholds, same aggregation across years (median temperature, mean precipitation and wind).
- **Additions, for reporting only** (they never enter scoring or ranking):
  - **Per-year values:** `_get_offline_stats(include_per_year=True)` (simulation only) also returns the individual years it read anyway.
  - **Per candidate:** the summary gains `per_year`, the same metrics computed for each reference year.
  - **Per curve point:** each point gains `year_values` per reference year.
  - **`meta.reliability`:** reference years requested and used, data coverage of the recommended start, and how many individual years put the recommended date among the best 20 % of start dates. A year without any variation does not count as confirming.

  | Level | Conditions |
  |---|---|
  | High | ≥ 3 years assessed, all confirming, coverage ≥ 90 % |
  | Medium | at least half of the years confirming, coverage ≥ 75 % |
  | Low | otherwise |
  | Not assessable | only one reference year |

  The old gap-based `confidence` field is still returned but no longer shown.

### Results panel (`#simResultsPanel`, `_renderTourSlotOptimizerResults`)

- **Header:** title, subtitle with riding days and period, close button. The panel lies over the map and the TourBook column.
- **Reliability:** level, its reasons, and a "How is this assessed?" tooltip.
- **Cards:**
  - **Best departure period:** the consecutive start dates around the best date that reach the same lucky-day count.
  - **Average temperature:** mean daily temperature over all tour days.
  - **Precipitation:** total ÷ tour days, plus the tour total.
  - **Headwind:** headwind total ÷ riding days, i.e. the mean headwind component; tailwind counts as 0.
- **Chart:**
  - Tabs: Precipitation, Temperature, Headwind, Lucky days (default: Lucky days, the ranking objective).
  - Line: the value for the reference period. With daily steps it is drawn as a centred 7-day average, stated in the legend.
  - Band: the range of the individual reference years. It is drawn only with two or more years.
  - Markers: dashed line for the recommended date.
  - Interaction: hovering shows the exact value and the per-year values. A click only selects a candidate date.
- **Recommendation:** comparisons with the median over all simulated start dates (differences under 10 % are not mentioned) and with the user's lucky-day temperature range. No other claims.
- **Top 3:** the first three candidates of the optimizer ranking. Assessment by share of lucky days: very favourable ≥ 80 %, favourable ≥ 60 %, moderate ≥ 40 %, otherwise unfavourable.
- **Actions:** "Reset view" returns to the recommended date and the Lucky days tab. "Apply selected departure date" (`_simApplySlot`) sets the start date and the simulated direction only; duration and rest days are unchanged, and the existing autosave and weather refresh follow.

### Tests

- `tests/regression/test_simulation_results.py` (9 tests, real UI).
- `tests/test_tour_slot_optimizer.py`: per-year values leave the ranking unchanged; reliability levels.
