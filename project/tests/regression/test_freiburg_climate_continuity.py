"""Freiburg climate discontinuity: real databases, real backend path, real map code.

Kronenbruecke and Schwabentorbruecke (~1 km apart, central Freiburg) showed 14.6 C /
1,123 mm and 12.0 C / 1,309 mm. Cause: the climate panel took each year's *nearest*
tile; Freiburg lies almost exactly halfway (7.8495 E) between the tile centres at
7.513 E (Rhine plain) and 8.186 E (Black Forest) of the 2024/2025 grid, so a few
hundred metres switched every year's tile. The panel now interpolates bilinearly with
the map overlay's own rule (one column layout per row, larger layout origin first).

These tests use the local offline databases (skipped where they are not installed),
the actual /api/explore/climate_profile and /api/strategic_grid endpoints, and the
map's own _makeTileMap/_sampleInterpolated code from map.js (run in Chromium).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

import app as backend_app  # type: ignore
import test_offline_tile_lookup as tl
from test_explore_overlays import explore, grid_server, wait_ready  # noqa: F401  (fixtures)

KRONEN = (47.99070, 7.84300)        # Kronenbruecke over the Dreisam
SCHWABENTOR = (47.99030, 7.85600)   # Schwabentorbruecke over the Dreisam
POINTS = [(KRONEN[0] + (SCHWABENTOR[0] - KRONEN[0]) * i / 6, KRONEN[1] + (SCHWABENTOR[1] - KRONEN[1]) * i / 6) for i in range(7)]
OPTIONS = {'all': [2025, 2024, 2023, 2022, 2021], 'last3': [2025, 2024, 2023],
           '2025': [2025], '2024': [2024], '2023': [2023], '2022': [2022], '2021': [2021]}
MAP_JS = Path(backend_app.__file__).resolve().parents[1] / 'frontend' / 'map.js'

_real = backend_app._discover_offline_year_databases()
real_data = pytest.mark.skipif(not {2021, 2022, 2023, 2024, 2025} <= set(_real),
                               reason='local offline databases 2021-2025 not installed')


@pytest.fixture
def client(monkeypatch, tmp_path):
    for name in ('data', 'stats', 'debug'):
        (tmp_path / name).mkdir()
    for name, value in {'DATA_DIR': tmp_path / 'data', 'UPLOAD_DIR': tmp_path / 'data',
                        'SESSION_FILE': tmp_path / 'data' / 'session_state.json', 'SESSION_STORE': {},
                        'SESSION_STORE_LOADED': False, 'STATS_CACHE_DIR': tmp_path / 'stats',
                        'DEBUG_DIR': tmp_path / 'debug'}.items():
        monkeypatch.setattr(backend_app, name, value)
    monkeypatch.setattr(backend_app, '_reverse_geocode_location', lambda lat, lon, **k: {'label': 'Freiburg', 'name': 'Freiburg', 'country': 'DE'})
    return backend_app.app.test_client()


def profile(client, lat, lon, years):
    r = client.get('/api/explore/climate_profile', query_string={'lat': f'{lat:.5f}', 'lon': f'{lon:.5f}', 'years': ','.join(map(str, years))})
    assert r.status_code == 200, r.get_json()
    j = r.get_json()
    temps = [p['mean_c'] for m in j['temperature']['months'] for p in m['periods'] if p.get('mean_c') is not None]
    by_month = [[p['mean_c'] for p in m['periods'] if p.get('mean_c') is not None] for m in j['temperature']['months']]
    assert len(temps) == 36
    return {'t': sum(sum(v) / len(v) for v in by_month) / 12, 'p': float(j['precipitation']['annual_total_mm']), 'meta': j['meta']}


@real_data
@pytest.mark.parametrize('option', list(OPTIONS))
def test_both_bridges_and_the_points_between_are_continuous(client, option):
    years = OPTIONS[option]
    res = [profile(client, lat, lon, years) for lat, lon in POINTS]
    for r in res:
        meta = r['meta']
        assert meta['reference_years'] == years and meta['reference_year_rule'] == 'explicit_years', meta
        assert meta['spatial']['method'] == 'bilinear' and meta['spatial']['grid_km'] == 50.0
        assert sorted(meta['spatial']['sources_by_year']) == sorted(str(y) for y in years)
        for srcs in meta['spatial']['sources_by_year'].values():
            assert len(srcs) == 4 and abs(sum(s['weight'] for s in srcs) - 1.0) < 1e-3, srcs
    t = [r['t'] for r in res]
    p = [r['p'] for r in res]
    steps_t = [abs(b - a) for a, b in zip(t, t[1:])]
    steps_p = [abs(b - a) for a, b in zip(p, p[1:])]
    assert max(steps_t) < 0.05 and max(steps_p) < 5, (option, t, p)          # nearest tile: 2.6 K / 186 mm in one step
    assert abs(t[0] - t[-1]) < 0.25 and abs(p[0] - p[-1]) < 25, (option, t, p)
    # the values change monotonically (linear interpolation), no detour over another tile
    assert all(a >= b - 1e-6 for a, b in zip(t, t[1:])) or all(a <= b + 1e-6 for a, b in zip(t, t[1:])), t


@real_data
def test_several_years_are_the_mean_of_the_individual_years(client):
    """Each reference year is interpolated in its own grid and the years count equally."""
    for lat, lon in (KRONEN, SCHWABENTOR):
        single = {y: profile(client, lat, lon, [y]) for y in OPTIONS['all']}
        for option in ('all', 'last3'):
            years = OPTIONS[option]
            multi = profile(client, lat, lon, years)
            for y in years:
                assert multi['meta']['spatial']['sources_by_year'][str(y)] == single[y]['meta']['spatial']['sources_by_year'][str(y)]
            assert abs(multi['p'] - sum(single[y]['p'] for y in years) / len(years)) < 1.0, option
            assert abs(multi['t'] - sum(single[y]['t'] for y in years) / len(years)) < 0.05, option


@real_data
def test_reference_years_change_the_result_and_never_leak_between_requests(client):
    a = profile(client, *KRONEN, [2022])
    b = profile(client, *KRONEN, [2021])
    a2 = profile(client, *KRONEN, [2022])
    assert a['meta']['reference_years'] == [2022] and b['meta']['reference_years'] == [2021]
    assert abs(a['t'] - b['t']) > 1.0                              # 2022 was a much warmer year than 2021
    assert (a2['t'], a2['p']) == (a['t'], a['p'])


# ------------------------------------------------------- map == climate panel ---
def _js_function(src, name):
    m = re.search(rf'  (?:async )?function {name}\(', src)
    assert m, name
    start = m.start()
    depth = 0
    for i in range(src.index('{', start), len(src)):
        depth += {'{': 1, '}': -1}.get(src[i], 0)
        if depth == 0:
            return src[start:i + 1]
    raise AssertionError(name)


def _js_const(src, name):
    m = re.search(rf'  const {name} = \[.*?\];', src, re.S)
    return m.group(0)


@pytest.fixture(scope='module')
def map_sampler():
    """The map overlay's own sampling functions, taken from map.js."""
    src = MAP_JS.read_text(encoding='utf-8')
    parts = [_js_const(src, 'STRATEGIC_SAMPLE_KEYS'), _js_function(src, '_lerp') if '  function _lerp(' in src else '',
             _js_function(src, '_makeTileMap'), _js_function(src, '_strategicMixSamples'),
             _js_function(src, '_strategicTileSample'), _js_function(src, '_sampleInterpolated')]
    return 'const SETTINGS = { interpolation: true };\n' + '\n'.join(parts)


