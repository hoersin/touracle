from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'
INDEX_HTML = BASE_DIR / 'frontend' / 'index.html'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def _html() -> str:
    return INDEX_HTML.read_text(encoding='utf-8')


def test_timeline_contains_today_button_and_marker():
    html = _html()
    assert 'id="strategicToday"' in html
    assert 'Jump timeline to today' in html
    assert 'id="strategicRangeToday"' in html
    assert '.wm-range-today' in html


def test_today_button_logic_is_wired_to_range_movement():
    source = _source()
    assert 'function _strategicMoveRangeToToday()' in source
    assert 'const start = _todayDoy();' in source
    assert '_strategicSetRange(safeStart, end, {' in source
    assert "if (strategicTodayBtn) {" in source
    assert '_strategicMoveRangeToToday();' in source


def test_today_marker_position_is_synced_with_range_ui():
    source = _source()
    assert 'if (strategicRangeToday) {' in source
    assert 'const todayPct = ((_todayDoy() - 1) / 365) * 100;' in source
    assert "strategicRangeToday.style.left =" in source
