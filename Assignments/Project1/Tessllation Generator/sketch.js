// FREEHAND TO TESSELLATION
// Draw a closed silhouette (left panel), fit it to a quadrilateral half-turn
// tile (middle panel), and repeat that tile across the plane (right panel).
//
// Geometry: any simple quadrilateral ABCD tiles the plane by 180-degree
// rotations ("half-turns") about the midpoints of its edges. The neighbour
// across edge XY is the tile half-turned about mid(XY), which maps XY onto
// itself reversed. So a curved edge matches its neighbour exactly when it is
// centrally symmetric about its midpoint: only the half from X to the
// midpoint is stored (editable); the other half is its exact point
// reflection. The four vertices are free (any simple quadrilateral).

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

const S = 150; // reference size: the drawing is normalized to area S*S
// Tile-local coordinates; the drawing is centred on (S/2, S/2).

// Quadrilateral skeleton [A, B, C, D], cyclic order with positive signed area
// (clockwise on screen). Edge i runs quad[i] -> quad[i + 1].
let quad = [];

// Control points of the editable half of each edge (vertex -> midpoint).
// Each is { t, d, a } in units of that half-edge's length L:
//   t = position along the half-edge where the point was created
//   a = extra movement along it (0 for fitted points)
//   d = perpendicular offset
// so points ride on their edge when vertices move. Points move freely in
// 2D; validity checks (not ordering rules) keep the outline simple.
let halfEdges = [[], [], [], []];

let selected = null; // { edge: 0..3, pt } or { vertex: 0..3 }
let dragging = false;

let hasTile = false;    // true once GENERATE succeeded
let ghostContour = [];  // normalized freehand outline, in tile-local coords
let ghostFeatures = []; // its tips and indentations (see contourFeatures)

// Freehand state: one closed outline, stored in canvas coordinates.
let freehandPoints = [];
let isDrawingStroke = false;

const BLUE = "#3d6ee8";
const PINK = "#e8457a";
const GREEN = "#1f9e74";
const AMBER = "#d9971c";
const EDGE_COLORS = [BLUE, PINK, GREEN, AMBER]; // edges AB, BC, CD, DA
const VERTEX_RED = "#e5322d";
const GRAY = "#bbbbbb";
const TILE_FILL = "#ecebe7";

const PALETTES = [
  ["#111111", "#555555", "#3f4ee8", "#ffffff"], // black / gray / blue / white
  ["#111111", "#ffffff", "#e23b3b", "#f4a7c3"], // black / white / red / pink
  ["#1c2541", "#f2e8cf", "#e8772e", "#7a4a2b"], // navy / cream / orange / brown
  ["#A8DADC", "#F1FAEE", "#FFB4A2", "#BDB2FF"], // pastel: light blue / off-white / coral / lavender
  ["#283618", "#606C38", "#DDA15E", "#FEFAE0"], // earth: forest / olive / sand / cream
  ["#264653", "#2A9D8F", "#E9C46A", "#F4A261"], // retro: dark teal / turquoise / yellow / orange
];
let palette = PALETTES[0];

// Tile outline overlay in the tessellation (separate from the palette).
let outlineMode = "none"; // "none" | "white" | "black"
let outlineWeight = 3;    // visible width in px

const SAMPLES_PER_SEGMENT = 10;
const CLICK_DIST = 10;

// Skeleton limits.
const MIN_QUAD_AREA = 0.15 * S * S;
const MIN_SIDE = 0.15 * S;
const MIN_ANGLE = Math.PI / 18;  // interior angles stay within (10deg, 350deg)
const VIEW_RADIUS = 190;         // dragged vertices stay near the panel centre
const POINT_LIMIT = { uMin: -0.3, uMax: 1.3, w: 1.2 }; // control point bounds (x L)
// End tangents of an edge pair are aligned when they already differ by less
// than this, so the curve network runs smoothly through the vertex.
const SNAP_COS = Math.cos(Math.PI * 25 / 180);

// Freehand processing / fitting parameters (kept small so GENERATE is quick).
const SIMPLIFY_EPS = 1.5;      // Ramer-Douglas-Peucker tolerance, in pixels
const CONTOUR_SAMPLES = 96;    // evenly spaced points on the normalized contour
const VERTEX_STEP = 2;         // vertex candidates: every 2nd contour point
const ARC_MIN = 4, ARC_MAX = 24; // arc length between vertices, in candidate steps (of 48)
const ARC_SAMPLES = 16;        // samples per arc when measuring its asymmetry
const FIT_ARC_SAMPLES = 32;    // samples per arc when building the tile
const FIT_CANDIDATES = 40;     // vertex sets scored as (fast) polyline tiles
const FIT_POLISH = 4;          // best of those whose vertices are then optimized
const VERTEX_STEPS = [10, 5, 2.5]; // vertex search step sizes (px)
const FIT_RDP_EPS = 1.2;       // detail kept in each fitted half-edge (px)
const MAX_FIT_CP = 6;          // control points per fitted half-edge

const IOU_ROWS = 40;           // scan lines for the silhouette comparison
const IOU_WEIGHT = 0.25 * S;   // error (px) per unit of (1 - IoU)
const FEATURE_WEIGHT = 0.5;    // error per px of distance from a tip/indentation
const SMOOTH_WEIGHT = 0.1;     // error (px) per radian of curve turning

const TESS_SCALE = 0.5;

function setup() {
  createCanvas(1200, 446).parent("canvas-holder");
  quad = defaultQuad();

  document.getElementById("clear-btn").onclick = clearAll;
  document.getElementById("generate-btn").onclick = generateTile;
  document.getElementById("refine-btn").onclick = refineTile;
  document.getElementById("cursor-btn").onclick = () => setTool(null);
  document.getElementById("brush-btn").onclick = () => setTool(toolMode === "brush" ? null : "brush");
  document.getElementById("eraser-btn").onclick = () => setTool(toolMode === "eraser" ? null : "eraser");
  document.getElementById("size-slider").oninput = e => {
    brushSize = Number(e.target.value);
    document.getElementById("size-value").textContent = brushSize;
  };
  buildPaletteButtons();
  setupFullscreen();
  setupOutlineControls();
  setStatus("Draw one closed outline in the left panel.");

  noLoop(); // the sketch only redraws when something changes
}

