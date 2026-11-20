// Linework for shop drawings (Stage 12.1): our own hidden-line removal on the solids src/shared/model3d already makes.
// No mesh screenshot, no CAD kernel. The steps:
//   1. Merge the cutting's fragments back into true faces: flat ones by plane, round ones by cylinder.
//   2. Edges are those faces' boundaries (found by adding up each edge's coverage along its line, so the little splits
//      the cutting leaves cancel out). Round faces add their silhouette for the view, never their facet lines.
//   3. Project; split every edge where it crosses or touches another; test each piece against the faces in front of it;
//      merge pieces on the same line (visible wins over hidden) and chain them into continuous lines.
//   4. A rim seen end on is put back as a true circle or arc.
//   5. Sections: each part is cut by the plane (the near side taken away); the cut faces become closed loops to hatch.
// Pure functions, millimetres, the same code on the server and in the tests.
import type { BuiltModel, BuiltPart } from "../model3d/build.js";
import { type Box3, type V3, cross, dot, emptyBox, grow, norm, scale, sub } from "../model3d/math.js";
import { type Poly, subtract } from "../model3d/csg.js";
import { solidPolys } from "../model3d/solids.js";

export type P2 = [number, number];
export type LineKind = "visible" | "hidden" | "cut";

/** How the viewer looks: f is the way they look (into the paper); right and up are the paper's x and y. */
export type ViewDir = { f: V3; right: V3; up: V3 };

export const VIEWS = {
  /** Looking at the front (from -y), x to the right, z up. */
  front: { f: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1] } as ViewDir,
  /** Looking down (from +z), x to the right, y up the paper. */
  top: { f: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] } as ViewDir,
  /** Looking from the right (from +x), y to the right, z up. */
  right: { f: [-1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] } as ViewDir,
  /** Looking from the left (from -x), -y to the right, z up. */
  left: { f: [1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] } as ViewDir,
  /** Looking from the back (from +y). */
  back: { f: [0, -1, 0], right: [-1, 0, 0], up: [0, 0, 1] } as ViewDir,
  /** Looking up from underneath. */
  bottom: { f: [0, 0, 1], right: [1, 0, 0], up: [0, -1, 0] } as ViewDir,
};

/** A view from any direction (looking along f), with z kept upright on the paper where it can be. */
export function viewFrom(f: V3, upHint: V3 = [0, 0, 1]): ViewDir {
  const F = norm(f);
  let up = upHint;
  if (Math.abs(dot(norm(up), F)) > 0.999) up = [0, 1, 0];
  const right = norm(cross(F, up));
  return { f: F, right, up: norm(cross(right, F)) };
}

/** The usual three-quarter (isometric) view: from the front, right and above. */
export const ISO = viewFrom([-1, 1, -1]);

export type Chain = { pts: P2[]; kind: LineKind; part: number; closed?: boolean };
/** A circle or part of one, counter-clockwise from a0 to a1 (radians); full when a1 - a0 >= 2π. */
export type Arc2 = { c: P2; r: number; a0: number; a1: number; kind: LineKind; part: number };
/** A part's cut face, as closed loops (holes included; filled even-odd). */
export type Hatch = { part: number; loops: P2[][] };
export type ViewLines = { chains: Chain[]; arcs: Arc2[]; hatches: Hatch[]; min: P2; max: P2; ms: number; dir?: ViewDir };

/* ---------------- small helpers ---------------- */

const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const TOL3 = 1e-4; // mm: points this close are the same, lines this close the same line
const ANG = 1e-9; // directions whose dot product is within this of 1 are the same

/** A direction pointing the canonical way (its first clear component positive), and whether it was flipped. */
function canon(d: V3): [V3, number] {
  const k = Math.abs(d[0]) > 1e-6 ? 0 : Math.abs(d[1]) > 1e-6 ? 1 : 2;
  return d[k] < 0 ? [scale(d, -1), -1] : [d, 1];
}

type Item = { t0: number; t1: number; v: number; tag?: number; f?: number };
type LineGroup = { d: V3; p0: V3; items: Item[] };

/** Groups directed segments by the line they lie on; each item is its span along the line and its direction (±1). */
function groupByLine(segs: { a: V3; b: V3; tag?: number; f?: number }[]): LineGroup[] {
  const groups: LineGroup[] = [];
  const byDir = new Map<string, LineGroup[]>();
  for (const s of segs) {
    const dv = sub(s.b, s.a);
    const L = len3(dv);
    if (L < 1e-9) continue;
    const [d, sign] = canon(scale(dv, 1 / L));
    const p0 = sub(s.a, scale(d, dot(s.a, d)));
    const key = `${Math.round(d[0] * 1e4)},${Math.round(d[1] * 1e4)},${Math.round(d[2] * 1e4)}`;
    let near: LineGroup | undefined;
    // the direction key is coarse (1e-4), so look at it and its neighbours' lines with real tolerances
    for (const k of neighbourKeys(key)) {
      for (const g of byDir.get(k) ?? []) if (dot(g.d, d) > 1 - ANG && len3(sub(g.p0, sub(p0, scale(g.d, dot(p0, g.d))))) < TOL3) near = g;
      if (near) break;
    }
    if (!near) {
      near = { d, p0, items: [] };
      groups.push(near);
      const list = byDir.get(key) ?? [];
      list.push(near);
      byDir.set(key, list);
    }
    const ta = dot(s.a, near.d),
      tb = dot(s.b, near.d);
    near.items.push({ t0: Math.min(ta, tb), t1: Math.max(ta, tb), v: ta < tb ? 1 : -1, ...(s.tag !== undefined ? { tag: s.tag } : {}), ...(s.f !== undefined ? { f: s.f } : {}) });
    void sign;
  }
  return groups;
}
function neighbourKeys(key: string): string[] {
  const [a, b, c] = key.split(",").map(Number);
  const out = [key];
  for (const da of [-1, 0, 1]) for (const db of [-1, 0, 1]) for (const dc of [-1, 0, 1]) if (da || db || dc) out.push(`${a + da},${b + db},${c + dc}`);
  return out;
}

