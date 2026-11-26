from pathlib import Path


FRONTEND_INDEX_HTML = Path(__file__).resolve().parents[1] / 'frontend' / 'index.html'
FRONTEND_MAP_JS = Path(__file__).resolve().parents[1] / 'frontend' / 'map.js'
FRONTEND_EN = Path(__file__).resolve().parents[1] / 'frontend' / 'i18n' / 'en.js'   # UI texts (English reference)


def test_tour_slot_optimizer_controls_present_in_tour_panel():
    html = FRONTEND_INDEX_HTML.read_text(encoding='utf-8')
    assert 'id="tourSlotOptimizeBtn"' in html
    assert 'data-i18n="sim.start"' in html and '"sim.start": "Start simulation"' in FRONTEND_EN.read_text(encoding='utf-8')
    assert 'Simulation run idle.' in html
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
    assert 'border-color: rgba(15,118,110,0.24)' in html
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
    assert "i18nMsg('status.sim.appliedSlotFromRefreshStarted'" in source
    assert 'Applied slot: {start} ({dir}) from {curveLabel}. Refresh started.' in FRONTEND_EN.read_text(encoding='utf-8')
    assert "'status.sim.simulationRunComplete'" in source and '"Simulation run complete."' in FRONTEND_EN.read_text(encoding='utf-8')
    assert 'Simulation Run' in source
    assert 'loadMap({ ...(LAST_LOAD_OPTS || {}), weatherOnly: true, forceRestart: true });' in source
    assert "'sim.result.lowerBetter'" in source and "'sim.result.higherBetter'" in source   # score direction
    assert 'year_penalty_curve_bundle' in source
    assert 'wmSlotCurveSvg' in source
    assert "i18nT('sim.chart.apply')" in source
    assert 'year_penalty_curve' in source
    assert "'sim.result.requestedYears'" in source
    assert "'sim.result.usedYears'" in source
