from __future__ import annotations

import datetime as dt
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1] / 'backend'
for p in (str(BACKEND), str(HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

import app as backend_app  # type: ignore  # noqa: E402
import synthetic as syn  # noqa: E402


@pytest.fixture
def backend(monkeypatch, tmp_path):
    """Real Flask app: isolated storage, synthetic weather, no network."""
    for name in ('data', 'stats', 'debug'):
        (tmp_path / name).mkdir()
    for name, value in {
        'DATA_DIR': tmp_path / 'data', 'UPLOAD_DIR': tmp_path / 'data',
        'SESSION_FILE': tmp_path / 'data' / 'session_state.json',
        'SESSION_STORE': {}, 'SESSION_STORE_LOADED': False,
        'STATS_CACHE_DIR': tmp_path / 'stats', 'DEBUG_DIR': tmp_path / 'debug',
    }.items():
        monkeypatch.setattr(backend_app, name, value)

    weather = SimpleNamespace(rain_fn=syn.rain_at_lon)

    def offline(lat, lon, month, day, **_kw):
        return syn.make_stats(lat, lon, month, day, rain_fn=weather.rain_fn)

    def no_network(*_a, **_k):
        raise AssertionError('network access is not allowed in regression tests')

    monkeypatch.setattr(backend_app, '_get_offline_stats', offline)
    monkeypatch.setattr(backend_app, '_get_offline_store', lambda: None)
    monkeypatch.setattr(backend_app, '_resolve_offline_store_for_year', lambda *a, **k: None)
    monkeypatch.setattr(backend_app, '_resolve_complete_reference_years', lambda *a, **k: ([], []))
    monkeypatch.setattr(backend_app, '_reverse_geocode_location',
                        lambda lat, lon, **k: {'label': f'P{lon:.2f}', 'name': f'P{lon:.2f}', 'country': ''})
    monkeypatch.setattr(backend_app.requests, 'get', no_network)
    for fn in ('fetch_daily_weather', 'fetch_daily_weather_same_day', 'fetch_daily_weather_window',
               'fetch_forecast_weather_window', 'fetch_hourly_weather_same_day',
               'fetch_hourly_forecast_weather_window'):
        monkeypatch.setattr(backend_app, fn, no_network)
    return SimpleNamespace(app=backend_app.app, module=backend_app, weather=weather, tmp=tmp_path)


@pytest.fixture
def stream(backend):
    """Run /api/map_stream and return its parsed content."""
    def run(gpx, *, step_km, days, start=syn.START, **extra):
        q = {'date': start.strftime('%m-%d'), 'start_date': start.isoformat(), 'total_days': days,
             'step_km': step_km, 'tour_planning': 1, 'mode': 'single_day', 'offline_only': 1,
             'years': '2025', 'hist_years': 1, 'hist_start': 2025, 'gpx_path': str(gpx),
             'temp_cold': 5, 'temp_hot': 30, 'rain_high': 10,
             'wind_head_comfort': 4, 'wind_tail_comfort': 10, **extra}
        ev = syn.parse_sse(backend.app.test_client().get('/api/map_stream', query_string=q).data.decode())
        stations = [d for e, d in ev if e == 'station']
        bad = [s for s in stations if 'feature' not in s]
        assert stations and not bad, f'stream returned unusable stations: {bad[:2]}'
        pick = lambda name: next((d for e, d in ev if e == name), None)
        return SimpleNamespace(
            stations=stations, props=[s['feature']['properties'] for s in stations],
            lons=[s['feature']['geometry']['coordinates'][0] for s in stations],
            summary=pick('tour_summary'), route=pick('route'),
            profile=(pick('profile') or {}).get('profile'))
    return run


# ---------------------------------------------------------------- browser ---
@pytest.fixture
def server(backend):
    from werkzeug.serving import make_server
    srv = make_server('127.0.0.1', 0, backend.app, threaded=True)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    backend.url = f'http://127.0.0.1:{srv.server_port}'
    yield backend
    srv.shutdown()
    thread.join(5)


@pytest.fixture(scope='session')
def chromium():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


class TourPage:
    """Drives the real UI and reads what the user sees or what is stored."""

    def __init__(self, page, url):
        self.page, self.url, self.requests, self.errors = page, url, [], []
        page.on('request', lambda r: self.requests.append(r) if r.url.startswith(url + '/api/') else None)
        page.on('pageerror', lambda e: self.errors.append(str(e)))

    def open(self):
        self.page.goto(self.url, wait_until='load')
        self.page.wait_for_function('() => typeof window.setMode === "function" && window.__WM_LEAFLET_MAP__')
        self.page.wait_for_timeout(800)

    def tour(self):
        self.page.click('#navTour')

    def explore(self):
        self.page.click('#navClimate')
        self.page.wait_for_timeout(500)

    def wait_weather(self, previous):
        """Wait until a map_stream newer than ``previous`` has finished."""
        self.page.wait_for_function(
            "() => /Stream: done/.test((document.getElementById('sseStatus')||{}).textContent||'')", timeout=20000)
        assert self.stream_count() > previous, 'no weather stream was started'
        self.page.wait_for_timeout(600)

    def stream_count(self):
        return sum('/api/map_stream' in r.url for r in self.requests)

    def _arm(self):
        self.page.evaluate("() => { const e=document.getElementById('sseStatus'); if(e) e.textContent=''; }")
        return self.stream_count()

    def import_gpx(self, path):
        n = self._arm()
        self.page.set_input_files('#gpxFileInput', str(path))
        self.wait_weather(n)

    def get_weather(self):
        n = self._arm()
        if not self.page.locator('#fetchWeather').is_visible():
            self.page.click('#tourTab-weather')                   # the Weather task tab holds the button
        self.page.click('#fetchWeather')
        self.wait_weather(n)

    def add_rest_day(self, position):
        self.page.evaluate(
            "p => document.querySelector(`.wm-roadbook-insert-btn[data-insert-type='rest'][data-insert-position='${p}']`).click()",
            position)
        self.page.wait_for_timeout(300)

    def set_note(self, day_key, text):
        self.page.evaluate(
            "k => document.querySelector(`#roadbookList button[data-action='add-annotation'][data-day-key='${k}']`).click()", day_key)
        self.page.fill('textarea[data-roadbook-notes-dialog-editor]', text)
        self.page.click('button[data-roadbook-notes-save]')
        self.page.wait_for_timeout(300)

    def set_reverse(self, on):
        self.page.evaluate(
            "on => { const e=document.getElementById('reverse'); e.checked=on; e.dispatchEvent(new Event('change',{bubbles:true})); }", on)
        self.page.wait_for_timeout(300)

    def set_start_date(self, iso):
        self.page.evaluate(
            "v => { const e=document.getElementById('startDate'); e.value=v; e.dispatchEvent(new Event('change',{bubbles:true})); }", iso)
        self.page.wait_for_timeout(300)

    def delete_ride_day(self, day_key):
        """User action that changes stage boundaries (and the ride-day count)."""
        self.page.evaluate(
            "k => document.querySelector(`#roadbookList button[data-action='delete-day'][data-day-key='${k}']`).click()", day_key)
        self.page.wait_for_timeout(500)

    def cards(self):
        """Displayed TourBook cards in order."""
        return self.page.evaluate("""() => [...document.querySelectorAll('#roadbookList article.wm-roadbook-card')].map(c => ({
            kind: c.dataset.kind, key: c.dataset.dayKey,
            date: c.querySelector('.wm-roadbook-card-dateline').textContent.trim(),
            stage: c.querySelector('.wm-roadbook-card-row2').textContent.trim(),
            weather: c.querySelector('.wm-roadbook-card-row3').textContent.trim(),
            tile: c.querySelector('.wm-roadbook-weather').innerText.replace(/\\s+/g,' ').trim(),
            note: !!c.querySelector('.wm-roadbook-note-indicator')}))""")

    def autosaved_plan(self):
        """Persisted active plan, read after the autosave debounce (1.8 s)."""
        self.page.wait_for_timeout(2600)
        return self.page.evaluate("""() => { const id=localStorage.getItem('wm_active_tour_plan_id_v1');
            return JSON.parse(localStorage.getItem('wm_tour_plan_store_v1')).plans[id].plan; }""")

    def structure(self):
        """User-authored structure, from persisted plan plus visible state."""
        plan = self.autosaved_plan()
        rb = plan['roadbook']
        return {
            'rest': [(s['id'], s['position']) for s in rb['restStops']],
            'boundaries': [round(b, 2) for b in (rb['boundariesKm'] or [])],
            'notes': {d['key']: d['notes'] for d in rb['days'] if d['notes']},
            'overnight': [(o['id'], o['name'], o['linkedStageId']) for o in rb['overnightStops']],
            'start': plan['settings']['startDate'],
            'reverse': self.page.evaluate("document.getElementById('reverse').checked"),
            # Ascent ('hm') is derived from the route direction, not authored.
            'days': [(c['kind'], c['key'], c['date'], c['stage'].split(' •')[0]) for c in self.cards()],
        }


@pytest.fixture
def ui(server, chromium):
    ctx = chromium.new_context(viewport={'width': 1600, 'height': 1000})
    leaflet = (HERE / 'vendor' / 'leaflet-1.9.4.js').read_text(encoding='utf-8')

    def route(r):
        url = r.request.url
        if url.startswith(server.url):
            r.continue_()
        elif 'leaflet' in url and url.endswith('.js'):
            r.fulfill(body=leaflet, content_type='text/javascript')
        else:
            r.abort()

    ctx.route('**/*', route)
    # Replace only the native file pickers; the app's save/open code is real.
    ctx.add_init_script("""window.__saved=[];
      const h={name:'t.tour',createWritable:async()=>({write:async t=>{window.__saved.push(t)},close:async()=>{}}),
               getFile:async()=>new File([window.__open],'t.tour')};
      window.showSaveFilePicker=async()=>h; window.showOpenFilePicker=async()=>[h];""")
    page = ctx.new_page()
    tp = TourPage(page, server.url)
    tp.backend = server
    yield tp
    ctx.close()


@pytest.fixture
def loaded(ui):
    """Tour mode with a 420 km route, 7 ride days of 60 km, weather loaded."""
    gpx = syn.write_gpx(ui.backend.tmp / 'tour420.gpx', 420)
    ui.open()
    ui.tour()
    ui.import_gpx(gpx)
    assert len(ui.cards()) == 7
    return ui
