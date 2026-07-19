"""
P2.5 Rest Day Management — frontend regression tests.

Uses the plain string-assertion pattern: assert 'literal JS code string' in source.
"""
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'
INDEX_HTML = BASE_DIR / 'frontend' / 'index.html'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def _html() -> str:
    return INDEX_HTML.read_text(encoding='utf-8')


# ── REQ26: Day model ─────────────────────────────────────────────────────────

def test_req26_rest_day_type_field_in_build():
    """REQ26: _roadbookBuild emits type='rest' and type='ride' on day objects."""
    source = _source()
    assert "type: 'rest'," in source
    assert "type: 'ride'," in source


def test_req26_rest_day_startKm_equals_endKm():
    """REQ26: Rest days have startKm === endKm (distance is 0)."""
    source = _source()
    assert 'startKm: anchorDist,' in source
    assert 'endKm: anchorDist,' in source
    assert 'distanceKm: 0,' in source


def test_req26_rest_day_has_logical_idx():
    """REQ26: Day objects include logicalIdx for date offset calculation."""
    source = _source()
    assert 'logicalIdx,' in source


# ── REQ27: Insert Rest Day ────────────────────────────────────────────────────

def test_req27_insert_zone_html_emitted():
    """REQ27: _renderRoadbookPanel emits insert zone elements between cards."""
    source = _source()
    assert 'wm-roadbook-insert-zone' in source
    assert 'wm-roadbook-insert-btn' in source
    assert 'data-insert-position' in source


def test_req27_insert_zone_at_position_zero():
    """REQ27: An insert zone is always placed before the first card (position 0)."""
    source = _source()
    assert '_insertZoneHtml(0)' in source


def test_req27_insert_after_each_card():
    """REQ27: Insert zones are emitted after every ride and rest card."""
    source = _source()
    assert '_insertZoneHtml(day.rideIdx + 1)' in source
    assert '_insertZoneHtml(day.position)' in source


def test_req27_add_rest_stop_function_exists():
    """REQ27: _roadbookAddRestStop creates a rest stop at the given position."""
    source = _source()
    assert 'function _roadbookAddRestStop(position)' in source
    assert '_roadbookAddRestStop(pos)' in source


def test_req27_insert_zone_css_in_html():
    """REQ27: CSS for insert zone and insert button is present."""
    html = _html()
    assert '.wm-roadbook-insert-zone' in html
    assert '.wm-roadbook-insert-btn' in html


# ── REQ28: Move Rest Day ─────────────────────────────────────────────────────

def test_req28_move_buttons_in_rest_card():
    """REQ28: Rest day card includes ▲/▼ move buttons."""
    source = _source()
    assert 'wm-roadbook-move-btn' in source
    assert "data-dir=\"up\"" in source
    assert "data-dir=\"down\"" in source
    assert "data-rest-position" in source


def test_req28_move_buttons_disabled_at_boundaries():
    """REQ28: Move-up disabled at position 0, move-down disabled at rideCount."""
    source = _source()
    assert 'canMoveUp = day.position > 0' in source
    assert 'canMoveDown = day.position < rideCount' in source
    assert "canMoveUp ? '' : ' disabled'" in source
    assert "canMoveDown ? '' : ' disabled'" in source


def test_req28_move_rest_stop_function_exists():
    """REQ28: _roadbookMoveRestStop exists and is called from move button handler."""
    source = _source()
    assert 'function _roadbookMoveRestStop(restId, position)' in source
    assert "_roadbookMoveRestStop(restId, currentPos - 1)" in source
    assert "_roadbookMoveRestStop(restId, currentPos + 1)" in source


def test_req28_move_css_in_html():
    """REQ28: CSS for move buttons is present."""
    html = _html()
    assert '.wm-roadbook-move-btn' in html
    assert '.wm-roadbook-rest-controls' in html


# ── REQ29: Delete Rest Day ────────────────────────────────────────────────────

def test_req29_delete_button_in_rest_card():
    """REQ29: Rest day card includes a delete (×) button."""
    source = _source()
    assert 'wm-roadbook-delete-btn' in source
    assert 'Remove rest day' in source


def test_req29_remove_rest_stop_function_exists():
    """REQ29: _roadbookRemoveRestStop exists and is called from delete handler."""
    source = _source()
    assert 'function _roadbookRemoveRestStop(restId)' in source
    assert '_roadbookRemoveRestStop(restId)' in source


def test_req29_delete_btn_css_in_html():
    """REQ29: CSS for delete button is present."""
    html = _html()
    assert '.wm-roadbook-delete-btn' in html


# ── REQ30: Date Propagation ───────────────────────────────────────────────────

def test_req30_logical_date_iso_uses_logical_idx():
    """REQ30: _roadbookLogicalDateIso offsets start date by logicalIdx."""
    source = _source()
    assert 'function _roadbookLogicalDateIso(dayIndex)' in source
    assert 'd.setUTCDate(d.getUTCDate() + Math.max(0, Math.round(Number(dayIndex) || 0)))' in source


