"""UI consolidation before Phase 4, in the real UI.

- Application mode selector in the sidebar header (not on the map).
- Three sectors with their own header, background and spacing; only Sector 3 scrolls.
- Reference years: exactly one of seven options (All years, Last three years, 2025..2021),
  used by the map overlay, the climate profile and every reference label.
- No Explore climate legend in Tour Planning.
- One TourBook per tour: no variant UI, no variants in tour files.
- Every user-visible text exists in all five languages (no missing keys, no raw keys).
"""
from __future__ import annotations

import json
import re

import pytest

import synthetic as syn
import test_offline_tile_lookup as tl
from test_explore_overlays import explore, grid_server, wait_ready  # noqa: F401  (fixtures)

LANGS = ('en', 'de', 'fr', 'es', 'zh-CN')
YEARS = (2025, 2024, 2023, 2022, 2021)
RAW_KEY = re.compile(r'^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$')


def ref_state(page, host='#setStrategicYears'):
    return page.evaluate("""h => { const rows = [...document.querySelectorAll(h + ' .wm-ref-years-row')];
        return { rows: rows.map(r => r.querySelectorAll('[role=radio]').length),
                 options: [...document.querySelectorAll(h + ' [role=radio]')].map(b => b.dataset.refYears),
                 checked: [...document.querySelectorAll(h + ' [role=radio][aria-checked=true]')].map(b => b.dataset.refYears),
                 group: document.querySelector(h).getAttribute('role') }; }""", host)


def pick(page, option, host='#setStrategicYears'):
    page.click(f'{host} [data-ref-years="{option}"]')
    page.wait_for_timeout(250)


# ------------------------------------------------------------ header/sectors ---
def test_mode_selector_is_in_the_sidebar_header_not_on_the_map(ui):
    ui.open()
    page = ui.page
    info = page.evaluate("""() => { const nav = document.getElementById('modeNav');
        const r = nav.getBoundingClientRect(), z = document.getElementById('wmZonePrimary').getBoundingClientRect();
        return { inHeader: !!document.getElementById('wmSidebarHeader').contains(nav),
                 inMap: !!(document.getElementById('mainPane') || document).contains(nav) && !document.getElementById('wmSidebar').contains(nav),
                 topNav: !!document.getElementById('topNav'), aboveSector1: r.bottom <= z.top + 1,
                 buttons: [...nav.querySelectorAll('[role=tab]')].map(b => b.id) }; }""")
    assert info == {'inHeader': True, 'inMap': False, 'topNav': False, 'aboveSector1': True,
                    'buttons': ['navClimate', 'navTour']}, info
    page.click('#navTour')
    assert page.evaluate("document.body.dataset.mode") == 'tour'
    assert page.get_attribute('#navTour', 'aria-selected') == 'true'
    pill = page.evaluate("getComputedStyle(document.getElementById('modeNavPill')).backgroundColor")
    accent = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--wm-accent').trim()")
    assert accent == '#0f766e' and pill == 'rgb(15, 118, 110)', (accent, pill)


