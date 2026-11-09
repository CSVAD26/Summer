// MODE 02 — CULINARY COLLAGE
//
// A second sphere whose surface is a precomputed equirectangular atlas (built locally by
// scripts/build_collage.py). The sphere is built from an explicit latitude/longitude grid with
// matching UVs, using the same lat/lon -> 3D function as the outlines and dots, so the texture
// is exactly aligned with the geography, rotates with the globe, has no seam at ±180° and is
// hidden on the far side by the depth buffer like the minimal sphere.
// The texture is loaded once, on first use, and cached on the GPU (one shared texture).

export function createCollage({ THREE, globe, renderer, llToVec, lineLayer, borderColor, borderRadius, url }) {
  let mesh = null;
  let admin1 = null;
  let loading = null;

  function buildSphere(texture) {
    const LON = 360, LAT = 180;                       // 1° grid
    const pos = new Float32Array((LON + 1) * (LAT + 1) * 3);
    const uv = new Float32Array((LON + 1) * (LAT + 1) * 2);
    const v = new THREE.Vector3();
    let p = 0, t = 0;
    for (let i = 0; i <= LAT; i++) {
      const lat = -90 + (180 * i) / LAT;
      for (let j = 0; j <= LON; j++) {
        const lon = -180 + (360 * j) / LON;
        llToVec(lat, lon, 1, v);
        pos[p++] = v.x; pos[p++] = v.y; pos[p++] = v.z;
        uv[t++] = j / LON;                               // u: lon -180..180
        uv[t++] = i / LAT;                               // v: lat -90..90 (image top = north)
      }
    }
    const idx = [];
    const row = LON + 1;
    for (let i = 0; i < LAT; i++) {
      for (let j = 0; j < LON; j++) {
        const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
        idx.push(a, b, c, b, d, c);                     // counter-clockwise seen from outside
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      map: texture, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));
    m.visible = false;
    return m;
  }

  async function load() {
    if (!loading) {
      loading = (async () => {
        const [texture, lines] = await Promise.all([
          new THREE.TextureLoader().loadAsync(url),
          fetch('geo/admin1_lines.json').then((r) => (r.ok ? r.json() : { lines: [] })).catch(() => ({ lines: [] })),
        ]);
        mesh = buildSphere(texture);
        globe.add(mesh);
        // US state + China province outlines keep neighbouring collages visibly separate
        admin1 = lineLayer(lines.lines || [], borderRadius, borderColor);
        admin1.visible = false;
        globe.add(admin1);
        return true;
      })().catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  return {
    load,
    /** Show or hide the collage surface. Resolves false if the texture is unavailable. */
    async show(on) {
      if (on) {
        try { await load(); } catch { return false; }
      }
      if (mesh) mesh.visible = !!on;
      if (admin1) admin1.visible = !!on;
      return true;
    },
    ready: () => !!mesh,
  };
}
