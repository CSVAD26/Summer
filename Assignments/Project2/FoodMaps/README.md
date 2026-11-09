# FOODMAPS — An Atlas of What I've Tasted

MAT 236 · Computational Systems for Visual Art and Design · Project 2: Data Portrait

## Project write-up

### Concept

FoodMaps is a data portrait built from a personal photo library: each photograph of food or drink becomes one coloured point on an interactive 3D globe, at the GPS position where it was taken. It is designed as a quiet geographic artwork rather than a tracking app: a white sphere, hairline coastlines, muted category colours, and the photograph as the focus when a point is selected. The current atlas contains **1,451 photographs** from **161 cities in 14 countries**, taken between 2017 and 2026.

### Data extraction

The source is an Apple Photos library of **70,348 images**. They were read with [OSXPhotos](https://github.com/RhetTbull/osxphotos), which accesses the Photos database read-only. Of the 70,177 non-hidden images, 42,597 carry GPS coordinates and 65,553 carry Apple's on-device scene labels (1,681 distinct labels). About 60,000 originals exist only in iCloud, so browser thumbnails (640 px JPEG, metadata stripped) are built from the local previews Photos keeps on disk; nothing is downloaded.

### Food classification

Classification has two stages:
- **Stage A** scores every photo from Apple's labels (Food, Dish, Sushi, Coffee…), the on-device AI caption, and negative labels (Document, Menu, Market, appliances): **4,574 candidates**.
- **Stage B** runs Apple Vision (`VNClassifyImageRequest`) locally on each candidate: 2,310 accepted, 1,606 rejected (including 318 screenshots), 658 uncertain sent to review instead of the globe.

Apple's labels catch almost all food but also flag photos where food is not the subject, so Vision serves as a second opinion, not ground truth.

### GPS filtering, deduplication and curation

Near-duplicates were grouped only within 90 minutes and 300 m, by exact fingerprint, perceptual hash or close Vision image embedding, with a safeguard against chaining different dishes together. 527 shots were merged; borderline pairs were kept and flagged. 288 food photos without GPS were set aside, since no coordinates are invented. In a local review gallery with copyable photo IDs, 44 photos were manually excluded from the dataset; the originals in Photos are untouched.

### Globe and colour mapping

Each photo gets one category from deterministic rules over Apple labels, Vision classes and caption keywords:

| Category | Photos | Colour |
|---|---:|---|
| Grains & Noodles | 228 | ochre |
| Drinks | 182 | dusty pink |
| Fruits & Vegetables | 154 | muted blue |
| Seafood | 135 | sage |
| Meat | 92 | terracotta |
| Desserts | 54 | lavender |
| Other / Mixed | 606 | charcoal |

Uncertain photos stay in Other / Mixed rather than being guessed. **Three.js** renders Natural Earth coastlines and borders (simplified from 80,617 to 24,544 points) as one-pixel WebGL lines; **p5.js** runs the frame loop and draws the data layer. Navigation is a "grab the Earth" trackball that reaches the poles without flipping. Zoom is intentionally disabled, so the globe is a fixed navigation surface.

### LOCAL VIEW and overlapping points

Clicking a point opens its photo and a 2D LOCAL VIEW centred on it, in an azimuthal-equidistant projection (true distances from the centre), showing photos within a great-circle radius.
- **Starting radius:** chosen from 50 / 20 / 10 / 5 / 2 mi by local density, so dense cities open closer in.
- **Separate markers:** every photo stays individually selectable. Small stacks fan into tiny rings, dense spots become count markers that expand on click, and other overlaps get minimal displacement with hairline leader lines.
- **Local geography:** USGS 1:1M water and Census 1:500k boundaries in the US; Natural Earth 1:10m elsewhere.

### North-up alignment

Pressing **Space** rolls the globe around the viewing axis (about 750 ms, eased) so north points up while the centred place stays fixed. Centred on a pole, where north is undefined, nothing happens.

### Culinary Collage mode

A second display mode turns the photographs into the surface of the Earth:
- **Regions:** US states (Census 1:500k), Chinese province-level divisions and other countries (Natural Earth 1:10m), assigned by point-in-polygon: 1,442 of 1,451 photos across **44 regions**; 9 offshore points stay markers only.
- **Mosaics:** 8–20 varied photos per region (fixed seed), composed in a local projection so photos keep their proportions, then resampled into one 8192×4096 equirectangular texture strictly inside each region's polygon.
- **Display:** a latitude/longitude sphere with exact UVs (no seam at ±180°); empty regions stay white and markers stay on top.

Switching modes preserves rotation, selection and local view; Minimal mode renders pixel-identically to before.

### Design principles, challenges and outcomes

The guiding principles were geographic honesty, restraint and one photograph per point. Key problems and their solutions:

| Challenge | Solution |
|---|---|
| Lines crossing the 180° meridian were drawn around the globe | Take the short way across the meridian |
| A city-wide spiral layout hid the geography in dense views | Adaptive radius plus count markers |
| Natural Earth state lines put downtown St. Louis in Illinois | Census state boundaries |
| A plain latitude/longitude texture squashes photos at high latitudes | Compose each mosaic in a local projection |

Automated browser tests confirmed 61 fps rendering, correct far-side hiding, every local marker selecting its own photo, all 1,442 collage photos inside their own region with no texture outside boundaries, and full agreement between polygon-based and Apple-recorded countries.

### Privacy and limitations

All processing runs locally; no photograph, coordinate or metadata was sent to any external service, and geographic data came only from whole-world or whole-country public files. **The private photographs, the personal GPS dataset (`data/`), the thumbnails (`public/images/`), the generated collage texture (`public/collage/`) and the review outputs (`output/`) are intentionally excluded from GitHub** by `.gitignore`. The repository contains only code and public geographic data; the app is designed to run locally, since a public deployment would expose thumbnails and coordinates.

Limitations:
- **Classification** depends on Apple's labels and Vision and is imperfect; the 658 uncertain photos were not reviewed exhaustively, and 41.8% of photos are Other / Mixed.
- **Missing GPS:** photos without coordinates are absent from the globe.
- **Local map detail:** coarser outside the US; at 2 miles, river and coast lines can be off by about half a mile.
- **Small regions:** since the globe does not zoom, collages for places like Washington DC cover only a few pixels.

---

## Technical reference

**Run locally**

```bash
./serve.sh                        # http://127.0.0.1:8236/public/  (localhost only)
```
- Drag to rotate the globe; click a dot for its photo and LOCAL VIEW.
- In LOCAL VIEW, **− / +** change the radius.
- **Space** turns north up; **Esc** closes panels.
- The top-right toggle switches between MINIMAL and CULINARY COLLAGE.
- `public/?demo` shows a synthetic demo dataset that is safe for screenshots (`scripts/make_demo.py`).

**Setup**

```bash
brew install uv
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```
The terminal or editor that runs the extraction needs macOS Full Disk Access to read the Photos library.

**Pipeline** (`scripts/`)

| Step | Command |
|---|---|
| Library statistics | `inspect_library.py` → `output/library_analysis.md` |
| Extract, classify, deduplicate, thumbnails | `extract_food.py --limit 0` |
| Manual exclusions (`data/excluded_ids.txt`) | `exclusions.py` (also applied by `extract_food.py`) |
| Review gallery | `build_review.py` → `output/review.html` |
| Food categories | `categorize.py` → `data/food_categories.json` |
| Globe outlines (Natural Earth 1:50m, tracked) | `build_geo.py <countries-50m.json>` |
| LOCAL VIEW tiles (git-ignored, ~79 MB) | `build_local_tiles.py <natural_earth_dir> <us_dir>` |
| Collage atlas (git-ignored) | `build_collage.py <dir>` (`--demo` for the demo atlas) |

Front end: `public/index.html`, `public/style.css`, `public/js/main.js` (globe, navigation, panels), `public/js/localview.js` (LOCAL VIEW), `public/js/collage.js` (collage sphere). Libraries are stored in `public/lib/` (three 0.160.0, p5 1.9.4).

**Public data sources:** Natural Earth (1:50m, 1:10m), USGS 1:1,000,000 hydrography, US Census 2023 cartographic boundaries (1:500k).