/** The elementary spans of a line group, each with the items over it. */
function sweep(items: Item[], tol = 1e-6): { t0: number; t1: number; over: Item[] }[] {
  const ts = items.flatMap((i) => [i.t0, i.t1]).sort((a, b) => a - b);
  const cuts: number[] = [];
  for (const t of ts) if (!cuts.length || t - cuts[cuts.length - 1] > tol) cuts.push(t);
  const out: { t0: number; t1: number; over: Item[] }[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k],
      b = cuts[k + 1];
    const m = (a + b) / 2;
    const over = items.filter((i) => i.t0 <= m && i.t1 >= m);
    if (over.length) out.push({ t0: a, t1: b, over });
  }
  return out;
}

/** Back from a span on a line to its two 3D ends. */
const at3 = (g: LineGroup, t: number): V3 => [g.p0[0] + g.d[0] * t, g.p0[1] + g.d[1] * t, g.p0[2] + g.d[2] * t];

/** Joins touching spans that share a value. */
function joinSpans<T extends { t0: number; t1: number }>(spans: T[], same: (a: T, b: T) => boolean, tol = 1e-6): T[] {
  const out: T[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t1 - s.t0) <= tol && same(last, s)) last.t1 = s.t1;
    else out.push({ ...s });
  }
  return out;
}

/* ---------------- 1 and 2: faces and their edges, per part ---------------- */

export type Cyl = { c: V3; d: V3; r: number };
type Face = { plane?: { n: V3; w: number }; cyl?: Cyl & { s: number }; polys: Poly[] };
/** A part's edges that don't depend on the view: every face boundary, and round faces' facet edges for silhouettes. */
export type PartEdges = {
  part: number;
  /** Face boundaries: a, b, and the cylinder a rim belongs to (index into cyls). */
  edges: { a: V3; b: V3; cyl?: number }[];
  cyls: Cyl[];
  /** Each round face's facets' edges with the facet's normal, for the silhouette in a given view. */
  smooth: { groups: LineGroup[]; normals: V3[] }[];
  /** Directed boundary loops of faces lying on a given plane, for sections (filled later). */
  faces: Face[];
  polys: Poly[];
};

function mergeFaces(polys: Poly[]): Face[] {
  const faces: Face[] = [];
  for (const p of polys) {
    if (p.sm) {
      const d = canon(norm(p.sm.d))[0];
      // radius from the axis: the furthest corner (a piece cut from inside a facet has corners on the chord, a little in)
      const r = Math.max(
        ...p.v.map((v) => {
          const rel = sub(v, p.sm!.c);
          return len3(sub(rel, scale(d, dot(rel, d))));
        }),
      );
      const c0 = sub(p.sm.c, scale(d, dot(p.sm.c, d))); // the axis's point nearest the origin
      // the same round face within the facets' sag (2% of the radius covers 32 facets with room)
      let f = faces.find((x) => x.cyl && x.cyl.s === p.sm!.s && dot(x.cyl.d, d) > 1 - 1e-9 && len3(sub(x.cyl.c, c0)) < TOL3 && Math.abs(x.cyl.r - r) < 1e-3 + 0.02 * Math.max(r, x.cyl.r));
      if (!f) faces.push((f = { cyl: { c: c0, d, r, s: p.sm.s }, polys: [] }));
      if (r > f.cyl!.r) f.cyl!.r = r;
      f.polys.push(p);
      continue;
    }
    let f = faces.find((x) => x.plane && dot(x.plane.n, p.p.n) > 1 - 1e-9 && Math.abs(x.plane.w - p.p.w) < TOL3);
    if (!f) faces.push((f = { plane: { n: p.p.n, w: p.p.w }, polys: [] }));
    f.polys.push(p);
  }
  return faces;
}

const polyEdges = (polys: Poly[]) => polys.flatMap((p) => p.v.map((a, i) => ({ a, b: p.v[(i + 1) % p.v.length] })));

/** A face's boundary: where the edges of its pieces don't cancel. Directed (counter-clockwise seen from outside). */
function faceBoundary(face: Face): { a: V3; b: V3 }[] {
  const out: { a: V3; b: V3 }[] = [];
  for (const g of groupByLine(polyEdges(face.polys))) {
    const spans = sweep(g.items)
      .map((s) => ({ t0: s.t0, t1: s.t1, v: Math.round(s.over.reduce((t, i) => t + i.v, 0)) }))
      .filter((s) => s.v !== 0);
    for (const s of joinSpans(spans, (a, b) => Math.sign(a.v) === Math.sign(b.v))) {
      const a = at3(g, s.t0),
        b = at3(g, s.t1);
      out.push(s.v > 0 ? { a, b } : { a: b, b: a });
    }
  }
  return out;
}

