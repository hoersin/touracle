"""Explore map overlays (Phase 2): loading, rendering, progress, controls, persistence.

The real Flask app runs with its real Strategic Grid admission lock (one computation
at a time, HTTP 429 for a different concurrent request); only the aggregation itself
is replaced by the synthetic grid in ``explore_synthetic`` with a configurable delay.
What the user sees is read from the page: map canvas pixels, legend, status, controls.
"""
from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest
from flask import jsonify, request

import explore_synthetic as xs
from conftest import HERE

LAND = [(48.5, 10.0), (47.0, 2.5), (51.0, 19.0), (45.5, 10.5)]   # inland points inside the default view


@pytest.fixture
def grid_server(server, monkeypatch):
    """Server whose Strategic Grid computation is synthetic and slow on demand."""
    cfg = SimpleNamespace(delay=0.0, gradient=0.0, fail_months=set(), calls=[])

    def impl():
        args = request.args.to_dict()
        cfg.calls.append(args)
        time.sleep(cfg.delay)
        if xs.period_month(args) in cfg.fail_months:
            return jsonify({'error': 'Aggregation failed: synthetic failure'}), 500
        return jsonify(xs.grid(args, gradient=cfg.gradient))

    monkeypatch.setattr(server.module, '_api_strategic_grid_impl', impl)
    server.grid = cfg
    return server


def _open(chromium, srv, viewport=(1440, 900), init_script=None):
    ctx = chromium.new_context(viewport={'width': viewport[0], 'height': viewport[1]})
    leaflet = (HERE / 'vendor' / 'leaflet-1.9.4.js').read_text(encoding='utf-8')

    def route(r):
        url = r.request.url
        if url.startswith(srv.url):
            r.continue_()
        elif 'leaflet' in url and url.endswith('.js'):
            r.fulfill(body=leaflet, content_type='text/javascript')
        else:
            r.abort()

    ctx.route('**/*', route)
    if init_script:
        ctx.add_init_script(init_script)
    page = ctx.new_page()
    page.ctx = ctx
    page.grid_responses = []
    page.errors = []
    page.on('response', lambda r: page.grid_responses.append((time.monotonic(), r.status, r.url))
            if '/api/strategic_grid' in r.url else None)
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    page.goto(srv.url, wait_until='load')
    page.wait_for_function('() => typeof window.setMode === "function" && window.__WM_LEAFLET_MAP__')
    if page.evaluate("document.body.dataset.mode") != 'climate':
        page.click('#navClimate')
    return page


@pytest.fixture
def explore(grid_server, chromium):
    pages = []

    def open_(viewport=(1440, 900), init_script=None):
        p = _open(chromium, grid_server, viewport, init_script)
        pages.append(p)
        return p

    open_.srv = grid_server
    yield open_
    for p in pages:
        p.ctx.close()


# ----------------------------------------------------------------- helpers ---
def progress(page):
    return page.evaluate("""() => { const p = document.getElementById('exploreContextProgress');
        return { state: p.dataset.state || '', now: p.getAttribute('aria-valuenow'),
                 text: (document.getElementById('exploreContextStatus') || {}).textContent || '' }; }""")


def wait_ready(page, timeout=20000):
    page.wait_for_function(
        "() => (document.getElementById('exploreContextProgress') || {dataset:{}}).dataset.state === 'ready'",
        timeout=timeout)


def diag(page):
    return page.evaluate("() => { const d = window.__WM_EXPLORE_DIAG__; return d ? { renders: d.renders, lastRenderMs: d.lastRenderMs } : null; }")


def renders(page):
    d = diag(page)
    assert d is not None, 'Explore render diagnostics are missing'
    return d['renders']


def pixels(page, layer_class, points):
    """RGBA of the given overlay canvas at lat/lon positions."""
    return page.evaluate("""([cls, pts]) => {
        const c = document.querySelector(`.${cls} canvas`); const m = window.__WM_LEAFLET_MAP__;
        if (!c) return pts.map(() => [0, 0, 0, 0]);
        const ctx = c.getContext('2d'); const k = c.width / Math.max(1, c.clientWidth);
        return pts.map(([lat, lon]) => { const p = m.latLngToContainerPoint([lat, lon]);
            return Array.from(ctx.getImageData(Math.round(p.x * k), Math.round(p.y * k), 1, 1).data); }); }""",
        [layer_class, [list(p) for p in points]])


