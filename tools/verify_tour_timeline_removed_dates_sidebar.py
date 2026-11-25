"""Browser regression for Tour Planning timeline removal and sidebar date controls.

Usage:
  /Users/ingolfhorsch/Projekte/WeatherMap/.venv/bin/python tools/verify_tour_timeline_removed_dates_sidebar.py \
    --base-url http://127.0.0.1:5002
"""

from __future__ import annotations

import argparse
import pathlib
from datetime import date, timedelta

from playwright.sync_api import Page, sync_playwright


def _assert(page: Page, condition: str, message: str, timeout: int = 120000) -> None:
    try:
        page.wait_for_function(condition, timeout=timeout)
    except Exception as exc:
        raise AssertionError(message) from exc


def _set_input_value(page: Page, selector: str, value: str) -> None:
    page.evaluate(
        """({selector, value}) => {
            const el = document.querySelector(selector);
            if (!el) return;
            el.value = String(value || '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        {"selector": selector, "value": value},
    )


def _switch_mode(page: Page, mode: str) -> None:
    if mode == "tour":
        page.click("#navTour", timeout=10000)
    elif mode == "climate":
        page.click("#navClimate", timeout=10000)
    else:
        raise ValueError(f"Unsupported mode {mode}")
    _assert(page, f"() => document.body?.dataset?.mode === {mode!r}", f"Mode did not switch to {mode}", timeout=30000)


def _resolve_tourday_dialog(page: Page) -> None:
    try:
        page.wait_for_selector(".wm-tourday-update-dialog:not([hidden])", timeout=1200)
    except Exception:
        return
    for choice in ("balanced", "preserve", "cancel"):
        locator = page.locator(f'.wm-tourday-update-option[data-choice="{choice}"]')
        if locator.count() > 0:
            locator.first.click(timeout=3000)
            break
    try:
        page.wait_for_selector(".wm-tourday-update-dialog[hidden]", timeout=5000)
    except Exception:
        pass


def _tour_layout_snapshot(page: Page) -> dict:
    snap = page.evaluate(
        """() => {
            const timeline = document.querySelector('#strategicTimeline');
            const map = document.querySelector('#map');
            const profile = document.querySelector('#profilePanel');
            const profileCanvas = document.querySelector('#profileCanvas');
            if (!timeline || !map || !profile || !profileCanvas) return null;
            const timelineStyle = getComputedStyle(timeline);
            const mapRect = map.getBoundingClientRect();
            const profileRect = profile.getBoundingClientRect();
            return {
              timelineDisplay: timelineStyle.display,
              timelineHeight: timeline.getBoundingClientRect().height,
              mapToProfileGap: profileRect.top - mapRect.bottom,
              mapHeight: mapRect.height,
              profileCanvasHeight: profileCanvas.getBoundingClientRect().height,
              routeCards: document.querySelectorAll('[data-wm-route-card="1"], .wm-tour-day-card, .glyph-map').length
            };
        }"""
    )
    if not snap:
        raise AssertionError("Could not collect tour layout snapshot")
    return snap


def _run_fetch(page: Page) -> None:
    page.click("#fetchWeather", timeout=12000)
    try:
        _assert(
            page,
            "() => String(document.querySelector('#sseStatus')?.textContent || '').trim().startsWith('Stream: done')",
            "Tour weather stream did not complete",
            timeout=180000,
        )
    except AssertionError:
        _assert(
            page,
            "() => document.querySelectorAll('[data-wm-route-card=\"1\"], .wm-tour-day-card, .glyph-map').length >= 1",
            "Tour route cards did not render",
            timeout=180000,
        )


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify timeline removal and sidebar date workflow.")
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

    gpx = pathlib.Path(args.gpx).resolve()
    if not gpx.exists():
        raise FileNotFoundError(f"Missing GPX fixture: {gpx}")

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
        page.wait_for_selector("#startDate", state="attached", timeout=30000)
        page.wait_for_selector("#arrivalDate", state="attached", timeout=30000)
        page.wait_for_selector("#tourDays", state="attached", timeout=30000)
        page.wait_for_selector("#gpxFileInput", state="attached", timeout=30000)

        _switch_mode(page, "tour")

        # GPX + route rendering remains intact.
        page.set_input_files("#gpxFileInput", str(gpx))
        _run_fetch(page)

        # Date synchronization checks, including leap-year and reversed ranges.
        _set_input_value(page, "#startDate", "2024-02-28")
        _set_input_value(page, "#tourDays", "3")
        _resolve_tourday_dialog(page)
        _assert(
            page,
            "() => document.querySelector('#arrivalDate')?.value === '2024-03-01'",
            "Duration -> arrival sync failed for leap-year transition",
        )
        _set_input_value(page, "#arrivalDate", "2024-03-05")
        _resolve_tourday_dialog(page)
        _assert(
            page,
            "() => String(document.querySelector('#tourDays')?.value || '') === '7'",
            "Arrival -> duration sync failed across month transition",
        )
        _set_input_value(page, "#arrivalDate", "2024-02-20")
        _resolve_tourday_dialog(page)
        _assert(
            page,
            "() => String(document.querySelector('#tourDays')?.value || '') === '1'",
            "Reversed range did not clamp duration to one day",
        )
        _assert(
            page,
            "() => document.querySelector('#arrivalDate')?.value === document.querySelector('#startDate')?.value",
            "One-day tour did not synchronize arrival with departure",
        )
        _set_input_value(page, "#tourDays", "10")
        _resolve_tourday_dialog(page)
        _assert(
            page,
            "() => document.querySelector('#arrivalDate')?.value === '2024-03-08'",
            "Duration update did not recompute arrival date",
        )

        tour_snap = _tour_layout_snapshot(page)
        if tour_snap["timelineDisplay"] != "none":
            raise AssertionError(f"Timeline still visible in Tour mode: {tour_snap}")
        if float(tour_snap["timelineHeight"]) > 2:
            raise AssertionError(f"Timeline still consumes space in Tour mode: {tour_snap}")
        if abs(float(tour_snap["mapToProfileGap"])) > 4:
            raise AssertionError(f"Unexpected blank timeline gap remains: {tour_snap}")
        if float(tour_snap["profileCanvasHeight"]) < 40:
            raise AssertionError(f"Profile canvas not visible: {tour_snap}")
        if int(tour_snap["routeCards"]) < 1:
            raise AssertionError(f"Tour route cards not rendered: {tour_snap}")

        # Explore mode should no longer show the bottom timeline controls.
        _switch_mode(page, "climate")
        _assert(
            page,
            "() => getComputedStyle(document.querySelector('#strategicTimeline')).display === 'none'",
            "Explore timeline should be hidden",
            timeout=30000,
        )
        _assert(
            page,
            "() => !!document.querySelector('#strategicRangeStart') && !!document.querySelector('#strategicRangeEnd')",
            "Strategic range controls missing in DOM",
            timeout=30000,
        )
        _set_input_value(page, "#strategicRangeStart", "120")
        _set_input_value(page, "#strategicRangeEnd", "150")
        _assert(
            page,
            "() => String(document.querySelector('#strategicRangeStart')?.value || '') === '120' && String(document.querySelector('#strategicRangeEnd')?.value || '') === '150'",
            "Strategic range controls did not accept updated values",
        )

        # Reload must preserve current tour date controls.
        _switch_mode(page, "tour")
        expected_start = "2024-02-28"
        expected_days = "10"
        expected_arrival = str(date(2024, 2, 28) + timedelta(days=9))
        _assert(page, f"() => document.querySelector('#startDate')?.value === {expected_start!r}", "Start date drift before reload")
        page.reload(wait_until="domcontentloaded")
        _switch_mode(page, "tour")
        _assert(page, f"() => document.querySelector('#startDate')?.value === {expected_start!r}", "Start date not restored after reload", timeout=60000)
        _assert(page, f"() => String(document.querySelector('#tourDays')?.value || '') === {expected_days!r}", "Duration not restored after reload", timeout=60000)
        _assert(page, f"() => document.querySelector('#arrivalDate')?.value === {expected_arrival!r}", "Arrival date not restored after reload", timeout=60000)

        browser.close()

    if js_errors:
        raise AssertionError("Browser JS errors detected:\n" + "\n".join(js_errors[:20]))

    print("PASS: Tour timeline removal and sidebar date synchronization verified.")
    print(f"Tour layout snapshot: {tour_snap}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
