from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'


def _source() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def test_forecast_days_beyond_horizon_are_marked_unavailable_before_sampling():
    source = _source()
    assert 'function _tourForecastDayUnavailable(dayIdx)' in source
    assert 'const forecastUnavailable = _tourForecastDayUnavailable(dayIdx);' in source
    assert 'if (forecastUnavailable || (knownForecastWindow && !backendDaySummary)) {' in source
    assert 'out.push(_tourRouteFallbackEntry(dayIdx, startDist, endDist, midDist));' in source


def test_forecast_horizon_prefers_backend_last_summary_date():
    source = _source()
    assert 'const summaries = Array.isArray(LAST_TOUR_DAY_SUMMARIES) ? LAST_TOUR_DAY_SUMMARIES : [];' in source
    assert ".map((entry) => (entry && typeof entry.date === 'string') ? String(entry.date).slice(0, 10) : '')" in source
    assert 'if (dated.length) return dated[dated.length - 1];' in source


def test_route_and_roadbook_cards_use_null_safe_numeric_checks():
    source = _source()
    assert 'function _finiteOrNull(value)' in source
    assert 'const tempC = _finiteOrNull(info.tempC);' in source
    assert 'const rainMm = _finiteOrNull(info.rainMm);' in source
    assert 'const windMs = _finiteOrNull(info.windMs);' in source
    assert 'const forecastUnavailable = _tourForecastDayUnavailable(info.dayIdx);' in source
    assert 'noData: forecastUnavailable || (!Number.isFinite(tempC) && !Number.isFinite(rainMm) && !Number.isFinite(windMs))' in source
    assert 'if (_tourForecastDayUnavailable(slotIdx)) {' in source
    assert 'const fallbackTemp = fallbackEntry ? _finiteOrNull(fallbackEntry.tempC) : null;' in source
    assert 'const fallbackRain = fallbackEntry ? _finiteOrNull(fallbackEntry.rainMm) : null;' in source
    assert 'const fallbackWind = fallbackEntry ? _finiteOrNull(fallbackEntry.windMs) : null;' in source


def test_profile_day_markers_also_blank_out_beyond_horizon_forecast_days():
    source = _source()
    assert 'const forecastUnavailable = _tourForecastDayUnavailable(dayIdx);' in source
    assert 'const tMed = forecastUnavailable' in source
    assert 'const rainMm = forecastUnavailable' in source
    assert "const iconClass = Number.isFinite(rainProb) ? mapWeatherByProb(rainProb) : 'cloudy';" in source


def test_no_data_card_uses_two_line_label():
    source = _source()
    assert 'No<br>data' in source
