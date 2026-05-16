#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (error) {
    throw new Error('Playwright is not installed. Run this scaffold with a Node environment that provides the playwright package.');
  }

  const baseUrl = process.env.WM_BASE_URL || 'http://127.0.0.1:5002';
  const screenshotDir = process.env.WM_SCREENSHOT_DIR || path.resolve(__dirname, '..', '..', 'debug_output', 'frontend_screenshots');
  const routeEnv = process.env.WM_GPX_ROUTES;
  const routes = routeEnv
    ? routeEnv.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [
        path.resolve(__dirname, '..', 'data', 'realistic_routes', 'real_route_1_freiburg_bern.gpx'),
        path.resolve(__dirname, '..', 'data', 'realistic_routes', 'real_route_2_milano_rome.gpx'),
        path.resolve(__dirname, '..', 'data', 'realistic_routes', 'real_route_3_vienna_berlin.gpx'),
        path.resolve(__dirname, '..', 'data', 'realistic_routes', 'real_route_4_barcelona_warsaw.gpx'),
        path.resolve(__dirname, '..', 'data', 'realistic_routes', 'real_route_5_porto_bucharest.gpx'),
      ];

  fs.mkdirSync(screenshotDir, { recursive: true });

  const browser = await playwright.chromium.launch({ headless: process.env.WM_HEADLESS !== '0' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

  for (const routePath of routes) {
    if (!fs.existsSync(routePath)) {
      console.warn(`Skipping missing GPX: ${routePath}`);
      continue;
    }

    const routeName = path.basename(routePath, path.extname(routePath));
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.locator('#navTour').click();
    await page.locator('#gpxFileInput').setInputFiles(routePath);
    await page.locator('#startDate').fill(process.env.WM_START_DATE || '2026-05-12');
    await page.locator('#tourDays').evaluate((node, value) => {
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, process.env.WM_TOUR_DAYS || '8');
    await page.locator('#fetchWeather').click();

    await page.waitForSelector('#map .leaflet-container', { timeout: 60000 });
    await page.waitForFunction(() => {
      const summary = document.querySelector('#tourSummaryRoute');
      return Boolean(summary && summary.textContent && summary.textContent.trim().length > 0);
    }, { timeout: 120000 });
    await page.waitForFunction(() => {
      const badges = document.querySelector('#tourSummaryBadgesItems');
      return Boolean(badges && badges.textContent && badges.textContent.trim().length > 0);
    }, { timeout: 120000 });
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#profileCanvas');
      return Boolean(canvas && canvas.clientHeight > 40 && canvas.clientWidth > 200);
    }, { timeout: 120000 });

    await page.screenshot({
      path: path.join(screenshotDir, `${routeName}.png`),
      fullPage: true,
    });
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});