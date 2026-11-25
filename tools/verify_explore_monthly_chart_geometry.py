"""Focused Explore regression: non-empty monthly chart SVG geometry + timing + tooltip cleanup."""

from __future__ import annotations

import argparse
import json
import time

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


def _chart_probe(page: Page) -> dict:
    return page.evaluate(
        """() => {
            const chartSvgs = [...document.querySelectorAll('#tourSummaryBadgesItems .wm-climate-monthly-chart-svg')];
            const tempSvg = chartSvgs[0] || null;
            const rainSvg = chartSvgs[1] || null;
            const tempBars = tempSvg ? [...tempSvg.querySelectorAll('rect')] : [];
            const rainBars = rainSvg ? [...rainSvg.querySelectorAll('rect')] : [];
            const windRoses = [...document.querySelectorAll('#tourSummaryLegends .wm-climate-wind-rose-svg')];
            const windScaleValues = [...new Set(windRoses.map((n) => String(n.getAttribute('data-radial-max-pct') || '').trim()).filter(Boolean))];
            const clippedRoseCount = windRoses.filter((n) => String(n.getAttribute('data-clipped') || '').toLowerCase() === 'true').length;
            const dominantMarkers = [...document.querySelectorAll('#tourSummaryLegends .wm-climate-wind-dominant-marker')].length;
            const monthDominant = [...document.querySelectorAll('#tourSummaryLegends .wm-climate-wind-rose-card')].map((card) => {
                const month = String(card.querySelector('.wm-climate-wind-rose-label')?.textContent || '').trim();
                const svg = card.querySelector('.wm-climate-wind-rose-svg');
                const sector = String(svg?.getAttribute('data-dominant-sector') || '').trim();
                const share = String(svg?.getAttribute('data-dominant-share-pct') || '').trim();
                return { month, sector, share };
            });
            const monthToken = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/;
            const tempTexts = tempSvg ? [...(tempSvg.querySelectorAll('text') || [])].map((n) => String(n.textContent || '').trim()) : [];
            const rainTexts = rainSvg ? [...(rainSvg.querySelectorAll('text') || [])].map((n) => String(n.textContent || '').trim()) : [];
            const overlayTip = document.querySelector('.wm-climate-profile-tooltip');
            const overlayTipVisible = (() => {
                if (!overlayTip) return false;
                const style = getComputedStyle(overlayTip);
                const rect = overlayTip.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            })();
            return {
                tempSvg: !!tempSvg,
                rainSvg: !!rainSvg,
                chartSvgCount: chartSvgs.length,
                tempBars: tempBars.length,
                rainBars: rainBars.length,
                windRoses: windRoses.length,
                windScaleValues,
                clippedRoseCount,
                dominantMarkers,
                monthDominant,
                detachedCompassLabels: document.querySelectorAll('#tourSummaryLegends .wm-climate-wind-compass').length,
                calmLabels: [...document.querySelectorAll('#tourSummaryLegends .wm-climate-wind-rose-meta')]
                  .map((n) => String(n.textContent || '').trim())
                  .filter((t) => /calm/i.test(t)).length,
                tempMonthCount: tempTexts.filter((token) => monthToken.test(token)).length,
                rainMonthCount: rainTexts.filter((token) => monthToken.test(token)).length,
                tooltipVisible: overlayTipVisible,
                strategicCursorTooltipPresent: !!document.querySelector('#wmStrategicCursorReadout'),
                versionBadge: (() => {
                  const n = document.querySelector('#wmVersionBadge');
                  if (!n) return null;
                  const style = getComputedStyle(n);
                  const bg = String(style.backgroundColor || '');
                  const m = bg.match(/rgba?\\(([^)]+)\\)/i);
                  let alpha = 1;
                  if (m && m[1]) {
                    const parts = m[1].split(',').map((x) => x.trim());
                    if (parts.length >= 4) {
                      const a = Number(parts[3]);
                      if (Number.isFinite(a)) alpha = a;
                    }
                  }
                  return { bg, alpha, text: String(n.textContent || '') };
                })(),
                windAlignment: (() => {
                  const title = document.querySelector('#tourSummaryLegends .wm-climate-workspace-panel-wind .wm-climate-monthly-chart-title');
                  const grid = document.querySelector('#tourSummaryLegends .wm-climate-workspace-panel-wind .wm-climate-wind-grid');
                  const rainSvg = document.querySelector('#tourSummaryBadgesItems .wm-climate-workspace-panel-charts .wm-climate-monthly-chart-svg:nth-of-type(2)');
                  const chartsPanel = document.querySelector('#tourSummaryBadgesItems .wm-climate-workspace-panel-charts');
                  if (!title || !grid || !rainSvg || !chartsPanel) return null;
                  const tr = title.getBoundingClientRect();
                  const gr = grid.getBoundingClientRect();
                  const rr = rainSvg.getBoundingClientRect();
                  const cr = chartsPanel.getBoundingClientRect();
                  return {
                    leftDeltaPx: Math.round((gr.left - tr.left) * 10) / 10,
                    bottomDeltaVsRainSvgPx: Math.round((gr.bottom - rr.bottom) * 10) / 10,
                    bottomDeltaVsChartsPanelPx: Math.round((gr.bottom - cr.bottom) * 10) / 10,
                    gridWidthPx: Math.round(gr.width),
                    gridHeightPx: Math.round(gr.height),
                  };
                })(),
                summary: String(document.querySelector('#tourSummary')?.textContent || ''),
            };
        }"""
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify Explore monthly charts render visible SVG geometry.")
    ap.add_argument("--base-url", default="http://127.0.0.1:5002")
    args = ap.parse_args()

    js_errors: list[str] = []
    request_log: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 2560, "height": 1440})
        page.on("pageerror", lambda e: js_errors.append(f"pageerror: {e}"))
        page.on(
            "console",
            lambda msg: js_errors.append(f"console:{msg.type}: {msg.text}")
            if msg.type == "error"
            and "favicon" not in msg.text.lower()
            and "404 (not found)" not in msg.text.lower()
            and "sse error event" not in msg.text.lower()
            else None,
        )
        page.on(
            "request",
            lambda req: request_log.append(req.url)
            if "/api/" in req.url
            else None,
        )

        t0 = time.time()
        page.goto(args.base_url, wait_until="domcontentloaded")
        _switch_mode(page, "climate")
        startup_ms = (time.time() - t0) * 1000.0

        # Wait for visible non-empty geometry.
        _assert(
            page,
            "() => { const charts = document.querySelectorAll('#tourSummaryBadgesItems .wm-climate-monthly-chart-svg'); if (charts.length < 2) return false; const tBars = charts[0].querySelectorAll('rect').length; const pBars = charts[1].querySelectorAll('rect').length; const roses = document.querySelectorAll('#tourSummaryLegends .wm-climate-wind-rose-svg').length; return tBars >= 36 && pBars >= 36 && roses === 12; }",
            "Explore monthly chart geometry did not become visible.",
            timeout=120000,
        )
        first_visible_ms = (time.time() - t0) * 1000.0
        startup_to_visible_ms = max(0.0, first_visible_ms - startup_ms)

        before = _chart_probe(page)
        if before["tooltipVisible"]:
            raise AssertionError(f"Tour-style floating tooltip visible in Explore: {before}")
        if "Lucky days" in before["summary"] or "Completed" in before["summary"]:
            raise AssertionError(f"Tour-specific Lucky/Completed text visible in Explore: {before}")
        if "14d" in before["summary"]:
            raise AssertionError(f"Short-term tour period summary visible in Explore: {before}")
        if before["tempMonthCount"] < 12 or before["rainMonthCount"] < 12:
            raise AssertionError(f"Expected 12 month labels in both charts: {before}")
        if before["detachedCompassLabels"] != 0:
            raise AssertionError(f"Detached N/E/S/W compass labels are still visible: {before}")
        if before["calmLabels"] != 0:
            raise AssertionError(f"Per-month calm labels are still visible: {before}")
        if len(before["windScaleValues"]) != 1:
            raise AssertionError(f"Wind roses do not share one fixed radial scale: {before}")
        if before["windScaleValues"][0] != "30":
            raise AssertionError(f"Unexpected fixed radial scale max; expected 30: {before}")
        if int(before["dominantMarkers"]) != 12:
            raise AssertionError(f"Expected dominant-direction marker on all monthly roses: {before}")
        if before.get("strategicCursorTooltipPresent"):
            raise AssertionError(f"Explore hover tooltip element should be removed: {before}")
        if not before.get("versionBadge"):
            raise AssertionError(f"Version badge not found: {before}")
        if not (0.0 < float(before["versionBadge"]["alpha"]) < 0.9):
            raise AssertionError(f"Version badge should be translucent: {before}")
        wa = before.get("windAlignment") or {}
        if abs(float(wa.get("leftDeltaPx", 999))) > 2.0:
            raise AssertionError(f"Wind grid must align with wind panel title left edge: {before}")
        if abs(float(wa.get("bottomDeltaVsChartsPanelPx", 999))) > 20.0:
            raise AssertionError(f"Wind grid bottom should align with precipitation chart bottom: {before}")

        # Moving pointer over map must not trigger a strategic hover tooltip/request storm.
        req_count_before_hover = len([u for u in request_log if "/api/location_label" in u])
        page.mouse.move(700, 260)
        page.mouse.move(760, 320)
        page.mouse.move(820, 380)
        page.wait_for_timeout(450)
        probe_after_hover = _chart_probe(page)
        req_count_after_hover = len([u for u in request_log if "/api/location_label" in u])
        if req_count_after_hover != req_count_before_hover:
            raise AssertionError("Hovering Explore map should not trigger location label requests")
        if probe_after_hover.get("strategicCursorTooltipPresent"):
            raise AssertionError("Strategic hover tooltip should not appear in Explore mode")

        # Cursor should be selection-crosshair in climate mode and grabbing during drag state.
        cursor_probe = page.evaluate(
            """() => {
                const mapEl = document.querySelector('#map.leaflet-container');
                if (!mapEl) return null;
                const normal = getComputedStyle(mapEl).cursor;
                const map = window.__WM_LEAFLET_MAP__;
                if (map) map.fire('dragstart');
                const dragging = getComputedStyle(mapEl).cursor;
                if (map) map.fire('dragend');
                return { normal, dragging };
            }"""
        )
        if not cursor_probe:
            raise AssertionError("Could not evaluate map cursor behavior")
        if ("crosshair" not in str(cursor_probe.get("normal", "")).lower()) and ("url(" not in str(cursor_probe.get("normal", "")).lower()):
            raise AssertionError(f"Expected crosshair-style map cursor in Explore mode: {cursor_probe}")
        if "grabbing" not in str(cursor_probe.get("dragging", "")).lower():
            raise AssertionError(f"Expected grabbing cursor while dragging map: {cursor_probe}")

        # location change refreshes chart geometry
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
            "() => { const charts = document.querySelectorAll('#tourSummaryBadgesItems .wm-climate-monthly-chart-svg'); if (charts.length < 2) return false; const tBars = charts[0].querySelectorAll('rect').length; const pBars = charts[1].querySelectorAll('rect').length; const roses = document.querySelectorAll('#tourSummaryLegends .wm-climate-wind-rose-svg').length; const s = String(document.querySelector('#tourSummary')?.textContent || ''); return tBars >= 36 && pBars >= 36 && roses === 12 && (/Avignon|43\\.9493|Provence|\\bFR\\b/.test(s)); }",
            "Charts did not re-render after location change.",
            timeout=60000,
        )
        avignon_probe = _chart_probe(page)
        month_to_sector = {str(entry.get("month")): str(entry.get("sector")) for entry in avignon_probe.get("monthDominant", [])}
        if month_to_sector.get("Jun") not in ("WNW", "NW", "NNW"):
            raise AssertionError(f"Avignon June dominant sector should be NW-band: {avignon_probe}")
        if month_to_sector.get("Jul") not in ("WNW", "NW", "NNW"):
            raise AssertionError(f"Avignon July dominant sector should be NW-band: {avignon_probe}")
        if int(avignon_probe.get("clippedRoseCount") or 0) < 1:
            raise AssertionError(f"Expected at least one clipped rose with fixed 30% scale: {avignon_probe}")

        # year control changes must not break chart geometry
        year_btn = page.locator("button.wm-mini-btn", has_text="2024").first
        if year_btn.count() > 0:
            year_btn.click(timeout=10000)
            _assert(
                page,
                "() => { const charts = document.querySelectorAll('#tourSummaryBadgesItems .wm-climate-monthly-chart-svg'); if (charts.length < 2) return false; const tBars = charts[0].querySelectorAll('rect').length; const pBars = charts[1].querySelectorAll('rect').length; const roses = document.querySelectorAll('#tourSummaryLegends .wm-climate-wind-rose-svg').length; return tBars >= 36 && pBars >= 36 && roses === 12; }",
                "Charts did not render correctly after year selection change.",
                timeout=60000,
            )

        # Missing-data location must fail fast and not block subsequent valid location requests.
        clicked_missing = page.evaluate(
            """() => {
                const map = window.__WM_LEAFLET_MAP__;
                const L = (window.leaflet && window.leaflet.L) || window.L;
                if (!map || !L || !L.latLng) return false;
                map.fire('click', { latlng: L.latLng(0.0, -30.0) });
                return true;
            }"""
        )
        if not clicked_missing:
            raise AssertionError("Could not trigger missing-data Explore map selection")
        _assert(
            page,
            "() => /no OFFLINE data available/i.test(String(document.querySelector('#tourSummary')?.textContent || ''))",
            "Missing-data selection did not surface strict offline error state.",
            timeout=45000,
        )

        clicked_recover = page.evaluate(
            """() => {
                const map = window.__WM_LEAFLET_MAP__;
                const L = (window.leaflet && window.leaflet.L) || window.L;
                if (!map || !L || !L.latLng) return false;
                map.fire('click', { latlng: L.latLng(43.9493, 4.8055) });
                return true;
            }"""
        )
        if not clicked_recover:
            raise AssertionError("Could not trigger recovery Explore map selection")
        _assert(
            page,
            "() => { const charts = document.querySelectorAll('#tourSummaryBadgesItems .wm-climate-monthly-chart-svg'); if (charts.length < 2) return false; const tBars = charts[0].querySelectorAll('rect').length; const pBars = charts[1].querySelectorAll('rect').length; const roses = document.querySelectorAll('#tourSummaryLegends .wm-climate-wind-rose-svg').length; const s = String(document.querySelector('#tourSummary')?.textContent || ''); return tBars >= 36 && pBars >= 36 && roses === 12 && !/no OFFLINE data available/i.test(s) && (/Avignon|43\\.9493|Provence|\\bFR\\b/.test(s)); }",
            "Valid location did not recover after missing-data selection.",
            timeout=60000,
        )

        after = _chart_probe(page)
        diagnostics = page.evaluate(
            """() => {
                try {
                  if (typeof window.wmExploreClimateDiag !== 'function') return null;
                  return window.wmExploreClimateDiag();
                } catch (_) {
                  return null;
                }
            }"""
        )
        browser.close()

    if js_errors:
        raise AssertionError("Browser JS errors detected:\n" + "\n".join(js_errors[:20]))

    print("PASS: Explore monthly chart geometry and tooltip cleanup verified.")
    print(
        json.dumps(
            {
                "startup_ms": round(startup_ms, 1),
                "first_visible_ms": round(first_visible_ms, 1),
                "startup_to_visible_ms": round(startup_to_visible_ms, 1),
                "before": before,
                "after": after,
                "api_request_counts": {
                    "climate_profile": len([u for u in request_log if "/api/explore/climate_profile" in u]),
                    "location_label": len([u for u in request_log if "/api/location_label" in u]),
                    "strategic_data": len([u for u in request_log if "/api/strategic_data" in u]),
                },
                "diag": diagnostics,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
