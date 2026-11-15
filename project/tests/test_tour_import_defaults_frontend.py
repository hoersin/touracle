from pathlib import Path


MAP_JS = Path(__file__).resolve().parents[1] / 'frontend' / 'map.js'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def test_import_defaults_constants_and_helpers_exist():
    source = _source()
    assert "const TOUR_IMPORT_DEFAULT_START_DATE = '2026-06-01';" in source
    assert "const TOUR_IMPORT_DEFAULT_DAYS = 7;" in source
    assert "function _applyTourImportDefaults()" in source
    assert "function _resetTourPlanForImportedGpx()" in source
    assert "function _refreshAfterGpxImport()" in source


def test_import_defaults_apply_start_date_and_days():
    source = _source()
    assert "startDateInput.value = TOUR_IMPORT_DEFAULT_START_DATE;" in source
    assert "tourDaysInput.value = String(TOUR_IMPORT_DEFAULT_DAYS);" in source
    assert "_tourSyncArrivalInputFromInputs();" in source


def test_import_refresh_pipeline_restarts_weather_map_flow():
    source = _source()
    assert "_tourBookRefreshAll({ skipDirtyClear: true });" in source
    assert "_resetTourRouteDisplay('Loading route + profile…');" in source
    assert "applyPrefsFromFormAndPersist();" in source
    assert "loadMap({ ...(LAST_LOAD_OPTS || {}), forceRestart: true, gpxJustUploaded: true });" in source


def test_both_gpx_import_paths_use_same_defaults_and_refresh_pipeline():
    source = _source()
    assert source.count("_applyTourImportDefaults();") >= 2
    assert source.count("_resetTourPlanForImportedGpx();") >= 2
    assert source.count("_refreshAfterGpxImport();") >= 2
