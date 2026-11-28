"""Central request scheduler for the Open-Meteo archive API.

Why: the offline builder used to pace requests per process with a fixed interval and
retried HTTP 429 after 2-80 s. Open-Meteo's free tier enforces per-minute, per-hour
and per-day limits, so short retries ran straight into the same window again (retry
storms), every process paced itself independently, and tiles were marked "error"
during a temporary block.

What: every request of every downloader process is reserved in one small SQLite
ledger (``project/cache/openmeteo_request_ledger.sqlite``) before it is sent. A
reservation is granted only while the rolling minute, hour and day windows stay
inside the configured budget and the global minimum spacing has passed. A 429 sets
a global cooldown in the same ledger, derived from ``Retry-After`` and from the
limit Open-Meteo names in its error text (minutely / hourly / daily), with
exponential escalation and jitter, and halves the effective rate until a quiet
period has passed. Transient server and network errors are retried with jittered
exponential backoff and finally raised as TransientError so a job can pause and
continue instead of failing the tile. Only genuine client errors (400, 404 ...)
raise PermanentError.

Calls are weighted the way Open-Meteo counts them: a request is
locations x max(1, variables / 10) x max(1, days / 14) calls, so one year of one
location is ~26 calls and three years ~78. Measured 2026-11-28: ~230 three-year
requests within one hour triggered "Hourly API request limit exceeded" (free tier:
600 calls/min, 5,000/h, 10,000/day, 300,000/month). The default budget uses 40% of
each free limit and leaves the rest to Touracle's own live requests.
"""
from __future__ import annotations

import datetime as _dt
import json
import random
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import requests
from urllib.parse import parse_qs, urlparse

DEFAULT_LEDGER = Path(__file__).resolve().parents[1] / "cache" / "openmeteo_request_ledger.sqlite"
USER_AGENT = "touracle-offline-tiles/2"


class TransientError(RuntimeError):
    """Temporary failure (network, 5xx, persistent rate limiting): retry later."""


class PermanentError(RuntimeError):
    """The request itself is invalid (HTTP 4xx other than 429): do not retry."""


class Aborted(RuntimeError):
    """The caller asked to stop while the scheduler was waiting."""


def call_weight(url: str) -> float:
    """Open-Meteo call weight of a request: locations x max(1, vars/10) x max(1, days/14)."""
    try:
        q = parse_qs(urlparse(url).query)
        n_loc = len(str(q.get("latitude", ["0"])[0]).split(","))
        n_vars = sum(len(str(q[k][0]).split(",")) for k in ("daily", "hourly", "minutely_15", "current") if k in q)
        days = 1
        if "start_date" in q and "end_date" in q:
            d0 = _dt.date.fromisoformat(q["start_date"][0])
            d1 = _dt.date.fromisoformat(q["end_date"][0])
            days = (d1 - d0).days + 1
        return float(n_loc) * max(1.0, n_vars / 10.0) * max(1.0, days / 14.0)
    except Exception:
        return 1.0


@dataclass
class Budget:
    # HTTP requests (spacing and request caps)
    per_minute: float = 20.0
    per_hour: int = 900
    per_day: int = 4000
    # Weighted Open-Meteo calls (what the API enforces): 40% of the free limits
    calls_per_minute: float = 240.0
    calls_per_hour: float = 2000.0
    calls_per_day: float = 4000.0
    max_in_flight: int = 1
    timeout_s: float = 120.0
    max_transient_attempts: int = 8

    @property
    def min_spacing_s(self) -> float:
        return 60.0 / max(0.1, float(self.per_minute))