def test_req30_rest_days_increment_logical_idx():
    """REQ30: Each rest day increments logicalIdx so subsequent ride days get shifted dates."""
    source = _source()
    # After pushing a rest day entry, logicalIdx increments before the next ride
    assert 'logicalIdx += 1;' in source


def test_req30_dateIso_used_for_day_state():
    """REQ30: Day date state is derived from logicalIdx-based dateIso."""
    source = _source()
    assert 'dayState: _roadbookDayState(dateIso),' in source
    assert 'dateLabel: dateIso ? _fmtIsoDayMonthCompact(dateIso)' in source


# ── REQ31: Weather Shift ─────────────────────────────────────────────────────

def test_req31_ride_weather_lookup_by_ride_idx():
    """REQ31: Ride day weather is looked up by rideIdx (position), not logicalIdx,
    so weather stays with its correct segment after rest day inserts."""
    source = _source()
    assert 'const days = planDays.map((day) => ({ ...day, weather: _deriveRoadbookDayWeather(day, rideEntries) }));' in source
    assert 'const slot = Number.isFinite(Number(day.rideIdx)) ? Number(day.rideIdx) : Number(day.logicalIdx) || 0;' in source


def test_req31_render_called_after_rest_day_changes():
    """REQ31: _renderRoadbookPanel is called after every rest day mutation."""
    source = _source()
    # _roadbookAddRestStop, _roadbookMoveRestStop, _roadbookRemoveRestStop each call _renderRoadbookPanel
    assert source.count('_renderRoadbookPanel();') >= 3


# ── REQ32: Profile Double-Line Marker ────────────────────────────────────────

def test_req32_profile_double_line_marker_function():
    """REQ32: _drawRoadbookRestDayMarkers draws double-line markers for rest days."""
    source = _source()
    assert 'function _drawRoadbookRestDayMarkers(profile, xAt, padTop, innerH)' in source
    assert 'for (const offset of [-2, 2])' in source


def test_req32_marker_called_during_profile_draw():
    """REQ32: Profile redraw includes rest day markers."""
    source = _source()
    assert '_drawRoadbookRestDayMarkers(profile, xAt, padTop, innerH' in source


# ── REQ33: Interaction Isolation ─────────────────────────────────────────────

def test_req33_rest_operations_only_modify_rest_stops():
    """REQ33: _roadbookAddRestStop only touches persistent rest-stop state, not boundaries."""
    source = _source()
    # The add function must not reference TOUR_SEGMENTATION_STATE
    add_start = source.index('function _roadbookAddRestStop(position)')
    add_end = source.index('function _roadbookMoveRestStop', add_start)
    add_body = source[add_start:add_end]
    assert 'roadbook.restStops' in add_body
    assert 'TOUR_SEGMENTATION_STATE' not in add_body


def test_req33_drag_commit_does_not_touch_rest_stops():
    """REQ33: _tourCommitSegmentation does not modify restStops."""
    source = _source()
    commit_start = source.index('function _tourCommitSegmentation(profile)')
    # Find the end of the function by looking for the next top-level function
    commit_snippet = source[commit_start:commit_start + 2000]
    assert 'restStops' not in commit_snippet


# ── REQ34: Edge Cases ────────────────────────────────────────────────────────

def test_req34_profile_marker_supports_edge_positions():
    """REQ34: Profile marker drawing allows position 0 and rideCount (start/end of tour)."""
    source = _source()
    # The updated guard allows all positions in [0, rideEntries.length]
    assert 'if (position < 0 || position > rideEntries.length) continue; // REQ34' in source


def test_req34_profile_marker_handles_last_entry_endDist():
    """REQ34: Profile marker uses endDist of last ride when rest day is at end of tour."""
    source = _source()
    assert 'position < rideEntries.length ? rideEntries[position] : rideEntries[rideEntries.length - 1]' in source
    assert 'Number(anchorEntry && anchorEntry.endDist)' in source


def test_req34_rest_stop_position_clamped():
    """REQ34: Rest stop positions are clamped to [0, rideCount] in normalize."""
    source = _source()
    assert 'Math.max(0, Math.min(Number.isFinite(Number(rideCount))' in source


# ── Binding ───────────────────────────────────────────────────────────────────

def test_rest_day_controls_binding_function_exists():
    """_roadbookBindRestDayControls binds insert, delete and move events."""
    source = _source()
    assert 'function _roadbookBindRestDayControls()' in source
    assert '_roadbookBindRestDayControls()' in source


def test_rest_day_controls_stop_propagation():
    """Click handlers on rest day controls stop event propagation to prevent card toggle."""
    source = _source()
    bind_start = source.index('function _roadbookBindRestDayControls()')
    bind_end = source.index('\n  function ', bind_start + 10)
    bind_body = source[bind_start:bind_end]
    assert bind_body.count('ev.stopPropagation()') >= 3
