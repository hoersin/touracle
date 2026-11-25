"""Browser regression for Step 6.3 Explore mode isolation."""

from __future__ import annotations

import argparse
import pathlib
from typing import Any

from playwright.sync_api import Page, sync_playwright


def _assert(page: Page, condition: str, message: str, timeout: int = 120000) -> None:
    try:
        page.wait_for_function(condition, timeout=timeout)
    except Exception as exc:
        raise AssertionError(message) from exc


def _switch_mode(page: Page, mode: str) -> None:
    if mode == "tour":
        page.click("#navTour", timeout=10000)
    elif mode == "climate":
        page.click("#navClimate", timeout=10000)
    else:
        raise ValueError(f"Unsupported mode: {mode}")
    _assert(page, f"() => document.body?.dataset?.mode === {mode!r}", f"Mode did not switch to {mode}", timeout=30000)


def _run_fetch(page: Page) -> None:
    page.click("#fetchWeather", timeout=12000)
    _assert(
        page,
        "() => String(document.querySelector('#sseStatus')?.textContent || '').trim().startsWith('Stream: done')",
        "Tour weather stream did not complete",
        timeout=180000,
    )


def _route_sidebar_snapshot(page: Page) -> dict[str, Any]:
    data = page.evaluate(
        """() => ({
          distance: String(document.querySelector('#tourSidebarRouteDistance')?.textContent || '').trim(),
          elevation: String(document.querySelector('#tourSidebarRouteElevation')?.textContent || '').trim(),
          routeCards: document.querySelectorAll('[data-wm-route-card="1"], .wm-tour-day-card, .glyph-map').length
        })"""
    )
    if not data:
        raise AssertionError("Could not read route sidebar snapshot")
    return data


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify Explore mode is isolated from Tour Planning UI.")
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
    args = ap.parse_args()
    gpx_path = pathlib.Path(args.gpx).resolve()
    if not gpx_path.exists():
        raise FileNotFoundError(f"Missing GPX fixture: {gpx_path}")

    js_errors: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 1100})
        page.on("pageerror", lambda e: js_errors.append(f"pageerror: {e}"))
        page.on(
            "console",
            lambda msg: js_errors.append(f"console:{msg.type}: {msg.text}")
            if msg.type == "error"
            and "favicon" not in msg.text.lower()
            and "sse error event" not in msg.text.lower()
            else None,
        )

        page.goto(args.base_url, wait_until="domcontentloaded")

        _switch_mode(page, "climate")
        _assert(page, "() => getComputedStyle(document.querySelector('#strategicTimeline')).display === 'none'", "Explore timeline should be hidden")
        _assert(page, "() => getComputedStyle(document.querySelector('#profileCanvas')).display === 'none'", "Explore profile diagram should be hidden")
        _assert(page, "() => getComputedStyle(document.querySelector('#wmSectionTour')).display === 'none'", "Tour section should be hidden in Explore")
        _assert(page, "() => getComputedStyle(document.querySelector('#roadbookPanel')).display === 'none'", "TourBook panel should be hidden in Explore")

        before_click = page.eval_on_selector("#tourSummaryRoute", "el => String(el.textContent || '').trim()")
        page.evaluate("(text) => { window.__wmExploreSummaryBeforeClick = String(text || ''); }", before_click)
        map_box = page.locator("#map").bounding_box()
        if not map_box:
            raise AssertionError("Map not rendered in Explore mode")
        page.mouse.click(map_box["x"] + map_box["width"] * 0.6, map_box["y"] + map_box["height"] * 0.45)
        _assert(
            page,
            "() => String(document.querySelector('#tourSummaryRoute')?.textContent || '').trim() !== String(window.__wmExploreSummaryBeforeClick || '').trim()",
            "Explore map click did not update climate inspection summary",
            timeout=45000,
        )

        _switch_mode(page, "tour")
        page.set_input_files("#gpxFileInput", str(gpx_path))
        _run_fetch(page)
        tour_snapshot = _route_sidebar_snapshot(page)
        if tour_snapshot["distance"] in {"", "—"}:
            raise AssertionError(f"Tour distance missing after GPX load: {tour_snapshot}")

        _switch_mode(page, "climate")
        _assert(page, "() => getComputedStyle(document.querySelector('#wmSectionTour')).display === 'none'", "Tour section leaked into Explore")
        _assert(page, "() => getComputedStyle(document.querySelector('#strategicTimeline')).display === 'none'", "Explore timeline should stay hidden after mode switches")
        _assert(page, "() => getComputedStyle(document.querySelector('#profileCanvas')).display === 'none'", "Explore profile should stay hidden after mode switches")

        explore_snapshot = _route_sidebar_snapshot(page)
        browser.close()

    if js_errors:
        raise AssertionError("Browser JS errors detected:\n" + "\n".join(js_errors[:20]))

    print("PASS: Explore mode isolation verified.")
    print(f"tour snapshot: {tour_snapshot}")
    print(f"explore snapshot: {explore_snapshot}")
    print(f"explore summary before click: {before_click[:120]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