export function partEdges(polys: Poly[], part: number): PartEdges {
  const faces = mergeFaces(polys);
  const cyls: Cyl[] = [];
  const all: { a: V3; b: V3; tag?: number }[] = [];
  const smooth: PartEdges["smooth"] = [];
  for (const f of faces) {
    let tag: number | undefined;
    if (f.cyl) {
      tag = cyls.length;
      cyls.push({ c: f.cyl.c, d: f.cyl.d, r: f.cyl.r });
      // the facets' own edges, each with its facet's normal, for silhouettes
      const segs: { a: V3; b: V3; f: number }[] = [];
      const normals: V3[] = [];
      f.polys.forEach((p) => {
        normals.push(p.p.n);
        p.v.forEach((a, i) => segs.push({ a, b: p.v[(i + 1) % p.v.length], f: normals.length - 1 }));
      });
      smooth.push({ groups: groupByLine(segs), normals });
    }
    for (const e of faceBoundary(f)) all.push({ ...e, ...(tag !== undefined ? { tag } : {}) });
  }
  // each boundary is shared by the two faces either side: keep it once (with its rim's cylinder, if it is one)
  const edges: PartEdges["edges"] = [];
  for (const g of groupByLine(all)) {
    const spans = sweep(g.items).map((s) => ({ t0: s.t0, t1: s.t1, tag: s.over.find((i) => i.tag !== undefined)?.tag }));
    for (const s of joinSpans(spans, (a, b) => a.tag === b.tag)) edges.push({ a: at3(g, s.t0), b: at3(g, s.t1), ...(s.tag !== undefined ? { cyl: s.tag } : {}) });
  }
  return { part, edges, cyls, smooth, faces, polys };
}

/** A round face's silhouette in a view: facet edges with a facet facing the viewer on one side and away on the other. */
function silhouettes(pe: PartEdges, f: V3): { a: V3; b: V3 }[] {
  const out: { a: V3; b: V3 }[] = [];
  for (const s of pe.smooth) {
    const facing = s.normals.map((n) => {
      const k = dot(n, f);
      return k < -1e-9 ? 1 : k > 1e-9 ? -1 : 0; // 1: towards the viewer
    });
    for (const g of s.groups) {
      const spans = sweep(g.items)
        .map((sp) => ({ t0: sp.t0, t1: sp.t1, all: sp.over.reduce((t, i) => t + i.v, 0), front: sp.over.reduce((t, i) => t + (facing[i.f!] === 1 ? i.v : 0), 0) }))
        .filter((sp) => Math.round(sp.all) === 0 && Math.round(sp.front) !== 0);
      for (const sp of joinSpans(spans, () => true)) out.push({ a: at3(g, sp.t0), b: at3(g, sp.t1) });
    }
  }
  return out;
}

/* ---------------- 3: project, split, test, merge, chain ---------------- */

type Seg = { a: P2; b: P2; da: number; db: number; part: number; cut: boolean; circ?: number; ghost?: boolean; noHidden?: boolean; jo?: boolean };
type Tri = { a: P2; b: P2; c: P2; da: number; db: number; dc: number; part: number; minx: number; miny: number; maxx: number; maxy: number };

class Grid<T extends { minx: number; miny: number; maxx: number; maxy: number }> {
  private cells = new Map<number, T[]>();
  constructor(
    private x0: number,
    private y0: number,
    private size: number,
  ) {}
  private range(t: { minx: number; miny: number; maxx: number; maxy: number }) {
    const s = this.size;
    return [Math.floor((t.minx - this.x0) / s), Math.floor((t.miny - this.y0) / s), Math.floor((t.maxx - this.x0) / s), Math.floor((t.maxy - this.y0) / s)];
  }
  add(t: T) {
    const [i0, j0, i1, j1] = this.range(t);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = i * 100003 + j;
        const l = this.cells.get(k);
        if (l) l.push(t);
        else this.cells.set(k, [t]);
      }
  }
  near(b: { minx: number; miny: number; maxx: number; maxy: number }): Set<T> {
    const out = new Set<T>();
    const [i0, j0, i1, j1] = this.range(b);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const t of this.cells.get(i * 100003 + j) ?? []) out.add(t);
    return out;
  }
}

const segBox = (s: { a: P2; b: P2 }, pad = 0) => ({ minx: Math.min(s.a[0], s.b[0]) - pad, miny: Math.min(s.a[1], s.b[1]) - pad, maxx: Math.max(s.a[0], s.b[0]) + pad, maxy: Math.max(s.a[1], s.b[1]) + pad });

