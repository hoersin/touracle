(function (globalScope) {
  'use strict';

  function nearestIndex(xs, x) {
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

  function clampClimateHoverX(clientX, rectLeft, geom) {
    const x = Number(clientX) - Number(rectLeft);
    const padL = Number(geom && geom.padL);
    const innerW = Number(geom && geom.innerW);
    if (!Number.isFinite(x) || !Number.isFinite(padL) || !Number.isFinite(innerW)) return NaN;
    return Math.max(padL, Math.min(padL + innerW, x));
  }

  function isValidHoverIndex(value, length) {
    const index = Number(value);
    const size = Number(length);
    if (!Number.isInteger(index)) return false;
    if (!Number.isFinite(size) || size <= 0) return false;
    return index >= 0 && index < size;
  }

  function pointInsideRect(clientX, clientY, rect) {
    const x = Number(clientX);
    const y = Number(clientY);
    if (!rect || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    return x >= Number(rect.left)
      && x <= Number(rect.right)
      && y >= Number(rect.top)
      && y <= Number(rect.bottom);
  }

  const api = {
    nearestIndex,
    clampClimateHoverX,
    isValidHoverIndex,
    pointInsideRect,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (globalScope) {
    globalScope.WM_PROFILE_HOVER = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);