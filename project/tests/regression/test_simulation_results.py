"""Simulation: one source of truth for the reference years and the results panel, in the real UI.

The Weather tab's reference-year selection is the only setting: the Simulation tab shows it
read-only, sends exactly those years and marks results computed for another period as
outdated. The results panel (reliability, metric cards, four metric tabs, chart, top 3,
recommendation) shows the optimizer's own values; selecting a date in the chart never
changes the tour, only "Apply selected departure date" does.
"""
from __future__ import annotations

import json

import pytest

import synthetic as syn

OPTIONS = ['all', 'last3', '2025', '2024', '2023', '2022', '2021']
EXPECT_YEARS = {'all': [2025, 2024, 2023, 2022, 2021], 'last3': [2025, 2024, 2023], '2025': [2025], '2024': [2024],
                '2023': [2023], '2022': [2022], '2021': [2021]}


@pytest.fixture
def sim(loaded):
    ui = loaded
    ui.sim_requests = []
    ui.sim_results = []
    ui.page.on('request', lambda r: ui.sim_requests.append(json.loads(r.post_data))
               if '/api/tour_slot_optimizer/start' in r.url else None)

    def on_response(r):
        if '/api/tour_slot_optimizer/result/' in r.url:
            try:
                body = r.json()
                if body.get('status') == 'done':
                    ui.sim_results.append(body['result'])
            except Exception:
                pass
    ui.page.on('response', on_response)
    return ui


def choose_years(ui, option):
    ui.page.click('#tourTab-weather')
    ui.page.click(f'#tourWeatherYears [data-ref-years="{option}"]')
    ui.page.wait_for_timeout(300)


def run_sim(ui):
    ui.page.click('#tourTab-simulation')
    n = len(ui.sim_results)
    ui.page.click('#tourSlotOptimizeBtn')
    ui.page.wait_for_function("() => { const p = document.getElementById('simResultsPanel'); return p && !p.hidden && document.querySelector('.wm-sim-chart'); }", timeout=60000)
    ui.page.wait_for_timeout(300)
    assert len(ui.sim_results) > n
    return ui.sim_results[-1]


def text(ui, sel):
    return ui.page.evaluate("s => (document.querySelector(s) || {}).textContent || ''", sel)


def test_simulation_has_no_own_years_and_shows_the_weather_reference(sim):
    page = sim.page
    page.click('#tourTab-simulation')
    assert page.evaluate("!!document.getElementById('tourSlotHorizonYears')") is False
    assert page.evaluate("document.querySelectorAll('#tourPanel-simulation select').length") == 2      # step, direction
    for option in OPTIONS:
        choose_years(sim, option)                         # changed in Weather ...
        page.click('#tourTab-simulation')                 # ... shown immediately in Simulation
        ys = EXPECT_YEARS[option]
        period = str(ys[0]) if len(ys) == 1 else f'{min(ys)}–{max(ys)}'
        label = text(sim, '#tourSlotReference')
        assert label.startswith(f'Historical reference: {period}'), (option, label)
        if option == 'all':
            assert label.endswith('(All years)'), label
        if option == 'last3':
            assert label.endswith('(Last three years)'), label
        checked = page.evaluate("[...document.querySelectorAll('#tourWeatherYears [aria-checked=true]')].map(b => b.dataset.refYears)")
        assert checked == [option]


@pytest.mark.parametrize('option', ['last3', '2022'])
def test_simulation_uses_exactly_the_selected_reference_period(sim, option):
    choose_years(sim, option)
    result = run_sim(sim)
    assert sim.sim_requests[-1]['yearsSelected'] == EXPECT_YEARS[option]
    assert 'horizonYears' not in sim.sim_requests[-1]
    assert result['meta']['requested_years'] == sorted(EXPECT_YEARS[option])
    ys = EXPECT_YEARS[option]
    period = str(ys[0]) if len(ys) == 1 else f'{min(ys)}–{max(ys)}'
    assert period in text(sim, '[data-role=sim-ref]') and period in text(sim, '#simResultsSubtitle')
    assert not text(sim, '[data-role=sim-stale]')


def test_changing_the_weather_reference_marks_results_outdated(sim):
    choose_years(sim, 'last3')
    run_sim(sim)
    choose_years(sim, '2024')
    stale = text(sim, '[data-role=sim-stale]')
    assert 'now 2024' in stale and '2023–2025' in stale, stale
    sim.page.click('#tourTab-simulation')
    assert text(sim, '#tourSlotReference') == 'Historical reference: 2024'
    run_sim(sim)
    assert sim.sim_requests[-1]['yearsSelected'] == [2024] and not text(sim, '[data-role=sim-stale]')


