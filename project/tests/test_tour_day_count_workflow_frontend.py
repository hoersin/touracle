from pathlib import Path


MAP_JS = Path(__file__).resolve().parents[1] / 'frontend' / 'map.js'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def test_day_count_workflow_prefers_committed_stage_state_over_slider_value():
    source = _source()
    assert "const persistedBoundaryRideCount = Array.isArray(TOUR_PLAN && TOUR_PLAN.roadbook && TOUR_PLAN.roadbook.boundariesKm)" in source
    assert "const preferredCurrentRideCount = Math.max(1, Math.round(Number(opts && opts.previousRideCount) || 0));" in source
    assert "persistedBoundaryRideCount\n          || boundariesRideCount\n          || preferredCurrentRideCount" in source


def test_day_count_apply_keeps_slider_in_sync_after_boundary_update():
    source = _source()
    assert "const field = tourDaysInput ? tourDaysInput.closest('[data-slider-field=\"single\"]') : null;" in source
    assert "_syncSingleSliderField(field);" in source


def test_day_change_handler_uses_committed_ride_count_as_previous_days():
    source = _source()
    assert "const previousDays = (() => {" in source
    assert "if (Array.isArray(TOUR_PLAN && TOUR_PLAN.roadbook && TOUR_PLAN.roadbook.boundariesKm)) {" in source
    assert "if (Array.isArray(TOUR_SEGMENTATION_STATE && TOUR_SEGMENTATION_STATE.boundariesKm)) {" in source


def test_day_count_apply_has_consistency_fallback_to_set_requested_count():
    source = _source()
    assert "if (postRideCount !== targetRideCount) {" in source
    assert "_tourBookSetRideCount(targetRideCount, {" in source


def test_day_change_handler_reverts_to_previous_days_when_workflow_not_applied():
    source = _source()
    assert "const fallbackRideDays = Math.max(1, Math.round(Number(previousDays) || 1));" in source


def test_tour_duration_slider_input_does_not_bypass_workflow_dialog():
    source = _source()
    assert "if (input !== tourDaysInput) _scheduleLiveSettingsApply();" in source
