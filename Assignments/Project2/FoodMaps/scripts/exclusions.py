"""Manual exclusions: remove listed photos from the globe dataset.

data/excluded_ids.txt holds one Apple Photos UUID per line ('#' comments allowed).
Excluded photos (and the near-identical shots merged into them) are moved to
review_candidates.json with review_reason "user_excluded", and their generated globe
thumbnails are deleted. Nothing in Apple Photos is touched.

  python scripts/exclusions.py      # apply to the existing data/*.json, rebuild review.html
extract_food.py applies the same list automatically on every run.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import DATA_DIR, IMAGES_DIR, log  # noqa: E402

EXCLUDE_FILE = DATA_DIR / "excluded_ids.txt"


def load_excluded() -> set[str]:
    try:
        return {ln.strip().upper() for ln in EXCLUDE_FILE.read_text().splitlines()
                if ln.strip() and not ln.lstrip().startswith("#")}
    except FileNotFoundError:
        return set()


def apply_exclusions(food: list[dict], review: list[dict], excluded: set[str]):
    """Return (food, review, n_removed, n_group_members). Pure list operation + thumbnail cleanup."""
    if not excluded:
        return food, review, 0, 0
    keep, removed = [], []
    for r in food:
        (removed if r["id"].upper() in excluded else keep).append(r)
    dropped_groups = {r["dup_group"] for r in removed if r.get("dup_group")}
    members = 0
    for r in review:
        if r.get("review_reason") == "duplicate_of" and r.get("dup_group") in dropped_groups:
            r["review_reason"] = "user_excluded_group"
            members += 1
        elif r["id"].upper() in excluded and r.get("review_reason") != "user_excluded":
            r["review_reason"] = "user_excluded"
    for r in removed:
        if r.get("thumb", "").startswith("images/") and "/review/" not in r["thumb"]:
            (IMAGES_DIR.parent / r["thumb"]).unlink(missing_ok=True)
        r["thumb"] = None
        r["review_reason"] = "user_excluded"
        review.append(r)
    return keep, review, len(removed), members


def main():
    fp, rp = DATA_DIR / "food_photos.json", DATA_DIR / "review_candidates.json"
    fd, rd = json.loads(fp.read_text()), json.loads(rp.read_text())
    excluded = load_excluded()
    food, review, n, m = apply_exclusions(fd["photos"], rd["photos"], excluded)
    fd["photos"] = food
    fd["meta"].update(count=len(food),
                      countries=len({r["country_code"] for r in food if r.get("country_code")}),
                      cities=len({(r["country_code"], r["city"]) for r in food if r.get("city")}),
                      user_excluded=len(excluded))
    rd["photos"] = review
    reasons = {}
    for r in review:
        reasons[r.get("review_reason")] = reasons.get(r.get("review_reason"), 0) + 1
    rd["meta"].update(count=len(review), reasons=reasons)
    fp.write_text(json.dumps(fd, ensure_ascii=False, indent=1))
    rp.write_text(json.dumps(rd, ensure_ascii=False, indent=1))
    log(f"excluded now: {n} accepted photos removed, {m} merged shots marked; "
        f"globe records: {len(food)}; countries {fd['meta']['countries']}, cities {fd['meta']['cities']}")

    import build_review
    build_review.main()


if __name__ == "__main__":
    main()
