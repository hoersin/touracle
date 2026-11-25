from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'
INDEX_HTML = BASE_DIR / 'frontend' / 'index.html'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def _html() -> str:
    return INDEX_HTML.read_text(encoding='utf-8')


def test_route_info_section_exists_in_tour_sidebar():
    html = _html()
    assert 'Route information' in html
    assert 'id="tourSidebarRouteStart"' in html
    assert 'id="tourSidebarRouteEnd"' in html
    assert 'id="tourSidebarRouteDistance"' in html
    assert 'id="tourSidebarRouteElevation"' in html
    assert 'id="tourSummaryFitAll"' in html
    assert 'id="reverse"' in html


def test_sidebar_route_info_is_rendered_from_existing_tour_state():
    source = _source()
    assert 'function _tourRouteDistanceKm()' in source
    assert 'function _tourRouteElevationHm()' in source
    assert 'function _renderTourSidebarRouteInfo(opts)' in source
    assert '_renderTourSidebarRouteInfo({' in source


def test_sidebar_route_metric_validation_keeps_unknown_as_placeholder():
    source = _source()
    assert 'const providedDistanceKm = _finiteOrNull(data.distanceKm);' in source
    assert 'const providedElevationHm = _finiteOrNull(data.elevationHm);' in source
    assert 'const fallbackDistanceKm = _finiteOrNull(_tourRouteDistanceKm());' in source
    assert 'const fallbackElevationHm = (fallbackDistanceKm !== null) ? _finiteOrNull(_tourRouteElevationHm()) : null;' in source
    assert 'if (distanceKm === null) elevationHm = null;' in source
    assert "tourSidebarRouteDistance.textContent = (distanceKm !== null) ? fmt(distanceKm, 0) : '—';" in source
    assert "tourSidebarRouteElevation.textContent = (elevationHm !== null) ? fmt(elevationHm, 0) : '—';" in source
    assert 'Number.isFinite(Number(distanceKm))' not in source
    assert 'Number.isFinite(Number(elevationHm))' not in source


def test_fit_entire_tour_button_remains_wired():
    source = _source()
    assert "const fitBtn = tourSummaryFitAllBtn;" in source
    assert "fitBtn.addEventListener('click', () => {" in source
    assert '_fitEntireTour();' in source
