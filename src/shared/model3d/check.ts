// The checks a model gets on the server before it's shown (Stage 9.1). Facts, not refusals: the overall size, each
// part's finished size and volume, parts that occupy the same space (a tenon longer than its mortise is deep), parts
// touching nothing, and cuts that remove nothing or the whole part. The brain reads these and fixes what it didn't mean
// before it says anything to the owner. An exploded diagram or a deliberate gap is allowed.
import type { ModelPart, ModelPayload } from "../protocol.js";
import { type Box3, type V3, add, apply, applyDir, boxSize, boxesOverlap, cross, dot, scale, sub } from "./math.js";
import { type Contact, contactOf } from "../drawing/joints.js";
import { type Poly, intersect, volumeOf } from "./csg.js";
import { type BuiltModel, buildModel, polysBox } from "./build.js";

export const CLASH_MM3 = 1;
export const TOUCH_MM = 0.5;

export type ModelFacts = {
  size_mm: V3;
  parts: { id: string; name: string; size_mm: V3; volume_cm3: number }[];
  clashes: { a: string; b: string; overlap_mm3: number; overlap_size_mm: V3 }[];
  floating: string[];
  cuts: { part: string; cut: number; problem: string }[];
  /** What stops it working (Stage 19.8): it isn't shown until these are fixed. And what's odd but possible. */
  errors: string[];
  warnings: string[];
  ms: number;
};

const r1 = (v: number) => Math.round(v * 10) / 10;
const r1v = (v: V3): V3 => [r1(v[0]), r1(v[1]), r1(v[2])];

type Tri = { a: V3; b: V3; c: V3; box: Box3 };
function trisOf(polys: Poly[]): Tri[] {
  const out: Tri[] = [];
  for (const p of polys)
    for (let i = 1; i + 1 < p.v.length; i++) {
      const a = p.v[0],
        b = p.v[i],
        c = p.v[i + 1];
      out.push({ a, b, c, box: { min: [0, 1, 2].map((k) => Math.min(a[k], b[k], c[k])) as V3, max: [0, 1, 2].map((k) => Math.max(a[k], b[k], c[k])) as V3 } });
    }
  return out;
}

/** The closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTri(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

/** The squared distance between segments pq and rs (Ericson 5.1.9). */
function segSeg2(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1 = sub(q1, p1),
    d2 = sub(q2, p2),
    r = sub(p1, p2);
  const a = dot(d1, d1),
    e = dot(d2, d2),
    f = dot(d2, r);
  let s: number, t: number;
  if (a <= 1e-12 && e <= 1e-12) return dot(r, r);
  if (a <= 1e-12) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = dot(d1, r);
    if (e <= 1e-12) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const d = sub(add(p1, scale(d1, s)), add(p2, scale(d2, t)));
  return dot(d, d);
}

/** Whether two triangles come within tol of each other (corner-to-face and edge-to-edge; enough for solids that don't cross). */
function trisNear(t: Tri, u: Tri, tol: number) {
  const tol2 = tol * tol;
  for (const [p, o] of [
    [t.a, u],
    [t.b, u],
    [t.c, u],
    [u.a, t],
    [u.b, t],
    [u.c, t],
  ] as [V3, Tri][]) {
    const q = sub(p, closestOnTri(p, o.a, o.b, o.c));
    if (dot(q, q) <= tol2) return true;
  }
  const te: [V3, V3][] = [
    [t.a, t.b],
    [t.b, t.c],
    [t.c, t.a],
  ];
  const ue: [V3, V3][] = [
    [u.a, u.b],
    [u.b, u.c],
    [u.c, u.a],
  ];
  for (const [p, q] of te) for (const [r, s] of ue) if (segSeg2(p, q, r, s) <= tol2) return true;
  return false;
}

function near(a: Tri[], b: Tri[], tol: number) {
  for (const t of a)
    for (const u of b) {
      if (!boxesOverlap(t.box, u.box, -tol)) continue;
      if (trisNear(t, u, tol)) return true;
    }
  return false;
}

