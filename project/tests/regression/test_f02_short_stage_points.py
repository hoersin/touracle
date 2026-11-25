"""F-02: points added for short stages keep true distance, day and date."""
import datetime as dt

import pytest
import synthetic as syn

CASES = [(420, 14, 60), (420, 10, 100), (300, 7, 60), (180, 9, 60)]  # km, days, step


@pytest.fixture(params=CASES, ids=lambda c: f'{c[0]}km-{c[1]}d-step{c[2]}')
def case(request, tmp_path, stream):
    km, days, step = request.param
    return km, days, stream(syn.write_gpx(tmp_path / 'r.gpx', km), step_km=step, days=days)


def test_reported_distance_equals_true_position_on_route(case):
    km, _days, r = case
    for p, lon in zip(r.props, r.lons):
        assert p['distance_from_start_km'] == pytest.approx(syn.km_at_lon(lon), abs=0.5)


def test_cumulative_distance_is_monotonic_and_spans_route(case):
    km, _days, r = case
    d = [p['distance_from_start_km'] for p in r.props]
    assert d == sorted(d)
    assert d[0] == pytest.approx(0) and d[-1] == pytest.approx(km, abs=0.5)


def test_regular_samples_keep_their_distances_when_points_are_inserted(tmp_path, stream):
    gpx = syn.write_gpx(tmp_path / 'r.gpx', 420)
    before = stream(gpx, step_km=60, days=1)          # nothing needs inserting
    after = stream(gpx, step_km=60, days=14)          # 30 km stages
    assert len(after.props) > len(before.props)
    by_lon = {round(l, 6): p['distance_from_start_km'] for p, l in zip(after.props, after.lons)}
    for p, lon in zip(before.props, before.lons):
        assert by_lon[round(lon, 6)] == pytest.approx(p['distance_from_start_km'], abs=0.01)


def test_every_day_has_weather(case):
    _km, days, r = case
    assert {p['tour_day_index'] for p in r.props} == set(range(days))
    assert [d['day_index'] for d in r.summary['day_summaries']] == list(range(days))


def test_day_and_date_follow_true_position(case):
    km, days, r = case
    stage = km / days
    for p, lon in zip(r.props, r.lons):
        pos = syn.km_at_lon(lon)
        allowed = {min(days - 1, max(0, int((pos + e) // stage))) for e in (-0.05, 0.05)}  # either side of a boundary
        assert p['tour_day_index'] in allowed, (pos, p['tour_day_index'])
        day = syn.START + dt.timedelta(days=p['tour_day_index'])
        assert p['date'] == day.isoformat()
        assert p['temp_day_median'] == pytest.approx(syn.temp_on(day))


def test_stations_agree_with_profile_stage_boundaries(case):
    km, days, r = case
    b = [x['distance_km'] for x in r.profile['day_boundaries']]
    assert b == pytest.approx([km / days * k for k in range(1, days)], abs=0.5)
    edges = [0.0, *b, km]
    for p in r.props:
        lo, hi = edges[p['tour_day_index']], edges[p['tour_day_index'] + 1]
        assert lo - 0.5 <= p['distance_from_start_km'] <= hi + 0.5


def test_announced_total_matches_emitted_stations(case):
    _km, _days, r = case
    assert r.route['total'] == len(r.stations)
    assert all(s['completed'] <= s['total'] for s in r.stations)


def test_reverse_direction_keeps_distance_day_and_date(tmp_path, stream):
    r = stream(syn.write_gpx(tmp_path / 'r.gpx', 420), step_km=60, days=14, reverse=1)
    assert {p['tour_day_index'] for p in r.props} == set(range(14))
    for p, lon in zip(r.props, r.lons):
        assert p['distance_from_start_km'] == pytest.approx(420 - syn.km_at_lon(lon), abs=0.5)
        assert p['temp_day_median'] == pytest.approx(syn.temp_on(dt.date.fromisoformat(p['date'])))


@pytest.mark.parametrize('weather_only', [0, 1])
def test_weather_only_refresh_uses_the_same_assignment(tmp_path, stream, weather_only):
    r = stream(syn.write_gpx(tmp_path / 'r.gpx', 300), step_km=60, days=7, weather_only=weather_only)
    assert {p['tour_day_index'] for p in r.props} == set(range(7))
    for p, lon in zip(r.props, r.lons):
        assert p['distance_from_start_km'] == pytest.approx(syn.km_at_lon(lon), abs=0.5)


def test_tourbook_shows_weather_and_length_for_every_short_stage(ui):
    ui.open()
    ui.tour()
    ui.import_gpx(syn.write_gpx(ui.backend.tmp / 'short.gpx', 168))  # 7 x 24 km, default step 60
    cards = ui.cards()
    assert [c['kind'] for c in cards] == ['ride'] * 7
    assert [c['stage'].split(' km')[0] for c in cards] == ['24'] * 7
    for i, c in enumerate(cards):
        t = syn.temp_on(syn.START + dt.timedelta(days=i))
        assert c['weather'].startswith(f'{round(t)}°C'), (i, c['weather'])
        assert 'NO DATA' not in c['tile']
