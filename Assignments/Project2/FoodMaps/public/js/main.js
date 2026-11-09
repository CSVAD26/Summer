// FOODMAPS — An Atlas of What I've Tasted
//
// Rendering split:
//   Three.js  -> the globe: sphere + Natural Earth coastlines/borders as native 1-px GL lines
//   p5.js     -> the frame loop and the data layer: dots, globe edge, hover/selection rings
// Both use the same latitude/longitude -> 3D function (llToVec), so dots and outlines align.
//
// Everything is loaded from this machine; nothing is sent anywhere.

import * as THREE from '../lib/three.module.js';
import { createLocalView } from './localview.js';
import { createCollage } from './collage.js';

// ------------------------------------------------------------------ config
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const SRC = DEMO
  ? { photos: 'demo/food_photos.json', cats: 'demo/food_categories.json', excluded: null, base: 'demo/',
      atlas: 'demo/collage/atlas.jpg' }
  : { photos: '../data/food_photos.json', cats: '../data/food_categories.json',
      excluded: '../data/excluded_ids.txt', base: '', atlas: 'collage/atlas.jpg' };

const FOV = 30;                 // degrees; narrow lens = calm, little distortion
const R_COAST = 1.0012;         // lines sit just above the sphere (radius 1)
const R_BORDER = 1.0010;
const R_GRAT = 1.0006;
const R_DOT = 1.0015;
const DOT_SIZE = 5.5;           // CSS px diameter
const PICK_RADIUS = 8;          // CSS px
const CLICK_SLOP = 4;           // px of movement still counted as a click
const INERTIA_TAU = 0.22;       // s, release damping
const MAX_SPIN = 3.5;           // rad/s cap so throws never look exaggerated

const COLORS = {
  coast: 0x1a1a1a,
  border: 0x9d9d9d,
  graticule: 0xececec,
  sphere: 0xfcfcfb,
  edge: '#cfcfcf',
};

// ------------------------------------------------------------------ geometry helpers
const DEG = Math.PI / 180;
function llToVec(lat, lon, r = 1, out = new THREE.Vector3()) {
  const la = lat * DEG, lo = lon * DEG, c = Math.cos(la);
  // lon 0 faces +z (the camera), east is +x, north is +y
  return out.set(r * c * Math.sin(lo), r * Math.sin(la), r * c * Math.cos(lo));
}

/** Densify a [lon,lat,...] polyline so no segment spans more than maxDeg (long straight
 *  borders would otherwise cut through the sphere as chords). */
function densify(flat, maxDeg = 1) {
  const out = [flat[0], flat[1]];
  for (let i = 2; i < flat.length; i += 2) {
    const lo0 = flat[i - 2], la0 = flat[i - 1], lo1 = flat[i], la1 = flat[i + 1];
    // take the short way across the antimeridian (179.9 -> -179.9 is 0.2°, not 359.8°)
    const dlo = ((lo1 - lo0 + 540) % 360) - 180;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dlo), Math.abs(la1 - la0)) / maxDeg));
    for (let k = 1; k <= n; k++) out.push(lo0 + dlo * k / n, la0 + (la1 - la0) * k / n);
  }
  return out;
}

function lineLayer(polylines, r, color) {
  let n = 0;
  const dense = polylines.map((pl) => densify(pl));
  for (const pl of dense) n += pl.length / 2 - 1;
  const pos = new Float32Array(n * 6);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  let k = 0;
  for (const pl of dense) {
    for (let i = 0; i + 3 < pl.length; i += 2) {
      llToVec(pl[i + 1], pl[i], r, a);
      llToVec(pl[i + 3], pl[i + 2], r, b);
      pos[k++] = a.x; pos[k++] = a.y; pos[k++] = a.z;
      pos[k++] = b.x; pos[k++] = b.y; pos[k++] = b.z;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
}

function graticule(step = 30) {
  const lines = [];
  for (let lat = -90 + step; lat < 90; lat += step) {
    const pl = [];
    for (let lon = -180; lon <= 180; lon += 2) pl.push(lon, lat);
    lines.push(pl);
  }
  for (let lon = -180; lon < 180; lon += step) {
    const pl = [];
    for (let lat = -90; lat <= 90; lat += 2) pl.push(lon, lat);
    lines.push(pl);
  }
  return lines;
}

/** Orientation that puts (lat, lon) at the centre of the view with north up. */
function northUpQuat(lat, lon) {
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -lon * DEG);
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lat * DEG);
  return qx.multiply(qy);
}

