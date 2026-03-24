"""Generate teaser screenshots for the WeatherMap app.

Uses Playwright to capture a few deterministic screenshots from the locally
running dev server.

Usage:
  /Users/ingolfhorsch/Projekte/WeatherMap/.venv/bin/python tools/generate_teaser_screenshots.py \
    --base-url http://127.0.0.1:5002 \
    --out-dir docs/teaser
"""

from __future__ import annotations

import argparse
import pathlib

from playwright.sync_api import sync_playwright


def _wait_for_app_ready(page) -> None:
    # Wait for map and top nav to exist.
    page.wait_for_selector("#map", timeout=30_000)
    page.wait_for_selector("#modeNav", timeout=30_000)
    # Give Leaflet a moment to layout tiles/canvas.
    page.wait_for_timeout(800)


def _goto_mode(page, mode: str) -> None:
    if mode == "tour":
        page.click("#navTour")
    elif mode == "climate":
        page.click("#navClimate")
    else:
        raise ValueError(f"Unsupported mode: {mode}")
        page.wait_for_function(
                """(m) => {
                    try {
                        return document.body && document.body.dataset && document.body.dataset.mode === m;
                    } catch (e) {
                        return false;
                    }
                }""",
                mode,
                timeout=30_000,
        )
        page.wait_for_timeout(250)


def _climate_set_legend_controls(page, *, year: str | None, timescale: str | None, layer: str | None) -> None:
    # Legend only exists when climate is active.
    page.wait_for_selector(".wm-map-legend", timeout=30_000)

    if layer:
        page.select_option("#wmStrategicLegendLayerSelect", layer)
        page.wait_for_timeout(300)

    if year:
        page.select_option("#wmStrategicLegendYearSelect", year)
        page.wait_for_timeout(300)

    if timescale:
        page.select_option("#wmStrategicLegendTimescaleSelect", timescale)
        page.wait_for_timeout(400)

    # Wait for some strategic fetches to have happened.
    # (Network-idle is a bit flaky with tile loads; just a small settle works.)
    page.wait_for_timeout(1200)


def _screenshot(page, path: pathlib.Path, *, full_page: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), full_page=full_page)


def _read_sse_status(page) -> str:
    try:
        return str(
            page.evaluate(
                """() => {
                  const el = document.querySelector('#sseStatus');
                  return el ? String(el.textContent || '').trim() : '';
                }"""
            )
        )
    except Exception:
        return ""


def _set_tour_teaser_prefs(page) -> None:
    # Keep teaser generation fast and deterministic.
    page.wait_for_selector("#weatherQuality", state="attached", timeout=30_000)
    page.select_option("#weatherQuality", "fast")
    page.select_option("#setWeatherVisualizationMode", "bands")
    # Smaller historic span -> faster stream, still shows the bands.
    page.fill("#setHistLast", "2024")
    page.fill("#setHistYears", "1")
    # Profile overlay: temperature is visually clean.
    page.select_option("#setOverlayMode", "temperature")

    # Reduce station count so the SSE stream finishes quickly.
    try:
        page.fill("#tourDays", "5")
    except Exception:
        pass
    try:
        page.fill("#setStepKm", "200")
    except Exception:
        pass
    page.wait_for_timeout(150)


def _wait_for_stream_done(page, *, timeout_ms: int = 240_000) -> None:
    page.wait_for_selector("#sseStatus", timeout=30_000)
    page.wait_for_function(
        """() => {
          const el = document.querySelector('#sseStatus');
          if (!el) return false;
          const t = String(el.textContent || '').trim();
          return t.startsWith('Stream: done');
        }""",
        timeout=timeout_ms,
    )


def _wait_for_tour_visuals_ready(page, *, timeout_ms: int = 240_000) -> None:
        # We want the route + bands + profile to be visible.
        # Waiting for SSE "done" can take very long on some machines/networks.
        page.wait_for_selector("#sseStatus", timeout=30_000)
        page.wait_for_selector(".leaflet-container", timeout=30_000)
        page.wait_for_function(
                """() => {
                    const s = document.querySelector('#sseStatus');
                    const t = s ? String(s.textContent || '') : '';
                    // Any non-idle status indicates the tour has started building.
                    if (!t || t.includes('idle')) return false;
                    // Bands layer inserts a .wm-tour-bands container with canvases.
                    const bands = document.querySelector('.wm-tour-bands');
                    if (!bands) return false;
                    const cvs = bands.querySelector('canvas');
                    if (!cvs) return false;
                    // Leaflet may keep CSS size while backing store is 0 initially.
                    if ((cvs.width|0) < 20 || (cvs.height|0) < 20) return false;
                    return true;
                }""",
                timeout=timeout_ms,
        )
        _wait_for_profile_canvas_painted(page, timeout_ms=min(timeout_ms, 60_000))


