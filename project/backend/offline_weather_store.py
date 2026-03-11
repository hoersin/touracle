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
    years: Optional[Tuple[int, int]] = None  # (start_year, end_year)


def _parse_bbox(raw: str) -> Tuple[float, float, float, float]:
    j = json.loads(raw)
    return (float(j["lat_min"]), float(j["lat_max"]), float(j["lon_min"]), float(j["lon_max"]))


class OfflineWeatherStore:
    def __init__(self, cfg: OfflineTileConfig):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.cfg.db_path), check_same_thread=False)
        try:
            cols = {str(r[1]) for r in self._conn.execute("PRAGMA table_info(climatology)").fetchall()}
        except Exception:
            cols = set()
        self._has_rain_hist_percentiles = (
            "rain_hist_p25_mm" in cols and "rain_hist_p75_mm" in cols and "rain_hist_p90_mm" in cols
        )

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
        p_env = os.environ.get("OFFLINE_WEATHER_DB")

        # Explicit override: respect exactly.
        if p_env:
            try:
                path = Path(p_env)
                if path.exists():
                    cfg = OfflineWeatherStore._load_config(path)
                    if cfg is not None:
                        return OfflineWeatherStore(cfg)
            except Exception:
                return None

        # Auto-detect: prefer the DB with the most complete tile coverage.
        # Some DBs can be multi-year but very sparse (few tiles) and thus unusable
        # for most routes. Tie-break using the widest historical year span.
        # Resolve cache dir relative to this source file so packaged builds
        # and "run from anywhere" invocations still find the offline DB.
        cache_dir = Path(__file__).resolve().parents[1] / "cache"
        candidates: List[Path] = []
        try:
            year_dbs: List[Tuple[int, Path]] = []
            for p in cache_dir.glob("offline_weather_*.sqlite"):
                try:
                    suffix = p.stem.split("offline_weather_", 1)[1]
                    year = int(suffix)
                    year_dbs.append((year, p))
                except Exception:
                    continue
            for _, p in sorted(year_dbs, key=lambda t: t[0], reverse=True):
                candidates.append(p)
        except Exception:
            pass
        candidates.append(cache_dir / "offline_weather.sqlite")

        best: Tuple[int, int, int, float, OfflineTileConfig] | None = None
        for path in candidates:
            try:
                if not path.exists():
                    continue
                cfg = OfflineWeatherStore._load_config(path)
                if cfg is None:
                    continue
                tile_count = 0
                try:
                    conn = sqlite3.connect(str(path))
                    try:
                        tile_count = int(conn.execute("SELECT COUNT(*) FROM tiles").fetchone()[0])
                    finally:
                        conn.close()
                except Exception:
                    tile_count = 0
                span_years = 0
                end_year = 0
                if cfg.years is not None:
                    ys, ye = cfg.years
                    span_years = max(0, int(ye) - int(ys) + 1)
                    end_year = int(ye)
                mtime = float(path.stat().st_mtime)
                score = (tile_count, span_years, end_year, mtime)
                if best is None or score > best[:4]:
                    best = (tile_count, span_years, end_year, mtime, cfg)
            except Exception:
                continue

        if best is None:
            return None
        return OfflineWeatherStore(best[4])

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

        years: Optional[Tuple[int, int]] = None
        try:
            raw = meta.get("years")
            if raw:
                yj = json.loads(str(raw))
                ys = int(yj.get("start"))
                ye = int(yj.get("end"))
                years = (ys, ye)
        except Exception:
            years = None

        return OfflineTileConfig(db_path=db_path, tile_km=tile_km, bbox=bbox, years=years)

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

    def get_climatology_grid(
        self,
        lat_min: float,
        lat_max: float,
        lon_min: float,
        lon_max: float,
        month: int,
        day: int,
    ) -> List[Dict[str, Any]]:
        """Return (tile center + climatology stats) for a given calendar day.

        This is intended for the Strategic/Climatic map: fetch all tile nodes
        in the current viewport and let the frontend do interpolation + rendering.
        """
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT
                    t.tile_id, t.lat, t.lon, t.row, t.col,
                    c.temperature_c,
                    c.precipitation_mm,
                    c.rain_probability,
                    c.rain_typical_mm,
                    c.wind_speed_ms,
                    c.wind_dir_deg,
                    c.wind_var_deg,
                    c.temp_day_median,
                    c.temp_day_p25,
                    c.temp_day_p75
                FROM tiles t
                LEFT JOIN climatology c
                  ON c.tile_id = t.tile_id AND c.month = ? AND c.day = ?
                WHERE t.lat BETWEEN ? AND ? AND t.lon BETWEEN ? AND ?
                ORDER BY t.row, t.col
                """,
                (int(month), int(day), float(lat_min), float(lat_max), float(lon_min), float(lon_max)),
            ).fetchall()

        def _avg2(a: Optional[float], b: Optional[float]) -> Optional[float]:
            if a is None:
                return b
            if b is None:
                return a
            try:
                return (float(a) + float(b)) / 2.0
            except Exception:
                return a

        def _avg_dir_deg(a: Optional[float], b: Optional[float]) -> Optional[float]:
            """Average directions on a circle.

            If only one is present, return it.
            """

            if a is None:
                return b
            if b is None:
                return a
            try:
                a_rad = math.radians(float(a))
                b_rad = math.radians(float(b))
                x = math.cos(a_rad) + math.cos(b_rad)
                y = math.sin(a_rad) + math.sin(b_rad)
                if abs(x) < 1e-12 and abs(y) < 1e-12:
                    return float(a)
                deg = math.degrees(math.atan2(y, x))
                if deg < 0:
                    deg += 360.0
                return deg
            except Exception:
                return a

        out: List[Dict[str, Any]] = []
        for r in rows or []:
            try:
                (
                    tile_id,
                    lat,
                    lon,
                    row,
                    col,
                    temperature_c,
                    precipitation_mm,
                    rain_probability,
                    rain_typical_mm,
                    wind_speed_ms,
                    wind_dir_deg,
                    wind_var_deg,
                    temp_day_median,
                    temp_day_p25,
                    temp_day_p75,
                ) = r
                out.append(
                    {
                        "tile_id": str(tile_id),
                        "lat": float(lat),
                        "lon": float(lon),
                        "row": int(row),
                        "col": int(col),
                        "temperature_c": temperature_c,
                        "precipitation_mm": precipitation_mm,
                        "rain_probability": rain_probability,
                        "rain_typical_mm": rain_typical_mm,
                        "wind_speed_ms": wind_speed_ms,
                        "wind_dir_deg": wind_dir_deg,
                        "wind_var_deg": wind_var_deg,
                        "temp_day_median": temp_day_median,
                        "temp_day_p25": temp_day_p25,
                        "temp_day_p75": temp_day_p75,
                    }
                )
            except Exception:
                continue

        # Gap-fill: if a tile has no climatology row at all (all stats are NULL),
        # copy/average from immediate neighbor rows (same col). This prevents
        # visible blank stripes when a few tiles failed during offline DB build.
        by_rc: Dict[Tuple[int, int], Dict[str, Any]] = {(d["row"], d["col"]): d for d in out}
        value_keys = (
            "temperature_c",
            "precipitation_mm",
            "rain_probability",
            "rain_typical_mm",
            "wind_speed_ms",
            "wind_dir_deg",
            "wind_var_deg",
            "temp_day_median",
            "temp_day_p25",
            "temp_day_p75",
        )

        def _has_any_values(d: Dict[str, Any]) -> bool:
            return any(d.get(k) is not None for k in value_keys)

        for (row, col), d in list(by_rc.items()):
            if _has_any_values(d):
                continue
            north = by_rc.get((row - 1, col))
            south = by_rc.get((row + 1, col))
            if north is None and south is None:
                continue
            if north is not None and not _has_any_values(north):
                north = None
            if south is not None and not _has_any_values(south):
                south = None
            if north is None and south is None:
                continue

            d["temperature_c"] = _avg2((north or {}).get("temperature_c"), (south or {}).get("temperature_c"))
            d["precipitation_mm"] = _avg2((north or {}).get("precipitation_mm"), (south or {}).get("precipitation_mm"))
            d["rain_probability"] = _avg2((north or {}).get("rain_probability"), (south or {}).get("rain_probability"))
            d["rain_typical_mm"] = _avg2((north or {}).get("rain_typical_mm"), (south or {}).get("rain_typical_mm"))
            d["wind_speed_ms"] = _avg2((north or {}).get("wind_speed_ms"), (south or {}).get("wind_speed_ms"))
            d["wind_var_deg"] = _avg2((north or {}).get("wind_var_deg"), (south or {}).get("wind_var_deg"))
            d["wind_dir_deg"] = _avg_dir_deg((north or {}).get("wind_dir_deg"), (south or {}).get("wind_dir_deg"))
            d["temp_day_median"] = _avg2((north or {}).get("temp_day_median"), (south or {}).get("temp_day_median"))
            d["temp_day_p25"] = _avg2((north or {}).get("temp_day_p25"), (south or {}).get("temp_day_p25"))
            d["temp_day_p75"] = _avg2((north or {}).get("temp_day_p75"), (south or {}).get("temp_day_p75"))

        return out

    def get_stats_for_tile(self, tile_id: str, month: int, day: int) -> Optional[Dict[str, Any]]:
        """Return stats for an exact (tile_id, month, day)."""

        with self._lock:
            if self._has_rain_hist_percentiles:
                row = self._conn.execute(
                    """
                    SELECT
                        temperature_c, temp_p25, temp_p75, temp_std,
                        precipitation_mm, rain_probability, rain_typical_mm,
                        rain_hist_p25_mm, rain_hist_p75_mm, rain_hist_p90_mm,
                        wind_speed_ms, wind_dir_deg, wind_var_deg,
                        temp_hist_p25, temp_hist_p75, temp_day_p25, temp_day_p75, temp_day_median,
                        samples_daily, samples_rain, samples_wind, samples_day_means, samples_day_hours
                    FROM climatology
                    WHERE tile_id=? AND month=? AND day=?
                    """,
                    (str(tile_id), int(month), int(day)),
                ).fetchone()
            else:
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

        if self._has_rain_hist_percentiles:
            (
                temperature_c,
                temp_p25,
                temp_p75,
                temp_std,
                precipitation_mm,
                rain_probability,
                rain_typical_mm,
                rain_hist_p25_mm,
                rain_hist_p75_mm,
                rain_hist_p90_mm,
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
        else:
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
            rain_hist_p25_mm = None
            rain_hist_p75_mm = None
            rain_hist_p90_mm = None

        stats: Dict[str, Any] = {
            "temperature_c": temperature_c,
            "temp_p25": temp_p25,
            "temp_p75": temp_p75,
            "temp_std": temp_std,
            "precipitation_mm": precipitation_mm,
            "rain_probability": rain_probability,
            "rain_typical_mm": rain_typical_mm,
            "rain_hist_p25_mm": rain_hist_p25_mm,
            "rain_hist_p75_mm": rain_hist_p75_mm,
            "rain_hist_p90_mm": rain_hist_p90_mm,
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
