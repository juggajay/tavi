// Every joint in a model (Stage 19.1): where two or more parts meet, found from the solids (faces lying on each other,
// or one part let into another), named from what is cut (a mortise and a tenon, a housing, a rebate, a groove with a
// panel in it, a lap, a notch, a hole lining up with a bolt in it, or nothing cut: a butt), sized from the cuts, and
// grouped: identical joints are one joint type with a count ("8 PLACES"), and each type gets one detail. Where the
// model came from a recipe, the recipe names it. A joint the code can't name is listed all the same, with what is cut.
// Pure functions, millimetres, z up; everything comes from the model's own solids and cuts, nothing is guessed.
import type { ModelDesign, ModelPayload } from "../protocol.js";
import type { BuiltModel } from "../model3d/build.js";
import { type Box3, type V3, apply, cross, dot, emptyBox, grow, invert, norm } from "../model3d/math.js";
import type { Poly } from "../model3d/csg.js";
import type { Feature, Mark, PartInfo } from "./parts.js";
import { JOINT_RULE_IDS } from "../model3d/designRules.js";

export type JointKind =
  | "mortise and tenon"
  | "bridle"
  | "housing"
  | "slot"
  | "rebate"
  | "groove"
  | "tongue and groove"
  | "halving"
  | "notch"
  | "birdsmouth"
  | "dovetail"
  | "box joint"
  | "mitre"
  | "scarf"
  | "dowelled"
  | "bolted"
  | "screwed"
  | "butt"
  | "unnamed";

/**
 * A fixing part (a bolt, a peg, a dowel, a screw; and what holds a splice together, Stage 19.8: a key, a folding wedge,
 * a fishplate): its kind, diameter (or thickness) and length; w, its width; steel, a steel one.
 */
export type Fixing = { part: number; mark: number; kind: "bolt" | "screw" | "dowel" | "peg" | "nail" | "pin" | "key" | "wedge" | "plate"; d: number; len: number; w?: number; steel?: boolean };
/** The round ones (a section can go through them along their length). */
export const roundFixing = (f: Fixing) => f.kind !== "key" && f.kind !== "wedge" && f.kind !== "plate";

/** One joint: where these parts meet. host: the part let into (a leg, a cabinet side); guests: the parts that go in. */
export type JointInst = {
  index: number;
  host: number;
  guests: number[];
  fixings: Fixing[];
  /** Every part in it (model indices): host, guests, fixings. */
  parts: number[];
  kind: JointKind;
  /** Its kind as the drawing says it: "HAUNCHED MORTISE AND TENON", "HOUSING", "BUTT". */
  name: string;
  /** Where it is in the model: the faces in contact, and the cuts that make it. */
  contact: Box3;
  region: Box3;
  /** The way the guest comes out of the host (a unit axis), so the pulled-apart view pulls it that way. */
  d: V3;
  /** The cuts in it, per part (indices into that part's features). */
  feats: Map<number, number[]>;
  /** Its sizes from the cuts, by name (tenon length, mortise depth, shoulders...), and as the schedule says them. */
  sizes: Record<string, number>;
  sizesText: string;
  /** How it's held: "2 / M12 x 90 BOLTS", "Ø10 x 90 PEG", "GLUED", "FIXING TBC". */
  fixNote: string;
  /** For a joint the code can't name: what is cut, in words. */
  what?: string;
  /** Faces meeting, for a butt: which of the guest's (END, EDGE, FACE) meets which of the host's. */
  faces?: string;
  through?: boolean;
  haunched?: boolean;
  /** The host's cuts in it (model), if any. */
  hostCut: Box3 | null;
  /** Per model axis: the host's cuts here run its whole length that way (a groove the length of a stile). */
  hostRuns: boolean[];
  /** The joint type it belongs to (index into JointSet.types). */
  type: number;
};

export type JointType = {
  index: number;
  kind: JointKind;
  name: string;
  insts: JointInst[];
  /** Part numbers: the hosts, the guests, the fixings. */
  hostMarks: number[];
  guestMarks: number[];
  fixMarks: number[];
  /** "APRON & END APRON TO LEG", "RAFTER NOTCHED OVER BEAM". */
  title: string;
  sizesText: string;
  fixNote: string;
  butt: boolean;
  /** Its detail's letter (A, B... skipping I, O, Q), or null: a butt in the schedule only (more than six butt types). */
  letter: string | null;
  /** Whose joint it is (19.7), from the model's design record: his (AS DIRECTED) or the assistant's (SUGGESTED). */
  by?: "owner" | "assistant";
  /** The design rules its proportions follow (20.2, from the record), as far as its sizes bear them out. */
  rules?: string[];
};

export type JointSet = { insts: JointInst[]; types: JointType[]; buttsInScheduleOnly: boolean };

export const KIND_NAME: Record<JointKind, string> = {
  "mortise and tenon": "MORTISE AND TENON",
  bridle: "BRIDLE",
  housing: "HOUSING",
  slot: "SLOT",
  rebate: "REBATE",
  groove: "GROOVE",
  "tongue and groove": "TONGUE AND GROOVE",
  halving: "HALVING",
  notch: "NOTCH",
  birdsmouth: "BIRDSMOUTH",
  dovetail: "DOVETAIL",
  "box joint": "BOX JOINT",
  mitre: "MITRE",
  scarf: "SCARF",
  dowelled: "DOWELLED",
  bolted: "BOLTED",
  screwed: "SCREWED",
  butt: "BUTT",
  unnamed: "JOINT",
};

/** The recipes (Stage 9.2) and the joint each makes. */
const RECIPE_KIND: Record<string, JointKind> = {
  butt: "butt",
  mitre: "mitre",
  half_lap: "halving",
  housing: "housing",
  mortise_tenon: "mortise and tenon",
  bridle: "bridle",
  dovetail: "dovetail",
  box_joint: "box joint",
  dowel: "dowelled",
  tongue_groove: "tongue and groove",
  birdsmouth: "birdsmouth",
  scarf: "scarf",
};

/* ---------------- small geometry ---------------- */