@dataclass
class Telemetry:
    requests: int = 0
    calls: float = 0.0
    ok: int = 0
    http_429: int = 0
    http_5xx: int = 0
    network_errors: int = 0
    other_errors: int = 0
    retries: int = 0
    wait_s: float = 0.0
    cooldown_s: float = 0.0
    latency_ms_sum: float = 0.0
    latency_ms_max: float = 0.0
    latencies_ms: List[float] = field(default_factory=list)
    last_429_reason: Optional[str] = None
    last_429_at: Optional[str] = None
    bytes_received: int = 0

    def summary(self) -> Dict[str, Any]:
        lat = sorted(self.latencies_ms)
        med = lat[len(lat) // 2] if lat else None
        return {
            "requests": self.requests,
            "calls_weighted": round(self.calls, 1),
            "ok": self.ok,
            "http_429": self.http_429,
            "http_5xx": self.http_5xx,
            "network_errors": self.network_errors,
            "other_errors": self.other_errors,
            "retries": self.retries,
            "retry_rate": round(self.retries / self.requests, 4) if self.requests else 0.0,
            "rate_429": round(self.http_429 / self.requests, 4) if self.requests else 0.0,
            "wait_s": round(self.wait_s, 1),
            "cooldown_s": round(self.cooldown_s, 1),
            "latency_ms_mean": round(self.latency_ms_sum / self.ok, 1) if self.ok else None,
            "latency_ms_median": round(med, 1) if med is not None else None,
            "latency_ms_max": round(self.latency_ms_max, 1),
            "bytes_received": self.bytes_received,
            "last_429_reason": self.last_429_reason,
            "last_429_at": self.last_429_at,
        }


def _utc_iso(ts: float) -> str:
    return _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).isoformat(timespec="seconds")


