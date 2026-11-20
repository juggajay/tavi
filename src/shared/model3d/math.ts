// Small vector and placement maths for the 3D models (Stage 9). Millimetres, right-handed, z up. Pure functions, no
// imports, so the server (checks, files for Blender) and the app (the viewer) run exactly the same code.
export type V3 = [number, number, number];
export type Axis = "x" | "y" | "z";
export const AXES: Axis[] = ["x", "y", "z"];
export const axisIndex = (a: Axis) => (a === "x" ? 0 : a === "y" ? 1 : 2);

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A placement: rotate (3×3, row-major) then move. */
export type Xf = { r: number[]; t: V3 };
export const IDENTITY: Xf = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

const mul3 = (a: number[], b: number[]) => {
  const o = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
};

/** Rotation by degrees about x, then y, then z (each about the fixed axes): R = Rz · Ry · Rx. */
export function rotation(deg?: V3): number[] {
  if (!deg || (deg[0] === 0 && deg[1] === 0 && deg[2] === 0)) return IDENTITY.r.slice();
  const [a, b, c] = deg.map((d) => (d * Math.PI) / 180);
  const cs = (v: number) => {
    const k = Math.cos(v);
    const s = Math.sin(v);
    // tidy exact quarter turns, so a 90° part lands exactly where it should
    return [Math.abs(k) < 1e-12 ? 0 : k, Math.abs(s) < 1e-12 ? 0 : s];
  };
  const [ca, sa] = cs(a);
  const [cb, sb] = cs(b);
  const [cc, sc] = cs(c);
  const rx = [1, 0, 0, 0, ca, -sa, 0, sa, ca];
  const ry = [cb, 0, sb, 0, 1, 0, -sb, 0, cb];
  const rz = [cc, -sc, 0, sc, cc, 0, 0, 0, 1];
  return mul3(rz, mul3(ry, rx));
}

export const xf = (rot?: V3, at?: V3): Xf => ({ r: rotation(rot), t: at ? [at[0], at[1], at[2]] : [0, 0, 0] });
export const applyDir = (x: Xf, d: V3): V3 => [x.r[0] * d[0] + x.r[1] * d[1] + x.r[2] * d[2], x.r[3] * d[0] + x.r[4] * d[1] + x.r[5] * d[2], x.r[6] * d[0] + x.r[7] * d[1] + x.r[8] * d[2]];
export const apply = (x: Xf, p: V3): V3 => add(applyDir(x, p), x.t);
/** a after b: p → a(b(p)). */
export const compose = (a: Xf, b: Xf): Xf => ({ r: mul3(a.r, b.r), t: apply(a, b.t) });
export function invert(x: Xf): Xf {
  const r = [x.r[0], x.r[3], x.r[6], x.r[1], x.r[4], x.r[7], x.r[2], x.r[5], x.r[8]];
  const inv = { r, t: [0, 0, 0] as V3 };
  inv.t = scale(applyDir(inv, x.t), -1);
  return inv;
}
export const isIdentity = (x: Xf) => x.r.every((v, i) => v === IDENTITY.r[i]) && x.t.every((v) => v === 0);

export type Box3 = { min: V3; max: V3 };
export const emptyBox = (): Box3 => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
export function grow(b: Box3, p: V3) {
  for (let i = 0; i < 3; i++) {
    if (p[i] < b.min[i]) b.min[i] = p[i];
    if (p[i] > b.max[i]) b.max[i] = p[i];
  }
  return b;
}
export const boxSize = (b: Box3): V3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
export const boxCentre = (b: Box3): V3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
/** Whether two boxes overlap by more than tol on every axis (tol < 0: within -tol of each other). */
export const boxesOverlap = (a: Box3, b: Box3, tol = 0) => [0, 1, 2].every((i) => a.min[i] < b.max[i] - tol && b.min[i] < a.max[i] - tol);
export const boxUnion = (a: Box3, b: Box3): Box3 => ({ min: [0, 1, 2].map((i) => Math.min(a.min[i], b.min[i])) as V3, max: [0, 1, 2].map((i) => Math.max(a.max[i], b.max[i])) as V3 });
export const shiftBox = (b: Box3, d: V3): Box3 => ({ min: add(b.min, d), max: add(b.max, d) });

/** A small, steady pseudo-random number from a string (two boards of the same name look alike, every time). */
export function seeded(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
