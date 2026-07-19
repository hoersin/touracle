import datetime as dt
from pathlib import Path
import sys


BACKEND_DIR = Path(__file__).resolve().parents[1] / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app import (  # type: ignore
    _effective_tour_weather_mode,
    _hybrid_current_year_historical_spec,
    _location_admin_importance,
    _location_candidate_score,
    _normalize_tour_weather_mode,
    _reverse_geocode_cache_key,
)


def test_hybrid_weather_mode_normalization_accepts_new_mode():
    assert _normalize_tour_weather_mode('hybrid') == 'hybrid'
    assert _normalize_tour_weather_mode('forecast') == 'forecast'
    assert _normalize_tour_weather_mode('climatology') == 'climatology'


def test_hybrid_mode_uses_forecast_only_inside_horizon():
    today = dt.date.today()
    assert _effective_tour_weather_mode('hybrid', today) == 'forecast'
    assert _effective_tour_weather_mode('hybrid', today + dt.timedelta(days=13)) == 'forecast'
    assert _effective_tour_weather_mode('hybrid', today + dt.timedelta(days=14)) == 'climatology'


def test_hybrid_mode_uses_current_year_history_for_past_and_today():
    today = dt.date.today()
    spec_today = _hybrid_current_year_historical_spec('hybrid', today)
    spec_past = _hybrid_current_year_historical_spec('hybrid', today - dt.timedelta(days=10))
    spec_future = _hybrid_current_year_historical_spec('hybrid', today + dt.timedelta(days=1))
    assert spec_today is not None
    assert spec_today['start_year'] == today.year
    assert spec_today['end_year'] == today.year
    assert spec_today['include_current_year'] is True
    assert spec_today['weather_source'] == 'historical-current-year'
    assert spec_past is not None
    assert spec_future is None


def test_hybrid_mode_forces_online_route_path_server_side():
    source = (BACKEND_DIR / 'app.py').read_text(encoding='utf-8')
    assert "if tour_weather_mode in ('forecast', 'hybrid'):" in source
    assert 'offline_only = False' in source
    assert 'force_online = True' in source


def test_location_scoring_prefers_recognizable_places_over_hamlets():
    city_score = _location_candidate_score(18.0, 120000, _location_admin_importance('city'))
    hamlet_score = _location_candidate_score(1.0, 0, _location_admin_importance('hamlet'))
    assert city_score > hamlet_score


def test_reverse_geocode_cache_key_is_fine_grained_enough_for_nearby_towns():
    bayonne = _reverse_geocode_cache_key(43.493777, -1.473531)
    ustaritz = _reverse_geocode_cache_key(43.499900, -1.456000)
    assert bayonne != ustaritz
    assert bayonne == (43.494, -1.474)