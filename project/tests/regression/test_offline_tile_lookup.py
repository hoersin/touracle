"""Coordinate -> offline tile lookup and multi-year merging.

The real yearly offline databases contain tiles of two grid layouts under the same
r{row}_c{col} naming: column origin -28 deg (the reported bbox) and -11 deg. Computing
a tile id from bbox/row/col can therefore name a tile far away (Freiburg resolved to a
tile at 48.15 N 25.02 E in the 2024/2025 databases). Synthetic stores reproduce that
layout; every tile's temperature equals its longitude, so results show which place's
data was used.
"""
from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path

import pytest

import app as backend_app  # type: ignore
import climate_aggregation as agg  # type: ignore
from offline_weather_store import OfflineWeatherStore  # type: ignore

BBOX = (34.0, 72.0, -28.0, 33.0)
TILE_KM = 50.0
STEP_LAT = TILE_KM / 111.32
FREIBURG = (47.999, 7.842)

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE tiles (tile_id TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, row INTEGER NOT NULL, col INTEGER NOT NULL);
CREATE TABLE climatology (tile_id TEXT NOT NULL, month INTEGER NOT NULL, day INTEGER NOT NULL,
  temperature_c REAL, temp_p25 REAL, temp_p75 REAL, temp_std REAL,
  precipitation_mm REAL, rain_probability REAL, rain_typical_mm REAL,
  wind_speed_ms REAL, wind_dir_deg REAL, wind_var_deg REAL,
  temp_hist_p25 REAL, temp_hist_p75 REAL, temp_day_p25 REAL, temp_day_p75 REAL, temp_day_median REAL,
  samples_daily INTEGER, samples_rain INTEGER, samples_wind INTEGER, samples_day_means INTEGER, samples_day_hours INTEGER,
  rain_hist_p25_mm REAL, rain_hist_p75_mm REAL, rain_hist_p90_mm REAL,
  PRIMARY KEY (tile_id, month, day));
CREATE TABLE build_state (tile_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT);
CREATE TABLE riding_hourly (tile_id TEXT NOT NULL, month INTEGER NOT NULL, day INTEGER NOT NULL, hour INTEGER NOT NULL,
  temp_median REAL, temp_p25 REAL, temp_p75 REAL, samples INTEGER, PRIMARY KEY (tile_id, month, day, hour));