def map_weights(page, code, points, tile_km, lat, lon):
    """Weight of every tile in the map's value at (lat, lon): one-hot probe per tile."""
    return page.evaluate("""([code, points, km, lat, lon]) => {
        const f = new Function('points', 'km', 'lat', 'lon', code + `
            const out = {};
            for (const probe of points) {
              const pts = points.map(p => Object.assign({}, p, { precipitation_mm: p.tile_id === probe.tile_id ? 1 : 0 }));
              const m = _makeTileMap(pts, km);
              const s = _sampleInterpolated(m, { tile_km: km }, lat, lon);
              const w = s ? s.precipitation_mm : 0;
              if (w > 1e-6) out[probe.tile_id] = w;
            }
            return out;`);
        return f(points, km, lat, lon); }""", [code, points, tile_km, lat, lon])


@real_data
@pytest.mark.parametrize('year', OPTIONS['all'])
def test_map_overlay_and_climate_panel_use_the_same_cells_and_weights(client, chromium, map_sampler, year):
    r = client.get('/api/strategic_grid', query_string={'year': year, 'years': year, 'timescale': 'daily', 'date': '07-01',
                                                        'lat_min': 47.0, 'lat_max': 49.0, 'lon_min': 6.5, 'lon_max': 9.5})
    assert r.status_code == 200
    grid = r.get_json()
    points = [{k: p.get(k) for k in ('tile_id', 'row', 'col', 'lat', 'lon')} for p in grid['points']]
    ctx = chromium.new_context()
    page = ctx.new_page()
    try:
        for lat, lon in (KRONEN, POINTS[3], SCHWABENTOR):
            panel = profile(client, lat, lon, [year])['meta']['spatial']['sources_by_year'][str(year)]
            drawn = map_weights(page, map_sampler, points, grid.get('tile_km', 50), lat, lon)
            assert sorted(drawn) == sorted(s['tile_id'] for s in panel), (year, drawn, panel)
            for s in panel:
                assert abs(drawn[s['tile_id']] - s['weight']) < 1e-3, (year, drawn, panel)
    finally:
        ctx.close()


