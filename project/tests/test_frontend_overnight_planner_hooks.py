from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
INDEX_HTML = BASE_DIR / 'frontend' / 'index.html'
MAP_JS = BASE_DIR / 'frontend' / 'map.js'


def test_overnight_controls_exist_in_tour_sidebar():
    html = INDEX_HTML.read_text(encoding='utf-8')
    assert 'id="overnightPlannerPanel"' in html
    assert 'id="overnightSearchBtn"' in html
    assert 'id="overnightShowOwned"' in html
    assert 'id="overnightShowSearchResults"' in html
    assert 'id="overnightShowSearchAreas"' in html
    assert 'id="overnightSearchRadius"' in html
    assert 'id="overnightSearchRadiusValue"' in html
    assert 'id="overnightSearchScope"' in html
    assert 'id="overnightCategoryChips"' in html
    assert 'data-overnight-category="all"' in html
    assert 'data-overnight-category="camping"' in html
    assert 'data-overnight-category="hotel"' in html
    assert 'data-overnight-category="hostel"' in html
    assert 'data-overnight-category="bivouac"' in html
    assert 'id="overnightOwnedCount"' in html
    assert 'id="overnightSearchCount"' in html
    assert 'id="overnightStatus"' in html
    assert 'Your overnight stops' in html


def test_overnight_frontend_hooks_and_persistence_are_wired():
    source = MAP_JS.read_text(encoding='utf-8')
    assert 'const overnightSearchBtn = document.getElementById(\'overnightSearchBtn\');' in source
    assert 'function _renderOvernightPlanner()' in source
    assert 'function _runOvernightDiscovery()' in source
    assert 'map.on(\'contextmenu\'' in source
    assert "fetch('/api/overnight/discover'" in source
    assert 'function _overnightEditorPopupHtml(stop' in source
    assert 'function _overnightWebsiteHref(value)' in source
    assert 'function _overnightOpenEditorById(id)' in source
    assert 'function _openOvernightEditorOverlay(stop' in source
    assert 'function _closeOvernightEditorOverlay()' in source
    assert "marker.on('contextmenu'" in source
    assert 'bubblingMouseEvents: false' in source
    assert 'data-action="delete-overnight"' in source
    assert 'function _overnightStageArrivalZonesInView(radiusKm)' in source
    assert 'function _overnightDrawSearchAreas()' in source
    assert 'function _overnightRefreshPlanningZones()' in source
    assert 'routePoints: routePoint,' in source
    assert "console.groupCollapsed('[OvernightDiscovery] request')" in source
    assert "console.info('[OvernightDiscovery] response'" in source
    assert "setProgressIndeterminate(true);" in source
    assert "setProgressIndeterminate(false);" in source
    assert "progressEl.classList.remove('wm-overnight-bounce');" in source
    assert 'function _overnightUpdateSharedProgress(doneCount, totalCount, successCount, foundCount = 0)' in source
    assert 'wm-overnight-map-marker--discovered' in source
    assert 'wm-overnight-map-marker--user' in source
    assert 'wm-overnight-map-marker--selected' in source
    assert 'OVERNIGHT_SELECTED_MARKER_KEY' in source
    assert 'function _overnightShowOwnedEnabled()' in source
    assert 'function _overnightShowSearchResultsEnabled()' in source
    assert 'function _overnightShowSearchAreasEnabled()' in source
    assert 'function _overnightApplyCategoryChipStates()' in source
    assert 'function _overnightFilteredDiscoveredItems()' in source
    assert 'function _overnightDensityForZoom()' in source
    assert 'function _overnightThinDiscoveredForViewport(stops)' in source
    assert 'function _overnightEnsureViewportRefreshBinding()' in source
    assert "progressPercentEl.textContent = `${done}/${total} zones • ${ok} ok • ${found} found`;" in source
    assert 'function _overnightInterleaveZoneCandidates(entries, radiusKm, limit)' in source
    assert 'OVERNIGHT_DISCOVERED = [];' in source
    assert '.filter((entry) => Number.isFinite(Number(entry.distKm)) && Number(entry.distKm) <= radiusKm + 0.25)' in source
    assert 'const maxCandidatesPerZone = 80;' in source
    assert 'Delete this overnight option?' not in source
    assert "map.on('click', () => {" in source
    assert 'Day ${idx} - Accomodation' in source
    assert 'function _overnightAssignableDays()' in source
    assert 'data-overnight-action="edit-title"' in source
    assert 'data-overnight-action="type"' in source
    assert 'data-overnight-action="status"' in source
    assert 'data-action="edit-overnight"' in source
    assert '.wm-roadbook-overnight-item .text[data-action="edit-overnight"]' in source
    assert 'const overnightStops = _overnightStopsForStage(dayKey);' in source
    assert 'const _roadbookOvernightHtml = (dayKey) => {' in source
    assert '${overnightHtml}' in source
    assert 'overnightStops: Array.isArray(src.roadbook && src.roadbook.overnightStops)' in source
    assert 'nextOvernightId: Math.max(1, Math.round(Number(src.roadbook && src.roadbook.nextOvernightId) || 1))' in source
