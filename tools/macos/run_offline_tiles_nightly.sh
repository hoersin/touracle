#!/usr/bin/env bash
set -euo pipefail

# Nightly offline Open‑Meteo tile builder runner for macOS launchd.
#
# Writes logs into: project/debug_output/
# Produces/updates: project/cache/offline_weather_<endYear>.sqlite

now_iso() {
  # macOS `date` doesn't support GNU `-Is`.
  date +"%Y-%m-%dT%H:%M:%S%z"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

mkdir -p project/debug_output project/cache

# Avoid concurrent runs (rate limits + DB contention). If a builder is already
# running (manual or from a previous schedule), exit cleanly.
if command -v pgrep >/dev/null 2>&1; then
  if pgrep -f "project/offline/build_offline_tiles_openmeteo.py" >/dev/null 2>&1; then
    TS_LOCAL="$(date +%F_%H-%M-%S)"
    LOG="project/debug_output/offline_build_nightly_${TS_LOCAL}_skipped_already_running.log"
    {
      echo "[nightly] skip $(now_iso)"
      echo "[nightly] reason=builder already running"
      pgrep -fl "project/offline/build_offline_tiles_openmeteo.py" || true
    } >>"$LOG" 2>&1
    exit 0
  fi
fi

# Rotate chunks deterministically by day-of-year so over ~10 days all chunks run.
# launchd provides a minimal env; rely only on POSIX tools.
DAY_OF_YEAR="$(date +%j)"
CHUNK_COUNT="10"
CHUNK_INDEX=$((10#$DAY_OF_YEAR % CHUNK_COUNT))

CURRENT_YEAR="$(date +%Y)"
DEFAULT_END_YEAR=$((10#$CURRENT_YEAR - 1))
DEFAULT_START_YEAR=$((DEFAULT_END_YEAR - 9))

PY="$REPO_ROOT/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  # Fallback for non-venv setups
  PY="python3"
fi

# Choose DB:
# - Prefer an existing DB that is incomplete (has errors/building/not-done tiles,
#   or a smaller tile universe than the most complete DB in cache).
# - Fall back to the default rolling window DB.
# - Allow overriding via OFFLINE_TILES_DB.
DB="${OFFLINE_TILES_DB:-}"
START_YEAR=""
END_YEAR=""

if [[ -z "$DB" ]]; then
  SELECTION="$(
  "$PY" - <<'PY'
import glob
import json
import os
import re
import sqlite3
from datetime import date

def _safe_int(x, default=None):
  try:
    return int(x)
  except Exception:
    return default

def meta_get(conn, key: str):
  try:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else None
  except Exception:
    return None

def counts(conn):
  out = {"tiles": 0, "done": 0, "error": 0, "building": 0}
  try:
    out["tiles"] = int(conn.execute("SELECT COUNT(*) FROM tiles").fetchone()[0])
  except Exception:
    pass
  try:
    for status, n in conn.execute("SELECT status, COUNT(*) FROM build_state GROUP BY status").fetchall():
      if status in out:
        out[status] = int(n)
  except Exception:
    pass
  return out

def parse_years_from_db(path: str):
  try:
    conn = sqlite3.connect(path)
    try:
      raw = meta_get(conn, "years")
      if raw:
        j = json.loads(raw)
        ys = _safe_int(j.get("start")), _safe_int(j.get("end"))
        if ys[0] and ys[1]:
          return ys
    finally:
      conn.close()
  except Exception:
    pass
  m = re.search(r"offline_weather_(\d{4})\.sqlite$", os.path.basename(path))
  if m:
    y = int(m.group(1))
    return (y, y)
  # Rolling window default
  end_year = date.today().year - 1
  return (end_year - 9, end_year)

def db_year_key(path: str) -> int:
  m = re.search(r"offline_weather_(\d{4})\.sqlite$", os.path.basename(path))
  return int(m.group(1)) if m else 9999

cache_glob = "project/cache/offline_weather*.sqlite"
paths = sorted(glob.glob(cache_glob))
paths = [
  p for p in paths
  if not any(s in os.path.basename(p) for s in ("_test", "pace_test"))
]

stats = []
max_tiles = 0
for p in paths:
  try:
    conn = sqlite3.connect(p)
    try:
      c = counts(conn)
    finally:
      conn.close()
  except Exception:
    c = {"tiles": 0, "done": 0, "error": 0, "building": 0}
  max_tiles = max(max_tiles, int(c.get("tiles") or 0))
  stats.append((p, c))

def is_incomplete(c: dict) -> bool:
  tiles = int(c.get("tiles") or 0)
  done = int(c.get("done") or 0)
  err = int(c.get("error") or 0)
  building = int(c.get("building") or 0)
  if err > 0 or building > 0:
    return True
  if tiles == 0:
    return True
  if done < tiles:
    return True
  # Heuristic: if this DB has a smaller tile universe than the most complete
  # DB found in cache, assume it still needs remaining chunks.
  if max_tiles and tiles < max_tiles:
    return True
  return False

incomplete = [(p, c) for (p, c) in stats if is_incomplete(c)]
if incomplete:
  def score(item):
    p, c = item
    tiles = int(c.get("tiles") or 0)
    done = int(c.get("done") or 0)
    err = int(c.get("error") or 0)
    building = int(c.get("building") or 0)
    missing = max(0, tiles - done)
    # Prioritize error recovery first, then missing tiles, then smaller DBs.
    base = err * 1000 + building * 200 + missing * 10 + max(0, (max_tiles - tiles))
    # Tie-break: prefer older years.
    return (base, -db_year_key(p))

  chosen, _ = max(incomplete, key=score)
else:
  chosen = f"project/cache/offline_weather_{date.today().year - 1}.sqlite"

ys, ye = parse_years_from_db(chosen)
print(f"DB={chosen}")
print(f"START_YEAR={ys}")
print(f"END_YEAR={ye}")
PY
  )"
  # shellcheck disable=SC2163
  eval "$SELECTION"
else
  # Use DB meta years when possible; fall back to rolling window.
  YEARS="$(
  "$PY" - <<PY
import json
import sqlite3
from datetime import date
db = "${DB}"
ys = None
ye = None
try:
  conn = sqlite3.connect(db)
  try:
    row = conn.execute("SELECT value FROM meta WHERE key='years'").fetchone()
    if row and row[0]:
      j = json.loads(row[0])
      ys = int(j.get('start'))
      ye = int(j.get('end'))
  finally:
    conn.close()
except Exception:
  pass
if ys is None or ye is None:
  ye = date.today().year - 1
  ys = ye - 9
print(f"{ys} {ye}")
PY
  )"
  START_YEAR="${YEARS%% *}"
  END_YEAR="${YEARS##* }"
fi

if [[ -z "$DB" ]]; then
  DB="project/cache/offline_weather_${DEFAULT_END_YEAR}.sqlite"
fi

if [[ -z "$START_YEAR" || -z "$END_YEAR" ]]; then
  START_YEAR="$DEFAULT_START_YEAR"
  END_YEAR="$DEFAULT_END_YEAR"
fi

DB="${DB#./}"
START_YEAR="${START_YEAR#./}"
END_YEAR="${END_YEAR#./}"
TS_LOCAL="$(date +%F_%H-%M-%S)"
LOG="project/debug_output/offline_build_nightly_${TS_LOCAL}_y${START_YEAR}-${END_YEAR}_chunk${CHUNK_INDEX}.log"

{
  echo "[nightly] start $(now_iso)"
  echo "[nightly] repo=$REPO_ROOT"
  echo "[nightly] db=$DB years=${START_YEAR}..${END_YEAR} chunk=${CHUNK_INDEX}/${CHUNK_COUNT}"

  # The builder is restart-safe; it will skip tiles already marked as done.
  # Pace control aims to finish by 07:00 Europe/Berlin.
  PYTHONUNBUFFERED=1 "$PY" project/offline/build_offline_tiles_openmeteo.py \
    --db "$DB" \
    --start-year "$START_YEAR" \
    --end-year "$END_YEAR" \
    --chunk-count "$CHUNK_COUNT" \
    --chunk-index "$CHUNK_INDEX" \
    --pace-until-berlin-7am

  echo "[nightly] done $(now_iso)"
} >>"$LOG" 2>&1
