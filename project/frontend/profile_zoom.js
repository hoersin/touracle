(function(){
  'use strict';

  class ProfileZoomController {
    constructor(opts) {
      this.profileCanvas = document.getElementById(opts.profileCanvasId);
      this.getKmAtClientX = opts.getKmAtClientX;
      this.getLatLngAtKm = opts.getLatLngAtKm;
      this.flyToMs = Number(opts.flyToMs || 800);
      this.minZoom = Number(opts.minZoom || 10);
      this.maxZoom = Number(opts.maxZoom || 12);
      this.defaultZoom = Number(opts.defaultZoom || 11);

      if (!this.profileCanvas) return;

      this.profileCanvas.addEventListener('dblclick', (e) => {
        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}

        const m = window.__WM_LEAFLET_MAP__;
        if (!m || !m.flyTo) return;

        const km = this.getKmAtClientX ? this.getKmAtClientX(e.clientX) : null;
        if (!Number.isFinite(km)) return;

        const latlng = this.getLatLngAtKm ? this.getLatLngAtKm(km) : null;
        if (!latlng) return;

        let z = this.defaultZoom;
        try {
          const cur = m.getZoom ? Number(m.getZoom()) : NaN;
          if (Number.isFinite(cur)) z = cur;
        } catch (_) {}
        z = Math.max(this.minZoom, Math.min(this.maxZoom, z));
        if (!Number.isFinite(z)) z = this.defaultZoom;
        z = Math.max(this.minZoom, Math.min(this.maxZoom, z));

        try {
          if (typeof window.updateMapCursorAtDistance === 'function') {
            window.updateMapCursorAtDistance(km);
          }
        } catch (_) {}

        try {
          m.flyTo(latlng, z, { duration: Math.max(0.1, this.flyToMs / 1000.0) });
        } catch (err) {
          console.warn('flyTo error', err);
        }
      }, { passive: false });
    }
  }

  function boot() {
    // map.js owns the authoritative profile axis mapping + route interpolation.
    const ready = () => {
      const wm = window.WM || {};
      const getKmAtClientX = wm.profileClientXToRouteKm;
      const getLatLngAtKm = wm.routeLatLngAtDistanceKm;
      if (typeof getKmAtClientX !== 'function' || typeof getLatLngAtKm !== 'function') return false;

      new ProfileZoomController({
        profileCanvasId: 'profileCanvas',
        getKmAtClientX,
        getLatLngAtKm,
        flyToMs: 800,
        minZoom: 10,
        maxZoom: 12,
        defaultZoom: 11,
      });
      return true;
    };

    if (ready()) return;

    // Retry a few times in case scripts load slowly.
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (ready() || tries > 30) {
        try { clearInterval(t); } catch (_) {}
      }
    }, 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
