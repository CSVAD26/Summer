// FREEHAND TO TESSELLATION
// Draw a closed silhouette (left panel), fit it to a square-rotation tile
// (middle panel), and repeat that tile across the plane (right panel).
//
// Only the TOP and LEFT edges of the square are editable; RIGHT and BOTTOM
// are computed from them by 90-degree rotations (RIGHT = TOP turned about
// topRight, BOTTOM = LEFT turned about bottomLeft), so every tile
// tessellates by construction.

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

const S = 150; // reference square size
// Corners are in tile-local coordinates; GENERATE starts them as the square
// (0..S). The middle panel and the tessellation place this local frame on
// screen with translate/rotate.
//
// The corners are editable, but the rotation rules force them to stay a
// square: RIGHT = TOP turned about topRight and BOTTOM = LEFT turned about
// bottomLeft must send topLeft to the same bottomRight, which only happens
// when topLeft and bottomRight complete the square on the diagonal
// topRight-bottomLeft. So dragging a corner moves, scales and rotates the
// square (setSquareCorner) and never makes an arbitrary quadrilateral.
let topLeft, topRight, bottomRight, bottomLeft;
const VERTEX_RED = "#e5322d";
const MIN_SQUARE = 0.5 * S, MAX_SQUARE = 1.6 * S; // allowed side lengths
const VIEW_RADIUS = 150; // corners stay this close to the panel centre

// Interior control points. Each is { t, d, a }:
//   t = position along the edge (0..1) where the point was created
//   d = perpendicular displacement in pixels
//   a = extra movement along the edge in pixels (optional; points made by
//       fitting have none, which counts as 0)
// Dragging changes d and a, so points move freely in 2D. Array order is the
// order along the edge and never changes.
let topControlPoints = [];
let leftControlPoints = [];

let selected = null; // { edge: "top" | "left", pt: controlPoint } or { vertex: 0..3 }
let dragging = false;

let hasTile = false;   // true once GENERATE succeeded
let ghostContour = []; // normalized freehand outline, in tile-local coords
let viewAngle = 0;     // rotation that shows the tile in the drawing's orientation

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
const FIT_KEEP = 12;           // best placements re-examined with alternative profiles
const VOTES = ["both", "a", "b"];      // which of two paired edges sets a profile
const PICKS = ["nearest", "tracked"];  // how a crossing is chosen on a scan line
const IOU_ROWS = 40;           // scan lines for the silhouette comparison
const IOU_WEIGHT = 0.25 * S;   // error (px) per unit of (1 - IoU)
const SMOOTH_WEIGHT = 0.1;     // error (px) per radian of curve turning

const TESS_SCALE = 0.5;

function setup() {
  createCanvas(1200, 446).parent("canvas-holder");

  resetSquare();

  document.getElementById("clear-btn").onclick = clearAll;
  document.getElementById("generate-btn").onclick = generateTile;
  document.getElementById("refine-btn").onclick = refineTile;
  buildPaletteButtons();
  setStatus("Draw one closed outline in the left panel.");

  noLoop(); // the sketch only redraws when something changes
}

