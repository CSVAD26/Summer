"""Assign one visual food category to every curated photo (deterministic, rule-based).

  python scripts/categorize.py

Input  : data/food_photos.json (read only; never modified)
         data/excluded_ids.txt (re-checked: excluded IDs are never categorized)
Output : data/food_categories.json   id -> category + evidence (derived dataset)
         output/category_summary.md  counts per category

Evidence comes only from what is already stored: Apple Photos labels and the local
Apple Vision top classes. Each category gets an evidence score = sum of label weights
+ Vision confidences for that category. These scores are rule weights, NOT model
probabilities. A category is assigned only if it clearly dominates; otherwise the
photo is "Other / Mixed" (we do not guess aggressively).
"""

from __future__ import annotations

import hashlib
import re
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR, OUTPUT_DIR, log  # noqa: E402
from exclusions import load_excluded  # noqa: E402

VERSION = "cat-v3"

CATEGORIES = [  # key, display name, color (restrained palette for a white background)
    ("drinks", "Drinks", "#D98FA3"),
    ("produce", "Fruits & Vegetables", "#7EA8BE"),
    ("seafood", "Seafood", "#86A98D"),
    ("meat", "Meat", "#C78368"),
    ("grains", "Grains & Noodles", "#D4B06A"),
    ("desserts", "Desserts", "#A99AC9"),
    ("other", "Other / Mixed", "#777777"),
]

