// LOCAL VIEW — a small 2D map around one photograph.
//
// Geography
//   Azimuthal equidistant projection centred on the selected photo (true distance and
//   direction from the centre). Outlines come from local 2° tiles (public data only):
//   USGS 1:1M hydrography + Census 1:500k boundaries inside the US, Natural Earth 1:10m
//   elsewhere. Tiles are fetched from this machine only.
//
// Points (every photo stays individually accessible)
//   - Adaptive radius: opens at the widest radius (50/20/10/5/2/1 mi) whose markers barely
//     need moving, so dense cities open closer in. No place-specific rules.
//   - Stacks: photos within STACK_PX of each other on screen are one spot.
//       1 photo     -> a dot at its true position
//       2-4 photos  -> a tiny ring around the spot
//       5+ photos   -> one small count marker; clicking it expands just that spot
//   - Remaining overlaps between spots are resolved locally with a strong pull back to
//     the true position; moved markers get a hairline leader line.
// Drawn with p5.js (instance mode); redraws only on change.

const EARTH_MI = 3958.8;
const RADII = [50, 20, 10, 5, 2, 1];    // miles; − / + step through these
const D = 7;                             // dot diameter (CSS px)
const GAP = 1.6;
const MIN_SEP = D + GAP;
const STACK_PX = 3;                      // closer than this on screen = same spot
const GROUP_MIN = 5;                     // dense views: spots with 5+ photos -> count marker
const GROUP_MIN_SPARSE = 9;              // sparse views (<= SPARSE_N photos): rings up to 8
const SPARSE_N = 60;
const AUTO_MIN_R = 2;                    // adaptive radius never starts closer than this
const AUTO_EXPAND_MAX = 24;              // larger groups only expand when clicked
const CROWD_MAX = 0.12;                  // adaptive radius: max share of colliding marks
const MARKS_MAX = 90;                    // adaptive radius: max marks on the first view
const BASE = 340;                        // default map size (px)
const MARGIN = 14;
const DEG = Math.PI / 180;
const TILE = 2;
const LAYER_MAX_R = { place: 20 };       // city limits only when zoomed in (miles)                          // degrees

const LINE_STYLE = {                     // drawn in this order: [color, weight]
  place: ['#ededed', 0.6],
  county: ['#e3e3e3', 0.6],
  admin1: ['#d6d6d6', 0.6],
  streams: ['#c4ccd2', 0.6],
  rivers: ['#c4ccd2', 0.6],
  lakes: ['#b6c0c7', 0.6],
  water: ['#b6c0c7', 0.6],
  admin0: ['#9a9a9a', 0.7],
  coast: ['#3a3a3a', 0.7],
};