// ------------------------------------------------------------------ data
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function loadData() {
  const [photosDoc, catsDoc, geo] = await Promise.all([
    getJSON(SRC.photos), getJSON(SRC.cats), getJSON('geo/world_lines.json'),
  ]);
  let excluded = new Set();
  if (SRC.excluded) {
    try {
      const t = await (await fetch(SRC.excluded, { cache: 'no-store' })).text();
      excluded = new Set(t.split(/\r?\n/).map((s) => s.trim().toUpperCase())
        .filter((s) => s && !s.startsWith('#')));
    } catch { /* optional */ }
  }
  const catByKey = Object.fromEntries(catsDoc.categories.map((c) => [c.key, c]));
  const other = catByKey.other || { key: 'other', name: 'Other / Mixed', color: '#777777' };
  const points = [];
  let skipped = 0;
  for (const p of photosDoc.photos) {
    const lat = Number(p.lat), lon = Number(p.lon);
    if (!p.id || excluded.has(String(p.id).toUpperCase()) || !Number.isFinite(lat) || !Number.isFinite(lon)
        || Math.abs(lat) > 90 || Math.abs(lon) > 180) { skipped++; continue; }
    const a = catsDoc.assignments[p.id];
    const cat = (a && catByKey[a.category]) || other;
    points.push({
      id: p.id, lat, lon,
      city: p.city || null, country: p.country || null,
      date: p.date || null,
      thumb: p.thumb ? SRC.base + p.thumb : null,
      cat,
      pos: llToVec(lat, lon, R_DOT),
    });
  }
  return { points, categories: catsDoc.categories, geo, skipped };
}

// ------------------------------------------------------------------ app
const stage = document.getElementById('stage');
const statusEl = document.getElementById('status');
function setStatus(msg) { statusEl.hidden = !msg; statusEl.textContent = msg || ''; }

setStatus('Loading…');
let data;
try {
  data = await loadData();
  setStatus('');
} catch (e) {
  setStatus('Could not load the dataset. Serve this folder locally (see README).');
  throw e;
}
const { points } = data;

// ---------- Three.js globe
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setClearColor(0xffffff, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.005, 50);
const globe = new THREE.Group();
scene.add(globe);

