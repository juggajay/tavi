// Taking one solid away from another (and finding where two overlap), by the binary-space-partition method Evan
// Wallace's csg.js made well known. Solids are lists of flat, convex, outward-facing polygons in millimetres. Written
// here rather than taken from a package: three-bvh-csg needs a third package (three-mesh-bvh) that the build rules
// don't allow, and this runs the same in Node (the server's checks) and in the app.
import { type V3, cross, dot, lerp, norm, sub } from "./math.js";

/** How close to a plane counts as on it, in millimetres. */
export const EPS = 1e-4;

export type Plane = { n: V3; w: number };
/** A round face (a cylinder's side): its normals point away from the axis through c along d (s = -1 once turned inside out). */
export type Smooth = { c: V3; d: V3; s: 1 | -1 };
export type Poly = { v: V3[]; p: Plane; sm?: Smooth };

/** The plane of a flat polygon (Newell's method, so collinear first points don't matter), or null if it has no area. */
export function planeOf(v: V3[]): Plane | null {
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
  const n: V3 = [nx / l, ny / l, nz / l];
  let w = 0;
  for (const p of v) w += dot(n, p);
  return { n, w: w / v.length };
}

export function makePoly(v: V3[], sm?: Smooth): Poly | null {
  const p = planeOf(v);
  return p ? { v, p, ...(sm ? { sm } : {}) } : null;
}

/** A polygon facing the given way (its corners reversed if it faced the other). */
export function facing(v: V3[], want: V3, sm?: Smooth): Poly | null {
  const p = makePoly(v, sm);
  if (!p) return null;
  return dot(p.p.n, want) < 0 ? flip(p) : p;
}

export const flip = (p: Poly): Poly => ({ v: p.v.slice().reverse(), p: { n: [-p.p.n[0], -p.p.n[1], -p.p.n[2]], w: -p.p.w }, ...(p.sm ? { sm: { ...p.sm, s: (-p.sm.s) as 1 | -1 } } : {}) });

const COPLANAR = 0,
  FRONT = 1,
  BACK = 2,
  SPANNING = 3;

function split(plane: Plane, poly: Poly, cf: Poly[], cb: Poly[], front: Poly[], back: Poly[]) {
  let all = 0;
  const types: number[] = [];
  for (const v of poly.v) {
    const t = dot(plane.n, v) - plane.w;
    const type = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
    all |= type;
    types.push(type);
  }
  if (all === COPLANAR) (dot(plane.n, poly.p.n) > 0 ? cf : cb).push(poly);
  else if (all === FRONT) front.push(poly);
  else if (all === BACK) back.push(poly);
  else {
    const f: V3[] = [],
      b: V3[] = [];
    const n = poly.v.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ti = types[i],
        tj = types[j];
      const vi = poly.v[i],
        vj = poly.v[j];
      if (ti !== BACK) f.push(vi);
      if (ti !== FRONT) b.push(vi);
      if ((ti | tj) === SPANNING) {
        const t = (plane.w - dot(plane.n, vi)) / dot(plane.n, sub(vj, vi));
        const v = lerp(vi, vj, t);
        f.push(v);
        b.push(v);
      }
    }
    if (f.length >= 3) front.push({ v: f, p: poly.p, ...(poly.sm ? { sm: poly.sm } : {}) });
    if (b.length >= 3) back.push({ v: b, p: poly.p, ...(poly.sm ? { sm: poly.sm } : {}) });
  }
}

class Node {
  plane: Plane | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polys: Poly[] = [];
  constructor(polys?: Poly[]) {
    if (polys) this.build(polys);
  }
  invert() {
    // iterative over the tree, so a deep one can't run out of stack
    const stack: Node[] = [this];
    while (stack.length) {
      const n = stack.pop()!;
      n.polys = n.polys.map(flip);
      if (n.plane) n.plane = { n: [-n.plane.n[0], -n.plane.n[1], -n.plane.n[2]], w: -n.plane.w };
      const f = n.front;
      n.front = n.back;
      n.back = f;
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
  }
  clipPolygons(polys: Poly[]): Poly[] {
    if (!this.plane) return polys.slice();
    let front: Poly[] = [],
      back: Poly[] = [];
    for (const p of polys) split(this.plane, p, front, back, front, back);
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }
  clipTo(bsp: Node) {
    const stack: Node[] = [this];
    while (stack.length) {
      const n = stack.pop()!;
      n.polys = bsp.clipPolygons(n.polys);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
  }
  allPolygons(): Poly[] {
    const out: Poly[] = [];
    const stack: Node[] = [this];
    while (stack.length) {
      const n = stack.pop()!;
      for (const p of n.polys) out.push(p);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
    return out;
  }
  build(polys: Poly[]) {
    // iterative: each node takes the first polygon's plane and passes the rest down the front and back
    const work: [Node, Poly[]][] = [[this, polys]];
    while (work.length) {
      const [n, ps] = work.pop()!;
      if (!ps.length) continue;
      if (!n.plane) n.plane = { n: ps[0].p.n, w: ps[0].p.w };
      const front: Poly[] = [],
        back: Poly[] = [];
      for (const p of ps) split(n.plane, p, n.polys, n.polys, front, back);
      if (front.length) work.push([(n.front ??= new Node()), front]);
      if (back.length) work.push([(n.back ??= new Node()), back]);
    }
  }
}

/** a with b taken away. */
export function subtract(a: Poly[], b: Poly[]): Poly[] {
  const A = new Node(a),
    B = new Node(b);
  A.invert();
  A.clipTo(B);
  B.clipTo(A);
  B.invert();
  B.clipTo(A);
  B.invert();
  A.build(B.allPolygons());
  A.invert();
  return A.allPolygons();
}

/** Where a and b overlap. */
export function intersect(a: Poly[], b: Poly[]): Poly[] {
  const A = new Node(a),
    B = new Node(b);
  A.invert();
  B.clipTo(A);
  B.invert();
  A.clipTo(B);
  B.clipTo(A);
  A.build(B.allPolygons());
  A.invert();
  return A.allPolygons();
}

/** a and b together. */
export function union(a: Poly[], b: Poly[]): Poly[] {
  const A = new Node(a),
    B = new Node(b);
  A.clipTo(B);
  B.clipTo(A);
  B.invert();
  B.clipTo(A);
  B.invert();
  A.build(B.allPolygons());
  return A.allPolygons();
}

/** The volume a closed set of outward polygons encloses, in cubic millimetres (divergence theorem). */
export function volumeOf(polys: Poly[]): number {
  let v = 0;
  for (const p of polys) {
    const a = p.v[0];
    for (let i = 1; i + 1 < p.v.length; i++) v += dot(a, cross(p.v[i], p.v[i + 1]));
  }
  return v / 6;
}

/** A unit normal for a corner of a polygon: the flat face's, or pointing away from the axis on a round face. */
export function normalAt(p: Poly, v: V3): V3 {
  if (!p.sm) return p.p.n;
  const { c, d, s } = p.sm;
  const rel = sub(v, c);
  const along = dot(rel, d);
  const r = norm([rel[0] - d[0] * along, rel[1] - d[1] * along, rel[2] - d[2] * along]);
  // a round face cut flat by another face keeps its own direction near the cut
  return dot(r, p.p.n) * s > 0.2 ? (s === 1 ? r : [-r[0], -r[1], -r[2]]) : p.p.n;
}
