"""Refresh teaser screenshots with explicit zoom-level variety.

Captures current UI screenshots for:
- Tour Planning mode across multiple real GPX routes.
- Climatic Map mode at different zoom levels.

Usage:
  /Users/ingolfhorsch/Projekte/WeatherMap/.venv/bin/python tools/refresh_teaser_screenshots_zoom.py \
    --base-url http://127.0.0.1:5002 \
    --out-dir docs/teaser
"""

from __future__ import annotations

import argparse
import pathlib

from playwright.sync_api import Page, sync_playwright


def _log(msg: str) -> None:
    print(msg, flush=True)


def _wait_app(page: Page) -> None:
    page.goto(page.url, wait_until="domcontentloaded")
    page.wait_for_selector("#map", timeout=30000)
    page.wait_for_selector("#modeNav", timeout=30000)
    page.wait_for_timeout(1200)


def _click_if_exists(page: Page, selector: str) -> bool:
    loc = page.locator(selector)
    if loc.count() > 0:
        try:
            loc.first.click(timeout=5000)
            return True
        except Exception:
            return False
    return False


def _goto_mode(page: Page, mode: str) -> None:
    if mode == "tour":
        if not _click_if_exists(page, "#navTour"):
            page.get_by_role("tab", name="Tour Planning").click(timeout=10000)
    elif mode == "climate":
        if not _click_if_exists(page, "#navClimate"):
            page.get_by_role("tab", name="Climatic Map").click(timeout=10000)
    else:
        raise ValueError(f"Unsupported mode: {mode}")
    page.wait_for_timeout(500)


def _upload_gpx(page: Page, gpx_path: pathlib.Path) -> None:
    page.wait_for_selector("#gpxFileInput", state="attached", timeout=30000)
    page.set_input_files("#gpxFileInput", str(gpx_path))
    # Wait a moment for upload + route reload to kick in.
    page.wait_for_timeout(1800)


def _run_tour_fetch(page: Page) -> None:
    page.wait_for_selector("#sseStatus", timeout=30000)
    # If running, try stopping first.
    try:
        running = page.evaluate(
            """() => {
                const b = document.querySelector('#fetchWeather');
                return !!b && !!b.disabled;
            }"""
        )
    except Exception:
        running = False
    if running:
        try:
            page.click("#stopWeather", timeout=3000)
            page.wait_for_timeout(800)
        except Exception:
            pass

    # Start stream if fetch button is available.
    try:
        page.click("#fetchWeather", timeout=8000)
    except Exception:
        pass

    try:
        page.wait_for_function(
            """() => {
                const el = document.querySelector('#sseStatus');
                if (!el) return false;
                const t = String(el.textContent || '').trim();
                return t.startsWith('Stream: done');
            }""",
            timeout=90000,
        )
    except Exception:
        # Fallback: accept once route markers and profile canvas are visibly rendered.
        page.wait_for_function(
            """() => {
                const map = document.querySelector('.leaflet-container');
                if (!map) return false;
                const cards = document.querySelectorAll('[data-wm-route-card="1"], .wm-tour-day-card, .glyph-map');
                const profile = document.querySelector('#profileCanvas');
                const pOk = !!profile && (profile.width|0) > 20 && (profile.height|0) > 20;
                return cards.length >= 3 && pOk;
            }""",
            timeout=180000,
        )
    page.wait_for_timeout(1400)


def _fit_route_and_set_zoom(page: Page, zoom: int) -> None:
    page.wait_for_function(
        """() => !!(window.__WM_LEAFLET_MAP__ && window.__WM_LEAFLET_MAP__.setZoom)""",
        timeout=30000,
    )
    page.evaluate(
        """(z) => {
            const m = window.__WM_LEAFLET_MAP__;
            if (!m) return;
            let bounds = null;
            m.eachLayer((layer) => {
                try {
                    if (layer && typeof layer.getBounds === 'function') {
                        const b = layer.getBounds();
                        if (b && typeof b.isValid === 'function' && b.isValid()) {
                            bounds = bounds ? bounds.extend(b) : b;
                        }
                    }
                } catch (_) {}
            });
            if (bounds && typeof m.fitBounds === 'function') {
                m.fitBounds(bounds, { padding: [24, 24] });
            }
            m.setZoom(z);
        }""",
        int(zoom),
    )
    page.wait_for_timeout(900)