type P2 = [number, number];
const sizeOf = (b: Box3): V3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
const centre = (b: Box3): V3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
const boxUnion = (a: Box3 | null, b: Box3): Box3 => (a ? { min: [0, 1, 2].map((i) => Math.min(a.min[i], b.min[i])) as V3, max: [0, 1, 2].map((i) => Math.max(a.max[i], b.max[i])) as V3 } : { min: [...b.min] as V3, max: [...b.max] as V3 });
const boxInter = (a: Box3, b: Box3): Box3 | null => {
  const min: V3 = [0, 0, 0],
    max: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    min[i] = Math.max(a.min[i], b.min[i]);
    max[i] = Math.min(a.max[i], b.max[i]);
    if (max[i] - min[i] < -1e-6) return null;
  }
  return { min, max };
};
const grown = (b: Box3, by: number | V3): Box3 => {
  const g = typeof by === "number" ? [by, by, by] : by;
  return { min: [b.min[0] - g[0], b.min[1] - g[1], b.min[2] - g[2]], max: [b.max[0] + g[0], b.max[1] + g[1], b.max[2] + g[2]] };
};
const inBox = (p: V3, b: Box3, tol = 0.01) => [0, 1, 2].every((i) => p[i] >= b.min[i] - tol && p[i] <= b.max[i] + tol);
export const AXIS: V3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
/** Which model axis a direction runs along (0, 1, 2), or -1 if it's slanted. */
export const axisOf = (d: V3): number => (Math.abs(d[0]) > 0.999 ? 0 : Math.abs(d[1]) > 0.999 ? 1 : Math.abs(d[2]) > 0.999 ? 2 : -1);
const r1 = (v: number) => Math.round(v * 10) / 10;
const fmt = (v: number) => {
  const r = Math.round(v);
  return Math.abs(v - r) < 0.05 ? String(r) : (Math.round(v * 10) / 10).toFixed(1);
};

/** A box in a part's drawing frame, back in the model. */
export function toModelBox(p: PartInfo, b: Box3): Box3 {
  const inv = invert(p.modelToDraw);
  const out = emptyBox();
  for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) grow(out, apply(inv, [i ? b.max[0] : b.min[0], j ? b.max[1] : b.min[1], k ? b.max[2] : b.min[2]]));
  return out;
}
/** A part's drawing axis (0 length, 1 thickness, 2 width) as a model direction. */
export const drawAxis = (p: PartInfo, a: number): V3 => [p.modelToDraw.r[a * 3], p.modelToDraw.r[a * 3 + 1], p.modelToDraw.r[a * 3 + 2]];

