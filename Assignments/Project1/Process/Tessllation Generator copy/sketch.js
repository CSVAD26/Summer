// FREEHAND TO TESSELLATION
// Draw a closed silhouette (left panel), fit it to a square-rotation tile
// (middle panel), and repeat that tile across the plane (right panel).
//
// Two geometry systems, chosen before GENERATE:
//   SQUARE   (unchanged from Mini Assignment 3): only the TOP and LEFT edges
//            are editable; RIGHT and BOTTOM are computed by 90-degree rotations.
//   TRIANGLE: each edge's first half is editable; its second half is the first
//            half rotated 180 degrees about the edge midpoint.
// Either way every tile tessellates by construction.

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const PANELS = {
  draw: { x: 20, y: 36, w: 340, h: 400, label: "01 / DRAW" },
  tile: { x: 380, y: 36, w: 340, h: 400, label: "02 / GENERATED TILE" },
  tess: { x: 740, y: 36, w: 440, h: 400, label: "03 / TESSELLATION" },
};

// ---------------------------------------------------------------------------
// Tile state
// ---------------------------------------------------------------------------

const S = 150; // square size
// Corners are in tile-local coordinates (0..S). The middle panel and the
// tessellation place this local frame on screen with translate/rotate.
let topLeft, topRight, bottomRight, bottomLeft;

// Interior control points. Each is { t, d }:
//   t = fixed position along the edge (0..1), never changes after creation
//   d = perpendicular displacement in pixels (what dragging changes)
let topControlPoints = [];
let leftControlPoints = [];

let selected = null; // { edge: "top" | "left" | 0..2 (triangle edge), pt: controlPoint }
let dragging = false;

let hasTile = false;   // true once GENERATE succeeded
let ghostContour = []; // normalized freehand outline, in tile-local coords
let viewAngle = 0;     // rotation that shows the tile in the drawing's orientation

let geometryMode = "square";   // selected by the TRIANGLE / SQUARE buttons
let activeTileType = "square"; // geometry of the tile currently shown

// Freehand state: one closed outline, stored in canvas coordinates.
let freehandPoints = [];
let isDrawingStroke = false;

const PINK = "#e8457a";
const BLUE = "#3d6ee8";
const GRAY = "#bbbbbb";
const TILE_FILL = "#ecebe7";

const PALETTES = [
  ["#111111", "#555555", "#3f4ee8", "#ffffff"], // black / gray / blue / white
  ["#111111", "#ffffff", "#e23b3b", "#f4a7c3"], // black / white / red / pink
  ["#1c2541", "#f2e8cf", "#e8772e", "#7a4a2b"], // navy / cream / orange / brown
];
let palette = PALETTES[0];

const SAMPLES_PER_SEGMENT = 16;
const CLICK_DIST = 10;
const MAX_DISPLACEMENT = S * 0.45;
// Near a corner |d| may grow at most this fast, so the two edges that meet
// at a corner can never cross each other there.
const CORNER_SLOPE = 0.9;
const MIN_T_GAP = 0.03; // minimum spacing between control points on one edge

// Freehand processing / fitting parameters (kept small so GENERATE is instant).
const SIMPLIFY_EPS = 1.5;      // Ramer-Douglas-Peucker tolerance, in pixels
const CONTOUR_SAMPLES = 96;    // evenly spaced points on the normalized contour
const FIT_SAMPLES = 24;        // displacement readings per edge
const FIT_ANGLES = 24;         // orientations tried (every 15 degrees)
const FIT_OFFSETS = [-0.16, -0.08, 0, 0.08, 0.16]; // shifts tried, in units of S
const ROTATION_PENALTY = 0.02 * S; // tiny preference for the drawn orientation
const MIN_CP = 5, MAX_CP = 10; // control points per editable edge
const CP_TOLERANCE = 0.04 * S; // allowed gap between curve and measured profile

const TESS_SCALE = 0.5;

// Triangle system: an equilateral triangle with area S*S (same as the square
// tile, so the normalized drawing fits both), centred on (S/2, S/2).
const TRI_SIDE = S * Math.sqrt(4 / Math.sqrt(3));
const TRI_HALF = TRI_SIDE / 2;          // length of one editable half-edge
const TRI_MAX_DISPLACEMENT = 0.4 * TRI_HALF;
const TRI_CORNER_SLOPE = 0.5;           // < tan(30deg): edges at a 60deg corner can't cross
const TRI_FIT_SAMPLES = 16;             // displacement readings per half-edge
const TRI_MIN_CP = 3, TRI_MAX_CP = 6;   // control points per half-edge
const GREEN = "#1f9e74";
const TRI_COLORS = [BLUE, PINK, GREEN];
let triA, triB, triC;                   // fixed vertices, clockwise on screen
// Control points of each edge's editable half, { t, d } as for the square:
// t along vertex -> midpoint (0..1), d = outward perpendicular displacement.
let triControlPoints = [[], [], []];

function setup() {
  createCanvas(1200, 446).parent("canvas-holder");

  topLeft = createVector(0, 0);
  topRight = createVector(S, 0);
  bottomRight = createVector(S, S);
  bottomLeft = createVector(0, S);

  const h = (TRI_SIDE * Math.sqrt(3)) / 2;
  triA = createVector(S / 2, S / 2 - (2 * h) / 3);
  triB = createVector(S / 2 + TRI_HALF, S / 2 + h / 3);
  triC = createVector(S / 2 - TRI_HALF, S / 2 + h / 3);

  document.getElementById("clear-btn").onclick = clearAll;
  document.getElementById("generate-btn").onclick = generateTile;
  document.getElementById("refine-btn").onclick = refineTile;
  document.getElementById("tri-btn").onclick = () => selectGeometry("triangle");
  document.getElementById("sq-btn").onclick = () => selectGeometry("square");
  buildPaletteButtons();
  setStatus("Draw one closed outline in the left panel.");

  noLoop(); // the sketch only redraws when something changes
}

function draw() {
  background(255);
  drawPanelLabels();
  drawFreehandPanel();
  const b = !hasTile ? null : activeTileType === "triangle" ? buildTriangleBoundary() : buildTileBoundary();
  drawTilePanel(b);
  drawTessellationPanel(b);
  document.getElementById("refine-btn").disabled = !hasTile;
}

