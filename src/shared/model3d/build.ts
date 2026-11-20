// Turning a model (Stage 9.1) into solids: each part is its stock with every cut taken away, in its own frame, then
// turned and moved into place. Used by the server (the checks, the files for Blender) and by the app (the viewer), so
// both see the same shapes. With mesh: true it also makes what a screen draws: triangles, normals, texture
// coordinates that run with the grain (long grain on the faces, end grain on the ends, cut faces included), and the
// sharp edges to outline.
import type { ModelMaterial, ModelPart, ModelPayload } from "../protocol.js";
import { type Axis, type Box3, type V3, type Xf, AXES, apply, applyDir, boxSize, boxesOverlap, dot, emptyBox, grow, seeded, sub, xf } from "./math.js";
import { type Poly, normalAt, subtract, volumeOf } from "./csg.js";
import { solidPolys } from "./solids.js";

/** Triangles for a screen. groups: which material each run of triangles takes (0: long grain or face, 1: end grain or ply edge). */
export type MeshData = { positions: Float32Array; normals: Float32Array; uvs: Float32Array; groups: { start: number; count: number; mat: 0 | 1 }[] };

export type CutEffect = { cut: number; problem: "removes nothing" | "removes the whole part" };

export type BuiltPart = {
  id: string;
  name: string;
  material: ModelMaterial;
  /** The grain direction in the part's own frame. */
  grain: Axis;
  /** Own frame → model. */
  frame: Xf;
  /** The finished part, placed in the model (assembled). */
  polys: Poly[];
  volume: number;
  stockVolume: number;
  cutEffects: CutEffect[];
  /** Finished size in its own frame (length along x, y, z). */
  size: V3;
  /** Where it sits in the model, assembled. */
  bbox: Box3;
  apart: V3;
  mesh?: MeshData;
  /** Sharp edges as line segments (pairs of points), placed in the model. */
  edges?: Float32Array;
};

export type BuiltModel = { parts: BuiltPart[]; bbox: Box3; bboxApart: Box3; ms: number };

export const TIMBER: ModelMaterial[] = ["pine", "hardwood", "oak", "walnut"];
const VOL_TOL = 0.5; // mm³: a cut that changes less than this removed nothing

export function polysBox(polys: Poly[], b: Box3 = emptyBox()) {
  for (const p of polys) for (const v of p.v) grow(b, v);
  return b;
}

const placePoly = (x: Xf, p: Poly): Poly => {
  const v = p.v.map((q) => apply(x, q));
  const n = applyDir(x, p.p.n);
  return { v, p: { n, w: dot(n, v[0]) }, ...(p.sm ? { sm: { c: apply(x, p.sm.c), d: applyDir(x, p.sm.d), s: p.sm.s } } : {}) };
};

/** The longest side of a box's size: the grain's way when none is given. */
export const longestAxis = (s: V3): Axis => (s[0] >= s[1] && s[0] >= s[2] ? "x" : s[1] >= s[2] ? "y" : "z");

export function buildPart(part: ModelPart, opts: { mesh?: boolean } = {}): BuiltPart {
  let polys = solidPolys(part.stock);
  const stockBox = polysBox(polys);
  const stockVolume = volumeOf(polys);
  let volume = stockVolume;
  let box = stockBox;
  const cutEffects: CutEffect[] = [];
  (part.cuts ?? []).forEach((c, i) => {
    if (volume < VOL_TOL) return;
    const cp = solidPolys(c);
    if (!boxesOverlap(box, polysBox(cp), 1e-6)) return void cutEffects.push({ cut: i + 1, problem: "removes nothing" });
    const next = subtract(polys, cp);
    const v = volumeOf(next);
    if (volume - v < VOL_TOL) return void cutEffects.push({ cut: i + 1, problem: "removes nothing" });
    polys = next;
    volume = v;
    box = polysBox(polys);
    if (v < VOL_TOL) cutEffects.push({ cut: i + 1, problem: "removes the whole part" });
  });
  const grain = part.grain ?? longestAxis(boxSize(stockBox));
  const frame = xf(part.rot, part.at);
  const placed = polys.map((p) => placePoly(frame, p));
  const out: BuiltPart = {
    id: part.id,
    name: part.name,
    material: part.material,
    grain,
    frame,
    polys: placed,
    volume,
    stockVolume,
    cutEffects,
    size: volume < VOL_TOL ? [0, 0, 0] : boxSize(polysBox(polys)),
    bbox: polysBox(placed),
    apart: part.apart ?? [0, 0, 0],
  };
  if (opts.mesh && volume >= VOL_TOL) {
    const fixed = closeGaps(polys);
    out.mesh = meshOf(part, polys, fixed, frame, grain, boxSize(stockBox), stockBox);
    out.edges = sharpEdges(polys, fixed, frame);
  }
  return out;
}

