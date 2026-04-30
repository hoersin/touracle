from __future__ import annotations

from flask import Flask, jsonify, request, send_from_directory
from pathlib import Path
from typing import Any, Dict, List, Optional
import datetime as dt
import json
import math
import os
import re
import signal
import shlex
import sqlite3
import subprocess
import threading
import uuid

from build_offline_tiles_openmeteo import _is_coastal_sea, _try_make_is_land_fn, tile_grid_approx_50km


OFFLINE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = OFFLINE_DIR.parent
REPO_DIR = PROJECT_DIR.parent
CACHE_DIR = PROJECT_DIR / "cache"
DATA_DIR = PROJECT_DIR / "data"
DEBUG_DIR = PROJECT_DIR / "debug_output"
FRONTEND_DIR = OFFLINE_DIR / "manager_frontend"
REGISTRY_PATH = DATA_DIR / "offline_tile_manager_jobs.json"
DEFAULT_PORT = 5003

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
try:
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
except Exception:
    pass

REGION_PRESETS: List[Dict[str, Any]] = [
    {
        "slug": "europe-iceland",
        "label": "Europe + Iceland",
        "bbox": {"lat_min": 34.0, "lat_max": 72.0, "lon_min": -28.0, "lon_max": 33.0},
        "default": True,
    },
    {
        "slug": "north-america",
        "label": "North America",
        "bbox": {"lat_min": 7.0, "lat_max": 84.0, "lon_min": -170.0, "lon_max": -52.0},
    },
    {
        "slug": "south-america",
        "label": "South America",
        "bbox": {"lat_min": -56.0, "lat_max": 14.0, "lon_min": -92.0, "lon_max": -34.0},
    },
    {
        "slug": "africa",
        "label": "Africa",
        "bbox": {"lat_min": -36.0, "lat_max": 38.0, "lon_min": -20.0, "lon_max": 55.0},
    },
    {
        "slug": "asia",
        "label": "Asia",
        "bbox": {"lat_min": -12.0, "lat_max": 82.0, "lon_min": 25.0, "lon_max": 180.0},
    },
    {
        "slug": "oceania",
        "label": "Oceania",
        "bbox": {"lat_min": -50.0, "lat_max": 5.0, "lon_min": 110.0, "lon_max": 180.0},
    },
]

LOCK = threading.RLock()
PROCESS_BY_JOB_ID: Dict[str, subprocess.Popen[Any]] = {}
EXPECTED_TILE_COUNT_CACHE: Dict[str, int] = {}


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _default_registry() -> Dict[str, Any]:
    return {"version": 1, "jobs": []}


def _load_registry() -> Dict[str, Any]:
    try:
        if REGISTRY_PATH.exists():
            raw = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                raw.setdefault("version", 1)
                raw.setdefault("jobs", [])
                return raw
    except Exception:
        pass
    return _default_registry()


def _save_registry(registry: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(registry, indent=2, sort_keys=True), encoding="utf-8")


def _find_job(registry: Dict[str, Any], job_id: str) -> Optional[Dict[str, Any]]:
    for job in registry.get("jobs", []):
        if str(job.get("id")) == str(job_id):
            return job
    return None


def _find_job_by_db_relpath(registry: Dict[str, Any], db_relpath: str) -> Optional[Dict[str, Any]]:
    target = str(db_relpath or "").strip()
    for job in registry.get("jobs", []):
        if str(job.get("db_relpath") or "").strip() == target:
            return job
    return None


def _slugify(value: str) -> str:
    out = []
    last_dash = False
    for ch in str(value or "").lower():
        if ch.isalnum():
            out.append(ch)
            last_dash = False
            continue
        if not last_dash:
            out.append("-")
            last_dash = True
    slug = "".join(out).strip("-")
    return slug or "region"


def _parse_json_request() -> Dict[str, Any]:
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


def _safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)


def _bbox_from_payload(payload: Dict[str, Any], preset: Optional[Dict[str, Any]]) -> Dict[str, float]:
    bbox_payload = payload.get("bbox") if isinstance(payload.get("bbox"), dict) else {}
    base = dict((preset or {}).get("bbox") or {})
    return {
        "lat_min": _safe_float(bbox_payload.get("lat_min", base.get("lat_min", 34.0)), 34.0),
        "lat_max": _safe_float(bbox_payload.get("lat_max", base.get("lat_max", 72.0)), 72.0),
        "lon_min": _safe_float(bbox_payload.get("lon_min", base.get("lon_min", -28.0)), -28.0),
        "lon_max": _safe_float(bbox_payload.get("lon_max", base.get("lon_max", 33.0)), 33.0),
    }


def _preset_by_slug(slug: str) -> Optional[Dict[str, Any]]:
    for preset in REGION_PRESETS:
        if str(preset.get("slug")) == str(slug):
            return preset
    return None