function draw() {
  background(255);
  drawPanelLabels();
  drawFreehandPanel();
  const b = hasTile ? buildTileBoundary() : null;
  drawTilePanel(b);
  drawTessellationPanel(b);
  document.getElementById("refine-btn").disabled = !hasTile;
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

// ---------------------------------------------------------------------------
// Control point -> tile-local position
// ---------------------------------------------------------------------------

// Position along the edge (0..1), including the along-edge offset.
function edgePos(p) {
  return p.t + (p.a || 0) / S;
}

// TOP edge runs topLeft -> topRight (along = x, displacement = y for the
// starting square); LEFT runs bottomLeft -> topLeft (along = up,
// displacement = x).
function topPointPos(p) {
  return framePoint(squareFrame("top"), p);
}

function leftPointPos(p) {
  return framePoint(squareFrame("left"), p);
}

// Local frame of an editable edge of the current square: start P, length L,
// unit direction dir, normal n = (-dir.y, dir.x), and scale k = L / S.
// Control points are stored for the reference square (t, d, a in units of
// S) and scaled by k, so they ride on their edge and the tile keeps its
// shape when the square moves, scales or turns.
function squareFrame(edge) {
  const [P, Q] = edge === "top" ? [topLeft, topRight] : [bottomLeft, topLeft];
  const L = p5.Vector.dist(P, Q);
  const dir = p5.Vector.sub(Q, P).div(L);
  return { P, L, k: L / S, dir, n: createVector(-dir.y, dir.x) };
}

// P + dir * (edge position * L) + n * (d * k)
function framePoint(f, p) {
  const along = edgePos(p) * f.L, d = p.d * f.k;
  return createVector(f.P.x + f.dir.x * along + f.n.x * d, f.P.y + f.dir.y * along + f.n.y * d);
}

// ---- Editable square -------------------------------------------------------

function resetSquare() {
  topLeft = createVector(0, 0);
  topRight = createVector(S, 0);
  bottomRight = createVector(S, S);
  bottomLeft = createVector(0, S);
}

function squareCorners() {
  return [topLeft, topRight, bottomRight, bottomLeft]; // clockwise
}

// Puts corner i at (x, y) while the opposite corner stays fixed; the other
// two corners complete the square on that diagonal. This is the full
// freedom the rotation rules allow: position, size and angle.
function setSquareCorner(i, x, y) {
  const c = squareCorners(), o = c[(i + 2) % 4];
  const mx = (x + o.x) / 2, my = (y + o.y) / 2, hx = x - mx, hy = y - my;
  c[i].set(x, y);
  c[(i + 1) % 4].set(mx - hy, my + hx);
  c[(i + 3) % 4].set(mx + hy, my - hx);
}

// Not too small or large, and still inside the middle panel.
function squareOk() {
  const side = p5.Vector.dist(topLeft, topRight);
  if (!(side >= MIN_SQUARE && side <= MAX_SQUARE)) return false;
  return squareCorners().every(c => dist(c.x, c.y, S / 2, S / 2) <= VIEW_RADIUS);
}

// Moves p to along-edge offset a and displacement d. It stays between its
// neighbours (so the array order stays the order along the edge) and inside
// the displacement limits for its new position.
function placeControlPoint(list, p, a, d) {
  const i = list.indexOf(p);
  const lo = (i > 0 ? edgePos(list[i - 1]) : 0) + MIN_T_GAP;
  const hi = (i < list.length - 1 ? edgePos(list[i + 1]) : 1) - MIN_T_GAP;
  const u = isFinite(a) && lo <= hi ? constrain(p.t + a / S, lo, hi) : edgePos(p);
  p.a = (u - p.t) * S;
  p.d = limitDisplacement(u, d);
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
  if (!squareOk()) return false;
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
// read f and g off the drawing, build the resulting tile, and keep the
// candidate with the lowest fitError().

function generateTile() {
  if (freehandPoints.length === 0) {
    setStatus("Draw an outline first.");
    return;
  }
  try {
    const simplified = simplifyClosed(freehandPoints, SIMPLIFY_EPS);
    const contour = normalizeContour(resampleClosed(simplified, CONTOUR_SAMPLES));
    resetSquare(); // fitting works on the reference square
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

// Two passes, both scored with fitError():
// 1. every placement (orientation x shift) with the default profiles
//    (both paired edges vote, nearest crossing);
// 2. for the FIT_KEEP best placements, alternative profiles: one edge of a
//    pair alone instead of the average (an average halves a deep
//    indentation seen by only one edge), and tracked instead of nearest
//    crossings.
function fitTile(contour) {
  const placements = [];
  for (let a = 0; a < FIT_ANGLES; a++) {
    const angle = (a * TWO_PI) / FIT_ANGLES;
    const turn = (ROTATION_PENALTY * min(angle, TWO_PI - angle)) / PI;
    for (const ox of FIT_OFFSETS) {
      for (const oy of FIT_OFFSETS) {
        const target = placeContour(contour, angle, ox * S, oy * S);
        const cand = scoreProfiles(target, readEdges(target, "nearest"), "both", "both");
        placements.push({ ...cand, score: cand.score + turn, angle, target, turn });
      }
    }
  }
  placements.sort((p, q) => p.score - q.score);
  let best = placements[0];
  for (const pl of placements.slice(0, FIT_KEEP)) {
    for (const pick of PICKS) {
      const readings = readEdges(pl.target, pick);
      for (const fVote of VOTES) {
        for (const gVote of VOTES) {
          const cand = scoreProfiles(pl.target, readings, fVote, gVote);
          if (cand.score + pl.turn < best.score) best = { ...pl, ...cand, score: cand.score + pl.turn, pick, fVote, gVote };
        }
      }
    }
  }
  return isFinite(best.score) ? best : null;
}

function scoreProfiles(target, readings, fVote, gVote) {
  const { top, left } = combineProfiles(readings, fVote, gVote);
  const lines = profilePolylines(top, left);
  const score = fitError(coarseBoundary(top, left), target, curveTurning(lines.top) + curveTurning(lines.left));
  return { top, left, score };
}

// Rotates the normalized contour and moves it over the square [0, S]^2.
function placeContour(contour, angle, ox, oy) {
  const c = cos(angle), s = sin(angle);
  return contour.map(p => ({
    x: p.x * c - p.y * s + S / 2 + ox,
    y: p.x * s + p.y * c + S / 2 + oy,
  }));
}

// Raw crossings for every sample t. The vertical line x = tS gives the TOP
// reading (near y = 0) and BOTTOM reading (near y = S); the horizontal line
// y = (1-t)S gives LEFT (near x = 0) and RIGHT (near x = S). A line can cross
// the drawing 4+ times. "nearest" takes the crossing closest to the square
// edge; "tracked" takes the one closest to the previous sample's choice, so
// a reading can stay inside a deep indentation instead of jumping out.
function readEdges(target, pick) {
  const refs = { top: 0, bottom: S, left: 0, right: S };
  const prev = { ...refs };
  const r = { top: [], bottom: [], left: [], right: [] };
  for (let i = 1; i <= FIT_SAMPLES; i++) {
    const t = i / (FIT_SAMPLES + 1);
    const vertical = crossings(target, "x", t * S);
    const horizontal = crossings(target, "y", (1 - t) * S);
    for (const e of ["top", "bottom", "left", "right"]) {
      const list = e === "top" || e === "bottom" ? vertical : horizontal;
      const v = nearestTo(list, pick === "tracked" ? prev[e] : refs[e]);
      r[e].push(v);
      if (v !== null) prev[e] = v;
    }
  }
  return r;
}

// Turns raw readings into the profiles f (TOP) and g (LEFT). Each profile is
// seen by two edges (TOP/RIGHT for f, LEFT/BOTTOM for g); the vote decides
// whether both readings are averaged or one edge alone is used.
function combineProfiles(r, fVote, gVote) {
  const shift = v => (v === null ? null : v - S);
  const fB = r.right.map(shift);
  const gB = r.bottom.map(shift);
  const top = fillGaps(r.top.map((v, i) => vote(v, fB[i], fVote)));
  const left = fillGaps(r.left.map((v, i) => vote(v, gB[i], gVote)));
  let k = 1;
  // Shrink the profiles until the coarse tile no longer crosses itself.
  for (let i = 0; i < 8; i++) {
    const tp = clampProfile(top, k), lp = clampProfile(left, k);
    if (!polygonSelfIntersects(coarseBoundary(tp, lp))) return { top: tp, left: lp };
    k *= 0.85;
  }
  return { top: clampProfile(top, k), left: clampProfile(left, k) };
}

function vote(a, b, how) {
  if (how === "a") return a ?? b;
  if (how === "b") return b ?? a;
  return average([a, b]);
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

// The editable TOP and LEFT curves as polylines straight from the profiles.
function profilePolylines(f, g) {
  const t = i => (i + 1) / (f.length + 1);
  return {
    top: [{ x: 0, y: 0 }, ...f.map((d, i) => ({ x: t(i) * S, y: d })), { x: S, y: 0 }],
    left: [{ x: 0, y: S }, ...g.map((d, i) => ({ x: d, y: (1 - t(i)) * S })), { x: 0, y: 0 }],
  };
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

// Similarity objective for fitting and REFINE (lower is better). Both shapes
// are in tile-local coordinates; the tile outline is resampled to the same
// density as the target.
//   contour term:    Chamfer distance between the outlines
//   silhouette term: 1 - IoU of the filled shapes, which rewards keeping big
//                    indentations and proportions that outline distance
//                    under-weights
//   smoothness term: total turning of the editable curves (discourages wiggles)
function fitError(poly, target, turning) {
  const outline = resampleClosed(poly, CONTOUR_SAMPLES);
  return chamfer(outline, target)
    + IOU_WEIGHT * (1 - silhouetteIoU(poly, target))
    + SMOOTH_WEIGHT * turning;
}

// Intersection-over-union of two filled polygons, rasterized along
// IOU_ROWS horizontal scan lines (exact along each line).
function silhouetteIoU(A, B) {
  const ys = [...A, ...B].map(p => p.y);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  let inter = 0, union = 0;
  for (let r = 0; r < IOU_ROWS; r++) {
    const y = lerp(y0, y1, (r + 0.5) / IOU_ROWS);
    const a = scanSpans(A, y), b = scanSpans(B, y);
    let both = 0;
    for (const [a0, a1] of a) for (const [b0, b1] of b) both += max(0, min(a1, b1) - max(a0, b0));
    inter += both;
    union += spanLength(a) + spanLength(b) - both;
  }
  return union > 0 ? inter / union : 0;
}

// Inside intervals of a polygon on the line y (even-odd rule).
function scanSpans(poly, y) {
  const xs = crossings(poly, "y", y).sort((p, q) => p - q);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2) out.push([xs[k], xs[k + 1]]);
  return out;
}

function spanLength(spans) {
  return spans.reduce((sum, [x0, x1]) => sum + x1 - x0, 0);
}

// Sum of absolute direction changes along a polyline, in radians.
function curveTurning(pts) {
  let total = 0, prev = null;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
    if (abs(dx) + abs(dy) < 1e-6) continue;
    const a = Math.atan2(dy, dx);
    if (prev !== null) total += abs(Math.atan2(Math.sin(a - prev), Math.cos(a - prev)));
    prev = a;
  }
  return total;
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
function chooseControlPoints(vals) {
  let pts = [];
  for (let m = MIN_CP; m <= MAX_CP; m++) {
    pts = [];
    for (let j = 1; j <= m; j++) {
      const t = j / (m + 1);
      pts.push({ t, d: limitDisplacement(t, sampleProfile(vals, t)) });
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

// Shape error between the current tile and the drawing, using the same
// objective as fitting. Both are in tile-local coordinates (viewAngle is
// display-only).
function tileScore() {
  const turning = curveTurning(getTopCurvePoints()) + curveTurning(getLeftCurvePoints());
  return fitError(flattenBoundary(buildTileBoundary()), ghostContour, turning);
}

// Nudges one control point per trial and keeps the nudge only if the tile
// stays valid and gets closer to the drawing. The point count never changes, and
// RIGHT/BOTTOM are still derived from TOP/LEFT by the rotations, so the tile
// always tessellates.
function refineTile() {
  if (!hasTile) return;
  const pts = [...topControlPoints, ...leftControlPoints];
  const start = tileScore();
  let best = start;
  for (let i = 0; i < REFINE_TRIALS; i++) {
    const p = random(pts);
    const list = topControlPoints.includes(p) ? topControlPoints : leftControlPoints;
    const old = { a: p.a || 0, d: p.d };
    const step = random(-REFINE_STEP, REFINE_STEP);
    // nudge either the displacement or the position along the edge
    if (random() < 0.5) placeControlPoint(list, p, old.a, old.d + step);
    else placeControlPoint(list, p, old.a + step, old.d);
    const score = tileIsValid() ? tileScore() : Infinity;
    if (score < best) best = score; // NaN and Infinity also fail this test
    else Object.assign(p, old);
  }
  setStatus(`Refined: shape error ${start.toFixed(2)} → ${best.toFixed(2)}.`);
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

  // the normalized freehand outline, dashed, for comparison
  stroke(GRAY);
  strokeWeight(1);
  noFill();
  drawingContext.setLineDash([4, 4]);
  beginShape();
  for (const q of ghostContour) vertex(q.x, q.y);
  endShape(CLOSE);
  drawingContext.setLineDash([]);

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

  // draggable corners (red), slightly larger than the control points
  strokeWeight(1.5);
  stroke(VERTEX_RED);
  squareCorners().forEach((c, i) => {
    fill(selected && selected.vertex === i ? VERTEX_RED : 255);
    circle(c.x, c.y, 11);
  });

  strokeWeight(1.5);
  for (const q of topControlPoints) drawControlPoint(topPointPos(q), BLUE, selected && selected.pt === q);
  for (const q of leftControlPoints) drawControlPoint(leftPointPos(q), PINK, selected && selected.pt === q);

  pop();
  drawingContext.restore();
  drawFrame(p);
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
// 0/90/180/270 degrees about bottomLeft form a block twice the square's
// size; that block repeats by plain translation of 2 * (bottomRight -
// bottomLeft) and 2 * (bottomLeft - topLeft), i.e. (2S, 0) and (0, 2S) for
// the starting square, and turned/scaled with the square. Every copy uses the
// same boundary b, so edges interlock with no gaps or overlaps.
// Neighbours across any edge differ by one quarter turn, so colouring by
// turn count never puts the same colour on both sides of an edge.
function drawTessellationPanel(b) {
  const p = PANELS.tess;
  if (!b) {
    drawFrame(p);
    return;
  }
  const e1 = p5.Vector.sub(bottomRight, bottomLeft).mult(2 * TESS_SCALE);
  const e2 = p5.Vector.sub(bottomLeft, topLeft).mult(2 * TESS_SCALE);
  const step = e1.mag();
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
      const x = i * e1.x + j * e2.x, y = i * e1.y + j * e2.y;
      if (dist(0, 0, x, y) > reach) continue;
      for (let k = 0; k < 4; k++) {
        drawTileAt(b, x, y, k * HALF_PI, TESS_SCALE, palette[k]);
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
  selected = null;
  dragging = false;
  ghostContour = [];
  viewAngle = 0;
  resetSquare();
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
  // 0. corners take priority, so clicking one never adds a control point
  const corner = squareCorners().findIndex(c => dist(m.x, m.y, c.x, c.y) < CLICK_DIST);
  if (corner >= 0) {
    selected = { vertex: corner };
    dragging = true;
    return;
  }
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
  if (nearCurve(m, getTopCurvePoints()) && addControlPoint("top", m)) return;
  if (nearCurve(m, getLeftCurvePoints()) && addControlPoint("left", m)) return;

  selected = null;
}

// Inserts a point at the clicked spot m. Its array position comes from the
// nearest sampled curve segment (segment i runs from point i-1 to point i),
// so it lands between the correct neighbours.
function addControlPoint(edge, m) {
  const list = edge === "top" ? topControlPoints : leftControlPoints;
  const curve = edge === "top" ? getTopCurvePoints() : getLeftCurvePoints();
  let k = 0;
  curve.forEach((q, j) => {
    if (dist(m.x, m.y, q.x, q.y) < dist(m.x, m.y, curve[k].x, curve[k].y)) k = j;
  });
  const i = min(floor(k / SAMPLES_PER_SEGMENT), list.length);
  const { along, d } = edgeCoords(edge, m);
  const t = along / S;
  const lo = (i > 0 ? edgePos(list[i - 1]) : 0) + MIN_T_GAP;
  const hi = (i < list.length ? edgePos(list[i]) : 1) - MIN_T_GAP;
  if (t < lo || t > hi) return false; // too close to a neighbour or a corner
  const p = { t, d: limitDisplacement(t, d) };
  list.splice(i, 0, p);
  if (!tileIsValid()) {
    list.splice(i, 1);
    return false;
  }
  selected = { edge, pt: p };
  dragging = true;
  return true;
}

function nearCurve(m, pts) {
  return pts.some(p => dist(m.x, m.y, p.x, p.y) < CLICK_DIST);
}

// Tile-local point -> distance along an editable edge and displacement from
// it, in reference-square units (the inverse of framePoint).
function edgeCoords(edge, m) {
  const f = squareFrame(edge), dx = m.x - f.P.x, dy = m.y - f.P.y;
  return { along: (dx * f.dir.x + dy * f.dir.y) / f.k, d: (dx * f.n.x + dy * f.n.y) / f.k };
}

// The point follows the cursor in 2D (along the edge and across it), kept
// between its neighbours by placeControlPoint. If the new position would make
// the boundary cross itself, the point stops at the last valid position on
// the straight path from where it was.
function mouseDragged() {
  if (isDrawingStroke) {
    extendStroke();
    redraw();
    return;
  }
  if (!dragging || !selected) return;
  if (selected.vertex !== undefined) return dragVertex(screenToTile(mouseX, mouseY));
  const p = selected.pt;
  const list = selected.edge === "top" ? topControlPoints : leftControlPoints;
  const { along, d } = edgeCoords(selected.edge, screenToTile(mouseX, mouseY));
  const start = { a: p.a || 0, d: p.d };
  placeControlPoint(list, p, along - p.t * S, d);
  const target = { a: p.a, d: p.d };
  if (!tileIsValid()) {
    let lo = 0, hi = 1; // fraction of the way from start to target
    const setAt = f => Object.assign(p, { a: lerp(start.a, target.a, f), d: lerp(start.d, target.d, f) });
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      setAt(mid);
      if (tileIsValid()) lo = mid;
      else hi = mid;
    }
    setAt(lo);
  }
  redraw();
}

// Moves corner selected.vertex toward m with the opposite corner fixed; the
// square, both editable curves, their control points, the rotated edges
// and the tessellation lattice all follow. If the target is invalid, the
// corner stops at the last valid spot on the way.
function dragVertex(m) {
  const i = selected.vertex, start = squareCorners()[i].copy();
  setSquareCorner(i, m.x, m.y);
  if (!tileIsValid()) {
    let lo = 0, hi = 1;
    for (let k = 0; k < 6; k++) {
      const mid = (lo + hi) / 2;
      setSquareCorner(i, lerp(start.x, m.x, mid), lerp(start.y, m.y, mid));
      if (tileIsValid()) lo = mid;
      else hi = mid;
    }
    setSquareCorner(i, lerp(start.x, m.x, lo), lerp(start.y, m.y, lo));
  }
  redraw();
}

function mouseReleased() {
  if (isDrawingStroke) finishStroke();
  dragging = false;
  redraw();
}

function keyPressed() {
  if (selected && selected.pt && (keyCode === BACKSPACE || keyCode === DELETE)) {
    const list = selected.edge === "top" ? topControlPoints : leftControlPoints;
    const i = list.indexOf(selected.pt);
    list.splice(i, 1);
    if (!tileIsValid()) list.splice(i, 0, selected.pt); // keep it if removal breaks the tile
    else selected = null;
    redraw();
    return false; // stop the browser from navigating back on Backspace
  }
}
