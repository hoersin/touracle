"""Offline Open‑Meteo tile store reader.

Reads `project/cache/offline_weather.sqlite` built by
`project/offline/build_offline_tiles_openmeteo.py`.

Design:
- Open‑Meteo only: validates `meta.provider == open-meteo` and `meta.provider_only == true`.
- Provides derived stats per (tile, month, day).
- Optional riding-hour stats per (tile, month, day, hour).

This module intentionally does not fall back to any other provider.
"""

from __future__ import annotations

import json
import math
import os
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


@dataclass(frozen=True)
class OfflineTileConfig:
    db_path: Path
    tile_km: float
    bbox: Tuple[float, float, float, float]  # (lat_min, lat_max, lon_min, lon_max)


def _parse_bbox(raw: str) -> Tuple[float, float, float, float]:
    j = json.loads(raw)
    return (float(j["lat_min"]), float(j["lat_max"]), float(j["lon_min"]), float(j["lon_max"]))


class OfflineWeatherStore:
    def __init__(self, cfg: OfflineTileConfig):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.cfg.db_path), check_same_thread=False)

    def close(self) -> None:
        try:
            with self._lock:
                self._conn.close()
        except Exception:
            pass

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    @staticmethod
    def default_from_env() -> Optional["OfflineWeatherStore"]:
        # Default path
        p = os.environ.get("OFFLINE_WEATHER_DB", "project/cache/offline_weather.sqlite")
        path = Path(p)
        if not path.exists():
            return None
        cfg = OfflineWeatherStore._load_config(path)
        if cfg is None:
            return None
        return OfflineWeatherStore(cfg)

    @staticmethod
    def _load_config(db_path: Path) -> Optional[OfflineTileConfig]:
        conn = sqlite3.connect(str(db_path))
        try:
            meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
        except Exception:
            return None
        finally:
            conn.close()

        if meta.get("provider") != "open-meteo":
            return None
        if str(meta.get("provider_only", "")).lower() != "true":
            return None

        try:
            tile_km = float(meta.get("tile_km", "50"))
            bbox = _parse_bbox(meta["bbox"])
        except Exception:
            return None

        return OfflineTileConfig(db_path=db_path, tile_km=tile_km, bbox=bbox)

    def _tile_id_for_point(self, lat: float, lon: float) -> Optional[str]:
        lat_min, lat_max, lon_min, lon_max = self.cfg.bbox
        if not (lat_min <= lat <= lat_max and lon_min <= lon <= lon_max):
            return None

        step_lat = self.cfg.tile_km / 111.32
        row = int(math.floor((lat - lat_min) / step_lat))
        if row < 0:
            return None

        lat_c = lat_min + (row + 0.5) * step_lat
        if lat_c > lat_max + 1e-9:
            return None

        c = max(0.05, math.cos(math.radians(lat_c)))
        step_lon = self.cfg.tile_km / (111.32 * c)
        col = int(math.floor((lon - lon_min) / step_lon))
        if col < 0:
            return None

        lon_c = lon_min + (col + 0.5) * step_lon
        if lon_c > lon_max + 1e-9:
            return None

        return f"r{row}_c{col}"

    def get_stats(self, lat: float, lon: float, month: int, day: int) -> Optional[Dict[str, Any]]:
        tile_id = self._tile_id_for_point(float(lat), float(lon))
        if tile_id is None:
            return None

        return self.get_stats_for_tile(tile_id, int(month), int(day))

    def list_tiles_in_bbox(self, lat_min: float, lat_max: float, lon_min: float, lon_max: float) -> List[Dict[str, Any]]:
        """Return tile centers within bbox.

        Intended for Strategic mode (no route): frontend requests current map bounds
        and receives tile points to render.
        """
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT tile_id, lat, lon, row, col
                FROM tiles
                WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
                ORDER BY row, col
                """,
                (float(lat_min), float(lat_max), float(lon_min), float(lon_max)),
            ).fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows or []:
            try:
                tile_id, lat, lon, row, col = r
                out.append(
                    {
                        "tile_id": str(tile_id),
                        "lat": float(lat),
                        "lon": float(lon),
                        "row": int(row),
                        "col": int(col),
                    }
                )
            except Exception:
                continue
        return out

    def get_stats_for_tile(self, tile_id: str, month: int, day: int) -> Optional[Dict[str, Any]]:
        """Return stats for an exact (tile_id, month, day)."""

        with self._lock:
            row = self._conn.execute(
                """
                SELECT
                    temperature_c, temp_p25, temp_p75, temp_std,
                    precipitation_mm, rain_probability, rain_typical_mm,
                    wind_speed_ms, wind_dir_deg, wind_var_deg,
                    temp_hist_p25, temp_hist_p75, temp_day_p25, temp_day_p75, temp_day_median,
                    samples_daily, samples_rain, samples_wind, samples_day_means, samples_day_hours
                FROM climatology
                WHERE tile_id=? AND month=? AND day=?
                """,
                (str(tile_id), int(month), int(day)),
            ).fetchone()

        if not row:
            return None

        (
            temperature_c,
            temp_p25,
            temp_p75,
            temp_std,
            precipitation_mm,
            rain_probability,
            rain_typical_mm,
            wind_speed_ms,
            wind_dir_deg,
            wind_var_deg,
            temp_hist_p25,
            temp_hist_p75,
            temp_day_p25,
            temp_day_p75,
            temp_day_median,
            samples_daily,
            samples_rain,
            samples_wind,
            samples_day_means,
            samples_day_hours,
        ) = row

        stats: Dict[str, Any] = {
            "temperature_c": temperature_c,
            "temp_p25": temp_p25,
            "temp_p75": temp_p75,
            "temp_std": temp_std,
            "precipitation_mm": precipitation_mm,
            "rain_probability": rain_probability,
            "rain_typical_mm": rain_typical_mm,
            "wind_speed_ms": wind_speed_ms,
            "wind_dir_deg": wind_dir_deg,
            "wind_var_deg": wind_var_deg,
            "temp_hist_p25": temp_hist_p25,
            "temp_hist_p75": temp_hist_p75,
            "temp_day_p25": temp_day_p25,
            "temp_day_p75": temp_day_p75,
            "temp_day_median": temp_day_median,
            "_offline": True,
            "_provider": "open-meteo",
            "_tile_id": str(tile_id),
            "_match_days": int(samples_daily or 0),
            "_temp_source": "offline_tile",
            "_samples_daily": int(samples_daily or 0),
            "_samples_day_means": int(samples_day_means or 0),
            "_samples_day_hours": int(samples_day_hours or 0),
            "_samples_rain": int(samples_rain or 0),
            "_samples_wind": int(samples_wind or 0),
        }
        return stats

    def get_riding_hour_stats(self, lat: float, lon: float, month: int, day: int, hour: int) -> Optional[Dict[str, Any]]:
        tile_id = self._tile_id_for_point(float(lat), float(lon))
        if tile_id is None:
            return None

        with self._lock:
            row = self._conn.execute(
                """
                SELECT temp_median, temp_p25, temp_p75, samples
                FROM riding_hourly
                WHERE tile_id=? AND month=? AND day=? AND hour=?
                """,
                (tile_id, int(month), int(day), int(hour)),
            ).fetchone()
        if not row:
            return None
        temp_median, temp_p25, temp_p75, samples = row
        return {
            "temp_median": temp_median,
            "temp_p25": temp_p25,
            "temp_p75": temp_p75,
            "samples": int(samples or 0),
            "_offline": True,
            "_provider": "open-meteo",
            "_tile_id": tile_id,
        }