def _normalize_spec(payload: Dict[str, Any]) -> Dict[str, Any]:
    now_year = dt.date.today().year
    region_slug = str(payload.get("region_slug") or "europe-iceland").strip() or "europe-iceland"
    preset = _preset_by_slug(region_slug)
    region_label = str(payload.get("region_label") or (preset or {}).get("label") or region_slug).strip()
    bbox = _bbox_from_payload(payload, preset)
    start_year = _safe_int(payload.get("start_year"), now_year - 10)
    end_year = _safe_int(payload.get("end_year"), now_year - 1)
    if start_year > end_year:
        start_year, end_year = end_year, start_year
    chunk_count = max(1, _safe_int(payload.get("chunk_count"), 1))
    chunk_index = _safe_int(payload.get("chunk_index"), 0)
    if chunk_index < 0:
        chunk_index = 0
    if chunk_index >= chunk_count:
        chunk_index = chunk_count - 1
    return {
        "region_slug": region_slug,
        "region_label": region_label,
        "bbox": bbox,
        "start_year": start_year,
        "end_year": end_year,
        "tile_km": max(10.0, _safe_float(payload.get("tile_km"), 50.0)),
        "ocean": str(payload.get("ocean") or "coastal").strip().lower() or "coastal",
        "coastal_sea_km": max(0.0, _safe_float(payload.get("coastal_sea_km"), 50.0)),
        "chunk_years": max(1, _safe_int(payload.get("chunk_years"), 2)),
        "min_interval_s": max(0.25, _safe_float(payload.get("min_interval_s"), 1.15)),
        "chunk_count": chunk_count,
        "chunk_index": chunk_index,
        "pace_until_berlin_7am": bool(payload.get("pace_until_berlin_7am", False)),
    }


def _is_legacy_europe_job(spec: Dict[str, Any]) -> bool:
    bbox = spec["bbox"]
    return (
        spec.get("region_slug") == "europe-iceland"
        and float(spec.get("tile_km", 0)) == 50.0
        and str(spec.get("ocean")) == "coastal"
        and float(spec.get("coastal_sea_km", 0)) == 50.0
        and bbox == {"lat_min": 34.0, "lat_max": 72.0, "lon_min": -28.0, "lon_max": 33.0}
    )


def _db_relpath_for_spec(spec: Dict[str, Any]) -> str:
    if _is_legacy_europe_job(spec):
        if int(spec["start_year"]) == int(spec["end_year"]):
            return f"project/cache/offline_weather_{int(spec['start_year'])}.sqlite"
        now_year = dt.date.today().year
        if int(spec["start_year"]) == now_year - 10 and int(spec["end_year"]) == now_year - 1:
            return "project/cache/offline_weather.sqlite"
    region_slug = _slugify(spec.get("region_slug") or spec.get("region_label") or "region")
    km = int(round(float(spec["tile_km"])))
    return f"project/cache/offline_weather_{region_slug}_y{int(spec['start_year'])}-{int(spec['end_year'])}_{km}km.sqlite"


def _abs_from_rel(relpath: str) -> Path:
    rel = str(relpath or "").strip()
    if rel.startswith("/"):
        return Path(rel)
    return REPO_DIR / rel


def _db_relpath_from_any(path_value: str) -> str:
    raw = str(path_value or "").strip()
    if not raw:
        return ""
    path = Path(raw)
    if path.is_absolute():
        try:
            return os.path.relpath(str(path), str(REPO_DIR))
        except Exception:
            return str(path)
    return raw[2:] if raw.startswith("./") else raw


def _compute_tiles(spec: Dict[str, Any]) -> Dict[str, Any]:
    bbox = spec["bbox"]
    tiles = tile_grid_approx_50km(
        bbox["lat_min"],
        bbox["lat_max"],
        bbox["lon_min"],
        bbox["lon_max"],
        spec["tile_km"],
    )
    tiles.sort(key=lambda tile: (tile.row, tile.col))
    ocean_mode = str(spec.get("ocean") or "coastal").strip().lower()
    used_land_mask = False
    if ocean_mode in ("coastal", "none"):
        is_land_fn = _try_make_is_land_fn()
        if is_land_fn is None:
            ocean_mode = "all"
        else:
            used_land_mask = True
            kept = []
            coastal_km = float(spec.get("coastal_sea_km") or 0.0)
            for tile in tiles:
                if is_land_fn(tile.lat, tile.lon):
                    kept.append(tile)
                    continue
                if ocean_mode == "coastal" and _is_coastal_sea(tile.lat, tile.lon, coastal_km, is_land_fn):
                    kept.append(tile)
            tiles = kept
    chunk_count = max(1, int(spec["chunk_count"]))
    chunk_index = int(spec["chunk_index"])
    selected = [tile for idx, tile in enumerate(tiles) if (idx % chunk_count) == chunk_index]
    return {
        "tiles": tiles,
        "selected": selected,
        "ocean_mode_effective": ocean_mode,
        "used_land_mask": used_land_mask,
    }


