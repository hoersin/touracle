"""Explore Controls: three sidebar zones (primary / context / preferences), 2 x 6 months, Explore/Tour isolation.

The zone layout itself (only Zone 3 scrolls, both modes) is covered in test_sidebar_zones.py."""
from __future__ import annotations

import pytest

from test_explore_overlays import explore, grid_server, wait_ready, click_time, select_overlay, legend  # noqa: F401

TOUR_ONLY = ['#prefsSaveSettings', '#prefsSaveTourAs', '#prefsLoadSettings', '#prefsImportGpx', '#prefsExportGpx',
             '#prefsExportTourXls', '#prefsExportTourCsv', '#prefsPrintTourPdf', '#prefsShareSnapshot',
             '#setTempCold', '#setTempHot', '#setRainHigh', '#setWindHeadComfort']
ALWAYS = ['.wm-prefs-time-button[data-time-kind="year"]', '.wm-prefs-time-button[data-time-kind="month"][data-time-value="12"]',
          '#exploreOverlaySelect', '#exploreContextStatus', '#exploreContextProgress']


def visible(page, sel):
    return page.locator(sel).first.is_visible()


@pytest.mark.parametrize('viewport', [(1280, 800), (1440, 900), (5120, 2880)])
def test_always_controls_are_visible_without_expanding_or_scrolling(explore, viewport):
    page = explore(viewport)
    wait_ready(page)
    for sel in ALWAYS:
        assert page.evaluate("(s) => document.getElementById('wmZonePrimary').contains(document.querySelector(s))", sel), sel
        box = page.locator(sel).first.bounding_box()
        assert box and box['height'] > 0 and box['y'] + box['height'] <= viewport[1], (sel, box)
        assert page.evaluate("(s) => !document.querySelector(s).closest('details:not([open])')", sel), sel


def test_context_settings_stay_visible_and_preferences_are_in_zone_3(explore):
    page = explore((1280, 800))
    wait_ready(page)
    for sel in ('#strategicWindOn', '#setStrategicYears'):                      # Zone 2: always visible, no folding
        assert visible(page, sel) and page.evaluate("(s) => document.getElementById('wmZoneContext').contains(document.querySelector(s))", sel), sel
    for sel in ('#setInterpolation', '#setIncludeSea', '#setBasemap', '#settingsSave', '#settingsLoad', '#setWindDensity'):
        assert page.evaluate("(s) => document.getElementById('wmSidebarScroll').contains(document.querySelector(s))", sel), sel
        page.locator(sel).first.scroll_into_view_if_needed()
        assert visible(page, sel), sel
        assert visible(page, '#strategicWindOn') and visible(page, '#exploreOverlaySelect')   # never scrolled away


@pytest.mark.parametrize('viewport', [(1280, 800), (1440, 900)])
def test_months_form_a_2_by_6_grid_with_legible_buttons(explore, viewport):
    page = explore(viewport)
    wait_ready(page)
    boxes = page.evaluate("""() => [...document.querySelectorAll('.wm-prefs-time-button[data-time-kind="month"]')].map(b => {
        const r = b.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: r.width, h: r.height,
        f: parseFloat(getComputedStyle(b).fontSize), v: Number(b.dataset.timeValue) }; })""")
    assert [b['v'] for b in boxes] == list(range(1, 13))
    rows = sorted({b['y'] for b in boxes})
    assert len(rows) == 2, rows
    assert [len([b for b in boxes if b['y'] == y]) for y in rows] == [6, 6]
    assert [b['v'] for b in boxes if b['y'] == rows[0]] == [1, 2, 3, 4, 5, 6]
    assert all(b['w'] >= 36 and b['h'] >= 30 and b['f'] >= 11 for b in boxes), boxes


def test_selected_period_is_clearly_marked_and_announced(explore):
    page = explore()
    wait_ready(page)
    click_time(page, 'month', 8)
    wait_ready(page)
    pressed = page.evaluate("() => [...document.querySelectorAll('.wm-prefs-time-button[aria-pressed=\"true\"]')].map(b => b.dataset.timeValue)")
    assert pressed == ['8']
    colours = page.evaluate("""() => { const a = document.querySelector('.wm-prefs-time-button.is-active');
        const b = document.querySelector('.wm-prefs-time-button:not(.is-active)');
        return [getComputedStyle(a).backgroundColor, getComputedStyle(b).backgroundColor]; }""")
    assert colours[0] != colours[1]


def test_explore_shows_no_tour_planning_controls_and_tour_keeps_them(explore):
    page = explore()
    wait_ready(page)
    for sel in TOUR_ONLY:
        assert not visible(page, sel), f'{sel} visible in Explore'
    page.click('#navTour')
    page.wait_for_timeout(500)
    assert not visible(page, '#exploreOverlaySelect') and not visible(page, '.wm-prefs-time-button')
    assert page.locator('#prefsSaveTourAs').count() == 1 and page.locator('#prefsImportGpx').count() == 1
    page.locator('#prefsImportGpx').scroll_into_view_if_needed()
    assert visible(page, '#prefsImportGpx') and visible(page, '#prefsSaveTourAs')
    page.click('#navClimate')
    page.wait_for_timeout(500)
    assert visible(page, '#exploreOverlaySelect') and not visible(page, '#prefsSaveTourAs')


def test_dead_controls_are_gone(explore):
    page = explore()
    wait_ready(page)
    for pid in ('devDebugOverlayEnabled', 'devWeatherSamplesEnabled', 'devRouteSamplesEnabled', 'devReverseGeoEnabled',
                'devCacheInfoEnabled', 'setGridKm', 'strategicTimescale', 'strategicLayer', 'strategicTemporalPeriod'):
        assert page.locator(f'#{pid}').count() == 0, pid
    assert page.locator('#settingsSave').count() == 1 and page.locator('#settingsLoad').count() == 1


def test_no_nested_scroll_container_in_explore_controls(explore):
    page = explore((1280, 800))
    wait_ready(page)
    nested = page.evaluate("""() => [...document.querySelectorAll('#wmSidebar *')].filter(e => {
        const s = getComputedStyle(e); return e.offsetParent !== null && /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1;
      }).map(e => e.id || e.className)""")
    assert set(nested) <= {'wmSidebarScroll'}, nested                            # only Zone 3 scrolls


def test_explore_tour_explore_keeps_period_and_overlay(explore):
    page = explore()
    wait_ready(page)
    click_time(page, 'month', 8)
    wait_ready(page)
    select_overlay(page, 'precipitation')
    wait_ready(page)
    page.click('#navTour')
    page.wait_for_timeout(600)
    page.click('#navClimate')
    wait_ready(page)
    active = page.evaluate("() => [...document.querySelectorAll('.wm-prefs-time-button.is-active')].map(b => b.dataset.timeValue)")
    assert active == ['8']
    assert page.evaluate("document.getElementById('exploreOverlaySelect').value") == 'precipitation'
    assert 'Period: August' in legend(page)
