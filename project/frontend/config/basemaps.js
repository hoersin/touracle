(function() {
  'use strict';

  const BASEMAPS = [
    {
      id: 'osm-standard',
      name: 'OpenStreetMap Standard',
      tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
      status: 'stable',
      icon: 'osm',
    },
    {
      id: 'carto-positron',
      name: 'CARTO Positron',
      tileUrl: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 20,
      status: 'experimental',
      icon: 'carto',
    },
    {
      id: 'opentopomap',
      name: 'OpenTopoMap',
      tileUrl: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)',
      maxZoom: 17,
      status: 'experimental',
      icon: 'terrain',
    },
    {
      id: 'cyclosm',
      name: 'CyclOSM',
      tileUrl: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors &amp; CyclOSM',
      maxZoom: 20,
      status: 'experimental',
      icon: 'bike',
    },
  ];

  const DEFAULT_BASEMAP_ID = 'opentopomap';
  const BY_ID = new Map(BASEMAPS.map((entry) => [entry.id, entry]));
  const LAYER_CACHE = new Map();

  function cloneEntry(entry) {
    return entry ? { ...entry } : null;
  }

  function normalizeId(id) {
    const raw = String(id || '').trim();
    return BY_ID.has(raw) ? raw : DEFAULT_BASEMAP_ID;
  }

  function getBasemap(id) {
    return cloneEntry(BY_ID.get(normalizeId(id)));
  }

  function getBasemaps() {
    return BASEMAPS.map((entry) => cloneEntry(entry));
  }

  function createLayer(id, overrides) {
    if (typeof L === 'undefined' || !L || typeof L.tileLayer !== 'function') return null;
    const normalized = normalizeId(id);
    if (LAYER_CACHE.has(normalized)) return LAYER_CACHE.get(normalized);
    const entry = BY_ID.get(normalized) || BY_ID.get(DEFAULT_BASEMAP_ID);
    if (!entry) return null;
    const layer = L.tileLayer(entry.tileUrl, {
      attribution: entry.attribution,
      maxZoom: Number(entry.maxZoom) || 19,
      ...(overrides && typeof overrides === 'object' ? overrides : {}),
    });
    LAYER_CACHE.set(normalized, layer);
    return layer;
  }

  function getSummary(id) {
    const entry = getBasemap(id);
    if (!entry) return null;
    return {
      id: entry.id,
      name: entry.name,
      status: entry.status,
      icon: entry.icon,
    };
  }

  window.WM_BASEMAPS = BASEMAPS.map((entry) => cloneEntry(entry));
  window.WM_BASEMAP_MANAGER = Object.freeze({
    getBasemaps,
    getBasemap,
    getSummary,
    getDefaultBasemapId: () => DEFAULT_BASEMAP_ID,
    normalizeId,
    createLayer,
  });
})();