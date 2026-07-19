from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def test_req17_pin_discoverability_visual_enhancements():
    """REQ17: Enhanced pin visuals with hover/drag effects."""
    source = _source()
    assert 'const isHovered = TOUR_PIN_HOVER_ID === String(marker.id || \'\');' in source
    assert 'const isDragging = !!TOUR_DRAG_STATE && TOUR_DRAG_STATE.activeBoundaryId === String(marker.id || \'\');' in source
    assert 'const pinSize = isHovered || isDragging ? basePinSize + 1.5 : basePinSize;' in source
    assert 'if (isHovered || isDragging) {' in source
    assert 'profileCtx.arc(x, knobY, pinSize + 2, 0, Math.PI * 2);' in source
    assert 'if (active || isHovered || isDragging) {' in source


def test_req18_cursor_feedback_on_hover_and_drag():
    """REQ18: Cursor changes to ew-resize on hover, grabbing during drag."""
    source = _source()
    assert 'profileCanvas.style.cursor = \'ew-resize\';' in source
    assert 'profileCanvas.style.cursor = \'grabbing\';' in source
    assert 'profileCanvas.style.cursor = \'default\';' in source
    assert 'let TOUR_PIN_HOVER_ID = null;' in source


def test_req19_live_map_highlighting_during_drag():
    """REQ19: Map segment highlighting when dragging a boundary."""
    source = _source()
    assert 'let TOUR_DRAG_DISPLAY_SEGMENT = null;' in source
    assert 'TOUR_DRAG_DISPLAY_SEGMENT = { startKm: dragStartKm, endKm: dragEndKm };' in source
    assert 'if (TOUR_DRAG_DISPLAY_SEGMENT) {' in source
    assert 'activeRideDay = TOUR_DRAG_DISPLAY_SEGMENT;' in source
    assert 'TOUR_DRAG_DISPLAY_SEGMENT = null;' in source


def test_req20_profile_active_segment_highlighting():
    """REQ20: Profile shows active/selected segment highlight."""
    source = _source()
    assert 'function _drawTourActiveDragSegmentHighlight(profile, xAt, padTop, innerH, axisLen)' in source
    assert 'const segment = TOUR_DRAG_DISPLAY_SEGMENT || _roadbookActiveRideDay();' in source
    assert 'profileCtx.fillStyle = \'rgba(15, 118, 110, 0.08)\';' in source
    assert '_drawTourActiveDragSegmentHighlight(profile, xAt, padTop, innerH, axisLen);' in source


def test_req21_weather_only_on_drag_end():
    """REQ21: Weather updates only after drag end, not during drag."""
    source = _source()
    # During drag: points use old assigned indices (no weather recompute)
    assert 'if (dragging || !customSegmentation) {' in source
    # On drag end: commit happens in handleDragEnd
    assert 'const handleDragEnd = () => {' in source
    assert '_tourCommitSegmentation(LAST_PROFILE);' in source
    # Weather cleared when drag ends
    assert 'TOUR_DRAG_DISPLAY_SEGMENT = null;' in source


def test_req22_partial_weather_recalculation():
    """REQ22: Rebuild weather efficiently without full recomputation."""
    source = _source()
    # Uses existing pipeline and client-side aggregation
    assert 'function _tourCommitSegmentation(profile)' in source
    assert 'const daySummaries = _tourBuildClientDaySummaries(p);' in source
    assert 'function _tourBuildClientDaySummaries(profile)' in source
    # No API calls during commit (uses OVERLAY_POINTS)
    assert 'const routePoints = Array.isArray(OVERLAY_POINTS) ? OVERLAY_POINTS : [];' in source
    # Comment documents REQ21-22 behavior
    assert 'REQ21-22: Rebuild weather summaries from committed boundaries' in source


def test_all_refinement_states_properly_initialized():
    """Verify all new state variables are declared."""
    source = _source()
    assert 'let TOUR_PIN_HOVER_ID = null;' in source
    assert 'let TOUR_DRAG_DISPLAY_SEGMENT = null;' in source


def test_hover_and_drag_cleared_on_drag_end():
    """Verify hover and drag display states are reset on drag end."""
    source = _source()
    assert 'TOUR_PIN_HOVER_ID = null;' in source
    assert 'TOUR_DRAG_DISPLAY_SEGMENT = null;' in source
    assert 'profileCanvas.style.cursor = \'default\';' in source


def test_drag_end_keeps_dragged_segment_selected():
    """After drag end, dragged segment remains selected/active."""
    source = _source()
    assert 'const draggedDayKey = `ride-${Math.max(0, Number(TOUR_DRAG_STATE.boundaryIndex) || 0)}`;' in source
    assert "_setSelectedTourDay(draggedDayKey, { forceMapFit: true });" in source


def test_profile_click_selects_segment():
    """Clicking inside a profile day segment selects the corresponding roadbook day."""
    source = _source()
    assert 'function _tourDayKeyAtProfileClientPoint(profile, clientX, clientY, options = {})' in source
    assert 'const selectedDayKey = _tourDayKeyAtProfileClientPoint(LAST_PROFILE, e && e.clientX, e && e.clientY, { includeDrag: true });' in source
    assert '_roadbookSelectDay(selectedDayKey);' in source


def test_selected_tour_day_single_source_helpers_exist():
    source = _source()
    assert 'let SELECTED_TOUR_DAY_KEY = null;' in source
    assert 'function _getSelectedTourDayKey()' in source
    assert 'function _setSelectedTourDay(dayKey, opts = {})' in source
    assert 'SELECTED_TOUR_DAY_KEY = key;' in source
    assert '_fitSelectedTourDayOnMap(key, { animate: true });' in source


def test_roadbook_hover_is_visual_only_and_click_selects():
    source = _source()
    assert "hoverDayId: null" in source
    assert "ROADBOOK_STATE.hoverDayId = nextKey || null;" in source
    assert "_roadbookSyncCardSelectionUi();" in source
    assert "card.addEventListener('click', () => { _roadbookSelectDay(dayKey); });" in source
    assert "card.addEventListener('mouseenter', () => { _roadbookSetHoverDay(dayKey); });" in source


def test_drag_tooltip_shows_day_km_and_hm_on_second_line():
    """Dragging tooltip should include day distance/elevation on a second line."""
    source = _source()
    assert 'if (isDragging) {' in source
    assert 'const seg = _tourSegmentRange(profile, marker.prevRideIdx, { includeDrag: true });' in source
    assert 'line2 = `${fmt(dayKm, 0)} km • ${fmt(dayHmSafe, 0)} hm`;' in source
    assert 'const boxH = line2 ? 30 : 18;' in source
    assert 'if (line2) {' in source
    assert 'profileCtx.fillText(line2, boxX + textW / 2, boxY + 21);' in source
