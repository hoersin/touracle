from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'
INDEX_HTML = BASE_DIR / 'frontend' / 'index.html'
APP_PY = BASE_DIR / 'backend' / 'app.py'


def _js() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def _html() -> str:
    return INDEX_HTML.read_text(encoding='utf-8')


def _py() -> str:
    return APP_PY.read_text(encoding='utf-8')


def test_project_format_constants_exist():
    source = _js()
    assert "const TOUR_PROJECT_FORMAT_KEY = 'touracle-tour-project';" in source
    assert "const TOUR_PROJECT_FORMAT_VERSION = 1;" in source
    assert "const TOUR_PROJECT_SCHEMA_VERSION = 1;" in source


def test_project_payload_includes_gpx_and_all_plans():
    source = _js()
    assert "async function _tourProjectFilePayload()" in source
    assert "tourPlans: plansById," in source
    assert "gpx: gpx || {" in source
    assert "activePlanId," in source


def test_legacy_tourplan_loader_bridge_exists():
    source = _js()
    assert "function _tourProjectPayloadFromLegacy(parsed)" in source
    assert "const legacyPlan = (source.tourPlan" in source


def test_sidebar_has_project_centric_commands():
    html = _html()
    assert 'id="tourProjectPanel"' in html
    assert 'id="tourProjectNewBtn"' in html
    assert 'id="tourProjectOpenBtn"' in html
    assert 'id="tourProjectSaveBtn"' in html
    assert 'id="tourProjectSaveAsBtn"' in html
    assert 'id="tourProjectImportGpxBtn"' in html
    assert 'id="tourProjectReplaceGpxBtn"' in html
    assert 'id="tourProjectExportGpxBtn"' in html


def test_open_picker_accepts_tour_extension():
    html = _html()
    assert 'accept=".tour,.json,application/json"' in html


def test_backend_supports_embedded_gpx_roundtrip():
    source = _py()
    assert "@app.route('/api/gpx_content', methods=['GET'])" in source
    assert "@app.route('/api/upload_gpx_text', methods=['POST'])" in source


def test_project_status_indicator_is_updated_from_dirty_state():
    source = _js()
    assert "function _setProjectStatusUi(isDirty)" in source
    assert "_setProjectStatusUi(TOUR_PLAN_IS_DIRTY);" in source


def test_project_dirty_watchers_cover_key_controls():
    source = _js()
    assert "function _bindProjectDirtyWatchers()" in source
    assert "setActiveHourStart" in source
    assert "setActiveHourEnd" in source
    assert "tourWeatherModeSelect" in source
    assert "reverseCheck" in source
