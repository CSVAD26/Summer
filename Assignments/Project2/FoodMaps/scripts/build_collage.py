"""Build the CULINARY COLLAGE globe texture (runs locally; reads only the curated dataset
and its existing thumbnails — never the Photos Library).

  python scripts/build_collage.py <natural_earth_dir>            # real data
  python scripts/build_collage.py <natural_earth_dir> --demo     # synthetic demo data

Regions (public domain; whole-world / whole-country files only):
  United States -> 50 states + DC from US Census 2023 cartographic boundaries 1:500k
                   (<natural_earth_dir>/us_state/cb_2023_us_state_500k.shp; NAD83 ≈ WGS84),
                   precise enough for riverside cities such as St. Louis.
  China -> province-level divisions (Natural Earth 1:10m v5.1.2 admin-1).
  Everything else -> countries (Natural Earth 1:10m admin-0; Hong Kong, Macao and Taiwan are
                   their own polygons; Puerto Rico and other territories stay country-level).

Steps
  1. Point-in-polygon assignment of every photo (shapely STRtree). Points just off a coast
     (<= ~1 km) snap to the nearest polygon; anything else stays unassigned (marker only).
  2. For each region with photos: pick a varied, deterministic subset (8–20 when available),
     compose an asymmetric mosaic (guillotine partition, cover-crops, no gaps or borders) in a
     local orthographic projection centred on the region (so photos keep their proportions on
     the globe), then resample it into an equirectangular atlas strictly inside the region's
     rasterised polygon mask. Empty regions keep the sphere colour.
  3. Also writes public/geo/admin1_lines.json — US state + China province outlines (public data)
     drawn on the globe in collage mode so neighbouring collages stay separated.

Outputs (private, git-ignored): public/collage/atlas.jpg, data/collage_regions.json,
output/collage_summary.md   (demo: public/demo/collage/…)
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import sys
import warnings
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import shapely
from PIL import Image, ImageDraw, ImageOps
from shapely.geometry import shape

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR, OUTPUT_DIR, ROOT  # noqa: E402
from exclusions import load_excluded  # noqa: E402

W, H = 8192, 4096                        # atlas size (equirectangular)
BG = (252, 252, 251)                     # = minimal-mode sphere colour (#fcfcfb)
SNAP_DEG = 0.01                          # ~1 km coastal tolerance
K_MIN, K_MAX = 8, 20
CELL_MIN_PX = 28                         # area per mosaic cell guideline (atlas px)
SEED = 236


# ------------------------------------------------------------------ regions
def load_regions(ne: Path):
    a0 = json.loads((ne / "ne_10m_admin_0_countries.geojson").read_text())["features"]
    a1 = json.loads((ne / "ne_10m_admin_1_states_provinces.geojson").read_text())["features"]
    countries, subs = [], {"USA": [], "CHN": []}
    for f in a0:
        p = f["properties"]
        countries.append({"code": p["ADM0_A3"], "name": p["NAME"], "geom": shape(f["geometry"])})
    for f in a1:
        p = f["properties"]
        if p["adm0_a3"] == "CHN":
            subs["CHN"].append({"id": f"CN:{p['name']}", "name": p["name"], "level": "province",
                                "geom": shape(f["geometry"])})
    from pyogrio import raw
    shp = next((ne / "us_state").glob("*.shp"))
    meta, _, wkb, fields = raw.read(shp, columns=["STUSPS", "NAME"])[:4]
    names = dict(zip(meta["fields"], fields))
    territories = {"PR", "GU", "VI", "AS", "MP"}
    for g, code, name in zip(shapely.from_wkb(wkb), names["STUSPS"], names["NAME"]):
        if code not in territories:
            subs["USA"].append({"id": f"US:{code}", "name": name, "level": "state", "geom": g})
    return countries, subs


def locate(pt, items, tree):
    for i in tree.query(pt):                     # bbox candidates, then exact test
        if items[i]["geom"].covers(pt):
            return items[i], "inside"
    near = tree.query_nearest(pt, max_distance=SNAP_DEG)
    if len(near):
        return items[int(near[0])], "snapped"
    return None, None


# ------------------------------------------------------------------ geometry helpers
def to_px(lon, lat):
    return (lon + 180.0) / 360.0 * W, (90.0 - lat) / 180.0 * H


def polygons_of(g):
    if g.geom_type == "Polygon":
        return [g]
    if g.geom_type == "MultiPolygon":
        return list(g.geoms)
    return []


def rasterise(geom):
    """Mask of a (multi)polygon in atlas pixels, returned as (y0, x0, mask) for its bbox."""
    minx, miny, maxx, maxy = geom.bounds
    x0, y1 = to_px(minx, miny)
    x1, y0 = to_px(maxx, maxy)
    x0, y0 = max(0, int(math.floor(x0)) - 1), max(0, int(math.floor(y0)) - 1)
    x1, y1 = min(W, int(math.ceil(x1)) + 1), min(H, int(math.ceil(y1)) + 1)
    img = Image.new("L", (x1 - x0, y1 - y0), 0)
    d = ImageDraw.Draw(img)
    for poly in polygons_of(geom):
        ext = [(px - x0, py - y0) for px, py in (to_px(*c[:2]) for c in poly.exterior.coords)]
        if len(ext) >= 3:
            d.polygon(ext, fill=255)
        for ring in poly.interiors:
            hole = [(px - x0, py - y0) for px, py in (to_px(*c[:2]) for c in ring.coords)]
            if len(hole) >= 3:
                d.polygon(hole, fill=0)
    return y0, x0, np.asarray(img) > 127


# ------------------------------------------------------------------ photo choice + mosaic
def choose_photos(recs, k, rng):
    """Varied subset: round-robin over categories, evenly spread through time within each."""
    by_cat = defaultdict(list)
    for r in sorted(recs, key=lambda r: (r["date"] or "", r["id"])):
        by_cat[r["cat"]].append(r)
    queues = []
    for cat in sorted(by_cat):
        lst = by_cat[cat]
        # evenly spaced through time
        step = max(1, len(lst) / max(1, min(len(lst), k)))
        picked = [lst[int(i * step)] for i in range(min(len(lst), k))]
        queues.append(picked)
    rng.shuffle(queues)
    out = []
    while len(out) < k and any(queues):
        for q in queues:
            if q and len(out) < k:
                out.append(q.pop(0))
    rng.shuffle(out)
    return out


def partition(x, y, w, h, n, rng):
    """Asymmetric guillotine partition of a rectangle into n cells (floats)."""
    if n == 1:
        return [(x, y, w, h)]
    n1 = max(1, min(n - 1, round(n * rng.uniform(0.35, 0.65))))
    ratio = min(0.8, max(0.2, n1 / n * rng.uniform(0.85, 1.15)))
    aspect = w / max(h, 1e-6)
    vertical = aspect > 1.25 or (aspect > 0.8 and rng.random() < 0.5)
    if vertical:
        w1 = w * ratio
        return partition(x, y, w1, h, n1, rng) + partition(x + w1, y, w - w1, h, n - n1, rng)
    h1 = h * ratio
    return partition(x, y, w, h1, n1, rng) + partition(x, y + h1, w, h - h1, n - n1, rng)


def cover_crop(img, cw, ch, rng):
    """Scale to cover cw×ch (aspect preserved), slight random zoom, random crop offset."""
    iw, ih = img.size
    s = max(cw / iw, ch / ih) * rng.uniform(1.0, 1.3)
    nw, nh = max(cw, round(iw * s)), max(ch, round(ih * s))
    im = img.resize((nw, nh), Image.LANCZOS)
    ox = rng.randint(0, nw - cw) if nw > cw else 0
    oy = rng.randint(0, nh - ch) if nh > ch else 0
    return im.crop((ox, oy, ox + cw, oy + ch))


def compose(photos, cw, ch, rng, base):
    canvas = Image.new("RGB", (cw, ch), BG)
    cells = partition(0, 0, cw, ch, len(photos), rng)
    for (x, y, w, h), r in zip(cells, photos):
        x0, y0, x1, y1 = round(x), round(y), round(x + w), round(y + h)   # shared edges: no gaps
        if x1 - x0 < 1 or y1 - y0 < 1:
            continue
        try:
            with Image.open(base / r["thumb"]) as im:
                tile = cover_crop(ImageOps.exif_transpose(im).convert("RGB"), x1 - x0, y1 - y0, rng)
            canvas.paste(tile, (x0, y0))
        except Exception:  # noqa: BLE001 - a missing thumbnail leaves sphere colour in that cell
            pass
    return canvas


# ------------------------------------------------------------------ main
def main():
    ne = Path(sys.argv[1])
    demo = "--demo" in sys.argv
    if demo:
        src = ROOT / "public" / "demo" / "food_photos.json"
        cats_src = ROOT / "public" / "demo" / "food_categories.json"
        base = ROOT / "public" / "demo"
        out_dir = ROOT / "public" / "demo" / "collage"
        regions_out = out_dir / "regions.json"
        summary_out = out_dir / "summary.md"
        excluded = set()
    else:
        src, cats_src = DATA_DIR / "food_photos.json", DATA_DIR / "food_categories.json"
        base = ROOT / "public"
        out_dir = ROOT / "public" / "collage"
        regions_out = DATA_DIR / "collage_regions.json"
        summary_out = OUTPUT_DIR / "collage_summary.md"
        excluded = load_excluded()
    photos = [p for p in json.loads(src.read_text())["photos"] if p["id"].upper() not in excluded]
    cats = json.loads(cats_src.read_text())["assignments"]
    for p in photos:
        p["cat"] = (cats.get(p["id"]) or {}).get("category", "other")

    countries, subs = load_regions(ne)
    ctree = shapely.STRtree([c["geom"] for c in countries])
    stree = {k: shapely.STRtree([s["geom"] for s in v]) for k, v in subs.items()}
    regions = {}
    assigned = defaultdict(list)
    st = Counter()
    for p in photos:
        if p.get("lat") is None or p.get("lon") is None:
            st["no_gps"] += 1
            continue
        pt = shapely.Point(p["lon"], p["lat"])
        c, how = locate(pt, countries, ctree)
        if c is None:
            st["unassigned_no_country"] += 1
            continue
        st[f"country_{how}"] += 1
        if c["code"] in subs:
            s, how2 = locate(pt, subs[c["code"]], stree[c["code"]])
            if s is None:
                st["unassigned_no_subdivision"] += 1
                continue
            rid, name, level, geom = s["id"], s["name"], s["level"], s["geom"]
        else:
            rid, name, level, geom = f"A0:{c['code']}", c["name"], "country", c["geom"]
        regions[rid] = {"id": rid, "name": name, "level": level, "country": c["code"], "geom": geom}
        assigned[rid].append(p)
        # cross-check with the country name Apple Photos stored (aggregate only)
        apple = (p.get("country") or "").lower()
        ne_names = {c["name"].lower()}
        if apple:
            st["apple_country_match" if any(apple in n or n in apple for n in ne_names)
               or (c["code"] == "USA" and "united states" in apple)
               or (c["code"] == "CHN" and "china" in apple) else "apple_country_differs"] += 1

    # ---------------------------------------------------------------- atlas
    atlas = np.empty((H, W, 3), np.uint8)
    atlas[:] = BG
    filled = np.zeros((H, W), bool)
    rad_px = W / (2 * math.pi)                       # atlas pixels per radian (equator)
    summary = []
    for rid in sorted(assigned, key=lambda r: (-len(assigned[r]), r)):
        reg, recs = regions[rid], assigned[rid]
        y0, x0, mask = rasterise(reg["geom"])
        ys, xs = np.nonzero(mask)
        if not len(ys):
            continue
        ys, xs = ys + y0, xs + x0
        lon = (xs + 0.5) / W * 360.0 - 180.0
        lat = 90.0 - (ys + 0.5) / H * 180.0
        # region centre: mean unit vector (robust across the antimeridian)
        la, lo = np.radians(lat), np.radians(lon)
        wgt = np.cos(la)
        v = np.array([np.sum(wgt * np.cos(la) * np.cos(lo)), np.sum(wgt * np.cos(la) * np.sin(lo)), np.sum(wgt * np.sin(la))])
        v /= np.linalg.norm(v)
        lat0, lon0 = math.asin(v[2]), math.atan2(v[1], v[0])
        # local orthographic coordinates (radians on the tangent plane)
        dl = lo - lon0
        X = np.cos(la) * np.sin(dl)
        Y = math.cos(lat0) * np.sin(la) - math.sin(lat0) * np.cos(la) * np.cos(dl)
        xmin, xmax, ymin, ymax = X.min(), X.max(), Y.min(), Y.max()
        cw = int(min(4096, max(8, math.ceil((xmax - xmin) * rad_px) + 2)))
        ch = int(min(4096, max(8, math.ceil((ymax - ymin) * rad_px) + 2)))
        sx, sy = (cw - 1) / max(xmax - xmin, 1e-9), (ch - 1) / max(ymax - ymin, 1e-9)
        area_cells = max(1, int(len(xs) // (CELL_MIN_PX * CELL_MIN_PX)))
        # 8–20 photos when available (fewer only when fewer exist); one photo -> that photo
        k = min(len(recs), K_MAX, max(K_MIN, area_cells))
        rng = random.Random(int(hashlib.sha1(f"{SEED}:{rid}".encode()).hexdigest()[:12], 16))
        chosen = choose_photos(recs, k, rng)
        collage = np.asarray(compose(chosen, cw, ch, rng, base))
        cx = np.clip(((X - xmin) * sx).round().astype(int), 0, cw - 1)
        cy = np.clip(((ymax - Y) * sy).round().astype(int), 0, ch - 1)
        atlas[ys, xs] = collage[cy, cx]
        filled[ys, xs] = True
        reg["photo_ids"] = [r["id"] for r in recs]
        reg["collage_ids"] = [r["id"] for r in chosen]
        summary.append((reg["name"], reg["level"], reg["country"], len(recs), len(chosen)))

    # 30° graticule baked into the EMPTY areas only (collage mode hides the line graticule,
    # so photographs are never crossed by grid lines). Same grey as the minimal graticule.
    grid = np.zeros((H, W), bool)
    for lat in range(-60, 90, 30):
        y = int(round((90 - lat) / 180 * H))
        grid[max(0, y - 1):y + 1, :] = True
    for lon in range(-180, 180, 30):
        x = int(round((lon + 180) / 360 * W)) % W
        grid[:, max(0, x - 1):x + 1] = True
    atlas[grid & ~filled] = (236, 236, 236)

    out_dir.mkdir(parents=True, exist_ok=True)
    Image.fromarray(atlas).save(out_dir / "atlas.jpg", "JPEG", quality=90, optimize=True, progressive=True)
    regions_out.parent.mkdir(parents=True, exist_ok=True)
    regions_out.write_text(json.dumps({
        "atlas": {"width": W, "height": H, "projection": "equirectangular", "background": "#fcfcfb"},
        "regions": [{k: v for k, v in r.items() if k != "geom"} for r in regions.values() if "photo_ids" in r],
        "stats": dict(st)}, indent=1))

    # public admin-1 outlines for collage mode (all US states + China provinces; no photo info)
    lines = []
    for lst in subs.values():
        for s in lst:
            for poly in polygons_of(s["geom"].simplify(0.02)):
                for ring in [poly.exterior, *poly.interiors]:
                    lines.append([round(v, 3) for c in ring.coords for v in c[:2]])
    geo_out = ROOT / "public" / "geo" / "admin1_lines.json"
    geo_out.write_text(json.dumps({"source": "Natural Earth 1:10m admin-1 (US states, China provinces)",
                                   "format": "polylines of [lon, lat, ...]", "lines": lines},
                                  separators=(",", ":")))

    md = ["# Culinary collage — regional summary\n",
          f"Photos: {len(photos)} · assigned: {sum(len(v) for v in assigned.values())} · regions filled: {len(summary)}\n",
          "Assignment: " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in sorted(st.items())) + "\n",
          "| Region | Level | Country | Photos | In collage |", "|---|---|---|---:|---:|"]
    md += [f"| {n} | {lv} | {c} | {cnt} | {k} |" for n, lv, c, cnt, k in summary]
    summary_out.parent.mkdir(parents=True, exist_ok=True)
    summary_out.write_text("\n".join(md) + "\n")

    print(f"photos {len(photos)}, assigned {sum(len(v) for v in assigned.values())}, regions filled {len(summary)}")
    print("assignment:", dict(sorted(st.items())))
    print(f"atlas {W}x{H}, filled pixels {filled.mean() * 100:.2f}%, file {(out_dir / 'atlas.jpg').stat().st_size // 1024} KB")
    print("regions (photos / in collage):")
    for n, lv, c, cnt, k in summary:
        print(f"  {n} ({lv}, {c}): {cnt} / {k}")


if __name__ == "__main__":
    main()
