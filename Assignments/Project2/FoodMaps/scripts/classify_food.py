"""Food-photo classification.

Stage A  - Apple Photos' existing scene labels + on-device AI caption (metadata only, fast).
Stage B  - Apple Vision VNClassifyImageRequest on the *local preview* (on-device, no cloud,
           no iCloud download). Used only for photos Stage A marks as ambiguous.

Both stages are plain functions so they can be swapped or extended later
(e.g. a Core ML / CLIP model as another Stage B backend).

CLI:  python scripts/classify_food.py --vision-check 150
      Runs Vision on random label-positive and label-negative photos and prints
      aggregate agreement statistics only.
"""

from __future__ import annotations

import argparse
import random
import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Stage A configuration. Label names come from the actual label vocabulary
# found in this library (see output/label_counts.tsv), not assumed.
# ---------------------------------------------------------------------------

# Labels meaning "a meal / prepared food is in the picture".
CORE_FOOD = {
    "Food", "Meal", "Dish", "Brunch", "Breakfast", "Lunch", "Dinner", "Supper",
    "Fast Food", "Snack", "Dessert", "Baked Goods", "Seafood", "Fried Food",
    "Culinary Art", "Hors D'Oeuvre", "Fish as Food", "Shellfish Prepared",
    "English Breakfast", "Frozen Dessert",
}
# Specific dishes / ingredients (still strong evidence).
SPECIFIC_FOOD = {
    "Sushi", "Ramen", "Noodle", "Noodle Soup", "Pasta", "Spaghetti", "Capellini", "Pici",
    "Carbonara", "Pizza", "Steak", "Sirloin Steak", "Beef Tenderloin", "Beef", "Soup",
    "Leek Soup", "Salad", "Sandwich", "Breakfast Sandwich", "Hamburger", "Cheeseburger",
    "Veggie Burger", "Dumpling", "Wonton", "Gyoza", "Cake", "Birthday Cake", "Pastry",
    "Bread", "Ice Cream", "Candy", "Rice", "Curry", "Stir Fry", "Tempura", "Paella",
    "Fries", "Fried Chicken", "Satay", "Skewer", "Barbecue", "Oyster", "Lobster", "Crab",
    "Mussel", "Clam", "Salmon", "Tuna", "Roe", "Bakmi", "Tortilla", "Egg", "Yolk", "Cheese",
    "Sausage", "Salami", "Ham", "Pepperoni", "Icing", "Buttercream", "Cake Decorating",
    "Wasabi", "Meat",
}
BEVERAGE = {
    "Drink", "Coffee", "Coffee Cup", "Café Au Lait", "Beer", "Wine", "Red Wine",
    "Cocktail", "Martini", "Juice", "Soda", "Tea Drink",
}
# Supporting context: tableware, dining venues.
CONTEXT = {
    "Tableware", "Plate", "Bowl", "Utensil", "Fork", "Spoon", "Chopsticks", "Cutlery",
    "Saucer", "Restaurant", "Condiment", "Seasonings", "Eating", "Drinking Glass",
    "Wine Glass", "Cake Stand", "Dining Room", "Mug", "Cup", "Bakery", "Patisserie",
    "Bar", "Cutting Board", "Steamer Cookware",
}
# Food-ish but often not "food as the main subject" (markets, orchards, aquariums...).
WEAK_FOOD = {
    "Fruit", "Vegetable", "Citrus Fruit", "Berry", "Produce", "Lemon", "Strawberry",
    "Tomato", "Grape", "Herb", "Lettuce", "Leaf Vegetable", "Fish", "Shellfish", "Cooking",
    "Pot Cooking", "Grill", "Pan", "Wok",
}
# Strong signs the subject is something else.
NEGATIVE = {
    "Document", "Printed Page", "Handwriting", "Receipt", "Menu", "Screen",
    "Computer Program", "Clip Art", "Cartoon", "Drawing", "Painting", "Anime", "Manga",
    "Comics", "Map", "Chart", "Supermarket", "Market", "Bazaar", "Marketplace",
    "Convenience Store", "Aquarium", "Underwater", "Fish Tank", "Coral Reef",
    "Recreational Fishing", "Big-Game Fishing", "Fishing", "Whiteboard", "Chalkboard",
    # kitchen appliances / rooms: food may be present but is not the subject
    "Appliance", "Small Appliance", "Refrigerator", "Oven", "Kitchen Oven", "Stove",
    "Gas Stove", "Microwave", "Dishwasher", "Kettle", "Kitchen Sink", "Kitchen Faucet",
    "Kitchen Room", "Kitchen Countertop",
}

FOODISH_LABELS = CORE_FOOD | SPECIFIC_FOOD | BEVERAGE | WEAK_FOOD

