(function(){
  'use strict';

  class SidebarLayout {
    constructor(opts) {
      this.sidebarEl = document.getElementById(opts.sidebarId);
      this.toggleBtn = document.getElementById(opts.toggleId);
      this.storageKey = opts.storageKey || 'wm_sidebar_collapsed';

      if (!this.sidebarEl || !this.toggleBtn) return;

      const collapsed = this._loadCollapsed();
      this._applyCollapsed(collapsed);

      this.toggleBtn.addEventListener('click', () => {
        const next = !this._isCollapsed();
        this._applyCollapsed(next);
        this._saveCollapsed(next);
        this._notifyLayoutChange();
      });

      // In Settings mode, ensure preferences are visible.
      window.addEventListener('wm:modechange', (ev) => {
        const mode = ev && ev.detail && ev.detail.mode ? String(ev.detail.mode) : '';
        try {
          if (mode === 'settings') {
            const prefs = document.getElementById('wmSectionPrefs');
            if (prefs && prefs.open === false) prefs.open = true;
          }
        } catch (_) {}
      });
    }

    _isCollapsed() {
      try { return document.body.classList.contains('wm-sidebar-collapsed'); } catch (_) { return false; }
    }

    _applyCollapsed(collapsed) {
      try { document.body.classList.toggle('wm-sidebar-collapsed', !!collapsed); } catch (_) {}
    }

    _loadCollapsed() {
      try {
        const raw = localStorage.getItem(this.storageKey);
        if (raw === null || raw === undefined) return false;
        return raw === '1' || raw === 'true';
      } catch (_) {
        return false;
      }
    }

    _saveCollapsed(collapsed) {
      try { localStorage.setItem(this.storageKey, collapsed ? '1' : '0'); } catch (_) {}
    }

    _notifyLayoutChange() {
      // Resize-sensitive components: Leaflet map + profile canvas.
      try {
        const m = window.__WM_LEAFLET_MAP__;
        if (m && m.invalidateSize) {
          setTimeout(() => { try { m.invalidateSize(true); } catch (_) {} }, 80);
          setTimeout(() => { try { m.invalidateSize(true); } catch (_) {} }, 240);
        }
      } catch (_) {}

      try {
        setTimeout(() => {
          try { window.dispatchEvent(new Event('resize')); } catch (_) {}
        }, 100);
      } catch (_) {}
    }
  }

  class SidebarSection {
    constructor(detailsEl) {
      this.el = detailsEl;
      if (!this.el) return;
    }
  }

  class ToggleSwitch {
    static enhanceAll() {
      // Styling is CSS-only; this exists as a hook/"component".
      // Keep this minimal to avoid altering form behavior.
      return;
    }
  }

  function boot() {
    try {
      new SidebarLayout({ sidebarId: 'wmSidebar', toggleId: 'wmSidebarToggle', storageKey: 'wm_sidebar_collapsed' });
      ToggleSwitch.enhanceAll();

      // Touch SidebarSection to match requested organization.
      new SidebarSection(document.getElementById('wmSectionTour'));
      new SidebarSection(document.getElementById('wmSectionPrefs'));
    } catch (e) {
      console.warn('sidebar init error', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
