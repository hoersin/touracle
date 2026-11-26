"""Dominant wind directions per tile for the Explore wind roses.

Input: the daily observations in the offline databases, one per tile and day: the
day's wind direction in the meteorological convention (the direction the wind comes
FROM) and the day's mean wind speed.

Method (documented thresholds below, tuned to suppress diffuse distributions):

1. A 16-sector histogram (22.5 deg each) of FROM directions, each day weighted by its
   mean speed, so a strong regional wind (e.g. the Mistral) counts more than an
   equally frequent breeze and calm days barely count.
2. Directional clusters are circular windows of 3 adjacent sectors (67.5 deg). With a
   uniform distribution every window holds 3/16 = 18.75 % of the weight.
3. Primary direction: the strongest window, shown only if it holds at least
   PRIMARY_MIN_SHARE of the weight and its days average at least MIN_MEAN_SPEED_MS.
4. Secondary direction: the strongest window at least SECONDARY_MIN_SEPARATION sectors
   away from the primary, shown only if it holds SECONDARY_MIN_SHARE and at least
   SECONDARY_MIN_RATIO of the primary's share. Two adjacent high sectors are therefore
   one direction, not two.
5. The direction of a cluster is the speed-weighted circular mean (vector sum) of the
   actual observations in its sectors - never an arithmetic mean of angles.
6. Display: Touracle shows where the wind pushes TOWARDS (downwind). to_deg is the
   FROM direction rotated by exactly 180 deg; statistics are computed on FROM.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

SECTORS = 16
SECTOR_DEG = 360.0 / SECTORS
WINDOW = 3                       # sectors per cluster (67.5 deg)
UNIFORM_WINDOW_SHARE = WINDOW / SECTORS

MIN_DAYS = 20                    # fewer valid days: no statement
PRIMARY_MIN_SHARE = 0.35         # ~1.9 x uniform
SECONDARY_MIN_SHARE = 0.20
SECONDARY_MIN_RATIO = 0.40       # of the primary's share
SECONDARY_MIN_SEPARATION = 3     # sectors between cluster centres (67.5 deg)
MIN_MEAN_SPEED_MS = 2.0          # weaker average wind: not shown
SPEED_WEIGHT_CAP_MS = 15.0       # one stormy day must not dominate a month


def to_downwind(from_deg: float) -> float:
    """Direction the wind blows towards, from the meteorological FROM direction."""
    return (float(from_deg) + 180.0) % 360.0


class WindRoseAccumulator:
    """Per-tile histogram of daily FROM directions, built in the aggregation pass."""

    __slots__ = ("_w", "_n", "_v", "_x", "_y")

    def __init__(self) -> None:
        self._w: Dict[str, List[float]] = {}   # speed-weighted sum per sector
        self._n: Dict[str, List[int]] = {}     # days per sector
        self._v: Dict[str, List[float]] = {}   # speed sum per sector
        self._x: Dict[str, List[float]] = {}   # weighted direction vectors per sector
        self._y: Dict[str, List[float]] = {}

    def add(self, tile: str, from_deg: Any, speed_ms: Any) -> None:
        try:
            d = float(from_deg)
            v = float(speed_ms)
        except (TypeError, ValueError):
            return
        if not (math.isfinite(d) and math.isfinite(v)) or v < 0:
            return
        k = int(((d % 360.0) + SECTOR_DEG / 2.0) // SECTOR_DEG) % SECTORS
        w = self._w.get(tile)
        if w is None:
            w = self._w[tile] = [0.0] * SECTORS
            self._n[tile] = [0] * SECTORS
            self._v[tile] = [0.0] * SECTORS
            self._x[tile] = [0.0] * SECTORS
            self._y[tile] = [0.0] * SECTORS
        wt = min(v, SPEED_WEIGHT_CAP_MS)
        w[k] += wt
        self._n[tile][k] += 1
        self._v[tile][k] += v
        self._x[tile][k] += wt * math.cos(math.radians(d))
        self._y[tile][k] += wt * math.sin(math.radians(d))

    def modes(self, tile: str) -> List[Dict[str, float]]:
        if tile not in self._w:
            return []
        return classify(self._w[tile], self._n[tile], self._v[tile], self._x[tile], self._y[tile])


def _window(values: List[float], centre: int) -> List[int]:
    return [(centre + o) % SECTORS for o in range(-(WINDOW // 2), WINDOW // 2 + 1)]


def _cluster(weights, counts, speeds, xs, ys, centre: int, total_w: float, total_n: int) -> Dict[str, float]:
    idx = _window(weights, centre)
    w = sum(weights[i] for i in idx)
    n = sum(counts[i] for i in idx)
    v = sum(speeds[i] for i in idx)
    # Weighted circular mean of the actual observations in the cluster (the
    # sectors only find the cluster; their centres would add up to +-11 deg error).
    x = sum(xs[i] for i in idx)
    y = sum(ys[i] for i in idx)
    from_deg = math.degrees(math.atan2(y, x)) % 360.0
    mean_speed = v / n if n else 0.0
    share = w / total_w if total_w > 0 else 0.0
    return {
        "from_deg": round(from_deg, 1),
        "to_deg": round(to_downwind(from_deg), 1),
        "share": round(share, 3),                       # speed-weighted
        "days_share": round(n / total_n, 3) if total_n else 0.0,
        "mean_speed_ms": round(mean_speed, 2),
        "significance": round((share - UNIFORM_WINDOW_SHARE) * min(mean_speed, 10.0), 3),
    }


def classify(weights: List[float], counts: List[int], speeds: List[float],
             xs: Optional[List[float]] = None, ys: Optional[List[float]] = None) -> List[Dict[str, float]]:
    """0, 1 or 2 dominant directions (strongest first); [] for diffuse or weak wind."""
    if xs is None or ys is None:   # sector centres when only the histogram is known
        xs = [weights[i] * math.cos(math.radians(i * SECTOR_DEG)) for i in range(SECTORS)]
        ys = [weights[i] * math.sin(math.radians(i * SECTOR_DEG)) for i in range(SECTORS)]
    total_n = sum(counts)
    total_w = sum(weights)
    if total_n < MIN_DAYS or total_w <= 0:
        return []
    window_w = [sum(weights[i] for i in _window(weights, k)) for k in range(SECTORS)]
    k1 = max(range(SECTORS), key=lambda k: window_w[k])
    c1 = _cluster(weights, counts, speeds, xs, ys, k1, total_w, total_n)
    if c1["share"] < PRIMARY_MIN_SHARE or c1["mean_speed_ms"] < MIN_MEAN_SPEED_MS:
        return []
    out = [c1]
    far = [k for k in range(SECTORS) if min((k - k1) % SECTORS, (k1 - k) % SECTORS) >= SECONDARY_MIN_SEPARATION]
    if far:
        k2 = max(far, key=lambda k: window_w[k])
        c2 = _cluster(weights, counts, speeds, xs, ys, k2, total_w, total_n)
        if (c2["share"] >= SECONDARY_MIN_SHARE and c2["share"] >= SECONDARY_MIN_RATIO * c1["share"]
                and c2["mean_speed_ms"] >= MIN_MEAN_SPEED_MS):
            out.append(c2)
    return out


def classify_observations(observations: List[tuple]) -> List[Dict[str, float]]:
    """Convenience for tests and scripts: [(from_deg, speed_ms), ...]."""
    acc = WindRoseAccumulator()
    for d, v in observations:
        acc.add("t", d, v)
    return acc.modes("t")