def test_mixed_layout_rows_choose_the_same_layout_as_the_map(backend, monkeypatch, tmp_path):
    """A row holding tiles of both layouts (the 2023 database): the panel uses the layout
    the map uses (larger origin first), not a pair of centres from different layouts."""
    near_b_row30 = [(tl.R - 1, c, -11.0, 0.0) for c in range(25, 31)]
    near_a_row30 = [(tl.R - 1, c, -28.0, 0.0) for c in range(52, 56)]
    store = tl.make_store(tmp_path / 'offline_weather_2023.sqlite', 2023, tl.NEAR_A + near_a_row30 + near_b_row30)
    monkeypatch.setattr(backend_app, '_resolve_complete_reference_years', lambda n=3: ([2023], []))
    monkeypatch.setattr(backend_app, '_resolve_offline_store_for_year', lambda y, **k: store)
    r = backend.app.test_client().get('/api/explore/climate_profile', query_string={'lat': KRONEN[0], 'lon': KRONEN[1], 'years': '2023'})
    assert r.status_code == 200, r.get_json()
    srcs = r.get_json()['meta']['spatial']['sources_by_year']['2023']
    row30 = sorted(s['tile_id'] for s in srcs if s['tile_id'].startswith(f'r{tl.R - 1}_'))
    assert row30 == [f'r{tl.R - 1}_c27', f'r{tl.R - 1}_c28'], srcs          # the "-11" layout, as on the map


def test_climate_panel_cache_key_holds_position_reference_years_and_server_version():
    src = MAP_JS.read_text(encoding='utf-8')
    body = _js_function(src, '_climateProfileRequestKey')
    assert '_strategicGetSelectedYears().join' in body and 'CLIMATE_PROFILE_STATE.appVersion' in body
    assert "const key = _climateProfileRequestKey(point);" in _js_function(src, '_requestClimateProfile')


def test_switching_reference_years_never_shows_another_periods_cached_values(explore, monkeypatch, tmp_path):
    """Real UI: A -> B -> A at the same point shows A's, then B's, then A's values again."""
    srv = explore.srv
    years = (2025, 2024, 2023, 2022, 2021)
    stores = {y: tl.make_store(tmp_path / f'offline_weather_{y}.sqlite', y, tl.NEAR_B) for y in years}
    year_of = {id(st): y for y, st in stores.items()}
    real_rows = srv.module._fetch_tile_climatology_rows

    def rows(store, tile_id):            # each year 1 K warmer than the previous one
        out = real_rows(store, tile_id)
        off = year_of.get(id(store), 2025) - 2021
        return [dict(r, temp_day_median=(r['temp_day_median'] + off) if r.get('temp_day_median') is not None else None) for r in out]
    monkeypatch.setattr(srv.module, '_fetch_tile_climatology_rows', rows)
    monkeypatch.setattr(srv.module, '_resolve_complete_reference_years', lambda n=3: (list(years)[:n], []))
    monkeypatch.setattr(srv.module, '_resolve_offline_store_for_year', lambda y, **k: stores.get(int(y)))
    page = explore()
    wait_ready(page)

    def shown(option, label):
        page.click(f'#setStrategicYears [data-ref-years="{option}"]')
        page.wait_for_function("l => (document.querySelector('[data-role=climate-reference]') || {}).textContent === 'Climate reference: ' + l"
                               " && document.querySelectorAll('.wm-climate-wind-rose-svg').length === 12", arg=label, timeout=20000)
        page.wait_for_timeout(200)
        return page.evaluate("[...document.querySelectorAll('.wm-climate-monthly-chart-svg rect title')].map(t => t.textContent).join('|')")

    a = shown('2022', '2022')
    b = shown('2025', '2025')
    a2 = shown('2022', '2022')
    assert a != b and a2 == a
    assert '2025' not in a2.split('Reference years:')[-1]
    assert not page.errors, page.errors
