from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'
INDEX_HTML = BASE_DIR / 'frontend' / 'index.html'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def _html() -> str:
    return INDEX_HTML.read_text(encoding='utf-8')


def test_profile_zoom_controls_exist_in_ui():
    html = _html()
    assert 'id="profileZoomControls"' in html
    assert 'id="profileZoomOut"' in html
    assert 'id="profileZoomIn"' in html
    assert 'id="profileZoomReset"' in html
    assert '#profileZoomControls {' in html


def test_profile_zoom_state_and_helpers_exist():
    source = _source()
    assert 'let PROFILE_VIEW_MIN_KM = 0;' in source
    assert 'let PROFILE_VIEW_MAX_KM = null;' in source
    assert 'function _profileGetViewWindow(profile)' in source
    assert 'function _profileSetViewWindow(minKm, maxKm, profile, opts = {})' in source
    assert 'function _profileZoomHorizontally(factor, focusKm)' in source
    assert 'function _profileResetViewWindow()' in source


def test_profile_zoom_interactions_are_bound():
    source = _source()
    assert "profileZoomOutBtn.addEventListener('click'" in source
    assert "profileZoomInBtn.addEventListener('click'" in source
    assert "profileZoomResetBtn.addEventListener('click'" in source
    assert "el.addEventListener('wheel'" in source
    assert 'PROFILE_VIEW_DRAG_ACTIVE = true;' in source
