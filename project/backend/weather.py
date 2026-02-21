from typing import Dict, Any, Optional, Tuple
from datetime import datetime, timedelta
import numpy as np
import pandas as pd
import logging
from datetime import date

log = logging.getLogger('pipeline.weather')


def compute_wind_statistics(directions_deg: pd.Series) -> Dict[str, float]:
    """
    Compute circular mean direction and variability from wind direction series (degrees).
    Variability reported as circular standard deviation in degrees.
    """
    dirs = directions_deg.dropna().to_numpy()
    if dirs.size == 0:
        return {"wind_dir_deg": 0.0, "wind_var_deg": 180.0}
    radians = np.deg2rad(dirs)
    mean_sin = np.mean(np.sin(radians))
    mean_cos = np.mean(np.cos(radians))
    mean_dir = np.rad2deg(np.arctan2(mean_sin, mean_cos)) % 360.0
    R = np.sqrt(mean_sin ** 2 + mean_cos ** 2)
    if R <= 0:
        circ_std_rad = np.pi
    else:
        circ_std_rad = np.sqrt(-2.0 * np.log(R))
    circ_std_deg = float(np.rad2deg(circ_std_rad))
    return {"wind_dir_deg": float(mean_dir), "wind_var_deg": circ_std_deg}


def fetch_weather_data_point(lat: float, lon: float, start_year: int = 2000, years: int = 25) -> pd.DataFrame:
    """Fetch Meteostat Daily(Point) data for the last `years` years starting from `start_year`.
    Returns DataFrame indexed by date with available columns.
    """
    start = datetime(start_year, 1, 1)
    end = datetime(start_year + years - 1, 12, 31)
    log.info('[WEATHER] Fetching data for lat=%.5f lon=%.5f', lat, lon)
    pt = Point(lat, lon)
    try:
        df = daily(pt, start, end)
        rows = len(df) if df is not None else 0
        log.info('[WEATHER] Rows retrieved: %d', rows)
        return df if df is not None else pd.DataFrame()
    except Exception as e:
        log.error('[WEATHER] Fetch failed: %s', e)
        raise


def compute_weather_statistics_daily(df: pd.DataFrame, month: int, day: int) -> Tuple[Dict[str, Any], int]:
    """Compute medians for temperature, precipitation, wind speed, and circular wind stats for matching month/day across years.
    Returns (stats dict, matching_rows).
    """
    if df is None or df.empty:
        raise ValueError('No daily data available')
    # Determine date series
    # Accept 'date' or 'time' column, or DatetimeIndex
    if isinstance(df.index, pd.DatetimeIndex):
        months = df.index.month
        days = df.index.day
    elif 'date' in df.columns:
        ds = pd.to_datetime(df['date'])
        months = ds.dt.month
        days = ds.dt.day
    elif 'time' in df.columns:
        ds = pd.to_datetime(df['time'])
        months = ds.dt.month
        days = ds.dt.day
    else:
        raise ValueError('No date column or datetime index')
    mask = (months == month) & (days == day)
    subset = df.loc[mask]
    match_rows = int(len(subset))
    log.info('[WEATHER] Matching days: %d', match_rows)
    # Temperature median
    if 'tavg' in subset.columns and subset['tavg'].notna().any():
        temp_med = float(np.nanmedian(subset['tavg']))
    elif {'tmin', 'tmax'}.issubset(subset.columns):
        temp_med = float(np.nanmedian((subset['tmin'] + subset['tmax']) / 2.0))
    else:
        raise ValueError('Temperature columns missing')
    # Precipitation probability and typical amount
    if 'prcp' in subset.columns:
        prcp_series = pd.to_numeric(subset['prcp'], errors='coerce')
        valid_days = int(prcp_series.notna().sum())
        rain_days = int((prcp_series > 0.1).sum())
        rain_prob = float(rain_days / valid_days) if valid_days > 0 else 0.0
        typical_rain = float(np.nanmedian(prcp_series[prcp_series > 0.1])) if (prcp_series > 0.1).any() else 0.0
        prcp_med = float(np.nanmedian(prcp_series))
        log.info('[WEATHER] Rain probability: %.1f%% (%d/%d)', rain_prob * 100.0, rain_days, valid_days)
        log.info('[WEATHER] Typical rain amount: %.2f mm (median of >0.1mm)', typical_rain)
    else:
        prcp_series = pd.Series(dtype=float)
        prcp_med = 0.0
        rain_prob = 0.0
        typical_rain = 0.0
    wspd_med = float(np.nanmedian(subset['wspd'])) if 'wspd' in subset.columns else 0.0
    wdir_series = pd.to_numeric(subset.get('wdir'), errors='coerce') if 'wdir' in subset.columns else pd.Series(dtype=float)
    wind_stats = compute_wind_statistics(wdir_series)
    stats = {
        "temperature_c": temp_med,
        "precipitation_mm": prcp_med,
        "rain_probability": rain_prob,
        "rain_typical_mm": typical_rain,
        "wind_speed_ms": wspd_med,
        "wind_dir_deg": wind_stats["wind_dir_deg"],
        "wind_var_deg": wind_stats["wind_var_deg"],
    }
    log.info('[WEATHER] Median temp: %.2f', temp_med)
    log.info('[WEATHER] Rain stats: prob=%.2f, typical=%.2f mm', rain_prob, typical_rain)
    return stats, match_rows


