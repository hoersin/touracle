from math import sin, pi
from pathlib import Path
import sys

BASE_DIR = Path(__file__).resolve().parents[1]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from backend.route_sampling import (
    compute_elevation_stats_from_series,
    compare_elevation_stats,
    compute_segment_ascent_sum,
)


def test_flat_route_has_zero_ascent_descent():
    dist = [0.0, 10.0, 20.0, 30.0]
    elev = [120.0, 120.0, 120.0, 120.0]
    stats = compute_elevation_stats_from_series(dist, elev, stage_key='flat', label='Flat')
    assert stats['points'] == 4
    assert stats['distance_km'] == 30.0
    assert stats['ascent_m'] == 0.0
    assert stats['descent_m'] == 0.0
    assert stats['missing_elevation_points'] == 0


def test_rolling_hills_ascent_descent_are_accumulated_correctly():
    dist = [0.0, 5.0, 10.0, 15.0, 20.0]
    elev = [100.0, 130.0, 110.0, 150.0, 120.0]
    stats = compute_elevation_stats_from_series(dist, elev, stage_key='rolling', label='Rolling')
    assert stats['ascent_m'] == 70.0
    assert stats['descent_m'] == 50.0


def test_alpine_route_large_gain_is_preserved_in_reference_stats():
    dist = [0.0, 15.0, 30.0, 45.0, 60.0, 75.0]
    elev = [800.0, 1200.0, 900.0, 1800.0, 1400.0, 2100.0]
    stats = compute_elevation_stats_from_series(dist, elev, stage_key='alpine', label='Alpine')
    assert stats['ascent_m'] == 2000.0
    assert stats['descent_m'] == 700.0


def test_sparse_sampling_shows_expected_ascent_loss_against_dense_series():
    dense_dist = [i * 0.5 for i in range(401)]  # 0..200 km
    dense_elev = [500.0 + 120.0 * sin((i / 400.0) * 8 * pi) for i in range(401)]
    sparse_idx = list(range(0, 401, 20))
    sparse_dist = [dense_dist[i] for i in sparse_idx]
    sparse_elev = [dense_elev[i] for i in sparse_idx]

    dense_stats = compute_elevation_stats_from_series(dense_dist, dense_elev, stage_key='dense', label='Dense')
    sparse_stats = compute_elevation_stats_from_series(sparse_dist, sparse_elev, stage_key='sparse', label='Sparse')
    cmp_stats = compare_elevation_stats(dense_stats, sparse_stats)

    assert dense_stats['ascent_m'] > 0.0
    assert sparse_stats['ascent_m'] >= 0.0
    assert cmp_stats['ascent_loss_m'] >= 0.0
    assert cmp_stats['ascent_loss_pct'] >= 0.0


def test_segment_ascent_sum_matches_total_ascent_with_consistent_boundaries():
    dist = [0.0, 10.0, 20.0, 30.0, 40.0]
    elev = [100.0, 180.0, 140.0, 220.0, 210.0]
    total_stats = compute_elevation_stats_from_series(dist, elev, stage_key='total', label='Total')
    segments = compute_segment_ascent_sum(dist, elev, boundaries_km=[20.0])

    assert len(segments['segment_ascent_m']) == 2
    assert abs(float(segments['sum_ascent_m']) - float(total_stats['ascent_m'])) < 1e-9
