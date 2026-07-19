from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def test_req43_tour_plan_is_serializable_and_weather_free():
    source = _source()
    assert 'function serializeTourPlan(plan = TOUR_PLAN)' in source
    assert 'function deserializeTourPlan(raw)' in source
    assert 'roadbook: {' in source
    assert 'days: Array.isArray(src.roadbook && src.roadbook.days)' in source
    assert 'weather:' not in source[source.index('function serializeTourPlan(plan = TOUR_PLAN)'):source.index('function deserializeTourPlan(raw)')]


def test_req44_lifecycle_helpers_exist():
    source = _source()
    assert 'function createTourPlan(overrides = {})' in source
    assert 'function updateTourPlan(updater)' in source
    assert 'function cloneTourPlan(sourcePlan, options = {})' in source


def test_req45_route_separation_validation_exists():
    source = _source()
    assert 'function _validateTourPlanRouteSeparation(plan)' in source
    assert "Route geometry leaked into day state" in source


def test_req46_validation_helpers_exist():
    source = _source()
    assert 'function validateRoadbook(days)' in source
    assert 'function validateDaySequence(days)' in source
    assert 'function validateRestDays(days)' in source


def test_req47_legacy_adapters_removed():
    source = _source()
    assert 'function legacyRoadbookViewModel()' not in source
    assert 'function legacyWeatherViewModel()' not in source


def test_req48_schema_version_present():
    source = _source()
    assert 'schemaVersion: 1,' in source


def test_req49_selectors_exist():
    source = _source()
    assert 'function getRideDays(plan = TOUR_PLAN)' in source
    assert 'function getRestDays(plan = TOUR_PLAN)' in source
    assert 'function getAffectedDays(fromRef, plan = TOUR_PLAN)' in source
    assert 'function getDayById(dayKey, plan = TOUR_PLAN)' in source


def test_req50_snapshot_uses_serialized_tour_plan():
    source = _source()
    assert 'tourPlan: serializeTourPlan(TOUR_PLAN),' in source
    assert 'TOUR_PLAN = deserializeTourPlan(snapshot.tourPlan);' in source