def compute_weather_statistics(df: pd.DataFrame, month: int, day: int) -> Tuple[Dict[str, Any], int]:
    """Wrapper with the expected name, computing stats for daily DataFrame.
    Returns (stats dict, matching_rows)."""
    return compute_weather_statistics_daily(df, month, day)


def compute_daytime_temperature_statistics(df_hourly: pd.DataFrame, month: int, day: int) -> Tuple[Dict[str, Any], int]:
    """Compute daytime temperature statistics.
    - Select hours 10, 12, 14, 16 local time from historical hourly data for the target calendar day across years.
    - For each historical date, compute the mean of the selected hours (skip dates with <2 values).
    - Historical variability (between years): percentiles of these per-date means → temp_hist_p25, temp_hist_p75.
    - Daytime variability (within a day across all years): percentiles of all selected-hour values combined → temp_day_p25, temp_day_p75.
    Returns stats dict including backward-compatible keys temp_p25/temp_p75 mirroring historical percentiles.
    """
    if df_hourly is None or df_hourly.empty:
        raise ValueError('No hourly data available')
    # Expect columns 'time' (datetime) and 'temperature_2m'
    if 'time' not in df_hourly.columns or 'temperature_2m' not in df_hourly.columns:
        raise ValueError('Hourly data missing required columns')
    # Group by date
    ts = pd.to_datetime(df_hourly['time'])
    hours = ts.dt.hour
    temps = pd.to_numeric(df_hourly['temperature_2m'], errors='coerce')
    dates = ts.dt.date
    target_hours = {10, 12, 14, 16}
    means = []
    hour_vals = []
    by_date = pd.DataFrame({'date': dates, 'hour': hours, 'temp': temps})
    for d, g in by_date.groupby('date'):
        sel = g[g['hour'].isin(target_hours)]['temp'].dropna()
        if len(sel) >= 2:
            m = float(sel.mean())
            means.append((d, m))
            log.info('[WEATHER] Day %s daytime mean=%.2f', d, m)
        # Collect values for daytime variability across all years
        for v in sel.values:
            try:
                fv = float(v)
                if np.isfinite(fv):
                    hour_vals.append(fv)
            except Exception:
                pass
    if not means:
        raise ValueError('No valid daytime means computed')
    vals_means = np.array([m for _, m in means], dtype=float)
    med = float(np.nanmedian(vals_means))
    hist_p25 = float(np.nanpercentile(vals_means, 25))
    hist_p75 = float(np.nanpercentile(vals_means, 75))
    std = float(np.nanstd(vals_means))
    # Daytime variability percentiles across all selected hours in all years
    vals_hours = np.array(hour_vals, dtype=float)
    if vals_hours.size >= 1:
        day_med = float(np.nanmedian(vals_hours))
    else:
        day_med = float('nan')
    if vals_hours.size >= 4:
        day_p25 = float(np.nanpercentile(vals_hours, 25))
        day_p75 = float(np.nanpercentile(vals_hours, 75))
    else:
        day_p25 = float('nan')
        day_p75 = float('nan')
    log.info('[WEATHER] Daytime median temp: %.2f (hist IQR=%.2f..%.2f, std=%.2f; daytime median=%.2f IQR=%.2f..%.2f)', med, hist_p25, hist_p75, std, day_med, day_p25, day_p75)
    stats = {
        'temperature_c': med,
        # Backward-compatible typical range (historical between-year variability)
        'temp_p25': hist_p25,
        'temp_p75': hist_p75,
        'temp_std': std,
        # New keys for band rendering
        'temp_hist_p25': hist_p25,
        'temp_hist_p75': hist_p75,
        'temp_day_p25': day_p25,
        'temp_day_p75': day_p75,
        'temp_day_median': day_med,
        '_daytime_points': len(vals_means),
        '_daytime_samples': len(vals_hours),
    }
    return stats, int(len(vals_means))