@pytest.mark.parametrize('viewport', [(1280, 800), (1440, 900)])
def test_three_sectors_have_headers_backgrounds_and_spacing(ui, viewport):
    ui.page.set_viewport_size({'width': viewport[0], 'height': viewport[1]})
    ui.open()
    for mode in ('tour', 'climate'):
        ui.page.click('#navTour' if mode == 'tour' else '#navClimate')
        ui.page.wait_for_timeout(300)
        s = ui.page.evaluate("""() => { const z = ['wmZonePrimary', 'wmZoneContext', 'wmSidebarScroll'].map(id => document.getElementById(id));
            const head = (el) => { const h = el.querySelector('.wm-sector-head'); const r = h.getBoundingClientRect();
                const label = [...h.querySelectorAll('.wm-sector-label')].find(x => x.offsetParent !== null);
                return { h: Math.round(r.height), text: label ? label.innerText.trim() : '', bg: getComputedStyle(h).backgroundColor }; };
            const rect = z.map(e => e.getBoundingClientRect());
            return { heads: z.map(head), bg: z.map(e => getComputedStyle(e).backgroundColor),
                     gaps: [Math.round(rect[1].top - rect[0].bottom), Math.round(rect[2].top - rect[1].bottom)],
                     scroll: z.map(e => getComputedStyle(e).overflowY), bottom: Math.round(rect[2].bottom) }; }""")
        assert all(28 <= h['h'] <= 40 and h['text'] for h in s['heads']), (mode, s)
        assert len(set(s['bg'])) == 3, (mode, s['bg'])                                    # three distinct tones
        assert len({h['bg'] for h in s['heads']}) == 3, (mode, s['heads'])               # teal / pale teal / grey
        assert all(g >= 8 for g in s['gaps']), (mode, s['gaps'])                          # visible separation
        assert s['scroll'][2] == 'auto' and s['scroll'][0] != 'auto' and s['scroll'][1] != 'auto', s['scroll']
        assert s['bottom'] == viewport[1], s


# ----------------------------------------------------------- reference years ---
def test_reference_years_offer_exactly_one_of_seven_options(explore):
    page = explore()
    wait_ready(page)
    st = ref_state(page)
    assert st['group'] == 'radiogroup' and st['rows'] == [2, 5], st
    assert st['options'] == ['all', 'last3'] + [str(y) for y in YEARS], st
    assert len(st['checked']) == 1, st
    for option in ['last3', '2023', 'all', '2021', 'last3']:
        pick(page, option)
        assert ref_state(page)['checked'] == [option]
        pick(page, option)                                                     # clicking again keeps it selected
        assert ref_state(page)['checked'] == [option]
    # the map overlay requests exactly the selected years
    pick(page, '2022')
    wait_ready(page)
    assert explore.srv.grid.calls[-1].get('years') == '2022', explore.srv.grid.calls[-1]
    pick(page, '2024')                                                       # (earlier options are cached)
    wait_ready(page)
    assert explore.srv.grid.calls[-1].get('years') == '2024', explore.srv.grid.calls[-1]
    assert [c.get('years') for c in explore.srv.grid.calls if c.get('years') == '2025,2024,2023']   # last three years
    # one selection state: Tour Planning shows the same option, choosing there changes Explore too
    pick(page, 'last3')
    page.click('#navTour')
    page.click('#tourTab-weather')
    assert ref_state(page, '#tourWeatherYears')['checked'] == ['last3']
    pick(page, '2024', '#tourWeatherYears')
    page.click('#navClimate')
    assert ref_state(page)['checked'] == ['2024']


def test_old_multi_year_selection_is_normalised_to_one_option(explore):
    page = explore(init_script="""try { const s = JSON.parse(localStorage.getItem('touracle_settings') || '{}');
        s.strategicYears = [2025, 2023]; s.strategicYear = 2025; localStorage.setItem('touracle_settings', JSON.stringify(s)); } catch (e) {}""")
    wait_ready(page)
    assert len(ref_state(page)['checked']) == 1


