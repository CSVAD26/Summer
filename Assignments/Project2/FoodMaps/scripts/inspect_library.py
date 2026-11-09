"""Read-only metadata inspection of the Apple Photos Library.

  python scripts/inspect_library.py [--vision-check 100]

Writes output/library_analysis.md and output/label_counts.tsv (both git-ignored).
Console output: aggregate counts and Apple label names only.
The report's "Locations" section (country counts) is written to the file only.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from classify_food import (BEVERAGE, CONTEXT, CORE_FOOD, FOODISH_LABELS, NEGATIVE,  # noqa: E402
                           SPECIFIC_FOOD, WEAK_FOOD, stage_a, stage_b_decision, vision_classify)
from common import OUTPUT_DIR, best_local_derivative, gps, load_photosdb, log, place_info  # noqa: E402


def pct(a, b):
    return f"{100 * a / b:.1f}%" if b else "n/a"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vision-check", type=int, default=100,
                    help="photos per Stage A group to cross-check with Apple Vision (0 = skip)")
    ap.add_argument("--seed", type=int, default=236)
    args = ap.parse_args()
    t0 = time.time()

    db = load_photosdb()
    every = db.photos(images=True, movies=True)
    images = [p for p in every if p.isphoto]
    movies = [p for p in every if p.ismovie]
    c = collections.Counter()
    label_counts = collections.Counter()
    venue_counts = collections.Counter()
    country_counts = collections.Counter()
    years = collections.Counter()
    stage = collections.defaultdict(list)

    for p in images:
        c["images"] += 1
        if p.hidden:
            c["hidden"] += 1
            continue
        c["visible"] += 1
        g = gps(p)
        labels = p.labels or []
        if g:
            c["gps"] += 1
        if p.place:
            c["place"] += 1
            cc = place_info(p)["country_code"]
            if cc:
                country_counts[cc] += 1
        if labels:
            c["has_labels"] += 1
        label_counts.update(labels)
        if p.ai_caption:
            c["ai_caption"] += 1
        try:
            si = p.search_info
            if si and si.venue_types:
                c["venue_types"] += 1
                venue_counts.update(si.venue_types)
        except Exception:  # noqa: BLE001
            c["search_info_error"] += 1
        if p.screenshot:
            c["screenshot"] += 1
        if p.shared:
            c["shared"] += 1
        if p.ismissing:
            c["original_not_local"] += 1
        if p.iscloudasset:
            c["icloud_asset"] += 1
        has_prev = best_local_derivative(p) is not None
        c["local_preview" if has_prev else "no_local_preview"] += 1
        if p.ismissing and not has_prev:
            c["icloud_only_no_preview"] += 1

        a = stage_a(labels, p.ai_caption)
        c["stageA_" + a.decision] += 1
        if a.decision != "not_food":
            stage[a.decision].append(p)
            if g:
                c[f"stageA_{a.decision}_gps"] += 1
            if p.date:
                years[p.date.year] += 1
        if set(labels) & FOODISH_LABELS:
            c["any_foodish_label"] += 1

    # Vision cross-check (aggregate)
    rng = random.Random(args.seed)
    vcheck = {}
    if args.vision_check:
        neg_pool = [p for p in images if not p.hidden and p.labels
                    and stage_a(p.labels, p.ai_caption).decision == "not_food"]
        for name, pool in (("food", stage["food"]), ("ambiguous", stage["ambiguous"]),
                           ("not_food", neg_pool)):
            vc = collections.Counter()
            for p in rng.sample(pool, min(args.vision_check, len(pool))):
                d = best_local_derivative(p)
                v = vision_classify(d) if d else None
                vc[stage_b_decision(v)[0] if v else "no_result"] += 1
            vcheck[name] = (len(pool), vc)

    label_counts_food = {k: label_counts[k] for k in FOODISH_LABELS | CONTEXT | NEGATIVE
                         if label_counts.get(k)}
    venue_food = {k: v for k, v in venue_counts.items()
                  if any(w in k.lower() for w in ("restaurant", "food", "cafe", "café", "coffee",
                                                   "bakery", "bar", "pub", "dining", "tea", "dessert"))}

    # ------------------------------------------------------------------ report
    v = c["visible"]
    L = []
    L.append("# FoodMaps — Apple Photos Library Analysis\n")
    L.append(f"Generated {dt.datetime.now():%Y-%m-%d %H:%M} · OSXPhotos read-only · "
             f"Photos DB version {db.db_version} / Photos {db.photos_version}\n")
    L.append("## 1. Library overview\n")
    L.append("| Metric | Count | Share of visible images |\n|---|---:|---:|")
    rows = [
        ("Still images (total)", c["images"], None),
        ("Videos (not used)", len(movies), None),
        ("Hidden images (excluded)", c["hidden"], None),
        ("Visible images analysed", v, v),
        ("With GPS coordinates", c["gps"], c["gps"]),
        ("With Photos place info (city/country)", c["place"], c["place"]),
        ("With Apple scene labels", c["has_labels"], c["has_labels"]),
        ("With on-device AI caption", c["ai_caption"], c["ai_caption"]),
        ("With venue-type metadata", c["venue_types"], c["venue_types"]),
        ("Screenshots", c["screenshot"], c["screenshot"]),
        ("Shared-album items", c["shared"], c["shared"]),
    ]
    for name, n, share in rows:
        L.append(f"| {name} | {n:,} | {pct(share, v) if share is not None else ''} |")

    L.append("\n## 2. Local vs iCloud storage\n")
    L.append("| Metric | Count | Share |\n|---|---:|---:|")
    for name, key in (("iCloud Photos assets", "icloud_asset"),
                      ("Original NOT stored locally (Optimize Mac Storage)", "original_not_local"),
                      ("Local preview/derivative JPEG available", "local_preview"),
                      ("No local preview at all", "no_local_preview"),
                      ("iCloud-only with no local preview", "icloud_only_no_preview")):
        L.append(f"| {name} | {c[key]:,} | {pct(c[key], v)} |")
    L.append("\nThumbnails are generated from the local preview JPEGs, so no iCloud downloads are needed. "
             "Photos with no local preview are skipped and listed for review.\n")

    L.append("## 3. Apple classification labels\n")
    L.append(f"Distinct labels in library: **{len(label_counts):,}** (full list: `output/label_counts.tsv`).\n")
    L.append("Top 40 labels overall: " + ", ".join(f"{k} ({n:,})" for k, n in label_counts.most_common(40)) + "\n")

    def table(title, names):
        items = sorted(((k, label_counts[k]) for k in names if label_counts.get(k)), key=lambda x: -x[1])
        L.append(f"### {title}\n")
        L.append(", ".join(f"{k} ({n:,})" for k, n in items) + "\n" if items else "_none present_\n")

    table("Core food / meal labels", CORE_FOOD)
    table("Specific dish & ingredient labels", SPECIFIC_FOOD)
    table("Beverage labels", BEVERAGE)
    table("Weak / ambiguous food labels", WEAK_FOOD)
    table("Dining-context labels", CONTEXT)
    table("Negative labels (subject is probably not food)", NEGATIVE)
    L.append("Apple labels in this database carry **no per-label confidence score**; "
             "the pipeline derives a heuristic confidence from label combinations.\n")

    L.append("### Venue types (Photos search metadata)\n")
    L.append(", ".join(f"{k} ({n:,})" for k, n in sorted(venue_food.items(), key=lambda x: -x[1]))
             or "_no food-related venue types_")
    L.append(f"\nAll venue types: {len(venue_counts)} distinct, on {c['venue_types']:,} photos.\n")

    L.append("## 4. Food-photo candidates (Stage A: Apple metadata)\n")
    L.append("| Stage A decision | Photos | With GPS |\n|---|---:|---:|")
    for k in ("food", "ambiguous"):
        L.append(f"| {k} | {c['stageA_' + k]:,} | {c[f'stageA_{k}_gps']:,} |")
    L.append(f"| not food | {c['stageA_not_food']:,} | |")
    L.append(f"\nPhotos with any food/beverage label at all: {c['any_foodish_label']:,}.\n")
    L.append("Candidates by year: " + ", ".join(f"{y}: {n}" for y, n in sorted(years.items())) + "\n")

    if vcheck:
        L.append("## 5. Reliability check: Apple labels vs Apple Vision\n")
        L.append("Random samples from each Stage A group were re-classified on-device with "
                 "`VNClassifyImageRequest` on the local preview.\n")
        L.append("| Stage A group (pool) | Sampled | Vision: food | Vision: ambiguous | Vision: not food |"
                 "\n|---|---:|---:|---:|---:|")
        for name, (n, vc) in vcheck.items():
            s = sum(vc.values())
            L.append(f"| {name} ({n:,}) | {s} | {pct(vc['food'], s)} | {pct(vc['ambiguous'], s)} | "
                     f"{pct(vc['not_food'], s)} |")
        L.append("""
