"""Targeted browser regression for Tour Planning info-stripe removal.

Usage:
  /Users/ingolfhorsch/Projekte/WeatherMap/.venv/bin/python tools/verify_tour_info_stripe_removed.py \
    --base-url http://127.0.0.1:5002
"""

from __future__ import annotations

import argparse
import pathlib
import sys
from typing import Any

from playwright.sync_api import Page, sync_playwright


def _assert(page: Page, condition: str, message: str, timeout: int = 120000) -> None:
    try:
        page.wait_for_function(condition, timeout=timeout)
    except Exception as exc:  # pragma: no cover - test utility
        raise AssertionError(message) from exc


def _wait_tour_ready(page: Page) -> None:
    page.wait_for_selector("#map", timeout=30000)
    page.wait_for_selector("#profilePanel", state="attached", timeout=30000)
    page.wait_for_selector("#profileCanvas", state="attached", timeout=30000)
    page.wait_for_selector("#gpxFileInput", state="attached", timeout=30000)
    page.wait_for_selector("#fetchWeather", state="attached", timeout=30000)


def _switch_mode(page: Page, mode: str) -> None:
    if mode == "tour":
        page.click("#navTour", timeout=10000)
    elif mode == "climate":
        page.click("#navClimate", timeout=10000)
    else:
        raise ValueError(f"Unsupported mode: {mode}")
    _assert(page, f"() => document.body?.dataset?.mode === {mode!r}", f"Mode did not switch to {mode}")
    if mode == "tour":
        page.wait_for_selector("#fetchWeather", timeout=30000)


def _upload_route(page: Page, gpx_path: pathlib.Path) -> None:
    if not gpx_path.exists():
        raise FileNotFoundError(f"GPX not found: {gpx_path}")
    page.set_input_files("#gpxFileInput", str(gpx_path))
    _assert(
        page,
        "() => { const el = document.querySelector('#gpxFileInput'); return !!el && !!el.files && el.files.length > 0; }",
        "GPX upload did not stick",
    )


def _run_weather_fetch(page: Page) -> None:
    page.click("#fetchWeather", timeout=12000)
    try:
        _assert(
            page,
            "() => { const t = String(document.querySelector('#sseStatus')?.textContent || '').trim(); return t.startsWith('Stream: done'); }",
            "Weather stream did not complete",
            timeout=180000,
        )
    except AssertionError:
        _assert(
            page,
            "() => document.querySelectorAll('[data-wm-route-card=\"1\"], .wm-tour-day-card, .glyph-map').length > 0",
            "No rendered route/tour markers after fetch",
            timeout=180000,
        )


def _layout_snapshot(page: Page) -> dict[str, Any]:
    return page.evaluate(
        """() => {
            const summary = document.querySelector('#tourSummary');
            const map = document.querySelector('#map');
            const profilePanel = document.querySelector('#profilePanel');
            const profileCanvas = document.querySelector('#profileCanvas');
            if (!summary || !map || !profilePanel || !profileCanvas) return null;
            const s = getComputedStyle(summary);
            const mapRect = map.getBoundingClientRect();
            const profileRect = profilePanel.getBoundingClientRect();
            return {
              summaryDisplay: s.display,
              summaryHeight: summary.getBoundingClientRect().height,
              mapHeight: mapRect.height,
              profileHeight: profileRect.height,
              mapToProfileGap: profileRect.top - mapRect.bottom,
              profileCanvasHeight: profileCanvas.getBoundingClientRect().height,
              routeCards: document.querySelectorAll('[data-wm-route-card="1"], .wm-tour-day-card, .glyph-map').length,
              profileSamples: (window.LAST_PROFILE && Array.isArray(window.LAST_PROFILE.sampled_dist_km)) ? window.LAST_PROFILE.sampled_dist_km.length : 0,
              routePathCount: document.querySelectorAll('#map svg path.leaflet-interactive').length
            };
        }"""
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify Tour Planning info stripe is removed without regressions.")
    ap.add_argument("--base-url", default="http://127.0.0.1:5002")
    ap.add_argument(
        "--gpx",
        default=str(
            pathlib.Path(__file__).resolve().parents[1]
            / "project"
            / "data"
            / "realistic_routes"
            / "real_route_1_freiburg_bern.gpx"
        ),
    )
    ap.add_argument("--headless", action="store_true", default=True)
    args = ap.parse_args()

    gpx_path = pathlib.Path(args.gpx).resolve()
    js_errors: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=bool(args.headless))
        page = browser.new_page(viewport={"width": 1600, "height": 1100})
        page.on("pageerror", lambda e: js_errors.append(f"pageerror: {e}"))
        page.on(
            "console",
            lambda msg: js_errors.append(f"console:{msg.type}: {msg.text}")
            if msg.type == "error"
            and "favicon" not in msg.text.lower()
            and "overpass request failed" not in msg.text.lower()
            else None,
        )

        page.goto(args.base_url, wait_until="domcontentloaded")
        _wait_tour_ready(page)

        _switch_mode(page, "tour")
        _upload_route(page, gpx_path)
        _run_weather_fetch(page)
        tour_layout = _layout_snapshot(page)
        if not tour_layout:
            raise AssertionError("Could not collect tour layout snapshot")

        if tour_layout["summaryDisplay"] != "none":
            raise AssertionError(f"Tour summary stripe is still visible: {tour_layout}")
        if abs(float(tour_layout["mapToProfileGap"])) > 4:
            raise AssertionError(f"Unexpected blank gap between map and profile: {tour_layout}")
        if float(tour_layout["mapHeight"]) < 240:
            raise AssertionError(f"Map height too small in tour mode: {tour_layout}")
        if float(tour_layout["profileCanvasHeight"]) < 40:
            raise AssertionError(f"Profile canvas not visible: {tour_layout}")
        if int(tour_layout["routeCards"]) < 1:
            raise AssertionError(f"Profile route data missing: {tour_layout}")

        _switch_mode(page, "climate")
        climate_display = page.evaluate("() => getComputedStyle(document.querySelector('#tourSummary')).display")
        if climate_display == "none":
            raise AssertionError("Explore/Climatic mode unexpectedly hides tourSummary panel")
        _switch_mode(page, "tour")

        browser.close()

    if js_errors:
        raise AssertionError("Detected browser JS errors/warnings:\n" + "\n".join(js_errors[:20]))

    print("PASS: Tour info stripe removal regression checks succeeded.")
    print(f"Tour layout snapshot: {tour_layout}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
