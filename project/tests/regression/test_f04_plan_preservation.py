"""F-04: loading or refreshing weather never changes user-authored structure."""
import json

import pytest
import synthetic as syn

OVERNIGHT = {'id': 'o1', 'name': 'Camp Test', 'type': 'camping', 'lat': 48.0, 'lon': 6.0,
             'linkedStageId': 'ride-1', 'status': 'planned', 'notes': 'n', 'source': 'manual'}


@pytest.fixture
def authored(loaded):
    """A plan with uneven stages, two rest days, notes and reversed direction."""
    loaded.delete_ride_day('ride-2')
    loaded.add_rest_day(2)
    loaded.add_rest_day(4)
    loaded.set_note('ride-1', 'meet friends')
    loaded.set_note('rest-r1', 'museum')
    loaded.set_reverse(True)
    s = loaded.structure()
    assert s['rest'] == [('r1', 2), ('r2', 4)]
    assert len(s['boundaries']) == 5 and s['notes'] == {'ride-1': 'meet friends', 'rest-r1': 'museum'}
    assert s['reverse'] is True and len(s['days']) == 8
    return loaded, s


def test_get_weather_preserves_structure(authored):
    ui, before = authored
    ui.get_weather()
    assert ui.structure() == before


def test_repeated_get_weather_preserves_structure(authored):
    ui, before = authored
    for _ in range(3):
        ui.get_weather()
    assert ui.structure() == before


def test_explore_and_back_preserves_structure(authored):
    ui, before = authored
    ui.explore()
    n = ui._arm()
    ui.tour()
    ui.wait_weather(n)
    assert ui.structure() == before


def test_reload_preserves_structure(authored):
    ui, before = authored
    ui.page.reload(wait_until='load')
    ui.page.wait_for_function('() => typeof window.setMode === "function"')
    if ui.page.evaluate('document.body.dataset.mode') != 'tour':
        ui.tour()
    ui.page.wait_for_selector('#roadbookList article.wm-roadbook-card', timeout=15000)
    ui.page.wait_for_timeout(2500)
    assert ui.structure() == before


def test_failed_weather_stream_preserves_structure(authored, monkeypatch):
    """A stream that reports a fatal error must not touch the plan either."""
    ui, before = authored

    def broken(*_a, **_k):
        raise ValueError('synthetic route failure')
    monkeypatch.setattr(ui.backend.module, 'load_gpx_route', broken)
    ui.page.click('#fetchWeather')
    ui.page.wait_for_function(
        "() => /synthetic route failure/.test((document.getElementById('sseStatus')||{}).textContent||'')", timeout=10000)
    # The stored plan may be untouched while the working copy is already damaged,
    # so inspect what the application would write to a file right now.
    rb = save_as(ui)['tourPlan']['roadbook']
    assert [(x['id'], x['position']) for x in rb['restStops']] == before['rest']
    assert [round(b, 2) for b in (rb['boundariesKm'] or [])] == before['boundaries']
    assert {d['key']: d['notes'] for d in rb['days'] if d['notes']} == before['notes']


def save_as(ui):
    ui.page.evaluate("[...document.querySelectorAll('button')].find(b=>/Save Tour As/.test(b.textContent)).click()")
    ui.page.wait_for_function('() => window.__saved.length > 0')
    return json.loads(ui.page.evaluate('window.__saved[window.__saved.length-1]'))


def open_file(ui, payload):
    ui.page.evaluate('t => { window.__open = t }', json.dumps(payload))
    n = ui._arm()
    ui.page.evaluate("[...document.querySelectorAll('button')].find(b=>/Open Tour/.test(b.textContent)).click()")
    ui.wait_weather(n)


def test_tour_file_contains_complete_structure(authored):
    ui, before = authored
    p = save_as(ui)
    rb = p['tourPlans'][p['activePlanId']]['plan']['roadbook']
    assert [(s['id'], s['position']) for s in rb['restStops']] == before['rest']
    assert [round(b, 2) for b in rb['boundariesKm']] == before['boundaries']
    assert {d['key']: d['notes'] for d in rb['days'] if d['notes']} == before['notes']
    assert p['preferences']['reverse'] is True and p['preferences']['totalDays'] == 6
    assert p['gpx']['embedded'] is True and '<gpx' in p['gpx']['content']


def test_tour_file_round_trip_same_session(authored):
    ui, before = authored
    payload = save_as(ui)
    open_file(ui, payload)
    assert ui.structure() == before


def test_tour_file_round_trip_into_fresh_browser(authored, chromium):
    """Open the file in a new profile whose defaults differ (7 days, forward)."""
    ui, before = authored
    payload = save_as(ui)
    ui.page.context.clear_cookies()
    ui.page.evaluate('localStorage.clear()')
    ui.page.goto('about:blank')
    ui.open()
    ui.tour()
    open_file(ui, payload)
    assert ui.structure() == before


def test_round_trip_preserves_overnight_stops(authored):
    ui, _ = authored
    payload = save_as(ui)
    payload['tourPlans'][payload['activePlanId']]['plan']['roadbook']['overnightStops'] = [OVERNIGHT]
    open_file(ui, payload)
    ui.get_weather()
    s = ui.structure()
    assert s['overnight'] == [('o1', 'Camp Test', 'ride-1')]
    assert s['rest'] == [('r1', 2), ('r2', 4)]
