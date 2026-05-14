#!/usr/bin/env node

async function main() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (error) {
    throw new Error('Playwright is not installed. Run this smoke test in an environment that provides the playwright package.');
  }

  const baseUrl = process.env.WM_BASE_URL || 'http://127.0.0.1:5002';
  const yearSets = [
    ['2025'],
    ['2025', '2024'],
    ['2025', '2024', '2023'],
    ['2024', '2021'],
    ['2025', '2024', '2021'],
  ];
  const mapClicks = [
    { lat: 47.3769, lon: 8.5417, label: 'zurich' },
    { lat: 45.4642, lon: 9.19, label: 'milan' },
    { lat: 48.2082, lon: 16.3738, label: 'vienna' },
  ];

  const browser = await playwright.chromium.launch({ headless: process.env.WM_HEADLESS !== '0' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

  const waitForClimateReady = async () => {
    await page.waitForFunction(() => {
      const band = document.querySelector('#tourSummaryBadgesItems');
      const text = String(band && band.textContent || '');
      if (!band) return false;
      if (/Loading weather data/i.test(text)) return false;
      if (/Climate profile unavailable/i.test(text)) return false;
      return /Temp|Rain|Wind|Lucky/i.test(text);
    }, { timeout: 20000 });
  };

  const setYears = async (years) => {
    await page.evaluate((nextYears) => {
      const host = document.querySelector('#setStrategicYears');
      if (!host) throw new Error('Strategic years host not found');
      const buttons = Array.from(host.querySelectorAll('button'));
      for (const button of buttons) {
        const label = String(button.textContent || '').trim();
        if (!/^\d{4}$/.test(label)) continue;
        const want = nextYears.includes(label);
        const pressed = button.getAttribute('aria-pressed') === 'true';
        if (want !== pressed) button.click();
      }
    }, years);
  };

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const button = document.querySelector('#navClimate');
    if (!button) throw new Error('Climate tab not found');
    button.click();
  });

  for (const years of yearSets) {
    await setYears(years);
    await page.evaluate(() => {
      const map = window.__WM_LEAFLET_MAP__;
      if (!map) throw new Error('Leaflet map handle missing');
      map.setZoom(Math.min(8, map.getZoom() + 1));
      map.setZoom(Math.max(5, map.getZoom() - 1));
    });

    await waitForClimateReady();

    for (const point of mapClicks) {
      const payload = await page.evaluate(async ({ target, selectedYears }) => {
        const params = new URLSearchParams({
          lat: String(target.lat),
          lon: String(target.lon),
          years: selectedYears.join(','),
          mode: 'active',
          start_date: '2026-05-14',
          end_date: '2026-05-27',
        });
        const response = await fetch(`/api/weather_profile?${params.toString()}`);
        const data = await response.json();
        return {
          ok: response.ok,
          status: response.status,
          location: data && data.meta ? data.meta.location : null,
          luckyDays: data && data.summary ? data.summary.lucky_days : null,
          totalDays: data && data.summary ? data.summary.total_days : null,
          error: data && data.error ? data.error : null,
        };
      }, { target: point, selectedYears: years });
      if (!payload.ok) {
        throw new Error(`weather_profile failed for ${point.label} / ${years.join('+')}: ${payload.status} ${payload.error || ''}`);
      }
      if (!payload.location || !payload.totalDays) {
        throw new Error(`weather_profile returned incomplete data for ${point.label} / ${years.join('+')}`);
      }
    }
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});