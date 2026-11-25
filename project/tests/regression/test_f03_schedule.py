"""F-03: displayed schedule, weather dates and simulation must agree.

Existing contracts exercised here:
* /api/map_stream:          start_date + total_days, equal consecutive days
* /api/tour_slot_optimizer: totalDays = all calendar days including rest days,
                            restDayIndexes = calendar positions,
                            boundariesKm = one per transition between ride days

* /api/map_stream, optional: boundaries_km = km along the travelled direction,
                            rest_days = calendar positions (0-based);
                            total_days then still counts ride stages
"""
import datetime as dt
import json
import re
import time
from urllib.parse import parse_qs, urlsplit

import pytest
import synthetic as syn
import tour_slot_optimizer as tso
import route_sampling

def day(n):
    return syn.START + dt.timedelta(days=n)


def shown_temp(card):
    m = re.search(r'(-?\d+)°', card['tile'])
    assert m, card
    return int(m.group(1))


def require(condition, message):
    """Precondition of the scenario, reported apart from the checked invariant."""
    if not condition:
        raise RuntimeError(f'precondition failed: {message}')


# --- consecutive days ------------------------------------------------------
def test_consecutive_ride_days_use_consecutive_dates(tmp_path, stream):
    r = stream(syn.write_gpx(tmp_path / 'r.gpx', 420), step_km=30, days=7)
    for d in r.summary['day_summaries']:
        assert d['date'] == day(d['day_index']).isoformat()
        assert d['temp_median'] == pytest.approx(syn.temp_on(day(d['day_index'])))


def test_displayed_dates_and_weather_agree_without_rest_days(steep):
    steep.get_weather()
    cards = steep.cards()
    assert [shown_temp(c) for c in cards] == [steep_temp(day(i)) for i in range(7)]


# --- rest days: displayed calendar ----------------------------------------
def test_rest_day_shifts_displayed_dates_of_following_stages(loaded):
    loaded.add_rest_day(2)
    cards = loaded.cards()
    assert [c['kind'] for c in cards] == ['ride', 'ride', 'rest'] + ['ride'] * 5
    for i, c in enumerate(cards):
        assert c['date'].endswith(f'Jun {day(i).day}'), (i, c['date'])


# --- rest days / boundaries: weather --------------------------------------
def steep_temp(d):
    """Distinguishable whole-degree temperature per calendar day."""
    return d.timetuple().tm_yday - dt.date(2026, 6, 1).timetuple().tm_yday + 10


@pytest.fixture
def steep(loaded, monkeypatch):
    mod = loaded.backend.module

    def offline(lat, lon, month, dom, **_k):
        st = syn.make_stats(lat, lon, month, dom, rain_fn=loaded.backend.weather.rain_fn)
        t = float(steep_temp(dt.date(2026, month, dom)))
        for k in list(st):
            if k.startswith('temp'):
                st[k] = t
        return st
    monkeypatch.setattr(mod, '_get_offline_stats', offline)
    for f in (loaded.backend.tmp / 'stats').glob('*.json'):
        f.unlink()
    return loaded


def test_weather_after_rest_day_belongs_to_displayed_date(steep):
    steep.add_rest_day(2)
    steep.get_weather()
    cards = steep.cards()
    require([c['kind'] for c in cards].count('rest') == 1, 'rest day must survive weather loading (F-04)')
    assert [shown_temp(c) for c in cards] == [steep_temp(day(i)) for i in range(8)]


@pytest.fixture
def uneven(loaded):
    """Dense sampling, steep spatial rain (0.1 mm/km), merged stage => uneven stages."""
    loaded.backend.weather.rain_fn = lambda lon: 2.0 + 0.1 * syn.km_at_lon(lon)
    for f in (loaded.backend.tmp / 'stats').glob('*.json'):
        f.unlink()
    loaded.page.evaluate("() => { const e=document.getElementById('setStepKm'); e.value='10'; for (const t of ['input','change']) e.dispatchEvent(new Event(t,{bubbles:true})); }")
    loaded.get_weather()
    loaded.delete_ride_day('ride-1')
    require(len(set(stage_lengths(loaded))) > 1, f'uneven stages expected, got {stage_lengths(loaded)}')
    return loaded


def stage_lengths(ui):
    return [float(c['stage'].split(' km')[0]) for c in ui.cards() if c['kind'] == 'ride']


