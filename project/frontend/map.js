/* global L */
(function() {
  // Prefer canvas renderer so snapshotting (html2canvas) captures route layers without SVG transform drift.
  const map = L.map('map', { preferCanvas: true });
  try { window.__WM_LEAFLET_MAP__ = map; } catch (_) {}
  // Base maps
  const _osmTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  });
  // Neutral basemap (light grey styling, suited for meteorological overlays)
  const _neutralTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  });
  let _activeBaseLayer = _osmTiles;
  _activeBaseLayer.addTo(map);

  function fmt(num, digits = 1) {
    return (num === null || num === undefined) ? '-' : Number(num).toFixed(digits);
  }

  function _getAppMode() {
    try {
      const m = document.body && document.body.dataset ? String(document.body.dataset.mode || '') : '';
      return (m === 'climate' || m === 'tour' || m === 'settings') ? m : 'tour';
    } catch (_) {
      return 'tour';
    }
  }

  function _applyComfortWindUiForMode() {
    try {
      const mode = _getAppMode();
      const labHead = document.querySelector('label[for="setWindHeadComfort"]');
      if (labHead) {
        labHead.textContent = (mode === 'climate') ? 'Comfort max wind (m/s)' : 'Comfort max headwind (m/s)';
      }
    } catch (_) {}
  }

  try {
    // React to mode switches (navigation is wired externally in index.html).
    const obs = new MutationObserver(() => { _applyComfortWindUiForMode(); });
    if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ['data-mode'] });
    setTimeout(() => { _applyComfortWindUiForMode(); }, 0);
  } catch (_) {}

  // -------------------- Strategic legend helpers --------------------
  let STRATEGIC_LEGEND_HOST = null;

  function _populateYearOptionsFromPrefs(sel) {
    if (!sel) return;
    sel.innerHTML = '';
    try {
      if (setStrategicYear && setStrategicYear.options && setStrategicYear.options.length) {
        for (const opt of Array.from(setStrategicYear.options)) {
          const o = document.createElement('option');
          o.value = String(opt.value);
          o.textContent = String(opt.textContent || opt.value);
          sel.appendChild(o);
        }
        return;
      }
    } catch (_) {}
    // Fallback: show a small recent range
    let y1 = 2025;
    try { y1 = Math.max(1970, Math.min(2100, (new Date()).getFullYear())); } catch (_) {}
    for (let y = y1; y >= Math.max(1970, y1 - 6); y--) {
      const o = document.createElement('option');
      o.value = String(y);
      o.textContent = String(y);
      sel.appendChild(o);
    }
  }

  function _populateLayerOptions(sel) {
    if (!sel) return;
    sel.innerHTML = '';
    try {
      if (strategicLayerSelect && strategicLayerSelect.options && strategicLayerSelect.options.length) {
        for (const opt of Array.from(strategicLayerSelect.options)) {
          const o = document.createElement('option');
          o.value = String(opt.value);
          o.textContent = String(opt.textContent || opt.value);
          sel.appendChild(o);
        }
        return;
      }
    } catch (_) {}
    // Fallback
    const defs = [
      { v: 'temperature_ride', t: 'Temperature (Ride)' },
      { v: 'rain_ride', t: 'Rain (Ride)' },
      { v: 'wind_dir', t: 'Wind' },
      { v: 'comfort_ride', t: 'Ride Comfort' },
    ];
    for (const d of defs) {
      const o = document.createElement('option');
      o.value = d.v;
      o.textContent = d.t;
      sel.appendChild(o);
    }
  }

  // Note: a prior iteration used a Leaflet control in the bottom-right for
  // layer/year/timescale selectors. Those controls now live in the in-map
  // legend (lower-left), so we intentionally do not mount any extra box.

  function _strategicWantsStandardBasemap() {
    const layer = STRATEGIC_STATE ? String(STRATEGIC_STATE.layer || '') : '';
    return (layer === 'rain_ride' || layer === 'rain' || layer === 'precipitation' || layer === 'wind_dir' || layer === 'wind_speed');
  }

  function _applyStrategicBasemap() {
    try {
      const m = _getAppMode();
      // Tour planning always uses standard OSM.
      const wantOSM = (m !== 'climate') ? true : _strategicWantsStandardBasemap();
      try { document.body.dataset.wmBasemap = wantOSM ? 'osm' : 'neutral'; } catch (_) {}
      const next = wantOSM ? _osmTiles : _neutralTiles;
      if (_activeBaseLayer !== next) {
        try { map.removeLayer(_activeBaseLayer); } catch (_) {}
        _activeBaseLayer = next;
        try { _activeBaseLayer.addTo(map); } catch (_) {}
      }
    } catch (_) {}
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
  const weatherQualitySelect = document.getElementById('weatherQuality');

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
  const setWeatherVisualizationMode = document.getElementById('setWeatherVisualizationMode');
  const setStrategicYear = document.getElementById('setStrategicYear');
  const setIncludeSea = document.getElementById('setIncludeSea');
  const setInterpolation = document.getElementById('setInterpolation');
  const setWindDensity = document.getElementById('setWindDensity');
  const setAnimSpeed = document.getElementById('setAnimSpeed');
  const setGridKm = document.getElementById('setGridKm');
  const setRideHours = document.getElementById('setRideHours');
  const setTentHours = document.getElementById('setTentHours');
  const setWindWeighting = document.getElementById('setWindWeighting');
  const setOverlayMode = document.getElementById('setOverlayMode');

  const strategicDayLabel = document.getElementById('strategicDayLabel');
  const strategicTimelineLabel = document.getElementById('strategicTimelineLabel');
  const strategicDaySlider = document.getElementById('strategicDaySlider');
  const strategicStepBackBtn = document.getElementById('strategicStepBack');
  const strategicPlayBtn = document.getElementById('strategicPlay');
  const strategicStepForwardBtn = document.getElementById('strategicStepForward');
  const strategicSpeed = document.getElementById('strategicSpeed'); // legacy (removed from UI)
  const strategicMonthTicks = document.getElementById('strategicMonthTicks');
  const strategicTimeline = document.getElementById('strategicTimeline');
  const strategicLayerSelect = document.getElementById('strategicLayer');
  const strategicTimescaleSelect = document.getElementById('strategicTimescale');
  const strategicQuickLayerSelect = document.getElementById('strategicQuickLayerSelect');
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
  const tourSummaryBadges = document.getElementById('tourSummaryBadges');
  const profileLegendHost = document.getElementById('profileLegendHost');
  const mapEl = document.getElementById('map');
  const overlayContainer = document.getElementById('overlayContainer');
  const resizeHandle = document.getElementById('profileResizeHandle');
  let LAST_PROFILE = null;

  function _updateStrategicTimelineCssVar() {
    try {
      const h = strategicTimeline ? Number(strategicTimeline.offsetHeight || 0) : 0;
      document.documentElement.style.setProperty('--wm-strategic-timeline-h', `${Math.max(0, Math.round(h))}px`);
    } catch (_) {}
  }

  // Compute initial bottom UI height (0 unless Climate mode is active).
  try { setTimeout(() => { _updateStrategicTimelineCssVar(); }, 0); } catch (_) {}

  // Profile panel overlay selector (Temperature / Rain / Wind)
  let profileOverlaySelect = null;
  try {
    const host = tourSummaryBadges || profilePanel;
    if (host) {
      const sel = document.createElement('select');
      sel.id = 'overlayMode';
      // Mounted in Tour Summary band (preferred) or in profile panel as fallback.
      sel.style.cssText = tourSummaryBadges
        ? 'align-self:center; position:relative; background:rgba(255,255,255,0.95); border:1px solid #cfcfcf; border-radius:10px; padding:7px 12px; font-family:system-ui,-apple-system,sans-serif; font-size:13px; cursor:pointer; pointer-events:auto; box-shadow:0 2px 4px rgba(0,0,0,0.08);'
        : 'position:absolute; top:8px; right:22px; background:rgba(255,255,255,0.95); border:1px solid #cfcfcf; border-radius:10px; padding:7px 12px; font-family:system-ui,-apple-system,sans-serif; font-size:13px; z-index:1000; box-shadow:0 2px 4px rgba(0,0,0,0.08); cursor:pointer; pointer-events:auto;';
      sel.innerHTML = '<option value="temperature">Temperature</option><option value="precipitation">Rain</option><option value="wind">Wind</option>';
      // In the Tour Summary band, keep selector on the right (before Profile legend).
      if (tourSummaryBadges) {
        try { sel.style.marginLeft = '8px'; } catch (_) {}
        try {
          const legendHost = document.getElementById('profileLegendHost');
          if (legendHost && legendHost.parentElement === tourSummaryBadges) {
            tourSummaryBadges.insertBefore(sel, legendHost);
          } else {
            tourSummaryBadges.appendChild(sel);
          }
        } catch (_) {
          tourSummaryBadges.appendChild(sel);
        }
      } else {
        profilePanel.appendChild(sel);
      }
      profileOverlaySelect = sel;
    }
  } catch (_) {}
  
  // Profile overlay mode (controlled via Preferences, mirrored in profile panel)
  let OVERLAY_MODE = (setOverlayMode && setOverlayMode.value) ? setOverlayMode.value : 'temperature';

  function _updateProfileLegend() {
    try {
      if (!profileLegendHost) return;
      const m = (OVERLAY_MODE === 'precipitation' || OVERLAY_MODE === 'wind' || OVERLAY_MODE === 'temperature') ? OVERLAY_MODE : 'temperature';
      profileLegendHost.style.display = 'block';
      if (m === 'temperature') {
        profileLegendHost.innerHTML = `
          <div class="title">Temperature</div>
          <div class="bar" style="background: linear-gradient(90deg,#963cbe 0%,#005bff 17%,#28a050 58%,#f0dc50 75%,#f59b3c 83%,#d73c2d 92%,#8b0000 100%);"></div>
          <div class="ticks"><span>-10</span><span>0</span><span>20</span><span>40 °C</span></div>
          <div class="note">Solid line: median temperature. Dashed lines: typical daytime p25/p75. Shaded band: historical p25–p75 across years.</div>
        `;
      } else if (m === 'precipitation') {
        profileLegendHost.innerHTML = `
          <div class="title">Rain</div>
          <div class="bar" style="background: linear-gradient(90deg, rgba(30,112,200,0.10) 0%, rgba(30,112,200,0.92) 100%);"></div>
          <div class="ticks"><span>0</span><span>5</span><span>10</span><span>20 mm</span></div>
          <div class="note">Bars: typical rain (mm). Light band: typical × probability (expected mm).</div>
        `;
      } else {
        profileLegendHost.innerHTML = `
          <div class="title">Wind (effective)</div>
          <div class="bar steps">
            <div class="seg" style="background: rgba(220,80,60,0.82);"></div>
            <div class="seg" style="background: rgba(160,160,160,0.55);"></div>
            <div class="seg" style="background: rgba(60,180,90,0.80);"></div>
          </div>
          <div class="ticks"><span>-8</span><span>0</span><span>+8 m/s</span></div>
          <div class="note">Line: effective wind along the route (green tailwind, red headwind). Grey shadow band: tolerance from wind direction variability.</div>
        `;
      }
    } catch (_) {}
  }

  function _setOverlayMode(mode, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const m = (mode === 'temperature' || mode === 'precipitation' || mode === 'wind') ? mode : 'temperature';
    OVERLAY_MODE = m;
    try { SETTINGS.overlayMode = m; } catch (_) {}
    if (!options.skipPersist) {
      try { saveSettings(SETTINGS); } catch (_) {}
    }
    try { if (setOverlayMode) setOverlayMode.value = m; } catch (_) {}
    try { if (profileOverlaySelect) profileOverlaySelect.value = m; } catch (_) {}
    try { if (LAST_PROFILE) drawProfile(LAST_PROFILE); } catch (_) {}
    try { _updateProfileLegend(); } catch (_) {}
  }

  // Move Share into the map's top-left controls (next to Leaflet zoom).
  (function mountShareToMapTopLeft(){
    try {
      if (!shareBtn) return;
      const ctrl = L.control({ position: 'topleft' });
      ctrl.onAdd = () => {
        const wrap = L.DomUtil.create('div', 'leaflet-bar wm-share-control');
        // Place it horizontally next to the built-in zoom control.
        // Zoom control is offset by Leaflet margins (typically 10px top/left).
        wrap.style.position = 'absolute';
        wrap.style.left = '46px';
        wrap.style.top = '10px';
        wrap.style.margin = '0';
        shareBtn.style.display = 'block';
        wrap.appendChild(shareBtn);
        try { L.DomEvent.disableClickPropagation(wrap); } catch (_) {}
        try { L.DomEvent.disableScrollPropagation(wrap); } catch (_) {}
        return wrap;
      };
      ctrl.addTo(map);
    } catch (_) {}
  })();
  let OVERLAY_POINTS = [];
  let TOUR_DAYS_AGGR = {};
  let evtSource = null;
  let PRIME_IN_PROGRESS = false;
  let MAIN_IN_PROGRESS = false;
  let LAST_GPX_PATH = null;
  let LAST_GPX_NAME = null;
  let LAST_LOAD_OPTS = null;
  let OFFLINE_FALLBACK_ACTIVE = false;

  function getWeatherQualityMode() {
    try {
      const v = weatherQualitySelect ? String(weatherQualitySelect.value || '') : '';
      return (v === 'best') ? 'best' : 'fast';
    } catch (_) {
      return 'fast';
    }
  }

  function updateFetchWeatherLabel() {
    try {
      if (!fetchWeatherBtn) return;
      if (PRIME_IN_PROGRESS || MAIN_IN_PROGRESS) return;
      const mode = getWeatherQualityMode();
      fetchWeatherBtn.textContent = (mode === 'best') ? 'Get Multi-year Weather Data' : 'Get Weather Data';
    } catch (_) {}
  }

  // Bind GPX UI handlers only once (loadMap() runs many times)
  let GPX_UI_BOUND = false;
  let GPX_UPLOAD_IN_PROGRESS = false;
  let LAST_GPX_FILE_SIZE_BYTES = null;

  // Progress phase: GPX route -> profile -> weather
  let PROGRESS_PHASE = 'idle';
  let PROGRESS_ANIM_RAF = null;
  let PROGRESS_ANIM = null;

  function resetProgressInstant() {
    try {
      if (!progressBar) return;
      const prev = progressBar.style.transition;
      progressBar.style.transition = 'none';
      progressBar.style.width = '0%';
      void progressBar.offsetWidth;
      progressBar.style.transition = prev || '';
    } catch (_) {
      try { if (progressBar) progressBar.style.width = '0%'; } catch(_) {}
    }
  }

  function stopProgressAnim() {
    try {
      if (PROGRESS_ANIM_RAF) cancelAnimationFrame(PROGRESS_ANIM_RAF);
    } catch (_) {}
    try {
      if (progressBar && PROGRESS_ANIM && PROGRESS_ANIM.prevTransition !== undefined) {
        progressBar.style.transition = PROGRESS_ANIM.prevTransition;
      }
    } catch (_) {}
    PROGRESS_ANIM_RAF = null;
    PROGRESS_ANIM = null;
  }

  function startProgressAnim(targetPct, durationMs) {
    stopProgressAnim();
    if (!progressEl || !progressBar) return;
    const start = performance.now();
    const prevTransition = progressBar.style.transition;
    // During RAF-driven animations we want direct width updates (no extra CSS transition layer).
    progressBar.style.transition = 'none';
    const fromPct = (function(){
      try {
        const w = String(progressBar.style.width || '').trim();
        if (w.endsWith('%')) return Number(w.slice(0, -1)) || 0;
        return 0;
      } catch (_) { return 0; }
    })();
    const toPct = Math.max(0, Math.min(100, Number(targetPct) || 0));
    const dur = Math.max(250, Number(durationMs) || 1500);
    PROGRESS_ANIM = { start, dur, fromPct, toPct, prevTransition };
    progressEl.classList.remove('loading');

    const tick = (now) => {
      if (!PROGRESS_ANIM) return;
      const t = Math.max(0, Math.min(1, (now - PROGRESS_ANIM.start) / PROGRESS_ANIM.dur));
      const u = 1 - Math.pow(1 - t, 2); // ease-out
      const pct = PROGRESS_ANIM.fromPct + u * (PROGRESS_ANIM.toPct - PROGRESS_ANIM.fromPct);
      progressBar.style.width = `${pct}%`;
      if (t < 1) {
        PROGRESS_ANIM_RAF = requestAnimationFrame(tick);
      } else {
        PROGRESS_ANIM_RAF = null;
        try { progressBar.style.transition = prevTransition; } catch (_) {}
      }
    };
    PROGRESS_ANIM_RAF = requestAnimationFrame(tick);
  }

  function startGpxRouteProgress() {
    PROGRESS_PHASE = 'gpx_route';
    if (progressEl && progressBar) {
      resetProgressInstant();
      const mb = (LAST_GPX_FILE_SIZE_BYTES && Number.isFinite(LAST_GPX_FILE_SIZE_BYTES)) ? (LAST_GPX_FILE_SIZE_BYTES / (1024*1024)) : 0;
      const dur = Math.max(1200, Math.min(9000, 1800 + mb * 450));
      startProgressAnim(48, dur);
    }
    if (sseStatus) sseStatus.textContent = 'GPX: loading route…';
  }

  function startGpxProfileProgress() {
    PROGRESS_PHASE = 'gpx_profile';
    if (progressEl && progressBar) {
      const mb = (LAST_GPX_FILE_SIZE_BYTES && Number.isFinite(LAST_GPX_FILE_SIZE_BYTES)) ? (LAST_GPX_FILE_SIZE_BYTES / (1024*1024)) : 0;
      const dur = Math.max(1200, Math.min(12000, 2200 + mb * 650));
      startProgressAnim(95, dur);
    }
    if (sseStatus) sseStatus.textContent = 'GPX: generating elevation profile…';
  }

  function finishGpxProgress() {
    stopProgressAnim();
    PROGRESS_PHASE = 'gpx_done';
    try { if (progressBar) progressBar.style.width = '100%'; } catch (_) {}
  }

  function beginWeatherProgress() {
    stopProgressAnim();
    PROGRESS_PHASE = 'weather';
    if (progressEl && progressBar) {
      resetProgressInstant();
      progressEl.classList.remove('loading');
    }
  }

  // Weather provenance counters (updated from SSE station payload)
  let WEATHER_PROVENANCE = {
    disk_cache: 0,
    offline_tile: 0,
    api: 0,
    reused: 0,
    dummy: 0,
    other: 0,
    total_seen: 0,
  };

  function resetWeatherProvenance() {
    WEATHER_PROVENANCE = { disk_cache: 0, offline_tile: 0, api: 0, reused: 0, dummy: 0, other: 0, total_seen: 0 };
  }

  function _classifySourceMode(modeRaw) {
    const mode = String(modeRaw || '').toLowerCase();
    if (!mode) return 'other';
    if (mode.includes('disk_cache')) return 'disk_cache';
    if (mode.includes('offline')) return 'offline_tile';
    if (mode.includes('reused')) return 'reused';
    if (mode.includes('dummy')) return 'dummy';
    if (mode === 'api' || mode.startsWith('per_point_') || mode.includes('api')) return 'api';
    return 'other';
  }

  function noteWeatherProvenanceFromProps(props) {
    try {
      const bucket = _classifySourceMode(props && props._source_mode);
      WEATHER_PROVENANCE.total_seen += 1;
      if (WEATHER_PROVENANCE[bucket] !== undefined) WEATHER_PROVENANCE[bucket] += 1;
      else WEATHER_PROVENANCE.other += 1;
    } catch (_) {}
  }

  function weatherProvenanceText() {
    try {
      const c = WEATHER_PROVENANCE;
      const cache = (c.disk_cache || 0) + (c.reused || 0);
      const offline = (c.offline_tile || 0);
      const api = (c.api || 0);
      const dummy = (c.dummy || 0);
      const parts = [];
      parts.push(`cached ${cache}`);
      if (offline) parts.push(`offline ${offline}`);
      if (api) parts.push(`api ${api}`);
      if (dummy) parts.push(`dummy ${dummy}`);
      return parts.join(', ');
    } catch (_) {
      return '';
    }
  }

  function setProgressPercent(pct) {
    if (!progressEl || !progressBar) return;
    progressEl.classList.remove('loading');
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    progressBar.style.width = `${p}%`;
  }

  function setProgressIndeterminate(on) {
    if (!progressEl || !progressBar) return;
    if (on) {
      progressBar.style.width = '0%';
      progressEl.classList.add('loading');
    } else {
      progressEl.classList.remove('loading');
    }
  }

  function uploadGpxFileWithProgress(file) {
    return new Promise((resolve, reject) => {
      try {
        if (!file) return reject(new Error('No file'));
        if (GPX_UPLOAD_IN_PROGRESS) return reject(new Error('Upload already in progress'));
        GPX_UPLOAD_IN_PROGRESS = true;
        LAST_GPX_FILE_SIZE_BYTES = (file && file.size !== undefined) ? Number(file.size) : null;

        setProgressPercent(0);
        if (sseStatus) sseStatus.textContent = 'GPX: uploading…';

        const fd = new FormData();
        fd.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload_gpx', true);
        xhr.responseType = 'text';

        xhr.upload.onprogress = (ev) => {
          try {
            if (ev && ev.lengthComputable && ev.total > 0) {
              const pct = Math.round(100 * ev.loaded / ev.total);
              setProgressPercent(pct);
              if (sseStatus) sseStatus.textContent = `GPX: uploading… ${pct}%`;
            } else {
              setProgressIndeterminate(true);
              if (sseStatus) sseStatus.textContent = 'GPX: uploading…';
            }
          } catch (_) {}
        };

        xhr.onerror = () => {
          GPX_UPLOAD_IN_PROGRESS = false;
          setProgressIndeterminate(false);
          reject(new Error('Upload failed'));
        };
        xhr.onabort = () => {
          GPX_UPLOAD_IN_PROGRESS = false;
          setProgressIndeterminate(false);
          reject(new Error('Upload aborted'));
        };
        xhr.onload = () => {
          GPX_UPLOAD_IN_PROGRESS = false;
          try {
            const txt = xhr.responseText || '';
            const j = txt ? JSON.parse(txt) : null;
            if (!j || !j.path) {
              setProgressIndeterminate(false);
              return reject(new Error((j && j.error) ? String(j.error) : `Upload failed (HTTP ${xhr.status})`));
            }
            // Upload done; backend GPX parsing+profile generation progress will start on SSE connect.
            setProgressIndeterminate(false);
            resetProgressInstant();
            resolve(j);
          } catch (e) {
            setProgressIndeterminate(false);
            reject(e);
          }
        };

        xhr.send(fd);
      } catch (e) {
        GPX_UPLOAD_IN_PROGRESS = false;
        setProgressIndeterminate(false);
        reject(e);
      }
    });
  }

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
        const displayName = (LAST_GPX_NAME && String(LAST_GPX_NAME).trim()) ? String(LAST_GPX_NAME).trim() : getBaseName(LAST_GPX_PATH);
        dropZone.textContent = `Loaded GPX: ${displayName} (click or drop to change)`;
      } else {
        dropZone.textContent = 'Drop GPX here to load route (or click to choose)';
      }
    } catch (_) {}
  }

  function syncActiveGpxFromStreamPayload(payload) {
    try {
      if (!payload) return;
      const p = (payload.gpx_path !== undefined) ? payload.gpx_path
        : (payload.gpxPath !== undefined) ? payload.gpxPath
        : null;
      const n = (payload.gpx_name !== undefined) ? payload.gpx_name
        : (payload.gpxName !== undefined) ? payload.gpxName
        : null;

      let changed = false;
      if (p) {
        const sp = String(p);
        if (sp && sp !== String(LAST_GPX_PATH || '')) {
          LAST_GPX_PATH = sp;
          changed = true;
        }
      }
      if (n) {
        const sn = String(n);
        if (sn && sn !== String(LAST_GPX_NAME || '')) {
          LAST_GPX_NAME = sn;
          changed = true;
        }
      }
      if (changed) updateDropZoneLabel();
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
    // Global temperature palette (used across the whole app):
    // violet → blue → green → yellow → orange → red → darkred
    // Range: -20..40 °C
    // Best bike temperature: 15..25 °C maps green → yellow.
    const anchors = [
      { t: -20.0, c: [0x96, 0x3c, 0xbe] }, // violet
      { t: -10.0, c: [0x00, 0x5b, 0xff] }, // blue
      { t: 15.0,  c: [0x28, 0xa0, 0x50] }, // green
      { t: 25.0,  c: [0xf0, 0xdc, 0x50] }, // yellow
      { t: 30.0,  c: [0xf5, 0x9b, 0x3c] }, // orange
      { t: 35.0,  c: [0xd7, 0x3c, 0x2d] }, // red
      { t: 40.0,  c: [0x8b, 0x00, 0x00] }, // darkred
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
    const todayIso = (new Date()).toISOString().slice(0, 10);
    const defaults = {
      // Tour setup
      startDate: todayIso,
      tourDays: 7,
      reverse: false,
      weatherQuality: 'best',

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
      weatherVisualizationMode: 'glyphs',
      overlayMode: 'temperature',
      // Strategic/tactical settings (Phase 1: persisted but not yet fully used)
      strategicYear: 2025,
      climateTimescale: 'daily',
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
        startDate: (typeof j.startDate === 'string' && j.startDate) ? j.startDate : defaults.startDate,
        tourDays: Number.isFinite(Number(j.tourDays)) ? Number(j.tourDays) : defaults.tourDays,
        reverse: (typeof j.reverse === 'boolean') ? j.reverse : defaults.reverse,
        weatherQuality: (typeof j.weatherQuality === 'string') ? j.weatherQuality : defaults.weatherQuality,

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
        weatherVisualizationMode: (typeof j.weatherVisualizationMode === 'string')
          ? j.weatherVisualizationMode
          : defaults.weatherVisualizationMode,
        overlayMode: (typeof j.overlayMode === 'string') ? j.overlayMode : defaults.overlayMode,
        strategicYear: Number(j.strategicYear) || defaults.strategicYear,
        climateTimescale: (typeof j.climateTimescale === 'string')
          ? j.climateTimescale
          : ((typeof j.climate_timescale === 'string') ? j.climate_timescale : defaults.climateTimescale),
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
  // Preferences UI lives in the sidebar now, so sync it on startup
  // (previously this happened only when entering a dedicated "settings" mode).
  try { applySettingsToForm(SETTINGS); } catch (_) {}
  try { _setOverlayMode((SETTINGS && SETTINGS.overlayMode) ? String(SETTINGS.overlayMode) : OVERLAY_MODE, { skipPersist: true }); } catch (_) {}
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

    // Climate mode must never show TOUR tactical visuals (bands/glyphs).
    if (m === 'climate') {
      try { _setTourBandsEnabled(false); } catch (_) {}
      try {
        const tip = document.querySelector && document.querySelector('.wm-tour-bands-tip');
        if (tip) tip.style.display = 'none';
      } catch (_) {}
      try {
        // Hide glyph marker layers from prior TOUR runs.
        if (glyphLayerNew) { try { map.removeLayer(glyphLayerNew); } catch (_) {} }
        if (glyphLayer) { try { map.removeLayer(glyphLayer); } catch (_) {} }
      } catch (_) {}
    }
    if (m === 'tour') {
      // Restore preferred TOUR visualization when coming back from Climate mode.
      try { _setTourBandsEnabled(_tourWantBands()); } catch (_) {}
      try {
        const wantGlyphs = SETTINGS && String(SETTINGS.weatherVisualizationMode || 'glyphs') === 'glyphs';
        if (wantGlyphs) {
          if (glyphLayerNew) { try { glyphLayerNew.addTo(map); } catch (_) {} }
          if (glyphLayer) { try { glyphLayer.addTo(map); } catch (_) {} }
        } else {
          if (glyphLayerNew) { try { map.removeLayer(glyphLayerNew); } catch (_) {} }
          if (glyphLayer) { try { map.removeLayer(glyphLayer); } catch (_) {} }
        }
      } catch (_) {}
    }

    // Basemap selection: Climate mode varies per layer.
    try { _applyStrategicBasemap(); } catch (_) {}

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

  // (Intentionally no bottom-right climate control.)

  // -------------------- Climatic Map (Strategic) --------------------
  const STRATEGIC_DEFAULT_YEAR = 2025;
  const STRATEGIC_CROSSFADE_MS = 300;
  const STRATEGIC_FETCH_THROTTLE_MS = 180;

  // Cache strategic grid responses to keep slider scrubbing smooth.
  // Keyed by (year, timescale, iso, quantized bbox). LRU + TTL to cap memory.
  const STRATEGIC_CACHE_MAX = 96;
  const STRATEGIC_CACHE_TTL_MS = 3 * 60 * 1000;
  const STRATEGIC_CACHE = new Map(); // key -> { t:number, j:object }

  function _q3(x) {
    const v = Number(x);
    if (!Number.isFinite(v)) return 'nan';
    return (Math.round(v * 1000) / 1000).toFixed(3);
  }

  function _strategicCacheKey(year, timescale, iso, latMin, latMax, lonMin, lonMax) {
    return `${String(year)}|${String(timescale || 'daily')}|${String(iso)}|${_q3(latMin)},${_q3(latMax)},${_q3(lonMin)},${_q3(lonMax)}`;
  }

  function _strategicCacheGet(key) {
    const ent = STRATEGIC_CACHE.get(key);
    if (!ent) return null;
    if ((Date.now() - ent.t) > STRATEGIC_CACHE_TTL_MS) {
      STRATEGIC_CACHE.delete(key);
      return null;
    }
    // Touch LRU order
    STRATEGIC_CACHE.delete(key);
    STRATEGIC_CACHE.set(key, ent);
    return ent.j;
  }

  function _strategicCacheSet(key, j) {
    STRATEGIC_CACHE.set(key, { t: Date.now(), j });
    while (STRATEGIC_CACHE.size > STRATEGIC_CACHE_MAX) {
      const oldest = STRATEGIC_CACHE.keys().next().value;
      if (oldest === undefined) break;
      STRATEGIC_CACHE.delete(oldest);
    }
  }

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
    // Normalized palette aligned with tempColor(): map -20..40 °C → 0..1
    { t: 0.00,   c: { r: 150, g: 60,  b: 190 } }, // -20 violet
    { t: 0.1667, c: { r: 0,   g: 91,  b: 255 } }, // -10 blue
    { t: 0.5833, c: { r: 40,  g: 160, b: 80 } },  // 15 green
    { t: 0.75,   c: { r: 240, g: 220, b: 80 } },  // 25 yellow
    { t: 0.8333, c: { r: 245, g: 155, b: 60 } },  // 30 orange
    { t: 0.9167, c: { r: 215, g: 60,  b: 45 } },  // 35 red
    { t: 1.00,   c: { r: 139, g: 0,   b: 0 } },   // 40 darkred
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

  // -------------------- Strategic Legend (in-map) --------------------
  let STRATEGIC_LEGEND_EL = null;
  let STRATEGIC_LEGEND_LAYER_SELECT = null;
  let STRATEGIC_LEGEND_YEAR_SELECT = null;
  let STRATEGIC_LEGEND_TIMESCALE_SELECT = null;
  function _ensureStrategicLegend() {
    if (STRATEGIC_LEGEND_EL) return STRATEGIC_LEGEND_EL;
    try {
      const el = document.createElement('div');
      el.className = 'wm-map-legend hidden';
      el.innerHTML = [
        '<div class="title" id="wmStrategicLegendTitle" style="margin:0;">Legend</div>',
        '<div class="row">'
          + '<div class="lab">Layer</div>'
          + '<select id="wmStrategicLegendLayerSelect" class="sel" aria-label="Layer" title="Layer"></select>'
        + '</div>',
        '<div class="row">'
          + '<div class="lab">Year</div>'
          + '<select id="wmStrategicLegendYearSelect" class="sel" aria-label="Year" title="Year"></select>'
        + '</div>',
        '<div class="row">'
          + '<div class="lab">Timescale</div>'
          + '<select id="wmStrategicLegendTimescaleSelect" class="sel" aria-label="Timescale" title="Timescale">'
            + '<option value="daily">Daily</option>'
            + '<option value="week">Weekly</option>'
            + '<option value="two_week">2 Weeks</option>'
            + '<option value="month">Monthly</option>'
            + '<option value="quarter">Quarter</option>'
            + '<option value="year">Yearly</option>'
          + '</select>'
        + '</div>',
        '<div class="bar" id="wmStrategicLegendBar"></div>',
        '<div class="ticks" id="wmStrategicLegendTicks"></div>',
        '<div class="note" id="wmStrategicLegendNote" style="display:none"></div>',
      ].join('');
      // Attach to Leaflet map container so it stays inside the map.
      const c = map && map.getContainer ? map.getContainer() : null;
      if (c) c.appendChild(el);
      STRATEGIC_LEGEND_EL = el;

      try {
        const sel = el.querySelector('#wmStrategicLegendLayerSelect');
        if (sel) {
          STRATEGIC_LEGEND_LAYER_SELECT = sel;
          try { _populateLayerOptions(sel); } catch (_) {}
          sel.addEventListener('change', () => {
            const v = String(sel.value || 'temperature_ride');
            try { _setStrategicLayer(v); } catch (_) {}
            try { if (STRATEGIC_STATE && STRATEGIC_STATE.active) _scheduleStrategicFetch(); } catch (_) {}
            try { _applyStrategicBasemap(); } catch (_) {}
            try { _renderStrategic(); } catch (_) {}
          });
        }
      } catch (_) {}

      try {
        const selY = el.querySelector('#wmStrategicLegendYearSelect');
        if (selY) {
          STRATEGIC_LEGEND_YEAR_SELECT = selY;
          try { _populateYearOptionsFromPrefs(selY); } catch (_) {}
          selY.addEventListener('change', () => {
            const y = Number(selY.value);
            if (!Number.isFinite(y)) return;
            try { SETTINGS.strategicYear = y; saveSettings(SETTINGS); } catch (_) {}
            try { _strategicSetYear(y); } catch (_) {}
            try { if (STRATEGIC_STATE && STRATEGIC_STATE.active) _scheduleStrategicFetch(); } catch (_) {}
          });
        }
      } catch (_) {}

      try {
        const selTS = el.querySelector('#wmStrategicLegendTimescaleSelect');
        if (selTS) {
          STRATEGIC_LEGEND_TIMESCALE_SELECT = selTS;
          selTS.addEventListener('change', () => {
            const ts = String(selTS.value || 'daily');
            try { STRATEGIC_STATE.timescale = ts; } catch (_) {}
            try { if (strategicTimescaleSelect) strategicTimescaleSelect.value = ts; } catch (_) {}
            try { SETTINGS.climateTimescale = ts; saveSettings(SETTINGS); } catch (_) {}
            try { _strategicApplyTimescaleUI(); } catch (_) {}
            try { if (STRATEGIC_STATE && STRATEGIC_STATE.active) _scheduleStrategicFetch(); } catch (_) {}
          });
        }
      } catch (_) {}
      return el;
    } catch (_) {
      return null;
    }
  }

  function _legendGradientCSS(stops) {
    const parts = (stops || []).map(s => {
      const p = Math.round(100 * _clamp01(Number(s.t)));
      const c = s.c || { r: 0, g: 0, b: 0 };
      return `rgb(${c.r},${c.g},${c.b}) ${p}%`;
    });
    if (!parts.length) return 'linear-gradient(to right, rgba(0,0,0,0.08), rgba(0,0,0,0.18))';
    return `linear-gradient(to right, ${parts.join(', ')})`;
  }

  function _setLegend(title, stops, tickLabels, noteText) {
    const el = _ensureStrategicLegend();
    if (!el) return;
    const titleEl = el.querySelector('#wmStrategicLegendTitle');
    const barEl = el.querySelector('#wmStrategicLegendBar');
    const ticksEl = el.querySelector('#wmStrategicLegendTicks');
    const noteEl = el.querySelector('#wmStrategicLegendNote');
    if (titleEl) titleEl.textContent = String(title || 'Legend');
    if (barEl) {
      barEl.classList.remove('steps');
      barEl.innerHTML = '';
      barEl.style.background = _legendGradientCSS(stops);
    }
    if (ticksEl) {
      ticksEl.innerHTML = '';
      // Reset any per-layer overrides (e.g. temperature tick marks stacked layout).
      try { ticksEl.style.display = ''; } catch (_) {}
      try { ticksEl.style.gap = ''; } catch (_) {}
      try { ticksEl.style.flexDirection = ''; } catch (_) {}
      const labs = Array.isArray(tickLabels) ? tickLabels : [];
      for (const t of labs) {
        const s = document.createElement('span');
        s.textContent = String(t);
        ticksEl.appendChild(s);
      }
    }
    if (noteEl) {
      if (noteText) {
        noteEl.style.display = 'block';
        noteEl.textContent = String(noteText);
      } else {
        noteEl.style.display = 'none';
        noteEl.textContent = '';
      }
    }
  }

  function _setLegendSteps(title, segments, tickLabels, noteText) {
    const el = _ensureStrategicLegend();
    if (!el) return;
    const titleEl = el.querySelector('#wmStrategicLegendTitle');
    const barEl = el.querySelector('#wmStrategicLegendBar');
    const ticksEl = el.querySelector('#wmStrategicLegendTicks');
    const noteEl = el.querySelector('#wmStrategicLegendNote');
    if (titleEl) titleEl.textContent = String(title || 'Legend');

    if (barEl) {
      barEl.classList.add('steps');
      barEl.style.background = 'none';
      barEl.innerHTML = '';
      const segs = Array.isArray(segments) ? segments : [];
      for (const seg of segs) {
        const d = document.createElement('div');
        d.className = 'seg';
        const col = String(seg && seg.color ? seg.color : 'rgba(0,0,0,0.08)');
        d.style.background = col;
        if (seg && Number.isFinite(Number(seg.flex)) && Number(seg.flex) > 0) {
          d.style.flex = String(Number(seg.flex));
        }
        barEl.appendChild(d);
      }
    }

    if (ticksEl) {
      ticksEl.innerHTML = '';
      // Reset any per-layer overrides (e.g. temperature tick marks stacked layout).
      try { ticksEl.style.display = ''; } catch (_) {}
      try { ticksEl.style.gap = ''; } catch (_) {}
      try { ticksEl.style.flexDirection = ''; } catch (_) {}
      const labs = Array.isArray(tickLabels) ? tickLabels : [];
      for (const t of labs) {
        const s = document.createElement('span');
        s.textContent = String(t);
        ticksEl.appendChild(s);
      }
    }

    if (noteEl) {
      if (noteText) {
        noteEl.style.display = 'block';
        noteEl.textContent = String(noteText);
      } else {
        noteEl.style.display = 'none';
        noteEl.textContent = '';
      }
    }
  }

  function _setLegendTooltips(containerTip, barTip, tickTip) {
    const el = _ensureStrategicLegend();
    if (!el) return;
    const globalTip = (containerTip || barTip || tickTip) ? String(containerTip || barTip || tickTip) : null;
    try {
      if (globalTip) el.title = globalTip;
      else el.removeAttribute('title');
    } catch (_) {}
    try {
      const titleEl = el.querySelector('#wmStrategicLegendTitle');
      if (titleEl) {
        if (globalTip) titleEl.title = globalTip;
        else titleEl.removeAttribute('title');
      }
    } catch (_) {}
    try {
      const barEl = el.querySelector('#wmStrategicLegendBar');
      if (barEl) {
        const tip = barTip ? String(barTip) : globalTip;
        if (tip) barEl.title = tip;
        else barEl.removeAttribute('title');
      }
    } catch (_) {}
    try {
      const ticksEl = el.querySelector('#wmStrategicLegendTicks');
      if (ticksEl) {
        if (globalTip) ticksEl.title = globalTip;
        else ticksEl.removeAttribute('title');
        for (const s of ticksEl.querySelectorAll('span')) {
          const tip = tickTip ? String(tickTip) : globalTip;
          if (tip) s.title = tip;
          else s.removeAttribute('title');
        }
      }
    } catch (_) {}
    try {
      const noteEl = el.querySelector('#wmStrategicLegendNote');
      if (noteEl) {
        if (globalTip) noteEl.title = globalTip;
        else noteEl.removeAttribute('title');
      }
    } catch (_) {}
  }

  function _updateStrategicLegend() {
    const el = _ensureStrategicLegend();
    if (!el) return;
    if (!STRATEGIC_STATE || !STRATEGIC_STATE.active) {
      el.classList.add('hidden');
      return;
    }

    const layer = STRATEGIC_STATE.layer;
    el.classList.remove('hidden');

    // Keep legend's layer select in sync (and keep its options current).
    try {
      if (STRATEGIC_LEGEND_LAYER_SELECT) {
        if (strategicLayerSelect && strategicLayerSelect.options && STRATEGIC_LEGEND_LAYER_SELECT.options.length !== strategicLayerSelect.options.length) {
          _populateLayerOptions(STRATEGIC_LEGEND_LAYER_SELECT);
        }
        STRATEGIC_LEGEND_LAYER_SELECT.value = String(layer || 'temperature_ride');
      }
    } catch (_) {}

    try {
      if (STRATEGIC_LEGEND_YEAR_SELECT) {
        if (setStrategicYear && setStrategicYear.options && STRATEGIC_LEGEND_YEAR_SELECT.options.length !== setStrategicYear.options.length) {
          _populateYearOptionsFromPrefs(STRATEGIC_LEGEND_YEAR_SELECT);
        }
        const y = Number(STRATEGIC_STATE.year || (SETTINGS && SETTINGS.strategicYear) || STRATEGIC_DEFAULT_YEAR);
        STRATEGIC_LEGEND_YEAR_SELECT.value = String(Number.isFinite(y) ? y : STRATEGIC_DEFAULT_YEAR);
      }
    } catch (_) {}
    try {
      if (STRATEGIC_LEGEND_TIMESCALE_SELECT) {
        const ts = String(STRATEGIC_STATE.timescale || ((SETTINGS && SETTINGS.climateTimescale) ? SETTINGS.climateTimescale : 'daily'));
        STRATEGIC_LEGEND_TIMESCALE_SELECT.value = ts || 'daily';
      }
    } catch (_) {}

    if (layer === 'temperature_ride') {
      // Show color scale only between -10..40°C.
      _setLegend(
        'Temperature (ride hours, °C)',
        [
          { t: 0.00, c: { r: 0,   g: 91,  b: 255 } }, // -10 blue
          { t: 0.50, c: { r: 40,  g: 160, b: 80 } },  // 15 green
          { t: 0.70, c: { r: 240, g: 220, b: 80 } },  // 25 yellow
          { t: 0.80, c: { r: 245, g: 155, b: 60 } },  // 30 orange
          { t: 0.90, c: { r: 215, g: 60,  b: 45 } },  // 35 red
          { t: 1.00, c: { r: 139, g: 0,   b: 0 } },   // 40 darkred
        ],
        ['-10', '0', '10', '20', '30', '40'],
        null
      );

      // Add small tick marks between the color bar and labels.
      try {
        const ticksEl = el.querySelector('#wmStrategicLegendTicks');
        if (ticksEl) {
          const labs = ['-10', '0', '10', '20', '30', '40'];
          ticksEl.innerHTML = '';

          // Stack: tick marks row + labels row (CSS for .ticks is flex by default).
          try { ticksEl.style.display = 'block'; } catch (_) {}
          try { ticksEl.style.gap = '0px'; } catch (_) {}

          const marks = document.createElement('div');
          marks.style.display = 'flex';
          marks.style.justifyContent = 'space-between';
          marks.style.alignItems = 'flex-end';
          marks.style.height = '7px';
          marks.style.marginTop = '2px';
          for (let i = 0; i < labs.length; i++) {
            const mk = document.createElement('span');
            mk.style.display = 'inline-block';
            mk.style.width = '1px';
            mk.style.height = '5px';
            mk.style.background = 'rgba(0,0,0,0.35)';
            marks.appendChild(mk);
          }

          const labels = document.createElement('div');
          labels.style.display = 'flex';
          labels.style.justifyContent = 'space-between';
          labels.style.marginTop = '2px';
          for (const t of labs) {
            const s = document.createElement('span');
            s.textContent = String(t);
            labels.appendChild(s);
          }

          ticksEl.appendChild(marks);
          ticksEl.appendChild(labels);
        }
      } catch (_) {}
      _setLegendTooltips(
        'Ride-hours temperature (median of 10/12/14/16 local time).',
        'Color encodes temperature (°C).',
        'Tick labels are °C anchors for the palette.'
      );
      return;
    }
    if (layer === 'rain_ride') {
      _setLegendSteps(
        'Precipitation (mm/day)',
        [
          { color: 'rgba(255,255,255,0.0)' },  // 0
          { color: 'rgba(237,231,246,0.90)' },  // 0.5–1  (#ede7f6)
          { color: 'rgba(179,157,219,0.90)' },  // 1–3    (#b39ddb)
          { color: 'rgba(126,87,194,0.90)' },   // 3–8    (#7e57c2)
          { color: 'rgba(94,53,177,0.90)' },    // 8–20   (#5e35b1)
          { color: 'rgba(49,27,146,0.90)' },    // >20    (#311b92)
        ],
        ['0', '0.5', '1', '3', '8', '20', '>20'],
        null
      );
      _setLegendTooltips(
        'Daily precipitation sum (mm/day). Light drizzle (<0.5mm/day) is visually suppressed.',
        'Color encodes precipitation zones (mm/day) with higher contrast.',
        'Tick labels are mm/day anchors.'
      );
      return;
    }
    if (layer === 'rain_tent') {
      _setLegend('Rain (typical, mm/day)', PAL_RAIN, ['0', '3', '6', '12'], null);
      _setLegendTooltips(
        'Typical rain during tent hours (mm/day equivalent).',
        'Color encodes typical rain (mm/day).',
        'Tick labels are mm/day anchors.'
      );
      return;
    }
    if (layer === 'comfort_ride') {
      _setLegendSteps(
        'Ride comfort (bikepacking)',
        [
          { color: 'rgba(220,55,55,0.95)' },   // red
          { color: 'rgba(245,155,60,0.95)' },  // orange
          { color: 'rgba(240,220,80,0.95)' },  // yellow
          { color: 'rgba(40,160,80,0.95)' },   // green
          { color: 'rgba(0,120,70,0.95)' },    // deep green
        ],
        ['<-2', '0', '2', '4', '≥4'],
        null
      );
      const cold = Number(SETTINGS.tempCold || 5);
      const hot = Number(SETTINGS.tempHot || 30);
      const rainHigh = Number(SETTINGS.rainHigh || 10);
      const wAbs = Number(SETTINGS.windHeadComfort || 4);
      _setLegendTooltips(
        'Bikepacking comfort index = TempScore + RainScore + WindScore.',
        `Thresholds: temp ${cold}..${hot}°C, rain < ${rainHigh} mm/day, wind < ${wAbs} m/s (absolute).`,
        'ISO bands: ≥4 deep green, 2..4 green, 0..2 yellow, -2..0 orange, < -2 red.'
      );
      return;
    }
    if (layer === 'comfort_tent') {
      const rainTypStyled = styleVal(rainTyp, Number(rainTyp) >= R_HIGH);
      const cold = Number(SETTINGS.tempCold || 5);
      const hot = Number(SETTINGS.tempHot || 30);
      const rainHigh = Number(SETTINGS.rainHigh || 10);
      const wAbs = Number(SETTINGS.windHeadComfort || 4);
      _setLegendTooltips(
        'Comfort score combines temperature, rain and wind for tent hours.',
        `Thresholds: temp ${cold}..${hot}°C, rain < ${rainHigh} mm/day, wind < ${wAbs} m/s (absolute).`,
        'Tick labels are score anchors (0..1).'
      );
      return;
    }
    if (layer === 'wind_speed') {
      _setLegend('Wind speed (m/s)', PAL_WIND, ['0', '4', '8', '16'], null);
      _setLegendTooltips(
        'Wind speed averaged for the day (m/s).',
        'Color encodes wind speed (m/s).',
        'Tick labels are m/s anchors.'
      );
      return;
    }
    if (layer === 'wind_dir') {
      _setLegendSteps(
        'Wind (streamlines)',
        [
          { color: 'rgba(180,180,180,0.75)' },
          { color: 'rgba(60,130,220,0.75)' },
          { color: 'rgba(245,155,60,0.75)' },
          { color: 'rgba(220,55,55,0.75)' },
        ],
        ['0', '3', '6', '10', '>10'],
        'Direction by streamline direction; color encodes speed.'
      );
      _setLegendTooltips(
        'Wind streamlines: direction and speed.',
        'Color encodes wind speed (m/s).',
        'Speed bins: 0–3 grey, 3–6 blue, 6–10 orange, >10 red.'
      );
      return;
    }

    _setLegend('Legend', PAL_TEMP, [], null);
    _setLegendTooltips(null, null, null);
  }

  function _syncStrategicQuickLayer() {
    if (!strategicQuickLayerSelect) return;
    try {
      const lyr = STRATEGIC_STATE ? String(STRATEGIC_STATE.layer || '') : '';
      const opt = strategicQuickLayerSelect.querySelector(`option[value="${lyr.replace(/"/g, '')}"]`);
      if (opt) strategicQuickLayerSelect.value = lyr;
    } catch (_) {}
  }

  function _setStrategicLayer(layer) {
    STRATEGIC_STATE.layer = String(layer || 'temperature_ride');
    try {
      if (strategicLayerSelect) strategicLayerSelect.value = STRATEGIC_STATE.layer;
    } catch (_) {}
    if (strategicWindOn && (STRATEGIC_STATE.layer === 'wind_speed' || STRATEGIC_STATE.layer === 'wind_dir') && !strategicWindOn.checked) {
      strategicWindOn.checked = true;
      STRATEGIC_STATE.windOn = true;
    }
    _syncStrategicQuickLayer();
    _updateStrategicLegend();
    try { _applyStrategicBasemap(); } catch (_) {}
    _renderStrategic();
  }

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

        // Render into a hidden buffer canvas, then blit to the visible canvas.
        // This avoids flicker when repeatedly updating (e.g., day-to-day scrubbing).
        this._front = L.DomUtil.create('canvas', '', this._container);
        this._buffer = L.DomUtil.create('canvas', '', this._container);
        [this._front, this._buffer].forEach(c => {
          c.style.position = 'absolute';
          c.style.left = '0';
          c.style.top = '0';
          c.style.width = '100%';
          c.style.height = '100%';
        });
        // Keep buffer hidden; drawing to it is fine.
        this._buffer.style.visibility = 'hidden';
        this._buffer.style.pointerEvents = 'none';

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
        // Align overlay element with the current viewport.
        // Leaflet panes are in *layer* coordinates; our drawing uses *container* pixel coords.
        // Positioning the container at the layer-point for container (0,0) keeps them in sync.
        const topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._container, topLeft);
        const size = this._map.getSize();
        const dpr = (window.devicePixelRatio || 1);
        this._container.style.width = `${size.x}px`;
        this._container.style.height = `${size.y}px`;
        [this._front, this._buffer].forEach(c => {
          c.width = Math.max(1, Math.floor(size.x * dpr));
          c.height = Math.max(1, Math.floor(size.y * dpr));
        });
      },
      drawWith: function(drawFn) {
        if (!this._map) return;
        this._reset();
        const dpr = (window.devicePixelRatio || 1);
        const bctx = this._buffer.getContext('2d');
        const fctx = this._front.getContext('2d');
        if (!bctx || !fctx) return;

        // Draw into buffer in CSS pixels.
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.clearRect(0, 0, this._buffer.width, this._buffer.height);
        bctx.scale(dpr, dpr);
        try { drawFn(bctx, this._map.getSize()); } catch (e) { console.error('strategic draw', e); }

        // Blit buffer to front (device pixels); no intermediate blank frame.
        fctx.setTransform(1, 0, 0, 1, 0, 0);
        fctx.clearRect(0, 0, this._front.width, this._front.height);
        fctx.drawImage(this._buffer, 0, 0);
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
        const topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._container, topLeft);
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
      startFlow: function(sampleFn, opts) {
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
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        const size = m.getSize();
        const speedMul = Math.max(0.25, Number(strategicSpeed && strategicSpeed.value) || 1.0);

        // Density proportional to wind speed (using viewport hint when available).
        const speedHint = (opts && Number.isFinite(opts.speedHint)) ? Number(opts.speedHint) : 4.0;
        const base = Math.max(20, Math.min(240, Number(SETTINGS.windDensity) || 40));
        const speedFactor = Math.max(0.6, Math.min(2.2, 0.6 + 0.12 * speedHint));
        const density = Math.max(60, Math.min(2200, Math.round(base * 10 * speedFactor)));
        this._particles = [];
        for (let i = 0; i < density; i++) {
          this._particles.push({ x: Math.random() * size.x, y: Math.random() * size.y, a: Math.random() });
        }

        const colForSpeed = (sp) => {
          const s = Math.max(0, Number(sp) || 0);
          // Higher alpha so streamlines remain readable over basemap.
          if (s < 3) return 'rgba(180,180,180,0.62)';
          if (s < 6) return 'rgba(60,130,220,0.62)';
          if (s < 10) return 'rgba(245,155,60,0.62)';
          return 'rgba(220,55,55,0.62)';
        };

        const step = () => {
          if (!this._map) return;
          const m2 = this._map;
          const sz = m2.getSize();
          // Fade trails without tinting the map (reduce alpha only)
          ctx.globalCompositeOperation = 'destination-in';
          // Keep trails longer to make flow more visible.
          ctx.fillStyle = 'rgba(0,0,0,0.96)';
          ctx.fillRect(0, 0, sz.x, sz.y);
          ctx.globalCompositeOperation = 'source-over';
          ctx.lineWidth = 1.6;

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
            ctx.strokeStyle = colForSpeed(sp);
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

  // -------------------- Tour Bands (Tactical visualization) --------------------
  // Continuous bands along the GPX route:
  // - Right side: temperature band + uncertainty envelope (p25..p75)
  // - Left side: effective wind component (headwind↔tailwind)
  // - Sparse rain markers when rain is likely
  let TOUR_BANDS_LAYER = null;
  let TOUR_BANDS_ENABLED = false;
  let TOUR_BANDS_PROFILE = null;
  let TOUR_BANDS_POINTS = null;
  let TOUR_BANDS_REDRAW_QUEUED = false;

  // Hover/tooltip helpers (Tour Planning)
  let TOUR_HOVER_POINTS_SORTED = null;
  let TOUR_HOVER_POINTS_DIRTY = true;
  let TOUR_HOVER_MM_PX = null;

  function _mmToPx(mm) {
    const m = Number(mm);
    if (!Number.isFinite(m) || m <= 0) return 0;
    try {
      if (TOUR_HOVER_MM_PX && Number.isFinite(TOUR_HOVER_MM_PX.pxPerMm) && TOUR_HOVER_MM_PX.pxPerMm > 0) {
        return TOUR_HOVER_MM_PX.pxPerMm * m;
      }
    } catch (_) {}
    try {
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.left = '-10000px';
      el.style.top = '-10000px';
      el.style.width = '100mm';
      el.style.height = '1px';
      el.style.visibility = 'hidden';
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      const pxPerMm = (w && Number.isFinite(w) && w > 0) ? (w / 100.0) : (96 / 25.4);
      TOUR_HOVER_MM_PX = { pxPerMm: pxPerMm };
      return pxPerMm * m;
    } catch (_) {
      const pxPerMm = 96 / 25.4;
      TOUR_HOVER_MM_PX = { pxPerMm: pxPerMm };
      return pxPerMm * m;
    }
  }

  function _tourHoverPointsSorted() {
    if (!TOUR_HOVER_POINTS_DIRTY && TOUR_HOVER_POINTS_SORTED) return TOUR_HOVER_POINTS_SORTED;
    try {
      const pts = Array.isArray(OVERLAY_POINTS) ? OVERLAY_POINTS : [];
      const s = pts.slice().filter(p => p && Number.isFinite(Number(p.dist)));
      s.sort((a, b) => Number(a.dist) - Number(b.dist));
      TOUR_HOVER_POINTS_SORTED = s;
      TOUR_HOVER_POINTS_DIRTY = false;
      return TOUR_HOVER_POINTS_SORTED;
    } catch (_) {
      TOUR_HOVER_POINTS_SORTED = [];
      TOUR_HOVER_POINTS_DIRTY = false;
      return TOUR_HOVER_POINTS_SORTED;
    }
  }

  function _tourSampleAtDist(dkm) {
    const x = Number(dkm);
    if (!Number.isFinite(x)) return null;
    const pts = _tourHoverPointsSorted();
    if (!pts || pts.length === 0) return null;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const lerpNum = (a, b, t) => (Number.isFinite(Number(a)) && Number.isFinite(Number(b)))
      ? lerp(Number(a), Number(b), t)
      : (Number.isFinite(Number(a)) ? Number(a) : (Number.isFinite(Number(b)) ? Number(b) : null));
    if (pts.length === 1) {
      const p = pts[0];
      return {
        dist: x,
        temperature: Number.isFinite(Number(p.temperature)) ? Number(p.temperature) : null,
        temp_hist_median: Number.isFinite(Number(p.temp_hist_median)) ? Number(p.temp_hist_median) : null,
        temp_hist_min: Number.isFinite(Number(p.temp_hist_min)) ? Number(p.temp_hist_min) : null,
        temp_hist_max: Number.isFinite(Number(p.temp_hist_max)) ? Number(p.temp_hist_max) : null,
        temp_hist_p25: Number.isFinite(Number(p.temp_hist_p25)) ? Number(p.temp_hist_p25) : null,
        temp_hist_p75: Number.isFinite(Number(p.temp_hist_p75)) ? Number(p.temp_hist_p75) : null,
        temp_day_typical_min: Number.isFinite(Number(p.temp_day_typical_min)) ? Number(p.temp_day_typical_min) : null,
        temp_day_typical_max: Number.isFinite(Number(p.temp_day_typical_max)) ? Number(p.temp_day_typical_max) : null,
        temp_day_p25: Number.isFinite(Number(p.temp_day_p25)) ? Number(p.temp_day_p25) : null,
        temp_day_p75: Number.isFinite(Number(p.temp_day_p75)) ? Number(p.temp_day_p75) : null,
        windSpeed: Number.isFinite(Number(p.windSpeed)) ? Number(p.windSpeed) : null,
        windDir: Number.isFinite(Number(p.windDir)) ? Number(p.windDir) : null,
        rainProb: Number.isFinite(Number(p.rainProb)) ? Number(p.rainProb) : null,
        rainTypical: Number.isFinite(Number(p.rainTypical)) ? Number(p.rainTypical) : (Number.isFinite(Number(p.precipMm)) ? Number(p.precipMm) : null),
        rain_hist_p25_mm: Number.isFinite(Number(p.rain_hist_p25_mm)) ? Number(p.rain_hist_p25_mm) : null,
        rain_hist_p75_mm: Number.isFinite(Number(p.rain_hist_p75_mm)) ? Number(p.rain_hist_p75_mm) : null,
        rain_hist_p90_mm: Number.isFinite(Number(p.rain_hist_p90_mm)) ? Number(p.rain_hist_p90_mm) : null,
        yearsStart: Number.isFinite(Number(p.yearsStart)) ? Number(p.yearsStart) : null,
        yearsEnd: Number.isFinite(Number(p.yearsEnd)) ? Number(p.yearsEnd) : null,
        matchDays: Number.isFinite(Number(p.matchDays)) ? Number(p.matchDays) : null,
      };
    }
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (Number(pts[mid].dist) <= x) lo = mid; else hi = mid - 1;
    }
    const i0 = lo;
    const i1 = Math.min(pts.length - 1, i0 + 1);
    const p0 = pts[i0];
    const p1 = pts[i1];
    const d0 = Number(p0.dist);
    const d1 = Number(p1.dist);
    if (!Number.isFinite(d0) || !Number.isFinite(d1) || d1 <= d0) {
      return {
        dist: x,
        temperature: Number.isFinite(Number(p0.temperature)) ? Number(p0.temperature) : null,
        temp_hist_median: Number.isFinite(Number(p0.temp_hist_median)) ? Number(p0.temp_hist_median) : null,
        temp_hist_min: Number.isFinite(Number(p0.temp_hist_min)) ? Number(p0.temp_hist_min) : null,
        temp_hist_max: Number.isFinite(Number(p0.temp_hist_max)) ? Number(p0.temp_hist_max) : null,
        temp_hist_p25: Number.isFinite(Number(p0.temp_hist_p25)) ? Number(p0.temp_hist_p25) : null,
        temp_hist_p75: Number.isFinite(Number(p0.temp_hist_p75)) ? Number(p0.temp_hist_p75) : null,
        temp_day_typical_min: Number.isFinite(Number(p0.temp_day_typical_min)) ? Number(p0.temp_day_typical_min) : null,
        temp_day_typical_max: Number.isFinite(Number(p0.temp_day_typical_max)) ? Number(p0.temp_day_typical_max) : null,
        temp_day_p25: Number.isFinite(Number(p0.temp_day_p25)) ? Number(p0.temp_day_p25) : null,
        temp_day_p75: Number.isFinite(Number(p0.temp_day_p75)) ? Number(p0.temp_day_p75) : null,
        windSpeed: Number.isFinite(Number(p0.windSpeed)) ? Number(p0.windSpeed) : null,
        windDir: Number.isFinite(Number(p0.windDir)) ? Number(p0.windDir) : null,
        rainProb: Number.isFinite(Number(p0.rainProb)) ? Number(p0.rainProb) : null,
        rainTypical: Number.isFinite(Number(p0.rainTypical)) ? Number(p0.rainTypical) : (Number.isFinite(Number(p0.precipMm)) ? Number(p0.precipMm) : null),
        rain_hist_p25_mm: Number.isFinite(Number(p0.rain_hist_p25_mm)) ? Number(p0.rain_hist_p25_mm) : null,
        rain_hist_p75_mm: Number.isFinite(Number(p0.rain_hist_p75_mm)) ? Number(p0.rain_hist_p75_mm) : null,
        rain_hist_p90_mm: Number.isFinite(Number(p0.rain_hist_p90_mm)) ? Number(p0.rain_hist_p90_mm) : null,
        yearsStart: Number.isFinite(Number(p0.yearsStart)) ? Number(p0.yearsStart) : null,
        yearsEnd: Number.isFinite(Number(p0.yearsEnd)) ? Number(p0.yearsEnd) : null,
        matchDays: Number.isFinite(Number(p0.matchDays)) ? Number(p0.matchDays) : null,
      };
    }
    const t = clamp((x - d0) / (d1 - d0), 0, 1);
    return {
      dist: x,
      temperature: lerpNum(p0.temperature, p1.temperature, t),
      temp_hist_median: lerpNum(p0.temp_hist_median, p1.temp_hist_median, t),
      temp_hist_min: lerpNum(p0.temp_hist_min, p1.temp_hist_min, t),
      temp_hist_max: lerpNum(p0.temp_hist_max, p1.temp_hist_max, t),
      temp_hist_p25: lerpNum(p0.temp_hist_p25, p1.temp_hist_p25, t),
      temp_hist_p75: lerpNum(p0.temp_hist_p75, p1.temp_hist_p75, t),
      temp_day_typical_min: lerpNum(p0.temp_day_typical_min, p1.temp_day_typical_min, t),
      temp_day_typical_max: lerpNum(p0.temp_day_typical_max, p1.temp_day_typical_max, t),
      temp_day_p25: lerpNum(p0.temp_day_p25, p1.temp_day_p25, t),
      temp_day_p75: lerpNum(p0.temp_day_p75, p1.temp_day_p75, t),
      windSpeed: lerpNum(p0.windSpeed, p1.windSpeed, t),
      windDir: lerpNum(p0.windDir, p1.windDir, t),
      rainProb: lerpNum(p0.rainProb, p1.rainProb, t),
      rainTypical: lerpNum((p0.rainTypical ?? p0.precipMm), (p1.rainTypical ?? p1.precipMm), t),
      rain_hist_p25_mm: lerpNum(p0.rain_hist_p25_mm, p1.rain_hist_p25_mm, t),
      rain_hist_p75_mm: lerpNum(p0.rain_hist_p75_mm, p1.rain_hist_p75_mm, t),
      rain_hist_p90_mm: lerpNum(p0.rain_hist_p90_mm, p1.rain_hist_p90_mm, t),
      yearsStart: (p0.yearsStart ?? p1.yearsStart ?? null),
      yearsEnd: (p0.yearsEnd ?? p1.yearsEnd ?? null),
      matchDays: (p0.matchDays ?? p1.matchDays ?? null),
    };
  }

  function _tourDayIndexAtDist(dkm) {
    const d = Number(dkm);
    if (!Number.isFinite(d)) return 0;
    try {
      const bounds = Array.isArray(LAST_PROFILE && LAST_PROFILE.day_boundaries) ? LAST_PROFILE.day_boundaries : [];
      if (!bounds.length) return 0;
      const marks = bounds.map(b => Number(b.distance_km || 0)).filter(v => Number.isFinite(v));
      let dayIdx = marks.findIndex(m => d < m);
      if (dayIdx === -1 || dayIdx < 0) dayIdx = marks.length;
      return Math.max(0, dayIdx);
    } catch (_) {
      return 0;
    }
  }

  function _tourDateStrForDayIdx(dayIdx) {
    try {
      const base = startDateInput && startDateInput.value ? new Date(startDateInput.value) : null;
      if (!base) return '-';
      const d = new Date(base);
      d.setDate(d.getDate() + Number(dayIdx || 0));
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${dd}.${mm}`;
    } catch (_) {
      return '-';
    }
  }

  function _tourEffectiveWind(sample, dkm) {
    try {
      if (!sample) return null;
      const wspd = Number(sample.windSpeed);
      const wdir = Number(sample.windDir);
      if (!Number.isFinite(wspd) || !Number.isFinite(wdir)) return null;
      const sd = Array.isArray(LAST_PROFILE && LAST_PROFILE.sampled_dist_km) ? LAST_PROFILE.sampled_dist_km : [];
      const sh = Array.isArray(LAST_PROFILE && LAST_PROFILE.sampled_heading_deg) ? LAST_PROFILE.sampled_heading_deg : [];
      if (!sd.length || sh.length !== sd.length) return null;
      const xRoute = Number(dkm);
      if (!Number.isFinite(xRoute)) return null;

      // Distances in LAST_PROFILE.sampled_dist_km are in the profile sampling domain,
      // while callers often pass route-km (based on ROUTE_CUM_DISTS). If these differ,
      // we must scale to index the correct heading.
      let x = xRoute;
      try {
        const profLen = Number(sd[sd.length - 1] || 0);
        const routeLen = (Array.isArray(ROUTE_CUM_DISTS) && ROUTE_CUM_DISTS.length >= 2)
          ? Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0)
          : 0;
        const scale2 = (Number.isFinite(routeLen) && Number.isFinite(profLen) && profLen > 0) ? (routeLen / profLen) : 1;
        if (Number.isFinite(scale2) && scale2 > 0) x = xRoute / scale2;
      } catch (_) {}
      let lo = 0, hi = sd.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (Number(sd[mid]) < x) lo = mid + 1; else hi = mid;
      }
      const routeDir = Number(sh[Math.max(0, Math.min(sh.length - 1, lo))] || 0);
      if (!Number.isFinite(routeDir)) return null;
      // Convert wind "from" to "to" direction (+180°) before projection.
      const wdirTo = ((wdir + 180.0) % 360.0);
      const ang = (wdirTo - routeDir) * Math.PI / 180.0;
      const comp = wspd * Math.cos(ang);
      return Number.isFinite(comp) ? comp : null;
    } catch (_) {
      return null;
    }
  }

  function _tourProjectRouteRibbon(m) {
    try {
      if (!m || !LAST_PROFILE || !Array.isArray(LAST_PROFILE.sampled_points) || !Array.isArray(LAST_PROFILE.sampled_dist_km)) return null;
      const coords = LAST_PROFILE.sampled_points;
      const dists = LAST_PROFILE.sampled_dist_km;
      if (coords.length < 2 || dists.length !== coords.length) return null;
      const out = new Array(coords.length);
      for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        if (!c) continue;
        // Backend profile emits sampled_points as [lon, lat]
        const lon = Array.isArray(c) ? Number(c[0]) : Number(c.lng);
        const lat = Array.isArray(c) ? Number(c[1]) : Number(c.lat);
        const p = m.latLngToContainerPoint([lat, lon]);
        out[i] = { x: Number(p.x), y: Number(p.y), dist: Number(dists[i]) };
      }
      return out.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.dist));
    } catch (_) {
      return null;
    }
  }

  function _dist2PointToSeg(px, py, ax, ay, bx, by) {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const c2 = vx * vx + vy * vy;
    if (!(c2 > 1e-6)) {
      const dx = px - ax;
      const dy = py - ay;
      return { t: 0, x: ax, y: ay, d2: dx * dx + dy * dy };
    }
    let t = (wx * vx + wy * vy) / c2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * vx;
    const qy = ay + t * vy;
    const dx = px - qx;
    const dy = py - qy;
    return { t, x: qx, y: qy, d2: dx * dx + dy * dy };
  }

  function _nearestOnRibbon(x, y, ribbon, lastSegIdx, nearRadiusPx) {
    const rib = ribbon;
    if (!rib || rib.length < 2) return null;
    const nSeg = rib.length - 1;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const center = clamp(Number(lastSegIdx || 0), 0, Math.max(0, nSeg - 1));
    let best = null;
    const scan = (i0, i1) => {
      for (let i = i0; i <= i1; i++) {
        const a = rib[i];
        const b = rib[i + 1];
        if (!a || !b) continue;
        const r = _dist2PointToSeg(x, y, a.x, a.y, b.x, b.y);
        if (!best || r.d2 < best.d2) {
          const d0 = Number(a.dist);
          const d1 = Number(b.dist);
          const dist = (Number.isFinite(d0) && Number.isFinite(d1)) ? (d0 + r.t * (d1 - d0)) : d0;
          best = { dist, d2: r.d2, segIdx: i, qx: r.x, qy: r.y };
        }
      }
    };
    scan(Math.max(0, center - 60), Math.min(nSeg - 1, center + 60));
    // If the local scan yields a segment far away from the cursor,
    // fall back to a full scan. This prevents rare misses when the user
    // jumps to a distant part of the route (lastSegIdx becomes stale).
    try {
      const r = Number(nearRadiusPx);
      if (best && Number.isFinite(r) && r > 0) {
        const limit2 = (r * 3.0) * (r * 3.0); // 3x activation radius
        if (Number(best.d2) > limit2) {
          best = null;
        }
      }
    } catch (_) {}
    if (!best) scan(0, nSeg - 1);
    return best;
  }

  function _offsetRibbonRight(ribbon, offsetPx) {
    try {
      const rib = ribbon;
      const n = rib ? rib.length : 0;
      if (n < 2) return null;
      const off = Number(offsetPx);
      if (!Number.isFinite(off)) return null;
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const p = rib[i];
        const pPrev = rib[Math.max(0, i - 1)];
        const pNext = rib[Math.min(n - 1, i + 1)];
        const dx = Number(pNext.x) - Number(pPrev.x);
        const dy = Number(pNext.y) - Number(pPrev.y);
        const Ls = Math.hypot(dx, dy);
        if (!(Ls > 1e-3)) {
          out[i] = { x: Number(p.x), y: Number(p.y), dist: Number(p.dist) };
          continue;
        }
        const nx = dy / Ls;
        const ny = -dx / Ls;
        out[i] = { x: Number(p.x) + nx * off, y: Number(p.y) + ny * off, dist: Number(p.dist) };
      }
      return out;
    } catch (_) {
      return null;
    }
  }

  function _tourIsActive() {
    try {
      return (document.body && document.body.dataset && document.body.dataset.mode)
        ? (document.body.dataset.mode === 'tour')
        : false;
    } catch (_) {
      return false;
    }
  }

  function _tourWantBands() {
    try {
      return _tourIsActive() && SETTINGS && (String(SETTINGS.weatherVisualizationMode || 'glyphs') === 'bands');
    } catch (_) {
      return false;
    }
  }

  function _tourWindComponentColor(compMs) {
    const v = Number(compMs);
    if (!Number.isFinite(v)) return 'rgba(120,120,120,0.55)';
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    // Faster ramp and higher opacity so the wind lane reads well on a white background.
    const t = clamp(Math.abs(v) / 6.0, 0, 1);
    const lerp = (a, b, u) => Math.round(a + (b - a) * u);
    const base = [190, 190, 190];
    const head = [255, 80, 65];
    const tail = [55, 220, 120];
    const target = (v < 0) ? head : tail;
    const r = lerp(base[0], target[0], t);
    const g = lerp(base[1], target[1], t);
    const b = lerp(base[2], target[2], t);
    const a = 0.92;
    return `rgba(${r},${g},${b},${a})`;
  }

  function _makeTourBandsLayer() {
    const Layer = L.Layer.extend({
      onAdd: function(m) {
        this._map = m;
        // Pane above route vectors, below markers.
        try {
          if (!m.getPane('wmBandsPane')) {
            m.createPane('wmBandsPane');
            m.getPane('wmBandsPane').style.zIndex = '450';
            try { m.getPane('wmBandsPane').classList.add('leaflet-zoom-animated'); } catch (_) {}
          }
        } catch (_) {}

        this._container = L.DomUtil.create('div', 'wm-tour-bands');
        this._container.style.position = 'absolute';
        this._container.style.left = '0';
        this._container.style.top = '0';
        this._container.style.pointerEvents = 'none';

        this._canvasBand = L.DomUtil.create('canvas', '', this._container);
        this._canvasBand.style.position = 'absolute';
        this._canvasBand.style.left = '0';
        this._canvasBand.style.top = '0';
        this._canvasBand.style.width = '100%';
        this._canvasBand.style.height = '100%';
        this._canvasBand.style.zIndex = '1';

        this._canvasWind = L.DomUtil.create('canvas', '', this._container);
        this._canvasWind.style.position = 'absolute';
        this._canvasWind.style.left = '0';
        this._canvasWind.style.top = '0';
        this._canvasWind.style.width = '100%';
        this._canvasWind.style.height = '100%';
        // Wind must never cover the temperature band or rain symbols.
        this._canvasWind.style.zIndex = '0';

        // Legend: use a Leaflet control so it stays screen-fixed during drag.
        this._legendControl = L.control({ position: 'topright' });
        this._legendEl = null;
        this._legendControl.onAdd = () => {
          const el = L.DomUtil.create('div', 'wm-tour-bands-legend');
          el.style.background = 'rgba(255,255,255,0.90)';
          el.style.borderRadius = '10px';
          el.style.padding = '10px';
          el.style.fontSize = '11px';
          el.style.lineHeight = '1.25';
          el.style.color = '#111';
          el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.12)';
          el.style.pointerEvents = 'auto';
          el.innerHTML = `
            <div style="font-weight:600;margin-bottom:6px;">Legend</div>
            <div style="margin-bottom:8px;">
              <div style="font-weight:600;margin-bottom:3px;">Temperature</div>
              <div style="width:160px;height:10px;border-radius:6px;background:linear-gradient(90deg,#963cbe 0%,#005bff 17%,#28a050 58%,#f0dc50 75%,#f59b3c 83%,#d73c2d 92%,#8b0000 100%);"></div>
              <div style="display:flex;justify-content:space-between;margin-top:4px;opacity:0.85;">
                <span>-10</span><span>0</span><span>20</span><span>40 °C</span>
              </div>
            </div>
            <div style="margin-bottom:8px;">
              <div style="font-weight:600;margin-bottom:3px;">Rain</div>
              <div style="display:flex;align-items:center;gap:8px;margin:2px 0;">
                <span style="display:inline-flex;gap:3px;align-items:center;width:44px;">
                  <span style="display:inline-block;width:6px;height:14px;border-radius:3px;background:rgba(35, 120, 210, 0.88);"></span>
                </span>
                <span style="opacity:0.9;">1–3 mm</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;margin:2px 0;">
                <span style="display:inline-flex;gap:3px;align-items:center;width:44px;">
                  <span style="display:inline-block;width:6px;height:14px;border-radius:3px;background:rgba(35, 120, 210, 0.88);"></span>
                  <span style="display:inline-block;width:6px;height:14px;border-radius:3px;background:rgba(35, 120, 210, 0.88);"></span>
                </span>
                <span style="opacity:0.9;">3–8 mm</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;margin:2px 0;">
                <span style="display:inline-flex;gap:3px;align-items:center;width:44px;">
                  <span style="display:inline-block;width:6px;height:14px;border-radius:3px;background:rgba(35, 120, 210, 0.88);"></span>
                  <span style="display:inline-block;width:6px;height:14px;border-radius:3px;background:rgba(35, 120, 210, 0.88);"></span>
                  <span style="display:inline-block;width:6px;height:14px;border-radius:3px;background:rgba(35, 120, 210, 0.88);"></span>
                </span>
                <span style="opacity:0.9;">&gt;8 mm</span>
              </div>
            </div>
            <div>
              <div style="font-weight:600;margin-bottom:3px;">Wind</div>
              <div style="display:flex;align-items:center;gap:8px;margin:2px 0;">
                <span style="display:inline-block;width:28px;height:6px;border-radius:4px;background:rgba(95,174,106,0.80);border:1px solid rgba(255,255,255,0.85);"></span>
                <span style="opacity:0.9;">tailwind</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;margin:2px 0;">
                <span style="display:inline-block;width:28px;height:6px;border-radius:4px;background:rgba(200,106,106,0.80);border:1px solid rgba(255,255,255,0.85);"></span>
                <span style="opacity:0.9;">headwind</span>
              </div>
              <div style="opacity:0.85;">Arrow shows direction</div>
            </div>`;
          try { L.DomEvent.disableClickPropagation(el); } catch (_) {}
          try { L.DomEvent.disableScrollPropagation(el); } catch (_) {}
          this._legendEl = el;
          return el;
        };
        try { this._legendControl.addTo(m); } catch (_) {}

        const pane = (m.getPane && m.getPane('wmBandsPane')) ? m.getPane('wmBandsPane') : m.getPanes().overlayPane;
        pane.appendChild(this._container);

        this._anim = null;
        this._lastAnimTs = null;
        this._windSites = [];
        this._ribbon = null;
        this._pointAtDist = null;
        this._sampleAtDist = null;
        this._bandWidthAtDist = null;
        this._tangentAngleAtDist = null;
        this._tooltip = null;
        this._tipEl = null;
        this._dbgEl = null;
        this._lastTooltipTs = 0;
        this._onMouseMove = null;
        this._onMouseLeave = null;
        this._lastHoverSegIdx = 0;
        this._lastHoverSegIdxRoute = 0;
        this._hoverRouteRibbon = null;
        this._hoverBandRibbon = null;
        this._hoverGeomValid = false;
        this._lastDbgLogTs = 0;

        m.on('moveend zoomend resize', this._reset, this);
        // Tooltip support (hover near band).
        const _mapRect = () => {
          try {
            const c = m && m.getContainer ? m.getContainer() : null;
            return c ? c.getBoundingClientRect() : null;
          } catch (_) {
            return null;
          }
        };
        const _tourDbgEnabled = () => {
          try { return String(localStorage.getItem('wm_debug_tour_tooltip') || '') === '1'; } catch (_) { return false; }
        };
        const _ensureTourDbgEl = () => {
          try {
            if (this._dbgEl) return this._dbgEl;
            if (!_tourDbgEnabled()) return null;
            const el = document.createElement('div');
            el.className = 'wm-tour-bands-debug';
            el.style.position = 'fixed';
            const r = _mapRect();
            el.style.left = `${Math.round((r ? r.left : 0) + 8)}px`;
            el.style.top = `${Math.round((r ? r.top : 0) + 8)}px`;
            el.style.zIndex = '10001';
            el.style.pointerEvents = 'none';
            el.style.padding = '6px 8px';
            el.style.borderRadius = '10px';
            el.style.background = 'rgba(0,0,0,0.55)';
            el.style.color = 'white';
            el.style.font = '11px system-ui, -apple-system, sans-serif';
            el.style.whiteSpace = 'pre';
            el.style.display = 'none';
            try { document.body.appendChild(el); } catch (_) {}
            this._dbgEl = el;
            return el;
          } catch (_) {
            return null;
          }
        };
        const _ensureTipEl = () => {
          if (this._tipEl) return this._tipEl;
          this._tipEl = document.createElement('div');
          this._tipEl.className = 'wm-tour-bands-tip';
          this._tipEl.style.position = 'fixed';
          this._tipEl.style.zIndex = '10000';
          this._tipEl.style.pointerEvents = 'none';
          this._tipEl.style.background = 'rgba(255,255,255,0.97)';
          this._tipEl.style.border = '1px solid rgba(0,0,0,0.14)';
          this._tipEl.style.borderRadius = '10px';
          this._tipEl.style.padding = '8px 10px';
          this._tipEl.style.font = '13px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
          this._tipEl.style.fontWeight = '400';
          this._tipEl.style.lineHeight = '1.28';
          this._tipEl.style.color = '#111';
          this._tipEl.style.boxShadow = '0 2px 10px rgba(0,0,0,0.16)';
          this._tipEl.style.display = 'none';
          this._tipEl.style.maxWidth = '260px';
          // Smooth movement: position with transforms (GPU-friendly) and update at most once per frame.
          this._tipEl.style.left = '0px';
          this._tipEl.style.top = '0px';
          this._tipEl.style.willChange = 'transform';
          this._tipEl.style.transform = 'translate3d(0px, 0px, 0px)';
          try { document.body.appendChild(this._tipEl); } catch (_) {}
          return this._tipEl;
        };

        const _scheduleTipPos = (leftPx, topPx) => {
          try {
            this._tipNextLeft = Number(leftPx);
            this._tipNextTop = Number(topPx);
            if (this._tipPosRaf) return;
            this._tipPosRaf = requestAnimationFrame(() => {
              this._tipPosRaf = 0;
              const el = this._tipEl;
              if (!el) return;
              const x2 = Number(this._tipNextLeft);
              const y2 = Number(this._tipNextTop);
              if (!Number.isFinite(x2) || !Number.isFinite(y2)) return;
              el.style.transform = `translate3d(${x2}px, ${y2}px, 0px)`;
            });
          } catch (_) {}
        };

        this._onMouseMove = (e) => {
          const dbg = _tourDbgEnabled();
          const dbgEl = _ensureTourDbgEl();
          let dbgText = '';
          try {
            if (dbgEl && dbg) {
              const r = _mapRect();
              if (r) {
                dbgEl.style.left = `${Math.round(r.left + 8)}px`;
                dbgEl.style.top = `${Math.round(r.top + 8)}px`;
              }
            }
            // Tooltip should work in Tour Planning mode even when bands are off.
            if (!_tourIsActive()) {
              try { if (this._tipEl) this._tipEl.style.display = 'none'; } catch (_) {}
              try { m.getContainer().style.cursor = ''; } catch (_) {}
              if (dbgEl && dbg) { dbgEl.style.display = 'block'; dbgEl.textContent = 'TOUR tooltip: not in tour mode'; }
              return;
            }
            // Ensure we have some route geometry to hit-test.
            const wantBandHover = _tourWantBands() && TOUR_BANDS_ENABLED;
            if (!this._hoverGeomValid) {
              try {
                const rr = _tourProjectRouteRibbon(m);
                this._hoverRouteRibbon = rr;
                // Match draw() offset: TEMP_BAND_WIDTH_PX=8 => bandOffsetPx = 8*0.5 + 6 = 10
                this._hoverBandRibbon = (wantBandHover && rr) ? _offsetRibbonRight(rr, 10) : null;
                this._hoverGeomValid = true;
              } catch (_) {
                this._hoverRouteRibbon = null;
                this._hoverBandRibbon = null;
                this._hoverGeomValid = true;
              }
            }
            const haveRoute = !!(this._hoverRouteRibbon && this._hoverRouteRibbon.length >= 2);
            const haveBand = !!(wantBandHover && this._hoverBandRibbon && this._hoverBandRibbon.length >= 2);
            if (!haveRoute && !haveBand) {
              try { if (this._tipEl) this._tipEl.style.display = 'none'; } catch (_) {}
              try { m.getContainer().style.cursor = ''; } catch (_) {}
              if (dbgEl && dbg) {
                dbgEl.style.display = 'block';
                dbgEl.textContent = 'TOUR tooltip: no route/band geometry yet';
              }
              return;
            }
            const cp = (e && e.containerPoint) ? e.containerPoint : null;
            const x = cp ? Number(cp.x) : NaN;
            const y = cp ? Number(cp.y) : NaN;
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;

            let latlng = null;
            try { latlng = (e && e.latlng) ? e.latlng : m.containerPointToLatLng(cp); } catch (_) {}

            const thrPx = Math.max(8, Math.min(200, _mmToPx(10)));

            if (dbgEl && dbg) {
              dbgEl.style.display = 'block';
              dbgText += `mousemove @ ${Math.round(x)},${Math.round(y)}\n`;
            } else if (dbgEl) {
              dbgEl.style.display = 'none';
            }

            // Hit-test against both the GPX route centerline and the temperature band.
            const bestBand = haveBand ? _nearestOnRibbon(x, y, this._hoverBandRibbon, this._lastHoverSegIdx, thrPx) : null;
            const bestRoute = haveRoute ? _nearestOnRibbon(x, y, this._hoverRouteRibbon, this._lastHoverSegIdxRoute, thrPx) : null;
            let best = null;
            let bestType = null;
            if (bestBand && bestRoute) {
              if (bestBand.d2 <= bestRoute.d2) { best = bestBand; bestType = 'band'; } else { best = bestRoute; bestType = 'route'; }
            } else if (bestBand) {
              best = bestBand; bestType = 'band';
            } else if (bestRoute) {
              best = bestRoute; bestType = 'route';
            }
            if (!best || !Number.isFinite(best.dist)) {
              try { if (this._tooltip && this._tooltip._map) m.removeLayer(this._tooltip); } catch (_) {}
              try { if (this._tipEl) this._tipEl.style.display = 'none'; } catch (_) {}
              if (dbgEl && dbg) { dbgEl.textContent = dbgText + 'no best segment'; }
              return;
            }
            if (bestType === 'band') this._lastHoverSegIdx = Number.isFinite(best.segIdx) ? best.segIdx : this._lastHoverSegIdx;
            if (bestType === 'route') this._lastHoverSegIdxRoute = Number.isFinite(best.segIdx) ? best.segIdx : this._lastHoverSegIdxRoute;

            const dPx = Math.sqrt(Number(best.d2) || 0);
            const dBandPx = bestBand ? Math.sqrt(Number(bestBand.d2) || 0) : null;
            const dRoutePx = bestRoute ? Math.sqrt(Number(bestRoute.d2) || 0) : null;

            if (dPx > thrPx) {
              try { if (this._tooltip && this._tooltip._map) m.removeLayer(this._tooltip); } catch (_) {}
              try { if (this._tipEl) this._tipEl.style.display = 'none'; } catch (_) {}
              try { m.getContainer().style.cursor = ''; } catch (_) {}
              if (dbgEl && dbg) {
                dbgEl.textContent = dbgText +
                  `latlng=${latlng ? (latlng.lat.toFixed(5) + ',' + latlng.lng.toFixed(5)) : '-'}\n` +
                  `dRoute=${dRoutePx===null?'-':Math.round(dRoutePx)}px dBand=${dBandPx===null?'-':Math.round(dBandPx)}px thr=${Math.round(thrPx)}px\n` +
                  `outside activation (${bestType} d=${Math.round(dPx)}px)`;
              }
              return;
            }

            // Avoid the question-mark cursor; still show tooltip.
            try { m.getContainer().style.cursor = 'pointer'; } catch (_) {}

            const s = (this._sampleAtDist && typeof this._sampleAtDist === 'function')
              ? (this._sampleAtDist(best.dist) || _tourSampleAtDist(best.dist))
              : _tourSampleAtDist(best.dist);
            // If sampling hasn't arrived yet for this distance, keep a small placeholder
            // so the user can tell they're within activation range.
            const haveSample = !!s;

            const dayIdx = _tourDayIndexAtDist(best.dist);
            const dateStr = _tourDateStrForDayIdx(dayIdx);

            const t = haveSample ? Number(s.temperature) : NaN;
            const histLo = haveSample ? Number(s.temp_hist_p25) : NaN;
            const histHi = haveSample ? Number(s.temp_hist_p75) : NaN;
            const dayLo = haveSample ? Number(s.temp_day_p25) : NaN;
            const dayHi = haveSample ? Number(s.temp_day_p75) : NaN;
            const typicalLo = (Number.isFinite(histLo) && Number.isFinite(histHi)) ? histLo : (Number.isFinite(dayLo) ? dayLo : null);
            const typicalHi = (Number.isFinite(histLo) && Number.isFinite(histHi)) ? histHi : (Number.isFinite(dayHi) ? dayHi : null);
            const iqr = (Number.isFinite(typicalLo) && Number.isFinite(typicalHi)) ? (typicalHi - typicalLo) : null;
            const warmHint = (Number.isFinite(iqr) && iqr >= 7)
              ? (Number(typicalHi) + 0.5 * Number(iqr))
              : null;
            const coldHint = (Number.isFinite(iqr) && iqr >= 7)
              ? (Number(typicalLo) - 0.5 * Number(iqr))
              : null;

            const mm = haveSample ? Number(s.rainTypical) : NaN;
            const rainP = haveSample ? Number(s.rainProb) : NaN;
            const rainLo = haveSample ? Number(s.rain_hist_p25_mm) : NaN;
            const rainHi = haveSample ? Number(s.rain_hist_p75_mm) : NaN;
            const rainP90 = haveSample ? Number(s.rain_hist_p90_mm) : NaN;
            const rainSpanLo = (Number.isFinite(rainLo) && Number.isFinite(rainHi)) ? rainLo : null;
            const rainSpanHi = (Number.isFinite(rainLo) && Number.isFinite(rainHi)) ? rainHi : null;
            const rainSomeYears = (Number.isFinite(rainP90) && Number.isFinite(rainSpanHi)) ? rainP90 : null;

            const comp = haveSample ? _tourEffectiveWind(s, best.dist) : null;
            const wspd = haveSample ? Number(s.windSpeed) : NaN;
            const wdir = haveSample ? Number(s.windDir) : NaN;
            const windTxt = (Number.isFinite(wspd) && Number.isFinite(wdir) && Number.isFinite(comp))
              ? `${wspd.toFixed(1)} m/s @ ${Math.round(wdir)}° (${(comp >= 0) ? 'tailwind' : 'headwind'} ${Math.abs(comp).toFixed(1)} m/s)`
              : (Number.isFinite(wspd) && Number.isFinite(wdir))
                ? `${wspd.toFixed(1)} m/s @ ${Math.round(wdir)}°`
                : (Number.isFinite(comp)
                  ? `${(comp >= 0) ? 'tailwind' : 'headwind'} ${Math.abs(comp).toFixed(1)} m/s`
                  : '—');

            const yearsTxt = (Number.isFinite(Number(s.yearsStart)) && Number.isFinite(Number(s.yearsEnd)))
              ? `${Math.round(Number(s.yearsStart))}–${Math.round(Number(s.yearsEnd))}`
              : null;
            const nTxt = Number.isFinite(Number(s.matchDays)) ? ` (n=${Math.round(Number(s.matchDays))})` : '';

            const whichTxt = (bestType === 'band' && wantBandHover) ? 'temperature band' : 'route';
            const htmlKey = `${Math.round(best.dist * 10) / 10}|${dayIdx}|${wantBandHover ? 'b' : 'r'}|${haveSample ? '1' : '0'}`;
            const html = haveSample ? `
              <div style="margin-bottom:2px;">Day ${dayIdx + 1} — ${dateStr}</div>
              <div style="opacity:0.85;margin-bottom:4px;">${Math.round(best.dist)} km • ${whichTxt}</div>
              <div>Temp: ${Number.isFinite(t) ? Math.round(t) : '—'}°C</div>
              ${(Number.isFinite(typicalLo) && Number.isFinite(typicalHi))
                ? `<div style="opacity:0.90;">Typical: ${Math.round(typicalLo)}–${Math.round(typicalHi)}°C</div>`
                : ''}
              ${(Number.isFinite(warmHint) && Number.isFinite(typicalHi) && (warmHint - typicalHi) >= 3)
                ? `<div style="opacity:0.85;">Warm years: up to about ${Math.round(warmHint)}°C</div>`
                : ''}
              ${(Number.isFinite(coldHint) && Number.isFinite(typicalLo) && (typicalLo - coldHint) >= 3)
                ? `<div style="opacity:0.85;">Cold years: down to about ${Math.round(coldHint)}°C</div>`
                : ''}
              <div>Wind: ${windTxt}</div>
              <div>Rain: ${Number.isFinite(mm) ? `${mm.toFixed(1)} mm` : '—'}${Number.isFinite(rainP) ? ` (p=${Math.round(rainP * 100)}%)` : ''}</div>
              ${(Number.isFinite(rainSpanLo) && Number.isFinite(rainSpanHi))
                ? `<div style="opacity:0.90;">Typical: ${rainSpanLo.toFixed(1)}–${rainSpanHi.toFixed(1)} mm</div>`
                : ''}
              ${(Number.isFinite(rainSomeYears) && Number.isFinite(rainSpanHi) && (rainSomeYears - rainSpanHi) >= 1.5 && rainSomeYears >= 2.0)
                ? `<div style="opacity:0.85;">Some years: up to about ${rainSomeYears.toFixed(1)} mm</div>`
                : ''}
              ${yearsTxt ? `<div style="opacity:0.75;margin-top:4px;">Years: ${yearsTxt}${nTxt}</div>` : ''}
            ` : `
              <div style="margin-bottom:2px;">Day ${dayIdx + 1} — ${dateStr}</div>
              <div style="opacity:0.85;margin-bottom:4px;">${Math.round(best.dist)} km • ${whichTxt}</div>
              <div style="opacity:0.85;">Loading weather…</div>
            `;

            const tipEl = _ensureTipEl();
            if (tipEl._wmLastHtmlKey !== htmlKey || tipEl._wmLastHtml !== html) {
              tipEl._wmLastHtmlKey = htmlKey;
              tipEl._wmLastHtml = html;
              tipEl.innerHTML = html;
              // Cache size to reduce layout thrash during mousemove.
              try {
                this._tipW = tipEl.offsetWidth || this._tipW;
                this._tipH = tipEl.offsetHeight || this._tipH;
              } catch (_) {}
            }
            tipEl.style.display = 'block';

            // Positioning: prefer above cursor; flip below if needed; clamp to map container.
            const cont = m.getContainer();
            const rect = cont ? cont.getBoundingClientRect() : null;
            const cw = cont ? cont.clientWidth : 0;
            const ch = cont ? cont.clientHeight : 0;
            const pad = 8;
            const baseLeft = (rect ? rect.left : 0) + x;
            const baseTop = (rect ? rect.top : 0) + y;
            let left = (baseLeft + 14);
            let top = (baseTop - 12);
            const tw = Number(this._tipW || tipEl.offsetWidth || 0);
            const th = Number(this._tipH || tipEl.offsetHeight || 0);
            // place above
            top = (baseTop - 12 - th);
            // flip below if clipped
            if (ch && rect && (top < (rect.top + pad))) top = (baseTop + 18);
            // clamp
            if (cw && rect && (left + tw + pad) > (rect.left + cw)) left = Math.max(rect.left + pad, rect.left + cw - tw - pad);
            if (cw && rect && left < (rect.left + pad)) left = rect.left + pad;
            if (ch && rect && (top + th + pad) > (rect.top + ch)) top = Math.max(rect.top + pad, rect.top + ch - th - pad);
            if (ch && rect && top < (rect.top + pad)) top = rect.top + pad;
            _scheduleTipPos(left, top);

            if (dbgEl && dbg) {
              dbgEl.textContent = dbgText +
                `latlng=${latlng ? (latlng.lat.toFixed(5) + ',' + latlng.lng.toFixed(5)) : '-'}\n` +
                `dRoute=${dRoutePx===null?'-':Math.round(dRoutePx)}px dBand=${dBandPx===null?'-':Math.round(dBandPx)}px thr=${Math.round(thrPx)}px\n` +
                `pick=${bestType} km=${best.dist.toFixed(1)} d=${Math.round(dPx)}px\n` +
                `show tip @ ${Math.round(left)},${Math.round(top)}`;
              try {
                const now2 = Date.now();
                if ((now2 - (this._lastDbgLogTs || 0)) > 600) {
                  this._lastDbgLogTs = now2;
                  console.log('[TOUR hover]', {
                    x: Math.round(x), y: Math.round(y),
                    lat: latlng ? Number(latlng.lat.toFixed(6)) : null,
                    lon: latlng ? Number(latlng.lng.toFixed(6)) : null,
                    dRoutePx: dRoutePx === null ? null : Math.round(dRoutePx),
                    dBandPx: dBandPx === null ? null : Math.round(dBandPx),
                    thrPx: Math.round(thrPx),
                    pick: bestType,
                    km: Number(best.dist.toFixed(2)),
                  });
                }
              } catch (_) {}
            }
          } catch (err) {
            if (dbg) {
              try { console.error('TOUR tooltip mousemove failed', err); } catch (_) {}
              try { if (dbgEl) { dbgEl.style.display = 'block'; dbgEl.textContent = (dbgText ? (dbgText + '\n') : '') + 'ERROR: ' + String(err && (err.message || err)); } } catch (_) {}
            }
          }
        };
        this._onMouseLeave = () => {
          try { if (this._tooltip && this._tooltip._map) m.removeLayer(this._tooltip); } catch (_) {}
          try { if (this._tipEl) this._tipEl.style.display = 'none'; } catch (_) {}
          try { m.getContainer().style.cursor = ''; } catch (_) {}
        };
        m.on('mousemove', this._onMouseMove);
        try { m.getContainer().addEventListener('mouseleave', this._onMouseLeave); } catch (_) {}
        this._reset();
      },
      onRemove: function(m) {
        m.off('moveend zoomend resize', this._reset, this);
        try { if (this._onMouseMove) m.off('mousemove', this._onMouseMove); } catch (_) {}
        try { if (this._onMouseLeave) m.getContainer().removeEventListener('mouseleave', this._onMouseLeave); } catch (_) {}
        try { if (this._tooltip && this._tooltip._map) m.removeLayer(this._tooltip); } catch (_) {}
        try { if (this._tipEl) this._tipEl.remove(); } catch (_) {}
        this._tipEl = null;
        try { if (this._tipPosRaf) cancelAnimationFrame(this._tipPosRaf); } catch (_) {}
        this._tipPosRaf = 0;
        try { if (this._dbgEl) this._dbgEl.remove(); } catch (_) {}
        this._dbgEl = null;
        try { if (this._legendControl) m.removeControl(this._legendControl); } catch (_) {}
        this._legendControl = null;
        this._legendEl = null;
        try { if (this._anim) cancelAnimationFrame(this._anim); } catch (_) {}
        try { this._container && this._container.remove(); } catch (_) {}
        this._map = null;
      },
      _reset: function() {
        if (!this._map || !this._container) return;
        const topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._container, topLeft);
        const size = this._map.getSize();
        const dpr = (window.devicePixelRatio || 1);
        this._container.style.width = `${size.x}px`;
        this._container.style.height = `${size.y}px`;
        this._canvasBand.width = Math.max(1, Math.floor(size.x * dpr));
        this._canvasBand.height = Math.max(1, Math.floor(size.y * dpr));
        this._canvasWind.width = Math.max(1, Math.floor(size.x * dpr));
        this._canvasWind.height = Math.max(1, Math.floor(size.y * dpr));
        // Invalidate hover geometry; it depends on pixel projection.
        this._hoverGeomValid = false;
        try { _scheduleTourBandsRedraw(); } catch (_) {}
      },
      clear: function() {
        try { if (this._anim) cancelAnimationFrame(this._anim); } catch (_) {}
        this._anim = null;
        this._lastAnimTs = null;
        this._windSites = [];
        this._ribbon = null;
        this._pointAtDist = null;
        this._sampleAtDist = null;
        this._bandWidthAtDist = null;
        this._tangentAngleAtDist = null;
        try { if (this._tooltip && this._tooltip._map && this._map) this._map.removeLayer(this._tooltip); } catch (_) {}
        try { if (this._tipEl) this._tipEl.style.display = 'none'; } catch (_) {}
        try { if (this._legendEl) this._legendEl.style.display = 'none'; } catch (_) {}
        const c1 = this._canvasBand.getContext('2d');
        if (c1) {
          c1.setTransform(1, 0, 0, 1, 0, 0);
          c1.clearRect(0, 0, this._canvasBand.width, this._canvasBand.height);
        }
        const c2 = this._canvasWind.getContext('2d');
        if (c2) {
          c2.setTransform(1, 0, 0, 1, 0, 0);
          c2.clearRect(0, 0, this._canvasWind.width, this._canvasWind.height);
        }
      },
      draw: function(profile, points) {
        if (!this._map) return;
        const m = this._map;
        const ctx = this._canvasBand.getContext('2d');
        const windCtx = this._canvasWind.getContext('2d');
        if (!ctx || !windCtx) return;

        if (!TOUR_BANDS_ENABLED) {
          try { this._container.style.display = 'none'; } catch (_) {}
          this.clear();
          return;
        }
        try { this._container.style.display = 'block'; } catch (_) {}
        try { if (this._legendEl) this._legendEl.style.display = 'block'; } catch (_) {}

        if (!profile || !Array.isArray(profile.sampled_points) || !Array.isArray(profile.sampled_dist_km)) {
          this.clear();
          return;
        }
        const coords = profile.sampled_points;
        const dists = profile.sampled_dist_km;
        if (coords.length < 2 || dists.length !== coords.length) {
          this.clear();
          return;
        }
        const pts = Array.isArray(points) ? points.slice() : [];
        pts.sort((a, b) => Number(a.dist) - Number(b.dist));
        if (!pts.length) {
          this.clear();
          return;
        }

        // Progressive rendering: only draw where we have station data.
        const routeLenAll = Number(dists[dists.length - 1] || 0);
        const ptsMinDist = Number(pts[0].dist);
        const ptsMaxDist = Number(pts[pts.length - 1].dist);
        const havePtsRange = Number.isFinite(ptsMinDist) && Number.isFinite(ptsMaxDist) && ptsMaxDist >= ptsMinDist;
        const drawStartKm = havePtsRange ? Math.max(0, Math.min(routeLenAll, ptsMinDist)) : 0;
        const drawEndKm = havePtsRange ? Math.max(0, Math.min(routeLenAll, ptsMaxDist)) : 0;

        const z = Number(m.getZoom());
        if (z < 5) {
          this.clear();
          return;
        }

        const dpr = (window.devicePixelRatio || 1);
        const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
        const lerp = (a, b, t) => a + (b - a) * t;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this._canvasBand.width, this._canvasBand.height);
        ctx.scale(dpr, dpr);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        windCtx.setTransform(1, 0, 0, 1, 0, 0);
        windCtx.clearRect(0, 0, this._canvasWind.width, this._canvasWind.height);
        windCtx.scale(dpr, dpr);

        // Spec parameters
        // Temperature band width: fixed (~2mm on typical displays) per latest UX request.
        // Use a constant pixel width to remove variability from percentile spread.
        const TEMP_BAND_WIDTH_PX = 8;
        // Small, deterministic offset so the GPX route stays readable.
        // Keep the near band edge ~6px away from the route.
        const bandOffsetPx = (TEMP_BAND_WIDTH_PX * 0.5) + 6;
        const stride = (z >= 12) ? 1 : ((z >= 9) ? 2 : 3);
        // Less aggressive simplification at higher zoom to avoid geometric kinks.
        const simplifyEps = clamp(10 - (z - 6) * 1.6, 1.5, 10);
        const crSubdiv = (z >= 13) ? 4 : ((z >= 11) ? 5 : 7);

        // Temperature palette: MUST match the profile overlay scale exactly.
        const tempColorSpec = (t) => {
          try { return tempColor(Number(t)); } catch (_) { return 'rgba(153,153,153,1)'; }
        };

        // RDP simplification
        const rdpSimplify = (arr, eps) => {
          if (!arr || arr.length < 3) return arr || [];
          const e2 = Number(eps) * Number(eps);
          const keep = new Array(arr.length).fill(false);
          keep[0] = true;
          keep[arr.length - 1] = true;
          const dist2PointToSegment = (p, a, b) => {
            const vx = b.x - a.x;
            const vy = b.y - a.y;
            const wx = p.x - a.x;
            const wy = p.y - a.y;
            const c1 = vx * wx + vy * wy;
            if (c1 <= 0) {
              const dx = p.x - a.x; const dy = p.y - a.y;
              return dx*dx + dy*dy;
            }
            const c2 = vx * vx + vy * vy;
            if (c2 <= c1) {
              const dx = p.x - b.x; const dy = p.y - b.y;
              return dx*dx + dy*dy;
            }
            const t = c1 / c2;
            const px = a.x + t * vx;
            const py = a.y + t * vy;
            const dx = p.x - px;
            const dy = p.y - py;
            return dx*dx + dy*dy;
          };
          const stack = [[0, arr.length - 1]];
          while (stack.length) {
            const [i0, i1] = stack.pop();
            let bestI = -1;
            let bestD2 = -1;
            const a = arr[i0];
            const b = arr[i1];
            for (let i = i0 + 1; i < i1; i++) {
              const d2 = dist2PointToSegment(arr[i], a, b);
              if (d2 > bestD2) { bestD2 = d2; bestI = i; }
            }
            if (bestI >= 0 && bestD2 > e2) {
              keep[bestI] = true;
              stack.push([i0, bestI]);
              stack.push([bestI, i1]);
            }
          }
          const out = [];
          for (let i = 0; i < arr.length; i++) if (keep[i]) out.push(arr[i]);
          return out;
        };

        // Catmull–Rom spline smoothing (geometry only; keep dist monotonic by linear interpolation).
        const chaikinSmooth = (arr, iters) => {
          let out = arr || [];
          let k = Math.max(0, Math.floor(Number(iters) || 0));
          while (k-- > 0 && out.length >= 3) {
            const next = [out[0]];
            for (let i = 0; i < out.length - 1; i++) {
              const p = out[i];
              const q = out[i + 1];
              next.push(
                {
                  x: 0.75 * p.x + 0.25 * q.x,
                  y: 0.75 * p.y + 0.25 * q.y,
                  dist: 0.75 * Number(p.dist) + 0.25 * Number(q.dist),
                },
                {
                  x: 0.25 * p.x + 0.75 * q.x,
                  y: 0.25 * p.y + 0.75 * q.y,
                  dist: 0.25 * Number(p.dist) + 0.75 * Number(q.dist),
                }
              );
            }
            next.push(out[out.length - 1]);
            out = next;
          }
          return out;
        };
        const catmullRom = (arr, subdiv) => {
          const n = arr ? arr.length : 0;
          if (n < 4) return arr || [];
          const out = [arr[0]];
          const s = Math.max(1, Math.floor(Number(subdiv) || 1));
          const crXY = (p0, p1, p2, p3, t) => {
            const t2 = t * t;
            const t3 = t2 * t;
            const a0 = -0.5*t3 + t2 - 0.5*t;
            const a1 =  1.5*t3 - 2.5*t2 + 1.0;
            const a2 = -1.5*t3 + 2.0*t2 + 0.5*t;
            const a3 =  0.5*t3 - 0.5*t2;
            return {
              x: a0*p0.x + a1*p1.x + a2*p2.x + a3*p3.x,
              y: a0*p0.y + a1*p1.y + a2*p2.y + a3*p3.y,
            };
          };
          for (let i = 0; i < n - 3; i++) {
            const p0 = arr[i];
            const p1 = arr[i + 1];
            const p2 = arr[i + 2];
            const p3 = arr[i + 3];
            for (let j = 1; j <= s; j++) {
              const t = j / (s + 1);
              const q = crXY(p0, p1, p2, p3, t);
              q.dist = Number(p1.dist) + t * (Number(p2.dist) - Number(p1.dist));
              out.push(q);
            }
            out.push(p2);
          }
          out.push(arr[n - 1]);
          return out;
        };

        const sampleAt = (dkm) => {
          const x = Number(dkm);
          if (!Number.isFinite(x) || pts.length === 0) return null;

          // Do not extrapolate beyond what has been downloaded.
          // This avoids an immediate full-length (but wrong) redraw early in SSE.
          if (havePtsRange && (x < (drawStartKm - 1e-6) || x > (drawEndKm + 1e-6))) return null;

          const asSample = (p, distOverride) => {
            const dist = Number.isFinite(Number(distOverride)) ? Number(distOverride) : Number(p && p.dist);
            const histMedian = (p && (p.temp_hist_median !== undefined)) ? Number(p.temp_hist_median) : null;
            const histMin = (p && (p.temp_hist_min !== undefined)) ? Number(p.temp_hist_min) : null;
            const histMax = (p && (p.temp_hist_max !== undefined)) ? Number(p.temp_hist_max) : null;
            const histP25 = (p && (p.temp_hist_p25 !== undefined)) ? Number(p.temp_hist_p25) : null;
            const histP75 = (p && (p.temp_hist_p75 !== undefined)) ? Number(p.temp_hist_p75) : null;
            const dayTypicalMin = (p && (p.temp_day_typical_min !== undefined)) ? Number(p.temp_day_typical_min) : null;
            const dayTypicalMax = (p && (p.temp_day_typical_max !== undefined)) ? Number(p.temp_day_typical_max) : null;
            const dayP25 = (p && (p.temp_day_p25 !== undefined)) ? Number(p.temp_day_p25) : null;
            const dayP75 = (p && (p.temp_day_p75 !== undefined)) ? Number(p.temp_day_p75) : null;
            const p25 = (Number.isFinite(dayP25) && Number.isFinite(dayP75)) ? dayP25 : (Number.isFinite(histP25) ? histP25 : null);
            const p75 = (Number.isFinite(dayP25) && Number.isFinite(dayP75)) ? dayP75 : (Number.isFinite(histP75) ? histP75 : null);
            return {
              dist,
              temperature: (p && (p.temperature !== undefined)) ? Number(p.temperature) : null,
              temp_hist_median: Number.isFinite(histMedian) ? histMedian : null,
              temp_hist_min: Number.isFinite(histMin) ? histMin : null,
              temp_hist_max: Number.isFinite(histMax) ? histMax : null,
              temp_p25: p25,
              temp_p75: p75,
              temp_hist_p25: Number.isFinite(histP25) ? histP25 : null,
              temp_hist_p75: Number.isFinite(histP75) ? histP75 : null,
              temp_day_typical_min: Number.isFinite(dayTypicalMin) ? dayTypicalMin : null,
              temp_day_typical_max: Number.isFinite(dayTypicalMax) ? dayTypicalMax : null,
              temp_day_p25: Number.isFinite(dayP25) ? dayP25 : null,
              temp_day_p75: Number.isFinite(dayP75) ? dayP75 : null,
              windSpeed: (p && (p.windSpeed !== undefined)) ? Number(p.windSpeed) : null,
              windDir: (p && (p.windDir !== undefined)) ? Number(p.windDir) : null,
              rainProb: (p && (p.rainProb !== undefined)) ? Number(p.rainProb) : null,
              rainTypical: (p && (p.rainTypical !== undefined)) ? Number(p.rainTypical) : ((p && (p.precipMm !== undefined)) ? Number(p.precipMm) : null),
              rain_hist_p25_mm: (p && (p.rain_hist_p25_mm !== undefined)) ? Number(p.rain_hist_p25_mm) : null,
              rain_hist_p75_mm: (p && (p.rain_hist_p75_mm !== undefined)) ? Number(p.rain_hist_p75_mm) : null,
              rain_hist_p90_mm: (p && (p.rain_hist_p90_mm !== undefined)) ? Number(p.rain_hist_p90_mm) : null,
              yearsStart: (p && (p.yearsStart !== undefined)) ? Number(p.yearsStart) : null,
              yearsEnd: (p && (p.yearsEnd !== undefined)) ? Number(p.yearsEnd) : null,
              matchDays: (p && (p.matchDays !== undefined)) ? Number(p.matchDays) : null,
            };
          };

          if (pts.length === 1) return asSample(pts[0], x);
          let lo = 0, hi = pts.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (Number(pts[mid].dist) <= x) lo = mid; else hi = mid - 1;
          }
          const i0 = lo;
          const i1 = Math.min(pts.length - 1, i0 + 1);
          const p0 = pts[i0];
          const p1 = pts[i1];
          const d0 = Number(p0.dist);
          const d1 = Number(p1.dist);
          if (!Number.isFinite(d0) || !Number.isFinite(d1) || d1 <= d0) return asSample(p0, x);
          const t = clamp((x - d0) / (d1 - d0), 0, 1);
          const lerpNum = (a, b) => (Number.isFinite(Number(a)) && Number.isFinite(Number(b)))
            ? lerp(Number(a), Number(b), t)
            : (Number.isFinite(Number(a)) ? Number(a) : (Number.isFinite(Number(b)) ? Number(b) : null));
          // Keep both historical (multi-year) and ride-window spreads for the tooltip.
          const histP25 = lerpNum(p0.temp_hist_p25, p1.temp_hist_p25);
          const histP75 = lerpNum(p0.temp_hist_p75, p1.temp_hist_p75);
          const histMedian = lerpNum(p0.temp_hist_median, p1.temp_hist_median);
          const histMin = lerpNum(p0.temp_hist_min, p1.temp_hist_min);
          const histMax = lerpNum(p0.temp_hist_max, p1.temp_hist_max);
          const dayTypicalMin = lerpNum(p0.temp_day_typical_min, p1.temp_day_typical_min);
          const dayTypicalMax = lerpNum(p0.temp_day_typical_max, p1.temp_day_typical_max);
          const dayP25 = lerpNum(p0.temp_day_p25, p1.temp_day_p25);
          const dayP75 = lerpNum(p0.temp_day_p75, p1.temp_day_p75);
          // Backwards-compatible fields used elsewhere: prefer daytime if available.
          const p25 = (Number.isFinite(dayP25) && Number.isFinite(dayP75)) ? dayP25 : histP25;
          const p75 = (Number.isFinite(dayP25) && Number.isFinite(dayP75)) ? dayP75 : histP75;
          return {
            dist: x,
            temperature: lerpNum(p0.temperature, p1.temperature),
            temp_hist_median: histMedian,
            temp_hist_min: histMin,
            temp_hist_max: histMax,
            // Prefer ride-window (daytime) spread; fall back to historical spread.
            temp_p25: p25,
            temp_p75: p75,
            // Explicit spreads for tooltip copy.
            temp_hist_p25: histP25,
            temp_hist_p75: histP75,
            temp_day_typical_min: dayTypicalMin,
            temp_day_typical_max: dayTypicalMax,
            temp_day_p25: dayP25,
            temp_day_p75: dayP75,
            windSpeed: lerpNum(p0.windSpeed, p1.windSpeed),
            windDir: lerpNum(p0.windDir, p1.windDir),
            rainProb: lerpNum(p0.rainProb, p1.rainProb),
            rainTypical: lerpNum((p0.rainTypical ?? p0.precipMm), (p1.rainTypical ?? p1.precipMm)),
            rain_hist_p25_mm: lerpNum(p0.rain_hist_p25_mm, p1.rain_hist_p25_mm),
            rain_hist_p75_mm: lerpNum(p0.rain_hist_p75_mm, p1.rain_hist_p75_mm),
            rain_hist_p90_mm: lerpNum(p0.rain_hist_p90_mm, p1.rain_hist_p90_mm),
            yearsStart: (p0.yearsStart ?? p1.yearsStart ?? null),
            yearsEnd: (p0.yearsEnd ?? p1.yearsEnd ?? null),
            matchDays: (p0.matchDays ?? p1.matchDays ?? null),
          };
        };

        const routeHeadingAt = (dkm) => {
          const sh = Array.isArray(profile.sampled_heading_deg) ? profile.sampled_heading_deg : null;
          if (!sh || sh.length !== dists.length) return null;
          const x = Number(dkm);
          if (!Number.isFinite(x)) return null;
          let lo = 0, hi = dists.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (Number(dists[mid]) < x) lo = mid + 1; else hi = mid;
          }
          const idx = clamp(lo, 0, sh.length - 1);
          const h = Number(sh[idx]);
          return Number.isFinite(h) ? h : null;
        };

        const windComponentAt = (sample, routeHeadingDeg) => {
          if (!sample) return null;
          const wspd = Number(sample.windSpeed);
          const wdir = Number(sample.windDir);
          const rh = Number(routeHeadingDeg);
          if (!Number.isFinite(wspd) || !Number.isFinite(wdir) || !Number.isFinite(rh)) return null;
          const wto = (wdir + 180.0) % 360.0;
          const ang = (wto - rh) * Math.PI / 180.0;
          return wspd * Math.cos(ang);
        };

        const llAtIdx = (i) => {
          const c = coords[i];
          if (!c || c.length < 2) return null;
          const lon = Number(c[0]);
          const lat = Number(c[1]);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          return [lat, lon];
        };

        // Build display polyline and dedupe by distance.
        const display = [];
        let lastD = -1e99;
        for (let i = 0; i < coords.length; i += stride) {
          const dk = Number(dists[i]);
          if (!Number.isFinite(dk) || dk <= lastD) continue;
          const ll = llAtIdx(i);
          if (!ll) continue;
          const p = m.latLngToContainerPoint(ll);
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
          display.push({ x: p.x, y: p.y, dist: dk });
          lastD = dk;
        }
        if (display.length < 2) {
          this.clear();
          return;
        }

        // Smooth route pipeline (spec): RDP simplify -> Catmull-Rom -> resample (~1 km)
        let ribbon = rdpSimplify(display, simplifyEps);
        if (ribbon.length >= 4) ribbon = catmullRom(ribbon, crSubdiv);
        const resampleByDist = (arr, stepKm) => {
          try {
            const step = Math.max(0.25, Number(stepKm) || 1.0);
            if (!arr || arr.length < 2) return arr || [];
            const dEnd = Number(arr[arr.length - 1].dist);
            if (!Number.isFinite(dEnd) || dEnd <= 0) return arr;
            const out = [];
            let i = 0;
            const lerpPt = (a, b, u) => ({
              x: Number(a.x) + (Number(b.x) - Number(a.x)) * u,
              y: Number(a.y) + (Number(b.y) - Number(a.y)) * u,
            });
            for (let d = 0; d <= dEnd; d += step) {
              while (i < arr.length - 2 && Number(arr[i + 1].dist) < d) i++;
              const a = arr[i];
              const b = arr[Math.min(arr.length - 1, i + 1)];
              const d0 = Number(a.dist);
              const d1 = Number(b.dist);
              if (!Number.isFinite(d0) || !Number.isFinite(d1) || d1 <= d0) {
                out.push({ x: Number(a.x), y: Number(a.y), dist: d });
                continue;
              }
              const u = clamp((d - d0) / (d1 - d0), 0, 1);
              const p = lerpPt(a, b, u);
              out.push({ x: p.x, y: p.y, dist: d });
            }
            // Ensure last point exactly at end distance.
            if (out.length && out[out.length - 1].dist < dEnd) {
              const last = arr[arr.length - 1];
              out.push({ x: Number(last.x), y: Number(last.y), dist: dEnd });
            }
            return out;
          } catch (_) {
            return arr || [];
          }
        };
        // Denser resampling reduces visible linear facets and helps normals vary smoothly.
        ribbon = resampleByDist(ribbon, 0.5);
        if (ribbon.length < 2) {
          this.clear();
          return;
        }

        // Keep a non-offset copy for hover hit-testing against the GPX route itself.
        const routeRibbon = ribbon;

        // Offset the band to one side (right of local travel direction) so the route line remains readable.
        const offsetRibbon = (() => {
          const n = ribbon.length;
          const out = new Array(n);
          for (let i = 0; i < n; i++) {
            const p = ribbon[i];
            const pPrev = ribbon[Math.max(0, i - 1)];
            const pNext = ribbon[Math.min(n - 1, i + 1)];
            const dx = Number(pNext.x) - Number(pPrev.x);
            const dy = Number(pNext.y) - Number(pPrev.y);
            const Ls = Math.hypot(dx, dy);
            if (!(Ls > 1e-3)) {
              out[i] = { x: Number(p.x), y: Number(p.y), dist: Number(p.dist) };
              continue;
            }
            // Right normal in screen coords
            const nx = dy / Ls;
            const ny = -dx / Ls;
            out[i] = { x: Number(p.x) + nx * bandOffsetPx, y: Number(p.y) + ny * bandOffsetPx, dist: Number(p.dist) };
          }
          return out;
        })();
        ribbon = offsetRibbon;

        // Expose ribbons + sampling helpers for tooltips.
        this._routeRibbon = routeRibbon;
        this._ribbon = ribbon;
        // Also refresh hover caches.
        this._hoverRouteRibbon = this._routeRibbon;
        this._hoverBandRibbon = this._ribbon;
        this._hoverGeomValid = true;

        const pointAtDist = (dk) => {
          const x = Number(dk);
          if (!Number.isFinite(x)) return null;
          if (ribbon.length === 1) return ribbon[0];
          let lo = 0, hi = ribbon.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (Number(ribbon[mid].dist) <= x) lo = mid; else hi = mid - 1;
          }
          const i0 = lo;
          const i1 = Math.min(ribbon.length - 1, i0 + 1);
          const p0 = ribbon[i0];
          const p1 = ribbon[i1];
          const d0 = Number(p0.dist);
          const d1 = Number(p1.dist);
          if (!Number.isFinite(d0) || !Number.isFinite(d1) || d1 <= d0) return p0;
          const u = clamp((x - d0) / (d1 - d0), 0, 1);
          return { x: p0.x + (p1.x - p0.x) * u, y: p0.y + (p1.y - p0.y) * u, dist: x };
        };

        this._pointAtDist = pointAtDist;
        this._sampleAtDist = sampleAt;

        const bandWidthAt = (_s) => TEMP_BAND_WIDTH_PX;

        this._bandWidthAtDist = (dk) => {
          const s = sampleAt(dk);
          return bandWidthAt(s);
        };

        const tangentAngleAtDist = (dk) => {
          const d = Number(dk);
          if (!Number.isFinite(d)) return 0;
          const delta = 4.0;
          const a = pointAtDist(d - delta);
          const b = pointAtDist(d + delta);
          if (!a || !b) return 0;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          if (!(Math.hypot(dx, dy) > 1e-3)) return 0;
          return Math.atan2(dy, dx);
        };
        this._tangentAngleAtDist = tangentAngleAtDist;

        // Render temperature band as a thick stroked line (stroke algorithm with thickness).
        for (let i = 0; i < ribbon.length - 1; i++) {
          const a = ribbon[i];
          const b = ribbon[i + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const segLen = Math.hypot(dx, dy);
          if (!(segLen > 0.25)) continue;
          const d0 = Number(a.dist);
          const d1 = Number(b.dist);
          const s0 = sampleAt(d0);
          const s1 = sampleAt(d1);
          const t0 = s0 ? Number(s0.temperature) : null;
          const t1 = s1 ? Number(s1.temperature) : null;
          if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
          const w0 = bandWidthAt(s0);
          const w1 = bandWidthAt(s1);
          const wAvg = 0.5 * (w0 + w1);

          const c0 = tempColorSpec(t0);
          const c1 = tempColorSpec(t1);
          const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
          grad.addColorStop(0, c0);
          grad.addColorStop(1, c1);

          ctx.globalAlpha = 1.0;
          ctx.strokeStyle = grad;
          ctx.lineWidth = wAvg;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // Precip markers: only on category transitions (spec), plus a light re-marker
        // in long sustained rainy stretches to slightly increase symbol density.
        const rainCat = (mm) => {
          const x = Number(mm);
          if (!Number.isFinite(x) || x <= 1) return 0;
          if (x <= 3) return 1;
          if (x <= 8) return 2;
          if (x <= 15) return 3;
          return 4;
        };
        try {
          const rainEvents = [];
          let prev = null;
          let lastAddedAt = -1e99;
          const extraSpacingKm = 90; // slightly denser, still calm
          for (const p of pts) {
            const dk = Number(p.dist);
            if (!Number.isFinite(dk)) continue;
            const sMid = sampleAt(dk);
            const mm = sMid ? Number(sMid.rainTypical) : null;
            const cat = rainCat(mm);
            if (prev === null) { prev = cat; continue; }
            if (cat !== prev) {
              if (cat > 0) {
                rainEvents.push({ dist: dk, cat });
                lastAddedAt = dk;
              }
              prev = cat;
              continue;
            }
            // Slight density increase: in long constant rainy stretches, add occasional markers.
            if (cat > 0 && (dk - lastAddedAt) >= extraSpacingKm) {
              rainEvents.push({ dist: dk, cat });
              lastAddedAt = dk;
            }
          }

          const rr = (x, y, w, h, r) => {
            const rad = Math.max(0, Math.min(Math.min(w, h) / 2, Number(r) || 0));
            ctx.beginPath();
            ctx.moveTo(x + rad, y);
            ctx.lineTo(x + w - rad, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
            ctx.lineTo(x + w, y + h - rad);
            ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
            ctx.lineTo(x + rad, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
            ctx.lineTo(x, y + rad);
            ctx.quadraticCurveTo(x, y, x + rad, y);
            ctx.closePath();
          };

          ctx.fillStyle = 'rgba(35, 120, 210, 0.88)';
          for (const ev of rainEvents) {
            const p = pointAtDist(ev.dist);
            if (!p) continue;
            const w = bandWidthAt(sampleAt(ev.dist));
            const ang = tangentAngleAtDist(ev.dist);
            const nx = Math.sin(ang);
            const ny = -Math.cos(ang);
            const x0 = p.x + nx * (0.5 * w + 12);
            const y0 = p.y + ny * (0.5 * w + 12);
            const count = (ev.cat <= 1) ? 1 : (ev.cat === 2) ? 2 : 3; // ||| for >= heavy
            const sep = 6;
            const len = 18;
            const barW = 4;
            const rad = 2.2;
            for (let k = 0; k < count; k++) {
              const xo = x0 + (k - (count - 1) / 2) * sep;
              rr(xo - barW / 2, y0 - len / 2, barW, len, rad);
              ctx.fill();
            }
          }
        } catch (_) {}

        // Temperature labels every ~160 km; avoid overlaps.
        try {
          const routeLen = Number.isFinite(drawEndKm) && drawEndKm > 0 ? drawEndKm : Number(dists[dists.length - 1] || 0);
          const boxes = [];
          const overlaps = (a, b) => !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
          const fontPx = 11;
          ctx.font = `600 ${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const stepLabel = 160;
          for (let dk = stepLabel; dk < routeLen; dk += stepLabel) {
            const sMid = sampleAt(dk);
            if (!sMid) continue;
            const t = Number(sMid.temperature);
            const loT = Number(sMid.temp_p25);
            const hiT = Number(sMid.temp_p75);
            if (!Number.isFinite(t)) continue;
            const p = pointAtDist(dk);
            if (!p) continue;
            const w = bandWidthAt(sMid);
            const x = p.x;
            const y = p.y + (0.5 * w + 18);
            const line1 = `${Math.round(t)}°C`;
            const line2 = (Number.isFinite(loT) && Number.isFinite(hiT)) ? `${Math.round(loT)} / ${Math.round(hiT)}` : '';
            const w1 = ctx.measureText(line1).width;
            const w2 = line2 ? ctx.measureText(line2).width : 0;
            const ww = Math.max(w1, w2);
            const pad = 6;
            const hh = line2 ? (fontPx*2 + 6) : (fontPx + 6);
            const rect = { x1: x - ww/2 - pad, y1: y - hh/2, x2: x + ww/2 + pad, y2: y + hh/2 };
            let ok = true;
            for (const b of boxes) { if (overlaps(rect, b)) { ok = false; break; } }
            if (!ok) continue;
            boxes.push(rect);

            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            const r = 7;
            ctx.beginPath();
            ctx.moveTo(rect.x1 + r, rect.y1);
            ctx.lineTo(rect.x2 - r, rect.y1);
            ctx.quadraticCurveTo(rect.x2, rect.y1, rect.x2, rect.y1 + r);
            ctx.lineTo(rect.x2, rect.y2 - r);
            ctx.quadraticCurveTo(rect.x2, rect.y2, rect.x2 - r, rect.y2);
            ctx.lineTo(rect.x1 + r, rect.y2);
            ctx.quadraticCurveTo(rect.x1, rect.y2, rect.x1, rect.y2 - r);
            ctx.lineTo(rect.x1, rect.y1 + r);
            ctx.quadraticCurveTo(rect.x1, rect.y1, rect.x1 + r, rect.y1);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = '#111';
            ctx.fillText(line1, x, y - (line2 ? fontPx*0.55 : 0));
            if (line2) {
              ctx.font = `500 ${fontPx-1}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
              ctx.fillText(line2, x, y + fontPx*0.55);
              ctx.font = `600 ${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
            }
          }
        } catch (_) {}

        // Wind bands (spec): subtle, deterministic, parallel outside the temperature band (no animation).
        try {
          const windRouteLen = Number.isFinite(drawEndKm) && drawEndKm > 0 ? drawEndKm : Number(dists[dists.length - 1] || 0);
          const blendKm = 5.0;
          const minSegKm = 10.0;
          const maxSegKm = 60.0;

          const windSoftGreen = [95, 174, 106]; // #5fae6a
          const windSoftRed = [200, 106, 106];  // #c86a6a

          const windValueAt = (() => {
            const stepKm = 1.0;
            const samples = [];
            for (let dk = 0; dk <= windRouteLen; dk += stepKm) {
              const sMid = sampleAt(dk);
              const hMid = routeHeadingAt(dk);
              const comp = windComponentAt(sMid, hMid);
              const v = Number.isFinite(comp) ? Number(comp) : 0;
              samples.push({ d: dk, v });
            }

            const kindOf = (v) => {
              const x = Number(v);
              if (!Number.isFinite(x) || Math.abs(x) < 1.0) return 0;
              return (x > 0) ? 1 : -1;
            };

            // Initial segmentation by sign and similarity.
            const segs0 = [];
            let cur = null;
            const pushCur = () => {
              if (!cur) return;
              const len = Math.max(0, cur.end - cur.start);
              const val = (cur.n > 0) ? (cur.sum / cur.n) : 0;
              segs0.push({ start: cur.start, end: cur.end, kind: cur.kind, val, len });
              cur = null;
            };
            for (const s of samples) {
              const d = Number(s.d);
              const vRaw = Number(s.v);
              const k = kindOf(vRaw);
              const v = (k === 0) ? 0 : vRaw;
              if (!cur) {
                cur = { start: d, end: d, kind: k, sum: v, n: (k === 0) ? 0 : 1 };
                continue;
              }
              const mean = (cur.n > 0) ? (cur.sum / cur.n) : 0;
              const similar = (k === cur.kind) && (k === 0 || Math.abs(v - mean) <= 1.2);
              const wouldLen = d - cur.start;
              if (similar && wouldLen <= maxSegKm) {
                cur.end = d;
                if (k !== 0) { cur.sum += v; cur.n += 1; }
              } else {
                pushCur();
                cur = { start: d, end: d, kind: k, sum: v, n: (k === 0) ? 0 : 1 };
              }
            }
            pushCur();

            // Normalize ends (make last segment reach route end).
            if (segs0.length) segs0[segs0.length - 1].end = windRouteLen;

            // Split segments longer than max.
            const segs1 = [];
            for (const s of segs0) {
              const L = Math.max(0, Number(s.end) - Number(s.start));
              if (!(L > maxSegKm) || s.kind === 0) {
                segs1.push({ ...s, len: L });
                continue;
              }
              const n = Math.ceil(L / maxSegKm);
              for (let i = 0; i < n; i++) {
                const a = Number(s.start) + (i * L) / n;
                const b = Number(s.start) + ((i + 1) * L) / n;
                segs1.push({ start: a, end: b, kind: s.kind, val: s.val, len: b - a });
              }
            }

            // Drop too-short non-neutral segments (calm visualization).
            const segs = segs1.map(s => {
              const L = Math.max(0, Number(s.end) - Number(s.start));
              if (s.kind !== 0 && L < minSegKm) return { start: s.start, end: s.end, kind: 0, val: 0, len: L };
              return { ...s, len: L };
            });

            const valueAtDist = (dIn) => {
              const d = clamp(Number(dIn), 0, windRouteLen);
              let idx = 0;
              while (idx < segs.length && !(segs[idx].start <= d && d <= segs[idx].end)) idx++;
              idx = clamp(idx, 0, Math.max(0, segs.length - 1));
              const s = segs[idx] || { start: 0, end: windRouteLen, kind: 0, val: 0 };
              const prev = (idx > 0) ? segs[idx - 1] : null;
              const next = (idx < segs.length - 1) ? segs[idx + 1] : null;
              let v = Number(s.val) || 0;

              const b = blendKm;
              if (prev && (d - Number(s.start)) < b) {
                const u = clamp((d - Number(s.start)) / b, 0, 1);
                const v0 = Number(prev.val) || 0;
                v = lerp(v0, v, u);
              }
              if (next && (Number(s.end) - d) < b) {
                const u = clamp((Number(s.end) - d) / b, 0, 1);
                const v1 = Number(next.val) || 0;
                v = lerp(v1, v, u);
              }
              return v;
            };
            valueAtDist._segs = segs;
            return valueAtDist;
          })();

          windCtx.lineCap = 'round';
          windCtx.lineJoin = 'round';

          const drawWindStroke = (ax, ay, bx, by, wPx, rgb) => {
            const w = clamp(Number(wPx) || 2.5, 2, 4);
            const r = rgb[0], g = rgb[1], b = rgb[2];

            // Outline (1px)
            windCtx.globalAlpha = 0.85;
            windCtx.strokeStyle = 'rgba(255,255,255,0.75)';
            windCtx.lineWidth = w + 2;
            windCtx.beginPath();
            windCtx.moveTo(ax, ay);
            windCtx.lineTo(bx, by);
            windCtx.stroke();

            // Feathered edges: outer (0.3), mid (0.55), center (0.8)
            windCtx.strokeStyle = `rgb(${r},${g},${b})`;
            windCtx.globalAlpha = 0.30;
            windCtx.lineWidth = w + 4;
            windCtx.beginPath();
            windCtx.moveTo(ax, ay);
            windCtx.lineTo(bx, by);
            windCtx.stroke();

            windCtx.globalAlpha = 0.55;
            windCtx.lineWidth = w + 2;
            windCtx.beginPath();
            windCtx.moveTo(ax, ay);
            windCtx.lineTo(bx, by);
            windCtx.stroke();

            windCtx.globalAlpha = 0.80;
            windCtx.lineWidth = w;
            windCtx.beginPath();
            windCtx.moveTo(ax, ay);
            windCtx.lineTo(bx, by);
            windCtx.stroke();

            windCtx.globalAlpha = 1;
          };

          // Draw wind band as a parallel polyline outside the temperature band.
          for (let i = 0; i < ribbon.length - 1; i++) {
            const a = ribbon[i];
            const b = ribbon[i + 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const segLen = Math.hypot(dx, dy);
            if (!(segLen > 0.25)) continue;
            const leftX = -dy / segLen;
            const leftY = dx / segLen;
            const outX = -leftX;
            const outY = -leftY;

            const d0 = Number(a.dist);
            const d1 = Number(b.dist);
            const dMid = 0.5 * (d0 + d1);
            const vMid = windValueAt(dMid);
            if (!Number.isFinite(vMid) || Math.abs(vMid) < 1.0) continue;
            const abs = Math.abs(vMid);

            const w0 = bandWidthAt(sampleAt(d0));
            const w1 = bandWidthAt(sampleAt(d1));
            const off0 = 0.5 * w0 + 6;
            const off1 = 0.5 * w1 + 6;
            const ax = a.x + outX * off0;
            const ay = a.y + outY * off0;
            const bx = b.x + outX * off1;
            const by = b.y + outY * off1;

            const widthPx = clamp(2 + (abs / 8.0) * 2, 2, 4);
            const rgb = (vMid >= 0) ? windSoftGreen : windSoftRed;
            drawWindStroke(ax, ay, bx, by, widthPx, rgb);
          }

          // Chevron arrow: one per segment, centered.
          try {
            const segs = windValueAt._segs || [];
            const arrowSize = 7;
            for (const s of segs) {
              if (!s || s.kind === 0) continue;
              const L = Math.max(0, Number(s.end) - Number(s.start));
              if (L < minSegKm) continue;
              const mid = 0.5 * (Number(s.start) + Number(s.end));
              const v = Number(s.val);
              if (!Number.isFinite(v) || Math.abs(v) < 1.0) continue;
              const ang = tangentAngleAtDist(mid) + ((v < 0) ? Math.PI : 0);
              const p = pointAtDist(mid);
              if (!p) continue;
              const w = bandWidthAt(sampleAt(mid));
              const off = 0.5 * w + 6;
              const nx = Math.sin(tangentAngleAtDist(mid));
              const ny = -Math.cos(tangentAngleAtDist(mid));
              const cx = p.x + nx * off;
              const cy = p.y + ny * off;

              const rgb = (v >= 0) ? windSoftGreen : windSoftRed;
              windCtx.save();
              windCtx.translate(cx, cy);
              windCtx.rotate(ang);
              windCtx.globalAlpha = 0.90;
              windCtx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
              windCtx.strokeStyle = 'rgba(255,255,255,0.85)';
              windCtx.lineWidth = 1.2;
              windCtx.beginPath();
              windCtx.moveTo(arrowSize * 0.55, 0);
              windCtx.lineTo(-arrowSize * 0.45, -arrowSize * 0.38);
              windCtx.lineTo(-arrowSize * 0.45, +arrowSize * 0.38);
              windCtx.closePath();
              windCtx.fill();
              windCtx.stroke();
              windCtx.globalAlpha = 1;
              windCtx.restore();
            }
          } catch (_) {}
        } catch (_) {}

        // No wind animation in tactical spec.
        try { if (this._anim) cancelAnimationFrame(this._anim); } catch (_) {}
        this._anim = null;
      },
    });
    return new Layer();
  }

  // Debug helper (console): TOUR bands hover tooltip.
  try {
    window.wmTourTooltipDebug = {
      enable: () => { try { localStorage.setItem('wm_debug_tour_tooltip', '1'); } catch (_) {} },
      disable: () => { try { localStorage.removeItem('wm_debug_tour_tooltip'); } catch (_) {} },
    };
  } catch (_) {}

  function _ensureTourBandsLayer() {
    if (TOUR_BANDS_LAYER) return TOUR_BANDS_LAYER;
    TOUR_BANDS_LAYER = _makeTourBandsLayer();
    try { TOUR_BANDS_LAYER.addTo(map); } catch (_) {}
    return TOUR_BANDS_LAYER;
  }

  function _scheduleTourBandsRedraw() {
    if (TOUR_BANDS_REDRAW_QUEUED) return;
    TOUR_BANDS_REDRAW_QUEUED = true;
    requestAnimationFrame(() => {
      TOUR_BANDS_REDRAW_QUEUED = false;
      try {
        if (!TOUR_BANDS_LAYER) return;
        TOUR_BANDS_LAYER.draw(TOUR_BANDS_PROFILE, TOUR_BANDS_POINTS);
      } catch (_) {}
    });
  }

  function _setTourBandsEnabled(enabled) {
    TOUR_BANDS_ENABLED = !!enabled;
    // Tactical map must not show strategic climate overlays.
    try { if (_tourIsActive()) strategicSetActive && strategicSetActive(false); } catch (_) {}
    _ensureTourBandsLayer();
    _scheduleTourBandsRedraw();
  }

  function _setTourBandsData(profile, points) {
    TOUR_BANDS_PROFILE = profile || null;
    TOUR_BANDS_POINTS = points || null;
    TOUR_HOVER_POINTS_DIRTY = true;
    _ensureTourBandsLayer();
    _scheduleTourBandsRedraw();
  }

  // --- Land mask for Strategic overlays (used when includeSea=false) ---
  let STRATEGIC_LAND = null; // GeoJSON FeatureCollection
  let STRATEGIC_LAND_LOADING = false;
  // Higher-res shoreline source (used when includeSea=true)
  let STRATEGIC_SHORE_LAND = null; // GeoJSON FeatureCollection
  let STRATEGIC_SHORE_LOADING = false;

  function _geoFeatureBbox(feature) {
    try {
      const g = feature && feature.geometry;
      const coords = g && g.coordinates;
      if (!coords) return null;
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      const walk = (c) => {
        if (!Array.isArray(c) || c.length === 0) return;
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
          const lon = Number(c[0]);
          const lat = Number(c[1]);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
            minLon = Math.min(minLon, lon);
            maxLon = Math.max(maxLon, lon);
          }
          return;
        }
        for (const x of c) walk(x);
      };
      walk(coords);
      if (!(minLat <= maxLat && minLon <= maxLon)) return null;
      return { minLat, maxLat, minLon, maxLon };
    } catch (_) {
      return null;
    }
  }

  function _bboxIntersects(a, b) {
    if (!a || !b) return false;
    return !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLon < b.minLon || a.minLon > b.maxLon);
  }

  async function _ensureStrategicLandMaskLoaded() {
    if (STRATEGIC_LAND || STRATEGIC_LAND_LOADING) return;
    STRATEGIC_LAND_LOADING = true;
    try {
      const r = await fetch('/ne_110m_land.geojson');
      const j = await r.json();
      if (j && j.type === 'FeatureCollection' && Array.isArray(j.features)) {
        // Precompute bboxes for quick culling.
        for (const f of j.features) {
          try { f.__bbox = _geoFeatureBbox(f); } catch (_) {}
        }
        STRATEGIC_LAND = j;
      }
    } catch (e) {
      console.warn('Land mask load failed', e);
    } finally {
      STRATEGIC_LAND_LOADING = false;
      try { if (STRATEGIC_STATE && STRATEGIC_STATE.active) _renderStrategic(); } catch (_) {}
    }
  }

  async function _ensureStrategicShoreMaskLoaded() {
    if (STRATEGIC_SHORE_LAND || STRATEGIC_SHORE_LOADING) return;
    STRATEGIC_SHORE_LOADING = true;
    try {
      const r = await fetch('/ne_50m_land.geojson');
      const j = await r.json();
      if (j && j.type === 'FeatureCollection' && Array.isArray(j.features)) {
        // Precompute bboxes for quick culling.
        for (const f of j.features) {
          try { f.__bbox = _geoFeatureBbox(f); } catch (_) {}
        }
        STRATEGIC_SHORE_LAND = j;
      }
    } catch (e) {
      console.warn('Shore mask load failed', e);
    } finally {
      STRATEGIC_SHORE_LOADING = false;
      try { if (STRATEGIC_STATE && STRATEGIC_STATE.active) _renderStrategic(); } catch (_) {}
    }
  }

  function _beginStrategicLandClip(ctx) {
    // Returns true if a clip was applied (caller must ctx.restore()).
    if (!ctx) return false;
    if (SETTINGS && SETTINGS.includeSea) return false;
    if (!STRATEGIC_LAND || !STRATEGIC_LAND.features) {
      // Load lazily; render will refresh once ready.
      _ensureStrategicLandMaskLoaded();
      return false;
    }

    let view = null;
    try {
      const b = map.getBounds();
      view = {
        minLat: b.getSouth() - 1.0,
        maxLat: b.getNorth() + 1.0,
        minLon: b.getWest() - 1.0,
        maxLon: b.getEast() + 1.0,
      };
    } catch (_) {}

    ctx.save();
    ctx.beginPath();

    const drawRing = (ring) => {
      if (!Array.isArray(ring) || ring.length < 2) return;
      let started = false;
      for (const pt of ring) {
        if (!pt || pt.length < 2) continue;
        const lon = Number(pt[0]);
        const lat = Number(pt[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const q = map.latLngToContainerPoint([lat, lon]);
        if (!started) { ctx.moveTo(q.x, q.y); started = true; }
        else ctx.lineTo(q.x, q.y);
      }
      if (started) ctx.closePath();
    };

    const geom = (g) => {
      if (!g || !g.type || !g.coordinates) return;
      if (g.type === 'Polygon') {
        for (const ring of g.coordinates) drawRing(ring);
        return;
      }
      if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates) {
          for (const ring of poly) drawRing(ring);
        }
      }
    };

    for (const f of STRATEGIC_LAND.features) {
      if (!f) continue;
      if (view) {
        const bb = f.__bbox;
        if (bb && !_bboxIntersects(bb, view)) continue;
      }
      geom(f.geometry);
    }

    // Use even-odd so holes (lakes) punch out correctly even if ring winding varies.
    try { ctx.clip('evenodd'); } catch (_) { try { ctx.clip(); } catch (_) {} }
    return true;
  }

  function _strokeStrategicShoreline(ctx) {
    // Coastline outline for Strategic overlays.
    // Draw regardless of includeSea so the continent boundary stays readable
    // and doesn't disappear when toggling includeSea.
    if (!ctx) return;

    // Prefer higher-res shoreline when available.
    const src = (STRATEGIC_SHORE_LAND && STRATEGIC_SHORE_LAND.features)
      ? STRATEGIC_SHORE_LAND
      : STRATEGIC_LAND;
    if (!src || !src.features) {
      // Prefer loading the higher-res shoreline source; fall back to 110m if needed.
      _ensureStrategicShoreMaskLoaded();
      _ensureStrategicLandMaskLoaded();
      return;
    }

    let view = null;
    try {
      const b = map.getBounds();
      view = {
        minLat: b.getSouth() - 1.0,
        maxLat: b.getNorth() + 1.0,
        minLon: b.getWest() - 1.0,
        maxLon: b.getEast() + 1.0,
      };
    } catch (_) {}

    const drawRing = (ring) => {
      if (!Array.isArray(ring) || ring.length < 2) return;
      let started = false;
      for (const pt of ring) {
        if (!pt || pt.length < 2) continue;
        const lon = Number(pt[0]);
        const lat = Number(pt[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const q = map.latLngToContainerPoint([lat, lon]);
        if (!started) { ctx.moveTo(q.x, q.y); started = true; }
        else ctx.lineTo(q.x, q.y);
      }
      if (started) ctx.closePath();
    };

    const geom = (g) => {
      if (!g || !g.type || !g.coordinates) return;
      if (g.type === 'Polygon') {
        for (const ring of g.coordinates) drawRing(ring);
        return;
      }
      if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates) {
          for (const ring of poly) drawRing(ring);
        }
      }
    };

    ctx.save();
    try {
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Dark, thick coastline line.
      ctx.strokeStyle = 'rgba(55,55,55,0.78)';
      const z = (map && typeof map.getZoom === 'function') ? Number(map.getZoom()) : 7;
      ctx.lineWidth = (z >= 10) ? 3.2 : ((z >= 8) ? 2.9 : ((z >= 6) ? 2.6 : 2.3));
    } catch (_) {}

    ctx.beginPath();
    for (const f of src.features) {
      if (!f) continue;
      if (view) {
        const bb = f.__bbox;
        if (bb && !_bboxIntersects(bb, view)) continue;
      }
      geom(f.geometry);
    }
    try { ctx.stroke(); } catch (_) {}
    ctx.restore();
  }

  // --- Strategic cursor readout (tooltip) ---
  let STRATEGIC_CURSOR_EL = null;

  function _ensureStrategicCursorReadout() {
    if (STRATEGIC_CURSOR_EL) return STRATEGIC_CURSOR_EL;
    try {
      const el = document.createElement('div');
      el.id = 'wmStrategicCursorReadout';
      el.style.position = 'fixed';
      el.style.left = '0px';
      el.style.top = '0px';
      // Keep above Leaflet panes/controls.
      el.style.zIndex = '9999';
      el.style.display = 'none';
      el.style.pointerEvents = 'none';
      el.style.whiteSpace = 'pre';
      el.style.fontFamily = 'system-ui, -apple-system, sans-serif';
      el.style.fontSize = '11px';
      el.style.lineHeight = '1.2';
      el.style.color = 'rgba(10,10,10,0.82)';
      // Nearly transparent, minimal chrome.
      el.style.background = 'rgba(255,255,255,0.42)';
      el.style.border = '1px solid rgba(0,0,0,0.10)';
      el.style.borderRadius = '10px';
      el.style.padding = '6px 8px';
      el.style.backdropFilter = 'blur(2px)';
      el.style.boxShadow = '0 2px 10px rgba(0,0,0,0.08)';

      try { document.body.appendChild(el); } catch (_) { return null; }
      STRATEGIC_CURSOR_EL = el;
      return el;
    } catch (_) {
      return null;
    }
  }

  function _hideStrategicCursorReadout() {
    const el = STRATEGIC_CURSOR_EL;
    if (!el) return;
    el.style.display = 'none';
  }

  function _fmtNum(v, digits) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const d = Number.isFinite(Number(digits)) ? Math.max(0, Math.min(3, Number(digits))) : 0;
    return n.toFixed(d);
  }

  function _comfortLabel(score) {
    const s = Number(score);
    if (!Number.isFinite(s)) return '';
    if (s >= 4) return 'excellent';
    if (s >= 2) return 'good';
    if (s >= 0) return 'ok';
    if (s >= -2) return 'poor';
    return 'bad';
  }

  function _strategicSampleAt(lat, lon) {
    if (!STRATEGIC_STATE || !STRATEGIC_STATE.active) return null;
    const resp = STRATEGIC_STATE.lastResp;
    if (!resp || !resp.points) return null;

    let meta = STRATEGIC_STATE._meta;
    let tileMap = STRATEGIC_STATE._tileMap;
    if (!meta) {
      const bboxRaw = _bboxFromResp(resp);
      const tileKm = Number(resp.tile_km || 50);
      meta = bboxRaw ? { bbox: bboxRaw, tile_km: tileKm } : null;
      STRATEGIC_STATE._meta = meta;
    }
    if (!tileMap) {
      tileMap = _makeTileMap(resp.points);
      STRATEGIC_STATE._tileMap = tileMap;
    }
    if (!meta || !tileMap) return null;
    return _sampleInterpolated(tileMap, meta, lat, lon);
  }

  function _bikepackingTempScore(tC) {
    const t = Number(tC);
    if (!Number.isFinite(t)) return 0;
    if (t >= 15 && t <= 22) return 2;
    if (t >= 10 && t < 15) return 1;
    if (t > 22 && t <= 28) return 1;
    if (t < 5) return -2;
    if (t > 30) return -2;
    return 0;
  }

  function _bikepackingRainScore(rMm) {
    const r = Math.max(0, Number(rMm));
    if (!Number.isFinite(r)) return 0;
    if (r < 1) return 2;
    if (r <= 5) return 0;
    return -2;
  }

  function _bikepackingWindScore(wMs) {
    const w = Math.max(0, Number(wMs));
    if (!Number.isFinite(w)) return 0;
    if (w < 3) return 2;
    if (w <= 6) return 1;
    if (w > 8) return -2;
    return 0;
  }

  function _bikepackingComfortScore(point) {
    if (!point) return null;
    const t = Number(point.temp_day_median);
    const r = Number(point.precipitation_mm);
    const w = Number(point.wind_speed_ms);
    if (!Number.isFinite(t) || !Number.isFinite(r) || !Number.isFinite(w)) return null;
    return _bikepackingTempScore(t) + _bikepackingRainScore(r) + _bikepackingWindScore(w);
  }

  function _meanWindSpeed(points) {
    let sum = 0;
    let n = 0;
    for (const p of (points || [])) {
      if (!p) continue;
      const w = Number(p.wind_speed_ms);
      if (!Number.isFinite(w)) continue;
      sum += Math.max(0, w);
      n += 1;
    }
    return n ? (sum / n) : 0;
  }

  const STRATEGIC_STATE = {
    active: false,
    year: Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR),
    // Continuous day-of-year (1..365)
    doy: 1.0,
    timescale: (strategicTimescaleSelect && strategicTimescaleSelect.value)
      ? strategicTimescaleSelect.value
      : String((SETTINGS && SETTINGS.climateTimescale) ? SETTINGS.climateTimescale : 'daily'),
    layer: (strategicLayerSelect && strategicLayerSelect.value) ? strategicLayerSelect.value : 'temperature_ride',
    windOn: false,
    windMode: (strategicWindMode && strategicWindMode.value) ? strategicWindMode.value : 'flow',
    playing: false,
    playTimer: null,
    lastResp: null,
    _meta: null,
    _tileMap: null,
    _cursorMoveHandler: null,
    _cursorLeaveHandler: null,
    lastFetchAt: 0,
    pendingFetch: null,
    fetchAbort: null,
    isoLayer: null,
    windLayer: null,
  };

  // --- Day-of-Year helpers (non-leap year) ---
  const _DOY_MONTHS = [
    { name: 'Jan', days: 31 },
    { name: 'Feb', days: 28 },
    { name: 'Mar', days: 31 },
    { name: 'Apr', days: 30 },
    { name: 'May', days: 31 },
    { name: 'Jun', days: 30 },
    { name: 'Jul', days: 31 },
    { name: 'Aug', days: 31 },
    { name: 'Sep', days: 30 },
    { name: 'Oct', days: 31 },
    { name: 'Nov', days: 30 },
    { name: 'Dec', days: 31 },
  ];
  const _DOY_MONTH_STARTS = (() => {
    let acc = 1;
    const out = [];
    for (let i = 0; i < _DOY_MONTHS.length; i++) {
      out.push({ month: i + 1, name: _DOY_MONTHS[i].name, doy: acc });
      acc += _DOY_MONTHS[i].days;
    }
    return out;
  })();

  function _clampDOY(d) {
    const v = Number(d);
    if (!Number.isFinite(v)) return 1.0;
    if (v < 1) return 1.0;
    if (v > 365) return 365.0;
    return v;
  }

  function _doyToMonthDay(doyInt) {
    let d = Math.max(1, Math.min(365, Math.round(Number(doyInt) || 1)));
    for (let i = 0; i < _DOY_MONTHS.length; i++) {
      const md = _DOY_MONTHS[i].days;
      if (d <= md) return { month: i + 1, day: d, monthName: _DOY_MONTHS[i].name };
      d -= md;
    }
    return { month: 12, day: 31, monthName: 'Dec' };
  }

  function _mmddFromDOY(doyInt) {
    const md = _doyToMonthDay(doyInt);
    const mm = String(md.month).padStart(2, '0');
    const dd = String(md.day).padStart(2, '0');
    return `${mm}-${dd}`;
  }

  function _labelFromDOY(doyFloat) {
    const d = Math.max(1, Math.min(365, Math.round(Number(doyFloat) || 1)));
    const md = _doyToMonthDay(d);
    return `${md.monthName} ${md.day}`;
  }

  function _renderStrategicSliderTicks(timescale) {
    if (!strategicMonthTicks) return;
    strategicMonthTicks.innerHTML = '';
    const ts = String(timescale || 'daily');

    // Yearly has no meaningful in-year ticks.
    if (ts === 'year') return;

    // Daily: show month boundaries on the 1..365 axis.
    if (ts === 'daily') {
      const n = 365;
      for (const s of _DOY_MONTH_STARTS) {
        const x = ((s.doy - 1) / (n - 1)) * 100;
        const el = document.createElement('div');
        el.className = 'wm-tick wm-major';
        el.style.left = `${x}%`;
        strategicMonthTicks.appendChild(el);

        const lab = document.createElement('div');
        lab.className = 'wm-month-label';
        lab.style.left = `${x}%`;
        lab.textContent = s.name;
        strategicMonthTicks.appendChild(lab);
      }
      return;
    }

    const spec = _strategicSliderSpec(ts);
    const minV = Number(spec.min);
    const maxV = Number(spec.max);
    const denom = Math.max(1, (maxV - minV));

    function _xFor(v) {
      return ((Number(v) - minV) / denom) * 100;
    }

    function _addTick(v, isMajor) {
      const el = document.createElement('div');
      el.className = isMajor ? 'wm-tick wm-major' : 'wm-tick';
      el.style.left = `${_xFor(v)}%`;
      strategicMonthTicks.appendChild(el);
    }

    function _addLabel(v, text) {
      const lab = document.createElement('div');
      lab.className = 'wm-month-label';
      lab.style.left = `${_xFor(v)}%`;
      lab.textContent = String(text || '');
      strategicMonthTicks.appendChild(lab);
    }

    if (ts === 'month') {
      for (let m = 1; m <= 12; m++) {
        _addTick(m, true);
        _addLabel(m, _DOY_MONTHS[m - 1] ? _DOY_MONTHS[m - 1].name : String(m));
      }
      return;
    }

    if (ts === 'quarter') {
      for (let q = 1; q <= 4; q++) {
        _addTick(q, true);
        _addLabel(q, `Q${q}`);
      }
      return;
    }

    // Week / Two-week: tick each bin, label months at their first bin.
    if (ts === 'week' || ts === 'two_week') {
      const stepDays = (ts === 'two_week') ? 14 : 7;
      const majorAt = new Map();
      for (const s of _DOY_MONTH_STARTS) {
        const idx = 1 + Math.floor((s.doy - 1) / stepDays);
        if (!majorAt.has(idx)) majorAt.set(idx, s.name);
      }

      for (let i = minV; i <= maxV; i++) {
        _addTick(i, majorAt.has(i));
      }
      for (const [idx, name] of majorAt.entries()) {
        _addLabel(idx, name);
      }
    }
  }

  function _strategicSetLabels() {
    const y = Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
    const ts = String(STRATEGIC_STATE.timescale || 'daily');
    const p = _strategicPeriodForDOY(STRATEGIC_STATE.doy, ts, y);
    const txtShort = p && p.shortLabel ? String(p.shortLabel) : _labelFromDOY(STRATEGIC_STATE.doy);
    const txtMonitor = p && p.monitorLabel ? String(p.monitorLabel) : `${y}-${_mmddFromDOY(STRATEGIC_STATE.doy)}`;
    if (strategicDayLabel) strategicDayLabel.textContent = txtShort;
    if (strategicTimelineLabel) strategicTimelineLabel.textContent = txtMonitor;
  }

  function _strategicSetYear(year) {
    STRATEGIC_STATE.year = Number(year || STRATEGIC_DEFAULT_YEAR);
    _strategicApplyTimescaleUI();
    _updateStrategicLegend();
  }

  function _strategicSetDOY(doyVal) {
    STRATEGIC_STATE.doy = _clampDOY(doyVal);
    if (strategicDaySlider) {
      const ts = String(STRATEGIC_STATE.timescale || 'daily');
      const v = _strategicDOYToSliderValue(STRATEGIC_STATE.doy, ts);
      strategicDaySlider.value = String(v);
    }
    _strategicSetLabels();
    _updateStrategicLegend();
  }

  function _pad2(n) {
    return String(Number(n) || 0).padStart(2, '0');
  }

  function _fmtDM(d) {
    return `${_pad2(d.day)}.${_pad2(d.month)}.`;
  }

  function _fmtDMY(d, year) {
    return `${_pad2(d.day)}.${_pad2(d.month)}.${String(year)}`;
  }

  function _doyToDM(doyInt) {
    const md = _doyToMonthDay(doyInt);
    return { month: md.month, day: md.day, monthName: md.monthName };
  }

  function _strategicPeriodForDOY(doyFloat, timescale, year) {
    const ts = String(timescale || 'daily');
    const d = Math.max(1, Math.min(365, Math.round(Number(doyFloat) || 1)));

    const startEnd = (() => {
      if (ts === 'daily') return { start: d, end: d };
      if (ts === 'week') {
        const start = 1 + 7 * Math.floor((d - 1) / 7);
        return { start, end: Math.min(365, start + 6) };
      }
      if (ts === 'two_week') {
        const start = 1 + 14 * Math.floor((d - 1) / 14);
        return { start, end: Math.min(365, start + 13) };
      }
      if (ts === 'month') {
        const md = _doyToMonthDay(d);
        const start = _DOY_MONTH_STARTS.find(s => s.month === md.month)?.doy || 1;
        const end = Math.min(365, start + (_DOY_MONTHS[md.month - 1]?.days || 30) - 1);
        return { start, end };
      }
      if (ts === 'quarter') {
        const md = _doyToMonthDay(d);
        const qStartMonth = 1 + 3 * Math.floor((md.month - 1) / 3);
        const qEndMonth = qStartMonth + 2;
        const start = _DOY_MONTH_STARTS.find(s => s.month === qStartMonth)?.doy || 1;
        const endStart = _DOY_MONTH_STARTS.find(s => s.month === qEndMonth)?.doy || start;
        const end = Math.min(365, endStart + (_DOY_MONTHS[qEndMonth - 1]?.days || 30) - 1);
        return { start, end };
      }
      if (ts === 'year') return { start: 1, end: 365 };
      return { start: d, end: d };
    })();

    const sDM = _doyToDM(startEnd.start);
    const eDM = _doyToDM(startEnd.end);

    const monitorLabel = (() => {
      if (ts === 'daily') return _fmtDMY(sDM, year);
      if (ts === 'year') return `Yearly: ${_fmtDM(sDM)}–${_fmtDM(eDM)}${String(year)}`;
      const tsTitle = (ts === 'two_week') ? '2 Weeks' : (ts.charAt(0).toUpperCase() + ts.slice(1));
      return `${tsTitle}: ${_fmtDM(sDM)}–${_fmtDM(eDM)}${String(year)}`;
    })();

    const shortLabel = (() => {
      if (ts === 'daily') return `${sDM.monthName} ${sDM.day}`;
      if (ts === 'month') return `${sDM.monthName} ${String(year)}`;
      if (ts === 'quarter') return `Q${1 + Math.floor((sDM.month - 1) / 3)} ${String(year)}`;
      if (ts === 'year') return String(year);
      // week / two_week
      return `${_fmtDM(sDM)}–${_fmtDM(eDM)}${String(year)}`;
    })();

    return {
      startDoy: startEnd.start,
      endDoy: startEnd.end,
      start: sDM,
      end: eDM,
      shortLabel,
      monitorLabel,
    };
  }

  function _strategicSliderSpec(timescale) {
    const ts = String(timescale || 'daily');
    if (ts === 'daily') return { min: 1, max: 365, step: 0.1 };
    if (ts === 'week') return { min: 1, max: 53, step: 1 };
    if (ts === 'two_week') return { min: 1, max: 27, step: 1 };
    if (ts === 'month') return { min: 1, max: 12, step: 1 };
    if (ts === 'quarter') return { min: 1, max: 4, step: 1 };
    if (ts === 'year') return { min: 1, max: 1, step: 1 };
    return { min: 1, max: 365, step: 1 };
  }

  function _strategicSliderValueToDOY(sliderValue, timescale) {
    const ts = String(timescale || 'daily');
    const v = Number(sliderValue);
    if (ts === 'daily') return _clampDOY(v);
    if (ts === 'week') {
      const idx = Math.max(1, Math.min(53, Math.round(v || 1)));
      return _clampDOY(1 + (idx - 1) * 7);
    }
    if (ts === 'two_week') {
      const idx = Math.max(1, Math.min(27, Math.round(v || 1)));
      return _clampDOY(1 + (idx - 1) * 14);
    }
    if (ts === 'month') {
      const idx = Math.max(1, Math.min(12, Math.round(v || 1)));
      const s = _DOY_MONTH_STARTS[idx - 1];
      return _clampDOY(s ? s.doy : 1);
    }
    if (ts === 'quarter') {
      const idx = Math.max(1, Math.min(4, Math.round(v || 1)));
      const startMonth = 1 + (idx - 1) * 3;
      const s = _DOY_MONTH_STARTS.find(x => x.month === startMonth);
      return _clampDOY(s ? s.doy : 1);
    }
    if (ts === 'year') return 1;
    return _clampDOY(v);
  }

  function _strategicDOYToSliderValue(doyFloat, timescale) {
    const ts = String(timescale || 'daily');
    const d = Math.max(1, Math.min(365, Math.round(Number(doyFloat) || 1)));
    if (ts === 'daily') return _clampDOY(Number(doyFloat) || d);
    if (ts === 'week') return 1 + Math.floor((d - 1) / 7);
    if (ts === 'two_week') return 1 + Math.floor((d - 1) / 14);
    if (ts === 'month') {
      const md = _doyToMonthDay(d);
      return md.month;
    }
    if (ts === 'quarter') {
      const md = _doyToMonthDay(d);
      return 1 + Math.floor((md.month - 1) / 3);
    }
    if (ts === 'year') return 1;
    return d;
  }

  function _strategicApplyTimescaleUI() {
    const ts = String(STRATEGIC_STATE.timescale || 'daily');
    const spec = _strategicSliderSpec(ts);
    try {
      if (strategicDaySlider) {
        strategicDaySlider.min = String(spec.min);
        strategicDaySlider.max = String(spec.max);
        strategicDaySlider.step = String(spec.step);
        // Re-map current state.doy into the new slider coordinate.
        strategicDaySlider.value = String(_strategicDOYToSliderValue(STRATEGIC_STATE.doy, ts));
      }
    } catch (_) {}
    try {
      if (strategicMonthTicks) {
        strategicMonthTicks.style.display = (ts === 'year') ? 'none' : '';
      }
    } catch (_) {}
    try {
      _renderStrategicSliderTicks(ts);
    } catch (_) {}
    _strategicSetLabels();
    _updateStrategicLegend();
  }

  function _strategicCurrentMMDDPair() {
    const ts = String(STRATEGIC_STATE.timescale || 'daily');
    // Only daily supports smooth interpolation between adjacent days.
    if (ts !== 'daily') {
      const d0 = Math.max(1, Math.min(365, Math.round(Number(STRATEGIC_STATE.doy) || 1)));
      return { d0, d1: d0, frac: 0, mmdd0: _mmddFromDOY(d0), mmdd1: _mmddFromDOY(d0) };
    }
    // Continuous DOY interpolation between adjacent days.
    const d = _clampDOY(STRATEGIC_STATE.doy);
    const base = Math.floor(d);
    const frac = d - base;
    const d0 = Math.max(1, Math.min(365, base));
    const d1 = (d0 >= 365) ? 1 : (d0 + 1);
    return { d0, d1, frac, mmdd0: _mmddFromDOY(d0), mmdd1: _mmddFromDOY(d1) };
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

  // --- Strategic rain rendering helpers (Phase 1: precipitation visualization only) ---
  function _gaussianKernel1D(sigma) {
    const s = Math.max(0.01, Number(sigma) || 1.0);
    const radius = Math.max(1, Math.ceil(3 * s));
    const w = [];
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      const v = Math.exp(-0.5 * (i * i) / (s * s));
      w.push(v);
      sum += v;
    }
    const inv = sum > 0 ? (1 / sum) : 1;
    for (let i = 0; i < w.length; i++) w[i] *= inv;
    return { radius, w };
  }

  function _gaussianBlur2D_nanAware(grid, sigma) {
    // grid: Array<Array<number>>; may include NaN for missing cells.
    if (!grid || !grid.length) return grid;
    const rows = grid.length;
    const cols = grid[0] ? grid[0].length : 0;
    if (rows < 2 || cols < 2) return grid;

    const { radius, w } = _gaussianKernel1D(sigma);

    // Horizontal pass
    const tmp = Array.from({ length: rows }, () => Array.from({ length: cols }, () => NaN));
    for (let r = 0; r < rows; r++) {
      const row = grid[r];
      for (let c = 0; c < cols; c++) {
        let acc = 0;
        let ws = 0;
        for (let k = -radius; k <= radius; k++) {
          const cc = c + k;
          if (cc < 0 || cc >= cols) continue;
          const v = row[cc];
          if (!Number.isFinite(v)) continue;
          const wk = w[k + radius];
          acc += wk * v;
          ws += wk;
        }
        tmp[r][c] = ws > 0 ? (acc / ws) : NaN;
      }
    }

    // Vertical pass
    const out = Array.from({ length: rows }, () => Array.from({ length: cols }, () => NaN));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let acc = 0;
        let ws = 0;
        for (let k = -radius; k <= radius; k++) {
          const rr = r + k;
          if (rr < 0 || rr >= rows) continue;
          const v = tmp[rr][c];
          if (!Number.isFinite(v)) continue;
          const wk = w[k + radius];
          acc += wk * v;
          ws += wk;
        }
        out[r][c] = ws > 0 ? (acc / ws) : NaN;
      }
    }
    return out;
  }

  function _prepareStrategicRainRide(points, opts) {
    // Returns a tileMap where `precipitation_mm` holds the *smoothed, scaled* rain field.
    // Also returns per-tile smoothed raw-mm (approx) for optional contours.
    const sigma = (opts && Number.isFinite(Number(opts.sigma))) ? Number(opts.sigma) : 1.0;
    const m = new Map();
    const pts = Array.isArray(points) ? points : [];
    if (!pts.length) return { mapScaled: m, pointsForContours: [], sigma };

    let rowMin = Infinity, rowMax = -Infinity, colMin = Infinity, colMax = -Infinity;
    const items = [];
    for (const p of pts) {
      if (!p || !p.tile_id) continue;
      const r = Number(p.row);
      const c = Number(p.col);
      if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
      rowMin = Math.min(rowMin, r);
      rowMax = Math.max(rowMax, r);
      colMin = Math.min(colMin, c);
      colMax = Math.max(colMax, c);
      const raw = Math.max(0, Number(p.precipitation_mm));
      items.push({ id: String(p.tile_id), r, c, raw, lat: Number(p.lat), lon: Number(p.lon) });
    }
    if (!Number.isFinite(rowMin) || !Number.isFinite(colMin)) return { mapScaled: m, pointsForContours: [], sigma };
    const rows = (rowMax - rowMin + 1);
    const cols = (colMax - colMin + 1);
    if (rows <= 0 || cols <= 0) return { mapScaled: m, pointsForContours: [], sigma };

    // STEP 1: threshold (ignore drizzle)
    // rain_effective = max(0, rain - 0.5)
    const eff = Array.from({ length: rows }, () => Array.from({ length: cols }, () => NaN));
    for (const it of items) {
      const rr = it.r - rowMin;
      const cc = it.c - colMin;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const v = Math.max(0, it.raw - 0.5);
      eff[rr][cc] = Number.isFinite(v) ? v : NaN;
    }

    // STEP 2: non-linear scaling (preferred): log(1 + rain_effective)
    const scaled = Array.from({ length: rows }, () => Array.from({ length: cols }, () => NaN));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = eff[r][c];
        scaled[r][c] = Number.isFinite(v) ? Math.log1p(Math.max(0, v)) : NaN;
      }
    }

    // STEP 3: Gaussian smoothing BEFORE interpolation.
    const smoothScaled = _gaussianBlur2D_nanAware(scaled, sigma);

    // Prepare map for existing interpolation:
    // Store the smoothed/scaled field into `precipitation_mm`.
    // (Only used by the Strategic rain layer; tooltip/comfort still use the raw tileMap.)
    const pointsForContours = [];
    for (const it of items) {
      const rr = it.r - rowMin;
      const cc = it.c - colMin;
      let s = (rr >= 0 && cc >= 0 && rr < rows && cc < cols) ? smoothScaled[rr][cc] : NaN;
      if (!Number.isFinite(s)) {
        // Fallback to unsmoothed if smoothing had no neighbors.
        const vEff = Math.max(0, it.raw - 0.5);
        s = Math.log1p(vEff);
      }

      m.set(it.id, {
        tile_id: it.id,
        precipitation_mm: Number(s),
      });

      // For optional contours, we invert the scaled field back to effective mm,
      // then add the 0.5mm threshold offset to get an approximate raw-mm value.
      const effMm = Math.max(0, (Math.expm1 ? Math.expm1(Number(s)) : (Math.exp(Number(s)) - 1)));
      const rawApprox = (effMm > 0) ? (effMm + 0.5) : 0;
      if (Number.isFinite(it.lat) && Number.isFinite(it.lon)) {
        pointsForContours.push({
          tile_id: it.id,
          row: it.r,
          col: it.c,
          lat: it.lat,
          lon: it.lon,
          __rain_raw_mm_smooth: rawApprox,
        });
      }
    }

    return { mapScaled: m, pointsForContours, sigma };
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
      // Use global tempColor() palette (shared across app).
      try {
        const m = String(tempColor(t) || 'rgba(0,0,0,1)').match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (!m) return null;
        const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
        return { r, g, b, a: 0.78 };
      } catch (_) {
        return null;
      }
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

  async function _fetchStrategicGridForMMDD(mmdd) {
    if (!STRATEGIC_STATE.active) return;
    const b = map.getBounds();
    const latMin = b.getSouth();
    const latMax = b.getNorth();
    const lonMin = b.getWest();
    const lonMax = b.getEast();

    const cacheKey = _strategicCacheKey(STRATEGIC_STATE.year, STRATEGIC_STATE.timescale, mmdd, latMin, latMax, lonMin, lonMax);
    const cached = _strategicCacheGet(cacheKey);
    if (cached) {
      return cached;
    }

    const url = `/api/strategic_grid?year=${encodeURIComponent(String(STRATEGIC_STATE.year))}`
      + `&timescale=${encodeURIComponent(String(STRATEGIC_STATE.timescale || 'daily'))}`
      + `&date=${encodeURIComponent(String(mmdd))}`
      + `&lat_min=${encodeURIComponent(String(latMin))}&lat_max=${encodeURIComponent(String(latMax))}`
      + `&lon_min=${encodeURIComponent(String(lonMin))}&lon_max=${encodeURIComponent(String(lonMax))}`;
    const t0 = Date.now();

    // Abort any in-flight request; slider scrubs should only render the latest.
    try {
      if (STRATEGIC_STATE.fetchAbort) STRATEGIC_STATE.fetchAbort.abort();
    } catch (_) {}
    const ac = new AbortController();
    STRATEGIC_STATE.fetchAbort = ac;

    const resp = await fetch(url, { signal: ac.signal });
    const j = await resp.json();
    if (!resp.ok) throw new Error(j && j.error ? j.error : `HTTP ${resp.status}`);
    try { _strategicCacheSet(cacheKey, j); } catch (_) {}
    STRATEGIC_STATE.lastFetchAt = t0;
    return j;
  }

  function _blendStrategicPoints(aPoints, bPoints, frac) {
    const fa = _clamp01(1 - frac);
    const fb = _clamp01(frac);
    const aMap = _makeTileMap(aPoints);
    const bMap = _makeTileMap(bPoints);
    const keys = new Set();
    for (const p of (aPoints || [])) if (p && p.tile_id) keys.add(String(p.tile_id));
    for (const p of (bPoints || [])) if (p && p.tile_id) keys.add(String(p.tile_id));

    const out = [];
    const lerpNum = (x, y) => {
      const a = Number(x);
      const b = Number(y);
      const okA = Number.isFinite(a);
      const okB = Number.isFinite(b);
      if (!okA && !okB) return null;
      if (!okA) return b;
      if (!okB) return a;
      return a * fa + b * fb;
    };
    const lerpDir = (xDeg, yDeg) => {
      const a = Number(xDeg);
      const b = Number(yDeg);
      if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
      if (!Number.isFinite(a)) return b;
      if (!Number.isFinite(b)) return a;
      const aR = a * Math.PI / 180;
      const bR = b * Math.PI / 180;
      const x = Math.cos(aR) * fa + Math.cos(bR) * fb;
      const y = Math.sin(aR) * fa + Math.sin(bR) * fb;
      let deg = Math.atan2(y, x) * 180 / Math.PI;
      if (deg < 0) deg += 360;
      return deg;
    };

    for (const k of keys) {
      const pa = aMap.get(k);
      const pb = bMap.get(k);
      const p = pa || pb;
      if (!p) continue;
      const merged = { ...p };
      const numKeys = [
        'temperature_c','precipitation_mm','rain_probability','rain_typical_mm',
        'wind_speed_ms','wind_var_deg','temp_day_median','temp_day_p25','temp_day_p75'
      ];
      for (const nk of numKeys) merged[nk] = lerpNum(pa && pa[nk], pb && pb[nk]);
      merged.wind_dir_deg = lerpDir(pa && pa.wind_dir_deg, pb && pb.wind_dir_deg);
      out.push(merged);
    }
    return out;
  }

  async function _fetchStrategicGrid() {
    if (!STRATEGIC_STATE.active) return;
    const { mmdd0, mmdd1, frac } = _strategicCurrentMMDDPair();
    const a = await _fetchStrategicGridForMMDD(mmdd0);
    const b = (mmdd1 === mmdd0) ? a : await _fetchStrategicGridForMMDD(mmdd1);
    if (!a || !a.points) return;
    const blended = {
      ...a,
      points: (b && b.points) ? _blendStrategicPoints(a.points, b.points, frac) : a.points,
    };
    STRATEGIC_STATE.lastResp = blended;
  }

  function _prefetchStrategicNeighbor(offsetDays) {
    try {
      if (!STRATEGIC_STATE.active) return;
      const base = Math.floor(_clampDOY(STRATEGIC_STATE.doy));
      let d = base + Number(offsetDays || 0);
      while (d < 1) d += 365;
      while (d > 365) d -= 365;
      const mmdd = _mmddFromDOY(d);
      const b = map.getBounds();
      const latMin = b.getSouth();
      const latMax = b.getNorth();
      const lonMin = b.getWest();
      const lonMax = b.getEast();
      const cacheKey = _strategicCacheKey(STRATEGIC_STATE.year, STRATEGIC_STATE.timescale, mmdd, latMin, latMax, lonMin, lonMax);
      if (_strategicCacheGet(cacheKey)) return;
      const url = `/api/strategic_grid?year=${encodeURIComponent(String(STRATEGIC_STATE.year))}`
        + `&timescale=${encodeURIComponent(String(STRATEGIC_STATE.timescale || 'daily'))}`
        + `&date=${encodeURIComponent(String(mmdd))}`
        + `&lat_min=${encodeURIComponent(String(latMin))}&lat_max=${encodeURIComponent(String(latMax))}`
        + `&lon_min=${encodeURIComponent(String(lonMin))}&lon_max=${encodeURIComponent(String(lonMax))}`;
      fetch(url)
        .then(r => r.json().then(j => ({ ok: r.ok, status: r.status, j })))
        .then(({ ok, status, j }) => {
          if (!ok) throw new Error((j && j.error) ? j.error : `HTTP ${status}`);
          _strategicCacheSet(cacheKey, j);
        })
        .catch(() => {});
    } catch (_) {}
  }

  function _gridFromPoints(points, valueKey) {
    const mp = new Map();
    let rowMin = Infinity, rowMax = -Infinity, colMin = Infinity, colMax = -Infinity;
    for (const p of (points || [])) {
      if (!p) continue;
      const r = Number(p.row);
      const c = Number(p.col);
      const lat = Number(p.lat);
      const lon = Number(p.lon);
      const v = Number(p[valueKey]);
      if (!Number.isFinite(r) || !Number.isFinite(c) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!Number.isFinite(v)) continue;
      const key = `${r}|${c}`;
      mp.set(key, { r, c, lat, lon, v });
      rowMin = Math.min(rowMin, r);
      rowMax = Math.max(rowMax, r);
      colMin = Math.min(colMin, c);
      colMax = Math.max(colMax, c);
    }
    if (!Number.isFinite(rowMin) || !Number.isFinite(colMin)) return null;
    const rows = (rowMax - rowMin + 1);
    const cols = (colMax - colMin + 1);
    if (rows <= 1 || cols <= 1) return null;

    const lat = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
    const lon = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
    const val = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
    for (const it of mp.values()) {
      const rr = it.r - rowMin;
      const cc = it.c - colMin;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      lat[rr][cc] = it.lat;
      lon[rr][cc] = it.lon;
      val[rr][cc] = it.v;
    }
    return { rowMin, colMin, rows, cols, lat, lon, val };
  }

  function _marchingSquaresPaths(grid, threshold) {
    // Returns array of paths; each path is array of {lat,lon}
    if (!grid) return [];
    const segs = [];
    const thr = Number(threshold);
    if (!Number.isFinite(thr)) return [];

    const interpPt = (p0, p1, v0, v1) => {
      const a = Number(v0);
      const b = Number(v1);
      const t = (Math.abs(b - a) < 1e-12) ? 0.5 : ((thr - a) / (b - a));
      const u = _clamp01(t);
      return { lat: _lerp(p0.lat, p1.lat, u), lon: _lerp(p0.lon, p1.lon, u) };
    };

    for (let r = 0; r < grid.rows - 1; r++) {
      for (let c = 0; c < grid.cols - 1; c++) {
        const vTL = grid.val[r][c];
        const vTR = grid.val[r][c + 1];
        const vBR = grid.val[r + 1][c + 1];
        const vBL = grid.val[r + 1][c];
        const latTL = grid.lat[r][c], lonTL = grid.lon[r][c];
        const latTR = grid.lat[r][c + 1], lonTR = grid.lon[r][c + 1];
        const latBR = grid.lat[r + 1][c + 1], lonBR = grid.lon[r + 1][c + 1];
        const latBL = grid.lat[r + 1][c], lonBL = grid.lon[r + 1][c];

        if ([vTL, vTR, vBR, vBL, latTL, lonTL, latTR, lonTR, latBR, lonBR, latBL, lonBL].some(x => x === null)) continue;

        const a = Number(vTL), b = Number(vTR), d = Number(vBL), e = Number(vBR);
        const pTL = { lat: Number(latTL), lon: Number(lonTL) };
        const pTR = { lat: Number(latTR), lon: Number(lonTR) };
        const pBR = { lat: Number(latBR), lon: Number(lonBR) };
        const pBL = { lat: Number(latBL), lon: Number(lonBL) };
        const aboveTL = a >= thr;
        const aboveTR = b >= thr;
        const aboveBR = e >= thr;
        const aboveBL = d >= thr;

        const crossings = {};
        // top edge TL-TR
        if (aboveTL !== aboveTR) crossings.top = interpPt(pTL, pTR, a, b);
        // right edge TR-BR
        if (aboveTR !== aboveBR) crossings.right = interpPt(pTR, pBR, b, e);
        // bottom edge BL-BR (note order left->right)
        if (aboveBL !== aboveBR) crossings.bottom = interpPt(pBL, pBR, d, e);
        // left edge TL-BL (note order top->bottom)
        if (aboveTL !== aboveBL) crossings.left = interpPt(pTL, pBL, a, d);

        const edges = Object.keys(crossings);
        if (edges.length === 2) {
          segs.push([crossings[edges[0]], crossings[edges[1]]]);
        } else if (edges.length === 4) {
          // Ambiguous saddle: decide using cell center value.
          const center = (a + b + d + e) / 4.0;
          if (center >= thr) {
            // Connect top-right and bottom-left
            segs.push([crossings.top, crossings.right]);
            segs.push([crossings.bottom, crossings.left]);
          } else {
            // Connect top-left and bottom-right
            segs.push([crossings.top, crossings.left]);
            segs.push([crossings.bottom, crossings.right]);
          }
        }
      }
    }

    // Chain segments into paths.
    const keyOf = (p) => `${(Math.round(p.lat * 1e5) / 1e5).toFixed(5)},${(Math.round(p.lon * 1e5) / 1e5).toFixed(5)}`;
    const adj = new Map();
    const segUsed = new Array(segs.length).fill(false);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const k0 = keyOf(s[0]);
      const k1 = keyOf(s[1]);
      if (!adj.has(k0)) adj.set(k0, []);
      if (!adj.has(k1)) adj.set(k1, []);
      adj.get(k0).push({ i, end: 0, other: k1 });
      adj.get(k1).push({ i, end: 1, other: k0 });
    }

    const paths = [];
    for (let i = 0; i < segs.length; i++) {
      if (segUsed[i]) continue;
      segUsed[i] = true;
      const s0 = segs[i];
      let path = [s0[0], s0[1]];

      // Extend forward
      while (true) {
        const end = path[path.length - 1];
        const k = keyOf(end);
        const opts = adj.get(k) || [];
        let next = null;
        for (const o of opts) {
          if (segUsed[o.i]) continue;
          next = o;
          break;
        }
        if (!next) break;
        segUsed[next.i] = true;
        const seg = segs[next.i];
        const pA = seg[0];
        const pB = seg[1];
        const kA = keyOf(pA);
        const kB = keyOf(pB);
        if (kA === k) path.push(pB);
        else if (kB === k) path.push(pA);
        else break;
      }

      // Extend backward
      while (true) {
        const start = path[0];
        const k = keyOf(start);
        const opts = adj.get(k) || [];
        let next = null;
        for (const o of opts) {
          if (segUsed[o.i]) continue;
          next = o;
          break;
        }
        if (!next) break;
        segUsed[next.i] = true;
        const seg = segs[next.i];
        const pA = seg[0];
        const pB = seg[1];
        const kA = keyOf(pA);
        const kB = keyOf(pB);
        if (kA === k) path.unshift(pB);
        else if (kB === k) path.unshift(pA);
        else break;
      }

      if (path.length >= 2) paths.push(path);
    }
    return paths;
  }

  function _chaikinSmoothOpen(points, iterations) {
    const it = Math.max(0, Math.min(3, Math.round(Number(iterations) || 0)));
    let pts = Array.isArray(points) ? points : [];
    for (let k = 0; k < it; k++) {
      if (!pts || pts.length < 3) break;
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        const q = { x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y };
        const r = { x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y };
        out.push(q, r);
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  function _chaikinSmoothClosed(points, iterations) {
    const it = Math.max(0, Math.min(2, Math.round(Number(iterations) || 0)));
    let pts = Array.isArray(points) ? points : [];
    for (let k = 0; k < it; k++) {
      if (!pts || pts.length < 4) break;
      const out = [];
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % n];
        const q = { x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y };
        const r = { x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y };
        out.push(q, r);
      }
      pts = out;
    }
    return pts;
  }

  function _drawFilledThresholdCells(ctx, grid, threshold, rgba, alpha, smoothIters) {
    if (!grid) return;
    const thr = Number(threshold);
    if (!Number.isFinite(thr)) return;
    const aFill = _clamp01(alpha);

    const interpT = (v0, v1) => {
      const a = Number(v0);
      const b = Number(v1);
      const t = (Math.abs(b - a) < 1e-12) ? 0.5 : ((thr - a) / (b - a));
      return _clamp01(t);
    };
    const lerpXY = (p0, p1, t) => ({ x: _lerp(p0.x, p1.x, t), y: _lerp(p0.y, p1.y, t) });

    ctx.save();
    ctx.globalAlpha = aFill;
    ctx.fillStyle = `rgba(${rgba.r},${rgba.g},${rgba.b},1)`;
    ctx.beginPath();

    for (let r = 0; r < grid.rows - 1; r++) {
      for (let c = 0; c < grid.cols - 1; c++) {
        const vTL = grid.val[r][c];
        const vTR = grid.val[r][c + 1];
        const vBR = grid.val[r + 1][c + 1];
        const vBL = grid.val[r + 1][c];
        const latTL = grid.lat[r][c], lonTL = grid.lon[r][c];
        const latTR = grid.lat[r][c + 1], lonTR = grid.lon[r][c + 1];
        const latBR = grid.lat[r + 1][c + 1], lonBR = grid.lon[r + 1][c + 1];
        const latBL = grid.lat[r + 1][c], lonBL = grid.lon[r + 1][c];
        if ([vTL, vTR, vBR, vBL, latTL, lonTL, latTR, lonTR, latBR, lonBR, latBL, lonBL].some(x => x === null)) continue;

        const a = Number(vTL), b = Number(vTR), e = Number(vBR), d = Number(vBL);
        if (![a, b, d, e].every(Number.isFinite)) continue;

        const qTL = map.latLngToContainerPoint([Number(latTL), Number(lonTL)]);
        const qTR = map.latLngToContainerPoint([Number(latTR), Number(lonTR)]);
        const qBR = map.latLngToContainerPoint([Number(latBR), Number(lonBR)]);
        const qBL = map.latLngToContainerPoint([Number(latBL), Number(lonBL)]);

        const aboveTL = a >= thr;
        const aboveTR = b >= thr;
        const aboveBR = e >= thr;
        const aboveBL = d >= thr;
        let code = 0;
        if (aboveTL) code |= 8;
        if (aboveTR) code |= 4;
        if (aboveBR) code |= 2;
        if (aboveBL) code |= 1;
        if (code === 0) continue;

        const tTop = (aboveTL !== aboveTR) ? interpT(a, b) : null;
        const tRight = (aboveTR !== aboveBR) ? interpT(b, e) : null;
        const tBottom = (aboveBL !== aboveBR) ? interpT(d, e) : null;
        const tLeft = (aboveTL !== aboveBL) ? interpT(a, d) : null;
        const top = (tTop === null) ? null : lerpXY(qTL, qTR, tTop);
        const right = (tRight === null) ? null : lerpXY(qTR, qBR, tRight);
        const bottom = (tBottom === null) ? null : lerpXY(qBL, qBR, tBottom);
        const left = (tLeft === null) ? null : lerpXY(qTL, qBL, tLeft);

        const polys = [];
        const center = (a + b + d + e) / 4.0;

        switch (code) {
          case 15: polys.push([qTL, qTR, qBR, qBL]); break;
          case 1: if (left && bottom) polys.push([qBL, bottom, left]); break;
          case 2: if (right && bottom) polys.push([qBR, right, bottom]); break;
          case 3: if (left && right) polys.push([qBL, qBR, right, left]); break;
          case 4: if (top && right) polys.push([qTR, right, top]); break;
          case 5:
            if (top && right && bottom && left) {
              if (center >= thr) polys.push([top, qTR, right, bottom, qBL, left]);
              else { polys.push([qTR, right, top]); polys.push([qBL, bottom, left]); }
            }
            break;
          case 6: if (top && bottom) polys.push([top, qTR, qBR, bottom]); break;
          case 7: if (top && left) polys.push([top, qTR, qBR, qBL, left]); break;
          case 8: if (left && top) polys.push([qTL, top, left]); break;
          case 9: if (top && bottom) polys.push([qTL, top, bottom, qBL]); break;
          case 10:
            if (top && right && bottom && left) {
              if (center >= thr) polys.push([qTL, top, right, qBR, bottom, left]);
              else { polys.push([qTL, left, top]); polys.push([qBR, right, bottom]); }
            }
            break;
          case 11: if (right && bottom) polys.push([qTL, qTR, right, bottom, qBL]); break;
          case 12: if (left && right) polys.push([qTL, qTR, right, left]); break;
          case 13: if (right && bottom) polys.push([qTL, qTR, right, bottom, qBL]); break;
          case 14: if (left && bottom) polys.push([left, qTL, qTR, qBR, bottom]); break;
          default: break;
        }

        for (const poly of polys) {
          if (!poly || poly.length < 3) continue;
          const pts = (smoothIters && poly.length >= 4) ? _chaikinSmoothClosed(poly, smoothIters) : poly;
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
        }
      }
    }

    ctx.fill();
    ctx.restore();
  }

  function _drawRainZoneLabels(ctx, points, valueKey, bands) {
    try {
      const vals = Array.isArray(points) ? points : [];
      const thresholds = (bands || []).map(b => Number(b.thr)).filter(Number.isFinite).sort((a, b) => a - b);
      if (!thresholds.length) return;

      // Build ranges: [t0,t1), [t1,t2), ..., [tLast, +inf)
      const ranges = thresholds.map((thr, i) => ({
        lo: thr,
        hi: (i + 1 < thresholds.length) ? thresholds[i + 1] : Infinity,
      }));

      // Pick a representative point per range: the max value in that range.
      const picked = [];
      for (const rg of ranges) {
        let best = null;
        let bestV = -Infinity;
        for (const p of vals) {
          if (!p) continue;
          const v = Number(p[valueKey]);
          const lat = Number(p.lat);
          const lon = Number(p.lon);
          if (!Number.isFinite(v) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          if (!(v >= rg.lo && v < rg.hi)) continue;
          if (v > bestV) { bestV = v; best = { v, lat, lon }; }
        }
        if (best) picked.push(best);
      }
      if (!picked.length) return;

      // Draw tiny labels; avoid placing them too close.
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.font = '9px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const placed = [];
      for (const p of picked) {
        const q = map.latLngToContainerPoint([p.lat, p.lon]);
        const tooClose = placed.some(o => {
          const dx = o.x - q.x;
          const dy = o.y - q.y;
          return (dx * dx + dy * dy) < (60 * 60);
        });
        if (tooClose) continue;
        const text = `${Math.round(p.v)}mm`;
        const w = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(255,255,255,0.70)';
        ctx.fillRect(q.x - w / 2 - 3, q.y - 8, w + 6, 14);
        ctx.fillStyle = 'rgba(20,20,20,0.75)';
        ctx.fillText(text, q.x, q.y);
        placed.push({ x: q.x, y: q.y });
      }
      ctx.restore();
    } catch (_) {}
  }

  function _drawIsolines(ctx, grid, thresholds, strokeStyle, lineWidth, labelSet) {
    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.globalAlpha = 1;
    ctx.fillStyle = strokeStyle;
    ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const thr of thresholds) {
      const paths = _marchingSquaresPaths(grid, thr);
      if (!paths || !paths.length) continue;
      for (const path of paths) {
        if (!path || path.length < 2) continue;
        let pts = [];
        for (let i = 0; i < path.length; i++) {
          const q = map.latLngToContainerPoint([path[i].lat, path[i].lon]);
          pts.push({ x: q.x, y: q.y });
        }
        pts = _chaikinSmoothOpen(pts, 1);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();

        // Labels (selected isolines only)
        if (labelSet && labelSet.has(thr) && pts.length >= 6) {
          const mid = Math.floor(pts.length / 2);
          const pA = pts[Math.max(0, mid - 2)];
          const pB = pts[Math.min(pts.length - 1, mid + 2)];
          const pM = pts[mid];
          const ang = Math.atan2(pB.y - pA.y, pB.x - pA.x);
          const text = `${thr}°C`;
          ctx.save();
          ctx.translate(pM.x, pM.y);
          ctx.rotate(ang);
          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          const w = ctx.measureText(text).width;
          ctx.fillRect(-w / 2 - 3, -10, w + 6, 14);
          ctx.fillStyle = strokeStyle;
          ctx.fillText(text, -w / 2, 2);
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  function _drawBandedCellFill(ctx, grid, thresholds, bandColors, alpha) {
    // Simple, non-overlapping banded fill based on the cell-center value.
    // This avoids stacked semi-transparent fills that can create visible grid artifacts.
    if (!grid) return;
    const thr = Array.isArray(thresholds) ? thresholds.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
    const cols = Array.isArray(bandColors) ? bandColors : [];
    if (cols.length < thr.length + 1) return;

    const aFill = _clamp01(alpha);
    // Pre-project all grid nodes once.
    const proj = Array.from({ length: grid.rows }, () => Array.from({ length: grid.cols }, () => null));
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const lat = grid.lat[r][c];
        const lon = grid.lon[r][c];
        if (lat === null || lon === null) continue;
        const q = map.latLngToContainerPoint([Number(lat), Number(lon)]);
        proj[r][c] = { x: q.x, y: q.y };
      }
    }

    // Collect quads per band index.
    const paths = Array.from({ length: thr.length + 1 }, () => []);
    for (let r = 0; r < grid.rows - 1; r++) {
      for (let c = 0; c < grid.cols - 1; c++) {
        const a = Number(grid.val[r][c]);
        const b = Number(grid.val[r][c + 1]);
        const d = Number(grid.val[r + 1][c]);
        const e = Number(grid.val[r + 1][c + 1]);
        if (![a, b, d, e].every(Number.isFinite)) continue;
        const qTL = proj[r][c];
        const qTR = proj[r][c + 1];
        const qBL = proj[r + 1][c];
        const qBR = proj[r + 1][c + 1];
        if (!qTL || !qTR || !qBL || !qBR) continue;

        const center = (a + b + d + e) / 4.0;
        let idx = 0;
        while (idx < thr.length && center >= thr[idx]) idx++;
        const col = cols[idx];
        if (!col) continue;
        paths[idx].push([qTL, qTR, qBR, qBL]);
      }
    }

    ctx.save();
    for (let i = 0; i < paths.length; i++) {
      const quads = paths[i];
      if (!quads || !quads.length) continue;
      const col = cols[i];
      if (!col) continue;
      ctx.globalAlpha = aFill;
      ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},1)`;
      ctx.beginPath();
      for (const q of quads) {
        ctx.moveTo(q[0].x, q[0].y);
        ctx.lineTo(q[1].x, q[1].y);
        ctx.lineTo(q[2].x, q[2].y);
        ctx.lineTo(q[3].x, q[3].y);
        ctx.closePath();
      }
      ctx.fill();
    }
    ctx.restore();
  }

  function _drawBandedTileFill(ctx, points, meta, valueKeyOrFn, thresholds, bandColors, alpha) {
    // Banded fill by drawing each source tile as its own quad (lat/lon bounds derived from tile_km).
    // This avoids holes caused by trying to coerce latitude-dependent lon steps into a rectangular grid.
    if (!ctx || !meta || !points) return;
    const bbox = meta.bbox;
    const tileKm = Number(meta.tile_km);
    if (!bbox || !Number.isFinite(tileKm) || tileKm <= 0) return;

    const thr = Array.isArray(thresholds) ? thresholds.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
    const cols = Array.isArray(bandColors) ? bandColors : [];
    if (cols.length < thr.length + 1) return;

    const aFill = _clamp01(alpha);
    const stepLat = tileKm / 111.32;
    const getVal = (p) => {
      try {
        if (typeof valueKeyOrFn === 'function') return valueKeyOrFn(p);
        const v = Number(p && p[valueKeyOrFn]);
        return Number.isFinite(v) ? v : null;
      } catch (_) {
        return null;
      }
    };

    const quadsByIdx = Array.from({ length: thr.length + 1 }, () => []);
    for (const p of (points || [])) {
      if (!p) continue;
      const latC = Number(p.lat);
      const lonC = Number(p.lon);
      if (!Number.isFinite(latC) || !Number.isFinite(lonC)) continue;
      const v = getVal(p);
      if (!Number.isFinite(v)) continue;

      let idx = 0;
      while (idx < thr.length && v >= thr[idx]) idx++;
      const col = cols[idx];
      if (!col) continue;

      const c = Math.max(0.05, Math.cos(latC * Math.PI / 180));
      const stepLon = tileKm / (111.32 * c);
      const lat0 = latC - stepLat * 0.5;
      const lat1 = latC + stepLat * 0.5;
      const lon0 = lonC - stepLon * 0.5;
      const lon1 = lonC + stepLon * 0.5;

      const qTL = map.latLngToContainerPoint([lat0, lon0]);
      const qTR = map.latLngToContainerPoint([lat0, lon1]);
      const qBR = map.latLngToContainerPoint([lat1, lon1]);
      const qBL = map.latLngToContainerPoint([lat1, lon0]);
      quadsByIdx[idx].push([qTL, qTR, qBR, qBL]);
    }

    ctx.save();
    ctx.globalAlpha = aFill;
    for (let i = 0; i < quadsByIdx.length; i++) {
      const quads = quadsByIdx[i];
      if (!quads || !quads.length) continue;
      const col = cols[i];
      if (!col) continue;
      ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},1)`;
      ctx.beginPath();
      for (const q of quads) {
        ctx.moveTo(q[0].x, q[0].y);
        ctx.lineTo(q[1].x, q[1].y);
        ctx.lineTo(q[2].x, q[2].y);
        ctx.lineTo(q[3].x, q[3].y);
        ctx.closePath();
      }
      ctx.fill();
    }
    ctx.restore();
  }

  function _renderStrategic() {
    if (!STRATEGIC_STATE.active) return;
    const resp = STRATEGIC_STATE.lastResp;
    if (!resp || !resp.points) return;
    if (!STRATEGIC_STATE.isoLayer) return;

    const bboxRaw = _bboxFromResp(resp);
    const tileKm = Number(resp.tile_km || 50);
    const meta = bboxRaw ? { bbox: bboxRaw, tile_km: tileKm } : null;
    const tileMap = _makeTileMap(resp.points);
    const layer = STRATEGIC_STATE.layer;

    // Cache for cursor readout + wind sampling.
    STRATEGIC_STATE._meta = meta;
    STRATEGIC_STATE._tileMap = tileMap;

    STRATEGIC_STATE.isoLayer.drawWith((ctx, size) => {
      const w = size.x;
      const h = size.y;
      ctx.clearRect(0, 0, w, h);

      const needLandClip = !(SETTINGS && SETTINGS.includeSea)
        && (layer === 'temperature_ride' || layer === 'rain_ride' || layer === 'comfort_ride');
      const clipped = needLandClip ? _beginStrategicLandClip(ctx) : false;

      if (layer === 'temperature_ride') {
        // Temperature iso-surfaces (riding-hours median temperature)
        const valueKey = 'temp_day_median';
        const grid = _gridFromPoints(resp.points, valueKey);
        // Fill tiles directly (prevents gaps near coasts); isolines still use grid when available.

        // Non-overlapping band fill (transparent so basemap remains readable)
        const thr = [-10, 0, 10, 20, 30, 40];
        const _rgbFromTemp = (t) => {
          try {
            const m = String(tempColor(Number(t)) || '').match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
            if (!m) return { r: 150, g: 150, b: 150 };
            return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
          } catch (_) {
            return { r: 150, g: 150, b: 150 };
          }
        };
        const cols = [
          _rgbFromTemp(-20), // < -10
          _rgbFromTemp(-5),  // -10..0
          _rgbFromTemp(5),   // 0..10
          _rgbFromTemp(15),  // 10..20
          _rgbFromTemp(25),  // 20..30
          _rgbFromTemp(35),  // 30..40
          _rgbFromTemp(45),  // >=40
        ];
        _drawBandedTileFill(ctx, resp.points, meta, valueKey, thr, cols, 0.22);

        // Isolines every 5°C
        const isoThr = [5,10,15,20,25,30];
        // No labels; keep lines subtle.
        if (grid) _drawIsolines(ctx, grid, isoThr, 'rgba(60,60,60,0.60)', 1, null);
        if (clipped) ctx.restore();
        _strokeStrategicShoreline(ctx);
        return;
      }

      if (layer === 'rain_ride') {
        // Phase 1 enhancement: meteorological-style precipitation field.
        // Pipeline: raw rain -> threshold -> log scaling -> gaussian smoothing -> existing interpolation -> rendering

        // Cache the prepared smoothed/scaled map for this resp.points.
        const sigma = 1.0; // allowed 0.8–1.2; keep stable for now
        let prep = STRATEGIC_STATE._rainRidePrep;
        if (!prep || prep._pointsRef !== resp.points) {
          prep = _prepareStrategicRainRide(resp.points, { sigma });
          prep._pointsRef = resp.points;
          STRATEGIC_STATE._rainRidePrep = prep;
        }

        const rainMapScaled = prep && prep.mapScaled;
        if (!rainMapScaled || !meta) {
          if (clipped) ctx.restore();
          _strokeStrategicShoreline(ctx);
          return;
        }

        // High-contrast precipitation palette (hex -> rgb)
        const _hexRgb = (hex) => {
          const h = String(hex || '').replace('#', '').trim();
          if (h.length !== 6) return { r: 0, g: 0, b: 0 };
          const r = parseInt(h.slice(0, 2), 16);
          const g = parseInt(h.slice(2, 4), 16);
          const b = parseInt(h.slice(4, 6), 16);
          return {
            r: Number.isFinite(r) ? r : 0,
            g: Number.isFinite(g) ? g : 0,
            b: Number.isFinite(b) ? b : 0,
          };
        };
        const PAL = {
          c0: _hexRgb('#ede7f6'),
          c1: _hexRgb('#b39ddb'),
          c2: _hexRgb('#7e57c2'),
          c3: _hexRgb('#5e35b1'),
          c4: _hexRgb('#311b92'),
        };
        const colorForRawMm = (rawMm) => {
          const r = Number(rawMm);
          if (!Number.isFinite(r) || r < 0.5) return null;
          if (r < 1) return PAL.c0;
          if (r < 3) return PAL.c1;
          if (r < 8) return PAL.c2;
          if (r < 20) return PAL.c3;
          return PAL.c4;
        };
        const darken = (rgb, f) => ({
          r: Math.max(0, Math.min(255, Math.round(rgb.r * f))),
          g: Math.max(0, Math.min(255, Math.round(rgb.g * f))),
          b: Math.max(0, Math.min(255, Math.round(rgb.b * f))),
        });

        // Render into a low-res raster and upscale for speed + smoothness.
        const z = map.getZoom ? map.getZoom() : 6;
        const stride = Math.max(2, Math.min(6, Math.round(6 - Math.max(0, Math.min(6, z - 5)))));
        const w2 = Math.max(1, Math.ceil(w / stride));
        const h2 = Math.max(1, Math.ceil(h / stride));
        const off = (STRATEGIC_STATE._rainRideRaster || (STRATEGIC_STATE._rainRideRaster = document.createElement('canvas')));
        off.width = w2;
        off.height = h2;
        const octx = off.getContext('2d');
        if (!octx) {
          if (clipped) ctx.restore();
          _strokeStrategicShoreline(ctx);
          return;
        }
        const img = octx.createImageData(w2, h2);
        const data = img.data;

        // Existing interpolation is kept: we sample `precipitation_mm` from the prepared map.
        // That value is the *smoothed, scaled* rain field (log1p of effective mm).
        for (let y2 = 0; y2 < h2; y2++) {
          const py = y2 * stride + stride * 0.5;
          for (let x2 = 0; x2 < w2; x2++) {
            const px = x2 * stride + stride * 0.5;
            let a = 0;
            let rgb = null;
            try {
              const ll = map.containerPointToLatLng([px, py]);
              const s = ll ? _sampleInterpolated(rainMapScaled, meta, ll.lat, ll.lng) : null;
              const scaledSmooth = s ? Number(s.precipitation_mm) : NaN;
              if (Number.isFinite(scaledSmooth) && scaledSmooth > 1e-9) {
                const effMm = Math.max(0, (Math.expm1 ? Math.expm1(scaledSmooth) : (Math.exp(scaledSmooth) - 1)));
                const rawApprox = (effMm > 0) ? (effMm + 0.5) : 0;
                rgb = colorForRawMm(rawApprox);
                if (rgb) {
                  // Opacity based on the same mm/day value that drives color bins.
                  // This avoids different shades for similar tooltip values.
                  const u = _clamp01(rawApprox / 20.0);
                  a = 0.18 + 0.62 * u;

                  // Slight emphasis for solid rain (>=3mm/day).
                  if (rawApprox >= 3) {
                    a = Math.min(0.9, a * 1.10);
                    rgb = darken(rgb, 0.92);
                  }
                }
              }
            } catch (_) {
              a = 0;
              rgb = null;
            }

            const i = (y2 * w2 + x2) * 4;
            if (!rgb || a <= 0) {
              data[i + 0] = 0;
              data[i + 1] = 0;
              data[i + 2] = 0;
              data[i + 3] = 0;
            } else {
              data[i + 0] = rgb.r;
              data[i + 1] = rgb.g;
              data[i + 2] = rgb.b;
              data[i + 3] = Math.max(0, Math.min(255, Math.round(_clamp01(a) * 255)));
            }
          }
        }

        octx.putImageData(img, 0, 0);
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.globalAlpha = 1;
        ctx.drawImage(off, 0, 0, w2, h2, 0, 0, w, h);
        ctx.restore();

        // Optional subtle contours for readability: 1mm, 5mm, 10mm
        try {
          const contourPts = (prep && prep.pointsForContours) ? prep.pointsForContours : [];
          const grid = _gridFromPoints(contourPts, '__rain_raw_mm_smooth');
          if (grid) {
            _drawIsolines(ctx, grid, [1, 5, 10], 'rgba(120,105,150,0.22)', 1, null);
          }
        } catch (_) {}

        if (clipped) ctx.restore();
        _strokeStrategicShoreline(ctx);
        return;
      }

      if (layer === 'comfort_ride') {
        // Bikepacking comfort index (TempScore + RainScore + WindScore)
        const pts = (resp.points || []).map(p => {
          if (!p) return null;
          const s = _bikepackingComfortScore(p);
          if (s === null) return null;
          return { ...p, bikepacking_comfort: s };
        }).filter(Boolean);
        const valueKey = 'bikepacking_comfort';
        const grid = _gridFromPoints(pts, valueKey);
        // Fill tiles directly (prevents gaps near coasts); isolines use grid when available.

        // ISO-style banded fill + isolines (same rendering approach as temperature/rain)
        const thr = [-2, 0, 2, 4];
        const cols = [
          { r: 220, g: 55,  b: 55 },  // < -2 red
          { r: 245, g: 155, b: 60 },  // -2..0 orange
          { r: 240, g: 220, b: 80 },  // 0..2 yellow
          { r: 40,  g: 160, b: 80 },  // 2..4 green
          { r: 0,   g: 120, b: 70 },  // >= 4 deep green
        ];
        _drawBandedTileFill(ctx, pts, meta, valueKey, thr, cols, 0.22);
        if (grid) _drawIsolines(ctx, grid, thr, 'rgba(60,60,60,0.45)', 1, null);
        if (clipped) ctx.restore();
        _strokeStrategicShoreline(ctx);
        return;
      }

      // Other strategic layers are not part of Phase 1 iso-weather rendering.

      if (clipped) ctx.restore();
      _strokeStrategicShoreline(ctx);
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
        // Phase 2: streamlines only (no arrows)
        STRATEGIC_STATE.windLayer.clear();
        STRATEGIC_STATE.windLayer.startFlow(sampleFn, { speedHint: _meanWindSpeed(resp.points) });
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

        // Best-effort prefetch for smooth next/prev scrubbing.
        setTimeout(() => {
          _prefetchStrategicNeighbor(-1);
          _prefetchStrategicNeighbor(+1);
        }, 0);
      } catch (e) {
        // Ignore abort noise during scrubbing.
        if (!(e && (e.name === 'AbortError'))) console.error('strategic fetch', e);
      }
    }, delay);
  }

  function strategicSetActive(active) {
    // Tactical tour map must never show strategic overlays.
    try {
      if (_tourIsActive() && Boolean(active)) active = false;
    } catch (_) {}

    const on = Boolean(active);
    if (STRATEGIC_STATE.active === on) return;
    STRATEGIC_STATE.active = on;

    _updateStrategicTimelineCssVar();

    if (on) {
      _strategicSetYear(Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR));

      // Coastline uses the higher-res (50m) dataset when available.
      // Load it eagerly so it doesn't appear to "drop" after toggling includeSea.
      try { _ensureStrategicShoreMaskLoaded(); } catch (_) {}

      // Timescale (temporal aggregation): persisted setting, defaults to daily.
      try {
        const ts = String((SETTINGS && SETTINGS.climateTimescale) ? SETTINGS.climateTimescale : (STRATEGIC_STATE.timescale || 'daily'));
        STRATEGIC_STATE.timescale = ts || 'daily';
        if (strategicTimescaleSelect) strategicTimescaleSelect.value = STRATEGIC_STATE.timescale;
      } catch (_) {
        STRATEGIC_STATE.timescale = 'daily';
        try { if (strategicTimescaleSelect) strategicTimescaleSelect.value = 'daily'; } catch (_) {}
      }

      try { _strategicApplyTimescaleUI(); } catch (_) {}

      // Default DOY: today (UTC) mapped into 1..365
      try {
        const today = new Date();
        const y = 2021; // non-leap reference
        const d0 = new Date(Date.UTC(y, today.getUTCMonth(), today.getUTCDate()));
        const start = new Date(Date.UTC(y, 0, 1));
        const doy = 1 + Math.floor((d0 - start) / (24 * 3600 * 1000));
        _strategicSetDOY(Math.max(1, Math.min(365, doy)));
      } catch (_) {
        _strategicSetDOY(1);
      }
      if (strategicLayerSelect) STRATEGIC_STATE.layer = strategicLayerSelect.value;
      if (strategicWindMode) STRATEGIC_STATE.windMode = strategicWindMode.value;
      if (strategicWindOn) {
        // Default: wind overlay on for wind layer, off otherwise
        const want = (STRATEGIC_STATE.layer === 'wind_speed');
        strategicWindOn.checked = want;
        STRATEGIC_STATE.windOn = want;
      }

      if (!STRATEGIC_STATE.isoLayer) STRATEGIC_STATE.isoLayer = _makeHeatLayer();
      if (!STRATEGIC_STATE.windLayer) STRATEGIC_STATE.windLayer = _makeWindLayer();
      try { STRATEGIC_STATE.isoLayer.addTo(map); } catch (_) {}
      try { STRATEGIC_STATE.windLayer.addTo(map); } catch (_) {}

      // Cursor readout
      _ensureStrategicCursorReadout();
      try {
        const c = map.getContainer();
        if (c && STRATEGIC_STATE._cursorMoveHandler) c.removeEventListener('mousemove', STRATEGIC_STATE._cursorMoveHandler, true);
      } catch (_) {}
      // Use a DOM mousemove listener (capture) for robustness; Leaflet mouse events
      // can be blocked by overlay elements depending on z-index/pointer-events.
      STRATEGIC_STATE._cursorMoveHandler = (ev) => {
        if (!STRATEGIC_STATE.active) return;
        const el = _ensureStrategicCursorReadout();
        if (!el) return;
        let dbg = false;
        try { dbg = (String(localStorage.getItem('wm_debug_strategic_tooltip') || '') === '1'); } catch (_) { dbg = false; }
        let ll = null;
        let pt = null;
        try {
          ll = map.mouseEventToLatLng ? map.mouseEventToLatLng(ev) : null;
          pt = map.mouseEventToContainerPoint ? map.mouseEventToContainerPoint(ev) : (ll ? map.latLngToContainerPoint(ll) : null);
        } catch (_) {
          ll = null;
          pt = null;
        }
        if (!ll || !pt) {
          if (!dbg) _hideStrategicCursorReadout();
          return;
        }

        const s = _strategicSampleAt(ll.lat, ll.lng);
        if (!s) {
          if (!dbg) {
            _hideStrategicCursorReadout();
            return;
          }
          el.textContent = `No sample\nLat: ${_fmtNum(ll.lat, 3)}\nLon: ${_fmtNum(ll.lng, 3)}`;
          el.style.display = 'block';
          // Clamp inside map container.
          const cont = map.getContainer();
          const rect = cont ? cont.getBoundingClientRect() : null;
          const cw = cont ? cont.clientWidth : 0;
          const ch = cont ? cont.clientHeight : 0;
          const pad = 8;
          const baseLeft = Math.round((rect ? rect.left : 0) + pt.x);
          const baseTop = Math.round((rect ? rect.top : 0) + pt.y);
          let left = Math.round(baseLeft + 14);
          let top = Math.round(baseTop + 14);
          el.style.left = `${left}px`;
          el.style.top = `${top}px`;
          const tw = el.offsetWidth || 0;
          const th = el.offsetHeight || 0;
          if (cw && rect && (left + tw + pad) > (rect.left + cw)) left = Math.max(rect.left + pad, rect.left + cw - tw - pad);
          if (ch && rect && (top + th + pad) > (rect.top + ch)) top = Math.max(rect.top + pad, rect.top + ch - th - pad);
          el.style.left = `${left}px`;
          el.style.top = `${top}px`;
          return;
        }

        const y = Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
        const ts = String(STRATEGIC_STATE.timescale || 'daily');
        const p = _strategicPeriodForDOY(STRATEGIC_STATE.doy, ts, y);
        const dateStr = (p && p.monitorLabel) ? String(p.monitorLabel) : `${y}-${_mmddFromDOY(STRATEGIC_STATE.doy)}`;

        const daysInPeriod = (p && Number.isFinite(Number(p.startDoy)) && Number.isFinite(Number(p.endDoy)))
          ? Math.max(1, Math.round(Number(p.endDoy) - Number(p.startDoy) + 1))
          : 1;

        const t = Number(s.temp_day_median);

        // For rain_ride, the map rendering uses a smoothed precipitation field.
        // Use the same field value in the tooltip so color and numbers match.
        let r = Number(s.precipitation_mm);
        try {
          if (String(STRATEGIC_STATE.layer || '') === 'rain_ride') {
            const prep = STRATEGIC_STATE._rainRidePrep;
            const meta2 = STRATEGIC_STATE._meta;
            if (prep && prep.mapScaled && meta2 && ll) {
              const ss = _sampleInterpolated(prep.mapScaled, meta2, ll.lat, ll.lng);
              const scaledSmooth = ss ? Number(ss.precipitation_mm) : NaN;
              if (Number.isFinite(scaledSmooth) && scaledSmooth > 1e-9) {
                const effMm = Math.max(0, (Math.expm1 ? Math.expm1(scaledSmooth) : (Math.exp(scaledSmooth) - 1)));
                const rawApprox = (effMm > 0) ? (effMm + 0.5) : 0;
                r = rawApprox;
              } else {
                r = 0;
              }
            }
          }
        } catch (_) {}
        const w = Number(s.wind_speed_ms);
        const wdFrom = Number(s.wind_dir_deg);
        const wdTo = Number.isFinite(wdFrom) ? ((wdFrom + 180) % 360) : null;
        const comfort = ([t, r, w].every(Number.isFinite))
          ? (_bikepackingTempScore(t) + _bikepackingRainScore(r) + _bikepackingWindScore(w))
          : null;

        const lines = [
          `${dateStr}`,
          `Temp: ${_fmtNum(t, 1)} °C`,
          `Rain: ${_fmtNum(r, 1)} mm/day`,
          `Rain sum: ${_fmtNum((Number.isFinite(r) ? (r * daysInPeriod) : NaN), 1)} mm (${daysInPeriod}d)`,
          `Wind: ${_fmtNum(w, 1)} m/s${Number.isFinite(wdTo) ? ` (to ${Math.round(wdTo)}°)` : ''}`,
          `Comfort: ${Number.isFinite(comfort) ? String(Math.round(comfort)) : '—'}${Number.isFinite(comfort) ? ` (${_comfortLabel(comfort)})` : ''}`,
        ];
        el.textContent = lines.join('\n');
        el.style.display = 'block';

        // Clamp inside map container.
        const cont = map.getContainer();
        const rect = cont ? cont.getBoundingClientRect() : null;
        const cw = cont ? cont.clientWidth : 0;
        const ch = cont ? cont.clientHeight : 0;
        const pad = 8;
        const baseLeft = Math.round((rect ? rect.left : 0) + pt.x);
        const baseTop = Math.round((rect ? rect.top : 0) + pt.y);
        let left = Math.round(baseLeft + 14);
        let top = Math.round(baseTop + 14);
        // Set once so offsetWidth/Height are measurable.
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        const tw = el.offsetWidth || 0;
        const th = el.offsetHeight || 0;
        if (cw && rect && (left + tw + pad) > (rect.left + cw)) left = Math.max(rect.left + pad, rect.left + cw - tw - pad);
        if (ch && rect && (top + th + pad) > (rect.top + ch)) top = Math.max(rect.top + pad, rect.top + ch - th - pad);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
      };
      try {
        const c = map.getContainer();
        if (c) c.addEventListener('mousemove', STRATEGIC_STATE._cursorMoveHandler, true);
      } catch (_) {}

      try {
        const c = map.getContainer();
        if (STRATEGIC_STATE._cursorLeaveHandler) c.removeEventListener('mouseleave', STRATEGIC_STATE._cursorLeaveHandler);
        STRATEGIC_STATE._cursorLeaveHandler = () => {
          _hideStrategicCursorReadout();
        };
        c.addEventListener('mouseleave', STRATEGIC_STATE._cursorLeaveHandler);
      } catch (_) {}

      _scheduleStrategicFetch();
      _updateStrategicLegend();
      _syncStrategicQuickLayer();
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
      try {
        if (STRATEGIC_STATE.fetchAbort) STRATEGIC_STATE.fetchAbort.abort();
      } catch (_) {}
      STRATEGIC_STATE.fetchAbort = null;

      STRATEGIC_STATE._meta = null;
      STRATEGIC_STATE._tileMap = null;

      try {
        const c = map.getContainer();
        if (c && STRATEGIC_STATE._cursorMoveHandler) c.removeEventListener('mousemove', STRATEGIC_STATE._cursorMoveHandler, true);
      } catch (_) {}
      STRATEGIC_STATE._cursorMoveHandler = null;
      try {
        const c = map.getContainer();
        if (c && STRATEGIC_STATE._cursorLeaveHandler) c.removeEventListener('mouseleave', STRATEGIC_STATE._cursorLeaveHandler);
      } catch (_) {}
      STRATEGIC_STATE._cursorLeaveHandler = null;
      _hideStrategicCursorReadout();

      if (STRATEGIC_STATE.windLayer) {
        STRATEGIC_STATE.windLayer.stop();
        STRATEGIC_STATE.windLayer.clear();
        try { map.removeLayer(STRATEGIC_STATE.windLayer); } catch (_) {}
      }
      if (STRATEGIC_STATE.isoLayer) {
        try { map.removeLayer(STRATEGIC_STATE.isoLayer); } catch (_) {}
      }
      _updateStrategicLegend();
      _syncStrategicQuickLayer();
    }
  }

  // Debug helper (console): strategic cursor readout reliability.
  try {
    window.wmStrategicTooltipDebug = {
      enable: () => { try { localStorage.setItem('wm_debug_strategic_tooltip', '1'); } catch (_) {} try { strategicSetActive(true); } catch (_) {} },
      disable: () => { try { localStorage.removeItem('wm_debug_strategic_tooltip'); } catch (_) {} },
    };
  } catch (_) {}

  try {
    window.addEventListener('resize', () => {
      _updateStrategicTimelineCssVar();
    });
  } catch (_) {}

  // UI wiring
  if (strategicTimescaleSelect) {
    strategicTimescaleSelect.addEventListener('change', () => {
      const ts = String(strategicTimescaleSelect.value || 'daily');
      STRATEGIC_STATE.timescale = ts;
      try { SETTINGS.climateTimescale = ts; saveSettings(SETTINGS); } catch (_) {}
      try { _strategicApplyTimescaleUI(); } catch (_) {}
      _scheduleStrategicFetch();
    });
  }
  if (strategicLayerSelect) {
    strategicLayerSelect.addEventListener('change', () => {
      STRATEGIC_STATE.layer = strategicLayerSelect.value;
      if (strategicWindOn && STRATEGIC_STATE.layer === 'wind_speed' && !strategicWindOn.checked) {
        strategicWindOn.checked = true;
        STRATEGIC_STATE.windOn = true;
      }
      _updateStrategicLegend();
      _syncStrategicQuickLayer();
      _renderStrategic();
    });
  }
  if (strategicQuickLayerSelect) {
    strategicQuickLayerSelect.addEventListener('change', () => {
      const layer = String(strategicQuickLayerSelect.value || '');
      _setStrategicLayer(layer);
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
      const ts = String(STRATEGIC_STATE.timescale || 'daily');
      const doy = _strategicSliderValueToDOY(strategicDaySlider.value, ts);
      _strategicSetDOY(doy);
      _scheduleStrategicFetch();
    });
  }
  if (strategicPlayBtn) {
    strategicPlayBtn.addEventListener('click', () => {
      STRATEGIC_STATE.playing = !STRATEGIC_STATE.playing;
      strategicPlayBtn.textContent = STRATEGIC_STATE.playing ? 'Pause' : '▶ Play Season';
      if (STRATEGIC_STATE.playTimer) {
        try { clearTimeout(STRATEGIC_STATE.playTimer); } catch (_) {}
        STRATEGIC_STATE.playTimer = null;
      }
      if (STRATEGIC_STATE.playing) {
        const tick = () => {
          if (!STRATEGIC_STATE.playing) return;
          const ts = String(STRATEGIC_STATE.timescale || 'daily');
          const spec = _strategicSliderSpec(ts);
          const cur = _strategicDOYToSliderValue(STRATEGIC_STATE.doy, ts);
          let next = Number(cur) + 1;
          if (next > spec.max) next = spec.min;
          const doy = _strategicSliderValueToDOY(next, ts);
          _strategicSetDOY(doy);
          _scheduleStrategicFetch();
          const delay = 200;
          STRATEGIC_STATE.playTimer = setTimeout(tick, delay);
        };
        STRATEGIC_STATE.playTimer = setTimeout(tick, 200);
      }
    });
  }

  function _strategicStepOnce(delta) {
    if (!STRATEGIC_STATE || !STRATEGIC_STATE.active) return;
    // If stepping manually, pause playback.
    if (STRATEGIC_STATE.playing) {
      STRATEGIC_STATE.playing = false;
      try { if (strategicPlayBtn) strategicPlayBtn.textContent = '▶ Play Season'; } catch (_) {}
      if (STRATEGIC_STATE.playTimer) {
        try { clearTimeout(STRATEGIC_STATE.playTimer); } catch (_) {}
        STRATEGIC_STATE.playTimer = null;
      }
    }
    const ts = String(STRATEGIC_STATE.timescale || 'daily');
    const spec = _strategicSliderSpec(ts);
    const cur = _strategicDOYToSliderValue(STRATEGIC_STATE.doy, ts);
    let next = Number(cur) + Number(delta || 0);
    if (!Number.isFinite(next)) next = spec.min;
    if (next > spec.max) next = spec.min;
    if (next < spec.min) next = spec.max;
    const doy = _strategicSliderValueToDOY(next, ts);
    _strategicSetDOY(doy);
    _scheduleStrategicFetch();
  }

  if (strategicStepBackBtn) {
    strategicStepBackBtn.addEventListener('click', () => _strategicStepOnce(-1));
  }
  if (strategicStepForwardBtn) {
    strategicStepForwardBtn.addEventListener('click', () => _strategicStepOnce(+1));
  }
  // Speed slider removed in Phase 1.

  map.on('moveend zoomend', () => {
    if (!STRATEGIC_STATE.active) return;
    _scheduleStrategicFetch();
  });

  // Settings view wiring
  function applySettingsToForm(s) {
    if (!s) return;
    if (startDateInput && s.startDate) startDateInput.value = String(s.startDate);
    if (tourDaysInput && s.tourDays !== undefined) tourDaysInput.value = String(Number(s.tourDays) || 7);
    if (weatherQualitySelect && s.weatherQuality) weatherQualitySelect.value = String(s.weatherQuality);
    try {
      const rc = document.getElementById('reverse');
      if (rc) rc.checked = Boolean(s.reverse);
    } catch (_) {}
    try { REVERSED = Boolean(s.reverse); } catch (_) {}

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
    if (setWeatherVisualizationMode) setWeatherVisualizationMode.value = String(s.weatherVisualizationMode || 'glyphs');

    if (setStrategicYear) setStrategicYear.value = String(s.strategicYear || 2025);
    if (setIncludeSea) setIncludeSea.checked = Boolean(s.includeSea);
    if (setInterpolation) setInterpolation.checked = Boolean(s.interpolation);
    if (setWindDensity) setWindDensity.value = String(Number(s.windDensity || 40));
    if (setAnimSpeed) setAnimSpeed.value = String(Number(s.animSpeed || 1.0));
    if (setGridKm) setGridKm.value = String(Number(s.gridKm || 50));
    if (setRideHours) setRideHours.value = String(s.rideHours || '10-16');
    if (setTentHours) setTentHours.value = String(s.tentHours || '18-08');
    if (setWindWeighting) setWindWeighting.value = String(s.windWeighting || 'relative');

    if (setOverlayMode) setOverlayMode.value = String(s.overlayMode || 'temperature');
    if (profileOverlaySelect) profileOverlaySelect.value = String(s.overlayMode || 'temperature');
  }

  function readSettingsFromForm(prev) {
    const base = prev ? { ...prev } : {};
    base.startDate = (startDateInput && startDateInput.value) ? String(startDateInput.value) : (new Date()).toISOString().slice(0, 10);
    base.tourDays = Number(tourDaysInput && tourDaysInput.value) || 7;
    base.weatherQuality = (weatherQualitySelect && weatherQualitySelect.value) ? String(weatherQualitySelect.value) : 'best';
    try {
      const rc = document.getElementById('reverse');
      base.reverse = Boolean(rc && rc.checked);
    } catch (_) {
      base.reverse = Boolean(base.reverse);
    }

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
    base.weatherVisualizationMode = (setWeatherVisualizationMode && setWeatherVisualizationMode.value)
      ? String(setWeatherVisualizationMode.value)
      : 'glyphs';
    if (base.weatherVisualizationMode !== 'glyphs' && base.weatherVisualizationMode !== 'bands') base.weatherVisualizationMode = 'glyphs';

    base.strategicYear = Number(setStrategicYear && setStrategicYear.value) || 2025;
    base.includeSea = Boolean(setIncludeSea && setIncludeSea.checked);
    base.interpolation = Boolean(setInterpolation && setInterpolation.checked);
    base.windDensity = Number(setWindDensity && setWindDensity.value) || 40;
    base.animSpeed = Number(setAnimSpeed && setAnimSpeed.value) || 1.0;
    base.gridKm = Number(setGridKm && setGridKm.value) || 50;
    base.rideHours = String(setRideHours && setRideHours.value ? setRideHours.value : '10-16');
    base.tentHours = String(setTentHours && setTentHours.value ? setTentHours.value : '18-08');
    base.windWeighting = String(setWindWeighting && setWindWeighting.value ? setWindWeighting.value : 'relative');
    base.overlayMode = String(setOverlayMode && setOverlayMode.value ? setOverlayMode.value : 'temperature');
    return base;
  }

  function applyPrefsFromFormAndPersist() {
    SETTINGS = readSettingsFromForm(SETTINGS);
    saveSettings(SETTINGS);
    STEP_KM = SETTINGS.stepKm;
    try { REVERSED = Boolean(SETTINGS.reverse); } catch (_) {}
    try { _setOverlayMode(String(SETTINGS.overlayMode || OVERLAY_MODE), { skipPersist: true }); } catch (_) {}
    try { applySettingsToForm(SETTINGS); } catch (_) {}
    try { _updateProfileLegend(); } catch (_) {}

    // Tour bands are purely client-side; toggle immediately.
    try { _setTourBandsEnabled(_tourWantBands()); } catch (_) {}
    try { _setTourBandsData(LAST_PROFILE, OVERLAY_POINTS); } catch (_) {}

    // Strategic overlay reacts to includeSea/interpolation/etc.
    try {
      if (STRATEGIC_STATE && STRATEGIC_STATE.active) {
        _scheduleStrategicFetch();
        _renderStrategic();
      }
    } catch (_) {}
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
    const wantBands = _tourWantBands();

    try {
      if (profileOverlaySelect && !wantBands && profilePanel && profileOverlaySelect.parentElement === profilePanel) {
        profileOverlaySelect.style.top = '8px';
        profileOverlaySelect.style.right = '22px';
      }
    } catch (_) {}
    const hasPins = (!wantBands) && Array.isArray(OVERLAY_POINTS) && OVERLAY_POINTS.length > 0;
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
    // Bands mode: reserve space for the horizontal tactical band strip above the chart.
    if (wantBands) {
      // Reserve enough room for the strip + temperature tags and keep it readable.
      // Also leave some whitespace below the strip so UI overlays (selector) don't clash.
      const bandStripH = 36;
      const bandStripPad = 40;
      neededTop = Math.max(neededTop, bandStripH + bandStripPad);
    }
    // Increase bottom padding slightly to ensure x-axis ticks and labels are fully visible
    // Increase right padding to ensure right-side ticks/labels/color bars aren't clipped
    const padBot = wantBands ? 34 : 22;
    return { padTop: Math.max(minTop, neededTop), padBot, padL: 18, padR: 18 };
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
      // Align tooltip just above the profile panel (legacy floating tooltip only)
      const bottomGap = hh + tsdbH + 16; // slight spacing above profile
      try {
        if (profileTooltip && profilePanel && profileTooltip.parentElement === profilePanel) {
          profileTooltip.style.bottom = `${bottomGap}px`;
        }
      } catch (_) {}
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

    const wantBands = _tourWantBands();

    // In bands mode, draw a horizontal tactical band strip above the profile.
    if (wantBands) {
      try {
        if (DEBUG_PROFILE_STEP) console.log(`%c[STEP ${++DEBUG_STEP_COUNTER}] Draw tactical bands strip (profile)`, 'color: blue; font-weight: bold');
        await waitForSpacebar(DEBUG_STEP_COUNTER, 'Draw tactical bands strip (profile)');

        const pts0 = (Array.isArray(OVERLAY_POINTS) ? OVERLAY_POINTS : []).filter(p => Number.isFinite(Number(p && p.dist)));
        pts0.sort((a, b) => Number(a.dist) - Number(b.dist));
        const havePts = pts0.length >= 2;
        const loadedEnd = pts0.length ? Number(pts0[pts0.length - 1].dist) : 0;

        // Place the strip inside the reserved top padding, centered vertically.
        // Keep some margin from the panel divider and the chart area.
        const stripMargin = 8;
        const availH = Math.max(18, padTop - 2 * stripMargin);
        const stripH = Math.max(26, Math.min(40, Math.round(availH)));
        let stripY = Math.round((padTop - stripH) / 2);
        stripY = Math.max(stripMargin, Math.min(Math.max(stripMargin, padTop - stripH - stripMargin), stripY));

        // Keep the profile overlay selector below the strip (only when selector is mounted inside profile panel).
        try {
          if (profileOverlaySelect && profilePanel && profileOverlaySelect.parentElement === profilePanel) {
            const selH = 24;
            let selTop = Math.round(stripY + stripH + 10);
            // Prefer below the strip; if that would overlap, drop into chart area.
            selTop = Math.max(selTop, Math.round(padTop + 8));
            const maxTop = Math.max(8, Math.round(H - padBot - selH - 6));
            selTop = Math.max(8, Math.min(maxTop, selTop));
            profileOverlaySelect.style.top = `${selTop}px`;
          }
        } catch (_) {}
        const x0 = padL;
        const x1 = padL + innerW;

        // Frame
        profileCtx.save();
        profileCtx.fillStyle = 'rgba(255,255,255,0.92)';
        profileCtx.strokeStyle = 'rgba(0,0,0,0.14)';
        profileCtx.lineWidth = 1;
        profileCtx.beginPath();
        profileCtx.rect(x0, stripY, x1 - x0, stripH);
        profileCtx.fill();
        profileCtx.stroke();
        profileCtx.clip();

        const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
        const lerp = (a, b, t) => a + (b - a) * t;
        const lerpNum = (a, b, t) => (Number.isFinite(Number(a)) && Number.isFinite(Number(b)))
          ? lerp(Number(a), Number(b), t)
          : (Number.isFinite(Number(a)) ? Number(a) : (Number.isFinite(Number(b)) ? Number(b) : null));

        const sampleAt = (dkm) => {
          const x = Number(dkm);
          if (!Number.isFinite(x) || pts0.length === 0) return null;
          const dMin = Number(pts0[0].dist);
          const dMax = Number(pts0[pts0.length - 1].dist);
          if (Number.isFinite(dMin) && Number.isFinite(dMax)) {
            if (x < dMin - 1e-6 || x > dMax + 1e-6) return null;
          }
          if (pts0.length === 1) return pts0[0];
          let lo = 0, hi = pts0.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (Number(pts0[mid].dist) <= x) lo = mid; else hi = mid - 1;
          }
          const i0 = lo;
          const i1 = Math.min(pts0.length - 1, i0 + 1);
          const p0 = pts0[i0];
          const p1 = pts0[i1];
          const d0 = Number(p0.dist);
          const d1 = Number(p1.dist);
          const t = (!Number.isFinite(d0) || !Number.isFinite(d1) || d1 <= d0) ? 0 : clamp((x - d0) / (d1 - d0), 0, 1);
          const dayP25 = lerpNum(p0.temp_day_p25, p1.temp_day_p25, t);
          const dayP75 = lerpNum(p0.temp_day_p75, p1.temp_day_p75, t);
          const histP25 = lerpNum(p0.temp_hist_p25, p1.temp_hist_p25, t);
          const histP75 = lerpNum(p0.temp_hist_p75, p1.temp_hist_p75, t);
          const p25 = (Number.isFinite(dayP25) && Number.isFinite(dayP75)) ? dayP25 : histP25;
          const p75 = (Number.isFinite(dayP25) && Number.isFinite(dayP75)) ? dayP75 : histP75;
          return {
            dist: x,
            temperature: lerpNum(p0.temperature, p1.temperature, t),
            temp_p25: p25,
            temp_p75: p75,
            windSpeed: lerpNum(p0.windSpeed, p1.windSpeed, t),
            windDir: lerpNum(p0.windDir, p1.windDir, t),
            rainTypical: lerpNum((p0.rainTypical ?? p0.precipMm), (p1.rainTypical ?? p1.precipMm), t),
          };
        };
        // Route heading at distance (km). Uses the profile-sampled headings, mapped into the
        // route distance domain via the profile→route scale used for the x-axis.
        const routeHeadingAt = (routeKm) => {
          try {
            const sh = Array.isArray(profile.sampled_heading_deg) ? profile.sampled_heading_deg : null;
            if (!sh || sh.length !== dist.length) return null;
            const rk = Number(routeKm);
            if (!Number.isFinite(rk) || !Number.isFinite(scale) || scale <= 0) return null;
            const pk = rk / scale; // route-km -> profile-km
            let lo = 0, hi = dist.length - 1;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (Number(dist[mid]) < pk) lo = mid + 1; else hi = mid;
            }
            const idx = Math.max(0, Math.min(sh.length - 1, lo));
            const h = Number(sh[idx]);
            return Number.isFinite(h) ? h : null;
          } catch (_) {
            return null;
          }
        };

        // Layout within strip:
        // - top: wind mini-band lane (thin)
        // - gap
        // - temperature band lane (major)
        const windLinePx = (() => {
          // About 3mm looks clearly visible in the profile strip; bump by +30% as requested.
          const px = _mmToPx(3.0) * 1.3;
          return Math.max(4, Math.min(12, Math.round(px || 0)));
        })();
        const windGapPx = Math.max(2, Math.min(10, Math.round(_mmToPx(0.7) || 0)));
        const windLaneH = Math.max(6, Math.min(stripH - 6, Math.round(windLinePx + windGapPx + 2)));
        const tempY = stripY + windLaneH;
        const tempH = Math.max(1, stripH - windLaneH);

        // Temperature band (same palette as map + overlay)
        if (havePts) {
          for (let i = 0; i < pts0.length - 1; i++) {
            const a = pts0[i];
            const b = pts0[i + 1];
            const dA = Number(a.dist);
            const dB = Number(b.dist);
            if (!Number.isFinite(dA) || !Number.isFinite(dB) || dB <= dA) continue;
            const tA = Number(a.temperature);
            const tB = Number(b.temperature);
            if (!Number.isFinite(tA) || !Number.isFinite(tB)) continue;
            const xa = xAt(dA);
            const xb = xAt(dB);
            if (!(xb > xa + 0.5)) continue;
            const grad = profileCtx.createLinearGradient(xa, 0, xb, 0);
            grad.addColorStop(0, tempColor(tA));
            grad.addColorStop(1, tempColor(tB));
            profileCtx.fillStyle = grad;
            profileCtx.fillRect(xa, tempY, xb - xa, tempH);
          }
        }

        // Wind mini-band (Tour spec semantics):
        // - compute effective wind vs route heading (routeHeadingAt)
        // - segment by sign/similarity
        // - draw only significant segments (|v| >= 1 m/s, length >= minSegKm)
        // - one direction triangle per segment
        try {
          const windRouteLen = Math.max(0, Number.isFinite(loadedEnd) ? loadedEnd : 0);
          if (windRouteLen > 1 && typeof routeHeadingAt === 'function') {
            const yWind = stripY + windGapPx + Math.max(1, windLinePx / 2);
            const stepKm = 1.0;
            const minSegKm = 10.0;
            const maxSegKm = 60.0;

            const windCompAt = (dk) => {
              const s = sampleAt(dk);
              if (!s) return 0;
              const wspd = Number(s.windSpeed);
              const wdir = Number(s.windDir);
              const h = routeHeadingAt(dk);
              if (!Number.isFinite(wspd) || !Number.isFinite(wdir) || !Number.isFinite(h)) return 0;
              const wdirTo = ((wdir + 180.0) % 360.0);
              const ang = (wdirTo - h) * Math.PI / 180.0;
              const comp = wspd * Math.cos(ang);
              return Number.isFinite(comp) ? comp : 0;
            };

            const samples = [];
            for (let dk = 0; dk <= windRouteLen + 1e-6; dk += stepKm) {
              samples.push({ d: dk, v: windCompAt(dk) });
            }

            const kindOf = (v) => {
              const x = Number(v);
              if (!Number.isFinite(x) || Math.abs(x) < 1.0) return 0;
              return (x > 0) ? 1 : -1;
            };

            const segs0 = [];
            let cur = null;
            const pushCur = () => {
              if (!cur) return;
              const len = Math.max(0, cur.end - cur.start);
              const val = (cur.n > 0) ? (cur.sum / cur.n) : 0;
              segs0.push({ start: cur.start, end: cur.end, kind: cur.kind, val, len });
              cur = null;
            };

            for (const s of samples) {
              const d = Number(s.d);
              const vRaw = Number(s.v);
              const k = kindOf(vRaw);
              const v = (k === 0) ? 0 : vRaw;
              if (!cur) {
                cur = { start: d, end: d, kind: k, sum: v, n: (k === 0) ? 0 : 1 };
                continue;
              }
              const mean = (cur.n > 0) ? (cur.sum / cur.n) : 0;
              const similar = (k === cur.kind) && (k === 0 || Math.abs(v - mean) <= 1.2);
              const wouldLen = d - cur.start;
              if (similar && wouldLen <= maxSegKm) {
                cur.end = d;
                if (k !== 0) { cur.sum += v; cur.n += 1; }
              } else {
                pushCur();
                cur = { start: d, end: d, kind: k, sum: v, n: (k === 0) ? 0 : 1 };
              }
            }
            pushCur();
            if (segs0.length) segs0[segs0.length - 1].end = windRouteLen;

            const segs1 = [];
            for (const s of segs0) {
              const L = Math.max(0, Number(s.end) - Number(s.start));
              if (!(L > maxSegKm) || s.kind === 0) {
                segs1.push({ ...s, len: L });
                continue;
              }
              const n = Math.ceil(L / maxSegKm);
              for (let i = 0; i < n; i++) {
                const a = Number(s.start) + (i * L) / n;
                const b = Number(s.start) + ((i + 1) * L) / n;
                segs1.push({ start: a, end: b, kind: s.kind, val: s.val, len: b - a });
              }
            }

            const segs = segs1.map(s => {
              const L = Math.max(0, Number(s.end) - Number(s.start));
              if (s.kind !== 0 && L < minSegKm) return { start: s.start, end: s.end, kind: 0, val: 0, len: L };
              return { ...s, len: L };
            });

            profileCtx.lineCap = 'round';
            profileCtx.lineJoin = 'round';
            profileCtx.lineWidth = windLinePx;

            for (const s of segs) {
              if (!s || s.kind === 0) continue;
              const L = Math.max(0, Number(s.end) - Number(s.start));
              if (L < minSegKm) continue;
              const v = Number(s.val);
              if (!Number.isFinite(v) || Math.abs(v) < 1.0) continue;
              const xa = xAt(Number(s.start));
              const xb = xAt(Number(s.end));
              if (!(xb > xa + 2)) continue;
              profileCtx.strokeStyle = _tourWindComponentColor(v);
              profileCtx.beginPath();
              profileCtx.moveTo(xa, yWind);
              profileCtx.lineTo(xb, yWind);
              profileCtx.stroke();

              // Direction triangle (one per segment) with subtle grey outline.
              try {
                const mid = 0.5 * (Number(s.start) + Number(s.end));
                const xMid = xAt(mid);
                const triW = Math.max(6, Math.min(14, Math.round(windLinePx * 1.2)));
                const triH = Math.max(5, Math.min(12, Math.round(windLinePx * 0.95)));
                const dir = (v >= 0) ? 1 : -1;

                profileCtx.save();
                profileCtx.globalAlpha = 0.96;
                profileCtx.fillStyle = 'rgba(255,255,255,0.96)';
                profileCtx.strokeStyle = 'rgba(0,0,0,0.35)';
                profileCtx.lineWidth = 1;
                profileCtx.beginPath();
                profileCtx.moveTo(xMid + dir * (triW / 2), yWind);
                profileCtx.lineTo(xMid - dir * (triW / 2), yWind - triH / 2);
                profileCtx.lineTo(xMid - dir * (triW / 2), yWind + triH / 2);
                profileCtx.closePath();
                profileCtx.fill();
                profileCtx.stroke();
                profileCtx.restore();
              } catch (_) {}
            }
          }
        } catch (_) {}

        // Rain markers (small rounded bars near bottom edge)
        try {
          const rainCat = (mm) => {
            const x = Number(mm);
            if (!Number.isFinite(x) || x <= 1) return 0;
            if (x <= 3) return 1;
            if (x <= 8) return 2;
            if (x <= 15) return 3;
            return 4;
          };
          const rr = (x, y, w, h, r) => {
            const rad = Math.max(0, Math.min(Math.min(w, h) / 2, Number(r) || 0));
            profileCtx.beginPath();
            profileCtx.moveTo(x + rad, y);
            profileCtx.lineTo(x + w - rad, y);
            profileCtx.quadraticCurveTo(x + w, y, x + w, y + rad);
            profileCtx.lineTo(x + w, y + h - rad);
            profileCtx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
            profileCtx.lineTo(x + rad, y + h);
            profileCtx.quadraticCurveTo(x, y + h, x, y + h - rad);
            profileCtx.lineTo(x, y + rad);
            profileCtx.quadraticCurveTo(x, y, x + rad, y);
            profileCtx.closePath();
          };
          profileCtx.fillStyle = 'rgba(35, 120, 210, 0.88)';
          for (const p of pts0) {
            const dk = Number(p.dist);
            if (!Number.isFinite(dk) || dk > loadedEnd + 1e-6) continue;
            const sMid = sampleAt(dk);
            const mm = sMid ? Number(sMid.rainTypical) : NaN;
            const cat = rainCat(mm);
            if (cat <= 0) continue;
            const x = xAt(dk);
            const count = (cat <= 1) ? 1 : (cat === 2) ? 2 : 3;
            const sep = 5;
            const len = 10;
            const barW = 3;
            const rad = 1.8;
            const y0 = stripY + stripH - 4;
            for (let k = 0; k < count; k++) {
              const xo = x + (k - (count - 1) / 2) * sep;
              rr(xo - barW / 2, y0 - len / 2, barW, len, rad);
              profileCtx.fill();
            }
          }
        } catch (_) {}

        // Temperature tags every ~160 km (same copy style as map)
        try {
          const stepLabel = 160;
          const fontPx = 10;
          const boxes = [];
          const overlaps = (a, b) => !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
          profileCtx.font = `600 ${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
          profileCtx.textAlign = 'center';
          profileCtx.textBaseline = 'middle';
          for (let dk = stepLabel; dk < Math.max(0, loadedEnd - 1e-6); dk += stepLabel) {
            const s = sampleAt(dk);
            if (!s) continue;
            const t = Number(s.temperature);
            const loT = Number(s.temp_p25);
            const hiT = Number(s.temp_p75);
            if (!Number.isFinite(t)) continue;
            const x = xAt(dk);
            const y = tempY + tempH / 2;
            const line1 = `${Math.round(t)}°C`;
            const line2 = (Number.isFinite(loT) && Number.isFinite(hiT)) ? `${Math.round(loT)} / ${Math.round(hiT)}` : '';
            const w1 = profileCtx.measureText(line1).width;
            const w2 = line2 ? profileCtx.measureText(line2).width : 0;
            const ww = Math.max(w1, w2);
            const pad = 6;
            const hh = line2 ? (fontPx * 2 + 6) : (fontPx + 6);
            const rect = { x1: x - ww/2 - pad, y1: y - hh/2, x2: x + ww/2 + pad, y2: y + hh/2 };
            let ok = true;
            for (const b of boxes) { if (overlaps(rect, b)) { ok = false; break; } }
            if (!ok) continue;
            boxes.push(rect);
            const r = 7;
            profileCtx.fillStyle = 'rgba(255,255,255,0.85)';
            profileCtx.beginPath();
            profileCtx.moveTo(rect.x1 + r, rect.y1);
            profileCtx.lineTo(rect.x2 - r, rect.y1);
            profileCtx.quadraticCurveTo(rect.x2, rect.y1, rect.x2, rect.y1 + r);
            profileCtx.lineTo(rect.x2, rect.y2 - r);
            profileCtx.quadraticCurveTo(rect.x2, rect.y2, rect.x2 - r, rect.y2);
            profileCtx.lineTo(rect.x1 + r, rect.y2);
            profileCtx.quadraticCurveTo(rect.x1, rect.y2, rect.x1, rect.y2 - r);
            profileCtx.lineTo(rect.x1, rect.y1 + r);
            profileCtx.quadraticCurveTo(rect.x1, rect.y1, rect.x1 + r, rect.y1);
            profileCtx.closePath();
            profileCtx.fill();
            profileCtx.fillStyle = '#111';
            profileCtx.fillText(line1, x, y - (line2 ? fontPx*0.55 : 0));
            if (line2) {
              profileCtx.font = `500 ${fontPx - 1}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
              profileCtx.fillText(line2, x, y + fontPx*0.55);
              profileCtx.font = `600 ${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
            }
          }
        } catch (_) {}

        profileCtx.restore();
      } catch (e) {
        try { profileCtx.restore(); } catch (_) {}
      }
    }
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
    // In bands mode we suppress pins (map + profile must match visualization setting).
    if (!wantBands) {
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
    }
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
        try {
          if (!map.getPane('wmCursorPane')) {
            map.createPane('wmCursorPane');
            map.getPane('wmCursorPane').style.zIndex = '700';
          }
        } catch (_) {}
        MAP_CURSOR_MARKER = L.circleMarker(latlng, { pane: 'wmCursorPane', radius: 6, color: '#555', fillColor: '#555', fillOpacity: 0.85, weight: 0 });
        MAP_CURSOR_MARKER.addTo(map);
      } else {
        MAP_CURSOR_MARKER.setLatLng(latlng);
      }
      try { MAP_CURSOR_MARKER.bringToFront(); } catch (_) {}
    } catch (e) { console.error('updateMapCursorAtDistance error', e); }
  };

  // ---- Exports for ProfileZoomController (frontend-only UX wiring) ----
  function routeLatLngAtDistanceKm(dkm) {
    try {
      if (!Array.isArray(ROUTE_COORDS) || !Array.isArray(ROUTE_CUM_DISTS) || ROUTE_COORDS.length < 2) return null;
      const total = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
      let d = Math.max(0, Math.min(total, Number(dkm || 0)));
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
        const d1 = ROUTE_CUM_DISTS[i - 1];
        const d2 = ROUTE_CUM_DISTS[i];
        const t = (d2 > d1) ? Math.max(0, Math.min(1, (d - d1) / (d2 - d1))) : 0;
        const [lon1, lat1] = ROUTE_COORDS[i - 1];
        const [lon2, lat2] = ROUTE_COORDS[i];
        lon = lon1 + (lon2 - lon1) * t;
        lat = lat1 + (lat2 - lat1) * t;
      }
      return L.latLng(lat, lon);
    } catch (_) {
      return null;
    }
  }

  function profileClientXToRouteKm(clientX) {
    try {
      if (!profileCanvas) return NaN;
      if (!Array.isArray(ROUTE_CUM_DISTS) || ROUTE_CUM_DISTS.length < 2) return NaN;
      const rect = profileCanvas.getBoundingClientRect();
      const { padTop, padBot, padL, padR } = getPads();
      const W = Math.max(1, Math.floor(rect.width));
      const innerW = Math.max(1, W - padL - padR);
      const xClient = Number(clientX - rect.left);
      const xClamped = Math.max(padL, Math.min(padL + innerW, xClient));
      const u = (xClamped - padL) / Math.max(1, innerW);
      const routeLen = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
      return routeLen * Math.max(0, Math.min(1, u));
    } catch (_) {
      return NaN;
    }
  }

  try {
    window.WM = window.WM || {};
    window.WM.routeLatLngAtDistanceKm = routeLatLngAtDistanceKm;
    window.WM.profileClientXToRouteKm = profileClientXToRouteKm;
  } catch (_) {}

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
    const tempHistMedian = best ? (Number.isFinite(best.temp_hist_median) ? Number(best.temp_hist_median) : (Number.isFinite(best.temperature) ? Number(best.temperature) : (Number.isFinite(best.temp_day_median) ? Number(best.temp_day_median) : null))) : null;
    const histMin = (best && Number.isFinite(best.temp_hist_min)) ? Number(best.temp_hist_min) : null;
    const histMax = (best && Number.isFinite(best.temp_hist_max)) ? Number(best.temp_hist_max) : null;
    const dayTypicalMin = (best && Number.isFinite(best.temp_day_typical_min)) ? Number(best.temp_day_typical_min) : null;
    const dayTypicalMax = (best && Number.isFinite(best.temp_day_typical_max)) ? Number(best.temp_day_typical_max) : null;
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
    const tempMedStyled = styleVal(tempHistMedian, (Number(tempHistMedian) <= T_COLD || Number(tempHistMedian) >= T_HOT));
    const rainTypStyled = styleVal(rainTyp, Number(rainTyp) >= R_HIGH);
    if (profileTooltip) {
      // Effective wind: label by sign and highlight by comfort thresholds.
      const effNum = (effWind !== null && Number.isFinite(effWind)) ? Number(effWind) : null;
      const effLabel = (effNum !== null && effNum < 0) ? 'Headwind' : 'Tailwind';
      let effStyled = (effNum === null) ? '-' : `${effNum >= 0 ? '+' : ''}${effNum.toFixed(1)}`;
      if (effNum !== null) {
        const absW = Math.abs(effNum);
        const isTail = effNum > 0;
        const limit = isTail ? W_TAIL : W_HEAD;
        const warn = absW >= limit;
        if (warn) {
          effStyled = `<span style="color:${isTail?'#2a7a2a':'#c0392b'};font-weight:700">${effStyled}</span>`;
        }
      }
      const yearsTxt = `${yearsStart===null||yearsEnd===null?'-':`${yearsStart}–${yearsEnd}`}${matchDays===null?'':` (n=${Math.round(matchDays)})`}`;
      const windDirTxt = (wdir === null || wdir === undefined) ? '-' : `${fmt(wdir,0)}°`;
      const windSpdTxt = (wspd === null || wspd === undefined) ? '-' : `${fmt(wspd,1)} m/s`;
      profileTooltip.innerHTML = `
        <div class="wm-ptt-grid">
          <div class="wm-ptt-col">
            <div class="wm-ptt-line"><span class="wm-ptt-k">Day:</span> ${dayIdx+1} — ${dateStr}</div>
            <div class="wm-ptt-line"><span class="wm-ptt-k">Years:</span> ${yearsTxt}</div>
            <div class="wm-ptt-line"><span class="wm-ptt-k">Distance:</span> ${fmt(dkm,1)} km</div>
            <div class="wm-ptt-line"><span class="wm-ptt-k">Elevation:</span> ${fmt(elev,0)} m</div>
          </div>
          <div class="wm-ptt-col">
            <div class="wm-ptt-line"><span class="wm-ptt-k">Typ. Temperature:</span> ${tempMedStyled} °C</div>
            <div class="wm-ptt-line"><span class="wm-ptt-k">Typ. Range:</span> ${fmt(histMin,1)}–${fmt(histMax,1)} °C</div>
            <div class="wm-ptt-line"><span class="wm-ptt-k">Typical Daytime Variation:</span> ${fmt(dayTypicalMin,1)}–${fmt(dayTypicalMax,1)} °C</div>
          </div>
          <div class="wm-ptt-col">
            <div class="wm-ptt-line"><span class="wm-ptt-k">Typ. Rain:</span> ${rainTypStyled} mm</div>
            <div class="wm-ptt-line"><span class="wm-ptt-k">Rain Probability:</span> ${rainP===null?'-':rainP}%</div>
            <div class="wm-ptt-line"><span class="wm-ptt-k">Wind:</span> ${windDirTxt} ${windSpdTxt}</div>
            <div class="wm-ptt-line"><span class="wm-ptt-k">${effLabel}:</span> ${effStyled} m/s</div>
          </div>
        </div>`;
      profileTooltip.style.visibility = 'visible';
      profileTooltip.style.opacity = '1';
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
      function colorFromTemperature(t) {
        // MUST match global palette used elsewhere.
        return tempColor(Number(t));
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
        const a = Math.max(0, Math.min(1, Number(alpha)));
        const s = String(hex || '');
        if (s[0] === '#' && s.length >= 7) {
          const r = parseInt(s.slice(1,3), 16);
          const g = parseInt(s.slice(3,5), 16);
          const b = parseInt(s.slice(5,7), 16);
          return `rgba(${r}, ${g}, ${b}, ${a})`;
        }
        const m = s.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (m) return `rgba(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])}, ${a})`;
        return `rgba(0, 0, 0, ${a})`;
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
    const forceRestart = !!loadOpts.forceRestart;
    const weatherOnly = !!loadOpts.weatherOnly;
    const autoUpgradeIfSingleYear = !!loadOpts.autoUpgradeIfSingleYear;
    const upgradePass = !!loadOpts._upgradePass;

    // Full stream already emits route+profile before stations; avoid running a separate priming stream.
    try { window.__WM_PROFILE_PRIME_DONE__ = true; } catch (_) {}

    if (forceRestart) {
      // GPX reload (and similar actions) must interrupt any ongoing stream.
      try { evtSource && evtSource.close(); } catch (_) {}
      try {
        if (window.__WM_PRIME_EVT_SOURCE__) window.__WM_PRIME_EVT_SOURCE__.close();
      } catch (_) {}
      PRIME_IN_PROGRESS = false;
      MAIN_IN_PROGRESS = false;
      stopProgressAnim();
    }

    // New stream → reset provenance counters
    resetWeatherProvenance();
    // Update button state
    if (fetchWeatherBtn) {
      fetchWeatherBtn.textContent = 'Downloading...';
      fetchWeatherBtn.disabled = true;
    }
    if (stopWeatherBtn) stopWeatherBtn.style.display = 'block';
    // GPX route/profile progress phase starts immediately; switches on SSE events.
    if (evtSource) { try { evtSource.close(); } catch (_) {} }
    // If we close the stream here, we must allow a fresh start.
    if (forceRestart) {
      MAIN_IN_PROGRESS = false;
      PRIME_IN_PROGRESS = false;
    }
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
      const forceOnlineParam = loadOpts.forceOnline ? '&force_online=1' : '';
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

    const wantMultiYear = histN >= 2;
    let sawSingleYearSpan = false;

    if (weatherOnly) {
      beginWeatherProgress();
      if (sseStatus) sseStatus.textContent = (loadOpts.forceOnline && wantMultiYear)
        ? 'Fetching multi-year weather…'
        : 'Loading weather…';
    } else {
      startGpxRouteProgress();
    }

    // Profile-first priming: disabled (kept code path for reference)
    if (false && !window.__WM_PROFILE_PRIME_DONE__) {
      if (!forceRestart && (PRIME_IN_PROGRESS || MAIN_IN_PROGRESS)) return; // avoid parallel primes
      try { evtSource && evtSource.close(); } catch(_){ }
      try {
        if (window.__WM_PRIME_EVT_SOURCE__) window.__WM_PRIME_EVT_SOURCE__.close();
      } catch(_){ }
      if (forceRestart) {
        PRIME_IN_PROGRESS = false;
        MAIN_IN_PROGRESS = false;
      }
      if (sseStatus) sseStatus.textContent = 'Loading route + profile…';
      OVERLAY_POINTS = [];
      TOUR_HOVER_POINTS_DIRTY = true;
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
      evtSource = new EventSource(`/api/map_stream?date=${mmdd}&step_km=${STEP_KM}&profile_step_km=${profileStep}&tour_planning=${tourPlanningParam}&mode=single_day&total_days=${tourDays}&start_date=${encodeURIComponent(startDateStr)}&hist_years=${histN}&hist_start=${histStart}${offlineOnlyParam}${forceOnlineParam}${gpxParam}${revParam}${qsComfort}`);
    let stationCount = 0;
    let stationTotal = 0;
    // Dim existing glyphs and prepare new layer
    if (glyphLayer) {
      try { glyphLayer.eachLayer(l => { if (l.setOpacity) l.setOpacity(0.3); }); } catch (_) {}
    }
    if (glyphLayerNew) { map.removeLayer(glyphLayerNew); }
    OVERLAY_POINTS = [];
    TOUR_HOVER_POINTS_DIRTY = true;
    glyphLayerNew = L.layerGroup().addTo(map);
    try { _setTourBandsEnabled(_tourWantBands()); } catch (_) {}
    if (!weatherOnly) LAST_PROFILE = null;
    try { _setTourBandsData(LAST_PROFILE, OVERLAY_POINTS); } catch (_) {}

    // Subscribe to streaming map data
    evtSource.addEventListener('route', (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          syncActiveGpxFromStreamPayload(payload);
          // In weather-only upgrade mode, keep the existing route/profile stable.
          if (weatherOnly) {
            const total = Number(payload.total || 0);
            stationTotal = total;
            return;
          }

          // GPX route geometry ready -> switch to elevation/profile phase
          if (PROGRESS_PHASE !== 'weather') startGpxProfileProgress();
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
          TOUR_HOVER_POINTS_DIRTY = true;
          LAST_PROFILE = null;
          try { _setTourBandsData(LAST_PROFILE, OVERLAY_POINTS); } catch (_) {}
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
        syncActiveGpxFromStreamPayload(payload);
        if (weatherOnly) return;
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
        OVERLAY_POINTS = [];
        TOUR_HOVER_POINTS_DIRTY = true;
        try { _setTourBandsData(LAST_PROFILE, OVERLAY_POINTS); } catch (_) {}
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
        // Do not clobber the GPX/profile phase status text here; station updates will set status once weather starts.
        if (sseStatus && PROGRESS_PHASE === 'weather') sseStatus.textContent = `Loading station 0/${stationTotal} from ${spanTxt}`;
      } catch (e) { console.error('route event error', e); }
    });
    // Profile data stream
    evtSource.addEventListener('profile', (ev) => {
      try {
        if (weatherOnly) return;
        const payload = JSON.parse(ev.data);
        if (payload && payload.profile) {
          drawProfile(payload.profile);
          // Precompute nearest route indexes for profile points for cursor sync
          computeProfileRouteIndexes(payload.profile);
          // GPX+profile complete
          if (PROGRESS_PHASE !== 'weather') finishGpxProgress();
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
          if (profileTooltip) {
            profileTooltip.style.visibility = 'hidden';
            profileTooltip.style.opacity = '0';
          }
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
    // Bind GPX UI handlers ONCE (otherwise click can open multiple dialogs)
    if (!GPX_UI_BOUND) {
      GPX_UI_BOUND = true;
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
          try {
            const j = await uploadGpxFileWithProgress(f);
            LAST_GPX_PATH = j.path;
            LAST_GPX_NAME = (j.original_name || f.name || j.name || null);
            updateDropZoneLabel();
            try { applyPrefsFromFormAndPersist(); } catch (_) {}
            try { window.__WM_PROFILE_PRIME_DONE__ = false; } catch(_){ }
            loadMap({ ...(LAST_LOAD_OPTS || {}), forceRestart: true, gpxJustUploaded: true });
          } catch (err) {
            console.error('Upload error', err);
            alert('Upload error: ' + err);
            setProgressIndeterminate(false);
          }
        });
      }

      // Click to open file dialog
      const gpxInput = document.getElementById('gpxFileInput');
      if (dropZone && gpxInput) {
        dropZone.addEventListener('click', (e) => {
          try {
            e.preventDefault();
            e.stopPropagation();
          } catch (_) {}
          if (GPX_UPLOAD_IN_PROGRESS) return;
          gpxInput.click();
        });
        gpxInput.addEventListener('change', async () => {
          const f = gpxInput.files && gpxInput.files[0];
          if (!f) return;
          if (!f.name.toLowerCase().endsWith('.gpx')) { alert('Please choose a .gpx file'); return; }
          try {
            const j = await uploadGpxFileWithProgress(f);
            LAST_GPX_PATH = j.path;
            LAST_GPX_NAME = (j.original_name || f.name || j.name || null);
            updateDropZoneLabel();
            try { applyPrefsFromFormAndPersist(); } catch (_) {}
            try { window.__WM_PROFILE_PRIME_DONE__ = false; } catch(_){ }
            loadMap({ ...(LAST_LOAD_OPTS || {}), forceRestart: true, gpxJustUploaded: true });
          } catch (err) {
            console.error('Upload error', err);
            alert('Upload error: ' + err);
            setProgressIndeterminate(false);
          } finally {
            // Allow selecting the same file again to retrigger change
            try { gpxInput.value = ''; } catch (_) {}
          }
        });
      }
    }

    evtSource.addEventListener('station', (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        const f = payload.feature;
        const [lon, lat] = f.geometry.coordinates;
        const props = f.properties || {};
        const wantBands = _tourWantBands();

        // Detect single-year span (used to decide whether to auto-upgrade to multi-year).
        try {
          if (autoUpgradeIfSingleYear && wantMultiYear) {
            const ys = props._years_start;
            const ye = props._years_end;
            if (ys !== undefined && ys !== null && ye !== undefined && ye !== null) {
              const ysn = Number(ys);
              const yen = Number(ye);
              if (Number.isFinite(ysn) && Number.isFinite(yen) && Math.round(ysn) === Math.round(yen)) {
                sawSingleYearSpan = true;
              }
            }
          }
        } catch (_) {}

        noteWeatherProvenanceFromProps(props);
        // Weather phase begins with first station: reset to 0% and then advance by completed/total.
        if (PROGRESS_PHASE !== 'weather') beginWeatherProgress();
        if (!wantBands) {
          // Build map glyph according to settings
          let icon = null;
          if ((SETTINGS.glyphType === 'svg') || (!SETTINGS.glyphType && !SETTINGS.useClassicWeatherIcons)) {
            const sizedSvg = resizeGlyphSVG(String(props.svg || ''), 51);
            const html = `<div class=\"glyph-inner\" style=\"width:51px;height:51px;filter:saturate(0.70);opacity:0.92;overflow:hidden\">${sizedSvg}</div>`;
            icon = L.divIcon({ html, className: 'glyph-map', iconSize: [51, 51], iconAnchor: [26, 26] });
          } else if (SETTINGS.glyphType === 'cyclist') {
            // Compose cyclist glyph into a 51x51 PNG
            const tMed = (props.temp_hist_median !== undefined) ? Number(props.temp_hist_median) : ((props.temperature_c !== undefined) ? Number(props.temperature_c) : ((props.temp_day_median !== undefined) ? Number(props.temp_day_median) : (props.temp_median || 0)));
            const t25 = (props.temp_day_p25 !== undefined) ? Number(props.temp_day_p25) : ((props.temp_p25 !== undefined) ? Number(props.temp_p25) : null);
            const t75 = (props.temp_day_p75 !== undefined) ? Number(props.temp_day_p75) : ((props.temp_p75 !== undefined) ? Number(props.temp_p75) : null);
            const prob = (props.rain_probability !== undefined) ? Number(props.rain_probability) : 0;
            // Relative wind vs route heading
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
              `<div class="wm-tip-line"><strong>Historical median:</strong> ${fmt((props.temp_hist_median !== undefined ? props.temp_hist_median : props.temperature_c), 1)} °C</div>` +
              `<div class="wm-tip-line"><strong>Historical range:</strong> ${fmt((props.temp_hist_min !== undefined ? props.temp_hist_min : props.temp_p25), 1)}–${fmt((props.temp_hist_max !== undefined ? props.temp_hist_max : props.temp_p75), 1)} °C</div>` +
              `<div class="wm-tip-line"><strong>Typical daytime variation:</strong> ${fmt(props.temp_day_typical_min, 1)}–${fmt(props.temp_day_typical_max, 1)} °C</div>` +
              `<div class=\"wm-tip-line\"><strong>Rain probability:</strong> ${props.rain_probability!==undefined?Math.round(Number(props.rain_probability)*100):'-'}%</div>` +
              `<div class=\"wm-tip-line\"><strong>Typical rain:</strong> ${fmt(props.rain_typical_mm, 1)} mm</div>` +
              `<div class=\"wm-tip-line\"><strong>Wind:</strong> ${kmh===null?'-':fmt(kmh,1)} km/h (${fmt(props.wind_speed_ms,1)} m/s, Bft ${msToBeaufort(props.wind_speed_ms)}), dir ${degToCardinal(props.wind_dir_deg)} (${fmt(props.wind_dir_deg,0)}°), std ${fmt(props.wind_var_deg,0)}°</div>` +
              `<div class=\"wm-tip-line\"><strong>Dist:</strong> ${fmt(props.min_distance_to_route_km, 1)} km</div>` +
            `</div>`
          );
          const cls = props._wind_warning ? 'tooltip wm-tip wind-warning' : 'tooltip wm-tip';
          m.bindTooltip(tipHtml, { className: cls, direction: 'auto', offset: L.point(40, -20) });
          glyphLayerNew.addLayer(m);
        }
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
          temperature: (props.temp_hist_median !== undefined) ? Number(props.temp_hist_median) : ((props.temperature_c !== undefined) ? Number(props.temperature_c) : ((props.temp_day_median !== undefined) ? Number(props.temp_day_median) : (props.temp_median || null))),
          precipMm: (props.precipitation_mm !== undefined) ? Number(props.precipitation_mm) : null,
          rainProb: (props.rain_probability !== undefined) ? Number(props.rain_probability) : null,
          rainTypical: (props.rain_typical_mm !== undefined) ? Number(props.rain_typical_mm) : null,
          rain_hist_p25_mm: (props.rain_hist_p25_mm !== undefined) ? Number(props.rain_hist_p25_mm) : null,
          rain_hist_p75_mm: (props.rain_hist_p75_mm !== undefined) ? Number(props.rain_hist_p75_mm) : null,
          rain_hist_p90_mm: (props.rain_hist_p90_mm !== undefined) ? Number(props.rain_hist_p90_mm) : null,
          windSpeed: (props.wind_speed_ms !== undefined) ? Number(props.wind_speed_ms) : null,
          windDir: (props.wind_dir_deg !== undefined) ? Number(props.wind_dir_deg) : null,
          windVar: (props.wind_var_deg !== undefined) ? Number(props.wind_var_deg) : null,
          // Temperature variability percentiles
          // Historical variability across years (daily daytime median percentiles)
          temp_hist_median: (props.temp_hist_median !== undefined) ? Number(props.temp_hist_median) : ((props.temperature_c !== undefined) ? Number(props.temperature_c) : null),
          temp_hist_min: (props.temp_hist_min !== undefined) ? Number(props.temp_hist_min) : null,
          temp_hist_max: (props.temp_hist_max !== undefined) ? Number(props.temp_hist_max) : null,
          temp_hist_p25: (props.temp_hist_p25 !== undefined) ? Number(props.temp_hist_p25) : ((props.temp_p25 !== undefined) ? Number(props.temp_p25) : null),
          temp_hist_p75: (props.temp_hist_p75 !== undefined) ? Number(props.temp_hist_p75) : ((props.temp_p75 !== undefined) ? Number(props.temp_p75) : null),
          temp_day_typical_min: (props.temp_day_typical_min !== undefined) ? Number(props.temp_day_typical_min) : null,
          temp_day_typical_max: (props.temp_day_typical_max !== undefined) ? Number(props.temp_day_typical_max) : null,
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
        // Progressive tactical rendering: enable + redraw bands as points arrive.
        try { if (wantBands) _setTourBandsEnabled(true); } catch (_) {}
        try { _setTourBandsData(LAST_PROFILE, OVERLAY_POINTS); } catch (_) {}
        const completed = Number(payload.completed || 0);
        const total = Number(payload.total || 0);
        const pct = total > 0 ? Math.min(100, Math.round(100 * completed / total)) : 0;
        if (progressBar) progressBar.style.width = `${pct}%`;
        stationCount = completed;
        stationTotal = total;
        const spanTxt = YEARS_SPAN_TEXT ? `historical Open-Meteo weather data ${YEARS_SPAN_TEXT}` : 'historical Open-Meteo weather data';
        if (sseStatus) sseStatus.textContent = `Loading station ${stationCount}/${stationTotal} (${weatherProvenanceText()}) from ${spanTxt}`;
      } catch (e) { console.error('station event error', e); }
    });


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
        const prov = weatherProvenanceText();
        const provTxt = prov ? ` (${prov})` : '';
        sseStatus.textContent = `Stream: done, stations ${stationCount}/${stationTotal}${provTxt}${suffix}`;
      }

      // Best (multi-year) mode: if preview showed only single-year stats, immediately upgrade.
      if (autoUpgradeIfSingleYear && !upgradePass && wantMultiYear && sawSingleYearSpan) {
        try {
          if (sseStatus) sseStatus.textContent = 'Upgrading to multi-year weather…';
        } catch (_) {}
        // Keep button disabled; start a weather-only stream that forces online.
        loadMap({
          ...loadOpts,
          offlineOnly: false,
          forceOnline: true,
          weatherOnly: true,
          autoUpgradeIfSingleYear: false,
          _upgradePass: true,
          forceRestart: true,
        });
        return;
      }

      // Restore button state
      if (fetchWeatherBtn) {
        updateFetchWeatherLabel();
        fetchWeatherBtn.disabled = false;
      }
      if (stopWeatherBtn) stopWeatherBtn.style.display = 'none';
      // Reset priming flag for next loads
      window.__WM_PROFILE_PRIME_DONE__ = false;
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
    try { applyPrefsFromFormAndPersist(); } catch (_) {}
    const mode = getWeatherQualityMode();
    if (mode === 'best') {
      loadMap({ ...(LAST_LOAD_OPTS || {}), offlineOnly: true, autoUpgradeIfSingleYear: true });
    } else {
      loadMap({ ...(LAST_LOAD_OPTS || {}) });
    }
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

    updateFetchWeatherLabel();
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
    updateFetchWeatherLabel();
    fetchWeatherBtn.disabled = false;
    if (stopWeatherBtn) stopWeatherBtn.style.display = 'none';
    if (sseStatus) sseStatus.textContent = 'Parameters changed - click "Update" (or "Get Weather Data")';
  }
  
  startDateInput.addEventListener('change', markDataStale);
  tourDaysInput.addEventListener('change', markDataStale);

  if (weatherQualitySelect) {
    weatherQualitySelect.addEventListener('change', markDataStale);
  }
  updateFetchWeatherLabel();

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
  // Profile display: overlay selection
  if (setOverlayMode) {
    setOverlayMode.addEventListener('change', () => {
      try {
        _setOverlayMode(String(setOverlayMode.value || 'temperature'));
      } catch (_) {}
    });
  }
  if (profileOverlaySelect) {
    profileOverlaySelect.addEventListener('change', () => {
      try {
        _setOverlayMode(String(profileOverlaySelect.value || 'temperature'));
      } catch (_) {}
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
      const prev = SETTINGS ? { ...SETTINGS } : {};
      try { applyPrefsFromFormAndPersist(); } catch (_) {}
      const next = SETTINGS ? { ...SETTINGS } : {};

      const dataKeys = [
        'startDate',
        'tourDays',
        'reverse',
        'weatherQuality',
        'stepKm',
        'histLastYear',
        'histYears',
        'tempCold',
        'tempHot',
        'rainHigh',
        'windHeadComfort',
        'windTailComfort',
      ];
      let needsRefetch = false;
      try {
        for (const k of dataKeys) {
          if (String(prev && prev[k]) !== String(next && next[k])) { needsRefetch = true; break; }
        }
      } catch (_) { needsRefetch = true; }

      if (needsRefetch) {
        loadMap({ forceRestart: true });
      } else {
        // Pure display/strategic toggles → redraw locally.
        if (STRATEGIC_STATE && STRATEGIC_STATE.active) {
          try { _strategicSetYear(Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR)); } catch (_) {}
          try { _scheduleStrategicFetch(); } catch (_) {}
          // Some strategic settings (e.g. includeSea land clipping) don't change the fetch key.
          // Force a local redraw so the toggle has an immediate effect.
          try { _renderStrategic(); } catch (_) {}
        }
        if (LAST_PROFILE) drawProfile(LAST_PROFILE);
      }
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
        if (st.last_gpx_name) LAST_GPX_NAME = st.last_gpx_name;
        if (st.gpx_exists === false) {
          // Clear stale path to avoid sending invalid override
          LAST_GPX_PATH = null;
          LAST_GPX_NAME = null;
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
