"""Tour Planning sidebar redesign (Sectors 1-3) and UI languages, in the real UI.

Sector 1 Tour & TourBook (header, menus, metadata), Sector 2 task tabs
(Overnight / Weather / Simulation / Analysis), Sector 3 collapsible preferences.
Language switching is immediate, persisted, falls back to English, and leaves
technical identifiers alone.
"""
from __future__ import annotations

import re

import pytest

import synthetic as syn

LANGS = {'en': 'Weather', 'de': 'Wetter', 'fr': 'Météo', 'es': 'Tiempo', 'zh-CN': '天气'}
# the TourBook PDF / Excel exports use these pinned libraries (index.html); nothing else may leave the test
EXPORT_LIBS = re.compile(r'^https://cdn\.jsdelivr\.net/npm/(jspdf@2\.5\.1|jspdf-autotable@3\.8\.2|xlsx-js-style@1\.2\.0)/dist/')


@pytest.fixture
def tour(ui):
    return _open_tour(ui)


@pytest.fixture
def export_tour(ui):
    ui.page.context.route(EXPORT_LIBS, lambda r: r.continue_())            # takes precedence over the blocking route
    tp = _open_tour(ui)
    if not tp.page.evaluate("!!(window.jspdf && window.jspdf.jsPDF && window.XLSX)"):
        pytest.skip('export libraries not reachable (offline)')
    return tp


def _open_tour(ui):
    ui.open()
    ui.tour()
    ui.import_gpx(syn.write_gpx(ui.backend.tmp / 'redesign.gpx', 300))
    return ui


def api_calls(ui):
    return [r.url for r in ui.requests]


def test_task_tabs_switch_panels_without_requests_and_remember_the_tab(tour):
    page = tour.page
    n = len(tour.requests)
    for tab in ('overnight', 'weather', 'simulation', 'analysis'):
        page.click(f'#tourTab-{tab}')
        page.wait_for_timeout(150)
        state = page.evaluate("""t => ({ selected: document.getElementById('tourTab-' + t).getAttribute('aria-selected'),
            shown: [...document.querySelectorAll('#wmZoneContext [role=tabpanel]')].filter(p => !p.hidden).map(p => p.id) })""", tab)
        assert state == {'selected': 'true', 'shown': [f'tourPanel-{tab}']}, state
    assert api_calls(tour)[n:] == [], 'switching tabs must not load or calculate anything'
    page.reload(wait_until='load')
    page.wait_for_function('() => window.__WM_LEAFLET_MAP__')
    tour.tour()
    page.wait_for_timeout(300)
    assert page.evaluate("document.getElementById('tourTab-analysis').getAttribute('aria-selected')") == 'true'


def test_menus_open_close_and_hold_each_command_once(tour):
    page = tour.page
    for menu, items in {'tour': ['tourProjectOpenBtn', 'tourProjectSaveBtn', 'tourProjectSaveAsBtn', 'tourProjectImportGpxBtn', 'prefsExportGpx'],
                        'route': ['tourSummaryFitAll'],
                        'export': ['tourPlanExportPdfBtn', 'tourPlanExportExcelBtn', 'prefsExportTourCsv']}.items():
        btn = f'.wm-menu[data-menu="{menu}"] .wm-menu-btn'
        assert not page.locator(f'#{items[0]}').is_visible()
        page.click(btn)
        assert page.get_attribute(btn, 'aria-expanded') == 'true'
        for i in items:
            assert page.locator(f'#{i}').count() == 1 and page.locator(f'#{i}').is_visible(), i
        page.keyboard.press('Escape')
        assert not page.locator(f'#{items[0]}').is_visible() and page.get_attribute(btn, 'aria-expanded') == 'false'
    page.click('.wm-menu[data-menu="tour"] .wm-menu-btn')
    page.mouse.click(900, 450)                                                   # outside click closes
    assert not page.locator('#tourProjectOpenBtn').is_visible()
    # one TourBook: no separate TourBook/plan-variant management
    assert page.evaluate("document.querySelectorAll('#tourPlanManageBtn, #tourPlanManager, #tourPlanList').length") == 0


def test_tourbook_button_toggles_the_tourbook_panel(tour):
    page = tour.page
    vis = lambda: page.evaluate("document.body.classList.contains('wm-roadbook-visible')")
    before = vis()
    page.click('#tourBookShowBtn')
    page.wait_for_timeout(300)
    assert vis() != before
    assert page.get_attribute('#tourBookShowBtn', 'aria-pressed') == ('true' if vis() else 'false')
    page.click('#tourBookShowBtn')
    page.wait_for_timeout(300)
    assert vis() == before