def assert_rain_describes_displayed_stages(ui):
    start = 0.0
    for c, length in zip([c for c in ui.cards() if c['kind'] == 'ride'], stage_lengths(ui)):
        require('Rain' in c['weather'], f'stage without weather: {c}')
        shown = float(re.search(r'Rain ([\d.]+) mm', c['weather']).group(1))
        # Tolerance: 10 km sampling and half-open stage ends on this gradient.
        assert shown == pytest.approx(2.0 + 0.1 * (start + length / 2), abs=1.0), (c['key'], shown)
        start += length


def test_weather_follows_changed_boundary_before_refresh(uneven):
    """Control: the client aggregates by displayed stage."""
    assert_rain_describes_displayed_stages(uneven)


def test_weather_follows_changed_boundary_after_refresh(uneven):
    lens = stage_lengths(uneven)
    uneven.get_weather()
    require(stage_lengths(uneven) == lens, 'stage lengths must survive weather loading (F-04)')
    assert_rain_describes_displayed_stages(uneven)


def test_weather_after_moved_rest_day_follows_new_position(steep):
    steep.add_rest_day(2)
    steep.get_weather()
    steep.page.evaluate("""() => document.querySelector("#roadbookList article[data-kind='rest'] [data-action='remove-rest'], #roadbookList article[data-kind='rest'] [data-action='delete-day']").click()""")
    steep.page.wait_for_timeout(300)
    require([c['kind'] for c in steep.cards()] == ['ride'] * 7, 'rest day must be removable')
    steep.add_rest_day(5)
    steep.get_weather()
    cards = steep.cards()
    require([c['kind'] for c in cards].index('rest') == 5, 'rest day at its new position')
    assert [shown_temp(c) for c in cards] == [steep_temp(day(i)) for i in range(8)]


def test_client_sends_schedule_only_when_the_plan_has_one(steep):
    def last_query():
        url = [r.url for r in steep.requests if '/api/map_stream' in r.url][-1]
        return parse_qs(urlsplit(url).query)
    assert not {'boundaries_km', 'rest_days'} & set(last_query())
    steep.add_rest_day(2)
    steep.add_rest_day(2)
    steep.get_weather()
    q = last_query()
    assert q['rest_days'] == ['2,3'] and q['total_days'] == ['7']
    steep.delete_ride_day('ride-1')
    lens = stage_lengths(steep)
    steep.get_weather()
    q = last_query()
    marks = [float(v) for v in q['boundaries_km'][0].split(',')]
    assert len(marks) == 5 and q['total_days'] == ['6']
    assert marks == pytest.approx([sum(lens[:i + 1]) for i in range(5)], abs=0.6)


def test_rest_days_and_boundaries_together_survive_reload(uneven):
    uneven.add_rest_day(2)
    uneven.get_weather()
    before = uneven.cards()
    assert_rain_describes_displayed_stages(uneven)
    uneven.page.wait_for_timeout(2600)
    uneven.page.reload(wait_until='load')
    uneven.page.wait_for_timeout(2000)
    uneven.tour()
    uneven.page.wait_for_timeout(800)
    assert [(c['kind'], c['date'], c['tile']) for c in uneven.cards()] == [(c['kind'], c['date'], c['tile']) for c in before]


# --- stream contract -------------------------------------------------------
BOUNDS = [50, 150, 300]


def schedule(r):
    return [(d['day_index'], d['date']) for d in r.summary['day_summaries']]