/** Where along s (0..1) each other segment crosses or touches it. */
function splitParams(s: Seg, others: Iterable<Seg>, eps: number): number[] {
  const ts: number[] = [];
  const dx = s.b[0] - s.a[0],
    dy = s.b[1] - s.a[1];
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-18) return ts;
  const L = Math.sqrt(L2);
  for (const o of others) {
    if (o === s) continue;
    const ex = o.b[0] - o.a[0],
      ey = o.b[1] - o.a[1];
    const den = dx * ey - dy * ex;
    const wx = o.a[0] - s.a[0],
      wy = o.a[1] - s.a[1];
    if (Math.abs(den) > 1e-12 * L * Math.hypot(ex, ey)) {
      const t = (wx * ey - wy * ex) / den;
      const u = (wx * dy - wy * dx) / den;
      const ol = Math.hypot(ex, ey);
      if (t > -eps / L && t < 1 + eps / L && u > -eps / ol && u < 1 + eps / ol) ts.push(t);
    } else {
      // parallel: if on the same line, the other's ends split this one
      const off = Math.abs(wx * dy - wy * dx) / L;
      if (off > eps) continue;
      for (const p of [o.a, o.b]) ts.push(((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / L2);
    }
  }
  return ts;
}

/** Whether point p (with depth d) is behind any face: inside a triangle (edges included) that is nearer by more than tol. */
function occluded(p: P2, d: number, tris: Iterable<Tri>, tol: number): boolean {
  const e = 1e-5;
  for (const t of tris) {
    if (p[0] < t.minx - e || p[0] > t.maxx + e || p[1] < t.miny - e || p[1] > t.maxy + e) continue;
    const v0x = t.b[0] - t.a[0],
      v0y = t.b[1] - t.a[1],
      v1x = t.c[0] - t.a[0],
      v1y = t.c[1] - t.a[1],
      v2x = p[0] - t.a[0],
      v2y = p[1] - t.a[1];
    const den = v0x * v1y - v1x * v0y;
    if (Math.abs(den) < 1e-12) continue;
    const u = (v2x * v1y - v1x * v2y) / den;
    const v = (v0x * v2y - v2x * v0y) / den;
    // inside, with a margin of e (in mm, measured across each edge)
    const la = Math.hypot(v0x, v0y),
      lb = Math.hypot(v1x, v1y),
      lc = Math.hypot(t.c[0] - t.b[0], t.c[1] - t.b[1]);
    const area2 = Math.abs(den);
    // distances to the three edges are (barycentric × twice the area / edge length)
    const w = 1 - u - v;
    if ((v * area2) / la < -e || (u * area2) / lb < -e || (w * area2) / lc < -e) continue;
    const dep = t.da * w + t.db * u + t.dc * v;
    if (dep < d - tol) return true;
  }
  return false;
}

export type ViewOpts = {
  /** Draw hidden lines (default true). */
  hidden?: boolean;
  /** Show only these parts' lines (the others still hide what's behind them). */
  only?: Set<number>;
  /** Move parts before drawing (pulled apart): part index → offset. */
  shift?: Map<number, V3>;
  /** Which edges may show hidden (the rest show only where seen): a general arrangement shows members, not joinery. */
  keepHidden?: (part: number, a: V3, b: V3) => boolean;
  /**
   * Only the hidden lines that explain something (Stage 19.4): a part's hidden outline only when none of it is seen
   * from this side (a shelf behind a door), and edges jointEdge says are a joint's outline (where it's marked). The
   * hidden parts of a part that's partly in view are left off: its visible part shows where it is.
   */
  sparseHidden?: boolean;
  jointEdge?: (part: number, a: V3, b: V3) => boolean;
};

/** One part's polygons, moved. */
const moved = (polys: Poly[], d: V3): Poly[] => polys.map((p) => ({ v: p.v.map((q) => [q[0] + d[0], q[1] + d[1], q[2] + d[2]] as V3), p: { n: p.p.n, w: p.p.w + dot(p.p.n, d) }, ...(p.sm ? { sm: { ...p.sm, c: [p.sm.c[0] + d[0], p.sm.c[1] + d[1], p.sm.c[2] + d[2]] as V3 } } : {}) }));

/** The parts of a model, ready to draw from any side: their faces and edges, worked out once. */
export type Prepared = { parts: PartEdges[]; built: BuiltModel };

export function prepare(built: BuiltModel, shift?: Map<number, V3>): Prepared {
  return { built, parts: built.parts.map((p, i) => partEdges(shift?.has(i) ? moved(p.polys, shift.get(i)!) : p.polys, i)) };
}

/** Draws the prepared parts as seen along v. Cut edges (on a section plane) come back as kind "cut". */
export function drawView(prep: Prepared | PartEdges[], v: ViewDir, opts: ViewOpts & { plane?: { n: V3; w: number } } = {}): ViewLines {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const parts = Array.isArray(prep) ? prep : prep.parts;
  const P = (p: V3): P2 => [dot(p, v.right), dot(p, v.up)];
  const D = (p: V3) => dot(p, v.f);
  const segs: Seg[] = [];
  const tris: Tri[] = [];
  const circles: { c: P2; r: number }[] = [];
  const onPlane = (p: V3) => !!opts.plane && Math.abs(dot(p, opts.plane.n) - opts.plane.w) < 1e-6;
  let minx = Infinity,
    miny = Infinity,
    maxx = -Infinity,
    maxy = -Infinity;
  for (const pe of parts) {
    const show = !opts.only || opts.only.has(pe.part);
    const circOf = pe.cyls.map((c) => {
      if (Math.abs(dot(c.d, v.f)) < 1 - 1e-9) return -1;
      circles.push({ c: P(c.c), r: c.r });
      return circles.length - 1;
    });
    // a part not drawn still splits the lines it hides (its outline is where they go out of sight)
    const all: { a: V3; b: V3; cyl?: number }[] = [...pe.edges, ...silhouettes(pe, v.f)];
    for (const e of all) {
      const s: Seg = { a: P(e.a), b: P(e.b), da: D(e.a), db: D(e.b), part: pe.part, cut: onPlane(e.a) && onPlane(e.b), ...(show ? {} : { ghost: true }), ...(opts.keepHidden && !opts.keepHidden(pe.part, e.a, e.b) ? { noHidden: true } : {}), ...(opts.jointEdge?.(pe.part, e.a, e.b) ? { jo: true } : {}) };
      const ci = e.cyl !== undefined ? circOf[e.cyl] : -1;
      if (ci >= 0) s.circ = ci;
      if (Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) < 1e-7) continue; // seen end on
      segs.push(s);
    }
    for (const p of pe.polys) {
      const q = p.v.map(P),
        d = p.v.map(D);
      for (let i = 1; i + 1 < q.length; i++) {
        const a = q[0],
          b = q[i],
          c = q[i + 1];
        const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        if (Math.abs(area) < 1e-6) continue; // seen edge on: hides nothing
        tris.push({ a, b, c, da: d[0], db: d[i], dc: d[i + 1], part: pe.part, minx: Math.min(a[0], b[0], c[0]), miny: Math.min(a[1], b[1], c[1]), maxx: Math.max(a[0], b[0], c[0]), maxy: Math.max(a[1], b[1], c[1]) });
      }
      for (const x of q) {
        if (x[0] < minx) minx = x[0];
        if (x[1] < miny) miny = x[1];
        if (x[0] > maxx) maxx = x[0];
        if (x[1] > maxy) maxy = x[1];
      }
    }
  }
  if (!Number.isFinite(minx)) return { chains: [], arcs: [], hatches: [], min: [0, 0], max: [0, 0], ms: 0 };
  const span = Math.max(maxx - minx, maxy - miny, 1);
  const cell = Math.max(span / Math.max(8, Math.sqrt(segs.length + tris.length) * 1.5), 1e-3);
  const eps = 1e-6 * span + 1e-7;
  const sg = new Grid<Seg & ReturnType<typeof segBox>>(minx, miny, cell);
  const boxed = segs.map((s) => Object.assign(s, segBox(s, eps)));
  for (const s of boxed) sg.add(s);
  const tg = new Grid<Tri>(minx, miny, cell);
  for (const t of tris) tg.add(t);
  const tol = 1e-3;

  // split and test
  type Piece = { a: P2; b: P2; kind: LineKind; part: number; circ?: number; jo?: boolean };
  const pieces: Piece[] = [];
  for (const s of boxed) {
    if (s.ghost) continue;
    const ts = splitParams(s, sg.near(s), eps)
      .filter((t) => t > 1e-9 && t < 1 - 1e-9)
      .sort((x, y) => x - y);
    const cuts = [0, ...ts, 1];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const u0 = cuts[k],
        u1 = cuts[k + 1];
      if (u1 - u0 < 1e-9) continue;
      const pa: P2 = [s.a[0] + (s.b[0] - s.a[0]) * u0, s.a[1] + (s.b[1] - s.a[1]) * u0];
      const pb: P2 = [s.a[0] + (s.b[0] - s.a[0]) * u1, s.a[1] + (s.b[1] - s.a[1]) * u1];
      const um = (u0 + u1) / 2;
      const m: P2 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      const dm = s.da + (s.db - s.da) * um;
      const hid = occluded(m, dm, tg.near({ minx: m[0], miny: m[1], maxx: m[0], maxy: m[1] }), tol);
      if (hid && (opts.hidden === false || s.noHidden)) continue;
      pieces.push({ a: pa, b: pb, kind: hid ? "hidden" : s.cut ? "cut" : "visible", part: s.part, ...(s.circ !== undefined ? { circ: s.circ } : {}), ...(s.jo ? { jo: true } : {}) });
    }
  }

  // only the hidden lines that explain something (19.4): of parts not seen at all from here, and joint outlines
  if (opts.sparseHidden) {
    const seen = new Set(pieces.filter((p) => p.kind !== "hidden").map((p) => p.part));
    for (let i = pieces.length - 1; i >= 0; i--) if (pieces[i].kind === "hidden" && seen.has(pieces[i].part) && !pieces[i].jo) pieces.splice(i, 1);
  }
  // rims seen end on: back to true circles and arcs
  const arcs: Arc2[] = [];
  const onCircle = new Map<number, Piece[]>();
  const straight: Piece[] = [];
  for (const p of pieces) {
    if (p.circ === undefined) straight.push(p);
    else {
      const l = onCircle.get(p.circ) ?? [];
      l.push(p);
      onCircle.set(p.circ, l);
    }
  }
  // the same circle can come from several rims (the two ends of a hole, a dowel in its hole): one circle each
  const circleKey = (c: { c: P2; r: number }) => `${Math.round(c.c[0] * 1000)},${Math.round(c.c[1] * 1000)},${Math.round(c.r * 1000)}`;
  const byCircle = new Map<string, { c: P2; r: number; ps: Piece[] }>();
  for (const [ci, ps] of onCircle) {
    const k = circleKey(circles[ci]);
    const e = byCircle.get(k) ?? { ...circles[ci], ps: [] };
    e.ps.push(...ps);
    byCircle.set(k, e);
  }
  for (const { c, r, ps } of byCircle.values()) {
    const ang = (p: P2) => {
      const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
      return a < 0 ? a + 2 * Math.PI : a;
    };
    const rank = (k: LineKind) => (k === "cut" ? 3 : k === "visible" ? 2 : 1);
    // elementary angle spans: the best kind over each
    const items = ps.map((p) => {
      let a0 = ang(p.a),
        a1 = ang(p.b);
      if (a1 < a0) [a0, a1] = [a1, a0];
      if (a1 - a0 > Math.PI) [a0, a1] = [a1, a0 + 2 * Math.PI]; // the short way round, across 0
      return { a0, a1, kind: p.kind, part: p.part };
    });
    const ts = [...new Set(items.flatMap((i) => [i.a0 % (2 * Math.PI), i.a1 % (2 * Math.PI)]).map((t) => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y);
    if (!ts.length) continue;
    const spans: { t0: number; t1: number; kind: LineKind; part: number }[] = [];
    for (let k = 0; k < ts.length; k++) {
      const a = ts[k],
        b = k + 1 < ts.length ? ts[k + 1] : ts[0] + 2 * Math.PI;
      const m = (a + b) / 2;
      let best: { kind: LineKind; part: number } | null = null;
      const m0 = m % (2 * Math.PI);
      for (const i of items) {
        const inside = [m0, m0 + 2 * Math.PI].some((mm) => mm >= i.a0 && mm <= i.a1);
        if (inside && (!best || rank(i.kind) > rank(best.kind))) best = i;
      }
      if (best) spans.push({ t0: a, t1: b, kind: best.kind, part: best.part });
    }
    const joined = joinSpans(spans, (x, y) => x.kind === y.kind && x.part === y.part, 1e-7);
    // the last span may continue into the first, across 0
    if (joined.length > 1) {
      const f = joined[0],
        l = joined[joined.length - 1];
      if (Math.abs(l.t1 - (f.t0 + 2 * Math.PI)) < 1e-7 && l.kind === f.kind && l.part === f.part) {
        f.t0 = l.t0 - 2 * Math.PI;
        joined.pop();
      }
    }
    for (const s of joined) arcs.push({ c, r, a0: s.t0, a1: s.t1, kind: s.kind, part: s.part });
  }

  // pieces on the same line: visible (and cut) win over hidden, and overlapping ones become one
  const lines = new Map<string, { d: P2; o: number; items: { t0: number; t1: number; kind: LineKind; part: number }[] }[]>();
  for (const p of straight) {
    let dx = p.b[0] - p.a[0],
      dy = p.b[1] - p.a[1];
    const L = Math.hypot(dx, dy);
    dx /= L;
    dy /= L;
    if (dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dy < 0)) ((dx = -dx), (dy = -dy));
    const o = -dy * p.a[0] + dx * p.a[1]; // signed distance of the line from the origin
    const kA = Math.round(Math.atan2(dy, dx) * 1e5),
      kO = Math.round(o * 1e2);
    let g: { d: P2; o: number; items: { t0: number; t1: number; kind: LineKind; part: number }[] } | undefined;
    for (const a of [kA, kA - 1, kA + 1])
      for (const b of [kO, kO - 1, kO + 1]) {
        for (const x of lines.get(`${a},${b}`) ?? []) if (Math.abs(x.d[0] * dx + x.d[1] * dy) > 1 - 1e-10 && Math.abs(x.o - o) < 1e-4) g = x;
        if (g) break;
      }
    if (!g) {
      g = { d: [dx, dy], o, items: [] };
      const key = `${kA},${kO}`;
      lines.set(key, [...(lines.get(key) ?? []), g]);
    }
    const ta = p.a[0] * g.d[0] + p.a[1] * g.d[1],
      tb = p.b[0] * g.d[0] + p.b[1] * g.d[1];
    g.items.push({ t0: Math.min(ta, tb), t1: Math.max(ta, tb), kind: p.kind, part: p.part });
  }
  const rank = (k: LineKind) => (k === "cut" ? 3 : k === "visible" ? 2 : 1);
  const merged: Piece[] = [];
  for (const gs of lines.values())
    for (const g of gs) {
      const spans = sweep(g.items.map((i) => ({ t0: i.t0, t1: i.t1, v: 1, tag: rank(i.kind) * 1000 + i.part })), 1e-7).map((s) => {
        const best = s.over.reduce((m, i) => (i.tag! > m ? i.tag! : m), 0);
        return { t0: s.t0, t1: s.t1, kind: (best >= 3000 ? "cut" : best >= 2000 ? "visible" : "hidden") as LineKind, part: best % 1000 };
      });
      for (const s of joinSpans(spans, (a, b) => a.kind === b.kind, 1e-7)) {
        if (s.t1 - s.t0 < 1e-6) continue;
        const nx = -g.d[1],
          ny = g.d[0];
        const P0: P2 = [nx * g.o + g.d[0] * s.t0, ny * g.o + g.d[1] * s.t0];
        const P1: P2 = [nx * g.o + g.d[0] * s.t1, ny * g.o + g.d[1] * s.t1];
        merged.push({ a: P0, b: P1, kind: s.kind, part: s.part });
      }
    }

  const chains = chainUp(merged);
  const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  return { chains, arcs, hatches: [], min: [minx, miny], max: [maxx, maxy], ms, dir: v };
}

