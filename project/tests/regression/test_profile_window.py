"""Profile window (Tour Planning): "Route Profile & Tour Weather", in the real UI.

The synthetic tour (conftest ``loaded``) is a straight 420 km west-to-east route,
7 riding days of 60 km from 1 June. Weather is deterministic (synthetic.py): wind
from the west at 2 m/s everywhere (a pure 2 m/s tailwind for this route, a pure
headwind when reversed); daily rain grows with the route kilometre.

Checked: header, summary strip, legend, one precipitation bar per tour day at the
day's interval with the TourBook's daily value, day headers with good-weather
symbols from the existing classification, the wind strip (head/tail per day,
reversal), rest days, summary cards from the same values, hover readout, close /
reopen, layouts 1280x800 / 1440x900 / 2560x1440 and all five languages.
"""
from __future__ import annotations

import math
import re

import pytest

import synthetic as syn

LANGS = ('en', 'de', 'fr', 'es', 'zh-CN')


def pw(page):
    return page.evaluate("""() => { const p = window.__WM_PROFILE_WINDOW__;
        return p ? { days: p.model.days, sum: p.summary(), geo: p.geo() } : null; }""")


def tourbook(page):
    """TourBook cards: kind, key, and the daily values shown in row 3."""
    return page.evaluate("""() => [...document.querySelectorAll('#roadbookList article.wm-roadbook-card')].map(c => ({
        kind: c.dataset.kind, key: c.dataset.dayKey, row3: c.querySelector('.wm-roadbook-card-row3').textContent.trim() }))""")


def pixel(page, x, y):
    return page.evaluate("""([x, y]) => { const c = document.getElementById('profileCanvas');
        const r = window.devicePixelRatio || 1; const d = c.getContext('2d').getImageData(Math.round(x * r), Math.round(y * r), 1, 1).data;
        return [d[0], d[1], d[2], d[3]]; }""", [x, y])


def x_at(geo, km):
    return geo['padL'] + geo['innerW'] * (km - geo['minKm']) / (geo['maxKm'] - geo['minKm'])


def is_blue(px):
    r, g, b, _a = px
    return b > r + 40 and b > g + 15


def is_green(px):
    r, g, b, _a = px
    return g > r + 40 and g > b + 20


def redraw(ui):
    ui.page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    ui.page.wait_for_timeout(250)


# ----------------------------------------------------------------- structure ---
def test_window_has_header_strip_legend_chart_and_four_cards(loaded):
    page = loaded.page
    st = page.evaluate("""() => { const t = s => (document.querySelector(s) || {}).innerText || '';
        return { title: t('#wmProfileHead .wm-pw-title'), sub: t('[data-role=pw-sub]'), strip: t('[data-role=pw-strip]'),
                 close: document.getElementById('wmProfileToggle').getAttribute('aria-label'),
                 legend: [...document.querySelectorAll('#wmProfileLegend .wm-pw-lg')].map(e => e.dataset.lg),
                 cards: [...document.querySelectorAll('#wmProfileCards .wm-pw-card')].map(e => e.dataset.metric),
                 readoutHidden: document.getElementById('wmProfileReadout').hidden }; }""")
    assert st['title'] == 'Route Profile & Tour Weather'
    assert st['sub'].startswith('Typical weather per tour day'), st
    assert st['close'] == 'Close profile window'
    for part in ('420 km', '7 riding days', '0 rest days', 'Mon, Jun 1 – Sun, Jun 7'):
        assert part in st['strip'], (part, st['strip'])
    assert '→' in st['strip']
    assert st['legend'] == ['elev', 'temp', 'range', 'precip', 'head', 'tail']
    assert st['cards'] == ['temp', 'precip', 'headwind', 'good']
    assert st['readoutHidden'] is True                       # only while the pointer is over the chart
    assert not loaded.errors, loaded.errors


