#!/usr/bin/env python3
"""Resumable background download of a region into the existing yearly databases.

Example (Africa, 2023-2025, conservative budget):
  ./.venv/bin/python project/offline/region_job.py --region africa --years 2023,2024,2025

Design:
- Tiles come from the region's fixed tile list (regions.py), on the existing 50 km
  grid (negative rows south of 34 N). Ids never collide with the European tiles.
- Per tile, one daily and one hourly request cover all missing years; each year is
  computed exactly like a single-year build (build_offline_tiles_openmeteo).
- Every request goes through the central scheduler (openmeteo_scheduler): one global
  budget across processes, 429 cooldowns, jittered backoff.
- The yearly databases only ever receive complete tiles: tile row, 366 climatology
  rows, riding-hour rows and build_state "done" in one transaction per batch. A
  yearly database therefore stays "complete" for the app's reference-year audit at
  every moment, and existing rows are never updated or deleted.
- Progress, attempts and errors live in a separate job-state database
  (project/cache/offline_jobs/<job>.sqlite) plus a status JSON next to it. On start
  the job reconciles with the yearly databases, so an interrupted run resumes
  without downloading any completed tile/year again.
- Before the first write, each yearly database is copied (SQLite backup API) to
  project/cache/backups/.
- WAL auto-checkpoints are disabled for the job's connections; it checkpoints every
  --checkpoint-hours and on exit, so the app's derived caches (keyed on the database
  file) are not invalidated every few minutes.
- SIGTERM/SIGINT or the file <state>.stop end the job after the current tile and a
  final flush.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import fcntl
import json
import math
import os
import signal
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

OFFLINE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = OFFLINE_DIR.parent
CACHE_DIR = PROJECT_DIR / "cache"
if str(OFFLINE_DIR) not in sys.path:
    sys.path.insert(0, str(OFFLINE_DIR))

import build_offline_tiles_openmeteo as B  # noqa: E402
import openmeteo_scheduler as S  # noqa: E402
import regions as R  # noqa: E402

STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS job_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tile_years (
  tile_id TEXT NOT NULL, year INTEGER NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (tile_id, year));
CREATE TABLE IF NOT EXISTS events (ts TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
"""


def utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def job_name(region: str, years: List[int]) -> str:
    return f"{region}-{min(years)}-{max(years)}"


def default_state_path(region: str, years: List[int]) -> Path:
    return CACHE_DIR / "offline_jobs" / f"{job_name(region, years)}.sqlite"