/** Joins pieces of the same kind end to end, through corners, where exactly two meet. */
export function chainUp(pieces: { a: P2; b: P2; kind: LineKind; part: number }[]): Chain[] {
  const key = (p: P2) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const chains: Chain[] = [];
  for (const kind of ["cut", "visible", "hidden"] as LineKind[]) {
    const ps = pieces.filter((p) => p.kind === kind);
    const at = new Map<string, number[]>();
    ps.forEach((p, i) => {
      for (const k of [key(p.a), key(p.b)]) at.set(k, [...(at.get(k) ?? []), i]);
    });
    const used = new Set<number>();
    const next = (pt: P2, from: number) => {
      const l = at.get(key(pt)) ?? [];
      if (l.length !== 2) return -1; // a T or a crossing: the chain stops here
      const n = l[0] === from ? l[1] : l[0];
      return used.has(n) ? -1 : n;
    };
    // start from ends first (so open chains come out whole), then whatever is left (closed loops)
    const order = ps.map((_, i) => i).sort((i, j) => ((at.get(key(ps[i].a))!.length === 2 ? 1 : 0) + (at.get(key(ps[i].b))!.length === 2 ? 1 : 0)) - ((at.get(key(ps[j].a))!.length === 2 ? 1 : 0) + (at.get(key(ps[j].b))!.length === 2 ? 1 : 0)));
    for (const i of order) {
      if (used.has(i)) continue;
      used.add(i);
      let pts: P2[] = [ps[i].a, ps[i].b];
      // forwards from b
      let cur = i,
        end = ps[i].b;
      for (let n = next(end, cur); n >= 0; n = next(end, cur)) {
        used.add(n);
        end = key(ps[n].a) === key(end) ? ps[n].b : ps[n].a;
        pts.push(end);
        cur = n;
      }
      // backwards from a
      cur = i;
      let start = ps[i].a;
      for (let n = next(start, cur); n >= 0; n = next(start, cur)) {
        used.add(n);
        start = key(ps[n].a) === key(start) ? ps[n].b : ps[n].a;
        pts = [start, ...pts];
        cur = n;
      }
      const closed = pts.length > 3 && key(pts[0]) === key(pts[pts.length - 1]);
      if (closed) pts.pop();
      chains.push({ pts: dropCollinear(pts, closed), kind, part: ps[i].part, ...(closed ? { closed } : {}) });
    }
  }
  return chains;
}

