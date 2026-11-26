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
    cfg = SimpleNamespace(delay=0.0, gradient=0.0, mixed=False, rain=None, wind=None, fail_months=set(), calls=[])

    def impl():
        args = request.args.to_dict()
        cfg.calls.append(args)
        time.sleep(cfg.delay)
        if xs.period_month(args) in cfg.fail_months:
            return jsonify({'error': 'Aggregation failed: synthetic failure'}), 500
        return jsonify(xs.grid(args, gradient=cfg.gradient, mixed=cfg.mixed, rain=cfg.rain, wind=cfg.wind))

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


def test_rows_mixing_two_grid_layouts_are_sampled_and_drawn(explore):
    """Real offline databases mix two grid layouts within one row (Pyrenees, Gulf of Lion)."""
    explore.srv.grid.gradient = 1.0
    explore.srv.grid.mixed = True
    page = explore()
    wait_ready(page)
    for lat in (44.3, 45.0, 45.7):
        for lon in (4.0, 7.0, 8.2, 9.5, 12.0, 15.0):
            s = page.evaluate("([a, b]) => window.__WM_EXPLORE_DIAG__.sampleAt(a, b)", [lat, lon])
            want = xs.temperature(None, lon, 1.0)
            assert s and abs(s['temperature_c'] - want) < 0.6, (lat, lon, s and s['temperature_c'], want)
    band = [(44.6, 6.0), (45.2, 9.0), (45.4, 12.0), (45.4, 15.6)]   # inland points
    assert all(px[3] > 0 for px in pixels(page, 'wm-strategic-heat', band)), pixels(page, 'wm-strategic-heat', band)


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
    assert count(lambda: select_overlay(page, 'none')) == 1
    assert count(lambda: select_overlay(page, 'temperature')) == 1
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


def test_dry_areas_are_drawn_not_left_as_gaps(explore):
    """< 0.5 mm/day is data (dry); it must look different from 'no data' (transparent)."""
    explore.srv.grid.rain = 0.2
    page = explore()
    wait_ready(page)
    select_overlay(page, 'precipitation')
    wait_ready(page)
    dry = pixels(page, 'wm-strategic-heat', LAND)
    assert all(px[3] > 0 and px[0] > px[2] for px in dry), dry          # sand tint, not purple


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


# ------------------------------------------------------------------- wind roses
ROSES = "() => window.__WM_EXPLORE_DIAG__.roses"


def angle_diff(a, b):
    return abs((a - b + 180) % 360 - 180)


def show_wind(page):
    select_overlay(page, 'wind_absolute')
    wait_ready(page)
    page.wait_for_timeout(300)
    return page.evaluate(ROSES)


def test_wind_roses_point_downwind_with_one_or_two_arrows(explore):
    page = explore()
    wait_ready(page)
    roses = show_wind(page)
    assert roses, 'no wind roses drawn'
    west = [r for r in roses if r['lon'] < 5]
    centre = [r for r in roses if 5 <= r['lon'] < 15]
    east = [r for r in roses if r['lon'] >= 15]
    assert west and centre, roses
    assert not east, f'diffuse region must not get roses: {east}'
    for r in west:                                     # wind from NW pushes towards SE
        assert len(r['modes']) == 1 and angle_diff(r['modes'][0]['to_deg'], 135) < 10, r
    for r in centre:                                   # N 60 % / W 30 % -> arrows S and E
        assert len(r['modes']) == 2, r
        assert angle_diff(r['modes'][0]['to_deg'], 180) < 10 and angle_diff(r['modes'][1]['to_deg'], 90) < 10, r
        assert r['modes'][0]['share'] > r['modes'][1]['share']


def test_wind_rose_arrows_are_drawn_downwind_on_the_map(explore):
    page = explore()
    wait_ready(page)
    roses = show_wind(page)
    r = next(r for r in roses if r['lon'] < 5)          # one arrow pointing SE
    dark = page.evaluate("""([x, y]) => { const c = document.querySelector('.wm-strategic-heat canvas');
        const k = c.width / c.clientWidth; const ctx = c.getContext('2d');
        const at = (dx, dy) => Array.from(ctx.getImageData(Math.round((x + dx) * k), Math.round((y + dy) * k), 1, 1).data);
        const s = Math.SQRT1_2 * 14;
        return { downwind: at(s, s), upwind: at(-s, -s) }; }""", [r['x'], r['y']])
    assert is_primary_ink(dark['downwind']), dark     # arrow body towards SE (screen +x, +y)
    assert not is_primary_ink(dark['upwind']), dark   # nothing towards NW