def coverage(page, layer_class):
    """Share of sampled canvas pixels that are not transparent."""
    return page.evaluate("""(cls) => { let n = 0, hit = 0;
        for (const c of document.querySelectorAll(`.${cls} canvas`)) {
          if (!c.width || !c.height) continue;
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < d.length; i += 4 * 97) { n++; if (d[i] > 8) hit++; } }
        return n ? hit / n : 0; }""", layer_class)


def temp_rgb(page, t):
    return page.evaluate("""(t) => { const sc = window.WM_TEMP_SCALE; const h = sc.TEMP_COLORS[sc.getTempBinIndex(t)];
        const v = sc.hexToRgb(h); return [v.r, v.g, v.b]; }""", t)


def close(rgba, rgb, tol=16):
    return rgba[3] > 0 and all(abs(a - b) <= tol for a, b in zip(rgba[:3], rgb))


def legend(page):
    return page.evaluate("() => (document.getElementById('wmStrategicLegendNote') || {}).textContent || ''")


def click_time(page, kind, value):
    page.click(f'.wm-prefs-time-button[data-time-kind="{kind}"][data-time-value="{value}"]')


def select_overlay(page, value):
    page.select_option('#exploreOverlaySelect', value, timeout=3000)


def statuses(page):
    return [s for _t, s, _u in page.grid_responses]


# ------------------------------------------------------------------- D1 ------
def test_initial_load_shows_overlay_without_any_click(explore):
    explore.srv.grid.delay = 2.5
    page = explore()
    wait_ready(page, timeout=25000)
    assert 429 not in statuses(page), f'the page collided with its own request: {statuses(page)}'
    assert coverage(page, 'wm-strategic-heat') > 0.05, 'no overlay drawn after start'
    assert all(close(px, temp_rgb(page, xs.YEAR_TEMP)) for px in pixels(page, 'wm-strategic-heat', LAND))
    assert len(explore.srv.grid.calls) <= 2


def test_busy_server_is_retried_while_request_is_current(explore):
    srv = explore.srv
    srv.grid.delay = 4.0
    blocker = threading.Thread(target=lambda: srv.app.test_client().get(
        '/api/strategic_grid', query_string={'timescale': 'year', 'date': '01-01', 'lat_min': 0,
                                             'lat_max': 1, 'lon_min': 0, 'lon_max': 1}))
    blocker.start()
    time.sleep(0.3)
    srv.grid.delay = 0.3
    page = explore()
    page.wait_for_timeout(1500)
    assert progress(page)['state'] in ('loading', 'waiting'), progress(page)
    wait_ready(page, timeout=25000)
    blocker.join()
    assert 429 in statuses(page), 'test precondition: the server was busy'
    assert coverage(page, 'wm-strategic-heat') > 0.05


# ------------------------------------------------------------------- D2 ------
def test_interpolation_uses_the_tiles_at_the_sampled_position(explore):
    explore.srv.grid.gradient = 1.0            # 1 °C per degree of longitude
    page = explore()
    wait_ready(page)
    for lat, lon in [(48.0, 4.0), (48.0, 10.0), (48.0, 16.0), (52.0, 21.0)]:
        s = page.evaluate("([a, b]) => window.__WM_EXPLORE_DIAG__.sampleAt(a, b)", [lat, lon])
        want = xs.temperature(None, lon, 1.0)
        assert s and abs(s['temperature_c'] - want) < 0.6, (lat, lon, s and s['temperature_c'], want)