/** Points in the middle of a straight run add nothing. */
function dropCollinear(pts: P2[], closed: boolean): P2[] {
  if (pts.length < 3) return pts;
  const out: P2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n],
      b = pts[i],
      c = pts[(i + 1) % n];
    if (!closed && (i === 0 || i === n - 1)) {
      out.push(b);
      continue;
    }
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]);
    const dt = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (l > 0 && Math.abs(cr) / l < 1e-9 && dt > 0) continue;
    out.push(b);
  }
  return out;
}

/* ---------------- 5: sections ---------------- */

/**
 * A section: every part cut by the plane n·p = w, the side the viewer is on (n points at them) taken away, seen looking
 * along -n. The cut faces come back as hatch loops per part; the edges on the plane as kind "cut". No hidden lines.
 */
export function drawSection(built: BuiltModel, plane: { n: V3; w: number }, up: V3, opts: { only?: Set<number>; window?: Box3 } = {}): ViewLines {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const n = norm(plane.n);
  const v = viewFrom(scale(n, -1), up);
  const all = emptyBox();
  for (const p of built.parts) if (Number.isFinite(p.bbox.min[0])) (grow(all, p.bbox.min), grow(all, p.bbox.max));
  const parts: PartEdges[] = [];
  built.parts.forEach((p, i) => {
    if (!p.polys.length) return;
    const near = p.polys.some((q) => q.v.some((x) => dot(x, n) > plane.w + 1e-9));
    const clipped = near ? subtract(p.polys, halfSpace(n, plane.w, all)) : p.polys;
    if (clipped.length) parts.push(partEdges(clipped, i));
  });
  const lines = drawView(parts, v, { hidden: false, only: opts.only, plane: { n, w: plane.w } });
  // the cut faces: faces on the plane facing the viewer, as loops
  const P = (p: V3): P2 => [dot(p, v.right), dot(p, v.up)];
  const hatches: Hatch[] = [];
  for (const pe of parts) {
    if (opts.only && !opts.only.has(pe.part)) continue;
    for (const f of pe.faces) {
      if (!f.plane || dot(f.plane.n, n) < 1 - 1e-9 || Math.abs(f.plane.w - plane.w) > 1e-6) continue;
      const loops = loopsOf(faceBoundary(f)).map((l) => l.map(P));
      if (loops.length) hatches.push({ part: pe.part, loops });
    }
  }
  lines.hatches = hatches;
  lines.ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  return lines;
}

