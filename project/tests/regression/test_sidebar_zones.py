"""Three-zone sidebar (Explore and Tour Planning).

Zone 1 Primary controls and Zone 2 Context settings are always visible and never
scroll; Zone 3 Preferences (#wmSidebarScroll) takes the remaining height and is the
only scroll container. Checked in the real UI at the target viewports.
"""
from __future__ import annotations

import pytest

import synthetic as syn
from conftest import HERE, TourPage

ZONES = ('wmZonePrimary', 'wmZoneContext', 'wmSidebarScroll')
LAYOUT = """() => {
  const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
  const sb = document.getElementById('wmSidebar');
  const scrollers = [...sb.querySelectorAll('*')].filter(e => /(auto|scroll)/.test(getComputedStyle(e).overflowY)
      && e.scrollHeight > e.clientHeight + 1 && e.getClientRects().length).map(e => e.id || e.className);
  const zs = document.getElementById('wmSidebarZones');
  const tryScroll = el => { const b = el.scrollTop; el.scrollTop = b + 200; const moved = el.scrollTop !== b; el.scrollTop = b; return moved; };
  return { primary: r('wmZonePrimary'), context: r('wmZoneContext'), prefs: r('wmSidebarScroll'),
           scrollers, sidebarScrolls: tryScroll(sb) || tryScroll(zs) || tryScroll(document.scrollingElement),
           sidebarBottom: sb.getBoundingClientRect().bottom, viewport: innerHeight,
           map: document.getElementById('map').getBoundingClientRect().width }; }"""
REACH = """() => {
  const bad = []; let n = 0;
  const els = [...document.querySelectorAll('#wmSidebarZones button, #wmSidebarZones input, #wmSidebarZones select, #wmSidebarZones summary')]
    .filter(e => e.type !== 'file' && !e.classList.contains('wm-visually-hidden') && !e.classList.contains('wm-slider-native')
                 && !e.classList.contains('wm-slider-editor'));
  for (const e of els) {
    if (e.closest('[hidden]') || !e.getClientRects().length) continue;            // not part of this mode
    const det = e.closest('details:not([open])'); if (det && !e.closest('summary')) continue;
    n++;
    e.scrollIntoView({ block: 'nearest' });
    const b = e.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + Math.max(1, Math.min(b.width - 1, b.width / 2)), b.top + Math.max(1, Math.min(b.height - 1, b.height / 2)));
    const zone = ['wmZonePrimary', 'wmZoneContext', 'wmSidebarScroll'].map(z => document.getElementById(z)).find(z => z.contains(e));
    const zr = zone.getBoundingClientRect();
    const ok = hit && (hit === e || e.contains(hit) || hit.contains(e) || (e.labels && [...e.labels].some(l => l.contains(hit))));
    if (!ok || b.top < zr.top - 1 || b.bottom > zr.bottom + 1) bad.push(e.id || e.textContent.trim().slice(0, 24));
  }
  document.getElementById('wmSidebarScroll').scrollTop = 0;
  return { checked: n, bad }; }"""
