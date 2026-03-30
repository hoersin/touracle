(function(){
  'use strict';

  function clamp(n, min, max) {
    const v = Number(n);
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, Math.round(v)));
  }

  class SidebarLayout {
    constructor(opts) {
      this.sidebarEl = document.getElementById(opts.sidebarId);
      this.toggleBtn = document.getElementById(opts.toggleId);
      this.resizeHandle = document.getElementById(opts.resizeHandleId);
      this.storageKey = opts.storageKey || 'wm_sidebar_collapsed';
      this.widthStorageKey = opts.widthStorageKey || 'wm_sidebar_width';
      this.minWidth = Number(opts.minWidth || 300);
      this.maxWidth = Number(opts.maxWidth || 760);

      if (!this.sidebarEl || !this.toggleBtn) return;

      this._applyContext(this._currentMode());
      this._updateCalculationGuide(this._currentMode());

      const collapsed = this._loadCollapsed();
      this._applyWidth(this._loadWidth());
      this._applyCollapsed(collapsed);

      this.toggleBtn.addEventListener('click', () => {
        const next = !this._isCollapsed();
        this._applyCollapsed(next);
        this._saveCollapsed(next);
        this._notifyLayoutChange();
      });

      if (this.resizeHandle) {
        this.resizeHandle.addEventListener('pointerdown', (ev) => this._startResize(ev));
      }

      // In Settings mode, ensure preferences are visible.
      window.addEventListener('wm:modechange', (ev) => {
        const mode = ev && ev.detail && ev.detail.mode ? String(ev.detail.mode) : '';
        try {
          this._applyContext(mode);
          this._updateCalculationGuide(mode);
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

    _currentMode() {
      try {
        const m = document.body && document.body.dataset ? String(document.body.dataset.mode || '') : '';
        return m || 'climate';
      } catch (_) {
        return 'climate';
      }
    }

    _applyContext(mode) {
      try {
        const next = (mode === 'climate' || mode === 'tour') ? mode : (document.body.dataset.wmContext || 'climate');
        document.body.dataset.wmContext = next;
      } catch (_) {}
    }

    _updateCalculationGuide(mode) {
      try {
        const active = (mode === 'climate' || mode === 'tour') ? mode : this._currentMode();
        const cards = Array.from(document.querySelectorAll('#wmSectionCalcGuide .wm-calc-card[data-wm-mode]'));
        for (const card of cards) {
          const cardMode = card && card.dataset ? String(card.dataset.wmMode || '') : '';
          const show = (cardMode === active);
          card.hidden = !show;
          card.style.display = show ? '' : 'none';
        }
      } catch (_) {}
    }

    _applyWidth(width) {
      try {
        const next = clamp(width, this.minWidth, this.maxWidth);
        document.body.style.setProperty('--wm-sidebar-w', `${next}px`);
      } catch (_) {}
    }

    _loadWidth() {
      try {
        const raw = localStorage.getItem(this.widthStorageKey);
        if (raw === null || raw === undefined || raw === '') return 340;
        return clamp(Number(raw), this.minWidth, this.maxWidth);
      } catch (_) {
        return 340;
      }
    }

    _saveWidth(width) {
      try { localStorage.setItem(this.widthStorageKey, String(clamp(width, this.minWidth, this.maxWidth))); } catch (_) {}
    }

    _startResize(ev) {
      try {
        if (this._isCollapsed()) return;
        if (ev && ev.preventDefault) ev.preventDefault();
        const pointerId = (ev && Number.isFinite(Number(ev.pointerId))) ? Number(ev.pointerId) : null;
        if (pointerId !== null && this.resizeHandle && this.resizeHandle.setPointerCapture) {
          try { this.resizeHandle.setPointerCapture(pointerId); } catch (_) {}
        }
        const onMove = (moveEv) => {
          const next = clamp(moveEv.clientX, this.minWidth, this.maxWidth);
          try { document.body.classList.add('wm-sidebar-resizing'); } catch (_) {}
          this._applyWidth(next);
          this._notifyLayoutChange();
        };
        const onUp = (upEv) => {
          const next = clamp(upEv.clientX, this.minWidth, this.maxWidth);
          try { document.body.classList.remove('wm-sidebar-resizing'); } catch (_) {}
          this._applyWidth(next);
          this._saveWidth(next);
          this._notifyLayoutChange();
          try {
            if (pointerId !== null && this.resizeHandle && this.resizeHandle.releasePointerCapture) {
              this.resizeHandle.releasePointerCapture(pointerId);
            }
          } catch (_) {}
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      } catch (_) {}
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
      new SidebarLayout({
        sidebarId: 'wmSidebar',
        toggleId: 'wmSidebarToggle',
        resizeHandleId: 'wmSidebarResizeHandle',
        storageKey: 'wm_sidebar_collapsed',
        widthStorageKey: 'wm_sidebar_width',
        minWidth: 300,
        maxWidth: 760,
      });
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