def _wait_for_profile_canvas_painted(page, *, timeout_ms: int = 60_000) -> None:
        page.wait_for_selector("#profileCanvas", timeout=30_000)
        page.wait_for_function(
                """() => {
                    const c = document.querySelector('#profileCanvas');
                    if (!c) return false;
                    // Ensure it has a drawable backing store.
                    if ((c.width|0) < 20 || (c.height|0) < 20) return false;
                    const ctx = c.getContext('2d');
                    if (!ctx) return false;
                    // Sample a few points; if all are fully transparent, profile likely not drawn.
                    const pts = [
                        [Math.floor(c.width*0.25), Math.floor(c.height*0.5)],
                        [Math.floor(c.width*0.50), Math.floor(c.height*0.5)],
                        [Math.floor(c.width*0.75), Math.floor(c.height*0.5)],
                    ];
                    for (const [x,y] of pts) {
                        try {
                            const d = ctx.getImageData(x, y, 1, 1).data;
                            if (d && d.length === 4) {
                                const a = d[3];
                                const rgb = d[0] + d[1] + d[2];
                                if (a > 0 && rgb > 0) return true;
                            }
                        } catch (e) {
                            // In some browsers, getImageData can throw for tainted canvases.
                            // If that happens, at least require layout dimensions.
                            return true;
                        }
                    }
                    return false;
                }""",
                timeout=timeout_ms,
        )


def _tour_load_demo_route_and_wait(page, *, repo_root: pathlib.Path) -> None:
    # The backend already defaults to the repo-tracked demo GPX.
    # Trigger a fresh stream explicitly to ensure we capture the fully-rendered tour.
    page.wait_for_selector("#fetchWeather", state="attached", timeout=30_000)

    # If a stream is already running (button disabled), stop it first.
    try:
        is_disabled = page.evaluate(
            """() => {
              const b = document.querySelector('#fetchWeather');
              return !!b && !!b.disabled;
            }"""
        )
    except Exception:
        is_disabled = False

    if is_disabled:
        try:
            page.click("#stopWeather", timeout=2_000)
            page.wait_for_timeout(600)
        except Exception:
            pass

    page.wait_for_function(
        """() => {
          const b = document.querySelector('#fetchWeather');
          return !!b && !b.disabled;
        }""",
        timeout=60_000,
    )
    page.click("#fetchWeather")

    _wait_for_tour_visuals_ready(page)
    page.wait_for_timeout(600)


def _climate_zoom_out_europe(page) -> None:
    # Fit bounds roughly covering Spain, France, Germany.
    page.wait_for_function(
        """() => !!(window.__WM_LEAFLET_MAP__ && window.__WM_LEAFLET_MAP__.fitBounds)""",
        timeout=30_000,
    )
    page.evaluate(
        """() => {
          const m = window.__WM_LEAFLET_MAP__;
          // [[southWestLat, southWestLon], [northEastLat, northEastLon]]
          m.fitBounds([[36.0, -10.0], [55.5, 16.5]], { padding: [12, 12] });
        }"""
    )
    page.wait_for_timeout(1200)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:5002")
    ap.add_argument("--out-dir", default="docs/teaser")
    args = ap.parse_args()

    base_url = str(args.base_url).rstrip("/")
    out_dir = pathlib.Path(args.out_dir)

    repo_root = pathlib.Path(__file__).resolve().parents[1]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=2,
        )
        page = context.new_page()

        page.goto(base_url + "/", wait_until="domcontentloaded")
        _wait_for_app_ready(page)

        # Screenshot 1: Tour Planning (fully built)
        _goto_mode(page, "tour")
        _set_tour_teaser_prefs(page)
        try:
            _tour_load_demo_route_and_wait(page, repo_root=repo_root)
        except Exception:
            dbg = out_dir / "_debug-tour.png"
            _screenshot(page, dbg, full_page=True)
            raise RuntimeError(f"Tour screenshot readiness timeout. sseStatus='{_read_sse_status(page)}'. Debug: {dbg}")
        _screenshot(page, out_dir / "01-tour-planning.png")

        # Screenshot 2: Climatic Map, monthly temperature
        _goto_mode(page, "climate")
        _climate_set_legend_controls(page, year="2024", timescale="month", layer="temperature_ride")
        _screenshot(page, out_dir / "02-climate-monthly-temperature.png")

        # Screenshot 3: Climatic Map, weekly wind
        _climate_set_legend_controls(page, year="2024", timescale="week", layer="wind_dir")
        _screenshot(page, out_dir / "03-climate-weekly-wind.png")

        # Screenshot 4: Climatic Map, monthly rain (zoomed out to show Germany/France/Spain)
        _climate_set_legend_controls(page, year="2024", timescale="month", layer="rain_ride")
        _climate_zoom_out_europe(page)
        _screenshot(page, out_dir / "04-climate-monthly-rain-europe.png")

        context.close()
        browser.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
