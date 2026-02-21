"""Standalone verification of Meteostat basic functionality.
Does not use project modules.
"""
from datetime import datetime
from typing import List
import numpy as np
import pandas as pd

# Meteostat imports (functional API)
from meteostat import Point, daily
try:
    from meteostat import Stations as StationsClass
except Exception:
    StationsClass = None
try:
    from meteostat import stations as stations_func
except Exception:
    stations_func = None


LAT = 43.6112
LON = 3.8771
START = datetime(2015, 1, 1)
END = datetime(2023, 12, 31)
MONTH = 5
DAY = 15


def label(title: str):
    print("\n" + title)
    print("-" * len(title))


def run():
    label("[BASIC] Query nearby stations")
    df = None
    try:
        if StationsClass is not None:
            s = StationsClass()
            s = s.nearby(LAT, LON)
            df = s.fetch()
        elif stations_func is not None:
            df = stations_func(bounds=(LAT - 1, LON - 1, LAT + 1, LON + 1))
        else:
            raise RuntimeError('No stations API available')
    except Exception as e:
        print(f"[ERROR] Stations query failed: {e}")
    if df is None or df.empty:
        print("Stations found: 0")
    else:
        print(f"Stations found: {len(df)}")
        print("First 5 stations:")
        print(df[['id', 'name', 'latitude', 'longitude']].head(5))
        cols = [c for c in df.columns if 'daily' in c]
        print("Columns with daily_ prefix:", cols)

    label("[BASIC] Fetch Daily(Point) data 2015–2023")
    df_daily = None
    try:
        pt = Point(LAT, LON)
        df_daily = daily(pt, START, END)
    except Exception as e:
        print(f"[ERROR] Daily Point fetch failed: {e}")

    if df_daily is None or len(df_daily) == 0:
        print("Rows: 0")
    else:
        print(f"Rows: {len(df_daily)}")
        print("First 5 rows:")
        print(df_daily.head(5))
        print("Available columns:", list(df_daily.columns))
        missing_pct = float(df_daily.isna().mean().mean() * 100.0)
        print(f"Missing values: {missing_pct:.1f}% (overall)")

    label("[BASIC] Stats for May 15 (across years)")
    if df_daily is None or len(df_daily) == 0:
        print("No data available for stats.")
        return
    # Determine date column
    date_col = 'time' if 'time' in df_daily.columns else None
    idx_dates = df_daily.index if date_col is None else pd.to_datetime(df_daily[date_col])
    mask = (idx_dates.month == MONTH) & (idx_dates.day == DAY)
    subset = df_daily.loc[mask]
    print(f"Matching days: {len(subset)}")
    if len(subset) == 0:
        print("No matching days for May 15.")
        return
    # Temperature median
    if 'tavg' in subset.columns and subset['tavg'].notna().any():
        temp_med = float(np.nanmedian(subset['tavg']))
    elif {'tmin', 'tmax'}.issubset(subset.columns):
        temp_med = float(np.nanmedian((subset['tmin'] + subset['tmax']) / 2.0))
    else:
        temp_med = float('nan')
    prcp_med = float(np.nanmedian(subset['prcp'])) if 'prcp' in subset.columns else float('nan')
    wspd_med = float(np.nanmedian(subset['wspd'])) if 'wspd' in subset.columns else float('nan')
    print(f"Median Temp: {temp_med:.2f} °C")
    print(f"Median Precip: {prcp_med:.2f} mm")
    print(f"Median Wind: {wspd_med:.2f} m/s")


if __name__ == '__main__':
    run()
