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


def test_weather_mode_normalization_defaults_to_climatology():
    assert _normalize_tour_weather_mode('hybrid') == 'climatology'
    assert _normalize_tour_weather_mode('forecast') == 'forecast'
    assert _normalize_tour_weather_mode('climatology') == 'climatology'
    assert _normalize_tour_weather_mode('unknown') == 'climatology'


def test_forecast_mode_uses_forecast_only_inside_horizon():
    today = dt.date.today()
    assert _effective_tour_weather_mode('forecast', today) == 'forecast'
    assert _effective_tour_weather_mode('forecast', today + dt.timedelta(days=13)) == 'forecast'
    assert _effective_tour_weather_mode('forecast', today + dt.timedelta(days=14)) == 'climatology'


def test_non_forecast_modes_stay_climatology():
    today = dt.date.today()
    assert _effective_tour_weather_mode('climatology', today) == 'climatology'
    assert _effective_tour_weather_mode('historical-median', today) == 'climatology'
    assert _effective_tour_weather_mode('hybrid', today) == 'climatology'


def test_hybrid_specific_server_side_branch_removed():
    source = (BACKEND_DIR / 'app.py').read_text(encoding='utf-8')
    assert "if tour_weather_mode == 'forecast':" in source
    assert 'force_online = True' in source


def test_hybrid_current_year_spec_disabled():
    today = dt.date.today()
    assert _hybrid_current_year_historical_spec('hybrid', today) is None
    assert _hybrid_current_year_historical_spec('forecast', today) is None


def test_location_scoring_prefers_recognizable_places_over_hamlets():
    city_score = _location_candidate_score(18.0, 120000, _location_admin_importance('city'))
    hamlet_score = _location_candidate_score(1.0, 0, _location_admin_importance('hamlet'))
    assert city_score > hamlet_score


def test_reverse_geocode_cache_key_is_fine_grained_enough_for_nearby_towns():
    bayonne = _reverse_geocode_cache_key(43.493777, -1.473531)
    ustaritz = _reverse_geocode_cache_key(43.499900, -1.456000)
    assert bayonne != ustaritz
    assert bayonne == (43.494, -1.474)