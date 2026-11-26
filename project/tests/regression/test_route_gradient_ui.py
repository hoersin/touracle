"""Tour Planning route colours: Stage colors (default) vs Gradient, in the real UI.

The synthetic route runs east along one latitude; its elevation is known per km,
so the expected gradient class at every place - and its reversal - is known.
"""
from __future__ import annotations

from pathlib import Path

import synthetic as syn

STAGE_COLOR = '#0891b2'
# (length km, grade %): 120 km in total, two ride days of 60 km
PROFILE = [(10, 0.0), (4, 5.0), (3, -10.0), (13, 1.0), (5, 7.5), (5, -5.0), (20, 0.0),
           (6, 3.0), (2, 10.5), (8, -3.0), (4, 14.0), (40, 0.0)]


def elevation_at(km):
    h, acc = 300.0, 0.0
    for L, g in PROFILE:
        part = max(0.0, min(L, km - acc))
        h += part * 1000 * g / 100.0
        acc += L
    return h


def write_profile_gpx(path: Path, spacing_km=0.025) -> Path:
    total = sum(L for L, _ in PROFILE)
    n = int(round(total / spacing_km))
    pts = [f'<trkpt lat="{syn.LAT}" lon="{syn.lon_at_km(i * spacing_km):.8f}"><ele>{elevation_at(i * spacing_km):.2f}</ele></trkpt>'
           for i in range(n + 1)]
    path.write_text('<?xml version="1.0"?><gpx version="1.1" creator="t"><trk><trkseg>' + ''.join(pts)
                    + '</trkseg></trk></gpx>', encoding='utf-8')
    return path


DIAG = "() => { const d = window.__WM_ROUTE_GRADIENT_DIAG__; return { mode: d.mode, sections: d.sections, drawn: d.drawnClasses, days: d.dayBoundaries }; }"


def stroke_colors(page):
    """Line colours drawn in the route layer (the map draws on canvas)."""
    return sorted({s['color'] for s in page.evaluate("window.__WM_ROUTE_GRADIENT_DIAG__.routeStyles") if not s['marker']})


def legend(page):
    return page.evaluate("""() => { const e = document.getElementById('routeGradientLegend');
        return { visible: !!e && !e.hidden && getComputedStyle(e).display !== 'none',
                 rows: e ? [...e.querySelectorAll('.wm-gradient-legend-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()) : [] }; }""")


def section_at(sections, km):
    return next(s for s in sections if s[0] <= km <= s[1])


def set_coloring(page, mode):
    """Route colours live in the Sector 1 Route menu."""
    if not page.locator(f'[data-route-coloring="{mode}"]').is_visible():
        page.click('.wm-menu[data-menu="route"] .wm-menu-btn')
    page.click(f'[data-route-coloring="{mode}"]')


def open_route(ui):
    gpx = write_profile_gpx(ui.backend.tmp / 'gradient_route.gpx')
    ui.open()
    ui.tour()
    ui.import_gpx(gpx)
    return ui.page


def test_stage_colors_stay_the_default_and_unchanged(ui):
    page = open_route(ui)
    d = page.evaluate(DIAG)
    assert d['mode'] == 'stage'
    assert STAGE_COLOR in stroke_colors(page), stroke_colors(page)          # the existing route colour
    assert not legend(page)['visible']
    assert len(d['sections']) > 5                                            # computed, but not drawn


def test_gradient_mode_colours_the_route_with_the_nine_classes(ui):
    page = open_route(ui)
    set_coloring(page, 'gradient')
    page.wait_for_timeout(500)
    d = page.evaluate(DIAG)
    assert d['mode'] == 'gradient'
    assert STAGE_COLOR not in stroke_colors(page), 'stage colour must not be drawn below or over the gradient'
    secs = d['sections']
    expect = {5: 3, 12: 5, 15: 0, 22: 3, 33: 6, 37: 1, 50: 3, 63: 4, 67: 7, 72: 2, 78: 8, 100: 3}
    for km, cls in expect.items():
        assert section_at(secs, km)[2] == cls, (km, section_at(secs, km))
    drawn = d['drawn']
    assert all(drawn[c] > 0 for c in set(expect.values())), drawn             # every class present is drawn
    lg = legend(page)
    assert lg['visible'] and len(lg['rows']) == 9, lg
    assert lg['rows'][0].startswith('> +12 %') and lg['rows'][-1].startswith('≤ −8 %'), lg


def test_day_boundaries_are_visible_in_both_modes(ui):
    page = open_route(ui)
    cards = [c for c in ui.cards() if c['kind'] != 'rest']
    for mode in ('stage', 'gradient'):
        set_coloring(page, mode)
        page.wait_for_timeout(500)
        days = page.evaluate(DIAG)['days']
        assert len(days) == len(cards) - 1 >= 1, (mode, days, len(cards))
        assert all(abs(b['lat'] - syn.LAT) < 0.01 for b in days)
        assert [round(b['km']) for b in days] == [round(k * 120 / len(cards)) for k in range(1, len(cards))], (mode, days)
        markers = [s for s in page.evaluate("window.__WM_ROUTE_GRADIENT_DIAG__.routeStyles") if s['marker']]
        assert len(markers) == len(days) and all(m['fill'] == '#ffffff' for m in markers), (mode, markers)


def test_reversed_route_turns_climbs_into_descents(ui):
    page = open_route(ui)
    set_coloring(page, 'gradient')
    fwd = page.evaluate(DIAG)['sections']
    total = fwd[-1][1]
    ui.set_reverse(True)
    ui.get_weather()
    page.wait_for_timeout(500)
    rev = page.evaluate(DIAG)['sections']
    # km: (class forward, class of the same place travelled backwards)
    #   +5 % -> -5 % (descent) | -10 % -> +10 % (very steep) | +7.5 % -> -7.5 % (descent)
    #   -5 % -> +5 % (moderate) | +10.5 % -> -10.5 % (strong descent) | +14 % -> -14 %
    for km, (cls, back_cls) in {12: (5, 1), 15: (0, 7), 33: (6, 1), 37: (1, 5), 67: (7, 0), 78: (8, 0)}.items():
        assert section_at(fwd, km)[2] == cls, (km, section_at(fwd, km))
        back = section_at(rev, total - km)
        assert back[2] == back_cls, (km, back)
        assert (back[3] < 0) == (section_at(fwd, km)[3] > 0), (km, back)
    assert page.evaluate(DIAG)['mode'] == 'gradient'


def test_route_colour_choice_survives_a_reload(ui):
    page = open_route(ui)
    set_coloring(page, 'gradient')
    page.wait_for_timeout(1500)
    page.reload(wait_until='load')
    page.wait_for_function('() => window.__WM_ROUTE_GRADIENT_DIAG__')
    assert page.evaluate("document.getElementById('routeColoringMode').value") == 'gradient'
    assert page.evaluate("document.querySelector('[data-route-coloring=\"gradient\"]').getAttribute('aria-pressed')") == 'true'