# ------------------------------------------------------------- precipitation ---
def test_one_precipitation_bar_per_tour_day_with_the_tourbook_value(loaded):
    page = loaded.page
    data = pw(page)
    days = data['days']
    assert [d['key'] for d in days] == [f'ride-{i}' for i in range(7)]
    assert [(round(d['startKm']), round(d['endKm'])) for d in days] == [(60 * i, 60 * (i + 1)) for i in range(7)]
    cards = tourbook(page)
    for d, c in zip(days, cards):
        shown = float(re.search(r'Rain ([\d.]+) mm', c['row3']).group(1))
        assert abs(d['rainMm'] - shown) < 0.051, (d, c)                          # the TourBook's daily value
        # a daily value (mean over the day's route points), never a sum over sampling points
        lo, hi = (syn.rain_at_lon(syn.lon_at_km(k)) for k in (d['startKm'], d['endKm']))
        assert lo - 0.01 <= d['rainMm'] <= hi + 0.01, (d, lo, hi)
    geo = data['geo']
    base = geo['padTop'] + geo['innerH'] - 2
    vals = [d['rainMm'] for d in days]
    assert vals == sorted(vals) and vals[-1] > vals[0]                           # rain grows eastwards
    for d in days:
        assert is_blue(pixel(page, x_at(geo, (d['startKm'] + d['endKm']) / 2), base)), d          # bar inside its day
    for km in (60, 120, 180, 240, 300, 360):
        assert not is_blue(pixel(page, x_at(geo, km), base)), km                                 # gap at each day boundary
    # taller bar for more rain
    def top(d):
        x = x_at(geo, (d['startKm'] + d['endKm']) / 2)
        y = base
        while y > geo['padTop'] and is_blue(pixel(page, x, y - 1)):
            y -= 1
        return y
    assert top(days[6]) < top(days[0])


# ---------------------------------------------------------------------- wind ---
def test_wind_strip_shows_tailwind_and_reverses_with_the_route(loaded):
    page = loaded.page
    data = pw(page)
    assert all(d['comp'] is not None and abs(d['comp'] - 2.0) < 0.05 for d in data['days']), data['days']
    assert all(d['tailMs'] > 1.9 and d['headMs'] == 0 for d in data['days'])
    geo = data['geo']
    yc = geo['windTop'] + geo['windH'] * 0.5 - 4
    for d in data['days']:
        x = x_at(geo, (d['startKm'] + d['endKm']) / 2)
        assert any(is_green(pixel(page, x + dx, yc)) for dx in (-6, 0, 6)), d             # green tailwind arrow
    assert page.evaluate("document.querySelector('[data-metric=headwind] [data-role=value]').textContent") == '0.0 m/s'
    loaded.set_reverse(True)
    loaded.get_weather()
    redraw(loaded)
    rev = pw(page)
    assert all(d['comp'] is not None and abs(d['comp'] + 2.0) < 0.05 for d in rev['days']), rev['days']
    assert all(d['headMs'] > 1.9 and d['tailMs'] == 0 for d in rev['days'])
    geo = rev['geo']
    for d in rev['days']:
        x = x_at(geo, (d['startKm'] + d['endKm']) / 2)
        assert any(is_blue(pixel(page, x + dx, yc)) for dx in (-6, 0, 6)), d               # blue headwind arrow
    assert page.evaluate("document.querySelector('[data-metric=headwind] [data-role=value]').textContent") == '2.0 m/s'
    # the TourBook agrees
    assert all('Headwind' in c['row3'] for c in tourbook(page))


def test_headwind_card_counts_tailwind_as_zero(loaded):
    page = loaded.page
    s = pw(page)
    heads = [max(0.0, -d['comp']) for d in s['days'] if d['type'] == 'ride']
    assert abs(s['sum']['headMean'] - sum(heads) / len(heads)) < 1e-9
    assert s['sum']['headMean'] == 0                                         # tailwind days never count negative


# --------------------------------------------------------- good weather days ---
@pytest.fixture
def mixed_sky(ui, monkeypatch):
    """The synthetic tour with rain probability by route position (set before loading):
    sunny / partly cloudy / showers / rain."""
    real = syn.make_stats

    def stats(lat, lon, month, day, **kw):
        s = real(lat, lon, month, day, **kw)
        km = syn.km_at_lon(lon)
        s['rain_probability'] = 0.1 if km < 120 else 0.35 if km < 180 else 0.6 if km < 300 else 0.9
        return s
    monkeypatch.setattr(syn, 'make_stats', stats)
    ui.open()
    ui.tour()
    ui.import_gpx(syn.write_gpx(ui.backend.tmp / 'tour420.gpx', 420))
    redraw(ui)
    return ui


def test_good_weather_symbols_and_card_use_the_existing_classification(mixed_sky):
    page = mixed_sky.page
    data = pw(page)
    cls = [d['cls'] for d in data['days']]
    expect = page.evaluate("ps => ps.map(p => p === null ? null : (p < 0.2 ? 'sunny' : p < 0.5 ? 'partly_cloudy' : p < 0.8 ? 'light_rain' : 'rain'))",
                           [0.1, 0.1, 0.35, 0.6, 0.6, 0.9, 0.9])
    assert cls == expect, cls
    assert [d['favourable'] for d in data['days']] == [True, True, True, False, False, False, False]
    assert data['sum']['good'] == 3 and data['sum']['total'] == 7
    assert page.evaluate("document.querySelector('[data-metric=good] [data-role=value]').textContent") == '3 / 7'
    # a large symbol under the label of good days only, nothing for the others
    geo = data['geo']

    def ink(d):
        x = x_at(geo, (d['startKm'] + d['endKm']) / 2)
        pts = [pixel(page, x + dx, y) for dx in range(-8, 9, 4) for y in range(34, int(geo['padTop']) - 4, 3)]
        return sum(1 for r, g, b, a in pts if a > 0 and (r, g, b) != (255, 255, 255) and min(r, g, b) < 235)
    assert ink(data['days'][0]) > 3 and ink(data['days'][2]) > 3
    assert ink(data['days'][4]) == 0 and ink(data['days'][6]) == 0


