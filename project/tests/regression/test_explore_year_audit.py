"""Reference-year audit behind the Explore climate profile (Phase 2, timeout cause).

The audit must give exactly the results of the original four-query version, and a
background warm-up after server start must leave nothing for the first request to do.
"""
from __future__ import annotations

import sqlite3

import pytest

import app as backend_app  # type: ignore

USABLE = """NOT (month = 2 AND day = 29 AND COALESCE(samples_daily, 0) <= 0 AND COALESCE(samples_rain, 0) <= 0
  AND COALESCE(samples_wind, 0) <= 0 AND temp_day_median IS NULL AND precipitation_mm IS NULL AND wind_speed_ms IS NULL)
  AND (COALESCE(samples_daily, 0) > 0 OR COALESCE(samples_rain, 0) > 0 OR COALESCE(samples_wind, 0) > 0
  OR temp_day_median IS NOT NULL OR precipitation_mm IS NOT NULL OR wind_speed_ms IS NOT NULL)"""

DAYS = [(m, d) for m, n in enumerate([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], 1) for d in range(1, n + 1)]


def make_db(path, *, tiles=3, skip=(), empty_tiles=(), error_tiles=(), empty_feb29=True):
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE tiles (tile_id TEXT PRIMARY KEY, lat REAL, lon REAL, row INT, col INT);
        CREATE TABLE build_state (tile_id TEXT, status TEXT);
        CREATE TABLE climatology (tile_id TEXT, month INT, day INT, temp_day_median REAL, precipitation_mm REAL,
          wind_speed_ms REAL, samples_daily INT, samples_rain INT, samples_wind INT,
          PRIMARY KEY (tile_id, month, day));""")
    for t in range(tiles):
        tid = f'r0_c{t}'
        con.execute('INSERT INTO tiles VALUES (?, 0, ?, 0, ?)', (tid, t, t))
        con.execute('INSERT INTO build_state VALUES (?, ?)', (tid, 'error' if t in error_tiles else 'done'))
        for m, d in DAYS:
            if (t, m, d) in skip:
                continue
            blank = t in empty_tiles or (empty_feb29 and (m, d) == (2, 29))
            con.execute('INSERT INTO climatology VALUES (?,?,?,?,?,?,?,?,?)',
                        (tid, m, d, None if blank else 10.0, None if blank else 1.0, None if blank else 3.0,
                         0 if blank else 5, 0 if blank else 5, 0 if blank else 5))
    con.commit()
    con.close()
    return path


def reference_audit(path):
    """The original implementation: four separate scans."""
    cur = sqlite3.connect(path).cursor()
    rows = cur.execute(f'SELECT COUNT(*) FROM climatology WHERE {USABLE}').fetchone()[0] or 0
    tiles = cur.execute(f'SELECT COUNT(DISTINCT tile_id) FROM climatology WHERE {USABLE}').fetchone()[0] or 0
    mmdd = cur.execute(f'SELECT COUNT(DISTINCT printf("%02d-%02d", month, day)) FROM climatology WHERE {USABLE}').fetchone()[0] or 0
    lo, hi = cur.execute(f'SELECT MIN(c), MAX(c) FROM (SELECT tile_id, COUNT(*) c FROM climatology WHERE {USABLE} GROUP BY tile_id)').fetchone()
    return {'usable_row_count': rows, 'usable_tiles': tiles, 'distinct_usable_mmdd': mmdd,
            'min_usable_rows_per_tile': lo or 0, 'max_usable_rows_per_tile': hi or 0}


CASES = {
    'complete': {},
    'missing_day': {'skip': {(1, 3, 15)}},
    'tile_without_data': {'empty_tiles': {2}},
    'error_tile': {'error_tiles': {0}},
    'feb29_with_data': {'empty_feb29': False},
}


@pytest.mark.parametrize('case', CASES)
def test_audit_matches_the_original_queries(tmp_path, case):
    db = make_db(tmp_path / 'offline_weather_2024.sqlite', **CASES[case])
    got = backend_app._evaluate_offline_year_database(db)
    want = reference_audit(db)
    assert {k: got[k] for k in want} == want
    assert got['complete'] == (case in ('complete', 'feb29_with_data'))


def test_warmup_fills_the_cache_before_the_first_request(tmp_path, monkeypatch):
    dbs = {y: make_db(tmp_path / f'offline_weather_{y}.sqlite') for y in (2023, 2024, 2025)}
    monkeypatch.setattr(backend_app, '_discover_offline_year_databases', lambda: dict(dbs))
    monkeypatch.setattr(backend_app, '_OFFLINE_REFERENCE_YEARS_CACHE', {})
    monkeypatch.setattr(backend_app, '_OFFLINE_REFERENCE_YEARS_CACHE_IN_FLIGHT', set())
    calls = []
    real = backend_app._evaluate_offline_year_database
    monkeypatch.setattr(backend_app, '_evaluate_offline_year_database', lambda p: (calls.append(p), real(p))[1])

    backend_app._start_reference_year_warmup().join(30)
    assert len(calls) == 3
    years, audits = backend_app._resolve_complete_reference_years(3)
    assert years == [2025, 2024, 2023] and len(audits) == 3
    assert len(calls) == 3, 'the first request audited again'