function draw() {
  background(255);
  drawPanelLabels();
  drawFreehandPanel();
  const b = hasTile ? buildTileBoundary() : null;
  const detail = b ? prepareDetails(b) : null; // deformed strokes + tile clip, once per frame
  drawTilePanel(b, detail);
  drawTessellationPanel(b, detail);
  document.getElementById("refine-btn").disabled = !hasTile;
  document.getElementById("fullscreen-btn").disabled = !hasTile;
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function defaultQuad() {
  return [createVector(0, 0), createVector(S, 0), createVector(S, S), createVector(0, S)];
}

// ---------------------------------------------------------------------------
// Half-edge frames: control point <-> tile-local position
// ---------------------------------------------------------------------------

// Editable half of edge i: from X = quad[i] to the midpoint M of X -> Y.
// L = |M - X|, dir = unit X -> M, n = (-dir.y, dir.x).
function halfFrame(i) {
  const X = quad[i], Y = quad[(i + 1) % 4];
  const M = p5.Vector.lerp(X, Y, 0.5);
  const L = p5.Vector.dist(X, M);
  const dir = p5.Vector.sub(M, X).div(L);
  return { X, Y, M, L, dir, n: createVector(-dir.y, dir.x) };
}

// X + dir * ((t + a) * L) + n * (d * L)
function framePoint(f, p) {
  const u = (p.t + (p.a || 0)) * f.L, w = p.d * f.L;
  return createVector(f.X.x + f.dir.x * u + f.n.x * w, f.X.y + f.dir.y * u + f.n.y * w);
}

// Inverse of framePoint: tile-local m -> { u, w } in units of L.
function frameCoords(f, m) {
  const dx = m.x - f.X.x, dy = m.y - f.X.y;
  return { u: (dx * f.dir.x + dy * f.dir.y) / f.L, w: (dx * f.n.x + dy * f.n.y) / f.L };
}

// Point reflection about M (the half-turn), computed exactly.
function halfTurn(p, M) {
  return createVector(2 * M.x - p.x, 2 * M.y - p.y);
}

// ---------------------------------------------------------------------------
// Smooth curves (Catmull-Rom via p5's curvePoint)
// ---------------------------------------------------------------------------

// Samples a Catmull-Rom spline through the given points (endpoints included).
// By default the first and last points are repeated as phantom points; a
// caller may pass a different phantom to set the starting tangent. The
// curve always starts and ends exactly at pts[0] and pts[last].
function sampleCurve(pts, before = pts[0], after = pts[pts.length - 1]) {
  const all = [before, ...pts, after];
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

// ---------------------------------------------------------------------------
// Tile boundary (the edge-matching construction)
// ---------------------------------------------------------------------------

// Direction in which edge i leaves its first vertex (toward its first knot).
function startDirection(i) {
  const f = halfFrame(i);
  const first = halfEdges[i].length ? framePoint(f, halfEdges[i][0]) : f.M;
  return p5.Vector.sub(first, f.X).normalize();
}

// Vertex tangents. In the tiling, edge AB passes through each vertex into a
// copy of edge CD (and BC into a copy of DA), so the curve network is smooth
// there when tangent(AB) = -tangent(CD) and tangent(BC) = -tangent(DA).
// Where the fitted curves already nearly agree (< 25 deg) both are snapped
// to their average; larger differences are real corners (tips) and are
// kept. This only changes end tangents, never the vertices or the matching.
function vertexTangents() {
  const d = [0, 1, 2, 3].map(startDirection);
  const out = d.map(v => v.copy());
  for (const i of [0, 1]) {
    const a = d[i], b = p5.Vector.mult(d[i + 2], -1);
    if (a.dot(b) > SNAP_COS) {
      out[i] = p5.Vector.add(a, b).normalize();
      out[i + 2] = p5.Vector.mult(out[i], -1);
    }
  }
  return out;
}

// The editable half of edge i: Catmull-Rom through X, its control points
// and M, leaving X along tangents[i] (a phantom point sets the tangent).
function halfCurve(i, tangents) {
  const f = halfFrame(i);
  const knots = [f.X, ...halfEdges[i].map(p => framePoint(f, p)), f.M];
  const reach = p5.Vector.dist(knots[1], f.X);
  return sampleCurve(knots, p5.Vector.sub(knots[1], p5.Vector.mult(tangents[i], reach)));
}

// Full edge i, X -> Y: the authoritative half plus its half-turn about M
// (reversed, so it runs M -> Y). The neighbour across this edge is the tile
// half-turned about M, whose copy of the edge is exactly this point set.
function edgeCurve(i, tangents) {
  const f = halfFrame(i), first = halfCurve(i, tangents);
  const second = first.map(p => halfTurn(p, f.M)).reverse();
  return [...first, ...second.slice(1)];
}

// Closed boundary: edges AB, BC, CD, DA.
function buildTileBoundary() {
  const tangents = vertexTangents();
  return [0, 1, 2, 3].map(i => edgeCurve(i, tangents));
}

function flattenBoundary(b) {
  return b.flat();
}

function drawPolyline(pts) {
  beginShape();
  noFill();
  for (const p of pts) vertex(p.x, p.y);
  endShape();
}

// g = where to draw: the main sketch (default) or the fullscreen surface.
function drawTileFill(b, fillColor, g = p5.instance) {
  g.fill(fillColor);
  g.beginShape();
  for (const p of flattenBoundary(b)) g.vertex(p.x, p.y);
  g.endShape(CLOSE);
}

// Translation lattice of the tiling: two half-turns compose to a translation,
// H(mid BC) after H(mid AB) = +(C - A) and H(mid CD) after H(mid BC) = +(D - B).
// The plane is covered by T + i*u + j*v and T' + i*u + j*v, where T' is the
// tile half-turned about m = mid(AB).
function tilingLattice() {
  return {
    u: p5.Vector.sub(quad[2], quad[0]),
    v: p5.Vector.sub(quad[3], quad[1]),
    m: p5.Vector.lerp(quad[0], quad[1], 0.5),
  };
}

// ---------------------------------------------------------------------------
// Geometric validation
// ---------------------------------------------------------------------------

const isFinitePoint = p => isFinite(p.x) && isFinite(p.y);

// A usable skeleton: finite, positive signed area (fixed cyclic order),
// simple (opposite sides don't cross), no tiny sides, no needle angles.
// Concave quadrilaterals are allowed.
function quadOk(q = quad) {
  if (!q.every(isFinitePoint) || polygonArea(q) < MIN_QUAD_AREA) return false;
  if (segmentsCross(q[0], q[1], q[2], q[3]) || segmentsCross(q[1], q[2], q[3], q[0])) return false;
  for (let i = 0; i < 4; i++) {
    const X = q[i], next = q[(i + 1) % 4], prev = q[(i + 3) % 4];
    if (p5.Vector.dist(X, next) < MIN_SIDE) return false;
    const nx = next.x - X.x, ny = next.y - X.y, px = prev.x - X.x, py = prev.y - X.y;
    let ang = Math.atan2(nx * py - ny * px, nx * px + ny * py);
    if (ang < 0) ang += TWO_PI;
    if (ang < MIN_ANGLE || ang > TWO_PI - MIN_ANGLE) return false;
  }
  return true;
}

// The full check, used for every edit, fit candidate and REFINE step.
function tileIsValid() {
  if (!quadOk()) return false;
  const b = buildTileBoundary(), poly = flattenBoundary(b);
  if (!poly.every(isFinitePoint)) return false;
  if (!boundaryClosed(b) || !edgesMatch(b)) return false;
  if (polygonSelfIntersects(poly)) return false;
  if (!latticeConsistent(poly)) return false;
  return !overlapsNeighbours(poly);
}

// Each edge starts at its vertex and ends where the next edge starts.
function boundaryClosed(b) {
  return b.every((e, i) => p5.Vector.dist(e[0], quad[i]) < 1e-9 &&
    p5.Vector.dist(e[e.length - 1], b[(i + 1) % 4][0]) < 1e-9);
}

// Each edge equals its own half-turn about its midpoint, i.e. the shared
// boundary of the two neighbouring copies is the same point set.
function edgesMatch(b) {
  return b.every((e, i) => {
    const M = halfFrame(i).M;
    return e.every((p, k) => {
      const q = e[e.length - 1 - k];
      return abs(2 * M.x - p.x - q.x) + abs(2 * M.y - p.y - q.y) < 1e-6;
    });
  });
}

// The lattice cell holds exactly two tiles: |u x v| = 2 * tile area.
function latticeConsistent(poly) {
  const { u, v } = tilingLattice();
  const cell = abs(u.x * v.y - u.y * v.x), tile = abs(polygonArea(poly));
  return abs(cell - 2 * tile) < 1e-6 * cell;
}

// Checks the actual neighbouring copies (both orientations, one lattice step
// in every direction): no point of a copy may lie strictly inside the tile.
// Points a copy shares with the tile (matching edges, vertices) are skipped.
function overlapsNeighbours(poly) {
  const { u, v, m } = tilingLattice();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grid = new Map(); // tile points hashed in 1px cells, for the shared-point test
  for (const p of poly) {
    x0 = min(x0, p.x); y0 = min(y0, p.y); x1 = max(x1, p.x); y1 = max(y1, p.y);
    const key = `${Math.floor(p.x)},${Math.floor(p.y)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }
  const shared = (x, y) => {
    for (let gx = Math.floor(x) - 1; gx <= Math.floor(x) + 1; gx++) {
      for (let gy = Math.floor(y) - 1; gy <= Math.floor(y) + 1; gy++) {
        const cell = grid.get(`${gx},${gy}`);
        if (cell && cell.some(p => abs(p.x - x) < 0.01 && abs(p.y - y) < 0.01)) return true;
      }
    }
    return false;
  };
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const ox = i * u.x + j * v.x, oy = i * u.y + j * v.y;
      for (const turned of [false, true]) {
        if (!turned && i === 0 && j === 0) continue;
        for (const q of poly) {
          const x = (turned ? 2 * m.x - q.x : q.x) + ox, y = (turned ? 2 * m.y - q.y : q.y) + oy;
          if (x <= x0 || x >= x1 || y <= y0 || y >= y1 || shared(x, y)) continue;
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
// (aspect ratio preserved) so it encloses S*S, a comfortable size for the
// middle panel.
function normalizeContour(pts) {
  const c = polygonCentroid(pts);
  const k = S / sqrt(abs(polygonArea(pts)));
  return pts.map(p => ({ x: (p.x - c.x) * k, y: (p.y - c.y) * k }));
}

// ---------------------------------------------------------------------------
// STEP D: contour fitting
// ---------------------------------------------------------------------------
//
// 1. Pick four points of the drawing as the vertices A, B, C, D.
// 2. Between two vertices the drawing follows some arc. The edge there must
//    be centrally symmetric about the chord midpoint; the closest such curve
//    (least squares) is the average of the arc and its own point reflection,
//    s(k) = (p(k) + H(p(m - k))) / 2. Its error is the arc's asymmetry.
// 3. Search vertex quadruples for the smallest total asymmetry and score the
//    best ones as polyline tiles with fitError().
// 4. Move the vertices of the best few off the contour (hill climbing): a
//    symmetric edge is an S-curve with zero net area, so on a convex outline
//    the vertices must sit slightly off the drawing for the S-curves to
//    straddle it instead of cutting the bulges off.
// 5. Turn the winner into control points (Ramer-Douglas-Peucker keeps tips)
//    and run the full validation; if it fails, displacements are reduced
//    toward the chords until it passes.
// Every candidate obeys the tiling construction before it is scored.

function generateTile() {
  if (freehandPoints.length === 0) {
    setStatus("Draw an outline first.");
    return;
  }
  try {
    const simplified = simplifyClosed(freehandPoints, SIMPLIFY_EPS);
    let contour = normalizeContour(resampleClosed(simplified, CONTOUR_SAMPLES));
    if (polygonArea(contour) < 0) contour.reverse(); // same cyclic order as the skeleton
    const target = contour.map(p => ({ x: p.x + S / 2, y: p.y + S / 2 }));
    const fit = fitQuadTile(target);
    if (fit) {
      applyFit(fit, target);
      setTool(null); // a new tile starts in cursor (edit) mode
      setStatus(`Tile generated: ${halfEdges.map(h => h.length).join(" + ")} control points on the four edges.`);
    } else {
      clearTile();
      setStatus("Could not fit a valid tile to this outline — please redraw a simpler shape.");
    }
  } catch (err) {
    console.warn("Fitting failed:", err);
    clearTile();
    setStatus("Could not fit this outline — please redraw.");
  }
  redraw();
}

// Point at fractional index s along the (uniformly resampled) contour.
function contourAt(target, s) {
  const n = target.length, i = Math.floor(s), f = s - i;
  const a = target[((i % n) + n) % n], b = target[(((i + 1) % n) + n) % n];
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// The arc from contour index i0, `span` indices long, as m + 1 points.
function contourArc(target, i0, span, m) {
  const out = [];
  for (let k = 0; k <= m; k++) out.push(contourAt(target, i0 + (span * k) / m));
  return out;
}

// Mean distance between the arc and its symmetrized version (step 2).
function arcAsymmetry(arc) {
  const m = arc.length - 1, X = arc[0], Y = arc[m];
  const mx = X.x + Y.x, my = X.y + Y.y; // 2M
  let sum = 0;
  for (let k = 0; k <= m; k++) sum += Math.hypot(arc[k].x + arc[m - k].x - mx, arc[k].y + arc[m - k].y - my) / 2;
  return sum / (m + 1);
}

function fitQuadTile(target) {
  const n = target.length / VERTEX_STEP; // candidate positions
  // asymmetry error of every allowed arc, weighted by its share of the outline
  const err = [];
  for (let a = 0; a < n; a++) {
    err.push([]);
    for (let len = ARC_MIN; len <= ARC_MAX; len++) {
      const arc = contourArc(target, a * VERTEX_STEP, len * VERTEX_STEP, ARC_SAMPLES);
      err[a][len] = (arcAsymmetry(arc) * len) / n;
    }
  }
  // all vertex quadruples (k0 smallest), best total asymmetry first
  const cands = [];
  for (let k0 = 0; k0 < n; k0++) {
    for (let l1 = ARC_MIN; l1 <= ARC_MAX; l1++) {
      for (let l2 = ARC_MIN; l2 <= ARC_MAX; l2++) {
        for (let l3 = ARC_MIN; l3 <= ARC_MAX; l3++) {
          const l4 = n - l1 - l2 - l3;
          if (l4 < ARC_MIN || l4 > ARC_MAX) continue;
          const ks = [k0, k0 + l1, k0 + l1 + l2, k0 + l1 + l2 + l3].map(k => k % n);
          if (Math.min(...ks) !== k0) continue; // each quadruple once
          const e = err[ks[0]][l1] + err[ks[1]][l2] + err[ks[2]][l3] + err[ks[3]][l4];
          cands.push({ e, ks, lens: [l1, l2, l3, l4] });
        }
      }
    }
  }
  cands.sort((p, q) => p.e - q.e);

  // score the best valid skeletons as polyline tiles
  const features = contourFeatures(target), scored = [];
  for (const c of cands) {
    if (scored.length >= FIT_CANDIDATES) break;
    const q = c.ks.map(k => createVector(target[k * VERTEX_STEP].x, target[k * VERTEX_STEP].y));
    if (!quadOk(q)) continue;
    const arcs = c.ks.map((k, i) => contourArc(target, k * VERTEX_STEP, c.lens[i] * VERTEX_STEP, FIT_ARC_SAMPLES));
    const score = polyTileScore(q, arcs, target, features);
    if (isFinite(score)) scored.push({ q, arcs, score });
  }
  scored.sort((p, q) => p.score - q.score);

  // optimize the vertices of the best few, then build real tiles
  const polished = scored.slice(0, FIT_POLISH).map(c => polishVertices(c, target, features));
  polished.sort((p, q) => p.score - q.score);
  for (const c of polished) {
    quad = c.q.map(v => v.copy());
    halfEdges = c.arcs.map((arc, i) => fitHalfEdge(i, symmetricHalf(arc, quad[i], quad[(i + 1) % 4])));
    if (!tileIsValid() && !relaxUntilValid()) continue;
    return { quad: quad.map(v => v.copy()), halfEdges: halfEdges.map(h => h.map(p => ({ ...p }))) };
  }
  return null;
}

// First half (X .. M) of the centrally symmetric curve closest to the arc:
// s(k) = (p(k) + 2M - p(m - k)) / 2, then shifted so it starts exactly at X
// (the shift fades out toward M, so the vertex may lie off the drawing).
function symmetricHalf(arc, X, Y) {
  const m = arc.length - 1, mx = X.x + Y.x, my = X.y + Y.y; // 2M
  const half = [];
  for (let k = 0; k <= m / 2; k++) half.push({ x: (arc[k].x + mx - arc[m - k].x) / 2, y: (arc[k].y + my - arc[m - k].y) / 2 });
  const cx = X.x - half[0].x, cy = X.y - half[0].y;
  return half.map((p, k) => ({ x: p.x + cx * (1 - (2 * k) / m), y: p.y + cy * (1 - (2 * k) / m) }));
}

// The polyline tile for skeleton q and arcs: each half plus its point
// reflection, edge after edge. Infinity if invalid.
function polyTileScore(q, arcs, target, features) {
  if (!quadOk(q)) return Infinity;
  const poly = [], halves = [];
  arcs.forEach((arc, i) => {
    const X = q[i], Y = q[(i + 1) % 4], h = symmetricHalf(arc, X, Y);
    halves.push(h);
    poly.push(...h.slice(0, -1));
    for (let k = h.length - 1; k > 0; k--) poly.push({ x: X.x + Y.x - h[k].x, y: X.y + Y.y - h[k].y });
  });
  if (polygonSelfIntersects(poly)) return Infinity;
  return fitError(poly, target, halves.reduce((s, h) => s + curveTurning(h), 0), features);
}

// Hill climbing on the four vertex positions (the arcs stay the same).
function polishVertices(c, target, features) {
  let q = c.q.map(v => v.copy()), best = c.score;
  for (const step of VERTEX_STEPS) {
    for (let pass = 0, improved = true; improved && pass < 6; pass++) {
      improved = false;
      for (let i = 0; i < 4; i++) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const trial = q.map(v => v.copy());
          trial[i].add(dx * step, dy * step);
          const score = polyTileScore(trial, c.arcs, target, features);
          if (score < best) {
            best = score;
            q = trial;
            improved = true;
          }
        }
      }
    }
  }
  return { q, arcs: c.arcs, score: best };
}

// Control points for edge i from its symmetric half polyline, reduced with
// Ramer-Douglas-Peucker so sharp tips survive while small wiggles go.
function fitHalfEdge(i, half) {
  let eps = FIT_RDP_EPS, kept = rdp(half, eps);
  while (kept.length - 2 > MAX_FIT_CP) kept = rdp(half, (eps *= 1.4));
  const f = halfFrame(i);
  return kept.slice(1, -1).map(p => {
    const c = frameCoords(f, p);
    return { t: c.u, d: c.w, a: 0 };
  });
}

// If the smooth tile fails validation (e.g. very spiky input), pull every
// control point toward its chord step by step. Gives up (false) rather than
// returning invalid geometry.
function relaxUntilValid() {
  for (let k = 0; k < 8; k++) {
    for (const p of halfEdges.flat()) p.d *= 0.8;
    if (tileIsValid()) return true;
  }
  return false;
}

function applyFit(fit, target) {
  quad = fit.quad;
  halfEdges = fit.halfEdges;
  ghostContour = target;
  ghostFeatures = contourFeatures(target);
  selected = null;
  hasTile = true;
  detailStrokes = []; // a new tile starts with an empty drawing layer
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

// Similarity objective for fitting and REFINE (lower is better), in tile-local
// px. The tile outline is resampled to the same density as the target.
//   contour term:    Chamfer distance between the outlines
//   silhouette term: 1 - IoU of the filled shapes (proportions, big
//                    indentations)
//   feature term:    mean distance from the drawing's tips and indentations
//                    to the tile outline (keeps ears, tails, notches)
//   smoothness term: total turning of the editable curves (discourages wiggles)
function fitError(poly, target, turning, features = []) {
  const outline = resampleClosed(poly, CONTOUR_SAMPLES);
  let feature = 0;
  for (const f of features) {
    let best = Infinity;
    for (const p of poly) best = min(best, (p.x - f.x) ** 2 + (p.y - f.y) ** 2);
    feature += sqrt(best) / features.length;
  }
  return chamfer(outline, target)
    + IOU_WEIGHT * (1 - silhouetteIoU(poly, target))
    + FEATURE_WEIGHT * feature
    + SMOOTH_WEIGHT * turning;
}

// Tips and indentations of a closed contour: the points that turn most
// sharply (over a +-3 sample window), at most 8, local maxima only.
function contourFeatures(pts) {
  const n = pts.length, turn = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 3 + n) % n], b = pts[i], c = pts[(i + 3) % n];
    const t1 = Math.atan2(b.y - a.y, b.x - a.x), t2 = Math.atan2(c.y - b.y, c.x - b.x);
    turn.push(abs(Math.atan2(Math.sin(t2 - t1), Math.cos(t2 - t1))));
  }
  const peaks = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] > 0.6 && turn[i] >= turn[(i - 1 + n) % n] && turn[i] >= turn[(i + 1) % n]) peaks.push(i);
  }
  return peaks.sort((p, q) => turn[q] - turn[p]).slice(0, 8).map(i => pts[i]);
}

// Shape error of the current tile against a target (fitting and REFINE).
function shapeScore(target = ghostContour, features = ghostFeatures) {
  const tangents = vertexTangents();
  const turning = [0, 1, 2, 3].reduce((s, i) => s + curveTurning(halfCurve(i, tangents)), 0);
  return fitError(flattenBoundary(buildTileBoundary()), target, turning, features);
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

// ---------------------------------------------------------------------------
// REFINE: hill climbing on the current control points
// ---------------------------------------------------------------------------

const REFINE_TRIALS = 150;
const REFINE_STEP = 0.06; // largest change per trial, in units of the half-edge length

// Same objective as fitting, on the current tile (vertices as the user left them).
function tileScore() {
  return shapeScore();
}

// Nudges one control point per trial (along or across its half-edge) and
// keeps the nudge only if the tile gets closer to the drawing AND passes the
// full validity check (checked only for improvements, since it is the
// costlier test). Vertices and the point count never change.
function refineTile() {
  if (!hasTile) return;
  const pts = halfEdges.flat();
  if (pts.length === 0) {
    setStatus("No control points to refine — click a curve to add one.");
    return;
  }
  const start = tileScore();
  let best = start;
  for (let i = 0; i < REFINE_TRIALS; i++) {
    const p = random(pts);
    const old = { a: p.a || 0, d: p.d };
    const step = random(-REFINE_STEP, REFINE_STEP);
    if (random() < 0.5) p.d = constrain(old.d + step, -POINT_LIMIT.w, POINT_LIMIT.w);
    else p.a = constrain(p.t + old.a + step, POINT_LIMIT.uMin, POINT_LIMIT.uMax) - p.t;
    const score = tileScore();
    if (score < best && tileIsValid()) best = score; // NaN also fails
    else Object.assign(p, old);
  }
  setStatus(`Refined: shape error ${start.toFixed(2)} → ${best.toFixed(2)}.`);
  redraw();
}

// ---------------------------------------------------------------------------
// 02 / GENERATED TILE
// ---------------------------------------------------------------------------

// Tile-local frame -> middle panel (the tile is shown in the drawing's
// orientation, centred on the panel).
function applyTileView() {
  const p = PANELS.tile;
  translate(p.x + p.w / 2 - S / 2, p.y + p.h / 2 - S / 2);
}

// Inverse of applyTileView, for mouse interaction.
function screenToTile(x, y) {
  const p = PANELS.tile;
  return createVector(x - (p.x + p.w / 2) + S / 2, y - (p.y + p.h / 2) + S / 2);
}

function drawTilePanel(b, detail) {
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

  // drawn details: always black here, clipped to the tile
  drawDetails(detail, "#000000");

  // the normalized freehand outline, dashed, for comparison
  stroke(GRAY);
  strokeWeight(1);
  noFill();
  drawingContext.setLineDash([4, 4]);
  beginShape();
  for (const q of ghostContour) vertex(q.x, q.y);
  endShape(CLOSE);
  drawingContext.setLineDash([]);

  // editable half of each edge thick, its derived half-turn copy thin
  b.forEach((e, i) => {
    const mid = (e.length - 1) / 2;
    stroke(EDGE_COLORS[i]);
    strokeWeight(3);
    drawPolyline(e.slice(0, mid + 1));
    strokeWeight(1.5);
    drawPolyline(e.slice(mid));
  });

  // edge midpoints: fixed half-turn centres
  stroke(0);
  strokeWeight(1);
  fill(255);
  for (let i = 0; i < 4; i++) {
    const M = halfFrame(i).M;
    square(M.x - 2.5, M.y - 2.5, 5);
  }

  // draggable vertices (red), slightly larger than the control points
  strokeWeight(1.5);
  stroke(VERTEX_RED);
  quad.forEach((c, i) => {
    fill(selected && selected.vertex === i ? VERTEX_RED : 255);
    circle(c.x, c.y, 11);
  });

  halfEdges.forEach((list, i) => {
    const f = halfFrame(i);
    for (const q of list) drawControlPoint(framePoint(f, q), EDGE_COLORS[i], selected && selected.pt === q);
  });

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

// Every copy uses the same boundary b: the tile T at each i*u + j*v, and its
// half-turn T' (about mid AB) at each i*u + j*v. Each edge neighbour of a T
// is a T' and vice versa, so T uses palette colours 1/3 and T' 2/4: tiles
// sharing an edge never get the same colour.
// The drawing is part of the tile: it is drawn inside the same
// push/translate/rotate as each copy, so half-turned copies show it turned
// by 180 degrees, in a contrast colour for that copy's fill.
function drawTessellationPanel(b, detail) {
  const p = PANELS.tess;
  if (b) renderTessellation(p5.instance, b, detail, p);
  drawFrame(p);
}

// Draws the tessellation into g (the main sketch or the fullscreen surface),
// clipped to the rectangle view and centred on it, at scaleFactor (TESS_SCALE
// unless the fullscreen DENSITY slider changes it). The
// 03 panel and the fullscreen view both use this, so they always match.
// Pass 1 draws fills and details; pass 2 the optional tile outlines.
function renderTessellation(g, b, detail, view, scaleFactor = TESS_SCALE) {
  const { u, v, m } = tilingLattice();
  const poly = flattenBoundary(b);
  const size = Math.max(...poly.map(q => dist(q.x, q.y, S / 2, S / 2)));
  const reach = dist(0, 0, view.w / 2, view.h / 2) / scaleFactor + 2 * size; // tile units
  const cell = abs(u.x * v.y - u.y * v.x);
  // i = cross(x, v) / cross(u, v), so |i| <= reach * |v| / cell (same for j)
  const ni = ceil((reach * v.mag()) / cell) + 1, nj = ceil((reach * u.mag()) / cell) + 1;
  const lineColors = palette.map(detailColorForFill);

  const ctx = g.drawingContext;
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x, view.y, view.w, view.h);
  ctx.clip();
  g.push();
  g.translate(view.x + view.w / 2, view.y + view.h / 2);
  g.scale(scaleFactor);
  g.translate(-S / 2, -S / 2);
  g.stroke(17);
  g.strokeWeight(1.2); // scaled by scaleFactor
  const offsets = [];
  for (let i = -ni; i <= ni; i++) {
    for (let j = -nj; j <= nj; j++) {
      const ox = i * u.x + j * v.x, oy = i * u.y + j * v.y;
      if (dist(0, 0, ox, oy) > reach) continue;
      offsets.push([ox, oy]);
      const c = abs(i + j) % 2 === 0 ? 0 : 2;
      g.push();
      g.translate(ox, oy);
      drawTileFill(b, palette[c], g);
      drawDetails(detail, lineColors[c], g);
      g.translate(m.x, m.y);
      g.rotate(PI);
      g.translate(-m.x, -m.y);
      drawTileFill(b, palette[c + 1], g);
      drawDetails(detail, lineColors[c + 1], g);
      g.pop();
    }
  }
  drawTileOutlines(g, detail, offsets, scaleFactor);
  g.pop();
  ctx.restore();
}

// Tile outlines along the exact tile boundary (the same closed path used to
// clip the details). Every edge neighbour of an upright tile T is a
// half-turned T' and vice versa, so stroking only the upright copies draws
// every shared edge exactly once: no doubled width, no seams. Drawn after
// all fills so no neighbour covers half of a line. The width is divided by
// the display scale so the visible width is outlineWeight px in the preview
// and in fullscreen alike (at any density).
function drawTileOutlines(g, detail, offsets, scaleFactor = TESS_SCALE) {
  if (outlineMode === "none" || !detail) return;
  const ctx = g.drawingContext;
  ctx.save();
  ctx.strokeStyle = outlineMode === "white" ? "#ffffff" : "#000000";
  ctx.lineWidth = outlineWeight / scaleFactor;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const [ox, oy] of offsets) {
    ctx.translate(ox, oy);
    ctx.stroke(detail.clip);
    ctx.translate(-ox, -oy);
  }
  ctx.restore();
}

// NONE / WHITE / BLACK buttons and the WEIGHT slider under the 03 panel.
function setupOutlineControls() {
  document.querySelectorAll(".outline-opt").forEach(btn => {
    btn.onclick = () => {
      outlineMode = btn.dataset.mode;
      document.querySelectorAll(".outline-opt").forEach(b => b.classList.toggle("active", b === btn));
      refreshTessellation();
    };
  });
  document.getElementById("outline-slider").oninput = e => {
    outlineWeight = Number(e.target.value);
    document.getElementById("outline-value").textContent = outlineWeight;
    refreshTessellation();
  };
}

function refreshTessellation() {
  redraw();
  if (fullscreenOpen) renderFullscreen();
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
  quad = defaultQuad();
  halfEdges = [[], [], [], []];
  selected = null;
  dragging = false;
  ghostContour = [];
  ghostFeatures = [];
  detailStrokes = [];
  detailGesture = false;
}

function clearAll() {
  freehandPoints = [];
  isDrawingStroke = false;
  clearTile();
  setTool(null);
  setStatus("Draw one closed outline in the left panel.");
  redraw();
}

function mousePressed() {
  if (fullscreenOpen) return; // the editor is hidden behind the fullscreen view
  if (insidePanel(PANELS.draw, mouseX, mouseY)) {
    startStroke();
  } else if (hasTile && insidePanel(PANELS.tile, mouseX, mouseY)) {
    const m = screenToTile(mouseX, mouseY);
    if (toolMode) startDetailGesture(m); // brush / eraser
    else pressTile(m);                   // geometry editing
  } else if (mouseX >= 0 && mouseY >= 0 && mouseX <= width && mouseY <= height) {
    selected = null;
  } else {
    return; // clicks on the HTML buttons below the canvas
  }
  redraw();
}

// Editing in tile-local coordinates m. Vertices take priority, so clicking
// one never adds a control point.
function pressTile(m) {
  const v = quad.findIndex(c => dist(m.x, m.y, c.x, c.y) < CLICK_DIST);
  if (v >= 0) {
    selected = { vertex: v };
    dragging = true;
    return;
  }
  for (let i = 0; i < 4; i++) {
    const f = halfFrame(i);
    for (const p of halfEdges[i]) {
      const pos = framePoint(f, p);
      if (dist(m.x, m.y, pos.x, pos.y) < CLICK_DIST) {
        selected = { edge: i, pt: p };
        dragging = true;
        return;
      }
    }
  }
  // add a point on an editable (first) half
  const tangents = vertexTangents();
  for (let i = 0; i < 4; i++) {
    const curve = halfCurve(i, tangents);
    if (nearCurve(m, curve) && addControlPoint(i, m, curve)) return;
  }
  selected = null;
}

// Inserts a point at m on half-edge i. Its array position comes from the
// nearest sampled curve segment (segment s runs from knot s to knot s + 1).
function addControlPoint(i, m, curve) {
  let k = 0;
  curve.forEach((q, j) => {
    if (dist(m.x, m.y, q.x, q.y) < dist(m.x, m.y, curve[k].x, curve[k].y)) k = j;
  });
  const list = halfEdges[i];
  const at = min(floor(k / SAMPLES_PER_SEGMENT), list.length);
  const c = frameCoords(halfFrame(i), m);
  const p = { t: c.u, d: c.w, a: 0 };
  list.splice(at, 0, p);
  if (!tileIsValid()) {
    list.splice(at, 1);
    return false;
  }
  selected = { edge: i, pt: p };
  dragging = true;
  return true;
}

function nearCurve(m, pts) {
  return pts.some(p => dist(m.x, m.y, p.x, p.y) < CLICK_DIST);
}

// Runs apply(f) for f = 1 (the requested move); if the tile becomes invalid,
// binary-searches f in [0, 1] for the farthest valid position on the way.
function moveWithinValid(apply) {
  apply(1);
  if (tileIsValid()) return;
  let lo = 0, hi = 1;
  for (let k = 0; k < 6; k++) {
    const mid = (lo + hi) / 2;
    apply(mid);
    if (tileIsValid()) lo = mid;
    else hi = mid;
  }
  apply(lo);
}

function mouseDragged() {
  if (fullscreenOpen) return;
  if (isDrawingStroke) {
    extendStroke();
    redraw();
    return;
  }
  if (detailGesture) {
    continueDetailGesture(screenToTile(mouseX, mouseY));
    redraw();
    return;
  }
  if (!dragging || !selected) return;
  const m = screenToTile(mouseX, mouseY);
  if (selected.vertex !== undefined) {
    // vertex: moves freely; the half-edges, their mirrored halves, the
    // neighbour transforms and the lattice all follow from the skeleton
    const vtx = quad[selected.vertex], start = vtx.copy();
    if (dist(m.x, m.y, S / 2, S / 2) > VIEW_RADIUS) return;
    moveWithinValid(f => vtx.set(lerp(start.x, m.x, f), lerp(start.y, m.y, f)));
  } else {
    // control point: follows the cursor in 2D (along and across its half-edge)
    const p = selected.pt, c = frameCoords(halfFrame(selected.edge), m);
    const start = { a: p.a || 0, d: p.d };
    const target = {
      a: constrain(c.u, POINT_LIMIT.uMin, POINT_LIMIT.uMax) - p.t,
      d: constrain(c.w, -POINT_LIMIT.w, POINT_LIMIT.w),
    };
    moveWithinValid(f => Object.assign(p, { a: lerp(start.a, target.a, f), d: lerp(start.d, target.d, f) }));
  }
  redraw();
}

function mouseReleased() {
  if (fullscreenOpen) return;
  if (isDrawingStroke) finishStroke();
  dragging = false;
  detailGesture = false;
  activeDetailStroke = null;
  redraw();
}

function keyPressed() {
  if (fullscreenOpen) return;
  if (selected && selected.pt && (keyCode === BACKSPACE || keyCode === DELETE)) {
    const list = halfEdges[selected.edge];
    const i = list.indexOf(selected.pt);
    list.splice(i, 1);
    if (!tileIsValid()) list.splice(i, 0, selected.pt); // keep it if removal breaks the tile
    else selected = null;
    redraw();
    return false; // stop the browser from navigating back on Backspace
  }
}

// ===========================================================================
// DETAIL LAYER: brush / eraser drawing inside the tile
// ===========================================================================
//
// Stroke storage: detailStrokes = [{ width, points: [{ x, y, w }] }].
// x, y are the tile-local positions recorded with screenToTile() (never
// screen space, never a colour). w are the point's mean value coordinates
// with respect to the tile "cage" at the moment it was drawn.
//
// Deformation mapping: the cage is the tile outline resampled to
// CAGE_PER_EDGE points per edge, evenly by arc length from vertex to vertex.
// (Each edge is centrally symmetric, so its arc-length halfway point is
// exactly its midpoint: vertices and midpoints are fixed landmarks, and the
// cage always has the same number of points, even when control points are
// added or removed.) Mean value coordinates reproduce a point exactly from
// the cage, vary smoothly, and work inside concave polygons. When the tile
// is edited (vertex, control point, add/delete, REFINE), every stroke point
// is rebuilt as the same weighted sum of the NEW cage, so the drawing
// deforms with the shape. Only the drawing moves; the geometry is untouched.

let detailStrokes = [];
let toolMode = null;           // null = geometry editing, "brush", "eraser"
let brushSize = 3;             // brush width / eraser size (px)
let detailGesture = false;     // a brush or eraser drag is in progress
let activeDetailStroke = null; // the stroke piece being drawn
let gestureCage = null, gesturePoly = null, lastDetailPos = null; // fixed during a drag

const CAGE_PER_EDGE = 24;
const DETAIL_SPACING = 1.5;    // px between recorded stroke points

function setTool(mode) {
  toolMode = mode;
  document.getElementById("cursor-btn").classList.toggle("active", mode === null); // cursor = geometry editing
  document.getElementById("brush-btn").classList.toggle("active", mode === "brush");
  document.getElementById("eraser-btn").classList.toggle("active", mode === "eraser");
  document.querySelector("canvas").style.cursor = mode ? "crosshair" : "";
  selected = null;
  redraw();
}

// Eraser radius grows with the same SIZE control as the brush.
function eraserRadius() {
  return brushSize * 1.5 + 2;
}

// n points evenly spaced by arc length along an open polyline, ends included.
function resampleOpen(pts, n) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y));
  const total = cum[cum.length - 1], out = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const s = (total * k) / (n - 1);
    while (j < pts.length - 1 && cum[j] < s) j++;
    const seg = cum[j] - cum[j - 1], f = seg > 0 ? constrain((s - cum[j - 1]) / seg, 0, 1) : 0;
    out.push({ x: lerp(pts[j - 1].x, pts[j].x, f), y: lerp(pts[j - 1].y, pts[j].y, f) });
  }
  return out;
}

// The deformation cage of boundary b (see above).
function buildCage(b) {
  return b.flatMap(e => resampleOpen(e, CAGE_PER_EDGE + 1).slice(0, -1));
}

// Mean value coordinates (Floater) of point x with respect to the closed
// polygon cage: weights w with sum 1 and sum(w * cage) = x.
// tan(alpha/2) is computed as cross / (r_i r_j + dot), which is stable.
function meanValueWeights(x, cage) {
  const n = cage.length, dx = [], dy = [], r = [];
  for (let i = 0; i < n; i++) {
    dx.push(cage[i].x - x.x);
    dy.push(cage[i].y - x.y);
    r.push(Math.hypot(dx[i], dy[i]));
  }
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) if (r[i] < 1e-9) { w[i] = 1; return w; } // on a cage point
  const tanHalf = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = dx[i] * dy[j] - dy[i] * dx[j], dot = dx[i] * dx[j] + dy[i] * dy[j];
    const denom = r[i] * r[j] + dot;
    if (denom < 1e-9 * r[i] * r[j]) { // x lies on segment i-j: linear blend
      w[i] = r[j] / (r[i] + r[j]);
      w[j] = r[i] / (r[i] + r[j]);
      return w;
    }
    tanHalf[i] = cross / denom;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    w[i] = (tanHalf[(i + n - 1) % n] + tanHalf[i]) / r[i];
    sum += w[i];
  }
  for (let i = 0; i < n; i++) w[i] /= sum;
  return w;
}

// Current positions of a stroke's points for the given cage.
function deformedStroke(stroke, cage) {
  return stroke.points.map(p => {
    let x = 0, y = 0;
    for (let i = 0; i < cage.length; i++) {
      x += p.w[i] * cage[i].x;
      y += p.w[i] * cage[i].y;
    }
    return { x, y };
  });
}

// Per frame: deform every stroke once and build canvas paths that all
// panels and all tessellation copies reuse.
// Tile clipping: the closed tile outline as a Path2D clip region (respects
// deep indentations); see drawDetails.
function prepareDetails(b) {
  const clip = new Path2D();
  flattenBoundary(b).forEach((q, i) => (i ? clip.lineTo(q.x, q.y) : clip.moveTo(q.x, q.y)));
  clip.closePath();
  const cage = buildCage(b);
  const paths = detailStrokes.map(s => {
    const pts = deformedStroke(s, cage), path = new Path2D();
    path.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 1) path.lineTo(pts[0].x + 0.01, pts[0].y); // a single dot
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
    return { width: s.width, path };
  });
  return { clip, paths };
}

// Draws the detail strokes in the current transform, clipped to the tile.
// save/restore keeps the clip from leaking into anything drawn afterwards.
function drawDetails(detail, lineColor, g = p5.instance) {
  if (!detail || !detail.paths.length) return;
  const ctx = g.drawingContext;
  ctx.save();
  ctx.clip(detail.clip);
  ctx.strokeStyle = lineColor;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of detail.paths) {
    ctx.lineWidth = s.width;
    ctx.stroke(s.path);
  }
  ctx.restore();
}

// Contrast colour: the relative luminance (WCAG) of the tile fill decides
// whether black or white lines contrast more with it. Stroke data never
// stores a colour; this is applied only while rendering.
function detailColorForFill(fillColor) {
  const c = color(fillColor);
  const lin = v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(red(c)) + 0.7152 * lin(green(c)) + 0.0722 * lin(blue(c));
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? "#000000" : "#ffffff";
}

// Brush / eraser press in the middle panel (tile-local m). The tile cannot
// change during a drag, so its cage and outline are computed once here.
function startDetailGesture(m) {
  const b = buildTileBoundary();
  gesturePoly = flattenBoundary(b);
  gestureCage = buildCage(b);
  detailGesture = true;
  activeDetailStroke = null;
  lastDetailPos = m;
  if (toolMode === "brush") addDetailPoint(m);
  else eraseAlong(m, m);
}

function continueDetailGesture(m) {
  if (toolMode === "brush") {
    // fill in fast mouse jumps so strokes stay dense (needed for partial erasing)
    const steps = max(1, ceil(dist(lastDetailPos.x, lastDetailPos.y, m.x, m.y) / DETAIL_SPACING));
    for (let k = 1; k <= steps; k++) {
      addDetailPoint({ x: lerp(lastDetailPos.x, m.x, k / steps), y: lerp(lastDetailPos.y, m.y, k / steps) });
    }
  } else {
    eraseAlong(lastDetailPos, m);
  }
  lastDetailPos = m;
}

// Records a brush point, only inside the tile. Leaving the tile ends the
// current piece; coming back starts a new one, so nothing is stored outside.
function addDetailPoint(m) {
  if (!pointInPolygon(m.x, m.y, gesturePoly)) {
    activeDetailStroke = null;
    return;
  }
  if (!activeDetailStroke) {
    activeDetailStroke = { width: brushSize, points: [] };
    detailStrokes.push(activeDetailStroke);
  }
  const pts = activeDetailStroke.points, last = pts[pts.length - 1];
  if (last && dist(last.x, last.y, m.x, m.y) < DETAIL_SPACING * 0.66) return;
  pts.push({ x: m.x, y: m.y, w: meanValueWeights(m, gestureCage) });
}

// Erasing: removes every stroke point within the eraser radius of the
// eraser's path (the segment from the previous to the current mouse
// position), splitting strokes there, so only the touched part disappears.
// A segment is also cut if its midpoint is inside the eraser path (for
// strokes that were stretched by deformation). Tile geometry is untouched.
function eraseAlong(a, b) {
  const r = eraserRadius(), out = [];
  let changed = false;
  for (const s of detailStrokes) {
    const pos = deformedStroke(s, gestureCage);
    let run = [];
    const flush = () => {
      if (run.length) out.push({ width: s.width, points: run });
      run = [];
    };
    pos.forEach((q, k) => {
      if (distToSegment(q, a, b) <= r) {
        changed = true;
        flush();
        return;
      }
      if (k > 0 && run.length) {
        const mid = { x: (q.x + pos[k - 1].x) / 2, y: (q.y + pos[k - 1].y) / 2 };
        if (distToSegment(mid, a, b) <= r) {
          changed = true;
          flush();
        }
      }
      run.push(s.points[k]);
    });
    flush();
  }
  if (changed) detailStrokes = out;
}

// ===========================================================================
// FULLSCREEN TESSELLATION
// ===========================================================================
//
// A fixed overlay with its own drawing surface (a p5.Graphics the size of the
// window), so the main canvas and its mouse coordinates are never touched.
// It is drawn with renderTessellation, i.e. the current tile, lattice,
// palette and detail strokes, at the same TESS_SCALE as the 03 panel: a
// bigger screen shows more tiles, not bigger ones. Closing just hides the
// overlay; no editing state is changed.

let fullscreenOpen = false;
let fullscreenSurface = null;
let densityFrame = 0;

// DENSITY slider (0..100, 50 = default): density = 2^((value - 50) / 50),
// i.e. 0.5x .. 2x, and the fullscreen display scale is TESS_SCALE / density.
// At 50 this is exactly TESS_SCALE. Only the display scale changes, never
// the tile; the slider keeps its value for the rest of the session.
function setDensityValue(v) {
  document.getElementById("density-slider").value = v;
  if (fullscreenOpen) renderFullscreen();
}

function fullscreenScale() {
  const value = Number(document.getElementById("density-slider").value);
  return TESS_SCALE / Math.pow(2, (value - 50) / 50);
}

function setupFullscreen() {
  document.getElementById("fullscreen-btn").onclick = openFullscreen;
  document.getElementById("fullscreen-close").onclick = closeFullscreen;
  document.getElementById("fullscreen-download").onclick = downloadFullscreen;
  // Snap point: releasing a pointer drag within 46..54 lands exactly on 50
  // (1x). Snapping only on release keeps dragging smooth through the centre,
  // and keyboard steps are never snapped.
  const slider = document.getElementById("density-slider");
  let pointerOnSlider = false;
  slider.addEventListener("pointerdown", () => (pointerOnSlider = true));
  slider.addEventListener("change", () => {
    const v = Number(slider.value);
    if (pointerOnSlider && v >= 46 && v <= 54 && v !== 50) setDensityValue(50);
    pointerOnSlider = false;
  });
  document.getElementById("density-reset").onclick = () => setDensityValue(50);
  document.getElementById("density-slider").oninput = () => {
    // redraw at most once per animation frame while the slider is dragged
    if (densityFrame) return;
    densityFrame = requestAnimationFrame(() => {
      densityFrame = 0;
      if (fullscreenOpen) renderFullscreen();
    });
  };
  document.addEventListener("keydown", e => {
    if (fullscreenOpen && e.key === "Escape") closeFullscreen();
  });
  // Escape in native browser fullscreen exits it without a keydown event
  document.addEventListener("fullscreenchange", () => {
    if (fullscreenOpen && !document.fullscreenElement) closeFullscreen();
  });
  window.addEventListener("resize", () => {
    if (fullscreenOpen) renderFullscreen();
  });
}

function openFullscreen() {
  if (!hasTile || fullscreenOpen) return;
  fullscreenOpen = true;
  const view = document.getElementById("fullscreen-view");
  view.hidden = false;
  document.querySelector("main").style.display = "none";
  document.body.style.overflow = "hidden";
  renderFullscreen();
  // true browser fullscreen when allowed; the overlay already covers the window otherwise
  if (view.requestFullscreen) view.requestFullscreen().catch(() => {});
}

function closeFullscreen() {
  if (!fullscreenOpen) return;
  fullscreenOpen = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  document.getElementById("fullscreen-view").hidden = true;
  document.querySelector("main").style.display = "";
  document.body.style.overflow = "";
  redraw();
}

// (Re)draws the whole window-sized tessellation with the current state.
function renderFullscreen() {
  const w = window.innerWidth, h = window.innerHeight;
  if (!fullscreenSurface) {
    fullscreenSurface = createGraphics(w, h);
    fullscreenSurface.elt.style.display = "block";
    document.getElementById("fullscreen-view").prepend(fullscreenSurface.elt);
  } else if (fullscreenSurface.width !== w || fullscreenSurface.height !== h) {
    fullscreenSurface.resizeCanvas(w, h);
  }
  const g = fullscreenSurface, b = buildTileBoundary();
  g.background(255);
  renderTessellation(g, b, prepareDetails(b), { x: 0, y: 0, w, h }, fullscreenScale());
}

// Saves exactly what the fullscreen view shows: the dedicated tessellation
// canvas (re-rendered with the current state), never the HTML buttons.
function downloadFullscreen() {
  if (!fullscreenOpen || !fullscreenSurface) return;
  renderFullscreen();
  fullscreenSurface.elt.toBlob(blob => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "tessellation.png";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, "image/png");
}
