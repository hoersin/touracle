from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def test_req35_central_tour_plan_object_exists():
    source = _source()
    assert "let TOUR_PLAN = {" in source
    assert "id: 'tour-plan-local'" in source
    assert "roadbook:" in source
    assert "settings:" in source
    assert "metadata:" in source


def test_req36_weather_mode_union_documented():
    source = _source()
    assert "@typedef {'forecast'|'historical-year'|'historical-median'} WeatherMode" in source
    assert "function _normalizeWeatherMode(value)" in source


def test_req37_weather_context_exists():
    source = _source()
    assert "let WEATHER_CONTEXT = {" in source
    assert "mode: 'historical-median'" in source
    assert "historicalYear:" in source
    assert "forecastStartDate:" in source


def test_req38_roadbook_state_owned_by_tour_plan():
    source = _source()
    assert "ROADBOOK_STATE = TOUR_PLAN.roadbook.state;" in source
    assert "function _syncTourPlanStateAlias()" in source


def test_req39_boundaries_synced_to_tour_plan():
    source = _source()
    assert "TOUR_PLAN.roadbook.boundariesKm = committed.slice();" in source
    assert "const preferred = Array.isArray(TOUR_PLAN && TOUR_PLAN.roadbook && TOUR_PLAN.roadbook.boundariesKm)" in source


def test_req40_existing_paths_still_use_legacy_mode_accessor():
    source = _source()
    assert "function getTourWeatherMode()" in source
    assert "return _legacyWeatherModeFromContext(WEATHER_CONTEXT && WEATHER_CONTEXT.mode);" in source


def test_req41_weather_is_derived_not_persisted_in_tour_plan_days():
    source = _source()
    assert "function _persistRoadbookDaysToTourPlan(days)" in source
    assert "const days = planDays.map((day) => ({ ...day, weather: _deriveRoadbookDayWeather(day, rideEntries) }));" in source


def test_req42_shared_roadbook_adapter_exists_across_modes():
    source = _source()
    assert "function legacyRoadbookViewModel()" in source
    assert "function legacyWeatherViewModel()" in source
    assert "mode: getTourWeatherContextMode()," in source


def test_snapshot_persists_new_architecture_objects():
    source = _source()
    assert "tourPlan: TOUR_PLAN && typeof TOUR_PLAN === 'object' ? TOUR_PLAN : null," in source
    assert "weatherContext: WEATHER_CONTEXT && typeof WEATHER_CONTEXT === 'object' ? WEATHER_CONTEXT : null," in source


def test_start_date_propagates_into_tour_plan_settings():
    source = _source()
    assert "TOUR_PLAN.settings.startDate = startDateInput && startDateInput.value ? String(startDateInput.value) : null;" in source
