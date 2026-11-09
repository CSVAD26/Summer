"""Rebuild output/review.html from the existing data/*.json files.

Does not touch the Photos Library, the dataset, classifications or duplicate groups.
  python scripts/build_review.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import DATA_DIR, OUTPUT_DIR, log  # noqa: E402
from extract_food import write_review_html  # noqa: E402


def main():
    food = json.loads((DATA_DIR / "food_photos.json").read_text())["photos"]
    rv = json.loads((DATA_DIR / "review_candidates.json").read_text())
    review = rv["photos"]
    clusters = [c for c in rv.get("uncertain_duplicate_clusters", []) if len(c[1]) > 1]
    by_id = {r["id"]: r for r in food + review}
    reasons = rv["meta"].get("reasons", {})
    stats = {"on globe": len(food),
             "countries": len({r["country_code"] for r in food if r.get("country_code")}),
             "cities": len({(r["country_code"], r["city"]) for r in food if r.get("city")}),
             "merged duplicates": reasons.get("duplicate_of", 0),
             "no GPS": reasons.get("missing_location", 0),
             "uncertain": reasons.get("uncertain_classification", 0),
             "excluded by you": reasons.get("user_excluded", 0)}
    OUTPUT_DIR.mkdir(exist_ok=True)
    write_review_html(food, review, clusters, by_id, stats, OUTPUT_DIR / "review.html")
    log(f"review.html rebuilt: {len(food)} accepted, {len(review)} review records")


if __name__ == "__main__":
    main()
