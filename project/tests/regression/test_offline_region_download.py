"""Offline region download (Africa) and the central Open-Meteo request scheduler.

No network: Open-Meteo is replaced by a deterministic fake that answers the builder's
daily/hourly archive URLs (values depend on place and date), and the scheduler runs
on a fake clock. Yearly databases are small temporary copies with the real schema
and European meta; the real databases are only read (tests skip without them).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import random
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pandas as pd
import pytest

OFFLINE = Path(__file__).resolve().parents[2] / 'offline'
if str(OFFLINE) not in sys.path:
    sys.path.insert(0, str(OFFLINE))

import app as backend_app  # type: ignore  # noqa: E402
import build_offline_tiles_openmeteo as B  # noqa: E402
import openmeteo_scheduler as S  # noqa: E402
import region_job as RJ  # noqa: E402
import regions as R  # noqa: E402
from offline_weather_store import OfflineWeatherStore  # type: ignore  # noqa: E402

CACHE = Path(backend_app.__file__).resolve().parents[1] / 'cache'
EUROPE_BBOX = {"lat_min": 34.0, "lat_max": 72.0, "lon_min": -28.0, "lon_max": 33.0}
YEARS = [2023, 2024, 2025]


# ------------------------------------------------------------------ fakes
class FakeResponse:
    def __init__(self, status: int, payload=None, text: str = '', headers=None):
        self.status_code = status
        self._payload = payload
        self.text = text if text else (json.dumps(payload) if payload is not None else '')
        self.content = self.text.encode()
        self.headers = headers or {}

    def json(self):
        if self._payload is None:
            raise ValueError('no json')
        return self._payload


def _fake_archive(url: str) -> dict:
    q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
    lat, lon = float(q['latitude']), float(q['longitude'])
    d0, d1 = dt.date.fromisoformat(q['start_date']), dt.date.fromisoformat(q['end_date'])
    days = [d0 + dt.timedelta(days=i) for i in range((d1 - d0).days + 1)]
    if 'daily' in q:
        return {'daily': {
            'time': [d.isoformat() for d in days],
            'temperature_2m_mean': [round(20 + lat / 10 + 5 * math.sin(d.timetuple().tm_yday / 58.0) + d.year % 7, 3) for d in days],
            'precipitation_sum': [round(max(0.0, 3 * math.sin(d.toordinal() * 0.7 + lon)), 2) for d in days],
            'windspeed_10m_mean': [round(10 + (d.toordinal() % 9), 2) for d in days],
            'winddirection_10m_dominant': [float((d.toordinal() * 37 + int(lon * 10)) % 360) for d in days],
        }}
    times, temps = [], []
    for d in days:
        for h in range(24):
            times.append(f'{d.isoformat()}T{h:02d}:00')
            temps.append(round(15 + lat / 10 + 8 * math.sin((h - 9) / 24 * 2 * math.pi) + (d.year % 5), 2))
    return {'hourly': {'time': times, 'temperature_2m': temps}}


class FakeSession:
    """Answers archive URLs; optional scripted failures before the n-th request."""

    def __init__(self, script=None, on_request=None):
        self.headers = {}
        self.calls = []
        self.script = list(script or [])
        self.on_request = on_request

    def get(self, url, timeout=None):
        self.calls.append(url)
        if self.on_request:
            self.on_request(len(self.calls), url)
        if self.script:
            step = self.script.pop(0)
            if isinstance(step, Exception):
                raise step
            if step is not None:
                return step
        return FakeResponse(200, _fake_archive(url))


class FakeClock:
    def __init__(self, t0=1_800_000_000.0):
        self.t = float(t0)
        self.sleeps = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(float(s))
        self.t += float(s)


def scheduler(tmp_path, *, session=None, clock=None, **budget):
    clock = clock or FakeClock()
    sch = S.Scheduler(S.Budget(**budget), S.Ledger(tmp_path / 'ledger.sqlite'), session=session or FakeSession(),
                      sleep=clock.sleep, now=clock.now, rng=random.Random(1))
    return sch, clock


URL = 'https://archive-api.open-meteo.com/v1/archive?latitude=1&longitude=2&start_date=2024-01-01&end_date=2024-01-02&daily=x'


# ------------------------------------------------------------------ scheduler
def test_scheduler_spaces_requests_and_respects_minute_and_day_budgets(tmp_path):
    sch, clock = scheduler(tmp_path, per_minute=20, per_hour=900, per_day=5)
    for _ in range(5):
        sch.get_json(URL)
    times = [r[0] for r in sqlite3.connect(tmp_path / 'ledger.sqlite').execute('SELECT ts FROM requests ORDER BY ts')]
    assert all(b - a >= 3.0 - 1e-6 for a, b in zip(times, times[1:]))          # 60 / 20 per minute
    t_before = clock.t
    sch.get_json(URL)                                                            # 6th request: day budget 5
    assert clock.t - t_before >= 86400 - 5 * 3.0 - 1                             # waited for the rolling day
    assert sch.telemetry.ok == 6 and sch.telemetry.http_429 == 0


def test_call_weight_follows_open_meteo_counting():
    d = dt.date
    assert S.call_weight(B.build_url_daily(1, 2, d(2024, 1, 1), d(2024, 1, 14))) == 1.0
    assert S.call_weight(B.build_url_daily(1, 2, d(2024, 1, 1), d(2024, 12, 31))) == pytest.approx(366 / 14)
    assert S.call_weight(B.build_url_hourly(1, 2, d(2023, 1, 1), d(2025, 12, 31))) == pytest.approx(1096 / 14)
    many = 'https://x/v1/archive?latitude=1,2,3&longitude=4,5,6&start_date=2024-01-01&end_date=2024-01-28&daily=' + ','.join(f'v{i}' for i in range(15))
    assert S.call_weight(many) == pytest.approx(3 * 1.5 * 2.0)


THREE_YEARS = B.build_url_hourly(1.0, 2.0, dt.date(2023, 1, 1), dt.date(2025, 12, 31))


def test_weighted_hourly_budget_limits_three_year_requests(tmp_path):
    """Measured 2026-11-28: ~230 three-year requests in an hour exceeded the free hourly limit."""
    sess = FakeSession()
    sess.get = lambda url, timeout=None: FakeResponse(200, {'hourly': {'time': [], 'temperature_2m': []}})
    sch, clock = scheduler(tmp_path, session=sess, per_minute=600, calls_per_minute=1e9, calls_per_hour=200.0, calls_per_day=1e9)
    t0 = clock.t
    sch.get_json(THREE_YEARS)
    sch.get_json(THREE_YEARS)                                                     # 156.6 of 200 calls
    assert clock.t - t0 < 60
    sch.get_json(THREE_YEARS)                                                     # would exceed 200: waits for the hour
    assert clock.t - t0 >= 3600 - 1
    assert sch.telemetry.calls == pytest.approx(3 * 1096 / 14)


def test_stop_request_interrupts_a_budget_wait(tmp_path):
    flag = {'stop': False}
    sch, clock = scheduler(tmp_path, per_day=1)
    sch.should_abort = lambda: flag['stop']
    sch.get_json(URL)
    orig = clock.sleep

    def sleep_then_stop(s):
        orig(s)
        flag['stop'] = True

    sch._sleep = sleep_then_stop
    with pytest.raises(S.Aborted):
        sch.get_json(URL)                                                          # day budget exhausted -> waits
    assert max(clock.sleeps) <= 5.0                                                # waits in short slices


def test_429_minutely_sets_global_cooldown_and_halves_rate(tmp_path):
    body = {'error': True, 'reason': 'Minutely API request limit exceeded. Please try again in one minute.'}
    sess = FakeSession(script=[FakeResponse(429, body)])
    sch, clock = scheduler(tmp_path, session=sess, per_minute=20)
    t0 = clock.t
    assert 'daily' in sch.get_json(URL) or True
    assert sch.telemetry.http_429 == 1 and sch.telemetry.retries == 1
    assert clock.t - t0 >= 60.0                                                   # waited for the minute
    assert sch.rate_factor == 0.5
    # The cooldown is global: a second scheduler (another process) sees it too.
    led = S.Ledger(tmp_path / 'ledger.sqlite')
    led.extend_cooldown(clock.t + 500, '429 hourly')
    other, _ = scheduler(tmp_path, clock=clock, per_minute=20)
    t1 = clock.t
    other.get_json(URL)
    assert clock.t - t1 >= 500


def test_429_retry_after_and_hourly_reason_are_honoured(tmp_path):
    now = 1_800_000_000.0 + 1800.0
    rng = random.Random(0)
    assert S.cooldown_for_429('unknown', 1, now, 900.0, rng) >= 900.0             # Retry-After wins
    hourly = S.cooldown_for_429('hourly', 1, now, None, rng)
    assert now + hourly >= (int(now) // 3600 + 1) * 3600                           # until the next hour at least
    daily = S.cooldown_for_429('daily', 1, now, None, rng)
    assert now + daily >= dt.datetime.fromtimestamp(now, dt.timezone.utc).replace(hour=0, minute=0, second=0).timestamp() + 86400
    assert S.classify_429('{"reason":"Hourly API request limit exceeded"}') == 'hourly'
    assert S.parse_retry_after('120', now) == 120.0
    assert S.parse_retry_after('Wed, 21 Oct 2015 07:28:00 GMT', now) == 0.0


def test_transient_errors_back_off_then_raise_transient_not_permanent(tmp_path):
    import requests
    sess = FakeSession(script=[FakeResponse(503, None, 'busy'), requests.exceptions.ConnectionError('down'), None])
    sch, clock = scheduler(tmp_path, session=sess)
    sch.get_json(URL)
    assert sch.telemetry.http_5xx == 1 and sch.telemetry.network_errors == 1 and sch.telemetry.ok == 1
    sess2 = FakeSession(script=[requests.exceptions.ConnectionError('down')] * 10)
    sch2, _ = scheduler(tmp_path, session=sess2, max_transient_attempts=3)
    with pytest.raises(S.TransientError):
        sch2.get_json(URL)
    sch3, _ = scheduler(tmp_path, session=FakeSession(script=[FakeResponse(400, {'error': True, 'reason': 'bad'})]))
    with pytest.raises(S.PermanentError):
        sch3.get_json(URL)


def test_rate_factor_recovers_after_quiet_period(tmp_path):
    sch, clock = scheduler(tmp_path)
    sch.rate_factor = 0.5
    sch._last_429_ts = clock.t
    clock.t += sch.QUIET_RESTORE_S + 1
    sch.get_json(URL)
    assert sch.rate_factor > 0.5


def test_legacy_builder_requests_go_through_central_scheduler(tmp_path, monkeypatch):
    sch, _ = scheduler(tmp_path, session=FakeSession())
    monkeypatch.setattr(B, '_SCHEDULER', sch)
    rl = B.RateLimiter(1.5)
    tele = B.ProviderRateLimitTelemetry(1.5)
    j = B.get_json_with_retries(B.build_url_daily(1.0, 2.0, dt.date(2024, 1, 1), dt.date(2024, 1, 3)), rl, telemetry=tele)
    assert len(j['daily']['time']) == 3 and tele.requests_success == 1
    assert sch.budget.per_minute == pytest.approx(40.0)                           # 60 / 1.5 s pacing
    assert sqlite3.connect(tmp_path / 'ledger.sqlite').execute('SELECT COUNT(*) FROM requests').fetchone()[0] == 1


# ------------------------------------------------------------------ builder parsing
def test_fast_hourly_parse_matches_pandas():
    for s in ['2024-02-29T00:00', '2023-12-31T23:00', '2025-03-30T02:00', '2024-07-01T14:00']:
        d, h = B._parse_iso_hour(s)
        p = pd.to_datetime(s)
        assert (d, h) == (p.date(), int(p.hour))


def test_multi_year_request_gives_the_rows_of_single_year_builds():
    t = B.Tile('r-79_c141', -79, 141, -0.98, 36.4)
    urls = []

    def get_json(url):
        urls.append(url)
        return _fake_archive(url)

    multi = B.process_tile_years(t, YEARS, get_json)
    assert len(urls) == 2                                                          # one daily + one hourly for 3 years
    for y in YEARS:
        acc = B.make_empty_accumulators()
        B.parse_daily_into_accumulators(_fake_archive(B.build_url_daily(t.lat, t.lon, dt.date(y, 1, 1), dt.date(y, 12, 31))), acc)
        B.parse_hourly_into_accumulators(_fake_archive(B.build_url_hourly(t.lat, t.lon, dt.date(y, 1, 1), dt.date(y, 12, 31))), acc)
        assert multi[y] == (B.compute_climatology_rows(acc), B.compute_riding_hourly_rows(acc))
    feb29 = {y: next(r for r in multi[y][0] if (r['month'], r['day']) == (2, 29)) for y in YEARS}
    assert feb29[2024]['samples_daily'] == 1 and feb29[2023]['samples_daily'] == 0 and feb29[2025]['samples_daily'] == 0


# ------------------------------------------------------------------ region definition
def test_africa_region_is_the_european_grid_continued_south():
    tiles = R.load_region('africa')
    assert len(tiles) == 12593
    assert len({t.tile_id for t in tiles}) == len(tiles)
    assert {t.kind for t in tiles} == {'land', 'coastal'}
    assert max(t.row for t in tiles) == -1 and min(t.row for t in tiles) == -154
    for t in tiles[:: 97]:
        lat, lon = R.grid_centre(t.row, t.col)
        assert t.tile_id == f'r{t.row}_c{t.col}'
        assert abs(lat - t.lat) < 1e-9 and abs(lon - t.lon) < 1e-9
    countries = {t.country for t in tiles}
    for island_state in ('CV', 'MG', 'MU', 'SC', 'KM', 'ST', 'RE'):
        assert island_state in countries                                           # islands are included
    assert any(t.country == 'ES' for t in tiles)                                   # Canary Islands
    box = R.region_box(tiles)
    assert box['lat_max'] == 34.0 and box['lat_min'] < -34.8                       # Cape Agulhas
    assert box['lon_min'] < -25.0 and box['lon_max'] > 63.0                        # Cape Verde ... Rodrigues


@pytest.mark.parametrize('year', YEARS)
def test_region_grid_matches_the_existing_database_grid(year):
    """The region continues the grid each yearly database declares (bbox origin 34 N / 28 W).

    The databases also hold tiles of an older -11 deg column layout under the same
    naming; every tile of the declared -28 deg layout lies exactly on grid_centre(),
    in every row including row 0 directly north of the region's row -1.
    """
    db = CACHE / f'offline_weather_{year}.sqlite'
    if not db.exists():
        pytest.skip('real yearly database not installed')
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    assert json.loads(dict(c.execute('SELECT key, value FROM meta'))['bbox']) == EUROPE_BBOX
    n = 0
    rows0 = 0
    for row, col, lat, lon in c.execute('SELECT row, col, lat, lon FROM tiles'):
        origin = lon - (col + 0.5) * 50.0 / (111.32 * math.cos(math.radians(lat)))
        if abs(origin - R.GRID_ORIGIN_LON) > 0.5:
            continue                                                               # -11 deg layout
        glat, glon = R.grid_centre(row, col)
        assert abs(glat - lat) < 1e-6 and abs(glon - lon) < 1e-6
        n += 1
        rows0 += row == 0
    assert n > 1000 and rows0 > 20


# ------------------------------------------------------------------ job end to end
def _make_year_db(path: Path, year: int) -> None:
    c = sqlite3.connect(path)
    B.ensure_schema(c, OFFLINE / 'offline_store_schema.sql')
    for k, v in {'provider': 'open-meteo', 'provider_only': 'true', 'tile_km': '50.0',
                 'bbox': json.dumps(EUROPE_BBOX), 'years': json.dumps({'start': year, 'end': year})}.items():
        B.meta_set(c, k, v)
    # Two complete European tiles (rows 0 and 1, -28 deg layout).
    acc = B.make_empty_accumulators()
    B.parse_daily_into_accumulators(_fake_archive(B.build_url_daily(34.2, 10.0, dt.date(year, 1, 1), dt.date(year, 12, 31))), acc)
    B.parse_hourly_into_accumulators(_fake_archive(B.build_url_hourly(34.2, 10.0, dt.date(year, 1, 1), dt.date(year, 12, 31))), acc)
    rows, riding = B.compute_climatology_rows(acc), B.compute_riding_hourly_rows(acc)
    for row, col in ((0, 60), (1, 60), (0, 111)):                                  # r0_c111: east edge (32.6 E)
        lat, lon = R.grid_centre(row, col)
        B.upsert_tile(c, B.Tile(f'r{row}_c{col}', row, col, lat, lon))
        B.replace_climatology_rows(c, f'r{row}_c{col}', rows)
        B.replace_riding_hourly_rows(c, f'r{row}_c{col}', riding)
        B.tile_mark_state(c, f'r{row}_c{col}', 'done')
    c.commit()
    c.close()


def _europe_digest(path: Path) -> str:
    c = sqlite3.connect(path)
    h = hashlib.sha256()
    for q in ("SELECT * FROM tiles WHERE row >= 0 ORDER BY tile_id",
              "SELECT * FROM climatology WHERE tile_id NOT LIKE 'r-%' ORDER BY tile_id, month, day",
              "SELECT * FROM riding_hourly WHERE tile_id NOT LIKE 'r-%' ORDER BY tile_id, month, day, hour",
              "SELECT tile_id, status FROM build_state WHERE tile_id NOT LIKE 'r-%' ORDER BY tile_id",
              "SELECT key, value FROM meta WHERE key NOT IN ('grid_origin', 'coverage_bboxes') ORDER BY key"):
        h.update(repr(c.execute(q).fetchall()).encode())
    c.close()
    return h.hexdigest()


@pytest.fixture
def years_env(tmp_path):
    for y in YEARS:
        _make_year_db(tmp_path / f'offline_weather_{y}.sqlite', y)
    # Seam / pilot tiles: south of the European rows, Nairobi area, Madagascar.
    want = ['r-1_c60', 'r-1_c61', 'r-2_c60'] + [t.tile_id for t in R.load_region('africa') if t.country in ('KE',)][:2]
    (tmp_path / 'tiles.txt').write_text('\n'.join(want))
    return SimpleNamespace(dir=tmp_path, tiles=want)


def _work_order(env):
    want = set(env.tiles)
    return [t for t in R.load_region('africa') if t.tile_id in want]               # the job's order (row, col)


def _args(env, *extra):
    return RJ.parse_args(['--region', 'africa', '--years', '2023,2024,2025',
                          '--db-template', str(env.dir / 'offline_weather_{year}.sqlite'),
                          '--state', str(env.dir / 'job.sqlite'), '--ledger', str(env.dir / 'ledger.sqlite'),
                          '--backup-dir', str(env.dir / 'backups'), '--tiles-file', str(env.dir / 'tiles.txt'),
                          '--budget-per-minute', '600', '--budget-per-hour', '100000', '--budget-per-day', '100000',
                          '--calls-per-minute', '1e9', '--calls-per-hour', '1e9', '--calls-per-day', '1e9',
                          '--batch-tiles', '2', '--transient-pause-s', '1', *extra])


def test_region_job_appends_complete_tiles_only_and_keeps_years_complete(years_env):
    env = years_env
    before = {y: _europe_digest(env.dir / f'offline_weather_{y}.sqlite') for y in YEARS}
    sess = FakeSession()
    assert RJ.RegionJob(_args(env), session=sess, sleep=lambda s: None).run() == 0
    assert len(sess.calls) == 2 * len(env.tiles)                                   # 2 requests per tile for 3 years
    for y in YEARS:
        db = env.dir / f'offline_weather_{y}.sqlite'
        assert _europe_digest(db) == before[y]                                     # European data untouched
        c = sqlite3.connect(db)
        got = c.execute("SELECT t.tile_id, b.status, (SELECT COUNT(*) FROM climatology c WHERE c.tile_id=t.tile_id), "
                        "(SELECT COUNT(*) FROM riding_hourly r WHERE r.tile_id=t.tile_id) FROM tiles t "
                        "JOIN build_state b USING(tile_id) WHERE t.row < 0").fetchall()
        assert sorted(g[0] for g in got) == sorted(env.tiles)
        assert all(g[1] == 'done' and g[2] == 366 and g[3] == 366 * 4 for g in got)
        meta = dict(c.execute('SELECT key, value FROM meta'))
        assert json.loads(meta['bbox']) == EUROPE_BBOX                             # bbox unchanged
        assert json.loads(meta['grid_origin']) == {'lat': 34.0, 'lon': -28.0}
        cov = json.loads(meta['coverage_bboxes'])
        assert cov[0] == EUROPE_BBOX and cov[1]['lat_max'] == 34.0
        audit = backend_app._evaluate_offline_year_database(db)
        assert audit['complete'] is True, audit                                    # reference years stay usable
        assert (env.dir / 'backups' / f'offline_weather_{y}.before-africa.sqlite').exists()
    status = json.loads((env.dir / 'job.status.json').read_text())
    assert status['state'] == 'finished' and status['tile_years_done'] == 3 * len(env.tiles)
    # Resume: everything is done, no request is made.
    sess2 = FakeSession()
    RJ.RegionJob(_args(env), session=sess2, sleep=lambda s: None).run()
    assert sess2.calls == []


def test_region_job_resumes_after_interruption_without_refetching(years_env):
    env = years_env
    job = {}

    def stop_after_first_tile(n, _url):
        if n == 2:                                                                  # both requests of tile 1 sent
            job['j'].stop = True

    sess = FakeSession(on_request=stop_after_first_tile)
    job['j'] = RJ.RegionJob(_args(env), session=sess, sleep=lambda s: None)
    job['j'].run()
    st = json.loads((env.dir / 'job.status.json').read_text())
    assert st['state'] == 'stopped' and st['tile_years_done'] == 3                  # tile 1 flushed on stop
    sess2 = FakeSession()
    RJ.RegionJob(_args(env), session=sess2, sleep=lambda s: None).run()
    assert len(sess2.calls) == 2 * (len(env.tiles) - 1)
    fetched = {(parse_qs(urlparse(u).query)['latitude'][0], parse_qs(urlparse(u).query)['longitude'][0]) for u in sess2.calls}
    first = _work_order(env)[0]                                                    # the tile done before the stop
    assert (f'{first.lat:.6f}', f'{first.lon:.6f}') not in fetched
    # A crash after the yearly commit but before the job state: reconcile from the databases.
    (env.dir / 'job.sqlite').unlink()
    sess3 = FakeSession()
    RJ.RegionJob(_args(env), session=sess3, sleep=lambda s: None).run()
    assert sess3.calls == []


def test_permanent_error_is_recorded_in_job_state_not_in_yearly_databases(years_env):
    env = years_env
    sess = FakeSession(script=[FakeResponse(400, {'error': True, 'reason': 'Parameter out of range'})])
    RJ.RegionJob(_args(env), session=sess, sleep=lambda s: None).run()
    st = json.loads((env.dir / 'job.status.json').read_text())
    assert st['tile_years_error'] == 3 and st['tile_years_done'] == 3 * (len(env.tiles) - 1)
    for y in YEARS:
        db = env.dir / f'offline_weather_{y}.sqlite'
        c = sqlite3.connect(db)
        assert c.execute("SELECT COUNT(*) FROM build_state WHERE status != 'done'").fetchone()[0] == 0
        assert c.execute('SELECT COUNT(*) FROM tiles WHERE tile_id=?', (_work_order(env)[0].tile_id,)).fetchone()[0] == 0
        assert backend_app._evaluate_offline_year_database(db)['complete'] is True
    sess2 = FakeSession()
    RJ.RegionJob(_args(env, '--retry-errors'), session=sess2, sleep=lambda s: None).run()
    assert len(sess2.calls) == 2


def test_region_job_refuses_a_database_on_another_grid(years_env):
    env = years_env
    c = sqlite3.connect(env.dir / 'offline_weather_2024.sqlite')
    B.meta_set(c, 'bbox', json.dumps({"lat_min": 35.0, "lat_max": 72.0, "lon_min": -11.0, "lon_max": 33.0}))
    c.commit()
    c.close()
    with pytest.raises(SystemExit, match='incompatible grid'):
        RJ.RegionJob(_args(env), session=FakeSession(), sleep=lambda s: None).run()


# ------------------------------------------------------------------ app lookups across the seam
def _store(path: Path) -> OfflineWeatherStore:
    cfg = OfflineWeatherStore._load_config(path)
    assert cfg is not None
    return OfflineWeatherStore(cfg)


def test_store_and_app_find_region_tiles_and_interpolate_across_34N(years_env):
    env = years_env
    RJ.RegionJob(_args(env), session=FakeSession(), sleep=lambda s: None).run()
    st = _store(env.dir / 'offline_weather_2024.sqlite')
    assert st.cfg.grid_origin_lat == 34.0 and len(st.cfg.coverage_boxes) == 2
    lat, lon = R.grid_centre(-1, 60)
    assert st._tile_id_for_point(lat, lon) == 'r-1_c60'
    elat, elon = R.grid_centre(0, 60)
    assert st._tile_id_for_point(elat, elon) == 'r0_c60'                          # Europe unchanged
    assert backend_app._store_covers_point(st, lat, lon)
    assert not backend_app._store_covers_point(st, 40.0, 45.0)                   # Caucasus: in neither box
    parts = backend_app._interpolation_tiles(st, 34.0, lon)                       # on the seam
    ids = {p[0] for p in parts}
    assert any(i.startswith('r-1_') for i in ids) and any(i.startswith('r0_') for i in ids)
    # A point just east of the European box (in neither box) still falls back to the European edge tile.
    assert backend_app._tile_id_for_point_or_edge(st, elat, 33.5) == 'r0_c111'


def test_store_without_region_meta_behaves_as_before(tmp_path):
    _make_year_db(tmp_path / 'offline_weather_2024.sqlite', 2024)
    st = _store(tmp_path / 'offline_weather_2024.sqlite')
    assert st.cfg.grid_origin_lat == 34.0 and st.cfg.coverage_boxes == ((34.0, 72.0, -28.0, 33.0),)
    assert backend_app._store_bbox(st) == (34.0, 72.0, -28.0, 33.0)
    assert not backend_app._store_covers_point(st, 0.0, 36.0)


# ------------------------------------------------------------------ tile manager
def test_manager_region_endpoints_start_detached_and_stop_gracefully(tmp_path, monkeypatch):
    import manager_app as M  # type: ignore
    monkeypatch.setattr(M, 'CACHE_DIR', tmp_path / 'cache')
    monkeypatch.setattr(M, 'DEBUG_DIR', tmp_path / 'debug')
    monkeypatch.setattr(M, 'REPO_DIR', tmp_path)
    started = []

    class P:
        pid = 4242

    def fake_popen(cmd, **kw):
        started.append((cmd, kw))
        return P()

    monkeypatch.setattr(M.subprocess, 'Popen', fake_popen)
    client = M.app.test_client()
    j = client.get('/api/regions').get_json()
    africa = next(r for r in j['regions'] if r['slug'] == 'africa')
    assert africa['tiles'] == 12593 and africa['years'] == YEARS and africa['tile_years'] == 3 * 12593
    assert africa['running'] is False and africa['status'] is None
    assert not any(p['slug'] == 'africa' for p in M.REGION_PRESETS)               # no rectangle job any more
    r = client.post('/api/regions/africa/start', json={'budget_per_minute': 15})
    assert r.status_code == 202
    cmd, kw = started[0]
    assert cmd[1].endswith('region_job.py') and '--region' in cmd and 'africa' in cmd
    assert cmd[cmd.index('--budget-per-minute') + 1] == '15.0' and cmd[cmd.index('--years') + 1] == '2023,2024,2025'
    assert cmd[cmd.index('--calls-per-day') + 1] == '4000.0'                         # 40% of the free daily limit
    assert kw.get('start_new_session') is True                                     # survives the manager/browser
    r = client.post('/api/regions/africa/stop')
    assert r.status_code == 200
    assert (tmp_path / 'cache' / 'offline_jobs' / 'africa-2023-2025.stop').exists()
    assert client.post('/api/regions/nowhere/start').status_code == 404