/** Whether a point is inside a closed solid (a ray to far away crosses its surface an odd number of times). */
export function contains(polys: Poly[], p: V3): boolean {
  const dir = [0.8191, 0.4572, 0.3466] as V3; // a slanted ray, so it doesn't run along an edge
  let hits = 0;
  for (const poly of polys)
    for (let i = 1; i + 1 < poly.v.length; i++) {
      const a = poly.v[0],
        b = poly.v[i],
        c = poly.v[i + 1];
      const e1 = sub(b, a),
        e2 = sub(c, a);
      const h = cross(dir, e2);
      const det = dot(e1, h);
      if (Math.abs(det) < 1e-12) continue;
      const f = 1 / det;
      const s = sub(p, a);
      const u = f * dot(s, h);
      if (u < 0 || u > 1) continue;
      const q = cross(s, e1);
      const v = f * dot(dir, q);
      if (v < 0 || u + v > 1) continue;
      if (f * dot(e2, q) > 1e-9) hits++;
    }
  return hits % 2 === 1;
}

export function checkModel(m: ModelPayload, built?: BuiltModel): ModelFacts {
  const t0 = performance.now();
  const b = built ?? buildModel(m);
  const parts = b.parts;
  const clashes: ModelFacts["clashes"] = [];
  const touching = parts.map(() => false);
  const tris = parts.map((p) => trisOf(p.polys));
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) {
      const A = parts[i],
        B = parts[j];
      if (!A.polys.length || !B.polys.length) continue;
      let clash = false;
      if (boxesOverlap(A.bbox, B.bbox, 1e-6)) {
        const both = intersect(A.polys, B.polys);
        const v = volumeOf(both);
        if (v > CLASH_MM3) {
          clash = true;
          clashes.push({ a: A.name, b: B.name, overlap_mm3: Math.round(v), overlap_size_mm: r1v(boxSize(polysBox(both))) });
        }
      }
      if (clash || (boxesOverlap(A.bbox, B.bbox, -TOUCH_MM) && near(tris[i], tris[j], TOUCH_MM))) touching[i] = touching[j] = true;
    }
  const cuts: ModelFacts["cuts"] = [];
  for (const p of parts) for (const e of p.cutEffects) cuts.push({ part: p.name, cut: e.cut, problem: e.problem });
  return {
    size_mm: Number.isFinite(b.bbox.min[0]) ? r1v(boxSize(b.bbox)) : [0, 0, 0],
    parts: parts.map((p) => ({ id: p.id, name: p.name, size_mm: r1v(p.size), volume_cm3: Math.round(p.volume / 100) / 10 })),
    clashes,
    floating: parts.length > 1 ? parts.filter((p, i) => !touching[i] && p.polys.length).map((p) => p.name) : [],
    cuts,
    ...fixingProblems(m, b, clashes),
    ms: Math.round(performance.now() - t0 + b.ms),
  };
}

/* ---------------- a model that can't work is never shown (Stage 19.8) ---------------- */

/** A fixing: named as one (a bolt, screw, dowel, peg, pin, nail, rod), or a slim cylinder that is its own part. */
// (named as one and slim: a "pin board" in a dovetail is a board)
export const isFixingPart = (p: ModelPart, size?: V3) =>
  (/\b(bolts?|screws?|dowels?|pegs?|pins?|nails?|rods?|coach|lag)\b/i.test(p.name) && (!size || [...size].sort((x, y) => x - y)[1] <= 40)) || (p.stock.type === "cyl" && p.stock.r <= 20);

type Axis3 = { a: V3; d: V3; r: number; len: number };
/** A cylinder part's centre line in the model: from its base, its direction, its radius and length. */
function axisOfFixing(p: ModelPart, b: BuiltModel["parts"][number]): Axis3 | null {
  if (p.stock.type !== "cyl") {
    // a box-shaped fixing (a pin, a key): its longest side
    const s = b.size;
    const k = s[0] >= s[1] && s[0] >= s[2] ? 0 : s[1] >= s[2] ? 1 : 2;
    const d = applyDir(b.frame, k === 0 ? [1, 0, 0] : k === 1 ? [0, 1, 0] : [0, 0, 1]);
    const c: V3 = [(b.bbox.min[0] + b.bbox.max[0]) / 2, (b.bbox.min[1] + b.bbox.max[1]) / 2, (b.bbox.min[2] + b.bbox.max[2]) / 2];
    return { a: sub(c, scale(d, s[k] / 2)), d, r: Math.min(...s.filter((_, i) => i !== k)) / 2, len: s[k] };
  }
  const e: V3 = p.stock.axis === "x" ? [1, 0, 0] : p.stock.axis === "y" ? [0, 1, 0] : [0, 0, 1];
  return { a: apply(b.frame, p.stock.at), d: applyDir(b.frame, e), r: p.stock.r, len: p.stock.h };
}