"""
DAYS = [(m, d) for m, n in enumerate([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], 1) for d in range(1, n + 1)]


def row_of(lat):
    return int(math.floor((lat - BBOX[0]) / STEP_LAT))


def centre(row, col, origin, shift=0.0):
    lat = BBOX[0] + (row + 0.5) * STEP_LAT
    step_lon = TILE_KM / (111.32 * max(0.05, math.cos(math.radians(lat))))
    return lat, origin + (col + 0.5) * step_lon + shift


def make_store(path, year, tiles, days=DAYS):
    """tiles: [(row, col, origin, shift)]; temperature = longitude, precipitation = latitude."""
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    for k, v in {'provider': 'open-meteo', 'provider_only': 'true', 'tile_km': str(TILE_KM),
                 'bbox': json.dumps(dict(zip(('lat_min', 'lat_max', 'lon_min', 'lon_max'), BBOX))),
                 'years': json.dumps({'start': year, 'end': year})}.items():
        con.execute('INSERT INTO meta VALUES (?, ?)', (k, v))
    for row, col, origin, shift in tiles:
        tid = f'r{row}_c{col}'
        lat, lon = centre(row, col, origin, shift)
        con.execute('INSERT INTO tiles VALUES (?,?,?,?,?)', (tid, lat, lon, row, col))
        con.execute("INSERT INTO build_state VALUES (?, 'done', '2026-01-01', NULL)", (tid,))
        con.executemany(
            'INSERT INTO climatology (tile_id, month, day, temperature_c, temp_day_median, temp_day_p25, temp_day_p75, '
            'precipitation_mm, rain_typical_mm, wind_speed_ms, wind_dir_deg, wind_var_deg, samples_daily, samples_rain, '
            'samples_wind, samples_day_means, samples_day_hours) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,1,1,8)',
            [(tid, m, d, lon, lon, lon - 1, lon + 1, lat, lat, 3.0, 270.0, 0.0) for m, d in days])
    con.commit()
    con.close()
    return OfflineWeatherStore(OfflineWeatherStore._load_config(Path(path)))


R = row_of(FREIBURG[0])            # 31, as in the real databases
NEAR_B = [(R, c, -11.0, 0.0) for c in range(25, 31)]      # "-11" layout around Freiburg (~6-10 E)
FAR_B = [(R, 53, -11.0, 0.0)]                              # r31_c53 of the "-11" layout lies at ~25 E
NEAR_A = [(R, c, -28.0, 0.0) for c in range(52, 56)]       # "-28" layout: r31_c53 lies at ~7.9 E


def test_formula_id_names_a_far_tile_in_such_stores(tmp_path):
    """Precondition: the bbox formula really gives r31_c53, which lies ~25 E here."""
    st = make_store(tmp_path / 'offline_weather_2025.sqlite', 2025, NEAR_B + FAR_B)
    lat, lon = centre(R, 53, -11.0)
    assert abs(lon - 25.0) < 0.2
    step_lon = TILE_KM / (111.32 * math.cos(math.radians(lat)))
    assert int(math.floor((FREIBURG[1] - BBOX[2]) / step_lon)) == 53
    assert st is not None


def test_point_lookup_uses_the_tile_at_the_point(tmp_path):
    st = make_store(tmp_path / 'offline_weather_2025.sqlite', 2025, NEAR_B + FAR_B)
    stats = st.get_stats(*FREIBURG, 7, 1)
    assert stats is not None
    assert abs(float(stats['temperature_c']) - FREIBURG[1]) < 0.5, stats['temperature_c']


def test_point_without_a_nearby_tile_has_no_data(tmp_path):
    st = make_store(tmp_path / 'offline_weather_2025.sqlite', 2025, NEAR_B + FAR_B)
    assert st.get_stats(48.0, -20.0, 7, 1) is None
    assert st._tile_id_for_point(48.0, 16.0) is None          # between Freiburg tiles and the far tile


def test_tiles_added_by_the_builder_are_found(tmp_path, monkeypatch):
    path = tmp_path / 'offline_weather_2025.sqlite'
    st = make_store(path, 2025, NEAR_B)
    assert st._tile_id_for_point(48.0, 16.0) is None
    lat, lon = centre(R, 39, -11.0)
    con = sqlite3.connect(path)
    con.execute('INSERT INTO tiles VALUES (?,?,?,?,?)', ('r31_c39', lat, lon, R, 39))
    con.commit()
    con.close()
    monkeypatch.setattr(OfflineWeatherStore, 'TILE_INDEX_REFRESH_S', 0.0)
    assert st._tile_id_for_point(lat, lon) == 'r31_c39'


def test_multi_year_grid_never_mixes_places(tmp_path):
    s2025 = make_store(tmp_path / 'offline_weather_2025.sqlite', 2025, NEAR_B + FAR_B)
    s2023 = make_store(tmp_path / 'offline_weather_2023.sqlite', 2023, NEAR_A)
    pts = agg.aggregate_climate_multi('month', 182, 2025, stores=[(2025, s2025), (2023, s2023)],
                                      lat_min=46.0, lat_max=50.0, lon_min=0.0, lon_max=30.0)
    assert pts
    for p in pts:
        assert abs(p['temperature_c'] - p['lon']) < 0.3, p
    assert len({p['tile_id'] for p in pts}) == len(pts)


def test_multi_year_grid_merges_the_same_place_across_years(tmp_path):
    """One layout shifted slightly between databases (as in the real stores) is one place."""
    s2025 = make_store(tmp_path / 'offline_weather_2025.sqlite', 2025, NEAR_B)
    s2024 = make_store(tmp_path / 'offline_weather_2024.sqlite', 2024, [(r, c, o, 0.09) for r, c, o, _ in NEAR_B])
    pts = agg.aggregate_climate_multi('month', 182, 2025, stores=[(2025, s2025), (2024, s2024)],
                                      lat_min=46.0, lat_max=50.0, lon_min=0.0, lon_max=30.0)
    assert len(pts) == len(NEAR_B)
    for p in pts:
        assert abs(p['temperature_c'] - (p['lon'] + 0.045)) < 0.01, p


@pytest.fixture
def two_layout_years(backend, monkeypatch, tmp_path):
    stores = {2025: make_store(tmp_path / 'offline_weather_2025.sqlite', 2025, NEAR_B + FAR_B),
              2024: make_store(tmp_path / 'offline_weather_2024.sqlite', 2024, NEAR_B + FAR_B),
              2023: make_store(tmp_path / 'offline_weather_2023.sqlite', 2023, NEAR_A)}
    monkeypatch.setattr(backend_app, '_resolve_complete_reference_years', lambda n=3: ([2025, 2024, 2023][:n], []))
    monkeypatch.setattr(backend_app, '_resolve_offline_store_for_year', lambda y, **k: stores.get(int(y)))
    return backend


def test_climate_profile_uses_each_years_tile_at_the_point(two_layout_years):
    r = two_layout_years.app.test_client().get(
        '/api/explore/climate_profile', query_string={'lat': FREIBURG[0], 'lon': FREIBURG[1], 'reference_years': 3})
    assert r.status_code == 200, r.get_json()
    j = r.get_json()
    assert abs(j['meta']['tile_center']['lon'] - FREIBURG[1]) < 0.5, j['meta']
    assert j['meta']['tile_ids_by_year']['2023'] == 'r31_c53'          # the "-28" tile at Freiburg
    assert j['meta']['tile_ids_by_year']['2025'] != 'r31_c53'          # not the "-11" tile at 25 E
    temps = [p.get('mean_c') for m in j['temperature']['months'] for p in m['periods'] if p.get('mean_c') is not None]
    assert temps and all(abs(t - FREIBURG[1]) < 0.6 for t in temps), temps[:6]
