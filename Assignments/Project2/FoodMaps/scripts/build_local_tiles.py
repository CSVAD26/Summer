"""Build 2° outline tiles for the LOCAL VIEW from public datasets.

  python scripts/build_local_tiles.py <natural_earth_dir> <us_dir>

Sources (all public; whole-country / whole-world files, so nothing reveals photo locations):
  Natural Earth 1:10m v5.1.2 (public domain) - coast, lakes, rivers, admin-0/1 lines (worldwide)
  USGS Small-scale 1:1,000,000 hydrography (hydrusm010g, public domain) - US coast, lakes, rivers
  US Census 2023 cartographic boundaries 1:500,000 (public domain) - counties, places

Inside the United States the higher-resolution USGS/Census layers replace the Natural Earth
coast/lakes/rivers/admin-1 lines (those are clipped away against the US land mask).

Output: public/geo/tiles/<lat>_<lon>.json  {layer: [[lon,lat,...], ...]}  + index.json
(git-ignored; large).
"""

from __future__ import annotations

import glob
import json
import math
import shutil
import sys
import warnings
from collections import defaultdict
from pathlib import Path

import numpy as np
import shapely
from pyogrio import raw

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "geo" / "tiles"
TILE = 2


def tkey(lon, lat):
    a = math.floor(lat / TILE) * TILE
    b = math.floor(lon / TILE) * TILE
    b = ((b + 180) % 360) - 180
    return f"{a}_{b}"


tiles: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
stats = defaultdict(int)


def add_line(layer, coords, nd):
    """Cut a polyline at tile borders; segments crossing a border go to both tiles."""
    if len(coords) < 2:
        return
    cur_key = tkey(*coords[0])
    cur = [coords[0]]
    for p in coords[1:]:
        k = tkey(*p)
        cur.append(p)
        if k != cur_key:
            _emit(layer, cur_key, cur, nd)
            cur = [cur[-2], p]
            cur_key = k
    _emit(layer, cur_key, cur, nd)


def _emit(layer, key, pts, nd):
    if len(pts) >= 2:
        tiles[key][layer].append([round(v, nd) for p in pts for v in p])
        stats[layer] += len(pts)


def lines_of(geom):
    """All line strings of a geometry (polygon -> its rings)."""
    if geom is None or geom.is_empty:
        return []
    t = geom.geom_type
    if t == "LineString":
        return [geom]
    if t in ("MultiLineString", "GeometryCollection"):
        return [g for part in geom.geoms for g in lines_of(part)]
    if t == "Polygon":
        return [shapely.LineString(geom.exterior.coords)] + [shapely.LineString(r.coords) for r in geom.interiors]
    if t == "MultiPolygon":
        return [g for part in geom.geoms for g in lines_of(part)]
    return []


def read(path, layer=None, where=None, columns=()):
    # note: fields used in `where` must also be listed in `columns`
    kw = {"read_geometry": True, "columns": list(columns)}
    if layer:
        kw["layer"] = layer
    if where:
        kw["where"] = where
    res = raw.read(path, **kw)
    return [g for g in shapely.from_wkb(res[2]) if g is not None]


def add_geoms(layer, geoms, tol, nd, clip_out=None):
    for g in geoms:
        g = shapely.force_2d(g)
        if clip_out is not None and g.intersects(clip_out):
            g = g.difference(clip_out)
        g = g.simplify(tol, preserve_topology=False)
        for ln in lines_of(g):
            c = np.asarray(ln.coords)[:, :2].tolist()
            add_line(layer, c, nd)


def main():
    ne, us = Path(sys.argv[1]), Path(sys.argv[2])
    gdb = glob.glob(str(us / "*.gdb"))[0]

    print("US mask from Census counties ...")
    counties = read(glob.glob(str(us / "county" / "*.shp"))[0])
    us_mask = shapely.union_all([c.simplify(0.002) for c in counties]).buffer(0.002)
    shapely.prepare(us_mask)

    print("Natural Earth 1:10m (outside the US for coast/lakes/rivers/admin-1) ...")
    for layer, fname, tol, clip in [
        ("coast", "ne_10m_coastline.geojson", 0.0015, True),
        ("lakes", "ne_10m_lakes.geojson", 0.0015, True),
        ("rivers", "ne_10m_rivers_lake_centerlines.geojson", 0.002, True),
        ("admin1", "ne_10m_admin_1_states_provinces_lines.geojson", 0.002, True),
        ("admin0", "ne_10m_admin_0_boundary_lines_land.geojson", 0.0015, False),
    ]:
        add_geoms(layer, read(str(ne / fname)), tol, 4, us_mask if clip else None)

    print("USGS 1:1M hydrography ...")
    add_geoms("coast", read(gdb, "Coastline"), 0.0003, 5)
    add_geoms("water", read(gdb, "Waterbody", "Feature IN ('Lake', 'Reservoir')", ["Feature"]), 0.0004, 5)
    add_geoms("streams", read(gdb, "Stream", "Strahler >= 4 AND Feature = 'Stream'", ["Strahler", "Feature"]), 0.0005, 5)

    print("Census 1:500k boundaries ...")
    add_geoms("county", counties, 0.0004, 5)
    add_geoms("place", read(glob.glob(str(us / "place" / "*.shp"))[0]), 0.0004, 5)

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    for key, layers in tiles.items():
        (OUT / f"{key}.json").write_text(json.dumps(layers, separators=(",", ":")))
    (OUT / "index.json").write_text(json.dumps({
        "tile_deg": TILE, "tiles": sorted(tiles),
        "sources": ["Natural Earth 1:10m v5.1.2", "USGS 1:1M hydrography (hydrusm010g)",
                    "US Census 2023 cartographic boundaries 1:500k"]}))
    size = sum(f.stat().st_size for f in OUT.glob("*.json"))
    print(f"tiles: {len(tiles)}, total {size / 1e6:.1f} MB; points per layer: {dict(stats)}")


if __name__ == "__main__":
    main()