EXPLORE_ZONES = {
    'wmZonePrimary': ['exploreOverlaySelect', 'exploreContextProgress', 'exploreContextStatus'],
    'wmZoneContext': ['setStrategicYears', 'strategicWindOn'],
    'wmSidebarScroll': ['setWindDensity', 'setAnimSpeed', 'setInterpolation', 'setIncludeSea', 'setBasemap',
                        'settingsSave', 'settingsLoad', 'devDiagnosticsEnabled', 'wmSectionCalcGuide'],
}
TOUR_ZONES = {
    # Sector 1 - Tour & TourBook: header, menus (Tour / Route / TourBook / Export), compact metadata
    'wmZonePrimary': ['tourProjectTitle', 'tourProjectStatus', 'tourProjectOpenBtn', 'tourProjectSaveBtn', 'tourProjectSaveAsBtn',
                      'tourProjectImportGpxBtn', 'prefsExportGpx', 'reverse', 'tourSummaryFitAll', 'routeColoringMode',
                      'tourBookShowBtn', 'tourPlanExportPdfBtn', 'tourPlanExportExcelBtn', 'prefsExportTourCsv',
                      'startDate', 'tourDays', 'arrivalDate', 'tourSidebarDays'],
    # Sector 2 - Tasks: Overnight / Weather / Simulation / Analysis
    'wmZoneContext': ['tourTab-overnight', 'tourTab-weather', 'tourTab-simulation', 'tourTab-analysis',
                      'overnightSearchBtn', 'tourWeatherModeClimate', 'tourWeatherModeForecast', 'tourWeatherYears',
                      'fetchWeather', 'stopWeather', 'progress', 'sseStatus', 'tourWeatherSummary',
                      'tourSlotOptimizeBtn', 'tourAnalysis'],
    # Sector 3 - Preferences: the only scroll area
    'wmSidebarScroll': ['uiLanguage', 'setBasemap', 'dropZone', 'setStepKm', 'progressDetails', 'weatherQuality',
                        'settingsSave', 'settingsLoad', 'devDiagnosticsEnabled', 'wmSectionCalcGuide'],
}
# removed in the redesign: duplicate commands and the separate plan-variant manager
TOUR_REMOVED = ('wmPrefsGlobalSection', 'prefsSaveSettings', 'prefsSaveTourAs', 'prefsLoadSettings', 'prefsImportGpx',
                'prefsExportTourXls', 'prefsPrintTourPdf', 'prefsShareSnapshot', 'tourPlanManageBtn', 'tourPlanManager',
                'advancedWeatherPrefs')


# visually hidden select behind the segmented buttons; Stop is shown only while a stream runs
ONLY_WHILE_ACTIVE = ('routeColoringMode', 'stopWeather')


@pytest.fixture
def sized(server, chromium):
    ctxs = []

    def open_(w, h):
        ctx = chromium.new_context(viewport={'width': w, 'height': h})
        leaflet = (HERE / 'vendor' / 'leaflet-1.9.4.js').read_text(encoding='utf-8')
        ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith(server.url) else (
            r.fulfill(body=leaflet, content_type='text/javascript') if 'leaflet' in r.request.url and r.request.url.endswith('.js') else r.abort()))
        ctxs.append(ctx)
        tp = TourPage(ctx.new_page(), server.url)
        tp.backend = server
        tp.open()
        if tp.page.evaluate("document.body.dataset.mode") != 'climate':
            tp.explore()
        return tp
    yield open_
    for c in ctxs:
        c.close()


def check_layout(page, min_prefs_px, min_controls=20):
    page.evaluate("document.getElementById('wmSidebarScroll').scrollTop = 0")
    top = page.evaluate(LAYOUT)
    assert not top['sidebarScrolls'], 'the sidebar itself must not scroll'
    assert set(top['scrollers']) <= {'wmSidebarScroll'}, f"only Zone 3 may scroll: {top['scrollers']}"
    assert top['primary']['bottom'] <= top['context']['top'] + 1 and top['context']['bottom'] <= top['prefs']['top'] + 1
    assert abs(top['prefs']['bottom'] - top['viewport']) <= 1, 'Zone 3 fills the remaining height'
    assert top['prefs']['height'] >= min_prefs_px, f"Zone 3 too small: {top['prefs']['height']}"
    page.evaluate("document.getElementById('wmSidebarScroll').scrollTop = 1e6")
    page.mouse.move(150, top['prefs']['top'] + 40)
    page.mouse.wheel(0, -300)
    page.wait_for_timeout(200)
    after = page.evaluate(LAYOUT)
    assert after['primary'] == top['primary'] and after['context'] == top['context'], 'Zones 1 and 2 must not move'
    reach = page.evaluate(REACH)
    assert reach['checked'] > min_controls and not reach['bad'], reach
    return top