export function haversineMi(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG, dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

function aeqd(lat0, lon0) {
  const s0 = Math.sin(lat0 * DEG), c0 = Math.cos(lat0 * DEG);
  return (lat, lon) => {
    const s = Math.sin(lat * DEG), c = Math.cos(lat * DEG), dl = (lon - lon0) * DEG;
    const cosc = Math.max(-1, Math.min(1, s0 * s + c0 * c * Math.cos(dl)));
    const cc = Math.acos(cosc);
    const k = cc < 1e-9 ? 1 : cc / Math.sin(cc);
    return [EARTH_MI * k * c * Math.sin(dl), EARTH_MI * k * (c0 * s - s0 * c * Math.cos(dl))];
  };
}

const groupDiameter = (n) => (n < 10 ? 14 : n < 100 ? 16 : 19);

// ------------------------------------------------------------------ stacks + layout
/** Union-find of anchors closer than STACK_PX. Returns arrays of item indices (input order). */
function findStacks(items) {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const grid = new Map();
  items.forEach((it, i) => {
    const k = `${Math.floor(it.ax / STACK_PX)},${Math.floor(it.ay / STACK_PX)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  items.forEach((it, i) => {
    const gx = Math.floor(it.ax / STACK_PX), gy = Math.floor(it.ay / STACK_PX);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(`${gx + dx},${gy + dy}`) || []) {
        if (j > i && Math.hypot(items[j].ax - it.ax, items[j].ay - it.ay) < STACK_PX) {
          const a = find(i), b = find(j);
          if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
        }
      }
    }
  });
  const m = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!m.has(r)) m.set(r, []); m.get(r).push(i); }
  return [...m.values()];
}

/** Display marks (dots, ring dots, groups) at their home positions. */
function buildMarks(items, stacks, expandedKey) {
  const groupMin = items.length > SPARSE_N ? GROUP_MIN : GROUP_MIN_SPARSE;
  const marks = [];
  stacks.forEach((members, sid) => {
    let cx = 0, cy = 0;
    for (const k of members) { cx += items[k].ax; cy += items[k].ay; }
    cx /= members.length; cy /= members.length;
    const photos = members.map((k) => items[k].i);
    if (members.length >= groupMin) {
      const key = Math.min(...photos);                // stable id: smallest photo index
      marks.push({ type: 'group', sid, key, photos, ax: cx, ay: cy, hx: cx, hy: cy,
        r: groupDiameter(photos.length) / 2, expanded: key === expandedKey });
    } else if (members.length === 1) {
      const it = items[members[0]];
      marks.push({ type: 'dot', sid, i: it.i, ax: it.ax, ay: it.ay, hx: it.ax, hy: it.ay, r: D / 2 });
    } else {
      const n = members.length, rr = MIN_SEP / (2 * Math.sin(Math.PI / n));
      photos.forEach((i, k) => {
        const a = -Math.PI / 2 + (2 * Math.PI * k) / n;
        marks.push({ type: 'dot', sid, i, ax: cx, ay: cy, hx: cx + rr * Math.cos(a), hy: cy + rr * Math.sin(a),
          r: D / 2, ring: true });
      });
    }
  });
  return marks;
}

/** Resolve overlaps locally: strong pull home (minimal displacement), then pure separation. */
export function resolve(marks) {
  const n = marks.length;
  if (!n) return marks;
  const pos = marks.map((m) => [m.hx, m.hy]);
  const cell = 2 * Math.max(D / 2, ...marks.map((m) => m.r)) + GAP;
  const step = (pull) => {
    const g = new Map();
    for (let i = 0; i < n; i++) {
      const k = `${Math.floor(pos[i][0] / cell)},${Math.floor(pos[i][1] / cell)}`;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(i);
    }
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(pos[i][0] / cell), gy = Math.floor(pos[i][1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const j of g.get(`${gx + dx},${gy + dy}`) || []) {
          if (j <= i) continue;
          const need = marks[i].r + marks[j].r + GAP;
          let vx = pos[j][0] - pos[i][0], vy = pos[j][1] - pos[i][1];
          let d = Math.hypot(vx, vy);
          if (d >= need) continue;
          if (d < 1e-6) { const a = ((i * 7 + j * 13) % 360) * DEG; vx = Math.cos(a); vy = Math.sin(a); d = 1e-6; }
          const wi = marks[i].type === 'group' ? 0.25 : 1, wj = marks[j].type === 'group' ? 0.25 : 1;
          const push = (need - d) + 0.02, s = wi + wj;
          const ux = vx / d, uy = vy / d;
          pos[i][0] -= ux * push * wi / s; pos[i][1] -= uy * push * wi / s;
          pos[j][0] += ux * push * wj / s; pos[j][1] += uy * push * wj / s;
          moved++;
        }
      }
    }
    if (pull) for (let i = 0; i < n; i++) {
      pos[i][0] += (marks[i].hx - pos[i][0]) * pull;
      pos[i][1] += (marks[i].hy - pos[i][1]) * pull;
    }
    return moved;
  };
  for (let k = 0; k < 60; k++) if (!step(0.25)) break;
  for (let k = 0; k < 600; k++) if (!step(0)) break;
  marks.forEach((m, i) => { m.x = pos[i][0]; m.y = pos[i][1]; });
  return marks;
}

function overlapsOf(marks) {
  let k = 0;
  for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) {
    if (Math.hypot(marks[i].x - marks[j].x, marks[i].y - marks[j].y) < marks[i].r + marks[j].r - 0.25) k++;
  }
  return k;
}

/** Number of marks that collide with a different spot at their home positions. */
function crowding(marks) {
  if (marks.length < 2) return 0;
  const hit = new Uint8Array(marks.length);
  for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) {
    if (marks[i].sid === marks[j].sid) continue;
    if (Math.hypot(marks[i].hx - marks[j].hx, marks[i].hy - marks[j].hy) < marks[i].r + marks[j].r + GAP) {
      hit[i] = 1; hit[j] = 1;
    }
  }
  return hit.reduce((a, b) => a + b, 0);
}

/** Sunflower layout of one expanded group around its spot, kept inside the canvas. */
function expandGroup(g, size) {
  const golden = Math.PI * (3 - Math.sqrt(5)), c = MIN_SEP * 0.62;
  const n = g.photos.length;
  const rad = c * Math.sqrt(n) * 1.08 + D;
  const cx = Math.min(size - rad - 2, Math.max(rad + 2, g.x));
  const cy = Math.min(size - rad - 2, Math.max(rad + 2, g.y));
  g.halo = { x: cx, y: cy, r: rad + 4 };
  g.kids = g.photos.map((i, k) => {
    const r = c * Math.sqrt(k) * (k ? 1.08 : 0), a = k * golden - Math.PI / 2;
    return { i, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

// ------------------------------------------------------------------ tiles (lazy, local)
const tileCache = new Map();
let tileIndex = null;
function loadIndex() {
  if (!tileIndex) {
    tileIndex = fetch('geo/tiles/index.json').then((r) => (r.ok ? r.json() : { tiles: [] }))
      .then((j) => new Set(j.tiles)).catch(() => new Set());
  }
  return tileIndex;
}
function loadTile(key) {
  if (!tileCache.has(key)) {
    tileCache.set(key, fetch(`geo/tiles/${key}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  }
  return tileCache.get(key);
}
async function tilesFor(lat, lon, R) {
  const idx = await loadIndex();
  const dLat = (R * 1.6) / 69.0, dLon = (R * 1.6) / (69.0 * Math.max(0.05, Math.cos(lat * DEG)));
  const keys = [];
  for (let a = Math.floor((lat - dLat) / TILE) * TILE; a <= lat + dLat; a += TILE) {
    for (let b = Math.floor((lon - dLon) / TILE) * TILE; b <= lon + dLon; b += TILE) {
      const bb = (((b + 180) % 360) + 360) % 360 - 180;
      const k = `${a}_${bb}`;
      if (idx.has(k)) keys.push(k);
    }
  }
  return Promise.all(keys.map(loadTile));
}

// ------------------------------------------------------------------ component
export function createLocalView({ points, onSelect, getSelected }) {
  const root = document.getElementById('local');
  const canvasHost = root.querySelector('.local-map');
  const placeEl = root.querySelector('.local-place');
  const radiusEl = root.querySelector('.local-radius');
  const countEl = root.querySelector('.local-count');
  const zin = root.querySelector('.zin');
  const zout = root.querySelector('.zout');

  const st = {
    open: false, center: -1, rIdx: 0, size: BASE, near: [],
    marks: [], lines: [], tiles: null, hover: null, overlaps: 0, expanded: -1, token: 0,
  };
  let P = null;

  const maxSize = () => {
    const w = Math.min(window.innerWidth * 0.5, 720);
    const h = window.innerHeight - 110 - 60 - 40;
    return Math.max(BASE, Math.floor(Math.min(w, h)));
  };

  function nearby(R) {
    const c = points[st.center];
    const out = [];
    for (let i = 0; i < points.length; i++) {
      if (haversineMi(c.lat, c.lon, points[i].lat, points[i].lon) <= R) out.push(i);
    }
    out.sort((a, b) => String(points[a].date).localeCompare(String(points[b].date))
      || String(points[a].id).localeCompare(String(points[b].id)));
    return out;
  }

  function project(near, R, size) {
    const c = points[st.center];
    const proj = aeqd(c.lat, c.lon), half = size / 2, scale = (half - MARGIN) / R;
    return near.map((i) => {
      const [x, y] = proj(points[i].lat, points[i].lon);
      return { i, ax: half + x * scale, ay: half - y * scale };
    });
  }

  /** Widest radius whose spots barely collide and stay few. Works for any place. */
  function chooseRadius() {
    const last = RADII.indexOf(AUTO_MIN_R);
    for (let r = 0; r < last; r++) {
      const items = project(nearby(RADII[r]), RADII[r], BASE);
      const marks = buildMarks(items, findStacks(items), -1);
      const crowded = crowding(marks);
      if ((crowded <= 4 || crowded / marks.length <= CROWD_MAX) && marks.length <= MARKS_MAX) return r;
    }
    return last;
  }

  function compute() {
    const c = points[st.center];
    const R = RADII[st.rIdx];
    st.near = nearby(R);
    let size = BASE;
    const limit = maxSize();
    let marks;
    for (;;) {
      const items = project(st.near, R, size);
      marks = resolve(buildMarks(items, findStacks(items), st.expanded));
      const ov = overlapsOf(marks);
      const outside = marks.some((m) => m.x < 2 || m.y < 2 || m.x > size - 2 || m.y > size - 2);
      if ((!ov && !outside) || size >= limit) { st.overlaps = ov; break; }
      size = Math.min(limit, Math.round(size * 1.2));
    }
    st.size = size;
    for (const m of marks) {
      m.displaced = Math.hypot(m.x - m.hx, m.y - m.hy) > D * 0.6;
      if (m.type === 'group' && m.expanded) expandGroup(m, size);
    }
    if (st.expanded >= 0 && !marks.some((m) => m.type === 'group' && m.key === st.expanded)) st.expanded = -1;
    st.marks = marks;
    projectLines();

    placeEl.textContent = [c.city, c.country].filter(Boolean).join(', ') || 'Unnamed location';
    radiusEl.textContent = `${R} mi radius`;
    countEl.textContent = `${st.near.length} photo${st.near.length === 1 ? '' : 's'}`;
    zin.disabled = st.rIdx === RADII.length - 1;
    zout.disabled = st.rIdx === 0;
    if (P) P.resizeCanvas(size, size);
    canvasHost.style.width = canvasHost.style.height = `${size}px`;
    redraw();
    loadLinesAsync();
  }

  function projectLines() {
    st.lines = [];
    if (!st.tiles) return;
    const c = points[st.center], R = RADII[st.rIdx];
    const proj = aeqd(c.lat, c.lon), half = st.size / 2, scale = (half - MARGIN) / R;
    const lim = R * 1.6;
    for (const t of st.tiles) {
      for (const [name, list] of Object.entries(t)) {
        if (!LINE_STYLE[name]) continue;
        for (const pl of list) {
          const xy = [];
          let any = false;
          for (let k = 0; k < pl.length; k += 2) {
            const [x, y] = proj(pl[k + 1], pl[k]);
            if (Math.abs(x) < lim && Math.abs(y) < lim) any = true;
            xy.push(half + x * scale, half - y * scale);
          }
          if (any) st.lines.push({ name, xy });
        }
      }
    }
  }

  async function loadLinesAsync() {
    const token = ++st.token;
    const c = points[st.center];
    const tiles = await tilesFor(c.lat, c.lon, RADII[st.rIdx]);
    if (token !== st.token || !st.open) return;
    st.tiles = tiles;
    projectLines();
    redraw();
  }

  const redraw = () => { if (P) P.redraw(); };
  const expandedGroup = () => st.marks.find((m) => m.type === 'group' && m.expanded && m.kids);

  function hitTest(x, y) {
    const g = expandedGroup();
    if (g) {
      let best = null, bd = D / 2 + 3;
      for (const kid of g.kids) {
        const d = Math.hypot(kid.x - x, kid.y - y);
        if (d < bd) { bd = d; best = { kind: 'kid', i: kid.i }; }
      }
      if (best) return best;
    }
    let best = null, bd = Infinity;
    for (let k = st.marks.length - 1; k >= 0; k--) {
      const m = st.marks[k];
      if (m.type === 'group' && m.expanded) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d <= m.r + 3 && d < bd) {
        bd = d;
        best = m.type === 'group' ? { kind: 'group', key: m.key } : { kind: 'dot', i: m.i };
      }
    }
    return best;
  }

  function drawGroup(p, m) {
    const counts = new Map();
    for (const i of m.photos) counts.set(points[i].cat.color, (counts.get(points[i].cat.color) || 0) + 1);
    const dia = m.r * 2;
    p.noStroke(); p.fill(255); p.circle(m.x, m.y, dia);
    p.noFill(); p.strokeWeight(2.2); p.strokeCap(p.SQUARE);
    let a0 = -Math.PI / 2;
    for (const [col, n] of [...counts.entries()].sort()) {
      const a1 = a0 + (2 * Math.PI * n) / m.photos.length;
      p.stroke(col);
      p.arc(m.x, m.y, dia - 2.2, dia - 2.2, a0, a1);
      a0 = a1;
    }
    p.strokeCap(p.ROUND);
    p.noStroke(); p.fill(40);
    p.textAlign(p.CENTER, p.CENTER);
    p.textSize(m.photos.length >= 100 ? 7.5 : 8.5);
    p.text(String(m.photos.length), m.x, m.y + 0.5);
  }

  P = new p5((p) => {
    p.setup = () => {
      p.createCanvas(BASE, BASE).parent(canvasHost);
      p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
      p.textFont('Helvetica Neue');
      p.noLoop();
    };
    p.draw = () => {
      p.background(255);
      if (!st.open) return;
      const half = st.size / 2;
      p.noFill();
      for (const name of Object.keys(LINE_STYLE)) {
        if (LAYER_MAX_R[name] && RADII[st.rIdx] > LAYER_MAX_R[name]) continue;
        const [col, w] = LINE_STYLE[name];
        p.stroke(col); p.strokeWeight(w);
        for (const ln of st.lines) {
          if (ln.name !== name) continue;
          p.beginShape();
          for (let k = 0; k < ln.xy.length; k += 2) p.vertex(ln.xy[k], ln.xy[k + 1]);
          p.endShape();
        }
      }
      p.stroke('#e2e2e2'); p.strokeWeight(0.75);
      p.drawingContext.setLineDash([2, 3]);
      p.circle(half, half, (half - MARGIN) * 2);
      p.drawingContext.setLineDash([]);

      // leader lines for moved marks; small ticks at true spots of rings / moved marks
      p.stroke(150, 150, 150, 130); p.strokeWeight(0.5);
      for (const m of st.marks) if (m.displaced) p.line(m.ax, m.ay, m.x, m.y);
      p.noStroke(); p.fill(60);
      for (const m of st.marks) if (m.displaced || m.ring) p.circle(m.ax, m.ay, 1.8);

      for (const m of st.marks) {
        if (m.type === 'group') { if (!m.expanded) drawGroup(p, m); continue; }
        p.stroke(255); p.strokeWeight(0.8);
        p.fill(points[m.i].cat.color);
        p.circle(m.x, m.y, D);
      }
      const g = expandedGroup();
      if (g) {
        p.noStroke(); p.fill(255, 235); p.circle(g.halo.x, g.halo.y, g.halo.r * 2);
        p.noFill(); p.stroke('#d8d8d8'); p.strokeWeight(0.6); p.circle(g.halo.x, g.halo.y, g.halo.r * 2);
        if (Math.hypot(g.halo.x - g.ax, g.halo.y - g.ay) > 2) {
          p.stroke(150, 150, 150, 130); p.strokeWeight(0.5); p.line(g.ax, g.ay, g.halo.x, g.halo.y);
        }
        p.noStroke(); p.fill(60); p.circle(g.ax, g.ay, 2);
        p.stroke(255); p.strokeWeight(0.8);
        for (const kid of g.kids) { p.fill(points[kid.i].cat.color); p.circle(kid.x, kid.y, D); }
      }

      p.noFill();
      const ring = (L, extra, w, a = 255) => { p.stroke(17, a); p.strokeWeight(w); p.circle(L[0], L[1], L[2] + extra); };
      const locate = (i) => {
        if (g) { const kid = g.kids.find((k) => k.i === i); if (kid) return [kid.x, kid.y, D]; }
        const m = st.marks.find((mm) => mm.type === 'dot' && mm.i === i);
        if (m) return [m.x, m.y, D];
        const grp = st.marks.find((mm) => mm.type === 'group' && mm.photos.includes(i));
        return grp ? [grp.x, grp.y, grp.r * 2] : null;
      };
      const sel = getSelected();
      if (sel >= 0) { const L = locate(sel); if (L) ring(L, 6, 1.4); }
      if (st.hover) {
        const h = st.hover;
        let L = null;
        if (h.kind === 'dot' || h.kind === 'kid') L = locate(h.i);
        if (h.kind === 'group') { const m = st.marks.find((mm) => mm.type === 'group' && mm.key === h.key); if (m) L = [m.x, m.y, m.r * 2]; }
        if (L) ring(L, 5, 1, 140);
      }
    };
  }, canvasHost);

  canvasHost.addEventListener('pointermove', (e) => {
    const h = hitTest(e.offsetX, e.offsetY);
    const next = h && h.kind !== 'halo' ? h : null;
    if (JSON.stringify(next) !== JSON.stringify(st.hover)) {
      st.hover = next;
      canvasHost.style.cursor = next ? 'pointer' : 'default';
      redraw();
    }
  });
  canvasHost.addEventListener('pointerleave', () => { st.hover = null; redraw(); });
  canvasHost.addEventListener('click', (e) => {
    const h = hitTest(e.offsetX, e.offsetY);
    if (!h) { if (st.expanded >= 0) { st.expanded = -1; compute(); } return; }  // click map: collapse
    if (h.kind === 'kid') { onSelect(h.i); return; }
    if (h.kind === 'dot') {
      if (st.expanded >= 0) { st.expanded = -1; compute(); }   // leaving an open group
      onSelect(h.i);
      return;
    }
    if (h.kind === 'group') { st.expanded = h.key; compute(); }
  });
  zin.addEventListener('click', () => { if (st.rIdx < RADII.length - 1) { st.rIdx++; afterRadiusChange(); } });
  zout.addEventListener('click', () => { if (st.rIdx > 0) { st.rIdx--; afterRadiusChange(); } });
  root.querySelector('.close').addEventListener('click', () => close());
  window.addEventListener('resize', () => { if (st.open) compute(); });

  function afterRadiusChange() { st.expanded = -1; compute(); autoExpandSelected(); }

  /** If the selected photo sits inside a small count marker, expand that group so the photo
   *  itself is visible. Large groups stay compact (the ring marks them as selected). */
  function autoExpandSelected() {
    const sel = getSelected();
    const g = st.marks.find((m) => m.type === 'group' && m.photos.includes(sel)
      && m.photos.length <= AUTO_EXPAND_MAX);
    if (g && st.expanded !== g.key) { st.expanded = g.key; compute(); }
  }

  function open(centerIdx) {
    st.open = true; st.center = centerIdx; st.hover = null; st.expanded = -1; st.tiles = null;
    root.hidden = false;
    st.rIdx = chooseRadius();
    compute();
    autoExpandSelected();
  }
  function close() { st.open = false; root.hidden = true; st.token++; }

  return {
    open, close,
    redraw: () => { if (st.open) autoExpandSelected(); redraw(); },
    isOpen: () => st.open,
    // ---- test hooks (indices and counts only)
    state: () => ({
      open: st.open, radius: RADII[st.rIdx], size: st.size, n: st.near.length,
      marks: st.marks.length, groups: st.marks.filter((m) => m.type === 'group').length,
      largestGroup: Math.max(0, ...st.marks.filter((m) => m.type === 'group').map((m) => m.photos.length)),
      overlaps: st.overlaps, outlines: st.lines.length, center: st.center, expanded: st.expanded,
      maxDisplacement: Math.max(0, ...st.marks.map((m) => Math.hypot(m.x - m.hx, m.y - m.hy))),
      meanDisplacement: st.marks.length
        ? st.marks.reduce((a, m) => a + Math.hypot(m.x - m.hx, m.y - m.hy), 0) / st.marks.length : 0,
    }),
    marks: () => st.marks.map((m) => ({ type: m.type, i: m.i, key: m.key, x: m.x, y: m.y,
      photos: m.photos || null, expanded: !!m.expanded })),
    kids: () => { const g = expandedGroup(); return g ? g.kids.map((k) => ({ i: k.i, x: k.x, y: k.y })) : []; },
    setRadius: (r) => { const k = RADII.indexOf(r); if (k >= 0) { st.rIdx = k; afterRadiusChange(); } },
    canvasOffset: () => { const r = canvasHost.getBoundingClientRect(); return [r.left, r.top]; },
  };
}
