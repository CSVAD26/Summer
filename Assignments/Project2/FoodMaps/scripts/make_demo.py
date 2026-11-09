"""Generate a synthetic demo dataset (public city coordinates + placeholder images).

  python scripts/make_demo.py      # -> public/demo/   open  /public/?demo

Used to test and screenshot the globe without exposing any personal photo or location.
Includes edge cases: high latitudes, antimeridian, several photos at one spot,
a missing city name, a missing thumbnail and a broken thumbnail path.
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "demo"

CITIES = [  # name, country, lat, lon, photos   (public coordinates)
    ("Paris", "France", 48.8566, 2.3522, 4),
    ("Tokyo", "Japan", 35.6762, 139.6503, 6),
    ("New York", "United States", 40.7128, -74.0060, 3),
    ("Sydney", "Australia", -33.8688, 151.2093, 2),
    ("Cape Town", "South Africa", -33.9249, 18.4241, 2),
    ("Reykjavik", "Iceland", 64.1466, -21.9426, 1),
    ("Buenos Aires", "Argentina", -34.6037, -58.3816, 2),
    ("Singapore", "Singapore", 1.3521, 103.8198, 3),
    ("Cairo", "Egypt", 30.0444, 31.2357, 1),
    ("Anchorage", "United States", 61.2181, -149.9003, 1),
    ("Ushuaia", "Argentina", -54.8019, -68.3030, 1),
    ("Honolulu", "United States", 21.3069, -157.8583, 1),
    ("Longyearbyen", "Norway", 78.2232, 15.6267, 1),
    ("Suva", "Fiji", -18.1248, 178.4501, 1),
    ("Mumbai", "India", 19.0760, 72.8777, 2),
    ("Mexico City", "Mexico", 19.4326, -99.1332, 2),
    ("Lima", "Peru", -12.0464, -77.0428, 1),
    ("Helsinki", "Finland", 60.1699, 24.9384, 1),
]
CATS = [("drinks", "Drinks", "#D98FA3"), ("produce", "Fruits & Vegetables", "#7EA8BE"),
        ("seafood", "Seafood", "#86A98D"), ("meat", "Meat", "#C78368"),
        ("grains", "Grains & Noodles", "#D4B06A"), ("desserts", "Desserts", "#A99AC9"),
        ("other", "Other / Mixed", "#777777")]


def main():
    (OUT / "images").mkdir(parents=True, exist_ok=True)
    photos, assign = [], {}
    k = 0
    for ci, (city, country, lat, lon, n) in enumerate(CITIES):
        for j in range(n):
            key, name, color = CATS[k % len(CATS)]
            pid = f"DEMO-{k:04d}"
            thumb = f"images/{pid}.jpg"
            im = Image.new("RGB", (480, 360), color)
            d = ImageDraw.Draw(im)
            d.text((24, 24), f"DEMO {k}\n{city}\n{name}", fill="white")
            im.save(OUT / thumb, "JPEG", quality=80)
            rec = {"id": pid, "date": f"2024-{(k % 12) + 1:02d}-{(k % 27) + 1:02d}T12:00:00",
                   "lat": lat, "lon": lon, "city": city, "country": country, "thumb": thumb}
            if city == "Reykjavik":
                rec["city"] = None                      # missing city name
            if city == "Cairo":
                rec["thumb"] = None                     # missing thumbnail
            if city == "Lima":
                rec["thumb"] = "images/does-not-exist.jpg"  # broken path
            photos.append(rec)
            assign[pid] = {"category": key, "color": color}
            k += 1
    # Dense synthetic clusters around public city centres (stress test for the local view)
    import math, random
    rnd = random.Random(42)
    def add(city, country, lat, lon):
        nonlocal k
        key, name, color = CATS[k % len(CATS)]
        pid = f"DEMO-{k:04d}"
        thumb = f"images/{pid}.jpg"
        im = Image.new("RGB", (480, 360), color)
        ImageDraw.Draw(im).text((24, 24), f"DEMO {k}\n{city}\n{name}", fill="white")
        im.save(OUT / thumb, "JPEG", quality=80)
        photos.append({"id": pid, "date": f"2025-{(k % 12) + 1:02d}-{(k % 27) + 1:02d}T19:00:00",
                       "lat": round(lat, 6), "lon": round(lon, 6), "city": city, "country": country, "thumb": thumb})
        assign[pid] = {"category": key, "color": color}
        k += 1
    def around(lat, lon, miles):
        r = miles * math.sqrt(rnd.random()); a = rnd.random() * 2 * math.pi
        return lat + r * math.cos(a) / 69.0, lon + r * math.sin(a) / (69.0 * math.cos(math.radians(lat)))
    stl = (38.6270, -90.1994)
    for _ in range(160): add("St. Louis", "United States", *stl)             # identical coords
    for _ in range(25): add("St. Louis", "United States", stl[0] + 0.0004, stl[1] + 0.0003)  # ~50 m away
    for _ in range(60): add("St. Louis", "United States", *around(*stl, 15))
    for _ in range(20): add("St. Louis", "United States", *around(*stl, 1.5))
    la = (34.0522, -118.2437)
    spots = [around(*la, 30) for _ in range(8)]
    for s_ in spots:
        for _ in range(12): add("Los Angeles", "United States", *s_)
    for _ in range(60): add("Los Angeles", "United States", *around(*la, 45))

    # Realistic city structure: many restaurant-like spots, each with several photos and
    # a few metres of GPS jitter (public city-centre coordinates, synthetic offsets).
    def city(name, lat, lon, spots, per, spread_mi):
        for s_ in range(spots):
            slat, slon = around(lat, lon, spread_mi)
            for _ in range(rnd.randint(1, per)):
                j = 0.00015  # ~15 m jitter
                add(name, "United States", slat + rnd.uniform(-j, j), slon + rnd.uniform(-j, j))
    city("Arcadia", 34.1397, -118.0353, 45, 9, 3)
    city("University City", 38.6559, -90.3093, 30, 8, 2)
    for _ in range(14):  # sparse rural area
        add("Marshall", "United States", *around(38.1977, -122.8936, 25))

    (OUT / "food_photos.json").write_text(json.dumps({"meta": {"demo": True}, "photos": photos}, indent=1))
    (OUT / "food_categories.json").write_text(json.dumps({
        "meta": {"demo": True},
        "categories": [{"key": a, "name": b, "color": c} for a, b, c in CATS],
        "assignments": assign}, indent=1))
    print(f"demo: {len(photos)} records at {len(CITIES)} public city locations")


if __name__ == "__main__":
    main()
