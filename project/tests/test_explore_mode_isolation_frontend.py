from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / "frontend" / "map.js"
INDEX_HTML = BASE_DIR / "frontend" / "index.html"


def _source() -> str:
    return MAP_JS.read_text(encoding="utf-8")


def _html() -> str:
    return INDEX_HTML.read_text(encoding="utf-8")


def test_explore_nav_label_and_tour_section_visibility_rules():
    html = _html()
    assert 'id="navClimate"' in html
    assert '>Explore</button>' in html
    assert 'body[data-mode="climate"] #wmSectionTour { display: none; }' in html
    assert 'body[data-mode="climate"] #strategicTimeline { display: none; }' in html
    assert 'body[data-mode="climate"] #profileCanvas,' in html
    assert 'body[data-mode="climate"] #tourSummary {' in html
    assert 'body[data-mode="climate"] #roadbookPanel,' in html
    assert 'body[data-mode="climate"] #roadbookResizeHandle { display: none !important; }' in html
    assert 'data-time-row="year"' in html
    assert 'data-time-row="quarter"' in html
    assert 'data-time-row="month"' in html


def test_route_layer_visibility_is_tour_only():
    source = _source()
    assert "const showSharedRoute = (_getAppMode() === 'tour');" in source
    assert "const showSharedRoute = (_getAppMode() === 'tour' || _getAppMode() === 'climate');" not in source


def test_explore_uses_sidebar_period_control_and_local_climate_loading_copy():
    source = _source()
    assert "if (timescaleRow) timescaleRow.style.display = 'none';" in source
    assert 'Loading weather data...' not in source
    assert 'offline weather tiles' not in source
    assert 'Loading local climate profile…' in source
    assert '/api/explore/climate_profile?lat=' in source
    assert '&reference_years=' in source
    assert '_climateTemperatureThirdsChartSvg' in source
    assert '_climatePrecipitationThirdsChartSvg' in source
    assert '_climateWindPanelMarkup' in source


def test_explore_climate_request_key_no_longer_depends_on_map_period_controls():
    source = _source()
    assert "const refYears = Math.max(1, Number(CLIMATE_PROFILE_STATE.referenceYearCount)" in source
    assert "&reference_years=" in source
    assert "&years=" not in source[source.find("const url = `/api/explore/climate_profile?lat="):source.find("try {", source.find("const url = `/api/explore/climate_profile?lat="))]
    assert "_scheduleClimateProfileForPoint(CLIMATE_PROFILE_STATE.selectedPoint, { force: true });" not in source


def test_strategic_grid_429_is_retried_while_the_request_is_current():
    # Phase 2: a single retry gave up while the server was still busy with the page's
    # own earlier request (no overlay after start). Behaviour is covered by
    # regression/test_explore_overlays.py (initial load, busy server).
    source = _source()
    assert "async function _strategicFetchBusyAware" in source
    assert "resp.status !== 429" in source[source.find("async function _strategicFetchBusyAware"):]
    assert "StrategicGridBusyError" in source
    assert "async function _strategicRequestGrid" in source
    # Phase 3: neighbour prefetch (daily/range timeline only) was unreachable and is removed.
    assert "_prefetchStrategicNeighbor" not in source


def test_explore_overlay_lifecycle_keeps_canvas_layers_and_clears_wind():
    source = _source()
    assert "function _setStrategicLayer(layer)" in source
    assert "STRATEGIC_STATE.windLayer.stop()" in source
    assert "STRATEGIC_STATE.windLayer.clear()" in source
    assert "!map.hasLayer(STRATEGIC_STATE.isoLayer)" in source
    assert "!map.hasLayer(STRATEGIC_STATE.windLayer)" in source
    assert "if (layer === 'none')" in source
    assert "clear: function()" in source
    assert "STRATEGIC_STATE.isoLayer.clear()" in source


def test_explore_default_workspace_is_responsive_percentage_with_persisted_override():
    source = _source()
    assert "Math.round(window.innerHeight * 0.34)" in source
    assert "localStorage.getItem('wm_profile_height')" in source
    assert "legacyDefault" in source


def test_explore_time_modes_are_complete_and_profile_stays_period_independent():
    html = _html()
    source = _source()
    assert 'data-time-kind="year"' in html
    assert 'data-time-kind="quarter"' in html
    assert 'data-time-kind="month"' in html
    assert "_applyExploreTimeButton" in source
    assert "&reference_years=" in source
    assert "&years=" not in source[source.find("const url = `/api/explore/climate_profile?lat="):source.find("try {", source.find("const url = `/api/explore/climate_profile?lat="))]


def test_explore_workspace_charts_share_wind_panel_height():
    html = _html()
    assert "grid-template-rows: repeat(3, minmax(0, 1fr));" in html
    assert "grid-template-columns: repeat(4, minmax(0, 1fr));" in html
    assert "body[data-mode=\"climate\"] .wm-climate-workspace-panel-charts" in html
    assert "grid-template-rows: auto minmax(0, 1fr)" in html
    assert 'grid-template-areas: "location charts wind";' in html


def test_explore_overlays_use_spatial_rasters_and_wind_arrows():
    source = _source()
    assert "const a255 = Math.max(0, Math.min(255, Math.round(255 * 0.58)))" in source
    assert "drawArrows(resp.points, sampleFn)" in source
    assert "a: 0.78" in source


def test_explore_uses_24h_only_and_preferences_overlay_control():
    html = _html()
    source = _source()
    assert 'id="exploreOverlaySelect"' in html
    assert 'data-time-row="year"' in html
    assert 'data-time-row="quarter"' in html
    assert 'data-time-row="month"' in html
    assert html.count('data-time-kind=') >= 17
    assert 'id="exploreContextProgress"' in html
    assert 'id="setActiveHourStart"' not in html
    assert 'id="setActiveHourEnd"' not in html
    assert "return 'full_day';" in source
    # Phase 2: the per-pixel nearest-point search was replaced by an indexed bilinear
    # lookup (performance and correctness: regression/test_explore_overlays.py).
    assert "const directPoints = Array.isArray(tileMap.__points)" not in source
    assert "m.__rows = rows;" in source
    assert "r.layouts" in source
    assert "_strategicSelectionIdentity()" in source


def test_preferences_three_section_architecture_and_file_toolbar():
    html = _html()
    source = _source()
    assert 'id="wmPrefsGlobalSection"' in html
    assert 'id="wmPrefsContextSection"' in html
    assert 'id="wmPrefsAdvancedSection"' in html
    assert 'id="prefsSaveSettings"' in html
    assert 'id="prefsSaveTourAs"' in html
    assert 'id="prefsLoadSettings"' in html
    assert 'id="prefsImportGpx"' in html
    assert 'id="prefsExportGpx"' in html
    assert 'id="prefsExportTourXls"' in html
    assert 'id="prefsExportTourCsv"' in html
    assert 'id="prefsPrintTourPdf"' in html
    assert "#wmPrefsAdvancedSection" in html
    assert "_prefsExportGpx" in source
    assert "_prefsExportTourCsv" in source

