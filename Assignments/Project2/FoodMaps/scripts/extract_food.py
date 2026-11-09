"""FoodMaps extraction pipeline.

  python scripts/extract_food.py --limit 0        # whole library (all Stage A candidates)
  python scripts/extract_food.py --limit 100      # quick sample

Steps: Stage A (Apple labels) on every photo -> Stage B (Apple Vision) on candidates ->
deduplicate (time + GPS gate, pHash, Vision embeddings) -> browser thumbnails from LOCAL
previews -> data/food_photos.json, data/review_candidates.json, output/review.html.

Read-only with respect to the Photos Library. Never downloads from iCloud. Console output
is aggregate-only; per-photo details go only to git-ignored local files.
Classification results are cached in .cache/ (uuid -> scores, no paths) so reruns are fast.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import html
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from classify_food import classify, stage_a  # noqa: E402
from common import (CACHE_DIR, DATA_DIR, IMAGES_DIR, OUTPUT_DIR, all_images,  # noqa: E402
                    best_local_derivative, gps, load_photosdb, log, place_info, safe_err)
from exclusions import apply_exclusions, load_excluded  # noqa: E402
from deduplicate import Item, feature_print, group_duplicates, phash_file  # noqa: E402

THUMB_MAX = 640
THUMB_QUALITY = 80
REVIEW_DIR = IMAGES_DIR / "review"
CLASSIFIER_VERSION = "v2-appliance-doc-screenshot"   # bump to invalidate the cache


def make_thumb(src: str, dst: Path) -> tuple[int, int] | None:
    """Compressed JPEG from a local preview. EXIF (incl. GPS) is stripped."""
    try:
        from PIL import Image, ImageOps

        if dst.exists():
            with Image.open(dst) as im:
                return im.size
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
            dst.parent.mkdir(parents=True, exist_ok=True)
            im.save(dst, "JPEG", quality=THUMB_QUALITY, optimize=True, progressive=True)
            return im.size
    except Exception:  # noqa: BLE001
        return None


def event_key(p):
    g = gps(p)
    day = p.date.date().isoformat() if p.date else "nodate"
    return (day, round(g[0], 2), round(g[1], 2)) if g else (day, None, None)


def choose_pool(cands, limit, rng):
    """Sample mode: whole 'events' (same day + ~1 km cell) so dedup is exercised realistically."""
    if limit <= 0:
        return cands
    events = collections.defaultdict(list)
    for p, a in cands:
        if gps(p):
            events[event_key(p)].append((p, a))
    keys = sorted((k for k, v in events.items() if any(a.decision == "food" for _, a in v)),
                  key=lambda k: (k[0], k[1] or 0, k[2] or 0))
    rng.shuffle(keys)  # sorted first so the same seed always gives the same sample
    for k in keys:
        events[k].sort(key=lambda c: c[0].uuid)
    pool, target = [], int(limit * 1.6)
    for k in keys:
        if len(pool) >= target:
            break
        pool.extend(events[k][:8])
    nogps = sorted((c for c in cands if not gps(c[0])), key=lambda c: c[0].uuid)
    pool.extend(rng.sample(nogps, min(len(nogps), max(5, limit // 5))))
    return pool


def record(p, cls, thumb_rel, size):
    g = gps(p)
    pl = place_info(p)
    v = cls.get("vision") or {}
    return {
        "id": p.uuid,
        "filename": p.original_filename,
        "date": p.date.isoformat() if p.date else None,
        "lat": round(g[0], 5) if g else None,
        "lon": round(g[1], 5) if g else None,
        "city": pl["city"],
        "country": pl["country"],
        "country_code": pl["country_code"],
        "labels": sorted(p.labels or []),
        "food_labels": cls["food_labels"],
        "caption": p.ai_caption or None,
        "thumb": thumb_rel,
        "thumb_w": size[0] if size else None,
        "thumb_h": size[1] if size else None,
        "confidence": cls["confidence"],
        "classified_by": cls["stage"],
        "vision_food": v.get("food"),
        "vision_top": v.get("top"),
        "aesthetic": round(p.score.overall, 3) if p.score and p.score.overall is not None else None,
        "flags": list(cls["flags"]),
        "dup_group": None,
        "dup_count": 1,
        "dup_members": [],
        "review_cluster": None,
    }


# --------------------------------------------------------------------------- review page

# Copy-to-clipboard (works from file://; falls back to execCommand where the
# async clipboard API is unavailable). Runs only in the local browser.
COPY_JS = """<script>
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  const id = b.dataset.id;
  let ok = false;
  try { await navigator.clipboard.writeText(id); ok = true; } catch (_) {
    const t = document.createElement('textarea');
    t.value = id; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { ok = document.execCommand('copy'); } catch (_) {}
    t.remove();
  }
  b.textContent = ok ? 'Copied!' : 'Copy failed';
  b.classList.toggle('ok', ok);
  clearTimeout(b._t);
  b._t = setTimeout(() => { b.textContent = 'Copy ID'; b.classList.remove('ok'); }, 1200);
});
</script>"""

def write_review_html(food, review, clusters, by_id, stats, path: Path):
    esc = html.escape

    def card(r, tag=""):
        src = esc("../public/" + r["thumb"]) if r.get("thumb") else ""
        meta = esc(f'{(r.get("date") or "")[:10]} · {r.get("city") or "—"} · {r.get("country_code") or "—"}'
                   f' · conf {r.get("confidence")}')
        lab = esc(", ".join((r.get("food_labels") or [])[:4]))
        t = f"<b>{esc(tag)}</b> " if tag else ""
        img = f'<img loading="lazy" src="{src}">' if src else '<div class="noimg">no preview</div>'
        uid = esc(r["id"])
        idrow = (f'<div class=idrow><code title="Apple Photos UUID (= &quot;id&quot; in the JSON)">{uid}</code>'
                 f'<button type=button data-id="{uid}">Copy ID</button></div>')
        return f"<figure>{img}<figcaption>{t}{meta}<br>{lab}{idrow}</figcaption></figure>"

    def section(title, n, inner, open_=False):
        return (f'<details{" open" if open_ else ""}><summary>{esc(title)} <span>({n:,})</span></summary>'
                f"{inner}</details>")

    # Accepted, grouped by country then date
    byc = collections.defaultdict(list)
    for r in food:
        byc[r.get("country") or "Unknown country"].append(r)
    acc = []
    for c in sorted(byc, key=lambda c: -len(byc[c])):
        rs = sorted(byc[c], key=lambda r: r["date"] or "")
        acc.append(f"<h3>{esc(c)} · {len(rs)}</h3><div class=g>" +
                   "".join(card(r, f'×{r["dup_count"]}' if r["dup_count"] > 1 else "") for r in rs) + "</div>")

    # Merged duplicate groups: kept photo + suppressed members
    groups = [r for r in food if r["dup_count"] > 1]
    gh = []
    for r in sorted(groups, key=lambda r: r["date"] or ""):
        row = [card(r, "kept")] + [card(by_id[m], "merged") for m in r["dup_members"] if m in by_id]
        gh.append(f'<div class="row">{"".join(row)}</div>')

    # Uncertain clusters: all kept; shown side by side
    uh = []
    for cid, rids in clusters:
        uh.append(f'<div class="row"><span class=cid>{esc(cid)}</span>'
                  + "".join(card(by_id[i], "kept") for i in rids if i in by_id) + "</div>")

    unc = [r for r in review if r.get("review_reason") == "uncertain_classification"]
    nog = [r for r in review if r.get("review_reason") == "missing_location"]
    noprev = [r for r in review if r.get("review_reason") == "icloud_only_no_local_preview"]

    stat_html = " · ".join(f"<b>{v:,}</b> {esc(k)}" for k, v in stats.items())
    body = [
        f"<h1>FoodMaps review <small>(local only)</small></h1><p class=stats>{stat_html}</p>"
        "<p class=idnote>ID shown under each photo = Apple Photos UUID, identical to the "
        "<code>id</code> field in data/food_photos.json.</p>",
        section("Accepted for the globe", len(food), "".join(acc), True),
        section("Merged duplicate groups (kept + merged)", len(groups), "".join(gh)),
        section("Uncertain duplicates — all kept, flagged", len(clusters), "".join(uh)),
        section("Uncertain classification — not on globe", len(unc),
                "<div class=g>" + "".join(card(r, r.get("why", "")) for r in unc) + "</div>"),
        section("Food without GPS — not on globe", len(nog),
                "<div class=g>" + "".join(card(r) for r in nog) + "</div>"),
        section("No local preview (iCloud only, skipped)", len(noprev), ""),
    ]
    path.write_text(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
        "<title>FoodMaps review</title><style>"
        "body{font:13px system-ui;margin:16px;background:#111;color:#ddd}h1 small{opacity:.5;font-weight:400}"
        ".stats{opacity:.8}summary{font-size:18px;cursor:pointer;padding:10px 0;border-top:1px solid #333}"
        "summary span{opacity:.6}h3{margin:18px 0 6px;font-weight:600}"
        ".g{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}"
        ".row{display:flex;gap:10px;overflow-x:auto;padding:8px 0;border-bottom:1px solid #222;align-items:flex-start}"
        ".row figure{flex:0 0 160px}.cid{writing-mode:vertical-rl;opacity:.4;font-size:10px}"
        "figure{margin:0}img,.noimg{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;background:#222}"
        ".noimg{display:grid;place-items:center;opacity:.5}figcaption{font-size:11px;opacity:.8;margin-top:3px}"
        ".idrow{display:flex;align-items:center;gap:4px;margin-top:3px}"
        ".idrow code{flex:1;min-width:0;font:9px/1.2 ui-monospace,Menlo,monospace;word-break:break-all;"
        "user-select:all;color:#9ab}"
        ".idrow button{flex:none;font:10px system-ui;padding:2px 6px;border:1px solid #444;border-radius:4px;"
        "background:#222;color:#ddd;cursor:pointer}.idrow button:hover{background:#333}"
        ".idrow button.ok{background:#1f5130;border-color:#2e7d46;color:#fff}"
        ".idnote{opacity:.6;font-size:12px}"
        "</style>" + "".join(body) + COPY_JS)


# --------------------------------------------------------------------------- main

def load_cache():
    f = CACHE_DIR / "classify.json"
    try:
        d = json.loads(f.read_text())
        return d["results"] if d.get("version") == CLASSIFIER_VERSION else {}
    except Exception:  # noqa: BLE001
        return {}


def save_cache(results):
    CACHE_DIR.mkdir(exist_ok=True)
    (CACHE_DIR / "classify.json").write_text(json.dumps({"version": CLASSIFIER_VERSION, "results": results}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=100, help="target unique photos (0 = all)")
    ap.add_argument("--seed", type=int, default=236)
    ap.add_argument("--no-vision", action="store_true", help="skip Stage B")
    ap.add_argument("--no-embed", action="store_true", help="skip embedding-based dedup")
    args = ap.parse_args()
    rng = random.Random(args.seed)
    t0 = time.time()
    st = collections.Counter()

    db = load_photosdb()
    photos = all_images(db)
    st["library_images"] = len(photos)

    # Stage A on everything (metadata only)
    cands = []
    for p in photos:
        a = stage_a(list(p.labels or []), p.ai_caption)
        st["stageA_" + a.decision] += 1
        if a.decision != "not_food":
            cands.append((p, a))
    pool = choose_pool(cands, args.limit, rng)
    st["pool"] = len(pool)
    log(f"Stage A: {st['stageA_food']} food + {st['stageA_ambiguous']} ambiguous; processing {len(pool)}")

    # Stage B (cached)
    cache = load_cache()
    by_uuid, cls_by_uuid, deriv = {}, {}, {}
    accepted, review = [], []
    for i, (p, _a) in enumerate(pool, 1):
        try:
            c = cache.get(p.uuid) if not args.no_vision else None
            if c is None:
                c = classify(p, run_vision=not args.no_vision)
                cache[p.uuid] = c
            else:
                st["classify_cached"] += 1
        except Exception as e:  # noqa: BLE001
            st["classify_error:" + safe_err(e)] += 1
            continue
        st["final_" + c["decision"]] += 1
        st["by_" + c["stage"]] += 1
        if "screenshot" in c["flags"]:
            st["excluded_screenshot"] += 1
        if c["decision"] == "not_food":
            continue
        by_uuid[p.uuid], cls_by_uuid[p.uuid], deriv[p.uuid] = p, c, best_local_derivative(p)
        (accepted if c["decision"] == "food" else review).append(p.uuid)
        if i % 250 == 0:
            log(f"  classified {i}/{len(pool)} ({time.time() - t0:.0f}s)")
            save_cache(cache)
    save_cache(cache)
    log(f"Stage B done: {st['final_food']} food, {st['final_review']} review, {st['final_not_food']} not food")

    # Deduplicate accepted photos
    items = []
    for u in accepted:
        p = by_uuid[u]
        items.append(Item(key=u, ts=p.date.timestamp() if p.date else 0.0, latlon=gps(p),
                          fingerprint=getattr(p, "fingerprint", None),
                          phash=phash_file(deriv[u]) if deriv[u] else None))
    embed_fn = None if args.no_embed else (lambda k: feature_print(deriv[k]) if deriv[k] else None)
    groups, clusters, dstats = group_duplicates(items, embed_fn)
    log(f"Dedup done ({time.time() - t0:.0f}s)")
    members = collections.defaultdict(list)
    for u, g in groups.items():
        members[g].append(u)

    def rank(u):
        c, p = cls_by_uuid[u], by_uuid[u]
        aes = p.score.overall if p.score and p.score.overall is not None else 0
        return (c["confidence"], aes)

    reps = []
    for g, us in members.items():
        us.sort(key=rank, reverse=True)
        reps.append((g, us))
    reps.sort(key=lambda x: (gps(by_uuid[x[1][0]]) is None, x[0]))
    group_cluster = {g: f"u{i:04d}" for i, gs in enumerate(clusters) for g in gs}

    food_records, review_records, member_records = [], [], {}
    for g, us in reps:
        rep = us[0]
        p = by_uuid[rep]
        has_gps = gps(p) is not None
        if args.limit and has_gps and len(food_records) >= args.limit:
            st["unused_due_to_limit"] += 1
            continue
        if deriv[rep] is None:
            r = record(p, cls_by_uuid[rep], None, None)
            r["review_reason"] = "icloud_only_no_local_preview"
            review_records.append(r)
            continue
        rel = ("images/" if has_gps else "images/review/") + f"{rep}.jpg"
        size = make_thumb(deriv[rep], IMAGES_DIR.parent / rel)
        if size is None:
            st["thumb_error"] += 1
        r = record(p, cls_by_uuid[rep], rel if size else None, size)
        r["dup_group"], r["dup_count"], r["dup_members"] = g, len(us), us[1:]
        if g in group_cluster:
            r["review_cluster"] = group_cluster[g]
            r["flags"].append("possible_duplicate")
        if has_gps:
            food_records.append(r)
        else:
            r["review_reason"] = "missing_location"
            review_records.append(r)
        for other in us[1:]:  # merged duplicates: thumbnail kept for verification only
            st["duplicates_merged"] += 1
            po = by_uuid[other]
            orel, osize = None, None
            if deriv[other]:
                osize = make_thumb(deriv[other], REVIEW_DIR / f"{other}.jpg")
                orel = f"images/review/{other}.jpg" if osize else None
            mr = record(po, cls_by_uuid[other], orel, osize)
            mr.update(review_reason="duplicate_of", duplicate_of=rep, dup_group=g)
            member_records[other] = mr
            review_records.append(mr)

    for u in review:
        p = by_uuid[u]
        rel, size = None, None
        if deriv[u]:
            size = make_thumb(deriv[u], REVIEW_DIR / f"{u}.jpg")
            rel = f"images/review/{u}.jpg" if size else None
        r = record(p, cls_by_uuid[u], rel, size)
        r["review_reason"] = "uncertain_classification"
        r["why"] = ",".join(r["flags"]) or "low_confidence"
        review_records.append(r)

    food_records.sort(key=lambda r: r["date"] or "")

    # Manual exclusions (data/excluded_ids.txt)
    food_records, review_records, n_ex, n_exm = apply_exclusions(food_records, review_records, load_excluded())
    st["user_excluded"], st["user_excluded_group_members"] = n_ex, n_exm

    # Remove generated thumbnails no longer referenced (only our own output folder)
    referenced = {r["thumb"] for r in food_records + review_records if r.get("thumb")}
    for f in list(IMAGES_DIR.glob("*.jpg")) + list(REVIEW_DIR.glob("*.jpg")):
        if str(f.relative_to(IMAGES_DIR.parent)) not in referenced:
            f.unlink()
            st["stale_thumbs_removed"] += 1

    countries = {r["country_code"] for r in food_records if r.get("country_code")}
    cities = {(r["country_code"], r["city"]) for r in food_records if r.get("city")}
    meta = {
        "generated": dt.datetime.now().isoformat(timespec="seconds"),
        "mode": "sample" if args.limit else "full",
        "count": len(food_records),
        "countries": len(countries),
        "cities": len(cities),
        "date_range": [food_records[0]["date"], food_records[-1]["date"]] if food_records else None,
        "thumb_max_px": THUMB_MAX,
        "classifier": CLASSIFIER_VERSION,
        "fields": list(food_records[0].keys()) if food_records else [],
    }
    DATA_DIR.mkdir(exist_ok=True)
    (DATA_DIR / "food_photos.json").write_text(
        json.dumps({"meta": meta, "photos": food_records}, ensure_ascii=False, indent=1))
    reasons = collections.Counter(r.get("review_reason") for r in review_records)
    rclusters = [[cid, [r["id"] for r in food_records + review_records
                        if r.get("review_cluster") == cid]] for cid in sorted(set(group_cluster.values()))]
    (DATA_DIR / "review_candidates.json").write_text(json.dumps(
        {"meta": {**meta, "count": len(review_records), "reasons": dict(reasons)},
         "uncertain_duplicate_clusters": rclusters, "photos": review_records},
        ensure_ascii=False, indent=1))

    by_id = {r["id"]: r for r in food_records + review_records}
    OUTPUT_DIR.mkdir(exist_ok=True)
    write_review_html(food_records, review_records, [c for c in rclusters if len(c[1]) > 1], by_id,
                      {"on globe": len(food_records), "countries": len(countries), "cities": len(cities),
                       "merged duplicates": st["duplicates_merged"],
                       "no GPS": reasons["missing_location"],
                       "uncertain": reasons["uncertain_classification"]},
                      OUTPUT_DIR / "review.html")

    # Aggregate-only summary
    st["globe_records"] = len(food_records)
    st["review_records"] = len(review_records)
    st["thumbnails_referenced"] = len(referenced)
    log("---- summary (aggregate) ----")
    for k in sorted(st):
        log(f"{k}: {st[k]}")
    for k, v in dstats.items():
        log(f"dedup_{k}: {v}")
    log(f"review reasons: {dict(reasons)}")
    log(f"distinct countries: {len(countries)}, distinct cities: {len(cities)}")
    log(f"elapsed: {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