const minimalSphere = new THREE.Mesh(
  new THREE.SphereGeometry(1, 192, 128),
  new THREE.MeshBasicMaterial({ color: COLORS.sphere, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
);
globe.add(minimalSphere);
const graticuleLayer = lineLayer(graticule(30), R_GRAT, COLORS.graticule);
globe.add(graticuleLayer);
globe.add(lineLayer(data.geo.borders, R_BORDER, COLORS.border));
globe.add(lineLayer(data.geo.coast, R_COAST, COLORS.coast));

// ---------- view state
const view = {
  q: new THREE.Quaternion(),
  dist: 3.6, distTarget: 3.6,
  spin: new THREE.Vector3(),          // angular velocity (world axis * rad/s)
  anim: null,                          // {from, to, t, dur} for the north-up reset
  w: 1, h: 1,
};

function fitDistance() {
  // distance at which the globe's radius on screen is ~40% of the shorter side
  const f = (view.h / 2) / Math.tan((FOV / 2) * DEG);
  const r = 0.40 * Math.min(view.w, view.h);
  return Math.sqrt(1 + (f / r) ** 2);
}

function initialView() {
  // centre on the mean direction of all photos (computed locally, north up)
  const m = new THREE.Vector3();
  for (const p of points) m.add(p.pos);
  if (m.lengthSq() < 1e-9) return northUpQuat(20, 0);
  m.normalize();
  return northUpQuat(Math.asin(m.y) / DEG, Math.atan2(m.x, m.z) / DEG);
}

// ---------- screen-space helpers
const ndc = new THREE.Vector2();
const ray = new THREE.Raycaster();
const tmp = new THREE.Vector3();

/** Point on the unit sphere under the cursor (world space). If the cursor is off the
 *  globe, returns the closest point on the globe's edge so dragging stays continuous. */
function sphereHit(x, y) {
  ndc.set((x / view.w) * 2 - 1, -(y / view.h) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  const b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c;
  if (disc >= 0) return { p: o.clone().addScaledVector(d, -b - Math.sqrt(disc)), on: true };
  return { p: o.clone().addScaledVector(d, -b).normalize(), on: false };
}

// ---------- navigation (grab-the-Earth trackball)
const drag = { active: false, id: null, x0: 0, y0: 0, t0: 0, moved: 0, grab: null, lastT: 0 };

function onPointerDown(e) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  stage.setPointerCapture(e.pointerId);
  const hit = sphereHit(e.offsetX, e.offsetY);
  drag.active = true;
  drag.id = e.pointerId;
  drag.x0 = e.offsetX; drag.y0 = e.offsetY;
  drag.t0 = drag.lastT = performance.now();
  drag.moved = 0;
  // remember the grabbed point in globe-local coordinates
  drag.grab = hit.p.clone().applyQuaternion(view.q.clone().invert());
  view.spin.set(0, 0, 0);
  view.anim = null;
  e.preventDefault();
}

function onPointerMove(e) {
  if (!drag.active) { updateHover(e.offsetX, e.offsetY); return; }
  if (e.pointerId !== drag.id) return;
  drag.moved = Math.max(drag.moved, Math.hypot(e.offsetX - drag.x0, e.offsetY - drag.y0));
  if (drag.moved > CLICK_SLOP) stage.classList.add('dragging');
  const target = sphereHit(e.offsetX, e.offsetY).p.normalize();
  const current = drag.grab.clone().applyQuaternion(view.q).normalize();
  const delta = new THREE.Quaternion().setFromUnitVectors(current, target);
  view.q.premultiply(delta).normalize();

  // angular velocity for release damping
  const now = performance.now();
  const dt = Math.max(1, now - drag.lastT) / 1000;
  drag.lastT = now;
  const angle = 2 * Math.acos(Math.min(1, Math.abs(delta.w)));
  if (angle > 1e-6) {
    const s = Math.sqrt(1 - delta.w * delta.w) || 1;
    const inst = new THREE.Vector3(delta.x / s, delta.y / s, delta.z / s)
      .multiplyScalar((delta.w < 0 ? -1 : 1) * angle / dt);
    view.spin.lerp(inst, 0.5);
  }
}

function onPointerUp(e) {
  if (!drag.active || e.pointerId !== drag.id) return;
  drag.active = false;
  stage.classList.remove('dragging');
  try { stage.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  const now = performance.now();
  if (drag.moved <= CLICK_SLOP && now - drag.t0 < 600) {
    view.spin.set(0, 0, 0);
    handleClick(e.offsetX, e.offsetY);
    return;
  }
  // only carry momentum if the pointer was still moving at release
  if (now - drag.lastT > 60) view.spin.set(0, 0, 0);
  if (view.spin.length() > MAX_SPIN) view.spin.setLength(MAX_SPIN);
}

// Zoom is intentionally disabled on the globe: it is a navigation surface at a fixed,
// balanced size. Wheel / pinch are swallowed so the page never scrolls or zooms.
function onWheel(e) { e.preventDefault(); }

const NORTH_UP_MS = 750;
const POLE_EPS = Math.sin(0.5 * DEG);   // centre within 0.5° of a pole: "north" is undefined

/* North-up: roll the globe about the viewing axis only, so the centred location stays exactly
 * where it is (no reset of longitude, latitude or size). The north direction on screen is the
 * screen-plane part of the rotated North Pole vector; rolling by its angle from screen-up makes
 * the meridian through the centre vertical. Always the shortest roll (<= 180°). */
function northUp() {
  const pole = new THREE.Vector3(0, 1, 0).applyQuaternion(view.q);
  if (Math.hypot(pole.x, pole.y) < POLE_EPS) return false;   // looking straight at a pole
  const roll = Math.atan2(pole.x, pole.y);                     // angle of north from screen-up
  if (Math.abs(roll) < 1e-4) return true;                      // already north-up
  const to = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll).multiply(view.q);
  view.spin.set(0, 0, 0);
  view.anim = { from: view.q.clone(), to, t: 0, dur: NORTH_UP_MS / 1000 };
  return true;
}

stage.addEventListener('pointerdown', onPointerDown);
stage.addEventListener('pointermove', onPointerMove);
stage.addEventListener('pointerup', onPointerUp);
stage.addEventListener('pointercancel', onPointerUp);
stage.addEventListener('wheel', onWheel, { passive: false });
stage.addEventListener('contextmenu', (e) => e.preventDefault());
// Safari trackpad pinch
stage.addEventListener('gesturestart', (e) => e.preventDefault());
stage.addEventListener('gesturechange', (e) => e.preventDefault());

function stepView(dt) {
  if (view.anim) {
    const a = view.anim;
    a.t = Math.min(1, a.t + dt / a.dur);
    const s = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2;   // ease-in-out cubic
    view.q.slerpQuaternions(a.from, a.to, s);
    if (a.t >= 1) view.anim = null;
  } else if (!drag.active && view.spin.lengthSq() > 1e-6) {
    const w = view.spin.length();
    const dq = new THREE.Quaternion().setFromAxisAngle(tmp.copy(view.spin).divideScalar(w), w * dt);
    view.q.premultiply(dq).normalize();
    view.spin.multiplyScalar(Math.exp(-dt / INERTIA_TAU));
    if (w < 0.03) view.spin.set(0, 0, 0);
  }
  view.dist = view.distTarget;
  globe.quaternion.copy(view.q);
  camera.position.set(0, 0, view.dist);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
}

// ---------- dot projection (shared by drawing and picking)
const N = points.length;
const sx = new Float32Array(N), sy = new Float32Array(N), alpha = new Float32Array(N);

function projectPoints() {
  const d = view.dist, r2 = R_DOT * R_DOT;
  for (let i = 0; i < N; i++) {
    tmp.copy(points[i].pos).applyQuaternion(view.q);
    // visible iff the point is in front of its own horizon: p·cam > |p|²
    const facing = tmp.z * d - r2;
    if (facing <= 0) { alpha[i] = 0; continue; }
    alpha[i] = Math.min(1, facing / (0.06 * d));      // soft fade right at the limb
    tmp.project(camera);
    sx[i] = (tmp.x + 1) * 0.5 * view.w;
    sy[i] = (1 - tmp.y) * 0.5 * view.h;
  }
}

/** Index of the single dot under the cursor: nearest, ties -> the one drawn on top. */
function pickOne(x, y, radius = PICK_RADIUS) {
  let best = -1, bd = radius + 1e-9;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    if (alpha[i] < 0.35) continue;
    const dd = Math.hypot(sx[i] - x, sy[i] - y);
    if (dd < bd - 0.01) { bd = dd; best = i; }
  }
  return best;
}

let hoverIdx = -1;
function updateHover(x, y) {
  hoverIdx = pickOne(x, y);
  stage.classList.toggle('pointing', hoverIdx >= 0);
}

// ---------- photo panel
const panel = document.getElementById('panel');
const img = document.getElementById('photo-img');
const noimg = panel.querySelector('.noimg');
let selected = -1;                       // index of the one selected photo

const fmtDate = (iso) => {
  if (!iso) return 'Date unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Date unknown';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};
const fmtPlace = (p) => [p.city, p.country].filter(Boolean).join(', ') || 'Unnamed location';

/* A single click on a globe dot selects that one photo and opens the LOCAL VIEW
 * (50-mile radius) centred on it. Drags never reach here (see onPointerUp). */
function handleClick(x, y) {
  const i = pickOne(x, y);
  if (i < 0) return;                      // clicking empty globe changes nothing
  select(i);
  local.open(i);
}

function select(i) {
  selected = i;
  renderPanel();
  local.redraw();
}

function showPhoto(p) {
  noimg.hidden = true;
  img.hidden = false;
  img.alt = `${p.cat.name} — ${fmtPlace(p)}`;
  if (!p.thumb) { img.hidden = true; noimg.hidden = false; img.removeAttribute('src'); return; }
  img.onerror = () => { img.hidden = true; noimg.hidden = false; };
  img.src = p.thumb;
}

function renderPanel() {
  if (selected < 0) { panel.hidden = true; return; }
  const p = points[selected];
  showPhoto(p);
  panel.querySelector('.place').textContent = fmtPlace(p);
  panel.querySelector('.date').textContent = fmtDate(p.date);
  const c = panel.querySelector('.category');
  c.innerHTML = '';
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.background = p.cat.color;
  c.append(sw, document.createTextNode(p.cat.name));
  panel.hidden = false;
}

function closePanel() { selected = -1; panel.hidden = true; local.redraw(); }
panel.querySelector('.close').addEventListener('click', closePanel);
const isEditable = (el) => !!el && (el.isContentEditable
  || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest?.('[contenteditable="true"]'));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.key === ' ') {
    if (isEditable(e.target)) return;          // typing: leave the space alone
    e.preventDefault();                        // no page scroll, no re-pressing a focused button
    if (!e.repeat) northUp();                  // ignore auto-repeat while held
    return;
  }
  if (e.key === 'Escape') { if (!panel.hidden) closePanel(); else local.close(); }
  else if (e.key === 'n' || e.key === 'N') northUp();
});
// some browsers activate a focused button on Space keyup
window.addEventListener('keyup', (e) => {
  if ((e.code === 'Space' || e.key === ' ') && !isEditable(e.target)) e.preventDefault();
});