/** A box covering everything on the n side of the plane (n axis-aligned or not), as polygons. */
function halfSpace(n: V3, w: number, all: Box3): Poly[] {
  const big = Math.max(...[0, 1, 2].map((i) => all.max[i] - all.min[i])) * 4 + 1000;
  const c: V3 = [(all.min[0] + all.max[0]) / 2, (all.min[1] + all.max[1]) / 2, (all.min[2] + all.max[2]) / 2];
  // a box in the plane's own frame: u, v in the plane, n out of it
  const u = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  const vv = cross(n, u);
  const o = scale(n, w - dot(c, n)); // move c onto the plane
  const base: V3 = [c[0] + o[0], c[1] + o[1], c[2] + o[2]];
  const corner = (a: number, b: number, h: number): V3 => [base[0] + u[0] * a + vv[0] * b + n[0] * h, base[1] + u[1] * a + vv[1] * b + n[1] * h, base[2] + u[2] * a + vv[2] * b + n[2] * h];
  // an axis-aligned plane makes an exact box; any other uses the same corners as a prism of the square
  const pts: [number, number][] = [
    [-big, -big],
    [big, -big],
    [big, big],
    [-big, big],
  ];
  const out: Poly[] = [];
  const poly = (v: V3[], want: V3) => {
    const p = solidFace(v, want);
    if (p) out.push(p);
  };
  poly(pts.map(([a, b]) => corner(a, b, 0)), scale(n, -1));
  poly(pts.map(([a, b]) => corner(a, b, big)), n);
  for (let i = 0; i < 4; i++) {
    const [a0, b0] = pts[i],
      [a1, b1] = pts[(i + 1) % 4];
    const mid: V3 = [u[0] * (a0 + a1) + vv[0] * (b0 + b1), u[1] * (a0 + a1) + vv[1] * (b0 + b1), u[2] * (a0 + a1) + vv[2] * (b0 + b1)];
    poly([corner(a0, b0, 0), corner(a1, b1, 0), corner(a1, b1, big), corner(a0, b0, big)], mid);
  }
  void solidPolys;
  return out;
}

function solidFace(v: V3[], want: V3): Poly | null {
  let nx = 0,
    ny = 0,
    nz = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i],
      b = v[(i + 1) % v.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-9) return null;
  let n: V3 = [nx / l, ny / l, nz / l];
  let vs = v;
  if (dot(n, want) < 0) {
    vs = v.slice().reverse();
    n = [-n[0], -n[1], -n[2]];
  }
  let w = 0;
  for (const p of vs) w += dot(n, p);
  return { v: vs, p: { n, w: w / vs.length } };
}

