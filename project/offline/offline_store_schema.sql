-- Offline Open‑Meteo tile store (SQLite)
-- Created: 2026-02-23

PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tiles (
  tile_id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  row INTEGER NOT NULL,
  col INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS climatology (
  tile_id TEXT NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,

  -- App-facing stats (aligned with backend `stats` keys)
  temperature_c REAL,
  temp_p25 REAL,
  temp_p75 REAL,
  temp_std REAL,

  precipitation_mm REAL,
  rain_probability REAL,
  rain_typical_mm REAL,

  wind_speed_ms REAL,
  wind_dir_deg REAL,
  wind_var_deg REAL,

  -- Daytime / riding-hours stats
  temp_hist_p25 REAL,
  temp_hist_p75 REAL,
  temp_day_p25 REAL,
  temp_day_p75 REAL,
  temp_day_median REAL,

  -- Sample counts for transparency/debug
  samples_daily INTEGER,
  samples_rain INTEGER,
  samples_wind INTEGER,
  samples_day_means INTEGER,
  samples_day_hours INTEGER,

  PRIMARY KEY (tile_id, month, day),
  FOREIGN KEY (tile_id) REFERENCES tiles(tile_id)
);

CREATE TABLE IF NOT EXISTS build_state (
  tile_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  FOREIGN KEY (tile_id) REFERENCES tiles(tile_id)
);

-- Optional: hour-specific riding-temperature distributions.
-- Stores stats for selected hours (typically 10/12/14/16 local time).
CREATE TABLE IF NOT EXISTS riding_hourly (
  tile_id TEXT NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  temp_median REAL,
  temp_p25 REAL,
  temp_p75 REAL,
  samples INTEGER,
  PRIMARY KEY (tile_id, month, day, hour),
  FOREIGN KEY (tile_id) REFERENCES tiles(tile_id)
);

CREATE INDEX IF NOT EXISTS idx_climatology_mmdd ON climatology(month, day);
CREATE INDEX IF NOT EXISTS idx_riding_hourly_mmdd ON riding_hourly(month, day);
