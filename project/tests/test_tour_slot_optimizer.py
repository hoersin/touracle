import sys
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1] / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from tour_slot_optimizer import optimize_tour_slots  # type: ignore


def _simple_route_data():
    # Roughly eastward route with simple cumulative distance and flat elevation.
    return {
        'points': [
            (55.0, 10.0, 10.0),
            (55.0, 10.8, 15.0),
            (55.0, 11.6, 12.0),
        ],
        'cum_km': [0.0, 50.0, 100.0],
    }


def _weather_lookup_headwind_forward(lat, lon, month, day, years_selected):
    # Wind from east (90 deg) means wind-to direction 270 deg:
    # - forward eastbound heading ~90 => mostly headwind
    # - reverse westbound heading ~270 => mostly tailwind
    return {
        'temp_day_median': 18.0,
        'temperature_c': 18.0,
        'precipitation_mm': 0.2,
        'rain_probability': 0.1,
        'wind_speed_ms': 7.0,
        'wind_dir_deg': 90.0,
    }


def _weather_lookup_threshold_sensitive(lat, lon, month, day, years_selected):
    return {
        'temp_day_median': 18.0,
        'temperature_c': 18.0,
        'precipitation_mm': 3.0,
        'rain_probability': 0.2,
        'wind_speed_ms': 3.0,
        'wind_dir_deg': 270.0,
    }


