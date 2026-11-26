# Tour Planning sidebar (Sectors 1–3) and UI languages

Status: implemented on `explore/phase3-controls`, awaiting review. Phase 4 has not started.

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
| Plan Variants manager (`tourPlanManageBtn`, `tourPlanManager`, `tourPlanList`: load / duplicate / rename / delete / new local variants) | **not available in the UI** (decision for review). The local plan store stays for autosave and restore. Tours are files: Open / Save / Save As. |
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

### Known untranslated areas (English fallback)

- Explore climate panel below the map: charts and cards.
- Elevation and weather profile chart labels.
- Map tooltips and popups.
- The content of the PDF, Excel and CSV exports.
- Simulation chart curve names and axes.
- Verbose progress lines in "progress details" and the provider suffix of the stream-done message.
- Diagnostics.

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