def _read_db_summary(db_path: Path) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "db_path": str(db_path),
        "db_relpath": os.path.relpath(str(db_path), str(REPO_DIR)),
        "exists": db_path.exists(),
        "size_bytes": db_path.stat().st_size if db_path.exists() else 0,
        "meta": {},
        "tiles_total": 0,
        "done": 0,
        "building": 0,
        "error": 0,
        "status": "missing",
    }
    if not db_path.exists():
        return summary
    try:
        conn = sqlite3.connect(str(db_path))
        try:
            meta = {str(row[0]): row[1] for row in conn.execute("SELECT key, value FROM meta").fetchall()}
            summary["meta"] = meta
            summary["tiles_total"] = int(conn.execute("SELECT COUNT(*) FROM tiles").fetchone()[0])
            counts = {str(status): int(count) for status, count in conn.execute("SELECT status, COUNT(*) FROM build_state GROUP BY status").fetchall()}
            summary["done"] = int(counts.get("done", 0))
            summary["building"] = int(counts.get("building", 0))
            summary["error"] = int(counts.get("error", 0))
        finally:
            conn.close()
    except Exception as exc:
        summary["status"] = "unreadable"
        summary["read_error"] = str(exc)
        return summary
    if summary["building"] > 0:
        summary["status"] = "running"
    elif summary["error"] > 0:
        summary["status"] = "error"
    elif summary["tiles_total"] == 0:
        summary["status"] = "empty"
    elif summary["done"] >= summary["tiles_total"]:
        summary["status"] = "complete"
    else:
        summary["status"] = "partial"
    total = max(1, int(summary["tiles_total"]))
    summary["progress_pct"] = round(100.0 * float(summary["done"]) / float(total), 1) if summary["tiles_total"] else 0.0
    try:
        years = json.loads(summary["meta"].get("years") or "{}")
    except Exception:
        years = {}
    try:
        bbox = json.loads(summary["meta"].get("bbox") or "{}")
    except Exception:
        bbox = {}
    summary["years"] = years
    summary["bbox"] = bbox
    summary["tile_km"] = _safe_float(summary["meta"].get("tile_km"), 0.0)
    summary["last_build_started_at"] = summary["meta"].get("last_build_started_at")
    summary["last_build_finished_at"] = summary["meta"].get("last_build_finished_at")
    return summary


def _expected_full_tile_count(spec: Dict[str, Any]) -> int:
    bbox = dict(spec.get("bbox") or {})
    cache_key = json.dumps({
        "bbox": {
            "lat_min": round(_safe_float(bbox.get("lat_min"), 0.0), 4),
            "lat_max": round(_safe_float(bbox.get("lat_max"), 0.0), 4),
            "lon_min": round(_safe_float(bbox.get("lon_min"), 0.0), 4),
            "lon_max": round(_safe_float(bbox.get("lon_max"), 0.0), 4),
        },
        "tile_km": round(_safe_float(spec.get("tile_km"), 50.0), 4),
        "ocean": str(spec.get("ocean") or "coastal"),
        "coastal_sea_km": round(_safe_float(spec.get("coastal_sea_km"), 50.0), 4),
        "chunk_count": max(1, _safe_int(spec.get("chunk_count"), 1)),
        "chunk_index": max(0, _safe_int(spec.get("chunk_index"), 0)),
    }, sort_keys=True)
    cached = EXPECTED_TILE_COUNT_CACHE.get(cache_key)
    if cached is not None:
        return cached
    try:
        count = int(len(_compute_tiles(spec).get("tiles") or []))
    except Exception:
        count = 0
    EXPECTED_TILE_COUNT_CACHE[cache_key] = count
    return count


def _scan_active_builder_processes() -> Dict[str, Dict[str, Any]]:
    processes: Dict[str, Dict[str, Any]] = {}
    try:
        output = subprocess.check_output(["ps", "-ax", "-o", "pid=,command="], text=True)
    except Exception:
        return processes
    for raw_line in output.splitlines():
        line = str(raw_line or "").strip()
        if not line or "build_offline_tiles_openmeteo.py" not in line:
            continue
        m = re.match(r"^(\d+)\s+(.*)$", line)
        if not m:
            continue
        pid = int(m.group(1))
        command = m.group(2)
        try:
            argv = shlex.split(command)
        except Exception:
            argv = command.split()
        arg_map: Dict[str, Any] = {}
        idx = 0
        while idx < len(argv):
            token = argv[idx]
            if token.startswith("--"):
                if idx + 1 < len(argv) and not argv[idx + 1].startswith("--"):
                    arg_map[token] = argv[idx + 1]
                    idx += 2
                    continue
                arg_map[token] = True
            idx += 1
        db_relpath = _db_relpath_from_any(str(arg_map.get("--db") or ""))
        if not db_relpath:
            continue
        processes[db_relpath] = {
            "pid": pid,
            "command": command,
            "argv": argv,
            "args": arg_map,
            "db_relpath": db_relpath,
        }
    return processes


