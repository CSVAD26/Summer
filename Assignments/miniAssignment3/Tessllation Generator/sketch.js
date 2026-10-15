// Tiny tessellation generator.
// The user edits the LEFT and TOP edges of a square; the RIGHT and BOTTOM
// edges are computed from them by 90-degree rotations.

let mode = "edit"; // "edit" -> "shape" -> "tessellation"

const S = 220; // square size
let topLeft, topRight, bottomRight, bottomLeft;

// Interior control points. Each is { t, d }:
//   t = fixed position along the edge (0..1), never changes after creation
//   d = perpendicular displacement in pixels (what dragging changes)
let topControlPoints = [];
let leftControlPoints = [];

let selected = null; // { edge: "top" | "left", pt: controlPoint }
let dragging = false;

const PINK = "#e8457a";
const BLUE = "#3d6ee8";
const GRAY = "#cccccc";
const TILE_FILL = "#e9e6f7";
const PALETTE = ["#ffffff", "#2b2b2e", "#6a5acd"]; // white, charcoal, blue-violet

const SAMPLES_PER_SEGMENT = 16;
const CLICK_DIST = 10;
const MAX_DISPLACEMENT = S * 0.45;

function setup() {
  const c = createCanvas(900, 1200);
  c.parent("canvas-holder");

  const x0 = (width - S) / 2;
  const y0 = (700 - S) / 2; // tile stays centred in the original 700px top area
  topLeft = createVector(x0, y0);
  topRight = createVector(x0 + S, y0);
  bottomRight = createVector(x0 + S, y0 + S);
  bottomLeft = createVector(x0, y0 + S);

  document.getElementById("play-btn").onclick = () => {
    if (mode === "edit") setMode("shape");
    else if (mode === "shape") setMode("tessellation");
  };
  document.getElementById("return-btn").onclick = () => setMode("edit");
}

function setMode(m) {
  mode = m;
  selected = null;
  dragging = false;
  const labels = { edit: "EDIT", shape: "SHAPE", tessellation: "TESSELLATION" };
  document.getElementById("mode-label").textContent = labels[m];
}

function draw() {
  background(255);
  if (mode === "edit") drawEditMode();
  else if (mode === "shape") drawShapeMode();
  else drawTessellationMode();
}

// ---------------------------------------------------------------------------
// Control point -> screen position
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
// Derived edges
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
// Modes
// ---------------------------------------------------------------------------

function drawEditMode() {
  strokeWeight(2);
  stroke(GRAY);
  line(topRight.x, topRight.y, bottomRight.x, bottomRight.y);
  line(bottomLeft.x, bottomLeft.y, bottomRight.x, bottomRight.y);

  strokeWeight(3);
  stroke(PINK);
  drawPolyline(getLeftCurvePoints());
  stroke(BLUE);
  drawPolyline(getTopCurvePoints());

  // control points
  strokeWeight(1.5);
  for (const p of topControlPoints) drawControlPoint(topPointPos(p), BLUE, selected && selected.pt === p);
  for (const p of leftControlPoints) drawControlPoint(leftPointPos(p), PINK, selected && selected.pt === p);
}

function drawControlPoint(pos, col, isSelected) {
  stroke(col);
  fill(isSelected ? col : 255);
  circle(pos.x, pos.y, 8);
}

function drawShapeMode() {
  const b = buildTileBoundary();
  noStroke();
  drawTileFill(b, TILE_FILL);

  strokeWeight(3);
  stroke(BLUE);
  drawPolyline(b.top);
  drawPolyline(b.right);
  stroke(PINK);
  drawPolyline(b.bottom);
  drawPolyline(b.left);

  drawTessellationDemo(b);
}

// ---------------------------------------------------------------------------
// Tessellation demo (below the single-tile preview, shape mode only)
// ---------------------------------------------------------------------------

const tileColors = ["#111111", "#555555", "#3f4ee8", "#ffffff"];
const DEMO_SCALE = 0.5;
const DEMO_COLS = 7;
const DEMO_ROWS = 4;
const DEMO_TOP = 690;
// black panel around the demo (tiles can bulge ~50px past their grid cells)
const PANEL = { x: 10, y: 635, w: 880, h: 555 };

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

