// Materials for 3D models (Stage 9.4), drawn on canvases here: nothing is fetched. Timber has long streaks along the
// grain for faces and growth rings for end grain (the build code maps each face to one or the other by the part's
// grain direction, cut faces included). Ply shows its layers on its edges. Steel, concrete and plain are simple and
// honest. Texture coordinates arrive in metres; each texture's repeat sets how many millimetres one tile covers.
import * as THREE from "three";
import type { ModelMaterial } from "../../../../src/shared/protocol";

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Value noise that wraps every px by py lattice cells, so a texture tiles without a seam. */
function periodicNoise(seed: number, px: number, py: number) {
  const lat = new Float32Array(px * py);
  let h = seed >>> 0 || 1;
  for (let i = 0; i < lat.length; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    lat[i] = (h >>> 0) / 4294967296;
  }
  return (x: number, y: number) => {
    const xi = Math.floor(x),
      yi = Math.floor(y);
    const fx = x - xi,
      fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx),
      uy = fy * fy * (3 - 2 * fy);
    const g = (i: number, j: number) => lat[(((j % py) + py) % py) * px + (((i % px) + px) % px)];
    const a = g(xi, yi),
      b = g(xi + 1, yi),
      c = g(xi, yi + 1),
      d = g(xi + 1, yi + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}

type Wood = { early: string; late: string; rings: number; contrast: number; pores: number; rays?: boolean };
const WOOD: Record<string, Wood> = {
  pine: { early: "#E3C48F", late: "#BE8C52", rings: 16, contrast: 0.7, pores: 0 },
  hardwood: { early: "#B07250", late: "#7E4830", rings: 24, contrast: 0.5, pores: 0.05 },
  oak: { early: "#CBA779", late: "#9A7245", rings: 20, contrast: 0.55, pores: 0.08, rays: true },
  walnut: { early: "#6F4B33", late: "#462C1D", rings: 20, contrast: 0.45, pores: 0.05 },
  birch: { early: "#DDC79F", late: "#CBB083", rings: 12, contrast: 0.3, pores: 0 },
};

const canvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

function paint(c: HTMLCanvasElement, f: (x: number, y: number) => RGB) {
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(c.width, c.height);
  const d = img.data;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      const [r, g, b] = f(x, y);
      const i = (y * c.width + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Long grain: one tile is 800 mm along the grain (u) by 200 mm across it (v), and wraps both ways. Growth lines run along
 * the board, gently wavy, wider and narrower; fine fibre streaks run with them; open-pored timbers get short pores.
 */
function sideGrain(w: Wood, seed: number) {
  const W = 1024,
    H = 256;
  const warp = periodicNoise(seed, 5, 4),
    width = periodicNoise(seed + 7, 1, w.rings),
    broad = periodicNoise(seed + 19, 3, 3),
    fibre = periodicNoise(seed + 13, 10, 140),
    pores = periodicNoise(seed + 29, 40, 260);
  const early = hex(w.early),
    late = hex(w.late);
  return paint(canvas(W, H), (x, y) => {
    const u = x / W,
      v = y / H;
    const wv = (warp(u * 5, v * 4) - 0.5) * 1.3 + (warp(u * 5 + 2.3, v * 4 + 1.7) - 0.5) * 0.5;
    const r = v * w.rings + wv + (width(0, v * w.rings) - 0.5) * 0.9;
    const f = r - Math.floor(r);
    // early wood rising to a sharper late-wood line
    const band = smooth(0.5, 0.9, f) * (1 - smooth(0.93, 1, f));
    let col = mix(early, late, band * w.contrast);
    let k = 1 + (broad(u * 3, v * 3) - 0.5) * 0.14 + (fibre(u * 10, v * 140) - 0.5) * 0.1;
    if (w.pores && pores(u * 40, v * 260) > 1 - w.pores) k *= 0.88;
    col = [col[0] * k, col[1] * k, col[2] * k];
    return col;
  });
}

/** End grain: one tile is 600 mm square, growth rings round its centre (the build code puts the pith off the board). */
function endGrain(w: Wood, seed: number) {
  const S = 512;
  const wob = periodicNoise(seed + 3, 16, 8),
    grain = periodicNoise(seed + 11, 64, 64),
    rays = periodicNoise(seed + 17, 180, 4);
  const early = hex(w.early),
    late = hex(w.late);
  const ringMm = (200 / w.rings) * 1.05;
  return paint(canvas(S, S), (x, y) => {
    const dx = (x - S / 2) * (600 / S),
      dy = (y - S / 2) * (600 / S);
    const rmm = Math.hypot(dx, dy);
    const a = (Math.atan2(dy, dx) / (Math.PI * 2) + 0.5) * 16;
    const r = rmm / ringMm + (wob(a, rmm / 40) - 0.5) * 1.1;
    const f = r - Math.floor(r);
    const band = smooth(0.5, 0.9, f) * (1 - smooth(0.92, 1, f));
    let col = mix(early, late, band * (w.contrast + 0.15));
    let k = 0.84 * (1 + (grain(x / 8, y / 8) - 0.5) * 0.14);
    if (w.rays && rays((a / 16) * 180, rmm / 150) > 0.9) k *= 0.9;
    col = [col[0] * k, col[1] * k, col[2] * k];
    return col;
  });
}

/** Ply edge: seven layers across the thickness (v 0 to 1), each a slightly different veneer, thin glue lines between. */
function plyEdge(seed: number) {
  const W = 512,
    H = 256;
  const n = periodicNoise(seed, 32, 7),
    fine = periodicNoise(seed + 5, 128, 64);
  const a = hex("#E6CFA4"),
    b = hex("#CDAE7C");
  return paint(canvas(W, H), (x, y) => {
    const v = y / H,
      u = x / W;
    const layer = Math.min(6, Math.floor(v * 7));
    const f = v * 7 - layer;
    let col = layer % 2 ? b : a;
    const k = (1 + (n(u * 32, layer + 0.5) - 0.5) * 0.16) * (1 + (fine(u * 128, v * 64) - 0.5) * 0.1);
    col = [col[0] * k, col[1] * k, col[2] * k];
    if (f < 0.045 || f > 0.955) col = mix(col, [92, 70, 44], 0.55);
    return col;
  });
}

function speckle(base: string, seed: number, amount: number, size = 256) {
  const n = periodicNoise(seed, 64, 64),
    m = periodicNoise(seed + 9, 16, 16);
  const c0 = hex(base);
  return paint(canvas(size, size), (x, y) => {
    const u = x / size,
      v = y / size;
    let k = 1 + (n(u * 64, v * 64) - 0.5) * amount + (m(u * 16, v * 16) - 0.5) * amount * 0.6;
    if (n(u * 64 + 31.3, v * 64 + 7.1) > 0.965) k *= 0.72;
    return [c0[0] * k, c0[1] * k, c0[2] * k];
  });
}

/** The canvas textures, made once per kind and shared by every part of a model. */
export class TextureCache {
  private made = new Map<string, THREE.CanvasTexture>();
  constructor(private aniso: number) {}
  get(kind: string, make: () => HTMLCanvasElement, repeat: [number, number], offset: [number, number] = [0, 0]) {
    let t = this.made.get(kind);
    if (!t) {
      t = new THREE.CanvasTexture(make());
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this.aniso;
      t.repeat.set(repeat[0], repeat[1]);
      t.offset.set(offset[0], offset[1]);
      t.name = kind;
      this.made.set(kind, t);
    }
    return t;
  }
  dispose() {
    for (const t of this.made.values()) t.dispose();
    this.made.clear();
  }
}

const SEEDS: Record<string, number> = { pine: 11, hardwood: 23, oak: 37, walnut: 41, birch: 53 };

/**
 * The two materials a part's triangles use (group 0: long grain or a ply face; group 1: end grain or a ply edge), with
 * a slight tint of its own so two boards don't look like copies.
 */
export function materialsFor(m: ModelMaterial, tint: number, tex: TextureCache): [THREE.Material, THREE.Material] {
  const c = new THREE.Color(tint, tint, tint * 0.985);
  const std = (o: ConstructorParameters<typeof THREE.MeshStandardMaterial>[0]) =>
    new THREE.MeshStandardMaterial({ color: c, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, ...o });
  if (m === "pine" || m === "hardwood" || m === "oak" || m === "walnut") {
    const w = WOOD[m];
    const side = tex.get(`${m}-side`, () => sideGrain(w, SEEDS[m]), [1000 / 800, 1000 / 200]);
    const end = tex.get(`${m}-end`, () => endGrain(w, SEEDS[m]), [1000 / 600, 1000 / 600], [0.5, 0.5]);
    return [std({ map: side, roughness: 0.62, metalness: 0 }), std({ map: end, roughness: 0.78, metalness: 0 })];
  }
  if (m === "ply") {
    const face = tex.get("ply-face", () => sideGrain(WOOD.birch, SEEDS.birch), [1000 / 800, 1000 / 200]);
    const edge = tex.get("ply-edge", () => plyEdge(61), [1000 / 300, 1]);
    return [std({ map: face, roughness: 0.6 }), std({ map: edge, roughness: 0.8 })];
  }
  if (m === "mdf") {
    const t = tex.get("mdf", () => speckle("#B08A60", 71, 0.08), [1000 / 300, 1000 / 300]);
    const a = std({ map: t, roughness: 0.82 });
    return [a, a];
  }
  if (m === "concrete") {
    const t = tex.get("concrete", () => speckle("#A3A19B", 83, 0.22, 512), [1000 / 600, 1000 / 600]);
    const a = std({ map: t, roughness: 0.95 });
    return [a, a];
  }
  if (m === "steel") {
    const a = std({ color: new THREE.Color("#A9AFB5").multiplyScalar(tint), metalness: 1, roughness: 0.34 });
    return [a, a];
  }
  const a = std({ color: new THREE.Color("#D9D5CD").multiplyScalar(tint), roughness: 0.78 });
  return [a, a];
}
