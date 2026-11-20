// The three kinds of solid a model is made of (Stage 9.1), turned into outward-facing polygons in a part's own frame:
// a box, a cylinder, and a prism (a flat outline pushed through a depth: a dovetail, a birdsmouth, a mitre).
import type { Solid } from "../protocol.js";
import { type V3, type Xf, add, apply, applyDir, axisIndex, scale, xf } from "./math.js";
import { type Poly, facing } from "./csg.js";

/** Facets around a cylinder. The same for every cylinder, so a dowel and its hole share their faces exactly. */
export const CYL_SEGMENTS = 32;

type P2 = [number, number];

/** The in-plane axes (u, v) and the depth axis of a prism's plane. */
export function prismAxes(plane: "xy" | "xz" | "yz"): { u: V3; v: V3; e: V3 } {
  if (plane === "xy") return { u: [1, 0, 0], v: [0, 1, 0], e: [0, 0, 1] };
  if (plane === "xz") return { u: [1, 0, 0], v: [0, 0, 1], e: [0, 1, 0] };
  return { u: [0, 1, 0], v: [0, 0, 1], e: [1, 0, 0] };
}

export const area2 = (pts: P2[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i],
      q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

const orient = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSeg = (a: P2, b: P2, p: P2) => Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9;
function segsMeet(a: P2, b: P2, c: P2, d: P2) {
  const d1 = orient(c, d, a),
    d2 = orient(c, d, b),
    d3 = orient(a, b, c),
    d4 = orient(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const z = 1e-9;
  return (Math.abs(d1) < z && onSeg(c, d, a)) || (Math.abs(d2) < z && onSeg(c, d, b)) || (Math.abs(d3) < z && onSeg(a, b, c)) || (Math.abs(d4) < z && onSeg(a, b, d));
}

/** What's wrong with a prism outline in plain words, or null: repeated points, no area, or edges crossing. */
export function outlineProblem(pts: P2[]): string | null {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i],
      q = pts[(i + 1) % n];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6) return "two points next to each other in the outline are the same";
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // neighbours share a corner
      if (segsMeet(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return "the outline crosses itself";
    }
  if (Math.abs(area2(pts)) < 1e-6) return "the outline has no area (its points are in a line)";
  return null;
}

const convex = (pts: P2[]) => pts.every((_, i) => orient(pts[i], pts[(i + 1) % pts.length], pts[(i + 2) % pts.length]) >= -1e-9);

/** Triangles covering a simple counter-clockwise outline (ear clipping; at most 24 points, so plain is fine). */
export function earClip(pts: P2[]): [number, number, number][] {
  const idx = pts.map((_, i) => i);
  const tris: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length],
        i1 = idx[k],
        i2 = idx[(k + 1) % idx.length];
      const a = pts[i0],
        b = pts[i1],
        c = pts[i2];
      if (orient(a, b, c) <= 1e-12) continue; // a reflex or flat corner isn't an ear
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const p = pts[j];
        if (orient(a, b, p) >= -1e-12 && orient(b, c, p) >= -1e-12 && orient(c, a, p) >= -1e-12) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      tris.push([i0, i1, i2]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/** A solid as outward-facing polygons, placed by `outer` (the part's own frame is the identity). */
export function solidPolys(s: Solid, outer?: Xf): Poly[] {
  const out: Poly[] = [];
  const push = (p: Poly | null) => p && out.push(p);
  const place = (p: V3) => (outer ? apply(outer, p) : p);
  const dir = (d: V3) => (outer ? applyDir(outer, d) : d);
  if (s.type === "box") {
    const x = xf(s.rot, s.at);
    const [sx, sy, sz] = s.size;
    const c = (i: number, j: number, k: number) => place(apply(x, [i * sx, j * sy, k * sz]));
    const faces: [V3[], V3][] = [
      [[c(0, 0, 0), c(0, 1, 0), c(0, 1, 1), c(0, 0, 1)], [-1, 0, 0]],
      [[c(1, 0, 0), c(1, 0, 1), c(1, 1, 1), c(1, 1, 0)], [1, 0, 0]],
      [[c(0, 0, 0), c(0, 0, 1), c(1, 0, 1), c(1, 0, 0)], [0, -1, 0]],
      [[c(0, 1, 0), c(1, 1, 0), c(1, 1, 1), c(0, 1, 1)], [0, 1, 0]],
      [[c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0)], [0, 0, -1]],
      [[c(0, 0, 1), c(0, 1, 1), c(1, 1, 1), c(1, 0, 1)], [0, 0, 1]],
    ];
    for (const [v, n] of faces) push(facing(v, dir(applyDir(x, n))));
    return out;
  }
  if (s.type === "cyl") {
    const ai = axisIndex(s.axis);
    const e: V3 = [0, 0, 0];
    e[ai] = 1;
    const u: V3 = [0, 0, 0],
      v: V3 = [0, 0, 0];
    u[(ai + 1) % 3] = 1;
    v[(ai + 2) % 3] = 1;
    const ring = (h: number) => {
      const pts: V3[] = [];
      for (let k = 0; k < CYL_SEGMENTS; k++) {
        const t = (k / CYL_SEGMENTS) * Math.PI * 2;
        pts.push(place(add(add(s.at, scale(e, h)), add(scale(u, s.r * Math.cos(t)), scale(v, s.r * Math.sin(t))))));
      }
      return pts;
    };
    const lo = ring(0),
      hi = ring(s.h);
    const E = dir(e);
    push(facing(lo.slice(), scale(E, -1)));
    push(facing(hi.slice(), E));
    const sm = { c: place(s.at), d: E, s: 1 as const };
    for (let k = 0; k < CYL_SEGMENTS; k++) {
      const k1 = (k + 1) % CYL_SEGMENTS;
      const t = ((k + 0.5) / CYL_SEGMENTS) * Math.PI * 2;
      push(facing([lo[k], lo[k1], hi[k1], hi[k]], dir(add(scale(u, Math.cos(t)), scale(v, Math.sin(t)))), sm));
    }
    return out;
  }
  // prism
  const { u, v, e } = prismAxes(s.plane);
  const at = s.at ?? [0, 0, 0];
  let pts = s.points.map((p) => [p[0], p[1]] as P2);
  if (area2(pts) < 0) pts = pts.reverse();
  const P = (p: P2, h: number) => place(add(at, add(add(scale(u, p[0]), scale(v, p[1])), scale(e, h))));
  const E = dir(e);
  const caps = convex(pts) ? [pts.map((_, i) => i)] : earClip(pts);
  for (const c of caps) {
    push(facing(c.map((i) => P(pts[i], 0)), scale(E, -1)));
    push(facing(c.map((i) => P(pts[i], s.depth)), E));
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i],
      b = pts[(i + 1) % pts.length];
    const du = b[0] - a[0],
      dv = b[1] - a[1];
    push(facing([P(a, 0), P(b, 0), P(b, s.depth), P(a, s.depth)], dir(add(scale(u, dv), scale(v, -du)))));
  }
  return out;
}
