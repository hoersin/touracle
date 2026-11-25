"""F-01: daily precipitation is the mean over the day's route points.

Confirmed definition (2026-11-25, docs/WEATHER_VALUE_REFERENCE.md): mean, not
sum. Sampling density is technical and must not change the daily result.
"""
import pytest
import synthetic as syn

STEPS = (100, 60, 25, 10)
DAYS = 4
TOTAL_KM = 800


@pytest.fixture
def gpx(tmp_path):
    return syn.write_gpx(tmp_path / 'r.gpx', TOTAL_KM)


@pytest.mark.parametrize('step', STEPS)
def test_uniform_rain_yields_that_rain_per_day(stream, backend, gpx, step):
    backend.weather.rain_fn = lambda lon: 3.0
    s = stream(gpx, step_km=step, days=DAYS).summary
    assert [d['day_index'] for d in s['day_summaries']] == list(range(DAYS))
    assert [d['precip_sum'] for d in s['day_summaries']] == pytest.approx([3.0] * DAYS)
    assert [d['precip_mean'] for d in s['day_summaries']] == pytest.approx([3.0] * DAYS)
    assert s['total_precipitation'] == pytest.approx(3.0 * DAYS)


@pytest.mark.parametrize('step', STEPS)
def test_daily_rain_is_arithmetic_mean_of_the_days_points(stream, gpx, step):
    r = stream(gpx, step_km=step, days=DAYS)
    for d in r.summary['day_summaries']:
        vals = [p['precipitation_mm'] for p in r.props if p['tour_day_index'] == d['day_index']]
        assert d['precip_sum'] == pytest.approx(sum(vals) / len(vals))


def test_changing_density_does_not_materially_change_daily_rain(stream, gpx):
    ref = stream(gpx, step_km=10, days=DAYS).summary
    for step in STEPS:
        s = stream(gpx, step_km=step, days=DAYS).summary
        for a, b in zip(s['day_summaries'], ref['day_summaries']):
            # Gradient is 2 mm within a 200 km day; coarse sampling may shift
            # the mean by part of that, never multiply it.
            assert a['precip_sum'] == pytest.approx(b['precip_sum'], abs=0.75)
        assert s['total_precipitation'] == pytest.approx(ref['total_precipitation'], rel=0.10)


def test_rain_and_lucky_days_do_not_depend_on_density(stream, backend, gpx):
    # 0.4 mm is dry everywhere (rainy day: >= 1 mm) and below the 10 mm limit.
    backend.weather.rain_fn = lambda lon: 0.4
    got = {st: (s['rain_days'], s['lucky_days']) for st in STEPS
           for s in [stream(gpx, step_km=st, days=DAYS).summary]}
    assert set(got.values()) == {(0, DAYS)}, got


def test_displayed_tourbook_rain_matches_definition_before_and_after_restaging(loaded):
    """UI path: backend summary first, then the client's own aggregation."""
    loaded.backend.weather.rain_fn = lambda lon: 3.0
    (loaded.backend.tmp / 'stats').mkdir(exist_ok=True)
    for f in (loaded.backend.tmp / 'stats').glob('*.json'):
        f.unlink()
    loaded.page.evaluate("() => { const e=document.getElementById('setStepKm'); e.value='10'; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); }")
    loaded.get_weather()
    cards = loaded.cards()
    assert cards and all('Rain 3.0 mm' in c['weather'] for c in cards), [c['weather'] for c in cards]
    loaded.delete_ride_day('ride-2')  # client re-aggregates by stage
    cards = loaded.cards()
    assert len(cards) == 6
    assert all('Rain 3.0 mm' in c['weather'] for c in cards), [c['weather'] for c in cards]