@pytest.mark.parametrize('rests,ride_days', [
    ([], [0, 1, 2, 3]), ([2], [0, 1, 3, 4]), ([0], [1, 2, 3, 4]),
    ([1, 2], [0, 3, 4, 5]), ([1, 4], [0, 2, 3, 5]), ([4], [0, 1, 2, 3]),
])
@pytest.mark.parametrize('reuse', [0, 1])
def test_stream_assigns_calendar_dates(tmp_path, stream, rests, ride_days, reuse, backend, monkeypatch):
    extra = {'rest_days': ','.join(map(str, rests))} if rests else {}
    if reuse:
        extra.update(reuse_per_day=1, offline_only=0)
        monkeypatch.setattr(backend.module, '_offline_strict_enabled', lambda: False)
    r = stream(syn.write_gpx(tmp_path / 'r.gpx', 400), step_km=20, days=4, **extra)
    rides = [p for p in r.props if p['tour_day_index'] < 4]
    for p in rides:
        d = day(ride_days[p['tour_day_index']])
        assert p['date'] == d.isoformat()
        assert p['temperature_c'] == pytest.approx(syn.temp_on(d))
    summaries = r.summary['day_summaries']
    assert [d['day_index'] for d in summaries] == [0, 1, 2, 3]
    assert [d['temp_median'] for d in summaries] == pytest.approx([syn.temp_on(day(n)) for n in ride_days])
    got = r.summary.get('rest_day_summaries', [])
    assert [(d['calendar_index'], d['date']) for d in got] == [(n, day(n).isoformat()) for n in rests]
    assert [d['temp_median'] for d in got] == pytest.approx([syn.temp_on(day(n)) for n in rests])


def test_rest_day_weather_describes_the_overnight_place(tmp_path, stream):
    r = stream(syn.write_gpx(tmp_path / 'r.gpx', 400), step_km=20, days=4,
               boundaries_km='50,150,300', rest_days='0,2,6')
    rain = [d['precip_sum'] for d in r.summary['rest_day_summaries']]
    assert rain == pytest.approx([2.0, 2.5, 6.0], abs=0.02)  # start, km 50, finish


def test_rest_days_do_not_count_as_ride_days(tmp_path, stream):
    gpx = syn.write_gpx(tmp_path / 'r.gpx', 400)
    plain = stream(gpx, step_km=20, days=4).summary
    rest = stream(gpx, step_km=20, days=4, rest_days='2').summary
    for key in ('total_days', 'rain_days', 'lucky_days', 'total_precipitation'):
        assert rest[key] == pytest.approx(plain[key])


@pytest.mark.parametrize('reverse', [0, 1])
def test_stream_assigns_points_to_moved_boundaries(tmp_path, stream, reverse):
    r = stream(syn.write_gpx(tmp_path / 'r.gpx', 400), step_km=20, days=4,
               boundaries_km='50,150,300', reverse=reverse)
    for p in r.props:
        km = p['distance_from_start_km']
        assert p['tour_day_index'] == sum(km > b + 1e-6 for b in BOUNDS), km
        assert p['date'] == day(p['tour_day_index']).isoformat()
    assert [b['distance_km'] for b in r.profile['day_boundaries']] == BOUNDS
    assert len(r.route['route_segments']['features']) == 4


def test_short_custom_stage_still_gets_weather_at_its_place(tmp_path, stream):
    r = stream(syn.write_gpx(tmp_path / 'r.gpx', 400), step_km=100, days=3, boundaries_km='110,130')
    assert schedule(r) == [(i, day(i).isoformat()) for i in range(3)]
    mid = [p for p in r.props if p['tour_day_index'] == 1]
    assert [p['distance_from_start_km'] for p in mid] == pytest.approx([120])


def test_segments_and_finish_marker_carry_calendar_dates(tmp_path, stream):
    r = stream(syn.write_gpx(tmp_path / 'r.gpx', 400), step_km=20, days=4, rest_days='1,3')
    assert [f['properties']['date'] for f in r.route['route_segments']['features']] == [day(n).isoformat() for n in (0, 2, 4, 5)]
    assert r.route['end_marker']['properties']['date'] == day(5).isoformat()
    assert [b['date'] for b in r.profile['day_boundaries']] == [day(n).isoformat() for n in (0, 2, 4)]


@pytest.mark.parametrize('extra', [
    {'boundaries_km': ''}, {'rest_days': ''}, {'boundaries_km': '50,150'}, {'boundaries_km': 'a,b,c'},
    {'boundaries_km': 'nan,150,300'}, {'boundaries_km': '50,150,9000'}, {'boundaries_km': '50,50,300'},
    {'rest_days': 'x,-1,99'},
])
def test_unusable_schedule_equals_no_schedule(tmp_path, stream, extra):
    gpx = syn.write_gpx(tmp_path / 'r.gpx', 400)
    a, b = stream(gpx, step_km=20, days=4), stream(gpx, step_km=20, days=4, **extra)
    assert (a.stations, a.summary, a.route, a.profile['day_boundaries']) == \
           (b.stations, b.summary, b.route, b.profile['day_boundaries'])