// Only changes what the next GENERATE builds; the current tile stays.
function selectGeometry(mode) {
  geometryMode = mode;
  document.getElementById("tri-btn").classList.toggle("active", mode === "triangle");
  document.getElementById("sq-btn").classList.toggle("active", mode === "square");
  if (hasTile && mode !== activeTileType) setStatus(`${mode.toUpperCase()} selected — click GENERATE to apply.`);
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

// ---------------------------------------------------------------------------
// Control point -> tile-local position
// ---------------------------------------------------------------------------

// TOP edge runs topLeft -> topRight; displacement is vertical.
function topPointPos(p) {
  return createVector(topLeft.x + p.t * S, topLeft.y + p.d);
}

// LEFT edge runs bottomLeft -> topLeft; displacement is horizontal.
function leftPointPos(p) {
  return createVector(bottomLeft.x + p.d, bottomLeft.y - p.t * S);
}

// ---------------------------------------------------------------------------
// Smooth curves (Catmull-Rom via p5's curvePoint)
// ---------------------------------------------------------------------------

// Samples a Catmull-Rom spline through the given points (endpoints included).
// The first and last points are repeated as phantom points so the curve
// starts and ends exactly at the fixed corners.
function sampleCurve(pts) {
  const all = [pts[0], ...pts, pts[pts.length - 1]];
  const out = [];
  for (let i = 1; i < all.length - 2; i++) {
    const a = all[i - 1], b = all[i], c = all[i + 1], d = all[i + 2];
    for (let s = 0; s < SAMPLES_PER_SEGMENT; s++) {
      const t = s / SAMPLES_PER_SEGMENT;
      out.push(createVector(
        curvePoint(a.x, b.x, c.x, d.x, t),
        curvePoint(a.y, b.y, c.y, d.y, t)
      ));
    }
  }
  out.push(pts[pts.length - 1].copy());
  return out;
}

// Top curve: topLeft -> topRight
function getTopCurvePoints() {
  return sampleCurve([topLeft, ...topControlPoints.map(topPointPos), topRight]);
}

// Left curve: bottomLeft -> topLeft
function getLeftCurvePoints() {
  return sampleCurve([bottomLeft, ...leftControlPoints.map(leftPointPos), topLeft]);
}

// ---------------------------------------------------------------------------
// Derived edges (the geometric constraint)
// ---------------------------------------------------------------------------

// Standard rotation formula. In screen coords (+Y down) a positive angle
// turns visually clockwise.
function rotatePointAroundPivot(p, pivot, angle) {
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  const c = cos(angle), s = sin(angle);
  return createVector(pivot.x + dx * c - dy * s, pivot.y + dx * s + dy * c);
}

// Bottom: the left curve rotated 90 degrees about bottomLeft.
// Its "up" direction (bottomLeft -> topLeft) becomes "right"
// (bottomLeft -> bottomRight). Result runs bottomLeft -> bottomRight.
function getBottomCurvePoints() {
  return getLeftCurvePoints().map(p => rotatePointAroundPivot(p, bottomLeft, HALF_PI));
}

// Right: the top curve rotated 90 degrees the other way about topRight.
// topLeft lands on bottomRight, so the rotated curve runs bottomRight -> topRight;
// reverse it so it runs topRight -> bottomRight.
function getRightCurvePoints() {
  return getTopCurvePoints().map(p => rotatePointAroundPivot(p, topRight, -HALF_PI)).reverse();
}

// Closed boundary, clockwise on screen: top, right, bottom (reversed), left.
function buildTileBoundary() {
  return {
    top: getTopCurvePoints(),                 // topLeft -> topRight
    right: getRightCurvePoints(),             // topRight -> bottomRight
    bottom: getBottomCurvePoints().reverse(), // bottomRight -> bottomLeft
    left: getLeftCurvePoints(),               // bottomLeft -> topLeft
  };
}

function drawPolyline(pts) {
  beginShape();
  noFill();
  for (const p of pts) vertex(p.x, p.y);
  endShape();
}

function drawTileFill(b, fillColor) {
  fill(fillColor);
  beginShape();
  for (const edge of [b.top, b.right, b.bottom, b.left]) {
    for (const p of edge) vertex(p.x, p.y);
  }
  endShape(CLOSE);
}

// ---------------------------------------------------------------------------
// Geometric safety
// ---------------------------------------------------------------------------

// Caps a displacement: never more than MAX_DISPLACEMENT, and tapering to 0
// toward the fixed corners. Also turns NaN into 0.
function limitDisplacement(t, d) {
  if (!isFinite(d)) return 0;
  const cap = min(MAX_DISPLACEMENT, CORNER_SLOPE * S * min(t, 1 - t));
  return constrain(d, -cap, cap);
}

function flattenBoundary(b) {
  return [...b.top, ...b.right, ...b.bottom, ...b.left];
}

// A tile is valid when its closed boundary has finite coordinates and does
// not cross itself (a self-crossing tile would overlap its neighbours).
function tileIsValid() {
  if (activeTileType === "triangle") return triangleIsValid();
  const poly = flattenBoundary(buildTileBoundary());
  return poly.every(p => isFinite(p.x) && isFinite(p.y)) && !polygonSelfIntersects(poly);
}

function polygonSelfIntersects(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // these two segments share a vertex
      if (segmentsCross(a, b, poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

// True only for a proper crossing; shared endpoints and touching don't count.
function segmentsCross(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d);
  const o3 = orient(c, d, a), o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function orient(a, b, c) {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return abs(v) < 1e-9 ? 0 : Math.sign(v);
}

// Scales all displacements down until the tile is valid. Gives up (returns
// false) rather than flattening the drawing into a plain square.
function makeTileValid() {
  for (let i = 0; i < 7; i++) {
    if (tileIsValid()) return true;
    for (const p of [...topControlPoints, ...leftControlPoints]) p.d *= 0.9;
  }
  return tileIsValid();
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function insidePanel(p, x, y) {
  return x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h;
}

function clipToPanel(p) {
  drawingContext.save();
  drawingContext.beginPath();
  drawingContext.rect(p.x, p.y, p.w, p.h);
  drawingContext.clip();
}

function drawFrame(p) {
  noFill();
  stroke(0);
  strokeWeight(1);
  rect(p.x, p.y, p.w, p.h);
}

function drawPanelLabels() {
  noStroke();
  fill(0);
  textFont("Helvetica");
  textSize(11);
  textStyle(BOLD);
  for (const p of Object.values(PANELS)) text(p.label, p.x, p.y - 10);
}

function drawEmptyNote(p, msg) {
  noStroke();
  fill(170);
  textSize(11);
  textStyle(NORMAL);
  textAlign(CENTER, CENTER);
  text(msg, p.x + p.w / 2, p.y + p.h / 2);
  textAlign(LEFT, BASELINE);
}

// ---------------------------------------------------------------------------
// 01 / DRAW: freehand capture
// ---------------------------------------------------------------------------

function drawFreehandPanel() {
  const p = PANELS.draw;
  if (freehandPoints.length > 1) {
    noFill();
    stroke(0);
    strokeWeight(2);
    beginShape();
    for (const q of freehandPoints) vertex(q.x, q.y);
    if (isDrawingStroke) endShape();
    else endShape(CLOSE); // the outline is closed automatically
  } else {
    drawEmptyNote(p, "draw one closed outline");
  }
  drawFrame(p);
}

// Starting a new stroke replaces the old drawing and its tile.
function startStroke() {
  freehandPoints = [{ x: mouseX, y: mouseY }];
  isDrawingStroke = true;
  clearTile();
  setStatus("Drawing…");
}

// Records the cursor, skipping points closer than 2px to the previous one.
function extendStroke() {
  const p = PANELS.draw;
  const x = constrain(mouseX, p.x, p.x + p.w);
  const y = constrain(mouseY, p.y, p.y + p.h);
  const last = freehandPoints[freehandPoints.length - 1];
  if (dist(x, y, last.x, last.y) >= 2) freehandPoints.push({ x, y });
}

function finishStroke() {
  isDrawingStroke = false;
  if (!isValidStroke(freehandPoints)) {
    freehandPoints = [];
    setStatus("Outline too small — please draw a larger closed shape.");
    return;
  }
  setStatus("Outline closed. Click GENERATE.");
}

// STEP A: reject strokes that are too short or enclose almost no area.
function isValidStroke(pts) {
  if (pts.length < 10) return false;
  let perimeter = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    perimeter += dist(a.x, a.y, b.x, b.y);
  }
  return perimeter >= 120 && abs(polygonArea(pts)) >= 1500;
}

// ---------------------------------------------------------------------------
// Contour processing: simplify -> resample -> normalize
// ---------------------------------------------------------------------------

// STEP B: Ramer-Douglas-Peucker on a closed loop. The loop is split at its
// first point and the point farthest from it, and each half is simplified.
// A small tolerance only removes hand jitter; major bends survive.
function simplifyClosed(pts, eps) {
  let far = 0;
  for (let i = 1; i < pts.length; i++) {
    if (dist(pts[i].x, pts[i].y, pts[0].x, pts[0].y) >
        dist(pts[far].x, pts[far].y, pts[0].x, pts[0].y)) far = i;
  }
  const a = rdp(pts.slice(0, far + 1), eps);
  const b = rdp([...pts.slice(far), pts[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1];
  let maxD = -1, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), eps);
  return [...left.slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : constrain(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return dist(p.x, p.y, a.x + t * dx, a.y + t * dy);
}

// Evenly spaced points along the closed outline (so every part of the
// silhouette counts equally when shapes are compared).
function resampleClosed(pts, n) {
  const loop = [...pts, pts[0]];
  let total = 0;
  for (let i = 1; i < loop.length; i++) total += dist(loop[i - 1].x, loop[i - 1].y, loop[i].x, loop[i].y);
  const step = total / n;
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let need = step;
  for (let i = 1; i < loop.length && out.length < n; i++) {
    let a = loop[i - 1];
    const b = loop[i];
    let seg = dist(a.x, a.y, b.x, b.y);
    while (seg >= need && out.length < n) {
      const s = need / seg;
      a = { x: a.x + s * (b.x - a.x), y: a.y + s * (b.y - a.y) };
      out.push(a);
      seg = dist(a.x, a.y, b.x, b.y);
      need = step;
    }
    need -= seg;
  }
  return out;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function polygonCentroid(pts) {
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  const a6 = 6 * polygonArea(pts);
  return { x: cx / a6, y: cy / a6 };
}

// STEP C: center the contour on its centroid and scale it uniformly
// (aspect ratio preserved) so it encloses S*S. Every valid tile of this
// system has exactly area S*S, so equal areas make the comparison fair.
function normalizeContour(pts) {
  const c = polygonCentroid(pts);
  const k = S / sqrt(abs(polygonArea(pts)));
  return pts.map(p => ({ x: (p.x - c.x) * k, y: (p.y - c.y) * k }));
}

// ---------------------------------------------------------------------------
// STEP D: contour fitting
// ---------------------------------------------------------------------------
//
// In tile-local coordinates the four edges are
//   TOP    (tS, f(t))         LEFT   (g(t), S - tS)
//   RIGHT  (S + f(t), (1-t)S) BOTTOM (tS, S + g(t))
// so TOP and RIGHT share one displacement profile f, and LEFT and BOTTOM
// share g. For each candidate placement of the drawing over the square we
// read f and g off the drawing (both edges vote, we average), build the
// resulting tile, and keep the placement whose tile is closest to the
// drawing (Chamfer distance).

function generateTile() {
  if (freehandPoints.length === 0) {
    setStatus("Draw an outline first.");
    return;
  }
  try {
    const simplified = simplifyClosed(freehandPoints, SIMPLIFY_EPS);
    const contour = normalizeContour(resampleClosed(simplified, CONTOUR_SAMPLES));
    activeTileType = geometryMode;
    if (geometryMode === "triangle") {
      const fit = fitTriangleTile(contour);
      if (fit && applyTriangleFit(fit)) {
        setStatus(`Triangle tile generated: ${triControlPoints.map(l => l.length).join(" + ")} control points.`);
      } else {
        clearTile();
        setStatus("Could not fit this outline — please redraw a simpler shape.");
      }
      redraw();
      return;
    }
    const fit = fitTile(contour);
    if (fit && applyFit(fit)) {
      setStatus(`Tile generated: ${topControlPoints.length} top + ${leftControlPoints.length} left control points.`);
    } else {
      clearTile();
      setStatus("Could not fit this outline — please redraw a simpler shape.");
    }
  } catch (err) {
    console.warn("Fitting failed:", err);
    clearTile();
    setStatus("Could not fit this outline — please redraw.");
  }
  redraw();
}

function fitTile(contour) {
  let best = null;
  for (let a = 0; a < FIT_ANGLES; a++) {
    const angle = (a * TWO_PI) / FIT_ANGLES;
    for (const ox of FIT_OFFSETS) {
      for (const oy of FIT_OFFSETS) {
        const target = placeContour(contour, angle, ox * S, oy * S);
        const cand = measureProfiles(target);
        const turn = min(angle, TWO_PI - angle) / PI;
        const score = chamfer(coarseBoundary(cand.top, cand.left), target) + ROTATION_PENALTY * turn;
        if (isFinite(score) && (!best || score < best.score)) {
          best = { score, angle, target, top: cand.top, left: cand.left };
        }
      }
    }
  }
  return best;
}

// Rotates the normalized contour and moves it over the square [0, S]^2.
function placeContour(contour, angle, ox, oy) {
  const c = cos(angle), s = sin(angle);
  return contour.map(p => ({
    x: p.x * c - p.y * s + S / 2 + ox,
    y: p.x * s + p.y * c + S / 2 + oy,
  }));
}

// Reads the displacement profiles f (TOP/RIGHT) and g (LEFT/BOTTOM) at
// FIT_SAMPLES interior positions t along the edges.
function measureProfiles(target) {
  let top = [], left = [];
  for (let i = 1; i <= FIT_SAMPLES; i++) {
    const t = i / (FIT_SAMPLES + 1);
    const vertical = crossings(target, "x", t * S);         // line through TOP and BOTTOM
    const horizontal = crossings(target, "y", (1 - t) * S); // line through LEFT and RIGHT
    const fTop = nearestTo(vertical, 0);
    const fRight = nearestTo(horizontal, S);
    const gLeft = nearestTo(horizontal, 0);
    const gBottom = nearestTo(vertical, S);
    top.push(average([fTop, fRight === null ? null : fRight - S]));
    left.push(average([gLeft, gBottom === null ? null : gBottom - S]));
  }
  top = fillGaps(top);
  left = fillGaps(left);
  let k = 1;
  // Shrink the profiles until the coarse tile no longer crosses itself.
  for (let i = 0; i < 8; i++) {
    const tp = clampProfile(top, k), lp = clampProfile(left, k);
    if (!polygonSelfIntersects(coarseBoundary(tp, lp))) return { top: tp, left: lp };
    k *= 0.85;
  }
  return { top: clampProfile(top, k), left: clampProfile(left, k) };
}

// The other coordinate of every point where the closed contour crosses
// the line axis = value.
function crossings(poly, axis, value) {
  const other = axis === "x" ? "y" : "x";
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[axis] <= value) !== (b[axis] <= value)) {
      const s = (value - a[axis]) / (b[axis] - a[axis]);
      out.push(a[other] + s * (b[other] - a[other]));
    }
  }
  return out;
}

function nearestTo(list, ref) {
  let best = null;
  for (const v of list) if (best === null || abs(v - ref) < abs(best - ref)) best = v;
  return best;
}

function average(vals) {
  const ok = vals.filter(v => v !== null);
  return ok.length ? ok.reduce((s, v) => s + v, 0) / ok.length : null;
}

// Missing readings (the line missed the contour) are interpolated from
// their neighbours; the corners count as displacement 0.
function fillGaps(vals) {
  const ext = [0, ...vals, 0];
  for (let i = 1; i < ext.length - 1; i++) {
    if (ext[i] !== null) continue;
    let j = i;
    while (ext[j] === null) j++;
    const a = ext[i - 1], b = ext[j];
    for (let k = i; k < j; k++) ext[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  }
  return ext.slice(1, -1);
}

function clampProfile(vals, k) {
  return vals.map((v, i) => limitDisplacement((i + 1) / (FIT_SAMPLES + 1), v * k));
}

// Tile outline as a polygon, built directly from the sampled profiles
// (cheap stand-in for the smooth tile, used only while scoring candidates).
function coarseBoundary(f, g) {
  const n = f.length;
  const t = i => (i + 1) / (n + 1);
  const pts = [{ x: 0, y: 0 }];
  for (let i = 0; i < n; i++) pts.push({ x: t(i) * S, y: f[i] });                    // top
  pts.push({ x: S, y: 0 });
  for (let i = n - 1; i >= 0; i--) pts.push({ x: S + f[i], y: (1 - t(i)) * S });     // right
  pts.push({ x: S, y: S });
  for (let i = n - 1; i >= 0; i--) pts.push({ x: t(i) * S, y: S + g[i] });           // bottom
  pts.push({ x: 0, y: S });
  for (let i = 0; i < n; i++) pts.push({ x: g[i], y: (1 - t(i)) * S });              // left
  return pts;
}

// Bidirectional sampled Chamfer distance: the average distance from each
// point of A to the nearest point of B, and vice versa.
function chamfer(A, B) {
  const oneWay = (P, Q) => {
    let sum = 0;
    for (const p of P) {
      let best = Infinity;
      for (const q of Q) best = min(best, (p.x - q.x) ** 2 + (p.y - q.y) ** 2);
      sum += sqrt(best);
    }
    return sum / P.length;
  };
  return (oneWay(A, B) + oneWay(B, A)) / 2;
}

// Turns the winning profiles into editable control points.
function applyFit(fit) {
  topControlPoints = chooseControlPoints(fit.top);
  leftControlPoints = chooseControlPoints(fit.left);
  selected = null;
  if (!makeTileValid()) return false;
  ghostContour = fit.target;
  viewAngle = -fit.angle; // show the tile turned back to the drawing's orientation
  hasTile = true;
  return true;
}

// Picks the fewest evenly spaced control points (MIN_CP..MAX_CP) whose
// Catmull-Rom curve stays within CP_TOLERANCE of the measured profile.
function chooseControlPoints(vals, limit = limitDisplacement, minCp = MIN_CP, maxCp = MAX_CP) {
  let pts = [];
  for (let m = minCp; m <= maxCp; m++) {
    pts = [];
    for (let j = 1; j <= m; j++) {
      const t = j / (m + 1);
      pts.push({ t, d: limit(t, sampleProfile(vals, t)) });
    }
    if (profileError(pts, vals) < CP_TOLERANCE) break;
  }
  return pts;
}

// Linear interpolation of a profile at t (0 at both corners).
function sampleProfile(vals, t) {
  const ext = [0, ...vals, 0];
  const u = t * (ext.length - 1);
  const i = min(floor(u), ext.length - 2);
  return lerp(ext[i], ext[i + 1], u - i);
}

// Largest gap between the profile and the 1D Catmull-Rom curve through the
// control points. With evenly spaced t this matches what sampleCurve draws.
function profileError(pts, vals) {
  const d = [0, 0, ...pts.map(p => p.d), 0, 0]; // corners + phantom points
  const segs = pts.length + 1;
  let worst = 0;
  vals.forEach((v, i) => {
    const u = ((i + 1) / (vals.length + 1)) * segs;
    const k = min(floor(u), segs - 1);
    const y = curvePoint(d[k], d[k + 1], d[k + 2], d[k + 3], u - k);
    worst = max(worst, abs(y - v));
  });
  return worst;
}

// ---------------------------------------------------------------------------
// REFINE: hill climbing on the current control points
// ---------------------------------------------------------------------------

const REFINE_TRIALS = 150;
const REFINE_STEP = 0.04 * S; // largest change of d in one trial

// Shape difference between the current tile and the drawing. Both are in
// tile-local coordinates (viewAngle is display-only), and the tile outline is
// resampled to the same density as ghostContour so chamfer() is balanced.
function tileScore() {
  const poly = resampleClosed(flattenBoundary(buildTileBoundary()), CONTOUR_SAMPLES);
  return chamfer(poly, ghostContour);
}

// Nudges one random displacement per trial and keeps the nudge only if the
// tile stays valid and gets closer to the drawing. t values never change, and
// RIGHT/BOTTOM are still derived from TOP/LEFT, so the tile always tessellates.
function refineTile() {
  if (!hasTile) return;
  if (activeTileType === "triangle") return refineTriangleTile();
  const pts = [...topControlPoints, ...leftControlPoints];
  const start = tileScore();
  let best = start;
  for (let i = 0; i < REFINE_TRIALS; i++) {
    const p = random(pts);
    const old = p.d;
    p.d = limitDisplacement(p.t, old + random(-REFINE_STEP, REFINE_STEP));
    const score = tileIsValid() ? tileScore() : Infinity;
    if (score < best) best = score; // NaN and Infinity also fail this test
    else p.d = old;
  }
  setStatus(`Refined: shape difference ${start.toFixed(1)} → ${best.toFixed(1)} px.`);
  redraw();
}

// ---------------------------------------------------------------------------
// 02 / GENERATED TILE
// ---------------------------------------------------------------------------

// Tile-local frame -> middle panel, turned back to the drawing's orientation.
function applyTileView() {
  const p = PANELS.tile;
  translate(p.x + p.w / 2, p.y + p.h / 2);
  rotate(viewAngle);
  translate(-S / 2, -S / 2);
}

// Inverse of applyTileView, for mouse interaction.
function screenToTile(x, y) {
  const p = PANELS.tile;
  const c = createVector(p.x + p.w / 2, p.y + p.h / 2);
  const r = rotatePointAroundPivot(createVector(x, y), c, -viewAngle);
  return createVector(r.x - c.x + S / 2, r.y - c.y + S / 2);
}

function drawTilePanel(b) {
  if (b && activeTileType === "triangle") return drawTriangleTilePanel(b);
  const p = PANELS.tile;
  if (!b) {
    drawEmptyNote(p, freehandPoints.length ? "click GENERATE" : "");
    drawFrame(p);
    return;
  }
  clipToPanel(p);
  push();
  applyTileView();

  noStroke();
  drawTileFill(b, TILE_FILL);

  drawGhostContour();

  // editable edges thick, derived edges thin
  strokeWeight(3);
  stroke(BLUE);
  drawPolyline(b.top);
  stroke(PINK);
  drawPolyline(b.left);
  strokeWeight(1.5);
  stroke(BLUE);
  drawPolyline(b.right);
  stroke(PINK);
  drawPolyline(b.bottom);

  // fixed corners
  noStroke();
  fill(0);
  for (const c of [topLeft, topRight, bottomRight, bottomLeft]) square(c.x - 2.5, c.y - 2.5, 5);

  strokeWeight(1.5);
  for (const q of topControlPoints) drawControlPoint(topPointPos(q), BLUE, selected && selected.pt === q);
  for (const q of leftControlPoints) drawControlPoint(leftPointPos(q), PINK, selected && selected.pt === q);

  pop();
  drawingContext.restore();
  drawFrame(p);
}

// The normalized freehand outline, dashed, for comparison.
function drawGhostContour() {
  stroke(GRAY);
  strokeWeight(1);
  noFill();
  drawingContext.setLineDash([4, 4]);
  beginShape();
  for (const q of ghostContour) vertex(q.x, q.y);
  endShape(CLOSE);
  drawingContext.setLineDash([]);
}

function drawControlPoint(pos, col, isSelected) {
  stroke(col);
  fill(isSelected ? col : 255);
  circle(pos.x, pos.y, 8);
}

// ---------------------------------------------------------------------------
// 03 / TESSELLATION
// ---------------------------------------------------------------------------

// Draws the existing tile so that its bottomLeft corner sits at (x, y),
// rotated about that corner.
function drawTileAt(b, x, y, rotationAngle, scaleFactor, fillColor) {
  push();
  translate(x, y);
  rotate(rotationAngle);
  scale(scaleFactor);
  translate(-bottomLeft.x, -bottomLeft.y);
  drawTileFill(b, fillColor);
  pop();
}

// The tile has a 4-fold rotation centre at bottomLeft. Four copies rotated
// 0/90/180/270 degrees about bottomLeft form a 2S x 2S block; that block
// repeats by plain translation of (2S, 0) and (0, 2S). Every copy uses the
// same boundary b, so edges interlock with no gaps or overlaps.
// Neighbours across any edge differ by one quarter turn, so colouring by
// turn count never puts the same colour on both sides of an edge.
function drawTessellationPanel(b) {
  if (b && activeTileType === "triangle") return drawTriangleTessellation(b);
  const p = PANELS.tess;
  if (!b) {
    drawFrame(p);
    return;
  }
  const step = 2 * S * TESS_SCALE;
  const reach = dist(0, 0, p.w / 2, p.h / 2) + 1.5 * step; // covers the rotated panel
  const n = ceil(reach / step);

  clipToPanel(p);
  push();
  translate(p.x + p.w / 2, p.y + p.h / 2);
  rotate(viewAngle); // same orientation as the middle panel
  stroke(17);
  strokeWeight(1.2); // scaled by TESS_SCALE inside drawTileAt
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      if (dist(0, 0, i * step, j * step) > reach) continue;
      for (let k = 0; k < 4; k++) {
        drawTileAt(b, i * step, j * step, k * HALF_PI, TESS_SCALE, palette[k]);
      }
    }
  }
  pop();
  drawingContext.restore();
  drawFrame(p);
}

function buildPaletteButtons() {
  const holder = document.getElementById("palettes");
  PALETTES.forEach((colors, i) => {
    const btn = document.createElement("button");
    btn.className = "palette" + (i === 0 ? " active" : "");
    for (const c of colors) {
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = c;
      btn.appendChild(sw);
    }
    btn.onclick = () => {
      palette = colors;
      holder.querySelectorAll(".palette").forEach(el => el.classList.remove("active"));
      btn.classList.add("active");
      redraw();
    };
    holder.appendChild(btn);
  });
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function clearTile() {
  hasTile = false;
  topControlPoints = [];
  leftControlPoints = [];
  triControlPoints = [[], [], []];
  selected = null;
  dragging = false;
  ghostContour = [];
  viewAngle = 0;
}

function clearAll() {
  freehandPoints = [];
  isDrawingStroke = false;
  clearTile();
  setStatus("Draw one closed outline in the left panel.");
  redraw();
}

function mousePressed() {
  if (insidePanel(PANELS.draw, mouseX, mouseY)) {
    startStroke();
  } else if (hasTile && insidePanel(PANELS.tile, mouseX, mouseY)) {
    pressTile(screenToTile(mouseX, mouseY));
  } else if (mouseX >= 0 && mouseY >= 0 && mouseX <= width && mouseY <= height) {
    selected = null;
  } else {
    return; // clicks on the HTML buttons below the canvas
  }
  redraw();
}

// Control point editing, in tile-local coordinates m.
function pressTile(m) {
  if (activeTileType === "triangle") return pressTriangle(m);
  // 1. select an existing control point
  for (const p of topControlPoints) {
    if (dist(m.x, m.y, topPointPos(p).x, topPointPos(p).y) < CLICK_DIST) {
      selected = { edge: "top", pt: p };
      dragging = true;
      return;
    }
  }
  for (const p of leftControlPoints) {
    if (dist(m.x, m.y, leftPointPos(p).x, leftPointPos(p).y) < CLICK_DIST) {
      selected = { edge: "left", pt: p };
      dragging = true;
      return;
    }
  }

  // 2. add a new point if the click is near one of the editable curves
  if (nearCurve(m, getTopCurvePoints()) && addControlPoint("top", m.x - topLeft.x, m.y - topLeft.y)) return;
  if (nearCurve(m, getLeftCurvePoints()) && addControlPoint("left", bottomLeft.y - m.y, m.x - bottomLeft.x)) return;

  selected = null;
}

// along = distance along the edge from its start corner, d = displacement.
function addControlPoint(edge, along, d) {
  const list = edge === "top" ? topControlPoints : leftControlPoints;
  const t = along / S;
  if (t < 0.02 || t > 0.98) return false;
  if (list.some(q => abs(q.t - t) < MIN_T_GAP)) return false; // too close to a neighbour
  const p = { t, d: limitDisplacement(t, d) };
  list.push(p);
  list.sort((a, b) => a.t - b.t);
  if (!tileIsValid()) {
    list.splice(list.indexOf(p), 1);
    return false;
  }
  selected = { edge, pt: p };
  dragging = true;
  return true;
}

function nearCurve(m, pts) {
  return pts.some(p => dist(m.x, m.y, p.x, p.y) < CLICK_DIST);
}

// Only the displacement changes; t (position along the edge) stays fixed,
// so points can never reorder. If the new position would make the boundary
// cross itself, the point stops at the last valid position on the way.
function mouseDragged() {
  if (isDrawingStroke) {
    extendStroke();
    redraw();
    return;
  }
  if (!dragging || !selected) return;
  const m = screenToTile(mouseX, mouseY);
  const target = activeTileType === "triangle"
    ? limitTriDisplacement(selected.pt.t, triLocal(triFrame(selected.edge), m).y)
    : limitDisplacement(selected.pt.t, selected.edge === "top" ? m.y - topLeft.y : m.x - bottomLeft.x);
  const start = selected.pt.d;
  selected.pt.d = target;
  if (!tileIsValid()) {
    let lo = 0, hi = 1; // fraction of the way from start to target
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      selected.pt.d = lerp(start, target, mid);
      if (tileIsValid()) lo = mid;
      else hi = mid;
    }
    selected.pt.d = lerp(start, target, lo);
  }
  redraw();
}

function mouseReleased() {
  if (isDrawingStroke) finishStroke();
  dragging = false;
  redraw();
}

function keyPressed() {
  if (selected && (keyCode === BACKSPACE || keyCode === DELETE)) {
    const list = activeTileType === "triangle" ? triControlPoints[selected.edge]
      : selected.edge === "top" ? topControlPoints : leftControlPoints;
    const i = list.indexOf(selected.pt);
    list.splice(i, 1);
    if (!tileIsValid()) list.splice(i, 0, selected.pt); // keep it if removal breaks the tile
    else selected = null;
    redraw();
    return false; // stop the browser from navigating back on Backspace
  }
}

// ===========================================================================
// TRIANGLE SYSTEM
// ===========================================================================
//
// Each edge X -> Y of the triangle ABC has midpoint M. Only the half X -> M
// is editable; the half M -> Y is that curve rotated 180 degrees about M.
// So every edge is centrally symmetric about its midpoint, and the copy of
// the tile rotated 180 degrees about that midpoint fits against it exactly.
// Tiling: the tile plus its half-turn about mid(BC) fill a parallelogram,
// which repeats by translation along u = B - A and v = C - A.

// Frame of edge i: start X, end Y, midpoint M, half-length L,
// unit direction dir (X -> M) and outward normal n.
function triFrame(i) {
  const [X, Y] = [[triA, triB], [triB, triC], [triC, triA]][i];
  const M = p5.Vector.lerp(X, Y, 0.5);
  const dir = p5.Vector.sub(M, X).div(TRI_HALF);
  return { X, Y, M, L: TRI_HALF, dir, n: createVector(dir.y, -dir.x) };
}

// Control point -> tile-local position.
function triPointPos(f, p) {
  return createVector(
    f.X.x + f.dir.x * p.t * f.L + f.n.x * p.d,
    f.X.y + f.dir.y * p.t * f.L + f.n.y * p.d
  );
}

// Tile-local point -> { x: distance along the edge, y: outward offset }.
function triLocal(f, p) {
  const dx = p.x - f.X.x, dy = p.y - f.X.y;
  return { x: dx * f.dir.x + dy * f.dir.y, y: dx * f.n.x + dy * f.n.y };
}

// Same idea as limitDisplacement: bounded, tapering to 0 at the vertex
// (slope < tan 30deg, so the two edges at a 60deg corner never meet) and at M.
function limitTriDisplacement(t, d) {
  if (!isFinite(d)) return 0;
  const cap = min(TRI_MAX_DISPLACEMENT, TRI_CORNER_SLOPE * TRI_HALF * t, TRI_HALF * (1 - t));
  return constrain(d, -cap, cap);
}

// first: editable half X -> M (Catmull-Rom, as for the square);
// second: first rotated 180deg about M, reversed so it runs M -> Y.
function getTriEdgePoints(i) {
  const f = triFrame(i);
  const first = sampleCurve([f.X, ...triControlPoints[i].map(p => triPointPos(f, p)), f.M]);
  const second = first.map(p => rotatePointAroundPivot(p, f.M, PI)).reverse();
  return { first, second: second.slice(1) };
}

// Closed boundary, clockwise: edge AB, BC, CA.
function buildTriangleBoundary() {
  return [0, 1, 2].map(getTriEdgePoints);
}

function flattenTriangle(b) {
  return b.flatMap(e => [...e.first, ...e.second]);
}

function drawTriangleFill(b, fillColor) {
  fill(fillColor);
  beginShape();
  for (const p of flattenTriangle(b)) vertex(p.x, p.y);
  endShape(CLOSE);
}

// Lattice translations of the triangle tiling.
function triLattice() {
  return { u: p5.Vector.sub(triB, triA), v: p5.Vector.sub(triC, triA), m: p5.Vector.lerp(triB, triC, 0.5) };
}

// Valid = finite, not self-crossing, and not overlapping any neighbouring copy.
function triangleIsValid() {
  const poly = flattenTriangle(buildTriangleBoundary());
  if (!poly.every(p => isFinite(p.x) && isFinite(p.y))) return false;
  if (polygonSelfIntersects(poly)) return false;
  return !overlapsNeighbours(poly);
}

// Checks the copies around the tile (both orientations, one lattice step in
// every direction). Points a neighbour shares with this tile (its matching
// edge) are skipped; any other neighbour point inside the tile is an overlap.
// The half-turn maps tile and neighbour onto each other, so one direction
// of the test is enough.
function overlapsNeighbours(poly) {
  const { u, v, m } = triLattice();
  const probe = poly.filter((_, k) => k % 3 === 0);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const ox = i * u.x + j * v.x, oy = i * u.y + j * v.y;
      for (const turned of [false, true]) {
        if (!turned && i === 0 && j === 0) continue;
        for (const q of probe) {
          const x = (turned ? 2 * m.x - q.x : q.x) + ox;
          const y = (turned ? 2 * m.y - q.y : q.y) + oy;
          if (poly.some(r => abs(r.x - x) < 0.5 && abs(r.y - y) < 0.5)) continue; // shared edge
          if (pointInPolygon(x, y, poly)) return true;
        }
      }
    }
  }
  return false;
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function makeTriangleValid() {
  for (let i = 0; i < 7; i++) {
    if (triangleIsValid()) return true;
    for (const p of triControlPoints.flat()) p.d *= 0.9;
  }
  return triangleIsValid();
}

// ---------------------------------------------------------------------------
// Triangle fitting
// ---------------------------------------------------------------------------
//
// Same search as fitTile (orientations x shifts, Chamfer score), but the
// readings follow the triangle: for each edge, a line perpendicular to the
// edge at distance u from X meets the drawing at the first-half offset, and
// the line at distance 2L - u meets it at the second-half offset, which by
// the half-turn symmetry is the negated first-half offset. Both vote.

function fitTriangleTile(contour) {
  let best = null;
  for (let a = 0; a < FIT_ANGLES; a++) {
    const angle = (a * TWO_PI) / FIT_ANGLES;
    for (const ox of FIT_OFFSETS) {
      for (const oy of FIT_OFFSETS) {
        const target = placeContour(contour, angle, ox * S, oy * S);
        const profiles = measureTriangleProfiles(target);
        const turn = min(angle, TWO_PI - angle) / PI;
        const score = chamfer(triCoarseBoundary(profiles), target) + ROTATION_PENALTY * turn;
        if (isFinite(score) && (!best || score < best.score)) best = { score, angle, target, profiles };
      }
    }
  }
  return best;
}

function measureTriangleProfiles(target) {
  const raw = [0, 1, 2].map(i => {
    const f = triFrame(i);
    const local = target.map(p => triLocal(f, p));
    const vals = [];
    for (let k = 1; k <= TRI_FIT_SAMPLES; k++) {
      const u = (k / (TRI_FIT_SAMPLES + 1)) * f.L;
      const first = nearestTo(crossings(local, "x", u), 0);
      const second = nearestTo(crossings(local, "x", 2 * f.L - u), 0);
      vals.push(average([first, second === null ? null : -second]));
    }
    return fillGaps(vals);
  });
  let k = 1;
  // Shrink the profiles until the coarse tile no longer crosses itself.
  for (let i = 0; i < 8; i++) {
    const clamped = raw.map(vals => clampTriProfile(vals, k));
    if (!polygonSelfIntersects(triCoarseBoundary(clamped))) return clamped;
    k *= 0.85;
  }
  return raw.map(vals => clampTriProfile(vals, k));
}

function clampTriProfile(vals, k) {
  return vals.map((v, i) => limitTriDisplacement((i + 1) / (vals.length + 1), v * k));
}

// Tile outline straight from the sampled profiles (used while scoring).
function triCoarseBoundary(profiles) {
  const pts = [];
  profiles.forEach((vals, i) => {
    const f = triFrame(i);
    const half = vals.map((d, k) => triPointPos(f, { t: (k + 1) / (vals.length + 1), d }));
    pts.push(f.X, ...half, f.M);
    for (let k = half.length - 1; k >= 0; k--) pts.push({ x: 2 * f.M.x - half[k].x, y: 2 * f.M.y - half[k].y });
  });
  return pts;
}

function applyTriangleFit(fit) {
  triControlPoints = fit.profiles.map(vals =>
    chooseControlPoints(vals, limitTriDisplacement, TRI_MIN_CP, TRI_MAX_CP));
  selected = null;
  if (!makeTriangleValid()) return false;
  ghostContour = fit.target;
  viewAngle = -fit.angle;
  hasTile = true;
  return true;
}

// ---------------------------------------------------------------------------
// Triangle REFINE: same hill climbing as refineTile
// ---------------------------------------------------------------------------

function triangleScore() {
  const poly = resampleClosed(flattenTriangle(buildTriangleBoundary()), CONTOUR_SAMPLES);
  return chamfer(poly, ghostContour);
}

// Vertices, midpoints and t values never change; only d is nudged, and the
// second halves follow automatically. The (cheap) score is checked first,
// the (costlier) validity test only for improvements.
function refineTriangleTile() {
  const pts = triControlPoints.flat();
  if (pts.length === 0) return;
  const start = triangleScore();
  let best = start;
  for (let i = 0; i < REFINE_TRIALS; i++) {
    const p = random(pts);
    const old = p.d;
    p.d = limitTriDisplacement(p.t, old + random(-REFINE_STEP, REFINE_STEP));
    const score = triangleScore();
    if (score < best && triangleIsValid()) best = score; // NaN also fails
    else p.d = old;
  }
  setStatus(`Refined: shape difference ${start.toFixed(1)} → ${best.toFixed(1)} px.`);
  redraw();
}

// ---------------------------------------------------------------------------
// Triangle drawing
// ---------------------------------------------------------------------------

function drawTriangleTilePanel(b) {
  const p = PANELS.tile;
  clipToPanel(p);
  push();
  applyTileView();

  noStroke();
  drawTriangleFill(b, TILE_FILL);
  drawGhostContour();

  // editable halves thick, derived halves thin
  b.forEach((e, i) => {
    stroke(TRI_COLORS[i]);
    strokeWeight(3);
    drawPolyline(e.first);
    strokeWeight(1.5);
    drawPolyline(e.second);
  });

  // fixed vertices (filled) and midpoints (hollow)
  noStroke();
  fill(0);
  for (const c of [triA, triB, triC]) square(c.x - 2.5, c.y - 2.5, 5);
  stroke(0);
  strokeWeight(1);
  fill(255);
  for (let i = 0; i < 3; i++) square(triFrame(i).M.x - 2.5, triFrame(i).M.y - 2.5, 5);

  strokeWeight(1.5);
  triControlPoints.forEach((list, i) => {
    const f = triFrame(i);
    for (const q of list) drawControlPoint(triPointPos(f, q), TRI_COLORS[i], selected && selected.pt === q);
  });

  pop();
  drawingContext.restore();
  drawFrame(p);
}

// Tile T and its half-turn T' about mid(BC) form one parallelogram; it is
// repeated at every i*u + j*v. Every edge neighbour of a T is a T' (and vice
// versa), so T uses palette colours 0/2 and T' uses 1/3: no two tiles that
// share an edge get the same colour.
function drawTriangleTessellation(b) {
  const p = PANELS.tess;
  const { u, v, m } = triLattice();
  const reach = dist(0, 0, p.w / 2, p.h / 2) / TESS_SCALE + 1.5 * TRI_SIDE; // in tile units
  const n = ceil((2 * reach) / TRI_SIDE) + 1;

  clipToPanel(p);
  push();
  translate(p.x + p.w / 2, p.y + p.h / 2);
  rotate(viewAngle); // same orientation as the middle panel
  scale(TESS_SCALE);
  translate(-S / 2, -S / 2);
  stroke(17);
  strokeWeight(1.2); // scaled by TESS_SCALE, as in the square tessellation
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const ox = i * u.x + j * v.x, oy = i * u.y + j * v.y;
      if (dist(0, 0, ox, oy) > reach) continue;
      const c = abs(i + j) % 2 === 0 ? 0 : 2;
      push();
      translate(ox, oy);
      drawTriangleFill(b, palette[c]);
      translate(m.x, m.y);
      rotate(PI);
      translate(-m.x, -m.y);
      drawTriangleFill(b, palette[c + 1]);
      pop();
    }
  }
  pop();
  drawingContext.restore();
  drawFrame(p);
}