def check_contents(page, zones):
    for zone, ids in zones.items():
        for ident in ids:
            assert page.evaluate("([z, i]) => document.getElementById(z).contains(document.getElementById(i))", [zone, ident]), (zone, ident)
    # shown in this mode (controls inside a collapsed group count when the group itself is shown)
    hidden = page.evaluate("""ids => ids.filter(i => { const e = document.getElementById(i);
        // a control in a closed menu, an inactive task tab or a collapsed group counts when its opener is shown
        const menu = e.closest('.wm-menu'), panel = e.closest('[role="tabpanel"]');
        const box = menu && e.closest('.wm-menu-pop') ? menu.querySelector('.wm-menu-btn')
                  : panel && panel.hidden ? document.getElementById(panel.getAttribute('aria-labelledby'))
                  : e.closest('details:not([open])') ? e.closest('details').querySelector('summary') : e;
        return !box.getClientRects().length; })""",
                           [i for ids in zones.values() for i in ids if i not in ONLY_WHILE_ACTIVE])
    assert not hidden, hidden


@pytest.mark.parametrize('w,h', [(1280, 800), (1440, 900)])
def test_explore_three_zones_only_preferences_scroll(sized, w, h):
    tp = sized(w, h)
    tp.page.wait_for_timeout(500)
    check_layout(tp.page, min_prefs_px=250)
    check_contents(tp.page, EXPLORE_ZONES)


@pytest.mark.parametrize('w,h', [(1280, 800), (1440, 900)])
def test_tour_three_zones_only_preferences_scroll(sized, w, h):
    tp = sized(w, h)
    tp.tour()
    tp.import_gpx(syn.write_gpx(tp.backend.tmp / 'zones.gpx', 420))
    for tab in ('overnight', 'weather', 'simulation', 'analysis'):
        tp.page.click(f'#tourTab-{tab}')
        tp.page.wait_for_timeout(150)
        check_layout(tp.page, min_prefs_px=170, min_controls=12)   # commands sit in closed menus
    check_contents(tp.page, TOUR_ZONES)
    assert tp.page.evaluate("ids => ids.filter(i => document.getElementById(i))", list(TOUR_REMOVED)) == []


def test_switching_modes_keeps_the_structure_and_the_map_width(sized):
    tp = sized(1440, 900)
    width = lambda: tp.page.evaluate("document.getElementById('map').getBoundingClientRect().width")
    explore_w = width()
    tp.tour()
    tp.import_gpx(syn.write_gpx(tp.backend.tmp / 'zones.gpx', 420))
    assert width() < explore_w                                   # TourBook panel takes its space
    tp.explore()
    tp.page.wait_for_timeout(800)
    assert width() == explore_w, 'the map must regain the TourBook space in Explore'
    for _ in range(2):
        for mode in (tp.tour, tp.explore):
            mode()
            tp.page.wait_for_timeout(400)
            lay = tp.page.evaluate(LAYOUT)
            assert not lay['sidebarScrolls'] and set(lay['scrollers']) <= {'wmSidebarScroll'}


def test_controls_moved_into_zones_still_save_their_settings(sized):
    tp = sized(1440, 900)
    page = tp.page
    stored = lambda key: page.evaluate("k => (JSON.parse(localStorage.getItem('touracle_settings') || '{}').data || {})[k]", key)
    page.evaluate("() => { const e = document.getElementById('setInterpolation'); e.scrollIntoView(); }")
    before = page.evaluate("document.getElementById('setInterpolation').checked")
    page.click('label[for="setInterpolation"], #setInterpolation', force=True)
    page.wait_for_timeout(1500)
    assert page.evaluate("document.getElementById('setInterpolation').checked") != before
    assert stored('interpolation') == (not before)
    page.click('#strategicWindOn', force=True)
    page.wait_for_timeout(800)
    assert stored('strategicWindOn') is True