def test_reference_period_reaches_the_climate_profile_and_its_labels(explore, monkeypatch, tmp_path):
    srv = explore.srv
    stores = {y: tl.make_store(tmp_path / f'offline_weather_{y}.sqlite', y, tl.NEAR_B) for y in YEARS}
    monkeypatch.setattr(srv.module, '_resolve_complete_reference_years', lambda n=3: (list(YEARS)[:n], []))
    monkeypatch.setattr(srv.module, '_resolve_offline_store_for_year', lambda y, **k: stores.get(int(y)))
    requests = []
    page = explore()
    page.on('request', lambda r: requests.append(r.url) if '/api/explore/climate_profile' in r.url else None)
    wait_ready(page)
    expect = {'2024': ('2024', '2024'), 'last3': ('2025%2C2024%2C2023', '2023–2025'),
              'all': ('2025%2C2024%2C2023%2C2022%2C2021', '2021–2025'), '2021': ('2021', '2021')}
    for option, (param, label) in expect.items():
        n = len(requests)
        pick(page, option)
        page.wait_for_function("l => (document.querySelector('[data-role=climate-reference]') || {}).textContent === 'Climate reference: ' + l"
                               " && document.querySelectorAll('.wm-climate-wind-rose-svg').length === 12", arg=label, timeout=20000)
        assert requests[n:] and all(f'years={param}' in u for u in requests[n:]), (option, requests[n:])
        bars = page.evaluate("[...document.querySelectorAll('.wm-climate-monthly-chart-svg rect title')].slice(0, 1).map(t => t.textContent)")
        assert bars and bars[0].endswith('Reference years: ' + label), bars              # chart tooltips: same period
    note = page.evaluate("(document.querySelector('[data-role=climate-grid-note]') || {}).textContent || ''")
    assert 'km climate grid' in note and 'not resolved' in note, note
    assert not page.errors, page.errors


# --------------------------------------------------------------------- legend ---
def test_tour_planning_never_shows_the_explore_climate_legend(explore):
    page = explore()
    wait_ready(page)
    hidden = lambda: page.evaluate("[...document.querySelectorAll('.wm-map-legend')].every(l => l.classList.contains('hidden') || l.offsetParent === null)")
    assert not hidden()                                                       # Explore: legend with the overlay
    for _ in range(2):
        page.click('#navTour')
        page.wait_for_timeout(600)
        assert hidden(), 'climate legend visible in Tour Planning'
        page.click('#navClimate')
        wait_ready(page)
        assert not hidden()


# ------------------------------------------------------------ one TourBook ---
def save_as(ui):
    ui.page.click('.wm-menu[data-menu="tour"] .wm-menu-btn')
    ui.page.click('#tourProjectSaveAsBtn')
    ui.page.wait_for_function('() => window.__saved.length > 0')
    return json.loads(ui.page.evaluate('window.__saved[window.__saved.length-1]'))


def test_one_tourbook_per_tour_without_variant_ui_or_files(loaded):
    ui = loaded
    page = ui.page
    assert page.evaluate("""() => document.querySelectorAll('#tourPlanManageBtn, #tourPlanManager, #tourPlanList,'
        + ' [data-action=duplicate], [data-action=rename], .wm-plan-item').length""") == 0
    texts = page.evaluate("document.getElementById('wmSidebar').innerText + ' ' + document.getElementById('roadbookPanel').innerText")
    assert not re.search(r'variant|duplicate|rename', texts, re.I), texts[:300]
    payload = save_as(ui)
    assert 'tourPlans' not in payload and 'activePlanId' not in payload, sorted(payload)
    assert payload['tourPlan']['roadbook']['days'], 'the one TourBook is in the file'
    store = page.evaluate("JSON.parse(localStorage.getItem('wm_tour_plan_store_v1'))")
    assert len(store['plans']) == 1, list(store['plans'])
    # importing another route replaces the TourBook instead of adding a variant
    ui.import_gpx(syn.write_gpx(ui.backend.tmp / 'second.gpx', 300))
    page.wait_for_timeout(2500)
    assert len(page.evaluate("JSON.parse(localStorage.getItem('wm_tour_plan_store_v1')).plans")) == 1


