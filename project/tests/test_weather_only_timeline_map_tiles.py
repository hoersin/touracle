from pathlib import Path


FRONTEND_MAP_JS = Path(__file__).resolve().parents[1] / 'frontend' / 'map.js'


def test_weather_only_force_restart_keeps_existing_route_day_cards_visible():
    source = FRONTEND_MAP_JS.read_text(encoding='utf-8')
    assert 'if (!weatherOnly) {' in source
    assert 'try { _clearTourRouteDayCards(); } catch (_) {}' in source
    assert 'Weather-only refresh should keep currently visible map weather cards' in source


def test_weather_only_station_stream_progressively_refreshes_route_day_cards():
    source = FRONTEND_MAP_JS.read_text(encoding='utf-8')
    assert 'if (weatherOnly && LAST_PROFILE && (completed === total || completed % 5 === 0)) {' in source
    assert '_renderTourRouteDayCards(LAST_PROFILE);' in source


def test_route_day_cards_have_route_length_fallback_when_profile_missing():
    source = FRONTEND_MAP_JS.read_text(encoding='utf-8')
    assert 'let p = profile || LAST_PROFILE;' in source
    assert 'if (!p) {' in source
    assert 'const routeLen = (Array.isArray(ROUTE_CUM_DISTS) && ROUTE_CUM_DISTS.length >= 2)' in source
    assert 'sampled_dist_km: [0, routeLen]' in source
    assert 'total_distance_km: routeLen' in source


def test_route_day_cards_do_not_clear_existing_layer_on_empty_intermediate_entries():
    source = FRONTEND_MAP_JS.read_text(encoding='utf-8')
    marker = 'function _renderTourRouteDayCards(profile) {'
    start = source.index(marker)
    end = source.index('function _routeNormalOffsetPx', start)
    fn_body = source[start:end]
    assert 'const entries = _tourRouteDayCardEntries(profile);' in fn_body
    assert 'if (!entries.length) return;' in fn_body
    assert '_clearTourRouteDayCards();' in fn_body
    assert fn_body.index('if (!entries.length) return;') < fn_body.index('_clearTourRouteDayCards();')


def test_day_summary_numeric_parsing_ignores_empty_and_boolean_values():
    source = FRONTEND_MAP_JS.read_text(encoding='utf-8')
    assert "value === null || value === undefined || value === '' || typeof value === 'boolean'" in source
    assert "raw === null || raw === undefined || raw === '' || typeof raw === 'boolean'" in source
