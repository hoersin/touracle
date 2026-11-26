"""Fast Explore period aggregation (period_arrays) gives the results of the SQL path.

Explore period requests (Year / Quarter / Month) used to read every selected day of
every selected year from SQLite and aggregate row by row (up to ~90 s for four
reference years over Europe). period_arrays keeps the climatology as day x tile
column arrays and aggregates vectorised. These tests compare both paths on
synthetic databases with random values, missing values (NULL), two grid layouts
under the same tile ids and leap / non-leap years.
"""
from __future__ import annotations

import hashlib
import math
import os
import random
import sqlite3
from pathlib import Path

import pytest

import climate_aggregation as agg  # type: ignore
import period_arrays as pa  # type: ignore
import test_offline_tile_lookup as tl
from offline_weather_store import OfflineWeatherStore  # type: ignore

DAYS = tl.DAYS                                   # 366 month/day pairs


def make_random_store(path, year, tiles, seed):
    """Random daily values; ~6 % NULLs; one tile without any data; regional wind regimes."""
    rnd = random.Random(seed)
    tl.make_store(path, year, [])                # schema + meta only
    con = sqlite3.connect(path)
    for i, (row, col, origin, shift) in enumerate(tiles):
        tid = f'r{row}_c{col}'
        lat, lon = tl.centre(row, col, origin, shift)
        con.execute('INSERT INTO tiles VALUES (?,?,?,?,?)', (tid, lat, lon, row, col))
        if i == 3:
            continue                             # tile without climatology rows
        prevailing = (lon * 13.0) % 360.0
        rows = []
        for m, d in DAYS:
            nul = lambda v: None if rnd.random() < 0.06 else v
            t = 10 + 12 * math.sin((m - 4) / 12 * 2 * math.pi) + rnd.gauss(0, 3)
            wdir = prevailing + rnd.gauss(0, 25) if rnd.random() < 0.6 else rnd.uniform(0, 360)
            rows.append((tid, m, d, nul(round(t, 2)), nul(round(t + rnd.gauss(2, 1), 2)), nul(round(t - 3, 2)),
                         nul(round(t + 3, 2)), nul(round(max(0.0, rnd.expovariate(0.4) - 1.0), 2)),
                         nul(round(rnd.uniform(0, 1), 3)), nul(round(rnd.uniform(0, 8), 2)),
                         nul(round(abs(rnd.gauss(5, 3)), 2)), nul(round(wdir % 360.0, 1)), nul(round(rnd.uniform(0, 60), 1))))
        con.executemany(
            'INSERT INTO climatology (tile_id, month, day, temperature_c, temp_day_median, temp_day_p25, temp_day_p75, '
            'precipitation_mm, rain_probability, rain_typical_mm, wind_speed_ms, wind_dir_deg, wind_var_deg) '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
    con.commit()
    con.close()
    return OfflineWeatherStore(OfflineWeatherStore._load_config(Path(path)))


def layout_tiles(shift=0.0):
    out = []
    for row in range(28, 32):
        out += [(row, c, -11.0, shift) for c in range(24, 30)]        # "-11" layout, ~6-10 E
        out += [(row, c, -28.0, 0.0) for c in range(50, 55)]          # "-28" layout, same ids elsewhere
    return out


@pytest.fixture(scope='module')
def stores(tmp_path_factory):
    d = tmp_path_factory.mktemp('stores')
    out = {}
    for i, (year, shift) in enumerate(((2024, 0.0), (2023, 0.1), (2022, 0.0))):
        out[year] = make_random_store(d / f'offline_weather_{year}.sqlite', year, layout_tiles(shift), seed=11 + i)
    return out


BB = dict(lat_min=46.0, lat_max=50.0, lon_min=-1.0, lon_max=14.0)


def run(stores_by_year, ts, doy, fast):
    agg._CACHE = agg._LRUTTLCache(max_items=8, ttl_s=60)
    if fast:
        os.environ.pop('WM_DISABLE_PERIOD_ARRAYS', None)
    else:
        os.environ['WM_DISABLE_PERIOD_ARRAYS'] = '1'
    try:
        years = [y for y, _ in stores_by_year]
        if len(stores_by_year) == 1:
            return agg.aggregate_climate(ts, doy, years[0], store=stores_by_year[0][1], **BB)
        return agg.aggregate_climate_multi(ts, doy, max(years), stores=stores_by_year, **BB)
    finally:
        os.environ.pop('WM_DISABLE_PERIOD_ARRAYS', None)


def assert_same(slow, fast):
    assert len(slow) == len(fast) and slow, (len(slow), len(fast))
    for p, q in zip(slow, fast):
        assert list(p) == list(q), (p['tile_id'], list(p), list(q))
        for k in p:
            x, y = p[k], q[k]
            if isinstance(x, float) or isinstance(y, float):
                assert (x is None) == (y is None), (p['tile_id'], k, x, y)
                if x is not None:
                    assert y == pytest.approx(x, rel=1e-12, abs=1e-12), (p['tile_id'], k, x, y)
            else:
                assert x == y, (p['tile_id'], k, x, y)      # ids, rows, cols and the wind modes exactly


def build_all(stores):
    for st in stores.values():
        pa.build(Path(st.cfg.db_path))


@pytest.mark.parametrize('years', [(2024,), (2023,), (2024, 2023), (2023, 2022), (2024, 2023, 2022)])
@pytest.mark.parametrize('ts,doy', [('year', 1), ('quarter', 1), ('quarter', 100), ('month', 32), ('month', 200)])
def test_fast_period_aggregation_equals_the_sql_path(stores, years, ts, doy):
    build_all(stores)
    sel = [(y, stores[y]) for y in years]
    slow = run(sel, ts, doy, fast=False)
    fast = run(sel, ts, doy, fast=True)
    assert_same(slow, fast)
    assert any(p['wind_modes'] for p in fast), 'test data should contain dominant wind directions'
    assert any(p['temperature_c'] is None for p in fast) or len(years) > 1   # the tile without data


def test_arrays_are_derived_files_and_never_touch_the_database(tmp_path):
    db = tmp_path / 'offline_weather_2024.sqlite'
    st = make_random_store(db, 2024, layout_tiles(), seed=5)
    digest = hashlib.sha256(db.read_bytes()).hexdigest()
    assert pa.get(st) is None                                   # not built: callers use SQL
    folder = pa.build(db)
    assert folder.parent.parent == tmp_path / 'derived' and (folder / 'meta.json').exists()
    assert pa.get(st) is not None
    assert hashlib.sha256(db.read_bytes()).hexdigest() == digest


def test_a_changed_database_is_not_served_from_old_arrays(tmp_path):
    db = tmp_path / 'offline_weather_2024.sqlite'
    st = make_random_store(db, 2024, layout_tiles(), seed=5)
    pa.build(db)
    assert pa.get(st) is not None
    con = sqlite3.connect(db)
    con.execute("UPDATE climatology SET temperature_c = 99 WHERE month = 1")
    con.commit()
    con.close()
    os.utime(db, ns=(db.stat().st_atime_ns, db.stat().st_mtime_ns + 10_000_000))
    assert pa.get(st) is None                                   # stale: SQL path until rebuilt
    pa.build(db)
    fresh = run([(2024, st)], 'month', 1, fast=True)
    assert any(p['temperature_c'] is not None and p['temperature_c'] > 20 for p in fresh)


def test_missing_arrays_start_a_background_build_and_the_sql_path_answers(tmp_path):
    db = tmp_path / 'offline_weather_2024.sqlite'
    st = make_random_store(db, 2024, layout_tiles(), seed=6)
    first = run([(2024, st)], 'month', 32, fast=True)          # no arrays yet: SQL path
    assert first
    for t in list(pa._BUILDING.values()):
        t.join(timeout=60)
    assert pa.get(st) is not None
    assert_same(first, run([(2024, st)], 'month', 32, fast=True))
