"""Near-duplicate grouping for food photos. Affects only the generated dataset; originals
are never touched.

Signals (in order of cost):
 1. Exact duplicates: Photos' own fingerprint (identical image data).
 2. Perceptual hash (pHash, 64-bit) of the local preview.
 3. Optional Apple Vision feature-print embedding distance (on-device).
 4. Time + GPS proximity gate: two photos are only ever compared if they were taken
    close together in time AND place. Similar meals on different days or in different
    cities therefore always stay separate.

Pairs that are close but not clearly duplicates are reported as "possible" so they can be
reviewed instead of silently merged.
"""

from __future__ import annotations

import math
from array import array
from dataclasses import dataclass

# Tunable thresholds
TIME_WINDOW_S = 90 * 60     # only compare photos taken within 90 minutes of each other
MAX_DIST_M = 300            # ...and within 300 m (when both have GPS)
PHASH_DUP = 10              # pHash Hamming <= this: near-identical frame -> duplicate
PHASH_POSSIBLE = 20         # pHash Hamming <= this: visually similar
EMBED_STRICT = 0.25         # Vision embedding distance <= this alone: duplicate
EMBED_DUP = 0.35            # <= this AND pHash similar: duplicate
EMBED_POSSIBLE = 0.45       # <= this: keep both, flag possible_duplicate for review
# Calibration (this library): unrelated food photos >= 0.41; shots within one meal
# spread 0.1-0.6, so different dishes at the same table can fall below 0.45.


@dataclass
class Item:
    key: str                 # photo uuid
    ts: float                # unix timestamp
    latlon: tuple | None
    fingerprint: str | None
    phash: int | None = None
    embed: array | None = None


def phash_file(path: str) -> int | None:
    try:
        import imagehash
        from PIL import Image

        with Image.open(path) as im:
            return int(str(imagehash.phash(im.convert("RGB"))), 16)
    except Exception:  # noqa: BLE001
        return None


def feature_print(path: str) -> array | None:
    """Apple Vision image feature print (on-device embedding)."""
    try:
        import Vision
        from Foundation import NSURL

        handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(
            NSURL.fileURLWithPath_(path), None)
        req = Vision.VNGenerateImageFeaturePrintRequest.alloc().init()
        ok, _ = handler.performRequests_error_([req], None)
        if not ok or not req.results():
            return None
        obs = req.results()[0]
        if obs.elementType() != 1:  # 1 = float32
            return None
        a = array("f")
        a.frombytes(bytes(obs.data()))
        return a
    except Exception:  # noqa: BLE001
        return None


def embed_distance(a: array, b: array) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def haversine_m(a, b) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def _near(a: Item, b: Item) -> bool:
    if abs(a.ts - b.ts) > TIME_WINDOW_S:
        return False
    if a.latlon and b.latlon:
        return haversine_m(a.latlon, b.latlon) <= MAX_DIST_M
    # If one lacks GPS we rely on the (tight) time window only.
    return True


class _UF:
    def __init__(self, keys):
        self.p = {k: k for k in keys}

    def find(self, k):
        while self.p[k] != k:
            self.p[k] = self.p[self.p[k]]
            k = self.p[k]
        return k

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def group_duplicates(items: list[Item], embed_fn=None) -> tuple[dict, list, dict]:
    """Return (key -> group_id, uncertain_clusters, stats).

    Only photos within TIME_WINDOW_S and MAX_DIST_M of each other are compared.
    A pair is a duplicate if: identical fingerprint, OR pHash <= PHASH_DUP, OR
    Vision embedding distance <= EMBED_DUP. Before two groups are merged, every
    cross-pair must at least be "possibly similar" (complete-linkage guard), so a
    chain of in-between shots can never merge two different dishes.
    Pairs that are similar but not clearly duplicates become uncertain clusters
    (lists of group ids) for manual review; their photos are all kept.
    embed_fn(key) -> array|None is called lazily, once per photo.
    """
    import hashlib

    items = sorted(items, key=lambda i: i.ts)
    by_key = {it.key: it for it in items}
    uf = _UF(list(by_key))
    members = {k: [k] for k in by_key}
    stats = {"pairs_compared": 0, "exact": 0, "phash": 0, "embed": 0, "possible": 0,
             "blocked_by_linkage_guard": 0, "embed_dist_hist": [0] * 10}
    ecache: dict[str, array | None] = {}
    mcache: dict[tuple, tuple] = {}

    def emb(it: Item):
        if it.embed is not None:
            return it.embed
        if embed_fn is None:
            return None
        if it.key not in ecache:
            ecache[it.key] = embed_fn(it.key)
        return ecache[it.key]

    def metrics(a: Item, b: Item):
        k = (a.key, b.key) if a.key < b.key else (b.key, a.key)
        if k not in mcache:
            exact = bool(a.fingerprint and a.fingerprint == b.fingerprint)
            ham = bin(a.phash ^ b.phash).count("1") if a.phash is not None and b.phash is not None else None
            ea, eb = emb(a), emb(b)
            d = embed_distance(ea, eb) if ea is not None and eb is not None else None
            mcache[k] = (exact, ham, d)
        return mcache[k]

    def verdict(m):
        exact, ham, d = m
        if exact:
            return "exact"
        if ham is not None and ham <= PHASH_DUP:
            return "phash"
        similar_px = ham is not None and ham <= PHASH_POSSIBLE
        if d is not None and (d <= EMBED_STRICT or (d <= EMBED_DUP and similar_px)):
            return "embed"
        if (d is not None and d <= EMBED_POSSIBLE) or similar_px:
            return "possible"
        return "different"

    possible_pairs = []
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            if b.ts - a.ts > TIME_WINDOW_S:
                break
            if not _near(a, b):
                continue
            stats["pairs_compared"] += 1
            m = metrics(a, b)
            if m[2] is not None:
                stats["embed_dist_hist"][min(9, int(m[2] / 0.15))] += 1
            v = verdict(m)
            if v == "different":
                continue
            if v == "possible":
                possible_pairs.append((a.key, b.key)); stats["possible"] += 1
                continue
            ra, rb = uf.find(a.key), uf.find(b.key)
            if ra == rb:
                continue
            ok = all(verdict(metrics(by_key[x], by_key[y])) != "different"
                     for x in members[ra] for y in members[rb])
            if not ok:
                stats["blocked_by_linkage_guard"] += 1
                possible_pairs.append((a.key, b.key))
                continue
            uf.union(a.key, b.key)
            members[ra] = members[ra] + members.pop(rb)
            stats[v] += 1

    # Stable group ids: hash of the earliest member's uuid (same across reruns).
    roots, groups = {}, {}
    for it in items:
        r = uf.find(it.key)
        if r not in roots:
            roots[r] = "g" + hashlib.sha1(it.key.encode()).hexdigest()[:10]
        groups[it.key] = roots[r]

    # Uncertain clusters: connected components of "possible" links between groups.
    guf = _UF(sorted(set(groups.values())))
    for x, y in possible_pairs:
        if groups[x] != groups[y]:
            guf.union(groups[x], groups[y])
    comp = {}
    for g in sorted(set(groups.values())):
        comp.setdefault(guf.find(g), []).append(g)
    clusters = [c for c in comp.values() if len(c) > 1]
    stats["uncertain_clusters"] = len(clusters)
    return groups, clusters, stats