def test_interpolation_setting_switches_to_nearest_tile(explore):
    explore.srv.grid.gradient = 1.0
    page = explore()
    wait_ready(page)
    smooth = page.evaluate("() => [9.3, 9.6, 9.9].map(l => window.__WM_EXPLORE_DIAG__.sampleAt(48, l).temperature_c)")
    page.evaluate("() => { const d = document.getElementById('advancedWeatherPrefs'); if (d) d.open = true; }")
    page.evaluate("() => { const e = document.getElementById('setInterpolation'); e.checked = false; e.dispatchEvent(new Event('change', {bubbles: true})); }")
    page.wait_for_timeout(400)
    nearest = page.evaluate("() => [9.3, 9.6, 9.9].map(l => window.__WM_EXPLORE_DIAG__.sampleAt(48, l).temperature_c)")
    assert len(set(round(v, 6) for v in smooth)) == 3, smooth
    assert len(set(round(v, 6) for v in nearest)) < 3, nearest


@pytest.mark.parametrize('viewport', [(1440, 900), (1280, 800)])
def test_overlay_redraw_is_fast_at_europe_zoom(explore, viewport):
    page = explore(viewport)
    wait_ready(page)
    for value in ('precipitation', 'wind_absolute', 'temperature'):
        before = renders(page)
        t0 = time.monotonic()
        select_overlay(page, value)
        wait_ready(page)
        page.wait_for_function(f"() => window.__WM_EXPLORE_DIAG__.renders > {before}")
        elapsed = time.monotonic() - t0
        assert elapsed < 2.0, f'{value}: {elapsed:.1f} s until drawn'
        assert diag(page)['lastRenderMs'] < 1000, diag(page)


def test_each_change_draws_once(explore):
    page = explore()
    wait_ready(page)
    page.wait_for_timeout(600)

    def count(action):
        """Draws caused by the action, minus one per newly loaded grid (that one is needed)."""
        before, loads = renders(page), len(page.grid_responses)
        action()
        page.wait_for_timeout(1200)
        return renders(page) - before - (len(page.grid_responses) - loads)

    assert count(lambda: select_overlay(page, 'precipitation')) == 1
    assert count(lambda: page.evaluate("() => window.__WM_LEAFLET_MAP__.panBy([60, 0], {animate: false})")) == 1
    # Zoom out: the coastline for that band is already loaded (zooming in to >= 6 may
    # legitimately redraw once more when the finer coastline arrives).
    assert count(lambda: page.evaluate("() => window.__WM_LEAFLET_MAP__.setZoom(window.__WM_LEAFLET_MAP__.getZoom() - 1, {animate: false})")) == 1
    page.click('#navTour')
    page.wait_for_timeout(400)
    page.click('#navClimate')
    wait_ready(page)
    page.wait_for_timeout(600)
    assert count(lambda: page.evaluate("() => window.__WM_LEAFLET_MAP__.panBy([-60, 0], {animate: false})")) == 1


# ------------------------------------------------------------------- P1-P4 ---
PROGRESS_LOG = """() => { window.__plog = []; const p = document.getElementById('exploreContextProgress');
    const rec = () => window.__plog.push({ t: performance.now(), state: p.dataset.state || '',
        now: p.getAttribute('aria-valuenow'),
        renders: window.__WM_EXPLORE_DIAG__ ? window.__WM_EXPLORE_DIAG__.renders : -1 });
    new MutationObserver(rec).observe(p, { attributes: true }); }"""


def test_progress_completes_only_after_the_overlay_is_drawn(explore):
    explore.srv.grid.delay = 1.0
    page = explore()
    wait_ready(page)
    before = renders(page)
    page.evaluate(PROGRESS_LOG)
    click_time(page, 'month', 7)
    page.wait_for_timeout(300)
    mid = progress(page)
    assert mid['state'] == 'loading' and mid['now'] is None, f'loading must be indeterminate: {mid}'
    wait_ready(page)
    log = page.evaluate('window.__plog')
    full = [e for e in log if e['now'] == '100']
    assert full and all(e['renders'] > before for e in full), log
    assert not [e for e in log if e['now'] not in (None, '0', '100')], f'invented percentages: {log}'


