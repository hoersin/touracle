from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'
INDEX_HTML = BASE_DIR / 'frontend' / 'index.html'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def _html() -> str:
    return INDEX_HTML.read_text(encoding='utf-8')


def test_req51_tour_plan_list_ui_exists():
    html = _html()
    assert 'id="tourPlanManageBtn"' in html
    assert 'id="tourPlanManager"' in html
    assert 'id="tourPlanList"' in html
    assert 'id="tourPlanDirty"' in html


def test_req52_save_current_tour_plan_overwrites_existing_id():
    source = _source()
    assert 'function _saveCurrentTourPlan()' in source
    assert "const activeId = String(ACTIVE_TOUR_PLAN_ID || normalized.id || '').trim();" in source
    assert 'if (activeId && activeId !== normalized.id) normalized.id = activeId;' in source


def test_req53_load_tour_plan_restores_boundaries_and_start_date():
    source = _source()
    assert 'function _tourPlanApplyLoadedEntry(entry)' in source
    assert 'TOUR_SEGMENTATION_STATE.boundariesKm = Array.isArray(loaded && loaded.roadbook && loaded.roadbook.boundariesKm)' in source
    assert 'if (startDateInput && startIso) startDateInput.value = startIso;' in source


def test_req54_duplicate_tour_plan_action_exists():
    source = _source()
    assert "if (action === 'duplicate')" in source
    assert 'const copy = cloneTourPlan(entry.plan' in source


def test_req55_rename_tour_plan_action_exists():
    source = _source()
    assert "if (action === 'rename')" in source
    assert 'TourPlanStorageService.renameTourPlan(planId' in source


def test_req56_delete_requires_confirmation_and_fallback_guard():
    source = _source()
    assert "if (action === 'delete')" in source
    assert "if (!confirm('Delete this TourPlan?')) return;" in source
    assert "if (isActive && plansNow.length <= 1)" in source


def test_req57_autosave_debounce_present():
    source = _source()
    assert 'const TOUR_PLAN_AUTOSAVE_DEBOUNCE_MS = 1800;' in source
    assert 'function _queueTourPlanAutosave()' in source
    assert '_saveCurrentTourPlan();' in source


def test_req58_dirty_state_tracking_present():
    source = _source()
    assert 'let TOUR_PLAN_IS_DIRTY = false;' in source
    assert 'function _setTourPlanDirty(flag)' in source
    assert 'function _markTourPlanChanged()' in source


def test_req59_storage_service_api_exists():
    source = _source()
    assert 'const TourPlanStorageService = {' in source
    assert 'saveTourPlan(plan, weatherContext, options = {})' in source
    assert 'loadTourPlan(id)' in source
    assert 'deleteTourPlan(id)' in source
    assert 'listTourPlans()' in source


def test_req60_serialization_safety_functions_still_used():
    source = _source()
    assert 'tourPlan: serializeTourPlan(TOUR_PLAN),' in source
    assert 'TOUR_PLAN = deserializeTourPlan(snapshot.tourPlan);' in source


def test_req61_load_retriggers_render_and_commit_paths():
    source = _source()
    assert 'if (_tourIsActive() && LAST_PROFILE) _tourCommitSegmentation(LAST_PROFILE);' in source
    assert '_renderRoadbookPanel();' in source
    assert '_roadbookRefreshLinkedViews();' in source


def test_req62_boot_behavior_loads_active_or_creates_default():
    source = _source()
    assert 'function _bootTourPlanPersistence()' in source
    assert 'const storedActiveId = (() => {' in source
    assert 'const defaultPlan = createTourPlan({' in source
    assert 'try { _bootTourPlanPersistence(); } catch (_) {}' in source