def _climate_set_controls(page: Page, *, year: str, timescale: str, layer: str) -> None:
    page.wait_for_selector(".wm-map-legend", timeout=30000)
    timescale_aliases = {
        "day": ["daily"],
        "daily": ["day"],
        "week": ["weekly"],
        "weekly": ["week"],
        "month": ["monthly"],
        "monthly": ["month"],
    }
    layer_aliases = {
        "temperature_ride": ["temperature", "temp"],
        "temperature": ["temperature_ride", "temp"],
        "wind_dir": ["wind", "wind direction"],
        "wind": ["wind_dir", "wind direction"],
        "rain": ["precip", "rainfall"],
        "lucky_days": ["lucky", "lucky day"],
    }
    layer_keys = [str(layer)] + layer_aliases.get(str(layer), [])
    timescale_keys = [str(timescale)] + timescale_aliases.get(str(timescale), [])
    page.evaluate(
        """({year, timescale, layer}) => {
            const setSelect = (sel, wanted, aliases) => {
                const el = document.querySelector(sel);
                if (!el) return;
                const opts = Array.from(el.options || []);
                if (!opts.length) return;
                const wantedLc = String(wanted || '').toLowerCase();
                const aliasList = Array.isArray(aliases) ? aliases.map((x) => String(x || '').toLowerCase()) : [];
                const allNeedles = [wantedLc, ...aliasList].filter(Boolean);
                const exact = opts.find((o) => {
                    const v = String(o.value || '').toLowerCase();
                    const t = String(o.text || '').toLowerCase();
                    return allNeedles.includes(v) || allNeedles.includes(t);
                });
                const partial = opts.find((o) => {
                    const v = String(o.value || '').toLowerCase();
                    const t = String(o.text || '').toLowerCase();
                    return allNeedles.some((n) => v.includes(n) || t.includes(n));
                });
                const selected = exact || partial;
                if (!selected) return;
                el.value = String(selected.value);
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            setSelect('#wmStrategicLegendLayerSelect', layer, layer);
            setSelect('#wmStrategicLegendYearSelect', year, []);
            setSelect('#wmStrategicLegendTimescaleSelect', timescale, timescale);
        }""",
        {"year": year, "timescale": timescale_keys, "layer": layer_keys},
    )
    page.wait_for_timeout(1600)


def _set_map_view(page: Page, *, lat: float, lon: float, zoom: int) -> None:
    page.wait_for_function(
        """() => !!(window.__WM_LEAFLET_MAP__ && window.__WM_LEAFLET_MAP__.setView)""",
        timeout=30000,
    )
    page.evaluate(
        """({lat, lon, zoom}) => {
            const m = window.__WM_LEAFLET_MAP__;
            if (!m) return;
            m.setView([lat, lon], zoom, { animate: false });
        }""",
        {"lat": float(lat), "lon": float(lon), "zoom": int(zoom)},
    )
    page.wait_for_timeout(900)


def _wait_climate_ready(page: Page, *, timeout_ms: int = 180000) -> None:
    # Wait until obvious loading placeholders are gone and some weather stats are visible.
    page.wait_for_function(
        """() => {
            const bodyText = String(document.body ? document.body.innerText || '' : '');
            if (bodyText.includes('Loading weather data...')) return false;
            const status = document.querySelector('#sseStatus');
            const statusText = status ? String(status.textContent || '').toLowerCase() : '';
            if (statusText.includes('loading') || statusText.includes('stream: starting')) return false;
            // The climate summary area should usually show loaded data and non-empty values.
            const legends = document.querySelectorAll('.wm-map-legend, [data-role="strategic-legend"], #strategicLegend');
            if (!legends || legends.length === 0) return false;
            return true;
        }""",
        timeout=timeout_ms,
    )
    page.wait_for_timeout(1000)


def _climate_profile_loaded(page: Page) -> bool:
    try:
        return bool(
            page.evaluate(
                """() => {
                    const text = String(document.body ? document.body.innerText || '' : '');
                    const lc = text.toLowerCase();
                    if (lc.includes('climate-profile-timeout')) return false;
                    if (lc.includes('climate profile unavailable')) return false;
                    if (lc.includes('select a point on the climatic map')) return false;
                    if (lc.includes('loading weather data...')) return false;
                    const canvas = document.querySelector('#profileCanvas');
                    const canvasVisible = !!canvas && (canvas.clientWidth|0) > 200 && (canvas.clientHeight|0) > 80;
                    if (!canvasVisible) return false;
                    // Accept when loaded profile rows are visible.
                    return (lc.includes('ride day') && lc.includes('typical range')) || lc.includes('rain (mm/day)');
                }"""
            )
        )
    except Exception:
        return False