def test_obsolete_request_cannot_overwrite_the_newer_one(explore):
    explore.srv.grid.delay = 1.2
    page = explore()
    wait_ready(page)
    page.evaluate(PROGRESS_LOG)
    click_time(page, 'month', 3)
    page.wait_for_timeout(300)
    click_time(page, 'month', 10)
    page.wait_for_function("() => window.__plog.some(e => e.state === 'ready')", timeout=20000)
    page.wait_for_timeout(2500)
    log = page.evaluate('window.__plog')
    phases = [e['state'] for i, e in enumerate(log) if i == 0 or e['state'] != log[i - 1]['state']]
    assert [x for x in phases if x in ('ready', 'error')] == ['ready'], phases
    assert progress(page)['state'] == 'ready'
    assert 'Period: October' in legend(page), legend(page)
    assert all(close(px, temp_rgb(page, xs.MONTH_TEMP[10])) for px in pixels(page, 'wm-strategic-heat', LAND))


def test_failed_request_is_reported_and_does_not_show_old_overlay(explore):
    explore.srv.grid.fail_months = {9}
    page = explore()
    wait_ready(page)
    click_time(page, 'month', 9)
    page.wait_for_function(
        "() => document.getElementById('exploreContextProgress').dataset.state === 'error'", timeout=15000)
    p = progress(page)
    assert p['now'] != '100' and 'September' in p['text'], p
    assert coverage(page, 'wm-strategic-heat') < 0.01, 'the previous period is still drawn'
    assert 'Period:' not in legend(page), legend(page)
    click_time(page, 'month', 8)
    wait_ready(page)
    assert 'Period: August' in legend(page)


def test_only_one_progress_bar_for_the_overlay(explore):
    page = explore()
    wait_ready(page)
    bars = page.evaluate("() => [...document.querySelectorAll('[role=progressbar]')].filter(e => /overlay/i.test(e.getAttribute('aria-label') || '')).length")
    assert bars == 1


# ------------------------------------------------------------------- D3 ------
@pytest.mark.parametrize('viewport', [(1440, 900), (1280, 800)])
def test_overlay_controls_are_visible_without_opening_advanced(explore, viewport):
    page = explore(viewport)
    wait_ready(page)
    for sel in ('#exploreOverlaySelect', '#strategicWindOn', '#setStrategicYears'):
        assert page.evaluate("(s) => !document.querySelector(s).closest('details:not([open])')", sel), sel
        box = page.locator(sel).bounding_box()
        assert box and box['height'] > 0, sel
        assert box['y'] + box['height'] <= viewport[1], f'{sel} needs scrolling: {box}'
    for value in ('precipitation', 'wind_absolute', 'none', 'temperature'):
        select_overlay(page, value)


# ------------------------------------------------------------------- overlays
def test_all_overlays_render_on_the_map(explore):
    page = explore()
    wait_ready(page)
    assert all(close(px, temp_rgb(page, xs.YEAR_TEMP)) for px in pixels(page, 'wm-strategic-heat', LAND))

    select_overlay(page, 'precipitation')
    wait_ready(page)
    rain = pixels(page, 'wm-strategic-heat', LAND)
    assert all(px[3] > 0 for px in rain) and all(px[2] > px[1] for px in rain), rain   # purple scale

    select_overlay(page, 'wind_absolute')
    wait_ready(page)
    wind = pixels(page, 'wm-strategic-heat', LAND)
    assert all(px[3] > 60 for px in wind), wind
    assert wind != rain

    select_overlay(page, 'none')
    wait_ready(page)
    assert all(px[3] == 0 for px in pixels(page, 'wm-strategic-heat', LAND))   # only the coastline is drawn

    for _ in range(2):
        for value in ('temperature', 'precipitation', 'wind_absolute', 'none'):
            select_overlay(page, value)
    select_overlay(page, 'temperature')
    wait_ready(page)
    assert all(close(px, temp_rgb(page, xs.YEAR_TEMP)) for px in pixels(page, 'wm-strategic-heat', LAND))
    assert not page.errors


# ------------------------------------------------------------------- T1/T2 ---
@pytest.mark.parametrize('kind,value,text,month,date', [
    ('month', 7, 'July', 7, '07-01'), ('quarter', 3, 'Q3', 7, '07-01'), ('month', 1, 'January', 1, '01-01'),
    ('year', 'year', 'Year', None, '01-01')])
