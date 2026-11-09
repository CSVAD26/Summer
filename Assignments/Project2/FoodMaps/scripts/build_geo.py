"""Build simplified globe outlines from Natural Earth (public data).

  python scripts/build_geo.py path/to/countries-50m.json

Source: world-atlas@2.0.2 countries-50m.json (Natural Earth 1:50m, public domain),
https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json

TopoJSON arcs are classified by how many country polygons use them:
  used once            -> coastline (outer edge of land)
  shared by countries  -> land border
Each arc is simplified with Douglas-Peucker (tolerance in degrees, longitude scaled by
cos(latitude)). Artificial edges (the antimeridian cut and Antarctica's -90° closure)
are removed. Output: public/geo/world_lines.json  {coast: [[lon,lat,...]], borders: [...]}
Contains only public geographic data.
"""

from __future__ import annotations

import json
import math
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "geo" / "world_lines.json"
TOL_COAST = 0.045   # degrees
TOL_BORDER = 0.07


def decode_arcs(topo):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx; y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    return arcs


def arc_usage(geoms):
    use = Counter()

    def walk(a):
        if isinstance(a, int):
            use[a if a >= 0 else ~a] += 1
        else:
            for b in a:
                walk(b)
    for g in geoms:
        walk(g.get("arcs", []))
    return use


def dp(pts, tol):
    """Douglas-Peucker on (lon, lat) with longitude scaled by cos(lat)."""
    if len(pts) < 3:
        return pts

    def dist(p, a, b):
        k = math.cos(math.radians((a[1] + b[1]) / 2))
        ax, ay, bx, by, px, py = a[0] * k, a[1], b[0] * k, b[1], p[0] * k, p[1]
        dx, dy = bx - ax, by - ay
        if dx == dy == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0.0, -1
        for k in range(i + 1, j):
            d = dist(pts[k], pts[i], pts[j])
            if d > best:
                best, idx = d, k
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def artificial(a, b):
    on_am = abs(abs(a[0]) - 180) < 1e-6 and abs(abs(b[0]) - 180) < 1e-6
    south = a[1] < -89.9 and b[1] < -89.9
    return on_am or south


def split_clean(pts):
    """Split a polyline where it runs along artificial edges; drop those edges."""
    out, cur = [], [pts[0]]
    for a, b in zip(pts, pts[1:]):
        if artificial(a, b):
            if len(cur) > 1:
                out.append(cur)
            cur = [b]
        else:
            cur.append(b)
    if len(cur) > 1:
        out.append(cur)
    return out


def main():
    src = Path(sys.argv[1])
    topo = json.loads(src.read_text())
    arcs = decode_arcs(topo)
    use = arc_usage(topo["objects"]["countries"]["geometries"])
    coast, borders = [], []
    npts = 0
    for i, pts in enumerate(arcs):
        if use[i] == 0:
            continue
        tol = TOL_COAST if use[i] == 1 else TOL_BORDER
        for part in split_clean(pts):
            s = dp(part, tol)
            if len(s) < 2:
                continue
            flat = [round(v, 3) for p in s for v in p]
            (coast if use[i] == 1 else borders).append(flat)
            npts += len(s)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "source": "Natural Earth 1:50m via world-atlas@2.0.2 (public domain)",
        "format": "polylines of [lon, lat, lon, lat, ...] in degrees",
        "coast": coast, "borders": borders}, separators=(",", ":")))
    raw_pts = sum(len(a) for a in arcs)
    print(f"arcs {len(arcs)} -> coast lines {len(coast)}, border lines {len(borders)}; "
          f"points {raw_pts} -> {npts}; file {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()

# Local-view outlines are built by scripts/build_local_tiles.py
