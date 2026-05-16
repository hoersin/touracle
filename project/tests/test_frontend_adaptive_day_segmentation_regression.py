from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def test_segmentation_state_and_snapshot_fields_exist():
    source = _source()
    assert 'let TOUR_SEGMENTATION_STATE = {' in source
    assert 'let TOUR_DRAG_STATE = {' in source
    assert 'segmentationBoundariesKm:' in source
    assert 'TOUR_SEGMENTATION_STATE.boundariesKm = Array.isArray(snapshot.segmentationBoundariesKm)' in source


def test_profile_drag_handlers_and_boundary_hit_testing_exist():
    source = _source()
    assert 'const TOUR_BOUNDARY_HIT_PX = 12;' in source
    assert 'function _tourBoundaryMarkerHit(profile, clientX, clientY)' in source
    assert 'const handleDragMove = (e) => {' in source
    assert 'const handleDragEnd = () => {' in source
    assert 'const handleDown = (e) => {' in source
    assert "el.addEventListener('pointerdown', handleDown);" in source


def test_drag_preview_stays_light_and_commit_rebuilds_summaries_once():
    source = _source()
    assert 'if (dragging || !customSegmentation) {' in source
    assert 'function _tourQueueSegmentationPreviewRender() {' in source
    assert "try { _renderRoadbookPanel(); } catch (_) {}" in source
    assert "try { _scheduleProfileRedraw(); } catch (_) {}" in source
    assert 'function _tourCommitSegmentation(profile) {' in source
    assert 'const daySummaries = _tourBuildClientDaySummaries(p);' in source
    assert 'try { renderTourSummary(nextSummary); } catch (_) {}' in source


def test_profile_boundary_pins_are_rendered_from_segmentation_model():
    source = _source()
    assert 'function _drawTourSegmentationBoundaryPins(profile, xAt, padTop, innerH, axisLen) {' in source
    assert 'const markers = _tourBoundaryMarkerData(profile, { includeDrag: true });' in source
    assert '_drawTourSegmentationBoundaryPins(profile, xAt, padTop, innerH, axisLen);' in source