# Apple Photos label -> (category, weight). Broad labels weigh less than specific dishes;
# garnish-like labels (lemon, herb) weigh very little.
APPLE = {
    "drinks": {"Drink": .6, "Coffee": 1, "Coffee Cup": 1, "Café Au Lait": 1, "Beer": 1, "Wine": .8,
               "Red Wine": .8, "Cocktail": 1, "Martini": 1, "Juice": 1, "Soda": .8, "Tea Drink": 1,
               "Wine Glass": .3, "Wine Bottle": .5},
    "produce": {"Fruit": .6, "Vegetable": .5, "Citrus Fruit": .4, "Lemon": .25, "Lime": .25,
                "Berry": .8, "Strawberry": .9, "Grape": .9, "Salad": 1, "Lettuce": .7,
                "Leaf Vegetable": .7, "Tomato": .5, "Produce": .8, "Herb": .15, "Oranges": .9,
                "Pineapple": .9, "Banana": .9, "Apple": .9, "Melon": .9, "Watermelon": .9,
                "Blueberry": .9, "Raspberry": .9, "Frutti Di Bosco": .9, "Asparagus": .7,
                "Green Beans": .7, "Cucumber": .5, "Corn": .5, "Potato": .4, "Carrot": .5,
                "Arugula": .6, "Barbary Fig": .9},
    "seafood": {"Seafood": .8, "Shellfish": .8, "Shellfish Prepared": 1, "Fish as Food": 1,
                "Sushi": 1, "Oyster": 1, "Clam": 1, "Mussel": 1, "Lobster": 1, "Crab": 1,
                "Salmon": 1, "Tuna": 1, "Roe": .8, "Tempura": .5, "Paella": .6, "Wasabi": .4},
    "meat": {"Meat": .8, "Steak": 1, "Sirloin Steak": 1, "Beef Tenderloin": 1, "Beef": 1,
             "Hamburger": .9, "Cheeseburger": .9, "Fried Chicken": 1, "Sausage": .9, "Salami": .8,
             "Ham": .8, "Pepperoni": .5, "Barbecue": .9, "Satay": .9, "Skewer": .6},
    "grains": {"Rice": .9, "Noodle": 1, "Noodle Soup": 1, "Ramen": 1, "Pasta": 1, "Spaghetti": 1,
               "Capellini": 1, "Pici": 1, "Carbonara": 1, "Bakmi": 1, "Dumpling": 1, "Wonton": 1,
               "Gyoza": 1, "Bread": .9, "Pizza": .9, "Sandwich": .7, "Breakfast Sandwich": .7,
               "Tortilla": .7, "Baked Goods": .4, "Curry": .4, "Grain": .6},
    "desserts": {"Dessert": 1, "Frozen Dessert": 1, "Ice Cream": 1, "Cake": 1, "Birthday Cake": 1,
                 "Pastry": .9, "Candy": .9, "Icing": .9, "Buttercream": .9, "Cake Decorating": .9,
                 "Baked Goods": .4, "Patisserie": .5, "Lollipop": .9},
}
# Apple Vision class id -> category (weight = Vision's own confidence for that class)
VISION = {
    "drinks": {"drink", "coffee", "beer", "wine", "red_wine", "white_wine", "sparkling_wine",
               "cocktail", "juice", "tea_drink", "bubble_tea"},
    "produce": {"fruit", "vegetable", "salad", "berry", "strawberry", "grape", "citrus_fruit",
                "tomato", "leaf_vegetable", "produce"},
    "seafood": {"seafood", "sushi", "shellfish", "shellfish_prepared", "oyster", "lobster", "crab",
                "clam", "mussel", "salmon", "sashimi"},
    "meat": {"meat", "steak", "hamburger", "meatball", "sausage", "barbecue", "fried_chicken"},
    "grains": {"rice", "pasta", "spaghetti", "noodle", "ramen", "bread", "white_bread", "pizza",
               "sandwich", "dumpling"},
    "desserts": {"dessert", "frozen_dessert", "ice_cream", "cake", "cake_regular", "birthday_cake",
                 "cheesecake", "cupcake", "candy", "pancake", "fruitcake", "wedding_cake"},
}
# Apple's on-device AI caption (already stored; matched locally, never printed).
# One match per category counts CAPTION_WEIGHT, regardless of how many words match.
CAPTION_WEIGHT = 0.8
CAPTION = {
    "drinks": r"coffee|latte|cappuccino|espresso|americano|mocha|tea\b|matcha|boba|bubble tea|"
              r"cocktail|beer|wine|champagne|juice|smoothie|lemonade|soda|milkshake|drink|beverage",
    "produce": r"salad|fruit|vegetable|berr(y|ies)|strawberr|grape|mango|apple|banana|orange|melon|"
               r"pineapple|avocado|broccoli|greens|lettuce|tomato|cucumber|peach|cherr(y|ies)",
    "seafood": r"seafood|fish|shrimp|prawn|oyster|clam|mussel|lobster|crab|salmon|tuna|sushi|"
               r"sashimi|scallop|squid|octopus|calamari|crawfish|crayfish|eel",
    "meat": r"steak|beef|pork|chicken|lamb|bacon|sausage|burger|ham\b|brisket|ribs|barbecue|bbq|"
            r"meatball|duck|turkey|kebab|skewer|meat",
    "grains": r"noodle|ramen|udon|pho\b|pasta|spaghetti|linguine|fettuccine|rice|risotto|fried rice|"
              r"dumpling|wonton|bun\b|buns\b|bread|toast|bagel|pizza|sandwich|taco|burrito|tortilla|"
              r"croissant|porridge|congee",
    "desserts": r"dessert|cake|ice cream|gelato|pastr(y|ies)|cookie|chocolate|donut|doughnut|"
                r"tart\b|pie\b|pudding|macaron|cupcake|sweet|waffle|pancake|cheesecake|tiramisu|crepe",
}
MEAL_LABELS = {"Meal", "Dish", "Lunch", "Dinner", "Supper", "Brunch", "Breakfast", "Fast Food"}

MIN_SCORE = 0.8          # dominant category needs at least this much evidence
MIN_RATIO = 1.6          # ...and must beat the runner-up by this factor
DRINK_WITH_MEAL_RATIO = 2.5  # a glass next to a meal should not make it "Drinks"


CAPTION_RX = {k: re.compile(r"\b(" + v + r")", re.I) for k, v in CAPTION.items()}


