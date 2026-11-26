"""Route gradient sections for the Tour Planning "Gradient" route colouring.

Input: the route's elevation profile in the direction of travel (cumulative
distance in km, elevation in m - the original GPX points; a reversed tour is
passed reversed, so climbs become descents). Output: consecutive sections
[start_km, end_km, class, grade_pct] covering the route, one of nine discrete
gradient classes each.

Raw GPX elevation is noisy and point spacing varies (5 m to >100 m), so nothing
is computed from neighbouring GPX points. Every step works on distance:

1. Resample the profile onto a regular grid of GRID_M metres (linear
   interpolation between GPX points; gaps without elevation are skipped).
   Point density no longer matters after this step.
2. Smooth the elevation with a centred moving average over SMOOTH_M metres.
3. Local gradient at every grid point = elevation difference across a centred
   window of SLOPE_M metres divided by SLOPE_M (one-sided at the route ends).
4. Classify every grid point (CLASS_BOUNDS) and build runs of equal class.
5. Stability: a run shorter than MIN_SECTION_M is merged into the neighbouring
   run with the closest class (shortest runs first, repeated until stable), so
   the colour only changes for sections of at least ~90 m.
   Exception - genuine short ramps: a short run of a steep class (climb >= 6 %,
   descent <= -8 %) at least RAMP_MIN_M long is kept when the smoothed
   elevation really changes by >= RAMP_MIN_RISE_M across it AND that change
   is not cancelled within RAMP_HOLD_M afterwards. A noise spike goes up and
   immediately down again (cancelled) and is merged away; a real ramp keeps
   the height it gained.
6. Each final section reports its mean grade (smoothed elevation change over
   its length).

Class boundaries (grade g in %): g <= -8 | -8 < g <= -4 | -4 < g <= -2 |
-2 < g < 2 | 2 <= g < 4 | 4 <= g < 6 | 6 <= g < 9 | 9 <= g <= 12 | g > 12.
"""
from __future__ import annotations

import math
from typing import List, Optional, Sequence, Tuple

GRID_M = 10.0
SMOOTH_M = 50.0
SLOPE_M = 70.0
MIN_SECTION_M = 90.0
RAMP_MIN_M = 30.0
RAMP_MIN_RISE_M = 2.5
RAMP_HOLD_M = 100.0

# (key, label, colour) per class, steepest descent first.
CLASSES: Tuple[Tuple[str, str, str], ...] = (
    ("strong_descent", "Strong descent", "#168C91"),
    ("descent", "Descent", "#35B7A9"),
    ("gentle_descent", "Gentle descent", "#80C9A0"),
    ("flat", "Flat", "#B7D477"),
    ("gentle_climb", "Gentle climb", "#E5D65B"),
    ("moderate_climb", "Moderate climb", "#F2B34B"),
    ("steep_climb", "Steep climb", "#ED843F"),
    ("very_steep_climb", "Very steep climb", "#E65348"),
    ("extreme_climb", "Extreme climb", "#A92E91"),
)
FLAT = 3
STEEP_CLIMB = 6           # classes >= this are "steep" climbs
STRONG_DESCENT = 0        # class <= this is a steep descent


def classify(grade_pct: float) -> int:
    """Class index (0..8) of a gradient in percent."""
    g = float(grade_pct)
    if g <= -8:
        return 0
    if g <= -4:
        return 1
    if g <= -2:
        return 2
    if g < 2:
        return 3
    if g < 4:
        return 4
    if g < 6:
        return 5
    if g < 9:
        return 6
    if g <= 12:
        return 7
    return 8


def _clean(dist_km: Sequence[Optional[float]], elev_m: Sequence[Optional[float]]) -> Tuple[List[float], List[float]]:
    xs: List[float] = []
    hs: List[float] = []
    for d, h in zip(dist_km or [], elev_m or []):
        try:
            x = float(d) * 1000.0
            y = float(h)
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        if xs and x < xs[-1] - 1e-6:
            continue                       # not monotonic: ignore the point
        if xs and abs(x - xs[-1]) < 1e-6:
            hs[-1] = 0.5 * (hs[-1] + y)    # duplicate position
            continue
        xs.append(x)
        hs.append(y)
    return xs, hs


def _resample(xs: List[float], hs: List[float], step: float) -> Tuple[float, List[float]]:
    x0, x1 = xs[0], xs[-1]
    n = max(2, int(math.floor((x1 - x0) / step)) + 1)
    out: List[float] = []
    j = 0
    for i in range(n):
        x = x0 + i * step
        while j < len(xs) - 2 and xs[j + 1] < x:
            j += 1
        a, b = xs[j], xs[j + 1]
        t = 0.0 if b <= a else min(1.0, max(0.0, (x - a) / (b - a)))
        out.append(hs[j] + (hs[j + 1] - hs[j]) * t)
    return x0, out