// ---------------------------------------------------------------------------
// Triangle editing (same rules as the square: drag d only, add, delete)
// ---------------------------------------------------------------------------

function pressTriangle(m) {
  for (let i = 0; i < 3; i++) {
    const f = triFrame(i);
    for (const q of triControlPoints[i]) {
      const pos = triPointPos(f, q);
      if (dist(m.x, m.y, pos.x, pos.y) < CLICK_DIST) {
        selected = { edge: i, pt: q };
        dragging = true;
        return;
      }
    }
  }
  // add a point only on an editable (first) half
  const b = buildTriangleBoundary();
  for (let i = 0; i < 3; i++) {
    if (!nearCurve(m, b[i].first)) continue;
    const loc = triLocal(triFrame(i), m);
    if (addTriangleControlPoint(i, loc.x / TRI_HALF, loc.y)) return;
  }
  selected = null;
}

function addTriangleControlPoint(i, t, d) {
  const list = triControlPoints[i];
  if (t < 0.04 || t > 0.96) return false;
  if (list.some(q => abs(q.t - t) < 2 * MIN_T_GAP)) return false; // too close to a neighbour
  const p = { t, d: limitTriDisplacement(t, d) };
  list.push(p);
  list.sort((a, b) => a.t - b.t);
  if (!triangleIsValid()) {
    list.splice(list.indexOf(p), 1);
    return false;
  }
  selected = { edge: i, pt: p };
  dragging = true;
  return true;
}