def test_a_legacy_file_with_several_plans_opens_only_its_active_tourbook(loaded):
    ui = loaded
    page = ui.page
    payload = save_as(ui)
    active = dict(payload['tourPlan'], id='plan-active')
    active['roadbook'] = dict(active['roadbook'], days=[dict(d, notes='') for d in active['roadbook']['days']])
    active['roadbook']['days'][0]['notes'] = 'active plan'
    other = json.loads(json.dumps(active))
    other['id'] = 'plan-other'
    other['roadbook']['days'][0]['notes'] = 'other variant'
    legacy = {k: v for k, v in payload.items() if k != 'tourPlan'}
    legacy.update(activePlanId='plan-active', tourPlans={
        'plan-other': {'id': 'plan-other', 'title': 'Other', 'plan': other},
        'plan-active': {'id': 'plan-active', 'title': 'Active', 'plan': active}})
    page.evaluate('t => { window.__open = t }', json.dumps(legacy))
    n = ui._arm()
    page.click('.wm-menu[data-menu="tour"] .wm-menu-btn')
    page.click('#tourProjectOpenBtn')
    ui.wait_weather(n)
    page.wait_for_timeout(2500)
    plans = page.evaluate("JSON.parse(localStorage.getItem('wm_tour_plan_store_v1')).plans")
    assert len(plans) == 1, list(plans)
    (plan,) = plans.values()
    notes = [d.get('notes') for d in plan['plan']['roadbook']['days'] if d.get('notes')]
    assert notes == ['active plan'], notes


def test_existing_browser_variants_are_backed_up_not_deleted(ui):
    store = {'version': 1, 'plans': {
        'a': {'id': 'a', 'title': 'A', 'updatedAt': 1, 'plan': {'id': 'a', 'title': 'A'}},
        'b': {'id': 'b', 'title': 'B', 'updatedAt': 2, 'plan': {'id': 'b', 'title': 'B'}}}}
    ui.page.context.add_init_script(f"""if (!sessionStorage.getItem('seeded')) {{ sessionStorage.setItem('seeded', '1');
        localStorage.setItem('wm_tour_plan_store_v1', {json.dumps(json.dumps(store))});
        localStorage.setItem('wm_active_tour_plan_id_v1', 'a'); }}""")
    ui.open()
    got = ui.page.evaluate("""() => ({ backup: JSON.parse(localStorage.getItem('wm_tour_plan_store_v1_variants_backup')),
        store: JSON.parse(localStorage.getItem('wm_tour_plan_store_v1')) })""")
    assert got['backup'] == store
    assert list(got['store']['plans']) == ['a']


# ---------------------------------------------------------- translations ---
def test_every_visible_text_exists_in_all_five_languages(loaded):
    """Both modes, all task tabs and menus, the TourBook and the preference groups in
    every language: no missing translation (no English fallback used) and no raw key."""
    ui = loaded
    page = ui.page
    page.evaluate("document.querySelectorAll('#wmSidebarScroll details.wm-pgroup').forEach(d => d.open = true)")
    raw = []
    for lang in LANGS:
        page.evaluate("l => window.WM_I18N.setLanguage(l)", lang)
        page.wait_for_timeout(300)
        for mode in ('#navTour', '#navClimate', '#navTour'):
            page.click(mode)
            page.wait_for_timeout(300)
            if mode == '#navTour':
                for tab in ('overnight', 'weather', 'simulation', 'analysis'):
                    page.click(f'#tourTab-{tab}')
                    page.wait_for_timeout(150)
                    raw += page.evaluate("""re => { const out = []; const rx = new RegExp(re);
                        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
                        while ((n = w.nextNode())) { const t = n.textContent.trim(); const p = n.parentElement;
                          if (t && p && p.offsetParent !== null && !p.closest('script,style') && rx.test(t)) out.push(t); }
                        for (const e of document.querySelectorAll('[title],[aria-label],[placeholder]'))
                          for (const a of ['title', 'aria-label', 'placeholder']) { const v = (e.getAttribute(a) || '').trim(); if (v && rx.test(v)) out.push(a + ':' + v); }
                        return out; }""", RAW_KEY.pattern)
        assert page.evaluate("document.documentElement.lang") == lang
    missing = page.evaluate("[...window.WM_I18N.missing]")
    page.evaluate("window.WM_I18N.setLanguage('en')")
    assert not missing, missing
    assert not raw, sorted(set(raw))[:20]
    assert not ui.errors, ui.errors