/** Whether a point lies on a flat polygon (within tol of it, measured in its plane). */
function onPolygon(q: V3, pts: V3[], n: V3, tol: number) {
  const u = Math.abs(n[0]) < 0.9 ? [0, -n[2], n[1]] : [-n[2], 0, n[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  const U: V3 = [u[0] / ul, u[1] / ul, u[2] / ul];
  const V = cross(n, U);
  const P = (p: V3): [number, number] => [dot(p, U), dot(p, V)];
  const p2 = pts.map(P);
  const [x, y] = P(q);
  let inside = false;
  for (let i = 0, j = p2.length - 1; i < p2.length; j = i++) {
    const [xi, yi] = p2[i],
      [xj, yj] = p2[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  if (inside) return true;
  for (let i = 0; i < p2.length; i++) {
    const [ax, ay] = p2[i],
      [bx, by] = p2[(i + 1) % p2.length];
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2)) : 0;
    if (Math.hypot(ax + (bx - ax) * t - x, ay + (by - ay) * t - y) <= tol) return true;
  }
  return false;
}

/**
 * What would stop the model working, in plain words (errors: it isn't shown until they're fixed), and what's odd but
 * possible (warnings): every fixing in a hole, not cutting into solid timber; through at least two parts and across the
 * face where they meet (not along it, not inside one piece); a hole that reaches another part carried on into it; solid
 * parts not overlapping (an interference), by more than a whisker; a hole with nothing in it, when the model has fixings.
 */
export function fixingProblems(m: ModelPayload, b: BuiltModel, clashes: ModelFacts["clashes"]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parts = b.parts;
  const fix = m.parts.map((p, i) => isFixingPart(p, parts[i].size));
  const name = (i: number) => m.parts[i].name;
  const the = (i: number) => `the ${name(i).charAt(0).toLowerCase()}${name(i).slice(1)}`;
  const contactArea = new Map<string, Contact | null>();
  const contact = (i: number, j: number) => {
    const k = `${Math.min(i, j)}|${Math.max(i, j)}`;
    if (!contactArea.has(k)) contactArea.set(k, parts[i].polys.length && parts[j].polys.length && boxesOverlap(parts[i].bbox, parts[j].bbox, -0.05) ? contactOf(parts[Math.min(i, j)].polys, parts[Math.max(i, j)].polys) : null);
    return contactArea.get(k) ?? null;
  };
  const axes = new Map<number, Axis3>();
  parts.forEach((bp, i) => {
    if (!fix[i] || !bp.polys.length) return;
    const ax = axisOfFixing(m.parts[i], bp);
    if (!ax) return;
    axes.set(i, ax);
    // in a hole (or in free space) in every other part, never cutting into solid timber
    let cuts = false;
    parts.forEach((q, j) => {
      if (j === i || fix[j] || !q.polys.length || !boxesOverlap(bp.bbox, q.bbox, 1e-6)) return;
      const v = volumeOf(intersect(bp.polys, q.polys));
      if (v > Math.max(2, 0.002 * bp.volume)) {
        errors.push(`${name(i)} cuts into ${the(j)}: there's no hole for it there.`);
        cuts = true;
      }
    });
    if (cuts) return;
    // through two parts at least, and across the face where they meet
    const through = parts.map((_, j) => j).filter((j) => j !== i && !fix[j] && (contact(i, j)?.area ?? 0) > 1);
    if (!through.length) return void errors.push(`${name(i)} doesn't pass through anything: it has to go through the pieces it joins.`);
    if (through.length === 1) return void errors.push(`${name(i)} is only in ${the(through[0])}; it has to go through both pieces it joins.`);
    let crossed = false;
    let along: [number, number] | null = null;
    for (let x = 0; x < through.length && !crossed; x++)
      for (let y = x + 1; y < through.length && !crossed; y++) {
        const c = contact(through[x], through[y]);
        if (!c) continue;
        for (const f of c.faces) {
          const cosA = Math.abs(dot(ax.d, f.n));
          if (cosA < 0.25) {
            // the fixing lies along this face (within its radius of it): it runs along the joint
            const off = Math.abs(dot(sub(ax.a, f.c), f.n));
            if (off < ax.r + 1) along ??= [through[x], through[y]];
            continue;
          }
          const t = dot(sub(f.c, ax.a), f.n) / dot(ax.d, f.n);
          if (t < -0.5 || t > ax.len + 0.5) continue;
          const q = add(ax.a, scale(ax.d, t));
          if (f.pts && onPolygon(q, f.pts, f.n, ax.r)) {
            crossed = true;
            break;
          }
        }
      }
    if (!crossed) {
      if (along) errors.push(`${name(i)} runs along the joint between ${the(along[0])} and ${the(along[1])}; it has to go through both.`);
      else errors.push(`${name(i)} goes through ${through.map(the).join(" and ")} but doesn't cross where they meet; it has to go through the joint.`);
    }
  });
  // holes: carried on into a part they reach; and none left empty in a model with fixings
  const anyFix = axes.size > 0;
  m.parts.forEach((p, i) => {
    const bp = parts[i];
    if (fix[i] || !bp.polys.length) return;
    (p.cuts ?? []).forEach((c, ci) => {
      if (c.type !== "cyl" || c.r > 30) return;
      const e: V3 = c.axis === "x" ? [1, 0, 0] : c.axis === "y" ? [0, 1, 0] : [0, 0, 1];
      const a = apply(bp.frame, c.at),
        d = applyDir(bp.frame, e);
      // a fixing in it: its axis within the hole's radius, along it
      const used = [...axes.values()].some((f) => Math.abs(Math.abs(dot(f.d, d)) - 1) < 1e-3 && Math.hypot(...cross(sub(f.a, a), d)) < c.r + 0.5);
      if (!used && anyFix) warnings.push(`The ${c.r * 2} hole in ${the(i)} has nothing in it.`);
      if (used) return;
      // where the hole leaves the part: the points just past each end of it inside the part's box
      const box = bp.bbox;
      for (const [t, sgn] of [
        [0, -1],
        [c.h, 1],
      ] as const) {
        // walk in from the cut's end to the part's surface along the axis
        let tt = t;
        const inBox = (q: V3) => [0, 1, 2].every((k) => q[k] >= box.min[k] - 1e-6 && q[k] <= box.max[k] + 1e-6);
        for (let s = 0; s < 400 && !inBox(add(a, scale(d, tt))); s++) tt -= sgn * 0.5;
        const end = add(a, scale(d, tt + sgn * 0.6));
        parts.forEach((q, j) => {
          if (j === i || fix[j] || !q.polys.length) return;
          if (inBox(add(a, scale(d, tt))) && contains(q.polys, end) && !errors.some((x) => x.includes(the(j)) && x.includes(the(i)))) errors.push(`The hole in ${the(i)} stops at ${the(j)}: it has to carry on into it.`);
        });
      }
    });
  });
  // solid parts overlapping: an interference (a fixing in its hole is fine; that was checked above)
  for (const c of clashes) {
    const ia = m.parts.findIndex((p) => p.name === c.a),
      ib = m.parts.findIndex((p) => p.name === c.b);
    if (ia < 0 || ib < 0 || fix[ia] || fix[ib]) continue;
    const depth = Math.min(...c.overlap_size_mm);
    if (c.overlap_mm3 > 50 && depth > 0.5) errors.push(`${the(ia).charAt(0).toUpperCase()}${the(ia).slice(1)} and ${the(ib)} overlap: about ${Math.round(depth)} mm into each other (${c.overlap_size_mm.map((v) => Math.round(v)).join(" x ")} mm).`);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
