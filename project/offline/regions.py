"""Download regions on the existing ~50 km offline tile grid.

The yearly databases use the grid of ``tile_grid_approx_50km`` with its origin at
34 N / 28 W (meta ``bbox``): row r has its centre at 34 + (r + 0.5) * 50/111.32
degrees, column c at -28 + (c + 0.5) * 50 / (111.32 * cos(lat)) degrees. A region
south of 34 N continues exactly this grid with negative rows (r-1_c55 lies directly
south of r0_c55), so the same place always has the same tile id and centre, and the
row-wise interpolation of the map and the climate panel works across the seam.

A region is a fixed tile list (``regions/<slug>.csv``), generated once from the grid
with the builder's own land / coastal-sea filter (``--ocean coastal``,
50 km) and a country assignment (reverse_geocoder, offline GeoNames data). The list
is versioned with the code so every run downloads exactly the same tiles.
"""
from __future__ import annotations

import csv
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REGIONS_DIR = Path(__file__).resolve().parent / "regions"
GRID_ORIGIN_LAT = 34.0
GRID_ORIGIN_LON = -28.0
TILE_KM = 50.0
STEP_LAT = TILE_KM / 111.32

# Geographic Africa: African states and territories (ISO 3166-1 alpha-2), plus the
# Atlantic islands on the African plate that belong to European states (Canary
# Islands, Madeira). Not included: Socotra (Yemen), the sub-antarctic Prince Edward
# Islands (beyond 35 S) and Bouvet Island.
AFRICA_COUNTRIES = frozenset(
    "DZ AO BJ BW BF BI CV CM CF TD KM CD CG CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY "
    "MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW RE YT SH".split()
)
AFRICA_EXTRA_ADMIN1 = {("ES", "Canary Islands"), ("PT", "Madeira")}
AFRICA_BOX = {"lat_min": -35.2, "lat_max": GRID_ORIGIN_LAT, "lon_min": GRID_ORIGIN_LON, "lon_max": 64.0}

REGION_DEFS: Dict[str, Dict[str, object]] = {
    "africa": {
        "label": "Africa",
        "box": AFRICA_BOX,
        "years": [2023, 2024, 2025],
        "note": ("Geographic Africa south of 34 N incl. islands; the 340 North African tiles north of "
                 "34 N are part of the European yearly databases already."),
    },
}


@dataclass(frozen=True)
class RegionTile:
    tile_id: str
    row: int
    col: int
    lat: float
    lon: float
    country: str
    kind: str  # "land" or "coastal"


def grid_centre(row: int, col: int) -> Tuple[float, float]:
    lat = GRID_ORIGIN_LAT + (row + 0.5) * STEP_LAT
    step_lon = TILE_KM / (111.32 * max(0.05, math.cos(math.radians(lat))))
    return lat, GRID_ORIGIN_LON + (col + 0.5) * step_lon


def _in_africa(cc: str, admin1: str) -> bool:
    return cc in AFRICA_COUNTRIES or (cc, admin1) in AFRICA_EXTRA_ADMIN1


def generate_africa() -> List[RegionTile]:
    """All land and coastal-sea grid tiles of geographic Africa south of 34 N."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_offline_tiles_openmeteo import _is_coastal_sea, _try_make_is_land_fn, tile_grid_approx_50km
    import reverse_geocoder as rg  # type: ignore

    is_land = _try_make_is_land_fn()
    if is_land is None:
        raise RuntimeError("global_land_mask is required to generate a region")
    n_rows = int(math.ceil((GRID_ORIGIN_LAT - AFRICA_BOX["lat_min"]) / STEP_LAT))
    lat0 = GRID_ORIGIN_LAT - n_rows * STEP_LAT
    grid = tile_grid_approx_50km(lat0, GRID_ORIGIN_LAT, AFRICA_BOX["lon_min"], AFRICA_BOX["lon_max"], TILE_KM)
    cand: List[Tuple[int, int, float, float, str]] = []
    for t in grid:
        row = t.row - n_rows
        if row >= 0:
            continue
        if is_land(t.lat, t.lon):
            cand.append((row, t.col, t.lat, t.lon, "land"))
        elif _is_coastal_sea(t.lat, t.lon, 50.0, is_land):
            cand.append((row, t.col, t.lat, t.lon, "coastal"))
    places = rg.search([(c[2], c[3]) for c in cand], mode=1, verbose=False)
    out = []
    for (row, col, lat, lon, kind), p in zip(cand, places):
        if _in_africa(str(p.get("cc")), str(p.get("admin1"))):
            out.append(RegionTile(f"r{row}_c{col}", row, col, lat, lon, str(p.get("cc")), kind))
    out.sort(key=lambda t: (t.row, t.col))
    return out


def write_region(slug: str, tiles: List[RegionTile]) -> Path:
    REGIONS_DIR.mkdir(parents=True, exist_ok=True)
    path = REGIONS_DIR / f"{slug}.csv"
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["tile_id", "row", "col", "lat", "lon", "country", "kind"])
        for t in tiles:
            w.writerow([t.tile_id, t.row, t.col, f"{t.lat:.10f}", f"{t.lon:.10f}", t.country, t.kind])
    return path


def load_region(slug: str) -> List[RegionTile]:
    path = REGIONS_DIR / f"{slug}.csv"
    out = []
    with path.open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            out.append(RegionTile(r["tile_id"], int(r["row"]), int(r["col"]), float(r["lat"]), float(r["lon"]),
                                  r["country"], r["kind"]))
    return out


def region_box(tiles: List[RegionTile]) -> Dict[str, float]:
    """Coverage box of a region: the tile extents (half a tile around the centres)."""
    lat_min = min(t.lat for t in tiles) - STEP_LAT / 2
    lat_max = max(t.lat for t in tiles) + STEP_LAT / 2
    pad = max(TILE_KM / (111.32 * max(0.05, math.cos(math.radians(t.lat)))) for t in tiles) / 2
    return {"lat_min": round(lat_min, 4), "lat_max": round(min(lat_max, GRID_ORIGIN_LAT), 4),
            "lon_min": round(min(t.lon for t in tiles) - pad, 4), "lon_max": round(max(t.lon for t in tiles) + pad, 4)}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Generate a region tile list")
    ap.add_argument("slug", choices=sorted(REGION_DEFS))
    a = ap.parse_args()
    tiles = generate_africa()
    p = write_region(a.slug, tiles)
    print(f"{len(tiles)} tiles -> {p}")