const local = createLocalView({ points, onSelect: (i) => select(i), getSelected: () => selected });

// ---------- display mode: 01 MINIMAL / 02 CULINARY COLLAGE
// Switching only swaps the sphere surface (+ admin-1 outlines); rotation, selection, photo
// panel and local view are untouched.
const collage = createCollage({ THREE, globe, renderer, llToVec, lineLayer,
  borderColor: COLORS.border, borderRadius: R_BORDER, url: SRC.atlas });
let mode = 'minimal';
const modeButtons = [...document.querySelectorAll('.modes button[data-mode]')];
async function setMode(m) {
  if (m === mode) return true;
  modeButtons.forEach((b) => b.setAttribute('aria-busy', String(b.dataset.mode === m)));
  const ok = await collage.show(m === 'collage');
  modeButtons.forEach((b) => b.removeAttribute('aria-busy'));
  if (!ok) {
    setStatus('Collage texture not found — run scripts/build_collage.py');
    setTimeout(() => setStatus(''), 3000);
    return false;
  }
  mode = m;
  minimalSphere.visible = m === 'minimal';
  graticuleLayer.visible = m === 'minimal';    // collage atlas carries its own grid (empty areas only)
  modeButtons.forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  return true;
}
modeButtons.forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); b.blur(); }));