def test_stream_requests_the_whole_calendar_window(tmp_path, stream, backend, monkeypatch):
    """Forecast must cover the dates pushed back by rest days."""
    seen = []

    def forecast(lat, lon, start, span, **_k):
        seen.append(span)
        return None
    monkeypatch.setattr(backend.module, 'fetch_forecast_weather_window', forecast)
    today = dt.date.today()
    try:
        stream(syn.write_gpx(tmp_path / 'r.gpx', 400), step_km=100, days=4, start=today,
               rest_days='1,2', tour_weather_mode='forecast', offline_only=0)
    except AssertionError as exc:  # no forecast data: only the request matters
        require('unusable stations' in str(exc), str(exc))
    assert seen and set(seen) == {6}


# --- simulation ------------------------------------------------------------
def optimizer_payload(ui):
    ui.page.evaluate("document.getElementById('tourSlotOptimizeBtn') ? document.getElementById('tourSlotOptimizeBtn').click() : [...document.querySelectorAll('button')].find(b=>/Start Simulation Run/.test(b.textContent)).click()")
    deadline = time.time() + 10
    while time.time() < deadline:
        for r in ui.requests:
            if r.url.endswith('/api/tour_slot_optimizer/start'):
                return json.loads(r.post_data)
        ui.page.wait_for_timeout(100)
    raise AssertionError('simulation did not start')


def assert_simulation_matches_tourbook(ui):
    cards = ui.cards()
    payload = optimizer_payload(ui)
    rests = [i for i, c in enumerate(cards) if c['kind'] == 'rest']
    assert payload['totalDays'] == len(cards)
    assert payload['restDayIndexes'] == rests
    assert len(payload['boundariesKm']) == len(cards) - len(rests) - 1

    client = ui.backend.app.test_client()
    body = dict(payload, gpx_path=str(ui.backend.tmp / 'tour420.gpx'), slotGranularity='week')
    job = client.post('/api/tour_slot_optimizer/start', json=body).get_json()['job_id']
    for _ in range(200):
        res = client.get(f'/api/tour_slot_optimizer/result/{job}').get_json()
        if res['status'] in ('done', 'error'):
            break
        time.sleep(0.1)
    assert res['status'] == 'done', res.get('error')
    meta, best = res['result']['meta'], res['result']['candidates'][0]
    assert meta['total_days'] == len(cards)
    assert meta['ride_days'] == len(cards) - len(rests)
    assert meta['rest_day_indexes'] == rests
    span = dt.date.fromisoformat(best['end_date']) - dt.date.fromisoformat(best['start_date'])
    assert span.days + 1 == len(cards)


def test_simulation_schedule_equals_tourbook_without_rest_days(loaded):
    assert_simulation_matches_tourbook(loaded)


def test_simulation_schedule_equals_tourbook_with_rest_days(loaded):
    loaded.add_rest_day(2)
    loaded.add_rest_day(5)
    assert_simulation_matches_tourbook(loaded)


def test_simulation_schedule_equals_tourbook_with_rest_day_and_changed_boundary(loaded):
    loaded.delete_ride_day('ride-1')
    loaded.add_rest_day(3)
    assert_simulation_matches_tourbook(loaded)


def test_optimizer_evaluates_each_stage_on_its_calendar_day(tmp_path):
    """Backend contract: 4 uneven ride stages, rest on calendar day 2."""
    route = route_sampling.load_gpx_route(str(syn.write_gpx(tmp_path / 'r.gpx', 400)))
    calls = []

    def lookup(lat, lon, month, dom, _years):
        calls.append((month, dom, round(syn.km_at_lon(lon))))
        return syn.make_stats(lat, lon, month, dom)

    tso.optimize_tour_slots(
        route_data=route, total_days=5, rest_day_indexes=[2], boundaries_km=[50, 150, 300],
        years_selected=[2025], anchor_year=2026, direction_mode='forward',
        objective_mode='lowest_precip_sum', top_n=1, weather_lookup=lookup)
    first = calls[:5]
    assert [c[:2] for c in first] == [(1, 1), (1, 2), (1, 3), (1, 4), (1, 5)]
    assert [c[2] for c in first] == [25, 100, 100, 225, 350]  # rest stays near the previous stage