def is_primary_ink(px):            # deep indigo primary arrow
    return px[3] > 150 and px[0] < 90 and px[2] - px[0] > 60 and px[2] < 190


def is_secondary_ink(px):          # lighter steel-blue secondary arrow
    return px[3] > 150 and 30 <= px[0] < 140 and px[2] > 170 and px[2] - px[0] > 60


def canvas_px(page, x, y):
    return page.evaluate("""([x, y]) => { const c = document.querySelector('.wm-strategic-heat canvas');
        const k = c.width / c.clientWidth;
        return Array.from(c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data); }""", [x, y])


def test_secondary_arrow_is_lighter_and_shorter_than_the_primary(explore):
    page = explore()
    wait_ready(page)
    roses = show_wind(page)
    r = next(r for r in roses if 5 <= r['lon'] < 15)     # primary pushes S, secondary pushes E
    prim = [canvas_px(page, r['x'], r['y'] + d) for d in (12, 22)]
    sec = [canvas_px(page, r['x'] + d, r['y']) for d in (8, 14)]
    assert all(is_primary_ink(px) for px in prim), prim
    assert all(is_secondary_ink(px) for px in sec), sec
    # length: primary still drawn where the secondary has already ended
    p_len = max(d for d in range(4, 70) if is_primary_ink(canvas_px(page, r['x'], r['y'] + d)))
    s_len = max(d for d in range(4, 70) if is_secondary_ink(canvas_px(page, r['x'] + d, r['y'])))
    assert s_len < 0.8 * p_len, (p_len, s_len)


def test_germany_at_country_zoom_shows_at_most_five_roses(explore):
    page = explore()
    wait_ready(page)
    page.evaluate("window.__WM_LEAFLET_MAP__.setView([51.1, 10.4], 6, {animate: false})")
    wait_ready(page)
    roses = show_wind(page)
    in_de = [r for r in roses if 47.3 <= r['lat'] <= 55.0 and 5.9 <= r['lon'] <= 15.0]
    assert 1 <= len(in_de) <= 5, in_de
    assert page.evaluate("window.__WM_EXPLORE_DIAG__.roseSpacingPx") == 220     # country zoom: fixed spacing
    assert min_gap(roses) >= 219


