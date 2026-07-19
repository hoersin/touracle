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


def test_profile_draws_three_line_calendar_block_below_weather_tile():
    source = _js()
    assert "const calDayY = stackTop + 66;" in source
    assert "const calDateY = stackTop + 78;" in source
    assert "const calYearY = stackTop + 89;" in source
    assert "profileCtx.fillText(`Day ${dayIdx + 1}`, x, calDayY);" in source
    assert "profileCtx.fillText(calendarDateLabel || '—', x, calDateY);" in source
    assert "profileCtx.fillText(calendarYearLabel || '', x, calYearY);" in source


def test_profile_calendar_format_helpers_exist():
    source = _js()
    assert "function _weekdayMonthDayShort(dateIso)" in source
    assert "weekday: 'short'," in source
    assert "month: 'short'," in source
    assert "day: 'numeric'," in source
    assert "function _yearFromIso(dateIso)" in source