class Ledger:
    """Request reservations and the global cooldown, shared by all processes."""

    def __init__(self, path: Path = DEFAULT_LEDGER) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.execute("CREATE TABLE IF NOT EXISTS requests (ts REAL NOT NULL, job TEXT, status INTEGER)")
            cols = {r[1] for r in c.execute("PRAGMA table_info(requests)")}
            if "weight" not in cols:
                c.execute("ALTER TABLE requests ADD COLUMN weight REAL NOT NULL DEFAULT 1.0")
            c.execute("CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts)")
            c.execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(str(self.path), timeout=60.0, isolation_level=None)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA busy_timeout=60000")
        return c

    def try_reserve(self, now: float, budget: Budget, rate_factor: float, job: str,
                    weight: float = 1.0) -> tuple[Optional[int], float]:
        """Reserve one request slot. Returns (row id, 0) or (None, seconds to wait)."""
        c = self._conn()
        try:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT value FROM state WHERE key='cooldown_until'").fetchone()
            cooldown_until = float(row[0]) if row else 0.0
            if cooldown_until > now:
                c.execute("ROLLBACK")
                return None, cooldown_until - now
            spacing = budget.min_spacing_s / max(0.05, rate_factor)
            last = c.execute("SELECT MAX(ts) FROM requests").fetchone()[0]
            if last is not None and now - float(last) < spacing:
                c.execute("ROLLBACK")
                return None, spacing - (now - float(last))
            waits = []
            for window, limit in ((60.0, budget.per_minute * rate_factor), (3600.0, budget.per_hour * rate_factor),
                                  (86400.0, float(budget.per_day))):
                n = c.execute("SELECT COUNT(*) FROM requests WHERE ts > ?", (now - window,)).fetchone()[0]
                if n >= max(1.0, limit):
                    # Wait until enough of the window's oldest requests have expired.
                    k = int(n - max(1.0, limit))
                    oldest = c.execute("SELECT ts FROM requests WHERE ts > ? ORDER BY ts LIMIT 1 OFFSET ?",
                                       (now - window, k)).fetchone()
                    waits.append((float(oldest[0]) + window - now + 0.5) if oldest else window)
            for window, limit in ((60.0, budget.calls_per_minute * rate_factor),
                                  (3600.0, budget.calls_per_hour * rate_factor),
                                  (86400.0, float(budget.calls_per_day))):
                limit = max(float(weight), float(limit))  # a single request always fits an empty window
                used = float(c.execute("SELECT TOTAL(weight) FROM requests WHERE ts > ?", (now - window,)).fetchone()[0])
                if used + weight > limit:
                    # Wait until enough weight of the window's oldest requests has expired.
                    need = used + weight - limit
                    acc = 0.0
                    until = now + window
                    for ts, w in c.execute("SELECT ts, weight FROM requests WHERE ts > ? ORDER BY ts", (now - window,)):
                        acc += float(w)
                        if acc >= need:
                            until = float(ts) + window
                            break
                    waits.append(until - now + 0.5)
            if waits:
                c.execute("ROLLBACK")
                return None, max(waits)
            cur = c.execute("INSERT INTO requests(ts, job, status, weight) VALUES(?,?,NULL,?)", (now, job, float(weight)))
            c.execute("DELETE FROM requests WHERE ts < ?", (now - 3 * 86400.0,))
            c.execute("COMMIT")
            return int(cur.lastrowid), 0.0
        except Exception:
            try:
                c.execute("ROLLBACK")
            except Exception:
                pass
            raise
        finally:
            c.close()

    def set_status(self, rid: int, status: int) -> None:
        c = self._conn()
        try:
            c.execute("UPDATE requests SET status=? WHERE rowid=?", (int(status), int(rid)))
        finally:
            c.close()

    def extend_cooldown(self, until: float, reason: str) -> float:
        c = self._conn()
        try:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT value FROM state WHERE key='cooldown_until'").fetchone()
            cur = float(row[0]) if row else 0.0
            new = max(cur, float(until))
            c.execute("INSERT INTO state(key, value) VALUES('cooldown_until', ?) "
                      "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(new),))
            c.execute("INSERT INTO state(key, value) VALUES('cooldown_reason', ?) "
                      "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (reason,))
            c.execute("COMMIT")
            return new
        finally:
            c.close()

    def snapshot(self, now: float) -> Dict[str, Any]:
        c = self._conn()
        try:
            st = dict(c.execute("SELECT key, value FROM state").fetchall())
            counts = {name: c.execute("SELECT COUNT(*) FROM requests WHERE ts > ?", (now - w,)).fetchone()[0]
                      for name, w in (("last_minute", 60.0), ("last_hour", 3600.0), ("last_day", 86400.0))}
            calls = {name: round(float(c.execute("SELECT TOTAL(weight) FROM requests WHERE ts > ?", (now - w,)).fetchone()[0]), 1)
                     for name, w in (("last_minute", 60.0), ("last_hour", 3600.0), ("last_day", 86400.0))}
            cu = float(st.get("cooldown_until", 0) or 0)
            return {"requests": counts, "calls_weighted": calls, "cooldown_until": _utc_iso(cu) if cu > now else None,
                    "cooldown_reason": st.get("cooldown_reason") if cu > now else None}
        finally:
            c.close()


def classify_429(body: str) -> str:
    text = (body or "").lower()
    for key in ("minutely", "hourly", "daily", "monthly"):
        if key in text:
            return key
    return "unknown"


def parse_retry_after(value: Optional[str], now: float) -> Optional[float]:
    """Seconds to wait from a Retry-After header (delta-seconds or HTTP date)."""
    if not value:
        return None
    v = str(value).strip()
    try:
        return max(0.0, float(v))
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime
        d = parsedate_to_datetime(v)
        if d.tzinfo is None:
            d = d.replace(tzinfo=_dt.timezone.utc)
        return max(0.0, d.timestamp() - now)
    except Exception:
        return None


def cooldown_for_429(kind: str, consecutive: int, now: float, retry_after_s: Optional[float],
                     rng: random.Random) -> float:
    """Seconds to pause all requests after a 429 (never shorter than Retry-After)."""
    n = max(1, int(consecutive))
    if kind == "minutely":
        base = min(900.0, 60.0 * (2 ** (n - 1)))
    elif kind == "hourly":
        nxt = (int(now) // 3600 + 1) * 3600
        base = max(nxt - now, 300.0) + 600.0 * (n - 1)
    elif kind in ("daily", "monthly"):
        d = _dt.datetime.fromtimestamp(now, _dt.timezone.utc)
        midnight = _dt.datetime(d.year, d.month, d.day, tzinfo=_dt.timezone.utc) + _dt.timedelta(days=1)
        base = max(midnight.timestamp() - now, 600.0) + 3600.0 * (n - 1)
    else:
        base = min(3600.0, 60.0 * (2 ** (n - 1)))
    base += rng.uniform(5.0, 30.0)  # jitter: avoid synchronising with other clients
    if retry_after_s is not None:
        base = max(base, float(retry_after_s) + rng.uniform(1.0, 5.0))
    return base


def backoff_transient(attempt: int, rng: random.Random, base_s: float = 5.0, cap_s: float = 300.0) -> float:
    """Equal-jitter exponential backoff for network errors and 5xx."""
    exp = min(cap_s, base_s * (2 ** max(0, attempt)))
    return exp / 2.0 + rng.uniform(0.0, exp / 2.0)


class Scheduler:
    """Globally budgeted GET-JSON with resilient retry handling."""

    QUIET_RESTORE_S = 1800.0

    def __init__(self, budget: Budget, ledger: Optional[Ledger] = None, *, job: str = "offline",
                 session: Optional[requests.Session] = None, sleep: Callable[[float], None] = time.sleep,
                 now: Callable[[], float] = time.time, rng: Optional[random.Random] = None,
                 log: Optional[Callable[[str], None]] = None, api_key: Optional[str] = None,
                 should_abort: Optional[Callable[[], bool]] = None) -> None:
        self.budget = budget
        self.ledger = ledger or Ledger()
        self.job = job
        self.session = session or requests.Session()
        try:
            self.session.headers["User-Agent"] = USER_AGENT
        except Exception:
            pass
        self._sleep = sleep
        self._now = now
        self.rng = rng or random.Random()
        self.log = log or (lambda msg: None)
        self.api_key = api_key
        self.should_abort = should_abort or (lambda: False)
        self.telemetry = Telemetry()
        self.rate_factor = 1.0
        self._consecutive_429 = 0
        self._last_429_ts = 0.0
        self._sem = threading.BoundedSemaphore(max(1, int(budget.max_in_flight)))
        self._tlock = threading.Lock()

    # -------------------------------------------------------------- pacing
    def _restore_rate(self, now: float) -> None:
        if self.rate_factor < 1.0 and now - self._last_429_ts > self.QUIET_RESTORE_S:
            self.rate_factor = min(1.0, self.rate_factor * 1.25)
            self._last_429_ts = now - self.QUIET_RESTORE_S / 2.0  # next step after another quiet period
            self.log(f"[sched] quiet period, rate factor -> {self.rate_factor:.2f}")

    def _reserve(self, weight: float = 1.0) -> int:
        while True:
            if self.should_abort():
                raise Aborted("stop requested")
            now = self._now()
            self._restore_rate(now)
            rid, wait = self.ledger.try_reserve(now, self.budget, self.rate_factor, self.job, weight)
            if rid is not None:
                return rid
            # Short slices, so a stop request takes effect within seconds.
            wait = min(max(0.05, float(wait)), 5.0)
            with self._tlock:
                self.telemetry.wait_s += wait
            self._sleep(wait)

    # -------------------------------------------------------------- requests
    def get_json(self, url: str) -> Dict[str, Any]:
        if self.api_key and "apikey=" not in url:
            url = url + ("&" if "?" in url else "?") + f"apikey={self.api_key}"
        transient_attempt = 0
        weight = call_weight(url)
        while True:
            with self._sem:
                rid = self._reserve(weight)
                t0 = time.perf_counter()
                try:
                    resp = self.session.get(url, timeout=self.budget.timeout_s)
                except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
                    self.ledger.set_status(rid, -1)
                    with self._tlock:
                        self.telemetry.requests += 1
                        self.telemetry.network_errors += 1
                    resp = None
                    err: Exception = e
                latency_ms = (time.perf_counter() - t0) * 1000.0
            if resp is None:
                transient_attempt += 1
                if transient_attempt >= self.budget.max_transient_attempts:
                    raise TransientError(f"network error after {transient_attempt} attempts: {err}")
                self._retry_sleep(backoff_transient(transient_attempt, self.rng), f"network error: {err}")
                continue
            self.ledger.set_status(rid, resp.status_code)
            with self._tlock:
                self.telemetry.requests += 1
                self.telemetry.calls += weight
            if resp.status_code == 200:
                try:
                    data = resp.json()
                except ValueError as e:
                    with self._tlock:
                        self.telemetry.other_errors += 1
                    transient_attempt += 1
                    if transient_attempt >= self.budget.max_transient_attempts:
                        raise TransientError(f"invalid JSON: {e}")
                    self._retry_sleep(backoff_transient(transient_attempt, self.rng), "invalid JSON")
                    continue
                with self._tlock:
                    t = self.telemetry
                    t.ok += 1
                    t.latency_ms_sum += latency_ms
                    t.latency_ms_max = max(t.latency_ms_max, latency_ms)
                    t.bytes_received += len(resp.content or b"")
                    if len(t.latencies_ms) < 20000:
                        t.latencies_ms.append(latency_ms)
                self._consecutive_429 = 0
                return data
            if resp.status_code == 429:
                now = self._now()
                kind = classify_429(resp.text)
                self._consecutive_429 += 1
                self._last_429_ts = now
                self.rate_factor = max(0.1, self.rate_factor * 0.5)
                wait = cooldown_for_429(kind, self._consecutive_429, now,
                                        parse_retry_after(resp.headers.get("Retry-After"), now), self.rng)
                until = self.ledger.extend_cooldown(now + wait, f"429 {kind}")
                with self._tlock:
                    self.telemetry.http_429 += 1
                    self.telemetry.retries += 1
                    self.telemetry.cooldown_s += max(0.0, until - now)
                    self.telemetry.last_429_reason = (resp.text or "")[:200]
                    self.telemetry.last_429_at = _utc_iso(now)
                self.log(f"[sched] HTTP 429 ({kind}); all requests paused until {_utc_iso(until)}; "
                         f"rate factor {self.rate_factor:.2f}")
                if self._consecutive_429 >= 6:
                    raise TransientError(f"rate limited ({kind}) {self._consecutive_429} times in a row")
                continue  # _reserve() waits for the cooldown
            if resp.status_code in (500, 502, 503, 504):
                with self._tlock:
                    self.telemetry.http_5xx += 1
                transient_attempt += 1
                if transient_attempt >= self.budget.max_transient_attempts:
                    raise TransientError(f"HTTP {resp.status_code} after {transient_attempt} attempts")
                self._retry_sleep(backoff_transient(transient_attempt, self.rng), f"HTTP {resp.status_code}")
                continue
            with self._tlock:
                self.telemetry.other_errors += 1
            raise PermanentError(f"HTTP {resp.status_code}: {(resp.text or '')[:200]}")

    def _retry_sleep(self, seconds: float, why: str) -> None:
        with self._tlock:
            self.telemetry.retries += 1
            self.telemetry.wait_s += seconds
        self.log(f"[sched] {why}; retry in {seconds:.0f} s")
        end = self._now() + seconds
        while self._now() < end:
            if self.should_abort():
                raise Aborted("stop requested")
            self._sleep(min(5.0, end - self._now()))

    def status(self) -> Dict[str, Any]:
        return {
            "budget": {"per_minute": self.budget.per_minute, "per_hour": self.budget.per_hour,
                       "per_day": self.budget.per_day, "calls_per_minute": self.budget.calls_per_minute,
                       "calls_per_hour": self.budget.calls_per_hour, "calls_per_day": self.budget.calls_per_day,
                       "max_in_flight": self.budget.max_in_flight},
            "rate_factor": round(self.rate_factor, 3),
            "ledger": self.ledger.snapshot(self._now()),
            "telemetry": self.telemetry.summary(),
        }


def budget_from_json(raw: Optional[str]) -> Budget:
    b = Budget()
    if raw:
        for k, v in json.loads(raw).items():
            if hasattr(b, k):
                setattr(b, k, type(getattr(b, k))(v))
    return b
