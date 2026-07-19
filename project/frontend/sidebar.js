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
      this.scrollEl = document.getElementById(opts.scrollId || 'wmSidebarScroll');
      this.scrollbarEl = document.getElementById(opts.scrollbarId || 'wmSidebarScrollbar');
      this.scrollbarThumbEl = document.getElementById(opts.scrollbarThumbId || 'wmSidebarScrollbarThumb');
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
        this._syncScrollbar();
        this._notifyLayoutChange();
      });

      if (this.resizeHandle) {
        this.resizeHandle.addEventListener('pointerdown', (ev) => this._startResize(ev));
      }
      this._initScrollbar();

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
      try { this._syncScrollbar(); } catch (_) {}
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
        if (ev && Number(ev.button) !== 0) return;
        if (ev && ev.preventDefault) ev.preventDefault();
        const pointerId = (ev && Number.isFinite(Number(ev.pointerId))) ? Number(ev.pointerId) : null;
        if (pointerId !== null && this.resizeHandle && this.resizeHandle.setPointerCapture) {
          try { this.resizeHandle.setPointerCapture(pointerId); } catch (_) {}
        }
        const onMove = (moveEv) => {
          const next = clamp(moveEv.clientX, this.minWidth, this.maxWidth);
          try { document.body.classList.add('wm-sidebar-resizing'); } catch (_) {}
          this._applyWidth(next);
          this._syncScrollbar();
          this._notifyLayoutChange();
        };
        const onUp = (upEv) => {
          const next = clamp(upEv.clientX, this.minWidth, this.maxWidth);
          try { document.body.classList.remove('wm-sidebar-resizing'); } catch (_) {}
          this._applyWidth(next);
          this._saveWidth(next);
          this._syncScrollbar();
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
      try { this._syncScrollbar(); } catch (_) {}
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

    _initScrollbar() {
      try {
        if (!this.scrollEl || !this.scrollbarEl || !this.scrollbarThumbEl) return;
        this.scrollEl.addEventListener('scroll', () => this._syncScrollbar(), { passive: true });
        this.scrollEl.addEventListener('mouseenter', () => this._syncScrollbar(), { passive: true });
        if (this.sidebarEl) this.sidebarEl.addEventListener('mouseenter', () => this._syncScrollbar(), { passive: true });
        window.addEventListener('resize', () => this._syncScrollbar(), { passive: true });
        window.addEventListener('load', () => this._syncScrollbar(), { passive: true });
        this.scrollbarEl.addEventListener('pointerdown', (ev) => this._onScrollbarTrackPointerDown(ev));
        this.scrollbarThumbEl.addEventListener('pointerdown', (ev) => this._startScrollbarThumbDrag(ev));
        const details = Array.from(this.scrollEl.querySelectorAll('details'));
        for (const item of details) item.addEventListener('toggle', () => this._syncScrollbar());
        try {
          if (typeof ResizeObserver === 'function') {
            this._scrollResizeObserver = new ResizeObserver(() => this._syncScrollbar());
            this._scrollResizeObserver.observe(this.scrollEl);
            const firstChild = this.scrollEl.firstElementChild;
            if (firstChild) this._scrollResizeObserver.observe(firstChild);
          }
        } catch (_) {}
        requestAnimationFrame(() => this._syncScrollbar());
        requestAnimationFrame(() => requestAnimationFrame(() => this._syncScrollbar()));
        this._syncScrollbar();
      } catch (_) {}
    }

    _syncScrollbar() {
      try {
        if (!this.scrollEl || !this.scrollbarEl || !this.scrollbarThumbEl || this._isCollapsed()) {
          if (this.scrollbarEl) this.scrollbarEl.classList.add('is-hidden');
          return;
        }
        const viewport = Number(this.scrollEl.clientHeight || 0);
        const content = Number(this.scrollEl.scrollHeight || 0);
        const sidebarRect = this.sidebarEl ? this.sidebarEl.getBoundingClientRect() : null;
        const scrollRect = this.scrollEl.getBoundingClientRect();
        const trackTop = Math.max(0, Math.round(scrollRect.top - (sidebarRect ? sidebarRect.top : 0)));
        const trackHeight = Math.max(0, Math.round(scrollRect.height));
        if (!(viewport > 0) || !(content > viewport) || !(trackHeight > 0)) {
          this.scrollbarEl.classList.add('is-hidden');
          return;
        }
        this.scrollbarEl.style.top = `${trackTop}px`;
        this.scrollbarEl.style.height = `${trackHeight}px`;
        this.scrollbarEl.classList.remove('is-hidden');
        const thumbMin = 36;
        const thumbH = Math.max(thumbMin, Math.round((viewport / content) * trackHeight));
        const maxTop = Math.max(0, trackHeight - thumbH);
        const scrollTop = Number(this.scrollEl.scrollTop || 0);
        const maxScroll = Math.max(1, content - viewport);
        const thumbTop = Math.round((scrollTop / maxScroll) * maxTop);
        this.scrollbarThumbEl.style.height = `${thumbH}px`;
        this.scrollbarThumbEl.style.top = `${thumbTop}px`;
      } catch (_) {}
    }

    _onScrollbarTrackPointerDown(ev) {
      try {
        if (!this.scrollEl || !this.scrollbarEl || !this.scrollbarThumbEl) return;
        if (ev.target === this.scrollbarThumbEl) return;
        if (ev && Number(ev.button) !== 0) return;
        ev.preventDefault();
        const rect = this.scrollbarEl.getBoundingClientRect();
        const thumbRect = this.scrollbarThumbEl.getBoundingClientRect();
        const thumbH = Number(thumbRect.height || 0);
        const clickY = Number(ev.clientY) - rect.top;
        const nextTop = Math.max(0, Math.min(Number(rect.height || 0) - thumbH, clickY - thumbH / 2));
        this._scrollToThumbTop(nextTop);
      } catch (_) {}
    }

    _startScrollbarThumbDrag(ev) {
      try {
        if (!this.scrollEl || !this.scrollbarEl || !this.scrollbarThumbEl) return;
        if (ev && Number(ev.button) !== 0) return;
        ev.preventDefault();
        const pointerId = (ev && Number.isFinite(Number(ev.pointerId))) ? Number(ev.pointerId) : null;
        const thumbRect = this.scrollbarThumbEl.getBoundingClientRect();
        const dragOffset = Number(ev.clientY) - thumbRect.top;
        try { document.body.classList.add('wm-sidebar-scrolling'); } catch (_) {}
        if (pointerId !== null && this.scrollbarThumbEl.setPointerCapture) {
          try { this.scrollbarThumbEl.setPointerCapture(pointerId); } catch (_) {}
        }
        const onMove = (moveEv) => {
          const rect = this.scrollbarEl.getBoundingClientRect();
          const thumbH = Number(this.scrollbarThumbEl.getBoundingClientRect().height || 0);
          const nextTop = Math.max(0, Math.min(Number(rect.height || 0) - thumbH, Number(moveEv.clientY) - rect.top - dragOffset));
          this._scrollToThumbTop(nextTop);
        };
        const onUp = () => {
          try { document.body.classList.remove('wm-sidebar-scrolling'); } catch (_) {}
          try {
            if (pointerId !== null && this.scrollbarThumbEl.releasePointerCapture) this.scrollbarThumbEl.releasePointerCapture(pointerId);
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

    _scrollToThumbTop(thumbTop) {
      try {
        if (!this.scrollEl || !this.scrollbarEl || !this.scrollbarThumbEl) return;
        const viewport = Number(this.scrollEl.clientHeight || 0);
        const content = Number(this.scrollEl.scrollHeight || 0);
        const track = Number(this.scrollbarEl.getBoundingClientRect().height || 0);
        const thumbH = Number(this.scrollbarThumbEl.getBoundingClientRect().height || 0);
        const maxTop = Math.max(1, track - thumbH);
        const maxScroll = Math.max(0, content - viewport);
        const nextScroll = (Math.max(0, Math.min(maxTop, Number(thumbTop) || 0)) / maxTop) * maxScroll;
        this.scrollEl.scrollTop = nextScroll;
        this._syncScrollbar();
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
        scrollId: 'wmSidebarScroll',
        scrollbarId: 'wmSidebarScrollbar',
        scrollbarThumbId: 'wmSidebarScrollbarThumb',
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