// Tiles are grouped in 2x2 blocks that share a corner (the tile's bottomLeft).
// Around that corner the four quadrants get 0/90/180/270 degree copies, which
// is what makes neighbouring edges interlock.
function drawTessellationDemo(b) {
  const cell = S * DEMO_SCALE;
  const left = (width - DEMO_COLS * cell) / 2;
  // quadrant (col % 2, row % 2) -> number of quarter turns
  const turns = [[3, 2], [0, 1]]; // turns[col % 2][row % 2]

  // positive modulo, since the padded loop goes into negative rows/cols
  const mod = (n, m) => ((n % m) + m) % m;

  // clip to the panel and draw extra rows/cols so the pattern fills it edge to edge
  drawingContext.save();
  drawingContext.beginPath();
  drawingContext.rect(PANEL.x, PANEL.y, PANEL.w, PANEL.h);
  drawingContext.clip();

  noStroke();
  for (let row = -2; row < DEMO_ROWS + 2; row++) {
    for (let col = -2; col < DEMO_COLS + 2; col++) {
      // shared corner of this tile's 2x2 block
      const px = left + (floor(col / 2) * 2 + 1) * cell;
      const py = DEMO_TOP + (floor(row / 2) * 2 + 1) * cell;
      const k = turns[mod(col, 2)][mod(row, 2)];
      drawTileAt(b, px, py, k * HALF_PI, DEMO_SCALE, tileColors[mod(row + col, tileColors.length)]);
    }
  }

  drawingContext.restore();

  noFill();
  stroke(0);
  strokeWeight(1);
  rect(PANEL.x, PANEL.y, PANEL.w, PANEL.h);
}

// The tile has a 4-fold rotation centre at bottomLeft. Four copies rotated
// 0/90/180/270 degrees about bottomLeft form a 2S x 2S block; that block
// repeats by plain translation of (2S, 0) and (0, 2S).
function drawTessellationMode() {
  const b = buildTileBoundary();
  const step = 2 * S;
  const iMin = floor(-bottomLeft.x / step) - 1;
  const iMax = ceil((width - bottomLeft.x) / step) + 1;
  const jMin = floor(-bottomLeft.y / step) - 1;
  const jMax = ceil((height - bottomLeft.y) / step) + 1;

  stroke(40);
  strokeWeight(1);
  for (let i = iMin; i <= iMax; i++) {
    for (let j = jMin; j <= jMax; j++) {
      for (let k = 0; k < 4; k++) {
        push();
        translate(bottomLeft.x + i * step, bottomLeft.y + j * step);
        rotate(k * HALF_PI);
        translate(-bottomLeft.x, -bottomLeft.y);
        drawTileFill(b, PALETTE[(k + i + 2 * j + 300) % 3]);
        pop();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Interaction (edit mode only)
// ---------------------------------------------------------------------------

function mousePressed() {
  if (mode !== "edit") return;
  if (mouseX < 0 || mouseY < 0 || mouseX > width || mouseY > height) return;

  // 1. select an existing control point
  for (const p of topControlPoints) {
    if (dist(mouseX, mouseY, topPointPos(p).x, topPointPos(p).y) < CLICK_DIST) {
      selected = { edge: "top", pt: p };
      dragging = true;
      return;
    }
  }
  for (const p of leftControlPoints) {
    if (dist(mouseX, mouseY, leftPointPos(p).x, leftPointPos(p).y) < CLICK_DIST) {
      selected = { edge: "left", pt: p };
      dragging = true;
      return;
    }
  }

  // 2. add a new point if the click is near one of the editable curves
  if (nearCurve(getTopCurvePoints())) {
    const t = (mouseX - topLeft.x) / S;
    if (t > 0.02 && t < 0.98) {
      const p = { t, d: constrain(mouseY - topLeft.y, -MAX_DISPLACEMENT, MAX_DISPLACEMENT) };
      topControlPoints.push(p);
      topControlPoints.sort((a, b) => a.t - b.t);
      selected = { edge: "top", pt: p };
      dragging = true;
      return;
    }
  }
  if (nearCurve(getLeftCurvePoints())) {
    const t = (bottomLeft.y - mouseY) / S;
    if (t > 0.02 && t < 0.98) {
      const p = { t, d: constrain(mouseX - bottomLeft.x, -MAX_DISPLACEMENT, MAX_DISPLACEMENT) };
      leftControlPoints.push(p);
      leftControlPoints.sort((a, b) => a.t - b.t);
      selected = { edge: "left", pt: p };
      dragging = true;
      return;
    }
  }

  selected = null;
}

function nearCurve(pts) {
  return pts.some(p => dist(mouseX, mouseY, p.x, p.y) < CLICK_DIST);
}

// Only the displacement changes; t (position along the edge) stays fixed,
// so points can never reorder or create loops.
function mouseDragged() {
  if (mode !== "edit" || !dragging || !selected) return;
  if (selected.edge === "top") {
    selected.pt.d = constrain(mouseY - topLeft.y, -MAX_DISPLACEMENT, MAX_DISPLACEMENT);
  } else {
    selected.pt.d = constrain(mouseX - bottomLeft.x, -MAX_DISPLACEMENT, MAX_DISPLACEMENT);
  }
}

function mouseReleased() {
  dragging = false;
}

function keyPressed() {
  if (mode === "edit" && selected && (keyCode === BACKSPACE || keyCode === DELETE)) {
    const list = selected.edge === "top" ? topControlPoints : leftControlPoints;
    list.splice(list.indexOf(selected.pt), 1);
    selected = null;
    return false; // stop the browser from navigating back on Backspace
  }
}