function basis(n: V3): [V3, V3] {
  const u = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  return [u, cross(n, u)];
}
const area2d = (p: P2[]) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return a / 2;
};
/** A convex polygon clipped by another convex one (both counter-clockwise). */
function clipConvex(subject: P2[], clip: P2[]): P2[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i],
      b = clip[(i + 1) % clip.length];
    const side = (p: P2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const inp = out;
    out = [];
    for (let k = 0; k < inp.length; k++) {
      const p = inp[k],
        q = inp[(k + 1) % inp.length];
      const sp = side(p),
        sq = side(q);
      if (sp >= -1e-9) out.push(p);
      if ((sp >= -1e-9) !== (sq >= -1e-9)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}
const polyBox = (polys: Poly[]) => {
  const b = emptyBox();
  for (const p of polys) for (const v of p.v) grow(b, v);
  return b;
};

/** Where two parts' faces lie on each other: the area, where, and each face's outward normal (a's side) with its area. */
export type Contact = { area: number; box: Box3; faces: { n: V3; area: number; c: V3; pts?: V3[] }[] };

export function contactOf(a: Poly[], b: Poly[]): Contact | null {
  const bb = polyBox(b);
  const ab = polyBox(a);
  const near = boxInter(grown(ab, 0.01), grown(bb, 0.01));
  if (!near) return null;
  const key = (n: V3) => `${Math.round(n[0] * 1000)},${Math.round(n[1] * 1000)},${Math.round(n[2] * 1000)}`;
  const byN = new Map<string, Poly[]>();
  for (const q of b) {
    if (!q.v.some((v) => inBox(v, near, 0.02)) && !boxInter(polyBox([q]), near)) continue;
    const k = key(q.p.n);
    byN.set(k, [...(byN.get(k) ?? []), q]);
  }
  let area = 0;
  let box: Box3 | null = null;
  const faces: Contact["faces"] = [];
  for (const p of a) {
    const pb = polyBox([p]);
    if (!boxInter(pb, near)) continue;
    const list = byN.get(key([-p.p.n[0], -p.p.n[1], -p.p.n[2]]));
    if (!list) continue;
    const n = p.p.n;
    const [u, v] = basis(n);
    const P = (x: V3): P2 => [dot(x, u), dot(x, v)];
    let sp = p.v.map(P);
    if (area2d(sp) < 0) sp = sp.reverse();
    for (const q of list) {
      if (Math.abs(p.p.w + q.p.w) > 0.01) continue;
      if (!boxInter(grown(pb, 0.01), polyBox([q]))) continue;
      let sq = q.v.map(P);
      if (area2d(sq) < 0) sq = sq.reverse();
      const o = clipConvex(sp, sq);
      if (o.length < 3) continue;
      const ar = area2d(o);
      if (ar < 1e-4) continue;
      area += ar;
      const w = p.p.w;
      const pts = o.map(([x, y]): V3 => [u[0] * x + v[0] * y + n[0] * w, u[1] * x + v[1] * y + n[1] * w, u[2] * x + v[2] * y + n[2] * w]);
      const ob = emptyBox();
      for (const x of pts) grow(ob, x);
      box = boxUnion(box, ob);
      faces.push({ n, area: ar, c: centre(ob), pts });
    }
  }
  return area > 0.5 && box ? { area, box, faces } : null;
}

/* ---------------- the parts ---------------- */

/** A fixing: round and small (a bolt, a dowel, a peg), or steel, or named as one. */
function fixingOf(p: PartInfo, name: string): Fixing["kind"] | null {
  const n = name.toLowerCase();
  if (/\bbolts?\b|coach|\bnuts?\b|washer|threaded rod/.test(n)) return "bolt";
  if (/\bscrews?\b/.test(n)) return "screw";
  if (/\bnails?\b|brad/.test(n)) return "nail";
  if (/\bpegs?\b|\bpins?\b|treenail|trenail/.test(n)) return "peg";
  if (/\bdowels?\b/.test(n)) return "dowel";
  if (/\bkeys?\b/.test(n)) return "key";
  if (/\bwedges?\b/.test(n)) return "wedge";
  if (/fish ?plates?|splice plates?|steel plates?/.test(n)) return "plate";
  if (p.round && Math.min(p.T, p.W) <= 30) return p.material === "steel" ? "bolt" : "dowel";
  if (p.material === "steel" && Math.max(p.T, p.W) <= 30 && p.L <= 400) return "pin";
  return null;
}
/** Parts that hang or slide (doors, lids, drawers): where they close against the carcass is not a joint. */
const hung = (p: PartInfo) => /\b(DOOR|LID|FLAP)S?\b/.test(p.label.toUpperCase());
const drawer = (p: PartInfo) => /\bDRAWER\b/.test(p.label.toUpperCase());

const RECEIVING: Feature["kind"][] = ["mortise", "slot", "housing", "rebate", "groove", "notch", "pocket"];

/**
 * Which of a part's features make this joint: the cuts the contact faces lie on (a face inside the cut's box), each
 * holding a fair share of the contact (a housing crossing a rebate holds only a sliver of the back's contact: not it),
 * or, with nothing touching, the cuts the other part overlaps.
 */
function featsIn(p: PartInfo, faces: Contact["faces"], overlap: Box3 | null, fixFaces: Contact["faces"] = []): number[] {
  const held = p.features.map((f) => {
    const mb = toModelBox(p, f.box);
    return faces.reduce((t, c) => t + (inBox(c.c, mb, 0.02) ? c.area : 0), 0);
  });
  const top = Math.max(0, ...held);
  const out: number[] = [];
  p.features.forEach((f, i) => {
    const mb = toModelBox(p, f.box);
    if (held[i] > 0 && held[i] >= 0.05 * top) out.push(i);
    // a hole with one of the joint's fixings in it, however small beside the joint (a bolt through a long scarf)
    else if (f.hole && fixFaces.some((c) => inBox(c.c, mb, 0.02))) out.push(i);
    else if (!faces.length && overlap && [0, 1, 2].every((k) => Math.min(mb.max[k], overlap.max[k]) - Math.max(mb.min[k], overlap.min[k]) > 0.5)) out.push(i);
  });
  return out;
}

/** A box found inside a slightly smaller one, put back to the full one's faces where it reached them. */
const grownIn = (b: Box3 | null, outer: Box3): Box3 | null => (b ? { min: b.min.map((v, i) => (v <= outer.min[i] + 0.006 ? outer.min[i] : v)) as V3, max: b.max.map((v, i) => (v >= outer.max[i] - 0.006 ? outer.max[i] : v)) as V3 } : null);

/** The box of a part's material inside a box (its polygons clipped to it): a tenon inside a leg, not the apron's box. */
export function materialIn(polys: Poly[], box: Box3): Box3 | null {
  let out: Box3 | null = null;
  for (const p of polys) {
    let pts = p.v;
    for (let i = 0; i < 3 && pts.length; i++)
      for (const [lim, s] of [
        [box.min[i], 1],
        [box.max[i], -1],
      ] as const) {
        const inp = pts;
        pts = [];
        for (let k = 0; k < inp.length; k++) {
          const a = inp[k],
            b = inp[(k + 1) % inp.length];
          const da = (a[i] - lim) * s,
            db = (b[i] - lim) * s;
          if (da >= -1e-9) pts.push(a);
          if ((da >= -1e-9) !== (db >= -1e-9)) {
            const t = da / (da - db);
            pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
          }
        }
        if (!pts.length) break;
      }
    if (pts.length < 3) continue;
    const b = emptyBox();
    for (const v of pts) grow(b, v);
    out = boxUnion(out, b);
  }
  return out && sizeOf(out).every((s) => s > 1e-6) ? out : null;
}

/* ---------------- finding them ---------------- */

export function findAllJoints(m: ModelPayload, built: BuiltModel, parts: PartInfo[], marks: Mark[]): JointSet {
  const live = parts.filter((p) => built.parts[p.index].polys.length);
  const fix = new Map<number, Fixing>();
  for (const p of live) {
    const k = fixingOf(p, m.parts[p.index].name);
    if (k) fix.set(p.index, { part: p.index, mark: p.mark, kind: k, d: Math.min(p.T, p.W), len: p.L, w: Math.max(p.T, p.W), ...(p.material === "steel" ? { steel: true } : {}) });
  }
  // every pair whose faces lie on each other, or that are let into each other
  type Pair = { a: number; b: number; c: Contact | null; overlap: Box3 | null };
  const pairs: Pair[] = [];
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const A = live[i],
        B = live[j];
      const ba = built.parts[A.index].bbox,
        bb = built.parts[B.index].bbox;
      if (!boxInter(grown(ba, 0.02), bb)) continue;
      // a door or a drawer closing against the carcass is not a joint; a drawer's own parts are
      if ((hung(A) || hung(B) || drawer(A) || drawer(B)) && !(drawer(A) && drawer(B))) continue;
      const c = contactOf(built.parts[A.index].polys, built.parts[B.index].polys);
      const ov = boxInter(ba, bb);
      const deep = ov && sizeOf(ov).every((s) => s > 0.5) ? ov : null;
      if (!c && !deep) continue;
      pairs.push({ a: A.index, b: B.index, c, overlap: c ? null : deep });
    }
  const isFix = (i: number) => fix.has(i);
  const pairOf = new Map<string, Pair>();
  for (const p of pairs) pairOf.set(`${Math.min(p.a, p.b)}|${Math.max(p.a, p.b)}`, p);
  const get = (a: number, b: number) => pairOf.get(`${Math.min(a, b)}|${Math.max(a, b)}`);
  // joints: each pair of members that meet; fixings join the pair they pass through
  type Draft = { a: number; b: number; fixings: number[] };
  const drafts: Draft[] = pairs.filter((p) => !isFix(p.a) && !isFix(p.b)).map((p) => ({ a: p.a, b: p.b, fixings: [] }));
  const touching = (f: number) => pairs.filter((p) => p.a === f || p.b === f).map((p) => (p.a === f ? p.b : p.a));
  const later: number[] = [];
  for (const f of fix.keys()) {
    const members = touching(f).filter((x) => !isFix(x));
    if (members.length < 2) {
      later.push(f);
      continue;
    }
    // the pair it passes through with the most contact; or a new joint of the parts it holds together
    let best: Draft | null = null;
    let bestArea = -1;
    for (const d of drafts)
      if (members.includes(d.a) && members.includes(d.b)) {
        const ar = get(d.a, d.b)?.c?.area ?? 0;
        if (ar > bestArea) ((best = d), (bestArea = ar));
      }
    if (best) best.fixings.push(f);
    else drafts.push({ a: members[0], b: members[1], fixings: [f] });
  }
  // a nut or a washer: with the bolt it sits on
  for (const f of later) {
    const on = touching(f).find((x) => isFix(x) && drafts.some((d) => d.fixings.includes(x)));
    if (on !== undefined) drafts.find((d) => d.fixings.includes(on))!.fixings.push(f);
  }
  const insts: JointInst[] = drafts.map((d, i) => describe(m, built, parts, d.a, d.b, d.fixings.map((f) => fix.get(f)!), get, i));
  const types = groupTypes(insts, parts, marks);
  return { insts, types: types.types, buttsInScheduleOnly: types.buttsOnly };
}

/** A joint between a and b (with these fixings): which is the host, its kind, its sizes, how it's held. */
function describe(m: ModelPayload, built: BuiltModel, parts: PartInfo[], a: number, b: number, fixings: Fixing[], get: (a: number, b: number) => { c: Contact | null; overlap: Box3 | null } | undefined, index: number): JointInst {
  const pr = get(a, b);
  const c = pr?.c ?? null;
  const overlap = pr?.overlap ?? null;
  // the faces each part shows to the joint: its contact with the other, and with the fixings through it
  const facesOf = (x: number, y: number) => {
    const p = get(x, y);
    if (!p?.c) return [];
    // contact faces are kept with the lower index's normals; flip for the other side
    const flip = Math.min(x, y) !== x;
    return p.c.faces.map((f) => (flip ? { ...f, n: [-f.n[0], -f.n[1], -f.n[2]] as V3 } : f));
  };
  const allFaces = (x: number) => [...facesOf(x, x === a ? b : a), ...fixings.flatMap((f) => facesOf(x, f.part))];
  const PA = parts[a],
    PB = parts[b];
  const fixFaces = (x: number) => fixings.flatMap((f) => facesOf(x, f.part));
  const fa = featsIn(PA, allFaces(a), overlap, fixFaces(a)),
    fb = featsIn(PB, allFaces(b), overlap, fixFaces(b));
  const kinds = (p: PartInfo, fs: number[]) => fs.map((i) => p.features[i]).filter((f) => !f.hole).map((f) => f.kind);
  const ka = kinds(PA, fa),
    kb = kinds(PB, fb);
  const recv = (ks: Feature["kind"][]) => ks.some((k) => RECEIVING.includes(k));
  const tenonish = (ks: Feature["kind"][]) => ks.some((k) => k === "tenon" || k === "end");
  // which is the host (the one let into): the one with a trench, a mortise or a groove cut for the other
  let host = a;
  const vol = (i: number) => built.parts[i].volume;
  const broad = (p: PartInfo, faces: Contact["faces"]) => {
    // contact on its broad face (normal along its thickness): it's the one the other meets
    const t = drawAxis(p, 1);
    return faces.reduce((s, f) => s + (Math.abs(dot(f.n, t)) > 0.99 ? f.area : 0), 0);
  };
  const mortised = (ks: Feature["kind"][]) => ks.some((k) => k === "mortise" || k === "slot");
  if (ka.includes("tenon") && mortised(kb)) host = b;
  else if (kb.includes("tenon") && mortised(ka)) host = a;
  else if (recv(ka) && !recv(kb)) host = a;
  else if (recv(kb) && !recv(ka)) host = b;
  else if (recv(ka) && recv(kb)) host = vol(a) >= vol(b) ? a : b;
  else if (tenonish(ka) && !tenonish(kb)) host = b;
  else if (tenonish(kb) && !tenonish(ka)) host = a;
  else {
    const sa = broad(PA, allFaces(a)),
      sb = broad(PB, allFaces(b));
    host = sa > sb + 1e-6 ? a : sb > sa + 1e-6 ? b : vol(a) >= vol(b) ? a : b;
  }
  const guest = host === a ? b : a;
  const H = parts[host],
    G = parts[guest];
  const hf = host === a ? fa : fb,
    gf = host === a ? fb : fa;
  const hk = host === a ? ka : kb,
    gk = host === a ? kb : ka;
  // where it is: the contact (or the overlap), and the cuts that make it (a long groove cropped to the joint)
  const contact: Box3 = c?.box ?? overlap ?? boxInter(built.parts[a].bbox, built.parts[b].bbox) ?? emptyBox();
  const cs = sizeOf(contact);
  const near = grown(contact, cs.map((s) => Math.max(12, 0.35 * s)) as V3);
  const cutBox = (p: PartInfo, fs: number[], holes = false) => {
    let out: Box3 | null = null;
    const pb = built.parts[p.index].bbox;
    for (const i of fs) {
      if (!holes && p.features[i].hole) continue;
      const fb = toModelBox(p, p.features[i].box);
      // a cut running the part's whole length (a groove a haunch sits in) only counts where the joint is
      const lim = { min: [...near.min] as V3, max: [...near.max] as V3 };
      for (let k = 0; k < 3; k++)
        if (fb.min[k] <= pb.min[k] + 0.01 && fb.max[k] >= pb.max[k] - 0.01 && pb.max[k] - pb.min[k] > 2 * (contact.max[k] - contact.min[k]) + 1) {
          lim.min[k] = contact.min[k];
          lim.max[k] = contact.max[k];
        }
      const mb = boxInter(fb, lim);
      if (mb) out = boxUnion(out, mb);
    }
    return out;
  };
  const hc = cutBox(H, hf),
    gc = cutBox(G, gf);
  let region = boxUnion(contact, contact);
  if (hc) region = boxUnion(region, hc);
  if (gc) region = boxUnion(region, gc);
  for (const f of fixings) region = boxUnion(region, built.parts[f.part].bbox);
  // the way the guest comes out: no contact face of it pushing into the host that way; most face area behind it
  const gFaces = facesOf(guest, host);
  const gb = built.parts[guest].bbox,
    hb = built.parts[host].bbox;
  let d: V3 = [0, 0, 1];
  {
    let best = -Infinity;
    const away = [0, 1, 2].map((i) => centre(gb)[i] - centre(hb)[i]);
    for (const ax of AXIS)
      for (const s of [1, -1]) {
        const dd: V3 = [ax[0] * s, ax[1] * s, ax[2] * s];
        const blocked = gFaces.some((f) => f.area > 0.5 && dot(dd, f.n) > 0.05);
        const score = (blocked ? -1e9 : 0) + gFaces.reduce((t, f) => t - f.area * dot(dd, f.n), 0) + 1e-6 * dot(dd, away as V3);
        if (score > best) ((best = score), (d = dd));
      }
    if (!gFaces.length) {
      // let in with no faces touching (a gap in the model): the way it's furthest out of the host
      const k = [0, 1, 2].sort((x, y) => Math.abs(away[y]) - Math.abs(away[x]))[0];
      d = [0, 0, 0];
      d[k] = Math.sign(away[k]) || 1;
    }
  }
  const di = axisOf(d);
  const cross2 = [0, 1, 2].filter((i) => i !== di);
  // the kind: the recipe's when the model is one; else from what's cut
  const recipe = m.made_by?.recipe;
  let kind: JointKind;
  const hostPrism = (H.features.length && (m.parts[host].cuts ?? []).some((x) => x.type === "prism")) || (m.parts[guest].cuts ?? []).some((x) => x.type === "prism");
  const members = m.parts.filter((p, i) => !fixingOf(parts[i], p.name)).length;
  // two members of one section in line, each cut away for the other: a splice, whatever made it (19.8)
  if (spliced(built, H, G)) kind = "scarf";
  else if (recipe && RECIPE_KIND[recipe] && members <= 2) kind = RECIPE_KIND[recipe];
  else if (gk.includes("tenon") && hk.includes("mortise")) kind = "mortise and tenon";
  else if (gk.includes("tenon") && hk.includes("slot")) kind = "bridle";
  else if (hk.includes("groove") && (gk.includes("tenon") || gk.includes("rebate"))) kind = "tongue and groove";
  else if (hk.includes("slot") && !gk.length) kind = "slot";
  else if (hk.includes("housing") && (!gk.length || gk.every((k) => k === "tenon"))) kind = "housing";
  // a part's whole end let into a recess (no tenon on it): a stopped housing
  else if ((hk.includes("mortise") || hk.includes("pocket")) && !gk.length) kind = "housing";
  else if (hk.includes("groove") && !gk.length) kind = "groove";
  else if (hk.includes("rebate") && !gk.length) kind = "rebate";
  // a part's end let into a cut across another (a shelf into a square post) is housed, whatever that cut is called
  else if (hk.includes("notch") && !gk.length && di >= 0 && Math.abs(dot(drawAxis(G, 0), d)) > 0.99) kind = "housing";
  else if (hk.includes("notch") && !gk.length) kind = hostPrism ? "birdsmouth" : "notch";
  else if (hk.length && gk.length && recv(hk) && recv(gk)) kind = "halving";
  else if (!hk.length && !gk.length) kind = fixings.some((f) => f.kind === "bolt") ? "bolted" : fixings.some((f) => f.kind === "screw" || f.kind === "nail") ? "screwed" : fixings.some((f) => f.kind === "dowel") ? "dowelled" : holesLineUp(H, G, hf, gf) ? "bolted" : "butt";
  else kind = "unnamed";
  // the sizes, from the cuts
  const sizes: Record<string, number> = {};
  const ext = (bx: Box3, i: number) => bx.max[i] - bx.min[i];
  // the guest's material inside the host (a tenon, a shelf's end), and its own section just outside
  // (faces lying on the host's outside, a tenon's shoulders, aren't inside it)
  const inside = grownIn(materialIn(built.parts[guest].polys, grown(hb, -0.005)), hb);
  let through = false,
    haunched = false;
  const hostLen = axisOf(drawAxis(H, 0));
  // sizes are named by the joint's own axes (u, v across it, sorted by size), so mirror images and turned copies agree
  const uv = [...cross2].sort((x, y) => (hc ? ext(hc, y) - ext(hc, x) : 0) || x - y);
  const tenon = gk.includes("tenon");
  // a cut running right through the host that way (a groove the length of a stile, a through housing): its length
  // there is the part's, not the joint's
  const runsThrough = (p: PartInfo, f: Feature, i: number, pb: Box3) => {
    const mb = toModelBox(p, f.box);
    return mb.min[i] <= pb.min[i] + 0.01 && mb.max[i] >= pb.max[i] - 0.01;
  };
  const hCuts = hf.filter((k) => !H.features[k].hole);
  const runs = [0, 1, 2].map((i) => hCuts.length > 0 && hCuts.every((k) => runsThrough(H, H.features[k], i, hb)));
  if (hc && di >= 0) {
    sizes.depth = ext(hc, di);
    through = hc.min[di] <= hb.min[di] + 0.01 && hc.max[di] >= hb.max[di] - 0.01;
    uv.forEach((i, k) => !runs[i] && (sizes[k ? "cutV" : "cutU"] = ext(hc, i)));
    // set out from the host's faces (the nearer each way; along the host's length that's its end: on the part view)
    uv.forEach((i, k) => {
      if (i === hostLen) return;
      const lo = hc.min[i] - hb.min[i],
        hi = hb.max[i] - hc.max[i];
      if (lo > 0.05 && hi > 0.05) sizes[k ? "fromV" : "fromU"] = Math.min(lo, hi);
    });
  }
  if (inside && di >= 0) {
    sizes.len = ext(inside, di);
    if (sizes.depth !== undefined && !through && sizes.depth - sizes.len > 0.05) sizes.gap = sizes.depth - sizes.len;
    uv.forEach((i, k) => !runs[i] && (sizes[k ? "inV" : "inU"] = ext(inside, i)));
    // a tenon's shoulders: the guest's section just outside the host, against what goes in
    if (tenon) {
      const stub = { min: [...gb.min] as V3, max: [...gb.max] as V3 };
      if (d[di] > 0) ((stub.min[di] = hb.max[di]), (stub.max[di] = hb.max[di] + 1));
      else ((stub.max[di] = hb.min[di]), (stub.min[di] = hb.min[di] - 1));
      const sec = materialIn(built.parts[guest].polys, stub) ?? stub;
      uv.forEach((i, k) => {
        const s = [inside.min[i] - sec.min[i], sec.max[i] - inside.max[i]].sort((x, y) => x - y);
        if (s[0] > 0.05) sizes[k ? "shV1" : "shU1"] = s[0];
        if (s[1] > 0.05) sizes[k ? "shV2" : "shU2"] = s[1];
      });
    }
  }
  // a haunch: the guest's cuts at this end go to more than one depth
  if (di >= 0 && (kind === "mortise and tenon" || kind === "bridle")) {
    // (a groove the length of the rail isn't part of its end's shape)
    const depths = new Set(gf.filter((i) => !G.features[i].hole && !runsThrough(G, G.features[i], di, gb)).map((i) => r1(ext(toModelBox(G, G.features[i].box), di))));
    if (depths.size > 1) {
      haunched = true;
      sizes.haunch = Math.max(...depths) - Math.min(...depths);
      // the tenon proper is what goes in past the haunch; the haunch is the rest of its width
      const past = { min: [...hb.min] as V3, max: [...hb.max] as V3 };
      if (d[di] > 0) past.max[di] = hb.max[di] - sizes.haunch - 0.5;
      else past.min[di] = hb.min[di] + sizes.haunch + 0.5;
      const proper = materialIn(built.parts[guest].polys, past);
      if (proper && inside)
        uv.forEach((i, k) => {
          if (runs[i]) return;
          const full = ext(inside, i),
            t = ext(proper, i);
          sizes[k ? "inV" : "inU"] = t;
          if (full - t > 0.05) sizes.haunchW = full - t;
        });
    }
  }
  // a scarf: its shape and sizes from the faces where its halves meet (19.8)
  let scarf: { name: string; text: string } | null = null;
  if (kind === "scarf" && c && hostLen >= 0) {
    const sc = scarfShape(c, contact, hb, hostLen);
    for (const k of Object.keys(sizes)) delete sizes[k];
    Object.assign(sizes, sc.sizes);
    scarf = sc;
    // where it is: the splice and what holds it (a plain scarf's cut is the part's whole end, as the code finds it)
    region = boxUnion(contact, contact);
    for (const f of fixings) region = boxUnion(region, built.parts[f.part].bbox);
  }
  // the words: its kind as drawn, its key sizes, how it's held
  let name = KIND_NAME[kind];
  if (scarf) {
    name = scarf.name;
    const plates = fixings.filter((f) => f.kind === "plate");
    if (plates.length) name += plates.every((f) => f.steel) ? ", STEEL FISHPLATES" : ", FISHPLATES";
    if (fixings.some((f) => f.kind === "key")) name += ", KEYED";
    if (fixings.some((f) => f.kind === "wedge")) name += ", WEDGED";
    if (fixings.some((f) => f.kind === "bolt")) name += ", BOLTED";
  } else {
    if (kind === "mortise and tenon") name = `${haunched ? "HAUNCHED " : ""}${through ? "THROUGH " : ""}MORTISE AND TENON`;
    if (fixings.some((f) => f.kind === "peg")) name += ", PEGGED";
    else if (fixings.some((f) => f.kind === "bolt") && kind !== "bolted") name += ", BOLTED";
    else if (fixings.some((f) => f.kind === "dowel") && kind !== "dowelled") name += ", DOWELLED";
    else if (fixings.some((f) => f.kind === "screw") && kind !== "screwed") name += ", SCREWED";
  }
  const tw = [sizes.inU, sizes.inV].filter((x) => x !== undefined).sort((x, y) => x - y);
  let sizesText = "";
  if (kind === "mortise and tenon" || kind === "bridle") sizesText = `TENON ${tw.map(fmt).join(" x ")} x ${fmt(sizes.len ?? 0)} LONG${sizes.gap ? `, ${fmt(sizes.gap)} CLEAR` : ""}${haunched ? `, HAUNCH ${fmt(sizes.haunch!)}${sizes.haunchW ? ` x ${fmt(sizes.haunchW)}` : ""}` : ""}`;
  else if (kind === "housing" || kind === "slot" || kind === "groove" || kind === "rebate" || kind === "notch" || kind === "birdsmouth" || kind === "tongue and groove") {
    const w = hc ? Math.min(...cross2.map((i) => ext(hc, i))) : 0;
    sizesText = `${KIND_NAME[kind]} ${fmt(w)} x ${fmt(sizes.depth ?? 0)} DEEP${sizes.gap ? `, ${fmt(sizes.gap)} CLEAR` : ""}`;
  } else if (kind === "halving") sizesText = `LAP ${fmt(sizes.len ?? 0)} DEEP`;
  else if (scarf) sizesText = scarf.text;
  // which faces meet (a butt): the guest's end, edge or face on the host's
  const faceName = (p: PartInfo, n: V3) => (Math.abs(dot(n, drawAxis(p, 0))) > 0.99 ? "END" : Math.abs(dot(n, drawAxis(p, 1))) > 0.99 ? "FACE" : "EDGE");
  let faces: string | undefined;
  const gMain = gFaces.slice().sort((x, y) => y.area - x.area)[0];
  if (gMain) faces = `${faceName(G, gMain.n)} TO ${faceName(H, [-gMain.n[0], -gMain.n[1], -gMain.n[2]])}`;
  if (kind === "butt" || kind === "screwed" || kind === "bolted" || kind === "dowelled") {
    sizesText = faces ? `${faces}` : "";
    if (cs.some((x) => x > 0.05)) {
      const across = cross2.map((i) => cs[i]).filter((x) => x > 0.05);
      if (kind === "butt") sizes.contact = Math.min(...across);
    }
  }
  // how it's held
  const fixNote = fixingNote(fixings, kind, m.note ?? "", H, G, hf, gf);
  let what: string | undefined;
  if (kind === "unnamed") {
    const cutWords = (p: PartInfo, ks: Feature["kind"][]) => (ks.length ? `${[...new Set(ks)].map((k) => k.toUpperCase()).join(" AND ")} IN ${p.label}` : "");
    what = [cutWords(H, hk), cutWords(G, gk)].filter(Boolean).join(", ") || "NOTHING CUT";
    sizesText = what;
  }
  const feats = new Map<number, number[]>([
    [host, hf],
    [guest, gf],
  ]);
  for (const f of fixings) feats.set(f.part, []);
  return { index, host, guests: [guest], fixings, parts: [host, guest, ...fixings.map((f) => f.part)], kind, name, contact, region, d, feats, sizes, sizesText, fixNote, ...(what ? { what } : {}), ...(faces ? { faces } : {}), through, haunched, hostCut: hc, hostRuns: runs, type: -1 };
}

/** Holes in both parts at the joint, on one line: a bolt or a dowel with no part for it in the model. */
function holesLineUp(H: PartInfo, G: PartInfo, hf: number[], gf: number[]) {
  const hs = hf.map((i) => H.features[i]).filter((f) => f.hole);
  const gs = gf.map((i) => G.features[i]).filter((f) => f.hole);
  return hs.length > 0 && gs.length > 0;
}

/**
 * Two members of one section in line, overlapping along their length (each cut away for the other): a splice. Their
 * length axes agree, their sections line up within a millimetre, and neither lies wholly along the other.
 */
function spliced(built: BuiltModel, A: PartInfo, B: PartInfo) {
  const la = drawAxis(A, 0),
    lb = drawAxis(B, 0);
  const L = axisOf(la);
  if (L < 0 || Math.abs(dot(la, lb)) < 0.999) return false;
  const ba = built.parts[A.index].bbox,
    bb = built.parts[B.index].bbox;
  for (let i = 0; i < 3; i++) if (i !== L && (Math.abs(ba.min[i] - bb.min[i]) > 1 || Math.abs(ba.max[i] - bb.max[i]) > 1)) return false;
  const ov = Math.min(ba.max[L], bb.max[L]) - Math.max(ba.min[L], bb.min[L]);
  return ov > 1 && ov < Math.min(ba.max[L] - ba.min[L], bb.max[L] - bb.min[L]) - 1;
}

/**
 * A scarf's shape and sizes from the faces where its halves meet. Its length along the members is the contact's. A face
 * on a slope is a splay: with square ends, a stop-splayed scarf (its nibs the ends' height); without, a plain scarf (and
 * its slope). No slope: flat faces at two levels, a tabled scarf (the table the step between); at one level, a halved
 * splice (the lap its depth).
 */
function scarfShape(c: Contact, contact: Box3, hb: Box3, L: number): { sizes: Record<string, number>; name: string; text: string } {
  const len = contact.max[L] - contact.min[L];
  const cr = [0, 1, 2].filter((i) => i !== L);
  // the way the halves step (the depth across the splice): where the faces' normals point, other than along it
  const weight = cr.map((i) => c.faces.reduce((s, f) => s + (Math.abs(f.n[L]) < 0.99 ? f.area * Math.abs(f.n[i]) : 0), 0));
  const D = weight[0] >= weight[1] ? cr[0] : cr[1];
  const depth = hb.max[D] - hb.min[D];
  const big = c.faces.filter((f) => f.area > 1);
  const sloped = big.filter((f) => Math.abs(f.n[L]) > 0.02 && Math.abs(f.n[L]) < 0.99);
  const flat = big.filter((f) => Math.abs(f.n[L]) <= 0.02 && Math.abs(f.n[D]) > 0.99);
  // the square ends: at each end of the splice, how high the faces there reach across it (in one piece or several)
  const endAt = (s: number) => {
    const pts = c.faces.filter((f) => Math.abs(f.n[L]) >= 0.99 && Math.abs(f.c[L] - s) < 0.5).flatMap((f) => f.pts ?? []);
    return pts.length ? Math.max(...pts.map((p) => p[D])) - Math.min(...pts.map((p) => p[D])) : 0;
  };
  const ends = [endAt(contact.min[L]), endAt(contact.max[L])].filter((h) => h > 0.5);
  if (sloped.length) {
    if (ends.length) {
      const nibs = [...new Set(ends.map(r1))].sort((x, y) => y - x);
      return { sizes: { splice: len, nib: nibs[0], ...(nibs.length > 1 ? { nib2: nibs[nibs.length - 1] } : {}) }, name: "STOP-SPLAYED SCARF", text: `${fmt(len)} LONG, NIBS ${nibs.map(fmt).join(" & ")}` };
    }
    const slope = len / depth;
    return { sizes: { splice: len, slope }, name: "SCARF", text: `1 IN ${fmt(slope)}, ${fmt(len)} LONG` };
  }
  const levels = [...new Set(flat.map((f) => r1(f.c[D])))].sort((x, y) => x - y);
  if (levels.length >= 2) {
    const table = levels[levels.length - 1] - levels[0];
    return { sizes: { splice: len, table }, name: "TABLED SCARF", text: `${fmt(len)} LONG, TABLE ${fmt(table)}` };
  }
  const lap = levels.length ? Math.min(levels[0] - hb.min[D], hb.max[D] - levels[0]) : depth / 2;
  return { sizes: { splice: len, lap }, name: "HALVED SPLICE", text: `${fmt(len)} LONG, LAP ${fmt(lap)} DEEP` };
}

function fixingNote(fixings: Fixing[], kind: JointKind, note: string, H: PartInfo, G: PartInfo, hf: number[], gf: number[]): string {
  if (fixings.length) {
    const groups = new Map<string, { f: Fixing; n: number }>();
    for (const f of fixings) {
      const k = `${f.kind}|${r1(f.d)}|${r1(f.len)}|${r1(f.w ?? 0)}|${f.steel ? 1 : 0}`;
      const g = groups.get(k);
      if (g) g.n++;
      else groups.set(k, { f, n: 1 });
    }
    return [...groups.values()]
      .map(({ f, n }) => {
        const many = n > 1;
        const what = {
          bolt: many ? "BOLTS" : "BOLT",
          screw: many ? "SCREWS" : "SCREW",
          dowel: many ? "DOWELS" : "DOWEL",
          peg: many ? "PEGS" : "PEG",
          nail: many ? "NAILS" : "NAIL",
          pin: many ? "PINS" : "PIN",
          key: many ? "KEYS" : "KEY",
          wedge: many ? "FOLDING WEDGES" : "WEDGE",
          plate: f.steel ? (many ? "STEEL PLATES" : "STEEL PLATE") : many ? "FISHPLATES" : "FISHPLATE",
        }[f.kind];
        const size = f.kind === "bolt" ? `M${fmt(f.d)} x ${fmt(f.len)}` : roundFixing(f) ? `Ø${fmt(f.d)} x ${fmt(f.len)}` : `${fmt(f.d)} x ${fmt(f.w ?? f.d)} x ${fmt(f.len)}`;
        return `${n} / ${size} ${what}`;
      })
      .join(" + ");
  }
  const holes = [...hf.map((i) => H.features[i]), ...gf.map((i) => G.features[i])].filter((f) => f.hole);
  if (holes.length && holesLineUp(H, G, hf, gf)) {
    const d = holes[0].hole!.d;
    const n = hf.map((i) => H.features[i]).filter((f) => f.hole).length;
    return `${n} / Ø${fmt(d)} HOLES, FIXING TBC`;
  }
  // what the model's note says, else to be confirmed
  if ((kind === "groove" || kind === "tongue and groove") && /\bfloat/i.test(note)) return "FLOATING, NO GLUE";
  if (/\bglue/i.test(note) && kind !== "butt" && kind !== "groove") return "GLUED";
  return "FIXING TBC";
}

/* ---------------- grouping into joint types ---------------- */

const LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ".split("");

/** "BOTTOM, SHELF & TOP" */
const andList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} & ${xs[xs.length - 1]}` : (xs[0] ?? ""));

function groupTypes(insts: JointInst[], parts: PartInfo[], marks: Mark[]): { types: JointType[]; buttsOnly: boolean } {
  // the same joint: the same kind and name, the same sizes (to a tenth), the same fixing, and either the same host or
  // the same guest part (aprons and end aprons into a leg, a panel into its stiles, rails and mullion)
  const sizeKey = (j: JointInst) =>
    Object.entries(j.sizes)
      .map(([k, v]) => `${k}=${r1(v)}`)
      .sort()
      .join(",");
  const plain = (j: JointInst) => j.kind === "butt" || j.kind === "screwed" || j.kind === "bolted" || j.kind === "dowelled";
  const sig = (j: JointInst) => `${j.kind}|${j.name}|${sizeKey(j)}|${j.fixNote}|${plain(j) ? (j.faces ?? "") : ""}|${j.what ?? ""}`;
  const parent = insts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const hostMark = (j: JointInst) => parts[j.host].mark;
  const guestMarks = (j: JointInst) => j.guests.map((g) => parts[g].mark).sort((x, y) => x - y).join(",");
  for (let i = 0; i < insts.length; i++)
    for (let j = 0; j < i; j++) {
      const A = insts[i],
        B = insts[j];
      if (sig(A) !== sig(B)) continue;
      if (hostMark(A) !== hostMark(B) && guestMarks(A) !== guestMarks(B)) continue;
      if (!sameEnd(A, B, parts)) continue;
      parent[find(i)] = find(j);
    }
  const groups = new Map<number, JointInst[]>();
  insts.forEach((j, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), j]));
  const list = [...groups.values()];
  // order: joinery first, by host part number then guest; butts last
  const rank = (js: JointInst[]) => (js[0].kind === "butt" ? 1 : 0);
  list.sort((x, y) => rank(x) - rank(y) || hostMark(x[0]) - hostMark(y[0]) || Number(guestMarks(x[0]).split(",")[0]) - Number(guestMarks(y[0]).split(",")[0]) || x[0].index - y[0].index);
  const label = (n: number) => marks[n - 1]?.label ?? String(n);
  const butts = list.filter((g) => g[0].kind === "butt").length;
  const buttsOnly = butts > 6;
  let li = 0;
  const types: JointType[] = list.map((js, ti) => {
    const j = js[0];
    const hostMarks = [...new Set(js.map(hostMark))].sort((x, y) => x - y);
    const guests = [...new Set(js.flatMap((x) => x.guests.map((g) => parts[g].mark)))].sort((x, y) => x - y);
    const fixMarks = [...new Set(js.flatMap((x) => x.fixings.map((f) => f.mark)))].sort((x, y) => x - y);
    const hn = andList(hostMarks.map(label)),
      gn = andList(guests.map(label));
    const title = j.kind === "notch" || j.kind === "birdsmouth" ? `${hn} ${j.kind === "notch" ? "NOTCHED" : "BIRDSMOUTHED"} OVER ${gn}` : j.kind === "halving" && hn === gn ? `${hn} TO ${gn}` : `${gn} TO ${hn}`;
    const butt = j.kind === "butt";
    const letter = butt && buttsOnly ? null : LETTERS[li++ % LETTERS.length];
    for (const x of js) x.type = ti;
    return { index: ti, kind: j.kind, name: j.name, insts: js, hostMarks, guestMarks: guests, fixMarks, title, sizesText: j.sizesText, fixNote: j.fixNote, butt, letter };
  });
  return { types, buttsOnly };
}

/**
 * Two joints near their host's end (their detail shows the end) go together only if they're the same distance from it.
 * Near: within one and a half times the cut's own length that way, or 25 mm.
 */
function sameEnd(A: JointInst, B: JointInst, parts: PartInfo[]) {
  const endOf = (j: JointInst) => {
    if (!j.hostCut) return null;
    const li0 = axisOf(drawAxis(parts[j.host], 0));
    if (li0 >= 0 && j.hostRuns[li0]) return null;
    const h = parts[j.host];
    const box = toModelBox(h, { min: [0, 0, 0], max: [h.L, h.T, h.W] });
    const li = axisOf(drawAxis(h, 0));
    if (li < 0) return null;
    const lo = j.hostCut.min[li] - box.min[li],
      hi = box.max[li] - j.hostCut.max[li];
    const near = Math.max(25, 1.5 * (j.hostCut.max[li] - j.hostCut.min[li]));
    const dist = Math.min(lo, hi);
    return dist <= near ? r1(dist) : null;
  };
  return endOf(A) === endOf(B);
}

/**
 * Whose each joint type is (Stage 19.7), from the model's design record: a joint listed there by the parts it joins
 * (their names or kinds, "apron" and "leg") takes its owner and, where the model has no fixing for it, his words for
 * how it's held ("TOP SCREWED THROUGH BUTTONS"); one not listed is his if he set the whole design, else a suggestion.
 * No record (an older model): nothing is said either way.
 */
export function applyDesign(js: JointSet, design: ModelDesign | undefined, m: ModelPayload, parts: PartInfo[]) {
  if (!design) return;
  const words = (s: string) =>
    s
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/(?<=[A-Z]{3})(ES|S)$/, ""));
  const has = (want: string, name: string) => words(want).every((w) => words(name).includes(w));
  const named = (idx: number[]) => [...new Set(idx.flatMap((i) => [m.parts[i].name, parts[i].label]))];
  for (const t of js.types) {
    const names = named(t.insts.flatMap((j) => j.parts));
    // a record names the parts on both sides of the joint (the rail and the stile it goes into), so a joint type that
    // groups many hosts (a panel's groove in stiles and rails) takes the record for that joint, not one whose parts
    // only happen to be among its hosts (found at the merge, when the source of a suggestion went under it); else the
    // first record whose parts are all in it, as before
    const hosts = named(t.insts.map((j) => j.host)),
      guests = named(t.insts.flatMap((j) => j.guests));
    const inIt = (d: { parts: string[] }) => d.parts.length > 0 && d.parts.every((w) => names.some((n) => has(w, n)));
    const across = (d: { parts: string[] }) => d.parts.length < 2 || (d.parts.some((w) => hosts.some((n) => has(w, n))) && d.parts.some((w) => guests.some((n) => has(w, n))));
    const rec = design.joints?.find((d) => inIt(d) && across(d)) ?? design.joints?.find(inIt);
    t.by = rec?.by ?? (design.by === "owner" ? "owner" : "assistant");
    // the rules its proportions follow, where the record says (a recipe's own, or the assistant's), and its sizes agree
    const rules = (rec?.rules ?? []).filter((id) => JOINT_RULE_IDS.includes(id) && followsRule(id, t, parts) !== false);
    if (rules.length) t.rules = [...new Set(rules)];
    if (rec?.fixing && t.insts.every((j) => !j.fixings.length)) {
      const said = rec.fixing.toUpperCase().slice(0, 40);
      t.fixNote = said;
      for (const j of t.insts) j.fixNote = said;
    }
  }
}

/**
 * Whether a joint type's sizes bear out a proportion rule its record says it follows (connected at the merge of Stages
 * 19 and 20): true or false where the joint's measured sizes can show it, null for a rule they can't (a panel floating,
 * a top on buttons). So the schedule never names a source for a size that doesn't follow it. Within a millimetre (the
 * recipes round to it); a halving's lap within half of one.
 */
export function followsRule(id: string, t: JointType, parts: PartInfo[]): boolean | null {
  const j = t.insts[0];
  const g = parts[j.guests[0]],
    h = parts[j.host];
  const tenon = [j.sizes.inU, j.sizes.inV].filter((x): x is number => x !== undefined).sort((a, b) => a - b)[0];
  switch (id) {
    case "tenon_third":
      return t.kind === "mortise and tenon" && tenon !== undefined && Math.abs(3 * tenon - g.T) <= 3;
    case "bridle_thirds":
      return t.kind === "bridle" && tenon !== undefined && [g.T, h.T].some((T) => Math.abs(3 * tenon - T) <= 3);
    case "halving_half":
      return t.kind === "halving" && j.sizes.len !== undefined && [g.T, h.T].some((T) => Math.abs(2 * j.sizes.len! - T) <= 1);
    case "framing_scarf":
      return t.kind === "scarf" && j.sizes.splice !== undefined && [g.W, g.T].some((d) => j.sizes.splice! >= 4 * d - 1 && j.sizes.splice! <= 5 * d + 1);
    case "glued_scarf":
      return t.kind === "scarf" && j.sizes.slope !== undefined && j.sizes.slope >= 12 - 0.05;
  }
  return null;
}

/** The joint types' count of places, for the schedule. */
export const placesOf = (t: JointType) => t.insts.length;
export { andList as jointAndList, fmt as jointFmt, centre as boxCentre3, sizeOf as boxSize3, boxInter as boxInter3, boxUnion as boxUnion3, grown as boxGrown3, inBox as inBox3 };
