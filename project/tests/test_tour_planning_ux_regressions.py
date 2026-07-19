from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'
INDEX_HTML = BASE_DIR / 'frontend' / 'index.html'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def _html() -> str:
    return INDEX_HTML.read_text(encoding='utf-8')


def test_advanced_weather_preferences_are_collapsible_by_default():
    html = _html()
    assert 'id="advancedWeatherPrefs"' in html
    assert 'Advanced Weather Preferences' in html
    assert '<details id="advancedWeatherPrefs"' in html
    assert html.index('Data Selection') > html.index('id="advancedWeatherPrefs"')
    assert html.index('Wind Settings') > html.index('id="advancedWeatherPrefs"')
    assert html.index('Advanced</h4>') > html.index('id="advancedWeatherPrefs"')


def test_tour_schedule_exposes_departure_duration_and_arrival_inputs():
    html = _html()
    assert 'Departure date' in html
    assert 'Duration' in html
    assert 'Arrival date' in html
    assert 'id="arrivalDate"' in html


def test_hybrid_weather_mode_ui_is_present():
    html = _html()
    assert 'id="tourWeatherModeHybrid"' in html
    assert 'value="hybrid"' in html
    assert 'Hybrid: forecast when available, otherwise climatology' in html


def test_arrival_date_sync_uses_shared_tour_model_helpers():
    source = _source()
    assert 'function _tourSyncArrivalInputFromInputs()' in source
    assert 'function _tourApplyArrivalDateInput(opts)' in source
    assert "arrivalDateInput.addEventListener('change'" in source
    assert 'if (_tourIsActive()) _tourSyncTimelineFromInputs();' in source


def test_sidebar_scroll_and_resize_zones_are_separated():
    html = _html()
    sidebar_source = (BASE_DIR / 'frontend' / 'sidebar.js').read_text(encoding='utf-8')
    assert 'flex: 1 1 auto;' in html
    assert 'overflow-y: auto;' in html
    assert 'id="wmSidebarScrollbar"' in html
    assert 'id="wmSidebarScrollbarThumb"' in html
    assert '#wmSidebarScrollbar.is-hidden { display: none; }' in html
    assert 'right: -10px;' in html
    assert 'width: 8px;' in html
    assert '_startScrollbarThumbDrag(ev)' in sidebar_source
    assert '_scrollToThumbTop(nextTop);' in sidebar_source
    assert 'document.body.classList.add(\'wm-sidebar-scrolling\')' in sidebar_source
    assert "this.scrollEl.addEventListener('mouseenter', () => this._syncScrollbar(), { passive: true });" in sidebar_source
    assert "window.addEventListener('load', () => this._syncScrollbar(), { passive: true });" in sidebar_source
    assert 'requestAnimationFrame(() => requestAnimationFrame(() => this._syncScrollbar()));' in sidebar_source
    assert "this.scrollbarEl.classList.remove('is-hidden');" in sidebar_source
    assert "if (ev && Number(ev.button) !== 0) return;" in sidebar_source


def test_tour_plan_popup_is_overlayed_above_roadbook_shell():
    html = _html()
    assert '#roadbookPanel {' in html
    assert 'z-index: 1850;' in html
    assert '.wm-roadbook-shell {' in html
    assert 'position: relative;' in html
    assert 'overflow: visible;' in html
    assert '.wm-plan-manager {' in html
    assert 'position: absolute;' in html
    assert 'z-index: 1865;' in html
    assert 'pointer-events: none;' in html
    assert '.wm-plan-manager.is-open {' in html
    assert 'pointer-events: auto;' in html


def test_fit_entire_tour_action_exists_in_route_summary():
    source = _source()
    assert 'function _fitEntireTour()' in source
    assert 'id="tourSummaryFitAll"' in source
    assert "fitBtn.addEventListener('click', () => {" in source
    assert '_fitEntireTour();' in source


def test_hybrid_weather_mode_is_wired_into_frontend_state_and_controls():
    source = _source()
    assert "if (raw === 'hybrid') return 'hybrid';" in source
    assert "if (normalized === 'hybrid') return 'hybrid';" in source
    assert "_setTourWeatherMode('hybrid');" in source
    assert 'const hybridMode = _tourUsingHybridMode();' in source
    assert "const forceOnlineTourWeather = (tourWeatherModeUi === 'forecast' || tourWeatherModeUi === 'hybrid');" in source
    assert ": (forceOnlineTourWeather ? false : (routeMode !== 'premium'))," in source
    assert ": (forceOnlineTourWeather ? true : (routeMode === 'premium'))," in source
    assert "if (_tourUsingForecastMode() || _tourUsingHybridMode()) {" in source


def test_route_and_reverse_changes_reset_location_label_cache():
    source = _source()
    assert 'function _resetLocationLabelCaches()' in source
    assert 'if (pathChanged) {' in source
    assert '_resetLocationLabelCaches();' in source
    assert 'REVERSED = nextReversed;' in source


def test_roadbook_uses_continuous_stage_start_and_end_labels():
    source = _source()
    assert 'function _roadbookStageLocation(startKm, endKm)' in source
    assert 'const startLocation = previousEndLocation || stageLocation.startLabel;' in source
    assert 'const endLocation = stageLocation.endLabel;' in source
    assert 'location: `${startLocation} -> ${endLocation}`,' in source
    assert 'let previousEndLabel = \'\';' in source
    assert 'const startLabel = previousEndLabel || stageLocation.startLabel;' in source
    assert 'data-roadbook-stage="start"' in source
    assert 'data-roadbook-stage="end"' in source


def test_roadbook_location_updates_no_longer_rerender_entire_panel():
    source = _source()
    assert 'function _roadbookHydrateLocationLabels(days)' in source
    assert '_roadbookHydrateLocationLabels(days);' in source
    assert '_requestLocationLabel(point.lat, point.lng, () => {' not in source
