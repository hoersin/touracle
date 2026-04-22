/* global L */
(function() {
  // If Leaflet failed to load (e.g. CDN blocked/offline), avoid a hard crash
  // and show a clear in-map error.
  try {
    if (typeof window === 'undefined' || !window.L || typeof window.L.map !== 'function') {
      const el = (typeof document !== 'undefined') ? document.getElementById('map') : null;
      if (el) {
        el.innerHTML = '';
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.background = '#f7f7f7';
        el.style.color = '#222';
        el.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        el.style.fontSize = '14px';
        el.style.textAlign = 'center';
        el.style.padding = '16px';
        el.textContent = 'Map engine not available (Leaflet failed to load). Check internet/CDN access and reload.';
      }
      return;
    }
  } catch (_) {}

  // Prefer canvas renderer so snapshotting (html2canvas) captures route layers without SVG transform drift.
  const map = L.map('map', { preferCanvas: true });
  try { window.__WM_LEAFLET_MAP__ = map; } catch (_) {}
  try {
    const neutralBasePane = map.createPane('wmNeutralBasePane');
    if (neutralBasePane) {
      neutralBasePane.classList.add('wm-neutral-base-pane');
      neutralBasePane.style.zIndex = '100';
    }
    const climatePane = map.createPane('wmClimatePane');
    if (climatePane) {
      climatePane.style.zIndex = '200';
      climatePane.style.pointerEvents = 'none';
    }
    const windPane = map.createPane('wmWindPane');
    if (windPane) {
      windPane.style.zIndex = '300';
      windPane.style.pointerEvents = 'none';
    }
    const neutralLabelPane = map.createPane('wmNeutralLabelPane');
    if (neutralLabelPane) {
      neutralLabelPane.classList.add('wm-neutral-label-pane');
      neutralLabelPane.style.zIndex = '400';
      neutralLabelPane.style.pointerEvents = 'none';
    }
  } catch (_) {}
  // Base maps
  const _osmTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  });
  // Neutral basemap with separated labels so the background stays quiet in climate mode.
  const _neutralTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
    pane: 'wmNeutralBasePane',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  });
  const _neutralLabels = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
    pane: 'wmNeutralLabelPane',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  });
  const _cycleOverlayApiKey = (() => {
    try {
      const raw = (typeof window !== 'undefined' && window.WM_THUNDERFOREST_API_KEY)
        ? String(window.WM_THUNDERFOREST_API_KEY)
        : '';
      return raw.trim();
    } catch (_) {
      return '';
    }
  })();
  const _cycleOverlayEnabled = false;
  const _cycleOverlay = _cycleOverlayApiKey
    ? L.tileLayer(`https://tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=${encodeURIComponent(_cycleOverlayApiKey)}`, {
        pane: 'wmNeutralBasePane',
        opacity: 0.3,
        attribution: '&copy; OpenStreetMap contributors &copy; Thunderforest'
      })
    : null;
  let _activeBaseLayer = _osmTiles;
  let _neutralLabelsMounted = false;
  let _cycleOverlayMounted = false;
  _activeBaseLayer.addTo(map);
  try {
    map.setView([48.2, 11.6], 5);
  } catch (_) {}

  function fmt(num, digits = 1) {
    return (num === null || num === undefined) ? '-' : Number(num).toFixed(digits);
  }

  function _getAppMode() {
    try {
      const m = document.body && document.body.dataset ? String(document.body.dataset.mode || '') : '';
      return (m === 'climate' || m === 'tour' || m === 'settings') ? m : 'climate';
    } catch (_) {
      return 'climate';
    }
  }

  function _applyComfortWindUiForMode() {
    try {
      const mode = _getAppMode();
      const labHead = document.querySelector('[data-pref-title-for="setWindHeadComfort"]');
      if (labHead) {
        labHead.textContent = (mode === 'climate') ? 'Max wind' : 'Max headwind';
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
    if (_tourIsActive()) {
      const defs = [
        { v: 'temperature', t: 'Temperature (°C)' },
        { v: 'precipitation', t: 'Rain (mm)' },
        { v: 'wind_absolute', t: 'Wind (m/s)' },
        { v: 'wind_component', t: 'Head/Tail-Wind (m/s)' },
      ];
      for (const d of defs) {
        const o = document.createElement('option');
        o.value = d.v;
        o.textContent = d.t;
        sel.appendChild(o);
      }
      return;
    }
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
      { v: 'temperature_ride', t: 'Temperature' },
      { v: 'rain_ride', t: 'Rain' },
      { v: 'comfort', t: 'Lucky Days' },
    ];
    for (const d of defs) {
      const o = document.createElement('option');
      o.value = d.v;
      o.textContent = d.t;
      sel.appendChild(o);
    }
  }

  function _strategicNormalizeLayer(layer) {
    const l = String(layer || '');
    if (l === 'comfort_day' || l === 'comfort_ride') return 'comfort';
    if (l === 'wind_dir' || l === 'wind_speed') return 'temperature_ride';
    return l || 'temperature_ride';
  }

  // Note: a prior iteration used a Leaflet control in the bottom-right for
  // layer/year/timescale selectors. Those controls now live in the in-map
  // legend (lower-left), so we intentionally do not mount any extra box.

  function _strategicWantsStandardBasemap() {
    return false;
  }

  function _applyStrategicBasemap() {
    try {
      const m = _getAppMode();
      const wantOSM = (m !== 'climate');
      try { document.body.dataset.wmBasemap = wantOSM ? 'osm' : 'neutral'; } catch (_) {}
      const next = wantOSM ? _osmTiles : _neutralTiles;
      if (_activeBaseLayer !== next) {
        try { map.removeLayer(_activeBaseLayer); } catch (_) {}
        _activeBaseLayer = next;
        try { _activeBaseLayer.addTo(map); } catch (_) {}
      }
      const wantNeutralLabels = !wantOSM;
      if (wantNeutralLabels && !_neutralLabelsMounted) {
        try { _neutralLabels.addTo(map); } catch (_) {}
        _neutralLabelsMounted = true;
      } else if (!wantNeutralLabels && _neutralLabelsMounted) {
        try { map.removeLayer(_neutralLabels); } catch (_) {}
        _neutralLabelsMounted = false;
      }
      const wantCycleOverlay = !wantOSM && _cycleOverlayEnabled && !!_cycleOverlay;
      if (wantCycleOverlay && !_cycleOverlayMounted) {
        try { _cycleOverlay.addTo(map); } catch (_) {}
        _cycleOverlayMounted = true;
      } else if (!wantCycleOverlay && _cycleOverlayMounted) {
        try { map.removeLayer(_cycleOverlay); } catch (_) {}
        _cycleOverlayMounted = false;
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
  const setStrategicYears = document.getElementById('setStrategicYears');
  const setIncludeSea = document.getElementById('setIncludeSea');
  const setInterpolation = document.getElementById('setInterpolation');
  const setWindDensity = document.getElementById('setWindDensity');
  const setAnimSpeed = document.getElementById('setAnimSpeed');
  const setGridKm = document.getElementById('setGridKm');
  const setActiveHourStart = document.getElementById('setActiveHourStart');
  const setActiveHourEnd = document.getElementById('setActiveHourEnd');
  const setWindWeighting = document.getElementById('setWindWeighting');
  const setOverlayMode = document.getElementById('setOverlayMode');

  const strategicDayLabel = document.getElementById('strategicDayLabel');
  const strategicTimelineLabel = document.getElementById('strategicTimelineLabel');
  // Phase 2 (range): dual-handle slider + middle drag.
  const strategicRangeWrap = document.getElementById('strategicRangeWrap');
  const strategicRangeStart = document.getElementById('strategicRangeStart');
  const strategicRangeEnd = document.getElementById('strategicRangeEnd');
  const strategicRangeSelected = document.getElementById('strategicRangeSelected');
  const strategicRangeHandle = document.getElementById('strategicRangeHandle');
  const strategicRangeThumbStart = document.getElementById('strategicRangeThumbStart');
  const strategicRangeThumbEnd = document.getElementById('strategicRangeThumbEnd');
  const strategicRangeTooltip = document.getElementById('strategicRangeTooltip');
  // Phase 2 (range): preset buttons and step/speed selects were removed intentionally.

  // Legacy (Phase 1): single day slider.
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
  const settingsLoad = document.getElementById('settingsLoad');
  const settingsLiveStatus = document.getElementById('settingsLiveStatus');
  const settingsLiveStatusText = settingsLiveStatus ? settingsLiveStatus.querySelector('.wm-pref-live-text') : null;
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
  const tourSummaryPanel = document.getElementById('tourSummary');
  const tourSummaryBadges = document.getElementById('tourSummaryBadges');
  const tourSummaryBadgesItems = document.getElementById('tourSummaryBadgesItems');
  const tourSummaryLegends = document.getElementById('tourSummaryLegends');
  const tourSummaryTooltip = document.getElementById('tourSummaryTooltip');
  const profileLegendHost = document.getElementById('profileLegendHost');
  const mapEl = document.getElementById('map');
  const overlayContainer = document.getElementById('overlayContainer');
  const resizeHandle = document.getElementById('profileResizeHandle');
  let LAST_PROFILE = null;
  let LAST_CLIMATE_PROFILE = null;
  let LAST_TOUR_SUMMARY = null;
  let LAST_TOUR_CURSOR_READOUT = null;
  let TOUR_SUMMARY_LOCATION_TOKEN = 0;
  let LAST_EFFECTIVE_MODE = _getAppMode();
  let MODE_SWITCH_RELOAD_TIMER = null;
  const CLIMATE_PROFILE_HEIGHT = 280;
  const CLIMATE_CLICK_DEBOUNCE_MS = 100;
  const CLIMATE_PROFILE_FETCH_TIMEOUT_MS = 30000;
  const CLIMATE_PROFILE_CACHE_MAX = 128;
  const CLIMATE_PROFILE_CACHE = new Map();
  const CLIMATE_PROFILE_STATE = {
    selectedPoint: null,
    clickTimer: null,
    fetchAbort: null,
    selectedMarker: null,
    loadingPoint: null,
    hoverIndex: null,
  };
  const CLIMATE_DEFAULT_POINT = { lat: 47.999, lon: 7.842 };
  let CLIMATE_PROFILE_TOOLTIP = null;
  let CLIMATE_PROFILE_CURSOR_LINE = null;
  let CLIMATE_PROFILE_GEOMETRY = null;
  let PROFILE_POINTER_BOUND = false;
  let PROFILE_WINDOW_POINTER_BOUND = false;
  function _updateStrategicTimelineCssVar() {
    try {
      const h = strategicTimeline ? Number(strategicTimeline.offsetHeight || 0) : 0;
      document.documentElement.style.setProperty('--wm-strategic-timeline-h', `${Math.max(0, Math.round(h))}px`);
    } catch (_) {}
  }

  // Compute initial bottom UI height (0 unless Climate mode is active).
  try { setTimeout(() => { _updateStrategicTimelineCssVar(); }, 0); } catch (_) {}

  // Tour uses the shared in-map legend for layer selection; keep the old inline
  // profile overlay select removed so the white band matches Climate mode.
  let profileOverlaySelect = null;
  
  // Profile overlay mode (controlled via Preferences, mirrored in profile panel)
  let OVERLAY_MODE = (setOverlayMode && setOverlayMode.value) ? String(setOverlayMode.value) : 'temperature';

  function _tempLegendData(rangeMinC, rangeMaxC) {
    const minC = Number(rangeMinC);
    const maxC = Number(rangeMaxC);
    const rangeMin = Number.isFinite(minC) ? minC : -5;
    const rangeMax = (Number.isFinite(maxC) && maxC > rangeMin) ? maxC : 35;

    const sc = (typeof window !== 'undefined') ? window.WM_TEMP_SCALE : null;
    const bounds = (sc && Array.isArray(sc.TEMP_BOUNDS)) ? sc.TEMP_BOUNDS : [-5, 0, 5, 10, 15, 20, 25, 30, 35];
    const colorsHex = (sc && Array.isArray(sc.TEMP_COLORS)) ? sc.TEMP_COLORS : ['#313695','#2c7bb6','#00a6ca','#66c2a5','#1a9850','#66bd63','#fee08b','#f46d43'];

    const overlapLen = (lo, hi) => {
      const a = Number.isFinite(Number(lo)) ? Number(lo) : rangeMin;
      const b = Number.isFinite(Number(hi)) ? Number(hi) : rangeMax;
      const x0 = Math.max(rangeMin, Math.min(rangeMax, a));
      const x1 = Math.max(rangeMin, Math.min(rangeMax, b));
      return Math.max(0, x1 - x0);
    };

    const segments = [];
    for (let i = 0; i < Math.min(colorsHex.length, bounds.length - 1); i++) {
      const flex = overlapLen(bounds[i], bounds[i + 1]);
      if (!(flex > 0)) continue;
      segments.push({ color: colorsHex[i], flex });
    }

    const major = [-5, 0, 10, 20, 30, 35].filter(v => v >= rangeMin && v <= rangeMax);
    const minorSet = new Set();
    for (const b of bounds) {
      const v = Number(b);
      if (!Number.isFinite(v)) continue;
      if (v <= rangeMin || v >= rangeMax) continue;
      if (major.includes(v)) continue;
      minorSet.add(v);
    }
    const minor = Array.from(minorSet.values()).sort((a, b) => a - b);

    return { rangeMin, rangeMax, segments, major, minor };
  }

  function _tempLegendTicksMarkup(data, opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const rangeMin = Number(data && data.rangeMin);
    const rangeMax = Number(data && data.rangeMax);
    const denom = Math.max(1e-9, rangeMax - rangeMin);
    const major = Array.isArray(data && data.major) ? data.major : [];
    const minor = Array.isArray(data && data.minor) ? data.minor : [];

    const pct = (v) => (100 * (Number(v) - rangeMin) / denom);
    const fmtLabel = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return '';
      if (o.unitOnMax && Math.abs(n - rangeMax) < 1e-9) return `${Math.round(n)} °C`;
      return String(Math.round(n));
    };
    const xform = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return 'translateX(-50%)';
      if (Math.abs(n - rangeMin) < 1e-9) return 'translateX(0)';
      if (Math.abs(n - rangeMax) < 1e-9) return 'translateX(-100%)';
      return 'translateX(-50%)';
    };

    const ticks = [];
    for (const v of minor) ticks.push({ v, major: false });
    for (const v of major) ticks.push({ v, major: true });
    ticks.sort((a, b) => Number(a.v) - Number(b.v));

    const marks = ticks.map(t => {
      const left = pct(t.v);
      const h = t.major ? 6 : 4;
      const bg = t.major ? 'rgba(0,0,0,0.40)' : 'rgba(0,0,0,0.22)';
      return `<span style="position:absolute;left:${left}%;bottom:0;width:1px;height:${h}px;background:${bg};transform:translateX(-0.5px);"></span>`;
    }).join('');

    const labels = major.map(v => {
      const left = pct(v);
      return `<span style="position:absolute;left:${left}%;top:0;transform:${xform(v)};">${fmtLabel(v)}</span>`;
    }).join('');

    return `
      <div style="display:block;margin-top:5px;">
        <div style="position:relative;height:7px;">${marks}</div>
        <div style="position:relative;margin-top:2px;height:10px;">${labels}</div>
      </div>
    `;
  }

  function _renderTempLegendTicksInto(ticksEl, data) {
    if (!ticksEl) return;
    try {
      ticksEl.innerHTML = '';
      try { ticksEl.style.display = 'block'; } catch (_) {}
      try { ticksEl.style.gap = '0px'; } catch (_) {}
      try { ticksEl.style.flexDirection = 'column'; } catch (_) {}

      const rangeMin = Number(data && data.rangeMin);
      const rangeMax = Number(data && data.rangeMax);
      const denom = Math.max(1e-9, rangeMax - rangeMin);
      const major = Array.isArray(data && data.major) ? data.major : [];
      const minor = Array.isArray(data && data.minor) ? data.minor : [];

      const pct = (v) => (100 * (Number(v) - rangeMin) / denom);
      const xform = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return 'translateX(-50%)';
        if (Math.abs(n - rangeMin) < 1e-9) return 'translateX(0)';
        if (Math.abs(n - rangeMax) < 1e-9) return 'translateX(-100%)';
        return 'translateX(-50%)';
      };

      const marks = document.createElement('div');
      marks.style.position = 'relative';
      marks.style.height = '7px';
      marks.style.marginTop = '2px';

      const addMark = (v, isMajor) => {
        const left = pct(v);
        const mk = document.createElement('span');
        mk.style.position = 'absolute';
        mk.style.left = `${left}%`;
        mk.style.bottom = '0';
        mk.style.width = '1px';
        mk.style.height = isMajor ? '6px' : '4px';
        mk.style.background = isMajor ? 'rgba(0,0,0,0.40)' : 'rgba(0,0,0,0.22)';
        mk.style.transform = 'translateX(-0.5px)';
        marks.appendChild(mk);
      };
      for (const v of minor) addMark(v, false);
      for (const v of major) addMark(v, true);

      const labels = document.createElement('div');
      labels.style.position = 'relative';
      labels.style.marginTop = '2px';
      labels.style.height = '10px';

      for (const v of major) {
        const left = pct(v);
        const s = document.createElement('span');
        s.style.position = 'absolute';
        s.style.left = `${left}%`;
        s.style.top = '0';
        s.style.transform = xform(v);
        s.textContent = (Math.abs(Number(v) - rangeMax) < 1e-9) ? `${Math.round(Number(v))} °C` : String(Math.round(Number(v)));
        labels.appendChild(s);
      }

      ticksEl.appendChild(marks);
      ticksEl.appendChild(labels);
    } catch (_) {}
  }

  function _renderRainLegendTicksInto(ticksEl, opts) {
    if (!ticksEl) return;
    const o = (opts && typeof opts === 'object') ? opts : {};
    const rangeMin = Number.isFinite(Number(o.rangeMin)) ? Number(o.rangeMin) : 0.5;
    const rangeMax = Number.isFinite(Number(o.rangeMax)) ? Number(o.rangeMax) : 50;
    if (!(rangeMax > rangeMin)) return;

    const denom = Math.max(1e-9, rangeMax - rangeMin);
    const major = Array.isArray(o.major) ? o.major.map(Number).filter(Number.isFinite) : [2, 10, 20, 50];
    const pct = (v) => (100 * (Number(v) - rangeMin) / denom);
    const xform = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return 'translateX(-50%)';
      if (Math.abs(n - rangeMin) < 1e-9) return 'translateX(0)';
      if (Math.abs(n - rangeMax) < 1e-9) return 'translateX(-100%)';
      return 'translateX(-50%)';
    };

    try {
      ticksEl.innerHTML = '';
      try { ticksEl.style.display = 'block'; } catch (_) {}
      try { ticksEl.style.gap = '0px'; } catch (_) {}
      try { ticksEl.style.flexDirection = 'column'; } catch (_) {}

      const marks = document.createElement('div');
      marks.style.position = 'relative';
      marks.style.height = '7px';
      marks.style.marginTop = '2px';

      const labels = document.createElement('div');
      labels.style.position = 'relative';
      labels.style.marginTop = '2px';
      labels.style.height = '10px';

      for (const v of major) {
        if (v < rangeMin - 1e-9 || v > rangeMax + 1e-9) continue;
        const left = pct(v);

        const mk = document.createElement('span');
        mk.style.position = 'absolute';
        mk.style.left = `${left}%`;
        mk.style.bottom = '0';
        mk.style.width = '1px';
        mk.style.height = '6px';
        mk.style.background = 'rgba(0,0,0,0.40)';
        mk.style.transform = 'translateX(-0.5px)';
        marks.appendChild(mk);

        const s = document.createElement('span');
        s.style.position = 'absolute';
        s.style.left = `${left}%`;
        s.style.top = '0';
        s.style.transform = xform(v);
        s.textContent = `${Math.round(v)} mm`;
        labels.appendChild(s);
      }

      ticksEl.appendChild(marks);
      ticksEl.appendChild(labels);
    } catch (_) {}
  }

  function _normalizeOverlayMode(mode) {
    const raw = String(mode || '').trim();
    if (raw === 'temperature' || raw === 'precipitation' || raw === 'wind_absolute' || raw === 'wind_component') return raw;
    if (raw === 'wind') return 'wind_component';
    return 'temperature';
  }

  function _overlayModeLabel(mode) {
    const normalized = _normalizeOverlayMode(mode);
    if (normalized === 'precipitation') return 'Rain';
    if (normalized === 'wind_absolute') return 'Wind';
    if (normalized === 'wind_component') return 'Head/Tail-Wind';
    return 'Temperature';
  }

  function _paletteCssColor(stops, t) {
    try {
      const col = _paletteSample(stops, t);
      if (!col || !Number.isFinite(col.r) || !Number.isFinite(col.g) || !Number.isFinite(col.b)) {
        return 'rgb(153,153,153)';
      }
      return `rgb(${Math.round(col.r)},${Math.round(col.g)},${Math.round(col.b)})`;
    } catch (_) {
      return 'rgb(153,153,153)';
    }
  }

  function _tourWindAbsoluteColor(ms) {
    const speed = Math.max(0, Number(ms) || 0);
    const t = Math.max(0, Math.min(1, speed / 16));
    return _paletteCssColor(PAL_WIND, t);
  }

  function _tourWindComponentColorCss(ms) {
    const comp = Number(ms) || 0;
    const t = Math.max(0, Math.min(1, (comp + 8) / 16));
    return _paletteCssColor([
      { t: 0.00, c: { r: 204, g: 66, b: 57 } },
      { t: 0.50, c: { r: 181, g: 187, b: 198 } },
      { t: 1.00, c: { r: 38, g: 166, b: 91 } },
    ], t);
  }

  function _updateProfileLegend() {
    try {
      if (!profileLegendHost) return;
      const m = _normalizeOverlayMode(OVERLAY_MODE);
      profileLegendHost.style.display = 'block';
      if (m === 'temperature') {
        const td = _tempLegendData(-5, 35);
        const segHtml = (td && Array.isArray(td.segments) && td.segments.length)
          ? td.segments.map(s => `<div class="seg" style="background:${s.color};flex:${Number(s.flex) || 1} 1 0%;"></div>`).join('')
          : [
          '<div style="flex:1;background:#313695;height:100%;"></div>',
          '<div style="flex:1;background:#2c7bb6;height:100%;"></div>',
          '<div style="flex:1;background:#00a6ca;height:100%;"></div>',
          '<div style="flex:1;background:#66c2a5;height:100%;"></div>',
          '<div style="flex:1;background:#1a9850;height:100%;"></div>',
          '<div style="flex:1;background:#66bd63;height:100%;"></div>',
          '<div style="flex:1;background:#fee08b;height:100%;"></div>',
          '<div style="flex:1;background:#f46d43;height:100%;"></div>',
              '<div class="seg" style="background:#fee08b"></div>',
              '<div class="seg" style="background:#f46d43"></div>',
            ].join('');
        const ticksHtml = _tempLegendTicksMarkup(td, { unitOnMax: true });
        profileLegendHost.innerHTML = `
          <div class="title">Temperature</div>
          <div class="bar steps">${segHtml}</div>
          <div class="ticks" style="display:block;">${ticksHtml}</div>
          <div class="note">Solid line: median temperature. Dashed lines: typical daytime p25/p75. Shaded band: historical p25–p75 across years.</div>
        `;
      } else if (m === 'precipitation') {
        profileLegendHost.innerHTML = `
          <div class="title">Rain</div>
          <div class="bar" style="background: linear-gradient(90deg, rgba(30,112,200,0.10) 0%, rgba(30,112,200,0.92) 100%);"></div>
          <div class="ticks"><span>0</span><span>5</span><span>10</span><span>20 mm</span></div>
          <div class="note">Bars: typical rain (mm). Light band: typical × probability (expected mm).</div>
        `;
      } else if (m === 'wind_absolute') {
        profileLegendHost.innerHTML = `
          <div class="title">Wind (m/s + direction)</div>
          <div class="bar" style="background: linear-gradient(90deg, ${_tourWindAbsoluteColor(0)} 0%, ${_tourWindAbsoluteColor(6)} 45%, ${_tourWindAbsoluteColor(12)} 75%, ${_tourWindAbsoluteColor(16)} 100%);"></div>
          <div class="ticks"><span>0</span><span>3</span><span>6</span><span>10</span><span>14+ m/s</span></div>
          <div class="note">Line: absolute wind speed. Arrows: wind direction.</div>
        `;
      } else {
        profileLegendHost.innerHTML = `
          <div class="title">Head/Tail-Wind (m/s)</div>
          <div class="bar" style="background: linear-gradient(90deg, ${_tourWindComponentColorCss(-8)} 0%, ${_tourWindComponentColorCss(-4)} 25%, ${_tourWindComponentColorCss(0)} 50%, ${_tourWindComponentColorCss(4)} 75%, ${_tourWindComponentColorCss(8)} 100%);"></div>
          <div class="ticks"><span>-8</span><span>-4</span><span>0</span><span>4</span><span>8 m/s</span></div>
          <div class="note">Red = headwind, green = tailwind.</div>
        `;
      }
    } catch (_) {}
  }

  function _setOverlayMode(mode, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const m = _normalizeOverlayMode(mode);
    OVERLAY_MODE = m;
    try { SETTINGS.overlayMode = m; } catch (_) {}
    if (!options.skipPersist) {
      try { saveSettings(SETTINGS); } catch (_) {}
    }
    try { if (setOverlayMode) setOverlayMode.value = m; } catch (_) {}
    try { if (profileOverlaySelect) profileOverlaySelect.value = m; } catch (_) {}
    try { _updateStrategicLegend(); } catch (_) {}
    try { if (LAST_PROFILE) drawProfile(LAST_PROFILE); } catch (_) {}
    try { _updateProfileLegend(); } catch (_) {}
    try { if (tourSummaryLegends && _tourIsActive()) tourSummaryLegends.innerHTML = _tourSummaryLegendsMarkup(); } catch (_) {}
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
        return wrap;
      };
      ctrl.addTo(map);
    } catch (_) {}
  })();
  let OVERLAY_POINTS = [];
  let TOUR_DAYS_AGGR = {};
  let evtSource = null;
  let evtSourceProfile = null;
  let PROFILE_ZOOM_REFRESH_BOUND = false;
  let PRIME_IN_PROGRESS = false;
  let MAIN_IN_PROGRESS = false;
  let LAST_GPX_PATH = null;
  let LAST_GPX_NAME = null;
  const LAST_GPX_STORAGE_KEY = 'wm_last_gpx_selection';
  let LAST_LOAD_OPTS = null;
  let OFFLINE_FALLBACK_ACTIVE = false;

  function _persistLastGpxSelection() {
    try {
      if (!LAST_GPX_PATH) {
        localStorage.removeItem(LAST_GPX_STORAGE_KEY);
        return;
      }
      localStorage.setItem(LAST_GPX_STORAGE_KEY, JSON.stringify({
        path: String(LAST_GPX_PATH || ''),
        name: String(LAST_GPX_NAME || ''),
      }));
    } catch (_) {}
  }

  function _restoreLastGpxSelectionFromStorage() {
    try {
      const raw = localStorage.getItem(LAST_GPX_STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const path = String(parsed && parsed.path || '').trim();
      const name = String(parsed && parsed.name || '').trim();
      if (!path) return false;
      LAST_GPX_PATH = path;
      LAST_GPX_NAME = name || null;
      return true;
    } catch (_) {
      return false;
    }
  }

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

  function _cacheClimateProfileSet(key, value) {
    try {
      if (CLIMATE_PROFILE_CACHE.has(key)) CLIMATE_PROFILE_CACHE.delete(key);
      CLIMATE_PROFILE_CACHE.set(key, value);
      while (CLIMATE_PROFILE_CACHE.size > CLIMATE_PROFILE_CACHE_MAX) {
        const oldest = CLIMATE_PROFILE_CACHE.keys().next().value;
        if (oldest === undefined) break;
        CLIMATE_PROFILE_CACHE.delete(oldest);
      }
    } catch (_) {}
  }

  function _cacheClimateProfileGet(key) {
    try {
      if (!CLIMATE_PROFILE_CACHE.has(key)) return null;
      const value = CLIMATE_PROFILE_CACHE.get(key);
      CLIMATE_PROFILE_CACHE.delete(key);
      CLIMATE_PROFILE_CACHE.set(key, value);
      return value;
    } catch (_) {
      return null;
    }
  }

  function _climateProfileIsActive() {
    return _getAppMode() === 'climate';
  }

  function _reflowBottomLayout() {
    try {
      const tsdbH = tourSummaryPanel ? (tourSummaryPanel.offsetHeight || 64) : 64;
      const currentProfileH = profilePanel ? (profilePanel.offsetHeight || CLIMATE_PROFILE_HEIGHT) : CLIMATE_PROFILE_HEIGHT;
      if (mapEl) {
        mapEl.style.height = `calc(100% - ${currentProfileH + tsdbH}px)`;
        const rect = mapEl.getBoundingClientRect();
        if (!rect.height || rect.height < 200) {
          mapEl.style.height = `${Math.max(220, window.innerHeight - (currentProfileH + tsdbH))}px`;
        }
      }
      try { if (map && map.invalidateSize) map.invalidateSize(true); } catch (_) {}
    } catch (_) {}
  }

  function _setBottomPanelUiMode(mode) {
    const climate = (String(mode || '') === 'climate');
    const tour = (String(mode || '') === 'tour');
    try {
      if (profileTooltip) {
        profileTooltip.style.display = 'flex';
      }
    } catch (_) {}
    try {
      if (profileOverlaySelect) {
        profileOverlaySelect.style.display = climate ? 'none' : '';
      }
    } catch (_) {}
    try {
      if (profileLegendHost && !climate) {
        profileLegendHost.style.alignItems = '';
        profileLegendHost.style.gap = '';
        profileLegendHost.style.padding = '';
        profileLegendHost.style.border = '';
        profileLegendHost.style.background = '';
        profileLegendHost.style.boxShadow = '';
        profileLegendHost.style.fontSize = '';
        profileLegendHost.style.marginLeft = '';
      }
    } catch (_) {}
    try {
      if (tourSummaryTooltip) tourSummaryTooltip.style.display = 'none';
    } catch (_) {}
    try {
      if (strategicPlayBtn) strategicPlayBtn.style.display = tour ? 'none' : '';
    } catch (_) {}
  }

  function _fmtIsoDayMonthCompact(iso) {
    try {
      const s = String(iso || '').trim();
      const d = new Date(s);
      if (!Number.isFinite(Number(d && d.getTime && d.getTime()))) return '—';
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch (_) {}
    return '—';
  }

  function _fmtPercent(numer, denom) {
    const a = Number(numer);
    const b = Number(denom);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return '0%';
    return `${Math.round((100 * a) / b)}%`;
  }

  function _climateHaversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (v) => Number(v) * Math.PI / 180;
    const dLat = toRad(Number(lat2) - Number(lat1));
    const dLon = toRad(Number(lon2) - Number(lon1));
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))));
  }

  function _fmtLatLonClimate(lat, lon) {
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) return '—';
    const latAbs = Math.abs(latN).toFixed(2);
    const lonAbs = Math.abs(lonN).toFixed(2);
    const latHem = latN >= 0 ? 'N' : 'S';
    const lonHem = lonN >= 0 ? 'E' : 'W';
    return `${latAbs}°${latHem}, ${lonAbs}°${lonHem}`;
  }

  function _climateLocationInfo(meta) {
    const point = (meta && meta.point) ? meta.point : {};
    const lat = Number(point.lat);
    const lon = Number(point.lon);
    const exactName = meta && meta.location_name ? String(meta.location_name).trim() : '';
    const exactCountry = meta && meta.location_country ? String(meta.location_country).trim() : '';
    if (exactName) {
      return {
        title: `📍 ${exactName}${exactCountry ? ` (${exactCountry})` : ''}`,
        coords: _fmtLatLonClimate(lat, lon),
      };
    }
    const locationLabel = meta && meta.location ? String(meta.location).trim() : '';
    if (locationLabel && !/^near\s/i.test(locationLabel) && locationLabel !== 'selected location') {
      return {
        title: `📍 ${locationLabel}`,
        coords: _fmtLatLonClimate(lat, lon),
      };
    }
    return {
      title: `📍 ${_fmtLatLonClimate(lat, lon)}`,
      coords: _fmtLatLonClimate(lat, lon),
    };
  }

  function _whiteBandEmptyCardMarkup() {
    return '<div class="wm-tour-band-card wm-whiteband-card-empty" aria-hidden="true"></div>';
  }

  function _tourMedian(values) {
    const arr = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!arr.length) return null;
    const mid = Math.floor(arr.length / 2);
    return (arr.length % 2) ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  function _tourMean(values) {
    const arr = (values || []).map(Number).filter(Number.isFinite);
    if (!arr.length) return null;
    return arr.reduce((sum, value) => sum + value, 0) / arr.length;
  }

  function _tourSummarizeDayPoints(dayPoints) {
    try {
      const points = Array.isArray(dayPoints) ? dayPoints : [];
      if (!points.length) return null;
      const pickFinite = (...values) => {
        for (const value of values) {
          const num = Number(value);
          if (Number.isFinite(num)) return num;
        }
        return null;
      };
      const temps = points.map((point) => pickFinite(point && point.temp_day_median, point && point.temperature));
      const winds = points.map((point) => pickFinite(point && point.windSpeed));
      const precs = points.map((point) => {
        return pickFinite(point && point.rainTypical, point && point.precipMm);
      });
      const luckyVotes = points
        .map((point) => {
          if (point && point.lucky === true) return 1;
          if (point && point.lucky === false) return 0;
          return null;
        })
        .filter((value) => value !== null);
      const effs = points.map((point) => {
        const dist = Number(point && point.dist);
        if (!Number.isFinite(dist)) return NaN;
        const eff = _tourEffectiveWind({ windSpeed: point && point.windSpeed, windDir: point && point.windDir }, dist);
        return Number.isFinite(eff) ? eff : NaN;
      });
      const rainProb = _tourMean(points.map((point) => pickFinite(point && point.rainProb)));
      const tempMedian = _tourMedian(temps);
      const windMean = _tourMean(winds);
      const precipSum = precs.map(Number).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
      const precipMean = precs.map(Number).filter(Number.isFinite).length ? (precipSum / precs.map(Number).filter(Number.isFinite).length) : null;
      const effMean = _tourMean(effs);
      const cold = 15.0;
      const hot = 25.0;
      const rainThresh = 1.0;
      const headLimit = Number(SETTINGS.windHeadComfort || 4);
      const tailLimit = Number(SETTINGS.windTailComfort || 10);
      let lucky = null;
      if (luckyVotes.length) {
        const luckyCount = luckyVotes.reduce((sum, value) => sum + value, 0);
        lucky = luckyCount >= Math.max(1, Math.ceil(luckyVotes.length / 2));
      } else if (Number.isFinite(tempMedian) && Number.isFinite(precipSum)) {
        lucky = false;
        if (tempMedian >= cold && tempMedian <= hot && precipSum < rainThresh) {
          if (Number.isFinite(effMean)) {
            if (effMean < -0.33) lucky = Number.isFinite(windMean) && windMean < headLimit;
            else if (effMean > 0.33) lucky = Number.isFinite(windMean) && windMean < tailLimit;
            else lucky = Number.isFinite(windMean) && windMean < headLimit;
          } else {
            lucky = Number.isFinite(windMean) && windMean < headLimit;
          }
        }
      }
      return {
        tempMedian,
        windMean,
        precipSum,
        precipMean,
        effMean,
        rainProb,
        lucky,
      };
    } catch (_) {
      return null;
    }
  }

  function _tourFallbackSummary() {
    try {
      const grouped = new Map();
      const points = Array.isArray(OVERLAY_POINTS) ? OVERLAY_POINTS : [];
      for (const point of points) {
        const dayIndex = Number(point && point.tourDayIndex);
        if (!Number.isFinite(dayIndex)) continue;
        if (!grouped.has(dayIndex)) grouped.set(dayIndex, []);
        grouped.get(dayIndex).push(point || {});
      }
      const dayKeys = Array.from(grouped.keys()).sort((a, b) => a - b);
      if (!dayKeys.length) {
        const legacyKeys = Object.keys(TOUR_DAYS_AGGR || {}).map(k => Number(k)).filter(Number.isFinite).sort((a, b) => a - b);
        if (!legacyKeys.length) return null;
        for (const key of legacyKeys) {
          const ag = TOUR_DAYS_AGGR[key] || { temps: [], winds: [], precs: [], effs: [] };
          grouped.set(key, [{
            temperature: null,
            windSpeed: null,
            precipMm: null,
            lucky: null,
            _legacy: ag,
          }]);
        }
      }

      const dayTemps = [];
      const dayWinds = [];
      const dayPrecip = [];
      let rainDays = 0;
      let headwindDays = 0;
      let tailwindDays = 0;
      let comfortDays = 0;
      let extremeHot = 0;
      let extremeCold = 0;

      for (const dayKey of Array.from(grouped.keys()).sort((a, b) => a - b)) {
        const pointsForDay = grouped.get(dayKey) || [];
        const legacy = pointsForDay[0] && pointsForDay[0]._legacy ? pointsForDay[0]._legacy : null;
        const daySummary = legacy
          ? {
              tempMedian: _tourMedian(legacy.temps),
              windMean: _tourMean(legacy.winds),
              precipSum: (legacy.precs || []).map(Number).filter(Number.isFinite).reduce((sum, value) => sum + value, 0),
              precipMean: _tourMean(legacy.precs),
              effMean: _tourMean(legacy.effs),
              lucky: null,
            }
          : _tourSummarizeDayPoints(pointsForDay);
        if (!daySummary) continue;
        const tempMedian = daySummary.tempMedian;
        const windMean = daySummary.windMean;
        const precipSum = Number.isFinite(Number(daySummary.precipSum)) ? Number(daySummary.precipSum) : Number(daySummary.precipMean);
        const effMean = daySummary.effMean;

        if (Number.isFinite(tempMedian)) {
          dayTemps.push(tempMedian);
          if (tempMedian >= 30.0) extremeHot += 1;
          if (tempMedian <= 5.0) extremeCold += 1;
        }
        if (Number.isFinite(windMean)) dayWinds.push(windMean);
        if (Number.isFinite(precipSum)) {
          dayPrecip.push(precipSum);
          if (precipSum >= 1.0) rainDays += 1;
        }
        if (Number.isFinite(effMean)) {
          if (effMean <= -0.33) headwindDays += 1;
          else if (effMean >= 0.33) tailwindDays += 1;
        }
        if (daySummary.lucky === true) comfortDays += 1;
      }

      return {
        total_days: dayKeys.length,
        rain_days: rainDays,
        headwind_days: headwindDays,
        tailwind_days: tailwindDays,
        comfort_days: comfortDays,
        extreme_days_hot: extremeHot,
        extreme_days_cold: extremeCold,
        median_temperature: _tourMedian(dayTemps),
        max_temperature: dayTemps.length ? Math.max(...dayTemps) : null,
        min_temperature: dayTemps.length ? Math.min(...dayTemps) : null,
        total_precipitation: dayPrecip.reduce((total, value) => total + value, 0),
        mean_wind_speed: _tourMean(dayWinds),
      };
    } catch (_) {
      return null;
    }
  }

  function _tourSummaryScore(summary) {
    try {
      const data = (summary && typeof summary === 'object') ? summary : null;
      if (!data) return -1;
      let score = 0;
      if (Number.isFinite(Number(data.total_days)) && Number(data.total_days) > 0) score += 1;
      for (const key of ['median_temperature', 'max_temperature', 'min_temperature', 'mean_wind_speed']) {
        if (Number.isFinite(Number(data[key]))) score += 2;
      }
      if (Number.isFinite(Number(data.total_precipitation))) score += 1;
      for (const key of ['rain_days', 'headwind_days', 'tailwind_days', 'comfort_days', 'extreme_days_hot', 'extreme_days_cold']) {
        if (Number.isFinite(Number(data[key])) && Math.abs(Number(data[key])) > 1e-9) score += 1;
      }
      return score;
    } catch (_) {
      return -1;
    }
  }

  function _normalizeTourSummary(summary) {
    const incoming = (summary && typeof summary === 'object') ? { ...summary } : {};
    const fallback = _tourFallbackSummary();
    if (!fallback) return incoming;

    const incomingScore = _tourSummaryScore(incoming);
    const fallbackScore = _tourSummaryScore(fallback);
    const primary = incomingScore >= fallbackScore ? incoming : fallback;
    const secondary = primary === incoming ? fallback : incoming;
    const merged = { ...primary };

    for (const key of [
      'total_days',
      'rain_days',
      'headwind_days',
      'tailwind_days',
      'comfort_days',
      'extreme_days_hot',
      'extreme_days_cold',
      'median_temperature',
      'max_temperature',
      'min_temperature',
      'total_precipitation',
      'mean_wind_speed',
    ]) {
      const value = merged[key];
      if (Number.isFinite(Number(value))) continue;
      const other = secondary[key];
      if (Number.isFinite(Number(other))) merged[key] = Number(other);
    }
    return merged;
  }

  function _tourSummaryMetricsMarkup(summary) {
    const data = _normalizeTourSummary(summary);
    const totalDays = Math.max(1, Number(data.total_days || 0));
    const rainDays = Number(data.rain_days || 0);
    const headwindDays = Number(data.headwind_days || 0);
    const tailwindDays = Number(data.tailwind_days || 0);
    const totalPrecip = Number(data.total_precipitation || 0);
    const headPct = Math.round((100 * headwindDays) / Math.max(1, totalDays));
    const tailPct = Math.round((100 * tailwindDays) / Math.max(1, totalDays));
    return `
      <div class="wm-climate-metrics">
        <div class="wm-climate-metric">
          <div class="wm-climate-metric-label">Temp</div>
          <div class="wm-climate-metric-main">${fmt(data.median_temperature, 0)}°C</div>
          <div class="wm-climate-metric-secondary">${fmt(data.min_temperature, 0)}–${fmt(data.max_temperature, 0)}°C</div>
          <div class="wm-climate-metric-tertiary">route median</div>
        </div>
        <div class="wm-climate-metric">
          <div class="wm-climate-metric-label">Rain</div>
          <div class="wm-climate-metric-main">${fmt(totalPrecip / Math.max(1, totalDays), 1)} mm/d</div>
          <div class="wm-climate-metric-secondary">${fmt(totalPrecip, 0)} mm total</div>
          <div class="wm-climate-metric-tertiary">${rainDays}/${totalDays} rain days</div>
        </div>
        <div class="wm-climate-metric">
          <div class="wm-climate-metric-label">Wind</div>
          <div class="wm-climate-metric-main">${headPct}% headwind</div>
          <div class="wm-climate-metric-secondary">mean ${fmt(data.mean_wind_speed, 1)} m/s</div>
          <div class="wm-climate-metric-tertiary">${tailPct}% tailwind</div>
        </div>
        <div class="wm-climate-metric">
          <div class="wm-climate-metric-label">Lucky</div>
          <div class="wm-climate-metric-main">${Number(data.comfort_days || 0)}/${totalDays}</div>
          <div class="wm-climate-metric-secondary">${_fmtPercent(data.comfort_days, totalDays)}</div>
          <div class="wm-climate-metric-tertiary">good riding days</div>
        </div>
      </div>`;
  }

  function _renderClimateCurrentState() {
    try {
      if (LAST_CLIMATE_PROFILE) {
        _renderClimateSummary(LAST_CLIMATE_PROFILE);
        drawClimateProfile(LAST_CLIMATE_PROFILE);
        return;
      }
      if (CLIMATE_PROFILE_STATE.loadingPoint) {
        _renderClimateLoading(CLIMATE_PROFILE_STATE.loadingPoint);
        return;
      }
    } catch (_) {}
    _renderClimateEmptyState();
  }

  function _renderTourEmptyState(message) {
    const routeLabels = _tourRouteDisplayLabels();
    const years = _tourSelectedYearsSpan();
    const rangeInfo = _tourDateRangeInfo();
    const distanceKm = _tourRouteDistanceKm();
    const gpxName = _tourDisplayGpxName();
    _setBottomPanelUiMode('tour');
    _setWhiteBandSlots(
      `
        <div class="wm-tour-band-card wm-tour-summary-route">
          <div class="wm-tour-route-kicker">GPX Route Info</div>
          <div class="wm-tour-route-title"><span data-role="start">${_htmlEsc(routeLabels.fromLabel)}</span> → <span data-role="end">${_htmlEsc(routeLabels.toLabel)}</span></div>
          <div class="wm-tour-route-file">${_htmlEsc(gpxName)}${Number.isFinite(distanceKm) ? ` • ${fmt(distanceKm, 0)} km` : ''}</div>
          <div class="wm-tour-route-meta">${_fmtIsoDayMonthCompact(rangeInfo.startIso)}–${_fmtIsoDayMonthCompact(rangeInfo.endIso)} • ${Math.max(1, rangeInfo.totalDays)}d • ${years.discontiguous ? years.exactLabel : years.spanLabel}</div>
        </div>
      `,
      `
        <div class="wm-tour-band-card wm-tour-vdl-card wm-tour-vdl-empty">
          <div class="wm-tour-vdl-kicker">Vertical Day Line</div>
          <div class="wm-tour-vdl-location" data-role="location">Start location</div>
          <div class="wm-tour-vdl-meta">${_htmlEsc(String(message || 'Loading route weather...'))}</div>
          <div class="wm-tour-vdl-grid">
            <div class="wm-tour-vdl-metric">
              <div class="wm-tour-vdl-label">Temp</div>
              <div class="wm-tour-vdl-value">—</div>
            </div>
            <div class="wm-tour-vdl-metric">
              <div class="wm-tour-vdl-label">Wind</div>
              <div class="wm-tour-vdl-value">—</div>
            </div>
            <div class="wm-tour-vdl-metric">
              <div class="wm-tour-vdl-label">Rain</div>
              <div class="wm-tour-vdl-value">—</div>
            </div>
          </div>
        </div>
      `,
      _tourSummaryMetricsMarkup(null),
      _tourSummaryLegendsMarkup()
    );
    _drawProfilePlaceholder(String(message || 'Loading route profile...'));
    try { _reflowBottomLayout(); } catch (_) {}
  }

  function _activateClimateProfileSelection(point, opts) {
    if (!point) return;
    const target = { lat: Number(point.lat), lon: Number(point.lon) };
    CLIMATE_PROFILE_STATE.selectedPoint = target;
    _ensureClimateSelectedMarker(target);
    try {
      if (CLIMATE_PROFILE_STATE.clickTimer) {
        clearTimeout(CLIMATE_PROFILE_STATE.clickTimer);
        CLIMATE_PROFILE_STATE.clickTimer = null;
      }
    } catch (_) {}
    _requestClimateProfile(target, opts).catch((err) => {
      if (err && err.name === 'AbortError') return;
      _renderClimateError(err && err.message ? err.message : 'Climate profile could not be loaded.');
    });
  }

  function _setWhiteBandSlots(slot1Html, slot2Html, slot3Html, slot4Html) {
    try {
      const slot1 = document.getElementById('tourSummaryRoute');
      if (slot1) slot1.innerHTML = String(slot1Html || '');
    } catch (_) {}
    try {
      if (profileTooltip) {
        profileTooltip.innerHTML = String(slot2Html || '');
        profileTooltip.style.visibility = 'visible';
        profileTooltip.style.opacity = '1';
      }
    } catch (_) {}
    try {
      if (tourSummaryBadgesItems) tourSummaryBadgesItems.innerHTML = String(slot3Html || '');
    } catch (_) {}
    try {
      if (tourSummaryLegends) tourSummaryLegends.innerHTML = String(slot4Html || '');
    } catch (_) {}
  }

  function _climateRainLegendMarkup(opts) {
    const compact = Boolean(opts && opts.compact);
    const stops = [0.2, 2, 7, 15, 30, 60].map(v => `<div style="flex:1 1 0%; background:${_climateRainStepColor(v)};"></div>`).join('');
    return `
      <div class="wm-climate-legend${compact ? ' wm-climate-legend-compact' : ''}">
        <div class="wm-climate-legend-label">Rain (mm)</div>
        <div class="wm-climate-legend-bar is-stepped">${stops}</div>
        <div class="wm-climate-legend-ticks"><span>0</span><span>1</span><span>5</span><span>10</span><span>20</span><span>50+</span></div>
      </div>
    `;
  }

  function _climateTempLegendMarkup(opts) {
    const compact = Boolean(opts && opts.compact);
    const tempData = _tempLegendData(-5, 35);
    const tempSegs = (tempData && Array.isArray(tempData.segments) && tempData.segments.length)
      ? tempData.segments.map(s => `<div style="background:${s.color};flex:${Number(s.flex) || 1} 1 0%;height:100%;"></div>`).join('')
      : '';
    return `
      <div class="wm-climate-legend${compact ? ' wm-climate-legend-compact' : ''}">
        <div class="wm-climate-legend-label">Temperature (°C)</div>
        <div class="wm-climate-legend-bar">${tempSegs}</div>
        <div class="wm-climate-legend-ticks"><span>-5</span><span>0</span><span>10</span><span>20</span><span>30</span><span>35°C</span></div>
      </div>
    `;
  }

  function _tourActiveWindLegendMarkup() {
    const mode = _normalizeOverlayMode(OVERLAY_MODE);
    if (mode === 'wind_component') {
      return `
        <div class="wm-climate-legend wm-climate-legend-compact wm-tour-wind-legend">
          <div class="wm-climate-legend-label">Head/Tail-Wind (m/s)</div>
          <div class="wm-climate-legend-bar" style="background: linear-gradient(90deg, ${_tourWindComponentColorCss(-8)} 0%, ${_tourWindComponentColorCss(-4)} 25%, ${_tourWindComponentColorCss(0)} 50%, ${_tourWindComponentColorCss(4)} 75%, ${_tourWindComponentColorCss(8)} 100%);"></div>
          <div class="wm-climate-legend-ticks"><span>-8</span><span>-4</span><span>0</span><span>4</span><span>8 m/s</span></div>
        </div>
      `;
    }
    return `
      <div class="wm-climate-legend wm-climate-legend-compact wm-tour-wind-legend">
        <div class="wm-climate-legend-label">Wind (m/s)</div>
        <div class="wm-climate-legend-bar" style="background: linear-gradient(90deg, ${_tourWindAbsoluteColor(0)} 0%, ${_tourWindAbsoluteColor(6)} 45%, ${_tourWindAbsoluteColor(12)} 75%, ${_tourWindAbsoluteColor(16)} 100%);"></div>
        <div class="wm-climate-legend-ticks"><span>0</span><span>3</span><span>6</span><span>10</span><span>14+ m/s</span></div>
      </div>
    `;
  }

  function _tourWindLegendMarkup() {
    return _tourActiveWindLegendMarkup();
  }

  function _tourSummaryLegendsMarkup() {
    return `<div class="wm-climate-legends wm-tour-legends">${_climateTempLegendMarkup({ compact: true })}${_climateRainLegendMarkup({ compact: true })}${_tourWindLegendMarkup()}</div>`;
  }

  function _climateCurrentRangeIso() {
    const year = Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
    if (_strategicUsingRangeUI()) {
      const r = _strategicGetRangeDOY();
      return {
        start: _isoDateFromDOY(r.startDoy, year),
        end: _isoDateFromDOY(r.endDoy, year),
      };
    }
    const period = _strategicPeriodForDOY(STRATEGIC_STATE.doy, STRATEGIC_STATE.timescale, year);
    if (period && Number.isFinite(Number(period.startDoy)) && Number.isFinite(Number(period.endDoy))) {
      return {
        start: _isoDateFromDOY(Number(period.startDoy), year),
        end: _isoDateFromDOY(Number(period.endDoy), year),
      };
    }
    const one = _isoDateFromDOY(STRATEGIC_STATE.doy, year);
    return { start: one, end: one };
  }

  function _climateProfileRequestKey(point) {
    const p = point || {};
    const yearsKey = _strategicYearsKey(_strategicGetSelectedYears());
    const mode = _strategicGetMode();
    const range = _climateCurrentRangeIso();
    const q3 = (x) => {
      const v = Number(x);
      return Number.isFinite(v) ? (Math.round(v * 1000) / 1000).toFixed(3) : 'nan';
    };
    return [
      q3(p.lat),
      q3(p.lon),
      yearsKey,
      mode,
      String(range.start || ''),
      String(range.end || ''),
      String(Number(SETTINGS && SETTINGS.tempCold)),
      String(Number(SETTINGS && SETTINGS.tempHot)),
      String(Number(SETTINGS && SETTINGS.rainHigh)),
      String(Number(SETTINGS && SETTINGS.windHeadComfort)),
    ].join('|');
  }

  function _climateRainStepColor(mm) {
    const v = Number(mm);
    if (!Number.isFinite(v) || v < 1) return 'rgba(201, 190, 255, 0.26)';
    if (v < 5) return 'rgba(171, 149, 252, 0.42)';
    if (v < 10) return 'rgba(138, 106, 232, 0.56)';
    if (v < 20) return 'rgba(112, 76, 207, 0.72)';
    if (v < 50) return 'rgba(85, 52, 175, 0.84)';
    return 'rgba(58, 32, 134, 0.92)';
  }

  function _renderClimateSummaryLegends() {
    if (!profileLegendHost) return;
    profileLegendHost.style.display = 'block';
    profileLegendHost.style.padding = '0';
    profileLegendHost.style.border = '0';
    profileLegendHost.style.background = 'transparent';
    profileLegendHost.style.boxShadow = 'none';
    profileLegendHost.style.marginLeft = '0';
    profileLegendHost.innerHTML = `${_climateTempLegendMarkup()}${_climateRainLegendMarkup()}`;
  }

  function _ensureClimateProfileTooltip() {
    if (CLIMATE_PROFILE_TOOLTIP) return CLIMATE_PROFILE_TOOLTIP;
    try {
      if (!profilePanel) return null;
      const el = document.createElement('div');
      el.className = 'wm-climate-profile-tooltip';
      profilePanel.appendChild(el);
      CLIMATE_PROFILE_TOOLTIP = el;
      return el;
    } catch (_) {
      return null;
    }
  }

  function _ensureClimateProfileCursorLine() {
    if (CLIMATE_PROFILE_CURSOR_LINE) return CLIMATE_PROFILE_CURSOR_LINE;
    try {
      if (!profilePanel) return null;
      const el = document.createElement('div');
      el.className = 'wm-climate-profile-cursor-line';
      el.style.position = 'absolute';
      el.style.zIndex = '2500';
      el.style.width = '2px';
      el.style.background = 'repeating-linear-gradient(to bottom, rgba(71,85,105,0.78) 0 5px, rgba(71,85,105,0.08) 5px 10px)';
      el.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.16), 0 0 8px rgba(148,163,184,0.18)';
      el.style.borderRadius = '999px';
      el.style.pointerEvents = 'none';
      el.style.display = 'none';
      el.style.opacity = '0.92';
      el.style.transform = 'translateX(-1px)';
      profilePanel.appendChild(el);
      CLIMATE_PROFILE_CURSOR_LINE = el;
      return el;
    } catch (_) {
      return null;
    }
  }

  function _hideClimateProfileTooltip() {
    try {
      const el = _ensureClimateProfileTooltip();
      if (el) el.style.display = 'none';
    } catch (_) {}
    try {
      const line = _ensureClimateProfileCursorLine();
      if (line) line.style.display = 'none';
    } catch (_) {}
  }

  function _drawClimateProfilePlaceholder(message) {
    if (!profileCanvas || !profileCtx) return;
    resizeProfileCanvas();
    const rect = profileCanvas.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width));
    const H = Math.max(1, Math.floor(rect.height));
    profileCtx.clearRect(0, 0, W, H);
    if (profileCursorCtx) profileCursorCtx.clearRect(0, 0, W, H);
    const text = (message === null || message === undefined)
      ? 'Click the climatic map to inspect weather at a location.'
      : String(message);
    if (!text) return;
    profileCtx.fillStyle = '#666';
    profileCtx.font = '13px system-ui, -apple-system, sans-serif';
    profileCtx.textAlign = 'center';
    profileCtx.textBaseline = 'middle';
    profileCtx.fillText(text, W / 2, H / 2);
  }

  function _drawProfilePlaceholder(message) {
    if (!profileCanvas || !profileCtx) return;
    resizeProfileCanvas();
    const rect = profileCanvas.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width));
    const H = Math.max(1, Math.floor(rect.height));
    profileCtx.clearRect(0, 0, W, H);
    if (profileCursorCtx) profileCursorCtx.clearRect(0, 0, W, H);
    const text = String(message || '').trim();
    if (!text) return;
    profileCtx.fillStyle = '#666';
    profileCtx.font = '13px system-ui, -apple-system, sans-serif';
    profileCtx.textAlign = 'center';
    profileCtx.textBaseline = 'middle';
    profileCtx.fillText(text, W / 2, H / 2);
  }

  function _nearestProfileIndex(xs, x) {
    try {
      const api = (typeof window !== 'undefined') ? window.WM_PROFILE_HOVER : null;
      if (api && typeof api.nearestIndex === 'function') return api.nearestIndex(xs, x);
    } catch (_) {}
    const arr = Array.isArray(xs) ? xs : [];
    const target = Number(x);
    if (!arr.length || !Number.isFinite(target)) return -1;
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < arr.length; index += 1) {
      const value = Number(arr[index]);
      if (!Number.isFinite(value)) continue;
      const distance = Math.abs(value - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return Number.isFinite(bestDistance) ? bestIndex : -1;
  }

  function _clampClimateHoverX(clientX, rectLeft, geom) {
    try {
      const api = (typeof window !== 'undefined') ? window.WM_PROFILE_HOVER : null;
      if (api && typeof api.clampClimateHoverX === 'function') return api.clampClimateHoverX(clientX, rectLeft, geom);
    } catch (_) {}
    const x = Number(clientX) - Number(rectLeft);
    const padL = Number(geom && geom.padL);
    const innerW = Number(geom && geom.innerW);
    if (!Number.isFinite(x) || !Number.isFinite(padL) || !Number.isFinite(innerW)) return NaN;
    return Math.max(padL, Math.min(padL + innerW, x));
  }

  function _hasClimateHoverIndex(length) {
    try {
      const api = (typeof window !== 'undefined') ? window.WM_PROFILE_HOVER : null;
      if (api && typeof api.isValidHoverIndex === 'function') {
        return api.isValidHoverIndex(CLIMATE_PROFILE_STATE.hoverIndex, length);
      }
    } catch (_) {}
    const index = Number(CLIMATE_PROFILE_STATE.hoverIndex);
    const size = Number(length);
    return Number.isInteger(index) && Number.isFinite(size) && index >= 0 && index < size;
  }

  function _handleClimateProfilePointerMove(clientX) {
    if (!_climateProfileIsActive() || !LAST_CLIMATE_PROFILE || !PROFILE_XS.length) {
      return false;
    }
    const geom = CLIMATE_PROFILE_GEOMETRY;
    if (!geom || !profileCanvas) {
      return false;
    }
    const rect = profileCanvas.getBoundingClientRect();
    const xFinal = _clampClimateHoverX(clientX, rect.left, geom);
    const bestIndex = _nearestProfileIndex(PROFILE_XS, xFinal);
    if (bestIndex < 0) {
      return false;
    }
    _updateClimateProfileCursor(bestIndex, xFinal);
    return true;
  }

  function _profileCanvasRect() {
    try {
      return profileCanvas ? profileCanvas.getBoundingClientRect() : null;
    } catch (_) {
      return null;
    }
  }

  function _pointInsideRect(clientX, clientY, rect) {
    const x = Number(clientX);
    const y = Number(clientY);
    if (!rect || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function _bindProfileWindowPointerHandlers() {
    if (PROFILE_WINDOW_POINTER_BOUND) return;
    const handleWindowMove = (e) => {
      try {
        const clientX = Number(e && e.clientX);
        const clientY = Number(e && e.clientY);
        const rect = _profileCanvasRect();
        const inside = _pointInsideRect(clientX, clientY, rect);
        if (_climateProfileIsActive()) {
          if (inside) {
            _handleClimateProfilePointerMove(clientX);
          } else if (_hasClimateHoverIndex(PROFILE_XS.length)) {
            CLIMATE_PROFILE_STATE.hoverIndex = null;
            _hideClimateProfileTooltip();
          }
        }
      } catch (_) {}
    };

    const handleWindowLeave = () => {
      if (!_climateProfileIsActive()) return;
      CLIMATE_PROFILE_STATE.hoverIndex = null;
      _hideClimateProfileTooltip();
    };

    document.addEventListener('pointermove', handleWindowMove, { capture: true, passive: true });
    document.addEventListener('mousemove', handleWindowMove, { capture: true, passive: true });
    window.addEventListener('pointermove', handleWindowMove, { capture: true, passive: true });
    window.addEventListener('mousemove', handleWindowMove, { capture: true, passive: true });
    window.addEventListener('blur', handleWindowLeave);
    PROFILE_WINDOW_POINTER_BOUND = true;
  }

  function _bindProfilePointerHandlers() {
    if (PROFILE_POINTER_BOUND || !profilePanel || !profileCanvas) return;
    const handleMove = (e) => {
      try {
        const clientX = Number(e && e.clientX);
        if (!Number.isFinite(clientX)) return;
        if (_handleClimateProfilePointerMove(clientX)) return;
        if (!LAST_PROFILE || PROFILE_XS.length === 0) return;
        const rect = profileCanvas.getBoundingClientRect();
        const xClient = Number(clientX - rect.left);
        const { padTop, padBot, padL, padR } = getPads();
        const W = Math.max(1, Math.floor(rect.width));
        const H = Math.max(1, Math.floor(rect.height));
        const innerW = Math.max(1, W - padL - padR);
        const xCal = xClient;
        const xFinalRaw = xCal + CURSOR_X_OFFSET;
        const xFinal = Math.max(padL, Math.min(padL + innerW, xFinalRaw));
        const bestI = _nearestProfileIndex(PROFILE_XS, xFinal);
        if (bestI < 0) return;
        window.updateProfileCursor(bestI, xFinal);
        if (DEBUG_CURSOR && profileCursorCtx) {
          profileCursorCtx.strokeStyle = 'rgba(255,0,0,0.8)';
          profileCursorCtx.setLineDash([2,2]);
          profileCursorCtx.beginPath();
          profileCursorCtx.moveTo(xClient, padTop);
          profileCursorCtx.lineTo(xClient, padTop + Math.max(1, H - padTop - padBot));
          profileCursorCtx.stroke();
          profileCursorCtx.strokeStyle = 'rgba(0,0,255,0.6)';
          profileCursorCtx.beginPath();
          profileCursorCtx.moveTo(xFinal, padTop);
          profileCursorCtx.lineTo(xFinal, padTop + Math.max(1, H - padTop - padBot));
          profileCursorCtx.stroke();
          profileCursorCtx.setLineDash([]);
        }
      } catch (_) {}
    };

    const handleLeave = () => {
      if (_climateProfileIsActive()) {
        CLIMATE_PROFILE_STATE.hoverIndex = null;
        _hideClimateProfileTooltip();
        return;
      }
      if (LAST_TOUR_CURSOR_READOUT) {
        try { _renderTourCursorReadout(LAST_TOUR_CURSOR_READOUT); } catch (_) {}
      }
    };

    const bindMoveAndLeave = (el) => {
      if (!el) return;
      el.addEventListener('mousemove', handleMove);
      el.addEventListener('pointermove', handleMove);
      el.addEventListener('mouseleave', handleLeave);
      el.addEventListener('pointerleave', handleLeave);
    };

    bindMoveAndLeave(profilePanel);
    bindMoveAndLeave(profileCanvas);
    bindMoveAndLeave(profileCursorCanvas);
    try { _bindProfileWindowPointerHandlers(); } catch (_) {}
    PROFILE_POINTER_BOUND = true;
  }

  try { _bindProfilePointerHandlers(); } catch (_) {}

  function _drawClimateWindArrow(ctx, x, y, speed, dirFromDeg, maxWind) {
    const spd = Number(speed);
    const dirFrom = Number(dirFromDeg);
    if (!Number.isFinite(spd) || !Number.isFinite(dirFrom)) return;
    const maxRef = Math.max(4, Number(maxWind) || 8);
    const len = Math.max(10, Math.min(26, 10 + (16 * Math.max(0, spd)) / maxRef));
    const dirTo = ((dirFrom + 180) % 360) * Math.PI / 180;
    const dx = Math.cos(dirTo) * (len * 0.5);
    const dy = Math.sin(dirTo) * (len * 0.5);
    ctx.save();
    const alpha = Math.max(0.38, Math.min(0.92, 0.34 + (0.58 * Math.max(0, spd)) / maxRef));
    ctx.strokeStyle = `rgba(70,70,70,${alpha.toFixed(3)})`;
    ctx.fillStyle = `rgba(70,70,70,${alpha.toFixed(3)})`;
    ctx.lineWidth = 1.35;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - dx, y - dy);
    ctx.lineTo(x + dx, y + dy);
    ctx.stroke();
    const headX = x + dx;
    const headY = y + dy;
    const headLen = 4;
    const a1 = dirTo + Math.PI * 0.82;
    const a2 = dirTo - Math.PI * 0.82;
    ctx.beginPath();
    ctx.moveTo(headX, headY);
    ctx.lineTo(headX + Math.cos(a1) * headLen, headY + Math.sin(a1) * headLen);
    ctx.lineTo(headX + Math.cos(a2) * headLen, headY + Math.sin(a2) * headLen);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawClimateProfile(profileData) {
    if (!profileCanvas || !profileCtx) return;
    const series = Array.isArray(profileData && profileData.series) ? profileData.series : [];
    LAST_CLIMATE_PROFILE = profileData || null;
    resizeProfileCanvas();
    const rect = profileCanvas.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width));
    const H = Math.max(1, Math.floor(rect.height));
    profileCtx.clearRect(0, 0, W, H);
    if (profileCursorCtx) profileCursorCtx.clearRect(0, 0, W, H);
    if (!series.length) {
      _drawClimateProfilePlaceholder('No climate profile data available for this point.');
      return;
    }

    const padTop = 22;
    const padBot = 34;
    const padL = 38;
    const padR = 52;
    const innerW = Math.max(1, W - padL - padR);
    const innerH = Math.max(1, H - padTop - padBot);
    const axisY = padTop + innerH;
    const xAtIndex = (index) => {
      if (series.length <= 1) return padL + innerW * 0.5;
      const i = Math.max(0, Math.min(series.length - 1, Number(index) || 0));
      return padL + (innerW * i) / (series.length - 1);
    };

    const tempVals = [];
    for (const point of series) {
      const vals = [point && point.temp, point && point.temp_p25, point && point.temp_p75].map(Number).filter(Number.isFinite);
      tempVals.push(...vals);
    }
    const tmin = -5;
    const tmax = 40;
    const yAtTemp = (temp) => {
      const t = Number(temp);
      const clamped = Math.max(tmin, Math.min(tmax, Number.isFinite(t) ? t : tmin));
      return padTop + innerH - Math.round(innerH * ((clamped - tmin) / Math.max(1e-6, tmax - tmin)));
    };

    const tempRaw = series.map(p => Number(p && p.temp));
    const tempSmooth = tempRaw.map((_value, index) => {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, index - 1); j <= Math.min(tempRaw.length - 1, index + 1); j++) {
        const v = Number(tempRaw[j]);
        if (!Number.isFinite(v)) continue;
        sum += v;
        count += 1;
      }
      return count ? (sum / count) : NaN;
    });

    const rainVals = series.map(p => Number(p && p.rain)).filter(v => Number.isFinite(v) && v >= 0);
    const rainAxisMax = (() => {
      const rawMax = Math.max(5, ...(rainVals.length ? rainVals : [0]));
      if (rawMax <= 5) return 5;
      if (rawMax <= 10) return 10;
      if (rawMax <= 20) return 20;
      if (rawMax <= 35) return 35;
      return 50;
    })();
    const maxWind = Math.max(6, ...series.map(p => Number(p && p.wind_speed)).filter(Number.isFinite));

    CLIMATE_PROFILE_GEOMETRY = { padTop, padBot, padL, padR, innerW, innerH, axisY, rainAxisMax };

    profileCtx.save();
    profileCtx.globalAlpha = 0.68;
    profileCtx.fillStyle = '#334155';
    profileCtx.font = '600 11px system-ui, -apple-system, sans-serif';
    profileCtx.textAlign = 'left';
    profileCtx.fillText('Temperature (°C)', padL, 13);
    profileCtx.textAlign = 'right';
    profileCtx.fillText('Rain (mm/day)', padL + innerW + padR - 4, 13);
    profileCtx.restore();

    profileCtx.strokeStyle = '#ddd';
    profileCtx.lineWidth = 1;
    profileCtx.setLineDash([4, 4]);
    for (let tv = Math.ceil(tmin / 5) * 5; tv <= tmax + 1e-6; tv += 5) {
      const y = yAtTemp(tv);
      profileCtx.beginPath();
      profileCtx.moveTo(padL, y);
      profileCtx.lineTo(padL + innerW, y);
      profileCtx.stroke();
    }
    profileCtx.setLineDash([]);

    const rainGuideValues = [1, 5, 10].filter(v => v < rainAxisMax + 1e-9);
    profileCtx.save();
    profileCtx.strokeStyle = 'rgba(126, 92, 225, 0.16)';
    profileCtx.lineWidth = 1;
    profileCtx.setLineDash([3, 5]);
    for (const guide of rainGuideValues) {
      const y = axisY - (innerH * guide) / Math.max(1e-6, rainAxisMax);
      profileCtx.beginPath();
      profileCtx.moveTo(padL, y);
      profileCtx.lineTo(padL + innerW, y);
      profileCtx.stroke();
    }
    profileCtx.restore();

    const barW = Math.max(4, Math.min(12, Math.round(innerW / Math.max(6, series.length * 1.8))));
    for (let i = 0; i < series.length; i++) {
      const point = series[i] || {};
      const rain = Number(point.rain);
      if (!Number.isFinite(rain) || rain <= 0) continue;
      const h = (Math.max(0, Math.min(rainAxisMax, rain)) / Math.max(1, rainAxisMax)) * innerH;
      const x = xAtIndex(i);
      profileCtx.fillStyle = _climateRainStepColor(rain);
      profileCtx.fillRect(Math.round(x - barW / 2), Math.round(axisY - h), barW, Math.round(h));
    }

    const bandUpper = [];
    const bandLower = [];
    for (let i = 0; i < series.length; i++) {
      const point = series[i] || {};
      const hi = Number(point.temp_p75);
      const lo = Number(point.temp_p25);
      if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
      bandUpper.push({ x: xAtIndex(i), y: yAtTemp(hi) });
      bandLower.push({ x: xAtIndex(i), y: yAtTemp(lo) });
    }
    if (bandUpper.length >= 2 && bandLower.length >= 2) {
      const segmentCount = Math.min(bandUpper.length, bandLower.length) - 1;
      for (let i = 0; i < segmentCount; i++) {
        const upper0 = bandUpper[i];
        const upper1 = bandUpper[i + 1];
        const lower1 = bandLower[i + 1];
        const lower0 = bandLower[i];
        const t0 = Number(tempSmooth[i]);
        const t1 = Number(tempSmooth[i + 1]);
        const color = String(tempColor(Number.isFinite(t0) && Number.isFinite(t1) ? ((t0 + t1) * 0.5) : 15) || 'rgba(26,152,80,1)')
          .replace(/rgba\(([^)]+),\s*1\)/, 'rgba($1, 0.22)')
          .replace(/rgb\(([^)]+)\)/, 'rgba($1, 0.22)');
        profileCtx.beginPath();
        profileCtx.moveTo(upper0.x, upper0.y);
        profileCtx.lineTo(upper1.x, upper1.y);
        profileCtx.lineTo(lower1.x, lower1.y);
        profileCtx.lineTo(lower0.x, lower0.y);
        profileCtx.closePath();
        profileCtx.fillStyle = color;
        profileCtx.fill();
      }
    }

    const drawTempGuide = (key) => {
      let started = false;
      profileCtx.beginPath();
      for (let i = 0; i < series.length; i++) {
        const point = series[i] || {};
        const t = Number(point[key]);
        if (!Number.isFinite(t)) continue;
        const x = xAtIndex(i);
        const y = yAtTemp(t);
        if (!started) {
          profileCtx.moveTo(x, y);
          started = true;
        } else {
          profileCtx.lineTo(x, y);
        }
      }
      if (started) profileCtx.stroke();
    };

    profileCtx.strokeStyle = 'rgba(51, 65, 85, 0.72)';
    profileCtx.lineWidth = 1.2;
    profileCtx.setLineDash([3, 3]);
    drawTempGuide('temp_p25');
    drawTempGuide('temp_p75');

    profileCtx.setLineDash([]);
    profileCtx.lineWidth = 2.4;
    profileCtx.lineJoin = 'round';
    profileCtx.lineCap = 'round';
    for (let i = 1; i < series.length; i++) {
      const t0 = Number(tempSmooth[i - 1]);
      const t1 = Number(tempSmooth[i]);
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
      const x0 = xAtIndex(i - 1);
      const x1 = xAtIndex(i);
      const y0 = yAtTemp(t0);
      const y1 = yAtTemp(t1);
      profileCtx.beginPath();
      profileCtx.moveTo(x0, y0);
      profileCtx.lineTo(x1, y1);
      profileCtx.strokeStyle = tempColor((t0 + t1) * 0.5);
      profileCtx.stroke();
    }

    const luckyY = padTop + 9;
    const windY = axisY - 12;
    for (let i = 0; i < series.length; i++) {
      const point = series[i] || {};
      const x = xAtIndex(i);
      profileCtx.beginPath();
      profileCtx.arc(x, luckyY, 4.2, 0, Math.PI * 2);
      profileCtx.fillStyle = point.lucky ? '#47d764' : '#b3b3b3';
      profileCtx.fill();
      profileCtx.lineWidth = 1;
      profileCtx.strokeStyle = point.lucky ? 'rgba(20, 126, 56, 0.95)' : 'rgba(120, 132, 145, 0.72)';
      profileCtx.stroke();
      _drawClimateWindArrow(profileCtx, x, windY, point.wind_speed, point.wind_dir, maxWind);
    }

    profileCtx.strokeStyle = '#666';
    profileCtx.lineWidth = 1;
    profileCtx.beginPath();
    profileCtx.moveTo(padL, axisY);
    profileCtx.lineTo(padL + innerW, axisY);
    profileCtx.stroke();

    profileCtx.fillStyle = '#666';
    profileCtx.font = '10px system-ui, -apple-system, sans-serif';
    profileCtx.textAlign = 'center';
    const weeklyStep = (series.length <= 10) ? 2 : 7;
    for (let i = 0; i < series.length; i += weeklyStep) {
      const x = xAtIndex(i);
      profileCtx.beginPath();
      profileCtx.moveTo(x, axisY);
      profileCtx.lineTo(x, axisY + 6);
      profileCtx.stroke();
      profileCtx.fillText(_fmtIsoDayMonthCompact(series[i] && series[i].date), x, axisY + 18);
    }
    if (series.length > 1) {
      const lastX = xAtIndex(series.length - 1);
      profileCtx.beginPath();
      profileCtx.moveTo(lastX, axisY);
      profileCtx.lineTo(lastX, axisY + 6);
      profileCtx.stroke();
      profileCtx.fillText(_fmtIsoDayMonthCompact(series[series.length - 1] && series[series.length - 1].date), lastX, axisY + 18);
    }

    const xScaleL = padL;
    const xScaleR = padL + innerW;
    profileCtx.strokeStyle = '#666';
    profileCtx.fillStyle = '#666';
    profileCtx.textAlign = 'right';
    for (let tv = Math.ceil(tmin / 5) * 5; tv <= tmax + 1e-6; tv += 5) {
      const y = yAtTemp(tv);
      profileCtx.beginPath();
      profileCtx.moveTo(xScaleL, y);
      profileCtx.lineTo(xScaleL - 6, y);
      profileCtx.stroke();
      profileCtx.fillText(`${tv}°C`, xScaleL - 8, y + 3);
    }

    profileCtx.textAlign = 'left';
    const rainTicks = [0, rainAxisMax / 2, rainAxisMax].filter((v, idx, arr) => idx === 0 || Math.abs(v - arr[idx - 1]) > 0.5);
    for (const rv of rainTicks) {
      const y = axisY - (innerH * rv) / Math.max(1e-6, rainAxisMax);
      profileCtx.beginPath();
      profileCtx.moveTo(xScaleR, y);
      profileCtx.lineTo(xScaleR + 6, y);
      profileCtx.stroke();
      profileCtx.fillText(`${Math.round(rv)} mm`, xScaleR + 8, y + 3);
    }

    profileCtx.textAlign = 'center';
    profileCtx.fillStyle = '#64748b';
    profileCtx.font = '10px system-ui, -apple-system, sans-serif';
    let prevMonth = '';
    for (let i = 0; i < series.length; i++) {
      const iso = String(series[i] && series[i].date || '');
      const monthLabel = iso.length >= 7 ? iso.slice(5, 7) : '';
      if (!monthLabel || monthLabel === prevMonth) continue;
      prevMonth = monthLabel;
      const x = xAtIndex(i);
      profileCtx.fillText(monthLabel, x, H - 4);
    }

    PROFILE_XS = series.map((_point, index) => xAtIndex(index));
    try {
      const hoverIndex = Number(CLIMATE_PROFILE_STATE.hoverIndex);
      if (_hasClimateHoverIndex(PROFILE_XS.length)) {
        _updateClimateProfileCursor(hoverIndex, PROFILE_XS[hoverIndex]);
      } else {
        _hideClimateProfileTooltip();
      }
    } catch (_) {}
  }

  function _renderClimateSummary(payload) {
    const meta = payload && payload.meta ? payload.meta : {};
    const summary = payload && payload.summary ? payload.summary : {};
    const totalDays = Number(summary.total_days || (payload && payload.series && payload.series.length) || 0);
    const years = Array.isArray(meta.years) ? meta.years : [];
    const yearsText = years.length ? `${Math.min(...years)}–${Math.max(...years)}` : '—';
    const startTxt = _fmtIsoDayMonthCompact(meta.start);
    const endTxt = _fmtIsoDayMonthCompact(meta.end);
    const windCard = Number.isFinite(Number(summary.wind_dir)) ? degToCardinal(Number(summary.wind_dir)) : '—';
    const loc = _climateLocationInfo(meta);

    _setBottomPanelUiMode('climate');
    if (tourSummaryBadges) {
      tourSummaryBadges.style.minHeight = '70px';
      tourSummaryBadges.style.padding = '8px 12px';
    }
    _setWhiteBandSlots(
      `
        <div class="wm-tour-band-card">
          <div class="wm-tour-route-kicker">Click Location</div>
          <div class="wm-tour-route-title">${loc.title}</div>
          <div class="wm-tour-route-file">${loc.coords}</div>
          <div class="wm-tour-route-meta">${startTxt}–${endTxt} • ${Math.max(1, totalDays)}d • ${yearsText} • ${String(meta.mode || 'active') === 'full_day' ? '24h' : 'Active'}</div>
        </div>
      `,
      _whiteBandEmptyCardMarkup(),
      `
        <div class="wm-climate-metrics">
          <div class="wm-climate-metric">
            <div class="wm-climate-metric-label">🌡 Temp</div>
            <div class="wm-climate-metric-main">${fmt(summary.temp_mean, 1)}°C</div>
            <div class="wm-climate-metric-secondary">${fmt(summary.temp_min, 0)}–${fmt(summary.temp_max, 0)}°</div>
            <div class="wm-climate-metric-tertiary">typ ${fmt(summary.typical_temp_min, 0)}–${fmt(summary.typical_temp_max, 0)}</div>
          </div>
          <div class="wm-climate-metric">
            <div class="wm-climate-metric-label">🌧 Rain</div>
            <div class="wm-climate-metric-main">${fmt(summary.rain_mean, 1)} mm/d</div>
            <div class="wm-climate-metric-secondary">${fmt(summary.rain_sum, 0)} mm</div>
            <div class="wm-climate-metric-tertiary">${Number(summary.rain_days || 0)} days</div>
          </div>
          <div class="wm-climate-metric">
            <div class="wm-climate-metric-label">🌬 Wind</div>
            <div class="wm-climate-metric-main">${windCard} ${fmt(summary.wind_speed, 1)} m/s</div>
            <div class="wm-climate-metric-secondary">calm ${Number(summary.calm_days || 0)}/${Math.max(1, totalDays)}</div>
            <div class="wm-climate-metric-tertiary">dir ${Number.isFinite(Number(summary.wind_dir)) ? `${Math.round(Number(summary.wind_dir))}°` : '—'}</div>
          </div>
          <div class="wm-climate-metric">
            <div class="wm-climate-metric-label">😊 Lucky</div>
            <div class="wm-climate-metric-main">${Number(summary.lucky_days || 0)}/${Math.max(1, totalDays)}</div>
            <div class="wm-climate-metric-secondary">${_fmtPercent(summary.lucky_days, totalDays)}</div>
            <div class="wm-climate-metric-tertiary">good riding days</div>
          </div>
        </div>
      `,
      `<div class="wm-climate-legends">${_climateTempLegendMarkup()}${_climateRainLegendMarkup()}</div>`
    );
    try { if (profileLegendHost) profileLegendHost.style.display = 'none'; } catch (_) {}
    _reflowBottomLayout();
  }

  function _renderClimateLoading(point) {
    _setBottomPanelUiMode('climate');
    _hideClimateProfileTooltip();
    _setWhiteBandSlots(
      '<div class="wm-tour-band-card"><div class="wm-tour-route-kicker">Click Location</div><div class="wm-tour-route-meta">Loading weather data...</div></div>',
      _whiteBandEmptyCardMarkup(),
      '<div style="font-size:12px; color:#555; align-self:center;">Loading weather data...</div>',
      `<div class="wm-climate-legends">${_climateTempLegendMarkup()}${_climateRainLegendMarkup()}</div>`
    );
    try { if (profileLegendHost) profileLegendHost.style.display = 'none'; } catch (_) {}
    _drawClimateProfilePlaceholder('Loading weather data...');
    _reflowBottomLayout();
  }

  function _renderClimateError(message) {
    _setBottomPanelUiMode('climate');
    _hideClimateProfileTooltip();
    _setWhiteBandSlots(
      '<div class="wm-tour-band-card"><div class="wm-tour-route-kicker">Click Location</div><div class="wm-tour-route-meta">Climate profile unavailable</div></div>',
      _whiteBandEmptyCardMarkup(),
      `<div style="font-size:12px; color:#8a2d2d; align-self:center;">${String(message || 'Climate profile could not be loaded.')}</div>`,
      `<div class="wm-climate-legends">${_climateTempLegendMarkup()}${_climateRainLegendMarkup()}</div>`
    );
    try { if (profileLegendHost) profileLegendHost.style.display = 'none'; } catch (_) {}
    _drawClimateProfilePlaceholder(String(message || 'Climate profile could not be loaded.'));
    _reflowBottomLayout();
  }

  function _renderClimateEmptyState() {
    _setBottomPanelUiMode('climate');
    _hideClimateProfileTooltip();
    if (CLIMATE_PROFILE_STATE.loadingPoint) {
      _renderClimateLoading(CLIMATE_PROFILE_STATE.loadingPoint);
      return;
    }
    _setWhiteBandSlots(
      '<div class="wm-tour-band-card"><div class="wm-tour-route-kicker">Click Location</div><div class="wm-tour-route-meta">Select a point on the climatic map to inspect it.</div></div>',
      _whiteBandEmptyCardMarkup(),
      '',
      `<div class="wm-climate-legends">${_climateTempLegendMarkup()}${_climateRainLegendMarkup()}</div>`
    );
    try { if (profileLegendHost) profileLegendHost.style.display = 'none'; } catch (_) {}
    _drawClimateProfilePlaceholder('');
    _reflowBottomLayout();
  }

  function getRideConditionLabel(day, settings) {
    const point = (day && typeof day === 'object') ? day : {};
    const source = (settings && typeof settings === 'object') ? settings : (SETTINGS || {});
    const thresholds = {
      Tmin: Number.isFinite(Number(source.Tmin)) ? Number(source.Tmin) : Number(source.tempCold),
      Tmax: Number.isFinite(Number(source.Tmax)) ? Number(source.Tmax) : Number(source.tempHot),
      maxRain: Number.isFinite(Number(source.maxRain)) ? Number(source.maxRain) : Number(source.rainHigh),
      maxWind: Number.isFinite(Number(source.maxWind)) ? Number(source.maxWind) : Number(source.windHeadComfort),
    };

    const temp = Number(point.temp);
    const rain = Number(point.rain);
    const wind = Number(point.wind_speed);
    const conditions = [];

    if (Number.isFinite(rain) && Number.isFinite(thresholds.maxRain) && rain > thresholds.maxRain) {
      conditions.push(rain > thresholds.maxRain * 2
        ? { icon: '🌧', label: 'very wet', priority: 1 }
        : { icon: '🌧', label: 'wet', priority: 1 });
    }

    if (Number.isFinite(wind) && Number.isFinite(thresholds.maxWind) && wind > thresholds.maxWind) {
      conditions.push(wind > thresholds.maxWind * 1.5
        ? { icon: '💨', label: 'windy', priority: 2 }
        : { icon: '💨', label: 'breezy', priority: 2 });
    }

    if (Number.isFinite(temp)) {
      if (Number.isFinite(thresholds.Tmin) && temp < thresholds.Tmin) {
        conditions.push(temp < thresholds.Tmin - 5
          ? { icon: '❄️', label: 'cold', priority: 3 }
          : { icon: '❄️', label: 'chilly', priority: 3 });
      } else if (Number.isFinite(thresholds.Tmax) && temp > thresholds.Tmax) {
        conditions.push(temp > thresholds.Tmax + 5
          ? { icon: '☀️', label: 'hot', priority: 3 }
          : { icon: '☀️', label: 'warm', priority: 3 });
      }
    }

    if (!conditions.length) return '☀️ perfect riding day';

    conditions.sort((a, b) => a.priority - b.priority);
    const top = conditions.slice(0, 2);
    const icons = top.map((entry) => entry.icon).join('');
    const labels = top.map((entry) => entry.label);
    return top.length === 1
      ? `${icons} ${labels[0]}`
      : `${icons} ${labels[0]} and ${labels[1]}`;
  }

  function _updateClimateProfileCursor(index, displayX) {
    if (!profileCursorCtx || !profileCanvas || !LAST_CLIMATE_PROFILE) return;
    const series = Array.isArray(LAST_CLIMATE_PROFILE.series) ? LAST_CLIMATE_PROFILE.series : [];
    const point = series[index];
    const geom = CLIMATE_PROFILE_GEOMETRY;
    if (!point || !geom) return;
    const rect = profileCanvas.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width));
    const H = Math.max(1, Math.floor(rect.height));
    CLIMATE_PROFILE_STATE.hoverIndex = Number(index);
    const x = Number.isFinite(Number(PROFILE_XS && PROFILE_XS[index])) ? Number(PROFILE_XS[index]) : Number(displayX);
    profileCursorCtx.clearRect(0, 0, W, H);
    profileCursorCtx.strokeStyle = 'rgba(71, 85, 105, 0.58)';
    profileCursorCtx.lineWidth = 1;
    profileCursorCtx.setLineDash([4, 4]);
    profileCursorCtx.beginPath();
    profileCursorCtx.moveTo(x, geom.padTop);
    profileCursorCtx.lineTo(x, geom.axisY);
    profileCursorCtx.stroke();
    profileCursorCtx.setLineDash([]);
    try {
      const line = _ensureClimateProfileCursorLine();
      if (line) {
        line.style.display = 'block';
        line.style.left = `${Math.round(x)}px`;
        line.style.top = `${Math.round(geom.padTop)}px`;
        line.style.height = `${Math.max(0, Math.round(geom.axisY - geom.padTop))}px`;
      }
    } catch (_) {}

    const tip = _ensureClimateProfileTooltip();
    if (!tip) return;
    const windCard = Number.isFinite(Number(point.wind_dir)) ? degToCardinal(Number(point.wind_dir)) : '—';
    const iconClass = mapWeatherByProb(point.rain_probability !== undefined ? point.rain_probability : point.rainProb);
    const iconMarkup = (() => {
      try {
        return resizeInlineSvgGlyphMarkup(getWeatherSvg(iconClass), 16, 16);
      } catch (_) {
        return '';
      }
    })();
    const rideConditionLabel = getRideConditionLabel(point, SETTINGS);
    tip.innerHTML = `
      <div class="row"><strong>Day</strong><span style="display:inline-flex;align-items:center;gap:5px;">${iconMarkup}${_fmtIsoDayMonthCompact(point.date)}</span></div>
      <div class="row"><strong>Ride day</strong><span>${rideConditionLabel}</span></div>
      <div class="row"><strong>Temp</strong><span>${fmt(point.temp, 1)}°C</span></div>
      <div class="row"><strong>Typical range</strong><span>${fmt(point.temp_p25, 1)}–${fmt(point.temp_p75, 1)}°C</span></div>
      <div class="row"><strong>Rain</strong><span>${fmt(point.rain, 1)} mm</span></div>
      <div class="row"><strong>Wind</strong><span>${windCard} ${fmt(point.wind_speed, 1)} m/s</span></div>
    `;
    tip.style.display = 'block';
    const panelRect = profilePanel ? profilePanel.getBoundingClientRect() : rect;
    let left = x + 12;
    let top = geom.padTop + 10;
    const tw = tip.offsetWidth || 190;
    if (left + tw > panelRect.width - 8) left = Math.max(8, x - tw - 12);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function _ensureClimateSelectedMarker(point) {
    if (!point || !map || !window.L) return;
    try {
      if (!CLIMATE_PROFILE_STATE.selectedMarker) {
        CLIMATE_PROFILE_STATE.selectedMarker = L.circleMarker([Number(point.lat), Number(point.lon)], {
          radius: 6,
          color: '#1f1f1f',
          weight: 1.5,
          fillColor: '#ffffff',
          fillOpacity: 0.95,
        }).addTo(map);
      } else {
        CLIMATE_PROFILE_STATE.selectedMarker.setLatLng([Number(point.lat), Number(point.lon)]);
        try { if (!map.hasLayer(CLIMATE_PROFILE_STATE.selectedMarker)) CLIMATE_PROFILE_STATE.selectedMarker.addTo(map); } catch (_) {}
      }
    } catch (_) {}
  }

  async function _requestClimateProfile(point, opts) {
    if (!point || !_climateProfileIsActive()) return;
    const options = (opts && typeof opts === 'object') ? opts : {};
    const key = _climateProfileRequestKey(point);
    if (!options.force) {
      const cached = _cacheClimateProfileGet(key);
      if (cached) {
        LAST_CLIMATE_PROFILE = cached;
        _renderClimateSummary(cached);
        drawClimateProfile(cached);
        return;
      }
    }

    _renderClimateLoading(point);
    CLIMATE_PROFILE_STATE.loadingPoint = { lat: Number(point.lat), lon: Number(point.lon) };
    try {
      if (CLIMATE_PROFILE_STATE.fetchAbort) CLIMATE_PROFILE_STATE.fetchAbort.abort();
    } catch (_) {}
    const ac = new AbortController();
    CLIMATE_PROFILE_STATE.fetchAbort = ac;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      try { ac.abort(new Error('climate-profile-timeout')); } catch (_) {}
    }, CLIMATE_PROFILE_FETCH_TIMEOUT_MS);

    const range = _climateCurrentRangeIso();
    const yearsKey = _strategicYearsKey(_strategicGetSelectedYears());
    const mode = _strategicGetMode();
    const url = `/api/weather_profile?lat=${encodeURIComponent(String(point.lat))}`
      + `&lon=${encodeURIComponent(String(point.lon))}`
      + `&years=${encodeURIComponent(String(yearsKey))}`
      + `&mode=${encodeURIComponent(String(mode))}`
      + `&start_date=${encodeURIComponent(String(range.start || ''))}`
      + `&end_date=${encodeURIComponent(String(range.end || ''))}`
      + `&lucky_temp_cold=${encodeURIComponent(String(Number(SETTINGS && SETTINGS.tempCold)))}`
      + `&lucky_temp_hot=${encodeURIComponent(String(Number(SETTINGS && SETTINGS.tempHot)))}`
      + `&lucky_rain_max=${encodeURIComponent(String(Number(SETTINGS && SETTINGS.rainHigh)))}`
      + `&lucky_wind_max=${encodeURIComponent(String(Number(SETTINGS && SETTINGS.windHeadComfort)))}`;

    try {
      const resp = await fetch(url, { signal: ac.signal });
      const payload = await resp.json();
      if (!resp.ok) {
        throw new Error(payload && payload.error ? payload.error : `HTTP ${resp.status}`);
      }
      if (!_climateProfileIsActive()) return;
      _cacheClimateProfileSet(key, payload);
      LAST_CLIMATE_PROFILE = payload;
      _renderClimateSummary(payload);
      drawClimateProfile(payload);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (!timedOut) return;
        _renderClimateLoading(point);
        return;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (CLIMATE_PROFILE_STATE.fetchAbort === ac) {
        CLIMATE_PROFILE_STATE.fetchAbort = null;
      }
      if (timedOut) return;
      if (CLIMATE_PROFILE_STATE.loadingPoint
          && Number(CLIMATE_PROFILE_STATE.loadingPoint.lat) === Number(point.lat)
          && Number(CLIMATE_PROFILE_STATE.loadingPoint.lon) === Number(point.lon)) {
        CLIMATE_PROFILE_STATE.loadingPoint = null;
      }
    }
  }

  function _scheduleClimateProfileForPoint(point, opts) {
    if (!point) return;
    const options = (opts && typeof opts === 'object') ? opts : {};
    CLIMATE_PROFILE_STATE.selectedPoint = { lat: Number(point.lat), lon: Number(point.lon) };
    _ensureClimateSelectedMarker(CLIMATE_PROFILE_STATE.selectedPoint);
    try {
      if (CLIMATE_PROFILE_STATE.clickTimer) clearTimeout(CLIMATE_PROFILE_STATE.clickTimer);
    } catch (_) {}
    const delay = options.immediate ? 0 : CLIMATE_CLICK_DEBOUNCE_MS;
    CLIMATE_PROFILE_STATE.clickTimer = setTimeout(() => {
      _requestClimateProfile(CLIMATE_PROFILE_STATE.selectedPoint, options).catch((err) => {
        if (err && err.name === 'AbortError') return;
        _renderClimateError(err && err.message ? err.message : 'Climate profile could not be loaded.');
      });
    }, delay);
  }

  function _ensureDefaultClimateProfileSelection(opts) {
    try {
      if (CLIMATE_PROFILE_STATE.selectedPoint) return;
      _scheduleClimateProfileForPoint(CLIMATE_DEFAULT_POINT, { ...(opts || {}), immediate: true, force: false });
    } catch (_) {}
  }

  function _refreshClimateProfileSelection(opts) {
    if (!_climateProfileIsActive()) return;
    if (!CLIMATE_PROFILE_STATE.selectedPoint) {
      _ensureDefaultClimateProfileSelection(opts);
      return;
    }
    _scheduleClimateProfileForPoint(CLIMATE_PROFILE_STATE.selectedPoint, { ...(opts || {}), immediate: true });
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
      if (changed) {
        _persistLastGpxSelection();
        updateDropZoneLabel();
      }
    } catch (_) {}
  }

  function _cleanRouteDisplayName(name) {
    try {
      const raw = String(name || '').trim();
      if (!raw) return 'Loaded route';
      const base = raw.replace(/\.gpx$/i, '');
      return base
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch (_) {
      return 'Loaded route';
    }
  }

  function _tourRouteLabelParts() {
    const rawName = (LAST_GPX_NAME && String(LAST_GPX_NAME).trim())
      ? String(LAST_GPX_NAME).trim()
      : getBaseName(LAST_GPX_PATH || '');
    const title = _cleanRouteDisplayName(rawName || 'Loaded route');
    const candidates = [
      /^(?:from\s+)?(.+?)\s+to\s+(.+)$/i,
      /^von\s+(.+?)\s+nach\s+(.+)$/i,
      /^(.+?)\s*[→>-]+\s*(.+)$/i,
    ];
    for (const rx of candidates) {
      const m = title.match(rx);
      if (!m) continue;
      const from = String(m[1] || '').trim();
      const to = String(m[2] || '').trim();
      if (from && to) return { title: `${from} → ${to}`, from, to };
    }
    return { title, from: 'Start', to: 'Finish' };
  }

  function _tourDisplayGpxName() {
    try {
      const rawName = (LAST_GPX_NAME && String(LAST_GPX_NAME).trim())
        ? String(LAST_GPX_NAME).trim()
        : getBaseName(LAST_GPX_PATH || '');
      return rawName || 'Loaded route.gpx';
    } catch (_) {
      return 'Loaded route.gpx';
    }
  }

  function _tourRouteEndpointsForDisplay() {
    try {
      if (!Array.isArray(ROUTE_COORDS) || ROUTE_COORDS.length < 1) return null;
      const first = ROUTE_COORDS[0];
      const last = ROUTE_COORDS[ROUTE_COORDS.length - 1];
      if (!Array.isArray(first) || !Array.isArray(last) || first.length < 2 || last.length < 2) return null;
      const start = first;
      const end = last;
      const startLon = Number(start[0]);
      const startLat = Number(start[1]);
      const endLon = Number(end[0]);
      const endLat = Number(end[1]);
      if (![startLat, startLon, endLat, endLon].every((v) => Number.isFinite(v))) return null;
      return { startLat, startLon, endLat, endLon };
    } catch (_) {
      return null;
    }
  }

  function _tourRouteDisplayLabels() {
    const routeInfo = _tourRouteLabelParts();
    const endpoints = _tourRouteEndpointsForDisplay();
    if (endpoints) {
      return {
        fromLabel: _strategicLocationFallbackLabel(endpoints.startLat, endpoints.startLon),
        toLabel: _strategicLocationFallbackLabel(endpoints.endLat, endpoints.endLon),
      };
    }
    return {
      fromLabel: REVERSED ? routeInfo.to : routeInfo.from,
      toLabel: REVERSED ? routeInfo.from : routeInfo.to,
    };
  }

  function _applyReverseTourState(nextValue, opts) {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const refresh = Boolean(options.refresh);
    const nextReversed = Boolean(nextValue);
    try {
      const reverseCheck = document.getElementById('reverse');
      if (reverseCheck) reverseCheck.checked = nextReversed;
    } catch (_) {}
    REVERSED = nextReversed;
    try { applyPrefsFromFormAndPersist(); } catch (_) {}
    if (!refresh) {
      markDataStale();
      return;
    }
    OFFLINE_FALLBACK_ACTIVE = false;
    try { window.__WM_PROFILE_PRIME_DONE__ = false; } catch (_) {}
    loadMap({ ...(LAST_LOAD_OPTS || {}), forceRestart: true });
  }

  function _tourSelectedYears() {
    try {
      const ys = _uniqYearsDesc(_strategicGetSelectedYears());
      if (ys.length) return ys;
    } catch (_) {}
    try {
      const nowYear = (new Date()).getFullYear();
      const last = Number(SETTINGS && SETTINGS.histLastYear);
      const count = Math.max(1, Math.round(Number(SETTINGS && SETTINGS.histYears) || 10));
      const end = (Number.isFinite(last) && last >= 1970) ? Math.round(last) : (nowYear - 1);
      return Array.from({ length: count }, (_, i) => end - i).filter((v) => Number.isFinite(v) && v >= 1970);
    } catch (_) {
      return [Math.max(1970, (new Date()).getFullYear() - 1)];
    }
  }

  function _tourSelectedYearsSpan() {
    const years = _tourSelectedYears();
    const start = Math.min(...years);
    const end = Math.max(...years);
    const count = Math.max(1, end - start + 1);
    return {
      years,
      start,
      end,
      count,
      exactLabel: years.join(', '),
      spanLabel: (start === end) ? String(start) : `${start}–${end}`,
      discontiguous: years.length !== count,
    };
  }

  function _tourDateRangeInfo() {
    const fallbackIso = new Date().toISOString().slice(0, 10);
    const startIso = (startDateInput && startDateInput.value) ? String(startDateInput.value) : fallbackIso;
    const totalDays = Math.max(1, Math.round(Number(tourDaysInput && tourDaysInput.value) || 1));
    const startDate = new Date(`${startIso}T00:00:00Z`);
    if (!Number.isFinite(startDate.getTime())) {
      return { startIso: fallbackIso, endIso: fallbackIso, totalDays };
    }
    const endDate = new Date(startDate.getTime());
    endDate.setUTCDate(endDate.getUTCDate() + totalDays - 1);
    return {
      startIso,
      endIso: endDate.toISOString().slice(0, 10),
      totalDays,
    };
  }

  function _tourRangeFromInputs() {
    const info = _tourDateRangeInfo();
    const startDate = new Date(`${info.startIso}T00:00:00Z`);
    const refYear = 2021;
    let startDoy = 1;
    try {
      const refDate = new Date(Date.UTC(refYear, startDate.getUTCMonth(), startDate.getUTCDate()));
      const refStart = new Date(Date.UTC(refYear, 0, 1));
      startDoy = 1 + Math.floor((refDate - refStart) / (24 * 3600 * 1000));
    } catch (_) {
      startDoy = 1;
    }
    startDoy = Math.max(1, Math.min(365, startDoy));
    const durationDays = Math.max(1, Math.round(Number(info.totalDays) || 1));
    const maxStart = Math.max(1, 365 - durationDays + 1);
    const safeStart = Math.max(1, Math.min(maxStart, startDoy));
    const safeEnd = Math.max(safeStart, Math.min(365, safeStart + durationDays - 1));
    return { startDoy: safeStart, endDoy: safeEnd, durationDays };
  }

  let TOUR_TIMELINE_REFRESH_TIMER = null;

  function _tourSyncTimelineFromInputs() {
    const { startDoy, endDoy } = _tourRangeFromInputs();
    STRATEGIC_STATE.rangeStartDoy = startDoy;
    STRATEGIC_STATE.rangeEndDoy = endDoy;
    STRATEGIC_STATE.doy = startDoy;
    try {
      if (strategicRangeStart) strategicRangeStart.value = String(startDoy);
      if (strategicRangeEnd) strategicRangeEnd.value = String(endDoy);
    } catch (_) {}
    try { _strategicSetLabels(); } catch (_) {}
    try { _strategicSyncTimescaleSelectsFromRange(); } catch (_) {}
    try { _updateStrategicLegend(); } catch (_) {}
  }

  function _tourApplyRangeToInputs(startDoy, endDoy, opts) {
    const start = _clampDOYInt(startDoy);
    const end = _clampDOYInt(endDoy);
    const durationDays = Math.max(1, Math.round(end - start + 1));
    const currentIso = (startDateInput && startDateInput.value) ? String(startDateInput.value) : new Date().toISOString().slice(0, 10);
    let baseYear = (new Date(`${currentIso}T00:00:00Z`)).getUTCFullYear();
    if (!Number.isFinite(baseYear)) baseYear = (new Date()).getUTCFullYear();
    const nextIso = _isoDateFromDOY(start, baseYear);

    try {
      if (startDateInput) startDateInput.value = nextIso;
      if (tourDaysInput) tourDaysInput.value = String(durationDays);
    } catch (_) {}
    try {
      SETTINGS.startDate = nextIso;
      SETTINGS.tourDays = durationDays;
    } catch (_) {}
    try { _tourSyncTimelineFromInputs(); } catch (_) {}
    if (opts && opts.skipRefresh) return;
    try {
      if (TOUR_TIMELINE_REFRESH_TIMER) {
        clearTimeout(TOUR_TIMELINE_REFRESH_TIMER);
        TOUR_TIMELINE_REFRESH_TIMER = null;
      }
      TOUR_TIMELINE_REFRESH_TIMER = setTimeout(() => {
        TOUR_TIMELINE_REFRESH_TIMER = null;
        try { markDataStale(); } catch (_) {}
        try { loadMap({ ...(LAST_LOAD_OPTS || {}), forceRestart: true }); } catch (_) {}
      }, 160);
    } catch (_) {
      try { markDataStale(); } catch (_) {}
      try { loadMap({ ...(LAST_LOAD_OPTS || {}), forceRestart: true }); } catch (_) {}
    }
  }

  function _tourRouteDistanceKm() {
    try {
      if (Array.isArray(ROUTE_CUM_DISTS) && ROUTE_CUM_DISTS.length >= 2) {
        const d = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1]);
        if (Number.isFinite(d) && d > 0) return d;
      }
    } catch (_) {}
    return null;
  }

  function _weekdayShort(dateIso) {
    try {
      const d = new Date(`${String(dateIso || '').slice(0, 10)}T00:00:00Z`);
      return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    } catch (_) {
      return 'Day';
    }
  }

  function _dayMonthShort(dateIso) {
    try {
      const d = new Date(`${String(dateIso || '').slice(0, 10)}T00:00:00Z`);
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      return `${dd}.${mm}`;
    } catch (_) {
      return '—';
    }
  }

  function _createRouteEndpointMarker(lat, lon, type, labelDateISO) {
    try {
      const accent = (type === 'start') ? '#2f7a45' : '#b24334';
      const title = (type === 'start') ? 'Start' : 'Finish';
      const html = [
        '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;transform:translateY(-2px);">',
        `  <div style="display:flex;flex-direction:column;align-items:center;gap:1px;min-width:74px;padding:7px 10px;border-radius:999px;background:rgba(255,255,255,0.96);border:1px solid rgba(15,23,42,0.12);box-shadow:0 6px 16px rgba(15,23,42,0.16);font-family:system-ui,-apple-system,sans-serif;color:#0f172a;line-height:1;">`,
        `    <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${accent};">${title}</div>`,
        `    <div style="font-size:11px;font-weight:600;">${_weekdayShort(labelDateISO)} ${_dayMonthShort(labelDateISO)}</div>`,
        '  </div>',
        `  <div style="width:9px;height:9px;border-radius:999px;background:${accent};border:2px solid rgba(255,255,255,0.96);box-shadow:0 2px 6px rgba(15,23,42,0.18);"></div>`,
        '</div>',
      ].join('');
      const icon = L.divIcon({ html, className: '', iconSize: [84, 48], iconAnchor: [42, 45] });
      return L.marker([lat, lon], { icon, interactive: false, keyboard: false });
    } catch (e) {
      console.error('route endpoint marker error', e);
      return null;
    }
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
  let routeDayCardLayer = null;
  let _tourDayCardsZoomHandler = null;
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
    // Phase 1: discrete bins (single source of truth in /frontend/temperature_scale.js)
    try {
      const sc = (typeof window !== 'undefined') ? window.WM_TEMP_SCALE : null;
      if (sc && typeof sc.getTempColorRgba === 'function') {
        return sc.getTempColorRgba(Number(t), 1);
      }
    } catch (_) {}
    return 'rgba(153,153,153,1)';
  }

  function _parseCssColorToRgba(color) {
    const raw = String(color || '').trim();
    if (!raw) return null;
    let m = raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (m) {
      return {
        r: Math.max(0, Math.min(255, Math.round(Number(m[1]) || 0))),
        g: Math.max(0, Math.min(255, Math.round(Number(m[2]) || 0))),
        b: Math.max(0, Math.min(255, Math.round(Number(m[3]) || 0))),
        a: Math.max(0, Math.min(1, m[4] === undefined ? 1 : (Number(m[4]) || 0))),
      };
    }
    m = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      const hex = m[1];
      if (hex.length === 3) {
        return {
          r: parseInt(hex[0] + hex[0], 16),
          g: parseInt(hex[1] + hex[1], 16),
          b: parseInt(hex[2] + hex[2], 16),
          a: 1,
        };
      }
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    return null;
  }

  function _softenCssColor(color, opts) {
    const parsed = _parseCssColorToRgba(color);
    if (!parsed) return String(color || 'rgba(153,153,153,0.6)');
    const o = (opts && typeof opts === 'object') ? opts : {};
    const mixWhite = Math.max(0, Math.min(1, Number(o.mixWhite) || 0));
    const darken = Math.max(0, Math.min(1, Number(o.darken) || 0));
    const alpha = Math.max(0, Math.min(1, o.alpha === undefined ? parsed.a : Number(o.alpha)));
    const mix = (v) => {
      const washed = v + (255 - v) * mixWhite;
      return Math.max(0, Math.min(255, Math.round(washed * (1 - darken))));
    };
    return `rgba(${mix(parsed.r)},${mix(parsed.g)},${mix(parsed.b)},${alpha})`;
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

  function renderWeatherIcon(ctx, cx, topY, cls, size = 18) {
    const img = preloadWeatherBitmap(cls);
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

  function _routeWeatherChevronCount(speedMs) {
    const speed = Number(speedMs);
    if (!Number.isFinite(speed) || speed <= 0.75) return 0;
    if (speed < 3.5) return 1;
    if (speed < 7.0) return 2;
    return 3;
  }

  function _routeEffectiveChevronCount(effWindMs) {
    const eff = Math.abs(Number(effWindMs));
    if (!Number.isFinite(eff) || eff < 2.0) return 0;
    if (eff < 4.5) return 1;
    if (eff < 7.0) return 2;
    return 3;
  }

  function _routeWeatherChevronSvg(count) {
    const n = Math.max(0, Math.min(3, Math.round(Number(count) || 0)));
    if (!n) return '';
    const paths = [];
    const spacing = 6;
    const center = 12;
    for (let i = 0; i < n; i++) {
      const offset = Math.round((i - (n - 1) / 2) * spacing);
      const x = center + offset;
      paths.push(`<path d="M${x - 3.5} 2 L${x + 3.5} 6 L${x - 3.5} 10" />`);
    }
    return [
      '<svg width="24" height="12" viewBox="0 0 24 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
      '<g fill="none" stroke="rgba(245,242,235,0.96)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">',
      paths.join(''),
      '</g>',
      '<g fill="none" stroke="rgba(80,80,80,0.9)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">',
      paths.join(''),
      '</g>',
      '</svg>'
    ].join('');
  }

  function _tourRouteTangentDeg(dkm) {
    try {
      const sd = Array.isArray(LAST_PROFILE && LAST_PROFILE.sampled_dist_km) ? LAST_PROFILE.sampled_dist_km : [];
      const sh = Array.isArray(LAST_PROFILE && LAST_PROFILE.sampled_heading_deg) ? LAST_PROFILE.sampled_heading_deg : [];
      if (sd.length && sh.length === sd.length) {
        const xRoute = Number(dkm);
        if (!Number.isFinite(xRoute)) return 0;
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
        const heading = Number(sh[Math.max(0, Math.min(sh.length - 1, lo))] || 0);
        if (Number.isFinite(heading)) return heading;
      }
    } catch (_) {}
    try {
      const line = Array.isArray(ROUTE_COORDS) ? ROUTE_COORDS : null;
      const dists = Array.isArray(ROUTE_CUM_DISTS) ? ROUTE_CUM_DISTS : null;
      const d = Number(dkm);
      if (!line || !dists || line.length < 2 || dists.length !== line.length || !Number.isFinite(d)) return 0;
      let lo = 0, hi = dists.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (Number(dists[mid]) <= d) lo = mid; else hi = mid - 1;
      }
      const i0 = Math.max(0, Math.min(line.length - 2, lo));
      const a = line[i0];
      const b = line[i0 + 1];
      if (!Array.isArray(a) || !Array.isArray(b)) return 0;
      const dx = Number(b[0]) - Number(a[0]);
      const dy = Number(b[1]) - Number(a[1]);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
      return Math.atan2(dy, dx) * 180 / Math.PI;
    } catch (_) {
      return 0;
    }
  }

  function _routeStationMarkerHtml(props) {
    const rainProb = (props && props.rain_probability !== undefined) ? Number(props.rain_probability) : Number(props && props.rainProb);
    const temp = (props && props.temp_day_median !== undefined)
      ? Number(props.temp_day_median)
      : (props && props.temp_hist_median !== undefined)
        ? Number(props.temp_hist_median)
        : (props && props.temperature_c !== undefined)
          ? Number(props.temperature_c)
          : null;
    const tempLabel = Number.isFinite(temp) ? `${Math.round(temp)}°` : '';
    const iconClass = mapWeatherByProb(rainProb);
    const iconSrc = `/assets/glyphs/weather/weather_${encodeURIComponent(String(iconClass || 'cloudy'))}.png`;
    const rainValue = (props && props.rain_typical_mm !== undefined)
      ? Number(props.rain_typical_mm)
      : (props && props.precipitation_mm !== undefined)
        ? Number(props.precipitation_mm)
        : null;
    const rainLabel = Number.isFinite(rainValue) ? `${fmt(rainValue, 0)} mm` : '';
    const dateLabel = (() => {
      try {
        if (props && props.date) return _fmtIsoDayMonthCompact(String(props.date));
      } catch (_) {}
      return '';
    })();
    const lucky = (props && typeof props.lucky === 'boolean') ? props.lucky : null;
    return (
      `<div data-wm-route-card="1" style="width:40px;height:52px;display:flex;align-items:center;justify-content:center;overflow:visible;">`
        + `<div style="position:relative;width:48px;height:62px;transform:scale(0.8);transform-origin:center center;border-radius:11px;background:rgba(255,255,255,0.58);border:1px solid rgba(148,163,184,0.18);box-shadow:0 4px 10px rgba(15,23,42,0.06);backdrop-filter:blur(1.5px);">`
          + (typeof lucky === 'boolean'
            ? `<span style="position:absolute;left:50%;top:6px;width:8px;height:8px;border-radius:999px;transform:translateX(-50%);background:${lucky ? '#47d764' : '#b3b3b3'};border:1.2px solid ${lucky ? 'rgba(20,126,56,0.95)' : 'rgba(120,132,145,0.72)'};"></span>`
            : '')
          + (tempLabel
            ? `<div style="position:absolute;left:0;right:0;top:14px;text-align:center;font:600 12px/1 system-ui,-apple-system,sans-serif;color:#0f172a;">${tempLabel}</div>`
            : '')
          + `<img src="${iconSrc}" alt="" width="20" height="20" style="position:absolute;left:50%;top:24px;width:20px;height:20px;transform:translateX(-50%);object-fit:contain;" />`
          + (rainLabel
            ? `<div style="position:absolute;left:0;right:0;top:45px;text-align:center;font:500 9px/1 system-ui,-apple-system,sans-serif;color:#64748b;">${rainLabel}</div>`
            : '')
          + (dateLabel
            ? `<div style="position:absolute;left:0;right:0;top:54px;text-align:center;font:500 10px/1 system-ui,-apple-system,sans-serif;color:#64748b;">${dateLabel}</div>`
            : '')
        + `</div>`
      + `</div>`
    );
  }

  function _createRouteStationIcon(props) {
    const html = _routeStationMarkerHtml(props);
    return L.divIcon({ html, className: 'glyph-map', iconSize: [40, 52], iconAnchor: [20, 26] });
  }

  function _routeStationWindMarkerHtml(props) {
    try {
      const effWind = _tourEffectiveWind({
        windSpeed: props && props.wind_speed_ms,
        windDir: props && props.wind_dir_deg,
      }, Number(props && props.distance_from_start_km));
      const chevronCount = _routeEffectiveChevronCount(effWind);
      if (!chevronCount) return '<div data-wm-route-wind="0"></div>';
      const routeAngle = _tourRouteTangentDeg(Number(props && props.distance_from_start_km));
      const flip = Number.isFinite(effWind) && effWind < 0;
      return (
        `<div data-wm-route-wind="1" style="width:30px;height:18px;display:flex;align-items:center;justify-content:center;opacity:0.92;">`
          + `<div style="display:flex;align-items:center;justify-content:center;width:26px;height:12px;transform:rotate(${routeAngle + (flip ? 180 : 0)}deg);transform-origin:50% 50%;">${_routeWeatherChevronSvg(chevronCount)}</div>`
        + `</div>`
      );
    } catch (_) {
      return '<div data-wm-route-wind="0"></div>';
    }
  }

  function _createRouteWindIcon(props) {
    const html = _routeStationWindMarkerHtml(props);
    return L.divIcon({ html, className: 'glyph-map', iconSize: [30, 18], iconAnchor: [15, 9] });
  }

  function _routeOffsetLatLngPixels(lat, lon, dx, dy) {
    try {
      if (!map || !map.latLngToContainerPoint || !map.containerPointToLatLng) return L.latLng(lat, lon);
      const p = map.latLngToContainerPoint([lat, lon]);
      return map.containerPointToLatLng([Number(p.x) + Number(dx || 0), Number(p.y) + Number(dy || 0)]);
    } catch (_) {
      return L.latLng(lat, lon);
    }
  }

  function _ensureRouteMarkerPane(name, zIndex, pointerEvents) {
    try {
      if (!map) return null;
      let pane = map.getPane && map.getPane(name);
      if (!pane && map.createPane) {
        pane = map.createPane(name);
      }
      if (!pane) return null;
      pane.style.zIndex = String(zIndex);
      if (pointerEvents !== undefined) pane.style.pointerEvents = pointerEvents;
      return pane;
    } catch (_) {
      return null;
    }
  }

  function _routeMarkerLatLng(baseLat, baseLon, offset) {
    try {
      const lat = Number(baseLat);
      const lon = Number(baseLon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [baseLat, baseLon];
      if (!offset || !Number.isFinite(Number(offset.dx)) || !Number.isFinite(Number(offset.dy))) return [lat, lon];
      const shifted = _routeOffsetLatLngPixels(lat, lon, Number(offset.dx), Number(offset.dy));
      if (shifted && Number.isFinite(Number(shifted.lat)) && Number.isFinite(Number(shifted.lng))) return shifted;
      return [lat, lon];
    } catch (_) {
      return [baseLat, baseLon];
    }
  }

  function _ensureTourRouteDayCardTooltipStyles() {
    try {
      if (typeof document === 'undefined') return;
      if (document.getElementById('wm-tour-day-card-tooltip-style')) return;
      const style = document.createElement('style');
      style.id = 'wm-tour-day-card-tooltip-style';
      style.textContent = [
        '.wm-tour-day-card-tooltip {',
        '  background: transparent;',
        '  border: 0;',
        '  box-shadow: none;',
        '  padding: 0;',
        '  margin: 0;',
        '}',
        '.wm-tour-day-card-tooltip::before {',
        '  display: none;',
        '}',
        '.wm-tour-day-card-tooltip .leaflet-tooltip-content {',
        '  margin: 0;',
        '  padding: 0;',
        '  background: transparent;',
        '}',
      ].join('\n');
      document.head.appendChild(style);
    } catch (_) {}
  }

  function _refreshTourRouteMarkerIcons(layerGroup) {
    try {
      if (!layerGroup || !layerGroup.eachLayer) return;
      layerGroup.eachLayer((layer) => {
        try {
          if (!layer || !layer.setIcon) return;
          if (layer._wmRouteCardProps) {
            layer.setIcon(_createRouteStationIcon(layer._wmRouteCardProps));
            return;
          }
          if (layer._wmRouteWindProps) {
            layer.setIcon(_createRouteWindIcon(layer._wmRouteWindProps));
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  function _clearTourRouteDayCards() {
    try {
      if (routeDayCardLayer && map) map.removeLayer(routeDayCardLayer);
    } catch (_) {}
    routeDayCardLayer = null;
    try {
      if (_tourDayCardsZoomHandler && map) map.off('zoomend', _tourDayCardsZoomHandler);
    } catch (_) {}
    _tourDayCardsZoomHandler = null;
  }

  function _tourRouteDayCardHtml(data) {
    const info = (data && typeof data === 'object') ? data : {};
    const lucky = (typeof info.lucky === 'boolean') ? info.lucky : null;
    const tempLabel = Number.isFinite(Number(info.tempC)) ? `${Math.round(Number(info.tempC))}°` : '';
    const rainLabel = Number.isFinite(Number(info.rainMm)) ? `${fmt(Number(info.rainMm), 0)} mm` : '';
    const dateLabel = String(info.dateLabel || '');
    const iconClass = String(info.iconClass || 'cloudy');
    const iconSrc = `/assets/glyphs/weather/weather_${encodeURIComponent(iconClass)}.png`;
    return (
      `<div data-wm-route-card="1" style="width:40px;height:52px;display:flex;align-items:center;justify-content:center;overflow:visible;">`
        + `<div style="position:relative;width:48px;height:62px;transform:scale(0.8);transform-origin:center center;border-radius:11px;background:rgba(255,255,255,0.52);border:1px solid rgba(148,163,184,0.22);box-shadow:0 4px 10px rgba(15,23,42,0.06);backdrop-filter:blur(1.5px);">`
          + (typeof lucky === 'boolean'
            ? `<span style="position:absolute;left:50%;top:6px;width:8px;height:8px;border-radius:999px;transform:translateX(-50%);background:${lucky ? '#47d764' : '#b3b3b3'};border:1.2px solid ${lucky ? 'rgba(20,126,56,0.95)' : 'rgba(120,132,145,0.72)'};"></span>`
            : '')
          + (tempLabel
            ? `<div style="position:absolute;left:0;right:0;top:14px;text-align:center;font:600 12px/1 system-ui,-apple-system,sans-serif;color:#0f172a;">${tempLabel}</div>`
            : '')
          + `<img src="${iconSrc}" alt="" width="20" height="20" style="position:absolute;left:50%;top:24px;width:20px;height:20px;transform:translateX(-50%);object-fit:contain;display:block;" />`
          + (rainLabel
            ? `<div style="position:absolute;left:0;right:0;top:45px;text-align:center;font:500 9px/1 system-ui,-apple-system,sans-serif;color:#64748b;">${rainLabel}</div>`
            : '')
          + (dateLabel
            ? `<div style="position:absolute;left:0;right:0;top:54px;text-align:center;font:500 10px/1 system-ui,-apple-system,sans-serif;color:#64748b;">${dateLabel}</div>`
            : '')
        + `</div>`
      + `</div>`
    );
  }

  function _createTourRouteDayCardIcon(data) {
    return L.divIcon({ html: _tourRouteDayCardHtml(data), className: 'glyph-map', iconSize: [40, 52], iconAnchor: [20, 26] });
  }

  function _tourRouteDayCardDateLabel(dayIdx) {
    try {
      const startIso = (startDateInput && startDateInput.value) ? String(startDateInput.value) : '';
      if (!startIso) return '';
      const d = new Date(`${startIso}T00:00:00Z`);
      if (!Number.isFinite(d.getTime())) return '';
      d.setUTCDate(d.getUTCDate() + Number(dayIdx || 0));
      return _fmtIsoDayMonthCompact(d.toISOString().slice(0, 10));
    } catch (_) {
      return '';
    }
  }

  function _tourRouteDayCardEntries(profile) {
    try {
      const p = profile || LAST_PROFILE;
      if (!p) return [];
      const bounds = Array.isArray(p.day_boundaries) ? p.day_boundaries : [];
      const points = Array.isArray(OVERLAY_POINTS) ? OVERLAY_POINTS : [];
      const sampledDist = Array.isArray(p.sampled_dist_km) ? p.sampled_dist_km : [];
      const profileLen = Number(sampledDist.length ? sampledDist[sampledDist.length - 1] : 0);
      const requestedDays = Math.max(1, Math.round(Number(tourDaysInput && tourDaysInput.value) || (bounds.length + 1) || 1));
      const axisLen = (() => {
        try {
          if (Array.isArray(ROUTE_CUM_DISTS) && ROUTE_CUM_DISTS.length >= 2) {
            const routeLen = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
            if (Number.isFinite(routeLen) && routeLen > 0) return routeLen;
          }
        } catch (_) {}
        const fallbackLen = Number(p.total_distance_km || p.distance_km || profileLen || 0);
        return Number.isFinite(fallbackLen) && fallbackLen > 0 ? fallbackLen : 0;
      })();
      if (!(axisLen > 0)) return [];
      const marks = bounds
        .map((b) => Number(b && b.distance_km))
        .filter((v) => Number.isFinite(v) && v > 0 && v < axisLen)
        .sort((a, b) => a - b);
      const out = [];
      for (let dayIdx = 0; dayIdx < requestedDays; dayIdx++) {
        const fallbackStartDist = (axisLen * dayIdx) / requestedDays;
        const fallbackEndDist = (axisLen * (dayIdx + 1)) / requestedDays;
        const startDist = dayIdx === 0 ? 0 : (Number.isFinite(Number(marks[dayIdx - 1])) ? Number(marks[dayIdx - 1]) : fallbackStartDist);
        const endDist = dayIdx < marks.length ? Number(marks[dayIdx]) : fallbackEndDist;
        const midDist = startDist + Math.max(0, endDist - startDist) * 0.5;
        let dayPoints = points.filter((point) => Number(point && point.tourDayIndex) === dayIdx);
        if (!dayPoints.length) {
          dayPoints = points.filter((point) => {
            const dkm = Number(point && point.dist);
            return Number.isFinite(dkm) && dkm >= startDist && dkm < endDist;
          });
        }
        const daySummary = _tourSummarizeDayPoints(dayPoints);
        const sample = _tourSampleAtDist(midDist);
        const sampleTemp = Number.isFinite(Number(sample && sample.temp_day_median))
          ? Number(sample.temp_day_median)
          : Number.isFinite(Number(sample && sample.temperature))
            ? Number(sample.temperature)
            : Number.isFinite(Number(sample && sample.temp_hist_median))
              ? Number(sample.temp_hist_median)
              : null;
        const rainProb = Number.isFinite(Number(daySummary && daySummary.rainProb))
          ? Number(daySummary.rainProb)
          : Number(sample && sample.rainProb);
        out.push({
          dayIdx,
          distKm: midDist,
          dateLabel: _tourRouteDayCardDateLabel(dayIdx),
          tempC: Number.isFinite(Number(daySummary && daySummary.tempMedian))
            ? Number(daySummary.tempMedian)
            : sampleTemp,
          rainMm: Number.isFinite(Number(daySummary && daySummary.precipSum))
            ? Number(daySummary.precipSum)
            : Number.isFinite(Number(sample && sample.rainTypical))
              ? Number(sample.rainTypical)
              : null,
          rainProb,
          iconClass: mapWeatherByProb(rainProb),
          lucky: (daySummary && typeof daySummary.lucky === 'boolean') ? daySummary.lucky : null,
        });
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  function _renderTourRouteDayCards(profile) {
    try {
      _clearTourRouteDayCards();
      if (!_tourIsActive() || !map) return;
      _ensureTourRouteDayCardTooltipStyles();
      const entries = _tourRouteDayCardEntries(profile);
      if (!entries.length) return;
      _ensureRouteMarkerPane('wmRouteLabelPane', 650, 'auto');
      routeDayCardLayer = L.layerGroup().addTo(map);
      // Card visible size after scale(0.8): inner 48×62 → ~38×50px; half-diagonal ≈ 32px.
      // Route line is ~4px half-width. Use 42px perpendicular offset for comfortable clearance.
      const OFFSET_PX = 42;
      let mapBounds = null;
      try { mapBounds = map.getBounds(); } catch (_) {}
      for (const entry of entries) {
        const baseLatLng = routeLatLngAtDistanceKm(entry.distKm);
        if (!baseLatLng) continue;
        // Try preferred side (up=true = left/north of route direction), fall back to
        // the opposite side only when the preferred position is outside the viewport.
        let chosenLatLng = null;
        for (const preferUp of [true, false]) {
          const offset = _routeNormalOffsetPx(entry.distKm, OFFSET_PX, preferUp);
          const candidate = _routeMarkerLatLng(baseLatLng.lat, baseLatLng.lng, offset);
          if (!candidate) continue;
          if (!chosenLatLng) chosenLatLng = candidate; // keep as best-so-far
          if (!mapBounds) break; // no viewport info — take first
          try {
            const ll = Array.isArray(candidate)
              ? L.latLng(candidate[0], candidate[1])
              : candidate;
            if (mapBounds.contains(ll)) { chosenLatLng = candidate; break; }
          } catch (_) {}
        }
        if (!chosenLatLng) continue;
        const anchor = L.marker(chosenLatLng, {
          opacity: 0,
          pane: 'wmRouteLabelPane',
          interactive: false,
          keyboard: false,
          zIndexOffset: 260,
        });
        anchor.bindTooltip(_tourRouteDayCardHtml(entry), {
          permanent: true,
          direction: 'center',
          offset: L.point(0, 0),
          className: 'wm-tour-day-card-tooltip',
          opacity: 1,
          interactive: false,
          pane: 'wmRouteLabelPane',
        });
        routeDayCardLayer.addLayer(anchor);
      }
      // Re-render on zoom so pixel offsets stay geometrically correct.
      _tourDayCardsZoomHandler = () => {
        try { if (_tourIsActive()) _renderTourRouteDayCards(LAST_PROFILE); } catch (_) {}
      };
      try { map.on('zoomend', _tourDayCardsZoomHandler); } catch (_) {}
    } catch (_) {}
  }

  function _routeNormalOffsetPx(dkm, magnitudePx, preferUpward = true) {
    try {
      const angleRad = (_tourRouteTangentDeg(Number(dkm || 0)) || 0) * Math.PI / 180;
      let nx = -Math.sin(angleRad);
      let ny = Math.cos(angleRad);
      if (preferUpward && ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      return {
        dx: nx * Number(magnitudePx || 0),
        dy: ny * Number(magnitudePx || 0),
      };
    } catch (_) {
      return { dx: 0, dy: -Math.abs(Number(magnitudePx || 0)) };
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

  const SETTINGS_STORAGE_KEY = 'touracle_settings';
  const SETTINGS_STORAGE_VERSION = 1;
  const LEGACY_SETTINGS_STORAGE_KEY = 'wm_settings';

  function _defaultSettings() {
    const nowYear = (new Date()).getFullYear();
    const defaultLastYear = Math.max(1970, nowYear - 1);
    const todayIso = (new Date()).toISOString().slice(0, 10);
    return {
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
      useClassicWeatherIcons: false,
      glyphType: 'svg',
      weatherVisualizationMode: 'glyphs',
      overlayMode: 'temperature',
      liveUpdates: true,
      // Strategic/tactical settings (Phase 1: persisted but not yet fully used)
      strategicYear: 2025,
      // Phase 3: multi-year + explicit mode switch (active vs 24h)
      strategicYears: [2025],
      strategicMode: 'active',
      climateTimescale: 'daily',
      includeSea: false,
      interpolation: true,
      strategicWindOn: false,
      strategicWindMode: 'flow',
      windDensity: 40,
      animSpeed: 1.0,
      gridKm: 50,
      activeHours: '10-18',
      windWeighting: 'relative',
    };
  }

  function _coerceSettings(raw, defaultsIn) {
    const defaults = defaultsIn || _defaultSettings();
    try {
      const j = (raw && typeof raw === 'object') ? raw : {};
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

      const _sanitizeYears = (v, fallbackYear) => {
        try {
          const arr = Array.isArray(v) ? v : [];
          const years = arr
            .map(x => Math.round(Number(x)))
            .filter(y => Number.isFinite(y) && y >= 1970 && y <= 2100);
          const uniq = Array.from(new Set(years));
          uniq.sort((a, b) => b - a);
          if (uniq.length) return uniq;
        } catch (_) {}
        const fy = Math.round(Number(fallbackYear));
        return (Number.isFinite(fy) && fy >= 1970 && fy <= 2100) ? [fy] : [defaults.strategicYear];
      };

      const strategicModeRaw = (typeof j.strategicMode === 'string') ? String(j.strategicMode) : ((typeof j.mode === 'string') ? String(j.mode) : defaults.strategicMode);
      const strategicMode = (strategicModeRaw === 'full_day' || strategicModeRaw === '24h' || strategicModeRaw === 'day')
        ? 'full_day'
        : 'active';

      const loadedStrategicYear = Number(j.strategicYear) || defaults.strategicYear;
      const strategicYears = _sanitizeYears(j.strategicYears, loadedStrategicYear);
      const primaryStrategicYear = Math.round(Number(strategicYears[0] || loadedStrategicYear || defaults.strategicYear));
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
        glyphType: 'svg',
        useClassicWeatherIcons: false,
        weatherVisualizationMode: 'glyphs',
        overlayMode: _normalizeOverlayMode((typeof j.overlayMode === 'string') ? j.overlayMode : defaults.overlayMode),
        liveUpdates: (typeof j.liveUpdates === 'boolean') ? j.liveUpdates : defaults.liveUpdates,
        strategicYear: primaryStrategicYear,
        strategicYears,
        strategicMode,
        climateTimescale: (typeof j.climateTimescale === 'string')
          ? j.climateTimescale
          : ((typeof j.climate_timescale === 'string') ? j.climate_timescale : defaults.climateTimescale),
        includeSea: (typeof j.includeSea === 'boolean') ? j.includeSea : defaults.includeSea,
        interpolation: (typeof j.interpolation === 'boolean') ? j.interpolation : defaults.interpolation,
        strategicWindOn: (typeof j.strategicWindOn === 'boolean') ? j.strategicWindOn : defaults.strategicWindOn,
        strategicWindMode: (typeof j.strategicWindMode === 'string') ? j.strategicWindMode : defaults.strategicWindMode,
        windDensity: Number(j.windDensity) || defaults.windDensity,
        animSpeed: Number(j.animSpeed) || defaults.animSpeed,
        gridKm: Number(j.gridKm) || defaults.gridKm,
        activeHours: (typeof j.activeHours === 'string')
          ? j.activeHours
          : ((typeof j.rideHours === 'string') ? j.rideHours : defaults.activeHours),
        windWeighting: (typeof j.windWeighting === 'string') ? j.windWeighting : defaults.windWeighting,
      };
    } catch {
      return defaults;
    }
  }

  function _readSavedSettingsData() {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Number(parsed.version) === SETTINGS_STORAGE_VERSION && parsed.data && typeof parsed.data === 'object') {
          return parsed.data;
        }
      }
    } catch (e) {
      try { console.warn('Failed to load settings', e); } catch (_) {}
    }
    try {
      const rawLegacy = localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
      if (!rawLegacy) return null;
      const parsedLegacy = JSON.parse(rawLegacy);
      return (parsedLegacy && typeof parsedLegacy === 'object') ? parsedLegacy : null;
    } catch (e) {
      try { console.warn('Failed to load legacy settings', e); } catch (_) {}
      return null;
    }
  }

  function loadSavedSettings() {
    const defaults = _defaultSettings();
    const savedData = _readSavedSettingsData();
    if (!savedData) return null;
    return _coerceSettings(savedData, defaults);
  }

  // Settings persistence
  function loadSettings() {
    return loadSavedSettings() || _defaultSettings();
  }

  function saveSettings(vals) {
    const snapshot = _coerceSettings((vals && typeof vals === 'object') ? vals : (SETTINGS || {}), _defaultSettings());
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
        version: SETTINGS_STORAGE_VERSION,
        data: snapshot,
      }));
      return true;
    } catch (e) {
      try { console.warn('Failed to save settings', e); } catch (_) {}
      return false;
    }
  }

  let SETTINGS = loadSettings();
  try {
    if (!localStorage.getItem(SETTINGS_STORAGE_KEY) && localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY)) {
      saveSettings(SETTINGS);
    }
  } catch (_) {}
  // Tour route markers are fixed to the SVG weather-icon style.
  SETTINGS.useClassicWeatherIcons = false;
  SETTINGS.glyphType = 'svg';
  SETTINGS.weatherVisualizationMode = 'glyphs';
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

  function _getActiveHoursValue(source) {
    if (source && typeof source.activeHours === 'string' && source.activeHours) return String(source.activeHours);
    if (source && typeof source.rideHours === 'string' && source.rideHours) return String(source.rideHours);
    return '10-18';
  }

  function _parseActiveHoursRange(raw) {
    const txt = String(raw || '').trim();
    const match = txt.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    let start = match ? Number(match[1]) : 10;
    let end = match ? Number(match[2]) : 18;
    if (!Number.isFinite(start)) start = 10;
    if (!Number.isFinite(end)) end = 18;
    start = Math.max(0, Math.min(23, Math.round(start)));
    end = Math.max(0, Math.min(23, Math.round(end)));
    if (end < start) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    if (end - start < 1) {
      if (start >= 23) {
        start = 22;
        end = 23;
      } else {
        end = Math.min(23, start + 1);
      }
    }
    return { start, end };
  }

  function _formatActiveHoursRange(start, end) {
    const s = Math.max(0, Math.min(23, Math.round(Number(start) || 10)));
    const e = Math.max(0, Math.min(23, Math.round(Number(end) || 18)));
    const a = Math.min(s, e);
    let b = Math.max(s, e);
    if (b - a < 1) b = Math.min(23, a + 1);
    return `${a}-${b}`;
  }

  function _syncActiveHourInputs(source) {
    try {
      const currentStart = Number(setActiveHourStart && setActiveHourStart.value);
      const currentEnd = Number(setActiveHourEnd && setActiveHourEnd.value);
      let start = Number.isFinite(currentStart) ? currentStart : _parseActiveHoursRange(_getActiveHoursValue(SETTINGS)).start;
      let end = Number.isFinite(currentEnd) ? currentEnd : _parseActiveHoursRange(_getActiveHoursValue(SETTINGS)).end;
      if (source === setActiveHourStart) start = Number(setActiveHourStart && setActiveHourStart.value);
      if (source === setActiveHourEnd) end = Number(setActiveHourEnd && setActiveHourEnd.value);
      const next = _parseActiveHoursRange(_formatActiveHoursRange(start, end));
      if (setActiveHourStart && setActiveHourStart !== source) setActiveHourStart.value = String(next.start);
      if (setActiveHourEnd && setActiveHourEnd !== source) setActiveHourEnd.value = String(next.end);
      if (source === setActiveHourStart && setActiveHourStart) setActiveHourStart.value = String(next.start);
      if (source === setActiveHourEnd && setActiveHourEnd) setActiveHourEnd.value = String(next.end);
    } catch (_) {}
  }

  const SETTINGS_LIVE_APPLY_DEBOUNCE_MS = 200;
  const SETTINGS_REFETCH_KEYS = [
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
    'activeHours',
  ];
  let _settingsLiveApplyTimer = null;
  let _settingsLiveStatusTimer = null;
  let _settingsManualDirty = false;
  const TEMP_SLIDER_LOW_RANGE = 40;
  const TEMP_SLIDER_MID_RANGE = 30;
  const TEMP_SLIDER_HIGH_RANGE = 30;
  const TEMP_SLIDER_LOW_PCT = 25;
  const TEMP_SLIDER_MID_PCT = 75;

  function _settingsLiveEnabled() {
    return !(SETTINGS && SETTINGS.liveUpdates === false);
  }

  function _updateSettingsLiveStatus(text, state) {
    if (!settingsLiveStatus) return;
    settingsLiveStatus.dataset.state = String(state || 'idle');
    const msg = String(text || 'Live updates enabled');
    settingsLiveStatus.setAttribute('aria-label', msg);
    settingsLiveStatus.title = msg;
    settingsLiveStatus.setAttribute('aria-pressed', _settingsLiveEnabled() ? 'true' : 'false');
    if (settingsLiveStatusText) settingsLiveStatusText.textContent = msg;
  }

  function _setSettingsLiveEnabled(enabled, opts) {
    const options = (opts && typeof opts === 'object') ? opts : {};
    if (!SETTINGS) SETTINGS = loadSettings();
    SETTINGS.liveUpdates = Boolean(enabled);
    if (options.persist !== false) {
      try { saveSettings(SETTINGS); } catch (_) {}
    }
    if (enabled) {
      _settingsManualDirty = false;
      _updateSettingsLiveStatus('Live updates on', 'idle');
    } else {
      _updateSettingsLiveStatus('Manual apply', 'paused');
    }
  }

  function _markSettingsPending() {
    if (!_settingsLiveEnabled()) {
      _settingsManualDirty = true;
      _updateSettingsLiveStatus('Apply changes', 'pending');
      if (_settingsLiveApplyTimer) {
        try { clearTimeout(_settingsLiveApplyTimer); } catch (_) {}
        _settingsLiveApplyTimer = null;
      }
      return;
    }
    _updateSettingsLiveStatus('Updating after you stop dragging', 'pending');
    if (_settingsLiveStatusTimer) {
      try { clearTimeout(_settingsLiveStatusTimer); } catch (_) {}
      _settingsLiveStatusTimer = null;
    }
  }

  function _markSettingsSaved() {
    _settingsManualDirty = false;
    if (!_settingsLiveEnabled()) {
      _updateSettingsLiveStatus('Manual apply', 'paused');
      return;
    }
    _updateSettingsLiveStatus('Updated', 'saved');
    if (_settingsLiveStatusTimer) {
      try { clearTimeout(_settingsLiveStatusTimer); } catch (_) {}
    }
    _settingsLiveStatusTimer = setTimeout(() => {
      _updateSettingsLiveStatus('Live updates on', 'idle');
    }, 1200);
  }

  function _restoreSettingsLiveStatus() {
    if (_settingsManualDirty) {
      _updateSettingsLiveStatus('Apply changes', 'pending');
      return;
    }
    if (_settingsLiveEnabled()) {
      _updateSettingsLiveStatus('Live updates on', 'idle');
      return;
    }
    _updateSettingsLiveStatus('Manual apply', 'paused');
  }

  function _flashSettingsStatus(text, state, durationMs) {
    _updateSettingsLiveStatus(text, state);
    if (_settingsLiveStatusTimer) {
      try { clearTimeout(_settingsLiveStatusTimer); } catch (_) {}
    }
    _settingsLiveStatusTimer = setTimeout(() => {
      _restoreSettingsLiveStatus();
    }, Math.max(600, Number(durationMs) || 1400));
  }

  function _settingInputMin(input) {
    const n = Number(input && input.min);
    return Number.isFinite(n) ? n : 0;
  }

  function _settingInputMax(input) {
    const n = Number(input && input.max);
    return Number.isFinite(n) ? n : 100;
  }

  function _settingInputStep(input) {
    const n = Number(input && input.step);
    return (Number.isFinite(n) && n > 0) ? n : 1;
  }

  function _settingDomainMin(input) {
    if (input && input.dataset && input.dataset.scale === 'temp-nonlinear') {
      return Number.isFinite(Number(input.dataset.domainMin)) ? Number(input.dataset.domainMin) : -40;
    }
    return _settingInputMin(input);
  }

  function _settingDomainMax(input) {
    if (input && input.dataset && input.dataset.scale === 'temp-nonlinear') {
      return Number.isFinite(Number(input.dataset.domainMax)) ? Number(input.dataset.domainMax) : 60;
    }
    return _settingInputMax(input);
  }

  function _tempDomainToSliderValue(domainValue) {
    let v = Number(domainValue);
    if (!Number.isFinite(v)) v = 0;
    v = Math.max(-40, Math.min(60, v));
    if (v <= 0) return ((v + TEMP_SLIDER_LOW_RANGE) / TEMP_SLIDER_LOW_RANGE) * TEMP_SLIDER_LOW_PCT;
    if (v <= 30) return TEMP_SLIDER_LOW_PCT + (v / TEMP_SLIDER_MID_RANGE) * (TEMP_SLIDER_MID_PCT - TEMP_SLIDER_LOW_PCT);
    return TEMP_SLIDER_MID_PCT + ((v - 30) / TEMP_SLIDER_HIGH_RANGE) * (100 - TEMP_SLIDER_MID_PCT);
  }

  function _tempSliderToDomainValue(sliderValue) {
    let p = Number(sliderValue);
    if (!Number.isFinite(p)) p = TEMP_SLIDER_LOW_PCT;
    p = Math.max(0, Math.min(100, p));
    if (p <= TEMP_SLIDER_LOW_PCT) return -40 + (p / TEMP_SLIDER_LOW_PCT) * TEMP_SLIDER_LOW_RANGE;
    if (p <= TEMP_SLIDER_MID_PCT) return ((p - TEMP_SLIDER_LOW_PCT) / (TEMP_SLIDER_MID_PCT - TEMP_SLIDER_LOW_PCT)) * TEMP_SLIDER_MID_RANGE;
    return 30 + ((p - TEMP_SLIDER_MID_PCT) / (100 - TEMP_SLIDER_MID_PCT)) * TEMP_SLIDER_HIGH_RANGE;
  }

  function _sliderRawToDomainValue(input, rawValue) {
    if (input && input.dataset && input.dataset.scale === 'temp-nonlinear') {
      return _tempSliderToDomainValue(rawValue);
    }
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : Number(input && input.value);
  }

  function _domainValueToSliderRaw(input, domainValue) {
    if (input && input.dataset && input.dataset.scale === 'temp-nonlinear') {
      return _tempDomainToSliderValue(domainValue);
    }
    return Number(domainValue);
  }

  function _clampSettingsValue(input, rawValue) {
    const min = _settingInputMin(input);
    const max = _settingInputMax(input);
    let value = Number(rawValue);
    if (!Number.isFinite(value)) value = Number(input && input.value);
    if (!Number.isFinite(value)) value = min;
    value = Math.max(min, Math.min(max, value));

    const snap = String(input && input.dataset && input.dataset.snap || '');
    if (snap === 'rain') {
      if (value <= 2) value = Math.round(value / 0.5) * 0.5;
      else if (value <= 10) value = Math.round(value);
      else if (value <= 20) value = Math.round(value / 2) * 2;
      else value = Math.round(value / 5) * 5;
    } else if (snap === 'wind' || snap === 'int') {
      value = Math.round(value);
    } else {
      const step = _settingInputStep(input);
      const base = min;
      value = base + Math.round((value - base) / step) * step;
    }

    value = Math.max(min, Math.min(max, value));
    const decimals = Math.max(0, (String(_settingInputStep(input)).split('.')[1] || '').length);
    return Number(value.toFixed(decimals));
  }

  function _settingValueToPercent(input, rawValue) {
    const min = _settingInputMin(input);
    const max = _settingInputMax(input);
    const value = Number(rawValue);
    const span = Math.max(1e-9, max - min);
    return ((Math.max(min, Math.min(max, value)) - min) / span) * 100;
  }

  function _formatSettingsValue(input, rawValue) {
    const value = _sliderRawToDomainValue(input, _clampSettingsValue(input, rawValue));
    const fmt = String(input && input.dataset && input.dataset.format || '');
    if (fmt === 'hour') return String(Math.round(value)).padStart(2, '0');
    if (fmt === 'temp') return `${Math.round(value)}°C`;
    const decimals = Number(input && input.dataset && input.dataset.decimals);
    const fixed = Number.isFinite(decimals)
      ? value.toFixed(Math.max(0, decimals))
      : ((_settingInputStep(input) < 1)
          ? (Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1))
          : String(Math.round(value)));
    const unit = String(input && input.dataset && input.dataset.unit || '');
    if (!unit) return fixed;
    if (unit === 'x') return `${fixed}${unit}`;
    return `${fixed}${unit}`;
  }

  function _formatMergedRangeValue(input, rawStart, rawEnd) {
    const start = _sliderRawToDomainValue(input, rawStart);
    const end = _sliderRawToDomainValue(input, rawEnd);
    const fmt = String(input && input.dataset && input.dataset.format || '');
    if (fmt === 'hour') return `${String(Math.round(start)).padStart(2, '0')}–${String(Math.round(end)).padStart(2, '0')} h`;
    if (fmt === 'temp') return `${Math.round(start)}–${Math.round(end)}°C`;
    const unit = String(input && input.dataset && input.dataset.unit || '');
    const startTxt = _formatSettingsValue(input, _domainValueToSliderRaw(input, start)).replace(unit, '');
    const endTxt = _formatSettingsValue(input, _domainValueToSliderRaw(input, end)).replace(unit, '');
    return `${startTxt}–${endTxt}${unit}`;
  }

  function _positionSliderElement(el, pct) {
    if (!el) return;
    el.style.left = `${Math.max(0, Math.min(100, pct))}%`;
  }

  function _openSettingsValueEditor(editor, badge, input, applyValue) {
    if (!editor || !badge || !input || typeof applyValue !== 'function') return;
    const left = badge.style.left || `${_settingValueToPercent(input, input.value)}%`;
    editor.min = String(_settingDomainMin(input));
    editor.max = String(_settingDomainMax(input));
    editor.step = (input && input.dataset && input.dataset.scale === 'temp-nonlinear') ? '1' : (input.step || '1');
    editor.value = String(_sliderRawToDomainValue(input, input.value || ''));
    editor.style.left = left;
    editor.style.display = 'inline-flex';
    badge.style.visibility = 'hidden';

    let closed = false;
    const finish = (commit) => {
      if (closed) return;
      closed = true;
      if (commit) applyValue(editor.value);
      editor.style.display = 'none';
      badge.style.visibility = '';
      editor.removeEventListener('keydown', onKeyDown);
      editor.removeEventListener('blur', onBlur);
    };
    const onKeyDown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
      }
    };
    const onBlur = () => finish(true);
    editor.addEventListener('keydown', onKeyDown);
    editor.addEventListener('blur', onBlur);
    try {
      editor.focus({ preventScroll: true });
      editor.select();
    } catch (_) {}
  }

  function _syncSingleSliderField(field) {
    if (!field) return;
    const input = field.querySelector('.wm-slider-native');
    if (!input) return;
    input.value = String(_clampSettingsValue(input, input.value));
    const pct = _settingValueToPercent(input, input.value);
    const fill = field.querySelector('[data-slider-fill]');
    if (fill) fill.style.width = `${pct}%`;
    const badge = field.querySelector('[data-slider-badge]');
    if (badge) {
      badge.textContent = _formatSettingsValue(input, input.value);
      _positionSliderElement(badge, pct);
    }
    const editor = field.querySelector('[data-slider-editor]');
    if (editor && editor.style.display !== 'none' && editor.style.display !== '') {
      _positionSliderElement(editor, pct);
    }
  }

  function _syncRangeSliderField(field, preferredSide) {
    if (!field) return;
    const startInput = field.querySelector('[data-range-role="start"]');
    const endInput = field.querySelector('[data-range-role="end"]');
    if (!startInput || !endInput) return;
    let start = _clampSettingsValue(startInput, startInput.value);
    let end = _clampSettingsValue(endInput, endInput.value);
    if (start > end) {
      if (preferredSide === 'start') end = start;
      else start = end;
    }
    startInput.value = String(start);
    endInput.value = String(end);
    const startPct = _settingValueToPercent(startInput, start);
    const endPct = _settingValueToPercent(endInput, end);
    const shell = field.querySelector('[data-range-shell]');
    const mergeBadge = field.querySelector('[data-range-merge-badge]');
    const fill = field.querySelector('[data-slider-fill]');
    if (fill) {
      fill.style.left = `${startPct}%`;
      fill.style.width = `${Math.max(0, endPct - startPct)}%`;
    }
    const startThumb = field.querySelector('[data-range-thumb="start"]');
    const endThumb = field.querySelector('[data-range-thumb="end"]');
    _positionSliderElement(startThumb, startPct);
    _positionSliderElement(endThumb, endPct);
    const startBadge = field.querySelector('[data-range-badge="start"]');
    const endBadge = field.querySelector('[data-range-badge="end"]');
    if (startBadge) {
      startBadge.textContent = _formatSettingsValue(startInput, start);
      _positionSliderElement(startBadge, startPct);
    }
    if (endBadge) {
      endBadge.textContent = _formatSettingsValue(endInput, end);
      _positionSliderElement(endBadge, endPct);
    }
    if (mergeBadge) {
      const width = Math.max(1, Number(shell && shell.getBoundingClientRect ? shell.getBoundingClientRect().width : 0) || 220);
      const overlapPx = (Math.abs(endPct - startPct) / 100) * width;
      if (overlapPx < 78) {
        mergeBadge.textContent = _formatMergedRangeValue(startInput, start, end);
        _positionSliderElement(mergeBadge, (startPct + endPct) * 0.5);
        mergeBadge.style.display = 'inline-flex';
        if (startBadge) startBadge.style.visibility = 'hidden';
        if (endBadge) endBadge.style.visibility = 'hidden';
      } else {
        mergeBadge.style.display = 'none';
        if (startBadge && !(field.querySelector('[data-range-editor="start"]') && field.querySelector('[data-range-editor="start"]').style.display === 'inline-flex')) startBadge.style.visibility = '';
        if (endBadge && !(field.querySelector('[data-range-editor="end"]') && field.querySelector('[data-range-editor="end"]').style.display === 'inline-flex')) endBadge.style.visibility = '';
      }
    }
    const startEditor = field.querySelector('[data-range-editor="start"]');
    const endEditor = field.querySelector('[data-range-editor="end"]');
    if (startEditor && startEditor.style.display !== 'none' && startEditor.style.display !== '') _positionSliderElement(startEditor, startPct);
    if (endEditor && endEditor.style.display !== 'none' && endEditor.style.display !== '') _positionSliderElement(endEditor, endPct);
  }

  function _refreshPreferencesUi() {
    try {
      if (!settingsView) return;
      for (const field of Array.from(settingsView.querySelectorAll('[data-slider-field="single"]'))) {
        _syncSingleSliderField(field);
      }
      for (const field of Array.from(settingsView.querySelectorAll('[data-slider-field="range"]'))) {
        _syncRangeSliderField(field);
      }
      _applyComfortWindUiForMode();
    } catch (_) {}
  }

  function _emitInputAndChange(input) {
    if (!input) return;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function _applyRangePair(startInput, endInput, nextStart, nextEnd, preferredSide, emitEvents) {
    if (!startInput || !endInput) return;
    let start = _sliderRawToDomainValue(startInput, nextStart);
    let end = _sliderRawToDomainValue(endInput, nextEnd);
    const minGap = Math.max(0, Number(startInput.dataset.minGap || endInput.dataset.minGap || 0));
    if (start > end) {
      if (preferredSide === 'start') end = start;
      else start = end;
    }
    if (end - start < minGap) {
      if (preferredSide === 'start') {
        start = Math.min(start, _settingDomainMax(startInput) - minGap);
        end = Math.min(_settingDomainMax(endInput), start + minGap);
      } else {
        end = Math.max(end, _settingDomainMin(endInput) + minGap);
        start = Math.max(_settingDomainMin(startInput), end - minGap);
      }
    }
    startInput.value = String(_clampSettingsValue(startInput, _domainValueToSliderRaw(startInput, start)));
    endInput.value = String(_clampSettingsValue(endInput, _domainValueToSliderRaw(endInput, end)));
    const field = startInput.closest('[data-slider-field="range"]');
    _syncRangeSliderField(field, preferredSide);
    if (emitEvents) {
      _emitInputAndChange(startInput);
      _emitInputAndChange(endInput);
    }
  }

  function _scheduleLiveSettingsApply() {
    _markSettingsPending();
    if (!_settingsLiveEnabled()) return;
    if (_settingsLiveApplyTimer) {
      try { clearTimeout(_settingsLiveApplyTimer); } catch (_) {}
    }
    _settingsLiveApplyTimer = setTimeout(() => {
      _settingsLiveApplyTimer = null;
      try { _applySettingsWithRefresh(); } catch (_) {}
      _markSettingsSaved();
    }, SETTINGS_LIVE_APPLY_DEBOUNCE_MS);
  }

  function _initPreferencesSliderUi() {
    if (!settingsView || settingsView.dataset.wmSliderInit === '1') return;

    for (const field of Array.from(settingsView.querySelectorAll('[data-slider-field="single"]'))) {
      const input = field.querySelector('.wm-slider-native');
      const badge = field.querySelector('[data-slider-badge]');
      const editor = field.querySelector('[data-slider-editor]');
      if (!input) continue;
      input.addEventListener('input', () => {
        input.value = String(_clampSettingsValue(input, input.value));
        _syncSingleSliderField(field);
        _scheduleLiveSettingsApply();
      });
      input.addEventListener('change', () => {
        input.value = String(_clampSettingsValue(input, input.value));
        _syncSingleSliderField(field);
        _scheduleLiveSettingsApply();
      });
      if (badge && editor) {
        badge.addEventListener('click', () => {
          _openSettingsValueEditor(editor, badge, input, (raw) => {
            input.value = String(_clampSettingsValue(input, _domainValueToSliderRaw(input, raw)));
            _syncSingleSliderField(field);
            _emitInputAndChange(input);
          });
        });
      }
      _syncSingleSliderField(field);
    }

    for (const field of Array.from(settingsView.querySelectorAll('[data-slider-field="range"]'))) {
      const shell = field.querySelector('[data-range-shell]');
      const startInput = field.querySelector('[data-range-role="start"]');
      const endInput = field.querySelector('[data-range-role="end"]');
      const startThumb = field.querySelector('[data-range-thumb="start"]');
      const endThumb = field.querySelector('[data-range-thumb="end"]');
      const startBadge = field.querySelector('[data-range-badge="start"]');
      const endBadge = field.querySelector('[data-range-badge="end"]');
      const startEditor = field.querySelector('[data-range-editor="start"]');
      const endEditor = field.querySelector('[data-range-editor="end"]');
      if (!shell || !startInput || !endInput) continue;

      startInput.addEventListener('input', () => {
        _applyRangePair(startInput, endInput, startInput.value, endInput.value, 'start', false);
        _scheduleLiveSettingsApply();
      });
      startInput.addEventListener('change', () => {
        _applyRangePair(startInput, endInput, startInput.value, endInput.value, 'start', false);
        _scheduleLiveSettingsApply();
      });
      endInput.addEventListener('input', () => {
        _applyRangePair(startInput, endInput, startInput.value, endInput.value, 'end', false);
        _scheduleLiveSettingsApply();
      });
      endInput.addEventListener('change', () => {
        _applyRangePair(startInput, endInput, startInput.value, endInput.value, 'end', false);
        _scheduleLiveSettingsApply();
      });

      const valueFromClientX = (clientX) => {
        const rect = shell.getBoundingClientRect();
        const width = Math.max(1, rect.width);
        const ratio = Math.max(0, Math.min(1, (Number(clientX) - rect.left) / width));
        const min = _settingInputMin(startInput);
        const max = _settingInputMax(startInput);
        return min + ratio * (max - min);
      };

      let dragSide = '';
      const clearDragUi = () => {
        dragSide = '';
        try { if (startThumb) startThumb.classList.remove('wm-active'); } catch (_) {}
        try { if (endThumb) endThumb.classList.remove('wm-active'); } catch (_) {}
      };
      const setDragUi = (side) => {
        dragSide = side;
        try { if (startThumb) startThumb.classList.toggle('wm-active', side === 'start'); } catch (_) {}
        try { if (endThumb) endThumb.classList.toggle('wm-active', side === 'end'); } catch (_) {}
      };
      const applyClientX = (clientX, side) => {
        const raw = valueFromClientX(clientX);
        if (side === 'start') _applyRangePair(startInput, endInput, raw, endInput.value, 'start', true);
        else _applyRangePair(startInput, endInput, startInput.value, raw, 'end', true);
      };
      const startDrag = (side, clientX, jumpToTrack) => {
        setDragUi(side);
        if (jumpToTrack) applyClientX(clientX, side);
        const onMove = (ev) => {
          ev.preventDefault();
          applyClientX(ev.clientX, side);
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          clearDragUi();
        };
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      };

      if (startThumb) {
        startThumb.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          startDrag('start', ev.clientX, false);
        });
      }
      if (endThumb) {
        endThumb.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          startDrag('end', ev.clientX, false);
        });
      }
      shell.addEventListener('pointerdown', (ev) => {
        if (ev.target && (ev.target.closest('.wm-slider-badge') || ev.target.closest('.wm-slider-editor'))) return;
        const startPct = _settingValueToPercent(startInput, startInput.value);
        const endPct = _settingValueToPercent(endInput, endInput.value);
        const rect = shell.getBoundingClientRect();
        const xPct = ((Number(ev.clientX) - rect.left) / Math.max(1, rect.width)) * 100;
        const side = (Math.abs(xPct - startPct) <= Math.abs(xPct - endPct)) ? 'start' : 'end';
        ev.preventDefault();
        startDrag(side, ev.clientX, true);
      });

      if (startBadge && startEditor) {
        startBadge.addEventListener('click', () => {
          _openSettingsValueEditor(startEditor, startBadge, startInput, (raw) => {
            _applyRangePair(startInput, endInput, _domainValueToSliderRaw(startInput, raw), endInput.value, 'start', true);
          });
        });
      }
      if (endBadge && endEditor) {
        endBadge.addEventListener('click', () => {
          _openSettingsValueEditor(endEditor, endBadge, endInput, (raw) => {
            _applyRangePair(startInput, endInput, startInput.value, _domainValueToSliderRaw(endInput, raw), 'end', true);
          });
        });
      }

      _syncRangeSliderField(field);
    }

    for (const input of Array.from(settingsView.querySelectorAll('select, input[type="date"], input[type="checkbox"]'))) {
      if (!input) continue;
      input.addEventListener('input', () => _scheduleLiveSettingsApply());
      input.addEventListener('change', () => _scheduleLiveSettingsApply());
    }

    settingsView.dataset.wmSliderInit = '1';
    _refreshPreferencesUi();
  }

  try {
    if (setActiveHourStart) {
      setActiveHourStart.addEventListener('input', () => _syncActiveHourInputs(setActiveHourStart));
      setActiveHourStart.addEventListener('change', () => _syncActiveHourInputs(setActiveHourStart));
    }
    if (setActiveHourEnd) {
      setActiveHourEnd.addEventListener('input', () => _syncActiveHourInputs(setActiveHourEnd));
      setActiveHourEnd.addEventListener('change', () => _syncActiveHourInputs(setActiveHourEnd));
    }
  } catch (_) {}
  try { _initPreferencesSliderUi(); } catch (_) {}
  try {
    _setSettingsLiveEnabled(_settingsLiveEnabled(), { persist: false });
    if (settingsLiveStatus) {
      settingsLiveStatus.addEventListener('click', () => {
        if (_settingsLiveEnabled()) {
          if (_settingsLiveApplyTimer) {
            try { clearTimeout(_settingsLiveApplyTimer); } catch (_) {}
            _settingsLiveApplyTimer = null;
          }
          _setSettingsLiveEnabled(false);
          return;
        }
        if (_settingsManualDirty) {
          try { _applySettingsWithRefresh(); } catch (_) {}
          _markSettingsSaved();
          return;
        }
        _setSettingsLiveEnabled(true);
      });
    }
  } catch (_) {}

  // -------------------- Mode side effects --------------------
  // Tab selection + pill positioning is handled by the inlined script in index.html.
  // This function remains as the single place for non-visual side effects.
  let LAST_NON_SETTINGS_MODE = 'climate';
  function setMode(mode) {
    const m = (mode === 'climate' || mode === 'tour' || mode === 'settings') ? mode : 'climate';
    const prevMode = LAST_EFFECTIVE_MODE;
    const modeChanged = prevMode !== m;
    LAST_EFFECTIVE_MODE = m;
    if (m !== 'settings') LAST_NON_SETTINGS_MODE = m;
    try { document.body.dataset.mode = m; } catch (_) {}
    try { _setBottomPanelUiMode(m); } catch (_) {}

    try {
      strategicSetActive && strategicSetActive(m === 'climate');
    } catch (_) {}

    // Climate mode must never show TOUR tactical visuals (bands/glyphs).
    if (m === 'climate') {
      // Climate mode must never fetch route/weather streams.
      try { if (evtSource) evtSource.close(); } catch (_) {}
      try { if (window.__WM_PRIME_EVT_SOURCE__) window.__WM_PRIME_EVT_SOURCE__.close(); } catch (_) {}
      try { if (evtSourceProfile) evtSourceProfile.close(); } catch (_) {}
      PRIME_IN_PROGRESS = false;
      MAIN_IN_PROGRESS = false;
      try { stopProgressAnim(); } catch (_) {}
      try { if (fetchWeatherBtn) { updateFetchWeatherLabel(); fetchWeatherBtn.disabled = false; } } catch (_) {}
      try { if (stopWeatherBtn) stopWeatherBtn.style.display = 'none'; } catch (_) {}

      try { _setTourBandsEnabled(false); } catch (_) {}
      try {
        const tip = document.querySelector && document.querySelector('.wm-tour-bands-tip');
        if (tip) tip.style.display = 'none';
      } catch (_) {}
      try {
        // Hide glyph marker layers from prior TOUR runs.
        if (glyphLayerNew) { try { map.removeLayer(glyphLayerNew); } catch (_) {} }
        if (glyphLayer) { try { map.removeLayer(glyphLayer); } catch (_) {} }
        _clearTourRouteDayCards();
      } catch (_) {}
      try { _clearTourCursorMarker(); } catch (_) {}
      try { _hideClimateProfileTooltip(); } catch (_) {}
      try { PROFILE_XS = []; } catch (_) {}
      try { if (profileCursorCtx && profileCanvas) {
        const rect = profileCanvas.getBoundingClientRect();
        profileCursorCtx.clearRect(0, 0, Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)));
      } } catch (_) {}
      try {
        const currentH = profilePanel ? Number(profilePanel.offsetHeight || 0) : 0;
        if (!Number.isFinite(currentH) || currentH < CLIMATE_PROFILE_HEIGHT) {
          setProfileHeight(CLIMATE_PROFILE_HEIGHT);
        }
      } catch (_) {}
      try {
        const climatePoint = CLIMATE_PROFILE_STATE.selectedPoint || CLIMATE_DEFAULT_POINT;
        if (CLIMATE_PROFILE_STATE.selectedPoint) {
          _renderClimateCurrentState();
          _activateClimateProfileSelection(climatePoint, { force: false, immediate: true });
        } else {
          _renderClimateCurrentState();
          _activateClimateProfileSelection(climatePoint, { force: false, immediate: true });
        }
      } catch (_) {}
    }
    if (m === 'tour') {
      try {
        if (STRATEGIC_STATE.playing) {
          STRATEGIC_STATE.playing = false;
          if (STRATEGIC_STATE.playTimer) {
            clearTimeout(STRATEGIC_STATE.playTimer);
            STRATEGIC_STATE.playTimer = null;
          }
        }
      } catch (_) {}
      try { _setTourBandsEnabled(_tourWantBands()); } catch (_) {}
      try {
        if (glyphLayerNew) { try { map.removeLayer(glyphLayerNew); } catch (_) {} }
        if (glyphLayer) { try { map.removeLayer(glyphLayer); } catch (_) {} }
        _clearTourRouteDayCards();
      } catch (_) {}
      try { _hideStrategicCursorReadout(); } catch (_) {}
      try { _hideClimateProfileTooltip(); } catch (_) {}
      try {
        if (CLIMATE_PROFILE_STATE.selectedMarker) map.removeLayer(CLIMATE_PROFILE_STATE.selectedMarker);
      } catch (_) {}
      try {
        const currentH = profilePanel ? Number(profilePanel.offsetHeight || 0) : 0;
        if (!Number.isFinite(currentH) || currentH < 220) {
          setProfileHeight(220);
        }
      } catch (_) {}
      try {
        if (LAST_PROFILE) drawProfile(LAST_PROFILE);
        else _drawProfilePlaceholder('Loading route profile...');
      } catch (_) {}
      try {
        if (LAST_TOUR_SUMMARY) renderTourSummary(LAST_TOUR_SUMMARY);
        else _renderTourEmptyState('Loading route weather...');
      } catch (_) {}
      try { _tourSyncTimelineFromInputs(); } catch (_) {}
      try {
        if (sseStatus) sseStatus.textContent = 'Loading route + profile…';
      } catch (_) {}
      if (modeChanged) {
        if (MODE_SWITCH_RELOAD_TIMER) {
          try { clearTimeout(MODE_SWITCH_RELOAD_TIMER); } catch (_) {}
          MODE_SWITCH_RELOAD_TIMER = null;
        }
        MODE_SWITCH_RELOAD_TIMER = setTimeout(() => {
          MODE_SWITCH_RELOAD_TIMER = null;
          try {
            if (_getAppMode() !== 'tour') return;
            loadMap({ ...(LAST_LOAD_OPTS || {}), forceRestart: true });
          } catch (_) {}
        }, 0);
      }
    }

    // Basemap selection: Climate mode varies per layer.
    try { _applyStrategicBasemap(); } catch (_) {}
    try { _applyTourRouteLayerVisibility(); } catch (_) {}
    try { _updateStrategicLegend(); } catch (_) {}

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
  const STRATEGIC_YEAR_CHOICES = [2025, 2024, 2023, 2022, 2021];
  const STRATEGIC_DEFAULT_MODE = 'active'; // 'active' | 'full_day'
  const STRATEGIC_CROSSFADE_MS = 300;
  const STRATEGIC_FETCH_THROTTLE_MS = 180;

  function _uniqYearsDesc(arr) {
    const out = [];
    const seen = new Set();
    for (const x of (Array.isArray(arr) ? arr : [])) {
      const y = Math.round(Number(x));
      if (!Number.isFinite(y)) continue;
      if (seen.has(y)) continue;
      seen.add(y);
      out.push(y);
    }
    out.sort((a, b) => b - a);
    return out;
  }

  function _strategicGetSelectedYears() {
    try {
      const yrs = (STRATEGIC_STATE && Array.isArray(STRATEGIC_STATE.years) && STRATEGIC_STATE.years.length)
        ? STRATEGIC_STATE.years
        : (SETTINGS && Array.isArray(SETTINGS.strategicYears) && SETTINGS.strategicYears.length)
            ? SETTINGS.strategicYears
            : [Number((SETTINGS && SETTINGS.strategicYear) || STRATEGIC_DEFAULT_YEAR)];
      const u = _uniqYearsDesc(yrs);
      return u.length ? u : [STRATEGIC_DEFAULT_YEAR];
    } catch (_) {
      return [STRATEGIC_DEFAULT_YEAR];
    }
  }

  function _strategicGetMode() {
    try {
      const mRaw = (STRATEGIC_STATE && typeof STRATEGIC_STATE.mode === 'string')
        ? String(STRATEGIC_STATE.mode)
        : (SETTINGS && typeof SETTINGS.strategicMode === 'string')
            ? String(SETTINGS.strategicMode)
            : STRATEGIC_DEFAULT_MODE;
      return (mRaw === 'full_day') ? 'full_day' : 'active';
    } catch (_) {
      return STRATEGIC_DEFAULT_MODE;
    }
  }

  function _strategicYearsKey(years) {
    const ys = _uniqYearsDesc(years || _strategicGetSelectedYears());
    return ys.join(',');
  }

  function _strategicModeLabel(mode) {
    return (String(mode || '') === 'full_day') ? '24h' : 'Active';
  }

  function _renderMiniBtn(host, label, pressed, onClick, title) {
    if (!host) return null;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wm-mini-btn';
    b.textContent = String(label);
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    if (title) b.title = String(title);
    b.addEventListener('click', (ev) => {
      try { ev.preventDefault(); } catch (_) {}
      try { ev.stopPropagation(); } catch (_) {}
      try { onClick && onClick(); } catch (_) {}
    });
    host.appendChild(b);
    return b;
  }

  function _renderStrategicYearsButtons(host, selectedYears, onChange, opts) {
    if (!host) return;
    const o = (opts && typeof opts === 'object') ? opts : {};
    const includeAll = (o.includeAll !== undefined) ? Boolean(o.includeAll) : true;
    host.innerHTML = '';
    const sel = _uniqYearsDesc(selectedYears);
    const selSet = new Set(sel);

    const allPressed = STRATEGIC_YEAR_CHOICES.every(y => selSet.has(y));
    if (includeAll) {
      _renderMiniBtn(
        host,
        'All',
        allPressed,
        () => {
          const next = allPressed ? [STRATEGIC_YEAR_CHOICES[0]] : STRATEGIC_YEAR_CHOICES.slice();
          onChange && onChange(next);
        },
        allPressed ? 'Select only the newest year' : 'Select all years'
      );
    }

    for (const y of STRATEGIC_YEAR_CHOICES) {
      const pressed = selSet.has(y);
      _renderMiniBtn(
        host,
        String(y),
        pressed,
        () => {
          const nextSet = new Set(selSet);
          if (nextSet.has(y)) nextSet.delete(y);
          else nextSet.add(y);
          let next = Array.from(nextSet);
          next.sort((a, b) => b - a);
          if (!next.length) next = [y];
          onChange && onChange(next);
        },
        pressed ? 'Remove year' : 'Add year'
      );
    }
  }

  function _renderStrategicModeButtons(host, selectedMode, onChange) {
    if (!host) return;
    host.innerHTML = '';
    const m = (String(selectedMode || '') === 'full_day') ? 'full_day' : 'active';
    _renderMiniBtn(host, '24h', m === 'full_day', () => { onChange && onChange('full_day'); }, 'Full day (24h)');
    _renderMiniBtn(host, 'Active', m === 'active', () => { onChange && onChange('active'); }, 'Active time');
  }
  function _renderTourOverlayModeSelect(host, selectedMode, onChange) {
    if (!host) return;
    host.innerHTML = '';
    const sel = document.createElement('select');
    sel.className = 'sel wm-tour-mode-select';
    sel.setAttribute('aria-label', 'Tour profile mode');
    const options = [
      { value: 'temperature', label: 'Temperature' },
      { value: 'precipitation', label: 'Rain' },
      { value: 'wind_absolute', label: 'Wind' },
      { value: 'wind_component', label: 'Head/Tail-Wind' },
    ];
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      sel.appendChild(node);
    }
    sel.value = _normalizeOverlayMode(selectedMode);
    sel.addEventListener('change', () => {
      try { onChange && onChange(String(sel.value || 'temperature')); } catch (_) {}
    });
    host.appendChild(sel);
  }

  function _setStrategicYears(nextYears) {
    const ys = _uniqYearsDesc(nextYears);
    const years = ys.length ? ys : [STRATEGIC_DEFAULT_YEAR];
    STRATEGIC_STATE.years = years;
    STRATEGIC_STATE.year = years[0];
    try {
      SETTINGS.strategicYears = years;
      SETTINGS.strategicYear = years[0];
      saveSettings(SETTINGS);
    } catch (_) {}
    try { _strategicSetYear(Number(years[0] || STRATEGIC_DEFAULT_YEAR)); } catch (_) {}
    try { if (setStrategicYears) _renderStrategicYearsButtons(setStrategicYears, years, _setStrategicYears, { includeAll: true }); } catch (_) {}
    try { _updateStrategicLegend(); } catch (_) {}
    try {
      const span = _tourSelectedYearsSpan();
      SETTINGS.histLastYear = span.end;
      SETTINGS.histYears = span.count;
    } catch (_) {}
    try {
      if (_tourIsActive()) {
        loadMap({ ...(LAST_LOAD_OPTS || {}), forceRestart: true, weatherOnly: true });
      }
    } catch (_) {}
    try { if (STRATEGIC_STATE && STRATEGIC_STATE.active) { _renderStrategic(); if (_strategicViewNeedsFetch()) _scheduleStrategicFetch('years'); } } catch (_) {}
    try { _refreshClimateProfileSelection({ force: true, immediate: true }); } catch (_) {}
    try { _markSettingsSaved(); } catch (_) {}
  }

  function _setStrategicMode(nextMode) {
    const m = (String(nextMode || '') === 'full_day') ? 'full_day' : 'active';
    STRATEGIC_STATE.mode = m;
    try {
      SETTINGS.strategicMode = m;
      saveSettings(SETTINGS);
    } catch (_) {}
    try { _updateStrategicLegend(); } catch (_) {}
    try { if (STRATEGIC_STATE && STRATEGIC_STATE.active) { _renderStrategic(); if (_strategicViewNeedsFetch()) _scheduleStrategicFetch('mode'); } } catch (_) {}
    try { _refreshClimateProfileSelection({ force: true, immediate: true }); } catch (_) {}
  }

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

  function _strategicCacheKey(yearsKey, mode, timescale, iso, latMin, latMax, lonMin, lonMax, variant) {
    const v = (variant === null || variant === undefined) ? '' : String(variant);
    const yk = (yearsKey === null || yearsKey === undefined) ? '' : String(yearsKey);
    const mk = (mode === null || mode === undefined) ? '' : String(mode);
    return `${yk}|${mk}|${String(timescale || 'daily')}|${String(iso)}|${_q3(latMin)},${_q3(latMax)},${_q3(lonMin)},${_q3(lonMax)}|${v}`;
  }

  function _strategicLuckyVariant() {
    try {
      // Always include Lucky Days thresholds in the cache key because the
      // strategic tooltip shows Lucky Days even on Temp/Rain/Wind layers.
      // Use defaults while settings are still initializing to avoid NaN→0 bugs.
      const tColdRaw = Number(SETTINGS && SETTINGS.tempCold);
      const tHotRaw = Number(SETTINGS && SETTINGS.tempHot);
      const rMaxRaw = Number(SETTINGS && SETTINGS.rainHigh);
      const wMaxRaw = Number(SETTINGS && SETTINGS.windHeadComfort);
      const tCold = Number.isFinite(tColdRaw) ? tColdRaw : 5;
      const tHot = Number.isFinite(tHotRaw) ? tHotRaw : 30;
      const rMax = Number.isFinite(rMaxRaw) ? rMaxRaw : 10;
      const wMax = Number.isFinite(wMaxRaw) ? wMaxRaw : 4;
      // Quantize to stabilize caching on small slider changes.
      const q1 = (x) => (Number.isFinite(Number(x)) ? (Math.round(Number(x) * 10) / 10).toFixed(1) : 'nan');
      return `lucky:t${q1(tCold)}..${q1(tHot)}|r${q1(rMax)}|w${q1(wMax)}`;
    } catch (_) {
      return 'lucky:err';
    }
  }

  function _strategicLuckyQueryParams() {
    try {
      // Always request Lucky Days counts (used in tooltip for all layers).
      // Use defaults while settings are still initializing to avoid NaN params.
      const tColdRaw = Number(SETTINGS && SETTINGS.tempCold);
      const tHotRaw = Number(SETTINGS && SETTINGS.tempHot);
      const rMaxRaw = Number(SETTINGS && SETTINGS.rainHigh);
      const wMaxRaw = Number(SETTINGS && SETTINGS.windHeadComfort);
      const tCold = Number.isFinite(tColdRaw) ? tColdRaw : 5;
      const tHot = Number.isFinite(tHotRaw) ? tHotRaw : 30;
      const rMax = Number.isFinite(rMaxRaw) ? rMaxRaw : 10;
      const wMax = Number.isFinite(wMaxRaw) ? wMaxRaw : 4;
      return `&lucky_temp_cold=${encodeURIComponent(String(tCold))}`
        + `&lucky_temp_hot=${encodeURIComponent(String(tHot))}`
        + `&lucky_rain_max=${encodeURIComponent(String(rMax))}`
        + `&lucky_wind_max=${encodeURIComponent(String(wMax))}`;
    } catch (_) {
      return '';
    }
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
  let STRATEGIC_LEGEND_YEARS_HOST = null;
  let STRATEGIC_LEGEND_MODE_HOST = null;
  let STRATEGIC_LEGEND_TIMESCALE_SELECT = null;
  function _ensureStrategicLegend() {
    if (STRATEGIC_LEGEND_EL) return STRATEGIC_LEGEND_EL;
    try {
      const el = document.createElement('div');
      el.className = 'wm-map-legend hidden';
      el.innerHTML = [
        '<div class="title" id="wmStrategicLegendTitle" style="margin:0;">Legend</div>',
        '<div class="row" id="wmStrategicLegendLayerRow">'
          + '<div class="lab">Layer</div>'
          + '<select id="wmStrategicLegendLayerSelect" class="sel" aria-label="Layer" title="Layer"></select>'
        + '</div>',
        '<div class="row" id="wmStrategicLegendYearsRow">'
          + '<div class="lab">Years</div>'
          + '<div id="wmStrategicLegendYears" class="btns" aria-label="Years"></div>'
        + '</div>',
        '<div class="row" id="wmStrategicLegendModeRow">'
          + '<div class="lab">Mode</div>'
          + '<div id="wmStrategicLegendMode" class="btns" aria-label="Mode"></div>'
        + '</div>',
        '<div class="row" id="wmStrategicLegendTimescaleRow">'
          + '<div class="lab">Timescale</div>'
          + '<select id="wmStrategicLegendTimescaleSelect" class="sel" aria-label="Timescale" title="Timescale">'
            + '<option value="daily">Daily</option>'
            + '<option value="week">Weekly</option>'
            + '<option value="two_week">2 Weeks</option>'
            + '<option value="month">Monthly</option>'
            + '<option value="quarter">Quarter</option>'
            + '<option value="year">Yearly</option>'
            + '<option value="custom">Custom</option>'
          + '</select>'
        + '</div>',
        '<div class="bar" id="wmStrategicLegendBar"></div>',
        '<div class="ticks" id="wmStrategicLegendTicks"></div>',
        '<div class="note" id="wmStrategicLegendNote" style="display:none"></div>',
      ].join('');
      // Attach to Leaflet map container so it stays inside the map.
      const c = map && map.getContainer ? map.getContainer() : null;
      if (c) c.appendChild(el);
      try { L.DomEvent.disableClickPropagation(el); } catch (_) {}
      try { L.DomEvent.disableScrollPropagation(el); } catch (_) {}
      try {
        const swallow = (ev) => {
          try { ev.stopPropagation(); } catch (_) {}
        };
        el.addEventListener('pointerdown', swallow, true);
        el.addEventListener('mousedown', swallow, true);
        el.addEventListener('touchstart', swallow, { capture: true, passive: true });
      } catch (_) {}
      STRATEGIC_LEGEND_EL = el;

      try {
        const sel = el.querySelector('#wmStrategicLegendLayerSelect');
        if (sel) {
          STRATEGIC_LEGEND_LAYER_SELECT = sel;
          try { _populateLayerOptions(sel); } catch (_) {}
          sel.addEventListener('change', () => {
            const v = String(sel.value || 'temperature_ride');
            try { _setStrategicLayer(v); } catch (_) {}
            // Layer switch uses the same underlying dataset; no refetch needed.
            try { _applyStrategicBasemap(); } catch (_) {}
            try { _renderStrategic(); } catch (_) {}
          });
        }
      } catch (_) {}

      try {
        const hostY = el.querySelector('#wmStrategicLegendYears');
        if (hostY) {
          STRATEGIC_LEGEND_YEARS_HOST = hostY;
          _renderStrategicYearsButtons(hostY, _strategicGetSelectedYears(), _setStrategicYears, { includeAll: true });
        }
      } catch (_) {}

      try {
        const hostM = el.querySelector('#wmStrategicLegendMode');
        if (hostM) {
          STRATEGIC_LEGEND_MODE_HOST = hostM;
          _renderStrategicModeButtons(hostM, _strategicGetMode(), _setStrategicMode);
        }
      } catch (_) {}

      try {
        const selTS = el.querySelector('#wmStrategicLegendTimescaleSelect');
        if (selTS) {
          STRATEGIC_LEGEND_TIMESCALE_SELECT = selTS;
          selTS.addEventListener('change', () => {
            _strategicApplyTimescaleSelection(String(selTS.value || 'daily'));
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
        try {
          if (seg && seg.border) {
            d.style.outline = String(seg.border);
            d.style.outlineOffset = '-1px';
          }
        } catch (_) {}
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

  function _strategicLegendMetaNote() {
    try {
      const resp = STRATEGIC_STATE ? STRATEGIC_STATE.lastResp : null;
      const years = (resp && Array.isArray(resp.years_selected) && resp.years_selected.length)
        ? resp.years_selected
        : _strategicGetSelectedYears();
      const yearsTxt = _uniqYearsDesc(years).join(', ');
      const modeRaw = (resp && typeof resp.mode === 'string') ? String(resp.mode) : _strategicGetMode();
      const modeTxt = _tourIsActive() ? _overlayModeLabel(OVERLAY_MODE) : _strategicModeLabel(modeRaw);

      let rangeTxt = '';
      try {
        if (resp && String(resp.timescale || '') === 'range') {
          const s = String(resp.start_date || '');
          const e = String(resp.end_date || '');
          const d = Math.max(1, Math.round(Number(resp.duration_days) || 1));
          if (s && e) rangeTxt = `Range: ${_fmtISODayMonth(s)} – ${_fmtISODayMonth(e)} (${d}d)`;
          else if (s) rangeTxt = `Range: ${_fmtISODayMonth(s)} (${d}d)`;
        } else {
          const ts = String(STRATEGIC_STATE && STRATEGIC_STATE.timescale ? STRATEGIC_STATE.timescale : 'daily');
          const map = { daily: 'Daily', week: 'Weekly', two_week: '2 Weeks', month: 'Monthly', quarter: 'Quarter', year: 'Yearly', custom: 'Custom' };
          rangeTxt = map[ts] ? `Timescale: ${map[ts]}` : `Timescale: ${ts}`;
        }
      } catch (_) {
        rangeTxt = '';
      }

      const parts = [];
      if (yearsTxt) parts.push(`Years: ${yearsTxt}`);
      if (modeTxt) parts.push(`${_tourIsActive() ? 'Profile' : 'Mode'}: ${modeTxt}`);
      if (rangeTxt) parts.push(rangeTxt);
      return parts.join(' • ');
    } catch (_) {
      return '';
    }
  }

  function _updateStrategicLegend() {
    const el = _ensureStrategicLegend();
    if (!el) return;
    const appMode = _getAppMode();
    const showClimateLegend = Boolean(STRATEGIC_STATE && STRATEGIC_STATE.active);
    const showTourLegend = (appMode === 'tour');
    if (!showClimateLegend && !showTourLegend) {
      el.classList.add('hidden');
      return;
    }

    const layer = _tourIsActive() ? _normalizeOverlayMode(OVERLAY_MODE) : _strategicNormalizeLayer(STRATEGIC_STATE.layer);
    const metaNote = _strategicLegendMetaNote();
    el.classList.remove('hidden');

    try {
      const modeRow = el.querySelector('#wmStrategicLegendModeRow');
      if (modeRow) modeRow.style.display = _tourIsActive() ? 'none' : '';
    } catch (_) {}

    // Keep legend's layer select in sync (and keep its options current).
    try {
      if (STRATEGIC_LEGEND_LAYER_SELECT) {
        if (_tourIsActive() || (strategicLayerSelect && strategicLayerSelect.options && STRATEGIC_LEGEND_LAYER_SELECT.options.length !== strategicLayerSelect.options.length)) {
          _populateLayerOptions(STRATEGIC_LEGEND_LAYER_SELECT);
        }
        STRATEGIC_LEGEND_LAYER_SELECT.value = String(layer || (_tourIsActive() ? 'temperature' : 'temperature_ride'));
      }
    } catch (_) {}

    try {
      if (STRATEGIC_LEGEND_YEARS_HOST) {
        _renderStrategicYearsButtons(STRATEGIC_LEGEND_YEARS_HOST, _strategicGetSelectedYears(), _setStrategicYears, { includeAll: true });
      }
    } catch (_) {}

    try {
      if (STRATEGIC_LEGEND_MODE_HOST && !_tourIsActive()) {
        _renderStrategicModeButtons(STRATEGIC_LEGEND_MODE_HOST, _strategicGetMode(), _setStrategicMode);
      }
    } catch (_) {}
    try {
      if (STRATEGIC_LEGEND_TIMESCALE_SELECT) {
        const ts = String(STRATEGIC_STATE.timescale || ((SETTINGS && SETTINGS.climateTimescale) ? SETTINGS.climateTimescale : 'daily'));
        if (_strategicUsingRangeUI()) {
          try { _strategicUpdateCustomOptionLabel(STRATEGIC_LEGEND_TIMESCALE_SELECT); } catch (_) {}
        }
        STRATEGIC_LEGEND_TIMESCALE_SELECT.value = ts || 'daily';
      }
    } catch (_) {}

    if (layer === 'temperature_ride' || layer === 'temperature') {
      const td = _tempLegendData(-5, 35);
      const segments = (td && Array.isArray(td.segments) && td.segments.length)
        ? td.segments
        : [
            { color: '#2c7bb6', flex: 5 },
            { color: '#00a6ca', flex: 5 },
            { color: '#66c2a5', flex: 5 },
            { color: '#1a9850', flex: 5 },
            { color: '#66bd63', flex: 5 },
            { color: '#fee08b', flex: 5 },
          ];

      const modeRaw = (() => {
        try {
          const resp = STRATEGIC_STATE ? STRATEGIC_STATE.lastResp : null;
          return (resp && typeof resp.mode === 'string') ? String(resp.mode) : _strategicGetMode();
        } catch (_) {
          return _strategicGetMode();
        }
      })();
      const title = (String(modeRaw) === 'full_day') ? 'Temperature (24h, °C)' : 'Temperature (active hours, °C)';
      _setLegendSteps(title, segments, [], metaNote || null);
      try {
        const ticksEl = el.querySelector('#wmStrategicLegendTicks');
        _renderTempLegendTicksInto(ticksEl, td);
      } catch (_) {}
      _setLegendTooltips(
        (String(modeRaw) === 'full_day')
          ? 'Full-day temperature (24h) aggregated from offline climatology.'
          : 'Active-hours temperature (median of 10/12/14/16 local time).',
        'Color encodes discrete temperature bins.',
        'Ticks align with the temperature→color scale.'
      );
      return;
    }
    if (layer === 'rain_ride' || layer === 'precipitation') {
      const ts = String(STRATEGIC_STATE.timescale || ((SETTINGS && SETTINGS.climateTimescale) ? SETTINGS.climateTimescale : 'daily') || 'daily');
      const rangesTxt = '0.5–2 • 2–5 • 5–10 • 10–20 • 20–50 • >50';
      const note = (ts && ts !== 'daily')
        ? `${rangesTxt} (mm/day, capped). Interval shows mm/day average; tooltip shows sum.`
        : `${rangesTxt} (mm/day, capped).`;
      const note2 = metaNote ? `${note}  |  ${metaNote}` : note;
      _setLegendSteps(
        'Rain intensity (mm/day, capped)',
        [
          { color: 'rgba(180,160,255,0.10)' },  // 0.5–2 very subtle
          { color: 'rgba(150,120,255,0.18)' },  // 2–5 light
          { color: 'rgba(120,80,220,0.30)' },   // 5–10 moderate
          { color: 'rgba(100,60,200,0.45)' },   // 10–20 strong
          { color: 'rgba(80,40,160,0.60)' },    // 20–50 heavy
          { color: 'rgba(70,30,140,0.70)' },    // >50 extreme (capped max)
        ],
        [],
        note2
      );
      try {
        const ticksEl = el.querySelector('#wmStrategicLegendTicks');
        _renderRainLegendTicksInto(ticksEl, { rangeMin: 0.5, rangeMax: 50, major: [2, 10, 20, 50] });
      } catch (_) {}
      _setLegendTooltips(
        'Bikepacking-relevant rain intensity (mm/day). Light drizzle (<0.5mm/day) is hidden; values above 50mm/day are visually capped.',
        'Discrete bins after interpolation (no gradient), with light smoothing for field shape.',
        'Ticks are mm/day anchors on the capped scale.'
      );
      return;
    }
    if (layer === 'rain_tent') {
      _setLegend('Rain (typical, mm/day)', PAL_RAIN, ['0', '3', '6', '12'], null);
      _setLegendTooltips(
        'Typical rain for the full-day view (mm/day equivalent).',
        'Color encodes typical rain (mm/day).',
        'Tick labels are mm/day anchors.'
      );
      return;
    }
    if (layer === 'comfort' || layer === 'comfort_day' || layer === 'comfort_ride') {
      const modeRaw = (() => {
        try {
          const resp = STRATEGIC_STATE ? STRATEGIC_STATE.lastResp : null;
          return (resp && typeof resp.mode === 'string') ? String(resp.mode) : _strategicGetMode();
        } catch (_) {
          return _strategicGetMode();
        }
      })();
      const isActive = (String(modeRaw) !== 'full_day');
      _setLegendSteps(
        isActive ? 'Lucky Days (Active, %)' : 'Lucky Days (%)',
        [
          { color: '#d73027' },  // 0–20 bad
          { color: '#f46d43' },  // 20–40
          { color: '#fee08b' },  // 40–60 neutral
          { color: '#a6d96a' },  // 60–80 good
          { color: '#1a9850' },  // 80–100 excellent
        ],
        ['0', '20', '40', '60', '80', '100%'],
        (metaNote
          ? `Share of sample-days that meet your Lucky Days conditions (${isActive ? 'active hours' : '24h'}).  |  ${metaNote}`
          : `Share of sample-days that meet your Lucky Days conditions (${isActive ? 'active hours' : '24h'}).`)
      );
      _setLegendTooltips(
        `Counts how many sample-days in the selected interval are within your Lucky Days conditions (${isActive ? 'active hours' : '24h'}).`,
        'Color encodes the share of lucky days (0–100%).',
        'Tick labels are % anchors in 20% steps.'
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
        'Lucky Days score combines temperature, rain and wind for the full-day view.',
        `Thresholds: temp ${cold}..${hot}°C, rain < ${rainHigh} mm/day, wind < ${wAbs} m/s (absolute).`,
        'Tick labels are score anchors (0..1).'
      );
      return;
    }
    if (layer === 'wind_speed' || layer === 'wind_absolute') {
      _setLegend('Wind (absolute, m/s)', PAL_WIND, ['0', '3', '6', '10', '14+'], metaNote || null);
      _setLegendTooltips(
        'Absolute wind speed with route arrows showing direction.',
        'Color encodes wind speed (m/s).',
        'Tick labels are m/s anchors.'
      );
      return;
    }
    if (layer === 'wind_dir' || layer === 'wind_component') {
      _setLegend(
        'Head/Tail-Wind (m/s)',
        [
          { t: 0.00, c: { r: 204, g: 66, b: 57 } },
          { t: 0.50, c: { r: 181, g: 187, b: 198 } },
          { t: 1.00, c: { r: 38, g: 166, b: 91 } },
        ],
        ['-8', '-4', '0', '4', '8'],
        metaNote || null
      );
      _setLegendTooltips(
        'Tangential wind component along the route: red headwind to green tailwind.',
        'Color encodes signed effective wind (m/s).',
        'Tick labels are signed m/s anchors.'
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
    if (_tourIsActive()) {
      _setOverlayMode(String(layer || 'temperature'), { skipPersist: false });
      try {
        if (STRATEGIC_LEGEND_LAYER_SELECT) STRATEGIC_LEGEND_LAYER_SELECT.value = _normalizeOverlayMode(OVERLAY_MODE);
      } catch (_) {}
      return;
    }
    STRATEGIC_STATE.layer = _strategicNormalizeLayer(layer);
    try {
      if (strategicLayerSelect) strategicLayerSelect.value = STRATEGIC_STATE.layer;
    } catch (_) {}
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

  function _fmtISODayMonth(iso) {
    try {
      const s = String(iso || '').trim();
      const d = new Date(s);
      if (!Number.isFinite(Number(d && d.getTime && d.getTime()))) return s;
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
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

        // Track current backing-store size to avoid clearing on every move/zoom.
        this._lastW = 0;
        this._lastH = 0;
        this._lastDpr = 0;

        const climatePane = (m.getPane && m.getPane('wmClimatePane')) ? m.getPane('wmClimatePane') : m.getPanes().overlayPane;
        climatePane.appendChild(this._container);
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
        const w = Math.max(1, Math.floor(size.x * dpr));
        const h = Math.max(1, Math.floor(size.y * dpr));
        const needResize = (w !== this._lastW) || (h !== this._lastH) || (dpr !== this._lastDpr);
        if (needResize) {
          this._lastW = w;
          this._lastH = h;
          this._lastDpr = dpr;
          [this._front, this._buffer].forEach(c => {
            c.width = w;
            c.height = h;
          });
        }
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

        this._lastW = 0;
        this._lastH = 0;
        this._lastDpr = 0;
        const windPane = (m.getPane && m.getPane('wmWindPane')) ? m.getPane('wmWindPane') : m.getPanes().overlayPane;
        windPane.appendChild(this._container);
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
        const w = Math.max(1, Math.floor(size.x * dpr));
        const h = Math.max(1, Math.floor(size.y * dpr));
        const needResize = (w !== this._lastW) || (h !== this._lastH) || (dpr !== this._lastDpr);
        if (needResize) {
          this._lastW = w;
          this._lastH = h;
          this._lastDpr = dpr;
          this._canvas.width = w;
          this._canvas.height = h;
        }
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
        const MIN_PARTICLES = Math.max(24, Math.round(density * 0.7));
        const LIFE_MIN = 120;
        const LIFE_MAX = 300;
        const reseedParticle = (p) => {
          if (!p) return;
          const curSize = (this._map && this._map.getSize) ? this._map.getSize() : size;
          p.x = Math.random() * Math.max(1, Number(curSize && curSize.x) || 1);
          p.y = Math.random() * Math.max(1, Number(curSize && curSize.y) || 1);
          p.a = Math.random();
          p.age = 0;
          p.life = LIFE_MIN + Math.floor(Math.random() * Math.max(1, LIFE_MAX - LIFE_MIN + 1));
        };
        const topUpParticles = () => {
          while (this._particles.length < density) {
            const p = {};
            reseedParticle(p);
            this._particles.push(p);
          }
        };
        this._particles = [];
        topUpParticles();

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

          if (this._particles.length < MIN_PARTICLES) topUpParticles();

          const animSpd = Math.max(0.1, Number(SETTINGS.animSpeed) || 1.0) * speedMul;
          for (const p of this._particles) {
            p.age = Number(p.age || 0) + 1;
            const x0 = p.x;
            const y0 = p.y;
            if (!Number.isFinite(x0) || !Number.isFinite(y0) || p.age >= Number(p.life || LIFE_MAX)) {
              reseedParticle(p);
              continue;
            }
            const ll = m2.containerPointToLatLng([x0, y0]);
            const s = sampleFn(ll.lat, ll.lng);
            if (!s || !Number.isFinite(s.wind_speed_ms) || !Number.isFinite(s.wind_dir_deg)) {
              reseedParticle(p);
              continue;
            }
            const sp = Math.max(0, Number(s.wind_speed_ms));
            ctx.strokeStyle = colForSpeed(sp);
            const theta = ((Number(s.wind_dir_deg) + 180) % 360) * Math.PI / 180;
            const mag = (0.35 + 0.10 * sp) * animSpd;
            p.x += Math.sin(theta) * mag;
            p.y += -Math.cos(theta) * mag;
            if (p.x < 0 || p.x > sz.x || p.y < 0 || p.y > sz.y) {
              reseedParticle(p);
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
  function _applyTourRouteLayerVisibility() {
    try {
      if (!map) return;
      const showSharedRoute = (_getAppMode() === 'tour' || _getAppMode() === 'climate');
      if (routeLayer) {
        const hasRoute = !!(map.hasLayer && map.hasLayer(routeLayer));
        if (showSharedRoute) {
          if (!hasRoute) routeLayer.addTo(map);
        } else if (hasRoute) {
          map.removeLayer(routeLayer);
        }
      }
      if (flagsLayer) {
        const hasFlags = !!(map.hasLayer && map.hasLayer(flagsLayer));
        if (showSharedRoute) {
          if (!hasFlags) flagsLayer.addTo(map);
        } else if (hasFlags) {
          map.removeLayer(flagsLayer);
        }
      }
    } catch (_) {}
  }

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
      const sampleTemp = Number.isFinite(Number(p.temp_day_median))
        ? Number(p.temp_day_median)
        : (Number.isFinite(Number(p.temperature)) ? Number(p.temperature) : (Number.isFinite(Number(p.temp_hist_median)) ? Number(p.temp_hist_median) : null));
      return {
        dist: x,
        temperature: Number.isFinite(Number(p.temperature)) ? Number(p.temperature) : null,
        temp_day_median: sampleTemp,
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
      const sampleTemp = Number.isFinite(Number(p0.temp_day_median))
        ? Number(p0.temp_day_median)
        : (Number.isFinite(Number(p0.temperature)) ? Number(p0.temperature) : (Number.isFinite(Number(p0.temp_hist_median)) ? Number(p0.temp_hist_median) : null));
      return {
        dist: x,
        temperature: Number.isFinite(Number(p0.temperature)) ? Number(p0.temperature) : null,
        temp_day_median: sampleTemp,
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
      temp_day_median: lerpNum(
        Number.isFinite(Number(p0.temp_day_median)) ? Number(p0.temp_day_median) : (Number.isFinite(Number(p0.temperature)) ? Number(p0.temperature) : p0.temp_hist_median),
        Number.isFinite(Number(p1.temp_day_median)) ? Number(p1.temp_day_median) : (Number.isFinite(Number(p1.temperature)) ? Number(p1.temperature) : p1.temp_hist_median),
        t
      ),
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
      if (!m) return null;
      if (Array.isArray(ROUTE_COORDS) && Array.isArray(ROUTE_CUM_DISTS) && ROUTE_COORDS.length >= 2 && ROUTE_CUM_DISTS.length === ROUTE_COORDS.length) {
        const out = [];
        for (let i = 0; i < ROUTE_COORDS.length; i++) {
          const c = ROUTE_COORDS[i];
          if (!Array.isArray(c) || c.length < 2) continue;
          const lon = Number(c[0]);
          const lat = Number(c[1]);
          const dist = Number(ROUTE_CUM_DISTS[i]);
          if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(dist)) continue;
          const p = m.latLngToContainerPoint([lat, lon]);
          out.push({ x: Number(p.x), y: Number(p.y), dist });
        }
        if (out.length >= 2) return out;
      }
      if (!LAST_PROFILE || !Array.isArray(LAST_PROFILE.sampled_points) || !Array.isArray(LAST_PROFILE.sampled_dist_km)) return null;
      const coords = LAST_PROFILE.sampled_points;
      const dists = LAST_PROFILE.sampled_dist_km;
      if (coords.length < 2 || dists.length !== coords.length) return null;
      const out = new Array(coords.length);
      for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        if (!c) continue;
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
      return false;
    } catch (_) {
      return false;
    }
  }

  function _tourShowProfilePins() {
    return false;
  }

  function _clearTourCursorMarker() {
    try {
      if (MAP_CURSOR_MARKER) {
        map.removeLayer(MAP_CURSOR_MARKER);
        MAP_CURSOR_MARKER = null;
      }
    } catch (_) {}
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
        // Main pane below route vectors plus a foreground pane for rain dots above the route.
        try {
          if (!m.getPane('wmBandsPane')) {
            m.createPane('wmBandsPane');
            m.getPane('wmBandsPane').style.zIndex = '350';
            try { m.getPane('wmBandsPane').classList.add('leaflet-zoom-animated'); } catch (_) {}
          }
          if (!m.getPane('wmBandsTopPane')) {
            m.createPane('wmBandsTopPane');
            m.getPane('wmBandsTopPane').style.zIndex = '450';
            try { m.getPane('wmBandsTopPane').classList.add('leaflet-zoom-animated'); } catch (_) {}
          }
        } catch (_) {}

        this._container = L.DomUtil.create('div', 'wm-tour-bands');
        this._container.style.position = 'absolute';
        this._container.style.left = '0';
        this._container.style.top = '0';
        this._container.style.pointerEvents = 'none';

        this._topContainer = L.DomUtil.create('div', 'wm-tour-bands-top');
        this._topContainer.style.position = 'absolute';
        this._topContainer.style.left = '0';
        this._topContainer.style.top = '0';
        this._topContainer.style.pointerEvents = 'none';

        this._canvasBand = L.DomUtil.create('canvas', '', this._container);
        this._canvasBand.style.position = 'absolute';
        this._canvasBand.style.left = '0';
        this._canvasBand.style.top = '0';
        this._canvasBand.style.width = '100%';
        this._canvasBand.style.height = '100%';
        this._canvasBand.style.zIndex = '1';

        this._canvasWind = L.DomUtil.create('canvas', '', this._topContainer);
        this._canvasWind.style.position = 'absolute';
        this._canvasWind.style.left = '0';
        this._canvasWind.style.top = '0';
        this._canvasWind.style.width = '100%';
        this._canvasWind.style.height = '100%';
        this._canvasWind.style.zIndex = '1';

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
            <div style="font-weight:600;margin-bottom:6px;">Tour Weather</div>
            <div style="margin-bottom:8px;">
              <div style="font-weight:600;margin-bottom:3px;">Route</div>
              <div style="display:flex;align-items:center;gap:8px;margin:2px 0;">
                <span style="position:relative;display:inline-block;width:28px;height:10px;">
                  <span style="position:absolute;left:0;right:0;top:0;height:10px;border-radius:999px;background:rgba(245,242,235,0.6);"></span>
                  <span style="position:absolute;left:0;right:0;top:3px;height:3px;border-radius:999px;background:#2F4858;"></span>
                  <span style="position:absolute;left:0;right:0;top:4px;height:1px;border-radius:999px;background:rgba(255,255,255,0.6);"></span>
                </span>
                <span style="opacity:0.9;">base route</span>
              </div>
            </div>
            <div style="margin-bottom:8px;">
              <div style="font-weight:600;margin-bottom:3px;">Weather</div>
              <div style="display:flex;align-items:center;gap:8px;margin:2px 0;">
                <span style="display:inline-block;min-width:44px;font-size:13px;line-height:1;">🌤 21°</span>
                <span style="opacity:0.9;">icon + temperature</span>
              </div>
            </div>
            <div>
              <div style="font-weight:600;margin-bottom:3px;">Wind</div>
              <div style="display:flex;align-items:center;gap:8px;margin:2px 0;">
                <span style="display:inline-block;min-width:44px;color:#666;opacity:0.8;">▸▸</span>
                <span style="opacity:0.9;">wind chevrons</span>
              </div>
            </div>`;
          try { L.DomEvent.disableClickPropagation(el); } catch (_) {}
          try { L.DomEvent.disableScrollPropagation(el); } catch (_) {}
          this._legendEl = el;
          return el;
        };
        try { this._legendControl.addTo(m); } catch (_) {}

        const pane = (m.getPane && m.getPane('wmBandsPane')) ? m.getPane('wmBandsPane') : m.getPanes().overlayPane;
        pane.appendChild(this._container);
        const topPane = (m.getPane && m.getPane('wmBandsTopPane')) ? m.getPane('wmBandsTopPane') : m.getPanes().markerPane;
        topPane.appendChild(this._topContainer);

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
        this._hoverLocationTimer = 0;
        this._hoverLocationPending = null;
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
          this._tipEl.style.background = 'rgba(255,255,255,0.56)';
          this._tipEl.style.backdropFilter = 'blur(1.5px)';
          this._tipEl.style.border = '1px solid rgba(148,163,184,0.18)';
          this._tipEl.style.borderRadius = '10px';
          this._tipEl.style.padding = '8px 10px';
          this._tipEl.style.font = '13px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
          this._tipEl.style.fontWeight = '400';
          this._tipEl.style.lineHeight = '1.28';
          this._tipEl.style.color = '#111';
          this._tipEl.style.boxShadow = '0 4px 10px rgba(15,23,42,0.06)';
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

        const _clearHoverLocationRequest = () => {
          try {
            if (this._hoverLocationTimer) clearTimeout(this._hoverLocationTimer);
          } catch (_) {}
          this._hoverLocationTimer = 0;
          this._hoverLocationPending = null;
        };

        const _scheduleHoverLocationRequest = (lat, lon, key, renderHoverTooltipHtml) => {
          try {
            if (!key || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return;
            if (STRATEGIC_LOCATION_LABEL_CACHE.has(key)) return;
            const nextPending = {
              lat: Number(lat),
              lon: Number(lon),
              key: String(key),
              renderHoverTooltipHtml,
            };
            this._hoverLocationPending = nextPending;
            if (this._hoverLocationTimer) {
              try { clearTimeout(this._hoverLocationTimer); } catch (_) {}
            }
            const now = Date.now();
            const minDelayMs = 280;
            const quietWindowMs = 220;
            const elapsed = now - Number(this._lastTooltipTs || 0);
            const waitMs = Math.max(quietWindowMs, minDelayMs - (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0));
            this._hoverLocationTimer = setTimeout(() => {
              const pending = this._hoverLocationPending;
              this._hoverLocationTimer = 0;
              this._hoverLocationPending = null;
              if (!pending || !pending.key) return;
              this._lastTooltipTs = Date.now();
              _requestLocationLabel(pending.lat, pending.lon, (label, resolvedKey) => {
                try {
                  if (!this._tipEl || this._tipEl.style.display === 'none') return;
                  if (this._tipEl._wmLastLocationKey !== resolvedKey) return;
                  const nextHtml = pending.renderHoverTooltipHtml(label);
                  this._tipEl._wmLastHtml = nextHtml;
                  this._tipEl.innerHTML = nextHtml;
                  this._tipW = this._tipEl.offsetWidth || this._tipW;
                  this._tipH = this._tipEl.offsetHeight || this._tipH;
                } catch (_) {}
              });
            }, waitMs);
          } catch (_) {}
        };

        const _showOffRouteTooltip = (cp, latlng, dbg, dbgEl, dbgText, dRoutePx, thrPx) => {
          try {
            if (!cp || !latlng) {
              try { if (this._tipEl) this._tipEl.style.display = 'none'; } catch (_) {}
              return;
            }
            const hoverLat = Number(latlng.lat);
            const hoverLon = Number(latlng.lng);
            const hoverLocationKey = (Number.isFinite(hoverLat) && Number.isFinite(hoverLon))
              ? _strategicLocationLabelKey(hoverLat, hoverLon)
              : '';
            const cachedLocationLabel = (hoverLocationKey && STRATEGIC_LOCATION_LABEL_CACHE.has(hoverLocationKey))
              ? STRATEGIC_LOCATION_LABEL_CACHE.get(hoverLocationKey)
              : ((Number.isFinite(hoverLat) && Number.isFinite(hoverLon)) ? _strategicLocationFallbackLabel(hoverLat, hoverLon) : '—');
            const coordText = `${_fmtNum(hoverLat, 4)}, ${_fmtNum(hoverLon, 4)}`;
            const renderLocationTooltipHtml = (locationLabel) => (
              `<div style="display:flex;flex-direction:column;gap:3px;white-space:nowrap;">`
                + `<div style="font-size:13px;font-weight:700;color:#0f172a;">${_htmlEsc(locationLabel || cachedLocationLabel || '—')}</div>`
                + `<div style="font-size:11px;color:#475569;">${_htmlEsc(coordText)}</div>`
              + `</div>`
            );
            const htmlKey = `off|${hoverLocationKey}|${coordText}`;
            const tipEl = _ensureTipEl();
            const html = renderLocationTooltipHtml(cachedLocationLabel);
            if (tipEl._wmLastHtmlKey !== htmlKey || tipEl._wmLastHtml !== html) {
              tipEl._wmLastHtmlKey = htmlKey;
              tipEl._wmLastHtml = html;
              tipEl.innerHTML = html;
              try {
                this._tipW = tipEl.offsetWidth || this._tipW;
                this._tipH = tipEl.offsetHeight || this._tipH;
              } catch (_) {}
            }
            try {
              if (hoverLocationKey && tipEl._wmLastLocationKey !== hoverLocationKey) {
                tipEl._wmLastLocationKey = hoverLocationKey;
                _scheduleHoverLocationRequest(hoverLat, hoverLon, hoverLocationKey, renderLocationTooltipHtml);
              }
            } catch (_) {}
            tipEl.style.display = 'block';

            const cont = m.getContainer();
            const rect = cont ? cont.getBoundingClientRect() : null;
            const cw = cont ? cont.clientWidth : 0;
            const ch = cont ? cont.clientHeight : 0;
            const pad = 8;
            const baseLeft = (rect ? rect.left : 0) + Number(cp.x);
            const baseTop = (rect ? rect.top : 0) + Number(cp.y);
            let left = baseLeft + 14;
            let top = baseTop - 12;
            const tw = Number(this._tipW || tipEl.offsetWidth || 0);
            const th = Number(this._tipH || tipEl.offsetHeight || 0);
            top = baseTop - 12 - th;
            if (ch && rect && (top < (rect.top + pad))) top = baseTop + 18;
            if (cw && rect && (left + tw + pad) > (rect.left + cw)) left = Math.max(rect.left + pad, rect.left + cw - tw - pad);
            if (cw && rect && left < (rect.left + pad)) left = rect.left + pad;
            if (ch && rect && (top + th + pad) > (rect.top + ch)) top = Math.max(rect.top + pad, rect.top + ch - th - pad);
            if (ch && rect && top < (rect.top + pad)) top = rect.top + pad;
            _scheduleTipPos(left, top);

            if (dbgEl && dbg) {
              dbgEl.textContent = dbgText +
                `latlng=${hoverLat.toFixed(5)},${hoverLon.toFixed(5)}\n` +
                `dRoute=${dRoutePx===null?'-':Math.round(dRoutePx)}px thr=${Math.round(thrPx)}px\n` +
                `off-route tooltip @ ${Math.round(left)},${Math.round(top)}`;
            }
          } catch (_) {}
        };

        const _nearestRouteHit = (cp, thresholdPx) => {
          try {
            if (!cp || !this._hoverRouteRibbon || this._hoverRouteRibbon.length < 2) return null;
            const bestRoute = _nearestOnRibbon(Number(cp.x), Number(cp.y), this._hoverRouteRibbon, this._lastHoverSegIdxRoute, thresholdPx);
            if (bestRoute && Number.isFinite(bestRoute.segIdx)) this._lastHoverSegIdxRoute = bestRoute.segIdx;
            return bestRoute;
          } catch (_) {
            return null;
          }
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
                this._hoverBandRibbon = (wantBandHover && rr) ? rr : null;
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
            const selectThrPx = Math.max(4, Math.min(48, _mmToPx(1)));

            if (dbgEl && dbg) {
              dbgEl.style.display = 'block';
              dbgText += `mousemove @ ${Math.round(x)},${Math.round(y)}\n`;
            } else if (dbgEl) {
              dbgEl.style.display = 'none';
            }

            const bestRoute = haveRoute ? _nearestRouteHit(cp, selectThrPx) : null;
            const dRoutePx = bestRoute ? Math.sqrt(Number(bestRoute.d2) || 0) : null;

            try { m.getContainer().style.cursor = (bestRoute && Number.isFinite(dRoutePx) && dRoutePx <= selectThrPx) ? 'pointer' : ''; } catch (_) {}
            _showOffRouteTooltip(cp, latlng, dbg, dbgEl, dbgText, dRoutePx, thrPx);
            return;
          } catch (err) {
            if (dbg) {
              try { console.error('TOUR tooltip mousemove failed', err); } catch (_) {}
              try { if (dbgEl) { dbgEl.style.display = 'block'; dbgEl.textContent = (dbgText ? (dbgText + '\n') : '') + 'ERROR: ' + String(err && (err.message || err)); } } catch (_) {}
            }
          }
        };
        this._onClick = (e) => {
          try {
            if (!_tourIsActive()) return;
            const oe = e && e.originalEvent ? e.originalEvent : null;
            if (oe && Number.isFinite(Number(oe.button)) && Number(oe.button) !== 0) return;
            const cp = (e && e.containerPoint) ? e.containerPoint : null;
            if (!cp) return;
            const selectThrPx = Math.max(4, Math.min(48, _mmToPx(1)));
            const bestRoute = _nearestRouteHit(cp, selectThrPx);
            const dRoutePx = bestRoute ? Math.sqrt(Number(bestRoute.d2) || 0) : null;
            if (!(bestRoute && Number.isFinite(bestRoute.dist) && Number.isFinite(dRoutePx) && dRoutePx <= selectThrPx)) return;
            window.updateTourCursorAtDistance(bestRoute.dist);
          } catch (_) {}
        };
        this._onMouseLeave = () => {
          try { if (this._tooltip && this._tooltip._map) m.removeLayer(this._tooltip); } catch (_) {}
          try { _clearHoverLocationRequest(); } catch (_) {}
          try { if (this._tipEl) this._tipEl.style.display = 'none'; } catch (_) {}
          try { m.getContainer().style.cursor = ''; } catch (_) {}
        };
        m.on('mousemove', this._onMouseMove);
        m.on('click', this._onClick);
        try { m.getContainer().addEventListener('mouseleave', this._onMouseLeave); } catch (_) {}
        this._reset();
      },
      onRemove: function(m) {
        m.off('moveend zoomend resize', this._reset, this);
        try { if (this._onMouseMove) m.off('mousemove', this._onMouseMove); } catch (_) {}
        try { if (this._onClick) m.off('click', this._onClick); } catch (_) {}
        try { if (this._onMouseLeave) m.getContainer().removeEventListener('mouseleave', this._onMouseLeave); } catch (_) {}
        try { if (this._tooltip && this._tooltip._map) m.removeLayer(this._tooltip); } catch (_) {}
        try { if (this._hoverLocationTimer) clearTimeout(this._hoverLocationTimer); } catch (_) {}
        this._hoverLocationTimer = 0;
        this._hoverLocationPending = null;
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
        try { this._topContainer && this._topContainer.remove(); } catch (_) {}
        this._map = null;
      },
      _reset: function() {
        if (!this._map || !this._container) return;
        const topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._container, topLeft);
        if (this._topContainer) L.DomUtil.setPosition(this._topContainer, topLeft);
        const size = this._map.getSize();
        const dpr = (window.devicePixelRatio || 1);
        this._container.style.width = `${size.x}px`;
        this._container.style.height = `${size.y}px`;
        if (this._topContainer) {
          this._topContainer.style.width = `${size.x}px`;
          this._topContainer.style.height = `${size.y}px`;
        }
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
          try { if (this._topContainer) this._topContainer.style.display = 'none'; } catch (_) {}
          this.clear();
          return;
        }
        try { this._container.style.display = 'block'; } catch (_) {}
        try { if (this._topContainer) this._topContainer.style.display = 'block'; } catch (_) {}
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
        const TEMP_BAND_WIDTH_PX = 7;
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

        const routeRibbon = (() => {
          try {
            if (!Array.isArray(ROUTE_COORDS) || !Array.isArray(ROUTE_CUM_DISTS) || ROUTE_COORDS.length < 2 || ROUTE_CUM_DISTS.length !== ROUTE_COORDS.length) {
              return ribbon;
            }
            const out = [];
            let prevX = NaN;
            let prevY = NaN;
            for (let i = 0; i < ROUTE_COORDS.length; i++) {
              const pair = ROUTE_COORDS[i];
              if (!Array.isArray(pair) || pair.length < 2) continue;
              const lon = Number(pair[0]);
              const lat = Number(pair[1]);
              const distKm = Number(ROUTE_CUM_DISTS[i]);
              if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(distKm)) continue;
              const cp = m.latLngToContainerPoint([lat, lon]);
              const x = Number(cp.x);
              const y = Number(cp.y);
              if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
              if (out.length && Math.hypot(x - prevX, y - prevY) < 0.75 && i < (ROUTE_COORDS.length - 1)) continue;
              out.push({ x, y, dist: distKm });
              prevX = x;
              prevY = y;
            }
            return out.length >= 2 ? out : ribbon;
          } catch (_) {
            return ribbon;
          }
        })();

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

        const topCtx = windCtx;
        const makePointAtDistFor = (line) => (dk) => {
          const x = Number(dk);
          if (!Number.isFinite(x) || !Array.isArray(line) || !line.length) return null;
          if (line.length === 1) return line[0];
          let lo = 0;
          let hi = line.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (Number(line[mid].dist) <= x) lo = mid; else hi = mid - 1;
          }
          const i0 = lo;
          const i1 = Math.min(line.length - 1, i0 + 1);
          const p0 = line[i0];
          const p1 = line[i1];
          const d0 = Number(p0.dist);
          const d1 = Number(p1.dist);
          if (!Number.isFinite(d0) || !Number.isFinite(d1) || d1 <= d0) return p0;
          const u = clamp((x - d0) / (d1 - d0), 0, 1);
          return { x: p0.x + (p1.x - p0.x) * u, y: p0.y + (p1.y - p0.y) * u, dist: x };
        };
        const routePointAtDist = makePointAtDistFor(routeRibbon);

        const drawPolyline = (targetCtx, line, color, width, alpha) => {
          if (!targetCtx || !line || line.length < 2) return;
          targetCtx.save();
          targetCtx.globalAlpha = Number.isFinite(alpha) ? alpha : 1;
          targetCtx.strokeStyle = color;
          targetCtx.lineWidth = width;
          targetCtx.lineJoin = 'round';
          targetCtx.lineCap = 'round';
          targetCtx.beginPath();
          for (let i = 0; i < line.length; i++) {
            const p = line[i];
            if (!p) continue;
            if (i === 0) targetCtx.moveTo(p.x, p.y);
            else targetCtx.lineTo(p.x, p.y);
          }
          targetCtx.stroke();
          targetCtx.restore();
        };

        const weatherIconForSample = (sample) => {
          if (!sample) return '☁️';
          const rainMm = Number(sample.rainTypical);
          const rainProb = Number(sample.rainProb);
          const t25 = Number(sample.temp_day_p25);
          const t75 = Number(sample.temp_day_p75);
          if (Number.isFinite(rainMm) && rainMm >= 10) return '🌧🌧';
          const kind = classify_weather(rainProb, rainMm, t25, t75);
          if (kind === 'sunny') return '☀️';
          if (kind === 'partly_cloudy') return '🌤';
          if (kind === 'cloudy') return '☁️';
          return '🌧';
        };

        const windChevronCountForSample = (sample) => {
          if (!sample) return 0;
          const speed = Number(sample.windSpeed);
          if (!Number.isFinite(speed) || speed <= 0.75) return 0;
          if (speed < 3.5) return 1;
          if (speed < 7.0) return 2;
          return 3;
        };

        const roundRect = (targetCtx, x, y, w, h, r) => {
          const rad = Math.max(0, Math.min(Number(r) || 0, Math.min(w, h) / 2));
          targetCtx.beginPath();
          targetCtx.moveTo(x + rad, y);
          targetCtx.lineTo(x + w - rad, y);
          targetCtx.quadraticCurveTo(x + w, y, x + w, y + rad);
          targetCtx.lineTo(x + w, y + h - rad);
          targetCtx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
          targetCtx.lineTo(x + rad, y + h);
          targetCtx.quadraticCurveTo(x, y + h, x, y + h - rad);
          targetCtx.lineTo(x, y + rad);
          targetCtx.quadraticCurveTo(x, y, x + rad, y);
          targetCtx.closePath();
        };

        const drawWindChevrons = (targetCtx, x, y, angle, count) => {
          const n = Math.max(0, Math.min(3, Math.round(Number(count) || 0)));
          if (!n) return;
          const chevronW = 7;
          const chevronH = 5;
          const spacing = 6;
          targetCtx.save();
          targetCtx.translate(x, y);
          targetCtx.rotate(angle);
          targetCtx.strokeStyle = 'rgba(245,242,235,0.96)';
          targetCtx.lineWidth = 4;
          targetCtx.lineCap = 'round';
          targetCtx.lineJoin = 'round';
          for (let i = 0; i < n; i++) {
            const cx = (i - (n - 1) / 2) * spacing;
            targetCtx.beginPath();
            targetCtx.moveTo(cx - chevronW * 0.5, -chevronH);
            targetCtx.lineTo(cx + chevronW * 0.5, 0);
            targetCtx.lineTo(cx - chevronW * 0.5, chevronH);
            targetCtx.stroke();
          }
          targetCtx.strokeStyle = 'rgba(80,80,80,0.88)';
          targetCtx.lineWidth = 2.2;
          for (let i = 0; i < n; i++) {
            const cx = (i - (n - 1) / 2) * spacing;
            targetCtx.beginPath();
            targetCtx.moveTo(cx - chevronW * 0.5, -chevronH);
            targetCtx.lineTo(cx + chevronW * 0.5, 0);
            targetCtx.lineTo(cx - chevronW * 0.5, chevronH);
            targetCtx.stroke();
          }
          targetCtx.restore();
        };

        drawPolyline(ctx, routeRibbon, 'rgba(245,242,235,0.6)', 10, 1);
        drawPolyline(ctx, routeRibbon, '#2F4858', 4, 1);
        drawPolyline(ctx, routeRibbon, 'rgba(255,255,255,0.6)', 1, 1);

        try {
          const minKmSpacing = 35;
          const minBadgePxSpacing = 72;
          const minWindPxSpacing = 64;
          let lastBadgeKm = -1e99;
          let lastBadgePt = null;
          let lastWindPt = null;
          let windIndex = 0;
          topCtx.save();

          for (const p of pts) {
            const dk = Number(p.dist);
            if (!Number.isFinite(dk)) continue;
            const routePt = routePointAtDist(dk);
            if (!routePt) continue;
            if (lastWindPt && Math.hypot(routePt.x - lastWindPt.x, routePt.y - lastWindPt.y) < minWindPxSpacing) continue;
            const sample = sampleAt(dk);
            if (!sample) continue;
            const chevronCount = windChevronCountForSample(sample);
            if (!chevronCount) continue;
            const angle = tangentAngleAtDist(dk);
            const nx = -Math.sin(angle);
            const ny = Math.cos(angle);
            const effWind = _tourEffectiveWind(sample, dk);
            const side = (windIndex % 2 === 0) ? -1 : 1;
            const chevronAngle = angle + ((Number.isFinite(effWind) && effWind < 0) ? Math.PI : 0);
            const windX = routePt.x + nx * side * 7;
            const windY = routePt.y + ny * side * 7;
            drawWindChevrons(topCtx, windX, windY, chevronAngle, chevronCount);
            lastWindPt = routePt;
            windIndex += 1;
          }

          for (const p of pts) {
            const dk = Number(p.dist);
            if (!Number.isFinite(dk) || (dk - lastBadgeKm) < minKmSpacing) continue;
            const routePt = routePointAtDist(dk);
            if (!routePt) continue;
            if (lastBadgePt && Math.hypot(routePt.x - lastBadgePt.x, routePt.y - lastBadgePt.y) < minBadgePxSpacing) continue;

            const sample = sampleAt(dk);
            if (!sample) continue;
            const icon = weatherIconForSample(sample);
            const temp = Number(sample.temperature);
            const tempText = Number.isFinite(temp) ? `${Math.round(temp)}°` : '–';
            const angle = tangentAngleAtDist(dk);
            const nx = -Math.sin(angle);
            const ny = Math.cos(angle);
            const labelX = routePt.x + nx * 16;
            const labelY = routePt.y + ny * 16;
            const connectorX = routePt.x + nx * 7;
            const connectorY = routePt.y + ny * 7;

            topCtx.textAlign = 'left';
            topCtx.textBaseline = 'middle';
            const iconFont = '22px -apple-system, BlinkMacSystemFont, "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
            const textFont = '500 16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            topCtx.font = iconFont;
            const iconW = Math.max(22, topCtx.measureText(icon).width);
            topCtx.font = textFont;
            const tempW = Math.max(19, topCtx.measureText(tempText).width);
            const badgePadX = 8;
            const badgePadY = 4;
            const contentGap = 7;
            const badgeW = Math.ceil(badgePadX * 2 + iconW + contentGap + tempW);
            const badgeH = 29;
            const badgeX = Math.round(labelX - badgeW / 2);
            const badgeY = Math.round(labelY - badgeH / 2);

            topCtx.strokeStyle = 'rgba(0,0,0,0.15)';
            topCtx.lineWidth = 1;
            topCtx.beginPath();
            topCtx.moveTo(connectorX, connectorY);
            topCtx.lineTo(routePt.x + nx * 10, routePt.y + ny * 10);
            topCtx.stroke();

            topCtx.save();
            topCtx.shadowColor = 'rgba(0,0,0,0.15)';
            topCtx.shadowBlur = 3;
            topCtx.shadowOffsetX = 0;
            topCtx.shadowOffsetY = 1;
            topCtx.fillStyle = 'rgba(255,255,255,0.85)';
            roundRect(topCtx, badgeX, badgeY, badgeW, badgeH, 6);
            topCtx.fill();
            topCtx.restore();

            const contentY = badgeY + badgeH / 2;
            let cursorX = badgeX + badgePadX;
            const iconChipSize = 22;
            const iconChipX = Math.round(cursorX - 1);
            const iconChipY = Math.round(contentY - iconChipSize / 2);
            topCtx.save();
            topCtx.shadowColor = 'rgba(0,0,0,0.08)';
            topCtx.shadowBlur = 2;
            topCtx.fillStyle = 'rgba(255,255,255,0.96)';
            roundRect(topCtx, iconChipX, iconChipY, iconChipSize + 3, iconChipSize, 6);
            topCtx.fill();
            topCtx.restore();

            topCtx.font = iconFont;
            topCtx.save();
            topCtx.shadowColor = 'rgba(255,255,255,0.9)';
            topCtx.shadowBlur = 1.5;
            topCtx.fillStyle = '#333';
            topCtx.fillText(icon, cursorX, contentY + 0.5);
            topCtx.restore();
            cursorX += iconW + contentGap;
            topCtx.font = textFont;
            topCtx.fillText(tempText, cursorX, contentY + 0.5);

            lastBadgeKm = dk;
            lastBadgePt = { x: labelX, y: labelY };
            badgeIndex += 1;
          }
          topCtx.restore();
        } catch (_) {}

        try { if (this._anim) cancelAnimationFrame(this._anim); } catch (_) {}
        this._anim = null;
        return;

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

        try { if (this._anim) cancelAnimationFrame(this._anim); } catch (_) {}
        this._anim = null;
        return;

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
  const STRATEGIC_COASTLINE_VERSION = '1';
  let STRATEGIC_LAND = null; // GeoJSON FeatureCollection
  let STRATEGIC_LAND_LOADING = false;
  // Higher-res shoreline source (used when includeSea=true)
  let STRATEGIC_SHORE_LAND = null; // GeoJSON FeatureCollection
  let STRATEGIC_SHORE_LOADING = false;
  // Ultra-res shoreline source (10m) for high zoom levels.
  let STRATEGIC_ULTRA_LAND = null; // GeoJSON FeatureCollection
  let STRATEGIC_ULTRA_LOADING = false;

  function _strategicPreferHiResLand() {
    try {
      const z = (map && typeof map.getZoom === 'function') ? Number(map.getZoom()) : 0;
      return Number.isFinite(z) ? (z >= 5) : false;
    } catch (_) {
      return false;
    }
  }

  function _strategicPreferUltraResLand() {
    try {
      const z = (map && typeof map.getZoom === 'function') ? Number(map.getZoom()) : 0;
      return Number.isFinite(z) ? (z >= 6) : false;
    } catch (_) {
      return false;
    }
  }

  function _strategicLandSourceForCurrentZoom() {
    const preferHi = _strategicPreferHiResLand();
    const preferUltra = _strategicPreferUltraResLand();

    const ultra = (STRATEGIC_ULTRA_LAND && STRATEGIC_ULTRA_LAND.features) ? STRATEGIC_ULTRA_LAND : null;
    const hi = (STRATEGIC_SHORE_LAND && STRATEGIC_SHORE_LAND.features) ? STRATEGIC_SHORE_LAND : null;
    const lo = (STRATEGIC_LAND && STRATEGIC_LAND.features) ? STRATEGIC_LAND : null;

    // Trigger lazy loading; render will refresh once ready.
    try { _ensureStrategicLandMaskLoaded(); } catch (_) {}
    if (preferHi) {
      try { _ensureStrategicShoreMaskLoaded(); } catch (_) {}
    }
    if (preferUltra) {
      try { _ensureStrategicUltraMaskLoaded(); } catch (_) {}
    }

    // Prefer higher resolution only when zoomed in; otherwise use 110m for speed + less visual noise.
    if (preferUltra && ultra) return ultra;
    if (preferHi && hi) return hi;
    return lo || hi || ultra;
  }

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

  function _geoRingBbox(ring) {
    try {
      if (!Array.isArray(ring) || ring.length < 2) return null;
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      for (const pt of ring) {
        if (!pt || pt.length < 2) continue;
        const lon = Number(pt[0]);
        const lat = Number(pt[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
        minLon = Math.min(minLon, lon);
        maxLon = Math.max(maxLon, lon);
      }
      if (!(minLat <= maxLat && minLon <= maxLon)) return null;
      return { minLat, maxLat, minLon, maxLon };
    } catch (_) {
      return null;
    }
  }

  function _prepareFeatureRings(feature) {
    try {
      const g = feature && feature.geometry;
      if (!g || !g.type || !g.coordinates) return null;
      const out = [];
      if (g.type === 'Polygon') {
        for (const ring of g.coordinates) {
          const bb = _geoRingBbox(ring);
          if (bb) out.push({ bb, ring });
        }
        return out;
      }
      if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates) {
          for (const ring of poly) {
            const bb = _geoRingBbox(ring);
            if (bb) out.push({ bb, ring });
          }
        }
        return out;
      }
      return null;
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
      const r = await fetch(`/ne_110m_land.geojson?v=${encodeURIComponent(STRATEGIC_COASTLINE_VERSION)}`, { cache: 'force-cache' });
      const j = await r.json();
      if (j && j.type === 'FeatureCollection' && Array.isArray(j.features)) {
        // Precompute bboxes for quick culling.
        for (const f of j.features) {
          try { f.__bbox = _geoFeatureBbox(f); } catch (_) {}
          try { f.__rings = _prepareFeatureRings(f); } catch (_) {}
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
      const r = await fetch(`/ne_50m_land.geojson?v=${encodeURIComponent(STRATEGIC_COASTLINE_VERSION)}`, { cache: 'force-cache' });
      const j = await r.json();
      if (j && j.type === 'FeatureCollection' && Array.isArray(j.features)) {
        // Precompute bboxes for quick culling.
        for (const f of j.features) {
          try { f.__bbox = _geoFeatureBbox(f); } catch (_) {}
          try { f.__rings = _prepareFeatureRings(f); } catch (_) {}
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

  async function _ensureStrategicUltraMaskLoaded() {
    if (STRATEGIC_ULTRA_LAND || STRATEGIC_ULTRA_LOADING) return;
    STRATEGIC_ULTRA_LOADING = true;
    try {
      const r = await fetch(`/ne_10m_land.geojson?v=${encodeURIComponent(STRATEGIC_COASTLINE_VERSION)}`, { cache: 'force-cache' });
      const j = await r.json();
      if (j && j.type === 'FeatureCollection' && Array.isArray(j.features)) {
        // Precompute bboxes for quick culling.
        for (const f of j.features) {
          try { f.__bbox = _geoFeatureBbox(f); } catch (_) {}
          try { f.__rings = _prepareFeatureRings(f); } catch (_) {}
        }
        STRATEGIC_ULTRA_LAND = j;
      }
    } catch (e) {
      console.warn('Ultra shore mask load failed', e);
    } finally {
      STRATEGIC_ULTRA_LOADING = false;
      try { if (STRATEGIC_STATE && STRATEGIC_STATE.active) _renderStrategic(); } catch (_) {}
    }
  }

  function _beginStrategicLandClip(ctx) {
    // Returns true if a clip was applied (caller must ctx.restore()).
    if (!ctx) return false;
    if (SETTINGS && SETTINGS.includeSea) return false;
    const src = _strategicLandSourceForCurrentZoom();
    if (!src || !src.features) {
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

    const drawFeature = (f) => {
      if (!f) return;
      const rings = f.__rings;
      if (rings && Array.isArray(rings) && rings.length) {
        for (const r of rings) {
          if (!r) continue;
          if (view && r.bb && !_bboxIntersects(r.bb, view)) continue;
          drawRing(r.ring);
        }
        return;
      }
      const g = f.geometry;
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

    for (const f of src.features) {
      if (!f) continue;
      if (view) {
        const bb = f.__bbox;
        if (bb && !_bboxIntersects(bb, view)) continue;
      }
      drawFeature(f);
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
    const src = _strategicLandSourceForCurrentZoom();
    if (!src || !src.features) {
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

    const zNow = (map && typeof map.getZoom === 'function') ? Number(map.getZoom()) : 7;
    const isUltra = (src === STRATEGIC_ULTRA_LAND);
    const isHi = (src === STRATEGIC_SHORE_LAND);
    // Decimate only for stroke to reduce path complexity (keeps clip exact).
    const minPxDist = isUltra ? ((zNow >= 10) ? 0.6 : 0.9) : (isHi ? 0.4 : 0.0);

    const drawRing = (ring) => {
      if (!Array.isArray(ring) || ring.length < 2) return;
      let started = false;
      let lastX = NaN, lastY = NaN;
      for (const pt of ring) {
        if (!pt || pt.length < 2) continue;
        const lon = Number(pt[0]);
        const lat = Number(pt[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const q = map.latLngToContainerPoint([lat, lon]);
        if (minPxDist > 0 && Number.isFinite(lastX) && Number.isFinite(lastY)) {
          const dx = q.x - lastX;
          const dy = q.y - lastY;
          if ((dx * dx + dy * dy) < (minPxDist * minPxDist)) {
            continue;
          }
        }
        if (!started) { ctx.moveTo(q.x, q.y); started = true; }
        else ctx.lineTo(q.x, q.y);
        lastX = q.x;
        lastY = q.y;
      }
      if (started) ctx.closePath();
    };

    const drawFeature = (f) => {
      if (!f) return;
      const rings = f.__rings;
      if (rings && Array.isArray(rings) && rings.length) {
        for (const r of rings) {
          if (!r) continue;
          if (view && r.bb && !_bboxIntersects(r.bb, view)) continue;
          drawRing(r.ring);
        }
        return;
      }
      const g = f.geometry;
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
      // Softer coastline line; resolution increases with zoom (110m→50m→10m) via the selected source.
      ctx.strokeStyle = 'rgba(90,90,90,0.48)';
      const z = zNow;
      ctx.lineWidth = (z >= 10) ? 2.0 : ((z >= 8) ? 1.7 : ((z >= 6) ? 1.4 : 1.2));
    } catch (_) {}

    ctx.beginPath();
    for (const f of src.features) {
      if (!f) continue;
      if (view) {
        const bb = f.__bbox;
        if (bb && !_bboxIntersects(bb, view)) continue;
      }
      drawFeature(f);
    }
    try { ctx.stroke(); } catch (_) {}
    ctx.restore();
  }

  // --- Strategic cursor readout (tooltip) ---
  let STRATEGIC_CURSOR_EL = null;
  let STRATEGIC_CURSOR_MARKER = null;
  const STRATEGIC_LOCATION_LABEL_CACHE = new Map();
  const STRATEGIC_LOCATION_LABEL_INFLIGHT = new Map();
  let STRATEGIC_LOCATION_LABEL_TIMER = null;
  let STRATEGIC_CURSOR_LOCATION_KEY = '';

  function _strategicLocationLabelKey(lat, lon) {
    const latF = Number(lat);
    const lonF = Number(lon);
    if (!Number.isFinite(latF) || !Number.isFinite(lonF)) return '';
    return `${latF.toFixed(3)},${lonF.toFixed(3)}`;
  }

  function _strategicLocationFallbackLabel(lat, lon) {
    return `${_fmtNum(lat, 3)}, ${_fmtNum(lon, 3)}`;
  }

  function _htmlEsc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _buildMetricTooltipCardHtml(payload) {
    const p = (payload && typeof payload === 'object') ? payload : {};
    const rows = Array.isArray(p.rows) ? p.rows : [];
    const iconMarkup = String(p.iconMarkup || '');
    return [
      `<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;">${iconMarkup}<div data-role="location" style="font-size:13px;font-weight:700;color:#0f172a;">${_htmlEsc(p.location || '—')}</div></div>`,
      `<div style="font-size:11px;color:#475569;margin-bottom:8px;">${_htmlEsc(p.period || '')}</div>`,
      '<div style="display:grid;grid-template-columns:auto auto;column-gap:14px;row-gap:5px;align-items:start;">',
      rows.map((row) => `<div style="font-size:11px;font-weight:700;color:#334155;">${_htmlEsc(row && row.label)}</div><div style="font-size:11px;color:#0f172a;text-align:right;white-space:nowrap;">${_htmlEsc(row && row.value)}</div>`).join(''),
      '</div>',
    ].join('');
  }

  function _renderStrategicCursorReadoutCard(payload) {
    if (!STRATEGIC_CURSOR_EL) return;
    STRATEGIC_CURSOR_EL.innerHTML = _buildMetricTooltipCardHtml(payload);
  }

  function _requestLocationLabel(lat, lon, onReady) {
    try {
      const key = _strategicLocationLabelKey(lat, lon);
      if (!key) return;
      if (STRATEGIC_LOCATION_LABEL_CACHE.has(key)) {
        try { onReady(STRATEGIC_LOCATION_LABEL_CACHE.get(key), key); } catch (_) {}
        return;
      }
      if (STRATEGIC_LOCATION_LABEL_INFLIGHT.has(key)) {
        try {
          STRATEGIC_LOCATION_LABEL_INFLIGHT.get(key)
            .then((label) => { try { onReady(label, key); } catch (_) {} })
            .catch(() => {});
        } catch (_) {}
        return;
      }
      const req = fetch(`/api/location_label?lat=${encodeURIComponent(String(Number(lat).toFixed(6)))}&lon=${encodeURIComponent(String(Number(lon).toFixed(6)))}`, {
        cache: 'force-cache',
      })
        .then((r) => r.ok ? r.json() : null)
        .then((j) => {
          const location = (j && typeof j.location === 'string') ? String(j.location).trim() : '';
          const name = (j && typeof j.location_name === 'string') ? String(j.location_name).trim() : '';
          const country = (j && typeof j.location_country === 'string') ? String(j.location_country).trim() : '';
          const finalLabel = location || (name ? `${name}${country ? ` (${country})` : ''}` : '') || _strategicLocationFallbackLabel(lat, lon);
          STRATEGIC_LOCATION_LABEL_CACHE.set(key, finalLabel);
          try { onReady(finalLabel, key); } catch (_) {}
          return finalLabel;
        })
        .catch(() => {
          const fallback = _strategicLocationFallbackLabel(lat, lon);
          STRATEGIC_LOCATION_LABEL_CACHE.set(key, fallback);
          try { onReady(fallback, key); } catch (_) {}
          return fallback;
        })
        .finally(() => {
          try { STRATEGIC_LOCATION_LABEL_INFLIGHT.delete(key); } catch (_) {}
        });
      STRATEGIC_LOCATION_LABEL_INFLIGHT.set(key, req);
    } catch (_) {}
  }

  function _renderTourCursorReadout(payload) {
    LAST_TOUR_CURSOR_READOUT = (payload && typeof payload === 'object') ? payload : null;
    if (!profileTooltip) return;
    const info = LAST_TOUR_CURSOR_READOUT;
    if (!info) {
      if (_initializeTourCursorReadoutFromStart()) return;
      profileTooltip.dataset.locationKey = '';
      profileTooltip.innerHTML = `
        <div class="wm-tour-band-card wm-tour-vdl-card wm-tour-vdl-empty">
          <div class="wm-tour-vdl-kicker">Vertical Day Line</div>
          <div class="wm-tour-vdl-location" data-role="location">—</div>
          <div class="wm-tour-vdl-meta"></div>
          <div class="wm-tour-vdl-grid">
            <div class="wm-tour-vdl-metric">
              <div class="wm-tour-vdl-label">Temp</div>
              <div class="wm-tour-vdl-value">—</div>
            </div>
            <div class="wm-tour-vdl-metric">
              <div class="wm-tour-vdl-label">Wind</div>
              <div class="wm-tour-vdl-value">—</div>
            </div>
            <div class="wm-tour-vdl-metric">
              <div class="wm-tour-vdl-label">Rain</div>
              <div class="wm-tour-vdl-value">—</div>
            </div>
          </div>
        </div>`;
      profileTooltip.style.visibility = 'visible';
      profileTooltip.style.opacity = '1';
      return;
    }
    profileTooltip.dataset.locationKey = String(info.locationKey || '');
    profileTooltip.innerHTML = `
      <div class="wm-tour-band-card wm-tour-vdl-card">
        <div class="wm-tour-vdl-kicker">Vertical Day Line</div>
        <div class="wm-tour-vdl-location" data-role="location">${_htmlEsc(info.location || '—')}</div>
        <div class="wm-tour-vdl-meta">${_htmlEsc(info.meta || '')}</div>
        <div class="wm-tour-vdl-grid">
          <div class="wm-tour-vdl-metric">
            <div class="wm-tour-vdl-label">Temp</div>
            <div class="wm-tour-vdl-value">${_htmlEsc(info.tempText || '—')}</div>
          </div>
          <div class="wm-tour-vdl-metric">
            <div class="wm-tour-vdl-label">Wind</div>
            <div class="wm-tour-vdl-value">${_htmlEsc(info.windText || '—')}</div>
          </div>
          <div class="wm-tour-vdl-metric">
            <div class="wm-tour-vdl-label">Rain</div>
            <div class="wm-tour-vdl-value">${_htmlEsc(info.rainText || '—')}</div>
          </div>
        </div>
      </div>`;
    profileTooltip.style.visibility = 'visible';
    profileTooltip.style.opacity = '1';
  }

  function _initializeTourCursorReadoutFromStart() {
    try {
      if (!_tourIsActive() || !LAST_PROFILE || !Array.isArray(PROFILE_XS) || !PROFILE_XS.length) return false;
      const startX = Number(PROFILE_XS[0]);
      if (!Number.isFinite(startX)) return false;
      window.updateProfileCursor(0, startX);
      return true;
    } catch (_) {
      return false;
    }
  }

  window.updateTourCursorAtDistance = function(routeKm) {
    try {
      const target = _tourProfileCursorTargetAtDistance(routeKm);
      if (target && Number.isFinite(Number(target.index)) && Number.isFinite(Number(target.xDisplay))) {
        window.updateProfileCursor(Number(target.index), Number(target.xDisplay));
        return true;
      }
      window.updateMapCursorAtDistance(routeKm);
    } catch (_) {}
    return false;
  };

  function _setStrategicCursorLocationLine(label, key) {
    try {
      if (!STRATEGIC_CURSOR_EL || STRATEGIC_CURSOR_EL.style.display === 'none') return;
      if (!key || STRATEGIC_CURSOR_LOCATION_KEY !== key) return;
      const node = STRATEGIC_CURSOR_EL.querySelector('[data-role="location"]');
      if (node) node.textContent = String(label || '—');
      else {
        _renderStrategicCursorReadoutCard({
          location: label || '—',
          period: '',
          rows: [],
        });
      }
    } catch (_) {}
  }

  function _queueStrategicLocationLabel(lat, lon) {
    const key = _strategicLocationLabelKey(lat, lon);
    if (!key) return key;
    if (STRATEGIC_LOCATION_LABEL_CACHE.has(key)) {
      _setStrategicCursorLocationLine(STRATEGIC_LOCATION_LABEL_CACHE.get(key), key);
      return key;
    }
    if (STRATEGIC_LOCATION_LABEL_TIMER) {
      try { clearTimeout(STRATEGIC_LOCATION_LABEL_TIMER); } catch (_) {}
      STRATEGIC_LOCATION_LABEL_TIMER = null;
    }
    STRATEGIC_LOCATION_LABEL_TIMER = setTimeout(async () => {
      STRATEGIC_LOCATION_LABEL_TIMER = null;
      if (STRATEGIC_CURSOR_LOCATION_KEY !== key) return;
      if (STRATEGIC_LOCATION_LABEL_CACHE.has(key)) {
        _setStrategicCursorLocationLine(STRATEGIC_LOCATION_LABEL_CACHE.get(key), key);
        return;
      }
      if (STRATEGIC_LOCATION_LABEL_INFLIGHT.has(key)) return;
      const ac = new AbortController();
      const timeoutId = setTimeout(() => {
        try { ac.abort(); } catch (_) {}
      }, 3500);
      const req = fetch(`/api/location_label?lat=${encodeURIComponent(String(Number(lat).toFixed(6)))}&lon=${encodeURIComponent(String(Number(lon).toFixed(6)))}`, {
        signal: ac.signal,
      })
        .then((res) => res.ok ? res.json() : null)
        .then((payload) => {
          const name = payload && typeof payload.location === 'string' ? String(payload.location || '').trim() : '';
          const finalLabel = name || _strategicLocationFallbackLabel(lat, lon);
          STRATEGIC_LOCATION_LABEL_CACHE.set(key, finalLabel);
          _setStrategicCursorLocationLine(finalLabel, key);
        })
        .catch(() => {
          STRATEGIC_LOCATION_LABEL_CACHE.set(key, _strategicLocationFallbackLabel(lat, lon));
        })
        .finally(() => {
          try { clearTimeout(timeoutId); } catch (_) {}
          STRATEGIC_LOCATION_LABEL_INFLIGHT.delete(key);
        });
      STRATEGIC_LOCATION_LABEL_INFLIGHT.set(key, req);
      await req;
    }, 140);
    return key;
  }

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
      el.style.fontFamily = 'system-ui, -apple-system, sans-serif';
      el.style.fontSize = '11px';
      el.style.lineHeight = '1.35';
      el.style.color = '#0f172a';
      el.style.background = 'rgba(255,255,255,0.95)';
      el.style.border = '1px solid rgba(15,23,42,0.10)';
      el.style.borderRadius = '16px';
      el.style.padding = '10px 12px';
      el.style.backdropFilter = 'blur(8px)';
      el.style.boxShadow = '0 14px 34px rgba(15,23,42,0.18)';
      el.style.minWidth = '176px';
      el.style.maxWidth = '240px';

      try { document.body.appendChild(el); } catch (_) { return null; }
      STRATEGIC_CURSOR_EL = el;
      return el;
    } catch (_) {
      return null;
    }
  }

  function _hideStrategicCursorReadout() {
    const el = STRATEGIC_CURSOR_EL;
    if (el) el.style.display = 'none';
    STRATEGIC_CURSOR_LOCATION_KEY = '';
    if (STRATEGIC_LOCATION_LABEL_TIMER) {
      try { clearTimeout(STRATEGIC_LOCATION_LABEL_TIMER); } catch (_) {}
      STRATEGIC_LOCATION_LABEL_TIMER = null;
    }
    try {
      if (STRATEGIC_CURSOR_MARKER && STRATEGIC_CURSOR_MARKER._map) {
        STRATEGIC_CURSOR_MARKER._map.removeLayer(STRATEGIC_CURSOR_MARKER);
      }
    } catch (_) {}
    STRATEGIC_CURSOR_MARKER = null;
  }

  function _ensureStrategicCursorMarker(latlng) {
    try {
      if (!latlng || !map) return null;
      if (!STRATEGIC_CURSOR_MARKER) {
        try {
          if (!map.getPane('wmStrategicCursorPane')) {
            map.createPane('wmStrategicCursorPane');
            map.getPane('wmStrategicCursorPane').style.zIndex = '701';
          }
        } catch (_) {}
        STRATEGIC_CURSOR_MARKER = L.circleMarker(latlng, {
          pane: 'wmStrategicCursorPane',
          radius: 8,
          color: 'rgba(15, 23, 42, 0.88)',
          weight: 2,
          fillColor: 'rgba(255,255,255,0.95)',
          fillOpacity: 0.9,
        });
        STRATEGIC_CURSOR_MARKER.addTo(map);
      } else {
        STRATEGIC_CURSOR_MARKER.setLatLng(latlng);
      }
      try { STRATEGIC_CURSOR_MARKER.bringToFront(); } catch (_) {}
      return STRATEGIC_CURSOR_MARKER;
    } catch (_) {
      return null;
    }
  }

  function _strategicEventLatLngAndPoint(ev) {
    let ll = null;
    let pt = null;
    try {
      const touch = ev && ev.touches && ev.touches[0]
        ? ev.touches[0]
        : (ev && ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0] : null);
      if (touch) {
        const rect = map && map.getContainer ? map.getContainer().getBoundingClientRect() : null;
        const clientX = Number(touch.clientX);
        const clientY = Number(touch.clientY);
        if (rect && Number.isFinite(clientX) && Number.isFinite(clientY)) {
          const cp = L.point(clientX - rect.left, clientY - rect.top);
          pt = cp;
          ll = map.containerPointToLatLng ? map.containerPointToLatLng(cp) : null;
        }
      } else {
        ll = map.mouseEventToLatLng ? map.mouseEventToLatLng(ev) : null;
        pt = map.mouseEventToContainerPoint ? map.mouseEventToContainerPoint(ev) : (ll ? map.latLngToContainerPoint(ll) : null);
      }
    } catch (_) {
      ll = null;
      pt = null;
    }
    return { ll, pt };
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
    years: (SETTINGS && Array.isArray(SETTINGS.strategicYears) && SETTINGS.strategicYears.length)
      ? _uniqYearsDesc(SETTINGS.strategicYears)
      : [Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR)],
    year: (SETTINGS && Array.isArray(SETTINGS.strategicYears) && SETTINGS.strategicYears.length)
      ? Number(_uniqYearsDesc(SETTINGS.strategicYears)[0] || SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR)
      : Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR),
    mode: (SETTINGS && String(SETTINGS.strategicMode || '') === 'full_day') ? 'full_day' : 'active',
    // Phase 2: range selection stored as start/end DOY (inclusive).
    rangeStartDoy: 1,
    rangeEndDoy: 14,
    // Keep a representative DOY for legacy helpers (we keep it as rangeStart).
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
    _clickHandler: null,
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

  function _clampDOYInt(d) {
    const v = Math.round(Number(d) || 1);
    return Math.max(1, Math.min(365, v));
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

  function _isoDateFromDOY(doyInt, year) {
    const y = Number(year || STRATEGIC_DEFAULT_YEAR);
    const md = _doyToMonthDay(_clampDOYInt(doyInt));
    const mm = _pad2(md.month);
    const dd = _pad2(md.day);
    return `${String(y)}-${mm}-${dd}`;
  }

  function _strategicUsingRangeUI() {
    return Boolean(strategicRangeStart && strategicRangeEnd);
  }

  function _strategicGetRangeDOY() {
    const s = _clampDOYInt(STRATEGIC_STATE.rangeStartDoy);
    const e = _clampDOYInt(STRATEGIC_STATE.rangeEndDoy);
    const startDoy = Math.min(s, e);
    const endDoy = Math.max(s, e);
    const durationDays = Math.max(1, Math.round(endDoy - startDoy + 1));
    return { startDoy, endDoy, durationDays };
  }

  function _strategicFmtDayMonthCompact(doyInt) {
    const md = _doyToMonthDay(_clampDOYInt(doyInt));
    // Requirement: x.y style (no padding), interpreted as day.month.
    return `${md.day}.${md.month}`;
  }

  function _strategicCustomTimescaleLabel() {
    const { startDoy, endDoy, durationDays } = _strategicGetRangeDOY();
    return `Custom (${_strategicFmtDayMonthCompact(startDoy)}–${_strategicFmtDayMonthCompact(endDoy)} = ${durationDays} days)`;
  }

  function _strategicUpdateCustomOptionLabel(sel) {
    if (!sel) return;
    try {
      const opt = sel.querySelector('option[value="custom"]');
      if (opt) opt.textContent = _strategicCustomTimescaleLabel();
    } catch (_) {}
  }

  function _strategicExpectedRangeForTimescale(anchorDoy, timescale) {
    const y = Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
    const ts = String(timescale || 'daily');
    if (ts === 'custom') return null;
    const p = _strategicPeriodForDOY(_clampDOYInt(anchorDoy), ts, y);
    if (!p) return null;
    return { startDoy: _clampDOYInt(p.startDoy), endDoy: _clampDOYInt(p.endDoy) };
  }

  function _strategicDetectStandardTimescaleForCurrentRange() {
    const { startDoy, endDoy } = _strategicGetRangeDOY();
    const candidates = ['daily', 'week', 'two_week', 'month', 'quarter', 'year'];
    for (const ts of candidates) {
      const exp = _strategicExpectedRangeForTimescale(startDoy, ts);
      if (!exp) continue;
      if (exp.startDoy === startDoy && exp.endDoy === endDoy) return ts;
    }
    return 'custom';
  }

  function _strategicSyncTimescaleSelectsFromRange() {
    if (!_strategicUsingRangeUI()) return;
    const inferred = _strategicDetectStandardTimescaleForCurrentRange();
    try { STRATEGIC_STATE.timescale = inferred; } catch (_) {}

    _strategicUpdateCustomOptionLabel(strategicTimescaleSelect);
    _strategicUpdateCustomOptionLabel(STRATEGIC_LEGEND_TIMESCALE_SELECT);

    try {
      if (strategicTimescaleSelect && strategicTimescaleSelect.value !== inferred) strategicTimescaleSelect.value = inferred;
    } catch (_) {}
    try {
      if (STRATEGIC_LEGEND_TIMESCALE_SELECT && STRATEGIC_LEGEND_TIMESCALE_SELECT.value !== inferred) STRATEGIC_LEGEND_TIMESCALE_SELECT.value = inferred;
    } catch (_) {}
  }

  function _strategicApplyTimescaleSelection(ts) {
    const value = String(ts || 'daily');

    if (_strategicUsingRangeUI()) {
      if (value === 'custom') {
        _strategicSyncTimescaleSelectsFromRange();
        return;
      }
      const { startDoy } = _strategicGetRangeDOY();
      const exp = _strategicExpectedRangeForTimescale(startDoy, value);
      if (exp) {
        try { STRATEGIC_STATE.timescale = value; } catch (_) {}
        try { SETTINGS.climateTimescale = value; saveSettings(SETTINGS); } catch (_) {}
        _strategicSetRange(exp.startDoy, exp.endDoy, { skipFetch: false });
      }
      return;
    }

    // Legacy mode
    try { STRATEGIC_STATE.timescale = value; } catch (_) {}
    try { SETTINGS.climateTimescale = value; saveSettings(SETTINGS); } catch (_) {}
    try { _strategicApplyTimescaleUI(); } catch (_) {}
    _scheduleStrategicFetch('timescale');
  }

  function _strategicRangeLabelParts() {
    const y = Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
    const { startDoy, endDoy, durationDays } = _strategicGetRangeDOY();
    const sDM = _doyToDM(startDoy);
    const eDM = _doyToDM(endDoy);
    if (durationDays <= 1) {
      return {
        shortLabel: `${sDM.monthName} ${sDM.day}`,
        monitorLabel: `Range: ${_fmtDM(sDM)} (1d)`,
      };
    }
    return {
      shortLabel: `${sDM.monthName} ${sDM.day} – ${eDM.monthName} ${eDM.day} (${durationDays}d)`,
      monitorLabel: `Range: ${_fmtDM(sDM)}–${_fmtDM(eDM)} (${durationDays}d)`,
    };
  }

  function _strategicSyncRangeSelectedUI() {
    if (!strategicRangeWrap || !strategicRangeSelected) return;
    const { startDoy, endDoy, durationDays } = _strategicGetRangeDOY();
    const leftPct = ((startDoy - 1) / 365) * 100;
    const widthPct = (durationDays / 365) * 100;
    strategicRangeSelected.style.left = `${Math.max(0, Math.min(100, leftPct))}%`;
    strategicRangeSelected.style.width = `${Math.max(0.4, Math.min(100, widthPct))}%`;
    try {
      if (strategicRangeTooltip) {
        const centerPct = Math.max(0, Math.min(100, leftPct + 0.5 * widthPct));
        strategicRangeTooltip.style.left = `${centerPct}%`;
      }
    } catch (_) {}

    // Position explicit L/R thumb elements.
    try {
      if (strategicRangeThumbStart) strategicRangeThumbStart.style.left = '0%';
      if (strategicRangeThumbEnd) strategicRangeThumbEnd.style.left = '100%';
    } catch (_) {}
  }

  function _strategicSetActiveRangeElement(which) {
    const w = String(which || '');
    try {
      if (strategicRangeThumbStart) strategicRangeThumbStart.classList.toggle('wm-active', w === 'L');
      if (strategicRangeHandle) strategicRangeHandle.classList.toggle('wm-active', w === 'C');
      if (strategicRangeThumbEnd) strategicRangeThumbEnd.classList.toggle('wm-active', w === 'R');
    } catch (_) {}
  }

  function _strategicDoyFromClientX(clientX) {
    if (!strategicRangeWrap) return 1;
    const rect = strategicRangeWrap.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const x = Math.max(0, Math.min(w, Number(clientX) - rect.left));
    const doy = 1 + Math.round((x / w) * 365);
    return _clampDOYInt(doy);
  }

  let _strategicRangeTooltipTimer = null;
  function _strategicShowRangeTooltip() {
    if (!strategicRangeTooltip) return;
    try {
      const { startDoy, endDoy, durationDays } = _strategicGetRangeDOY();
      const y = Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
      const sDM = _doyToDM(startDoy);
      const eDM = _doyToDM(endDoy);
      strategicRangeTooltip.textContent = (durationDays <= 1)
        ? `${_fmtDMY(sDM, y)}`
        : `${_fmtDM(sDM)}–${_fmtDM(eDM)}${String(y)} (${durationDays}d)`;
      strategicRangeTooltip.style.display = '';
      if (_strategicRangeTooltipTimer) {
        try { clearTimeout(_strategicRangeTooltipTimer); } catch (_) {}
      }
      _strategicRangeTooltipTimer = setTimeout(() => {
        try { if (strategicRangeTooltip) strategicRangeTooltip.style.display = 'none'; } catch (_) {}
      }, 900);
    } catch (_) {}
  }

  function _renderStrategicSliderTicks(timescale) {
    if (!strategicMonthTicks) return;
    strategicMonthTicks.innerHTML = '';
    const ts = String(timescale || 'daily');

    // Phase 2 range slider always uses 1..365 axis (month boundaries).
    if (_strategicUsingRangeUI()) {
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
    if (_tourIsActive()) {
      const info = _tourDateRangeInfo();
      const shortTxt = `${_fmtIsoDayMonthCompact(info.startIso)}–${_fmtIsoDayMonthCompact(info.endIso)}`;
      const monitorTxt = `${shortTxt} • ${Math.max(1, info.totalDays)}d`;
      if (strategicDayLabel) strategicDayLabel.textContent = shortTxt;
      if (strategicTimelineLabel) strategicTimelineLabel.textContent = monitorTxt;
      _strategicSyncRangeSelectedUI();
      return;
    }
    if (_strategicUsingRangeUI()) {
      const lp = _strategicRangeLabelParts();
      if (strategicDayLabel) strategicDayLabel.textContent = String(lp.shortLabel || '—');
      if (strategicTimelineLabel) strategicTimelineLabel.textContent = String(lp.monitorLabel || '—');
      _strategicSyncRangeSelectedUI();
      return;
    }
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

  function _strategicSetRange(startDoy, endDoy, opts) {
    const s = _clampDOYInt(startDoy);
    const e = _clampDOYInt(endDoy);
    const start = Math.min(s, e);
    const end = Math.max(s, e);
    STRATEGIC_STATE.rangeStartDoy = start;
    STRATEGIC_STATE.rangeEndDoy = end;
    STRATEGIC_STATE.doy = start;
    try {
      if (strategicRangeStart) strategicRangeStart.value = String(start);
      if (strategicRangeEnd) strategicRangeEnd.value = String(end);
    } catch (_) {}
    _strategicSetLabels();
    _strategicSyncTimescaleSelectsFromRange();
    _updateStrategicLegend();
    _strategicShowRangeTooltip();
    if (_tourIsActive()) {
      _tourApplyRangeToInputs(start, end, { skipRefresh: Boolean(opts && opts.skipFetch) });
      return;
    }
    try {
      if (_climateProfileIsActive() && CLIMATE_PROFILE_STATE.selectedPoint) {
        _scheduleClimateProfileForPoint(CLIMATE_PROFILE_STATE.selectedPoint, { force: true });
      }
    } catch (_) {}
    if (!(opts && opts.skipFetch)) _scheduleStrategicFetch('range');
  }

  function _strategicSetDOY(doyVal) {
    // Legacy entrypoint; in range mode, treat this as moving the whole window.
    if (_strategicUsingRangeUI()) {
      const { durationDays } = _strategicGetRangeDOY();
      const start = _clampDOYInt(doyVal);
      const maxStart = Math.max(1, 365 - durationDays + 1);
      const s2 = Math.max(1, Math.min(maxStart, start));
      const e2 = Math.max(s2, Math.min(365, s2 + durationDays - 1));
      _strategicSetRange(s2, e2, { skipFetch: false });
      return;
    }
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
    try {
      const dt = new Date(Date.UTC(2021, Math.max(0, Number(d.month || 1) - 1), Math.max(1, Number(d.day || 1))));
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch (_) {
      return `${_pad2(d.day)}.${_pad2(d.month)}.`;
    }
  }

  function _fmtDMY(d, year) {
    try {
      const dt = new Date(Date.UTC(Number(year) || 2021, Math.max(0, Number(d.month || 1) - 1), Math.max(1, Number(d.day || 1))));
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    } catch (_) {
      return `${_pad2(d.day)}.${_pad2(d.month)}.${String(year)}`;
    }
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
    if (_strategicUsingRangeUI()) {
      try {
        if (strategicRangeStart) {
          strategicRangeStart.min = '1';
          strategicRangeStart.max = '365';
          strategicRangeStart.step = '1';
        }
        if (strategicRangeEnd) {
          strategicRangeEnd.min = '1';
          strategicRangeEnd.max = '365';
          strategicRangeEnd.step = '1';
        }
      } catch (_) {}
      try { _renderStrategicSliderTicks('daily'); } catch (_) {}
      _strategicSetLabels();
      _strategicSyncTimescaleSelectsFromRange();
      _updateStrategicLegend();
      return;
    }

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

  function _coverageBBoxFromPoints(points) {
    try {
      let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
      let n = 0;
      for (const p of (points || [])) {
        if (!p) continue;
        const lat = Number(p.lat);
        const lon = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        n++;
        if (lat < latMin) latMin = lat;
        if (lat > latMax) latMax = lat;
        if (lon < lonMin) lonMin = lon;
        if (lon > lonMax) lonMax = lon;
      }
      if (n <= 0) return null;
      return { latMin, latMax, lonMin, lonMax };
    } catch (_) {
      return null;
    }
  }

  function _makeTileMap(points) {
    const m = new Map();
    let rowMin = Infinity;
    let rowMax = -Infinity;
    let colMin = Infinity;
    let colMax = -Infinity;
    for (const p of (points || [])) {
      if (!(p && p.tile_id)) continue;
      m.set(String(p.tile_id), p);
      const row = Number(p.row);
      const col = Number(p.col);
      if (Number.isFinite(row)) {
        rowMin = Math.min(rowMin, row);
        rowMax = Math.max(rowMax, row);
      }
      if (Number.isFinite(col)) {
        colMin = Math.min(colMin, col);
        colMax = Math.max(colMax, col);
      }
    }
    m.__rowMin = Number.isFinite(rowMin) ? rowMin : null;
    m.__rowMax = Number.isFinite(rowMax) ? rowMax : null;
    m.__colMin = Number.isFinite(colMin) ? colMin : null;
    m.__colMax = Number.isFinite(colMax) ? colMax : null;
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
    const rowMin = Number.isFinite(Number(tileMap.__rowMin)) ? Number(tileMap.__rowMin) : null;
    const rowMax = Number.isFinite(Number(tileMap.__rowMax)) ? Number(tileMap.__rowMax) : null;
    const colMinBound = Number.isFinite(Number(tileMap.__colMin)) ? Number(tileMap.__colMin) : null;
    const colMaxBound = Number.isFinite(Number(tileMap.__colMax)) ? Number(tileMap.__colMax) : null;
    const row0Raw = Math.floor((lat - latMin) / stepLat);
    const row0 = (rowMin !== null && rowMax !== null)
      ? Math.max(rowMin, Math.min(Math.max(rowMin, rowMax - 1), row0Raw))
      : row0Raw;
    const latC0 = latMin + (row0 + 0.5) * stepLat;
    const latC1 = latC0 + stepLat;
    const tLat = _clamp01((lat - latC0) / Math.max(1e-9, (latC1 - latC0)));

    function rowValue(row, latC) {
      const c = Math.max(0.05, Math.cos(latC * Math.PI / 180));
      const stepLon = tileKm / (111.32 * c);
      const col0Raw = Math.floor((lon - lonMin) / stepLon);
      const col0 = (colMinBound !== null && colMaxBound !== null)
        ? Math.max(colMinBound, Math.min(Math.max(colMinBound, colMaxBound - 1), col0Raw))
        : col0Raw;
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
          lucky_day_count: (p && (p.lucky_day_count !== undefined)) ? Number(p.lucky_day_count) : null,
          lucky_ride_count: (p && (p.lucky_ride_count !== undefined)) ? Number(p.lucky_ride_count) : null,
        };
      }

      function num(p, k) {
        if (!p) return null;
        const v = Number(p[k]);
        return Number.isFinite(v) ? v : null;
      }

      const keys = [
        'temperature_c','precipitation_mm','rain_probability','rain_typical_mm',
        'wind_speed_ms','wind_dir_deg','wind_var_deg',
        'temp_day_median','temp_day_p25','temp_day_p75',
        'lucky_day_count','lucky_ride_count',
      ];
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

    const years = _strategicGetSelectedYears();
    const yearsKey = _strategicYearsKey(years);
    const mode = _strategicGetMode();
    const cacheKey = _strategicCacheKey(
      yearsKey,
      mode,
      STRATEGIC_STATE.timescale,
      mmdd,
      latMin,
      latMax,
      lonMin,
      lonMax,
      _strategicLuckyVariant(),
    );
    const cached = _strategicCacheGet(cacheKey);
    if (cached) {
      return cached;
    }

    const primaryYear = Number(years[0] || STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
    const url = `/api/strategic_grid?year=${encodeURIComponent(String(primaryYear))}`
      + `&years=${encodeURIComponent(String(yearsKey))}`
      + `&mode=${encodeURIComponent(String(mode))}`
      + `&timescale=${encodeURIComponent(String(STRATEGIC_STATE.timescale || 'daily'))}`
      + `&date=${encodeURIComponent(String(mmdd))}`
      + `&lat_min=${encodeURIComponent(String(latMin))}&lat_max=${encodeURIComponent(String(latMax))}`
      + `&lon_min=${encodeURIComponent(String(lonMin))}&lon_max=${encodeURIComponent(String(lonMax))}`
      + _strategicLuckyQueryParams();
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
    try { j._luckyVariant = _strategicLuckyVariant(); } catch (_) {}
    try { _strategicCacheSet(cacheKey, j); } catch (_) {}
    STRATEGIC_STATE.lastFetchAt = t0;
    return j;
  }

  async function _fetchStrategicGridForRange(startDateIso, durationDays) {
    if (!STRATEGIC_STATE.active) return;
    const b = map.getBounds();
    const latMin = b.getSouth();
    const latMax = b.getNorth();
    const lonMin = b.getWest();
    const lonMax = b.getEast();

    const startIso = String(startDateIso || '');
    const dur = Math.max(1, Math.round(Number(durationDays) || 1));

    const years = _strategicGetSelectedYears();
    const yearsKey = _strategicYearsKey(years);
    const mode = _strategicGetMode();
    const cacheKey = _strategicCacheKey(
      yearsKey,
      mode,
      'range',
      `${startIso}|${dur}`,
      latMin,
      latMax,
      lonMin,
      lonMax,
      _strategicLuckyVariant(),
    );
    const cached = _strategicCacheGet(cacheKey);
    if (cached) return cached;

    const primaryYear = Number(years[0] || STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
    const url = `/api/strategic_grid?year=${encodeURIComponent(String(primaryYear))}`
      + `&years=${encodeURIComponent(String(yearsKey))}`
      + `&mode=${encodeURIComponent(String(mode))}`
      + `&start_date=${encodeURIComponent(startIso)}`
      + `&duration_days=${encodeURIComponent(String(dur))}`
      + `&lat_min=${encodeURIComponent(String(latMin))}&lat_max=${encodeURIComponent(String(latMax))}`
      + `&lon_min=${encodeURIComponent(String(lonMin))}&lon_max=${encodeURIComponent(String(lonMax))}`
      + _strategicLuckyQueryParams();
    const t0 = Date.now();

    try {
      if (STRATEGIC_STATE.fetchAbort) STRATEGIC_STATE.fetchAbort.abort();
    } catch (_) {}
    const ac = new AbortController();
    STRATEGIC_STATE.fetchAbort = ac;

    const resp = await fetch(url, { signal: ac.signal });
    const j = await resp.json();
    if (!resp.ok) throw new Error(j && j.error ? j.error : `HTTP ${resp.status}`);
    try { j._luckyVariant = _strategicLuckyVariant(); } catch (_) {}
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
        'wind_speed_ms','wind_var_deg','temp_day_median','temp_day_p25','temp_day_p75',
        'lucky_day_count','lucky_ride_count'
      ];
      for (const nk of numKeys) merged[nk] = lerpNum(pa && pa[nk], pb && pb[nk]);
      merged.wind_dir_deg = lerpDir(pa && pa.wind_dir_deg, pb && pb.wind_dir_deg);
      out.push(merged);
    }
    return out;
  }

  async function _fetchStrategicGrid() {
    if (!STRATEGIC_STATE.active) return;
    if (_strategicUsingRangeUI()) {
      const y = Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
      const { startDoy, durationDays } = _strategicGetRangeDOY();
      const startIso = _isoDateFromDOY(startDoy, y);
      const j = await _fetchStrategicGridForRange(startIso, durationDays);
      if (!j || !j.points) return;
      try { j._coverage_bbox = _coverageBBoxFromPoints(j.points); } catch (_) {}
      STRATEGIC_STATE.lastResp = j;
      // Invalidate sampling caches so tooltip counts update immediately.
      STRATEGIC_STATE._meta = null;
      STRATEGIC_STATE._tileMap = null;
      return;
    }
    const { mmdd0, mmdd1, frac } = _strategicCurrentMMDDPair();
    const a = await _fetchStrategicGridForMMDD(mmdd0);
    const b = (mmdd1 === mmdd0) ? a : await _fetchStrategicGridForMMDD(mmdd1);
    if (!a || !a.points) return;
    const blended = {
      ...a,
      points: (b && b.points) ? _blendStrategicPoints(a.points, b.points, frac) : a.points,
    };
    try { blended._luckyVariant = _strategicLuckyVariant(); } catch (_) {}
    try { blended._coverage_bbox = _coverageBBoxFromPoints(blended.points); } catch (_) {}
    STRATEGIC_STATE.lastResp = blended;
    // Invalidate sampling caches so tooltip counts update immediately.
    STRATEGIC_STATE._meta = null;
    STRATEGIC_STATE._tileMap = null;
  }

  function _prefetchStrategicNeighbor(offsetDays) {
    try {
      if (!STRATEGIC_STATE.active) return;
      if (_strategicUsingRangeUI()) return;
      const years = _strategicGetSelectedYears();
      const yearsKey = _strategicYearsKey(years);
      const mode = _strategicGetMode();
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
      const cacheKey = _strategicCacheKey(
        yearsKey,
        mode,
        STRATEGIC_STATE.timescale,
        mmdd,
        latMin,
        latMax,
        lonMin,
        lonMax,
        _strategicLuckyVariant(),
      );
      if (_strategicCacheGet(cacheKey)) return;
      const primaryYear = Number(years[0] || STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
      const url = `/api/strategic_grid?year=${encodeURIComponent(String(primaryYear))}`
        + `&years=${encodeURIComponent(String(yearsKey))}`
        + `&mode=${encodeURIComponent(String(mode))}`
        + `&timescale=${encodeURIComponent(String(STRATEGIC_STATE.timescale || 'daily'))}`
        + `&date=${encodeURIComponent(String(mmdd))}`
        + `&lat_min=${encodeURIComponent(String(latMin))}&lat_max=${encodeURIComponent(String(latMax))}`
        + `&lon_min=${encodeURIComponent(String(lonMin))}&lon_max=${encodeURIComponent(String(lonMax))}`
        + _strategicLuckyQueryParams();
      fetch(url)
        .then(r => r.json().then(j => ({ ok: r.ok, status: r.status, j })))
        .then(({ ok, status, j }) => {
          if (!ok) throw new Error((j && j.error) ? j.error : `HTTP ${status}`);
          _strategicCacheSet(cacheKey, j);
        })
        .catch(() => {});
    } catch (_) {}
  }

  function _prefetchStrategicRangeNeighbor(offsetDays) {
    try {
      if (!STRATEGIC_STATE.active) return;
      if (!_strategicUsingRangeUI()) return;
      const years = _strategicGetSelectedYears();
      const yearsKey = _strategicYearsKey(years);
      const mode = _strategicGetMode();
      const y = Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
      const { startDoy, durationDays } = _strategicGetRangeDOY();
      const maxStart = Math.max(1, 365 - durationDays + 1);
      let s2 = _clampDOYInt(startDoy + Number(offsetDays || 0));
      s2 = Math.max(1, Math.min(maxStart, s2));
      const startIso = _isoDateFromDOY(s2, y);

      const b = map.getBounds();
      const latMin = b.getSouth();
      const latMax = b.getNorth();
      const lonMin = b.getWest();
      const lonMax = b.getEast();
      const cacheKey = _strategicCacheKey(
        yearsKey,
        mode,
        'range',
        `${startIso}|${durationDays}`,
        latMin,
        latMax,
        lonMin,
        lonMax,
        _strategicLuckyVariant(),
      );
      if (_strategicCacheGet(cacheKey)) return;

      const primaryYear = Number(years[0] || STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
      const url = `/api/strategic_grid?year=${encodeURIComponent(String(primaryYear))}`
        + `&years=${encodeURIComponent(String(yearsKey))}`
        + `&mode=${encodeURIComponent(String(mode))}`
        + `&start_date=${encodeURIComponent(startIso)}`
        + `&duration_days=${encodeURIComponent(String(durationDays))}`
        + `&lat_min=${encodeURIComponent(String(latMin))}&lat_max=${encodeURIComponent(String(latMax))}`
        + `&lon_min=${encodeURIComponent(String(lonMin))}&lon_max=${encodeURIComponent(String(lonMax))}`
        + _strategicLuckyQueryParams();
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
    for (let i = 0; i < quadsByIdx.length; i++) {
      const quads = quadsByIdx[i];
      if (!quads || !quads.length) continue;
      const col = cols[i];
      if (!col) continue;
      const fillAlpha = _clamp01((Number.isFinite(Number(col.a)) ? Number(col.a) : 1) * aFill);
      ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},${fillAlpha})`;
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

  function _applyBinnedEdgeEmphasis(imageDataRgba, w, h, binIdx, opts) {
    // Subtle boundary contrast between binned regions.
    // Modifies ImageData RGBA in-place.
    const o = (opts && typeof opts === 'object') ? opts : {};
    const data = imageDataRgba;
    const W = Math.max(0, Math.floor(Number(w) || 0));
    const H = Math.max(0, Math.floor(Number(h) || 0));
    if (!data || W < 3 || H < 3 || !binIdx) return;
    const darken = (Number.isFinite(Number(o.darken)) ? Number(o.darken) : 0.88);
    const alphaAdd = (Number.isFinite(Number(o.alphaAdd)) ? Number(o.alphaAdd) : 0.02);
    const aAdd255 = Math.max(0, Math.min(32, Math.round(alphaAdd * 255)));

    // Only touch pixels that are inside a region and adjacent to a different region.
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        const b = binIdx[p];
        if (b < 0) continue;
        const i = p * 4;
        const a = data[i + 3];
        if (!(a > 0)) continue;
        const bL = binIdx[p - 1];
        const bR = binIdx[p + 1];
        const bU = binIdx[p - W];
        const bD = binIdx[p + W];
        if (bL === b && bR === b && bU === b && bD === b) continue;
        data[i + 0] = Math.max(0, Math.min(255, Math.round(data[i + 0] * darken)));
        data[i + 1] = Math.max(0, Math.min(255, Math.round(data[i + 1] * darken)));
        data[i + 2] = Math.max(0, Math.min(255, Math.round(data[i + 2] * darken)));
        data[i + 3] = Math.max(0, Math.min(255, a + aAdd255));
      }
    }
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
    const layer = _strategicNormalizeLayer(STRATEGIC_STATE.layer);

    // Cache for cursor readout + wind sampling.
    STRATEGIC_STATE._meta = meta;
    STRATEGIC_STATE._tileMap = tileMap;

    const yNow = Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
    const tsNow = String(STRATEGIC_STATE.timescale || 'daily');
    const pNow = _strategicPeriodForDOY(STRATEGIC_STATE.doy, tsNow, yNow);
    const daysInPeriodNow = (() => {
      try {
        if (resp && String(resp.timescale || '') === 'range') {
          const d = Math.max(1, Math.round(Number(resp.duration_days) || 1));
          if (Number.isFinite(d) && d > 0) return d;
        }
      } catch (_) {}
      if (pNow && Number.isFinite(Number(pNow.startDoy)) && Number.isFinite(Number(pNow.endDoy))) {
        return Math.max(1, Math.round(Number(pNow.endDoy) - Number(pNow.startDoy) + 1));
      }
      return 1;
    })();
    const sampleDaysNow = (() => {
      try {
        const sd = Number(resp && resp.sample_days);
        if (Number.isFinite(sd) && sd > 0) return Math.round(sd);
      } catch (_) {}
      return daysInPeriodNow;
    })();

    STRATEGIC_STATE.isoLayer.drawWith((ctx, size) => {
      const w = size.x;
      const h = size.y;
      ctx.clearRect(0, 0, w, h);

      const needLandClip = !(SETTINGS && SETTINGS.includeSea)
        && (layer === 'temperature_ride' || layer === 'rain_ride' || layer === 'comfort');
      const clipped = needLandClip ? _beginStrategicLandClip(ctx) : false;

      if (layer === 'temperature_ride') {
        // Temperature iso-surfaces (riding-hours median temperature)
        const modeRaw = (() => {
          try {
            return (resp && typeof resp.mode === 'string') ? String(resp.mode) : _strategicGetMode();
          } catch (_) {
            return _strategicGetMode();
          }
        })();
        const valueKey = (String(modeRaw) === 'full_day') ? 'temperature_c' : 'temp_day_median';
        const grid = _gridFromPoints(resp.points, valueKey);
        if (meta) {
          const sc = (typeof window !== 'undefined') ? window.WM_TEMP_SCALE : null;
          const bounds = (sc && Array.isArray(sc.TEMP_BOUNDS)) ? sc.TEMP_BOUNDS : [-Infinity, 5, 10, 15, 20, 25, 30, 35, Infinity];
          const colorsHex = (sc && Array.isArray(sc.TEMP_COLORS)) ? sc.TEMP_COLORS : ['#2c7bb6','#00a6ca','#66c2a5','#1a9850','#66bd63','#fee08b','#f46d43','#7b3294'];
          const toRgb = (hex) => {
            try {
              if (sc && typeof sc.hexToRgb === 'function') return sc.hexToRgb(hex);
            } catch (_) {}
            const h = String(hex || '').replace('#', '').trim();
            if (h.length !== 6) return { r: 150, g: 150, b: 150 };
            const r = parseInt(h.slice(0, 2), 16);
            const g = parseInt(h.slice(2, 4), 16);
            const b = parseInt(h.slice(4, 6), 16);
            return {
              r: Number.isFinite(r) ? r : 150,
              g: Number.isFinite(g) ? g : 150,
              b: Number.isFinite(b) ? b : 150,
            };
          };
          const colorsRgb = colorsHex.map(toRgb);
          const z = map.getZoom ? map.getZoom() : 6;
          const binIndex = (t) => {
            try {
              if (sc && typeof sc.getTempBinIndex === 'function') return sc.getTempBinIndex(t);
            } catch (_) {}
            const v = Number(t);
            if (!Number.isFinite(v)) return null;
            for (let i = 0; i < bounds.length - 1; i++) {
              if (v < bounds[i + 1]) return i;
            }
            return bounds.length - 2;
          };

          const stride = Math.max(2, Math.min(6, Math.round(6 - Math.max(0, Math.min(6, z - 5)))));
          const w2 = Math.max(1, Math.ceil(w / stride));
          const h2 = Math.max(1, Math.ceil(h / stride));
          const off = (STRATEGIC_STATE._tempRideRaster || (STRATEGIC_STATE._tempRideRaster = document.createElement('canvas')));
          off.width = w2;
          off.height = h2;
          const octx = off.getContext('2d');
          if (octx) {
            const img = octx.createImageData(w2, h2);
            const data = img.data;
            const a255 = Math.max(0, Math.min(255, Math.round(255 * 0.24)));
            const binArr = new Int16Array(w2 * h2);
            for (let i = 0; i < binArr.length; i++) binArr[i] = -1;

            let lonAtX0 = 0;
            let lonPerPx = 0;
            try {
              const llL = map.containerPointToLatLng([0, h * 0.5]);
              const llR = map.containerPointToLatLng([w, h * 0.5]);
              if (llL && llR) {
                lonAtX0 = Number(llL.lng);
                let dLon = Number(llR.lng) - lonAtX0;
                if (dLon > 180) dLon -= 360;
                if (dLon < -180) dLon += 360;
                lonPerPx = dLon / Math.max(1, w);
              }
            } catch (_) {
              lonAtX0 = 0;
              lonPerPx = 0;
            }
            const lonByX2 = new Array(w2);
            for (let x2 = 0; x2 < w2; x2++) {
              const px = x2 * stride + stride * 0.5;
              let lon = lonAtX0 + lonPerPx * px;
              lon = ((lon + 540) % 360) - 180;
              lonByX2[x2] = lon;
            }

            for (let y2 = 0; y2 < h2; y2++) {
              const py = y2 * stride + stride * 0.5;
              let latRow = NaN;
              try {
                const llRow = map.containerPointToLatLng([w * 0.5, py]);
                latRow = llRow ? Number(llRow.lat) : NaN;
              } catch (_) {
                latRow = NaN;
              }
              const haveLat = Number.isFinite(latRow);

              for (let x2 = 0; x2 < w2; x2++) {
                const idxPx = (y2 * w2 + x2) * 4;
                if (!haveLat) {
                  data[idxPx + 3] = 0;
                  continue;
                }
                const lon = lonByX2[x2];
                const s = _sampleInterpolated(tileMap, meta, latRow, lon);
                const t = s ? Number(s[valueKey]) : NaN;
                if (!Number.isFinite(t)) {
                  data[idxPx + 3] = 0;
                  continue;
                }
                const bi = binIndex(t);
                if (bi === null) {
                  data[idxPx + 3] = 0;
                  continue;
                }
                binArr[(y2 * w2 + x2)] = Number(bi);
                const rgb = colorsRgb[Math.max(0, Math.min(colorsRgb.length - 1, Number(bi)))] || { r: 150, g: 150, b: 150 };
                data[idxPx + 0] = rgb.r;
                data[idxPx + 1] = rgb.g;
                data[idxPx + 2] = rgb.b;
                data[idxPx + 3] = a255;
              }
            }

            _applyBinnedEdgeEmphasis(data, w2, h2, binArr, { darken: 0.90, alphaAdd: 0.02 });

            octx.putImageData(img, 0, 0);
            ctx.save();
            try { ctx.imageSmoothingEnabled = false; } catch (_) {}
            ctx.drawImage(off, 0, 0, w2, h2, 0, 0, w, h);
            ctx.restore();
          }
        }

        // Optional thin contours (°C anchors) to help read bins.
        const isoThr = [10, 20, 30];
        if (grid) _drawIsolines(ctx, grid, isoThr, 'rgba(40,40,40,0.38)', 0.9, null);
        if (clipped) ctx.restore();
        _strokeStrategicShoreline(ctx);
        return;
      }

      if (layer === 'rain_ride') {
        // Phase 1 (refinement): perceptually compressed precipitation zones.
        // Pipeline: interpolate -> (light smooth) -> bin -> render (no gradients).
        if (!meta) {
          if (clipped) ctx.restore();
          _strokeStrategicShoreline(ctx);
          return;
        }

        // Hard threshold + capped discrete bins (mm/day)
        const RAIN_BINS = [0.5, 2, 5, 10, 20, 50, 999];
        const RAIN_COLORS = [
          { r: 180, g: 160, b: 255, a: 0.10 }, // 0.5–2 very subtle
          { r: 150, g: 120, b: 255, a: 0.18 }, // 2–5 light
          { r: 120, g: 80,  b: 220, a: 0.30 }, // 5–10 moderate
          { r: 100, g: 60,  b: 200, a: 0.45 }, // 10–20 strong
          { r: 80,  g: 40,  b: 160, a: 0.60 }, // 20–50 heavy
          { r: 70,  g: 30,  b: 140, a: 0.70 }, // >50 extreme (capped max)
        ];
        const rainBinIdx = (mm) => {
          const v = Number(mm);
          if (!Number.isFinite(v) || v < RAIN_BINS[0]) return -1;
          if (v < RAIN_BINS[1]) return 0;
          if (v < RAIN_BINS[2]) return 1;
          if (v < RAIN_BINS[3]) return 2;
          if (v < RAIN_BINS[4]) return 3;
          if (v < RAIN_BINS[5]) return 4;
          return 5;
        };
        const RAIN_SMOOTH_SIGMA = 2.0;

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
        const field = Array.from({ length: h2 }, () => Array.from({ length: w2 }, () => NaN));

        let lonAtX0 = 0;
        let lonPerPx = 0;
        try {
          const llL = map.containerPointToLatLng([0, h * 0.5]);
          const llR = map.containerPointToLatLng([w, h * 0.5]);
          if (llL && llR) {
            lonAtX0 = Number(llL.lng);
            let dLon = Number(llR.lng) - lonAtX0;
            if (dLon > 180) dLon -= 360;
            if (dLon < -180) dLon += 360;
            lonPerPx = dLon / Math.max(1, w);
          }
        } catch (_) {
          lonAtX0 = 0;
          lonPerPx = 0;
        }

        const lonByX2 = new Array(w2);
        for (let x2 = 0; x2 < w2; x2++) {
          const px = x2 * stride + stride * 0.5;
          let lon = lonAtX0 + lonPerPx * px;
          lon = ((lon + 540) % 360) - 180;
          lonByX2[x2] = lon;
        }

        for (let y2 = 0; y2 < h2; y2++) {
          const py = y2 * stride + stride * 0.5;
          let latRow = NaN;
          try {
            const llRow = map.containerPointToLatLng([w * 0.5, py]);
            latRow = llRow ? Number(llRow.lat) : NaN;
          } catch (_) {
            latRow = NaN;
          }
          const haveLat = Number.isFinite(latRow);

          for (let x2 = 0; x2 < w2; x2++) {
            if (!haveLat) continue;
            const lon = lonByX2[x2];
            let mm = NaN;
            try {
              const s = _sampleInterpolated(tileMap, meta, latRow, lon);
              mm = s ? Number(s.precipitation_mm) : NaN;
            } catch (_) {
              mm = NaN;
            }
            if (!Number.isFinite(mm) || mm < RAIN_BINS[0]) continue;
            field[y2][x2] = Math.max(0, mm);
          }
        }

        const smooth = _gaussianBlur2D_nanAware(field, RAIN_SMOOTH_SIGMA);

        const img = octx.createImageData(w2, h2);
        const data = img.data;
        const binArr = new Int16Array(w2 * h2);
        for (let i = 0; i < binArr.length; i++) binArr[i] = -1;

        for (let y2 = 0; y2 < h2; y2++) {
          const row = smooth[y2];
          for (let x2 = 0; x2 < w2; x2++) {
            const mm = row ? Number(row[x2]) : NaN;
            const bi = rainBinIdx(mm);
            const i = (y2 * w2 + x2) * 4;
            if (bi < 0) {
              data[i + 3] = 0;
              continue;
            }
            binArr[(y2 * w2 + x2)] = bi;
            const base = RAIN_COLORS[bi] || { r: 150, g: 150, b: 150, a: 0.2 };
            data[i + 0] = base.r;
            data[i + 1] = base.g;
            data[i + 2] = base.b;
            data[i + 3] = Math.max(0, Math.min(255, Math.round(_clamp01(base.a) * 255)));
          }
        }

        for (let y2 = 1; y2 < h2 - 1; y2++) {
          for (let x2 = 1; x2 < w2 - 1; x2++) {
            const p = y2 * w2 + x2;
            const bi = binArr[p];
            if (bi < 3) continue;
            const bL = binArr[p - 1];
            const bR = binArr[p + 1];
            const bU = binArr[p - w2];
            const bD = binArr[p + w2];
            const interior = (bL === bi && bR === bi && bU === bi && bD === bi);
            const i = p * 4;
            const a0 = data[i + 3];
            if (!(a0 > 0)) continue;
            if (interior) {
              data[i + 0] = Math.max(0, Math.min(255, Math.round(data[i + 0] * 0.97)));
              data[i + 1] = Math.max(0, Math.min(255, Math.round(data[i + 1] * 0.97)));
              data[i + 2] = Math.max(0, Math.min(255, Math.round(data[i + 2] * 0.97)));
              data[i + 3] = Math.max(0, Math.min(255, a0 + Math.round(0.04 * 255)));
            } else {
              data[i + 3] = Math.max(0, Math.min(255, Math.round(a0 * 0.92)));
            }
          }
        }

        _applyBinnedEdgeEmphasis(data, w2, h2, binArr, { darken: 0.92, alphaAdd: 0.01 });

        octx.putImageData(img, 0, 0);
        ctx.save();
        try { ctx.imageSmoothingEnabled = false; } catch (_) {}
        ctx.globalAlpha = 1;
        ctx.drawImage(off, 0, 0, w2, h2, 0, 0, w, h);
        ctx.restore();

        if (clipped) ctx.restore();
        _strokeStrategicShoreline(ctx);
        return;
      }

      if (layer === 'comfort' || layer === 'comfort_day' || layer === 'comfort_ride') {
        // Lucky Days (%) within selected timescale.
        // - full_day mode: uses 24h temperature for Lucky Days
        // - active mode: uses ride-hours temperature for Lucky Days

        const modeRaw = (() => {
          try {
            return (resp && typeof resp.mode === 'string') ? String(resp.mode) : _strategicGetMode();
          } catch (_) {
            return _strategicGetMode();
          }
        })();
        const countKey = (String(modeRaw) === 'full_day') ? 'lucky_day_count' : 'lucky_ride_count';
        const pctFn = (p) => {
          try {
            const n = Number(p && p[countKey]);
            if (!Number.isFinite(n)) return null;
            const pct = 100.0 * Math.max(0, n) / Math.max(1, sampleDaysNow);
            if (!Number.isFinite(pct)) return null;
            return Math.max(0, Math.min(100, pct));
          } catch (_) {
            return null;
          }
        };
        if (!meta) {
          if (clipped) ctx.restore();
          _strokeStrategicShoreline(ctx);
          return;
        }

        // Render as an interpolated raster (like temperature) to remove tile artifacts.
        // Pipeline: interpolate -> (micro-smooth) -> bin -> render.
        const LUCKY_BINS = [0, 20, 40, 60, 80, 100];
        const LUCKY_COLS = [
          { r: 0xd7, g: 0x30, b: 0x27 }, // #d73027
          { r: 0xf4, g: 0x6d, b: 0x43 }, // #f46d43
          { r: 0xfe, g: 0xe0, b: 0x8b }, // #fee08b
          { r: 0xa6, g: 0xd9, b: 0x6a }, // #a6d96a
          { r: 0x1a, g: 0x98, b: 0x50 }, // #1a9850
        ];
        const luckyBinIdx = (pct) => {
          const v = Number(pct);
          if (!Number.isFinite(v)) return -1;
          if (v < LUCKY_BINS[1]) return 0;
          if (v < LUCKY_BINS[2]) return 1;
          if (v < LUCKY_BINS[3]) return 2;
          if (v < LUCKY_BINS[4]) return 3;
          return 4;
        };

        const z = map.getZoom ? map.getZoom() : 6;
        const stride = Math.max(2, Math.min(6, Math.round(6 - Math.max(0, Math.min(6, z - 5)))));
        const w2 = Math.max(1, Math.ceil(w / stride));
        const h2 = Math.max(1, Math.ceil(h / stride));
        const off = (STRATEGIC_STATE._luckyRaster || (STRATEGIC_STATE._luckyRaster = document.createElement('canvas')));
        off.width = w2;
        off.height = h2;
        const octx = off.getContext('2d');
        if (!octx) {
          if (clipped) ctx.restore();
          _strokeStrategicShoreline(ctx);
          return;
        }

        let lonAtX0 = 0;
        let lonPerPx = 0;
        try {
          const llL = map.containerPointToLatLng([0, h * 0.5]);
          const llR = map.containerPointToLatLng([w, h * 0.5]);
          if (llL && llR) {
            lonAtX0 = Number(llL.lng);
            let dLon = Number(llR.lng) - lonAtX0;
            if (dLon > 180) dLon -= 360;
            if (dLon < -180) dLon += 360;
            lonPerPx = dLon / Math.max(1, w);
          }
        } catch (_) {
          lonAtX0 = 0;
          lonPerPx = 0;
        }
        const lonByX2 = new Array(w2);
        for (let x2 = 0; x2 < w2; x2++) {
          const px = x2 * stride + stride * 0.5;
          let lon = lonAtX0 + lonPerPx * px;
          lon = ((lon + 540) % 360) - 180;
          lonByX2[x2] = lon;
        }

        const field = Array.from({ length: h2 }, () => Array.from({ length: w2 }, () => NaN));
        for (let y2 = 0; y2 < h2; y2++) {
          const py = y2 * stride + stride * 0.5;
          let latRow = NaN;
          try {
            const llRow = map.containerPointToLatLng([w * 0.5, py]);
            latRow = llRow ? Number(llRow.lat) : NaN;
          } catch (_) {
            latRow = NaN;
          }
          if (!Number.isFinite(latRow)) continue;
          for (let x2 = 0; x2 < w2; x2++) {
            const lon = lonByX2[x2];
            const s = _sampleInterpolated(tileMap, meta, latRow, lon);
            const n = s ? Number(s[countKey]) : NaN;
            if (!Number.isFinite(n)) continue;
            const pctRaw = 100.0 * Math.max(0, n) / Math.max(1, sampleDaysNow);
            const pct = Math.max(0, Math.min(100, pctRaw));
            field[y2][x2] = pct;
          }
        }

        const smooth = _gaussianBlur2D_nanAware(field, 2.0);

        const img = octx.createImageData(w2, h2);
        const data = img.data;
        const binArr = new Int16Array(w2 * h2);
        for (let i = 0; i < binArr.length; i++) binArr[i] = -1;
        const a255 = Math.max(0, Math.min(255, Math.round(255 * 0.24)));

        for (let y2 = 0; y2 < h2; y2++) {
          const row = smooth[y2];
          for (let x2 = 0; x2 < w2; x2++) {
            const v = row ? Number(row[x2]) : NaN;
            const bi = luckyBinIdx(v);
            const i = (y2 * w2 + x2) * 4;
            if (bi < 0) {
              data[i + 3] = 0;
              continue;
            }
            binArr[(y2 * w2 + x2)] = bi;
            const rgb = LUCKY_COLS[bi] || { r: 150, g: 150, b: 150 };
            data[i + 0] = rgb.r;
            data[i + 1] = rgb.g;
            data[i + 2] = rgb.b;
            data[i + 3] = a255;
          }
        }

        _applyBinnedEdgeEmphasis(data, w2, h2, binArr, { darken: 0.90, alphaAdd: 0.02 });
        octx.putImageData(img, 0, 0);
        ctx.save();
        try { ctx.imageSmoothingEnabled = false; } catch (_) {}
        ctx.drawImage(off, 0, 0, w2, h2, 0, 0, w, h);
        ctx.restore();

        if (clipped) ctx.restore();
        _strokeStrategicShoreline(ctx);
        return;
      }

      // Other strategic layers are not part of Phase 1 iso-weather rendering.

      if (clipped) ctx.restore();
      _strokeStrategicShoreline(ctx);
    });

    // Wind overlay
    const wantWind = Boolean(STRATEGIC_STATE.windOn);
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

  function _scheduleStrategicFetch(reason) {
    if (!STRATEGIC_STATE.active) return;
    const now = Date.now();
    // If a fetch is already pending, just record the most important reason.
    // Timeline scrubbing should retain neighbor-prefetch; viewport fetches should not.
    if (STRATEGIC_STATE.pendingFetch) {
      try {
        const r = String(reason || '');
        if (r === 'doy' || r === 'range') STRATEGIC_STATE.pendingFetchReason = r;
      } catch (_) {}
      return;
    }
    const dt = now - (STRATEGIC_STATE.lastFetchAt || 0);
    const delay = Math.max(0, STRATEGIC_FETCH_THROTTLE_MS - dt);
    try { STRATEGIC_STATE.pendingFetchReason = String(reason || ''); } catch (_) { STRATEGIC_STATE.pendingFetchReason = ''; }
    STRATEGIC_STATE.pendingFetch = setTimeout(async () => {
      const why = String(STRATEGIC_STATE.pendingFetchReason || '');
      STRATEGIC_STATE.pendingFetch = null;
      STRATEGIC_STATE.pendingFetchReason = '';
      try {
        await _fetchStrategicGrid();
        _renderStrategic();

        // Best-effort prefetch only for timeline scrubbing (not for pan/zoom).
        if (why === 'doy' || why === 'range') {
          setTimeout(() => {
            try {
              if (_strategicUsingRangeUI()) {
                _prefetchStrategicRangeNeighbor(-1);
                _prefetchStrategicRangeNeighbor(+1);
                return;
              }
              const ts = String(STRATEGIC_STATE.timescale || 'daily');
              if (ts !== 'daily') return;
              _prefetchStrategicNeighbor(-1);
              _prefetchStrategicNeighbor(+1);
            } catch (_) {}
          }, 0);
        }
      } catch (e) {
        // Ignore abort noise during scrubbing.
        if (!(e && (e.name === 'AbortError'))) console.error('strategic fetch', e);
      }
    }, delay);
  }

  function _cancelStrategicPendingFetch() {
    try {
      if (STRATEGIC_STATE && STRATEGIC_STATE.pendingFetch) {
        try { clearTimeout(STRATEGIC_STATE.pendingFetch); } catch (_) {}
        STRATEGIC_STATE.pendingFetch = null;
        STRATEGIC_STATE.pendingFetchReason = '';
      }
    } catch (_) {}
  }

  async function _strategicFlushNow(reason) {
    if (!STRATEGIC_STATE || !STRATEGIC_STATE.active) return;
    // Ensure we don't have a delayed fetch queued that would redraw old state later.
    _cancelStrategicPendingFetch();
    try {
      await _fetchStrategicGrid();
      _renderStrategic();
    } catch (e) {
      // Ignore abort noise during scrubbing/playback.
      if (!(e && (e.name === 'AbortError'))) throw e;
    }
  }

  function _strategicViewNeedsFetch() {
    try {
      if (!STRATEGIC_STATE || !STRATEGIC_STATE.active) return false;
      const resp = STRATEGIC_STATE.lastResp;
      if (!resp || !resp.points || !resp.points.length) return true;

      // If the response doesn't match current strategic parameters, we must refetch.
      try {
        const wantYears = _strategicGetSelectedYears();
        const wantKey = _strategicYearsKey(wantYears);
        const gotYears = (resp && Array.isArray(resp.years_selected) && resp.years_selected.length)
          ? resp.years_selected
          : [Number(resp && resp.year)];
        const gotKey = _strategicYearsKey(gotYears);
        if (wantKey && gotKey && wantKey !== gotKey) return true;
      } catch (_) {}
      try {
        const wantMode = _strategicGetMode();
        const gotMode = (resp && typeof resp.mode === 'string') ? String(resp.mode) : STRATEGIC_DEFAULT_MODE;
        if (wantMode && gotMode && String(wantMode) !== String(gotMode)) return true;
      } catch (_) {}
      try {
        const wantLuckyVariant = _strategicLuckyVariant();
        const gotLuckyVariant = String((resp && resp._luckyVariant) || '');
        if (wantLuckyVariant && gotLuckyVariant && wantLuckyVariant !== gotLuckyVariant) return true;
        if (wantLuckyVariant && !gotLuckyVariant) return true;
      } catch (_) {}
      try {
        const gotTs = String(resp.timescale || 'daily');
        if (_strategicUsingRangeUI()) {
          if (gotTs !== 'range') return true;
          const y = Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR);
          const { startDoy, durationDays } = _strategicGetRangeDOY();
          const wantStart = _isoDateFromDOY(startDoy, y);
          const gotStart = String(resp.start_date || '');
          const wantDur = Math.max(1, Math.round(Number(durationDays) || 1));
          const gotDur = Math.max(1, Math.round(Number(resp.duration_days) || 1));
          if (wantStart && gotStart && wantStart !== gotStart) return true;
          if (Number.isFinite(gotDur) && gotDur !== wantDur) return true;
        } else {
          const wantTs = String(STRATEGIC_STATE.timescale || ((SETTINGS && SETTINGS.climateTimescale) ? SETTINGS.climateTimescale : 'daily'));
          if (wantTs && gotTs && wantTs !== gotTs) return true;
        }
      } catch (_) {}

      if (!map || !map.getBounds) return true;
      const vb = map.getBounds();
      if (!vb) return true;
      const view = {
        latMin: Number(vb.getSouth()),
        latMax: Number(vb.getNorth()),
        lonMin: Number(vb.getWest()),
        lonMax: Number(vb.getEast()),
      };
      if (![view.latMin, view.latMax, view.lonMin, view.lonMax].every(Number.isFinite)) return true;
      // Use the actual coverage of the returned points (not the DB's global bbox).
      const outer = (resp && resp._coverage_bbox) ? resp._coverage_bbox : _coverageBBoxFromPoints(resp.points);
      if (!outer) return true;
      // Expand the coverage bbox by ~half a tile to compensate for
      // point centers vs tile edges and avoid re-fetching on small zoom changes.
      const tileKm = Math.max(10, Number(resp.tile_km || 50));
      const stepLat = tileKm / 111.32;
      const midLat = (Number.isFinite(outer.latMin) && Number.isFinite(outer.latMax))
        ? (0.5 * (outer.latMin + outer.latMax))
        : 45.0;
      const c = Math.max(0.05, Math.cos(midLat * Math.PI / 180));
      const stepLon = tileKm / (111.32 * c);

      const jitter = 0.08;
      const padLat = Math.min(1.5, Math.max(jitter, stepLat * 0.75));
      const padLon = Math.min(2.0, Math.max(jitter, stepLon * 0.75));

      const cov = {
        latMin: outer.latMin - padLat,
        latMax: outer.latMax + padLat,
        lonMin: outer.lonMin - padLon,
        lonMax: outer.lonMax + padLon,
      };

      return !(
        view.latMin >= cov.latMin &&
        view.latMax <= cov.latMax &&
        view.lonMin >= cov.lonMin &&
        view.lonMax <= cov.lonMax
      );
    } catch (_) {
      return true;
    }
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
      try {
        const years = _strategicGetSelectedYears();
        STRATEGIC_STATE.years = years;
        STRATEGIC_STATE.year = Number(years[0] || SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR);
        STRATEGIC_STATE.mode = _strategicGetMode();
      } catch (_) {
        STRATEGIC_STATE.years = [Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR)];
        STRATEGIC_STATE.year = Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR);
        STRATEGIC_STATE.mode = STRATEGIC_DEFAULT_MODE;
      }
      _strategicSetYear(Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR));

      // Coastline masks are loaded eagerly for the current zoom band so the
      // overlay does not momentarily fall back to coarse geometry after toggles.
      try { _ensureStrategicShoreMaskLoaded(); } catch (_) {}
      try {
        if (_strategicPreferUltraResLand()) _ensureStrategicUltraMaskLoaded();
      } catch (_) {}

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

      // Default selection: center around today (UTC) mapped into 1..365
      try {
        const today = new Date();
        const y = 2021; // non-leap reference
        const d0 = new Date(Date.UTC(y, today.getUTCMonth(), today.getUTCDate()));
        const start = new Date(Date.UTC(y, 0, 1));
        const doy = 1 + Math.floor((d0 - start) / (24 * 3600 * 1000));
        const d = Math.max(1, Math.min(365, doy));
        if (_strategicUsingRangeUI()) {
          const cur = _strategicGetRangeDOY();
          const dur = Math.max(1, Math.round(Number(cur.durationDays) || 14));
          const maxStart = Math.max(1, 365 - dur + 1);
          const s2 = Math.max(1, Math.min(maxStart, d));
          const e2 = Math.max(s2, Math.min(365, s2 + dur - 1));
          _strategicSetRange(s2, e2, { skipFetch: true });
        } else {
          _strategicSetDOY(d);
        }
      } catch (_) {
        if (_strategicUsingRangeUI()) {
          _strategicSetRange(1, 14, { skipFetch: true });
        } else {
          _strategicSetDOY(1);
        }
      }
      if (strategicLayerSelect) {
        STRATEGIC_STATE.layer = _strategicNormalizeLayer(strategicLayerSelect.value);
        try { strategicLayerSelect.value = STRATEGIC_STATE.layer; } catch (_) {}
      }
      if (strategicWindMode) {
        const windModeSetting = String((SETTINGS && SETTINGS.strategicWindMode) || strategicWindMode.value || 'flow');
        strategicWindMode.value = windModeSetting;
        STRATEGIC_STATE.windMode = windModeSetting;
      }
      if (strategicWindOn) {
        const windPref = Boolean(SETTINGS && SETTINGS.strategicWindOn);
        const want = windPref;
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
        const coords = _strategicEventLatLngAndPoint(ev);
        const ll = coords.ll;
        const pt = coords.pt;
        if (!ll || !pt) {
          if (!dbg) _hideStrategicCursorReadout();
          return;
        }
        try {
          const isTouch = !!(ev && ((ev.touches && ev.touches.length) || (ev.changedTouches && ev.changedTouches.length)));
          if (isTouch) _ensureStrategicCursorMarker(ll);
        } catch (_) {}

        const layerNow = _strategicNormalizeLayer(STRATEGIC_STATE.layer);

        // For Lucky Days layers, use nearest-tile sampling so we can report
        // absolute counts (integers) instead of interpolated fractions.
        const _nearestStrategicTile = (lat, lon) => {
          try {
            const meta = STRATEGIC_STATE._meta;
            const tileMap = STRATEGIC_STATE._tileMap;
            if (!meta || !tileMap) return null;
            const bbox = meta.bbox;
            const tileKm = Number(meta.tile_km || 50);
            if (!bbox || !Number.isFinite(tileKm)) return null;
            const latMin = Number(bbox.latMin);
            const lonMin = Number(bbox.lonMin);
            const stepLat = tileKm / 111.32;
            const row = Math.floor((Number(lat) - latMin) / stepLat);
            const latC = latMin + (row + 0.5) * stepLat;
            const c = Math.max(0.05, Math.cos(latC * Math.PI / 180));
            const stepLon = tileKm / (111.32 * c);
            const col = Math.floor((Number(lon) - lonMin) / stepLon);
            const id = `r${row}_c${col}`;
            return tileMap.get(id) || null;
          } catch (_) {
            return null;
          }
        };

        const strategicLuckyTile = _nearestStrategicTile(ll.lat, ll.lng);
        const s = (layerNow === 'comfort' || layerNow === 'comfort_day' || layerNow === 'comfort_ride')
          ? strategicLuckyTile
          : _strategicSampleAt(ll.lat, ll.lng);
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

        const dateStr = (() => {
          const stripRangeLabel = (value) => String(value || '').replace(/^Range:\s*/i, '').trim();
          try {
            const resp = STRATEGIC_STATE.lastResp;
            if (resp && String(resp.timescale || '') === 'range') {
              const s = String(resp.start_date || '');
              const e = String(resp.end_date || '');
              const d = Math.max(1, Math.round(Number(resp.duration_days) || 1));
              if (s && e) return `${_fmtISODayMonth(s)} – ${_fmtISODayMonth(e)} (${d}d)`;
              if (s) return `${_fmtISODayMonth(s)} (${d}d)`;
            }
          } catch (_) {}
          if (_strategicUsingRangeUI()) {
            const lp = _strategicRangeLabelParts();
            if (lp && lp.monitorLabel) return stripRangeLabel(lp.monitorLabel);
          }
          return (p && p.monitorLabel) ? stripRangeLabel(p.monitorLabel) : `${y}-${_mmddFromDOY(STRATEGIC_STATE.doy)}`;
        })();

        const periodDays = (() => {
          try {
            const resp = STRATEGIC_STATE.lastResp;
            if (resp && String(resp.timescale || '') === 'range') {
              const d = Math.max(1, Math.round(Number(resp.duration_days) || 1));
              if (Number.isFinite(d) && d > 0) return d;
            }
          } catch (_) {}
          if (_strategicUsingRangeUI()) {
            const r = _strategicGetRangeDOY();
            return Math.max(1, Math.round(Number(r.durationDays) || 1));
          }
          if (p && Number.isFinite(Number(p.startDoy)) && Number.isFinite(Number(p.endDoy))) {
            return Math.max(1, Math.round(Number(p.endDoy) - Number(p.startDoy) + 1));
          }
          return 1;
        })();

        const sampleDays = (() => {
          try {
            const resp = STRATEGIC_STATE.lastResp;
            const sd = Number(resp && resp.sample_days);
            if (Number.isFinite(sd) && sd > 0) return Math.round(sd);
          } catch (_) {}
          return periodDays;
        })();

        const t = (() => {
          try {
            const resp = STRATEGIC_STATE.lastResp;
            const m = (resp && typeof resp.mode === 'string') ? String(resp.mode) : _strategicGetMode();
            const k = (String(m) === 'full_day') ? 'temperature_c' : 'temp_day_median';
            const v = Number(s && s[k]);
            return v;
          } catch (_) {
            return Number(s && s.temp_day_median);
          }
        })();

        // Rain overlay and readout both use the same interpolated precipitation_mm.
        let r = Number(s.precipitation_mm);
        if (!Number.isFinite(r) || r < 0) r = 0;
        const w = Number(s.wind_speed_ms);
        const wdFrom = Number(s.wind_dir_deg);
        const wdTo = Number.isFinite(wdFrom) ? ((wdFrom + 180) % 360) : null;
        const wdFromCard = Number.isFinite(wdTo) ? degToCardinal((wdTo + 180) % 360) : null;
        // Lucky Days: absolute counts provided by backend when lucky_* params are passed.
        let luckyDayCount = null;
        let luckyRideCount = null;
        let luckyCountsUseVisibleDays = false;
        try {
          const luckySource = strategicLuckyTile || s;
          const useMajorityCounts = Boolean(
            luckySource
            && (luckySource.lucky_day_majority_count !== undefined || luckySource.lucky_ride_majority_count !== undefined)
          );
          const a = Number(luckySource && (useMajorityCounts
            ? luckySource.lucky_day_majority_count
            : luckySource.lucky_day_count));
          const b = Number(luckySource && (useMajorityCounts
            ? luckySource.lucky_ride_majority_count
            : luckySource.lucky_ride_count));
          luckyDayCount = Number.isFinite(a) ? Math.max(0, Math.round(a)) : null;
          luckyRideCount = Number.isFinite(b) ? Math.max(0, Math.round(b)) : null;
          luckyCountsUseVisibleDays = useMajorityCounts;
        } catch (_) {}
        const luckyDayPct = (luckyDayCount === null)
          ? null
          : (100.0 * luckyDayCount / Math.max(1, luckyCountsUseVisibleDays ? periodDays : sampleDays));
        const luckyRidePct = (luckyRideCount === null)
          ? null
          : (100.0 * luckyRideCount / Math.max(1, luckyCountsUseVisibleDays ? periodDays : sampleDays));

        // The backend count is over sample-days (= years × days). For the tooltip, show
        // an expected count over the selected visible period (periodDays) so the time span
        // matches the Range label. Percentage stays based on sample-days.
        const luckyDayCountPerPeriod = (luckyDayCount === null)
          ? null
          : Number(luckyDayCount);
        const luckyRideCountPerPeriod = (luckyRideCount === null)
          ? null
          : Number(luckyRideCount);

        const _fmtLuckyDays = (countPerPeriod, days, pct, expandedSamples) => {
          if (countPerPeriod === null) return '—';
          const d = Math.max(1, Math.round(Number(days) || 1));
          const p = (pct === null) ? null : Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
          const v = Math.max(0, Number(countPerPeriod) || 0);
          const cTxt = expandedSamples ? _fmtNum(v, 1) : String(Math.round(v));
          return `${cTxt}/${d}${(p === null) ? '' : ` (=${p}%)`}`;
        };

        const locationKey = _queueStrategicLocationLabel(ll.lat, ll.lng);
        STRATEGIC_CURSOR_LOCATION_KEY = locationKey;
        const cachedLocationLabel = locationKey && STRATEGIC_LOCATION_LABEL_CACHE.has(locationKey)
          ? STRATEGIC_LOCATION_LABEL_CACHE.get(locationKey)
          : _strategicLocationFallbackLabel(ll.lat, ll.lng);

        const luckyMode = (() => {
          try {
            const resp = STRATEGIC_STATE.lastResp;
            const m = (resp && typeof resp.mode === 'string') ? String(resp.mode) : _strategicGetMode();
            return (String(m) === 'full_day') ? 'full_day' : 'active';
          } catch (_) {
            return (String(_strategicGetMode()) === 'full_day') ? 'full_day' : 'active';
          }
        })();
        const expandedSamples = (Math.round(Number(sampleDays) || 0) !== Math.round(Number(periodDays) || 0));
        const iconClass = mapWeatherByProb(s && (s.rain_probability !== undefined ? s.rain_probability : s.rainProb));
        const iconMarkup = (() => {
          try {
            return resizeInlineSvgGlyphMarkup(getWeatherSvg(iconClass), 16, 16);
          } catch (_) {
            return '';
          }
        })();
        const luckyText = (luckyMode === 'full_day')
          ? _fmtLuckyDays(luckyDayCountPerPeriod, periodDays, luckyDayPct, expandedSamples)
          : _fmtLuckyDays(luckyRideCountPerPeriod, periodDays, luckyRidePct, expandedSamples);
        _renderStrategicCursorReadoutCard({
          location: cachedLocationLabel || '—',
          period: dateStr,
          iconMarkup,
          rows: [
            { label: 'Temp', value: `${_fmtNum(t, 1)} °C` },
            { label: 'Rain', value: `${_fmtNum(r, 1)} mm/day` },
            { label: 'Rain sum', value: `${_fmtNum((Number.isFinite(r) ? (r * periodDays) : NaN), 1)} mm` },
            { label: 'Wind', value: `${_fmtNum(w, 1)} m/s${wdFromCard ? ` from ${wdFromCard}` : ''}` },
            { label: 'Lucky days', value: luckyText },
          ],
        });
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
        if (c) c.addEventListener('touchstart', STRATEGIC_STATE._cursorMoveHandler, { capture: true, passive: true });
        if (c) c.addEventListener('touchmove', STRATEGIC_STATE._cursorMoveHandler, { capture: true, passive: true });
      } catch (_) {}

      try {
        const c = map.getContainer();
        if (STRATEGIC_STATE._cursorLeaveHandler) c.removeEventListener('mouseleave', STRATEGIC_STATE._cursorLeaveHandler);
        STRATEGIC_STATE._cursorLeaveHandler = () => {
          _hideStrategicCursorReadout();
        };
        c.addEventListener('mouseleave', STRATEGIC_STATE._cursorLeaveHandler);
        c.addEventListener('touchcancel', STRATEGIC_STATE._cursorLeaveHandler, { passive: true });
      } catch (_) {}

      try {
        if (STRATEGIC_STATE._clickHandler) map.off('click', STRATEGIC_STATE._clickHandler);
        STRATEGIC_STATE._clickHandler = (ev) => {
          try {
            if (!_climateProfileIsActive()) return;
            const ll = ev && ev.latlng;
            if (!ll) return;
            _scheduleClimateProfileForPoint({ lat: Number(ll.lat), lon: Number(ll.lng) }, { force: false });
          } catch (_) {}
        };
        map.on('click', STRATEGIC_STATE._clickHandler);
      } catch (_) {}

      try {
        if (CLIMATE_PROFILE_STATE.selectedPoint) {
          _ensureClimateSelectedMarker(CLIMATE_PROFILE_STATE.selectedPoint);
        }
      } catch (_) {}

      _scheduleStrategicFetch('init');
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
        if (c && STRATEGIC_STATE._cursorMoveHandler) c.removeEventListener('touchstart', STRATEGIC_STATE._cursorMoveHandler, true);
        if (c && STRATEGIC_STATE._cursorMoveHandler) c.removeEventListener('touchmove', STRATEGIC_STATE._cursorMoveHandler, true);
      } catch (_) {}
      STRATEGIC_STATE._cursorMoveHandler = null;
      try {
        const c = map.getContainer();
        if (c && STRATEGIC_STATE._cursorLeaveHandler) c.removeEventListener('mouseleave', STRATEGIC_STATE._cursorLeaveHandler);
        if (c && STRATEGIC_STATE._cursorLeaveHandler) c.removeEventListener('touchcancel', STRATEGIC_STATE._cursorLeaveHandler);
      } catch (_) {}
      STRATEGIC_STATE._cursorLeaveHandler = null;
      try {
        if (STRATEGIC_STATE._clickHandler) map.off('click', STRATEGIC_STATE._clickHandler);
      } catch (_) {}
      STRATEGIC_STATE._clickHandler = null;
      _hideStrategicCursorReadout();

      try {
        if (CLIMATE_PROFILE_STATE.selectedMarker) map.removeLayer(CLIMATE_PROFILE_STATE.selectedMarker);
      } catch (_) {}

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
      _strategicApplyTimescaleSelection(String(strategicTimescaleSelect.value || 'daily'));
    });
  }
  if (strategicLayerSelect) {
    strategicLayerSelect.addEventListener('change', () => {
      STRATEGIC_STATE.layer = strategicLayerSelect.value;
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
      try { SETTINGS.strategicWindOn = Boolean(strategicWindOn.checked); } catch (_) {}
      _renderStrategic();
    });
  }
  if (strategicWindMode) {
    strategicWindMode.addEventListener('change', () => {
      STRATEGIC_STATE.windMode = strategicWindMode.value;
      try { SETTINGS.strategicWindMode = String(strategicWindMode.value || 'flow'); } catch (_) {}
      _renderStrategic();
    });
  }
  if (strategicDaySlider) {
    strategicDaySlider.addEventListener('input', () => {
      const ts = String(STRATEGIC_STATE.timescale || 'daily');
      const doy = _strategicSliderValueToDOY(strategicDaySlider.value, ts);
      _strategicSetDOY(doy);
      _scheduleStrategicFetch('doy');
    });
  }

  // Range slider: the native <input type="range"> elements are hidden and kept
  // only as state holders. Interactions are handled by explicit L/C/R elements.

  try {
    if (strategicRangeWrap && (strategicRangeThumbStart || strategicRangeHandle || strategicRangeThumbEnd)) {
      let drag = null;

      const begin = (mode, ev) => {
        ev.preventDefault();
        const { startDoy, endDoy, durationDays } = _strategicGetRangeDOY();
        const rect = strategicRangeWrap.getBoundingClientRect();
        drag = {
          mode,
          pointerId: ev.pointerId,
          x0: ev.clientX,
          w: Math.max(1, rect.width),
          start0: startDoy,
          end0: endDoy,
          dur: durationDays,
        };
        _strategicSetActiveRangeElement(mode === 'start' ? 'L' : (mode === 'end' ? 'R' : 'C'));
        try { _strategicShowRangeTooltip(); } catch (_) {}
        try {
          if (mode === 'center' && strategicRangeHandle) strategicRangeHandle.classList.add('wm-dragging');
        } catch (_) {}
      };

      const move = (ev) => {
        if (!drag) return;
        ev.preventDefault();
        if (drag.mode === 'start') {
          const d = _strategicDoyFromClientX(ev.clientX);
          const s2 = Math.min(drag.end0, d);
          _strategicSetRange(s2, drag.end0, { skipFetch: true });
          return;
        }
        if (drag.mode === 'end') {
          const d = _strategicDoyFromClientX(ev.clientX);
          const e2 = Math.max(drag.start0, d);
          _strategicSetRange(drag.start0, e2, { skipFetch: true });
          return;
        }
        // center: keep duration and shift by mouse delta so the cursor stays over C.
        const dx = Number(ev.clientX) - Number(drag.x0);
        const deltaDaysFloat = (dx * 365) / Math.max(1, Number(drag.w));
        const deltaDays = Math.round(deltaDaysFloat);
        const maxStart = Math.max(1, 365 - drag.dur + 1);
        const s2 = Math.max(1, Math.min(maxStart, _clampDOYInt(drag.start0 + deltaDays)));
        const e2 = Math.max(s2, Math.min(365, s2 + drag.dur - 1));
        _strategicSetRange(s2, e2, { skipFetch: true });
      };

      const end = (ev) => {
        if (!drag) return;
        ev.preventDefault();
        drag = null;
        try { if (strategicRangeHandle) strategicRangeHandle.classList.remove('wm-dragging'); } catch (_) {}
        _strategicSetActiveRangeElement('');
        try { _strategicShowRangeTooltip(); } catch (_) {}
        try {
          const { startDoy, endDoy } = _strategicGetRangeDOY();
          _strategicSetRange(startDoy, endDoy, { skipFetch: false });
        } catch (_) {}
      };

      const attach = (el, mode) => {
        if (!el) return;
        el.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          try { el.setPointerCapture(ev.pointerId); } catch (_) {}
          begin(mode, ev);
        });
        el.addEventListener('pointermove', (ev) => {
          ev.stopPropagation();
          move(ev);
        });
        el.addEventListener('pointerup', (ev) => {
          ev.stopPropagation();
          end(ev);
        });
        el.addEventListener('pointercancel', (ev) => {
          ev.stopPropagation();
          end(ev);
        });
      };

      attach(strategicRangeThumbStart, 'start');
      attach(strategicRangeThumbEnd, 'end');
      attach(strategicRangeHandle, 'center');
    }
  } catch (_) {}

  if (strategicPlayBtn) {
    strategicPlayBtn.addEventListener('click', () => {
      STRATEGIC_STATE.playing = !STRATEGIC_STATE.playing;
      strategicPlayBtn.textContent = STRATEGIC_STATE.playing ? 'Pause' : '▶ Play Season';
      if (STRATEGIC_STATE.playTimer) {
        try { clearTimeout(STRATEGIC_STATE.playTimer); } catch (_) {}
        STRATEGIC_STATE.playTimer = null;
      }
      if (STRATEGIC_STATE.playing) {
        const tick = async () => {
          if (!STRATEGIC_STATE.playing) return;
          const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

          if (_strategicUsingRangeUI()) {
            const step = 1;
            const { startDoy, durationDays } = _strategicGetRangeDOY();
            const maxStart = Math.max(1, 365 - durationDays + 1);
            let s2 = startDoy + step;
            if (s2 > maxStart) s2 = 1;
            const e2 = Math.max(s2, Math.min(365, s2 + durationDays - 1));
            // Avoid queuing a delayed fetch; we fetch+render immediately below.
            _strategicSetRange(s2, e2, { skipFetch: true });
          } else {
            const ts = String(STRATEGIC_STATE.timescale || 'daily');
            const spec = _strategicSliderSpec(ts);
            const cur = _strategicDOYToSliderValue(STRATEGIC_STATE.doy, ts);
            let next = Number(cur) + 1;
            if (next > spec.max) next = spec.min;
            const doy = _strategicSliderValueToDOY(next, ts);
            _strategicSetDOY(doy);
          }

          try {
            await _strategicFlushNow('play');
          } catch (e) {
            console.error('strategic play tick', e);
          }

          const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          const elapsed = Math.max(0, Number(t1) - Number(t0));
          // Pace the loop so we never build a backlog: next tick only after the
          // previous fetch+render finished, with a small breathing gap.
          const minPeriod = 220;
          const gap = 20;
          const delay = Math.max(gap, Math.round(minPeriod - elapsed + gap));
          if (STRATEGIC_STATE.playing) STRATEGIC_STATE.playTimer = setTimeout(tick, delay);
        };
        STRATEGIC_STATE.playTimer = setTimeout(tick, 0);
      } else {
        // Fallback: ensure we end on a fully rendered frame.
        _strategicFlushNow('pause').catch(() => {});
      }
    });
  }

  function _strategicStepOnce(delta) {
    const tour = _tourIsActive();
    if (!tour && (!STRATEGIC_STATE || !STRATEGIC_STATE.active)) return;
    // If stepping manually, pause playback.
    if (STRATEGIC_STATE.playing) {
      STRATEGIC_STATE.playing = false;
      try { if (strategicPlayBtn) strategicPlayBtn.textContent = '▶ Play Season'; } catch (_) {}
      if (STRATEGIC_STATE.playTimer) {
        try { clearTimeout(STRATEGIC_STATE.playTimer); } catch (_) {}
        STRATEGIC_STATE.playTimer = null;
      }
      // Ensure we don't leave a queued/partial frame behind.
      try { _cancelStrategicPendingFetch(); } catch (_) {}
    }
    if (_strategicUsingRangeUI()) {
      const d = Math.sign(Number(delta || 0)) * 1;
      const { startDoy, durationDays } = _strategicGetRangeDOY();
      const maxStart = Math.max(1, 365 - durationDays + 1);
      let s2 = startDoy + d;
      if (s2 > maxStart) s2 = 1;
      if (s2 < 1) s2 = maxStart;
      const e2 = Math.max(s2, Math.min(365, s2 + durationDays - 1));
      _strategicSetRange(s2, e2, { skipFetch: false });
      return;
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
    _scheduleStrategicFetch('doy');
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
    // Always redraw immediately; Leaflet resets canvases on zoom/pan.
    _renderStrategic();
    // Fetch only when the new viewport isn't covered by the last response.
    if (_strategicViewNeedsFetch()) _scheduleStrategicFetch('viewport');
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
    if (setTempCold) setTempCold.value = String(_domainValueToSliderRaw(setTempCold, s.tempCold));
    if (setTempHot) setTempHot.value = String(_domainValueToSliderRaw(setTempHot, s.tempHot));
    if (setRainHigh) setRainHigh.value = s.rainHigh;
    if (setWindHeadComfort) setWindHeadComfort.value = s.windHeadComfort;
    if (setWindTailComfort) setWindTailComfort.value = s.windTailComfort;

    try {
      if (setStrategicYears) {
        const yrs = (Array.isArray(s.strategicYears) && s.strategicYears.length)
          ? s.strategicYears
          : [Number(s.strategicYear || STRATEGIC_DEFAULT_YEAR)];
        _renderStrategicYearsButtons(setStrategicYears, yrs, _setStrategicYears, { includeAll: true });
      }
    } catch (_) {}
    if (setIncludeSea) setIncludeSea.checked = Boolean(s.includeSea);
    if (setInterpolation) setInterpolation.checked = Boolean(s.interpolation);
    if (strategicWindOn) strategicWindOn.checked = Boolean(s.strategicWindOn);
    if (strategicWindMode) strategicWindMode.value = String(s.strategicWindMode || 'flow');
    if (setWindDensity) setWindDensity.value = String(Number(s.windDensity || 40));
    if (setAnimSpeed) setAnimSpeed.value = String(Number(s.animSpeed || 1.0));
    if (setGridKm) setGridKm.value = String(Number(s.gridKm || 50));
    const activeHours = _parseActiveHoursRange(_getActiveHoursValue(s));
    if (setActiveHourStart) setActiveHourStart.value = String(activeHours.start);
    if (setActiveHourEnd) setActiveHourEnd.value = String(activeHours.end);
    if (setWindWeighting) setWindWeighting.value = String(s.windWeighting || 'relative');

    if (setOverlayMode) setOverlayMode.value = _normalizeOverlayMode(String(s.overlayMode || 'temperature'));
    if (profileOverlaySelect) profileOverlaySelect.value = _normalizeOverlayMode(String(s.overlayMode || 'temperature'));
    try { _refreshPreferencesUi(); } catch (_) {}
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
    base.tempCold = _sliderRawToDomainValue(setTempCold, setTempCold && setTempCold.value);
    if (!Number.isFinite(base.tempCold)) base.tempCold = 5;
    base.tempHot = _sliderRawToDomainValue(setTempHot, setTempHot && setTempHot.value);
    if (!Number.isFinite(base.tempHot)) base.tempHot = 30;
    base.rainHigh = Number(setRainHigh && setRainHigh.value);
    if (!Number.isFinite(base.rainHigh)) base.rainHigh = 10;
    base.windHeadComfort = Number(setWindHeadComfort && setWindHeadComfort.value);
    if (!Number.isFinite(base.windHeadComfort)) base.windHeadComfort = 4;
    base.windTailComfort = Number(setWindTailComfort && setWindTailComfort.value);
    if (!Number.isFinite(base.windTailComfort)) base.windTailComfort = 10;
    base.glyphType = 'svg';
    base.useClassicWeatherIcons = false;
    base.weatherVisualizationMode = 'glyphs';

    // Strategic years/mode are controlled via toggle buttons (not standard form elements).
    try {
      const yrs = _uniqYearsDesc(base.strategicYears || [base.strategicYear || STRATEGIC_DEFAULT_YEAR]);
      base.strategicYears = yrs.length ? yrs : [STRATEGIC_DEFAULT_YEAR];
      base.strategicYear = Math.round(Number(base.strategicYears[0] || STRATEGIC_DEFAULT_YEAR));
      const m = (String(base.strategicMode || '') === 'full_day') ? 'full_day' : 'active';
      base.strategicMode = m;
    } catch (_) {
      base.strategicYears = [Number(base.strategicYear || STRATEGIC_DEFAULT_YEAR)];
      base.strategicMode = (String(base.strategicMode || '') === 'full_day') ? 'full_day' : 'active';
    }
    base.includeSea = Boolean(setIncludeSea && setIncludeSea.checked);
    base.interpolation = Boolean(setInterpolation && setInterpolation.checked);
    base.strategicWindOn = Boolean(strategicWindOn && strategicWindOn.checked);
    base.strategicWindMode = String(strategicWindMode && strategicWindMode.value ? strategicWindMode.value : 'flow');
    base.windDensity = Number(setWindDensity && setWindDensity.value) || 40;
    base.animSpeed = Number(setAnimSpeed && setAnimSpeed.value) || 1.0;
    base.gridKm = Number(setGridKm && setGridKm.value) || 50;
    base.activeHours = _formatActiveHoursRange(
      Number(setActiveHourStart && setActiveHourStart.value),
      Number(setActiveHourEnd && setActiveHourEnd.value)
    );
    base.rideHours = base.activeHours;
    try { delete base.tentHours; } catch (_) {}
    base.windWeighting = String(setWindWeighting && setWindWeighting.value ? setWindWeighting.value : 'relative');
    base.overlayMode = _normalizeOverlayMode(String(setOverlayMode && setOverlayMode.value ? setOverlayMode.value : 'temperature'));
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
        // Preferences should be the single source of truth for strategic years/mode.
        try {
          const years = _uniqYearsDesc((SETTINGS && SETTINGS.strategicYears) ? SETTINGS.strategicYears : [Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR)]);
          STRATEGIC_STATE.years = years.length ? years : [Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR)];
          STRATEGIC_STATE.year = Number(STRATEGIC_STATE.years[0] || SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR);
          STRATEGIC_STATE.mode = (String(SETTINGS && SETTINGS.strategicMode || '') === 'full_day') ? 'full_day' : 'active';
        } catch (_) {}
        try { _strategicSetYear(Number(STRATEGIC_STATE.year || STRATEGIC_DEFAULT_YEAR)); } catch (_) {}
        _renderStrategic();
        if (_strategicViewNeedsFetch()) _scheduleStrategicFetch('prefs');
      }
    } catch (_) {}
  }

  function _applySettingsWithRefresh() {
    const prev = SETTINGS ? { ...SETTINGS } : {};
    try { applyPrefsFromFormAndPersist(); } catch (_) {}
    const next = SETTINGS ? { ...SETTINGS } : {};

    let needsRefetch = false;
    try {
      for (const k of SETTINGS_REFETCH_KEYS) {
        if (String(prev && prev[k]) !== String(next && next[k])) {
          needsRefetch = true;
          break;
        }
      }
    } catch (_) {
      needsRefetch = true;
    }

    if (needsRefetch) {
      loadMap({ forceRestart: true });
    } else {
      if (STRATEGIC_STATE && STRATEGIC_STATE.active) {
        try { _strategicSetYear(Number(SETTINGS.strategicYear || STRATEGIC_DEFAULT_YEAR)); } catch (_) {}
        try { if (_strategicViewNeedsFetch()) _scheduleStrategicFetch('prefs'); } catch (_) {}
        try { _renderStrategic(); } catch (_) {}
      }
      if (LAST_PROFILE) drawProfile(LAST_PROFILE);
    }

    try {
      if (STRATEGIC_STATE && STRATEGIC_STATE.active) {
        _refreshClimateProfileSelection({ force: true, immediate: true });
      }
    } catch (_) {}
  }

  function applySettings(data) {
    if (!data || typeof data !== 'object') return false;
    SETTINGS = _coerceSettings({ ...(SETTINGS || {}), ...data }, _defaultSettings());
    try { applySettingsToForm(SETTINGS); } catch (_) {}
    try { _applySettingsWithRefresh(); } catch (_) {}
    return true;
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
    const hasPins = (!wantBands) && _tourShowProfilePins() && Array.isArray(OVERLAY_POINTS) && OVERLAY_POINTS.length > 0;
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
    if (_tourIsActive()) {
      neededTop = Math.max(neededTop, 14);
    }
    // Increase bottom padding slightly to ensure x-axis ticks and labels are fully visible
    // Increase right padding to ensure right-side ticks/labels/color bars aren't clipped
    const padBot = wantBands ? 34 : 22;
    return { padTop: Math.max(minTop, neededTop), padBot, padL: 18, padR: 18 };
  }

  function _drawTourProfileDayMarkers(profile, xAt, padTop, innerH, axisLen) {
    if (!_tourIsActive()) return;
    try {
      const bounds = Array.isArray(profile && profile.day_boundaries) ? profile.day_boundaries : [];
      const routePoints = Array.isArray(OVERLAY_POINTS) ? OVERLAY_POINTS : [];
      const totalDays = Math.max(1, Math.round(Number(tourDaysInput && tourDaysInput.value) || (bounds.length + 1) || 1));
      const marks = bounds
        .map((b) => Number(b && b.distance_km))
        .filter((v) => Number.isFinite(v) && v > 0 && v < axisLen)
        .sort((a, b) => a - b);
      const chartTop = Math.max(0, Math.round(padTop));
      const chartBottom = Math.max(chartTop + 64, Math.round(padTop + Math.max(1, innerH)));
      const desiredTop = chartTop + 10;
      const stackTop = Math.min(chartBottom - 68, Math.max(chartTop + 10, desiredTop));
      const boxW = 48;
      const boxH = 62;
      const luckyY = stackTop + 10;
      const tempY = stackTop + 23;
      const iconTop = stackTop + 25;
      const rainY = stackTop + 49;
      const dateY = stackTop + 58;
      const canvasRect = profileCanvas && profileCanvas.getBoundingClientRect ? profileCanvas.getBoundingClientRect() : null;
      const canvasWidth = Math.max(boxW, Math.round(canvasRect && Number.isFinite(canvasRect.width) ? canvasRect.width : 0));

      const drawLabelBox = (cx, topY) => {
        const x0 = Math.round(cx - boxW / 2);
        const y0 = Math.round(topY);
        const radius = 11;
        profileCtx.save();
        profileCtx.shadowColor = 'rgba(15, 23, 42, 0.10)';
        profileCtx.shadowBlur = 14;
        profileCtx.shadowOffsetY = 3;
        profileCtx.fillStyle = 'rgba(255,255,255,0.74)';
        profileCtx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
        profileCtx.lineWidth = 1;
        profileCtx.beginPath();
        profileCtx.moveTo(x0 + radius, y0);
        profileCtx.lineTo(x0 + boxW - radius, y0);
        profileCtx.quadraticCurveTo(x0 + boxW, y0, x0 + boxW, y0 + radius);
        profileCtx.lineTo(x0 + boxW, y0 + boxH - radius);
        profileCtx.quadraticCurveTo(x0 + boxW, y0 + boxH, x0 + boxW - radius, y0 + boxH);
        profileCtx.lineTo(x0 + radius, y0 + boxH);
        profileCtx.quadraticCurveTo(x0, y0 + boxH, x0, y0 + boxH - radius);
        profileCtx.lineTo(x0, y0 + radius);
        profileCtx.quadraticCurveTo(x0, y0, x0 + radius, y0);
        profileCtx.closePath();
        profileCtx.fill();
        profileCtx.shadowColor = 'transparent';
        profileCtx.stroke();
        profileCtx.restore();
      };

      profileCtx.save();
      profileCtx.globalAlpha = 1;
      profileCtx.globalCompositeOperation = 'source-over';
      try { profileCtx.filter = 'none'; } catch (_) {}
      profileCtx.shadowColor = 'transparent';
      profileCtx.shadowBlur = 0;
      profileCtx.shadowOffsetX = 0;
      profileCtx.shadowOffsetY = 0;
      profileCtx.setLineDash([]);
      profileCtx.textAlign = 'center';
      profileCtx.textBaseline = 'middle';

      for (let dayIdx = 0; dayIdx < totalDays; dayIdx++) {
        try {
          const fallbackStartDist = (axisLen * dayIdx) / totalDays;
          const fallbackEndDist = (axisLen * (dayIdx + 1)) / totalDays;
          const startDist = (dayIdx === 0)
            ? 0
            : (Number.isFinite(Number(marks[dayIdx - 1])) ? Number(marks[dayIdx - 1]) : fallbackStartDist);
          const endDist = (dayIdx < marks.length)
            ? Number(marks[dayIdx])
            : fallbackEndDist;
          const midDist = startDist + Math.max(0, endDist - startDist) * 0.5;
          const sample = _tourSampleAtDist(midDist);
          let dayPoints = routePoints.filter((point) => Number(point && point.tourDayIndex) === dayIdx);
          if (!dayPoints.length) {
            dayPoints = routePoints.filter((point) => {
              const dk = Number(point && point.dist);
              return Number.isFinite(dk) && dk >= startDist && dk < endDist;
            });
          }
          const daySummary = _tourSummarizeDayPoints(dayPoints);
          const rawX = xAt(midDist);
          if (!Number.isFinite(rawX)) continue;
          const x = Math.max(boxW / 2, Math.min(canvasWidth - boxW / 2, rawX));
          const tMed = Number.isFinite(Number(daySummary && daySummary.tempMedian))
            ? Number(daySummary.tempMedian)
            : Number.isFinite(Number(sample && sample.temp_day_median))
              ? Number(sample.temp_day_median)
              : Number.isFinite(Number(sample && sample.temperature))
                ? Number(sample.temperature)
                : Number.isFinite(Number(sample && sample.temp_hist_median))
                  ? Number(sample.temp_hist_median)
                  : null;
          const rainMm = Number.isFinite(Number(daySummary && daySummary.precipSum))
            ? Number(daySummary.precipSum)
            : Number.isFinite(Number(sample && sample.rainTypical))
              ? Number(sample.rainTypical)
              : null;
          const rainProb = Number.isFinite(Number(daySummary && daySummary.rainProb))
            ? Number(daySummary.rainProb)
            : Number(sample && sample.rainProb);
          const iconClass = mapWeatherByProb(rainProb);
          const lucky = (daySummary && typeof daySummary.lucky === 'boolean') ? daySummary.lucky : null;
          const dateLabel = _tourRouteDayCardDateLabel(dayIdx) || '—';
          const rainLabel = Number.isFinite(rainMm) ? `${fmt(rainMm, 0)} mm` : '';

          drawLabelBox(x, stackTop);

          if (Number.isFinite(tMed)) {
            profileCtx.fillStyle = '#0f172a';
            profileCtx.font = '600 12px system-ui, -apple-system, sans-serif';
            profileCtx.fillText(`${Math.round(tMed)}°`, x, tempY);
          }
          renderWeatherIcon(profileCtx, x, iconTop, iconClass, 20);
          if (typeof lucky === 'boolean') {
            profileCtx.beginPath();
            profileCtx.arc(x, luckyY, 4.4, 0, Math.PI * 2);
            profileCtx.fillStyle = lucky ? '#47d764' : '#b3b3b3';
            profileCtx.fill();
            profileCtx.strokeStyle = lucky ? 'rgba(20, 126, 56, 0.95)' : 'rgba(120, 132, 145, 0.72)';
            profileCtx.lineWidth = 1.2;
            profileCtx.stroke();
          }
          if (rainLabel) {
            profileCtx.fillStyle = '#64748b';
            profileCtx.font = '500 9px system-ui, -apple-system, sans-serif';
            profileCtx.fillText(rainLabel, x, rainY);
          }
          profileCtx.fillStyle = '#64748b';
          profileCtx.font = '500 10px system-ui, -apple-system, sans-serif';
          profileCtx.fillText(dateLabel, x, dateY);
        } catch (_) {
          continue;
        }
      }
      profileCtx.restore();
    } catch (_) {}
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
      _reflowBottomLayout();
      // Align tooltip just above the profile panel (legacy floating tooltip only)
      const tsdbH = tourSummaryPanel && tourSummaryPanel.offsetHeight ? tourSummaryPanel.offsetHeight : 64;
      const bottomGap = hh + tsdbH + 16; // slight spacing above profile
      try {
        if (profileTooltip && profilePanel && profileTooltip.parentElement === profilePanel) {
          profileTooltip.style.bottom = `${bottomGap}px`;
        }
      } catch (_) {}
      // Resize canvases and redraw
      resizeProfileCanvas();
      if (_climateProfileIsActive()) {
        if (LAST_CLIMATE_PROFILE) drawClimateProfile(LAST_CLIMATE_PROFILE);
        else if (CLIMATE_PROFILE_STATE.loadingPoint) _renderClimateLoading(CLIMATE_PROFILE_STATE.loadingPoint);
        else _drawClimateProfilePlaceholder('');
      } else if (LAST_PROFILE) {
        drawProfile(LAST_PROFILE);
      }
      // Persist
      try { localStorage.setItem('wm_profile_height', String(hh)); } catch(_) {}
    } catch (e) { console.warn('setProfileHeight error', e); }
  }

  let PROFILE_REDRAW_RAF = 0;
  function _scheduleProfileRedraw() {
    try {
      if (PROFILE_REDRAW_RAF) {
        try { cancelAnimationFrame(PROFILE_REDRAW_RAF); } catch (_) {}
        PROFILE_REDRAW_RAF = 0;
      }
      PROFILE_REDRAW_RAF = requestAnimationFrame(() => {
        PROFILE_REDRAW_RAF = 0;
        try {
          if (_climateProfileIsActive()) {
            if (LAST_CLIMATE_PROFILE) drawClimateProfile(LAST_CLIMATE_PROFILE);
            else if (CLIMATE_PROFILE_STATE.loadingPoint) _renderClimateLoading(CLIMATE_PROFILE_STATE.loadingPoint);
            else _drawClimateProfilePlaceholder('');
            return;
          }
          if (LAST_PROFILE) drawProfile(LAST_PROFILE);
        } catch (_) {}
      });
    } catch (_) {}
  }

  // Initialize profile height from storage
  (function initProfileHeight(){
    try {
      const s = localStorage.getItem('wm_profile_height');
      const h = s ? Number(s) : 220;
      setProfileHeight(h);
    } catch(_) { setProfileHeight(220); }
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
            const tMid = 0.5 * (tA + tB);
            profileCtx.fillStyle = tempColor(tMid);
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
      const xScale = padL + innerW;
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
      } else if (overlayAxisInfo.mode === 'wind_component') {
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
        profileCtx.fillText('Head/Tail-Wind (m/s)', xScale - 4, padTop + 12);
      } else if (overlayAxisInfo.mode === 'wind_absolute') {
        const { maxWind, yAtW } = overlayAxisInfo;
        profileCtx.strokeStyle = '#666';
        profileCtx.fillStyle = '#666';
        profileCtx.lineWidth = 1;
        profileCtx.font = '10px system-ui, -apple-system, sans-serif';
        profileCtx.textAlign = 'right';
        const step = maxWind <= 8 ? 2 : (maxWind <= 14 ? 3 : 4);
        for (let tv = 0; tv <= maxWind + 1e-6; tv += step) {
          const y = yAtW(tv);
          profileCtx.beginPath();
          profileCtx.moveTo(xScale - tickLen, y);
          profileCtx.lineTo(xScale, y);
          profileCtx.stroke();
          const suffix = (tv + step > maxWind + 1e-6) ? ' m/s' : '';
          profileCtx.fillText(`${Math.round(tv)}${suffix}`, xScale - 4, y + 3);
        }
        profileCtx.fillText('Wind (m/s)', xScale - 4, padTop + 12);
      }
    }
    profileCtx.strokeStyle = '#7b8794';
    profileCtx.lineWidth = 1;
    profileCtx.beginPath();
    profileCtx.moveTo(padL, padTop);
    profileCtx.lineTo(padL, padTop + innerH);
    profileCtx.moveTo(padL + innerW, padTop);
    profileCtx.lineTo(padL + innerW, padTop + innerH);
    profileCtx.stroke();
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

    _drawTourProfileDayMarkers(profile, xAt, padTop, innerH, axisLen);

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
    if (!wantBands && _tourShowProfilePins()) {
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
    CURSOR_X_SCALE = 1;
    try { _initializeTourCursorReadoutFromStart(); } catch (_) {}
    
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

  function _tourProfileCursorTargetAtDistance(routeKm) {
    try {
      if (!LAST_PROFILE || !profileCanvas) return null;
      const dist = Array.isArray(LAST_PROFILE.sampled_dist_km) ? LAST_PROFILE.sampled_dist_km : [];
      if (!dist.length || !Array.isArray(ROUTE_CUM_DISTS) || ROUTE_CUM_DISTS.length < 2) return null;
      const routeLen = Number(ROUTE_CUM_DISTS[ROUTE_CUM_DISTS.length - 1] || 0);
      const profLen = Number(dist[dist.length - 1] || 0);
      if (!(Number.isFinite(routeLen) && routeLen > 0)) return null;
      const scale = (Number.isFinite(profLen) && profLen > 0) ? (routeLen / profLen) : 1;
      const targetRouteKm = Math.max(0, Math.min(routeLen, Number(routeKm || 0)));
      const targetProfKm = targetRouteKm / Math.max(scale, 1e-9);

      let lo = 0;
      let hi = dist.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (Number(dist[mid]) < targetProfKm) lo = mid + 1;
        else hi = mid;
      }
      let index = lo;
      if (index > 0) {
        const cur = Math.abs(Number(dist[index]) - targetProfKm);
        const prev = Math.abs(Number(dist[index - 1]) - targetProfKm);
        if (prev <= cur) index -= 1;
      }

      const rect = profileCanvas.getBoundingClientRect();
      const { padL, padR } = getPads();
      const W = Math.max(1, Math.floor(rect.width));
      const innerW = Math.max(1, W - padL - padR);
      const xDisplay = padL + innerW * (targetRouteKm / routeLen);
      return { index, xDisplay };
    } catch (_) {
      return null;
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
    const x = xDisplay;
    // Clear cursor canvas and draw vertical dashed line
    profileCursorCtx.clearRect(0, 0, W, H);
    profileCursorCtx.strokeStyle = 'rgba(71, 85, 105, 0.78)';
    profileCursorCtx.lineWidth = 2;
    profileCursorCtx.lineCap = 'round';
    profileCursorCtx.shadowColor = 'rgba(148, 163, 184, 0.18)';
    profileCursorCtx.shadowBlur = 2;
    profileCursorCtx.setLineDash([5,5]);
    profileCursorCtx.beginPath();
    profileCursorCtx.moveTo(x, padTop);
    profileCursorCtx.lineTo(x, padTop + innerH);
    profileCursorCtx.stroke();
    profileCursorCtx.setLineDash([]);
    profileCursorCtx.shadowBlur = 0;

    // Removed: secondary snapped grid line; keep single dashed cursor only

    // Optional debug overlay to compare coordinate methods
    if (DEBUG_CURSOR) {
      try {
        // Draw a small marker at snapped profile x
        if (Number.isFinite(snapX)) {
          profileCursorCtx.fillStyle = 'rgba(30,144,255,0.9)';
          profileCursorCtx.beginPath();
          profileCursorCtx.arc(snapX, padTop + 8, 3, 0, Math.PI*2);
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
    const overlayPoints = Array.isArray(OVERLAY_POINTS) ? OVERLAY_POINTS : [];
    let best = null, bestDiff = Infinity;
    for (const p of overlayPoints) {
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
    let dateStr = '—';
    try {
      const sd = startDateInput.value ? new Date(startDateInput.value) : null;
      if (sd) {
        const d2 = new Date(sd);
        d2.setDate(d2.getDate() + dayIdx);
        dateStr = _fmtIsoDayMonthCompact(d2.toISOString().slice(0, 10));
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
    const yearsTxt = `${yearsStart===null||yearsEnd===null?'—':`${yearsStart}–${yearsEnd}`}${matchDays===null?'':` (n=${Math.round(matchDays)})`}`;
    const rangeMin = Number.isFinite(dayTypicalMin) ? dayTypicalMin : histMin;
    const rangeMax = Number.isFinite(dayTypicalMax) ? dayTypicalMax : histMax;
    const tempRangeTxt = (Number.isFinite(rangeMin) && Number.isFinite(rangeMax)) ? ` (${fmt(rangeMin, 0)}–${fmt(rangeMax, 0)}°C)` : '';
    const tempText = Number.isFinite(tempHistMedian) ? `${fmt(tempHistMedian, 0)}°C${tempRangeTxt}` : '—';
    const effNum = (effWind !== null && Number.isFinite(effWind)) ? Number(effWind) : null;
    const effLabel = (effNum !== null && effNum < 0) ? 'headwind' : 'tailwind';
    const windText = (wspd === null || wspd === undefined || wdir === null || wdir === undefined)
      ? '—'
      : `${fmt(wspd, 1)} m/s @ ${fmt(wdir, 0)}°${effNum === null ? '' : ` (${effLabel} ${fmt(Math.abs(effNum), 1)} m/s)`}`;
    const rainText = (rainTyp === null || rainTyp === undefined)
      ? '—'
      : `${fmt(rainTyp, 1)} mm${rainP === null ? '' : ` (${rainP}%)`}`;
    const routePointLatLng = routeLatLngAtDistanceKm(dkm);
    const locationKey = routePointLatLng ? _strategicLocationLabelKey(routePointLatLng.lat, routePointLatLng.lng) : '';
    const locationText = routePointLatLng
      ? ((locationKey && STRATEGIC_LOCATION_LABEL_CACHE.has(locationKey))
          ? STRATEGIC_LOCATION_LABEL_CACHE.get(locationKey)
          : _strategicLocationFallbackLabel(routePointLatLng.lat, routePointLatLng.lng))
      : 'Route segment';
    const metaBits = [
      `Day ${dayIdx + 1}`,
      dateStr,
      `${fmt(dkm, 1)} km`,
      `${fmt(elev, 0)} m`,
      yearsTxt,
    ].filter((part) => String(part || '').trim() && String(part) !== '—');
    _renderTourCursorReadout({
      location: locationText,
      locationKey,
      meta: metaBits.join(' • '),
      tempText,
      windText,
      rainText,
    });
    if (routePointLatLng && locationKey && !STRATEGIC_LOCATION_LABEL_CACHE.has(locationKey)) {
      _requestLocationLabel(routePointLatLng.lat, routePointLatLng.lng, (label, key) => {
        try {
          if (!profileTooltip || String(profileTooltip.dataset.locationKey || '') !== String(key || '')) return;
          const node = profileTooltip.querySelector('[data-role="location"]');
          if (node) node.textContent = String(label || '—');
        } catch (_) {}
      });
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
    } else if (OVERLAY_MODE === 'wind_component') {
      // Head/tail wind profile: effective wind (-8..+8 m/s) and variability band
      const windData = window.computeEffectiveWind ? window.computeEffectiveWind(pts, profile) : null;
      if (windData && window.drawWindProfile) {
        const windAxisInfo = window.drawWindProfile(profileCtx, windData, { padTop, padBot, padL, padR, innerW, innerH, xAt });
        if (windAxisInfo) return { mode: 'wind_component', ...windAxisInfo };
      }
    } else if (OVERLAY_MODE === 'wind_absolute') {
      const valid = pts.filter(p => Number.isFinite(Number(p.windSpeed)) && Number.isFinite(Number(p.dist)));
      if (valid.length >= 2) {
        let maxWind = 12;
        for (const point of valid) {
          const wind = Number(point.windSpeed);
          if (Number.isFinite(wind) && wind > maxWind) maxWind = wind;
        }
        maxWind = Math.max(8, Math.ceil(maxWind));
        const yAtW = (wind) => {
          const speed = Math.max(0, Math.min(maxWind, Number(wind) || 0));
          const u = speed / Math.max(1e-6, maxWind);
          return padTop + innerH - Math.round(innerH * u);
        };
        profileCtx.lineWidth = 2;
        profileCtx.lineJoin = 'round';
        profileCtx.lineCap = 'round';
        for (let i = 1; i < valid.length; i++) {
          const p0 = valid[i - 1];
          const p1 = valid[i];
          const x0 = xAt(Number(p0.dist));
          const y0 = yAtW(Number(p0.windSpeed));
          const x1 = xAt(Number(p1.dist));
          const y1 = yAtW(Number(p1.windSpeed));
          profileCtx.strokeStyle = _tourWindAbsoluteColor((Number(p0.windSpeed) + Number(p1.windSpeed)) * 0.5);
          profileCtx.beginPath();
          profileCtx.moveTo(x0, y0);
          profileCtx.lineTo(x1, y1);
          profileCtx.stroke();
        }
        const minArrowSpacingPx = 76;
        let lastArrowX = -Infinity;
        for (let i = 0; i < valid.length; i++) {
          const point = valid[i];
          const x = xAt(Number(point.dist));
          if ((x - lastArrowX) < minArrowSpacingPx && i !== valid.length - 1) continue;
          const y = yAtW(Number(point.windSpeed));
          _drawClimateWindArrow(profileCtx, x, Math.max(padTop + 6, y - 18), Number(point.windSpeed), Number(point.windDir), maxWind);
          lastArrowX = x;
        }
        return { mode: 'wind_absolute', maxWind, yAtW };
      }
    }
  }

  async function loadMap(opts) {
    // In Climatic Map mode, *never* fetch route/weather along GPX.
    if (!_tourIsActive()) {
      try { if (evtSource) evtSource.close(); } catch (_) {}
      try { if (window.__WM_PRIME_EVT_SOURCE__) window.__WM_PRIME_EVT_SOURCE__.close(); } catch (_) {}
      try { if (evtSourceProfile) evtSourceProfile.close(); } catch (_) {}
      PRIME_IN_PROGRESS = false;
      MAIN_IN_PROGRESS = false;
      try { stopProgressAnim(); } catch (_) {}
      try { if (fetchWeatherBtn) { updateFetchWeatherLabel(); fetchWeatherBtn.disabled = false; } } catch (_) {}
      try { if (stopWeatherBtn) stopWeatherBtn.style.display = 'none'; } catch (_) {}
      try { if (sseStatus) sseStatus.textContent = 'Stream: idle (Climatic Map mode)'; } catch (_) {}
      return;
    }

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
      try { _clearTourRouteDayCards(); } catch (_) {}
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
    // loadMap is TOUR-only (climate mode returns at the top). Keep params consistent and
    // prevent accidental SSE calls with tour_planning=0 during mode-switch races.
    const tourPlanningParam = '1';
    // Subscribe to streaming map data (route + per-station glyphs)
    const tourDays = Number(tourDaysInput?.value || 7);
    const startDateStr = startDateInput && startDateInput.value ? startDateInput.value : new Date().toISOString().slice(0,10);
    const gpxParam = LAST_GPX_PATH ? `&gpx_path=${encodeURIComponent(LAST_GPX_PATH)}` : '';
      const revParam = REVERSED ? '&reverse=1' : '';

      // Tour shares the climate year selector UI. Backend requests still accept a contiguous span,
      // so discontiguous selections are widened to the selected min/max year window.
      const span = _tourSelectedYearsSpan();
      const histN = Math.max(1, Math.round((loadOpts.histYearsOverride !== undefined) ? Number(loadOpts.histYearsOverride) : Number(span.count || 1)));
      const histEnd = (loadOpts.histLastYearOverride !== undefined)
        ? Math.round(Number(loadOpts.histLastYearOverride))
        : Math.round(Number(span.end));
      const histStart = Math.round(Number(span.start));

      const offlineOnlyParam = loadOpts.offlineOnly ? '&offline_only=1' : '';
      const forceOnlineParam = loadOpts.forceOnline ? '&force_online=1' : '';
      const z = map.getZoom();
      const profileStep = (function(zoom){
        // Use a denser elevation profile than weather glyph sampling so local relief stays visible.
        if (zoom >= 13) return 0.5;
        if (zoom >= 12) return 0.75;
        if (zoom >= 11) return 1.0;
        if (zoom >= 10) return 1.5;
        if (zoom >= 9)  return 2.0;
        if (zoom >= 8)  return 2.5;
        if (zoom >= 7)  return 3.0;
        return 4.0;
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

      // Mode may change while async/session restore is running. Abort if we are no longer in TOUR.
      if (!_tourIsActive()) {
        MAIN_IN_PROGRESS = false;
        try { evtSource && evtSource.close(); } catch (_) {}
        try { if (window.__WM_PRIME_EVT_SOURCE__) window.__WM_PRIME_EVT_SOURCE__.close(); } catch (_) {}
        try { evtSourceProfile && evtSourceProfile.close(); } catch (_) {}
        try { stopProgressAnim(); } catch (_) {}
        try { if (fetchWeatherBtn) { updateFetchWeatherLabel(); fetchWeatherBtn.disabled = false; } } catch (_) {}
        try { if (stopWeatherBtn) stopWeatherBtn.style.display = 'none'; } catch (_) {}
        try { if (sseStatus) sseStatus.textContent = 'Stream: idle (Climatic Map mode)'; } catch (_) {}
        return;
      }

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
    TOUR_DAYS_AGGR = {};
    LAST_TOUR_SUMMARY = null;
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
          const ROUTE_COLOR = '#2F4858';
          const CASE_COLOR = '#FFFFFF';
          const CASE_OPACITY = 0.82;
          const CASE_WEIGHT = 5;
          const LINE_WEIGHT = 2.5;
          if (routeSegments && routeSegments.features && routeSegments.features.length) {
            routeLayer = L.layerGroup().addTo(map);
            routeSegments.features.forEach(feat => {
              L.geoJSON(feat, { style: { color: CASE_COLOR, weight: CASE_WEIGHT, opacity: CASE_OPACITY } }).addTo(routeLayer);
              L.geoJSON(feat, { style: { color: ROUTE_COLOR, weight: LINE_WEIGHT, opacity: 0.98 } }).addTo(routeLayer);
            });
          } else {
            routeLayer = L.layerGroup().addTo(map);
            L.geoJSON(route, { style: { color: CASE_COLOR, weight: CASE_WEIGHT, opacity: CASE_OPACITY } }).addTo(routeLayer);
            L.geoJSON(route, { style: { color: ROUTE_COLOR, weight: LINE_WEIGHT, opacity: 0.98 } }).addTo(routeLayer);
          }
          try { _applyTourRouteLayerVisibility(); } catch (_) {}
          flagsLayer = L.layerGroup().addTo(map);
          const coords = route.geometry.coordinates;
          if (startMarker && startMarker.geometry && Array.isArray(coords) && coords.length >= 2) {
            const [slon, slat] = startMarker.geometry.coordinates;
            const m = _createRouteEndpointMarker(slat, slon, 'start', (startMarker.properties||{}).date);
            if (m) flagsLayer.addLayer(m);
          }
          if (endMarker && endMarker.geometry && Array.isArray(coords) && coords.length >= 2) {
            const [elon, elat] = endMarker.geometry.coordinates;
            const m = _createRouteEndpointMarker(elat, elon, 'finish', (endMarker.properties||{}).date);
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
        ROUTE_COORDS = route.geometry && route.geometry.coordinates || null;
        const ROUTE_COLOR = '#2F4858';
        const CASE_COLOR = '#FFFFFF';
        const CASE_OPACITY = 0.82;
        const CASE_WEIGHT = 5;
        const LINE_WEIGHT = 2.5;
        if (routeSegments && routeSegments.features && routeSegments.features.length) {
          routeLayer = L.layerGroup().addTo(map);
          routeSegments.features.forEach(feat => {
            L.geoJSON(feat, { style: { color: CASE_COLOR, weight: CASE_WEIGHT, opacity: CASE_OPACITY } }).addTo(routeLayer);
            L.geoJSON(feat, { style: { color: ROUTE_COLOR, weight: LINE_WEIGHT, opacity: 0.98 } }).addTo(routeLayer);
          });
        } else {
          routeLayer = L.layerGroup().addTo(map);
          L.geoJSON(route, { style: { color: CASE_COLOR, weight: CASE_WEIGHT, opacity: CASE_OPACITY } }).addTo(routeLayer);
          L.geoJSON(route, { style: { color: ROUTE_COLOR, weight: LINE_WEIGHT, opacity: 0.98 } }).addTo(routeLayer);
        }
        try { _applyTourRouteLayerVisibility(); } catch (_) {}
        // Update route coords and recompute cumulative distances & profile mapping
        ROUTE_COORDS = route.geometry && route.geometry.coordinates || null;
        computeRouteCumulativeDistances();
        if (LAST_PROFILE) computeProfileRouteIndexes(LAST_PROFILE);
        // Render wind-blown banner flags using SVG with mast + curved cloth
        flagsLayer = L.layerGroup().addTo(map);
        // Determine reference segment for perpendicular offset
        const coords = route.geometry.coordinates;
        if (startMarker && startMarker.geometry && Array.isArray(coords) && coords.length >= 2) {
          const [slon, slat] = startMarker.geometry.coordinates;
          const m = _createRouteEndpointMarker(slat, slon, 'start', (startMarker.properties||{}).date);
          if (m) flagsLayer.addLayer(m);
        }
        if (endMarker && endMarker.geometry && Array.isArray(coords) && coords.length >= 2) {
          const [elon, elat] = endMarker.geometry.coordinates;
          const m = _createRouteEndpointMarker(elat, elon, 'finish', (endMarker.properties||{}).date);
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
    try { _bindProfilePointerHandlers(); } catch (_) {}
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
        _applyReverseTourState(!!reverseCheck.checked, { refresh: false });
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
            _persistLastGpxSelection();
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
            _persistLastGpxSelection();
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
          _ensureRouteMarkerPane('wmRouteWindPane', 640, 'none');
          const windOffset = _routeNormalOffsetPx(Number(props.distance_from_start_km || 0), 8, false);
          const windLatLng = _routeMarkerLatLng(lat, lon, windOffset);
          const kmh = msToKmh(props.wind_speed_ms);
          const selected2 = startDateInput.value ? new Date(startDateInput.value) : new Date();
          const mmdd2 = getMMDD(selected2);
          const locationKey = _strategicLocationLabelKey(lat, lon);
          const cachedLocationLabel = locationKey && STRATEGIC_LOCATION_LABEL_CACHE.has(locationKey)
            ? STRATEGIC_LOCATION_LABEL_CACHE.get(locationKey)
            : _strategicLocationFallbackLabel(lat, lon);
          const iconClass = mapWeatherByProb(props && props.rain_probability);
          const iconMarkup = (() => {
            try {
              return resizeInlineSvgGlyphMarkup(getWeatherSvg(iconClass), 16, 16);
            } catch (_) {
              return '';
            }
          })();
          const effWindMs = _tourEffectiveWind({
            windSpeed: props.wind_speed_ms,
            windDir: props.wind_dir_deg,
          }, Number(props.distance_from_start_km || 0));
          const effWindLabel = Number.isFinite(effWindMs)
            ? `${effWindMs >= 0 ? 'tailwind' : 'headwind'} ${fmt(Math.abs(effWindMs), 1)} m/s`
            : null;
          const yearsLabel = (props._years_start !== undefined && props._years_end !== undefined)
            ? `${props._years_start}–${props._years_end}`
            : '-';
          const matchCount = (props._match_days === undefined)
            ? null
            : (Array.isArray(props._match_days) ? props._match_days.length : props._match_days);
          const dateLabel = props.date ? _fmtISODayMonth(props.date) : mmdd2;
          const periodLabel = [
            (props.tour_day_index !== undefined) ? `Day ${Number(props.tour_day_index) + 1}` : 'Route point',
            dateLabel,
            `${fmt(props.distance_from_start_km, 1)} km`,
          ].join(' • ');
          const tipPayload = {
            location: cachedLocationLabel || '—',
            period: periodLabel,
            iconMarkup,
            rows: [
              { label: 'Station', value: `${props.station_name || '-'}` },
              { label: 'Temp', value: `${fmt((props.temp_hist_median !== undefined ? props.temp_hist_median : props.temperature_c), 1)} °C` },
              { label: 'Hist range', value: `${fmt((props.temp_hist_min !== undefined ? props.temp_hist_min : props.temp_p25), 1)}–${fmt((props.temp_hist_max !== undefined ? props.temp_hist_max : props.temp_p75), 1)} °C` },
              { label: 'Typical', value: `${fmt(props.temp_day_typical_min, 1)}–${fmt(props.temp_day_typical_max, 1)} °C` },
              { label: 'Rain', value: `${fmt(props.rain_typical_mm, 1)} mm (p=${props.rain_probability !== undefined ? Math.round(Number(props.rain_probability) * 100) : '-'}%)` },
              { label: 'Rain band', value: `${fmt(props.rain_hist_p25_mm, 1)}–${fmt(props.rain_hist_p75_mm, 1)} mm` },
              { label: 'Wind', value: `${fmt(props.wind_speed_ms, 1)} m/s${Number.isFinite(Number(props.wind_dir_deg)) ? ` from ${degToCardinal(props.wind_dir_deg)}` : ''}${effWindLabel ? ` • ${effWindLabel}` : ''}` },
              { label: 'Years', value: `${yearsLabel}${matchCount === null ? '' : ` (n=${matchCount})`}` },
              { label: 'Route offset', value: `${fmt(props.min_distance_to_route_km, 1)} km` },
              { label: 'Wind detail', value: `${kmh===null?'-':fmt(kmh,1)} km/h • Bft ${msToBeaufort(props.wind_speed_ms)} • std ${fmt(props.wind_var_deg,0)}°` },
            ],
          };
          const renderTipHtml = (locationLabel) => _buildMetricTooltipCardHtml({
            ...tipPayload,
            location: locationLabel || tipPayload.location,
          });
          try {
            const effWindMs = _tourEffectiveWind({
              windSpeed: props.wind_speed_ms,
              windDir: props.wind_dir_deg,
            }, Number(props.distance_from_start_km || 0));
            if (_routeEffectiveChevronCount(effWindMs) > 0) {
              const windIcon = _createRouteWindIcon(props);
              const windMarker = L.marker(windLatLng, { icon: windIcon, pane: 'wmRouteWindPane', interactive: false, keyboard: false, zIndexOffset: 160 });
              try { windMarker._wmRouteWindProps = { ...props }; } catch (_) {}
              glyphLayerNew.addLayer(windMarker);
            }
          } catch (_) {}
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
        const finiteNumber = (value) => {
          const num = Number(value);
          return Number.isFinite(num) ? num : null;
        };
        const pickFiniteProp = (...values) => {
          for (const value of values) {
            const num = finiteNumber(value);
            if (num !== null) return num;
          }
          return null;
        };
        OVERLAY_POINTS.push({
          dist: Number(props.distance_from_start_km || 0),
          tourDayIndex: finiteNumber(props.tour_day_index),
          id: (props.station_id !== undefined) ? String(props.station_id) : null,
          svg: (props.svg !== undefined) ? String(props.svg) : null,
          // Median used for color and solid line: prefer daytime median
          temperature: pickFiniteProp(props.temp_day_median, props.temp_hist_median, props.temperature_c, props.temp_median),
          precipMm: finiteNumber(props.precipitation_mm),
          rainProb: finiteNumber(props.rain_probability),
          rainTypical: finiteNumber(props.rain_typical_mm),
          rain_hist_p25_mm: finiteNumber(props.rain_hist_p25_mm),
          rain_hist_p75_mm: finiteNumber(props.rain_hist_p75_mm),
          rain_hist_p90_mm: finiteNumber(props.rain_hist_p90_mm),
          windSpeed: finiteNumber(props.wind_speed_ms),
          windDir: finiteNumber(props.wind_dir_deg),
          windVar: finiteNumber(props.wind_var_deg),
          // Temperature variability percentiles
          // Historical variability across years (daily daytime median percentiles)
          temp_hist_median: pickFiniteProp(props.temp_hist_median, props.temperature_c, props.temp_day_median),
          temp_hist_min: finiteNumber(props.temp_hist_min),
          temp_hist_max: finiteNumber(props.temp_hist_max),
          temp_hist_p25: pickFiniteProp(props.temp_hist_p25, props.temp_p25),
          temp_hist_p75: pickFiniteProp(props.temp_hist_p75, props.temp_p75),
          temp_day_typical_min: finiteNumber(props.temp_day_typical_min),
          temp_day_typical_max: finiteNumber(props.temp_day_typical_max),
          // Daytime variability within 10–16h (across all years)
          temp_day_p25: finiteNumber(props.temp_day_p25),
          temp_day_p75: finiteNumber(props.temp_day_p75),
          temp_day_median: pickFiniteProp(props.temp_day_median, props.temperature_c, props.temp_hist_median, props.temp_median),
          lucky: (props.lucky !== undefined) ? !!props.lucky : null,
          yearsStart: finiteNumber(props._years_start),
          yearsEnd: finiteNumber(props._years_end),
          matchDays: (props._match_days !== undefined && props._match_days !== null) ? (Array.isArray(props._match_days) ? finiteNumber(props._match_days.length) : finiteNumber(props._match_days)) : null,
          sourceMode: (props._source_mode !== undefined) ? String(props._source_mode) : null,
          tileId: (props._tile_id !== undefined) ? String(props._tile_id) : null
        });
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
      let donePayload = null;
      try {
        donePayload = (e && e.data) ? JSON.parse(e.data) : null;
      } catch (_) {
        donePayload = null;
      }
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
            if (el.querySelector && el.querySelector('[data-wm-route-card="1"]')) return;
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
      try {
        glyphLayer && glyphLayer.eachLayer((layer) => {
          try { if (layer && layer.bringToFront) layer.bringToFront(); } catch (_) {}
        });
      } catch (_) {}
      try { _renderTourRouteDayCards(LAST_PROFILE); } catch (_) {}
      try { _refreshTourRouteMarkerIcons(glyphLayer); } catch (_) {}
      try {
        requestAnimationFrame(() => {
          try { _renderTourRouteDayCards(LAST_PROFILE); } catch (_) {}
          try { _refreshTourRouteMarkerIcons(glyphLayer); } catch (_) {}
        });
      } catch (_) {}
      setTimeout(() => { if (progressBar) progressBar.style.width = '0%'; }, 600);
      if (sseStatus) {
        let backendTxt = null;
        try {
          backendTxt = donePayload && donePayload.station_source_text ? String(donePayload.station_source_text) : null;
        } catch (_) {
          backendTxt = null;
        }
        const spanTxt = YEARS_SPAN_TEXT ? ` from historical Open-Meteo weather data ${YEARS_SPAN_TEXT}` : '';
        const suffix = backendTxt ? ` ${backendTxt}` : spanTxt;
        const prov = weatherProvenanceText();
        const provTxt = prov ? ` (${prov})` : '';
        sseStatus.textContent = `Stream: done, stations ${stationCount}/${stationTotal}${provTxt}${suffix}`;
      }
      try {
        if (_tourIsActive()) {
          const summaryFromDone = donePayload && donePayload.tour_summary ? donePayload.tour_summary : null;
          renderTourSummary(summaryFromDone || LAST_TOUR_SUMMARY || null);
        }
      } catch (_) {}

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
    // Bound once; Tour mode only (never in Climatic Map).
    if (!PROFILE_ZOOM_REFRESH_BOUND) {
      PROFILE_ZOOM_REFRESH_BOUND = true;
      map.on('zoomend', () => {
        if (!_tourIsActive()) {
          try { evtSourceProfile && evtSourceProfile.close(); } catch (_) {}
          return;
        }
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
        const tourDays = Number(tourDaysInput?.value || 7);
        const startDateStr = startDateInput && startDateInput.value ? startDateInput.value : new Date().toISOString().slice(0,10);
        const gpxParam = LAST_GPX_PATH ? `&gpx_path=${encodeURIComponent(LAST_GPX_PATH)}` : '';
        const revParam = REVERSED ? '&reverse=1' : '';

        const histLast = Number(SETTINGS.histLastYear);
        const histN = Math.max(1, Math.round(Number(SETTINGS.histYears) || 10));
        const histEnd = (Number.isFinite(histLast) && histLast >= 1970) ? Math.round(histLast) : ((new Date()).getFullYear() - 1);
        const histStart = histEnd - histN + 1;

        const url = `/api/map_stream?date=${mmdd}&step_km=${STEP_KM}&profile_step_km=${profileStep}&tour_planning=1&mode=single_day&dry_run=1&total_days=${tourDays}&start_date=${encodeURIComponent(startDateStr)}&hist_years=${histN}&hist_start=${histStart}${gpxParam}${revParam}`;
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
  }

  fetchWeatherBtn.addEventListener('click', () => {
    if (!_tourIsActive()) return;
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
      if (evtSourceProfile) evtSourceProfile.close();
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
  startDateInput.addEventListener('change', () => {
    try { if (_tourIsActive()) _tourSyncTimelineFromInputs(); } catch (_) {}
  });
  tourDaysInput.addEventListener('change', () => {
    try { if (_tourIsActive()) _tourSyncTimelineFromInputs(); } catch (_) {}
  });

  if (weatherQualitySelect) {
    weatherQualitySelect.addEventListener('change', markDataStale);
  }
  updateFetchWeatherLabel();

  // Tour Summary: badges panel rendering
  function renderTourSummary(summary) {
    try {
      const resolvedSummary = _normalizeTourSummary(summary);
      LAST_TOUR_SUMMARY = resolvedSummary || null;
      _setBottomPanelUiMode('tour');
      const panel = document.getElementById('tourSummary');
      if (!panel) return;
      const badgesRow = document.getElementById('tourSummaryBadges');
      if (!badgesRow) return;
      const routeWrap = document.getElementById('tourSummaryRoute');
      try {
        badgesRow.style.minHeight = '64px';
        badgesRow.style.padding = '7px 10px';
      } catch (_) {}
      const badgesWrap = document.getElementById('tourSummaryBadgesItems') || badgesRow;
      const routeLabels = _tourRouteDisplayLabels();
      const years = _tourSelectedYearsSpan();
      const rangeInfo = _tourDateRangeInfo();
      const distanceKm = _tourRouteDistanceKm();
      const gpxName = _tourDisplayGpxName();
      const routeHtml = `
        <div class="wm-tour-band-card wm-tour-summary-route">
          <div class="wm-tour-route-kicker">GPX Route Info</div>
          <div class="wm-tour-route-title"><span data-role="start">${_htmlEsc(routeLabels.fromLabel)}</span> → <span data-role="end">${_htmlEsc(routeLabels.toLabel)}</span></div>
          <div class="wm-tour-route-file">${_htmlEsc(gpxName)}${Number.isFinite(distanceKm) ? ` • ${fmt(distanceKm, 0)} km` : ''}</div>
          <div class="wm-tour-route-meta">${_fmtIsoDayMonthCompact(rangeInfo.startIso)}–${_fmtIsoDayMonthCompact(rangeInfo.endIso)} • ${Math.max(1, rangeInfo.totalDays)}d • ${years.discontiguous ? years.exactLabel : years.spanLabel}</div>
          <div class="wm-tour-route-actions">
            <button id="tourSummaryReverseToggle" class="wm-tour-inline-toggle" type="button" aria-pressed="${REVERSED ? 'true' : 'false'}">${REVERSED ? 'Reverse Tour On' : 'Reverse Tour'}</button>
          </div>
        </div>`;
      if (routeWrap) {
        routeWrap.innerHTML = routeHtml;
        const reverseBtn = document.getElementById('tourSummaryReverseToggle');
        if (reverseBtn) {
          reverseBtn.addEventListener('click', () => {
            const reverseCheck = document.getElementById('reverse');
            if (!reverseCheck) return;
            _applyReverseTourState(!reverseCheck.checked, { refresh: true });
          });
        }
        const locationToken = String(++TOUR_SUMMARY_LOCATION_TOKEN);
        routeWrap.dataset.locationToken = locationToken;
        const endpoints = _tourRouteEndpointsForDisplay();
        const applyRouteLabel = (role, label) => {
          try {
            if (!routeWrap || String(routeWrap.dataset.locationToken || '') !== locationToken) return;
            const node = routeWrap.querySelector(`[data-role="${role}"]`);
            if (node) node.textContent = String(label || '—');
          } catch (_) {}
        };
        if (endpoints) {
          const startKey = _strategicLocationLabelKey(endpoints.startLat, endpoints.startLon);
          const endKey = _strategicLocationLabelKey(endpoints.endLat, endpoints.endLon);
          if (startKey && STRATEGIC_LOCATION_LABEL_CACHE.has(startKey)) applyRouteLabel('start', STRATEGIC_LOCATION_LABEL_CACHE.get(startKey));
          else _requestLocationLabel(endpoints.startLat, endpoints.startLon, (label) => applyRouteLabel('start', label));
          if (endKey && STRATEGIC_LOCATION_LABEL_CACHE.has(endKey)) applyRouteLabel('end', STRATEGIC_LOCATION_LABEL_CACHE.get(endKey));
          else _requestLocationLabel(endpoints.endLat, endpoints.endLon, (label) => applyRouteLabel('end', label));
        }
      }
      badgesWrap.innerHTML = _tourSummaryMetricsMarkup(resolvedSummary);
      if (tourSummaryLegends) {
        tourSummaryLegends.innerHTML = _tourSummaryLegendsMarkup();
      }
      if (LAST_TOUR_CURSOR_READOUT) _renderTourCursorReadout(LAST_TOUR_CURSOR_READOUT);
      else _initializeTourCursorReadoutFromStart();
      try { if (tourSummaryTooltip) tourSummaryTooltip.style.display = 'none'; } catch (_) {}
      
      // Recalculate layout after badges render (they may wrap to multiple lines)
      // Keep profile height constant, adjust map height to accommodate tour summary
      // Double rAF ensures DOM has fully reflowed before measurement
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try { _reflowBottomLayout(); } catch (_) {}
        });
      });
    } catch (e) { console.warn('renderTourSummary error', e); }
  }


  // Redraw profile on resize
  window.addEventListener('resize', () => {
    _scheduleProfileRedraw();
  });

  try {
    if (typeof ResizeObserver === 'function' && profilePanel) {
      const profileResizeObserver = new ResizeObserver(() => {
        _scheduleProfileRedraw();
      });
      profileResizeObserver.observe(profilePanel);
    }
  } catch (_) {}

  (function initResizeDrag(){
    if (!resizeHandle) return;
    let dragging = false;
    let startClientY = 0;
    let startHeight = 0;

    function _eventClientY(e) {
      const touch = (e && e.touches && e.touches.length) ? e.touches[0]
        : (e && e.changedTouches && e.changedTouches.length) ? e.changedTouches[0]
        : e;
      const y = touch && typeof touch.clientY === 'number' ? Number(touch.clientY) : NaN;
      return Number.isFinite(y) ? y : NaN;
    }

    function _setResizeDragState(active) {
      dragging = !!active;
      try { resizeHandle.classList.toggle('is-dragging', dragging); } catch (_) {}
      try { document.body.classList.toggle('wm-profile-resizing', dragging); } catch (_) {}
    }

    function onMove(e) {
      if (!dragging) return;
      const y = _eventClientY(e);
      if (!Number.isFinite(y)) return;
      const deltaY = startClientY - y;
      const newH = Math.round(startHeight + deltaY);
      setProfileHeight(newH);
      try { e.preventDefault(); } catch (_) {}
    }
    function onUp() {
      _setResizeDragState(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove, { passive: false });
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('touchcancel', onUp);
      window.removeEventListener('blur', onUp);
    }
    resizeHandle.addEventListener('mousedown', (e) => {
      const y = _eventClientY(e);
      startClientY = Number.isFinite(y) ? y : 0;
      startHeight = profilePanel ? Number(profilePanel.offsetHeight || 0) : 0;
      _setResizeDragState(true);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onUp);
      e.preventDefault();
    });
    resizeHandle.addEventListener('touchstart', (e) => {
      const y = _eventClientY(e);
      startClientY = Number.isFinite(y) ? y : 0;
      startHeight = profilePanel ? Number(profilePanel.offsetHeight || 0) : 0;
      _setResizeDragState(true);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
      window.addEventListener('touchcancel', onUp);
      window.addEventListener('blur', onUp);
      e.preventDefault();
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
      const snapshot = readSettingsFromForm(SETTINGS);
      if (saveSettings(snapshot)) {
        _flashSettingsStatus('Settings saved', 'saved', 1600);
      } else {
        _flashSettingsStatus('Save failed', 'paused', 1600);
      }
    });
  }
  if (settingsLoad) {
    settingsLoad.addEventListener('click', () => {
      const saved = loadSavedSettings();
      if (!saved) {
        _flashSettingsStatus('No saved settings', 'paused', 1600);
        return;
      }
      if (applySettings(saved)) {
        _settingsManualDirty = false;
        _flashSettingsStatus('Settings loaded', 'saved', 1600);
      } else {
        _flashSettingsStatus('Load failed', 'paused', 1600);
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
        try { _refreshPreferencesUi(); } catch (_) {}
        // GPX path and reverse flag
        if (st.last_gpx_path) LAST_GPX_PATH = st.last_gpx_path;
        if (st.last_gpx_name) LAST_GPX_NAME = st.last_gpx_name;
        if (st.gpx_exists === false) {
          // Clear stale path to avoid sending invalid override
          LAST_GPX_PATH = null;
          LAST_GPX_NAME = null;
          _persistLastGpxSelection();
        } else if (!LAST_GPX_PATH) {
          _restoreLastGpxSelectionFromStorage();
        }
        _persistLastGpxSelection();
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
      _restoreLastGpxSelectionFromStorage();
    }
    updateDropZoneLabel();
    loadMap();
    try {
      if (_getAppMode() === 'climate') {
        strategicSetActive(true);
        _ensureDefaultClimateProfileSelection({ immediate: true });
      }
    } catch (_) {}
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
