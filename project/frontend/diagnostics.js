(function() {
  'use strict';

  const LEVELS = Object.freeze({
    INFO: 'INFO',
    WARNING: 'WARNING',
    ERROR: 'ERROR',
    PERFORMANCE: 'PERFORMANCE',
  });

  const state = {
    enabled: false,
    performanceEnabled: true,
    maxEntries: 1000,
    entries: [],
    seq: 0,
    measureSeq: 0,
    measures: new Map(),
    measureStack: [],
    listeners: new Set(),
    statusListeners: new Set(),
    status: {
      state: 'Idle',
      gpxPoints: null,
      rideDays: null,
      weatherSamples: null,
      cacheHitRatio: null,
      lastLoadMs: null,
      memoryMB: null,
    },
  };

  function nowMs() {
    return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  function formatTimestamp(ts) {
    try {
      const d = new Date(Number(ts) || Date.now());
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      return `${hh}:${mm}:${ss}.${ms}`;
    } catch (_) {
      return '--:--:--.---';
    }
  }

  function cloneEntry(entry) {
    return {
      id: entry.id,
      timestamp: entry.timestamp,
      timestampText: entry.timestampText,
      level: entry.level,
      subsystem: entry.subsystem,
      event: entry.event,
      message: entry.message,
      duration: entry.duration,
      metadata: entry.metadata,
      parentId: entry.parentId,
      depth: entry.depth,
    };
  }

  function normalizeLogInput(input, maybeOpts) {
    if (typeof input === 'string') {
      const opts = (maybeOpts && typeof maybeOpts === 'object') ? maybeOpts : {};
      return {
        level: opts.level || LEVELS.INFO,
        subsystem: opts.subsystem || 'General',
        event: opts.event || input,
        message: opts.message || input,
        duration: Number.isFinite(Number(opts.duration)) ? Number(opts.duration) : null,
        metadata: opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : null,
        parentId: opts.parentId || null,
        depth: Number.isFinite(Number(opts.depth)) ? Number(opts.depth) : null,
      };
    }
    const obj = (input && typeof input === 'object') ? input : {};
    return {
      level: obj.level || LEVELS.INFO,
      subsystem: obj.subsystem || 'General',
      event: obj.event || obj.message || 'Event',
      message: obj.message || obj.event || 'Event',
      duration: Number.isFinite(Number(obj.duration)) ? Number(obj.duration) : (Number.isFinite(Number(obj.durationMs)) ? Number(obj.durationMs) : null),
      metadata: obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : null,
      parentId: obj.parentId || null,
      depth: Number.isFinite(Number(obj.depth)) ? Number(obj.depth) : null,
    };
  }

  function emitEntry(entry) {
    for (const listener of Array.from(state.listeners)) {
      try { listener(cloneEntry(entry)); } catch (_) {}
    }
  }

  function emitStatus() {
    const snapshot = getStatus();
    for (const listener of Array.from(state.statusListeners)) {
      try { listener(snapshot); } catch (_) {}
    }
  }

  function pushEntry(input, maybeOpts) {
    const normalized = normalizeLogInput(input, maybeOpts);
    const level = String(normalized.level || LEVELS.INFO).toUpperCase();
    const timestamp = Date.now();
    const entry = {
      id: ++state.seq,
      timestamp,
      timestampText: formatTimestamp(timestamp),
      level: (level === LEVELS.INFO || level === LEVELS.WARNING || level === LEVELS.ERROR || level === LEVELS.PERFORMANCE) ? level : LEVELS.INFO,
      subsystem: String(normalized.subsystem || 'General'),
      event: String(normalized.event || ''),
      message: String(normalized.message || normalized.event || ''),
      duration: Number.isFinite(Number(normalized.duration)) ? Math.max(0, Number(normalized.duration)) : null,
      metadata: normalized.metadata,
      parentId: normalized.parentId || null,
      depth: Number.isFinite(Number(normalized.depth)) ? Math.max(0, Math.round(Number(normalized.depth))) : 0,
    };

    state.entries.push(entry);
    if (state.entries.length > Math.max(100, Number(state.maxEntries) || 1000)) {
      state.entries.splice(0, state.entries.length - Math.max(100, Number(state.maxEntries) || 1000));
    }
    emitEntry(entry);
    return cloneEntry(entry);
  }

  function resolveParent(parentId) {
    if (parentId) return parentId;
    const top = state.measureStack.length ? state.measureStack[state.measureStack.length - 1] : null;
    return top || null;
  }

  function start(input, maybeOpts) {
    const normalized = normalizeLogInput(input, maybeOpts);
    const id = `m-${Date.now()}-${++state.measureSeq}`;
    const parentId = resolveParent(normalized.parentId);
    const parent = parentId && state.measures.has(parentId) ? state.measures.get(parentId) : null;
    const depth = parent ? (Number(parent.depth) + 1) : 0;
    const token = {
      id,
      parentId,
      depth,
      startedAt: nowMs(),
      timestamp: Date.now(),
      subsystem: String(normalized.subsystem || 'Performance'),
      event: String(normalized.event || normalized.message || 'Measure'),
      message: String(normalized.message || normalized.event || 'Measure'),
      metadata: normalized.metadata,
    };
    state.measures.set(id, token);
    state.measureStack.push(id);
    return { ...token };
  }

  function end(tokenOrId, maybeOpts) {
    const id = (tokenOrId && typeof tokenOrId === 'object') ? tokenOrId.id : tokenOrId;
    if (!id || !state.measures.has(id)) return null;
    const token = state.measures.get(id);
    state.measures.delete(id);
    const idx = state.measureStack.lastIndexOf(id);
    if (idx >= 0) state.measureStack.splice(idx, 1);

    const opts = (maybeOpts && typeof maybeOpts === 'object') ? maybeOpts : {};
    const duration = Math.max(0, nowMs() - Number(token.startedAt || nowMs()));
    const message = opts.message || token.message || token.event || 'Measure';
    const event = opts.event || token.event || message;
    const subsystem = opts.subsystem || token.subsystem || 'Performance';
    const metadata = opts.metadata && typeof opts.metadata === 'object'
      ? { ...(token.metadata || {}), ...opts.metadata }
      : (token.metadata || null);

    if (state.enabled && state.performanceEnabled) {
      pushEntry({
        level: LEVELS.PERFORMANCE,
        subsystem,
        event,
        message,
        duration,
        metadata,
        parentId: token.parentId || null,
        depth: Number.isFinite(Number(token.depth)) ? Number(token.depth) : 0,
      });
    }

    return {
      id,
      parentId: token.parentId || null,
      depth: Number.isFinite(Number(token.depth)) ? Number(token.depth) : 0,
      subsystem,
      event,
      message,
      duration,
      metadata,
    };
  }

  async function measure(input, fn, maybeOpts) {
    const token = start(input, maybeOpts);
    try {
      const result = await fn();
      end(token, maybeOpts);
      return result;
    } catch (error) {
      end(token, {
        ...(maybeOpts && typeof maybeOpts === 'object' ? maybeOpts : {}),
        metadata: {
          ...(maybeOpts && maybeOpts.metadata && typeof maybeOpts.metadata === 'object' ? maybeOpts.metadata : {}),
          error: error && error.message ? String(error.message) : String(error),
        },
      });
      throw error;
    }
  }

  function clear() {
    state.entries = [];
  }

  function getEntries() {
    return state.entries.map(cloneEntry);
  }

  function setEnabled(flag) {
    state.enabled = !!flag;
    return state.enabled;
  }

  function isEnabled() {
    return !!state.enabled;
  }

  function setPerformanceEnabled(flag) {
    state.performanceEnabled = !!flag;
    return state.performanceEnabled;
  }

  function isPerformanceEnabled() {
    return !!state.performanceEnabled;
  }

  function setMaxEntries(value) {
    const next = Math.max(100, Math.min(5000, Math.round(Number(value) || 1000)));
    state.maxEntries = next;
    if (state.entries.length > next) {
      state.entries.splice(0, state.entries.length - next);
    }
    return next;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    state.listeners.add(listener);
    return () => { state.listeners.delete(listener); };
  }

  function subscribeStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    state.statusListeners.add(listener);
    try { listener(getStatus()); } catch (_) {}
    return () => { state.statusListeners.delete(listener); };
  }

  function updateStatus(patch) {
    if (!patch || typeof patch !== 'object') return getStatus();
    state.status = { ...state.status, ...patch };
    emitStatus();
    return getStatus();
  }

  function getStatus() {
    return { ...state.status };
  }

  function configure(opts) {
    const config = (opts && typeof opts === 'object') ? opts : {};
    if (Object.prototype.hasOwnProperty.call(config, 'enabled')) setEnabled(!!config.enabled);
    if (Object.prototype.hasOwnProperty.call(config, 'performanceEnabled')) setPerformanceEnabled(!!config.performanceEnabled);
    if (Object.prototype.hasOwnProperty.call(config, 'maxEntries')) setMaxEntries(config.maxEntries);
    return {
      enabled: isEnabled(),
      performanceEnabled: isPerformanceEnabled(),
      maxEntries: state.maxEntries,
    };
  }

  const api = {
    LEVELS,
    configure,
    setEnabled,
    isEnabled,
    setPerformanceEnabled,
    isPerformanceEnabled,
    setMaxEntries,
    getEntries,
    clear,
    subscribe,
    subscribeStatus,
    updateStatus,
    getStatus,
    log: (entry, opts) => {
      if (!state.enabled) return null;
      return pushEntry(entry, opts);
    },
    info: (message, opts) => {
      if (!state.enabled) return null;
      return pushEntry(message, { ...(opts || {}), level: LEVELS.INFO });
    },
    warn: (message, opts) => {
      if (!state.enabled) return null;
      return pushEntry(message, { ...(opts || {}), level: LEVELS.WARNING });
    },
    error: (message, opts) => {
      if (!state.enabled) return null;
      return pushEntry(message, { ...(opts || {}), level: LEVELS.ERROR });
    },
    perf: (message, opts) => {
      if (!state.enabled || !state.performanceEnabled) return null;
      return pushEntry(message, { ...(opts || {}), level: LEVELS.PERFORMANCE });
    },
    start,
    end,
    measure,
  };

  try { window.TouracleDiagnostics = api; } catch (_) {}
})();
