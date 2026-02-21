import math
from pathlib import Path

from project.backend.route_sampling import sample_route, haversine_km

# This test verifies tour-day assignment for sampled points aligns with
# route segmentation by scaling sampled distances to full route length.


def compute_full_distance(coords):
    total = 0.0
    for i in range(1, len(coords)):
        lon1, lat1 = coords[i-1]
        lon2, lat2 = coords[i]
        total += haversine_km(lat1, lon1, lat2, lon2)
    return total


def compute_sampled_distances(points):
    acc = 0.0
    dists = [0.0]
    for i in range(1, len(points)):
        lat1, lon1 = points[i-1]
        lat2, lon2 = points[i]
        acc += haversine_km(lat1, lon1, lat2, lon2)
        dists.append(acc)
    return dists, acc


def assign_day_indices(dists_from_start, segment_length, tour_days, scale_factor):
    import bisect
    marks = [segment_length * k for k in range(1, int(tour_days))]
    out = []
    margin_km = 0.05 * segment_length
    n_pts = max(1, len(dists_from_start) - 1)
    for i, d in enumerate(dists_from_start):
        d_scaled = d * scale_factor
        base_idx = bisect.bisect_left(marks, d_scaled)
        if base_idx < len(marks):
            next_mark = marks[base_idx]
            if next_mark - d_scaled <= margin_km:
                base_idx = base_idx + 1
        # Blend with index-based fraction
        frac_dist = (i / n_pts) * (segment_length * tour_days)
        idx_frac = bisect.bisect_left(marks, frac_dist)
        base_idx = max(base_idx, idx_frac)
        day_idx = max(0, min(tour_days - 1, base_idx))
        out.append(day_idx)
    return out


def test_day_assignment_points_12_and_22():
    base = Path(__file__).resolve().parents[2]
    gpx_path = base / 'project' / 'data' / 'example_route.gpx'
    assert gpx_path.exists(), f"GPX does not exist: {gpx_path}"

    # Use same default sampling as backend map_stream
    sampled_points, route_feature = sample_route(str(gpx_path), step_km=25.0)
    coords = route_feature['geometry']['coordinates']

    full_total_km = compute_full_distance(coords)
    dists_from_start, sampled_total_km = compute_sampled_distances(sampled_points)
    assert full_total_km > 0 and sampled_total_km > 0
    tour_days = 7
    segment_length = full_total_km / tour_days
    scale_factor = full_total_km / sampled_total_km

    days = assign_day_indices(dists_from_start, segment_length, tour_days, scale_factor)

    # Basic sanity: monotonic, last point reaches last day
    assert days[0] == 0
    assert days[-1] == tour_days - 1
    assert all(days[i] <= days[i+1] for i in range(len(days)-1))

    # If enough points exist, check specific indices as per user expectation
    if len(days) > 22:
        assert days[12] == 3, f"Expected point 12 → Day 4 (index 3), got {days[12]}"
        assert days[22] == 6, f"Expected point 22 → Day 7 (index 6), got {days[22]}"


def test_day_assignment_specific_rps_boundaries():
    # Use the default GPX used by the app for realistic segmentation
    base = Path(__file__).resolve().parents[2]
    gpx_path = base / 'project' / 'data' / '2026-02-13_2781422668_von Montpellier nach Bayonne.gpx'
    assert gpx_path.exists(), f"GPX does not exist: {gpx_path}"

    sampled_points, route_feature = sample_route(str(gpx_path), step_km=25.0)
    coords = route_feature['geometry']['coordinates']
    full_total_km = compute_full_distance(coords)
    dists_from_start, sampled_total_km = compute_sampled_distances(sampled_points)
    assert full_total_km > 0 and sampled_total_km > 0

    tour_days = 7
    segment_length = full_total_km / tour_days
    scale_factor = full_total_km / sampled_total_km
    days = assign_day_indices(dists_from_start, segment_length, tour_days, scale_factor)

    # Ensure we have enough points
    assert len(days) > 16, f"Not enough sampled points: {len(days)}"

    # Expected boundary assignments from user
    assert days[4] == 0, f"RP4 should be Day 1 (index 0), got {days[4]}"
    assert days[10] == 2, f"RP10 should be Day 3 (index 2), got {days[10]}"
    assert days[13] == 3, f"RP13 should be Day 4 (index 3), got {days[13]}"
    assert days[16] == 4, f"RP16 should be Day 5 (index 4), got {days[16]}"