// ---------- legend
const legend = document.getElementById('legend');
for (const c of data.categories) {
  const li = document.createElement('li');
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.background = c.color;
  li.append(sw, document.createTextNode(c.name));
  legend.append(li);
}

// ---------- p5.js: frame loop + data layer
function resize(p) {
  view.w = stage.clientWidth;
  view.h = stage.clientHeight;
  renderer.setSize(view.w, view.h, false);
  renderer.domElement.style.width = view.w + 'px';
  renderer.domElement.style.height = view.h + 'px';
  camera.aspect = view.w / view.h;
  camera.updateProjectionMatrix();
  if (p) { p.resizeCanvas(view.w, view.h); view.dist = view.distTarget = fitDistance(); }
}

// draw order: Other / Mixed first, so the coloured categories sit on top
const order = Array.from({ length: N }, (_, i) => i)
  .sort((a, b) => (points[a].cat.key === 'other' ? 0 : 1) - (points[b].cat.key === 'other' ? 0 : 1) || a - b);

new p5((p) => {
  let rgb;
  p.setup = () => {
    view.w = stage.clientWidth; view.h = stage.clientHeight;
    const cnv = p.createCanvas(view.w, view.h);
    cnv.parent(stage);
    p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
    resize(p);
    view.q.copy(initialView());
    view.dist = view.distTarget = fitDistance();
    rgb = points.map((pt) => p.color(pt.cat.color));
  };

  p.windowResized = () => resize(p);

  p.draw = () => {
    const dt = Math.min(0.05, p.deltaTime / 1000 || 1 / 60);
    stepView(dt);
    renderer.render(scene, camera);
    projectPoints();

    p.clear();
    // globe edge: a hairline circle where the sphere meets the white page
    const f = (view.h / 2) / Math.tan((FOV / 2) * DEG);
    const rr = f / Math.sqrt(view.dist * view.dist - 1);
    p.noFill();
    p.stroke(COLORS.edge);
    p.strokeWeight(0.75);
    p.circle(view.w / 2, view.h / 2, rr * 2);

    // dots
    p.stroke(255);
    p.strokeWeight(mode === 'collage' ? 1.1 : 0.6);   // a touch more outline over photos
    for (const i of order) {
      if (alpha[i] <= 0) continue;
      const c = rgb[i];
      c.setAlpha(235 * alpha[i]);
      p.fill(c);
      p.circle(sx[i], sy[i], DOT_SIZE);
    }

    // selection + hover rings
    p.noFill();
    if (selected >= 0 && alpha[selected] > 0) {
      p.stroke(17);
      p.strokeWeight(1.4);
      p.circle(sx[selected], sy[selected], DOT_SIZE + 7);
    }
    if (hoverIdx >= 0 && alpha[hoverIdx] > 0 && !drag.active) {
      p.stroke(17, 140);
      p.strokeWeight(1);
      p.circle(sx[hoverIdx], sy[hoverIdx], DOT_SIZE + 6);
    }
  };
}, stage);