/** Directed boundary segments into closed loops. */
function loopsOf(segs: { a: V3; b: V3 }[]): V3[][] {
  const key = (p: V3) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
  const from = new Map<string, number[]>();
  segs.forEach((s, i) => from.set(key(s.a), [...(from.get(key(s.a)) ?? []), i]));
  const used = new Set<number>();
  const loops: V3[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    const loop: V3[] = [];
    let cur = i;
    for (let guard = 0; guard < segs.length + 1; guard++) {
      used.add(cur);
      loop.push(segs[cur].a);
      const nexts = (from.get(key(segs[cur].b)) ?? []).filter((k) => !used.has(k));
      if (!nexts.length) break;
      cur = nexts[0];
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/* ---------------- checks used by the tests ---------------- */

/**
 * Ends of lines that meet nothing: an end must touch another line's end, lie on another line, or lie on an arc. In a
 * right drawing of solids every end does (a corner, or where an edge goes behind something).
 */
export function danglingEnds(v: ViewLines, tol = 1e-3): P2[] {
  const segs: [P2, P2][] = [];
  for (const c of v.chains) {
    const n = c.pts.length;
    for (let i = 0; i + 1 < n; i++) segs.push([c.pts[i], c.pts[i + 1]]);
    if (c.closed) segs.push([c.pts[n - 1], c.pts[0]]);
  }
  const ends: { p: P2; chain: number }[] = [];
  v.chains.forEach((c, i) => {
    if (c.closed) return;
    ends.push({ p: c.pts[0], chain: i }, { p: c.pts[c.pts.length - 1], chain: i });
  });
  const arcEnds = v.arcs.filter((a) => a.a1 - a.a0 < 2 * Math.PI - 1e-6);
  for (const a of arcEnds) {
    ends.push({ p: [a.c[0] + a.r * Math.cos(a.a0), a.c[1] + a.r * Math.sin(a.a0)], chain: -1 });
    ends.push({ p: [a.c[0] + a.r * Math.cos(a.a1), a.c[1] + a.r * Math.sin(a.a1)], chain: -1 });
  }
  const out: P2[] = [];
  const onSeg = (p: P2, a: P2, b: P2) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) <= tol;
  };
  for (const e of ends) {
    let ok = false;
    // another chain's segment (its own chain's far parts count too, e.g. a hook)
    let k = 0;
    for (const c of v.chains) {
      const n = c.pts.length;
      const segsOf: [P2, P2][] = [];
      for (let i = 0; i + 1 < n; i++) segsOf.push([c.pts[i], c.pts[i + 1]]);
      if (c.closed) segsOf.push([c.pts[n - 1], c.pts[0]]);
      for (let i = 0; i < segsOf.length && !ok; i++) {
        // skip the segment the end itself belongs to
        if (k === e.chain && ((i === 0 && e.p === c.pts[0]) || (i === segsOf.length - 1 && e.p === c.pts[n - 1]))) continue;
        if (onSeg(e.p, segsOf[i][0], segsOf[i][1])) ok = true;
      }
      k++;
      if (ok) break;
    }
    for (const a of v.arcs) {
      if (ok) break;
      const d = Math.abs(Math.hypot(e.p[0] - a.c[0], e.p[1] - a.c[1]) - a.r);
      if (d > tol * 10 + a.r * 0.006) continue; // rims are facets put back as circles: ends sit within a facet's sag
      let ang = Math.atan2(e.p[1] - a.c[1], e.p[0] - a.c[0]);
      while (ang < a.a0 - 1e-6) ang += 2 * Math.PI;
      if (ang <= a.a1 + 1e-6 || a.a1 - a.a0 >= 2 * Math.PI - 1e-6) {
        // the arc's own end doesn't count as meeting something
        if (e.chain === -1 && (Math.abs(ang - a.a0) < 1e-6 || Math.abs(ang - a.a1) < 1e-6) && arcEnds.includes(a)) {
          const other = v.arcs.some((b) => b !== a && Math.abs(Math.hypot(e.p[0] - b.c[0], e.p[1] - b.c[1]) - b.r) < tol * 10);
          if (!other) continue;
        }
        ok = true;
      }
    }
    if (!ok) out.push(e.p);
  }
  return out;
}

/** Lines drawn twice (the same stretch of the same line, twice): a fault. */
export function doubledLines(v: ViewLines): number {
  let n = 0;
  const segs: { a: P2; b: P2 }[] = [];
  for (const c of v.chains) for (let i = 0; i + 1 < c.pts.length + (c.closed ? 1 : 0); i++) segs.push({ a: c.pts[i], b: c.pts[(i + 1) % c.pts.length] });
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i],
        t = segs[j];
      const dx = s.b[0] - s.a[0],
        dy = s.b[1] - s.a[1];
      const L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      const off = (p: P2) => Math.abs((p[0] - s.a[0]) * dy - (p[1] - s.a[1]) * dx) / L;
      if (off(t.a) > 1e-4 || off(t.b) > 1e-4) continue;
      const pr = (p: P2) => ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / L;
      const lo = Math.max(0, Math.min(pr(t.a), pr(t.b))),
        hi = Math.min(L, Math.max(pr(t.a), pr(t.b)));
      if (hi - lo > 1e-3) n++;
    }
  return n;
}

/** A part's polygons (placed in the model). */
export const polysOf = (p: BuiltPart) => p.polys;
