"""Gradient route colouring: classification, smoothing and stability (route_gradient.py).

Profiles are synthetic and exact: piecewise-constant grades sampled at a chosen GPX
point spacing, optionally with elevation noise, so the expected class of every
metre of the route is known.
"""
from __future__ import annotations

import random

import pytest

import route_gradient as rg


def profile(segments, spacing_m=10.0, noise_m=0.0, seed=1, start_h=500.0):
    """segments: [(length_m, grade_pct)] -> (dist_km, elev_m) sampled every spacing_m."""
    rnd = random.Random(seed)
    total = sum(L for L, _ in segments)
    xs, hs = [], []
    n = int(total // spacing_m)
    for i in range(n + 1):
        x = min(total, i * spacing_m)
        h, acc = start_h, 0.0
        for L, g in segments:
            part = max(0.0, min(L, x - acc))
            h += part * g / 100.0
            acc += L
        xs.append(x / 1000.0)
        hs.append(h + (rnd.gauss(0, noise_m) if noise_m else 0.0))
    return xs, hs


def class_at(sections, km):
    for a, b, c, _g in sections:
        if a <= km <= b:
            return c
    raise AssertionError(f'no section at {km} km')


def km_share(sections, cls):
    total = sections[-1][1] - sections[0][0]
    return sum(b - a for a, b, c, _ in sections if c == cls) / total


# ------------------------------------------------------------------ classes ---
@pytest.mark.parametrize('grade,cls', [
    (-15, 0), (-8, 0), (-7.99, 1), (-4, 1), (-3.99, 2), (-2, 2), (-1.99, 3), (0, 3), (1.99, 3),
    (2, 4), (3.99, 4), (4, 5), (5.99, 5), (6, 6), (8.99, 6), (9, 7), (12, 7), (12.01, 8), (20, 8)])
def test_class_boundaries(grade, cls):
    assert rg.classify(grade) == cls


def test_palette_is_the_agreed_one():
    assert [c for _k, _l, c in rg.CLASSES] == ['#168C91', '#35B7A9', '#80C9A0', '#B7D477', '#E5D65B',
                                              '#F2B34B', '#ED843F', '#E65348', '#A92E91']


GRADES = [(-10, 0), (-6, 1), (-3, 2), (0, 3), (3, 4), (5, 5), (7.5, 6), (10.5, 7), (14, 8)]


def test_all_nine_classes_on_a_route_with_clean_transitions():
    xs, hs = profile([(1000, g) for g, _ in GRADES])
    sec = rg.gradient_sections(xs, hs)
    assert [c for _a, _b, c, _g in sec] == [c for _g, c in GRADES]          # one section per class, in order
    for k, (a, b, c, g) in enumerate(sec):
        assert abs(g - GRADES[k][0]) < 1.0, (k, g)                          # reported mean grade
        if k:
            assert abs(a - k * 1.0) <= 0.06, (k, a)                         # transition at the true change


@pytest.mark.parametrize('grade,climb_cls,descent_cls', [(3, 4, 2), (5, 5, 1), (10.5, 7, 0)])
def test_uphill_and_downhill_and_reversed_route(grade, climb_cls, descent_cls):
    xs, hs = profile([(500, 0), (2000, grade), (500, 0)])
    fwd = rg.gradient_sections(xs, hs)
    assert class_at(fwd, 1.5) == climb_cls
    total = xs[-1]
    rev = rg.gradient_sections([total - x for x in reversed(xs)], list(reversed(hs)))
    assert class_at(rev, 1.5) == descent_cls                                # same place, other direction
    for a, b, c, g in fwd:                                                  # mirrored sections, opposite sign
        mid = (a + b) / 2
        rc = class_at(rev, total - mid)
        assert (c == rg.FLAT) == (rc == rg.FLAT), (mid, c, rc)
        assert (c > rg.FLAT) == (rc < rg.FLAT) or c == rg.FLAT


def test_noisy_elevation_stays_one_stable_colour():
    xs, hs = profile([(5000, 1.0)], spacing_m=10, noise_m=1.5, seed=3)       # 1 % road, +-1.5 m GPS noise
    sec = rg.gradient_sections(xs, hs)
    assert km_share(sec, rg.FLAT) > 0.95, sec
    assert all((b - a) * 1000 >= rg.MIN_SECTION_M - 1 for a, b, _c, _g in sec[:-1]), sec
    assert len(sec) <= 5, sec


@pytest.mark.parametrize('spacing', [5, 20, 50, 100])
def test_result_does_not_depend_on_gpx_point_density(spacing):
    segs = [(800, 0), (1200, 4.5), (600, 9.5), (900, -6), (700, 1), (1100, 7)]
    ref = rg.gradient_sections(*profile(segs, spacing_m=2))
    got = rg.gradient_sections(*profile(segs, spacing_m=spacing))
    probes = [k * 0.05 for k in range(1, int(5300 / 50))]
    agree = sum(class_at(ref, km) == class_at(got, km) for km in probes) / len(probes)
    assert agree >= 0.93, (spacing, agree)


@pytest.mark.parametrize('spacing', [10, 50])
def test_an_isolated_elevation_spike_is_not_coloured(spacing):
    xs, hs = profile([(3000, 0.5)], spacing_m=spacing)
    k = len(xs) // 2
    hs[k] += 12.0                                                           # one bad GPX point
    sec = rg.gradient_sections(xs, hs)
    assert len(sec) == 1 and sec[0][2] == rg.FLAT, sec


def test_a_genuine_short_steep_ramp_stays_visible():
    # 60 m at 14 % (+8.4 m) between flat roads, height kept afterwards
    xs, hs = profile([(1500, 0), (60, 14), (1500, 0)], spacing_m=10)
    sec = rg.gradient_sections(xs, hs)
    ramps = [s for s in sec if s[2] >= 7]
    assert len(ramps) == 1, sec
    a, b, c, g = ramps[0]
    assert (b - a) * 1000 < rg.MIN_SECTION_M and 1.45 <= a <= 1.56, ramps
    assert g >= 9, ramps


def test_a_short_gentle_wiggle_is_merged_away():
    # 50 m at 3 % inside a flat road: not steep, shorter than 90 m -> no own colour
    xs, hs = profile([(1500, 0), (50, 3), (1500, 0)], spacing_m=10)
    sec = rg.gradient_sections(xs, hs)
    assert [c for *_x, c, _g in sec] == [rg.FLAT], sec


def test_transition_between_two_climbs():
    xs, hs = profile([(1000, 3), (1000, 7)], spacing_m=25, noise_m=0.5)
    sec = rg.gradient_sections(xs, hs)
    assert [c for *_x, c, _g in sec] == [4, 6], sec
    assert abs(sec[1][0] - 1.0) <= 0.06, sec


def test_sections_cover_the_route_without_gaps():
    xs, hs = profile([(700, -5), (900, 2.5), (400, 11), (1000, -1)], spacing_m=37, noise_m=0.8)
    sec = rg.gradient_sections(xs, hs)
    assert sec[0][0] == 0 and sec[-1][1] == pytest.approx(xs[-1])
    assert all(abs(s[1] - t[0]) < 1e-9 for s, t in zip(sec, sec[1:]))


def test_no_elevation_gives_no_sections():
    assert rg.gradient_sections([0, 1, 2], [None, None, None]) == []
    assert rg.gradient_sections([], []) == []