// ---------- test hooks (local only; aggregate state, no photo metadata)
window.__foodmaps = {
  ready: true,
  count: N,
  skipped: data.skipped,
  visibleCount: () => { let n = 0; for (let i = 0; i < N; i++) if (alpha[i] > 0) n++; return n; },
  view: () => ({ dist: view.dist, q: view.q.toArray() }),
  center: () => {
    const c = new THREE.Vector3(0, 0, 1).applyQuaternion(view.q.clone().invert());
    return { lat: Math.asin(c.y) / DEG, lon: Math.atan2(c.x, c.z) / DEG };
  },
  mode: () => mode,
  setMode: (m) => setMode(m),
  setQuat: (arr) => { view.q.fromArray(arr).normalize(); view.anim = null; view.spin.set(0, 0, 0); },
  animating: () => !!view.anim,
  // angle (deg) between screen-up and the north direction at the centre; null at a pole
  northError: () => {
    const pole = new THREE.Vector3(0, 1, 0).applyQuaternion(view.q);
    return Math.hypot(pole.x, pole.y) < POLE_EPS ? null : Math.atan2(pole.x, pole.y) / DEG;
  },
  lookAt: (lat, lon, dist) => { view.q.copy(northUpQuat(lat, lon)); view.spin.set(0, 0, 0);
    if (dist) view.dist = view.distTarget = dist; },
  screenOf: (i) => (alpha[i] > 0 ? [sx[i], sy[i]] : null),
  selected: () => selected,
  selectedId: () => (selected >= 0 ? points[selected].id : null),
  local: () => local.state(),
  localMarks: () => local.marks(),
  localKids: () => local.kids(),
  localSetRadius: (r) => local.setRadius(r),
  localOffset: () => local.canvasOffset(),
  pointInfo: (i) => ({ lat: points[i].lat, lon: points[i].lon, city: points[i].city, id: points[i].id }),
  indexOf: (id) => points.findIndex((pt) => pt.id === id),
};