@pytest.mark.parametrize('item', ['tourPlanExportPdfBtn', 'tourPlanExportExcelBtn'])
def test_tourbook_exports_work_without_gpx_export(export_tour, item):
    tour = export_tour
    page = tour.page
    n = len(tour.requests)
    page.click('.wm-menu[data-menu="export"] .wm-menu-btn')
    with page.expect_download(timeout=30000) as dl:
        page.click(f'#{item}')
    name = dl.value.suggested_filename
    assert name.endswith('.pdf' if 'Pdf' in item else '.xlsx'), name
    assert dl.value.path().stat().st_size > 5000
    assert not [u for u in api_calls(tour)[n:] if 'gpx' in u.lower()], api_calls(tour)[n:]


def test_metadata_weather_summary_and_analysis_show_existing_values(tour):
    page = tour.page
    facts = page.evaluate("document.querySelector('.wm-s1-facts').innerText")
    assert 'km' in facts and 'm' in facts, facts
    page.click('#tourTab-weather')
    summary = page.evaluate("document.getElementById('tourWeatherSummary').innerText")
    assert '°C' in summary, summary
    page.click('#tourTab-analysis')
    analysis = page.evaluate("document.getElementById('tourAnalysis').innerText")
    days = page.evaluate("document.querySelectorAll('#roadbookList article.wm-roadbook-card').length")
    assert days >= 1 and 'km' in analysis, analysis
    # Sector 1 ascent and the Analysis elevation gain are the same value in metres
    num = lambda t: float(''.join(ch for ch in t if ch.isdigit()) or 0)
    s1_gain = num(page.evaluate("document.getElementById('tourSidebarRouteElevation').textContent"))
    an_gain = num(page.evaluate("""[...document.querySelectorAll('#tourAnalysis .wm-metric')]
        .find(m => /Elevation gain/.test(m.innerText)).querySelector('.wm-metric-value').textContent"""))
    assert abs(s1_gain - an_gain) <= max(100, 0.05 * an_gain), (s1_gain, an_gain)
    assert page.evaluate("document.querySelectorAll('#tourAnalysis .wm-grad-bar').length") == 1


def test_language_switch_is_immediate_persisted_and_formats_locally(tour):
    page = tour.page
    page.evaluate("document.querySelector('.wm-pgroup[data-pgroup=\"language\"]').open = true")
    for lang, label in LANGS.items():
        page.select_option('#uiLanguage', lang)
        page.wait_for_timeout(300)
        assert page.evaluate("document.getElementById('tourTab-weather').innerText.trim()") == label, lang
        assert page.evaluate("document.documentElement.lang") == lang
    assert page.evaluate("window.WM_I18N.formatNumber(1234.5, 1)") == '1,234.5'          # zh-CN
    page.select_option('#uiLanguage', 'de')
    page.wait_for_timeout(300)
    assert page.evaluate("window.WM_I18N.formatNumber(1234.5, 1)") == '1.234,5'
    assert page.evaluate("window.WM_I18N.monthName(3, 'long')") == 'März'
    page.reload(wait_until='load')
    page.wait_for_function('() => window.__WM_LEAFLET_MAP__')
    assert page.evaluate("window.WM_I18N.getLanguage()") == 'de'
    assert page.evaluate("document.getElementById('tourTab-weather').innerText.trim()") == 'Wetter'
    assert not tour.errors, tour.errors


def test_missing_translation_falls_back_to_english(tour):
    page = tour.page
    got = page.evaluate("""() => { const de = window.WM_I18N_RESOURCES.de; const keep = de['tabs.weather'];
        delete de['tabs.weather']; window.WM_I18N.setLanguage('de');
        const r = { text: window.WM_I18N.t('tabs.weather'), missing: [...window.WM_I18N.missing],
                    unknown: window.WM_I18N.t('no.such.key') };
        de['tabs.weather'] = keep; window.WM_I18N.setLanguage('en'); return r; }""")
    assert got['text'] == 'Weather' and 'de:tabs.weather' in got['missing'], got
    assert got['unknown'] == 'no.such.key'


def test_dynamic_status_texts_follow_the_language(tour):
    page = tour.page
    page.click('#tourTab-weather')
    en = page.evaluate("document.getElementById('tourWeatherSummary').innerText")
    page.evaluate("window.WM_I18N.setLanguage('fr')")
    page.wait_for_timeout(300)
    fr = page.evaluate("document.getElementById('tourWeatherSummary').innerText")
    assert fr != en
    page.evaluate("window.WM_I18N.setLanguage('en')")