# ------------------------------------------------------------------ rest day ---
def test_rest_day_keeps_stage_intervals_and_counts_as_tour_day(loaded):
    page = loaded.page
    loaded.add_rest_day(2)
    redraw(loaded)
    data = pw(page)
    kinds = [(d['type'], d['n']) for d in data['days']]
    assert kinds == [('ride', 1), ('ride', 2), ('rest', 3), ('ride', 4), ('ride', 5), ('ride', 6), ('ride', 7), ('ride', 8)]
    rides = [d for d in data['days'] if d['type'] == 'ride']
    assert [(round(d['startKm']), round(d['endKm'])) for d in rides] == [(60 * i, 60 * (i + 1)) for i in range(7)]
    rest = data['days'][2]
    assert round(rest['startKm']) == 120 and rest['comp'] is None and rest['cls'] is None
    assert [d['dateIso'] for d in data['days']][:4] == ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']
    strip = page.evaluate("document.querySelector('[data-role=pw-strip]').innerText")
    assert '1 rest day' in strip and '7 riding days' in strip and 'Mon, Jun 8' in strip, strip
    assert data['sum']['total'] == 8 and data['sum']['rideDays'] == 7
    assert page.evaluate("document.querySelector('[data-metric=good] [data-role=value]').textContent").endswith('/ 8')


