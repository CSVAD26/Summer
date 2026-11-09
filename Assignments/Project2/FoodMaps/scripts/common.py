"""Shared helpers for the FoodMaps pipeline.

Privacy rules enforced here:
- The Photos Library is opened read-only through OSXPhotos (it works on a temp copy of the database).
- Console output is aggregate-only. Use `log()` for counts and `safe_err()` for exceptions:
  error messages are reduced to the exception type so no paths or filenames leak to the console.
"""

from __future__ import annotations

import logging
import os
import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
IMAGES_DIR = ROOT / "public" / "images"
OUTPUT_DIR = ROOT / "output"
CACHE_DIR = ROOT / ".cache"


def quiet() -> None:
    """Silence library logging/warnings, which can include file paths."""
    warnings.filterwarnings("ignore")
    logging.disable(logging.CRITICAL)


def log(*args) -> None:
    print(*args, flush=True)


def safe_err(e: BaseException) -> str:
    return type(e).__name__


def load_photosdb():
    """Open the system Photos Library read-only. Exits with a sanitized message on failure."""
    quiet()
    import osxphotos

    try:
        return osxphotos.PhotosDB()
    except Exception as e:  # noqa: BLE001
        log(f"ERROR: could not open Photos Library ({safe_err(e)}).")
        log("If this is a permissions error, grant Full Disk Access to the app running this script")
        log("(System Settings > Privacy & Security > Full Disk Access) and restart it.")
        sys.exit(2)


def all_images(db):
    """Still images, excluding hidden photos (respecting the user's choice to hide them).
    Trash is already excluded by OSXPhotos."""
    return [p for p in db.photos(images=True, movies=False) if not p.hidden]


def gps(p):
    """Return (lat, lon) or None. Never invents coordinates."""
    lat, lon = p.location if p.location else (None, None)
    if lat is None or lon is None:
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
        return None
    return float(lat), float(lon)


def _first(v):
    if isinstance(v, (list, tuple)):
        return v[0] if v else None
    return v or None


def place_info(p) -> dict:
    """City / country from Photos' own (local) reverse-geocoding. None when unavailable."""
    out = {"city": None, "country": None, "country_code": None}
    pl = p.place
    if not pl:
        return out
    try:
        addr = pl.address
        out["city"] = getattr(addr, "city", None) or None
        out["country"] = getattr(addr, "country", None) or None
    except Exception:  # noqa: BLE001
        pass
    try:
        names = pl.names
        out["city"] = out["city"] or _first(getattr(names, "city", None))
        out["country"] = out["country"] or _first(getattr(names, "country", None))
    except Exception:  # noqa: BLE001
        pass
    try:
        out["country_code"] = pl.country_code or None
    except Exception:  # noqa: BLE001
        pass
    return out


def best_local_derivative(p):
    """Largest locally stored preview JPEG, or None. Never triggers an iCloud download."""
    try:
        for d in p.path_derivatives or []:
            if d and os.path.exists(d):
                return d
    except Exception:  # noqa: BLE001
        pass
    return None