def categorize(rec: dict) -> dict:
    labels = set(rec.get("labels") or [])
    vtop = {i: c for i, c in (rec.get("vision_top") or [])}
    scores, evidence = Counter(), {}
    for cat, table in APPLE.items():
        for lab in labels & table.keys():
            scores[cat] += table[lab]
            evidence.setdefault(cat, []).append(f"apple:{lab}")
    for cat, ids in VISION.items():
        for vid in ids & vtop.keys():
            scores[cat] += vtop[vid]
            evidence.setdefault(cat, []).append(f"vision:{vid}")
    cap = (rec.get("caption") or "").lower()
    for cat, rx in CAPTION_RX.items():
        if cap and rx.search(cap):
            scores[cat] += CAPTION_WEIGHT
            evidence.setdefault(cat, []).append("caption_keyword")
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))  # tie-break by key: deterministic
    top, s1 = ranked[0] if ranked else ("other", 0.0)
    s2 = ranked[1][1] if len(ranked) > 1 else 0.0
    need = DRINK_WITH_MEAL_RATIO if (top == "drinks" and labels & MEAL_LABELS) else MIN_RATIO
    if s1 >= MIN_SCORE and (s2 == 0 or s1 / s2 >= need):
        cat, rule = top, "dominant"
    else:
        cat = "other"
        rule = "no_food_type_evidence" if s1 == 0 else ("weak_evidence" if s1 < MIN_SCORE else "mixed")
    return {"category": cat, "rule": rule,
            "scores": {k: round(v, 3) for k, v in ranked},
            "evidence": sorted(set(evidence.get(cat, []))) if cat != "other" else []}


def main():
    src = DATA_DIR / "food_photos.json"
    raw = src.read_bytes()
    photos = json.loads(raw)["photos"]
    excluded = load_excluded()
    photos = [p for p in photos if p["id"].upper() not in excluded]  # belt and braces

    colors = {k: c for k, _, c in CATEGORIES}
    names = {k: n for k, n, _ in CATEGORIES}
    assignments, counts, rules = {}, Counter(), Counter()
    for p in sorted(photos, key=lambda r: r["id"]):
        a = categorize(p)
        a["color"] = colors[a["category"]]
        assignments[p["id"]] = a
        counts[a["category"]] += 1
        rules[a["rule"]] += 1

    out = {
        "meta": {"version": VERSION, "source": "data/food_photos.json",
                 "source_sha1": hashlib.sha1(raw).hexdigest(), "count": len(assignments),
                 "min_score": MIN_SCORE, "min_ratio": MIN_RATIO,
                 "note": "scores are rule-based evidence sums, not model probabilities"},
        "categories": [{"key": k, "name": n, "color": c, "count": counts[k]} for k, n, c in CATEGORIES],
        "assignments": assignments,
    }
    (DATA_DIR / "food_categories.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))

    total = len(assignments)
    md = ["# FoodMaps — Food Category Summary\n",
          f"Classifier `{VERSION}` · {total:,} curated photos · deterministic rules in `scripts/categorize.py`\n",
          "| Category | Color | Photos | Share |", "|---|---|---:|---:|"]
    for k, n, c in CATEGORIES:
        md.append(f"| {n} | `{c}` | {counts[k]:,} | {100 * counts[k] / total:.1f}% |")
    md.append("\n**Why photos fell into Other / Mixed:** " + ", ".join(
        f"{r.replace('_', ' ')}: {rules[r]:,}" for r in ("mixed", "weak_evidence", "no_food_type_evidence")))
    md.append("\nA category is assigned only when its evidence (Apple label weights + Vision class "
              f"confidences + {CAPTION_WEIGHT} for an Apple caption keyword match) is "
              f"at least {MIN_SCORE} and at least {MIN_RATIO}× the runner-up "
              f"({DRINK_WITH_MEAL_RATIO}× for Drinks when meal labels are present).")
    OUTPUT_DIR.mkdir(exist_ok=True)
    (OUTPUT_DIR / "category_summary.md").write_text("\n".join(md) + "\n")

    log(f"categorized {total} photos ({VERSION})")
    for k, n, _ in CATEGORIES:
        log(f"  {n:22s} {counts[k]:5d}  {100 * counts[k] / total:5.1f}%")
    log("  other/mixed reasons:", dict(rules))


if __name__ == "__main__":
    main()