# ------------------------------------------------------------------- cards ---
def test_summary_cards_use_the_same_daily_values(loaded):
    page = loaded.page
    data = pw(page)
    days = data['days']
    s = data['sum']
    temps = [d['tempC'] for d in days]
    rains = [d['rainMm'] for d in days]
    assert abs(s['tempMean'] - sum(temps) / len(temps)) < 1e-9
    assert abs(s['rainMean'] - sum(rains) / len(rains)) < 1e-9 and abs(s['rainTotal'] - sum(rains)) < 1e-9
    card = page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('#wmProfileCards .wm-pw-card')].map(c =>
        [c.dataset.metric, c.querySelector('[data-role=value]').textContent + ' | ' + c.querySelector('[data-role=note]').textContent]))""")
    assert card['temp'].startswith(f"{s['tempMean']:.1f} °C"), card
    assert card['precip'].startswith(f"{s['rainMean']:.1f} mm/day | {s['rainTotal']:.1f} mm in total"), card
    assert card['good'].startswith(f"{s['good']} / 7"), card
    # TourBook temperatures (rounded there) agree with the daily values used here
    for d, c in zip(days, tourbook(page)):
        assert c['row3'].startswith(f"{math.floor(d['tempC'] + 0.5)}°C"), (d, c)      # JS Math.round


# --------------------------------------------------------- hover and cursor ---
def test_hover_shows_the_days_values_and_highlights_nothing_else(loaded):
    page = loaded.page
    data = pw(page)
    geo = data['geo']
    box = page.locator('#profileCanvas').bounding_box()
    day = data['days'][2]
    page.mouse.move(box['x'] + x_at(geo, (day['startKm'] + day['endKm']) / 2), box['y'] + geo['padTop'] + geo['innerH'] / 2)
    page.wait_for_timeout(300)
    ro = page.evaluate("(() => { const b = document.getElementById('wmProfileReadout'); return { hidden: b.hidden, text: b.innerText }; })()")
    assert not ro['hidden'], ro
    assert ro['text'].startswith('Day 3 · Wed, Jun 3'), ro
    assert f"{day['rainMm']:.1f} mm" in ro['text'] and 'tailwind 2.0 m/s' in ro['text'] and 'from behind' in ro['text'], ro
    page.mouse.move(box['x'] + 5, box['y'] - 40)
    page.wait_for_timeout(200)
    assert page.evaluate("document.getElementById('wmProfileReadout').hidden")


def test_selected_tourbook_day_follows_into_the_profile(loaded):
    page = loaded.page
    page.click('#roadbookList article[data-day-key="ride-4"]')
    redraw(loaded)
    data = pw(page)
    geo = data['geo']
    day = data['days'][4]
    x = x_at(geo, (day['startKm'] + day['endKm']) / 2)
    tint = pixel(page, x, 6)                              # the header band of the selected day is tinted
    other = pixel(page, x_at(geo, 30), 6)
    assert tint != other and tint[1] >= tint[0], (tint, other)


# --------------------------------------------------------- close and reopen ---
def test_close_and_reopen(loaded):
    page = loaded.page
    h0 = page.evaluate("document.getElementById('profilePanel').offsetHeight")
    map0 = page.evaluate("document.getElementById('map').getBoundingClientRect().height")
    page.click('#wmProfileToggle')
    page.wait_for_timeout(300)
    st = page.evaluate("""() => ({ h: document.getElementById('profilePanel').offsetHeight,
        collapsed: document.getElementById('profilePanel').classList.contains('is-collapsed'),
        chart: getComputedStyle(document.getElementById('wmProfileChart')).display,
        label: document.getElementById('wmProfileToggle').getAttribute('aria-label'),
        map: document.getElementById('map').getBoundingClientRect().height })""")
    assert st['collapsed'] and st['chart'] == 'none' and st['h'] < 90 and st['label'] == 'Show profile window', st
    assert st['map'] > map0 + 150
    assert page.evaluate("localStorage.getItem('wm_profile_collapsed')") == '1'
    page.click('#wmProfileHead .wm-pw-title')                # the header of a closed window opens it
    page.wait_for_timeout(300)
    assert abs(page.evaluate("document.getElementById('profilePanel').offsetHeight") - h0) <= 2
    assert page.evaluate("localStorage.getItem('wm_profile_collapsed')") == '0'


# ------------------------------------------------------------------- layout ---
@pytest.mark.parametrize('viewport', [(1280, 800), (1440, 900), (2560, 1440)])
def test_layout_at_supported_sizes(loaded, viewport):
    page = loaded.page
    page.set_viewport_size({'width': viewport[0], 'height': viewport[1]})
    page.wait_for_timeout(600)
    redraw(loaded)
    lay = page.evaluate("""() => { const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
        const over = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
        const panel = r('#profilePanel'), head = r('#wmProfileHead'), legend = r('#wmProfileLegend'), chart = r('#wmProfileChart'),
              cards = r('#wmProfileCards'), badge = r('#wmVersionBadge');
        const cardRects = [...document.querySelectorAll('.wm-pw-card')].map(c => { const b = c.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; });
        const clipped = [...document.querySelectorAll('.wm-pw-card-v, .wm-pw-title')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent);
        return { panel, head, legend, chart, cards, cardRects, clipped, badgeOverPanel: over(badge, panel),
                 order: head[3] <= legend[1] + 1 && legend[3] <= chart[1] + 1 && chart[3] <= cards[1] + 1 && cards[3] <= panel[3] + 1,
                 inside: [head, legend, chart, cards].every(b => b[0] >= panel[0] - 1 && b[2] <= panel[2] + 1) }; }""")
    assert lay['order'] and lay['inside'], lay
    assert not lay['badgeOverPanel'], lay
    assert not lay['clipped'], lay
    assert len(lay['cardRects']) == 4 and all(abs(c[1] - lay['cardRects'][0][1]) < 1 for c in lay['cardRects'])   # one row
    geo = pw(page)['geo']
    assert geo['innerH'] >= 100, geo                       # the elevation/weather plot keeps a usable height
    assert geo['windTop'] + geo['windH'] <= (lay['chart'][3] - lay['chart'][1]) + 1


# ---------------------------------------------------------------- languages ---
def test_profile_window_in_all_five_languages(loaded):
    page = loaded.page
    seen = {}
    for lang in LANGS:
        page.evaluate("l => window.WM_I18N.setLanguage(l)", lang)
        page.wait_for_timeout(400)
        seen[lang] = page.evaluate("""() => [document.querySelector('#wmProfileHead .wm-pw-title').textContent,
            document.querySelector('[data-role=pw-sub]').textContent, document.querySelector('[data-role=pw-strip]').innerText,
            document.querySelector('#wmProfileLegend').innerText, document.querySelector('#wmProfileCards').innerText,
            document.getElementById('wmProfileToggle').getAttribute('aria-label')].join(' | ')""")
    page.evaluate("window.WM_I18N.setLanguage('en')")
    assert len(set(seen.values())) == 5, seen
    assert page.evaluate("[...window.WM_I18N.missing]") == []
    assert not any(re.search(r'\bpw\.[a-z]', v) for v in seen.values()), seen         # no raw keys
    assert 'Routenprofil & Tourwetter' in seen['de'] and '7 Fahrtage' in seen['de']
    assert '路线剖面与行程天气' in seen['zh-CN']