def _infer_years_from_relpath(db_relpath: str) -> Dict[str, int]:
    m = re.search(r"offline_weather_(\d{4})(?:\.sqlite|_)", str(db_relpath or ""))
    if m:
        year = int(m.group(1))
        return {"start": year, "end": year}
    now_year = dt.date.today().year
    return {"start": now_year - 10, "end": now_year - 1}


def _infer_region_from_bbox(bbox: Dict[str, Any]) -> Dict[str, str]:
    for preset in REGION_PRESETS:
        if dict(preset.get("bbox") or {}) == dict(bbox or {}):
            return {
                "slug": str(preset.get("slug") or "custom"),
                "label": str(preset.get("label") or "Custom Region"),
            }
    return {"slug": "custom", "label": "Custom Region"}


def _spec_from_db_summary(summary: Dict[str, Any], active_process: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    meta = dict(summary.get("meta") or {})
    years = dict(summary.get("years") or {})
    bbox = dict(summary.get("bbox") or {})
    if not years:
        years = _infer_years_from_relpath(str(summary.get("db_relpath") or ""))
    if not bbox:
        bbox = dict((_preset_by_slug("europe-iceland") or {}).get("bbox") or {})
    region = _infer_region_from_bbox(bbox)
    spec = {
        "region_slug": region["slug"],
        "region_label": region["label"],
        "bbox": {
            "lat_min": _safe_float(bbox.get("lat_min"), 34.0),
            "lat_max": _safe_float(bbox.get("lat_max"), 72.0),
            "lon_min": _safe_float(bbox.get("lon_min"), -28.0),
            "lon_max": _safe_float(bbox.get("lon_max"), 33.0),
        },
        "start_year": _safe_int(years.get("start"), dt.date.today().year - 10),
        "end_year": _safe_int(years.get("end"), dt.date.today().year - 1),
        "tile_km": max(10.0, _safe_float(summary.get("tile_km"), 50.0)),
        "ocean": "coastal",
        "coastal_sea_km": 50.0,
        "chunk_years": max(1, _safe_int(meta.get("chunk_years"), 2)),
        "min_interval_s": max(0.25, _safe_float(meta.get("min_interval_s_effective"), 1.15)),
        "chunk_count": 1,
        "chunk_index": 0,
        "pace_until_berlin_7am": False,
    }
    if active_process:
        args = dict(active_process.get("args") or {})
        spec.update({
            "start_year": _safe_int(args.get("--start-year"), spec["start_year"]),
            "end_year": _safe_int(args.get("--end-year"), spec["end_year"]),
            "tile_km": max(10.0, _safe_float(args.get("--tile-km"), spec["tile_km"])),
            "ocean": str(args.get("--ocean") or spec["ocean"]),
            "coastal_sea_km": max(0.0, _safe_float(args.get("--coastal-sea-km"), spec["coastal_sea_km"])),
            "chunk_years": max(1, _safe_int(args.get("--chunk-years"), spec["chunk_years"])),
            "min_interval_s": max(0.25, _safe_float(args.get("--min-interval-s"), spec["min_interval_s"])),
            "chunk_count": max(1, _safe_int(args.get("--chunk-count"), spec["chunk_count"])),
            "chunk_index": max(0, _safe_int(args.get("--chunk-index"), spec["chunk_index"])),
            "pace_until_berlin_7am": bool(args.get("--pace-until-berlin-7am", False)),
            "bbox": {
                "lat_min": _safe_float(args.get("--lat-min"), spec["bbox"]["lat_min"]),
                "lat_max": _safe_float(args.get("--lat-max"), spec["bbox"]["lat_max"]),
                "lon_min": _safe_float(args.get("--lon-min"), spec["bbox"]["lon_min"]),
                "lon_max": _safe_float(args.get("--lon-max"), spec["bbox"]["lon_max"]),
            },
        })
        region = _infer_region_from_bbox(spec["bbox"])
        spec["region_slug"] = region["slug"]
        spec["region_label"] = region["label"]
    return spec


def _managed_job_id_for_db(db_relpath: str) -> str:
    return f"db-{_slugify(db_relpath)}"[:64]


def _manager_status_from_summary(summary: Dict[str, Any], active_process: Optional[Dict[str, Any]] = None) -> str:
    raw_status = str(summary.get("status") or "partial")
    if active_process:
        return "running"
    if raw_status == "running":
        return "stalled"
    return raw_status


def _create_managed_job_from_summary(summary: Dict[str, Any], active_process: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    spec = _spec_from_db_summary(summary, active_process=active_process)
    return {
        "id": _managed_job_id_for_db(str(summary.get("db_relpath") or "dataset")),
        "label": f"{spec['region_label']} {spec['start_year']}-{spec['end_year']}",
        "status": _manager_status_from_summary(summary, active_process=active_process),
        "created_at": utc_now_iso(),
        "spec": spec,
        "db_relpath": str(summary.get("db_relpath") or ""),
        "estimate": _estimate(spec),
        "pid": int(active_process.get("pid")) if active_process else None,
        "log_path": None,
        "command": active_process.get("argv") if active_process else None,
        "last_exit_code": None,
        "source": "adopted-dataset",
    }


def _estimate(spec: Dict[str, Any]) -> Dict[str, Any]:
    tiles_info = _compute_tiles(spec)
    years = max(1, int(spec["end_year"]) - int(spec["start_year"]) + 1)
    year_chunks = int(math.ceil(float(years) / float(max(1, int(spec["chunk_years"])))) )
    expected_requests_per_tile = 2 * year_chunks
    selected = tiles_info["selected"]
    total_requests = len(selected) * expected_requests_per_tile
    estimated_seconds = float(total_requests) * float(spec["min_interval_s"])
    db_relpath = _db_relpath_for_spec(spec)
    db_summary = _read_db_summary(_abs_from_rel(db_relpath))
    return {
        "spec": spec,
        "db_relpath": db_relpath,
        "db_summary": db_summary,
        "expected_full_tiles": len(tiles_info["tiles"]),
        "expected_selected_tiles": len(selected),
        "chunk_count": int(spec["chunk_count"]),
        "chunk_index": int(spec["chunk_index"]),
        "ocean_mode_effective": tiles_info["ocean_mode_effective"],
        "used_land_mask": bool(tiles_info["used_land_mask"]),
        "expected_requests_per_tile": expected_requests_per_tile,
        "expected_requests_total": total_requests,
        "estimated_seconds": estimated_seconds,
        "estimated_hours": round(estimated_seconds / 3600.0, 2),
    }


def _tail_log(log_path: Path, max_lines: int = 120) -> str:
    try:
        if not log_path.exists():
            return ""
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[-max_lines:])
    except Exception:
        return ""


def _is_pid_alive(pid: int) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False


def _job_runtime_state(job: Dict[str, Any], db_summary: Dict[str, Any]) -> Dict[str, Any]:
    state = dict(job)
    prior_status = str(job.get("status") or "")
    pid = _safe_int(job.get("pid"), 0)
    proc = PROCESS_BY_JOB_ID.get(str(job.get("id")))
    if proc is not None:
        rc = proc.poll()
        if rc is None:
            state["status"] = "running"
            state["pid"] = proc.pid
        else:
            state["pid"] = None
            state["last_exit_code"] = int(rc)
            if prior_status == "stopping":
                state["status"] = "stopped"
            else:
                state["status"] = "completed" if rc == 0 else "failed"
            state.setdefault("finished_at", utc_now_iso())
            PROCESS_BY_JOB_ID.pop(str(job.get("id")), None)
    elif pid > 0 and prior_status in {"running", "queued", "stopping"}:
        if _is_pid_alive(pid):
            state["status"] = "running" if prior_status != "stopping" else "stopping"
        else:
            state["pid"] = None
            if prior_status == "stopping":
                state["status"] = "stopped"
            else:
                finished_at = str(db_summary.get("last_build_finished_at") or "")
                started_at = str(job.get("started_at") or "")
                state["status"] = "completed" if finished_at and finished_at >= started_at else "failed"
            state.setdefault("finished_at", utc_now_iso())
    elif prior_status in {"running", "queued", "stopping"}:
        if prior_status == "stopping":
            state["status"] = "stopped"
        else:
            db_status = str(db_summary.get("status") or "").lower()
            if db_status in {"partial", "error", "empty", "missing", "unreadable"}:
                state["status"] = "stalled"
            elif db_status in {"complete", "completed"}:
                state["status"] = "completed"
            else:
                state["status"] = "failed"
        state["pid"] = None
        state.setdefault("finished_at", utc_now_iso())
    state["db_summary"] = db_summary
    log_path = state.get("log_path")
    if log_path:
        state["log_tail"] = _tail_log(_abs_from_rel(str(log_path)))
    else:
        state["log_tail"] = ""
    status = str(state.get("status") or "")
    state["can_resume"] = status in {"stopped", "stalled", "partial", "error", "failed", "completed", "complete", "empty"}
    state["can_stop"] = status in {"running", "queued", "stopping"}
    state["can_kill"] = status in {"running", "queued", "stopping"}
    state["can_remove_job"] = status not in {"running", "queued", "stopping"}
    return state


def _delete_database_files(db_relpath: str) -> None:
    db_abs = _abs_from_rel(str(db_relpath or ""))
    for suffix in ("", "-wal", "-shm"):
        try:
            target = Path(str(db_abs) + suffix)
            if target.exists():
                target.unlink()
        except Exception:
            pass


def _remove_jobs_for_db_relpath(registry: Dict[str, Any], db_relpath: str) -> None:
    target = str(db_relpath or "")
    registry["jobs"] = [
        entry for entry in registry.get("jobs", [])
        if str(entry.get("db_relpath") or "") != target
    ]


def _sync_registry_state(registry: Dict[str, Any], active_processes: Optional[Dict[str, Dict[str, Any]]] = None) -> Dict[str, Any]:
    active_processes = active_processes if active_processes is not None else _scan_active_builder_processes()
    for db_relpath, active_process in active_processes.items():
        existing = _find_job_by_db_relpath(registry, db_relpath)
        if existing is None:
            summary = _read_db_summary(_abs_from_rel(db_relpath))
            registry.setdefault("jobs", []).append(_create_managed_job_from_summary(summary, active_process=active_process))
            continue
        existing["pid"] = int(active_process.get("pid") or 0)
        existing["command"] = active_process.get("argv") or existing.get("command")
        existing["status"] = "running"
        existing["spec"] = _spec_from_db_summary(_read_db_summary(_abs_from_rel(db_relpath)), active_process=active_process)
    changed = False
    synced_jobs: List[Dict[str, Any]] = []
    for job in registry.get("jobs", []):
        db_summary = _read_db_summary(_abs_from_rel(str(job.get("db_relpath") or "")))
        synced = _job_runtime_state(job, db_summary)
        if synced != job:
            changed = True
        synced_jobs.append(synced)
    registry["jobs"] = synced_jobs
    if changed:
        _save_registry(registry)
    return registry


def _discover_datasets(registry: Dict[str, Any], active_processes: Optional[Dict[str, Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    active_processes = active_processes if active_processes is not None else _scan_active_builder_processes()
    datasets = []
    for db_path in sorted(CACHE_DIR.glob("offline_weather*.sqlite")):
        summary = _read_db_summary(db_path)
        spec_for_expected = _spec_from_db_summary(summary, active_process=active_processes.get(str(summary.get("db_relpath") or "")))
        summary["expected_full_tiles"] = _expected_full_tile_count(spec_for_expected)
        summary["tiles_present"] = int(summary.get("tiles_total") or 0)
        job = _find_job_by_db_relpath(registry, str(summary.get("db_relpath") or ""))
        active_process = active_processes.get(str(summary.get("db_relpath") or ""))
        summary["managed"] = bool(job)
        summary["job_id"] = job.get("id") if job else None
        if active_process:
            summary["status"] = "running"
            summary["active_pid"] = int(active_process.get("pid") or 0)
            summary["active_command"] = active_process.get("command")
        elif job:
            summary["active_pid"] = job.get("pid")
            summary["active_command"] = " ".join(job.get("command") or []) if isinstance(job.get("command"), list) else job.get("command")
        if summary.get("status") == "running" and not summary.get("active_pid"):
            summary["status"] = "stalled"
        summary["can_stop"] = bool(summary.get("active_pid"))
        summary["can_kill"] = bool(summary.get("active_pid"))
        summary["can_load_missing"] = summary.get("status") in {"stopped", "stalled", "partial", "error", "failed", "empty"}
        summary["can_delete_db"] = not bool(summary.get("active_pid"))
        datasets.append(summary)
    return datasets


def _command_for_job(job: Dict[str, Any]) -> List[str]:
    spec = job["spec"]
    py = REPO_DIR / ".venv" / "bin" / "python"
    python_cmd = str(py if py.exists() else "python3")
    command = [
        python_cmd,
        "project/offline/build_offline_tiles_openmeteo.py",
        "--db",
        str(job["db_relpath"]),
        "--start-year",
        str(spec["start_year"]),
        "--end-year",
        str(spec["end_year"]),
        "--lat-min",
        str(spec["bbox"]["lat_min"]),
        "--lat-max",
        str(spec["bbox"]["lat_max"]),
        "--lon-min",
        str(spec["bbox"]["lon_min"]),
        "--lon-max",
        str(spec["bbox"]["lon_max"]),
        "--tile-km",
        str(spec["tile_km"]),
        "--ocean",
        str(spec["ocean"]),
        "--coastal-sea-km",
        str(spec["coastal_sea_km"]),
        "--chunk-years",
        str(spec["chunk_years"]),
        "--min-interval-s",
        str(spec["min_interval_s"]),
        "--chunk-count",
        str(spec["chunk_count"]),
        "--chunk-index",
        str(spec["chunk_index"]),
    ]
    if spec.get("pace_until_berlin_7am"):
        command.append("--pace-until-berlin-7am")
    return command


def _start_job_process(job: Dict[str, Any]) -> Dict[str, Any]:
    log_relpath = f"project/debug_output/offline_manager_job_{job['id']}.log"
    log_abs = _abs_from_rel(log_relpath)
    log_abs.parent.mkdir(parents=True, exist_ok=True)
    cmd = _command_for_job(job)
    with log_abs.open("ab") as log_file:
        proc = subprocess.Popen(
            cmd,
            cwd=str(REPO_DIR),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    PROCESS_BY_JOB_ID[str(job["id"])] = proc
    job["status"] = "running"
    job["pid"] = int(proc.pid)
    job["started_at"] = utc_now_iso()
    job["finished_at"] = None
    job["last_exit_code"] = None
    job["log_path"] = log_relpath
    job["command"] = cmd
    return job


def _kill_job(job: Dict[str, Any], sig: int = signal.SIGTERM) -> None:
    pid = _safe_int(job.get("pid"), 0)
    if pid <= 0:
        return
    try:
        os.killpg(pid, sig)
    except Exception:
        try:
            os.kill(pid, sig)
        except Exception:
            pass


def _dataset_for_control(registry: Dict[str, Any], db_relpath: str) -> Dict[str, Any]:
    normalized = _db_relpath_from_any(db_relpath)
    if not normalized:
        raise ValueError("dataset_missing")
    summary = _read_db_summary(_abs_from_rel(normalized))
    if not summary.get("exists"):
        raise FileNotFoundError(normalized)
    active_process = _scan_active_builder_processes().get(normalized)
    summary["status"] = _manager_status_from_summary(summary, active_process=active_process)
    job = _find_job_by_db_relpath(registry, normalized)
    if job is None:
        job = _create_managed_job_from_summary(summary, active_process=active_process)
        registry.setdefault("jobs", []).append(job)
    return job


def _restart_job(job: Dict[str, Any], reason: str) -> Dict[str, Any]:
    job[f"{reason}_at"] = utc_now_iso()
    return _start_job_process(job)


@app.route("/")
def manager_index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/presets")
def api_presets():
    return jsonify({"presets": REGION_PRESETS})


@app.post("/api/estimate")
def api_estimate():
    spec = _normalize_spec(_parse_json_request())
    return jsonify(_estimate(spec))


@app.get("/api/jobs")
def api_jobs():
    with LOCK:
        active_processes = _scan_active_builder_processes()
        registry = _sync_registry_state(_load_registry(), active_processes=active_processes)
        jobs = list(registry.get("jobs", []))
        datasets = _discover_datasets(registry, active_processes=active_processes)
    return jsonify({"jobs": jobs, "datasets": datasets, "presets": REGION_PRESETS})


@app.post("/api/jobs")
def api_create_job():
    payload = _parse_json_request()
    spec = _normalize_spec(payload)
    estimate = _estimate(spec)
    job_id = str(uuid.uuid4())[:8]
    job = {
        "id": job_id,
        "label": str(payload.get("label") or f"{spec['region_label']} {spec['start_year']}-{spec['end_year']}").strip(),
        "status": "queued",
        "created_at": utc_now_iso(),
        "spec": spec,
        "db_relpath": estimate["db_relpath"],
        "estimate": estimate,
        "pid": None,
        "log_path": None,
        "command": None,
        "last_exit_code": None,
    }
    with LOCK:
        registry = _sync_registry_state(_load_registry())
        registry.setdefault("jobs", []).append(_start_job_process(job))
        _save_registry(registry)
        created = _find_job(registry, job_id)
    return jsonify(created), 201


@app.post("/api/jobs/<job_id>/stop")
def api_stop_job(job_id: str):
    with LOCK:
        registry = _sync_registry_state(_load_registry())
        job = _find_job(registry, job_id)
        if not job:
            return jsonify({"error": "job_not_found"}), 404
        if str(job.get("status")) not in {"running", "queued"}:
            return jsonify({"error": "job_not_running", "job": job}), 409
        job["status"] = "stopping"
        job["stopped_requested_at"] = utc_now_iso()
        _kill_job(job)
        _save_registry(registry)
    return jsonify(job)


@app.post("/api/jobs/<job_id>/kill")
def api_kill_job(job_id: str):
    with LOCK:
        registry = _sync_registry_state(_load_registry())
        job = _find_job(registry, job_id)
        if not job:
            return jsonify({"error": "job_not_found"}), 404
        if str(job.get("status")) not in {"running", "queued", "stopping"}:
            return jsonify({"error": "job_not_running", "job": job}), 409
        job["status"] = "stopping"
        job["killed_requested_at"] = utc_now_iso()
        _kill_job(job, sig=signal.SIGKILL)
        _save_registry(registry)
    return jsonify(job)


@app.post("/api/jobs/<job_id>/restart")
def api_restart_job(job_id: str):
    with LOCK:
        registry = _sync_registry_state(_load_registry())
        job = _find_job(registry, job_id)
        if not job:
            return jsonify({"error": "job_not_found"}), 404
        if str(job.get("status")) in {"running", "queued", "stopping"}:
            return jsonify({"ok": True, "already_running": True, "job": job})
        _restart_job(job, reason="restarted")
        _save_registry(registry)
    return jsonify(job)


@app.post("/api/jobs/<job_id>/resume")
def api_resume_job(job_id: str):
    return api_restart_job(job_id)


@app.delete("/api/jobs/<job_id>")
def api_discard_job(job_id: str):
    with LOCK:
        registry = _sync_registry_state(_load_registry())
        job = _find_job(registry, job_id)
        if not job:
            return jsonify({"error": "job_not_found"}), 404
        if str(job.get("status")) in {"running", "queued", "stopping"}:
            return jsonify({"error": "job_running"}), 409
        log_path = str(job.get("log_path") or "").strip()
        if log_path:
            try:
                _abs_from_rel(log_path).unlink(missing_ok=True)
            except Exception:
                pass
        registry["jobs"] = [entry for entry in registry.get("jobs", []) if str(entry.get("id")) != str(job_id)]
        _save_registry(registry)
    return jsonify({"removed": True, "id": job_id})


@app.get("/api/jobs/<job_id>/log")
def api_job_log(job_id: str):
    with LOCK:
        registry = _sync_registry_state(_load_registry())
        job = _find_job(registry, job_id)
        if not job:
            return jsonify({"error": "job_not_found"}), 404
        log_path = str(job.get("log_path") or "").strip()
        log_text = _tail_log(_abs_from_rel(log_path)) if log_path else ""
    return jsonify({"id": job_id, "log_path": log_path, "log_tail": log_text})


@app.post("/api/datasets/control")
def api_dataset_control():
    payload = _parse_json_request()
    db_relpath = _db_relpath_from_any(str(payload.get("db_relpath") or ""))
    action = str(payload.get("action") or "").strip().lower()
    if action not in {"stop", "kill", "load-missing", "delete-db"}:
        return jsonify({"error": "unsupported_action"}), 400
    try:
        with LOCK:
            registry = _sync_registry_state(_load_registry())
            job = _dataset_for_control(registry, db_relpath)
            if action == "stop":
                if str(job.get("status")) not in {"running", "queued", "stopping"}:
                    return jsonify({"error": "job_not_running", "job": job}), 409
                job["status"] = "stopping"
                job["stopped_requested_at"] = utc_now_iso()
                _kill_job(job)
            elif action == "kill":
                if str(job.get("status")) not in {"running", "queued", "stopping"}:
                    return jsonify({"error": "job_not_running", "job": job}), 409
                job["status"] = "stopping"
                job["killed_requested_at"] = utc_now_iso()
                _kill_job(job, sig=signal.SIGKILL)
            elif action == "load-missing":
                if str(job.get("status")) in {"running", "queued", "stopping"}:
                    datasets = _discover_datasets(registry)
                    dataset = next((entry for entry in datasets if str(entry.get("db_relpath") or "") == db_relpath), None)
                    return jsonify({"ok": True, "already_running": True, "job": job, "dataset": dataset})
                _restart_job(job, reason="load_missing")
            elif action == "delete-db":
                if str(job.get("status")) in {"running", "queued", "stopping"}:
                    return jsonify({"error": "job_running", "job": job}), 409
                _delete_database_files(db_relpath)
                _remove_jobs_for_db_relpath(registry, db_relpath)
            _save_registry(registry)
            updated_job = _find_job_by_db_relpath(registry, db_relpath)
            datasets = _discover_datasets(registry)
            dataset = next((entry for entry in datasets if str(entry.get("db_relpath") or "") == db_relpath), None)
    except FileNotFoundError:
        return jsonify({"error": "dataset_not_found"}), 404
    except ValueError:
        return jsonify({"error": "dataset_missing"}), 400
    return jsonify({"ok": True, "job": updated_job, "dataset": dataset})


@app.get("/api/health")
def api_health():
    return jsonify({"ok": True, "time": utc_now_iso()})


if __name__ == "__main__":
    host = os.environ.get("OFFLINE_TILE_MANAGER_HOST", "127.0.0.1")
    port = _safe_int(os.environ.get("OFFLINE_TILE_MANAGER_PORT"), DEFAULT_PORT)
    app.run(host=host, port=port, debug=False)