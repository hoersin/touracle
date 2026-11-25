from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'
INDEX_HTML = BASE_DIR / 'frontend' / 'index.html'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def _html() -> str:
    return INDEX_HTML.read_text(encoding='utf-8')


def test_strategic_timeline_is_hidden_in_explore_and_tour_modes():
    html = _html()
    assert 'body[data-mode="climate"] #strategicTimeline { display: none; }' in html
    assert 'body[data-mode="tour"] #strategicTimeline { display: block; }' not in html


def test_main_pane_no_longer_reserves_timeline_height_in_climate_mode():
    html = _html()
    assert 'height: calc(100vh - var(--wm-strategic-timeline-h, 0px));' not in html


def test_tour_date_controls_remain_in_sidebar():
    html = _html()
    assert 'id="startDate"' in html
    assert 'id="arrivalDate"' in html
    assert 'id="tourDays"' in html
    assert 'type="date" id="startDate"' in html
    assert 'type="date" id="arrivalDate"' in html


def test_arrival_date_is_derived_with_inclusive_day_semantics():
    source = _source()
    assert "endDate.setUTCDate(endDate.getUTCDate() + totalDays - 1);" in source
    assert "let durationDays = 1 + Math.round((arrivalDate.getTime() - startDate.getTime()) / 86400000);" in source
    assert "if (!Number.isFinite(durationDays) || durationDays < 1) durationDays = 1;" in source


def test_arrival_change_updates_duration_and_syncs_slider():
    source = _source()
    assert "arrivalDateInput.addEventListener('change', () => {" in source
    assert "try { _tourApplyArrivalDateInput(); } catch (_) {}" in source
    assert "tourDaysInput.value = String(durationDays);" in source
    assert "_syncSingleSliderField(field);" in source
