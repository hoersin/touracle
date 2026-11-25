"""Browser regression for Step 6.3.1 Explore information workspace."""

from __future__ import annotations

import argparse
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


def _workspace_snapshot(page: Page) -> dict[str, Any]:
    data = page.evaluate(
        """() => {
            const map = document.querySelector('#map');
            const stripe = document.querySelector('#tourSummary');
            const profilePanel = document.querySelector('#profilePanel');
            const profileCanvas = document.querySelector('#profileCanvas');
            const timeline = document.querySelector('#strategicTimeline');
            const route = document.querySelector('#tourSummaryRoute');
            const badges = document.querySelector('#tourSummaryBadgesItems');
            const legends = document.querySelector('#tourSummaryLegends');
            const sidebarTimescale = document.querySelector('#strategicTimescale');
            const legendTimescale = document.querySelector('#wmStrategicLegendTimescaleRow');
            if (!map || !stripe || !profilePanel || !profileCanvas || !timeline || !route || !badges || !legends || !sidebarTimescale) return null;
            const mapRect = map.getBoundingClientRect();
            const stripeRect = stripe.getBoundingClientRect();
            return {
              mapHeight: mapRect.height,
              stripeHeight: stripeRect.height,
              mapToStripeGap: stripeRect.top - mapRect.bottom,
              profilePanelDisplay: getComputedStyle(profilePanel).display,
              profileCanvasDisplay: getComputedStyle(profileCanvas).display,
              timelineDisplay: getComputedStyle(timeline).display,
              stripeDisplay: getComputedStyle(stripe).display,
              routeText: String(route.textContent || '').trim(),
              badgesText: String(badges.textContent || '').trim(),
              legendsText: String(legends.textContent || '').trim(),
              statusText: String(document.querySelector('#sseStatus')?.textContent || '').trim(),
              summaryText: String(stripe.textContent || ''),
              sidebarTimescaleDisplay: getComputedStyle(sidebarTimescale).display,
              legendTimescaleDisplay: legendTimescale ? getComputedStyle(legendTimescale).display : 'missing',
              tempChartVisible: !!document.querySelector('#tourSummaryBadgesItems .wm-climate-monthly-chart-svg'),
              rainChartVisible: document.querySelectorAll('#tourSummaryBadgesItems .wm-climate-monthly-chart-svg').length >= 2,
              windVisible: !!document.querySelector('#tourSummaryLegends .wm-climate-wind-grid')
            };
        }"""
    )
    if not data:
        raise AssertionError("Could not collect Explore workspace snapshot")
    return data


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify Explore information workspace layout and behavior.")
    ap.add_argument("--base-url", default="http://127.0.0.1:5002")
    args = ap.parse_args()

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

        before = _workspace_snapshot(page)
        if before["profileCanvasDisplay"] != "none":
            raise AssertionError(f"Explore profile area is still visible: {before}")
        if before["timelineDisplay"] != "none":
            raise AssertionError(f"Explore timeline is still visible: {before}")
        if before["stripeDisplay"] == "none":
            raise AssertionError(f"Explore information stripe hidden: {before}")
        if float(before["stripeHeight"]) < 40:
            raise AssertionError(f"Explore information stripe not visible enough: {before}")
        if abs(float(before["mapToStripeGap"])) > 4:
            raise AssertionError(f"Unexpected blank/overlap gap between map and stripe: {before}")
        if float(before["mapHeight"]) < 420:
            raise AssertionError(f"Map did not expand after removing profile/timeline: {before}")
        if before["sidebarTimescaleDisplay"] == "none":
            raise AssertionError(f"Sidebar period control hidden in Explore: {before}")
        if before["legendTimescaleDisplay"] not in ("none", "missing"):
            raise AssertionError(f"Map-overlay period dropdown should be hidden: {before}")
        if "Loading weather data..." in before["summaryText"] or "offline weather tiles" in before["summaryText"]:
            raise AssertionError(f"Legacy route-weather loading copy shown in Explore summary: {before}")

        # Deterministic map click (Avignon) should keep climate workspace responsive and populated.
        clicked = page.evaluate(
            """() => {
                const map = window.__WM_LEAFLET_MAP__;
                const L = (window.leaflet && window.leaflet.L) || window.L;
                if (!map || !L || !L.latLng) return false;
                map.fire('click', { latlng: L.latLng(43.9493, 4.8055) });
                return true;
            }"""
        )
        if not clicked:
            raise AssertionError("Could not trigger deterministic Explore map selection")
        _assert(
            page,
            "() => document.querySelectorAll('#tourSummaryBadgesItems .wm-climate-monthly-chart-svg').length >= 2 && !!document.querySelector('#tourSummaryLegends .wm-climate-wind-grid')",
            "Explore monthly climate charts did not render after map selection",
            timeout=45000,
        )

        # Sidebar climate-year selection should still drive period updates.
        years = page.locator("#setStrategicYears button")
        if years.count() >= 2:
            before_text = page.eval_on_selector("#tourSummaryRoute", "el => String(el.textContent || '').trim()")
            years.nth(1).click(timeout=8000)
            _assert(
                page,
                "() => String(document.querySelector('#tourSummaryRoute')?.textContent || '').trim().length > 0",
                "Explore summary disappeared after sidebar period selection",
                timeout=45000,
            )
            after_text = page.eval_on_selector("#tourSummaryRoute", "el => String(el.textContent || '').trim()")
            if not after_text:
                raise AssertionError("Explore summary text empty after sidebar period selection")
            if before_text == after_text:
                # allow equal location text as long as climate panels remain present
                _assert(
                    page,
                    "() => document.querySelectorAll('#tourSummaryBadgesItems .wm-climate-monthly-chart-svg').length >= 2 && !!document.querySelector('#tourSummaryLegends .wm-climate-wind-grid')",
                    "Explore climate panels missing after sidebar period selection",
                    timeout=30000,
                )

        # Mode switching should preserve separation.
        _switch_mode(page, "tour")
        _assert(page, "() => getComputedStyle(document.querySelector('#profileCanvas')).display !== 'none'", "Tour profile should be visible")
        _switch_mode(page, "climate")
        after = _workspace_snapshot(page)
        if after["profileCanvasDisplay"] != "none" or after["timelineDisplay"] != "none":
            raise AssertionError(f"Explore components leaked after mode switches: {after}")
        if not after["tempChartVisible"] or not after["rainChartVisible"] or not after["windVisible"]:
            loading_text = str(after.get("summaryText", ""))
            if "Loading monthly climate profile" not in loading_text and "Loading local climate profile" not in loading_text:
                raise AssertionError(f"Explore monthly charts missing after mode switches: {after}")

        browser.close()

    if js_errors:
        raise AssertionError("Browser JS errors detected:\n" + "\n".join(js_errors[:20]))

    print("PASS: Explore information workspace verified.")
    print(f"before: {before}")
    print(f"after: {after}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