CAPTION_FOOD = re.compile(
    r"\b(food|meal|dish|plate of|bowl of|dessert|cake|pastr|bread|sushi|ramen|noodle|"
    r"pasta|pizza|burger|sandwich|salad|soup|steak|dumpling|rice|curry|breakfast|lunch|"
    r"dinner|brunch|coffee|latte|cappuccino|tea\b|cocktail|beer|wine|drink|juice|ice cream|"
    r"chocolate|fries|seafood|oyster|shrimp|taco|bbq|barbecue|snack|eggs?\b)",
    re.I,
)
CAPTION_PERSON_SUBJECT = re.compile(
    r"^\s*(a|an|the|two|three|four|several|group of)?\s*"
    r"(\w+\s)?(man|woman|men|women|person|people|girl|boy|child|children|kid|baby|couple|family|friends)\b",
    re.I,
)


@dataclass
class StageA:
    decision: str            # "food" | "ambiguous" | "not_food"
    score: float             # 0..1 heuristic confidence from Apple metadata
    food_labels: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)


def stage_a(labels: list[str], caption: str | None) -> StageA:
    labels = set(labels or [])
    core = labels & CORE_FOOD
    spec = labels & SPECIFIC_FOOD
    bev = labels & BEVERAGE
    ctx = labels & CONTEXT
    weak = labels & WEAK_FOOD
    neg = labels & NEGATIVE
    cap_food = bool(caption and CAPTION_FOOD.search(caption))
    cap_person = bool(caption and CAPTION_PERSON_SUBJECT.search(caption))
    people = "People" in labels or "Selfie" in labels

    food_labels = sorted(core | spec | bev | weak)
    s = 0.0
    s += 0.35 if core else 0.0
    s += min(0.25, 0.12 * len(spec))
    s += 0.20 if (bev and not core) else (0.05 if bev else 0.0)
    s += min(0.15, 0.05 * len(ctx))
    s += 0.05 if weak else 0.0
    s += 0.20 if cap_food else 0.0
    s -= 0.30 if neg else 0.0
    s -= 0.15 if people else 0.0
    s -= 0.15 if cap_person else 0.0
    s = max(0.0, min(1.0, s))

    reasons = []
    if neg:
        reasons.append("negative_label")
    if people or cap_person:
        reasons.append("people_present")

    if not (core or spec or bev or weak or cap_food):
        return StageA("not_food", 0.0, food_labels, reasons)
    strong = bool(core or spec or bev)
    if strong and (ctx or cap_food) and not neg and not (people and cap_person) and s >= 0.55:
        return StageA("food", s, food_labels, reasons)
    return StageA("ambiguous", s, food_labels, reasons)


# ---------------------------------------------------------------------------
# Stage B: Apple Vision (on-device)
# ---------------------------------------------------------------------------

VISION_FOOD_IDS = {
    "food", "dessert", "drink", "baked_goods", "beer", "birthday_cake", "bread",
    "bubble_tea", "cake", "cake_regular", "cheesecake", "cocktail", "coffee", "cupcake",
    "frozen_dessert", "fruitcake", "gingerbread", "hamburger", "juice", "meat", "meatball",
    "oatmeal", "pancake", "pasta", "pizza", "red_wine", "rice", "salad", "sandwich",
    "seafood", "soup", "sparkling_wine", "steak", "sushi", "tea_drink", "white_bread",
    "white_wine", "wine", "wedding_cake", "fruit", "citrus_fruit",
}
VISION_CONTEXT_IDS = {"tableware", "plate", "bowl", "utensil", "restaurant", "dining_room",
                      "drinking_glass", "straw_drinking", "teapot", "cakestand"}
VISION_PEOPLE_IDS = {"people", "adult", "child", "baby", "crowd", "selfie", "portrait"}
# Subject is a document/screen/appliance rather than food.
VISION_NEG_IDS = {"document", "screenshot", "receipt", "newspaper", "computer_monitor",
                  "appliance", "refrigerator", "oven", "kitchen_oven", "microwave", "stove",
                  "dishwasher", "toaster", "toaster_oven", "blender", "kettle", "kitchen_sink",
                  "kitchen_room"}


def vision_classify(image_path: str, top_k: int = 8) -> dict | None:
    """Run VNClassifyImageRequest locally. Returns None on failure (never raises)."""
    try:
        import Vision
        from Foundation import NSURL

        handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(
            NSURL.fileURLWithPath_(image_path), None
        )
        req = Vision.VNClassifyImageRequest.alloc().init()
        ok, _err = handler.performRequests_error_([req], None)
        if not ok:
            return None
        obs = [(o.identifier(), float(o.confidence())) for o in (req.results() or [])]
    except Exception:  # noqa: BLE001
        return None
    conf = dict(obs)
    food = max((conf.get(i, 0.0) for i in VISION_FOOD_IDS), default=0.0)
    ctx = max((conf.get(i, 0.0) for i in VISION_CONTEXT_IDS), default=0.0)
    ppl = max((conf.get(i, 0.0) for i in VISION_PEOPLE_IDS), default=0.0)
    neg = max((conf.get(i, 0.0) for i in VISION_NEG_IDS), default=0.0)
    top = sorted(((i, c) for i, c in obs if c >= 0.1), key=lambda x: -x[1])[:top_k]
    return {"food": round(food, 3), "context": round(ctx, 3), "people": round(ppl, 3), "negative": round(neg, 3),
            "top": [[i, round(c, 3)] for i, c in top]}