# ---------------------------------------------------------------- job state
class JobState:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path), timeout=60.0)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(STATE_SCHEMA)
        self.conn.commit()

    def set_meta(self, key: str, value: Any) -> None:
        self.conn.execute("INSERT INTO job_meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                          (key, value if isinstance(value, str) else json.dumps(value)))

    def get_meta(self, key: str) -> Optional[str]:
        row = self.conn.execute("SELECT value FROM job_meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def event(self, level: str, message: str) -> None:
        self.conn.execute("INSERT INTO events(ts, level, message) VALUES(?,?,?)", (utc_now_iso(), level, message[:2000]))
        self.conn.execute("DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY rowid DESC LIMIT -1 OFFSET 5000)")

    def mark(self, tile_id: str, year: int, status: str, error: Optional[str] = None, attempt: bool = False) -> None:
        self.conn.execute(
            "INSERT INTO tile_years(tile_id, year, status, attempts, error, updated_at) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(tile_id, year) DO UPDATE SET status=excluded.status, error=excluded.error, "
            "updated_at=excluded.updated_at, attempts=tile_years.attempts + excluded.attempts",
            (tile_id, int(year), status, 1 if attempt else 0, error, utc_now_iso()))

    def done_set(self) -> set:
        return {(r[0], int(r[1])) for r in self.conn.execute("SELECT tile_id, year FROM tile_years WHERE status='done'")}

    def error_set(self) -> set:
        return {(r[0], int(r[1])) for r in self.conn.execute("SELECT tile_id, year FROM tile_years WHERE status='error'")}

    def commit(self) -> None:
        self.conn.commit()


# ---------------------------------------------------------------- yearly databases
class YearDb:
    """Append-only writer for one existing yearly database."""

    def __init__(self, year: int, path: Path) -> None:
        self.year = int(year)
        self.path = Path(path)
        if not self.path.exists():
            raise SystemExit(f"yearly database missing: {self.path}")
        self.conn = sqlite3.connect(str(self.path), timeout=120.0, isolation_level=None)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=120000")
        # No automatic checkpoints from this connection: see module docstring.
        self.conn.execute("PRAGMA wal_autocheckpoint=0")
        self.meta = dict(self.conn.execute("SELECT key, value FROM meta").fetchall())

    def validate_grid(self) -> None:
        """The region continues this database's grid: same tile size, origin and year."""
        tile_km = float(self.meta.get("tile_km", "nan"))
        bbox = json.loads(self.meta["bbox"])
        origin = json.loads(self.meta["grid_origin"]) if self.meta.get("grid_origin") else {"lat": bbox["lat_min"], "lon": bbox["lon_min"]}
        years = json.loads(self.meta.get("years") or "{}")
        problems = []
        if abs(tile_km - R.TILE_KM) > 1e-9:
            problems.append(f"tile_km {tile_km} != {R.TILE_KM}")
        if abs(float(origin["lat"]) - R.GRID_ORIGIN_LAT) > 1e-9 or abs(float(origin["lon"]) - R.GRID_ORIGIN_LON) > 1e-9:
            problems.append(f"grid origin {origin} != ({R.GRID_ORIGIN_LAT}, {R.GRID_ORIGIN_LON})")
        if int(years.get("start", -1)) != self.year or int(years.get("end", -1)) != self.year:
            problems.append(f"years {years} != {self.year}")
        if problems:
            raise SystemExit(f"{self.path.name}: incompatible grid: " + "; ".join(problems))

    def existing_region_tiles(self, region_ids: set) -> Dict[str, Tuple[float, float, Optional[str], int]]:
        """Region tile ids present in this database: (lat, lon, build status, usable rows)."""
        out = {}
        rows = self.conn.execute(
            "SELECT t.tile_id, t.lat, t.lon, b.status, (SELECT COUNT(*) FROM climatology c WHERE c.tile_id=t.tile_id) "
            "FROM tiles t LEFT JOIN build_state b USING(tile_id) WHERE t.row < 0").fetchall()
        for tid, lat, lon, st, n in rows:
            if tid in region_ids:
                out[str(tid)] = (float(lat), float(lon), st, int(n))
        return out

    def ensure_region_meta(self, region_box: Dict[str, float]) -> bool:
        """Record grid origin and coverage (only additions; other meta keys untouched)."""
        bbox = json.loads(self.meta["bbox"])
        changed = False
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            if not self.meta.get("grid_origin"):
                v = json.dumps({"lat": float(bbox["lat_min"]), "lon": float(bbox["lon_min"])})
                self.conn.execute("INSERT INTO meta(key, value) VALUES('grid_origin', ?)", (v,))
                self.meta["grid_origin"] = v
                changed = True
            cov = json.loads(self.meta["coverage_bboxes"]) if self.meta.get("coverage_bboxes") else [bbox]
            box = {k: float(region_box[k]) for k in ("lat_min", "lat_max", "lon_min", "lon_max")}
            if not any(all(abs(float(c[k]) - box[k]) < 1e-9 for k in box) for c in cov):
                cov.append(box)
                v = json.dumps(cov)
                self.conn.execute("INSERT INTO meta(key, value) VALUES('coverage_bboxes', ?) "
                                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (v,))
                self.meta["coverage_bboxes"] = v
                changed = True
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        return changed

    def write_batch(self, items: List[Tuple["R.RegionTile", List[dict], List[dict]]]) -> float:
        """Append complete tiles in one transaction. Returns seconds spent."""
        t0 = time.perf_counter()
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            for t, clim, riding in items:
                cur = self.conn.execute("SELECT lat, lon FROM tiles WHERE tile_id=?", (t.tile_id,)).fetchone()
                if cur is not None and (abs(cur[0] - t.lat) > 1e-6 or abs(cur[1] - t.lon) > 1e-6):
                    raise RuntimeError(f"{self.path.name}: tile {t.tile_id} exists at another place {cur}")
                if cur is None:
                    self.conn.execute("INSERT INTO tiles(tile_id, lat, lon, row, col) VALUES(?,?,?,?,?)",
                                      (t.tile_id, B.clamp_lat(t.lat), float(t.lon), int(t.row), int(t.col)))
                # Region tiles only (row < 0): replacing a half-written region tile, never European data.
                B.replace_climatology_rows(self.conn, t.tile_id, clim)
                B.replace_riding_hourly_rows(self.conn, t.tile_id, riding)
                B.tile_mark_state(self.conn, t.tile_id, "done", error=None)
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        return time.perf_counter() - t0

    def checkpoint(self, mode: str = "PASSIVE") -> Tuple[int, int, int]:
        r = self.conn.execute(f"PRAGMA wal_checkpoint({mode})").fetchone()
        return tuple(int(x) for x in r)  # type: ignore[return-value]

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass


def backup_database(src: Path, dest: Path) -> Path:
    """Consistent copy via the SQLite backup API (safe while the app reads)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    s = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    d = sqlite3.connect(str(tmp))
    try:
        s.backup(d, pages=4096)
    finally:
        d.close()
        s.close()
    os.replace(tmp, dest)
    return dest


# ---------------------------------------------------------------- the job
class RegionJob:
    def __init__(self, args: argparse.Namespace, *, session: Any = None, sleep: Any = None) -> None:
        self.args = args
        self._session = session  # tests: fake HTTP session
        self._sleep = sleep or time.sleep
        self.region = args.region
        self.years = sorted({int(y) for y in str(args.years).split(",") if y.strip()})
        self.state_path = Path(args.state) if args.state else default_state_path(self.region, self.years)
        self.stop_file = self.state_path.with_suffix(".stop")
        self.status_path = self.state_path.with_suffix(".status.json")
        self.stop = False
        self.tiles = R.load_region(self.region)
        if args.only_tile_id:
            want = set(args.only_tile_id)
            self.tiles = [t for t in self.tiles if t.tile_id in want]
        if args.tiles_file:
            want = {ln.strip() for ln in Path(args.tiles_file).read_text().splitlines() if ln.strip() and not ln.startswith("#")}
            self.tiles = [t for t in self.tiles if t.tile_id in want]
        self.region_box = R.region_box(R.load_region(self.region))
        self.stats = {"tile_years_written": 0, "tiles_written": 0, "write_s": 0.0, "write_batches": 0,
                      "compute_s": 0.0, "fetch_s": 0.0, "transient_pauses": 0, "permanent_errors": 0}
        self.started = time.time()

    def log(self, msg: str) -> None:
        print(f"{utc_now_iso()} {msg}", flush=True)

    def _signal(self, signum, _frame) -> None:
        self.stop = True
        self.log(f"signal {signum}: stopping after the current tile")

    def _should_stop(self) -> bool:
        if self.stop_file.exists():
            self.stop = True
        return self.stop

    def run(self) -> int:
        lock_path = self.state_path.with_suffix(".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_f = open(lock_path, "w")
        try:
            fcntl.flock(lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.log(f"another process runs this job ({lock_path}); exiting")
            return 2
        lock_f.write(str(os.getpid()))
        lock_f.flush()
        if self.stop_file.exists():
            self.stop_file.unlink()
        signal.signal(signal.SIGTERM, self._signal)
        signal.signal(signal.SIGINT, self._signal)

        state = JobState(self.state_path)
        dbs = {y: YearDb(y, Path(str(self.args.db_template).format(year=y))) for y in self.years}
        for db in dbs.values():
            db.validate_grid()
        all_ids = {t.tile_id for t in self.tiles}

        # Reconcile: the yearly databases are the source of truth for "done".
        by_id = {t.tile_id: t for t in R.load_region(self.region)}
        for y, db in dbs.items():
            present = db.existing_region_tiles(set(by_id))
            for tid, (lat, lon, st, n) in present.items():
                t = by_id[tid]
                if abs(lat - t.lat) > 1e-6 or abs(lon - t.lon) > 1e-6:
                    raise SystemExit(f"{db.path.name}: tile {tid} at ({lat}, {lon}) is not the region tile ({t.lat}, {t.lon})")
                if st == "done" and n >= 365:
                    state.mark(tid, y, "done")
        state.set_meta("job", {"region": self.region, "years": self.years, "tiles": len(self.tiles),
                               "db_template": str(self.args.db_template), "pid": os.getpid(), "started_at": utc_now_iso()})
        state.set_meta("region_box", self.region_box)
        state.commit()

        done = state.done_set()
        retry_errors = bool(self.args.retry_errors)
        errors = set() if retry_errors else state.error_set()
        work = []
        for t in self.tiles:
            missing = [y for y in self.years if (t.tile_id, y) not in done and (t.tile_id, y) not in errors]
            if missing:
                work.append((t, missing))
        if self.args.max_tiles:
            work = work[: int(self.args.max_tiles)]
        total_pairs = len(self.tiles) * len(self.years)
        self.log(f"job {self.state_path.stem}: {len(self.tiles)} tiles x {len(self.years)} years = {total_pairs} tile-years; "
                 f"done {len([1 for p in done if p[0] in all_ids])}, to do {sum(len(m) for _, m in work)} "
                 f"({len(work)} tiles)")

        # Backups and meta, only when something will actually be written.
        if work and not self.args.dry_run:
            for y, db in dbs.items():
                if not self.args.no_backup:
                    dest = Path(self.args.backup_dir) / f"{db.path.stem}.before-{self.region}.sqlite"
                    if not dest.exists():
                        self.log(f"backup {db.path.name} -> {dest}")
                        t0 = time.time()
                        backup_database(db.path, dest)
                        state.event("info", f"backup {db.path.name} -> {dest} ({time.time() - t0:.0f} s)")
                if db.ensure_region_meta(self.region_box):
                    state.event("info", f"{db.path.name}: grid_origin/coverage_bboxes recorded")
            state.commit()
        if self.args.dry_run:
            self.write_status(state, dbs, work_total=len(work), note="dry run")
            return 0

        budget = S.Budget(per_minute=float(self.args.budget_per_minute), per_hour=int(self.args.budget_per_hour),
                          per_day=int(self.args.budget_per_day), calls_per_minute=float(self.args.calls_per_minute),
                          calls_per_hour=float(self.args.calls_per_hour), calls_per_day=float(self.args.calls_per_day),
                          max_in_flight=int(self.args.max_in_flight))
        sched = S.Scheduler(budget, S.Ledger(Path(self.args.ledger)), job=self.state_path.stem, log=self.log,
                            session=self._session, sleep=self._sleep, should_abort=self._tick,
                            api_key=os.environ.get("OPEN_METEO_API_KEY") or None)
        if sched.api_key:
            B.OPEN_METEO_ARCHIVE = "https://customer-archive-api.open-meteo.com/v1/archive"
        self.sched = sched
        self._live = {"state": state, "dbs": dbs, "work_total": len(work), "last_status": 0.0, "processed": 0}
        batch: List[Tuple[R.RegionTile, Dict[int, Tuple[List[dict], List[dict]]]]] = []
        batch_started = time.time()
        last_checkpoint = time.time()
        last_status = 0.0
        processed = 0

        def flush() -> None:
            nonlocal batch, batch_started
            if not batch:
                return
            for y, db in dbs.items():
                items = [(t, res[y][0], res[y][1]) for t, res in batch if y in res]
                if items:
                    self.stats["write_s"] += db.write_batch(items)
            self.stats["write_batches"] += 1
            for t, res in batch:
                for y in res:
                    state.mark(t.tile_id, y, "done", attempt=True)
                self.stats["tile_years_written"] += len(res)
                self.stats["tiles_written"] += 1
            state.commit()
            batch = []
            batch_started = time.time()

        try:
            i = 0
            while i < len(work):
                if self._should_stop():
                    break
                t, missing = work[i]
                try:
                    t0 = time.perf_counter()
                    fetch_before = self.stats["fetch_s"]

                    def get_json(url: str) -> dict:
                        a = time.perf_counter()
                        j = sched.get_json(url)
                        self.stats["fetch_s"] += time.perf_counter() - a
                        return j

                    res = B.process_tile_years(B.Tile(t.tile_id, t.row, t.col, t.lat, t.lon), missing, get_json)
                    self.stats["compute_s"] += max(0.0, time.perf_counter() - t0 - (self.stats["fetch_s"] - fetch_before))
                    for y in missing:
                        rows, _riding = res[y]
                        usable = sum(1 for r in rows if (r.get("samples_daily") or 0) > 0)
                        if usable < 365:
                            raise S.PermanentError(f"year {y}: only {usable} days with data")
                    batch.append((t, res))
                    processed += 1
                    self._live["processed"] = processed
                    i += 1
                except S.PermanentError as e:
                    self.stats["permanent_errors"] += 1
                    for y in missing:
                        state.mark(t.tile_id, y, "error", error=str(e), attempt=True)
                    state.event("error", f"{t.tile_id}: {e}")
                    state.commit()
                    self.log(f"[ERR] {t.tile_id}: {e}")
                    i += 1
                except S.Aborted:
                    break
                except S.TransientError as e:
                    self.stats["transient_pauses"] += 1
                    state.event("warn", f"{t.tile_id}: {e}; pausing {self.args.transient_pause_s} s")
                    state.commit()
                    self.log(f"[WARN] {t.tile_id}: {e}; pausing {self.args.transient_pause_s} s, then retrying")
                    flush()
                    self._pause(float(self.args.transient_pause_s))
                    continue
                if len(batch) >= int(self.args.batch_tiles) or (time.time() - batch_started) >= float(self.args.batch_seconds):
                    flush()
                if time.time() - last_checkpoint >= float(self.args.checkpoint_hours) * 3600.0:
                    flush()
                    for db in dbs.values():
                        db.checkpoint("PASSIVE")
                    last_checkpoint = time.time()
                    state.event("info", "WAL checkpoint")
                if time.time() - last_status >= 15.0:
                    self.write_status(state, dbs, work_total=len(work), processed=processed)
                    last_status = time.time()
        finally:
            flush()
            for db in dbs.values():
                try:
                    db.checkpoint("PASSIVE")
                except Exception as e:
                    self.log(f"checkpoint {db.path.name}: {e}")
            finished = not self.stop and processed + self.stats["permanent_errors"] >= len(work)
            state.event("info", "finished" if finished else "stopped")
            self.write_status(state, dbs, work_total=len(work), processed=processed,
                              note="finished" if finished else "stopped")
            state.commit()
            for db in dbs.values():
                db.close()
            try:
                fcntl.flock(lock_f, fcntl.LOCK_UN)
                lock_f.close()
            except Exception:
                pass
        return 0

    def _budget_estimate(self, remaining_pairs: int) -> Dict[str, Any]:
        """Remaining duration if the daily weighted-call budget is the limit (it usually is)."""
        n_years = max(1, len(self.years))
        days_span = sum(366 if y % 4 == 0 else 365 for y in self.years)
        calls_per_tile = 2 * max(1.0, days_span / 14.0)  # one daily + one hourly request (1 location, < 10 variables)
        tiles = math.ceil(remaining_pairs / n_years)
        per_day = float(self.args.calls_per_day)
        return {"calls_per_tile": round(calls_per_tile, 1), "remaining_tiles": tiles,
                "remaining_calls": round(tiles * calls_per_tile), "calls_per_day_budget": per_day,
                "tiles_per_day": round(per_day / calls_per_tile, 1),
                "eta_days": round(tiles * calls_per_tile / per_day, 1) if per_day > 0 else None}

    def _tick(self) -> bool:
        """Called by the scheduler while it waits: stop check plus a fresh status every minute."""
        live = getattr(self, "_live", None)
        if live is not None and time.time() - live["last_status"] >= 60.0:
            live["last_status"] = time.time()
            try:
                self.write_status(live["state"], live["dbs"], work_total=live["work_total"],
                                  processed=live["processed"], note="waiting for request budget")
            except Exception as e:
                self.log(f"status write failed: {e}")
        return self._should_stop()

    def _pause(self, seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end and not self._should_stop():
            self._sleep(min(5.0, max(0.0, end - time.time())))
            if self._sleep is not time.sleep:
                break

    def write_status(self, state: JobState, dbs: Dict[int, YearDb], *, work_total: int, processed: int = 0,
                     note: str = "running") -> Dict[str, Any]:
        ids = {t.tile_id for t in self.tiles}
        done = {p for p in state.done_set() if p[0] in ids}
        errs = {p for p in state.error_set() if p[0] in ids}
        per_year = {str(y): {"done": sum(1 for p in done if p[1] == y), "error": sum(1 for p in errs if p[1] == y),
                             "total": len(self.tiles)} for y in self.years}
        elapsed = max(1e-6, time.time() - self.started)
        total_pairs = len(self.tiles) * len(self.years)
        remaining_pairs = total_pairs - len(done) - len(errs)
        rate_pairs_h = self.stats["tile_years_written"] / elapsed * 3600.0
        sched = getattr(self, "sched", None)
        req_status = sched.status() if sched is not None else None
        tele = req_status["telemetry"] if req_status else {}
        status = {
            "job": self.state_path.stem,
            "state": note,
            "pid": os.getpid(),
            "updated_at": utc_now_iso(),
            "region": self.region,
            "years": self.years,
            "tiles": len(self.tiles),
            "tile_years_total": total_pairs,
            "tile_years_done": len(done),
            "tile_years_error": len(errs),
            "tile_years_remaining": remaining_pairs,
            "per_year": per_year,
            "session": {
                "elapsed_s": round(elapsed, 1),
                "tiles_processed": processed,
                "tile_years_written": self.stats["tile_years_written"],
                "tile_years_per_hour": round(rate_pairs_h, 1),
                "tiles_per_minute": round(processed / elapsed * 60.0, 2),
                "requests_per_minute": round((tele.get("requests") or 0) / elapsed * 60.0, 2),
                "db_write_ms_per_tile_year": round(self.stats["write_s"] * 1000.0 / self.stats["tile_years_written"], 2)
                if self.stats["tile_years_written"] else None,
                "write_batches": self.stats["write_batches"],
                "compute_s_per_tile": round(self.stats["compute_s"] / self.stats["tiles_written"], 3)
                if self.stats["tiles_written"] else None,
                "transient_pauses": self.stats["transient_pauses"],
                "permanent_errors": self.stats["permanent_errors"],
                "eta_hours_at_session_rate": round(remaining_pairs / rate_pairs_h, 1) if rate_pairs_h > 0 else None,
            },
            "budget_estimate": self._budget_estimate(remaining_pairs),
            "requests": req_status,
            "recent_events": [dict(zip(("ts", "level", "message"), r)) for r in
                              state.conn.execute("SELECT ts, level, message FROM events ORDER BY rowid DESC LIMIT 12")],
        }
        state.set_meta("status", status)
        state.commit()
        tmp = self.status_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(status, indent=2), encoding="utf-8")
        os.replace(tmp, self.status_path)
        return status


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--region", default="africa", choices=sorted(R.REGION_DEFS))
    p.add_argument("--years", default="2023,2024,2025")
    p.add_argument("--db-template", default=str(CACHE_DIR / "offline_weather_{year}.sqlite"))
    p.add_argument("--state", default="", help="Job-state database (default project/cache/offline_jobs/<job>.sqlite)")
    p.add_argument("--ledger", default=str(S.DEFAULT_LEDGER))
    p.add_argument("--backup-dir", default=str(CACHE_DIR / "backups"))
    p.add_argument("--no-backup", action="store_true")
    p.add_argument("--budget-per-minute", type=float, default=20.0)
    p.add_argument("--budget-per-hour", type=int, default=900)
    p.add_argument("--budget-per-day", type=int, default=4000)
    p.add_argument("--calls-per-minute", type=float, default=240.0, help="Weighted Open-Meteo calls per minute")
    p.add_argument("--calls-per-hour", type=float, default=2000.0, help="Weighted Open-Meteo calls per hour")
    p.add_argument("--calls-per-day", type=float, default=4000.0, help="Weighted Open-Meteo calls per day")
    p.add_argument("--max-in-flight", type=int, default=1)
    p.add_argument("--batch-tiles", type=int, default=25)
    p.add_argument("--batch-seconds", type=float, default=300.0)
    p.add_argument("--checkpoint-hours", type=float, default=6.0)
    p.add_argument("--transient-pause-s", type=float, default=600.0)
    p.add_argument("--max-tiles", type=int, default=0, help="Process at most this many tiles (pilot)")
    p.add_argument("--only-tile-id", action="append", default=[])
    p.add_argument("--tiles-file", default="")
    p.add_argument("--retry-errors", action="store_true", help="Retry tile/years previously marked as error")
    p.add_argument("--dry-run", action="store_true", help="Reconcile and report; no requests, no writes")
    p.add_argument("--status", action="store_true", help="Print the last status JSON and exit")
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    if args.status:
        years = sorted({int(y) for y in str(args.years).split(",") if y.strip()})
        path = (Path(args.state) if args.state else default_state_path(args.region, years)).with_suffix(".status.json")
        print(path.read_text() if path.exists() else json.dumps({"state": "never started", "path": str(path)}))
        return 0
    return RegionJob(args).run()


if __name__ == "__main__":
    sys.exit(main())