def _moving_average(v: List[float], half: int) -> List[float]:
    if half <= 0:
        return list(v)
    n = len(v)
    pre = [0.0]
    for x in v:
        pre.append(pre[-1] + x)
    out = []
    for i in range(n):
        k = min(half, i, n - 1 - i)        # symmetric near the ends: no bias on slopes
        a, b = i - k, i + k + 1
        out.append((pre[b] - pre[a]) / (b - a))
    return out


def _grades(h: List[float], step: float) -> List[float]:
    half = max(1, int(round(SLOPE_M / step / 2.0)))
    n = len(h)
    out = []
    for i in range(n):
        a = max(0, i - half)
        b = min(n - 1, i + half)
        out.append(100.0 * (h[b] - h[a]) / ((b - a) * step) if b > a else 0.0)
    return out


def _runs(cls: List[int]) -> List[List[int]]:
    """[class, first index, last index] runs of equal class."""
    runs: List[List[int]] = []
    for i, c in enumerate(cls):
        if runs and runs[-1][0] == c:
            runs[-1][2] = i
        else:
            runs.append([c, i, i])
    return runs


def _is_steep(c: int) -> bool:
    return c >= STEEP_CLIMB or c <= STRONG_DESCENT


def _protected(run: List[int], h: List[float], step: float) -> bool:
    """A genuine short ramp: steep, long enough, real and lasting height change."""
    c, a, b = run
    if not _is_steep(c) or (b - a + 1) * step < RAMP_MIN_M:
        return False
    rise = h[b] - h[a]
    if abs(rise) < RAMP_MIN_RISE_M or (rise > 0) != (c >= STEEP_CLIMB):
        return False
    k = int(round(RAMP_HOLD_M / step))
    before = h[max(0, a - k)]
    after = h[min(len(h) - 1, b + k)]
    # Net change from RAMP_HOLD_M before to RAMP_HOLD_M after the ramp: a noise spike
    # returns to its baseline (net ~0), a real ramp keeps the height it gained.
    return ((after - before) / rise) >= 0.5


def gradient_sections(dist_km: Sequence[Optional[float]], elev_m: Sequence[Optional[float]]) -> List[List[float]]:
    """[[start_km, end_km, class, grade_pct], ...] along the route; [] without elevation."""
    xs, hs = _clean(dist_km, elev_m)
    if len(xs) < 2 or xs[-1] - xs[0] < GRID_M:
        return []
    step = GRID_M
    x0, h = _resample(xs, hs, step)
    h = _moving_average(h, int(round(SMOOTH_M / step / 2.0)))
    g = _grades(h, step)
    runs = _runs([classify(v) for v in g])

    min_n = MIN_SECTION_M / step
    while len(runs) > 1:
        cand = [(r[2] - r[1] + 1, k) for k, r in enumerate(runs)
                if (r[2] - r[1] + 1) < min_n and not _protected(r, h, step)]
        if not cand:
            break
        _n, k = min(cand)
        r = runs[k]
        left = runs[k - 1] if k > 0 else None
        right = runs[k + 1] if k + 1 < len(runs) else None
        options = [x for x in (left, right) if x is not None]
        # closest class wins; on a tie the longer neighbour
        tgt = min(options, key=lambda x: (abs(x[0] - r[0]), -(x[2] - x[1])))
        if tgt is left:
            left[2] = r[2]
        else:
            right[1] = r[1]
        del runs[k]
        # neighbours of equal class join
        merged: List[List[int]] = []
        for x in runs:
            if merged and merged[-1][0] == x[0]:
                merged[-1][2] = x[2]
            else:
                merged.append(x)
        runs = merged

    out: List[List[float]] = []
    for c, a, b in runs:
        # sections meet at grid points: [a, b+1) except for the last one
        end_i = min(len(h) - 1, b + 1)
        start_m = x0 + a * step
        end_m = x0 + end_i * step if end_i > a else x0 + b * step
        length = max(step, end_m - start_m)
        grade = 100.0 * (h[end_i] - h[a]) / length
        out.append([round(start_m / 1000.0, 4), round(end_m / 1000.0, 4), int(c), round(grade, 1)])
    if out:
        out[-1][1] = round(xs[-1] / 1000.0, 4)
    return out


def legend() -> List[dict]:
    return [{"class": i, "key": k, "label": lbl, "color": col} for i, (k, lbl, col) in enumerate(CLASSES)]
