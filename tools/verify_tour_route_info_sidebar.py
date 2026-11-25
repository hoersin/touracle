"""Browser regression for Step 6.2 Phase 3 route info relocation.

Usage:
  /Users/ingolfhorsch/Projekte/WeatherMap/.venv/bin/python tools/verify_tour_route_info_sidebar.py \
    --base-url http://127.0.0.1:5002
"""

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


def _resolve_tourday_dialog(page: Page) -> None:
    try:
        page.wait_for_selector(".wm-tourday-update-dialog:not([hidden])", timeout=1000)
    except Exception:
        return
    for choice in ("balanced", "preserve", "cancel"):
        opt = page.locator(f'.wm-tourday-update-option[data-choice="{choice}"]')
        if opt.count() > 0:
            opt.first.click(timeout=3000)
            break
    try:
        page.wait_for_selector(".wm-tourday-update-dialog[hidden]", timeout=5000)
    except Exception:
        pass


def _run_fetch(page: Page) -> None:
    page.click("#fetchWeather", timeout=12000)
    try:
        _assert(
            page,
            "() => String(document.querySelector('#sseStatus')?.textContent || '').trim().startsWith('Stream: done')",
            "Weather stream did not complete",
            timeout=180000,
        )
    except AssertionError:
        _assert(
            page,
            "() => document.querySelectorAll('[data-wm-route-card=\"1\"], .wm-tour-day-card, .glyph-map').length >= 1",
            "No route cards rendered after fetch",
            timeout=180000,
        )


def _route_sidebar_snapshot(page: Page) -> dict[str, Any]:
    data = page.evaluate(
        """() => {
            const start = document.querySelector('#tourSidebarRouteStart');
            const end = document.querySelector('#tourSidebarRouteEnd');
            const dist = document.querySelector('#tourSidebarRouteDistance');
            const elev = document.querySelector('#tourSidebarRouteElevation');
            const file = document.querySelector('#tourSidebarRouteFile');
            const reverse = document.querySelector('#reverse');
            return {
              start: String(start?.textContent || '').trim(),
              end: String(end?.textContent || '').trim(),
              distance: String(dist?.textContent || '').trim(),
              elevation: String(elev?.textContent || '').trim(),
              file: String(file?.textContent || '').trim(),
              reverseChecked: !!(reverse && reverse.checked)
            };
        }"""
    )
    if not data:
        raise AssertionError("Could not read route sidebar snapshot")
    return data


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify route information section in sidebar.")
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
        page.wait_for_selector("#gpxFileInput", state="attached", timeout=30000)
        _switch_mode(page, "tour")
        _assert(page, "() => getComputedStyle(document.querySelector('#strategicTimeline')).display === 'none'", "Timeline should be hidden in tour mode")

        page.set_input_files("#gpxFileInput", str(gpx_path))
        _run_fetch(page)

        before = _route_sidebar_snapshot(page)
        if not before["start"] or not before["end"] or before["start"] == "Start location":
            raise AssertionError(f"Sidebar route labels not populated: {before}")
        if before["distance"] in {"", "—"}:
            raise AssertionError(f"Sidebar distance not populated: {before}")
        if before["elevation"] in {"", "—"}:
            raise AssertionError(f"Sidebar elevation not populated: {before}")
        if ".gpx" not in before["file"].lower():
            raise AssertionError(f"Sidebar GPX file name not populated: {before}")

        page.click("#reverse", timeout=8000)
        _resolve_tourday_dialog(page)
        _run_fetch(page)
        after = _route_sidebar_snapshot(page)
        if before["start"] == after["start"] and before["end"] == after["end"]:
            raise AssertionError(f"Reverse tour did not update route endpoint labels: before={before} after={after}")

        page.reload(wait_until="domcontentloaded")
        _switch_mode(page, "tour")
        persisted_initial = _route_sidebar_snapshot(page)
        if persisted_initial["distance"] != "—":
            raise AssertionError(f"Distance should show placeholder during initial reload state: {persisted_initial}")
        if persisted_initial["elevation"] != "—":
            raise AssertionError(f"Elevation should show placeholder during initial reload state: {persisted_initial}")
        _assert(
            page,
            "() => String(document.querySelector('#tourSidebarRouteDistance')?.textContent || '').trim() !== '—'",
            "Route distance did not recover after stream completion",
            timeout=180000,
        )
        persisted = _route_sidebar_snapshot(page)
        if persisted["distance"] in {"", "—"}:
            raise AssertionError(f"Route distance missing after stream completion: {persisted}")

        _switch_mode(page, "climate")
        _assert(
            page,
            "() => getComputedStyle(document.querySelector('#strategicTimeline')).display === 'none'",
            "Explore timeline should be hidden",
            timeout=30000,
        )

        browser.close()

    if js_errors:
        raise AssertionError("Browser JS errors detected:\n" + "\n".join(js_errors[:20]))

    print("PASS: Route information sidebar migration verified.")
    print(f"before reverse: {before}")
    print(f"after reverse: {after}")
    print(f"after reload initial: {persisted_initial}")
    print(f"after reload: {persisted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