def _load_climate_profile_for_view(page: Page) -> None:
    # Try map-relative click points so the logic remains stable across viewport/layout differences.
    map_box = page.locator("#map").bounding_box()
    if not map_box:
        raise RuntimeError("Map area not available for climate profile loading")
    rel_points = [
        (0.52, 0.46),
        (0.62, 0.40),
        (0.45, 0.55),
        (0.70, 0.34),
        (0.35, 0.62),
    ]
    for idx, (px, py) in enumerate(rel_points, start=1):
        x = map_box["x"] + map_box["width"] * px
        y = map_box["y"] + map_box["height"] * py
        _log(f"[teaser] climate click attempt {idx}/{len(rel_points)} at ({x:.0f},{y:.0f})")
        page.mouse.click(x, y)
        page.wait_for_timeout(1200)
        try:
            page.wait_for_function(
                """() => {
                    const t = String(document.body ? document.body.innerText || '' : '').toLowerCase();
                    if (t.includes('climate profile unavailable')) return false;
                    if (t.includes('climate-profile-timeout')) return false;
                    if (t.includes('loading weather data...')) return false;
                    return (t.includes('ride day') && t.includes('typical range')) || t.includes('rain (mm/day)');
                }""",
                timeout=120000,
            )
        except Exception:
            _log(f"[teaser] climate click attempt {idx} timed out")
            pass
        if _climate_profile_loaded(page):
            _log(f"[teaser] climate profile loaded on attempt {idx}")
            return
    raise RuntimeError('Could not load climate profile at current map view')


def _shot(page: Page, out_path: pathlib.Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out_path), full_page=False)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:5002")
    ap.add_argument("--out-dir", default="docs/teaser")
    args = ap.parse_args()

    base_url = str(args.base_url).rstrip("/")
    out_dir = pathlib.Path(args.out_dir)
    repo_root = pathlib.Path(__file__).resolve().parents[1]

    route_dir = repo_root / "project" / "data" / "realistic_routes"
    tour_scenarios = [
        (route_dir / "real_route_1_freiburg_bern.gpx", 8, out_dir / "10-tour-route-freiburg-bern.png"),
        (route_dir / "real_route_2_milano_rome.gpx", 6, out_dir / "11-tour-route-milano-rome.png"),
        (route_dir / "real_route_3_vienna_berlin.gpx", 5, out_dir / "12-tour-route-vienna-berlin.png"),
    ]

    with sync_playwright() as p:
        _log("[teaser] launching browser")
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1500, "height": 940},
            device_scale_factor=2,
        )
        page = context.new_page()
        _log(f"[teaser] opening {base_url}/")
        page.goto(base_url + "/", wait_until="domcontentloaded")
        _wait_app(page)

        _log("[teaser] mode=tour")
        _goto_mode(page, "tour")
        for gpx_path, zoom, out_path in tour_scenarios:
            _log(f"[teaser] tour route={gpx_path.name} zoom={zoom}")
            _upload_gpx(page, gpx_path)
            _run_tour_fetch(page)
            _fit_route_and_set_zoom(page, zoom)
            _shot(page, out_path)
            _log(f"[teaser] saved {out_path}")

        _log("[teaser] mode=climate")
        _goto_mode(page, "climate")
        _log("[teaser] climate monthly temperature")
        _climate_set_controls(page, year="2024", timescale="month", layer="temperature_ride")
        _set_map_view(page, lat=48.8, lon=7.8, zoom=4)
        _load_climate_profile_for_view(page)
        _shot(page, out_dir / "02-climate-monthly-temperature.png")
        _log(f"[teaser] saved {out_dir / '02-climate-monthly-temperature.png'}")

        _log("[teaser] climate weekly wind")
        _climate_set_controls(page, year="2024", timescale="week", layer="wind_dir")
        _set_map_view(page, lat=47.4, lon=11.0, zoom=7)
        _load_climate_profile_for_view(page)
        _shot(page, out_dir / "03-climate-weekly-wind.png")
        _log(f"[teaser] saved {out_dir / '03-climate-weekly-wind.png'}")

        context.close()
        browser.close()
        _log("[teaser] done")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