def min_gap(roses):
    pts = [(r['x'], r['y']) for r in roses]
    return min((((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 for i, a in enumerate(pts) for b in pts[i + 1:]),
               default=float('inf'))


MALLORCA = (39.62, 2.99)


def show_mallorca(explore, zoom):
    explore.srv.grid.wind = xs.mallorca_wind
    page = explore()
    wait_ready(page)
    page.evaluate(f"window.__WM_LEAFLET_MAP__.setView([{MALLORCA[0]}, {MALLORCA[1]}], {zoom}, {{animate: false}})")
    wait_ready(page)
    roses = show_wind(page)
    # the coastline for this zoom may arrive after the first draw; it triggers a redraw
    page.wait_for_timeout(1500)
    return page, page.evaluate(ROSES)


def is_island_tile(r):
    return abs(r['lat'] - 39.61) < 0.05 and (abs(r['lon'] - 2.70) < 0.05 or abs(r['lon'] - 3.28) < 0.05)


def test_land_tile_is_chosen_before_a_more_significant_sea_tile(explore):
    land = xs.wind_modes.classify_observations(xs.mallorca_observations(True))
    sea = xs.wind_modes.classify_observations(xs.mallorca_observations(False))
    assert land and sea and sea[0]['significance'] > land[0]['significance']     # sea would win on score alone
    page, roses = show_mallorca(explore, 8)
    assert page.evaluate("window.__WM_EXPLORE_DIAG__.roseSpacingPx") == 220      # zoom 8: tiles ~105 px apart
    island = [r for r in roses if is_island_tile(r)]
    assert len(island) == 1 and island[0]['land'], roses
    assert any(not r['land'] for r in roses), 'sea roses should still fill the gaps'
    assert min_gap(roses) >= 219                                                  # sea keeps distance to land
    for r in island:                                                              # from SW -> pushes NE
        assert 30 <= r['modes'][0]['to_deg'] <= 60, r


def test_neighbouring_land_tiles_both_get_a_rose_at_zoom_9(explore):
    page, roses = show_mallorca(explore, 9)
    spacing = page.evaluate("window.__WM_EXPLORE_DIAG__.roseSpacingPx")
    assert 140 <= spacing < 220, spacing                                          # 0.9 x ~205 px tile spacing
    island = [r for r in roses if is_island_tile(r)]
    assert len(island) == 2 and all(r['land'] for r in island), roses
    assert all(30 <= r['modes'][0]['to_deg'] <= 60 for r in island), island
    assert min_gap(roses) >= spacing - 1                                          # one rose per tile, no overlap
    assert min_gap([r for r in roses if not r['land']]) >= 219                    # sea roses stay sparse
    assert page.evaluate("window.__WM_EXPLORE_DIAG__.roseSeaSpacingPx") == 220
    assert len(roses) <= 14


def test_wide_european_view_keeps_the_rose_limit(explore):
    explore.srv.grid.wind = xs.mallorca_wind
    page = explore(viewport=(2560, 1440))
    wait_ready(page)
    page.evaluate("window.__WM_LEAFLET_MAP__.setView([50.0, 8.0], 5, {animate: false})")
    wait_ready(page)
    roses = show_wind(page)
    assert 1 <= len(roses) <= 14, len(roses)
    assert page.evaluate("window.__WM_EXPLORE_DIAG__.roseSpacingPx") == 220
    assert min_gap(roses) >= 219


def test_wind_roses_follow_the_selected_period(explore):
    page = explore()
    wait_ready(page)
    year = show_wind(page)
    click_time(page, 'month', 7)
    wait_ready(page)
    page.wait_for_timeout(300)
    july = page.evaluate(ROSES)
    assert any(r['lon'] < 5 for r in year)
    assert not any(r['lon'] < 5 for r in july), 'west is diffuse in July and must not get roses'


def test_wind_roses_belong_to_the_wind_overlay_and_ignore_the_wind_field(explore):
    page = explore()
    wait_ready(page)
    assert page.evaluate(ROSES) == []                 # Temperature: no roses
    roses = show_wind(page)
    page.click('#strategicWindOn')
    page.wait_for_timeout(800)
    assert [(r['lat'], r['lon']) for r in page.evaluate(ROSES)] == [(r['lat'], r['lon']) for r in roses]
    assert page.evaluate("document.getElementById('strategicWindOn').checked")
    select_overlay(page, 'temperature')
    wait_ready(page)
    assert page.evaluate(ROSES) == []
    assert page.evaluate("document.getElementById('strategicWindOn').checked")     # field stays independent


def test_wind_legend_says_where_the_wind_pushes(explore):
    page = explore()
    wait_ready(page)
    show_wind(page)
    text = page.evaluate("() => document.querySelector('.wm-map-legend').innerText")
    assert 'pushes towards' in text.lower(), text


def test_climate_profile_wind_roses_show_downwind(explore, monkeypatch, tmp_path):
    """Profile roses (12 months) follow the same rule: wind from W is drawn pushing towards E."""
    import test_offline_tile_lookup as tl
    srv = explore.srv
    stores = {y: tl.make_store(tmp_path / f'offline_weather_{y}.sqlite', y, tl.NEAR_B) for y in (2025, 2024, 2023)}
    monkeypatch.setattr(srv.module, '_resolve_complete_reference_years', lambda n=3: ([2025, 2024, 2023][:n], []))
    monkeypatch.setattr(srv.module, '_resolve_offline_store_for_year', lambda y, **k: stores.get(int(y)))
    page = explore()
    page.wait_for_function("() => document.querySelectorAll('.wm-climate-wind-rose-svg').length === 12", timeout=20000)
    roses = page.evaluate("""() => [...document.querySelectorAll('.wm-climate-wind-rose-svg')].map(s => {
        const l = s.querySelector('.wm-climate-wind-dominant-marker line');
        return { conv: s.dataset.directionConvention, dom: s.dataset.dominantSector,
                 dx: Number(l.getAttribute('x2')) - Number(l.getAttribute('x1')), dy: Number(l.getAttribute('y2')) - Number(l.getAttribute('y1')) }; })""")
    assert all(r['conv'] == 'downwind' and r['dom'] == 'E' for r in roses), roses
    assert all(r['dx'] > 5 and abs(r['dy']) < 1 for r in roses), roses          # marker points east
    meta = page.evaluate("() => document.querySelector('.wm-climate-wind-meta').textContent")
    assert 'pushes towards' in meta