def stage_b_decision(v: dict | None) -> tuple[str, float]:
    """Decide from Vision scores. Calibrated on this library: Vision's fine food classes
    are often low-confidence even on clear food photos, while tableware/utensil context is
    a reliable companion signal. People strongly present => food probably not the subject."""
    if v is None:
        return "ambiguous", 0.0
    f, c, ppl = v["food"], v["context"], v["people"]
    score = max(0.0, min(1.0, f + 0.3 * c - 0.4 * max(0.0, ppl - 0.5)))
    if ppl >= 0.7 and f < 0.6:
        return "not_food", score
    if v.get("negative", 0.0) >= 0.5 and f < 0.7:
        return "not_food", score
    if f >= 0.5 or (f >= 0.25 and c >= 0.5):
        return "food", score
    if f < 0.15 and c < 0.3:
        return "not_food", score
    return "ambiguous", score


def classify(p, run_vision: bool = True, verify_food: bool = True) -> dict:
    """Two-stage decision for one PhotoInfo. Returns a dict with no file paths.

    decision: "food" | "review" | "not_food"
      - Stage A food + Vision agrees (or Vision not run)   -> food
      - Stage A food + Vision says not food                 -> review (flag vision_disagrees)
      - Stage A ambiguous -> Vision decides; Vision unsure  -> review
    """
    from common import best_local_derivative

    if getattr(p, "screenshot", False):
        return {"stage": "apple_labels", "decision": "not_food", "confidence": 0.0,
                "food_labels": [], "flags": ["screenshot"], "vision": None}
    a = stage_a(list(p.labels or []), p.ai_caption)
    res = {"stage": "apple_labels", "decision": a.decision, "confidence": round(a.score, 3),
           "food_labels": a.food_labels, "flags": list(a.reasons), "vision": None}
    if a.decision == "not_food":
        return res
    need_vision = run_vision and (a.decision == "ambiguous" or verify_food)
    if not need_vision:
        res["decision"] = "food" if a.decision == "food" else "review"
        return res
    d = best_local_derivative(p)
    v = vision_classify(d) if d else None
    if v is None:
        res["flags"].append("no_local_preview" if not d else "vision_error")
        res["decision"] = "food" if a.decision == "food" else "review"
        return res
    dec, sc = stage_b_decision(v)
    res["vision"] = v
    if a.decision == "food":
        res["confidence"] = round(0.6 * a.score + 0.4 * sc, 3)
        if dec == "not_food":
            res["decision"] = "review"
            res["flags"].append("vision_disagrees")
        else:
            res["decision"] = "food"
    else:
        res["stage"] = "vision"
        res["confidence"] = round(0.3 * a.score + 0.7 * sc, 3)
        res["decision"] = {"food": "food", "not_food": "not_food"}.get(dec, "review")
    return res


# ---------------------------------------------------------------------------
# CLI: reliability check of Apple labels against Vision (aggregate output only)
# ---------------------------------------------------------------------------

def main() -> None:
    import collections
    from common import all_images, best_local_derivative, load_photosdb, log

    ap = argparse.ArgumentParser()
    ap.add_argument("--vision-check", type=int, default=150,
                    help="photos per group to run Vision on")
    ap.add_argument("--seed", type=int, default=236)
    args = ap.parse_args()

    db = load_photosdb()
    photos = all_images(db)
    rng = random.Random(args.seed)
    groups = collections.defaultdict(list)
    for p in photos:
        if not p.labels:
            continue
        groups[stage_a(p.labels, p.ai_caption).decision].append(p)
    for name in ("food", "ambiguous", "not_food"):
        pool = groups[name]
        sample = rng.sample(pool, min(args.vision_check, len(pool)))
        c = collections.Counter()
        for p in sample:
            d = best_local_derivative(p)
            if not d:
                c["no_preview"] += 1
                continue
            v = vision_classify(d)
            if v is None:
                c["vision_error"] += 1
                continue
            c[stage_b_decision(v)[0]] += 1
        log(f"Stage A '{name}' (pool {len(pool)}), Vision on {len(sample)}: {dict(c)}")


if __name__ == "__main__":
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
