"""F-03: displayed schedule, weather dates and simulation must agree.

Existing contracts exercised here:
* /api/map_stream:          start_date + total_days, equal consecutive days
* /api/tour_slot_optimizer: totalDays = all calendar days including rest days,
                            restDayIndexes = calendar positions,
                            boundariesKm = one per transition between ride days

/api/map_stream has NO contract for rest days or stage boundaries. Tests that
need one are strict xfails: they document the gap (see README.md) and will
turn red as soon as it is closed, so that the marker must then be removed.
"""
import datetime as dt
import json
import re
import time

import pytest
import synthetic as syn
import tour_slot_optimizer as tso
import route_sampling

GAP = pytest.mark.xfail(strict=True, raises=AssertionError,
                        reason='F-03 contract gap: map_stream receives neither rest days nor stage boundaries')


def day(n):
    return syn.START + dt.timedelta(days=n)


def shown_temp(card):
    m = re.search(r'(-?\d+)°', card['tile'])
    assert m, card
    return int(m.group(1))


def require(condition, message):
    """Precondition: not an AssertionError, so an xfail can never hide it."""
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


@GAP
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
    return [float(c['stage'].split(' km')[0]) for c in ui.cards()]


def assert_rain_describes_displayed_stages(ui):
    start = 0.0
    for c, length in zip(ui.cards(), stage_lengths(ui)):
        require('Rain' in c['weather'], f'stage without weather: {c}')
        shown = float(re.search(r'Rain ([\d.]+) mm', c['weather']).group(1))
        # Tolerance: 10 km sampling, half-open stage ends and the sampler's
        # duplicated start point account for up to 0.8 mm on this gradient.
        assert shown == pytest.approx(2.0 + 0.1 * (start + length / 2), abs=1.0), (c['key'], shown)
        start += length


def test_weather_follows_changed_boundary_before_refresh(uneven):
    """Control: the client aggregates by displayed stage."""
    assert_rain_describes_displayed_stages(uneven)


@GAP
def test_weather_follows_changed_boundary_after_refresh(uneven):
    lens = stage_lengths(uneven)
    uneven.get_weather()
    require(stage_lengths(uneven) == lens, 'stage lengths must survive weather loading (F-04)')
    assert_rain_describes_displayed_stages(uneven)


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
