/* global L */
(function() {
  // Prefer canvas renderer so snapshotting (html2canvas) captures route layers without SVG transform drift.
  const map = L.map('map', { preferCanvas: true });
  try { window.__WM_LEAFLET_MAP__ = map; } catch (_) {}
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  function fmt(num, digits = 1) {
    return (num === null || num === undefined) ? '-' : Number(num).toFixed(digits);
  }

  function msToKmh(ms) {
    return (ms === null || ms === undefined) ? null : (Number(ms) * 3.6);
  }

  function msToBeaufort(ms) {
    const s = Number(ms || 0);
    const thresholds = [0.3,1.6,3.4,5.5,8.0,10.8,13.9,17.2,20.8,24.5];
    for (let i = 0; i < thresholds.length; i++) {
      if (s < thresholds[i]) return i;
    }
    return 10;
  }

  function degToCardinal(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return '-';
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    const d = ((Number(deg) % 360) + 360) % 360;
    return dirs[Math.round(d / 22.5) % 16];
  }

  function getMMDD(date) {
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${m}-${d}`;
  }

  function boundsFromLineString(coords) {
    let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
    coords.forEach(([lon, lat]) => {
      minLat = Math.min(minLat, lat);
      minLon = Math.min(minLon, lon);
      maxLat = Math.max(maxLat, lat);
      maxLon = Math.max(maxLon, lon);
    });
    return [[minLat, minLon], [maxLat, maxLon]];
  }

  const startDateInput = document.getElementById('startDate');
  const tourDaysInput = document.getElementById('tourDays');
  const fetchWeatherBtn = document.getElementById('fetchWeather');
  const stopWeatherBtn = document.getElementById('stopWeather');
  const shareBtn = document.getElementById('share');

  const settingsView = document.getElementById('settingsView');
  const setStepKm = document.getElementById('setStepKm');
  const setHistLast = document.getElementById('setHistLast');
  const setHistYears = document.getElementById('setHistYears');
  const setTempCold = document.getElementById('setTempCold');
  const setTempHot = document.getElementById('setTempHot');
  const setRainHigh = document.getElementById('setRainHigh');
  const setWindHeadComfort = document.getElementById('setWindHeadComfort');
  const setWindTailComfort = document.getElementById('setWindTailComfort');
  const setGlyphType = document.getElementById('setGlyphType');
  const setStrategicYear = document.getElementById('setStrategicYear');
  const setIncludeSea = document.getElementById('setIncludeSea');
  const setInterpolation = document.getElementById('setInterpolation');
  const setWindDensity = document.getElementById('setWindDensity');
  const setAnimSpeed = document.getElementById('setAnimSpeed');
  const setGridKm = document.getElementById('setGridKm');
  const setRideHours = document.getElementById('setRideHours');
  const setTentHours = document.getElementById('setTentHours');
  const setWindWeighting = document.getElementById('setWindWeighting');

  const strategicDayLabel = document.getElementById('strategicDayLabel');
  const strategicTimelineLabel = document.getElementById('strategicTimelineLabel');
  const strategicDaySlider = document.getElementById('strategicDaySlider');
  const strategicPlayBtn = document.getElementById('strategicPlay');
  const strategicSpeed = document.getElementById('strategicSpeed');
  const strategicMonthTicks = document.getElementById('strategicMonthTicks');
  const strategicLayerSelect = document.getElementById('strategicLayer');
  const strategicWindOn = document.getElementById('strategicWindOn');
  const strategicWindMode = document.getElementById('strategicWindMode');
  const settingsCancel = document.getElementById('settingsCancel');
  const settingsSave = document.getElementById('settingsSave');
  const progressEl = document.getElementById('progress');
  const progressBar = progressEl ? progressEl.querySelector('.bar') : null;
  const sseStatus = document.getElementById('sseStatus');
  const dropZone = document.getElementById('dropZone');
  const profileCanvas = document.getElementById('profileCanvas');
  let profileCtx = profileCanvas ? profileCanvas.getContext('2d') : null;
  const profileCursorCanvas = document.getElementById('profileCursorCanvas');
  let profileCursorCtx = profileCursorCanvas ? profileCursorCanvas.getContext('2d') : null;
  const profileTooltip = document.getElementById('profileTooltip');
  const profilePanel = document.getElementById('profilePanel');
  const mapEl = document.getElementById('map');
  const overlayContainer = document.getElementById('overlayContainer');
  const resizeHandle = document.getElementById('profileResizeHandle');
  let LAST_PROFILE = null;
  
  // Create overlay mode selector dynamically on profile panel
  let overlaySelect = document.createElement('select');
  overlaySelect.id = 'overlayMode';
  overlaySelect.style.cssText = 'position:absolute; top:8px; right:22px; background:rgba(255,255,255,0.95); border:1px solid #ccc; border-radius:4px; padding:4px 8px; font-family:system-ui,-apple-system,sans-serif; font-size:11px; z-index:1000; box-shadow:0 2px 4px rgba(0,0,0,0.1); cursor:pointer; pointer-events:auto;';
  overlaySelect.innerHTML = '<option value="temperature">Temperature</option><option value="precipitation">Precipitation</option><option value="wind">Wind</option>';
  if (profilePanel) profilePanel.appendChild(overlaySelect);
  
  let OVERLAY_MODE = overlaySelect ? overlaySelect.value : 'temperature';
  let OVERLAY_POINTS = [];
  let TOUR_DAYS_AGGR = {};
  let evtSource = null;
  let PRIME_IN_PROGRESS = false;
  let MAIN_IN_PROGRESS = false;
  let LAST_GPX_PATH = null;
  let LAST_LOAD_OPTS = null;
  let OFFLINE_FALLBACK_ACTIVE = false;

  function getBaseName(p) {
    try {
      const s = String(p || '');
      if (!s) return '';
      const parts = s.split(/[/\\]/);
      return parts[parts.length - 1] || s;
    } catch (_) {
      return '';
    }
  }

  function updateDropZoneLabel() {
    try {
      if (!dropZone) return;
      if (LAST_GPX_PATH) {
        const name = getBaseName(LAST_GPX_PATH);
        dropZone.textContent = `Loaded GPX: ${name} (click or drop to change)`;
      } else {
        dropZone.textContent = 'Drop GPX here to load route (or click to choose)';
      }
    } catch (_) {}
  }
  let flagsLayer = null;
  let REVERSED = false;
  // Route coords for map cursor sync
  let ROUTE_COORDS = null;
  let MAP_CURSOR_MARKER = null;
  // Precomputed profile x positions and route index mapping
  let PROFILE_XS = [];
  let PROFILE_ROUTE_INDEXES = [];
  // Pin and glyph preview dimensions for profile
  const PIN_H = 17;           // stem height in px
  const PREVIEW_SIZE = 36;    // glyph preview size in px
  const PREVIEW_MARGIN = 4;   // small spacing
  // Cache tiny images for glyph previews in profile pins
  let PROFILE_GLYPH_CACHE = {};
  // Bitmap caches for classic weather and thermometer icons
  const WEATHER_BITMAPS = {};
  const THERMO_BITMAPS = {};
  const CYCLIST_GLYPH_CACHE = {};
  function preloadWeatherBitmap(cls) {
    const key = String(cls);
    if (WEATHER_BITMAPS[key]) return WEATHER_BITMAPS[key];
    const img = new Image();
    img.src = `/assets/glyphs/weather/weather_${key}.png`;
    WEATHER_BITMAPS[key] = img;
    return img;
  }
  function preloadThermoBitmap(temp) {
    const t = Math.max(-20, Math.min(40, Math.round(Number(temp)/2)*2));
    const key = `thermo_${t}`;
    if (THERMO_BITMAPS[key]) return THERMO_BITMAPS[key];
    const img = new Image();
    img.src = `/assets/glyphs/thermometers/${key}.png`;
    THERMO_BITMAPS[key] = img;
    return img;
  }
  function classify_weather(rain_probability, typical_rain_mm, t25, t75) {
    const rp = Number(rain_probability);
    const mm = Number(typical_rain_mm);
    const p25 = Number(t25);
    const p75 = Number(t75);
    if ((rp >= 0.6) || (mm >= 3.0)) return 'rain';
    if ((rp >= 0.3) || (mm >= 0.5)) return 'light_rain';
    const temp_range = (p75 - p25);
    if (temp_range < 4.0) return 'cloudy';
    if (temp_range > 8.0) return 'sunny';
    return 'partly_cloudy';
  }
  const today = new Date();
  // Default Start Date to today if empty
  if (!startDateInput.value) {
    startDateInput.value = today.toISOString().slice(0,10);
  }
  // Climatic map day is driven by the bottom slider (initialized below).

  // Mode navigation is wired externally (inlined in index.html).

  let routeLayer = null;
  let glyphLayer = null;
  let glyphLayerNew = null;
  // Persist years span from route event for stable progress text
  let YEARS_SPAN_TEXT = null;
  // Defer changes to tour days while streams are active
  let PENDING_TOUR_DAYS = null;
  
  // Brighten glyph SVG colors after recalculation finishes
  function brightenMarkerSVG(marker) {
    try {
      const el = marker._icon;
      if (!el) return;
      const glyphDiv = el.querySelector && (el.querySelector('.glyph-inner') || el.querySelector('.glyph'));
      if (!glyphDiv) return;
      const html = glyphDiv.innerHTML;
      // Slightly increase contrast while keeping soft appearance
      let brighter = html.replace(/fill-opacity="0\.9[0-9]?"/g, 'fill-opacity="0.88"');
      brighter = brighter.replace(/fill-opacity="0\.[0-5]"/g, 'fill-opacity="0.78"');
      if (brighter !== html) {
        glyphDiv.innerHTML = brighter;
      }
    } catch (_) {}
  }

  // Render an instrument-style wind rosette (24px suggested size)
  // windData: { median_speed, median_direction, circ_std, eff_relative }
  function renderWindRosette(ctx, cx, cy, windData, size = 24) {
    try {
      if (!ctx || !windData) return;
      const R = Math.max(6, Math.min(12, Math.floor(size/2)));
      const colCircle = 'rgba(0,0,0,0.35)';
      const colTicks = 'rgba(0,0,0,0.45)';
      const colArrow = '#333';
      // Circle
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI*2);
      ctx.strokeStyle = colCircle;
      ctx.lineWidth = 1;
      ctx.stroke();
      // 8-direction ticks (every 45°); N/E/S/W thicker
      for (let i = 0; i < 8; i++) {
        const ang = i * (Math.PI/4); // radians
        const isMajor = (i % 2 === 0);
        const r0 = R - (isMajor ? 5 : 3);
        const r1 = R - 1;
        const x0 = cx + r0 * Math.cos(ang);
        const y0 = cy + r0 * Math.sin(ang);
        const x1 = cx + r1 * Math.cos(ang);
        const y1 = cy + r1 * Math.sin(ang);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = colTicks;
        ctx.lineWidth = isMajor ? 2 : 1;
        ctx.stroke();
      }
      // Variability sector: circ_std in degrees around median_direction
      const stdDeg = Number(windData.circ_std || windData.windVar || 0);
      const dirDeg = Number(windData.median_direction || windData.windDir || 0);
      if (stdDeg > 0) {
        const half = Math.min(90, Math.max(2, stdDeg));
        const a0 = (dirDeg - half) * Math.PI/180;
        const a1 = (dirDeg + half) * Math.PI/180;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R - 2, a0, a1);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.fill();
      }
      // Wind arrow: angle=median_direction, length scaled by median_speed
      const spd = Number(windData.median_speed || windData.windSpeed || 0);
      const len = Math.min(R - 3, Math.max(5, spd * 1.2)); // scale ~1.2 px per m/s, capped
      const a = (dirDeg) * Math.PI/180;
      const ax = cx + len * Math.cos(a);
      const ay = cy + len * Math.sin(a);
      // Arrow shaft
      let arrowColor = colArrow;
      if (typeof windData.eff_relative === 'number') {
        if (windData.eff_relative > 0.5) arrowColor = '#1e90ff'; // tailwind → blue
        else if (windData.eff_relative < -0.5) arrowColor = '#c0392b'; // headwind → red
        else arrowColor = '#555'; // crosswind → gray
      }
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ax, ay);
      ctx.strokeStyle = arrowColor;
      ctx.lineWidth = 2;
      ctx.stroke();
      // Arrowhead (triangle)
      const ah = 5;
      const aw = 3;
      const leftA = a + Math.PI - 0.35;
      const rightA = a + Math.PI + 0.35;
      const lx = ax + ah * Math.cos(leftA);
      const ly = ay + ah * Math.sin(leftA);
      const rx = ax + ah * Math.cos(rightA);
      const ry = ay + ah * Math.sin(rightA);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(lx, ly);
      ctx.lineTo(rx, ry);
      ctx.closePath();
      ctx.fillStyle = arrowColor;
      ctx.fill();
    } catch (e) { /* noop */ }
  }

  // Temperature → color (shared ramp with glyphs)
  function tempColor(t) {
    // Palette B: Blue → Teal → Lime → Yellow → Orange → Crimson
    const anchors = [
      { t: -20.0, c: [0x00, 0x5b, 0xff] }, // cold
      { t: -10.0, c: [0x00, 0xb3, 0xcc] }, // cool
      { t: 0.0,   c: [0x00, 0xd9, 0xa3] }, // freezing
      { t: 15.0,  c: [0x7d, 0xff, 0x00] }, // mild
      { t: 20.0,  c: [0xff, 0xf2, 0x00] }, // warm
      { t: 25.0,  c: [0xff, 0x99, 0x33] }, // hot
      { t: 30.0,  c: [0xff, 0x33, 0x33] }, // very hot
      { t: 40.0,  c: [0xcc, 0x00, 0x00] }, // extreme
    ];
    const tt = Math.max(anchors[0].t, Math.min(anchors[anchors.length-1].t, Number(t)));
    for (let i = 0; i < anchors.length - 1; i++) {
      const a0 = anchors[i], a1 = anchors[i+1];
      if (a0.t <= tt && tt <= a1.t) {
        const u = (a1.t === a0.t) ? 1 : (tt - a0.t) / (a1.t - a0.t);
        const r = Math.round(a0.c[0] + u * (a1.c[0] - a0.c[0]));
        const g = Math.round(a0.c[1] + u * (a1.c[1] - a0.c[1]));
        const b = Math.round(a0.c[2] + u * (a1.c[2] - a0.c[2]));
        return `rgba(${r},${g},${b},1)`;
      }
    }
    const c = anchors[anchors.length-1].c; return `rgba(${c[0]},${c[1]},${c[2]},1)`;
  }

  // Map rain probability to weather icon class
  function mapWeatherByProb(prob) {
    const p = Number(prob||0);
    if (p < 0.2) return 'sunny';
    if (p < 0.5) return 'partly_cloudy';
    if (p < 0.8) return 'light_rain';
    return 'rain';
  }

  function renderThermometer(ctx, cx, topY, tempMed, t25, t75) {
    const w = 12, h = 40;
    const tubePad = 2;
    const x0 = Math.round(cx - w/2), x1 = x0 + w;
    const y0 = Math.round(topY), y1 = y0 + h;
    // Outer body (black border)
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    const bodyPad = 2;
    ctx.beginPath();
    const r = 6;
    ctx.moveTo(x0-bodyPad, y0);
    ctx.lineTo(x1+bodyPad, y0);
    ctx.lineTo(x1+bodyPad, y1+bodyPad);
    ctx.lineTo(x0-bodyPad, y1+bodyPad);
    ctx.closePath();
    ctx.fill();
    // Glass tube
    ctx.fillStyle = 'rgba(230,230,230,1)';
    ctx.fillRect(x0, y0, w, h);
    // Variance band (p25..p75)
    if (typeof t25 === 'number' && typeof t75 === 'number') {
      const minT=-20, maxT=40;
      const f = (v)=> Math.max(0, Math.min(1, (v-minT)/(maxT-minT)));
      const fy0 = Math.round(y1 - (f(t75) * (h - tubePad*2)) - tubePad);
      const fy1 = Math.round(y1 - (f(t25) * (h - tubePad*2)) - tubePad);
      const bandH = Math.max(2, fy1 - fy0);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(x0+tubePad, fy0, w - tubePad*2, bandH);
    }
    // Fluid fill
    const minT=-20, maxT=40;
    const f = (v)=> Math.max(0, Math.min(1, (v-minT)/(maxT-minT)));
    const frac = f(Number(tempMed||0));
    const fluidH = Math.round(frac * (h - tubePad*2));
    const yy0 = y1 - fluidH - tubePad;
    ctx.fillStyle = tempColor(Number(tempMed||0));
    ctx.fillRect(x0+tubePad, yy0, w - tubePad*2, fluidH);
    // Highlight stripe
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x0+1, y0+2, 2, h-4);
  }

  function renderWeatherIcon(ctx, cx, topY, cls) {
    const img = preloadWeatherBitmap(cls);
    const size = 18;
    if (img && img.complete) {
      ctx.drawImage(img, Math.round(cx - size/2), Math.round(topY), size, size);
    }
  }

  // Weather icon with opacity scaled by probability (0..1)
  function renderWeatherIconWithOpacity(ctx, cx, topY, prob) {
    const p = Math.max(0, Math.min(1, Number(prob||0)));
    let cls = 'sunny';
    if (p < 0.2) cls = 'sunny';
    else if (p < 0.5) cls = 'partly_cloudy';
    else if (p < 0.8) cls = 'rain';
    else cls = 'rain'; // heavy rain fallback to rain icon
    const img = preloadWeatherBitmap(cls);
    const size = 18;
    if (img && img.complete) {
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = Math.max(0.4, Math.min(1.0, 0.4 + 0.6 * p));
      ctx.drawImage(img, Math.round(cx - size/2), Math.round(topY), size, size);
      ctx.globalAlpha = prevAlpha;
    }
  }

  // Resize inline SVG glyph markup to a fixed pixel size to avoid inheriting 64px defaults
  function resizeGlyphSVG(svgHtml, sizePx) {
    try {
      if (typeof svgHtml !== 'string' || svgHtml.indexOf('<svg') === -1) return svgHtml;
      const sizeStr = String(Math.round(Number(sizePx) || 51));
      let out = svgHtml;
      out = out.replace(/<svg\b([^>]*)>/i, (m, attrs) => {
        let a = attrs;
        a = a.replace(/\bwidth="[^"]*"/i, '').replace(/\bheight="[^"]*"/i, '');
        if (/style="[^"]*"/i.test(a)) {
          a = a.replace(/style="([^"]*)"/i, (mm, s) => {
            let ss = s.replace(/\bwidth\s*:\s*[^;]*;?/i, '').replace(/\bheight\s*:\s*[^;]*;?/i, '');
            ss = `width:${sizeStr}px;height:${sizeStr}px;${ss}`.replace(/;;+/g, ';');
            return `style="${ss}"`;
          });
        } else {
          a = `${a} style="width:${sizeStr}px;height:${sizeStr}px;"`;
        }
        a = `${a} width="${sizeStr}" height="${sizeStr}"`;
        return `<svg ${a}>`;
      });
      return out;
    } catch (_) { return svgHtml; }
  }

  // Cyclist wind rosette + arrow: priority on arrow length/color
  function renderWindRosetteCyclist(ctx, cx, cy, windData, size = 22) {
    if (!ctx || !windData) return;
    const R = Math.max(6, Math.min(11, Math.floor(size/2)));
    // Circle
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Ticks
    for (let i = 0; i < 8; i++) {
      const ang = i * (Math.PI/4);
      const isMajor = (i % 2 === 0);
      const r0 = R - (isMajor ? 5 : 3);
      const r1 = R - 1;
      ctx.beginPath();
      ctx.moveTo(cx + r0*Math.cos(ang), cy + r0*Math.sin(ang));
      ctx.lineTo(cx + r1*Math.cos(ang), cy + r1*Math.sin(ang));
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = isMajor ? 2 : 1;
      ctx.stroke();
    }
    // Variability sector
    const stdDeg = Number(windData.circ_std || windData.windVar || 0);
    const dirDeg = Number(windData.median_direction || windData.windDir || 0);
    if (stdDeg > 0) {
      const half = Math.min(90, Math.max(2, stdDeg));
      const a0 = (dirDeg - half) * Math.PI/180;
      const a1 = (dirDeg + half) * Math.PI/180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R - 2, a0, a1);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fill();
    }
    // Wind arrow length tiers
    const spd = Number(windData.median_speed || windData.windSpeed || 0);
    let len = R * 0.5; // 0-2 m/s
    if (spd >= 2 && spd < 4) len = R * 0.8;
    else if (spd >= 4 && spd < 6) len = R * 1.1;
    else if (spd >= 6 && spd < 8) len = R * 1.3;
    else if (spd >= 8) len = R * 1.5; // allow overflow
    const a = dirDeg * Math.PI/180;
    const ax = cx + len * Math.cos(a);
    const ay = cy + len * Math.sin(a);
    // Color by relative wind
    let arrowColor = '#666';
    if (typeof windData.eff_relative === 'number') {
      if (windData.eff_relative > 0.33) arrowColor = '#2ecc71'; // tailwind green
      else if (windData.eff_relative < -0.33) arrowColor = '#e74c3c'; // headwind red
      else arrowColor = '#666'; // crosswind gray
    }
    // Shaft
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ax, ay);
    ctx.strokeStyle = arrowColor;
    ctx.lineWidth = 2;
    ctx.stroke();
    // Arrowhead
    const ah = 5;
    const leftA = a + Math.PI - 0.35;
    const rightA = a + Math.PI + 0.35;
    const lx = ax + ah * Math.cos(leftA);
    const ly = ay + ah * Math.sin(leftA);
    const rx = ax + ah * Math.cos(rightA);
    const ry = ay + ah * Math.sin(rightA);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(lx, ly);
    ctx.lineTo(rx, ry);
    ctx.closePath();
    ctx.fillStyle = arrowColor;
    ctx.fill();
  }

  // Build or fetch cyclist glyph offscreen canvas
  function getCyclistGlyphCanvas(key, data) {
    if (CYCLIST_GLYPH_CACHE[key]) return CYCLIST_GLYPH_CACHE[key];
    const totalW = 24;
    const totalH = 18 + 3 + 40 + 4 + 22; // spacing 3/4 px
    const cvs = document.createElement('canvas');
    cvs.width = totalW;
    cvs.height = totalH;
    const ctx = cvs.getContext('2d');
    const cx = Math.round(totalW/2);
    // Top: weather icon with opacity
    renderWeatherIconWithOpacity(ctx, cx, 0, data.rainProb);
    // Middle: thermometer
    renderThermometer(ctx, cx, 18 + 3, data.tMed, data.t25, data.t75);
    // Bottom: wind rosette + primary arrow
    const roseY = 18 + 3 + 40 + 4 + Math.round(22/2);
    renderWindRosetteCyclist(ctx, cx, roseY, { median_speed: data.windSpeed, median_direction: data.windDir, circ_std: data.windVar, eff_relative: data.effRel }, 22);
    CYCLIST_GLYPH_CACHE[key] = cvs;
    return cvs;
  }

  // Settings persistence
  function loadSettings() {
    const s = localStorage.getItem('wm_settings');
    const nowYear = (new Date()).getFullYear();
    const defaultLastYear = Math.max(1970, nowYear - 1);
    const defaults = {
      stepKm: 60,
      histLastYear: defaultLastYear,
      histYears: 10,
      tempCold: 5,
      tempHot: 30,
      rainHigh: 10,
      windHeadComfort: 4,
      windTailComfort: 10,
      useClassicWeatherIcons: true,
      glyphType: 'classic',
      // Strategic/tactical settings (Phase 1: persisted but not yet fully used)
      strategicYear: 2025,
      includeSea: false,
      interpolation: true,
      windDensity: 40,
      animSpeed: 1.0,
      gridKm: 50,
      rideHours: '10-16',
      tentHours: '18-08',
      windWeighting: 'relative',
    };
    if (!s) return defaults;
    try {
      const j = JSON.parse(s);
      const yearsN = Number(j.histYears);
      const safeYears = (Number.isFinite(yearsN) && yearsN >= 1) ? Math.round(yearsN) : defaults.histYears;
      let lastY = Number(j.histLastYear);
      if (!Number.isFinite(lastY)) lastY = Number(j.histEndYear);
      if (!Number.isFinite(lastY)) {
        // Backward compatibility: histStartYear + histYears - 1
        const startY = Number(j.histStartYear);
        if (Number.isFinite(startY)) lastY = Math.round(startY + safeYears - 1);
      }
      if (!Number.isFinite(lastY)) lastY = defaults.histLastYear;
      return {
        ...defaults,
        stepKm: Number(j.stepKm) || defaults.stepKm,
        histLastYear: Math.round(Number(lastY) || defaults.histLastYear),
        histYears: safeYears,
        tempCold: Number.isFinite(Number(j.tempCold)) ? Number(j.tempCold) : defaults.tempCold,
        tempHot: Number.isFinite(Number(j.tempHot)) ? Number(j.tempHot) : defaults.tempHot,
        rainHigh: Number.isFinite(Number(j.rainHigh)) ? Number(j.rainHigh) : defaults.rainHigh,
        // legacy windThresh retained for backward compatibility if present
        windHeadComfort: Number.isFinite(Number(j.windHeadComfort))
          ? Number(j.windHeadComfort)
          : (Number.isFinite(Number(j.windThresh)) ? Number(j.windThresh) : defaults.windHeadComfort),
        windTailComfort: Number.isFinite(Number(j.windTailComfort)) ? Number(j.windTailComfort) : defaults.windTailComfort,
        glyphType: (typeof j.glyphType === 'string')
          ? j.glyphType
          : ((typeof j.useClassicWeatherIcons === 'boolean') ? (j.useClassicWeatherIcons ? 'classic' : 'svg') : defaults.glyphType),
        useClassicWeatherIcons: (typeof j.useClassicWeatherIcons === 'boolean')
          ? j.useClassicWeatherIcons
          : ((typeof j.glyphType === 'string') ? (j.glyphType === 'classic') : defaults.useClassicWeatherIcons),
        strategicYear: Number(j.strategicYear) || defaults.strategicYear,
        includeSea: (typeof j.includeSea === 'boolean') ? j.includeSea : defaults.includeSea,
        interpolation: (typeof j.interpolation === 'boolean') ? j.interpolation : defaults.interpolation,
        windDensity: Number(j.windDensity) || defaults.windDensity,
        animSpeed: Number(j.animSpeed) || defaults.animSpeed,
        gridKm: Number(j.gridKm) || defaults.gridKm,
        rideHours: (typeof j.rideHours === 'string') ? j.rideHours : defaults.rideHours,
        tentHours: (typeof j.tentHours === 'string') ? j.tentHours : defaults.tentHours,
        windWeighting: (typeof j.windWeighting === 'string') ? j.windWeighting : defaults.windWeighting,
      };
    } catch {
      return defaults;
    }
  }

  function saveSettings(vals) {
    localStorage.setItem('wm_settings', JSON.stringify(vals));
  }

  let SETTINGS = loadSettings();
  // Default toggle to show classic weather + thermometer bitmaps in profile pins
  if (SETTINGS.useClassicWeatherIcons === undefined) SETTINGS.useClassicWeatherIcons = true;
  let STEP_KM = SETTINGS.stepKm;       // reduce sampling density to avoid rate limits
    const MAX_POINTS = 20;    // cap number of points for faster loads (to be removed)
  let DEBUG_CURSOR = false;   // toggle cursor alignment debug overlay
  let DEBUG_CURSOR_LOG = false; // log mouse X and computed km continuously
  let DEBUG_PROFILE_STEP = false; // step-by-step profile drawing with spacebar pauses
  let DEBUG_STEP_COUNTER = 0;
  let DEBUG_STEP_RESOLVER = null; // Holds the promise resolver for the current step
  // Remove heuristic DPR scaling and offset; map mouse-X directly to profile domain
  let CURSOR_X_SCALE = 1;     // unified scale (no DPR correction)
  let CURSOR_X_OFFSET = 0;    // no offset fudge
  let CURSOR_OFFSET_LOCKED = true; // lock to prevent heuristic changes

  // -------------------- Mode side effects --------------------
  // Tab selection + pill positioning is handled by the inlined script in index.html.
  // This function remains as the single place for non-visual side effects.
  let LAST_NON_SETTINGS_MODE = 'tour';
  function setMode(mode) {
    const m = (mode === 'climate' || mode === 'tour' || mode === 'settings') ? mode : 'tour';
    if (m !== 'settings') LAST_NON_SETTINGS_MODE = m;
    try { document.body.dataset.mode = m; } catch (_) {}

    try {
      strategicSetActive && strategicSetActive(m === 'climate');
    } catch (_) {}

    // Map needs a resize nudge when toggling profile/map visibility.
    if (m !== 'settings') {
      setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 60);
    }

    // When entering settings, sync form from current settings.
    if (m === 'settings') {
      try { applySettingsToForm(SETTINGS); } catch (_) {}
    }
  }
  try { window.setMode = setMode; } catch (_) {}

  // -------------------- Climatic Map (Strategic) --------------------
  const STRATEGIC_DEFAULT_YEAR = 2025;
  const STRATEGIC_CROSSFADE_MS = 300;
  const STRATEGIC_FETCH_THROTTLE_MS = 180;

  function _clamp01(t) {
    if (t < 0) return 0;
    if (t > 1) return 1;
    return t;
  }
  function _lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function _lerpColor(c0, c1, t) {
    return {
      r: Math.round(_lerp(c0.r, c1.r, t)),
      g: Math.round(_lerp(c0.g, c1.g, t)),
      b: Math.round(_lerp(c0.b, c1.b, t)),
    };
  }

  function _paletteSample(stops, t) {
    // stops: [{t:0..1, c:{r,g,b}}]
    const tt = _clamp01(t);
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (tt >= a.t && tt <= b.t) {
        const u = (tt - a.t) / Math.max(1e-9, (b.t - a.t));
        return _lerpColor(a.c, b.c, u);
      }
    }
    return (tt <= stops[0].t) ? stops[0].c : stops[stops.length - 1].c;
  }

  // Apple-like palettes
  const PAL_TEMP = [
    { t: 0.00, c: { r: 15, g: 45, b: 120 } },
    { t: 0.18, c: { r: 70, g: 130, b: 220 } },
    { t: 0.38, c: { r: 60, g: 185, b: 140 } },
    { t: 0.55, c: { r: 240, g: 225, b: 90 } },
    { t: 0.72, c: { r: 245, g: 160, b: 70 } },
    { t: 1.00, c: { r: 210, g: 50, b: 45 } },
  ];
  const PAL_RAIN = [
    { t: 0.00, c: { r: 120, g: 200, b: 255 } },
    { t: 0.45, c: { r: 70, g: 140, b: 235 } },
    { t: 1.00, c: { r: 55, g: 70, b: 190 } },
  ];
  const PAL_COMFORT = [
    { t: 0.00, c: { r: 210, g: 55, b: 45 } },
    { t: 0.35, c: { r: 245, g: 140, b: 55 } },
    { t: 0.70, c: { r: 245, g: 220, b: 90 } },
    { t: 1.00, c: { r: 60, g: 170, b: 110 } },
  ];
  const PAL_WIND = [
    { t: 0.00, c: { r: 200, g: 215, b: 225 } },
    { t: 1.00, c: { r: 90, g: 115, b: 140 } },
  ];

  function _buildYearDates(year) {
    const y = Number(year);
    const start = new Date(Date.UTC(y, 0, 1));
    const end = new Date(Date.UTC(y + 1, 0, 1));
    const dates = [];
    for (let d = new Date(start); d < end; d = new Date(d.getTime() + 24 * 3600 * 1000)) {
      const iso = d.toISOString().slice(0, 10);
      const mm = d.getUTCMonth() + 1;
      const dd = d.getUTCDate();
      const label = `${String(dd).padStart(2, '0')}.${String(mm).padStart(2, '0')}.${y}`;
      dates.push({ iso, month: mm, day: dd, label });
    }
    return dates;
  }

  function _monthStartsForYearDates(dates) {
    const starts = [];
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i];
      if (d.day === 1) starts.push({ idx: i, month: d.month });
    }
    return starts;
  }

  function _renderMonthTicks(dates) {
    if (!strategicMonthTicks) return;
    strategicMonthTicks.innerHTML = '';
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const starts = _monthStartsForYearDates(dates);
    const n = Math.max(1, dates.length - 1);
    starts.forEach(s => {
      const el = document.createElement('div');
      el.className = 'wm-tick wm-major';
      el.style.left = `${(s.idx / n) * 100}%`;
      strategicMonthTicks.appendChild(el);

      const lab = document.createElement('div');
      lab.className = 'wm-month-label';
      lab.style.left = `${(s.idx / n) * 100}%`;
      lab.textContent = monthNames[(s.month - 1) % 12];
      strategicMonthTicks.appendChild(lab);
    });
  }

  function _fmtISO(iso) {
    try {
      const d = new Date(iso);
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const yy = String(d.getUTCFullYear());
      return `${dd}.${mm}.${yy}`;
    } catch (_) {
      return String(iso);
    }
  }

  function _comfortScore(tempC, rainMm, windMs, isTent) {
    const tCold = Number(SETTINGS.tempCold);
    const tHot = Number(SETTINGS.tempHot);
    const rMax = Number(SETTINGS.rainHigh);
    const wMax = Number(SETTINGS.windHeadComfort);
    const t = Number(tempC);
    const r = Math.max(0, Number(rainMm));
    const w = Math.max(0, Number(windMs));
    if (!Number.isFinite(t) || !Number.isFinite(r) || !Number.isFinite(w)) return null;

    // Temperature: strong mid-range contrast (10–25°C) by using tighter falloff.
    const fall = isTent ? 12 : 10;
    let tScore = 1.0;
    if (t < tCold) tScore = _clamp01(1 - (tCold - t) / fall);
    if (t > tHot) tScore = _clamp01(1 - (t - tHot) / fall);

    const rHi = Math.max(0.1, rMax);
    const wHi = Math.max(0.1, wMax);
    const rScore = _clamp01(1 - (r / (2.0 * rHi)));
    const wScore = _clamp01(1 - (w / (2.0 * wHi)));

    const score = Math.pow(_clamp01(tScore), 1.0) * Math.pow(_clamp01(rScore), 1.1) * Math.pow(_clamp01(wScore), 1.0);
    return _clamp01(score);
  }

  function _makeHeatLayer() {
    const Layer = L.Layer.extend({
      onAdd: function(m) {
        this._map = m;
        this._container = L.DomUtil.create('div', 'wm-strategic-heat');
        this._container.style.position = 'absolute';
        this._container.style.left = '0';
        this._container.style.top = '0';
        this._container.style.pointerEvents = 'none';

        this._cA = L.DomUtil.create('canvas', '', this._container);
        this._cB = L.DomUtil.create('canvas', '', this._container);
        [this._cA, this._cB].forEach(c => {
          c.style.position = 'absolute';
          c.style.left = '0';
          c.style.top = '0';
          c.style.width = '100%';
          c.style.height = '100%';
          c.style.opacity = '0';
          c.style.transition = `opacity ${STRATEGIC_CROSSFADE_MS}ms ease`;
        });
        this._front = this._cA;
        this._back = this._cB;
        this._front.style.opacity = '1';
        this._back.style.opacity = '0';

        m.getPanes().overlayPane.appendChild(this._container);
        m.on('moveend zoomend resize', this._reset, this);
        this._reset();
      },
      onRemove: function(m) {
        m.off('moveend zoomend resize', this._reset, this);
        try { this._container && this._container.remove(); } catch (_) {}
        this._map = null;
      },
      _reset: function() {
        if (!this._map || !this._container) return;
        const size = this._map.getSize();
        const dpr = (window.devicePixelRatio || 1);
        this._container.style.width = `${size.x}px`;
        this._container.style.height = `${size.y}px`;
        [this._cA, this._cB].forEach(c => {
          c.width = Math.max(1, Math.floor(size.x * dpr));
          c.height = Math.max(1, Math.floor(size.y * dpr));
        });
      },
      drawWith: function(drawFn) {
        if (!this._map) return;
        this._reset();
        const dpr = (window.devicePixelRatio || 1);
        const ctx = this._back.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this._back.width, this._back.height);
        ctx.scale(dpr, dpr);
        try { drawFn(ctx, this._map.getSize()); } catch (e) { console.error('strategic draw', e); }

        // Crossfade
        this._back.style.opacity = '1';
        this._front.style.opacity = '0';
        const prevFront = this._front;
        this._front = this._back;
        this._back = prevFront;
      },
    });
    return new Layer();
  }

  function _makeWindLayer() {
    const Layer = L.Layer.extend({
      onAdd: function(m) {
        this._map = m;
        this._container = L.DomUtil.create('div', 'wm-strategic-wind');
        this._container.style.position = 'absolute';
        this._container.style.left = '0';
        this._container.style.top = '0';
        this._container.style.pointerEvents = 'none';
        this._canvas = L.DomUtil.create('canvas', '', this._container);
          this._canvas.style.position = 'absolute';
        this._canvas.style.left = '0';
        this._canvas.style.top = '0';
        this._canvas.style.width = '100%';
        this._canvas.style.height = '100%';
        this._anim = null;
        this._particles = [];
        m.getPanes().overlayPane.appendChild(this._container);
        m.on('moveend zoomend resize', this._reset, this);
        this._reset();
      },
      onRemove: function(m) {
        m.off('moveend zoomend resize', this._reset, this);
        this.stop();
        try { this._container && this._container.remove(); } catch (_) {}
        this._map = null;
      },
      _reset: function() {
        if (!this._map || !this._container) return;
        const size = this._map.getSize();
        const dpr = (window.devicePixelRatio || 1);
        this._container.style.width = `${size.x}px`;
        this._container.style.height = `${size.y}px`;
        this._canvas.width = Math.max(1, Math.floor(size.x * dpr));
        this._canvas.height = Math.max(1, Math.floor(size.y * dpr));
      },
      stop: function() {
        if (this._anim) {
          try { cancelAnimationFrame(this._anim); } catch (_) {}
          this._anim = null;
        }
      },
      clear: function() {
        const ctx = this._canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      },
      drawArrows: function(points, sampleFn) {
        this.stop();
        this._reset();
        const m = this._map;
        if (!m) return;
        const dpr = (window.devicePixelRatio || 1);
        const ctx = this._canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        ctx.scale(dpr, dpr);

        const z = m.getZoom();
        const baseStep = Math.max(1, Math.round(60 - Math.min(10, Math.max(0, z - 5)) * 4));
        const density = Math.max(1, Number(SETTINGS.windDensity) || 40);
        const stride = Math.max(1, Math.round(baseStep * 40 / density));
        const col = 'rgba(90,115,140,0.65)';
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.lineWidth = 1.2;

        let i = 0;
        for (const p of (points || [])) {
          i++;
          if (stride > 1 && (i % stride) !== 0) continue;
          const lat = Number(p.lat);
          const lon = Number(p.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const s = sampleFn(lat, lon);
          if (!s || !Number.isFinite(s.wind_speed_ms) || !Number.isFinite(s.wind_dir_deg)) continue;
          const pt = m.latLngToContainerPoint([lat, lon]);
          const x = pt.x;
          const y = pt.y;
          const sp = Math.max(0, Number(s.wind_speed_ms));
          const varDeg = Number(s.wind_var_deg);
          const alpha = (Number.isFinite(varDeg) ? _clamp01(1 - (varDeg / 90)) : 0.7);
          const len = 8 + Math.min(18, sp * 1.6);
          // wind_dir_deg is FROM; show TO
          const theta = ((Number(s.wind_dir_deg) + 180) % 360) * Math.PI / 180;
          const dx = Math.sin(theta) * len;
          const dy = -Math.cos(theta) * len;
          ctx.globalAlpha = 0.25 + 0.65 * alpha;
          ctx.beginPath();
          ctx.moveTo(x - dx * 0.5, y - dy * 0.5);
          ctx.lineTo(x + dx * 0.5, y + dy * 0.5);
          ctx.stroke();
          // arrow head
          const hx = x + dx * 0.5;
          const hy = y + dy * 0.5;
          const a = Math.atan2(dy, dx);
          const ah = 4;
          ctx.beginPath();
          ctx.moveTo(hx, hy);
          ctx.lineTo(hx - Math.cos(a - 0.6) * ah, hy - Math.sin(a - 0.6) * ah);
          ctx.lineTo(hx - Math.cos(a + 0.6) * ah, hy - Math.sin(a + 0.6) * ah);
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      },
      startFlow: function(sampleFn) {
        this.stop();
        this._reset();
        const m = this._map;
        if (!m) return;
        const dpr = (window.devicePixelRatio || 1);
        const ctx = this._canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        ctx.scale(dpr, dpr);

        const size = m.getSize();
        const speedMul = Math.max(0.25, Number(strategicSpeed && strategicSpeed.value) || 1.0);
        const density = Math.max(50, Math.min(1200, Math.round((Number(SETTINGS.windDensity) || 40) * 12)));
        this._particles = [];
        for (let i = 0; i < density; i++) {
          this._particles.push({ x: Math.random() * size.x, y: Math.random() * size.y, a: Math.random() });
        }

        const step = () => {
          if (!this._map) return;
          const m2 = this._map;
          const sz = m2.getSize();
          // Fade trails without tinting the map (reduce alpha only)
          ctx.globalCompositeOperation = 'destination-in';
          ctx.fillStyle = 'rgba(0,0,0,0.90)';
          ctx.fillRect(0, 0, sz.x, sz.y);
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = 'rgba(90,115,140,0.26)';
          ctx.lineWidth = 1;

          const animSpd = Math.max(0.1, Number(SETTINGS.animSpeed) || 1.0) * speedMul;
          for (const p of this._particles) {
            const x0 = p.x;
            const y0 = p.y;
            const ll = m2.containerPointToLatLng([x0, y0]);
            const s = sampleFn(ll.lat, ll.lng);
            if (!s || !Number.isFinite(s.wind_speed_ms) || !Number.isFinite(s.wind_dir_deg)) {
              p.x = Math.random() * sz.x; p.y = Math.random() * sz.y;
              continue;
            }
            const sp = Math.max(0, Number(s.wind_speed_ms));
            const theta = ((Number(s.wind_dir_deg) + 180) % 360) * Math.PI / 180;
            const mag = (0.35 + 0.10 * sp) * animSpd;
            p.x += Math.sin(theta) * mag;
            p.y += -Math.cos(theta) * mag;
            if (p.x < 0 || p.x > sz.x || p.y < 0 || p.y > sz.y) {
              p.x = Math.random() * sz.x; p.y = Math.random() * sz.y;
              continue;
            }
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }
          this._anim = requestAnimationFrame(step);
        };
        this._anim = requestAnimationFrame(step);
      },
    });
    return new Layer();
  }

  const STRATEGIC_STATE = {
    active: false,
    year: Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR),
    dates: [],
    dayIndex: 0,
    layer: (strategicLayerSelect && strategicLayerSelect.value) ? strategicLayerSelect.value : 'temperature_ride',
    windOn: false,
    windMode: (strategicWindMode && strategicWindMode.value) ? strategicWindMode.value : 'flow',
    playing: false,
    playTimer: null,
    lastResp: null,
    lastFetchAt: 0,
    pendingFetch: null,
    heatLayer: null,
    windLayer: null,
  };

  function _strategicSetLabels() {
    const d = STRATEGIC_STATE.dates[STRATEGIC_STATE.dayIndex];
    const txt = d ? d.label : '—';
    if (strategicDayLabel) strategicDayLabel.textContent = txt;
    if (strategicTimelineLabel) strategicTimelineLabel.textContent = d ? _fmtISO(d.iso) : '—';
  }

  function _strategicSetYear(year) {
    STRATEGIC_STATE.year = Number(year || STRATEGIC_DEFAULT_YEAR);
    STRATEGIC_STATE.dates = _buildYearDates(STRATEGIC_STATE.year);
    if (strategicDaySlider) {
      strategicDaySlider.min = '0';
      strategicDaySlider.max = String(Math.max(0, STRATEGIC_STATE.dates.length - 1));
    }
    _renderMonthTicks(STRATEGIC_STATE.dates);
  }

  function _strategicSetDayIndex(idx) {
    const n = STRATEGIC_STATE.dates.length;
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, Math.round(Number(idx) || 0)));
    STRATEGIC_STATE.dayIndex = i;
    if (strategicDaySlider) strategicDaySlider.value = String(i);
    _strategicSetLabels();
  }

  function _strategicCurrentISO() {
    const d = STRATEGIC_STATE.dates[STRATEGIC_STATE.dayIndex];
    return d ? d.iso : null;
  }

  function _bboxFromResp(resp) {
    try {
      const b = resp && resp.bbox;
      if (Array.isArray(b) && b.length >= 4) {
        return { latMin: Number(b[0]), latMax: Number(b[1]), lonMin: Number(b[2]), lonMax: Number(b[3]) };
      }
    } catch (_) {}
    return null;
  }

  function _makeTileMap(points) {
    const m = new Map();
    for (const p of (points || [])) {
      if (p && p.tile_id) m.set(String(p.tile_id), p);
    }
    return m;
  }

  function _sampleInterpolated(tileMap, meta, lat, lon) {
    if (!tileMap || !meta) return null;
    const bbox = meta.bbox;
    const tileKm = meta.tile_km;
    if (!bbox || !Number.isFinite(tileKm)) return null;
    const latMin = bbox.latMin;
    const lonMin = bbox.lonMin;
    const stepLat = tileKm / 111.32;
    const row0 = Math.floor((lat - latMin) / stepLat);
    const latC0 = latMin + (row0 + 0.5) * stepLat;
    const latC1 = latC0 + stepLat;
    const tLat = _clamp01((lat - latC0) / Math.max(1e-9, (latC1 - latC0)));

    function rowValue(row, latC) {
      const c = Math.max(0.05, Math.cos(latC * Math.PI / 180));
      const stepLon = tileKm / (111.32 * c);
      const col0 = Math.floor((lon - lonMin) / stepLon);
      const lonC0 = lonMin + (col0 + 0.5) * stepLon;
      const lonC1 = lonC0 + stepLon;
      const tLon = _clamp01((lon - lonC0) / Math.max(1e-9, (lonC1 - lonC0)));
      const id00 = `r${row}_c${col0}`;
      const id01 = `r${row}_c${col0 + 1}`;
      const p00 = tileMap.get(id00);
      const p01 = tileMap.get(id01);
      if (!p00 && !p01) return null;

      // Optional nearest-neighbor sampling (debug setting)
      if (SETTINGS && SETTINGS.interpolation === false) {
        const p = p00 || p01;
        if (!p) return null;
        return {
          temperature_c: Number(p.temperature_c),
          precipitation_mm: Number(p.precipitation_mm),
          rain_probability: Number(p.rain_probability),
          rain_typical_mm: Number(p.rain_typical_mm),
          wind_speed_ms: Number(p.wind_speed_ms),
          wind_dir_deg: Number(p.wind_dir_deg),
          wind_var_deg: Number(p.wind_var_deg),
          temp_day_median: Number(p.temp_day_median),
          temp_day_p25: Number(p.temp_day_p25),
          temp_day_p75: Number(p.temp_day_p75),
        };
      }

      function num(p, k) {
        if (!p) return null;
        const v = Number(p[k]);
        return Number.isFinite(v) ? v : null;
      }

      const keys = ['temperature_c','precipitation_mm','rain_probability','rain_typical_mm','wind_speed_ms','wind_dir_deg','wind_var_deg','temp_day_median','temp_day_p25','temp_day_p75'];
      const out = {};
      for (const k of keys) {
        const a = num(p00, k);
        const b = num(p01, k);
        if (a === null && b === null) { out[k] = null; continue; }
        if (a === null) { out[k] = b; continue; }
        if (b === null) { out[k] = a; continue; }
        // Special handling for circular wind direction
        if (k === 'wind_dir_deg') {
          const ang0 = a * Math.PI / 180;
          const ang1 = b * Math.PI / 180;
          const x = _lerp(Math.cos(ang0), Math.cos(ang1), tLon);
          const y = _lerp(Math.sin(ang0), Math.sin(ang1), tLon);
          let deg = (Math.atan2(y, x) * 180 / Math.PI);
          if (deg < 0) deg += 360;
          out[k] = deg;
          continue;
        }
        out[k] = _lerp(a, b, tLon);
      }
      return out;
    }

    const v0 = rowValue(row0, latC0);
    const v1 = rowValue(row0 + 1, latC1);
    if (!v0 && !v1) return null;
    if (!v0) return v1;
    if (!v1) return v0;

    const keys = Object.keys(v0);
    const out = {};
    for (const k of keys) {
      const a = v0[k];
      const b = v1[k];
      if (a === null && b === null) { out[k] = null; continue; }
      if (a === null) { out[k] = b; continue; }
      if (b === null) { out[k] = a; continue; }
      if (k === 'wind_dir_deg') {
        const ang0 = a * Math.PI / 180;
        const ang1 = b * Math.PI / 180;
        const x = _lerp(Math.cos(ang0), Math.cos(ang1), tLat);
        const y = _lerp(Math.sin(ang0), Math.sin(ang1), tLat);
        let deg = (Math.atan2(y, x) * 180 / Math.PI);
        if (deg < 0) deg += 360;
        out[k] = deg;
        continue;
      }
      out[k] = _lerp(a, b, tLat);
    }
    return out;
  }

  function _heatColorFor(layer, s) {
    if (!s) return null;
    if (layer === 'temperature_ride') {
      const t = Number(s.temp_day_median);
      if (!Number.isFinite(t)) return null;
      // Stronger mid-range contrast: map 10..25C into wider palette space.
      const tMin = -5;
      const tMax = 35;
      let u = (t - tMin) / (tMax - tMin);
      // Nonlinear boost around mid
      u = Math.pow(_clamp01(u), 0.85);
      const c = _paletteSample(PAL_TEMP, u);
      return { ...c, a: 0.78 };
    }
    if (layer === 'rain_ride') {
      const r = Math.max(0, Number(s.precipitation_mm));
      if (!Number.isFinite(r)) return null;
      const rMax = 20;
      const u = _clamp01(r / rMax);
      const c = _paletteSample(PAL_RAIN, u);
      const a = _clamp01(u * 0.85);
      return { ...c, a };
    }
    if (layer === 'rain_tent') {
      const r = Math.max(0, Number(s.rain_typical_mm));
      if (!Number.isFinite(r)) return null;
      const rMax = 12;
      const u = _clamp01(r / rMax);
      const c = _paletteSample(PAL_RAIN, u);
      const a = _clamp01(u * 0.85);
      return { ...c, a };
    }
    if (layer === 'wind_speed') {
      const w = Math.max(0, Number(s.wind_speed_ms));
      if (!Number.isFinite(w)) return null;
      const wMax = 16;
      const u = _clamp01(w / wMax);
      const c = _paletteSample(PAL_WIND, u);
      return { ...c, a: 0.62 };
    }
    if (layer === 'wind_dir') {
      // direction is visualized via wind overlay; keep base transparent
      return { r: 0, g: 0, b: 0, a: 0 };
    }
    if (layer === 'comfort_ride' || layer === 'comfort_tent') {
      const isTent = (layer === 'comfort_tent');
      const t = (layer === 'comfort_tent') ? Number(s.temperature_c) : Number(s.temp_day_median);
      const r = isTent ? Number(s.rain_typical_mm) : Number(s.precipitation_mm);
      const w = Number(s.wind_speed_ms);
      const score = _comfortScore(t, r, w, isTent);
      if (score === null) return null;
      const c = _paletteSample(PAL_COMFORT, score);
      return { ...c, a: 0.74 };
    }
    return null;
  }

  async function _fetchStrategicGrid() {
    if (!STRATEGIC_STATE.active) return;
    const iso = _strategicCurrentISO();
    if (!iso) return;
    const b = map.getBounds();
    const latMin = b.getSouth();
    const latMax = b.getNorth();
    const lonMin = b.getWest();
    const lonMax = b.getEast();
    const url = `/api/strategic_grid?year=${encodeURIComponent(String(STRATEGIC_STATE.year))}&date=${encodeURIComponent(iso)}`
      + `&lat_min=${encodeURIComponent(String(latMin))}&lat_max=${encodeURIComponent(String(latMax))}`
      + `&lon_min=${encodeURIComponent(String(lonMin))}&lon_max=${encodeURIComponent(String(lonMax))}`;
    const t0 = Date.now();
    const resp = await fetch(url);
    const j = await resp.json();
    if (!resp.ok) throw new Error(j && j.error ? j.error : `HTTP ${resp.status}`);
    STRATEGIC_STATE.lastResp = j;
    STRATEGIC_STATE.lastFetchAt = t0;
  }

  function _renderStrategic() {
    if (!STRATEGIC_STATE.active) return;
    const resp = STRATEGIC_STATE.lastResp;
    if (!resp || !resp.points) return;
    if (!STRATEGIC_STATE.heatLayer) return;

    const bboxRaw = _bboxFromResp(resp);
    const tileKm = Number(resp.tile_km || 50);
    const meta = bboxRaw ? { bbox: bboxRaw, tile_km: tileKm } : null;
    const tileMap = _makeTileMap(resp.points);
    const layer = STRATEGIC_STATE.layer;

    STRATEGIC_STATE.heatLayer.drawWith((ctx, size) => {
      const w = size.x;
      const h = size.y;
      // Render at reduced resolution then upscale for smoothness
      const target = Math.max(260, Math.min(520, Math.round(Math.min(w, h) * 0.55)));
      const offW = Math.round(target * (w / Math.max(1, Math.min(w, h))));
      const offH = Math.round(target * (h / Math.max(1, Math.min(w, h))));
      const off = document.createElement('canvas');
      off.width = Math.max(1, offW);
      off.height = Math.max(1, offH);
      const octx = off.getContext('2d');
      if (!octx) return;
      const img = octx.createImageData(off.width, off.height);
      const data = img.data;
      const sx = w / off.width;
      const sy = h / off.height;
      for (let y = 0; y < off.height; y++) {
        for (let x = 0; x < off.width; x++) {
          const cx = x * sx;
          const cy = y * sy;
          const ll = map.containerPointToLatLng([cx, cy]);
          const s = _sampleInterpolated(tileMap, meta, ll.lat, ll.lng);
          const col = _heatColorFor(layer, s);
          const idx = (y * off.width + x) * 4;
          if (!col) {
            data[idx + 3] = 0;
            continue;
          }
          data[idx + 0] = col.r;
          data[idx + 1] = col.g;
          data[idx + 2] = col.b;
          data[idx + 3] = Math.round(255 * _clamp01(col.a));
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(off, 0, 0, w, h);
    });

    // Wind overlay
    const wantWind = Boolean(STRATEGIC_STATE.windOn) || (layer === 'wind_dir');
    if (strategicWindOn && layer === 'wind_dir' && !strategicWindOn.checked) {
      strategicWindOn.checked = true;
      STRATEGIC_STATE.windOn = true;
    }
    if (STRATEGIC_STATE.windLayer) {
      if (!wantWind) {
        STRATEGIC_STATE.windLayer.stop();
        STRATEGIC_STATE.windLayer.clear();
      } else {
        const sampleFn = (lat, lon) => _sampleInterpolated(tileMap, meta, lat, lon);
        const mode = STRATEGIC_STATE.windMode;
        if (mode === 'arrows') {
          STRATEGIC_STATE.windLayer.drawArrows(resp.points, sampleFn);
        } else {
          STRATEGIC_STATE.windLayer.clear();
          STRATEGIC_STATE.windLayer.startFlow(sampleFn);
        }
      }
    }
  }

  function _scheduleStrategicFetch() {
    if (!STRATEGIC_STATE.active) return;
    const now = Date.now();
    if (STRATEGIC_STATE.pendingFetch) return;
    const dt = now - (STRATEGIC_STATE.lastFetchAt || 0);
    const delay = Math.max(0, STRATEGIC_FETCH_THROTTLE_MS - dt);
    STRATEGIC_STATE.pendingFetch = setTimeout(async () => {
      STRATEGIC_STATE.pendingFetch = null;
      try {
        await _fetchStrategicGrid();
        _renderStrategic();
      } catch (e) {
        console.error('strategic fetch', e);
      }
    }, delay);
  }

  function strategicSetActive(active) {
    const on = Boolean(active);
    if (STRATEGIC_STATE.active === on) return;
    STRATEGIC_STATE.active = on;

    if (on) {
      _strategicSetYear(Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR));
      // Default day: today mapped into selected year (month/day)
      try {
        const today = new Date();
        const y = STRATEGIC_STATE.year;
        const iso = `${y}-${String(today.getMonth() + 1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
        const idx = STRATEGIC_STATE.dates.findIndex(d => d.iso === iso);
        _strategicSetDayIndex(idx >= 0 ? idx : 0);
      } catch (_) {
        _strategicSetDayIndex(0);
      }
      if (strategicLayerSelect) STRATEGIC_STATE.layer = strategicLayerSelect.value;
      if (strategicWindMode) STRATEGIC_STATE.windMode = strategicWindMode.value;
      if (strategicWindOn) {
        // Default: wind overlay on for wind layer, off otherwise
        const want = (STRATEGIC_STATE.layer === 'wind_speed');
        strategicWindOn.checked = want;
        STRATEGIC_STATE.windOn = want;
      }

      if (!STRATEGIC_STATE.heatLayer) STRATEGIC_STATE.heatLayer = _makeHeatLayer();
      if (!STRATEGIC_STATE.windLayer) STRATEGIC_STATE.windLayer = _makeWindLayer();
      try { STRATEGIC_STATE.heatLayer.addTo(map); } catch (_) {}
      try { STRATEGIC_STATE.windLayer.addTo(map); } catch (_) {}

      _scheduleStrategicFetch();
    } else {
      STRATEGIC_STATE.playing = false;
      if (STRATEGIC_STATE.playTimer) {
        try { clearTimeout(STRATEGIC_STATE.playTimer); } catch (_) {}
        STRATEGIC_STATE.playTimer = null;
      }
      if (STRATEGIC_STATE.pendingFetch) {
        try { clearTimeout(STRATEGIC_STATE.pendingFetch); } catch (_) {}
        STRATEGIC_STATE.pendingFetch = null;
      }
      if (STRATEGIC_STATE.windLayer) {
        STRATEGIC_STATE.windLayer.stop();
        STRATEGIC_STATE.windLayer.clear();
        try { map.removeLayer(STRATEGIC_STATE.windLayer); } catch (_) {}
      }
      if (STRATEGIC_STATE.heatLayer) {
        try { map.removeLayer(STRATEGIC_STATE.heatLayer); } catch (_) {}
      }
    }
  }

  // UI wiring
  if (strategicLayerSelect) {
    strategicLayerSelect.addEventListener('change', () => {
      STRATEGIC_STATE.layer = strategicLayerSelect.value;
      if (strategicWindOn && STRATEGIC_STATE.layer === 'wind_speed' && !strategicWindOn.checked) {
        strategicWindOn.checked = true;
        STRATEGIC_STATE.windOn = true;
      }
      _renderStrategic();
    });
  }
  if (strategicWindOn) {
    strategicWindOn.addEventListener('change', () => {
      STRATEGIC_STATE.windOn = Boolean(strategicWindOn.checked);
      _renderStrategic();
    });
  }
  if (strategicWindMode) {
    strategicWindMode.addEventListener('change', () => {
      STRATEGIC_STATE.windMode = strategicWindMode.value;
      _renderStrategic();
    });
  }
  if (strategicDaySlider) {
    strategicDaySlider.addEventListener('input', () => {
      _strategicSetDayIndex(strategicDaySlider.value);
      _scheduleStrategicFetch();
    });
  }
  if (strategicPlayBtn) {
    strategicPlayBtn.addEventListener('click', () => {
      STRATEGIC_STATE.playing = !STRATEGIC_STATE.playing;
      strategicPlayBtn.textContent = STRATEGIC_STATE.playing ? 'Pause' : 'Play';
      if (STRATEGIC_STATE.playTimer) {
        try { clearTimeout(STRATEGIC_STATE.playTimer); } catch (_) {}
        STRATEGIC_STATE.playTimer = null;
      }
      if (STRATEGIC_STATE.playing) {
        const tick = () => {
          if (!STRATEGIC_STATE.playing) return;
          const sp = Math.max(0.25, Number(strategicSpeed && strategicSpeed.value) || 1.0);
          const n = STRATEGIC_STATE.dates.length;
          if (n) {
            let i = STRATEGIC_STATE.dayIndex + 1;
            if (i >= n) i = 0;
            _strategicSetDayIndex(i);
            _scheduleStrategicFetch();
          }
          const delay = Math.round(650 / sp);
          STRATEGIC_STATE.playTimer = setTimeout(tick, delay);
        };
        const sp0 = Math.max(0.25, Number(strategicSpeed && strategicSpeed.value) || 1.0);
        STRATEGIC_STATE.playTimer = setTimeout(tick, Math.round(200 / sp0));
      }
    });
  }
  if (strategicSpeed) {
    strategicSpeed.addEventListener('input', () => {
      // take effect next interval; flow overlay also reads this for motion scaling
    });
  }

  map.on('moveend zoomend', () => {
    if (!STRATEGIC_STATE.active) return;
    _scheduleStrategicFetch();
  });

  // Settings view wiring
  function applySettingsToForm(s) {
    if (!s) return;
    if (setStepKm) setStepKm.value = s.stepKm;
    try {
      const nowYear = (new Date()).getFullYear();
      if (setHistLast) setHistLast.max = String(Math.max(1970, nowYear - 1));
    } catch (_) {}
    if (setHistLast) setHistLast.value = s.histLastYear;
    if (setHistYears) setHistYears.value = s.histYears;
    if (setTempCold) setTempCold.value = s.tempCold;
    if (setTempHot) setTempHot.value = s.tempHot;
    if (setRainHigh) setRainHigh.value = s.rainHigh;
    if (setWindHeadComfort) setWindHeadComfort.value = s.windHeadComfort;
    if (setWindTailComfort) setWindTailComfort.value = s.windTailComfort;
    if (setGlyphType) setGlyphType.value = s.glyphType || (s.useClassicWeatherIcons ? 'classic' : 'svg');

    if (setStrategicYear) setStrategicYear.value = String(s.strategicYear || 2025);
    if (setIncludeSea) setIncludeSea.checked = Boolean(s.includeSea);
    if (setInterpolation) setInterpolation.checked = Boolean(s.interpolation);
    if (setWindDensity) setWindDensity.value = String(Number(s.windDensity || 40));
    if (setAnimSpeed) setAnimSpeed.value = String(Number(s.animSpeed || 1.0));
    if (setGridKm) setGridKm.value = String(Number(s.gridKm || 50));
    if (setRideHours) setRideHours.value = String(s.rideHours || '10-16');
    if (setTentHours) setTentHours.value = String(s.tentHours || '18-08');
    if (setWindWeighting) setWindWeighting.value = String(s.windWeighting || 'relative');
  }

  function readSettingsFromForm(prev) {
    const base = prev ? { ...prev } : {};
    const nowYear = (new Date()).getFullYear();
    const defaultLastYear = Math.max(1970, nowYear - 1);
    base.stepKm = Number(setStepKm && setStepKm.value) || 60;
    base.histLastYear = Number(setHistLast && setHistLast.value) || defaultLastYear;
    base.histYears = Number(setHistYears && setHistYears.value) || 10;
    if (!Number.isFinite(base.histLastYear) || base.histLastYear < 1970) base.histLastYear = defaultLastYear;
    if (!Number.isFinite(base.histYears) || base.histYears < 1) base.histYears = 10;
    base.tempCold = Number(setTempCold && setTempCold.value);
    if (!Number.isFinite(base.tempCold)) base.tempCold = 5;
    base.tempHot = Number(setTempHot && setTempHot.value);
    if (!Number.isFinite(base.tempHot)) base.tempHot = 30;
    base.rainHigh = Number(setRainHigh && setRainHigh.value);
    if (!Number.isFinite(base.rainHigh)) base.rainHigh = 10;
    base.windHeadComfort = Number(setWindHeadComfort && setWindHeadComfort.value);
    if (!Number.isFinite(base.windHeadComfort)) base.windHeadComfort = 4;
    base.windTailComfort = Number(setWindTailComfort && setWindTailComfort.value);
    if (!Number.isFinite(base.windTailComfort)) base.windTailComfort = 10;
    base.glyphType = (setGlyphType && setGlyphType.value) ? setGlyphType.value : 'classic';
    base.useClassicWeatherIcons = (setGlyphType && setGlyphType.value) ? (setGlyphType.value === 'classic') : true;

    base.strategicYear = Number(setStrategicYear && setStrategicYear.value) || 2025;
    base.includeSea = Boolean(setIncludeSea && setIncludeSea.checked);
    base.interpolation = Boolean(setInterpolation && setInterpolation.checked);
    base.windDensity = Number(setWindDensity && setWindDensity.value) || 40;
    base.animSpeed = Number(setAnimSpeed && setAnimSpeed.value) || 1.0;
    base.gridKm = Number(setGridKm && setGridKm.value) || 50;
    base.rideHours = String(setRideHours && setRideHours.value ? setRideHours.value : '10-16');
    base.tentHours = String(setTentHours && setTentHours.value ? setTentHours.value : '18-08');
    base.windWeighting = String(setWindWeighting && setWindWeighting.value ? setWindWeighting.value : 'relative');
    return base;
  }
  
  // Debug helper: wait for manual step() call
  async function waitForSpacebar(stepNum, description) {
    if (!DEBUG_PROFILE_STEP) return;
    console.log(`%c[STEP ${stepNum}] ${description}`, 'color: blue; font-weight: bold; font-size: 14px');
    console.log(`%c  → Call step() to continue`, 'color: orange; font-size: 12px');
    return new Promise(resolve => {
      DEBUG_STEP_RESOLVER = resolve;
    });
  }
  
  // Advance to next step (call from console)
  window.step = function() {
    if (DEBUG_STEP_RESOLVER) {
      const resolver = DEBUG_STEP_RESOLVER;
      DEBUG_STEP_RESOLVER = null;
      console.log(`%c  ✓ Step advanced`, 'color: gray; font-size: 12px');
      resolver();
    } else {
      console.warn('No step waiting. Run redrawProfile() first.');
    }
  };
  
  // Toggle debug mode from console
  window.toggleProfileDebug = function() {
    DEBUG_PROFILE_STEP = !DEBUG_PROFILE_STEP;
    console.log(`Profile step debug mode: ${DEBUG_PROFILE_STEP ? 'ON' : 'OFF'}`);
    if (DEBUG_PROFILE_STEP) {
      console.log('Call step() to advance through each drawing step.');
      console.log('Call window.redrawProfile() to start, or reload the map data.');
    }
  };
  
  // Expose redraw function for debugging
  window.redrawProfile = function() {
    if (LAST_PROFILE) {
      console.log('Redrawing profile...');
      drawProfile(LAST_PROFILE);
    } else {
      console.warn('No profile data available. Load map data first.');
    }
  };

  function getPads() {
    // Tighter padding to stretch chart left and downward
    // Increase bottom padding to leave room for x-axis labels
    // Compute dynamic top padding so pins + glyph previews fit without clipping,
    // but minimize whitespace when no pins/glyphs are present (e.g., during priming).
    const hasPins = Array.isArray(OVERLAY_POINTS) && OVERLAY_POINTS.length > 0;
    const minTop = 6;
    let neededTop = minTop;
    if (hasPins) {
      const z = map.getZoom ? map.getZoom() : 10;
      if (SETTINGS.glyphType === 'cyclist') {
        // 18 + 3 + 40 + 4 + 22 = 87
        neededTop = PIN_H + 87 + PREVIEW_MARGIN;
      } else if (SETTINGS.glyphType === 'classic' || SETTINGS.useClassicWeatherIcons) {
        const showFull = z >= 12;
        const totalH = (showFull ? 18 : 0) + (showFull ? 3 : 0) + 40 + (showFull ? 4 : 2) + 24;
        neededTop = PIN_H + totalH + PREVIEW_MARGIN;
      } else {
        neededTop = PIN_H + PREVIEW_SIZE + PREVIEW_MARGIN;
      }
    }
    // Increase bottom padding slightly to ensure x-axis ticks and labels are fully visible
    // Increase right padding to ensure right-side ticks/labels/color bars aren't clipped
    return { padTop: Math.max(minTop, neededTop), padBot: 22, padL: 18, padR: 18 };
  }

  function resizeProfileCanvas() {
    if (!profileCanvas || !profileCtx) return;
    const dpr = (window.devicePixelRatio || 1);
    const rect = profileCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    profileCanvas.width = Math.floor(w * dpr);
    profileCanvas.height = Math.floor(h * dpr);
    profileCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (profileCursorCanvas && profileCursorCtx) {
      profileCursorCanvas.width = Math.floor(w * dpr);
      profileCursorCanvas.height = Math.floor(h * dpr);
      profileCursorCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // Profile panel height management
  function setProfileHeight(h) {
    try {
      const minH = 120;
      const maxH = Math.max(minH, window.innerHeight - 220); // keep map at least ~220px
      const hh = Math.max(minH, Math.min(maxH, Math.round(Number(h) || 160)));
      if (profilePanel) profilePanel.style.height = `${hh}px`;
      // Account for Tour Summary box height (tightened to 64px)
      const tsdb = document.getElementById('tourSummary');
      const tsdbH = tsdb && tsdb.offsetHeight ? tsdb.offsetHeight : 64;
      if (mapEl) {
        mapEl.style.height = `calc(100% - ${hh + tsdbH}px)`;
        // Ensure a sensible minimum height for the map container
        const rect = mapEl.getBoundingClientRect();
        if (!rect.height || rect.height < 200) {
          mapEl.style.height = `${Math.max(220, window.innerHeight - (hh + tsdbH))}px`;
        }
      }
      // Align tooltip and overlay selector just above the profile panel
      const bottomGap = hh + tsdbH + 16; // slight spacing above profile
      if (profileTooltip) profileTooltip.style.bottom = `${bottomGap}px`;
      // Resize canvases and redraw
      resizeProfileCanvas();
      if (LAST_PROFILE) drawProfile(LAST_PROFILE);
      try { if (map && map.invalidateSize) map.invalidateSize(true); } catch(_) {}
      // Persist
      try { localStorage.setItem('wm_profile_height', String(hh)); } catch(_) {}
    } catch (e) { console.warn('setProfileHeight error', e); }
  }

  // Initialize profile height from storage
  (function initProfileHeight(){
    try {
      const s = localStorage.getItem('wm_profile_height');
      const h = s ? Number(s) : 160;
      setProfileHeight(h);
    } catch(_) { setProfileHeight(160); }
  })();

  function drawProfile(profile) {
    if (!profileCanvas || !profileCtx || !profile || !profile.sampled_dist_km) return;
    LAST_PROFILE = profile;
    resizeProfileCanvas();
    const rect = profileCanvas.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width));
    const H = Math.max(1, Math.floor(rect.height));
    
    // Wrap in async IIFE for step-by-step debugging
    (async () => {
    
    // Intercept fillRect calls to debug mystery rectangle
    if (DEBUG_PROFILE_STEP) {
      const originalFillRect = profileCtx.fillRect.bind(profileCtx);
      profileCtx.fillRect = function(x, y, w, h) {
        if (w > 100 || h > 100) { // Log large rectangles
          console.log(`%c[FILLRECT] x=${x.toFixed(0)}, y=${y.toFixed(0)}, w=${w.toFixed(0)}, h=${h.toFixed(0)}, fillStyle=${profileCtx.fillStyle}`, 'color: red; font-weight: bold');
        }
        originalFillRect(x, y, w, h);
      };
    }
    
    if (DEBUG_PROFILE_STEP) DEBUG_STEP_COUNTER = 0;
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Clear canvas`, 'color: blue; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Clear canvas');
    // Clear
    profileCtx.clearRect(0, 0, W, H);
    // Extract arrays
    const dist = Array.isArray(profile.sampled_dist_km) ? profile.sampled_dist_km : [];
    const elev = Array.isArray(profile.elev_m) ? profile.elev_m : [];
    if (!dist.length || dist.length !== elev.length) return;
    const profLen = dist[dist.length - 1] || 1;
    // Axis domain: prefer full route length when available, else fall back to profile length
    let axisLen = profLen;
    try {
      if (Array.isArray(ROUTE_CUM_DISTS) && ROUTE_CUM_DISTS.length >= 2) {
        const rl = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
        if (Number.isFinite(rl) && rl > 0) axisLen = rl;
      }
    } catch (_) {}
    const scale = axisLen / Math.max(1e-6, profLen);
    // Elevation min/max ignoring nulls
    let emin = Infinity, emax = -Infinity;
    elev.forEach(v => { if (v !== null && v !== undefined) { emin = Math.min(emin, v); emax = Math.max(emax, v); } });
    if (!isFinite(emin) || !isFinite(emax) || emax <= emin) { emin = 0; emax = 1000; }
    const { padTop, padBot, padL, padR } = getPads();
    const innerW = Math.max(1, W - padL - padR);
    const innerH = Math.max(1, H - padTop - padBot);
    const xAt = (d) => {
      // Clamp to axis domain (full route length when available)
      const dd = Math.max(0, Math.min(axisLen, Number(d) || 0));
      const u = dd / Math.max(1e-6, axisLen);
      // Keep profile x-scale normal even in reverse mode: 0 km at left, increasing to the right
      return padL + innerW * u;
    };
    const yAt = (e) => padTop + innerH - Math.round(innerH * ((e - emin) / Math.max(1, emax - emin)));
    // Grid: horizontal lines (dynamic "nice" step ~5–6 ticks across elevation range)
    profileCtx.strokeStyle = '#ddd';
    profileCtx.lineWidth = 1;
    profileCtx.setLineDash([4, 4]);
    const eRange = Math.max(1, emax - emin);
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Draw initial elevation grid lines (horizontal dashed)`, 'color: blue; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Draw initial elevation grid lines');
    function niceStep(val) {
      const bases = [1, 2, 5];
      const pow = Math.floor(Math.log10(val));
      const basePow = Math.pow(10, pow);
      for (let i = 0; i < bases.length; i++) {
        const step = bases[i] * basePow;
        if (step >= val) return step;
      }
      return Math.pow(10, pow + 1);
    }
    const targetTicks = 6;
    const stepElev = Math.max(1, niceStep(eRange / targetTicks));
    let gridVals = [];
    for (let v = Math.ceil(emin/stepElev)*stepElev; v <= emax + 1e-6; v += stepElev) {
      const y = yAt(v);
      profileCtx.beginPath();
      profileCtx.moveTo(padL, y);
      profileCtx.lineTo(padL + innerW, y);
      profileCtx.stroke();
      gridVals.push({ v: Math.round(v), y });
    }
    // Draw top boundary line
    profileCtx.setLineDash([]);
    profileCtx.beginPath();
    profileCtx.moveTo(padL, padTop);
    profileCtx.lineTo(padL + innerW, padTop);
    profileCtx.stroke();
    profileCtx.setLineDash([4, 4]);
    profileCtx.setLineDash([]);
    // Elevation tick labels (left side, slightly rightwards inside chart)
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Draw elevation tick labels (left side)`, 'color: blue; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Draw elevation tick labels');
    profileCtx.fillStyle = '#666';
    profileCtx.font = '10px system-ui, -apple-system, sans-serif';
    profileCtx.textAlign = 'left';
    gridVals.forEach(({ v, y }) => {
      const txt = `${v} m`;
      profileCtx.fillText(txt, padL + 2, y + 3);
    });
    // Removed explicit min/max labels to avoid overlap with grid labels

    // Clip all chart drawings (area, line, overlays) to the inner chart bounds
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Start clipping region (padL=${padL}, padTop=${padTop}, innerW=${innerW}, innerH=${innerH})`, 'color: orange; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Start clipping region');
    profileCtx.save();
    profileCtx.beginPath();
    profileCtx.rect(padL, padTop, innerW, innerH);
    profileCtx.clip();

    // Elevation area fill with tour-day alternating colors
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Draw elevation area fills (alternating orange)`, 'color: blue; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Draw elevation area fills');
    const boundaries = Array.isArray(profile.day_boundaries) ? profile.day_boundaries : [];
    const marks = boundaries.map(b => Number(b.distance_km||0)).filter(v => Number.isFinite(v) && v > 0 && v < axisLen).sort((a,b)=>a-b);
    const segIdx = [0];
    // Find nearest index for each mark
    for (let m of marks) {
      let lo = 0, hi = dist.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (dist[mid] < m) lo = mid + 1; else hi = mid;
      }
      const idx = Math.max(0, Math.min(dist.length - 1, lo));
      if (idx > segIdx[segIdx.length - 1]) segIdx.push(idx);
    }
    if (segIdx[segIdx.length - 1] !== dist.length - 1) segIdx.push(dist.length - 1);
    const fillColors = ['rgba(255,143,0,0.22)', 'rgba(255,183,77,0.22)'];
    for (let s = 0; s < segIdx.length - 1; s++) {
      const i0 = segIdx[s];
      const i1 = segIdx[s+1];
      if (i1 <= i0) continue;
      profileCtx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const x = xAt(dist[i] * scale);
        const y = yAt(elev[i] ?? emin);
        if (i === i0) profileCtx.moveTo(x, y);
        else profileCtx.lineTo(x, y);
      }
      // Close to baseline
      profileCtx.lineTo(xAt(dist[i1] * scale), padTop + innerH);
      profileCtx.lineTo(xAt(dist[i0] * scale), padTop + innerH);
      profileCtx.closePath();
      profileCtx.fillStyle = fillColors[s % fillColors.length];
      profileCtx.fill();
    }
    // Elevation line
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Draw elevation line (solid black)`, 'color: blue; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Draw elevation line');
    profileCtx.beginPath();
    for (let i = 0; i < dist.length; i++) {
      const x = xAt(dist[i] * scale);
      const y = yAt(elev[i] ?? emin);
      if (i === 0) profileCtx.moveTo(x, y);
      else profileCtx.lineTo(x, y);
    }
      profileCtx.strokeStyle = '#555';
      profileCtx.lineWidth = 1.25;
    profileCtx.stroke();
    // Overlay drawing (temperature/precipitation/wind)
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Draw overlay data (mode=${OVERLAY_MODE})`, 'color: blue; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Draw overlay data');
    const overlayAxisInfo = drawOverlay(profile);

    // End clipping region for chart drawings
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] End clipping region (restore)`, 'color: orange; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'End clipping region');
    profileCtx.restore();

    // Draw overlay axes outside clipping region to avoid label cutoff
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Draw overlay axes (ticks, labels, color bars)`, 'color: blue; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Draw overlay axes');
    if (overlayAxisInfo) {
      const xScale = padL + innerW - 10;
      const tickLen = 6;
      if (overlayAxisInfo.mode === 'temperature') {
        const { tmin, tmax, yAtT, colorFromTemperature } = overlayAxisInfo;
        // Color bar next to ticks (draw first so grid lines can be on top)
        const barX = xScale + 2;
        const barW = 6;
        const barStep = 1;
        for (let tv = Math.floor(tmin); tv <= Math.ceil(tmax - barStep); tv += barStep) {
          const y1 = yAtT(tv);
          const y2 = yAtT(tv + barStep);
          profileCtx.fillStyle = colorFromTemperature(tv + barStep * 0.5);
          profileCtx.fillRect(barX, Math.min(y1, y2), barW, Math.abs(y2 - y1));
        }
        // Draw ticks and labels
        profileCtx.strokeStyle = '#666';
        profileCtx.lineWidth = 1;
        profileCtx.fillStyle = '#666';
        profileCtx.font = '10px system-ui, -apple-system, sans-serif';
        profileCtx.textAlign = 'right';
        const stepT = 5;
        const startT = Math.ceil(tmin / stepT) * stepT;
        const endT = Math.floor(tmax / stepT) * stepT;
        for (let tv = startT; tv <= endT; tv += stepT) {
          const y = yAtT(tv);
          profileCtx.beginPath();
          profileCtx.moveTo(xScale - tickLen, y);
          profileCtx.lineTo(xScale, y);
          profileCtx.stroke();
          profileCtx.fillText(`${tv}°C`, xScale - 4, y + 3);
        }
      } else if (overlayAxisInfo.mode === 'precipitation') {
        const { maxMm, pxPerMm } = overlayAxisInfo;
        // Light blue bar (draw first so grid lines can be on top)
        const barX = xScale + 2;
        const barW = 6;
        profileCtx.fillStyle = 'rgba(100, 180, 255, 0.20)';
        profileCtx.fillRect(barX, Math.round(padTop), barW, Math.round(innerH));
        // Draw ticks and labels
        profileCtx.strokeStyle = '#666';
        profileCtx.lineWidth = 1;
        profileCtx.fillStyle = '#666';
        profileCtx.font = '10px system-ui, -apple-system, sans-serif';
        profileCtx.textAlign = 'right';
        const ticks = [];
        for (let t = 0; t <= maxMm; t += 5) ticks.push(t);
        if (ticks[ticks.length-1] < maxMm) ticks.push(Math.ceil(maxMm));
        for (let tv of ticks) {
          const y = padTop + innerH - (tv * pxPerMm);
          profileCtx.beginPath();
          profileCtx.moveTo(xScale - tickLen, y);
          profileCtx.lineTo(xScale, y);
          profileCtx.stroke();
          profileCtx.fillText(`${tv} mm`, xScale - 4, y + 3);
        }
      } else if (overlayAxisInfo.mode === 'wind') {
        const { maxAbs, yAt } = overlayAxisInfo;
        profileCtx.strokeStyle = '#666';
        profileCtx.fillStyle = '#666';
        profileCtx.lineWidth = 1;
        profileCtx.font = '10px system-ui, -apple-system, sans-serif';
        profileCtx.textAlign = 'right';
        const M = maxAbs;
        const ticks = [-M, -M/2, 0, M/2, M];
        for (const tv of ticks) {
          const y = yAt(tv);
          profileCtx.beginPath();
          profileCtx.moveTo(xScale - tickLen, y);
          profileCtx.lineTo(xScale, y);
          profileCtx.stroke();
          const lab = `${(Math.abs(tv) < 0.05 ? 0 : tv).toFixed(0)} m/s`;
          profileCtx.fillText(lab, xScale - 4, y + 3);
        }
        // Axis label at top-right
        profileCtx.fillText('Effective wind (m/s)', xScale - 4, padTop + 12);
        // Legend
        try {
          const lx = xScale - 120;
          const ly1 = padTop + 26;
          const ly2 = padTop + 40;
          profileCtx.lineWidth = 3;
          profileCtx.strokeStyle = 'rgba(60,180,90,1)';
          profileCtx.beginPath();
          profileCtx.moveTo(lx, ly1);
          profileCtx.lineTo(lx + 28, ly1);
          profileCtx.stroke();
          profileCtx.fillStyle = '#333';
          profileCtx.font = '10px system-ui, -apple-system, sans-serif';
          profileCtx.textAlign = 'left';
          profileCtx.fillText('Tailwind', lx + 34, ly1 + 3);
          profileCtx.strokeStyle = 'rgba(220,80,60,1)';
          profileCtx.beginPath();
          profileCtx.moveTo(lx, ly2);
          profileCtx.lineTo(lx + 28, ly2);
          profileCtx.stroke();
          profileCtx.fillStyle = '#333';
          profileCtx.fillText('Headwind', lx + 34, ly2 + 3);
        } catch(_) {}
      }
    }
    // Day boundaries (vertical dashed lines) — grey
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Draw day boundaries (vertical dashed lines)`, 'color: blue; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Draw day boundaries');
    // boundaries already defined above
    profileCtx.strokeStyle = '#aaa';
    profileCtx.lineWidth = 1;
    profileCtx.setLineDash([3, 3]);
    boundaries.forEach(b => {
      const x = xAt(Number(b.distance_km||0));
      profileCtx.beginPath();
      profileCtx.moveTo(x, padTop);
      profileCtx.lineTo(x, padTop + innerH);
      profileCtx.stroke();
    });
    profileCtx.setLineDash([]);

    // X-axis with ticks and labels
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Draw x-axis (km labels and ticks)`, 'color: blue; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Draw x-axis');
    const axisY = padTop + innerH;
    profileCtx.strokeStyle = '#666';
    profileCtx.lineWidth = 1;
    profileCtx.beginPath();
    profileCtx.moveTo(padL, axisY);
    profileCtx.lineTo(padL + innerW, axisY);
    profileCtx.stroke();
    const pxPerKm = innerW / Math.max(1e-6, axisLen);
    const desiredPx = 80; // target ~80px between ticks
    const desiredKm = desiredPx / Math.max(1e-6, pxPerKm);
    function niceStep(val) {
      const bases = [1, 2, 5];
      const pow = Math.floor(Math.log10(val));
      const basePow = Math.pow(10, pow);
      for (let i = 0; i < bases.length; i++) {
        const step = bases[i] * basePow;
        if (step >= val) return step;
      }
      return Math.pow(10, pow + 1);
    }
    const stepKm = Math.max(1, niceStep(desiredKm));
    const startKm = 0;
    const endKm = Math.floor(axisLen / stepKm) * stepKm;
    const tickLen = 6;
    profileCtx.fillStyle = '#666';
    profileCtx.font = '10px system-ui, -apple-system, sans-serif';
    profileCtx.textAlign = 'center';
    for (let d = startKm; d <= endKm + 1e-6; d += stepKm) {
      const x = xAt(d);
      profileCtx.beginPath();
      profileCtx.moveTo(x, axisY);
      profileCtx.lineTo(x, axisY + tickLen);
      profileCtx.stroke();
      profileCtx.fillText(`${Math.round(d)} km`, x, axisY + 12 + tickLen);
    }
    // Draw glyph position pins onto the elevation profile ("stuck onto" the line)
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Draw glyph position pins`, 'color: blue; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Draw glyph position pins');
    try {
      if (Array.isArray(OVERLAY_POINTS) && OVERLAY_POINTS.length) {
        const pinH = 17; // needle height (2x reduced by ~30%)
        const r = 4;     // head radius (2x reduced by ~30%)
        // Helper: interpolate elevation at distance d
        function yAtDist(d) {
          // Map route distance d into profile domain using scale
          const ddProf = Math.max(0, Math.min(profLen, Number(d||0) / Math.max(1e-6, scale)));
          // Binary search for index where dist[i] >= dd
          let lo = 0, hi = dist.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (dist[mid] < ddProf) lo = mid + 1; else hi = mid;
          }
          const i = lo;
          let e = null;
          if (i <= 0) {
            e = elev[0];
          } else if (i >= dist.length) {
            e = elev[dist.length - 1];
          } else {
            const d1 = dist[i-1];
            const d2 = dist[i];
            const e1 = elev[i-1];
            const e2 = elev[i];
            const t = (d2 > d1) ? Math.max(0, Math.min(1, (ddProf - d1) / (d2 - d1))) : 0;
            if (e1 == null && e2 == null) {
              e = emin;
            } else if (e1 == null) {
              e = e2;
            } else if (e2 == null) {
              e = e1;
            } else {
              e = e1 + (e2 - e1) * t;
            }
          }
          return yAt(e ?? emin);
        }
        const pts = OVERLAY_POINTS.slice().filter(p => Number.isFinite(p.dist)).sort((a,b)=>a.dist-b.dist);
        // Use subtle styling: grey stem; no separate head — extend stem to glyph's central ring
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const x = xAt(Number(p.dist));
          const y = yAtDist(Number(p.dist));
          // Determine glyph preview center to anchor stem tip
          let tipY = y - PIN_H; // fallback when image not ready
          let gx = null, gy = null, size = PREVIEW_SIZE;
          // Pin median temperature for ring color
          const tMedPin = (Number.isFinite(p.temp_day_median)) ? Number(p.temp_day_median)
                         : (Number.isFinite(p.temp_day_p25) && Number.isFinite(p.temp_day_p75)) ? ((Number(p.temp_day_p25)+Number(p.temp_day_p75))*0.5)
                         : (Number.isFinite(p.temperature) ? Number(p.temperature) : null);
          try {
            const id = p.id;
            const entry = id ? PROFILE_GLYPH_CACHE[id] : null;
            const img = entry && entry.img && entry.img.complete ? entry.img : null;
            if (img && (SETTINGS.glyphType === 'svg' || (!SETTINGS.glyphType && !SETTINGS.useClassicWeatherIcons))) {
              // Center preview on x, but keep fully inside chart horizontally
              gx = Math.round(x - size / 2);
              const gxMin = padL + 2;
              const gxMax = padL + innerW - size - 2;
              gx = Math.max(gxMin, Math.min(gxMax, gx));
              gy = Math.round((y - PIN_H) - size - 2);
              const centerY = gy + (size / 2);
              // Use precipitation ring radius scaled from 64px glyph design: 9px at 64 → scale by (size/64)
              const ringR = (9 / 64) * size;
              // Stem tip should touch the ring radius (bottom point), not the center
              tipY = Math.round(centerY + ringR);
              // Draw glyph preview (keep current height)
              try { profileCtx.save(); profileCtx.filter = 'saturate(1.75)'; } catch(_) {}
              profileCtx.drawImage(img, gx, gy, size, size);
              try { profileCtx.restore(); } catch(_) {}
            } else if (SETTINGS.glyphType === 'classic' || (!SETTINGS.glyphType && SETTINGS.useClassicWeatherIcons)) {
              // Unified vertical glyph: weather (top), thermometer (center), rosette (bottom)
              const tMed = (Number.isFinite(p.temp_day_median)) ? Number(p.temp_day_median)
                           : (Number.isFinite(p.temp_day_p25) && Number.isFinite(p.temp_day_p75)) ? ((Number(p.temp_day_p25)+Number(p.temp_day_p75))*0.5)
                           : (Number(p.temperature)||0);
              const t25 = Number.isFinite(p.temp_day_p25) ? Number(p.temp_day_p25) : null;
              const t75 = Number.isFinite(p.temp_day_p75) ? Number(p.temp_day_p75) : null;
              const cls = mapWeatherByProb(p.rainProb);
              const zoom = map.getZoom();
              const showFull = zoom >= 12;
              const totalH = (showFull ? 18 : 0) + (showFull ? 3 : 0) + 40 + (showFull ? 4 : 2) + 24;
              const totalW = 24;
              gx = Math.round(x - totalW / 2);
              const gxMin = padL + 2;
              const gxMax = padL + innerW - totalW - 2;
              gx = Math.max(gxMin, Math.min(gxMax, gx));
              gy = Math.round((y - PIN_H) - totalH - 2);
              // Top: weather icon
              if (showFull) {
                renderWeatherIcon(profileCtx, gx + Math.round(totalW/2), gy, cls);
              }
              // Thermometer (center), dominant
              const thermoTop = gy + (showFull ? (18 + 3) : 0);
              renderThermometer(profileCtx, gx + Math.round(totalW/2), thermoTop, tMed, showFull ? t25 : null, showFull ? t75 : null);
              // Bottom: wind rosette
              const roseY = thermoTop + 40 + (showFull ? 4 : 2) + Math.round(24/2);
              // Compute relative wind component along route heading (tail/head/cross)
              let effRel = null;
              try {
                const sd = Array.isArray(LAST_PROFILE.sampled_dist_km) ? LAST_PROFILE.sampled_dist_km : [];
                const sh = Array.isArray(LAST_PROFILE.sampled_heading_deg) ? LAST_PROFILE.sampled_heading_deg : [];
                if (sd.length && sh.length === sd.length && Array.isArray(ROUTE_CUM_DISTS) && ROUTE_CUM_DISTS.length >= 2) {
                  const profLen = Number(sd[sd.length - 1] || 0);
                  const routeLen = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
                  const scale2 = (Number.isFinite(routeLen) && Number.isFinite(profLen) && profLen > 0) ? (routeLen / profLen) : 1;
                  const dkm = Number(p.dist || 0);
                  let lo=0, hi=sd.length-1;
                  while(lo<hi){ const mid=(lo+hi)>>1; if (sd[mid]*scale2<dkm) lo=mid+1; else hi=mid; }
                  const routeDir = Number(sh[lo]||0);
                  const wdirTo = ((Number(p.windDir)||0) + 180.0) % 360.0;
                  const ang = (wdirTo - routeDir) * Math.PI/180.0;
                  effRel = Math.cos(ang); // -1..+1 (tailwind positive)
                }
              } catch(_) {}
              renderWindRosette(profileCtx, gx + Math.round(totalW/2), roseY, { median_speed: p.windSpeed, median_direction: p.windDir, circ_std: p.windVar, eff_relative: effRel, minimal: !showFull }, 24);
              // Stem tip aligns to bottom of the thermometer
              tipY = thermoTop + 40;
            } else if (SETTINGS.glyphType === 'cyclist') {
              const tMed = (Number.isFinite(p.temp_day_median)) ? Number(p.temp_day_median)
                           : (Number.isFinite(p.temp_day_p25) && Number.isFinite(p.temp_day_p75)) ? ((Number(p.temp_day_p25)+Number(p.temp_day_p75))*0.5)
                           : (Number(p.temperature)||0);
              const t25 = Number.isFinite(p.temp_day_p25) ? Number(p.temp_day_p25) : null;
              const t75 = Number.isFinite(p.temp_day_p75) ? Number(p.temp_day_p75) : null;
              const prob = Number(p.rainProb || 0);
              // Compute relative wind for color
              let effRel = null;
              try {
                const sd = Array.isArray(LAST_PROFILE.sampled_dist_km) ? LAST_PROFILE.sampled_dist_km : [];
                const sh = Array.isArray(LAST_PROFILE.sampled_heading_deg) ? LAST_PROFILE.sampled_heading_deg : [];
                if (sd.length && sh.length === sd.length && Array.isArray(ROUTE_CUM_DISTS) && ROUTE_CUM_DISTS.length >= 2) {
                  const profLen = Number(sd[sd.length - 1] || 0);
                  const routeLen = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
                  const scale2 = (Number.isFinite(routeLen) && Number.isFinite(profLen) && profLen > 0) ? (routeLen / profLen) : 1;
                  const dkm = Number(p.dist || 0);
                  let lo2=0, hi2=sd.length-1;
                  while(lo2<hi2){ const mid=(lo2+hi2)>>1; if (sd[mid]*scale2<dkm) lo2=mid+1; else hi2=mid; }
                  const routeDir = Number(sh[lo2]||0);
                  const wdirTo = ((Number(p.windDir)||0) + 180.0) % 360.0;
                  const ang = (wdirTo - routeDir) * Math.PI/180.0;
                  effRel = Math.cos(ang);
                }
              } catch(_) {}
              const totalW = 24;
              const totalH = 18 + 3 + 40 + 4 + 22;
              gx = Math.round(x - totalW / 2);
              const gxMin = padL + 2;
              const gxMax = padL + innerW - totalW - 2;
              gx = Math.max(gxMin, Math.min(gxMax, gx));
              gy = Math.round((y - PIN_H) - totalH - 2);
              const key = [Math.round(tMed*10)/10, t25 ?? '-', t75 ?? '-', Math.round(prob*100)/100, Math.round((p.windDir||0)*10)/10, Math.round((p.windSpeed||0)*10)/10, Math.round((p.windVar||0)*10)/10, Math.round((effRel||0)*100)/100].join('|');
              const cvs = getCyclistGlyphCanvas(key, { tMed, t25, t75, rainProb: prob, windDir: p.windDir, windSpeed: p.windSpeed, windVar: p.windVar, effRel });
              profileCtx.drawImage(cvs, gx, gy);
              // Stem tip aligns to bottom of the thermometer
              tipY = gy + 18 + 3 + 40;
            }
          } catch (_) {}
          // Stem from elevation to glyph center (or fallback height)
          profileCtx.strokeStyle = '#777';
          profileCtx.lineWidth = 1;
          profileCtx.beginPath();
          profileCtx.moveTo(x, tipY);
          profileCtx.lineTo(x, y);
          profileCtx.stroke();
          // Remove extra colored pin head at stem tip (no hollow circle)
        }
      }
    } catch (e) { console.warn('draw pins error', e); }
    // Start/Finish pins at 0 km and route end (stuck onto elevation line)
    if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Draw start/finish pins (green/red)`, 'color: blue; font-weight: bold');
    await waitForSpacebar(DEBUG_STEP_COUNTER, 'Draw start/finish pins');
    try {
      const pinH = PIN_H; // reduced by ~30%
      const r = 4;     // reduced by ~30%
      function yAtDist(d) {
        const ddProf = Math.max(0, Math.min(profLen, Number(d||0) / Math.max(1e-6, scale)));
        let lo = 0, hi = dist.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (dist[mid] < ddProf) lo = mid + 1; else hi = mid;
        }
        const i = lo;
        let e = null;
        if (i <= 0) e = elev[0];
        else if (i >= dist.length) e = elev[dist.length - 1];
        else {
          const d1 = dist[i-1], d2 = dist[i];
          const e1 = elev[i-1], e2 = elev[i];
          const t = (d2 > d1) ? Math.max(0, Math.min(1, (ddProf - d1) / (d2 - d1))) : 0;
          if (e1 == null && e2 == null) e = emin;
          else if (e1 == null) e = e2;
          else if (e2 == null) e = e1;
          else e = e1 + (e2 - e1) * t;
        }
        return yAt(e ?? emin);
      }
      // Start (green accent)
      {
        const xs = xAt(0);
        const ys = yAtDist(0);
        profileCtx.strokeStyle = '#2a7a2a';
        profileCtx.lineWidth = 1;
        profileCtx.beginPath();
        profileCtx.moveTo(xs, ys - PIN_H);
        profileCtx.lineTo(xs, ys);
        profileCtx.stroke();
        profileCtx.beginPath();
        profileCtx.arc(xs, ys - PIN_H, r, 0, Math.PI * 2);
        profileCtx.fillStyle = 'rgba(255,255,255,0.95)';
        profileCtx.fill();
        profileCtx.strokeStyle = '#2a7a2a';
        profileCtx.stroke();
      }
      // Finish (red accent)
      {
        const xf = xAt(axisLen);
        const yf = yAtDist(axisLen);
        profileCtx.strokeStyle = '#c0392b';
        profileCtx.lineWidth = 1;
        profileCtx.beginPath();
        profileCtx.moveTo(xf, yf - PIN_H);
        profileCtx.lineTo(xf, yf);
        profileCtx.stroke();
        profileCtx.beginPath();
        profileCtx.arc(xf, yf - PIN_H, r, 0, Math.PI * 2);
        profileCtx.fillStyle = 'rgba(255,255,255,0.95)';
        profileCtx.fill();
        profileCtx.strokeStyle = '#c0392b';
        profileCtx.stroke();
      }
    } catch (e) { console.warn('draw start/finish pins error', e); }
    
    // Precompute profile x positions for cursor snapping (scaled to route length)
    PROFILE_XS = dist.map(d => xAt(d * scale));
    // Calibrate Mouse-X mapping using devicePixelRatio only (fix 2x on Retina)
    CURSOR_X_SCALE = 1 / (window.devicePixelRatio || 1);
    
    })(); // End async IIFE
  }
  // Map cursor marker updater by fractional distance along route
  window.updateMapCursorAtDistance = function(dkm) {
    try {
      if (!Array.isArray(ROUTE_COORDS) || !Array.isArray(ROUTE_CUM_DISTS) || ROUTE_COORDS.length < 2) return;
      const total = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
      let d = Math.max(0, Math.min(total, Number(dkm||0)));
      // Binary search to find segment [i-1, i] that brackets d
      let lo = 0, hi = ROUTE_CUM_DISTS.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ROUTE_CUM_DISTS[mid] < d) lo = mid + 1; else hi = mid;
      }
      const i = lo;
      let lat, lon;
      if (i <= 0) {
        [lon, lat] = ROUTE_COORDS[0];
      } else if (i >= ROUTE_COORDS.length) {
        const last = ROUTE_COORDS[ROUTE_COORDS.length - 1];
        lon = last[0]; lat = last[1];
      } else {
        const d1 = ROUTE_CUM_DISTS[i-1];
        const d2 = ROUTE_CUM_DISTS[i];
        const t = (d2 > d1) ? Math.max(0, Math.min(1, (d - d1) / (d2 - d1))) : 0;
        const [lon1, lat1] = ROUTE_COORDS[i-1];
        const [lon2, lat2] = ROUTE_COORDS[i];
        lon = lon1 + (lon2 - lon1) * t;
        lat = lat1 + (lat2 - lat1) * t;
      }
      const latlng = L.latLng(lat, lon);
      if (!MAP_CURSOR_MARKER) {
        MAP_CURSOR_MARKER = L.circleMarker(latlng, { radius: 6, color: '#555', fillColor: '#555', fillOpacity: 0.85, weight: 0 });
        MAP_CURSOR_MARKER.addTo(map);
      } else {
        MAP_CURSOR_MARKER.setLatLng(latlng);
      }
    } catch (e) { console.error('updateMapCursorAtDistance error', e); }
  };

  // Profile cursor line + tooltip updater
  window.updateProfileCursor = function(index, displayX) {
    if (!profileCursorCtx || !profileCanvas || !LAST_PROFILE) return;
    const rect = profileCanvas.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width));
    const H = Math.max(1, Math.floor(rect.height));
    const { padTop, padBot, padL, padR } = getPads();
    const innerW = Math.max(1, W - padL - padR);
    const innerH = Math.max(1, H - padTop - padBot);
    const dist = Array.isArray(LAST_PROFILE.sampled_dist_km) ? LAST_PROFILE.sampled_dist_km : [];
    if (!dist.length || index < 0 || index >= dist.length) return;
    const snapX = PROFILE_XS[index] ?? (padL + (innerW * (dist[index] / (dist[dist.length - 1] || 1))));
    const xDisplay = (typeof displayX === 'number') ? displayX : snapX;
    const dpr = (window.devicePixelRatio || 1);
    const x = xDisplay / dpr; // align drawing with canvas transform scaling
    // Clear cursor canvas and draw vertical dashed line
    profileCursorCtx.clearRect(0, 0, W, H);
    profileCursorCtx.strokeStyle = '#666';
    profileCursorCtx.lineWidth = 1;
    profileCursorCtx.setLineDash([4,4]);
    profileCursorCtx.beginPath();
    profileCursorCtx.moveTo(x, padTop / dpr);
    profileCursorCtx.lineTo(x, (padTop + innerH) / dpr);
    profileCursorCtx.stroke();
    profileCursorCtx.setLineDash([]);

    // Removed: secondary snapped grid line; keep single dashed cursor only

    // Optional debug overlay to compare coordinate methods
    if (DEBUG_CURSOR) {
      try {
        // Draw a small marker at snapped profile x
        if (Number.isFinite(snapX)) {
          profileCursorCtx.fillStyle = 'rgba(30,144,255,0.9)';
          profileCursorCtx.beginPath();
          profileCursorCtx.arc(snapX / dpr, (padTop + 8) / dpr, 3, 0, Math.PI*2);
          profileCursorCtx.fill();
        }
        // Render text with measurement
        profileCursorCtx.fillStyle = '#333';
        profileCursorCtx.font = '11px system-ui, -apple-system, sans-serif';
        const dx = Math.round((xDisplay - (snapX||xDisplay)) * 10) / 10;
        profileCursorCtx.fillText(`x=${Math.round(xDisplay)} | snap=${Math.round(snapX||xDisplay)} | Δ=${dx}px | scale=${CURSOR_X_SCALE.toFixed(2)}`, padL + 6, padTop + 18);
      } catch (e) { console.warn('DEBUG_CURSOR overlay error', e); }
    }

    // Build tooltip content; display the profile’s cumulative distance
    // Compute displayed km directly from VDL position mapped onto [padL, padL+innerW] → [0, routeLen]
    let dkm = 0;
    try {
      const routeLen = Array.isArray(ROUTE_CUM_DISTS) && ROUTE_CUM_DISTS.length >= 2 ? Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0) : 0;
      const xClamped = Math.max(padL, Math.min(padL + innerW, Number(xDisplay || snapX)));
      const u = (xClamped - padL) / Math.max(1, innerW);
      // Do not flip by REVERSED: distance increases left→right; map cursor moves Start→End
      dkm = (Number.isFinite(routeLen) ? (routeLen * Math.max(0, Math.min(1, u))) : 0);
      if ((typeof window !== 'undefined' && window.DEBUG_CURSOR_LOG === true) || DEBUG_CURSOR_LOG) {
        try {
          const xDisp = (typeof xDisplay === 'number') ? Math.round(xDisplay) : Math.round(snapX);
          console.log(`[MouseKM] x=${xDisp} px | profile_km=${dkm.toFixed(1)} | routeLen=${routeLen.toFixed(1)} | idx=${index}/${dist.length-1}`);
        } catch (_) {}
      }
    } catch(_) {}
    let best = null, bestDiff = Infinity;
    for (const p of OVERLAY_POINTS) {
      const diff = Math.abs(Number(p.dist || 0) - Number(dkm || 0));
      if (diff < bestDiff) { bestDiff = diff; best = p; }
    }
    // dkm already scaled to route length for display
    const elev = Array.isArray(LAST_PROFILE.elev_m) ? LAST_PROFILE.elev_m[index] : null;
    // Day/date mapping via boundaries and startDate
    const bounds = Array.isArray(LAST_PROFILE.day_boundaries) ? LAST_PROFILE.day_boundaries : [];
    let dayIdx = 0;
    if (bounds && bounds.length) {
      const marks = bounds.map(b => Number(b.distance_km||0)).filter(v => Number.isFinite(v));
      dayIdx = marks.findIndex(m => dkm < m);
      if (dayIdx === -1 || dayIdx < 0) dayIdx = marks.length;
    }
    let dateStr = '-';
    try {
      const sd = startDateInput.value ? new Date(startDateInput.value) : null;
      if (sd) {
        const d2 = new Date(sd);
        d2.setDate(d2.getDate() + dayIdx);
        const mm = String(d2.getMonth()+1).padStart(2,'0');
        const dd = String(d2.getDate()).padStart(2,'0');
        dateStr = `${dd}.${mm}`;
      }
    } catch (_) {}
    const tempMed = best ? (Number.isFinite(best.temp_day_median) ? Number(best.temp_day_median) : (Number.isFinite(best.temperature) ? Number(best.temperature) : null)) : null;
    // If temp_med still null, approximate by midpoint of p25/p75
    const tMid = (best && Number.isFinite(best.temp_day_p25) && Number.isFinite(best.temp_day_p75)) ? (Number(best.temp_day_p25)+Number(best.temp_day_p75))/2 : tempMed;
    const t25 = (best && Number.isFinite(best.temp_day_p25))
      ? Number(best.temp_day_p25)
      : (best && Number.isFinite(best.temp_hist_p25))
        ? Number(best.temp_hist_p25)
        : null;
    const t75 = (best && Number.isFinite(best.temp_day_p75))
      ? Number(best.temp_day_p75)
      : (best && Number.isFinite(best.temp_hist_p75))
        ? Number(best.temp_hist_p75)
        : null;
    const yearsStart = best && Number.isFinite(best.yearsStart) ? Number(best.yearsStart) : null;
    const yearsEnd = best && Number.isFinite(best.yearsEnd) ? Number(best.yearsEnd) : null;
    const matchDays = best && Number.isFinite(best.matchDays) ? Number(best.matchDays) : null;
    const rainP = best && Number.isFinite(best.rainProb) ? Math.round(Number(best.rainProb)*100) : null;
    const rainTyp = best && Number.isFinite(best.rainTypical) ? Number(best.rainTypical) : ((best && Number.isFinite(best.precipMm)) ? Number(best.precipMm) : null);
    const wspd = best && Number.isFinite(best.windSpeed) ? Number(best.windSpeed) : null;
    const wdir = best && Number.isFinite(best.windDir) ? Number(best.windDir) : null;
    // Effective wind component along route
    let effWind = null;
    try {
      const sd2 = Array.isArray(LAST_PROFILE.sampled_dist_km) ? LAST_PROFILE.sampled_dist_km : [];
      const sh2 = Array.isArray(LAST_PROFILE.sampled_heading_deg) ? LAST_PROFILE.sampled_heading_deg : [];
      if (Array.isArray(ROUTE_CUM_DISTS) && sd2.length && sh2.length === sd2.length && Number.isFinite(dkm) && Number.isFinite(wspd) && Number.isFinite(wdir)) {
        // Binary search over scaled profile distances: use same scaling
        const profLen2 = Number(sd2[sd2.length - 1] || 0);
        const routeLen2 = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
        const scale2 = (Number.isFinite(routeLen2) && Number.isFinite(profLen2) && profLen2 > 0) ? (routeLen2 / profLen2) : 1;
        let lo=0, hi=sd2.length-1;
        while(lo<hi){ const mid=(lo+hi)>>1; if (sd2[mid]*scale2<dkm) lo=mid+1; else hi=mid; }
        const routeDir = Number(sh2[lo]||0);
        // Convert wind "from" to "to" direction (+180°) before projection
        const wdirTo = ((wdir + 180.0) % 360.0);
        const ang = (wdirTo - routeDir) * Math.PI/180.0;
        effWind = wspd * Math.cos(ang);
      }
    } catch(_) {}
    const colLeft = [
      `Day ${dayIdx+1} — ${dateStr}`,
      `Distance: ${fmt(dkm,1)} km`,
      `Elevation: ${fmt(elev,0)} m`,
      `Years: ${yearsStart===null||yearsEnd===null?'-':`${yearsStart}–${yearsEnd}`}${matchDays===null?'':` (n=${Math.round(matchDays)})`}`
    ];
    // Comfort thresholds
    const T_COLD = Number(SETTINGS.tempCold || 5);
    const T_HOT = Number(SETTINGS.tempHot || 30);
    const R_HIGH = Number(SETTINGS.rainHigh || 10);
    const W_HEAD = Number(SETTINGS.windHeadComfort || 4);
    const W_TAIL = Number(SETTINGS.windTailComfort || 10);
    function styleVal(v, bad, good) {
      const base = fmt(v, 1);
      if (v === null || v === undefined) return base;
      if (good) return `<span style="color:#2a7a2a;font-weight:600">${base}</span>`;
      if (bad) return `<span style="color:#c0392b;font-weight:700">${base}</span>`;
      return base;
    }
    const tempMedStyled = styleVal(tMid, (Number(tMid) <= T_COLD || Number(tMid) >= T_HOT));
    const colMid = [
      `Temp median: ${tempMedStyled} °C`,
      `Temp range: ${fmt(t25,1)}–${fmt(t75,1)} °C`
    ];
    const rainTypStyled = styleVal(rainTyp, Number(rainTyp) >= R_HIGH);
    // Effective wind: color by direction and threshold (tailwind green, headwind red)
    let effStyled = effWind===null?'-':fmt(effWind,1);
    if (effWind !== null && Number.isFinite(effWind)) {
      const absW = Math.abs(effWind);
      const isTail = effWind > 0;
      const limit = isTail ? W_TAIL : W_HEAD;
      const warn = absW >= limit;
      if (warn) {
        effStyled = `<span style="color:${isTail?'#2a7a2a':'#c0392b'};font-weight:700">${fmt(effWind,1)}</span>`;
      }
    }
    const colRight = [
      `Rain probability: ${rainP===null?'-':rainP}%`,
      `Typical rain: ${rainTypStyled} mm`,
      `Wind: ${fmt(wspd,1)} m/s @ ${degToCardinal(wdir)}${wdir===null?'':` (${fmt(wdir,0)}°)`}`,
      `Effective wind: ${effStyled} m/s`
    ];
    if (profileTooltip) {
      const colStyle = 'display:flex; flex-direction:column; gap:1px; min-width:100px; font-size:9px; line-height:1.3;';
      const sepStyle = 'width:1px; background:#ddd; margin:0 6px;';
      profileTooltip.innerHTML = `
        <div style="display:flex; align-items:flex-start; justify-content:center;">
          <div id="ptt-left" style="${colStyle} flex:1;">${colLeft.map(l => `<div>${l}</div>`).join('')}</div>
          <div style="${sepStyle}"></div>
          <div id="ptt-mid" style="${colStyle} flex:1;">${colMid.map(l => `<div>${l}</div>`).join('')}</div>
          <div style="${sepStyle}"></div>
          <div id="ptt-right" style="${colStyle} flex:1;">${colRight.map(l => `<div>${l}</div>`).join('')}</div>
        </div>`;
      profileTooltip.style.display = 'block';
      // Auto-fit tooltip width to keep third column within 4 single-line items (avoid line wraps)
      try {
        const widths = [480, 560, 640, 720];
        const getLines = (el) => {
          try {
            const rect = el.getBoundingClientRect();
            const lh = parseFloat(window.getComputedStyle(el).lineHeight || '0');
            if (!rect || !rect.height || !lh) return 1;
            return Math.ceil(rect.height / lh);
          } catch { return 1; }
        };
        setTimeout(() => {
          let applied = false;
          for (let w of widths) {
            profileTooltip.style.width = `${w}px`;
            const rightCol = profileTooltip.querySelector('#ptt-right');
            let maxLines = 0;
            if (rightCol && rightCol.children && rightCol.children.length) {
              for (let i = 0; i < rightCol.children.length; i++) {
                const child = rightCol.children[i];
                maxLines = Math.max(maxLines, getLines(child));
              }
            }
            // Accept layout when no child wraps to multiple lines
            if (maxLines <= 1) { applied = true; break; }
          }
          if (!applied) profileTooltip.style.width = `${widths[widths.length-1]}px`;
        }, 0);
      } catch (_) {}
    }
    // Sync map marker using VDL-mapped distance (fractional interpolation along route)
    window.updateMapCursorAtDistance(dkm);
  };

  // Assisted test: enable logging of mouse X and km; set demo settings
  window.enableProfileMouseKmTest = function() {
    DEBUG_CURSOR_LOG = true;
    console.log('[Test] Mouse→km logging enabled. Move mouse leftmost then rightmost in the elevation profile.');
  };
  window.setTestDemoSettings = function() {
    try {
      SETTINGS = { stepKm: 100, histLastYear: 2024, histYears: 1 };
      saveSettings(SETTINGS);
      STEP_KM = SETTINGS.stepKm;
      REVERSED = false;
      // Force Montpellier GPX via override param
      LAST_GPX_PATH = '/Users/ingolfhorsch/Projekte/WeatherMap/project/data/2026-02-13_2781422668_von Montpellier nach Bayonne.gpx';
      // Ensure tour days reflects UI input; leave existing value
      loadMap();
      console.log('[Test] Applied demo settings: Montpellier GPX, stepKm=100, histLast=2024, histYears=1');
    } catch (e) {
      console.warn('setTestDemoSettings error', e);
    }
  };

  // Compute route index mapping for profile points using cumulative route distances
  let ROUTE_CUM_DISTS = null; // km cumulative along ROUTE_COORDS
  function computeRouteCumulativeDistances() {
    try {
      if (!Array.isArray(ROUTE_COORDS) || ROUTE_COORDS.length < 2) { ROUTE_CUM_DISTS = null; return; }
      const R = 6371.0;
      const toRad = (v) => v * Math.PI / 180.0;
      const haversineKm = (lon1, lat1, lon2, lat2) => {
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
        return R * c;
      };
      ROUTE_CUM_DISTS = new Array(ROUTE_COORDS.length);
      ROUTE_CUM_DISTS[0] = 0;
      for (let i = 1; i < ROUTE_COORDS.length; i++) {
        const [lon1, lat1] = ROUTE_COORDS[i-1];
        const [lon2, lat2] = ROUTE_COORDS[i];
        const d = haversineKm(lon1, lat1, lon2, lat2);
        ROUTE_CUM_DISTS[i] = ROUTE_CUM_DISTS[i-1] + (Number.isFinite(d) ? d : 0);
      }
    } catch (e) { console.error('computeRouteCumulativeDistances error', e); ROUTE_CUM_DISTS = null; }
  }

  function computeProfileRouteIndexes(profile) {
    PROFILE_ROUTE_INDEXES = [];
    try {
      if (!Array.isArray(ROUTE_COORDS) || ROUTE_COORDS.length < 2) return;
      if (!ROUTE_CUM_DISTS) computeRouteCumulativeDistances();
      const dist = Array.isArray(profile.sampled_dist_km) ? profile.sampled_dist_km : [];
      if (!dist.length || !Array.isArray(ROUTE_CUM_DISTS)) return;
      // If profile distances are not full-route, scale them to match route length
      const routeLen = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
      const profLen = Number(dist[dist.length - 1] || 0);
      const scale = (Number.isFinite(routeLen) && Number.isFinite(profLen) && profLen > 0) ? (routeLen / profLen) : 1;
      // Map each profile distance to nearest route coordinate by cumulative distance
      const nearestRouteIdx = (dkm) => {
        let lo = 0, hi = ROUTE_CUM_DISTS.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (ROUTE_CUM_DISTS[mid] < dkm) lo = mid + 1; else hi = mid;
        }
        // Choose nearer of lo and lo-1
        if (lo > 0) {
          const a = ROUTE_CUM_DISTS[lo];
          const b = ROUTE_CUM_DISTS[lo-1];
          return Math.abs(a - dkm) < Math.abs(dkm - b) ? lo : (lo - 1);
        }
        return lo;
      };
      for (let i = 0; i < dist.length; i++) {
        const dkmScaled = Number(dist[i] || 0) * scale;
        PROFILE_ROUTE_INDEXES[i] = nearestRouteIdx(dkmScaled);
      }
    } catch (e) { console.error('computeProfileRouteIndexes error', e); }
  }

  function drawOverlay(profile) {
    if (!profileCanvas || !profileCtx) return;
    const rect = profileCanvas.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width));
    const H = Math.max(1, Math.floor(rect.height));
    const { padTop, padBot, padL, padR } = getPads();
    const innerW = Math.max(1, W - padL - padR);
    const innerH = Math.max(1, H - padTop - padBot);
    const dist = Array.isArray(profile.sampled_dist_km) ? profile.sampled_dist_km : [];
    const profLen = dist.length ? (dist[dist.length - 1] || 1) : 1;
    let axisLen = profLen;
    try {
      if (Array.isArray(ROUTE_CUM_DISTS) && ROUTE_CUM_DISTS.length >= 2) {
        const rl = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
        if (Number.isFinite(rl) && rl > 0) axisLen = rl;
      }
    } catch (_) {}
    const xAt = (d) => {
      const dd = Math.max(0, Math.min(axisLen, Number(d) || 0));
      return padL + (innerW * (dd / Math.max(1e-6, axisLen)));
    };
    // Prepare points sorted by distance
    const pts = (OVERLAY_POINTS || []).slice().filter(p => Number.isFinite(p.dist)).sort((a, b) => a.dist - b.dist);
    if (!pts.length) return;
    if (OVERLAY_MODE === 'temperature') {
      // Color ramp identical to glyphs
      const anchors = [
        // Palette B — Blue→Teal→Lime→Yellow→Orange→Crimson
        { t: -20.0, c: [0x00, 0x5b, 0xff] },
        { t: -10.0, c: [0x00, 0xb3, 0xcc] },
        { t: 0.0,   c: [0x00, 0xd9, 0xa3] },
        { t: 15.0,  c: [0x7d, 0xff, 0x00] },
        { t: 20.0,  c: [0xff, 0xf2, 0x00] },
        { t: 25.0,  c: [0xff, 0x99, 0x33] },
        { t: 30.0,  c: [0xff, 0x33, 0x33] },
        { t: 40.0,  c: [0xcc, 0x00, 0x00] },
      ];
      function colorFromTemperature(t) {
        const tt = Math.max(anchors[0].t, Math.min(anchors[anchors.length-1].t, Number(t)));
        for (let i = 0; i < anchors.length - 1; i++) {
          const a0 = anchors[i], a1 = anchors[i+1];
          if (a0.t <= tt && tt <= a1.t) {
            const u = (a1.t === a0.t) ? 1 : (tt - a0.t) / (a1.t - a0.t);
            const r = Math.round(a0.c[0] + u * (a1.c[0] - a0.c[0]));
            const g = Math.round(a0.c[1] + u * (a1.c[1] - a0.c[1]));
            const b = Math.round(a0.c[2] + u * (a1.c[2] - a0.c[2]));
            return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
          }
        }
        const c = anchors[anchors.length-1].c;
        return `#${c[0].toString(16).padStart(2,'0')}${c[1].toString(16).padStart(2,'0')}${c[2].toString(16).padStart(2,'0')}`;
      }
      // Map temperature to vertical range using data min/max across all relevant values
      function pointMedianT(p) {
        if (Number.isFinite(p.temp_day_median)) return Number(p.temp_day_median);
        if (Number.isFinite(p.temp_day_p25) && Number.isFinite(p.temp_day_p75)) {
          return (Number(p.temp_day_p25) + Number(p.temp_day_p75)) * 0.5;
        }
        return Number(p.temperature);
      }
      const baseVals = pts.map(pointMedianT).filter(v => Number.isFinite(v));
      if (!baseVals.length) return;
      const histVals = pts.flatMap(p => [p.temp_hist_p25, p.temp_hist_p75]).map(Number).filter(v => Number.isFinite(v));
      const dayVals = pts.flatMap(p => [p.temp_day_p25, p.temp_day_p75]).map(Number).filter(v => Number.isFinite(v));
      const allVals = baseVals.concat(histVals).concat(dayVals);
      // Fixed scale baseline: -10..40°C; expand only if values exceed bounds
      let tmin = -10;
      let tmax = 40;
      if (allVals.length) {
        const dataMin = Math.min(...allVals);
        const dataMax = Math.max(...allVals);
        if (Number.isFinite(dataMin) && dataMin < tmin) tmin = dataMin;
        if (Number.isFinite(dataMax) && dataMax > tmax) tmax = dataMax;
      }
      if (!isFinite(tmin) || !isFinite(tmax) || tmax <= tmin) { tmin = -10; tmax = 40; }
      const yAtT = (t) => padTop + innerH - Math.round(innerH * ((Number(t) - tmin) / Math.max(1e-6, tmax - tmin)));
      // Color: single route-level color derived from median of temp_day_median
      const routeMedianT = (function() {
        const vals = baseVals.slice().sort((a,b)=>a-b);
        const n = vals.length;
        if (!n) return baseVals[0];
        if (n % 2 === 1) return vals[(n-1)>>1];
        return (vals[n>>1] + vals[(n>>1)-1]) / 2;
      })();
      // Historical and Daytime variability rendering helpers
      function withAlpha(hex, alpha) {
        const r = parseInt(hex.slice(1,3), 16);
        const g = parseInt(hex.slice(3,5), 16);
        const b = parseInt(hex.slice(5,7), 16);
        return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, Number(alpha)))})`;
      }
      function drawTemperatureBand(points, lowerKey, upperKey, opacity, colorHex) {
        const valid = points.filter(p => Number.isFinite(p[lowerKey]) && Number.isFinite(p[upperKey]) && Number.isFinite(p.dist));
        if (valid.length < 2) return;
        let maxDiff = 0;
        for (let i = 0; i < valid.length; i++) {
          const d = Math.abs(Number(valid[i][upperKey]) - Number(valid[i][lowerKey]));
          if (Number.isFinite(d)) maxDiff = Math.max(maxDiff, d);
        }
        if (maxDiff < 1e-6) return;
        const col = withAlpha(colorHex, opacity);
        profileCtx.beginPath();
        for (let i = 0; i < valid.length; i++) {
          const p = valid[i];
          const x = xAt(p.dist);
          const y = yAtT(p[upperKey]);
          if (i === 0) profileCtx.moveTo(x, y);
          else profileCtx.lineTo(x, y);
        }
        for (let i = valid.length - 1; i >= 0; i--) {
          const p = valid[i];
          const x = xAt(p.dist);
          const y = yAtT(p[lowerKey]);
          profileCtx.lineTo(x, y);
        }
        profileCtx.closePath();
        profileCtx.fillStyle = col;
        profileCtx.fill();
      }
      function drawTemperatureLine(points, key, opacity, dashed) {
        const valid = points.filter(p => Number.isFinite(p[key]) && Number.isFinite(p.dist));
        if (valid.length < 2) return;
        profileCtx.beginPath();
        for (let i = 0; i < valid.length; i++) {
          const p = valid[i];
          const x = xAt(p.dist);
          const y = yAtT(p[key]);
          if (i === 0) profileCtx.moveTo(x, y);
          else profileCtx.lineTo(x, y);
        }
        profileCtx.strokeStyle = withAlpha(colorFromTemperature(routeMedianT), opacity);
        profileCtx.lineWidth = 1;
        profileCtx.setLineDash(dashed ? [3,3] : []);
        profileCtx.stroke();
        profileCtx.setLineDash([]);
      }
      const baseColor = colorFromTemperature(routeMedianT);
      const hasHist = pts.some(p => Number.isFinite(p.temp_hist_p25) && Number.isFinite(p.temp_hist_p75));
      if (hasHist) {
        drawTemperatureBand(pts, 'temp_hist_p25', 'temp_hist_p75', 0.15, baseColor);
      }
      // Daytime variability lines (p25, p75) — dashed, single path each
      const hasDay = pts.some(p => Number.isFinite(p.temp_day_p25) && Number.isFinite(p.temp_day_p75));
      if (hasDay) {
        // If percentile band collapses, skip percentile lines
        let maxDayDiff = 0;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          if (Number.isFinite(p.temp_day_p25) && Number.isFinite(p.temp_day_p75)) {
            const d = Math.abs(Number(p.temp_day_p75) - Number(p.temp_day_p25));
            if (Number.isFinite(d)) maxDayDiff = Math.max(maxDayDiff, d);
          }
        }
        if (maxDayDiff > 1e-6) {
          drawTemperatureLine(pts, 'temp_day_p25', 0.8, true);
          drawTemperatureLine(pts, 'temp_day_p75', 0.8, true);
        }
      }
      // Median temperature line — single continuous path, solid
      const validMed = pts.filter(p => Number.isFinite(pointMedianT(p)) && Number.isFinite(p.dist));
      if (validMed.length >= 2) {
        profileCtx.beginPath();
        for (let i = 0; i < validMed.length; i++) {
          const p = validMed[i];
          const x = xAt(p.dist);
          const y = yAtT(pointMedianT(p));
          if (i === 0) profileCtx.moveTo(x, y);
          else profileCtx.lineTo(x, y);
        }
        profileCtx.strokeStyle = baseColor;
        profileCtx.lineWidth = 2;
        profileCtx.setLineDash([]);
        profileCtx.stroke();
      }
      // Store axis parameters for rendering outside clipping region
      return { mode: 'temperature', tmin, tmax, yAtT, colorFromTemperature };
    } else if (OVERLAY_MODE === 'precipitation') {
      // Build precipitation data points
      const data = pts.map(p => ({
        dist: Number(p.dist),
        rainProb: (p.rainProb !== undefined) ? Math.max(0, Math.min(1, Number(p.rainProb))) : 0,
        rainTypical: (p.rainTypical !== undefined) ? Number(p.rainTypical) : ((p.precipMm !== undefined) ? Number(p.precipMm) : null)
      })).filter(d => Number.isFinite(d.dist));
      // Always draw a right-side precipitation axis (0,5,10,15 mm)
      // Default y-axis height is 20mm, stretch if needed
      let maxMm = 20.0;
      for (let i = 0; i < data.length; i++) {
        const mm = Number(data[i].rainTypical);
        if (Number.isFinite(mm) && mm > maxMm) maxMm = mm;
      }
      // If any product rain*prob exceeds maxMm, stretch axis
      for (let i = 0; i < data.length; i++) {
        const mm = Number(data[i].rainTypical);
        const prob = Math.max(0, Math.min(1, Number(data[i].rainProb)));
        const val = mm * prob;
        if (Number.isFinite(val) && val > maxMm) maxMm = val;
      }
      // Only one pxPerMm declaration
      const pxPerMm = innerH / maxMm;
      if (data.length >= 2 && window.drawRainProbabilityArea) {
        window.drawRainProbabilityArea(profileCtx, data, { padTop, padBot, padL, padR, innerW, innerH, xAt, maxMm });
      }
      if (data.length && window.drawRainBars) {
        window.drawRainBars(profileCtx, data, { padTop, padBot, padL, padR, innerW, innerH, xAt, maxMm });
      }
      // Store axis parameters for rendering outside clipping region
      return { mode: 'precipitation', maxMm, pxPerMm };
    } else if (OVERLAY_MODE === 'wind') {
      // Wind profile: effective wind (-8..+8 m/s) and variability band
      const windData = window.computeEffectiveWind ? window.computeEffectiveWind(pts, profile) : null;
      if (windData && window.drawWindProfile) {
        const windAxisInfo = window.drawWindProfile(profileCtx, windData, { padTop, padBot, padL, padR, innerW, innerH, xAt });
        if (windAxisInfo) return { mode: 'wind', ...windAxisInfo };
      }
    }
  }

  async function loadMap(opts) {
    const loadOpts = (opts && typeof opts === 'object') ? opts : {};
    LAST_LOAD_OPTS = loadOpts;
    // Update button state
    if (fetchWeatherBtn) {
      fetchWeatherBtn.textContent = 'Downloading...';
      fetchWeatherBtn.disabled = true;
    }
    if (stopWeatherBtn) stopWeatherBtn.style.display = 'block';
    // Prepare determinate progress
    if (evtSource) { try { evtSource.close(); } catch (_) {} }
    if (progressEl && progressBar) {
      progressEl.classList.remove('loading');
      progressBar.style.width = '0%';
    }
    if (sseStatus) sseStatus.textContent = 'Stream: connecting…';
    const selected = startDateInput.value ? new Date(startDateInput.value) : new Date();
    const mmdd = getMMDD(selected);
    const isTourMode = (document.body && document.body.dataset && document.body.dataset.mode)
      ? (document.body.dataset.mode === 'tour')
      : true;
    const tourPlanningParam = isTourMode ? '1' : '0';
    // Subscribe to streaming map data (route + per-station glyphs)
    const tourDays = Number(tourDaysInput?.value || 7);
    const startDateStr = startDateInput && startDateInput.value ? startDateInput.value : new Date().toISOString().slice(0,10);
    const gpxParam = LAST_GPX_PATH ? `&gpx_path=${encodeURIComponent(LAST_GPX_PATH)}` : '';
      const revParam = REVERSED ? '&reverse=1' : '';

      // Convert UI settings (last year + number of years) into backend params.
      const nowYear = (new Date()).getFullYear();
      const histLast = (loadOpts.histLastYearOverride !== undefined) ? Number(loadOpts.histLastYearOverride) : Number(SETTINGS.histLastYear);
      const histN = Math.max(1, Math.round((loadOpts.histYearsOverride !== undefined) ? Number(loadOpts.histYearsOverride) : (Number(SETTINGS.histYears) || 10)));
      const histEnd = (Number.isFinite(histLast) && histLast >= 1970) ? Math.round(histLast) : (nowYear - 1);
      const histStart = histEnd - histN + 1;

      const offlineOnlyParam = loadOpts.offlineOnly ? '&offline_only=1' : '';
      const z = map.getZoom();
      const profileStep = (function(zoom){
        // Finer elevation sampling: reduce step per zoom for smoother profile
        if (zoom >= 13) return 1;
        if (zoom >= 12) return 2;
        if (zoom >= 11) return 3;
        if (zoom >= 10) return 4;
        if (zoom >= 9)  return 5;
        if (zoom >= 8)  return 6;
        if (zoom >= 7)  return 8;
        return 12;
      })(z);

    // Profile-first priming: fetch route + profile (dry-run) before stations
    if (!window.__WM_PROFILE_PRIME_DONE__) {
      if (PRIME_IN_PROGRESS || MAIN_IN_PROGRESS) return; // avoid parallel primes
      try { evtSource && evtSource.close(); } catch(_){}
      if (sseStatus) sseStatus.textContent = 'Loading route + profile…';
      OVERLAY_POINTS = [];
      const urlPrime = `/api/map_stream?date=${mmdd}&step_km=${STEP_KM}&profile_step_km=${profileStep}&tour_planning=${tourPlanningParam}&mode=single_day&dry_run=1&total_days=${tourDays}&start_date=${encodeURIComponent(startDateStr)}&hist_years=${histN}&hist_start=${histStart}${offlineOnlyParam}${gpxParam}${revParam}`;
      let evtSourcePrime = new EventSource(urlPrime);
      window.__WM_PRIME_EVT_SOURCE__ = evtSourcePrime;
      PRIME_IN_PROGRESS = true;
      let primeTimer = setTimeout(() => {
        try { evtSourcePrime && evtSourcePrime.close(); } catch(_){}
        console.warn('Prime timeout — proceeding to full stream');
        window.__WM_PROFILE_PRIME_DONE__ = true;
        PRIME_IN_PROGRESS = false;
        loadMap(loadOpts);
      }, 7000);
      evtSourcePrime.addEventListener('route', (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          ROUTE_COORDS = payload.route && payload.route.geometry && payload.route.geometry.coordinates || null;
          computeRouteCumulativeDistances();
        } catch(e){ console.warn('prime route error', e); }
      });
      evtSourcePrime.addEventListener('profile', (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          if (payload && payload.profile) {
            drawProfile(payload.profile);
            computeProfileRouteIndexes(payload.profile);
            if (sseStatus) sseStatus.textContent = 'Profile ready';
            // Immediately proceed to full stream after profile is ready
            try { evtSourcePrime && evtSourcePrime.close(); } catch(_){}
            if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }
            window.__WM_PROFILE_PRIME_DONE__ = true;
            PRIME_IN_PROGRESS = false;
            loadMap(loadOpts);
          }
        } catch(e){ console.warn('prime profile error', e); }
      });
      evtSourcePrime.addEventListener('done', () => {
        try { evtSourcePrime && evtSourcePrime.close(); } catch(_){}
        if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }
        window.__WM_PROFILE_PRIME_DONE__ = true;
        PRIME_IN_PROGRESS = false;
        // Proceed to full stream
        loadMap(loadOpts);
      });
      evtSourcePrime.onerror = (e) => {
        try { evtSourcePrime && evtSourcePrime.close(); } catch(_){}
        console.warn('Prime SSE error; continuing to full stream', e);
        if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }
        window.__WM_PROFILE_PRIME_DONE__ = true;
        PRIME_IN_PROGRESS = false;
        loadMap(loadOpts);
      };
      return; // wait for prime to complete
    }
      if (MAIN_IN_PROGRESS) return;
      MAIN_IN_PROGRESS = true;
      const qsComfort = `&temp_cold=${encodeURIComponent(SETTINGS.tempCold)}&temp_hot=${encodeURIComponent(SETTINGS.tempHot)}&rain_high=${encodeURIComponent(SETTINGS.rainHigh)}&wind_head_comfort=${encodeURIComponent(SETTINGS.windHeadComfort)}&wind_tail_comfort=${encodeURIComponent(SETTINGS.windTailComfort)}`;
      evtSource = new EventSource(`/api/map_stream?date=${mmdd}&step_km=${STEP_KM}&profile_step_km=${profileStep}&tour_planning=${tourPlanningParam}&mode=single_day&total_days=${tourDays}&start_date=${encodeURIComponent(startDateStr)}&hist_years=${histN}&hist_start=${histStart}${offlineOnlyParam}${gpxParam}${revParam}${qsComfort}`);
    let stationCount = 0;
    let stationTotal = 0;
    // Dim existing glyphs and prepare new layer
    if (glyphLayer) {
      try { glyphLayer.eachLayer(l => { if (l.setOpacity) l.setOpacity(0.3); }); } catch (_) {}
    }
    if (glyphLayerNew) { map.removeLayer(glyphLayerNew); }
    OVERLAY_POINTS = [];
    glyphLayerNew = L.layerGroup().addTo(map);

    // Subscribe to streaming map data
    evtSource.addEventListener('route', (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          const route = payload.route;
          const routeSegments = payload.route_segments;
          const startMarker = payload.start_marker;
          const endMarker = payload.end_marker;
          const total = Number(payload.total || 0);
          stationTotal = total;
          if (routeLayer) { map.removeLayer(routeLayer); }
          if (flagsLayer) { map.removeLayer(flagsLayer); flagsLayer = null; }
          // Render bright green, alternating brightness per day when available
          const ROUTE_COLOR_A = '#FFA726'; // softer orange
          const ROUTE_COLOR_B = '#FFD180'; // lighter, desaturated orange
          const CASE_COLOR = '#FFFFFF';
          const CASE_OPACITY = 0.7;
          const CASE_WEIGHT = 7;
          const LINE_WEIGHT = 4; // slimmer line
          if (routeSegments && routeSegments.features && routeSegments.features.length) {
            routeLayer = L.layerGroup().addTo(map);
            routeSegments.features.forEach(feat => {
              const di = Number((feat.properties||{}).day_index||0);
              const color = (di % 2 === 0) ? ROUTE_COLOR_A : ROUTE_COLOR_B;
              // Casing underlay
              L.geoJSON(feat, { style: { color: CASE_COLOR, weight: CASE_WEIGHT, opacity: CASE_OPACITY } }).addTo(routeLayer);
              // Colored line on top
              L.geoJSON(feat, { style: { color, weight: LINE_WEIGHT, opacity: 0.85 } }).addTo(routeLayer);
            });
          } else {
            routeLayer = L.layerGroup().addTo(map);
            // Casing underlay
            L.geoJSON(route, { style: { color: CASE_COLOR, weight: CASE_WEIGHT, opacity: CASE_OPACITY } }).addTo(routeLayer);
            // Colored line on top
            L.geoJSON(route, { style: { color: ROUTE_COLOR_A, weight: LINE_WEIGHT, opacity: 0.85 } }).addTo(routeLayer);
          }
          // ... (flags placement and fitBounds retained below)
          function dayAbbrev(d) {
            const idx = d.getDay();
            const arr = ['So','Mo','Di','Mi','Do','Fr','Sa'];
            return arr[idx];
          }
          function fmtDDMM(d) {
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth()+1).padStart(2, '0');
            return `${dd}.${mm}`;
          }
          function buildFlagSVG(type, title, dateStr) {
            const color = type === 'start' ? 'rgba(60,180,90,0.65)' : 'rgba(220,80,80,0.65)';
            const stroke = 'none';
            const mastStroke = '#333';
            const S = 1.7 * 1.2;
            const w = Math.round(60 * S), h = Math.round(30 * S);
            const mastX = Math.round(8 * S), mastTopY = Math.round(2 * S), mastBottomY = Math.round(30 * S);
            const tipX = mastX + Math.round(22 * S);
            const topY = mastTopY + Math.round(2 * S);
            const botY = topY + Math.round(11 * S);
            const topPath = `M ${mastX},${topY} C ${mastX+Math.round(8*S)},${topY-Math.round(3*S)} ${mastX+Math.round(14*S)},${topY+Math.round(1*S)} ${tipX},${topY}`;
            const botPath = `L ${tipX},${botY} C ${mastX+Math.round(14*S)},${botY+Math.round(3*S)} ${mastX+Math.round(8*S)},${botY-Math.round(1*S)} ${mastX},${botY} Z`;
            const marginL = Math.round(4 * S);
            const marginR = Math.round(2 * S);
            const textX = mastX + marginL;
            const textW = Math.max(10, tipX - textX - marginR);
            const dy = Math.round(h * 0.05);
            const titleY = topY + Math.round(5 * S) - dy;
            const dateY = topY + Math.round(11 * S) - dy;
            const lineFS = Math.round(5 * S);
            const svg = `
              <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
                <g>
                  <line x1="${mastX}" y1="${mastTopY}" x2="${mastX}" y2="${mastBottomY}" stroke="${mastStroke}" stroke-width="2" />
                  <path d="${topPath} ${botPath}" fill="${color}" stroke="${stroke}" />
                  <text x="${textX}" y="${titleY}" font-size="${lineFS}" font-weight="500" fill="#000" stroke="#fff" stroke-width="2" paint-order="stroke" dominant-baseline="middle" lengthAdjust="spacingAndGlyphs" textLength="${textW}">${title}</text>
                  <text x="${textX}" y="${dateY}" font-size="${lineFS}" font-weight="500" fill="#000" stroke="#fff" stroke-width="2" paint-order="stroke" dominant-baseline="middle" lengthAdjust="spacingAndGlyphs" textLength="${textW}">${dateStr}</text>
                </g>
              </svg>`;
            return svg;
          }
          function placeFlag(lat, lon, type, labelDateISO, refA, refB) {
            try {
              const base = L.latLng(lat, lon);
              const p1 = map.project(L.latLng(refA[1], refA[0]));
              const p2 = map.project(L.latLng(refB[1], refB[0]));
              const vx = p2.x - p1.x, vy = p2.y - p1.y;
              const len = Math.max(1, Math.sqrt(vx*vx + vy*vy));
              const nx = -vy / len, ny = vx / len;
              const offsetPx = 0; // align flag pole base exactly at GPX point
              const bp = map.project(base);
              const op = L.point(bp.x + nx*offsetPx, bp.y + ny*offsetPx);
              const offLatLng = map.unproject(op);
              const d = new Date(labelDateISO);
              const title = (type === 'start') ? 'Start' : 'Finish';
              const dateStr = `${dayAbbrev(d)} ${fmtDDMM(d)}`;
              const html = buildFlagSVG(type, title, dateStr);
              const S = 1.7;
              const icon = L.divIcon({ html, className: 'wm-flag', iconSize: [Math.round(60*S), Math.round(30*S)], iconAnchor: [Math.round(8*S), Math.round(30*S)] });
              return L.marker(offLatLng, { icon, interactive: false });
            } catch (e) { console.error('flag error', e); return null; }
          }
          flagsLayer = L.layerGroup().addTo(map);
          const coords = route.geometry.coordinates;
          if (startMarker && startMarker.geometry && Array.isArray(coords) && coords.length >= 2) {
            const [slon, slat] = startMarker.geometry.coordinates;
            const m = placeFlag(slat, slon, 'start', (startMarker.properties||{}).date, coords[0], coords[1]);
            if (m) flagsLayer.addLayer(m);
          }
          if (endMarker && endMarker.geometry && Array.isArray(coords) && coords.length >= 2) {
            const [elon, elat] = endMarker.geometry.coordinates;
            const m = placeFlag(elat, elon, 'finish', (endMarker.properties||{}).date, coords[coords.length-2], coords[coords.length-1]);
            if (m) flagsLayer.addLayer(m);
          }
          const b = boundsFromLineString(route.geometry.coordinates);
          map.fitBounds(b, { padding: [20, 20] });
          if (progressBar) progressBar.style.width = total > 0 ? '0%' : '0%';
          OVERLAY_POINTS = [];
          const ysRaw = (payload.years_start !== undefined) ? payload.years_start : payload.yearsStart;
          const yeRaw = (payload.years_end !== undefined) ? payload.years_end : payload.yearsEnd;
          const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : NaN; };
          let ysNum = toNum(ysRaw);
          let yeNum = toNum(yeRaw);
          const validYear = (y) => Number.isFinite(y) && y >= 1900 && y <= 2100;
          let usePayload = validYear(ysNum) && validYear(yeNum) && yeNum >= ysNum;
          if (!usePayload) {
            let endY = Number(SETTINGS.histLastYear);
            let n = Number(SETTINGS.histYears);
            if (!Number.isFinite(endY) || endY < 1900) endY = (new Date()).getFullYear() - 1;
            if (!Number.isFinite(n) || n <= 0) n = 10;
            yeNum = Math.round(endY);
            ysNum = Math.round(endY - n + 1);
            usePayload = true;
          }
          YEARS_SPAN_TEXT = usePayload ? `${ysNum}..${yeNum}` : null;
          const spanTxt = YEARS_SPAN_TEXT ? `historical Open-Meteo weather data ${YEARS_SPAN_TEXT}` : 'historical Open-Meteo weather data';
          if (sseStatus) sseStatus.textContent = `Loading station 0/${stationTotal} from ${spanTxt}`;
        } catch (e) { console.error('route event error', e); }
      try {
        const payload = JSON.parse(ev.data);
        const route = payload.route;
        const routeSegments = payload.route_segments;
        const startMarker = payload.start_marker;
        const endMarker = payload.end_marker;
        const total = Number(payload.total || 0);
        stationTotal = total;
        if (routeLayer) { map.removeLayer(routeLayer); }
        if (flagsLayer) { map.removeLayer(flagsLayer); flagsLayer = null; }
        // Render bright green, alternating brightness per day when available
        ROUTE_COORDS = route.geometry && route.geometry.coordinates || null;
        const ROUTE_COLOR_A = '#FFA726';
        const ROUTE_COLOR_B = '#FFD180';
        const CASE_COLOR = '#FFFFFF';
        const CASE_OPACITY = 0.7;
        const CASE_WEIGHT = 7;
        const LINE_WEIGHT = 4;
        if (routeSegments && routeSegments.features && routeSegments.features.length) {
          routeLayer = L.layerGroup().addTo(map);
          routeSegments.features.forEach(feat => {
            const di = Number((feat.properties||{}).day_index||0);
            const color = (di % 2 === 0) ? ROUTE_COLOR_A : ROUTE_COLOR_B;
            L.geoJSON(feat, { style: { color: CASE_COLOR, weight: CASE_WEIGHT, opacity: CASE_OPACITY } }).addTo(routeLayer);
            L.geoJSON(feat, { style: { color, weight: LINE_WEIGHT, opacity: 0.85 } }).addTo(routeLayer);
          });
        } else {
          routeLayer = L.layerGroup().addTo(map);
          L.geoJSON(route, { style: { color: CASE_COLOR, weight: CASE_WEIGHT, opacity: CASE_OPACITY } }).addTo(routeLayer);
          L.geoJSON(route, { style: { color: ROUTE_COLOR_A, weight: LINE_WEIGHT, opacity: 0.85 } }).addTo(routeLayer);
        }
        // Update route coords and recompute cumulative distances & profile mapping
        ROUTE_COORDS = route.geometry && route.geometry.coordinates || null;
        computeRouteCumulativeDistances();
        if (LAST_PROFILE) computeProfileRouteIndexes(LAST_PROFILE);
        // Render wind-blown banner flags using SVG with mast + curved cloth
        function dayAbbrev(d) {
          const idx = d.getDay();
          const arr = ['So','Mo','Di','Mi','Do','Fr','Sa'];
          return arr[idx];
        }
        function fmtDDMM(d) {
          const dd = String(d.getDate()).padStart(2, '0');
          const mm = String(d.getMonth()+1).padStart(2, '0');
          return `${dd}.${mm}`;
        }
        function buildFlagSVG(type, title, dateStr) {
          const color = type === 'start' ? 'rgba(60,180,90,0.65)' : 'rgba(220,80,80,0.65)';
          const stroke = 'none';
          const mastStroke = '#333';
          // Scale up by 1.7 (≈70%), then +20%
          const S = 1.7 * 1.2;
          const w = Math.round(60 * S), h = Math.round(30 * S);
          // Mast coordinates scaled; double mast height relative to original
          const mastX = Math.round(8 * S), mastTopY = Math.round(2 * S), mastBottomY = Math.round(30 * S);
          // Flag path attached near mastTopY
          // Create slightly waving banner using cubic bezier for top and bottom edges
          const tipX = mastX + Math.round(22 * S); // length scaled
          const topY = mastTopY + Math.round(2 * S);
          const botY = topY + Math.round(11 * S); // height ~10-12px scaled
          const topPath = `M ${mastX},${topY} C ${mastX+Math.round(8*S)},${topY-Math.round(3*S)} ${mastX+Math.round(14*S)},${topY+Math.round(1*S)} ${tipX},${topY}`;
          const botPath = `L ${tipX},${botY} C ${mastX+Math.round(14*S)},${botY+Math.round(3*S)} ${mastX+Math.round(8*S)},${botY-Math.round(1*S)} ${mastX},${botY} Z`;
          // Text layout: two lines inside cloth, same font size, ~50% scaling and slight upper-left shift
          const marginL = Math.round(4 * S);
          const marginR = Math.round(2 * S);
          const textX = mastX + marginL; // shift a bit to upper-left within cloth
          const textW = Math.max(10, tipX - textX - marginR);
          // Move text upwards by 5% of flag height
          const dy = Math.round(h * 0.05);
          const titleY = topY + Math.round(5 * S) - dy;
          const dateY = topY + Math.round(11 * S) - dy;
          const lineFS = Math.round(5 * S); // ~50% of previous size
          const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
              <g>
                <line x1="${mastX}" y1="${mastTopY}" x2="${mastX}" y2="${mastBottomY}" stroke="${mastStroke}" stroke-width="2" />
                <path d="${topPath} ${botPath}" fill="${color}" stroke="${stroke}" />
                <text x="${textX}" y="${titleY}" font-size="${lineFS}" font-weight="500" fill="#000" stroke="#fff" stroke-width="2" paint-order="stroke" dominant-baseline="middle" lengthAdjust="spacingAndGlyphs" textLength="${textW}">${title}</text>
                <text x="${textX}" y="${dateY}" font-size="${lineFS}" font-weight="500" fill="#000" stroke="#fff" stroke-width="2" paint-order="stroke" dominant-baseline="middle" lengthAdjust="spacingAndGlyphs" textLength="${textW}">${dateStr}</text>
              </g>
            </svg>`;
          return svg;
        }
        function placeFlag(lat, lon, type, labelDateISO, refA, refB) {
          try {
            const base = L.latLng(lat, lon);
            const p1 = map.project(L.latLng(refA[1], refA[0]));
            const p2 = map.project(L.latLng(refB[1], refB[0]));
            const vx = p2.x - p1.x, vy = p2.y - p1.y;
            const len = Math.max(1, Math.sqrt(vx*vx + vy*vy));
            // unit perpendicular (to the left of direction)
            const nx = -vy / len, ny = vx / len;
            const offsetPx = 0; // align flag pole base exactly at GPX point
            const bp = map.project(base);
            const op = L.point(bp.x + nx*offsetPx, bp.y + ny*offsetPx);
            const offLatLng = map.unproject(op);
            const d = new Date(labelDateISO);
            const title = (type === 'start') ? 'Start' : 'Finish';
            const dateStr = `${dayAbbrev(d)} ${fmtDDMM(d)}`;
            const html = buildFlagSVG(type, title, dateStr);
            const S = 1.7;
            const icon = L.divIcon({ html, className: 'wm-flag', iconSize: [Math.round(60*S), Math.round(30*S)], iconAnchor: [Math.round(8*S), Math.round(30*S)] });
            return L.marker(offLatLng, { icon, interactive: false });
          } catch (e) { console.error('flag error', e); return null; }
        }
        flagsLayer = L.layerGroup().addTo(map);
        // Determine reference segment for perpendicular offset
        const coords = route.geometry.coordinates;
        if (startMarker && startMarker.geometry && Array.isArray(coords) && coords.length >= 2) {
          const [slon, slat] = startMarker.geometry.coordinates;
          const m = placeFlag(slat, slon, 'start', (startMarker.properties||{}).date, coords[0], coords[1]);
          if (m) flagsLayer.addLayer(m);
        }
        if (endMarker && endMarker.geometry && Array.isArray(coords) && coords.length >= 2) {
          const [elon, elat] = endMarker.geometry.coordinates;
          const m = placeFlag(elat, elon, 'finish', (endMarker.properties||{}).date, coords[coords.length-2], coords[coords.length-1]);
          if (m) flagsLayer.addLayer(m);
        }
        const b = boundsFromLineString(route.geometry.coordinates);
        map.fitBounds(b, { padding: [20, 20] });
        if (progressBar) progressBar.style.width = total > 0 ? '0%' : '0%';
        OVERLAY_POINTS = [];
        // Robust years span: parse, validate, and fallback to SETTINGS if invalid
        const ysRaw = (payload.years_start !== undefined) ? payload.years_start : payload.yearsStart;
        const yeRaw = (payload.years_end !== undefined) ? payload.years_end : payload.yearsEnd;
        const toNum = (v) => {
          const n = Number(v);
          return Number.isFinite(n) ? Math.round(n) : NaN;
        };
        let ysNum = toNum(ysRaw);
        let yeNum = toNum(yeRaw);
        const validYear = (y) => Number.isFinite(y) && y >= 1900 && y <= 2100;
        let usePayload = validYear(ysNum) && validYear(yeNum) && yeNum >= ysNum;
        if (!usePayload) {
          // Fallback to current settings; ensure sane defaults
          let endY = Number(SETTINGS.histLastYear);
          let n = Number(SETTINGS.histYears);
          if (!Number.isFinite(endY) || endY < 1900) endY = (new Date()).getFullYear() - 1;
          if (!Number.isFinite(n) || n <= 0) n = 10;
          yeNum = Math.round(endY);
          ysNum = Math.round(endY - n + 1);
          usePayload = true;
        }
        YEARS_SPAN_TEXT = usePayload ? `${ysNum}..${yeNum}` : null;
        const spanTxt = YEARS_SPAN_TEXT ? `historical Open-Meteo weather data ${YEARS_SPAN_TEXT}` : 'historical Open-Meteo weather data';
        if (sseStatus) sseStatus.textContent = `Loading station 0/${stationTotal} from ${spanTxt}`;
      } catch (e) { console.error('route event error', e); }
    });
    // Profile data stream
    evtSource.addEventListener('profile', (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload && payload.profile) {
          drawProfile(payload.profile);
          // Precompute nearest route indexes for profile points for cursor sync
          computeProfileRouteIndexes(payload.profile);
        }
      } catch (e) { console.error('profile event error', e); }
    });
    // Tour Summary stream: render compact badges panel
    evtSource.addEventListener('tour_summary', (ev) => {
      try {
        const s = JSON.parse(ev.data);
        renderTourSummary(s);
      } catch (e) { console.warn('tour_summary parse error', e); }
    });
      // Mouse cursor interactions
      if (profileCanvas) {
        profileCanvas.addEventListener('mousemove', (e) => {
          if (!LAST_PROFILE || PROFILE_XS.length === 0) return;
          const rect = profileCanvas.getBoundingClientRect();
          const xClient = Number(e.clientX - rect.left);
          const { padTop, padBot, padL, padR } = getPads();
          const W = Math.max(1, Math.floor(rect.width));
          const H = Math.max(1, Math.floor(rect.height));
          const innerW = Math.max(1, W - padL - padR);
          const innerH = Math.max(1, H - padTop - padBot);
          // Calibrated Mouse-X mapped onto profile grid space
          // Map mouse X directly into the profile domain and clamp
          const xCal = xClient; // unified scale
          const xFinalRaw = xCal + CURSOR_X_OFFSET;
          const xFinal = Math.max(padL, Math.min(padL + innerW, xFinalRaw));
          // Snap to nearest x
          let bestI = 0, bestDx = Infinity;
          for (let i = 0; i < PROFILE_XS.length; i++) {
            const dx = Math.abs(PROFILE_XS[i] - xFinal);
            if (dx < bestDx) { bestDx = dx; bestI = i; }
          }
          window.updateProfileCursor(bestI, xFinal);
          if (DEBUG_CURSOR && profileCursorCtx) {
            // Draw additional red/blue guide lines for test comparison
            const rect2 = profileCanvas.getBoundingClientRect();
            const W = Math.max(1, Math.floor(rect2.width));
            const H = Math.max(1, Math.floor(rect2.height));
            // Do not clear; overlay on top of dashed line
            profileCursorCtx.strokeStyle = 'rgba(255,0,0,0.8)';
            profileCursorCtx.setLineDash([2,2]);
            profileCursorCtx.beginPath();
            profileCursorCtx.moveTo(xClient / dpr, padTop / dpr);
            profileCursorCtx.lineTo(xClient / dpr, (padTop + Math.max(1, H - padTop - padBot)) / dpr);
            profileCursorCtx.stroke();
            profileCursorCtx.strokeStyle = 'rgba(0,0,255,0.6)';
            profileCursorCtx.beginPath();
            profileCursorCtx.moveTo(xFinal / dpr, padTop / dpr);
            profileCursorCtx.lineTo(xFinal / dpr, (padTop + Math.max(1, H - padTop - padBot)) / dpr);
            profileCursorCtx.stroke();
            profileCursorCtx.setLineDash([]);
          }
        });
        profileCanvas.addEventListener('mouseleave', () => {
          if (profileTooltip) profileTooltip.style.display = 'none';
          // Keep the cursor line visible per spec: do nothing
        });
      }
    // Keyboard toggle for cursor test overlay
    window.addEventListener('keydown', (ev) => {
      if (ev.key.toLowerCase() === 't') {
        DEBUG_CURSOR = !DEBUG_CURSOR;
        console.log('DEBUG_CURSOR', DEBUG_CURSOR ? 'enabled' : 'disabled');
      }
      // Fine-tune offset live: [ decreases, ] increases
      if (ev.key === '[') { CURSOR_X_OFFSET -= 1; }
      if (ev.key === ']') { CURSOR_X_OFFSET += 1; }
    });
    // Reverse tour behavior
    const reverseCheck = document.getElementById('reverse');
    if (reverseCheck) {
      reverseCheck.addEventListener('change', () => {
        REVERSED = !!reverseCheck.checked;
        markDataStale();
      });
    }
  // Drag & Drop GPX upload
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.background = 'rgba(0,255,128,0.12)'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.background = 'rgba(0,255,128,0.06)'; });
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.style.background = 'rgba(0,255,128,0.06)';
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (!f.name.toLowerCase().endsWith('.gpx')) { alert('Please drop a .gpx file'); return; }
      const fd = new FormData();
      fd.append('file', f);
      try {
        const res = await fetch('/api/upload_gpx', { method: 'POST', body: fd });
        const j = await res.json();
        if (j && j.path) {
          LAST_GPX_PATH = j.path;
          updateDropZoneLabel();
          // Reset priming flag so new GPX triggers profile-first
          try { window.__WM_PROFILE_PRIME_DONE__ = false; } catch(_){}
          loadMap();
        } else {
          alert('Upload failed: ' + (j.error || 'unknown error'));
        }
      } catch (err) {
        console.error('Upload error', err);
        alert('Upload error: ' + err);
      }
    });
  }

    evtSource.addEventListener('station', (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        const f = payload.feature;
        const [lon, lat] = f.geometry.coordinates;
        const props = f.properties || {};
        // Build map glyph according to settings
        let icon = null;
        if ((SETTINGS.glyphType === 'svg') || (!SETTINGS.glyphType && !SETTINGS.useClassicWeatherIcons)) {
          const sizedSvg = resizeGlyphSVG(String(props.svg || ''), 51);
          const html = `<div class=\"glyph-inner\" style=\"width:51px;height:51px;filter:saturate(0.70);opacity:0.92;overflow:hidden\">${sizedSvg}</div>`;
          icon = L.divIcon({ html, className: 'glyph-map', iconSize: [51, 51], iconAnchor: [26, 26] });
        } else if (SETTINGS.glyphType === 'cyclist') {
          // Compose cyclist glyph into a 51x51 PNG
          const tMed = (props.temp_day_median !== undefined) ? Number(props.temp_day_median) : ((props.temperature_c !== undefined) ? Number(props.temperature_c) : (props.temp_median || 0));
          const t25 = (props.temp_day_p25 !== undefined) ? Number(props.temp_day_p25) : ((props.temp_p25 !== undefined) ? Number(props.temp_p25) : null);
          const t75 = (props.temp_day_p75 !== undefined) ? Number(props.temp_day_p75) : ((props.temp_p75 !== undefined) ? Number(props.temp_p75) : null);
          const prob = (props.rain_probability !== undefined) ? Number(props.rain_probability) : 0;
          // Relative wind vs route heading (approximate: use station angle towards next route point if available)
          let effRel = null;
          try {
            const sd = Array.isArray(LAST_PROFILE?.sampled_dist_km) ? LAST_PROFILE.sampled_dist_km : [];
            const sh = Array.isArray(LAST_PROFILE?.sampled_heading_deg) ? LAST_PROFILE.sampled_heading_deg : [];
            if (sd.length && sh.length === sd.length && Array.isArray(ROUTE_CUM_DISTS) && ROUTE_CUM_DISTS.length >= 2) {
              const dkm = Number(props.distance_from_start_km || 0);
              const profLen = Number(sd[sd.length - 1] || 0);
              const routeLen = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
              const scale2 = (Number.isFinite(routeLen) && Number.isFinite(profLen) && profLen > 0) ? (routeLen / profLen) : 1;
              let lo=0, hi=sd.length-1;
              while(lo<hi){ const mid=(lo+hi)>>1; if (sd[mid]*scale2<dkm) lo=mid+1; else hi=mid; }
              const routeDir = Number(sh[lo]||0);
              const wdirTo = ((Number(props.wind_dir_deg)||0) + 180.0) % 360.0;
              const ang = (wdirTo - routeDir) * Math.PI/180.0;
              effRel = Math.cos(ang);
            }
          } catch(_){ }
          const key = [Math.round(tMed*10)/10, t25 ?? '-', t75 ?? '-', Math.round(prob*100)/100, Math.round((props.wind_dir_deg||0)*10)/10, Math.round((props.wind_speed_ms||0)*10)/10, Math.round((props.wind_var_deg||0)*10)/10, Math.round((effRel||0)*100)/100].join('|');
          const cvs = getCyclistGlyphCanvas(key, { tMed, t25, t75, rainProb: prob, windDir: props.wind_dir_deg, windSpeed: props.wind_speed_ms, windVar: props.wind_var_deg, effRel });
          const mapCvs = document.createElement('canvas');
          mapCvs.width = 51; mapCvs.height = 51;
          const ctx2 = mapCvs.getContext('2d');
          const s = Math.min(mapCvs.width / cvs.width, mapCvs.height / cvs.height);
          const w = Math.round(cvs.width * s);
          const h = Math.round(cvs.height * s);
          const x = Math.round((mapCvs.width - w) / 2);
          const y = Math.round((mapCvs.height - h) / 2);
          ctx2.drawImage(cvs, x, y, w, h);
          const url = mapCvs.toDataURL('image/png');
          const html = `<div class=\"glyph-inner\" style=\"width:51px;height:51px;filter:saturate(0.85);opacity:0.98;overflow:hidden\"><img src=\"${url}\" width=\"51\" height=\"51\"/></div>`;
          icon = L.divIcon({ html, className: 'glyph-map', iconSize: [51, 51], iconAnchor: [26, 26] });
        } else {
          // Classic default: use server-provided SVG
          const sizedSvg = resizeGlyphSVG(String(props.svg || ''), 51);
          const html = `<div class=\"glyph-inner\" style=\"width:51px;height:51px;filter:saturate(0.70);opacity:0.92;overflow:hidden\">${sizedSvg}</div>`;
          icon = L.divIcon({ html, className: 'glyph-map', iconSize: [51, 51], iconAnchor: [26, 26] });
        }
        const m = L.marker([lat, lon], { icon });
        const kmh = msToKmh(props.wind_speed_ms);
        const selected2 = startDateInput.value ? new Date(startDateInput.value) : new Date();
        const mmdd2 = getMMDD(selected2);
        const tipHtml = (
          `<div class=\"wm-tip-content\">` +
            `<div class=\"wm-tip-line\"><strong>Station:</strong> ${props.station_name || '-'}</div>` +
            `<div class=\"wm-tip-line\"><strong>Day:</strong> ${props.tour_day_index!==undefined?(props.tour_day_index+1):'-'} of ${props.tour_total_days||'-'}</div>` +
            `<div class=\"wm-tip-line\"><strong>Date:</strong> ${props.date || mmdd2}</div>` +
            `<div class=\"wm-tip-line\"><strong>Years:</strong> ${(props._years_start!==undefined&&props._years_end!==undefined)?(`${props._years_start}–${props._years_end}`):'-'}${props._match_days===undefined?'':` (n=${Array.isArray(props._match_days)?props._match_days.length:props._match_days})`}</div>` +
            `<div class=\"wm-tip-line\"><strong>Distance:</strong> ${fmt(props.distance_from_start_km,1)} km</div>` +
            `<div class=\"wm-tip-line\"><strong>Tour temperature:</strong> ${fmt(props.temperature_c, 1)} °C</div>` +
            `<div class=\"wm-tip-line\"><strong>Typical range:</strong> ${fmt(props.temp_p25, 1)}–${fmt(props.temp_p75, 1)} °C</div>` +
            `<div class=\"wm-tip-line\"><strong>Rain probability:</strong> ${props.rain_probability!==undefined?Math.round(Number(props.rain_probability)*100):'-'}%</div>` +
            `<div class=\"wm-tip-line\"><strong>Typical rain:</strong> ${fmt(props.rain_typical_mm, 1)} mm</div>` +
            `<div class=\"wm-tip-line\"><strong>Wind:</strong> ${kmh===null?'-':fmt(kmh,1)} km/h (${fmt(props.wind_speed_ms,1)} m/s, Bft ${msToBeaufort(props.wind_speed_ms)}), dir ${degToCardinal(props.wind_dir_deg)} (${fmt(props.wind_dir_deg,0)}°), std ${fmt(props.wind_var_deg,0)}°</div>` +
            `<div class=\"wm-tip-line\"><strong>Dist:</strong> ${fmt(props.min_distance_to_route_km, 1)} km</div>` +
          `</div>`
        );
        const cls = props._wind_warning ? 'tooltip wm-tip wind-warning' : 'tooltip wm-tip';
        m.bindTooltip(tipHtml, { className: cls, direction: 'auto', offset: L.point(40, -20) });
        glyphLayerNew.addLayer(m);
        // Aggregate per-tour-day stats for console diagnostics
        try {
          if (props.tour_day_index !== undefined && props.tour_day_index !== null) {
            const dkey = Number(props.tour_day_index);
            if (!Number.isNaN(dkey)) {
              let ag = TOUR_DAYS_AGGR[dkey];
              if (!ag) { ag = { temps: [], winds: [], precs: [], effs: [] }; TOUR_DAYS_AGGR[dkey] = ag; }
              const tDay = (props.temp_day_median !== undefined && props.temp_day_median !== null) ? Number(props.temp_day_median) : (props.temperature_c !== undefined ? Number(props.temperature_c) : null);
              if (tDay !== null && Number.isFinite(tDay)) ag.temps.push(tDay);
              const wMs = (props.wind_speed_ms !== undefined && props.wind_speed_ms !== null) ? Number(props.wind_speed_ms) : null;
              if (wMs !== null && Number.isFinite(wMs)) ag.winds.push(wMs);
              const pMm = (props.precipitation_mm !== undefined && props.precipitation_mm !== null) ? Number(props.precipitation_mm) : null;
              if (pMm !== null && Number.isFinite(pMm)) ag.precs.push(pMm);
              // Effective wind vs route heading (cosine of TO-wind vs route)
              try {
                const sd = Array.isArray(LAST_PROFILE?.sampled_dist_km) ? LAST_PROFILE.sampled_dist_km : [];
                const sh = Array.isArray(LAST_PROFILE?.sampled_heading_deg) ? LAST_PROFILE.sampled_heading_deg : [];
                if (sd.length && sh.length === sd.length && Array.isArray(ROUTE_CUM_DISTS) && ROUTE_CUM_DISTS.length >= 2) {
                  const dkm = Number(props.distance_from_start_km || 0);
                  const profLen = Number(sd[sd.length - 1] || 0);
                  const routeLen = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
                  const scale2 = (Number.isFinite(routeLen) && Number.isFinite(profLen) && profLen > 0) ? (routeLen / profLen) : 1;
                  let lo=0, hi=sd.length-1;
                  while(lo<hi){ const mid=(lo+hi)>>1; if (sd[mid]*scale2<dkm) lo=mid+1; else hi=mid; }
                  const routeDir = Number(sh[lo]||0);
                  const wdirTo = ((Number(props.wind_dir_deg)||0) + 180.0) % 360.0;
                  const ang = (wdirTo - routeDir) * Math.PI/180.0;
                  const eff = Math.cos(ang);
                  if (Number.isFinite(eff)) ag.effs.push(eff);
                }
              } catch(_) { }
            }
          }
        } catch(_) {}
        // Collect overlay point
        OVERLAY_POINTS.push({
          dist: Number(props.distance_from_start_km || 0),
          id: (props.station_id !== undefined) ? String(props.station_id) : null,
          svg: (props.svg !== undefined) ? String(props.svg) : null,
          // Median used for color and solid line: prefer daytime median
          temperature: (props.temp_day_median !== undefined) ? Number(props.temp_day_median) : ((props.temperature_c !== undefined) ? Number(props.temperature_c) : (props.temp_median || null)),
          precipMm: (props.precipitation_mm !== undefined) ? Number(props.precipitation_mm) : null,
          rainProb: (props.rain_probability !== undefined) ? Number(props.rain_probability) : null,
          rainTypical: (props.rain_typical_mm !== undefined) ? Number(props.rain_typical_mm) : null,
          windSpeed: (props.wind_speed_ms !== undefined) ? Number(props.wind_speed_ms) : null,
          windDir: (props.wind_dir_deg !== undefined) ? Number(props.wind_dir_deg) : null,
          windVar: (props.wind_var_deg !== undefined) ? Number(props.wind_var_deg) : null,
          // Temperature variability percentiles
          // Historical variability across years (daily daytime median percentiles)
          temp_hist_p25: (props.temp_hist_p25 !== undefined) ? Number(props.temp_hist_p25) : ((props.temp_p25 !== undefined) ? Number(props.temp_p25) : null),
          temp_hist_p75: (props.temp_hist_p75 !== undefined) ? Number(props.temp_hist_p75) : ((props.temp_p75 !== undefined) ? Number(props.temp_p75) : null),
          // Daytime variability within 10–16h (across all years)
          temp_day_p25: (props.temp_day_p25 !== undefined) ? Number(props.temp_day_p25) : null,
          temp_day_p75: (props.temp_day_p75 !== undefined) ? Number(props.temp_day_p75) : null,
          temp_day_median: (props.temp_day_median !== undefined) ? Number(props.temp_day_median) : null,
          yearsStart: (props._years_start !== undefined) ? Number(props._years_start) : null,
          yearsEnd: (props._years_end !== undefined) ? Number(props._years_end) : null,
          matchDays: (props._match_days !== undefined && props._match_days !== null) ? (Array.isArray(props._match_days) ? Number(props._match_days.length) : Number(props._match_days)) : null,
          sourceMode: (props._source_mode !== undefined) ? String(props._source_mode) : null,
          tileId: (props._tile_id !== undefined) ? String(props._tile_id) : null
        });
        // Prepare cached glyph image for profile preview pins
        try {
          const sid = (props.station_id !== undefined) ? String(props.station_id) : null;
          const svgStr = (props.svg !== undefined) ? String(props.svg) : null;
          if (sid && svgStr && !PROFILE_GLYPH_CACHE[sid]) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            // Ensure proper SVG container
            const svgWrapped = svgStr.startsWith('<svg') ? svgStr : `<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\">${svgStr}</svg>`;
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgWrapped);
            PROFILE_GLYPH_CACHE[sid] = { img };
            img.onload = () => { try { if (LAST_PROFILE) drawProfile(LAST_PROFILE); } catch(_){} };
          }
        } catch(_){}
        // Redraw full profile (clears canvas) as stations stream in
        if (LAST_PROFILE) drawProfile(LAST_PROFILE);
        const completed = Number(payload.completed || 0);
        const total = Number(payload.total || 0);
        const pct = total > 0 ? Math.min(100, Math.round(100 * completed / total)) : 0;
        if (progressBar) progressBar.style.width = `${pct}%`;
        stationCount = completed;
        stationTotal = total;
        const spanTxt = YEARS_SPAN_TEXT ? `historical Open-Meteo weather data ${YEARS_SPAN_TEXT}` : 'historical Open-Meteo weather data';
        if (sseStatus) sseStatus.textContent = `Loading station ${stationCount}/${stationTotal} from ${spanTxt}`;
      } catch (e) { console.error('station event error', e); }
    });
  // Click to open file dialog
  const gpxInput = document.getElementById('gpxFileInput');
  if (dropZone && gpxInput) {
    dropZone.addEventListener('click', () => { gpxInput.click(); });
    gpxInput.addEventListener('change', async (e) => {
      const f = gpxInput.files && gpxInput.files[0];
      if (!f) return;
      if (!f.name.toLowerCase().endsWith('.gpx')) { alert('Please choose a .gpx file'); return; }
      const fd = new FormData();
      fd.append('file', f);
      try {
        const res = await fetch('/api/upload_gpx', { method: 'POST', body: fd });
        const j = await res.json();
        if (j && j.path) {
          LAST_GPX_PATH = j.path;
          updateDropZoneLabel();
          try { window.__WM_PROFILE_PRIME_DONE__ = false; } catch(_){}
          loadMap();
        } else {
          alert('Upload failed: ' + (j.error || 'unknown error'));
        }
      } catch (err) {
        console.error('Upload error', err);
        alert('Upload error: ' + err);
      }
    });
  }

    evtSource.addEventListener('done', (e) => {
      try { evtSource && evtSource.close(); } catch (_) {}
      MAIN_IN_PROGRESS = false;
      // Remove old layer and replace
      if (glyphLayer) { map.removeLayer(glyphLayer); }
      glyphLayer = glyphLayerNew;
      glyphLayerNew = null;
      // Brighten all glyphs after recalculation done
      try { glyphLayer && glyphLayer.eachLayer(brightenMarkerSVG); } catch (_) {}
      // Standardize steady-state glyph size and saturation regardless of prior CSS/classes
      try {
        glyphLayer && glyphLayer.eachLayer(l => {
          try {
            // Only update markers
            if (!l || !l._icon) return;
            const el = l._icon;
            const inner = el.querySelector && (el.querySelector('.glyph-inner') || el.querySelector('.glyph'));
            const svgHtml = inner ? inner.innerHTML : '';
            if (!svgHtml) return;
            const sizedSvg = resizeGlyphSVG(svgHtml, 51);
            const html = `<div class="glyph-inner" style="width:51px;height:51px;filter:saturate(0.70);opacity:0.92;overflow:hidden">${sizedSvg}</div>`;
            const icon = L.divIcon({ html, className: 'glyph-map', iconSize: [51, 51], iconAnchor: [26, 26] });
            if (l.setIcon) l.setIcon(icon);
          } catch(_) {}
        });
      } catch(_) {}
      setTimeout(() => { if (progressBar) progressBar.style.width = '0%'; }, 600);
      if (sseStatus) {
        let backendTxt = null;
        try {
          const payload = (e && e.data) ? JSON.parse(e.data) : null;
          backendTxt = payload && payload.station_source_text ? String(payload.station_source_text) : null;
        } catch (_) {
          backendTxt = null;
        }
        const spanTxt = YEARS_SPAN_TEXT ? ` from historical Open-Meteo weather data ${YEARS_SPAN_TEXT}` : '';
        const suffix = backendTxt ? ` ${backendTxt}` : spanTxt;
        sseStatus.textContent = `Stream: done, stations ${stationCount}/${stationTotal}${suffix}`;
      }
      // Restore button state
      if (fetchWeatherBtn) {
        fetchWeatherBtn.textContent = 'Get Weather Data';
        fetchWeatherBtn.disabled = false;
      }
      if (stopWeatherBtn) stopWeatherBtn.style.display = 'none';
      // Reset priming flag for next loads
      window.__WM_PROFILE_PRIME_DONE__ = false;
      // Apply any deferred Days change now
      try {
        if (PENDING_TOUR_DAYS !== null) {
          const v = Number(PENDING_TOUR_DAYS);
          PENDING_TOUR_DAYS = null;
          if (tourDaysInput) tourDaysInput.value = String(v);
          loadMap();
        }
      } catch (_) {}
    });

    // Auto-reconnect with simple backoff
    let retryMs = 1000;
    evtSource.onerror = (e) => {
      try { evtSource && evtSource.close(); } catch (_) {}
      // Allow retry to actually start a new stream
      MAIN_IN_PROGRESS = false;
      if (progressBar) progressBar.style.width = '0%';
      if (sseStatus) sseStatus.textContent = `Stream: error, reconnecting in ${Math.round(retryMs/1000)}s…`;
      console.error('SSE error', e);
      setTimeout(() => {
        retryMs = Math.min(retryMs * 2, 10000);
        loadMap(LAST_LOAD_OPTS || undefined);
      }, retryMs);
    };

    // EventSource opens automatically; no additional fetch needed.

    // Lightweight profile refresh on zoom changes (dry-run stream)
    let evtSourceProfile = null;
    map.on('zoomend', () => {
      // Skip dry-run refresh while a prime or main stream is active
      if (PRIME_IN_PROGRESS || MAIN_IN_PROGRESS) return;
      try { evtSourceProfile && evtSourceProfile.close(); } catch(_){ }
      const z = map.getZoom();
      const profileStep = (function(zoom){
        if (zoom >= 13) return 2;
        if (zoom >= 12) return 3;
        if (zoom >= 11) return 4;
        if (zoom >= 10) return 5;
        if (zoom >= 9) return 6;
        if (zoom >= 8) return 8;
        if (zoom >= 7) return 10;
        return 15;
      })(z);
      const selected = startDateInput.value ? new Date(startDateInput.value) : new Date();
      const mmdd = getMMDD(selected);
      const isTourMode = (document.body && document.body.dataset && document.body.dataset.mode)
        ? (document.body.dataset.mode === 'tour')
        : true;
      const tourPlanningParam = isTourMode ? '1' : '0';
      const tourDays = Number(tourDaysInput?.value || 7);
      const startDateStr = startDateInput && startDateInput.value ? startDateInput.value : new Date().toISOString().slice(0,10);
      const gpxParam = LAST_GPX_PATH ? `&gpx_path=${encodeURIComponent(LAST_GPX_PATH)}` : '';
      const revParam = REVERSED ? '&reverse=1' : '';

      const histLast = Number(SETTINGS.histLastYear);
      const histN = Math.max(1, Math.round(Number(SETTINGS.histYears) || 10));
      const histEnd = (Number.isFinite(histLast) && histLast >= 1970) ? Math.round(histLast) : ((new Date()).getFullYear() - 1);
      const histStart = histEnd - histN + 1;

      const url = `/api/map_stream?date=${mmdd}&step_km=${STEP_KM}&profile_step_km=${profileStep}&tour_planning=${tourPlanningParam}&mode=single_day&dry_run=1&total_days=${tourDays}&start_date=${encodeURIComponent(startDateStr)}&hist_years=${histN}&hist_start=${histStart}${gpxParam}${revParam}`;
      evtSourceProfile = new EventSource(url);
      evtSourceProfile.addEventListener('profile', (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          if (payload && payload.profile) {
            drawProfile(payload.profile);
          }
        } catch (e) { console.error('profile zoom refresh error', e); }
      });
      evtSourceProfile.addEventListener('done', () => {
        try { evtSourceProfile && evtSourceProfile.close(); } catch(_){ }
      });
      evtSourceProfile.onerror = () => {
        try { evtSourceProfile && evtSourceProfile.close(); } catch(_){ }
      };
    });
  }

  fetchWeatherBtn.addEventListener('click', () => {
    if (PRIME_IN_PROGRESS || MAIN_IN_PROGRESS) return; // Stop button handles abort now
    OFFLINE_FALLBACK_ACTIVE = false;
    loadMap();
  });
  
  stopWeatherBtn.addEventListener('click', () => {
    const wasInProgress = PRIME_IN_PROGRESS || MAIN_IN_PROGRESS;
    const wasFallback = OFFLINE_FALLBACK_ACTIVE;
    // Abort current download
    try { 
      if (evtSource) evtSource.close();
      if (window.__WM_PRIME_EVT_SOURCE__) window.__WM_PRIME_EVT_SOURCE__.close();
    } catch(_) {}
    PRIME_IN_PROGRESS = false;
    MAIN_IN_PROGRESS = false;

    // If the user stopped a long download, immediately try a fast offline-only fallback
    // using the local 1-year tile DB (last year = currentYear-1).
    if (wasInProgress && !wasFallback) {
      OFFLINE_FALLBACK_ACTIVE = true;
      try { window.__WM_PROFILE_PRIME_DONE__ = false; } catch(_){ }
      if (sseStatus) sseStatus.textContent = 'Stream: switching to offline fallback…';
      const nowYear = (new Date()).getFullYear();
      loadMap({ offlineOnly: true, histYearsOverride: 1, histLastYearOverride: (nowYear - 1) });
      return;
    }

    fetchWeatherBtn.textContent = 'Get Weather Data';
    fetchWeatherBtn.disabled = false;
    if (stopWeatherBtn) stopWeatherBtn.style.display = 'none';
    if (sseStatus) sseStatus.textContent = 'Stream: stopped';
    if (progressEl) progressEl.classList.remove('loading');
  });
  
  // Parameter changes: mark data as stale but don't auto-refresh
  function markDataStale() {
    if (PRIME_IN_PROGRESS || MAIN_IN_PROGRESS) {
      // Abort if currently downloading
      try { 
        if (evtSource) evtSource.close();
        if (window.__WM_PRIME_EVT_SOURCE__) window.__WM_PRIME_EVT_SOURCE__.close();
      } catch(_) {}
      PRIME_IN_PROGRESS = false;
      MAIN_IN_PROGRESS = false;
      if (progressEl) progressEl.classList.remove('loading');
    }
    fetchWeatherBtn.textContent = 'Get Weather Data';
    fetchWeatherBtn.disabled = false;
    if (stopWeatherBtn) stopWeatherBtn.style.display = 'none';
    if (sseStatus) sseStatus.textContent = 'Parameters changed - click "Get Weather Data"';
  }
  
  startDateInput.addEventListener('change', markDataStale);
  tourDaysInput.addEventListener('change', markDataStale);

  // Tour Summary: badges panel rendering
  function renderTourSummary(summary) {
    try {
      const panel = document.getElementById('tourSummary');
      if (!panel) return;
      const badgesRow = document.getElementById('tourSummaryBadges');
      if (!badgesRow) return;
      const badgesWrap = document.getElementById('tourSummaryBadgesItems') || badgesRow;
      badgesWrap.innerHTML = '';
      const fmt = (v, d=1) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : '-';
      const total = Number(summary.total_days || 0);
      const headPct = total > 0 ? Math.round(100 * Number(summary.headwind_days||0) / total) : 0;
      const items = [
        { icon: '🌧', text: `Expect ${Number(summary.rain_days||0)} Rain days`, label: 'Rain days' },
        { icon: '🌬', text: `${headPct}% Headwind`, label: 'Wind' },
        { icon: '🌡', text: `${fmt(summary.median_temperature,0)}°C Median Temperature`, label: 'Temperature' },
        { icon: '⭐', text: `Expect ${Number(summary.comfort_days||0)} Comfort days`, label: 'Comfort' },
        (typeof summary.sunny_days === 'number') ? { icon: '☀️', text: `Expect ${Number(summary.sunny_days||0)} Sunny days`, label: 'Sun' } : null,
        (typeof summary.sun_hours_total === 'number') ? { icon: '⏱', text: `${Number(summary.sun_hours_total||0)} h Sun`, label: 'Sun hours' } : null,
      ].filter(Boolean);
      const tooltipEl = document.getElementById('tourSummaryTooltip');
      items.forEach(it => {
        const badge = document.createElement('div');
        badge.style.display = 'flex';
        badge.style.alignItems = 'center';
        badge.style.gap = '6px';
        badge.style.background = 'rgba(0,0,0,0.04)';
        badge.style.border = '1px solid #ddd';
        badge.style.borderRadius = '14px';
        badge.style.padding = '6px 10px';
        badge.style.whiteSpace = 'nowrap';
        badge.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        badge.style.fontSize = '13px';
        const icon = document.createElement('span'); icon.textContent = it.icon;
        const txt = document.createElement('span'); txt.textContent = it.text;
        let tip = '';
        const cold = Number(SETTINGS.tempCold||5);
        const hot = Number(SETTINGS.tempHot||30);
        const rainHigh = Number(SETTINGS.rainHigh||10);
        if (it.label === 'Rain days') tip = 'Rain prob ≥ 60% or typical rain ≥ 3 mm';
        else if (it.label === 'Wind') tip = 'Share of tour days with effective headwind (cos(to-wind vs route) < −0.33).';
        else if (it.label === 'Temperature') tip = 'Median daytime temperature (10–16h) across matched stations.';
        else if (it.label === 'Comfort') {
          const wHead = Number(SETTINGS.windHeadComfort||4);
          const wTail = Number(SETTINGS.windTailComfort||10);
          tip = `Comfort: temp ${cold}..${hot}°C, rain < ${rainHigh} mm/day, wind: head < ${wHead} m/s, tail < ${wTail} m/s.`;
        }
        else if (it.label === 'Sun') tip = 'Estimated sunny days';
        else if (it.label === 'Sun hours') tip = 'Total estimated sun hours';
        if (tip && tooltipEl) {
          badge.addEventListener('mouseenter', () => {
            try {
              tooltipEl.textContent = tip;
              tooltipEl.style.display = 'block';
              // Measure tooltip width after showing to compute clamped center
              const w = tooltipEl.offsetWidth || 240;
              const r = badge.getBoundingClientRect();
              const panelRect = panel.getBoundingClientRect();
              const badgeCenter = r.left - panelRect.left + (r.width/2);
              const pad = 12;
              const minCenter = (w/2) + pad;
              const maxCenter = panelRect.width - (w/2) - pad;
              const center = Math.max(minCenter, Math.min(maxCenter, badgeCenter));
              tooltipEl.style.left = `${center}px`;
              tooltipEl.style.top = `0px`;
              tooltipEl.style.transform = 'translateY(-105%)';
              tooltipEl.style.bottom = '';
            } catch (_) {}
          });
          badge.addEventListener('mouseleave', () => { tooltipEl.style.display = 'none'; });
        }
        badge.appendChild(icon); badge.appendChild(txt);
        badgesWrap.appendChild(badge);
      });
      // No description row; info moved into tooltips.
      
      // Recalculate layout after badges render (they may wrap to multiple lines)
      // Keep profile height constant, adjust map height to accommodate tour summary
      // Double rAF ensures DOM has fully reflowed before measurement
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            const tsdb = document.getElementById('tourSummary');
            const tsdbH = tsdb ? tsdb.offsetHeight : 64;
            const currentProfileH = profilePanel ? profilePanel.offsetHeight : 160;
            if (mapEl) {
              mapEl.style.height = `calc(100% - ${currentProfileH + tsdbH}px)`;
              const rect = mapEl.getBoundingClientRect();
              if (!rect.height || rect.height < 200) {
                mapEl.style.height = `${Math.max(220, window.innerHeight - (currentProfileH + tsdbH))}px`;
              }
              if (map && map.invalidateSize) map.invalidateSize(true);
            }
          } catch (_) {}
        });
      });
    } catch (e) { console.warn('renderTourSummary error', e); }
  }


  // Redraw profile on resize
  window.addEventListener('resize', () => { if (LAST_PROFILE) drawProfile(LAST_PROFILE); });

  (function initResizeDrag(){
    if (!resizeHandle) return;
    let dragging = false;
    function onMove(e) {
      if (!dragging) return;
      const y = (e.touches && e.touches.length) ? e.touches[0].clientY : e.clientY;
      const newH = Math.round(window.innerHeight - y);
      setProfileHeight(newH);
      e.preventDefault();
    }
    function onUp() {
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove, { passive: false });
      window.removeEventListener('touchend', onUp);
    }
    resizeHandle.addEventListener('mousedown', (e) => {
      dragging = true;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    resizeHandle.addEventListener('touchstart', (e) => {
      dragging = true;
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
    }, { passive: false });
  })();

  // UI wiring
  // Overlay mode control
  if (overlaySelect) {
    overlaySelect.addEventListener('change', () => {
      OVERLAY_MODE = overlaySelect.value;
      if (LAST_PROFILE) drawProfile(LAST_PROFILE);
    });
  }

  if (settingsCancel) {
    settingsCancel.addEventListener('click', () => {
      try { applySettingsToForm(SETTINGS); } catch (_) {}
      const m = (LAST_NON_SETTINGS_MODE || 'tour');
      try {
        if (window.WM && typeof window.WM.setMode === 'function') window.WM.setMode(m);
        else setMode(m);
      } catch (_) {
        try { setMode(m); } catch (_) {}
      }
    });
  }

  if (settingsSave) {
    settingsSave.addEventListener('click', () => {
      SETTINGS = readSettingsFromForm(SETTINGS);
      saveSettings(SETTINGS);
      STEP_KM = SETTINGS.stepKm;
      const m = (LAST_NON_SETTINGS_MODE || 'tour');
      try {
        if (window.WM && typeof window.WM.setMode === 'function') window.WM.setMode(m);
        else setMode(m);
      } catch (_) {
        try { setMode(m); } catch (_) {}
      }
      loadMap();
    });
  }
  // Share snapshot: capture full window and share/copy/download
  (function initShare(){
    if (!shareBtn) return;
    async function captureAndShare(){
      try {
        // Stabilize layout & Leaflet transforms before capturing.
        await new Promise(r => setTimeout(r, 30));
        try { map.invalidateSize(); } catch (_) {}
        await new Promise(r => requestAnimationFrame(() => r()));
        await new Promise(r => requestAnimationFrame(() => r()));
        const target = document.documentElement;
        const vw = Math.max(1, Number(window.innerWidth || document.documentElement.clientWidth || 1));
        const vh = Math.max(1, Number(window.innerHeight || document.documentElement.clientHeight || 1));
        const dpr = Math.max(1, Number(window.devicePixelRatio || 1));
        // html2canvas options tuned for full-viewport, full-resolution output.
        const canvas = await window.html2canvas(target, {
          backgroundColor: '#ffffff',
          scale: Math.min(2, dpr),
          useCORS: true,
          allowTaint: true,
          logging: false,
          scrollX: 0,
          scrollY: 0,
          x: 0,
          y: 0,
          width: vw,
          height: vh,
          windowWidth: vw,
          windowHeight: vh
        });
        const blob = await new Promise(res => canvas.toBlob(b => res(b), 'image/png', 0.92));
        if (!blob) throw new Error('Snapshot failed');
        // Prefer Clipboard copy (fastest way to reuse)
        let shared = false;
        if (navigator.clipboard && window.ClipboardItem) {
          try {
            await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
            shared = true;
            if (sseStatus) sseStatus.textContent = 'Snapshot copied to clipboard';
          } catch(_) {}
        }
        // Try Web Share API with file if available
        try {
          const file = new File([blob], 'WeatherMap.png', { type: 'image/png' });
          if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
            await navigator.share({ files: [file], title: 'WeatherMap snapshot' });
            shared = true;
            if (sseStatus) sseStatus.textContent = 'Snapshot shared';
          }
        } catch(_) {}
        // Fallback: trigger download
        if (!shared) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'WeatherMap.png';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          if (sseStatus) sseStatus.textContent = 'Snapshot downloaded';
        }
      } catch (e) {
        console.error('Share snapshot error', e);
        alert('Snapshot failed: ' + e);
      }
    }
    shareBtn.addEventListener('click', captureAndShare);
  })();
  // Restore session on page load
  (async function initFromSession(){
    try {
      const res = await fetch('/api/session');
      const st = await res.json();
      if (st && typeof st === 'object') {
        // Populate UI fields and internal state
        if (st.start_date) startDateInput.value = st.start_date;
        if (typeof st.tour_days === 'number') tourDaysInput.value = st.tour_days;
        if (typeof st.glyph_spacing_km === 'number') {
          SETTINGS.stepKm = Number(st.glyph_spacing_km);
          STEP_KM = SETTINGS.stepKm;
        }
        if (typeof st.num_years === 'number') SETTINGS.histYears = Number(st.num_years);
        if (typeof st.first_year === 'number') {
          const fy = Number(st.first_year);
          const ny = Number(SETTINGS.histYears);
          SETTINGS.histLastYear = Math.round(fy + (Number.isFinite(ny) ? ny : 10) - 1);
        }
        // Sync settings modal inputs silently
        setStepKm.value = SETTINGS.stepKm;
        if (setHistLast) setHistLast.value = SETTINGS.histLastYear;
        setHistYears.value = SETTINGS.histYears;
        // GPX path and reverse flag
        if (st.last_gpx_path) LAST_GPX_PATH = st.last_gpx_path;
        if (st.gpx_exists === false) {
          // Clear stale path to avoid sending invalid override
          LAST_GPX_PATH = null;
        }
        updateDropZoneLabel();
        if (typeof st.reverse === 'boolean') REVERSED = st.reverse;
        // Sync reverse checkbox state
        try {
          const rc = document.getElementById('reverse');
          if (rc) rc.checked = !!REVERSED;
        } catch(_) {}
        // Optional warning if GPX missing
        if (st.last_gpx_path && st.gpx_exists === false) {
          console.warn('Last GPX not found, continuing without route:', st.last_gpx_path);
        }
      }
    } catch (e) {
      console.warn('Session restore failed; using defaults', e);
    }
    updateDropZoneLabel();
    loadMap();
  })();

  // Console helper: summarize comfort-day criteria per tour day
  window.debugComfortDays = function() {
    try {
      const cold = 15.0; // backend threshold
      const hot = 25.0;  // backend threshold
      const windHead = Number(SETTINGS.windHeadComfort||4);
      const windTail = Number(SETTINGS.windTailComfort||10);
      const rainThresh = 1.0; // mm total per day
      const keys = Object.keys(TOUR_DAYS_AGGR).map(k => Number(k)).sort((a,b)=>a-b);
      const rows = [];
      const med = arr => {
        const a = (arr||[]).filter(x => Number.isFinite(x)).sort((x,y)=>x-y);
        if (!a.length) return NaN;
        const m = Math.floor(a.length/2);
        return (a.length%2) ? a[m] : ((a[m-1]+a[m])/2);
      };
      const mean = arr => {
        const a = (arr||[]).filter(x => Number.isFinite(x));
        if (!a.length) return NaN;
        return a.reduce((s,v)=>s+v,0)/a.length;
      };
      keys.forEach(dkey => {
        const ag = TOUR_DAYS_AGGR[dkey] || { temps:[], winds:[], precs:[], effs:[] };
        const t_med = med(ag.temps);
        const w_mean = mean(ag.winds);
        const p_sum = (ag.precs||[]).filter(x=>Number.isFinite(x)).reduce((s,v)=>s+v,0);
        const e_mean = mean(ag.effs);
        const passTemp = Number.isFinite(t_med) && t_med >= cold && t_med <= hot;
          const passWind = (Number.isFinite(w_mean) && Number.isFinite(e_mean))
            ? (e_mean > 0.33 ? (w_mean < windTail) : (e_mean < -0.33 ? (w_mean < windHead) : (w_mean < windHead)))
            : (Number.isFinite(w_mean) ? (w_mean < windHead) : false);
        const passRain = Number.isFinite(p_sum) && p_sum < rainThresh;
        const isComfort = !!(passTemp && passWind && passRain);
        const reasons = [];
        if (!passTemp) reasons.push(`Temp ${Number.isFinite(t_med)?t_med.toFixed(1):'-'}°C outside ${cold}..${hot}°C`);
          if (!passWind) {
            const lim = (Number.isFinite(e_mean) && e_mean > 0.33) ? windTail : windHead;
            reasons.push(`Wind ${Number.isFinite(w_mean)?w_mean.toFixed(1):'-'} m/s ≥ ${lim} m/s (${e_mean>0.33?'tail':'head/cross'})`);
          }
        if (!passRain) reasons.push(`Rain ${Number.isFinite(p_sum)?p_sum.toFixed(1):'-'} mm ≥ ${rainThresh} mm/day`);
        rows.push({
          day: dkey+1,
          temp_median_c: Number.isFinite(t_med)?t_med.toFixed(1):'-',
          wind_mean_ms: Number.isFinite(w_mean)?w_mean.toFixed(1):'-',
          wind_mean_kmh: Number.isFinite(w_mean)?(w_mean*3.6).toFixed(1):'-',
          rain_sum_mm: Number.isFinite(p_sum)?p_sum.toFixed(1):'-',
          eff_mean: Number.isFinite(e_mean)?e_mean.toFixed(2):'-',
          comfort: isComfort ? 'YES' : 'NO',
          reasons: reasons.join('; ')
        });
      });
      console.table(rows);
      if (rows.some(r => r.comfort === 'NO')) {
        console.log('Comfort criteria (backend): temp 15..25°C, mean wind < 4 m/s, total rain < 1 mm/day');
      }
      return rows;
    } catch (e) {
      console.warn('debugComfortDays error', e);
    }
  };
})();