def _weather_lookup_objective_tradeoff(lat, lon, month, day, years_selected):
    # Four seasonal buckets with deliberate trade-offs so each objective can prefer
    # a different start window over a 7-day candidate horizon.
    month_lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    doy = int(day)
    for idx in range(max(0, int(month) - 1)):
        doy += month_lengths[idx]
    bucket = ((doy - 1) // 91) % 4

    if bucket == 0:
        # High lucky-day ratio: comfortable temperature, low rain, small headwind.
        return {
            'temp_day_median': 20.0,
            'temperature_c': 20.0,
            'precipitation_mm': 1.0,
            'rain_probability': 0.2,
            'wind_speed_ms': 4.0,
            'wind_dir_deg': 120.0,
        }
    if bucket == 1:
        # Hottest period (wins highest_avg_temperature).
        return {
            'temp_day_median': 36.0,
            'temperature_c': 36.0,
            'precipitation_mm': 3.0,
            'rain_probability': 0.5,
            'wind_speed_ms': 2.0,
            'wind_dir_deg': 270.0,
        }
    if bucket == 2:
        # Driest period (wins lowest_precip_sum), but poor otherwise.
        return {
            'temp_day_median': 5.0,
            'temperature_c': 5.0,
            'precipitation_mm': 0.0,
            'rain_probability': 0.0,
            'wind_speed_ms': 9.0,
            'wind_dir_deg': 90.0,
        }

    # Lowest headwind period via strong tailwind alignment.
    return {
        'temp_day_median': 18.0,
        'temperature_c': 18.0,
        'precipitation_mm': 8.0,
        'rain_probability': 0.8,
        'wind_speed_ms': 10.0,
        'wind_dir_deg': 270.0,
    }


def test_auto_compare_can_prefer_reverse_when_wind_alignment_is_better():
    out = optimize_tour_slots(
        route_data=_simple_route_data(),
        total_days=7,
        rest_day_indexes=[],
        boundaries_km=[],
        years_selected=[2025, 2024, 2023],
        anchor_year=2026,
        direction_mode='auto_compare',
        objective_mode='lowest_headwind_sum',
        top_n=5,
        weather_lookup=_weather_lookup_headwind_forward,
    )

    assert out['candidates']
    best = out['candidates'][0]
    assert best['direction'] == 'reverse'


def test_forward_mode_only_returns_forward_candidates():
    out = optimize_tour_slots(
        route_data=_simple_route_data(),
        total_days=7,
        rest_day_indexes=[],
        boundaries_km=[],
        years_selected=[2025],
        anchor_year=2026,
        direction_mode='forward',
        objective_mode='most_lucky_days',
        top_n=3,
        weather_lookup=_weather_lookup_headwind_forward,
    )

    assert out['candidates']
    assert all(c['direction'] == 'forward' for c in out['candidates'])


def test_highest_average_temperature_sets_higher_is_better_semantics():
    out = optimize_tour_slots(
        route_data=_simple_route_data(),
        total_days=7,
        rest_day_indexes=[],
        boundaries_km=[],
        years_selected=[2025],
        anchor_year=2026,
        direction_mode='forward',
        objective_mode='highest_avg_temperature',
        top_n=3,
        weather_lookup=_weather_lookup_headwind_forward,
    )
    assert out['meta']['objective_mode'] == 'highest_avg_temperature'
    assert out['meta']['score_interpretation'] == 'higher_is_better'


def test_objective_modes_can_change_selected_top_window_deterministically():
    common_kwargs = dict(
        route_data=_simple_route_data(),
        total_days=7,
        rest_day_indexes=[],
        boundaries_km=[],
        years_selected=[2025],
        anchor_year=2026,
        direction_mode='forward',
        top_n=5,
        weather_lookup=_weather_lookup_objective_tradeoff,
    )

    best_by_mode = {}
    for mode in [
        'most_lucky_days',
        'highest_avg_temperature',
        'lowest_precip_sum',
        'lowest_headwind_sum',
    ]:
        out = optimize_tour_slots(objective_mode=mode, **common_kwargs)
        assert out['candidates']
        best_by_mode[mode] = out['candidates'][0]['start_date']

    # Regression guard: objective selector must influence ranking for this fixture.
    distinct_top_windows = set(best_by_mode.values())
    assert len(distinct_top_windows) >= 3

    # Targeted sanity checks for the synthetic trade-off fixture.
    assert best_by_mode['highest_avg_temperature'] != best_by_mode['lowest_precip_sum']
    assert best_by_mode['lowest_headwind_sum'] != best_by_mode['lowest_precip_sum']


def test_day_granularity_generates_more_candidates_than_weekly():
    common_kwargs = dict(
        route_data=_simple_route_data(),
        total_days=7,
        rest_day_indexes=[],
        boundaries_km=[],
        years_selected=[2025],
        anchor_year=2026,
        direction_mode='forward',
        objective_mode='most_lucky_days',
        top_n=3,
        weather_lookup=_weather_lookup_headwind_forward,
    )
    out_week = optimize_tour_slots(slot_step_days=7, **common_kwargs)
    out_day = optimize_tour_slots(slot_step_days=1, **common_kwargs)
    assert out_week['meta']['slot_granularity'] == 'week'
    assert out_day['meta']['slot_granularity'] == 'day'
    assert int(out_day['meta']['candidate_count']) > int(out_week['meta']['candidate_count'])


def test_slot_sensitivity_metadata_is_present_and_structured():
    out = optimize_tour_slots(
        route_data=_simple_route_data(),
        total_days=7,
        rest_day_indexes=[],
        boundaries_km=[],
        years_selected=[2025],
        anchor_year=2026,
        direction_mode='forward',
        objective_mode='most_lucky_days',
        slot_step_days=1,
        top_n=3,
        weather_lookup=_weather_lookup_headwind_forward,
    )
    ss = out['meta'].get('slot_sensitivity') or {}
    assert ss.get('label') in ('stable', 'moderate', 'fragile', 'unknown')
    assert ss.get('window_days') == 3
    assert isinstance(ss.get('offsets'), list)
    curve = out['meta'].get('year_penalty_curve') or {}
    assert isinstance(curve, dict)
    assert isinstance(curve.get('points'), list)
    assert curve.get('points')


def test_lucky_day_counts_follow_configured_thresholds():
    out_strict = optimize_tour_slots(
        route_data=_simple_route_data(),
        total_days=7,
        rest_day_indexes=[],
        boundaries_km=[],
        years_selected=[2025],
        anchor_year=2026,
        direction_mode='forward',
        objective_mode='most_lucky_days',
        slot_step_days=7,
        top_n=1,
        weather_lookup=_weather_lookup_threshold_sensitive,
        lucky_thresholds={
            'temp_cold': 5.0,
            'temp_hot': 30.0,
            'rain_high': 2.0,
            'wind_head_comfort': 4.0,
            'wind_tail_comfort': 10.0,
        },
    )
    out_loose = optimize_tour_slots(
        route_data=_simple_route_data(),
        total_days=7,
        rest_day_indexes=[],
        boundaries_km=[],
        years_selected=[2025],
        anchor_year=2026,
        direction_mode='forward',
        objective_mode='most_lucky_days',
        slot_step_days=7,
        top_n=1,
        weather_lookup=_weather_lookup_threshold_sensitive,
        lucky_thresholds={
            'temp_cold': 5.0,
            'temp_hot': 30.0,
            'rain_high': 10.0,
            'wind_head_comfort': 4.0,
            'wind_tail_comfort': 10.0,
        },
    )

    lucky_strict = int(out_strict['candidates'][0]['summary']['lucky_days'])
    lucky_loose = int(out_loose['candidates'][0]['summary']['lucky_days'])
    assert lucky_loose > lucky_strict
