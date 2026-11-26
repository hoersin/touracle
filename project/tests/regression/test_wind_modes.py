"""Wind rose classification: downwind convention and one/two/no dominant directions.

Observations are (meteorological FROM direction, daily mean speed). Touracle draws
the direction the wind pushes TOWARDS: FROM + 180 deg.
"""
from __future__ import annotations

import random

import pytest

import wind_modes as wm


def days(direction, n, speed=5.0):
    return [(direction, speed)] * n


def spread(n, speed=5.0, seed=1):
    rnd = random.Random(seed)
    return [(rnd.uniform(0, 360), speed) for _ in range(n)]


def angle_diff(a, b):
    return abs((a - b + 180) % 360 - 180)


def test_north_60_west_30_gives_two_arrows_pointing_south_and_east():
    obs = days(0, 54) + days(270, 27) + spread(9)          # 60 % N, 30 % W, 10 % random
    modes = wm.classify_observations(obs)
    assert len(modes) == 2, modes
    first, second = modes
    assert angle_diff(first['from_deg'], 0) < 10 and angle_diff(first['to_deg'], 180) < 10       # from N -> pushes S
    assert angle_diff(second['from_deg'], 270) < 10 and angle_diff(second['to_deg'], 90) < 10    # from W -> pushes E
    assert first['share'] > second['share']                 # first arrow more prominent


@pytest.mark.parametrize('from_deg,to_deg', [(0, 180), (45, 225), (90, 270), (135, 315), (180, 0), (225, 45),
                                             (270, 90), (315, 135), (337.5, 157.5)])
def test_every_direction_is_shown_rotated_by_exactly_180_degrees(from_deg, to_deg):
    modes = wm.classify_observations(days(from_deg, 40))
    assert modes, from_deg
    assert angle_diff(modes[0]['from_deg'], from_deg) < 0.05, modes[0]
    assert angle_diff(modes[0]['to_deg'], to_deg) < 0.05, modes[0]
    assert angle_diff(modes[0]['to_deg'], modes[0]['from_deg']) == pytest.approx(180.0, abs=1e-6)


def test_mistral_like_single_direction_gives_one_arrow():
    obs = days(337.5, 50, speed=9.0) + spread(40, speed=3.0)  # strong NNW wind on most days
    modes = wm.classify_observations(obs)
    assert len(modes) == 1, modes
    assert angle_diff(modes[0]['to_deg'], 157.5) < 15         # pushes SSE


def test_even_spread_over_four_directions_shows_nothing():
    obs = days(0, 25) + days(90, 25) + days(180, 25) + days(270, 25)
    assert wm.classify_observations(obs) == []


def test_uniform_directions_show_nothing():
    assert wm.classify_observations(spread(365)) == []


def test_two_adjacent_strong_sectors_are_one_direction_not_two():
    obs = days(0, 40) + days(22.5, 35) + spread(15)
    modes = wm.classify_observations(obs)
    assert len(modes) == 1, modes
    assert angle_diff(modes[0]['from_deg'], 11.25) < 8


def test_weak_wind_is_not_shown_even_if_directional():
    assert wm.classify_observations(days(270, 60, speed=1.0)) == []


def test_too_few_days_say_nothing():
    assert wm.classify_observations(days(270, wm.MIN_DAYS - 1)) == []


def test_strong_wind_outweighs_an_equally_frequent_breeze():
    obs = days(0, 30, speed=10.0) + days(180, 30, speed=1.5) + spread(10)
    modes = wm.classify_observations(obs)
    assert modes and angle_diff(modes[0]['from_deg'], 0) < 10
    assert all(angle_diff(m['from_deg'], 180) > 30 for m in modes), modes   # breeze < 2 m/s average


def test_circular_mean_across_north():
    modes = wm.classify_observations(days(348.75, 30) + days(11.25, 30) + spread(10))
    assert modes and angle_diff(modes[0]['from_deg'], 0) < 8, modes


def test_grid_aggregation_reports_downwind_modes_per_tile(tmp_path):
    """Through the real aggregation: synthetic stores blow from the west (270) every day."""
    import climate_aggregation as agg
    import test_offline_tile_lookup as tl
    s2025 = tl.make_store(tmp_path / 'offline_weather_2025.sqlite', 2025, tl.NEAR_B)
    s2024 = tl.make_store(tmp_path / 'offline_weather_2024.sqlite', 2024, tl.NEAR_B)
    for stores in ([(2025, s2025)], [(2025, s2025), (2024, s2024)]):
        pts = agg.aggregate_climate_multi('month', 182, 2025, stores=stores, lat_min=46.0, lat_max=50.0,
                                          lon_min=0.0, lon_max=30.0) if len(stores) > 1 else \
            agg.aggregate_climate('month', 182, 2025, store=s2025, lat_min=46.0, lat_max=50.0, lon_min=0.0, lon_max=30.0)
        assert pts
        for p in pts:
            assert len(p['wind_modes']) == 1, p['wind_modes']
            assert angle_diff(p['wind_modes'][0]['from_deg'], 270) < 0.05
            assert angle_diff(p['wind_modes'][0]['to_deg'], 90) < 0.05      # pushes east
