"""Column arrays of the offline climatology for fast Explore period aggregation.

Why: an Explore period request (Year / Quarter / Month over a large view) used to
read every selected day of every selected year from SQLite and aggregate it row by
row in Python - up to 6 million rows and ~90 s for four reference years. The data
of one yearly database fits into a handful of day x tile arrays, so a period is a
slice and the aggregation is vectorised.

What: per offline database, one float64 array per climatology column, shape
(366 days in leap-year calendar order, tiles ordered by row, col). SQL NULL is NaN
(the databases hold no other non-finite values; NaN and NULL are both "missing" for
every aggregate). The arrays are derived data only: they are written once to
``<cache>/derived/<database name>/<size>-<mtime>/`` next to the databases and read
memory-mapped; the databases themselves are never modified. A changed database
gets a new key and is rebuilt; until its arrays exist, callers use the SQL path.

Aggregation semantics are those of climate_aggregation.aggregate_climate (one
database) and climate_aggregation._aggregate_multi_for_mmdd (several databases),
including the wind roses of wind_modes.py; tests compare both paths.
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import math
import os
import shutil
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

try:
    import wind_modes as _wm
except ImportError:  # pragma: no cover - package-relative import
    from . import wind_modes as _wm  # type: ignore

log = logging.getLogger(__name__)

FORMAT_VERSION = 1
DAYS = 366
FIELDS = (
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
    "temp_24h_c",        # optional column; all NaN when a database lacks it
)

_DOY_INDEX: Dict[Tuple[int, int], int] = {}
for _d in range(DAYS):
    _x = _dt.date(2024, 1, 1) + _dt.timedelta(days=_d)
    _DOY_INDEX[(_x.month, _x.day)] = _d


def day_indices(mmdd: Optional[Iterable[Tuple[int, int]]]) -> np.ndarray:
    """Array day indices for a month/day list; None = every day (no filter)."""
    if mmdd is None:
        return np.arange(DAYS)
    return np.array(sorted({_DOY_INDEX[(int(m), int(d))] for (m, d) in mmdd if (int(m), int(d)) in _DOY_INDEX}),
                    dtype=np.int64)


class StoreArrays:
    """Memory-mapped climatology columns of one database."""

    def __init__(self, folder: Path) -> None:
        meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
        self.folder = folder
        self.tile_ids: List[str] = list(meta["tile_ids"])
        self.lat = np.load(folder / "lat.npy")
        self.lon = np.load(folder / "lon.npy")
        self.row = np.load(folder / "row.npy")
        self.col = np.load(folder / "col.npy")
        self.f: Dict[str, np.ndarray] = {k: np.load(folder / f"{k}.npy", mmap_mode="r") for k in FIELDS}

    def tiles_in_bbox(self, lat_min: float, lat_max: float, lon_min: float, lon_max: float) -> np.ndarray:
        """Indices of tiles inside the bbox (SQL BETWEEN, inclusive), in row, col order."""
        m = (self.lat >= lat_min) & (self.lat <= lat_max) & (self.lon >= lon_min) & (self.lon <= lon_max)
        return np.nonzero(m)[0]

    def take(self, field: str, days: np.ndarray, tiles: np.ndarray) -> np.ndarray:
        """(days, tiles) block; contiguous day ranges are read as one slice."""
        a = self.f[field]
        if len(days) and days[-1] - days[0] + 1 == len(days):
            block = a[int(days[0]):int(days[-1]) + 1]
        else:
            block = a[days]
        return np.asarray(block[:, tiles], dtype=np.float64)


# ------------------------------------------------------------------ registry
_LOCK = threading.Lock()
_READY: Dict[str, StoreArrays] = {}
_BUILDING: Dict[str, threading.Thread] = {}
_FAILED: Dict[str, str] = {}


def _db_path(store: Any) -> Optional[Path]:
    cfg = getattr(store, "cfg", None)
    p = getattr(cfg, "db_path", None) if cfg is not None else None
    return Path(p) if p else None


def _folder_for(db: Path) -> Path:
    st = db.stat()
    return db.parent / "derived" / db.name / f"v{FORMAT_VERSION}-{st.st_size}-{st.st_mtime_ns}"


def get(store: Any) -> Optional[StoreArrays]:
    """Arrays of a store if they are built and current, else None (never blocks)."""
    db = _db_path(store)
    if db is None or os.environ.get("WM_DISABLE_PERIOD_ARRAYS"):
        return None
    try:
        folder = _folder_for(db)
    except OSError:
        return None
    key = str(folder)
    with _LOCK:
        hit = _READY.get(key)
    if hit is not None:
        return hit
    if (folder / "meta.json").exists():
        try:
            arr = StoreArrays(folder)
        except Exception:
            log.exception("Period arrays unreadable: %s", folder)
            return None
        with _LOCK:
            _READY[key] = arr
        return arr
    return None


def ensure_async(stores: Sequence[Any]) -> None:
    """Start building missing arrays in the background (one database at a time)."""
    todo = []
    for st in stores:
        db = _db_path(st)
        if db is None or get(st) is not None:
            continue
        todo.append(db)
    if not todo:
        return
    with _LOCK:
        todo = [db for db in todo if str(db) not in _BUILDING and str(db) not in _FAILED]
        if not todo:
            return
        t = threading.Thread(target=_build_all, args=(todo,), name="period-arrays-build", daemon=True)
        for db in todo:
            _BUILDING[str(db)] = t
    t.start()


def _build_all(dbs: List[Path]) -> None:
    for db in dbs:
        try:
            build(db)
        except Exception as exc:
            log.exception("Period arrays build failed: %s", db)
            with _LOCK:
                _FAILED[str(db)] = str(exc)
        finally:
            with _LOCK:
                _BUILDING.pop(str(db), None)


def build(db: Path) -> Path:
    """Write the arrays of one database (atomic: temp folder, then rename)."""
    folder = _folder_for(db)
    if (folder / "meta.json").exists():
        return folder
    t0 = time.perf_counter()
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, check_same_thread=False, timeout=30.0)
    try:
        conn.execute("PRAGMA query_only = ON")
        cols = {r[1] for r in conn.execute("PRAGMA table_info(climatology)")}
        tiles = conn.execute("SELECT tile_id, lat, lon, row, col FROM tiles ORDER BY row, col").fetchall()
        index = {str(t[0]): i for i, t in enumerate(tiles)}
        n = len(tiles)
        present = [k for k in FIELDS if k in cols]
        data = {k: np.full((DAYS, n), np.nan, dtype=np.float64) for k in FIELDS}
        # NULL -> +inf in SQL (fast float conversion), then -> NaN. Chunked: bounded memory.
        sel = ", ".join(f"COALESCE({k}, 9e999)" for k in present)
        cur = conn.execute(f"SELECT tile_id, month, day, {sel} FROM climatology")
        while True:
            rows = cur.fetchmany(100_000)
            if not rows:
                break
            ti = np.fromiter((index.get(str(r[0]), -1) for r in rows), dtype=np.int64, count=len(rows))
            di = np.fromiter((_DOY_INDEX.get((int(r[1]), int(r[2])), -1) for r in rows), dtype=np.int64,
                             count=len(rows))
            vals = np.array([r[3:] for r in rows], dtype=np.float64).reshape(len(rows), len(present))
            vals[~np.isfinite(vals)] = np.nan
            ok = (ti >= 0) & (di >= 0)
            for j, k in enumerate(present):
                data[k][di[ok], ti[ok]] = vals[ok, j]
    finally:
        conn.close()
    tmp = folder.parent / (folder.name + f".tmp{os.getpid()}")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    for k in FIELDS:
        np.save(tmp / f"{k}.npy", data[k])
    np.save(tmp / "lat.npy", np.array([float(t[1]) for t in tiles], dtype=np.float64))
    np.save(tmp / "lon.npy", np.array([float(t[2]) for t in tiles], dtype=np.float64))
    np.save(tmp / "row.npy", np.array([int(t[3]) for t in tiles], dtype=np.int64))
    np.save(tmp / "col.npy", np.array([int(t[4]) for t in tiles], dtype=np.int64))
    (tmp / "meta.json").write_text(json.dumps({
        "format": FORMAT_VERSION, "source": db.name, "tiles": n, "days": DAYS, "fields": list(FIELDS),
        "present": present, "tile_ids": [str(t[0]) for t in tiles],
    }), encoding="utf-8")
    try:
        tmp.rename(folder)
    except OSError:
        shutil.rmtree(tmp, ignore_errors=True)       # built concurrently by another process
    for old in folder.parent.iterdir():               # older versions of this database
        if old != folder and ".tmp" not in old.name:
            shutil.rmtree(old, ignore_errors=True)
    log.info("Period arrays built for %s in %.1f s", db.name, time.perf_counter() - t0)
    return folder


# ------------------------------------------------------------------ aggregation
def _nanmean(block: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    n = np.sum(np.isfinite(block), axis=0)
    s = np.nansum(block, axis=0)
    return s, n


def _opt(x: float) -> Optional[float]:
    return float(x) if math.isfinite(x) else None


def _circular_mean(dirs: np.ndarray) -> List[Optional[float]]:
    """Per column: circular mean of finite directions (None when undefined)."""
    fin = np.isfinite(dirs)
    r = np.radians(np.where(fin, dirs, 0.0))
    c = np.sum(np.where(fin, np.cos(r), 0.0), axis=0)
    s = np.sum(np.where(fin, np.sin(r), 0.0), axis=0)
    n = np.sum(fin, axis=0)
    out: List[Optional[float]] = []
    for ci, si, ni in zip(c.tolist(), s.tolist(), n.tolist()):
        if ni <= 0 or (abs(ci) < 1e-12 and abs(si) < 1e-12):
            out.append(None)
        else:
            deg = math.degrees(math.atan2(si, ci))
            out.append(deg + 360.0 if deg < 0 else deg)
    return out


def _rose_hist_multi(blocks: List[Tuple[np.ndarray, np.ndarray, np.ndarray]], cols: int) -> Tuple[np.ndarray, ...]:
    """Histograms over several stores: all observations in one pass, store by store."""
    ds, vs, cs = [], [], []
    for dirs, speeds, places in blocks:
        # Tile by tile (row, col order), day by day within a tile: the SQL row order.
        dt, st = dirs.T, speeds.T
        ok = np.isfinite(dt) & np.isfinite(st) & (st >= 0)
        cs.append(places[np.broadcast_to(np.arange(dt.shape[0])[:, None], dt.shape)[ok]])
        ds.append(dt[ok])
        vs.append(st[ok])
    if not ds:
        z = np.zeros((cols, _wm.SECTORS))
        return z, z.astype(np.int64), z, z, z
    return _hist_from_obs(np.concatenate(ds), np.concatenate(vs), np.concatenate(cs), cols)


def _rose_histograms(dirs: np.ndarray, speeds: np.ndarray, cols: int) -> Tuple[np.ndarray, ...]:
    """16-sector histograms per column, exactly as WindRoseAccumulator.add.

    np.bincount adds in input order - per column day by day, like the SQL path - so
    weights, counts and speeds are bit-identical (matters for near-ties between
    direction windows).
    """
    ok = np.isfinite(dirs) & np.isfinite(speeds) & (speeds >= 0)
    col_idx = np.broadcast_to(np.arange(dirs.shape[1]), dirs.shape)[ok]
    return _hist_from_obs(dirs[ok], speeds[ok], col_idx, cols)


def _hist_from_obs(d: np.ndarray, v: np.ndarray, col_idx: np.ndarray, cols: int) -> Tuple[np.ndarray, ...]:
    k = (np.floor_divide(np.mod(d, 360.0) + _wm.SECTOR_DEG / 2.0, _wm.SECTOR_DEG).astype(np.int64)) % _wm.SECTORS
    wt = np.minimum(v, _wm.SPEED_WEIGHT_CAP_MS)
    flat = col_idx * _wm.SECTORS + k
    size = cols * _wm.SECTORS
    rad = np.radians(d)
    shape = (cols, _wm.SECTORS)
    w = np.bincount(flat, weights=wt, minlength=size).reshape(shape)
    n = np.bincount(flat, minlength=size).reshape(shape)
    vs = np.bincount(flat, weights=v, minlength=size).reshape(shape)
    xs = np.bincount(flat, weights=wt * np.cos(rad), minlength=size).reshape(shape)
    ys = np.bincount(flat, weights=wt * np.sin(rad), minlength=size).reshape(shape)
    return w, n, vs, xs, ys


def _modes(hist: Tuple[np.ndarray, ...], j: int) -> List[Dict[str, float]]:
    w, n, vs, xs, ys = hist
    if not n[j].any():
        return []
    return _wm.classify(w[j].tolist(), [int(x) for x in n[j]], vs[j].tolist(), xs[j].tolist(), ys[j].tolist())


def aggregate_single(arr: StoreArrays, mmdd: Optional[List[Tuple[int, int]]], lat_min: float, lat_max: float,
                     lon_min: float, lon_max: float) -> List[Dict[str, Any]]:
    """Same output as climate_aggregation.aggregate_climate (no Lucky counts)."""
    tiles = arr.tiles_in_bbox(lat_min, lat_max, lon_min, lon_max)
    days = day_indices(mmdd)
    means = {}
    for k in ("temperature_c", "precipitation_mm", "rain_probability", "rain_typical_mm", "wind_speed_ms",
              "wind_var_deg", "temp_day_median", "temp_day_p25", "temp_day_p75"):
        s, n = _nanmean(arr.take(k, days, tiles))
        means[k] = [(si / ni) if ni > 0 else None for si, ni in zip(s.tolist(), n.tolist())]
    dirs = arr.take("wind_dir_deg", days, tiles)
    speeds = arr.take("wind_speed_ms", days, tiles)
    wdir = _circular_mean(dirs)
    hist = _rose_histograms(dirs, speeds, len(tiles))
    out = []
    for j, t in enumerate(tiles.tolist()):
        d: Dict[str, Any] = {"tile_id": arr.tile_ids[t], "lat": float(arr.lat[t]), "lon": float(arr.lon[t]),
                             "row": int(arr.row[t]), "col": int(arr.col[t])}
        for k, vals in means.items():
            d[k] = vals[j]
        d["wind_dir_deg"] = wdir[j]
        d["wind_modes"] = _modes(hist, j)
        out.append(d)
    return out


def aggregate_multi(arrs: List[StoreArrays], place_of: Dict[Tuple[int, str], str],
                    mmdd: List[Tuple[int, int]], lat_min: float, lat_max: float, lon_min: float, lon_max: float,
                    rain_prob_threshold_mm: float = 0.5) -> List[Dict[str, Any]]:
    """Same output as climate_aggregation._aggregate_multi_for_mmdd (no Lucky counts)."""
    days = day_indices(mmdd)
    order: List[str] = []
    pidx: Dict[str, int] = {}
    base: List[Dict[str, Any]] = []
    per_store = []                      # (arr, tile indices, place index per tile)
    for s, arr in enumerate(arrs):
        tiles = arr.tiles_in_bbox(lat_min, lat_max, lon_min, lon_max)
        places = np.empty(len(tiles), dtype=np.int64)
        for j, t in enumerate(tiles.tolist()):
            tid = arr.tile_ids[t]
            key = place_of.get((s, tid), tid)
            p = pidx.get(key)
            if p is None:
                p = pidx[key] = len(order)
                order.append(key)
                base.append({"tile_id": tid, "lat": float(arr.lat[t]), "lon": float(arr.lon[t]),
                             "row": int(arr.row[t]), "col": int(arr.col[t])})
            places[j] = p
        per_store.append((arr, tiles, places))
    P = len(order)
    D = len(days)

    # Sample matrices for medians: one block of D columns per (store, tile) occurrence of a place.
    occ = np.zeros(P, dtype=np.int64)
    slots = []
    for arr, tiles, places in per_store:
        b = np.empty(len(places), dtype=np.int64)
        for j, p in enumerate(places.tolist()):
            b[j] = occ[p]
            occ[p] += 1
        slots.append(b)
    B = int(occ.max()) if P else 0

    def samples(primary: str, fallback: str) -> np.ndarray:
        m = np.full((P, max(1, B) * D), np.nan)
        for (arr, tiles, places), b in zip(per_store, slots):
            if not len(tiles):
                continue
            x = arr.take(primary, days, tiles)
            y = arr.take(fallback, days, tiles)
            x = np.where(np.isnan(x), y, x)          # primary unless NULL
            for j in range(len(tiles)):
                m[places[j], b[j] * D:(b[j] + 1) * D] = x[:, j]
        return m

    def median_rows(m: np.ndarray) -> List[Optional[float]]:
        fin = np.isfinite(m).any(axis=1)
        out = np.full(P, np.nan)
        if fin.any():
            out[fin] = np.nanmedian(m[fin], axis=1)
        return [_opt(x) for x in out.tolist()]

    t_full = median_rows(samples("temp_24h_c", "temperature_c"))
    t_active = median_rows(samples("temp_day_median", "temperature_c"))

    sums: Dict[str, np.ndarray] = {}
    cnts: Dict[str, np.ndarray] = {}
    mean_keys = ("precipitation_mm", "rain_typical_mm", "wind_speed_ms", "wind_var_deg", "temp_day_p25", "temp_day_p75")
    for k in mean_keys:
        sums[k] = np.zeros(P)
        cnts[k] = np.zeros(P, dtype=np.int64)
    rain_n = np.zeros(P, dtype=np.int64)
    rain_k = np.zeros(P, dtype=np.int64)
    dir_c = np.zeros(P)
    dir_s = np.zeros(P)
    dir_n = np.zeros(P, dtype=np.int64)
    rose_blocks = []
    for arr, tiles, places in per_store:
        if not len(tiles):
            continue
        for k in mean_keys:
            s, n = _nanmean(arr.take(k, days, tiles))
            np.add.at(sums[k], places, s)
            np.add.at(cnts[k], places, n)
        pr = arr.take("precipitation_mm", days, tiles)
        np.add.at(rain_n, places, np.sum(np.isfinite(pr), axis=0))
        np.add.at(rain_k, places, np.sum(np.isfinite(pr) & (pr > float(rain_prob_threshold_mm)), axis=0))
        dirs = arr.take("wind_dir_deg", days, tiles)
        speeds = arr.take("wind_speed_ms", days, tiles)
        fin = np.isfinite(dirs)
        r = np.radians(np.where(fin, dirs, 0.0))
        np.add.at(dir_c, places, np.sum(np.where(fin, np.cos(r), 0.0), axis=0))
        np.add.at(dir_s, places, np.sum(np.where(fin, np.sin(r), 0.0), axis=0))
        np.add.at(dir_n, places, np.sum(fin, axis=0))
        rose_blocks.append((dirs, speeds, places))
    hist = _rose_hist_multi(rose_blocks, P)

    name_count: Dict[str, int] = {}
    for b0 in base:
        name_count[b0["tile_id"]] = name_count.get(b0["tile_id"], 0) + 1
    out: List[Dict[str, Any]] = []
    for p, key in enumerate(order):
        d = dict(base[p])
        if name_count.get(d["tile_id"], 0) > 1:
            d["tile_id"] = key
        d["temperature_c"] = t_full[p]
        d["temp_day_median"] = t_active[p]
        for k in mean_keys:
            d[k] = (float(sums[k][p]) / float(cnts[k][p])) if cnts[k][p] > 0 else None
        d["rain_probability"] = (float(rain_k[p]) / float(rain_n[p])) if rain_n[p] > 0 else None
        c0, s0, n0 = float(dir_c[p]), float(dir_s[p]), int(dir_n[p])
        if n0 <= 0 or (abs(c0) < 1e-12 and abs(s0) < 1e-12):
            d["wind_dir_deg"] = None
        else:
            deg = math.degrees(math.atan2(s0, c0))
            d["wind_dir_deg"] = deg + 360.0 if deg < 0 else deg
        d["wind_modes"] = _modes(hist, p)
        out.append(d)
    return out