def test_legend_and_data_follow_the_selected_period(explore, kind, value, text, month, date):
    page = explore()
    wait_ready(page)
    if kind != 'year':
        click_time(page, kind, value)
    else:
        click_time(page, 'month', 2)
        wait_ready(page)
        click_time(page, 'year', 'year')
    page.wait_for_timeout(400)
    wait_ready(page)
    assert f'Period: {text}' in legend(page), legend(page)
    want = xs.YEAR_TEMP if month is None else xs.MONTH_TEMP[month]
    assert all(close(px, temp_rgb(page, want)) for px in pixels(page, 'wm-strategic-heat', LAND))
    # The data may come from the client cache (Year after Feb); the request that
    # produced it must have asked for exactly this period.
    assert any(c['timescale'] == kind and c['date'] == date for c in explore.srv.grid.calls), explore.srv.grid.calls


def test_selected_period_and_overlay_survive_reload(explore):
    page = explore()
    wait_ready(page)
    click_time(page, 'month', 8)
    wait_ready(page)
    select_overlay(page, 'precipitation')
    wait_ready(page)
    page.wait_for_timeout(800)
    page.reload(wait_until='load')
    page.wait_for_function('() => window.__WM_LEAFLET_MAP__')
    wait_ready(page)
    active = page.evaluate("() => [...document.querySelectorAll('.wm-prefs-time-button.is-active')].map(b => b.dataset.timeKind + ':' + b.dataset.timeValue)")
    assert active == ['month:8'], active
    assert page.evaluate("document.getElementById('exploreOverlaySelect').value") == 'precipitation'
    last = explore.srv.grid.calls[-1]
    assert (last['timescale'], last['date']) == ('month', '08-01'), last
    assert 'Period: August' in legend(page)
    rain = pixels(page, 'wm-strategic-heat', LAND)
    assert all(px[3] > 0 and px[2] > px[1] for px in rain), rain


# ------------------------------------------------------------------- wind ----
def test_wind_field_stays_on_across_overlay_switches(explore):
    page = explore()
    wait_ready(page)
    assert not page.evaluate("document.getElementById('strategicWindOn').checked")
    page.click('#strategicWindOn')
    page.wait_for_timeout(1200)
    assert coverage(page, 'wm-strategic-wind') > 0.0005, 'wind field not drawn'
    for value in ('precipitation', 'none', 'temperature'):
        select_overlay(page, value)
        wait_ready(page)
        page.wait_for_timeout(1200)
        assert page.evaluate("document.getElementById('strategicWindOn').checked")
        assert coverage(page, 'wm-strategic-wind') > 0.0005, f'wind field gone after switching to {value}'
    page.click('#strategicWindOn')
    page.wait_for_timeout(800)
    assert coverage(page, 'wm-strategic-wind') < 0.0001


# ------------------------------------------------------------------- lucky ---
def test_lucky_day_thresholds_do_not_reload_the_map(explore):
    page = explore()
    wait_ready(page)
    page.wait_for_timeout(500)
    n = len(explore.srv.grid.calls)
    page.evaluate("""() => { const d = document.getElementById('advancedWeatherPrefs'); if (d) d.open = true;
        const e = document.getElementById('setRainHigh'); e.value = '6'; e.dispatchEvent(new Event('input', {bubbles: true}));
        e.dispatchEvent(new Event('change', {bubbles: true})); }""")
    page.wait_for_timeout(2500)
    assert len(explore.srv.grid.calls) == n
    assert progress(page)['state'] == 'ready'


# ------------------------------------------------------------------- climate profile
def test_climate_profile_timeout_shows_a_readable_message(explore, monkeypatch):
    srv = explore.srv
    monkeypatch.setattr(srv.module, '_resolve_complete_reference_years',
                        lambda *a, **k: (time.sleep(3.0), ([], []))[1])
    page = explore(init_script='window.__WM_CLIMATE_PROFILE_TIMEOUT_MS__ = 1000;')
    page.wait_for_timeout(2500)
    band = page.evaluate("() => (document.querySelector('.wm-climate-workspace') || document.body).innerText")
    assert 'climate-profile-timeout' not in band
    assert 'took too long' in band.lower(), band[:400]
