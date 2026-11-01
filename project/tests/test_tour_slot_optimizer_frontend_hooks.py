from pathlib import Path


FRONTEND_INDEX_HTML = Path(__file__).resolve().parents[1] / 'frontend' / 'index.html'
FRONTEND_MAP_JS = Path(__file__).resolve().parents[1] / 'frontend' / 'map.js'


def test_tour_slot_optimizer_controls_present_in_tour_panel():
    html = FRONTEND_INDEX_HTML.read_text(encoding='utf-8')
    assert 'id="tourSlotOptimizeBtn"' in html
    assert 'id="tourSlotObjectiveMode"' not in html
    assert 'id="tourSlotGranularity"' in html
    assert 'id="tourSlotDirectionMode"' in html
    assert 'id="tourSlotHorizonYears"' in html
    assert 'id="tourSlotStatus"' in html
    assert 'id="tourSlotResults"' in html


def test_optimizer_button_uses_green_plan_variants_style_tokens():
    html = FRONTEND_INDEX_HTML.read_text(encoding='utf-8')
    assert '.wm-pref-action-btn.wm-slot-opt-btn' in html
    assert 'background: rgba(15,118,110,0.08);' in html
    assert 'border-color: rgba(15,118,110,0.24);' in html
    assert 'color: #0f766e;' in html


def test_tour_slot_optimizer_frontend_calls_backend_endpoints():
    source = FRONTEND_MAP_JS.read_text(encoding='utf-8')
    assert "fetch('/api/tour_slot_optimizer/start'" in source
    assert "`/api/tour_slot_optimizer/result/${encodeURIComponent(TOUR_SLOT_OPTIMIZER_JOB_ID)}`" in source
    assert '_collectTourSlotOptimizerPayload()' in source
    assert "directionMode" in source
    assert "objectiveMode" in source
    assert "slotGranularity" in source
    assert "luckyThresholds" in source
    assert 'Applied slot:' in source
    assert 'Refresh started.' in source
    assert 'loadMap({ ...(LAST_LOAD_OPTS || {}), weatherOnly: true, forceRestart: true });' in source
    assert 'Score semantics: LOWER is better.' in source
    assert 'year_penalty_curve_bundle' in source
    assert 'wmSlotCurveSvg' in source
    assert 'Apply Selected Slot' in source
    assert 'year_penalty_curve' in source
    assert 'Requested years:' in source
    assert 'Years actually used:' in source
