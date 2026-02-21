// Precipitation rendering for Tour Profile panel
// Functions: drawRainProbabilityArea(ctx, points, opts), drawRainBars(ctx, points, opts)
// points: [{ dist, rainProb, rainTypical }], sorted by dist ascending
// opts: { padTop, padBot, padL, padR, innerW, innerH, xAt }

(function(){
  function clamp01(v){ return Math.max(0, Math.min(1, Number(v))); }

  function drawRainProbabilityArea(ctx, points, opts){
    if (!ctx || !points || points.length < 2) return;
    const { padTop, padBot, padL, padR, innerW, innerH, xAt, maxMm } = opts;
    const pxPerMm = innerH / maxMm;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const mm = Number(p.rainTypical);
      const prob = clamp01(p.rainProb);
      const val = mm * prob;
      const h = val * pxPerMm;
      const x = xAt(p.dist);
      const y = padTop + innerH - h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    // Close against bottom baseline
    ctx.lineTo(padL + innerW, padTop + innerH);
    ctx.lineTo(padL, padTop + innerH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(100, 180, 255, 0.20)'; // light blue, opacity 0.2
    ctx.fill();
  }

  function drawRainBars(ctx, points, opts){
    if (!ctx || !points || points.length === 0) return;
    const { padTop, padBot, padL, padR, innerW, innerH, xAt, maxMm } = opts;
    const pxPerMm = innerH / maxMm;
    const barW = 12;             // widened by 300%
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const mm = Number(p.rainTypical);
      if (!Number.isFinite(mm)) continue;
      const mmCap = Math.max(0, Math.min(maxMm, mm));
      const h = mmCap * pxPerMm;
      const x = xAt(p.dist);
      const y = padTop + innerH - h;
      const alpha = 0.6 + 0.3 * clamp01(p.rainProb); // 0.6–0.9 by probability
      ctx.fillStyle = `rgba(30, 112, 200, ${alpha.toFixed(3)})`;
      ctx.fillRect(Math.round(x - barW/2), Math.round(y), barW, Math.round(h));
    }
    // Removed: horizontal grid lines for a cleaner precipitation diagram
  }

  // Export to window
  window.drawRainProbabilityArea = drawRainProbabilityArea;
  window.drawRainBars = drawRainBars;

  // ---------------- Wind Profile ----------------
  // points: [{ dist, windSpeed, windDir, windVar }], sorted by dist
  // profile: { sampled_dist_km: [], sampled_heading_deg: [] }
  // Enhanced: sample effective wind every 5 km using nearest station wind and local route heading
  function computeEffectiveWind(points, profile) {
    if (!Array.isArray(points) || points.length < 1) return null;
    const dist = Array.isArray(profile?.sampled_dist_km) ? profile.sampled_dist_km : [];
    const headings = Array.isArray(profile?.sampled_heading_deg) ? profile.sampled_heading_deg : [];
    if (!dist.length || dist.length !== headings.length) return null;
    // Binary search nearest profile index by distance
    const nearestHeadingIdx = (d) => {
      let lo = 0, hi = dist.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (dist[mid] < d) lo = mid + 1; else hi = mid;
      }
      return lo;
    };
    // Binary search nearest station point by distance
    const ptsDist = points.map(p => Number(p.dist));
    const nearestStationIdx = (d) => {
      let lo = 0, hi = ptsDist.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ptsDist[mid] < d) lo = mid + 1; else hi = mid;
      }
      // pick closer of lo and lo-1
      if (lo > 0) {
        const i0 = lo - 1, i1 = lo;
        return (Math.abs(ptsDist[i0] - d) <= Math.abs(ptsDist[i1] - d)) ? i0 : i1;
      }
      return lo;
    };
    const rad = (deg) => (Number(deg) * Math.PI / 180.0);
    const totalKm = dist[dist.length - 1];
    const stepKm = 5.0;
    const out = [];
    for (let d = 0; d <= totalKm + 1e-6; d += stepKm) {
      const hi = nearestHeadingIdx(d);
      const routeDir = Number(headings[hi] ?? 0);
      const si = nearestStationIdx(d);
      const sp = points[si] || {};
      const wsp = Number(sp.windSpeed);
      const wdir = Number(sp.windDir);
      const vdeg = Number(sp.windVar);
      if (!Number.isFinite(wsp) || !Number.isFinite(wdir)) {
        out.push({ dist: d, eff: null, varDeg: vdeg });
        continue;
      }
      // Meteorological wind direction is "from"; convert to "to" by +180°
      const wdirTo = (wdir + 180.0) % 360.0;
      const ang = rad(wdirTo - routeDir);
      const eff = wsp * Math.cos(ang);
      out.push({ dist: d, eff, varDeg: vdeg });
    }
    // Ensure last sample at route end if not aligned exactly
    if (out.length && out[out.length - 1].dist < totalKm - 1e-6) {
      const d = totalKm;
      const hi = nearestHeadingIdx(d);
      const routeDir = Number(headings[hi] ?? 0);
      const si = nearestStationIdx(d);
      const sp = points[si] || {};
      const wsp = Number(sp.windSpeed);
      const wdir = Number(sp.windDir);
      const vdeg = Number(sp.windVar);
      let eff = null;
      if (Number.isFinite(wsp) && Number.isFinite(wdir)) {
        const wdirTo = (wdir + 180.0) % 360.0;
        eff = wsp * Math.cos(rad(wdirTo - routeDir));
      }
      out.push({ dist: d, eff, varDeg: vdeg });
    }
    return out;
  }

  function drawWindProfile(ctx, data, opts) {
    if (!ctx || !Array.isArray(data) || data.length < 2) return;
    const { padTop, padBot, padL, padR, innerW, innerH, xAt } = opts;
    // Variability band: map varDeg (0..60) to ±bandMs
    const bandMsFor = (varDeg) => {
      const vd = Math.max(0, Math.min(60, Number(varDeg || 0)));
      return (vd / 60.0) * 2.0; // up to ±2 m/s at 60°
    };
    // Determine dynamic symmetric axis around 0 based on max magnitude incl. band
    const valid = data.filter(d => Number.isFinite(d.eff));
    if (valid.length < 2) return;
    let maxAbs = 0;
    for (let i = 0; i < valid.length; i++) {
      const d = valid[i];
      const band = bandMsFor(d.varDeg);
      const a = Math.abs(Number(d.eff) || 0) + band;
      if (a > maxAbs) maxAbs = a;
    }
    // Minimum 8 m/s to avoid over-zooming; expand if needed
    maxAbs = Math.max(8.0, maxAbs);
    // Round to a friendly value (nearest 1 m/s)
    maxAbs = Math.ceil(maxAbs);
    const ymin = -maxAbs, ymax = maxAbs;
    const yAt = (v) => {
      const vv = Math.max(ymin, Math.min(ymax, Number(v)));
      const u = (vv - ymin) / Math.max(1e-6, (ymax - ymin));
      return padTop + innerH - Math.round(innerH * u);
    };
    // Build upper/lower paths for band
    // Grid lines removed for cleaner wind visualization
    // Band polygon
    ctx.beginPath();
    for (let i = 0; i < valid.length; i++) {
      const d = valid[i];
      const x = xAt(d.dist);
      const yU = yAt(d.eff + bandMsFor(d.varDeg));
      if (i === 0) ctx.moveTo(x, yU); else ctx.lineTo(x, yU);
    }
    for (let i = valid.length - 1; i >= 0; i--) {
      const d = valid[i];
      const x = xAt(d.dist);
      const yL = yAt(d.eff - bandMsFor(d.varDeg));
      ctx.lineTo(x, yL);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(80,80,80,0.15)';
    ctx.fill();
    // Line colored by sign and magnitude (rounded caps/joins)
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    // Stroke in segments; if sign changes, split at zero crossing and switch color
    const eps = 0.05; // near-zero threshold
    function colorForEff(eff){
      const m = Math.min(1, Math.max(0, Math.abs(eff) / 8.0));
      if (eff > eps) return `rgba(60,180,90,${0.6 + 0.4*m})`; // tailwind: green
      if (eff < -eps) return `rgba(220,80,60,${0.6 + 0.4*m})`;  // headwind: red
      return 'rgba(120,120,120,0.6)'; // near zero: gray
    }
    ctx.lineWidth = 2;
    for (let i = 1; i < valid.length; i++) {
      const d0 = valid[i-1], d1 = valid[i];
      const e0 = Number(d0.eff), e1 = Number(d1.eff);
      const x0 = xAt(d0.dist), y0 = yAt(e0);
      const x1 = xAt(d1.dist), y1 = yAt(e1);
      const s0 = e0 > eps ? 1 : (e0 < -eps ? -1 : 0);
      const s1 = e1 > eps ? 1 : (e1 < -eps ? -1 : 0);
      if (s0 !== 0 && s1 !== 0 && s0 !== s1) {
        // Zero crossing within segment: linear interpolation to eff=0
        const denom = (e1 - e0);
        const t = denom !== 0 ? Math.max(0, Math.min(1, (-e0) / denom)) : 0.5;
        const xz = x0 + (x1 - x0) * t;
        const yz = yAt(0);
        // First sub-segment: x0,y0 -> xz,yz in color of e0
        ctx.strokeStyle = colorForEff(e0);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(xz, yz);
        ctx.stroke();
        // Second sub-segment: xz,yz -> x1,y1 in color of e1
        ctx.strokeStyle = colorForEff(e1);
        ctx.beginPath();
        ctx.moveTo(xz, yz);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      } else {
        // No sign change: single stroke with color for target eff
        ctx.strokeStyle = colorForEff(e1);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
    // Return axis info for rendering outside clipping region
    return { maxAbs, yAt };
  }

  window.computeEffectiveWind = computeEffectiveWind;
  window.drawWindProfile = drawWindProfile;
})();
