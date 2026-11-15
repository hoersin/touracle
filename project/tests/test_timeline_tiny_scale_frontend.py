from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'
INDEX_HTML = BASE_DIR / 'frontend' / 'index.html'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def _html() -> str:
    return INDEX_HTML.read_text(encoding='utf-8')


def test_tiny_timescale_styles_exist_below_slider():
    html = _html()
    assert '#strategicMonthTicks::before {' in html
    assert '#strategicMonthTicks::after {' in html
    assert '--wm-timescale-today-pct' in html
    assert '.wm-month-label {' in html
    assert 'class="wm-static-months"' in html
    assert '<span>Jan</span>' in html
    assert '<span>Dec</span>' in html


def test_tiny_timescale_today_marker_is_synced_from_js():
    source = _source()
    assert "strategicMonthTicks.style.setProperty('--wm-timescale-today-pct'" in source
    assert 'function _ensureStrategicMiniScaleRendered()' in source