export function buildModel(m: ModelPayload, opts: { mesh?: boolean } = {}): BuiltModel {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const parts = m.parts.map((p) => buildPart(p, opts));
  const bbox = emptyBox();
  const bboxApart = emptyBox();
  for (const p of parts) {
    if (!Number.isFinite(p.bbox.min[0])) continue;
    grow(grow(bbox, p.bbox.min), p.bbox.max);
    for (const c of [p.bbox.min, p.bbox.max]) grow(bboxApart, [c[0] + p.apart[0], c[1] + p.apart[1], c[2] + p.apart[2]]);
  }
  const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  return { parts, bbox, bboxApart, ms };
}

/* ---------------- closing the little gaps cutting leaves (T-junctions) ---------------- */

const KEY = 1e3; // vertices within a thousandth of a millimetre are the same point
const vkey = (p: V3) => `${Math.round(p[0] * KEY)},${Math.round(p[1] * KEY)},${Math.round(p[2] * KEY)}`;

/**
 * Cutting splits faces, and a corner of one piece can sit part-way along the edge of its neighbour. Put every such corner
 * into the neighbour's edge too, so the surface has no hairline cracks and the edge-finder sees matching edges.
 */
function closeGaps(polys: Poly[]): V3[][] {
  const seen = new Map<string, V3>();
  for (const p of polys) for (const v of p.v) if (!seen.has(vkey(v))) seen.set(vkey(v), v);
  const pts = [...seen.values()].sort((a, b) => a[0] - b[0]);
  const xs = pts.map((p) => p[0]);
  const lower = (x: number) => {
    let lo = 0,
      hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const tol = 1e-3;
  return polys.map((p) => {
    const out: V3[] = [];
    for (let i = 0; i < p.v.length; i++) {
      const a = p.v[i],
        b = p.v[(i + 1) % p.v.length];
      out.push(a);
      const ab = sub(b, a);
      const l2 = dot(ab, ab);
      if (l2 < 1e-12) continue;
      const between: [number, V3][] = [];
      const x0 = Math.min(a[0], b[0]) - tol,
        x1 = Math.max(a[0], b[0]) + tol;
      for (let k = lower(x0); k < pts.length && pts[k][0] <= x1; k++) {
        const c = pts[k];
        const t = dot(sub(c, a), ab) / l2;
        if (t <= 1e-7 || t >= 1 - 1e-7) continue;
        const d = sub(c, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
        if (dot(d, d) < tol * tol) between.push([t, c]);
      }
      between.sort((u, w) => u[0] - w[0]);
      for (const [, c] of between) out.push(c);
    }
    return out;
  });
}

/* ---------------- what a screen draws ---------------- */

/** Edges where the faces either side meet at more than 30°, or with only one face (none, on a closed solid). */
function sharpEdges(polys: Poly[], fixed: V3[][], frame: Xf): Float32Array {
  const cos30 = Math.cos((30 * Math.PI) / 180);
  const edges = new Map<string, { a: V3; b: V3; n: V3[] }>();
  fixed.forEach((vs, pi) => {
    const n = polys[pi].p.n;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i],
        b = vs[(i + 1) % vs.length];
      const ka = vkey(a),
        kb = vkey(b);
      if (ka === kb) continue;
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = edges.get(k);
      if (e) e.n.push(n);
      else edges.set(k, { a, b, n: [n] });
    }
  });
  const out: number[] = [];
  for (const e of edges.values()) {
    let sharp = e.n.length === 1;
    for (let i = 0; i < e.n.length && !sharp; i++) for (let j = i + 1; j < e.n.length && !sharp; j++) if (dot(e.n[i], e.n[j]) < cos30) sharp = true;
    if (!sharp) continue;
    const a = apply(frame, e.a),
      b = apply(frame, e.b);
    out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  return new Float32Array(out);
}

/**
 * Triangles with texture coordinates in metres, worked out in the part's own frame so they run with its grain. Timber:
 * a face whose normal runs mostly along the grain is end grain (rings, centred off the board the way a sawn board's
 * pith is); every other face is long grain, streaks along the grain. Ply: its two broad faces are veneer, every other
 * face shows the layers (v runs 0 to 1 across the thickness). Each part gets its own offset, so boards differ.
 */
function meshOf(part: ModelPart, polys: Poly[], fixed: V3[][], frame: Xf, grain: Axis, stockSize: V3, stockBox: Box3): MeshData {
  const g = AXES.indexOf(grain);
  const rnd = seeded(`${part.id}:${part.name}`);
  const du = rnd() * 3,
    dv = rnd() * 0.6;
  const others = [0, 1, 2].filter((i) => i !== g);
  // where the rings centre on the end grain: off the board, at a different spot for each part
  const half = Math.max(30, Math.hypot(stockSize[others[0]], stockSize[others[1]]) / 2);
  const ang = rnd() * Math.PI * 2;
  const reach = half * (0.9 + 0.9 * rnd());
  const ring = [
    (stockBox.min[others[0]] + stockBox.max[others[0]]) / 2 + Math.cos(ang) * reach,
    (stockBox.min[others[1]] + stockBox.max[others[1]]) / 2 + Math.sin(ang) * reach,
  ];
  const ply = part.material === "ply";
  const thick = [0, 1, 2].reduce((m, i) => (stockSize[i] < stockSize[m] ? i : m), 0);
  const timber = TIMBER.includes(part.material);
  const sets: number[][] = [[], []]; // per material, flattened per corner: position (3), normal (3), uv (2)
  const emit = (set: number, p: V3, n: V3, uv: [number, number]) => {
    const q = apply(frame, p),
      m = applyDir(frame, n);
    sets[set].push(q[0], q[1], q[2], m[0], m[1], m[2], uv[0], uv[1]);
  };
  fixed.forEach((vs, pi) => {
    const poly = polys[pi];
    const n = poly.p.n;
    const an = n.map(Math.abs);
    const dom = an[0] >= an[1] && an[0] >= an[2] ? 0 : an[1] >= an[2] ? 1 : 2;
    let set = 0;
    let uvOf: (p: V3) => [number, number];
    if (ply) {
      if (dom === thick) {
        const along = g === thick ? [0, 1, 2].find((i) => i !== thick)! : g;
        const across = [0, 1, 2].find((i) => i !== thick && i !== along)!;
        uvOf = (p) => [p[along] / 1000 + du, p[across] / 1000 + dv];
      } else {
        set = 1;
        const along = [0, 1, 2].find((i) => i !== thick && i !== dom)!;
        const t0 = stockBox.min[thick];
        const span = Math.max(1e-6, stockSize[thick]);
        uvOf = (p) => [p[along] / 1000 + du, (p[thick] - t0) / span];
      }
    } else if (timber && dom === g) {
      set = 1;
      uvOf = (p) => [(p[others[0]] - ring[0]) / 1000, (p[others[1]] - ring[1]) / 1000];
    } else {
      const across = timber ? [0, 1, 2].find((i) => i !== g && i !== dom)! : [0, 1, 2].filter((i) => i !== dom)[1];
      const along = timber ? g : [0, 1, 2].filter((i) => i !== dom)[0];
      uvOf = (p) => [p[along] / 1000 + du, p[across] / 1000 + dv];
    }
    for (let i = 1; i + 1 < vs.length; i++) {
      const a = vs[0],
        b = vs[i],
        c = vs[i + 1];
      const ab = sub(b, a),
        ac = sub(c, a);
      const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      if (Math.hypot(cr[0], cr[1], cr[2]) < 1e-9) continue; // a sliver with no area
      for (const p of [a, b, c]) emit(set, p, normalAt(poly, p), uvOf(p));
    }
  });
  const count = (sets[0].length + sets[1].length) / 8;
  const positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3),
    uvs = new Float32Array(count * 2);
  let k = 0;
  const groups: MeshData["groups"] = [];
  for (const mat of [0, 1] as const) {
    const s = sets[mat];
    const start = k;
    for (let i = 0; i < s.length; i += 8, k++) {
      positions.set([s[i], s[i + 1], s[i + 2]], k * 3);
      normals.set([s[i + 3], s[i + 4], s[i + 5]], k * 3);
      uvs.set([s[i + 6], s[i + 7]], k * 2);
    }
    if (k > start) groups.push({ start, count: k - start, mat });
  }
  return { positions, normals, uvs, groups };
}
