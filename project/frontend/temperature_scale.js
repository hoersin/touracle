// Shared, single-source temperature scale (Strategic + Tour)
// Discrete bins and colors as per Phase 1 spec.
(function(){
  'use strict';

  // Display scale runs from -5..35°C.
  // Keep existing 0..30°C bin edges/colors/labels; only add edge bins -5..0 and 30..35.
  const TEMP_BOUNDS = [
    -5,
    0, 5, 10, 15, 20, 25, 30,
    35,
  ];

  // 8 bins for the 9 bounds above.
  const TEMP_COLORS = [
    // -5..0
    '#313695',
    // 0..5, 5..10, ..., 25..30 (unchanged)
    '#2c7bb6',
    '#00a6ca',
    '#66c2a5',
    '#1a9850',
    '#66bd63',
    '#fee08b',
    // 30..35
    '#f46d43',
  ];

  function _hexToRgb(hex){
    const h = String(hex || '').trim().replace('#', '');
    if (h.length !== 6) return { r: 0, g: 0, b: 0 };
    const r = parseInt(h.slice(0,2), 16);
    const g = parseInt(h.slice(2,4), 16);
    const b = parseInt(h.slice(4,6), 16);
    return {
      r: Number.isFinite(r) ? r : 0,
      g: Number.isFinite(g) ? g : 0,
      b: Number.isFinite(b) ? b : 0,
    };
  }

  function getTempBinIndex(tC){
    const t = Number(tC);
    if (!Number.isFinite(t)) return null;
    for (let i = 0; i < TEMP_BOUNDS.length - 1; i++) {
      if (t < TEMP_BOUNDS[i + 1]) return i;
    }
    return TEMP_BOUNDS.length - 2;
  }

  function getTempColorHex(tC){
    const idx = getTempBinIndex(tC);
    if (idx === null) return null;
    return TEMP_COLORS[Math.max(0, Math.min(TEMP_COLORS.length - 1, idx))] || null;
  }

  function getTempColorRgba(tC, alpha){
    const a = Number.isFinite(Number(alpha)) ? Math.max(0, Math.min(1, Number(alpha))) : 1;
    const hex = getTempColorHex(tC);
    if (!hex) return `rgba(153,153,153,${a})`;
    const rgb = _hexToRgb(hex);
    return `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;
  }

  function isOptimalTemp(tC){
    const t = Number(tC);
    if (!Number.isFinite(t)) return false;
    // Highlight 15–25°C (upper bound exclusive to align with binning).
    return (t >= 15) && (t < 25);
  }

  function getTempBinLabelForIndex(idx){
    const i = Number(idx);
    if (!Number.isFinite(i) || i < 0 || i >= TEMP_COLORS.length) return '';
    const lo = TEMP_BOUNDS[i];
    const hi = TEMP_BOUNDS[i + 1];
    if (!Number.isFinite(lo) && Number.isFinite(hi)) return `<${Math.round(hi)}°C`;
    if (Number.isFinite(lo) && !Number.isFinite(hi)) return `≥${Math.round(lo)}°C`;
    return `${Math.round(lo)}–${Math.round(hi)}°C`;
  }

  function getTempBinLabel(tC){
    const idx = getTempBinIndex(tC);
    if (idx === null) return '';
    return getTempBinLabelForIndex(idx);
  }

  function getTempLegendSegments(){
    const out = [];
    for (let i = 0; i < TEMP_COLORS.length; i++) {
      const lo = TEMP_BOUNDS[i];
      const hi = TEMP_BOUNDS[i + 1];
      const optimal = (Number.isFinite(lo) && Number.isFinite(hi))
        ? (lo >= 15 && hi <= 25)
        : false;
      out.push({
        idx: i,
        color: TEMP_COLORS[i],
        label: getTempBinLabelForIndex(i),
        optimal,
      });
    }
    return out;
  }

  const api = {
    TEMP_BOUNDS,
    TEMP_COLORS,
    getTempBinIndex,
    getTempColorHex,
    getTempColorRgba,
    getTempBinLabel,
    getTempBinLabelForIndex,
    getTempLegendSegments,
    isOptimalTemp,
    hexToRgb: _hexToRgb,
  };

  try { window.WM_TEMP_SCALE = api; } catch (_) {}
})();