def test_four_metric_tabs_show_one_metric_each(sim):
    result = run_sim(sim)
    page = sim.page
    curves = {c['id']: c for c in result['meta']['year_penalty_curve_bundle']['curves']}
    meta = result['meta']
    expect = {'precip': ('lowest_precip_sum', 'Precipitation', meta['total_days']), 'temp': ('highest_avg_temperature', 'temperature', 1),
              'headwind': ('lowest_headwind_sum', 'Headwind', meta['ride_days']), 'lucky': ('most_lucky_days', 'Lucky days', 1)}
    for metric, (curve, title, divisor) in expect.items():
        page.click(f'[data-sim-metric="{metric}"]')
        page.wait_for_timeout(150)
        st = page.evaluate("""() => ({ metric: document.querySelector('.wm-sim-chart').dataset.metric,
            selected: [...document.querySelectorAll('[data-sim-metric][aria-selected=true]')].map(b => b.dataset.simMetric),
            lines: document.querySelectorAll('.wm-sim-chart .wm-sim-line').length,
            axis: document.querySelector('.wm-sim-axis-title').textContent })""")
        assert st['metric'] == metric and st['selected'] == [metric] and st['lines'] == 1, st
        assert title in st['axis'], st
    # the readout shows the optimizer value of the hovered date (converted to its display unit)
    page.click('[data-sim-metric="precip"]')
    box = page.locator('.wm-sim-hit').bounding_box()
    page.mouse.move(box['x'] + 2, box['y'] + box['height'] / 2)
    page.wait_for_timeout(200)
    first = curves['lowest_precip_sum']['points'][0]
    readout = text(sim, '[data-role=sim-readout]')
    assert f"{first['value'] / meta['total_days']:.1f} mm/day" in readout, (readout, first)


def test_chart_selection_never_changes_the_tour_until_applied(sim):
    result = run_sim(sim)
    page = sim.page
    before = page.evaluate("({ start: document.getElementById('startDate').value, days: document.getElementById('tourDays').value })")
    s0 = sim.structure()
    box = page.locator('.wm-sim-hit').bounding_box()
    page.mouse.click(box['x'] + box['width'] * 0.8, box['y'] + box['height'] / 2)
    page.wait_for_timeout(300)
    selection = text(sim, '[data-role=sim-selection]')
    assert selection.startswith('Selected departure:'), selection
    assert page.evaluate("document.getElementById('startDate').value") == before['start']     # nothing applied
    # pick the third-ranked option in the table and apply it
    third = result['candidates'][2]['start_date']
    page.click(f'.wm-sim-top-row[data-iso="{third}"]')
    assert page.evaluate("document.getElementById('startDate').value") == before['start']
    n = sim._arm()
    page.click('#wmSlotApplySelected')
    sim.wait_weather(n)
    after = page.evaluate("({ start: document.getElementById('startDate').value, days: document.getElementById('tourDays').value })")
    assert after == {'start': third, 'days': before['days']}, after
    s1 = sim.structure()
    assert s1['rest'] == s0['rest'] and len(s1['days']) == len(s0['days'])           # duration and rest days kept
    assert text(sim, '#tourSlotStatus').startswith('Applied slot:')
    assert sim.autosaved_plan()['settings']['startDate'] == third                     # existing autosave picked it up


def test_top_three_follow_the_simulation_ranking(sim):
    result = run_sim(sim)
    rows = sim.page.evaluate("[...document.querySelectorAll('.wm-sim-top-row')].map(r => ({ iso: r.dataset.iso, lucky: r.children[2].textContent, best: r.classList.contains('is-best') }))")
    cands = result['candidates'][:3]
    assert [r['iso'] for r in rows] == [c['start_date'] for c in cands]
    assert [r['lucky'] for r in rows] == [f"{c['summary']['lucky_days']} / {c['summary']['day_count']}" for c in cands]
    assert [r['best'] for r in rows] == [True, False, False]
    best_card = text(sim, '.wm-sim-card.is-best .wm-sim-card-note')
    assert f"{cands[0]['summary']['lucky_days']} of {cands[0]['summary']['day_count']} days" in best_card


def test_reliability_and_range_band_come_from_the_individual_years(sim, monkeypatch):
    """With several reference years the lookup reports the individual years: the chart
    shows their range and the reliability states how many years confirm the date."""
    real = sim.backend.module._get_offline_stats

    def per_year(lat, lon, month, day, **kw):
        base = real(lat, lon, month, day, **kw)
        years = kw.get('years_selected') or []
        if base is None or not kw.get('include_per_year') or len(years) < 2:
            return base
        out = dict(base)
        out['_per_year'] = {int(y): dict(base, precipitation_mm=float(base.get('precipitation_mm') or 0) + i) for i, y in enumerate(years)}
        out['_years_used'] = sorted(int(y) for y in years)
        return out
    monkeypatch.setattr(sim.backend.module, '_get_offline_stats', per_year)
    choose_years(sim, 'last3')
    result = run_sim(sim)
    rel = result['meta']['reliability']
    shown = text(sim, '[data-role=sim-reliability]')
    assert f"{rel['years_in_top']} of {rel['years_assessed']} individual years" in shown, shown
    assert 'Weather data cover 100% of the tour days' in shown
    assert sim.page.evaluate("!!document.querySelector('.wm-sim-band')")
    # one reference year: no range, reliability not assessable
    choose_years(sim, '2024')
    run_sim(sim)
    assert not sim.page.evaluate("!!document.querySelector('.wm-sim-band')")
    assert 'Not assessable' in text(sim, '[data-role=sim-reliability]')


def test_results_panel_in_all_five_languages(sim):
    run_sim(sim)
    page = sim.page
    seen = {}
    for lang in ('en', 'de', 'fr', 'es', 'zh-CN'):
        page.evaluate("l => window.WM_I18N.setLanguage(l)", lang)
        page.wait_for_timeout(300)
        seen[lang] = text(sim, '#simResultsTitle') + '|' + text(sim, '#wmSlotApplySelected')
    page.evaluate("window.WM_I18N.setLanguage('en')")
    assert len(set(seen.values())) == 5, seen
    assert page.evaluate("[...window.WM_I18N.missing]") == []
