#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import mimetypes
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


DEFAULT_GPX = Path(__file__).resolve().parents[1] / 'data' / 'realistic_routes' / 'real_route_2_milano_rome.gpx'


def _request(url: str, *, method: str = 'GET', body: bytes | None = None, headers: dict[str, str] | None = None, timeout: float = 30.0) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return int(response.status), response.read()


def _json_request(url: str, *, method: str = 'GET', body: bytes | None = None, headers: dict[str, str] | None = None, timeout: float = 30.0) -> dict:
    status, payload = _request(url, method=method, body=body, headers=headers, timeout=timeout)
    if status != 200:
        raise RuntimeError(f'Unexpected HTTP {status} for {url}')
    return json.loads(payload.decode('utf-8'))


def _multipart_body(file_path: Path) -> tuple[bytes, str]:
    boundary = f'wm-boundary-{uuid.uuid4().hex}'
    file_bytes = file_path.read_bytes()
    content_type = mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'
    parts = [
        f'--{boundary}\r\n'.encode('utf-8'),
        f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'.encode('utf-8'),
        f'Content-Type: {content_type}\r\n\r\n'.encode('utf-8'),
        file_bytes,
        b'\r\n',
        f'--{boundary}--\r\n'.encode('utf-8'),
    ]
    return b''.join(parts), boundary


def _parse_sse_events(text: str) -> list[tuple[str, str]]:
    events: list[tuple[str, str]] = []
    current_event = 'message'
    current_data: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.rstrip('\r')
        if not line:
            if current_data:
                events.append((current_event, '\n'.join(current_data)))
            current_event = 'message'
            current_data = []
            continue
        if line.startswith('event: '):
            current_event = line[7:].strip()
            continue
        if line.startswith('data: '):
            current_data.append(line[6:])
    if current_data:
        events.append((current_event, '\n'.join(current_data)))
    return events


def wait_for_server(base_url: str, timeout: float) -> None:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            payload = _json_request(f'{base_url}/api/session', timeout=5.0)
            if payload.get('session_id'):
                return
        except Exception as exc:  # pragma: no cover - best effort polling
            last_error = exc
        time.sleep(1.0)
    raise RuntimeError(f'Server did not become ready at {base_url}: {last_error}')


def run_route_smoke(
    base_url: str,
    gpx_path: Path,
    *,
    total_days: int,
    hist_start: int,
    hist_years: int,
    offline_only: bool,
    dry_run: bool,
) -> dict:
    session_payload = _json_request(f'{base_url}/api/session')
    if not session_payload.get('session_id'):
        raise RuntimeError('Session creation failed')

    body, boundary = _multipart_body(gpx_path)
    upload_payload = _json_request(
        f'{base_url}/api/upload_gpx',
        method='POST',
        body=body,
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
        timeout=120.0,
    )
    route_path = upload_payload.get('path')
    if not route_path:
        raise RuntimeError('GPX upload did not return a path')

    query = {
        'date': '05-12',
        'tour_planning': '1',
        'mode': 'single_day',
        'start_date': '2026-05-12',
        'total_days': str(total_days),
        'gpx_path': str(route_path),
        'step_km': '25',
        'profile_step_km': '8',
        'reuse_per_day': '1',
        'hist_start': str(hist_start),
        'hist_years': str(hist_years),
    }
    if offline_only:
        query['offline_only'] = '1'
    if dry_run:
        query['dry_run'] = '1'
    stream_url = f"{base_url}/api/map_stream?{urllib.parse.urlencode(query)}"
    status, payload = _request(stream_url, timeout=240.0)
    if status != 200:
        raise RuntimeError(f'map_stream returned HTTP {status}')

    text = payload.decode('utf-8', errors='replace')
    events = _parse_sse_events(text)
    names = [name for name, _data in events]
    if 'error' in names:
        raise RuntimeError('SSE emitted an error event')
    if 'route' not in names:
        raise RuntimeError('SSE stream did not emit a route event')
    if 'done' not in names:
        raise RuntimeError('SSE stream did not emit a done event')
    if not dry_run and 'station' not in names:
        raise RuntimeError('SSE stream did not emit any station events')

    done_payload = {}
    for name, data in reversed(events):
        if name == 'done':
            done_payload = json.loads(data)
            break
    return {
        'events': names,
        'done': done_payload,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description='Restart/proxy smoke runner for a deployed WeatherMap backend.')
    parser.add_argument('--base-url', default='http://127.0.0.1:5002', help='Backend base URL, for example http://127.0.0.1:5002')
    parser.add_argument('--gpx', type=Path, default=DEFAULT_GPX, help='GPX file to upload during the smoke run')
    parser.add_argument('--restart-command', help='Optional shell command that restarts the backend or proxy between the two smoke passes')
    parser.add_argument('--wait-timeout', type=float, default=90.0, help='Seconds to wait for the backend to become ready')
    parser.add_argument('--total-days', type=int, default=8, help='Tour length used for the smoke route')
    parser.add_argument('--hist-start', type=int, default=2024, help='Historical window start year')
    parser.add_argument('--hist-years', type=int, default=1, help='Historical window length in years')
    parser.add_argument('--offline-only', action='store_true', default=True, help='Force offline-only route streaming')
    parser.add_argument('--no-offline-only', dest='offline_only', action='store_false', help='Allow online fallback during the smoke run')
    parser.add_argument('--dry-run', action='store_true', help='Use dry_run=1 for a lightweight route/profile-only smoke')
    args = parser.parse_args()

    if not args.gpx.exists():
        raise SystemExit(f'GPX not found: {args.gpx}')

    wait_for_server(args.base_url, args.wait_timeout)
    first = run_route_smoke(
        args.base_url,
        args.gpx,
        total_days=args.total_days,
        hist_start=args.hist_start,
        hist_years=args.hist_years,
        offline_only=args.offline_only,
        dry_run=args.dry_run,
    )
    print(json.dumps({'phase': 'before_restart', **first}, indent=2))

    if not args.restart_command:
        return 0

    subprocess.run(args.restart_command, shell=True, check=True)
    wait_for_server(args.base_url, args.wait_timeout)
    second = run_route_smoke(
        args.base_url,
        args.gpx,
        total_days=args.total_days,
        hist_start=args.hist_start,
        hist_years=args.hist_years,
        offline_only=args.offline_only,
        dry_run=args.dry_run,
    )
    print(json.dumps({'phase': 'after_restart', **second}, indent=2))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except urllib.error.URLError as exc:
        print(f'Network error: {exc}', file=sys.stderr)
        raise SystemExit(1)
    except subprocess.CalledProcessError as exc:
        print(f'Restart command failed with exit code {exc.returncode}', file=sys.stderr)
        raise SystemExit(exc.returncode or 1)
    except Exception as exc:
        print(f'Smoke run failed: {exc}', file=sys.stderr)
        raise SystemExit(1)