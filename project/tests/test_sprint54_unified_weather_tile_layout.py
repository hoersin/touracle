from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
MAP_JS = BASE_DIR / 'frontend' / 'map.js'


def _js() -> str:
    return MAP_JS.read_text(encoding='utf-8')


def test_endpoint_marker_uses_weekday_only_label():
    source = _js()
    assert "function _createRouteEndpointMarker(lat, lon, type, labelDateISO)" in source
    assert "${_weekdayShort(labelDateISO)}</div>" in source
    assert "${_weekdayShort(labelDateISO)} ${_dayMonthShort(labelDateISO)}" not in source


def test_route_weather_station_card_date_uses_weekday_only():
    source = _js()
    assert "if (props && props.date) return _weekdayShort(String(props.date));" in source


def test_tour_route_day_card_date_label_returns_weekday_only():
    source = _js()
    assert "function _tourRouteDayCardDateLabel(dayIdx)" in source
    assert "return _weekdayShort(d.toISOString().slice(0, 10));" in source


def test_profile_draws_day_label_date_and_good_weather_symbol_per_day():
    """The profile window replaced the per-day weather tiles (temperature, icon, rain) by
    a day header: day label, date and a large symbol for good-weather days only; the
    daily weather itself is drawn in the chart (precipitation bars, wind strip)."""
    source = _js()
    assert "function _drawTourProfileDayMarkers(" not in source
    assert "function _pwDrawDayHeaders(model, xAt, geo, view)" in source
    assert "i18nT('tourbook.day', { n: d.n })" in source
    assert "_fmtIsoDayMonthCompact(d.dateIso)" in source
    assert "if (d.favourable) {" in source
    assert "const PW_FAVOURABLE = { sunny: 'pw.fav.sunny', partly_cloudy: 'pw.fav.partly' };" in source
    assert "mapWeatherByProb(rainProb)" in source


def test_profile_calendar_format_helpers_exist():
    source = _js()
    assert "function _weekdayMonthDayShort(dateIso)" in source
    assert "weekday: 'short'," in source
    assert "month: 'short'," in source
    assert "day: 'numeric'," in source
    assert "function _yearFromIso(dateIso)" in source