**Interpretation.**
- Apple labels have high *recall* for food but mixed *precision*: `Food`/`Dish`/`Meal` are also
  attached to group dinners, grocery shelves, menus and food in the background.
- Photos with no food label almost never contain food per Vision, so Stage A is a safe
  first filter: it removes ~90% of the library at no image-processing cost.
- Vision's fine-grained food classes are often low-confidence even on clear food photos
  (its top class is frequently a generic `tableware`/`utensil`/`structure`), so it is used as a
  corroborating second opinion, not as ground truth. Disagreements go to manual review.
- Neither source is ground truth. Use `output/review.html` (local) to spot-check results.
""")

    L.append("## 6. Locations (local file only, not printed to console)\n")
    L.append(f"Distinct countries among images with place info: {len(country_counts)}\n")
    L.append(", ".join(f"{k} ({n:,})" for k, n in country_counts.most_common(30)) + "\n")

    OUTPUT_DIR.mkdir(exist_ok=True)
    (OUTPUT_DIR / "library_analysis.md").write_text("\n".join(L))
    with open(OUTPUT_DIR / "label_counts.tsv", "w") as f:
        for k, n in label_counts.most_common():
            f.write(f"{n}\t{k}\n")

    # ------------------------------------------------------------------ console (aggregate only)
    log("---- library summary (aggregate) ----")
    for k in ("images", "hidden", "visible", "gps", "place", "has_labels", "ai_caption", "venue_types",
              "icloud_asset", "original_not_local", "local_preview", "no_local_preview",
              "icloud_only_no_preview", "any_foodish_label", "stageA_food", "stageA_food_gps",
              "stageA_ambiguous", "stageA_ambiguous_gps", "stageA_not_food"):
        log(f"{k}: {c[k]:,}")
    log(f"videos: {len(movies):,} | distinct labels: {len(label_counts):,} | distinct countries: {len(country_counts)}")
    log("food-related label counts:", dict(sorted(label_counts_food.items(), key=lambda x: -x[1])))
    # venue strings could in principle be place names, so only counts go to the console
    log(f"venue types: {len(venue_counts)} distinct; food-related: {len(venue_food)} distinct "
        f"on {sum(venue_food.values()):,} label hits")
    for name, (n, vc) in vcheck.items():
        log(f"vision check '{name}' (pool {n:,}): {dict(vc)}")
    log(f"elapsed: {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
