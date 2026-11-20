// A shop drawing set from a model (Stage 12.3). Sheets are laid out from fixed templates, not by a packing search:
//   - a general arrangement: the front, the plan above it and the side to its right (third-angle, in line), a pulled-apart
//     3D view with balloons, and the parts schedule top right (a large frame splits the plan and the elevations);
//   - part views: each different part, its views, "LEG, 4 REQ'D, 1:5", long plain members broken rather than shrunk;
//   - joint details (Stage 19.2, details.ts): every joint type once, a section through it, one at right angles where its
//     shape changes, a pulled-apart 3D view, marked on the general arrangement; a joint schedule; their own sheets;
//   - on every sheet the same right-hand column: numbered notes, the legend, the revisions, a blank checked/approved
//     box, and the title block.
// Everything is in paper millimetres (prims.ts); the PDF, SVG and DXF writers draw it.
import type { ModelMaterial, ModelPayload } from "../protocol.js";
import { applyAdded, type Added } from "./added.js";
import { buildModel, type BuiltModel } from "../model3d/build.js";
import { type Box3, type V3, apply, dot, emptyBox, grow, invert } from "../model3d/math.js";
import { solidPolys } from "../model3d/solids.js";
import { ISO, VIEWS, type ViewDir, type ViewLines, drawSection, drawView, partEdges, prepare, viewFrom } from "./hlr.js";
import { type Feature, type Mark, type PartInfo, analyseParts } from "./parts.js";
import { type JointInst, type JointSet, type JointType, applyDesign, findAllJoints } from "./joints.js";
import { scheduleLabel } from "../model3d/designRules.js";
import { type ExtraView, type JointDetail, type MarkerPlan, FROM, detailPages, detailedFeatures, hatchStyles, jointBetween, jointMarkers, jointSchedule, jointVariants, partsNamed, planJointDetails, planMarkers, planOne } from "./details.js";
import { type DimSpec, type Extent, Occupied, bestSide, leaderNote, placeDim } from "./dims.js";
import { type Box, DASH, type DimMeta, type P2, type Prim, type Sheet, type SheetMeta, TH, type Text, type ViewMeta, W, mm, segHitsBox, textBox, textWidth, wrap } from "./prims.js";
import { type Break, type HatchStyle, type Placement, SCALES, balloon, breakSymbol, drawLines, hatchFor, hatchLines, projectionSymbol, scaleBar, sectionMarker, text, toPage, viewTitle } from "./render.js";

export type Status = "PRELIMINARY" | "FOR APPROVAL" | "FOR CONSTRUCTION";
export type Revision = { rev: string; date: string; text: string; by: string };

export type SetInput = {
  model: ModelPayload;
  title: string;
  number: string;
  revision: string;
  status: Status;
  revisions: Revision[];
  /** The business, if the owner has put one on (12.10): nothing is filled in for him; without it the project leads. */
  company?: string;
  companyLine?: string;
  project: string;
  client: string;
  drawn: string;
  checked?: string;
  date: string;
  /** Extra numbered notes (e.g. a span table a size came from). */
  notes?: string[];
  finish?: string;
  /** What parts are made of, as the owner said it: by part name or label, kind ("hardwood", "ply") or "all". */
  materials?: Record<string, string>;
  /** Views he asked for (19.3), kept with the drawing: sections, details, a detail bigger, 3D views. */
  views?: ExtraView[];
  additions?: Added[];
  /** Room is kept for a logo in the title block (the PDF writer puts it there). */
  logo?: boolean;
};

/** extras: each view he asked for, what it's called on the drawing ("Section D-D", "Detail F") and the sheet it's on. */
export type DrawingSet = { model: ModelPayload; sheets: Sheet[]; parts: PartInfo[]; marks: Mark[]; built: BuiltModel; ms: number; logoAt: [number, number, number, number]; joints: JointSet; details: JointDetail[]; extras: { id: string; label: string; sheet: number }[] };

/* ---------------- the page ---------------- */

export const FRAME: Box = [20, 10, 410, 287];
export const COL_X = 318; // the right-hand column
export const AREA: Box = [26, 24, COL_X - 6, 281]; // where views go (the strip below holds the scale bar)

/** Section letters skip I, O and Q. */
const LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ".split("");

export const MATERIAL: Record<ModelMaterial, string> = { pine: "PINE", hardwood: "HARDWOOD", oak: "OAK", walnut: "WALNUT", ply: "PLYWOOD", mdf: "MDF", steel: "STEEL", concrete: "CONCRETE", plain: "TBC" };

/**
 * What a part is made of, as the owner said it ("TAS OAK, DAR", "MGP10 H3 PINE"), matched by the part's own name or
 * label, a word of its name, its kind from the model, or "all"; not said, TBC (12.10: never the model's "HARDWOOD").
 */
export function materialOf(materials: Record<string, string> | undefined, p: { label: string; name: string; material: ModelMaterial }): string {
  if (!materials) return "TBC";
  const norm = (x: string) => x.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const one = (x: string) => x.replace(/(?<=[A-Z]{3})(ES|S)$/, "");
  const es = Object.entries(materials)
    .map(([k, v]) => [norm(k), v.trim().replace(/\s+/g, " ").toUpperCase()] as const)
    .filter(([, v]) => v);
  const label = norm(p.label),
    name = norm(p.name),
    words = name.split(" ").map(one);
  const kinds: Record<string, string[]> = { ply: ["PLY", "PLYWOOD"], mdf: ["MDF"], steel: ["STEEL", "METAL"], hardwood: ["HARDWOOD", "TIMBER"], pine: ["PINE", "SOFTWOOD", "TIMBER"], oak: ["OAK", "TIMBER"], walnut: ["WALNUT", "TIMBER"], concrete: ["CONCRETE"], plain: [] };
  return (
    es.find(([k]) => k === label || one(k) === label || k === name)?.[1] ??
    es.find(([k]) => k.split(" ").map(one).every((w) => words.includes(w)))?.[1] ??
    es.find(([k]) => kinds[p.material]?.includes(k))?.[1] ??
    es.find(([k]) => ["ALL", "EVERYTHING", "REST", "THE REST", "OTHERS"].includes(k) || k === "")?.[1] ??
    "TBC"
  );
}

/** Boards with no grain to show: melamine and laminate faced, MDF and particleboard (a veneered one has grain). */
const grainless = (spec: string) => /MELAMINE|LAMINATE|\bMDF\b|PARTICLE|HMR|LAMINEX|FORMICA/.test(spec) && !/VENEER/.test(spec);

import { type Block, type ViewBuild, Space, addPrims, blockH, blockW, clipLines, dimRoom, emptyBlock, gapHatch, growBox, key, merge, moveBlock, mvBox, paperSize, placeLeaders, placeView, primBox, r1, reserve, titleUnder } from "./blocks.js";

/* ---------------- what the parts are ---------------- */

/** The drawing axes of a part as model directions: X (length), Y (thickness), Z (width). */
const axesOf = (p: PartInfo): V3[] => [0, 1, 2].map((i) => [p.modelToDraw.r[i * 3], p.modelToDraw.r[i * 3 + 1], p.modelToDraw.r[i * 3 + 2]] as V3);

/**
 * A feature's kind as its joint names it (19.2): a cut in a lap is a LAP, a recess a shelf's end is housed in is a
 * HOUSING whatever its shape is called on its own (a square post's second face reads as a notch). Else its own kind.
 */
type WorkKind = Feature["kind"] | "lap" | "scarf";
function kindIn(ctx: Ctx | null, p: PartInfo, i: number): WorkKind {
  const f = p.features[i];
  const letter = ctx?.jfeats.get(p.index)?.get(i);
  const t = letter ? ctx!.joints.types.find((x) => x.letter === letter) : undefined;
  if (t?.kind === "halving" && !f.hole) return "lap";
  // a scarf's cuts are its scarf, whatever shape each is (19.8)
  if (t?.kind === "scarf" && !f.hole) return "scarf";
  if (t?.kind === "housing" && (f.kind === "notch" || f.kind === "mortise" || f.kind === "pocket")) return "housing";
  return f.kind;
}

/** A short description of a part's work for the schedule ("2 MORTISES", "TENON BOTH ENDS", "4 HOLES Ø12"). */
function workNote(p: PartInfo, ctx: Ctx | null = null): string {
  const out: string[] = [];
  const count = (k: WorkKind) => p.features.filter((_, i) => kindIn(ctx, p, i) === k).length;
  const ends = new Set(p.features.filter((f, i) => f.kind === "tenon" && kindIn(ctx, p, i) === "tenon").map((f) => (f.lo[0] ? "a" : "b")));
  if (ends.size) out.push(ends.size === 2 ? "TENON BOTH ENDS" : "TENON ONE END");
  // a scarf at an end (or both), its cuts reaching that end
  const scarfEnds = new Set(p.features.filter((f, i) => kindIn(ctx, p, i) === "scarf").map((f) => (f.lo[0] ? "a" : f.hi[0] ? "b" : "m")));
  if (scarfEnds.size) out.push(scarfEnds.has("a") && scarfEnds.has("b") ? "SCARF BOTH ENDS" : "SCARF ONE END");
  for (const [k, one, many] of [
    ["mortise", "MORTISE", "MORTISES"],
    ["slot", "SLOT", "SLOTS"],
    ["housing", "HOUSING", "HOUSINGS"],
    ["rebate", "REBATE", "REBATES"],
    ["groove", "GROOVE", "GROOVES"],
    ["notch", "NOTCH", "NOTCHES"],
    ["lap", "LAP", "LAPS"],
    ["pocket", "POCKET", "POCKETS"],
  ] as const) {
    const n = count(k);
    if (n) out.push(n === 1 ? one : `${n} ${many}`);
  }
  const byD = new Map<number, number>();
  for (const h of p.features.filter((f) => f.hole)) byD.set(h.hole!.d, (byD.get(h.hole!.d) ?? 0) + 1);
  for (const [d, n] of byD) out.push(`${n === 1 ? "HOLE" : `${n} HOLES`} Ø${mm(d)}`);
  return out.join(", ");
}

/** Stations a feature gives along a drawing axis: its two sides (a hole's sides only along its own axis). */
function stationsOf(f: Feature, axis: number): number[] {
  if (f.hole && f.hole.axis !== axis) return [];
  return [f.box.min[axis], f.box.max[axis]];
}

/** A chain: the part's two faces and the stations between, deduped; keys per segment. Null if nothing between. */
function chainSpec(frame: string, axisName: string, size: number, stations: number[], side: DimSpec["side"], tier: number, feet?: Map<number, number>): DimSpec | null {
  const s = [...new Set([0, size, ...stations].map((v) => Math.round(v * 1000) / 1000))].filter((v) => v >= -1e-6 && v <= size + 1e-6).sort((a, b) => a - b);
  if (s.length <= 2) return null;
  const keys: string[] = [];
  for (let i = 0; i + 1 < s.length; i++) keys.push(key(frame, axisName, s[i], s[i + 1]));
  return { side, stations: s, keys, total: size, tier, ...(feet ? { feet: s.map((x) => feet.get(Math.round(x * 1000) / 1000)) } : {}) };
}

/**
 * A part view's chain along the part, with what a joint detail gives (19.2.7) in brackets: a segment that is a detailed
 * feature's own extent (a tenon's length, a housing's width), or a size the detail gives. When all that's left is the
 * rest of the part from one end of them, the chain goes: the overall and "SEE DETAIL" say it.
 */
function withRefs(ctx: Ctx, p: PartInfo, chain: DimSpec | null, jf: Map<number, string>): DimSpec | null {
  if (!chain) return null;
  const frame = `part${p.mark}`;
  const axis = chain.keys[0]?.split(":")[1] ?? "x";
  const fr = chain.keys[0]?.split(":")[0] ?? frame;
  const ext = p.features.flatMap((f, i) => (jf.has(i) ? [[Math.min(f.box.min[0], f.box.max[0]), Math.max(f.box.min[0], f.box.max[0])] as [number, number]] : []));
  const st = [...chain.stations].sort((a, b) => a - b);
  const refs: [number, number][] = [];
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i],
      b = st[i + 1];
    // (inside a detailed cut: a tenon's length, its haunch, at either end; the detail gives it)
    if (ext.some(([x, y]) => a >= x - 0.05 && b <= y + 0.05) || ctx.jkeys.has(key(frame, "x", a, b))) refs.push([a, b]);
  }
  if (!refs.length) return { ...chain, keyFn: (a, b) => key(fr, axis, a, b) };
  const real = st.length - 1 - refs.length;
  const fromEnd = (end: number) => {
    // the refs run on from one end with nothing between: the first k segments all refs, the rest one segment
    let k = 0;
    const seg = (i: number) => (end === 0 ? [st[i], st[i + 1]] : [st[st.length - 2 - i], st[st.length - 1 - i]]);
    while (k < st.length - 1 && refs.some(([x, y]) => Math.abs(x - seg(k)[0]) < 0.05 && Math.abs(y - seg(k)[1]) < 0.05)) k++;
    return k === refs.length;
  };
  if (real <= 1 && (fromEnd(0) || fromEnd(1))) return null;
  return { ...chain, refSegs: refs, keyFn: (a, b) => key(fr, axis, a, b) };
}

/* ---------------- context ---------------- */

type Detail = {
  letter: string;
  count: number;
  plane: { n: V3; w: number };
  up: V3;
  at: V3;
  halfSpan: number;
  marks: number[];
  window: Box3;
  title: string;
};

type Ctx = {
  m: ModelPayload;
  built: BuiltModel;
  parts: PartInfo[];
  marks: Mark[];
  joints: JointSet;
  bbox: Box3;
  /** Sections he asked for (19.3), marked on the arrangement with cutting lines. */
  details: Detail[];
  /** The joint details (19.2), marked on the arrangement with bubbles; where each part's features are detailed; the
   *  sizes the details give (part frames), and each detailed feature's extent, so a part view brackets them. */
  jds: JointDetail[];
  jfeats: Map<number, Map<number, string>>;
  jkeys: Set<string>;
  markerPlan?: MarkerPlan;
  /** The pulled-apart views' sub-assemblies (19.4): the whole piece, or the carcass, the drawers... */
  subs?: Sub[];
  keepHidden: (part: number, a: V3, b: V3) => boolean;
  cache: Map<string, ViewLines>;
  gaFirst?: GAName[];
  markerOn?: Map<string, GAName>;
  spec: (p: PartInfo) => string;
  code: Map<string, string>;
};
/** Linework doesn't depend on the scale: worked out once per view. */
const cached = (ctx: Ctx, key: string, make: () => ViewLines) => ctx.cache.get(key) ?? (ctx.cache.set(key, make()), ctx.cache.get(key)!);

/** Edges along a part's stock outline may show hidden on a general arrangement; joinery edges only where seen. */
function stockEdges(m: ModelPayload, built: BuiltModel) {
  const info = built.parts.map((bp, i) => {
    const st = m.parts[i].stock;
    if (st.type !== "box") return null;
    const b = emptyBox();
    for (const p of solidPolys(st)) for (const v of p.v) grow(b, v);
    return { inv: invert(bp.frame), b };
  });
  return (part: number, a: V3, c: V3) => {
    const s = info[part];
    if (!s) return false; // a bolt or a peg inside something: not on the arrangement
    const A = apply(s.inv, a),
      C = apply(s.inv, c);
    const on = (p: V3) => [0, 1, 2].filter((i) => Math.abs(p[i] - s.b.min[i]) < 1e-3 || Math.abs(p[i] - s.b.max[i]) < 1e-3);
    const oa = on(A),
      oc = on(C);
    // both ends on the same two faces of the stock: it runs along one of its edges
    return oa.filter((i) => oc.includes(i) && Math.abs(A[i] - C[i]) < 1e-3).length >= 2;
  };
}

const upright = (p: PartInfo) => Math.abs(axesOf(p)[0][2]) > 0.99;

/** Drop middle stations that would make a segment exactly one part's own size that way (it's on the part's view). */
function dropPartSizes(st: number[], axis: number, ctx: Ctx): number[] {
  let s = [...new Set(st.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
  const sizes = ctx.parts.filter((p) => ctx.built.parts[p.index].polys.length).map((p) => [ctx.built.parts[p.index].bbox.min[axis], ctx.built.parts[p.index].bbox.max[axis]]);
  for (let guard = 0; guard < 20; guard++) {
    let changed = false;
    for (let i = 0; i + 1 < s.length; i++) {
      if (!sizes.some(([a, b]) => Math.abs(a - s[i]) < 0.05 && Math.abs(b - s[i + 1]) < 0.05)) continue;
      const drop = i + 1 < s.length - 1 ? i + 1 : i > 0 ? i : -1;
      if (drop < 0) continue;
      s = s.filter((_, k) => k !== drop);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return s;
}

/* ---------------- the general arrangement ---------------- */

type GAName = "front" | "top" | "side";

/** The arrangement's sizes: overall length, height and depth once each, and set-out chains from a datum. */
function gaDims(ctx: Ctx, have: Record<GAName, ViewLines | undefined>, all: GAName[], scale = 1): Record<GAName, DimSpec[]> {
  const b = ctx.bbox;
  const live = ctx.parts.filter((p) => ctx.built.parts[p.index].polys.length);
  const pb = (p: PartInfo) => ctx.built.parts[p.index].bbox;
  const ups = live.filter(upright);
  const across = live.filter((p) => !upright(p));
  const faces = (axis: number) => {
    if (ups.length < 2) return [];
    return [Math.min(...ups.map((p) => pb(p).min[axis])), Math.max(...ups.map((p) => pb(p).max[axis]))];
  };
  const out: Record<GAName, DimSpec[]> = { front: [], top: [], side: [] };
  const overall = (axis: number, name: string, side: DimSpec["side"], tier: number): DimSpec => ({ side, stations: [b.min[axis], b.max[axis]], keys: [key("asm", name, b.min[axis], b.max[axis])], overall: true, total: b.max[axis] - b.min[axis], tier, flex: side === "right" });
  const chain = (axis: number, name: string, st: number[], side: DimSpec["side"]): DimSpec | null => {
    // (a set-out step under 3 on paper isn't for the arrangement: a door's 5 gap at 1:10 is left to the parts, 12.10)
    const s0 = dropPartSizes([b.min[axis], b.max[axis], ...st], axis, ctx);
    const s = s0.filter((x, i) => i === 0 || i === s0.length - 1 || (x - s0[i - 1] >= 3 * scale && s0[s0.length - 1] - x >= 3 * scale));
    if (s.length <= 2) return null;
    const keys: string[] = [];
    for (let i = 0; i + 1 < s.length; i++) keys.push(key("asm", name, s[i], s[i + 1]));
    return { side, stations: s, keys, total: b.max[axis] - b.min[axis], tier: 0, flex: side === "right" };
  };
  // The plan carries the overall length and depth when it's on the arrangement sheet (12.10): the elevations keep their
  // set-out chains (a chain adds up to the overall on the plan) and the height. With the plan on a later sheet the
  // elevations carry the overalls and the plan has them again in brackets, for reference.
  const first = ctx.gaFirst ?? all;
  // (whichever views this block has: the plan on the arrangement sheet decides it for the views on later sheets too)
  const planHere = first.includes("top");
  const planLater = !planHere && all.includes("top");
  const sideHere = first.includes("side");
  const yc = chain(1, "y", faces(1), "below");
  if (have.front) {
    const fx = chain(0, "x", faces(0), "below");
    if (fx) out.front.push(fx);
    if (!planHere) out.front.push(overall(0, "x", "below", fx ? 1 : 0));
    const fz = chain(2, "z", across.map((p) => pb(p).min[2]).filter((z) => z > b.min[2] + 1), "left");
    out.front.push(...(fz ? [fz] : []), overall(2, "z", "left", fz ? 1 : 0));
  }
  if (planHere) {
    // the depth's set-out on the side view if there's one, else on the plan with the overall; the overall on the
    // plan's left when the side view is beside the front (the space right of the plan is the 3D view's)
    const ycOnSide = !!yc && all.includes("side");
    if (yc && ycOnSide && have.side) out.side.push(yc);
    if (have.top) {
      if (yc && !ycOnSide) out.top.push({ ...yc, side: "right" as const });
      out.top.push({ ...overall(1, "y", sideHere ? "left" : "right", yc && !ycOnSide ? 1 : 0), flex: false });
    }
  } else {
    // depth, once in the set: on the side view on the arrangement sheet if it's there, else the plan, else the side view
    const depthOn: GAName = first.includes("side") ? "side" : first.includes("top") ? "top" : all.includes("side") ? "side" : "top";
    if (depthOn === "side" && have.side) out.side.push(...(yc ? [yc] : []), overall(1, "y", "below", yc ? 1 : 0));
    if (depthOn === "top" && have.top) {
      const ty = yc ? { ...yc, side: "right" as const } : null;
      out.top.push(...(ty ? [ty] : []), overall(1, "y", "right", ty ? 1 : 0));
    }
    if (planLater && have.top) {
      out.top.push({ ...overall(0, "x", "above", 1), ref: true, keys: [`ref:${key("asm", "x", b.min[0], b.max[0])}`] });
      if (depthOn !== "top") out.top.push({ ...overall(1, "y", "right", 0), ref: true, keys: [`ref:${key("asm", "y", b.min[1], b.max[1])}`] });
    }
  }
  // a row of three or more of the same lying part across x: their centres, above the plan
  if (have.top)
    for (const mk of ctx.marks) {
      const ps = mk.parts.map((i) => ctx.parts[i]).filter((p) => !upright(p));
      // (seen from above: on top of the rest, like rafters, not inside under a top like drawer sides)
      if (ps.length < 3 || Math.abs(axesOf(ps[0])[0][0]) > 0.5 || ps.some((p) => pb(p).max[2] < b.max[2] - 1)) continue;
      const cs = ps.map((p) => (pb(p).min[0] + pb(p).max[0]) / 2).sort((a, c) => a - c);
      const st = [b.min[0], ...cs, b.max[0]];
      const keys = st.slice(0, -1).map((s, i) => key(`asm-c${mk.mark}`, "x", s, st[i + 1]));
      const feet = st.map((s) => (cs.includes(s) ? Math.max(...ps.map((p) => pb(p).max[1])) : undefined));
      out.top.push({ side: "above", stations: st, keys, total: b.max[0] - b.min[0], tier: 0, feet });
      break;
    }
  if (planHere && have.top) out.top.push(overall(0, "x", "above", out.top.some((d) => d.side === "above") ? 1 : 0));
  return out;
}

/** Which of a block's views each section marker goes on: the usual one, unless another marker already crowds that spot
 *  there and another view in the block shows the plane edge on too (a pergola's two joints at one corner at 1:50). */
function markerViews(ctx: Ctx, which: GAName[], scale: number, dirs: Record<GAName, ViewDir>): Map<string, GAName> {
  const out = new Map<string, GAName>();
  const spots: { view: GAName; box: Box }[] = [];
  const k = 1 / scale;
  for (const d of ctx.details) {
    const n = d.plane.n;
    const prefs: GAName[] = Math.abs(n[1]) > 0.9 ? ["top", "side"] : Math.abs(n[0]) > 0.9 ? ["front", "top"] : ["front", "side"];
    const here = prefs.filter((v) => which.includes(v));
    if (!here.length) continue;
    // the marker's footprint on paper: its line, the arrows (7) and the letters past them
    const foot = (v: GAName): Box => {
      const dir = dirs[v];
      const P = (p: V3): P2 => [dot(p, dir.right) * k, dot(p, dir.up) * k];
      const along = Math.abs(dot(n, dir.up)) > 0.9 ? dir.right : dir.up;
      const half = d.halfSpan + 4 / k;
      const a = P([d.at[0] - along[0] * half, d.at[1] - along[1] * half, d.at[2] - along[2] * half]);
      const e = P([d.at[0] + along[0] * half, d.at[1] + along[1] * half, d.at[2] + along[2] * half]);
      const ar: P2 = [-dot(n, dir.right) * 12, -dot(n, dir.up) * 12];
      const xs = [a[0], e[0], a[0] + ar[0], e[0] + ar[0]],
        ys = [a[1], e[1], a[1] + ar[1], e[1] + ar[1]];
      return [Math.min(...xs) - 3, Math.min(...ys) - 3, Math.max(...xs) + 3, Math.max(...ys) + 3];
    };
    const clash = (v: GAName) => spots.some((s) => s.view === v && s.box[0] < foot(v)[2] && foot(v)[0] < s.box[2] && s.box[1] < foot(v)[3] && foot(v)[1] < s.box[3]);
    const v = here.find((x) => !clash(x)) ?? here[0];
    out.set(d.letter, v);
    spots.push({ view: v, box: foot(v) });
  }
  return out;
}

/** Section markers for the details, on whichever of these views shows each plane edge on. */
function markersFor(ctx: Ctx, view: GAName, dir: ViewDir, pl: Placement, taken: Set<string>, occ: Occupied, again?: string[]): { prims: Prim[]; letters: string[] } {
  const prims: Prim[] = [];
  const letters: string[] = [];
  for (const d of ctx.details) {
    if (again ? !again.includes(d.letter) : taken.has(d.letter)) continue;
    const n = d.plane.n;
    const want: GAName = ctx.markerOn?.get(d.letter) ?? (Math.abs(n[1]) > 0.9 ? "top" : "front");
    if (want !== view) continue;
    const P = (p: V3) => toPage(pl, [dot(p, dir.right), dot(p, dir.up)]);
    const along = Math.abs(dot(n, dir.up)) > 0.9 ? dir.right : dir.up;
    const half = d.halfSpan + 4 / pl.k;
    const c = d.at;
    const a = P([c[0] - along[0] * half, c[1] - along[1] * half, c[2] - along[2] * half]);
    const e = P([c[0] + along[0] * half, c[1] + along[1] * half, c[2] + along[2] * half]);
    const mk = sectionMarker(a, e, [-dot(n, dir.right), -dot(n, dir.up)], d.letter, pl.view, (box) => occ.free(box));
    // the next marker's letters keep clear of this one
    occ.addPrims(mk);
    prims.push(...mk);
    letters.push(d.letter);
    taken.add(d.letter);
  }
  return { prims, letters };
}

/** Some of front, plan above it and side to its right, in projection, at one scale. */
function orthoBlock(ctx: Ctx, scale: number, which: GAName[], taken: Set<string>, all: GAName[] = which): Block {
  let prep: ReturnType<typeof prepare> | null = null;
  // the arrangement's views are G1 to G3 (and the 3D view G4): numbers are part numbers, letters are sections
  const ids: Record<GAName, string> = { front: "G1", top: "G2", side: "G3" };
  const dirs: Record<GAName, ViewDir> = { front: VIEWS.front, top: VIEWS.top, side: VIEWS.right };
  const titles: Record<GAName, string> = { front: "FRONT ELEVATION", top: "PLAN", side: "SIDE ELEVATION" };
  const lines: Record<GAName, ViewLines | undefined> = { front: undefined, top: undefined, side: undefined };
  // each joint type marked once, at the place and on the view that shows it best (19.2.4)
  const mplan = planMarkers(ctx, ctx.jds.filter((d) => !taken.has(d.letter)), which.map((w) => ({ name: w, dir: dirs[w] })), scale);
  // the hidden lines that explain something (19.4): a part's outline where none of it is seen from that side, and the
  // joint's outline where it's marked; not the hidden parts of what's partly in view, nor other joinery
  const jointEdge = (w: GAName) => {
    // (a compact joint: a tenon in a leg; not a groove or a housing running the length of a part, whose marker sits on what's seen)
    const compact = (j: JointInst) => {
      const e = [0, 1, 2].map((i) => j.region.max[i] - j.region.min[i]).sort((x, y) => x - y);
      return e[2] <= Math.max(300, 3 * e[1]);
    };
    const here = [...mplan.entries()].filter(([, p]) => p.view === w && compact(p.inst)).map(([, p]) => p.inst);
    return (part: number, a: V3, b: V3) => here.some((j) => j.parts.includes(part) && [a, b].every((q) => [0, 1, 2].every((i) => q[i] >= j.region.min[i] - 0.5 && q[i] <= j.region.max[i] + 0.5)));
  };
  const sig = (w: GAName) => [...mplan.entries()].filter(([, p]) => p.view === w).map(([l, p]) => `${l}${p.inst.index}`).join(",");
  for (const w of which) {
    const je = jointEdge(w);
    lines[w] = cached(ctx, `ga-${w}-${sig(w)}`, () => drawView((prep ??= prepare(ctx.built)), dirs[w], { hidden: true, keepHidden: (p, a, b) => ctx.keepHidden(p, a, b) || je(p, a, b), sparseHidden: true, jointEdge: je }));
  }
  const dims = gaDims(ctx, lines, all, scale);
  ctx.markerOn = markerViews(ctx, which, scale, dirs);
  const vb = (w: GAName): ViewBuild => ({ id: ids[w], lines: lines[w]!, min: lines[w]!.min, max: lines[w]!.max, scale, dims: dims[w], kind: "ga", title: titles[w] });
  const b = emptyBlock();
  const occ = new Occupied();
  const titleRoom = 15;
  const place = (w: GAName, x: number, y: number) => {
    let letters: string[] = [];
    let jspots: { letter: string; at: P2; r: number }[] = [];
    let jprims: Prim[] = [];
    const pb = placeView(vb(w), x, y, occ, (pl, o, again) => {
      const r = markersFor(ctx, w, dirs[w], pl, taken, o, again ? letters : undefined);
      letters = r.letters;
      // (a section letter moved for a size's lines: the joint markers stay where they were)
      if (again) return [...r.prims, ...jprims];
      const lw = lines[w]!;
      const vbox: Box = [pl.ox + lw.min[0] * pl.k, pl.oy + lw.min[1] * pl.k, pl.ox + lw.max[0] * pl.k, pl.oy + lw.max[1] * pl.k];
      const j = jointMarkers(ctx, ctx.jds, mplan, w, dirs[w], pl, o, taken, vbox);
      jspots = j.spots;
      jprims = j.prims;
      return [...r.prims, ...j.prims];
    });
    for (const l of letters) pb.markers.push({ letter: l, view: ids[w] });
    for (const sp of jspots) pb.markers.push({ letter: sp.letter, view: ids[w], at: sp.at, r: sp.r });
    return pb;
  };
  // the anchor view: the front if it's here, else the plan, else the side
  const first: GAName = which.includes("front") ? "front" : which.includes("top") ? "top" : "side";
  const fv = vb(first);
  const fs = paperSize(fv),
    fr = dimRoom(fv);
  const fb = place(first, 0, 0);
  merge(b, fb);
  if (first === "front" && which.includes("top")) {
    const tv = vb("top");
    // above everything the front has (its sizes, a section marker), with room for the plan's title between
    const y = Math.max(fs[1] + fr.above, fb.box[3]) + dimRoom(tv).below + titleRoom + 6;
    const tb = place("top", 0, y);
    tb.views[0].aligned = [{ with: fv.id, axis: "x", at: tb.views[0].ox, other: fb.views[0].ox }];
    merge(b, tb);
  }
  if (first === "front" && which.includes("side")) {
    const sv = vb("side");
    let x = fs[0] + fr.right + dimRoom(sv).left + 18;
    const keep = { texts: occ.texts.length, lines: occ.lines.length, taken: new Set(taken) };
    let sb = place("side", x, 0);
    // a value set past the front's last station and one before the side's first mustn't read as a pair: 8 between
    const boxes = (bl: Block) => bl.prims.flatMap((p) => (p.t === "text" ? [textBox(p)] : []));
    const fbx = boxes(fb);
    let gap = Infinity;
    for (const a of fbx) for (const c of boxes(sb)) if (a[1] < c[3] && c[1] < a[3] && c[0] >= a[2]) gap = Math.min(gap, c[0] - a[2]);
    if (gap < 8) {
      occ.texts.length = keep.texts;
      occ.lines.length = keep.lines;
      taken.clear();
      keep.taken.forEach((l) => taken.add(l));
      x += 8 - gap;
      sb = place("side", x, 0);
    }
    sb.views[0].aligned = [{ with: fv.id, axis: "y", at: sb.views[0].oy, other: fb.views[0].oy }];
    merge(b, sb);
  }
  for (const w of which) titleUnder(b, b.views.find((v) => v.id === ids[w])!, ids[w], titles[w], scale);
  return b;
}

/**
 * A pulled-apart view's parts (Stage 19.4): the whole piece, or, when that would carry more than eight part numbers, a
 * sub-assembly (the carcass with its doors, a drawer), each with its own view, in the order they go together.
 */
type Sub = { id: string; title: string; parts: Set<number>; qty: number };

/**
 * The sub-assemblies, when one pulled-apart view would have more than eight part numbers: parts held together by joints
 * are one assembly; the biggest is the main one (a carcass); assemblies made of the same parts (two drawers) are one
 * view, "2 REQ'D"; a part on its own (a door) goes with the main one while it has room, else with others like it.
 */
function subAssemblies(ctx: Ctx): Sub[] {
  const live = ctx.parts.filter((p) => ctx.built.parts[p.index].polys.length).map((p) => p.index);
  const all: Sub = { id: "G4", title: "EXPLODED VIEW", parts: new Set(live), qty: 1 };
  if (ctx.marks.length <= 8) return [all];
  const parent = new Map<number, number>(live.map((i) => [i, i]));
  const find = (i: number): number => (parent.get(i) === i ? i : (parent.set(i, find(parent.get(i)!)), parent.get(i)!));
  for (const j of ctx.joints.insts) for (const p of j.parts.slice(1)) parent.set(find(p), find(j.parts[0]));
  const comps = new Map<number, number[]>();
  for (const i of live) comps.set(find(i), [...(comps.get(find(i)) ?? []), i]);
  const list = [...comps.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
  const marksOf = (ps: number[]) => [...new Set(ps.map((i) => ctx.parts[i].mark))].sort((x, y) => x - y);
  const main = list[0];
  const singles = list.slice(1).filter((c) => c.length === 1);
  const groups = new Map<string, number[][]>();
  for (const c of list.slice(1).filter((c) => c.length > 1)) groups.set(marksOf(c).join(","), [...(groups.get(marksOf(c).join(",")) ?? []), c]);
  const mainParts = new Set(main);
  const leftover: number[] = [];
  for (const c of singles) {
    const ms = new Set([...marksOf([...mainParts]), ...marksOf(c)]);
    if (ms.size <= 8) c.forEach((i) => mainParts.add(i));
    else leftover.push(...c);
  }
  const words = (ps: number[]) => {
    const labels = marksOf(ps).map((m) => ctx.marks[m - 1].label);
    const first = labels.map((l) => l.split(" ")[0]);
    return first.every((w) => w === first[0]) ? first[0] : (ctx.marks[marksOf(ps)[0] - 1]?.label ?? "PARTS");
  };
  const cabinetry = [...mainParts].some((i) => /\b(SIDE|END|TOP|BOTTOM|BACK|SHELF|DIVIDER|KICK|PLINTH)\b/.test(ctx.parts[i].label));
  const out: Sub[] = [{ id: "G4", title: `EXPLODED VIEW, ${cabinetry ? "CARCASS" : "FRAME"}`, parts: mainParts, qty: 1 }];
  let n = 5;
  for (const cs of groups.values()) out.push({ id: `G${n++}`, title: `EXPLODED VIEW, ${words(cs[0])}${cs.length > 1 ? `, ${cs.length} REQ'D` : ""}`, parts: new Set(cs[0]), qty: cs.length });
  if (leftover.length) out.push({ id: `G${n++}`, title: `EXPLODED VIEW, ${words(leftover)}`, parts: new Set(leftover), qty: 1 });
  return out;
}

/** The pulled-apart 3D view with a balloon for each part number (one each), leaders out to tidy rows. */
function isoBlock(ctx: Ctx, scale: number, ringSides: "all" | "tb" | "lr" = "all", spread = 1, pad = 9, sub?: Sub): Block {
  const sb = sub ?? (ctx.subs ??= subAssemblies(ctx))[0];
  const shift = new Map<number, V3>();
  // a sub-assembly pulls apart about itself (a drawer's parts relative to the drawer)
  const mine = [...sb.parts];
  const mean = [0, 1, 2].map((k) => (sb.id === "G4" ? 0 : mine.reduce((t, i) => t + ctx.built.parts[i].apart[k], 0) / mine.length));
  ctx.built.parts.forEach((p, i) => shift.set(i, [(p.apart[0] - mean[0]) * spread, (p.apart[1] - mean[1]) * spread, (p.apart[2] - mean[2]) * spread]));
  const subBuilt: BuiltModel = sb.parts.size === ctx.built.parts.length ? ctx.built : { ...ctx.built, parts: ctx.built.parts.map((p, i) => (sb.parts.has(i) ? p : { ...p, polys: [] })) };
  const lines = cached(ctx, `iso-${spread}-${sb.id}`, () => drawView(prepare(subBuilt, shift), ISO, { hidden: false }));
  const v: ViewBuild = { id: sb.id, lines, min: lines.min, max: lines.max, scale, dims: [], kind: "iso", title: sb.title };
  const b = placeView(v, 0, 0, new Occupied());
  const vm = b.views[0];
  const pl: Placement = { ox: vm.ox, oy: vm.oy, k: vm.k, view: sb.id };
  // an anchor for each part number: on the instance nearest the outside of the view (a short leader, 12.10), the middle
  // of its longest visible edge, among the instances seen at least half as well as the best-seen one
  const anchors: { mark: number; at: P2 }[] = [];
  const out = (q: P2) => Math.min(q[0] - vm.box[0], vm.box[2] - q[0], q[1] - vm.box[1], vm.box[3] - q[1]);
  for (const mk of ctx.marks) {
    const seen: { len: number; at: P2 }[] = [];
    for (const pi of mk.parts.filter((i) => sb.parts.has(i))) {
      let best: { len: number; at: P2 } | null = null;
      for (const c of lines.chains) {
        if (c.part !== pi || c.kind !== "visible") continue;
        const n = c.pts.length;
        for (let i = 0; i + 1 < n + (c.closed ? 1 : 0); i++) {
          const a = c.pts[i],
            e = c.pts[(i + 1) % n];
          const len = Math.hypot(e[0] - a[0], e[1] - a[1]);
          if (!best || len > best.len) best = { len, at: [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2] };
        }
      }
      if (best) seen.push({ len: best.len, at: toPage(pl, best.at) });
    }
    if (!seen.length) continue;
    const top = Math.max(...seen.map((x) => x.len));
    const pick = seen.filter((x) => x.len >= top * 0.5).sort((a, c) => out(a.at) - out(c.at))[0];
    anchors.push({ mark: mk.mark, at: pick.at });
  }
  // balloons in rows on the nearest side of a frame round the view, spaced 9 apart, so the leaders don't cross
  const box = vm.box;
  const ring: Box = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
  const sides: Record<string, { mark: number; at: P2; pos: number }[]> = { l: [], r: [], t: [], b: [] };
  const cx = (box[0] + box[2]) / 2,
    cy = (box[1] + box[3]) / 2;
  for (const a of anchors) {
    const dx = (a.at[0] - cx) / (box[2] - box[0] + 1),
      dy = (a.at[1] - cy) / (box[3] - box[1] + 1);
    const s = ringSides === "tb" ? (dy < 0 ? "b" : "t") : ringSides === "lr" ? (dx < 0 ? "l" : "r") : Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "l" : "r") : dy < 0 ? "b" : "t";
    sides[s].push({ ...a, pos: s === "l" || s === "r" ? a.at[1] : a.at[0] });
  }
  for (const [s, list] of Object.entries(sides)) {
    list.sort((p, q) => p.pos - q.pos);
    for (let i = 1; i < list.length; i++) if (list[i].pos - list[i - 1].pos < 9) list[i].pos = list[i - 1].pos + 9;
    const spot = (it: { pos: number }): P2 => (s === "l" ? [ring[0], it.pos] : s === "r" ? [ring[2], it.pos] : s === "t" ? [it.pos, ring[3]] : [it.pos, ring[1]]);
    // leaders never cross (B4): two that do swap balloons, until none do
    const cross = (a: P2, b: P2, c: P2, d: P2) => {
      const o = (p: P2, q: P2, r: P2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
    };
    for (let pass = 0, swapped = true; swapped && pass < 30; pass++) {
      swapped = false;
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++)
          if (cross(list[i].at, spot(list[i]), list[j].at, spot(list[j]))) {
            [list[i].pos, list[j].pos] = [list[j].pos, list[i].pos];
            swapped = true;
          }
    }
    for (const it of list) {
      const c: P2 = spot(it);
      const d = Math.hypot(c[0] - it.at[0], c[1] - it.at[1]) || 1;
      const e: P2 = [c[0] - ((c[0] - it.at[0]) / d) * 3.6, c[1] - ((c[1] - it.at[1]) / d) * 3.6];
      addPrims(b, [{ t: "line", a: it.at, b: e, w: W.thin, layer: "BALLOONS", view: sb.id }, { t: "circle", c: it.at, r: 0.6, w: 0, fill: true, layer: "BALLOONS", view: sb.id }, ...balloon(c, it.mark, sb.id)]);
      b.balloons.push({ mark: it.mark, at: c, view: sb.id });
    }
  }
  titleUnder(b, vm, sb.id, sb.title, scale, "NOT DIMENSIONED");
  return b;
}

/** The parts schedule (plan 12.3.5): No., Part, Qty, Material, Thickness, Width, Length, Notes. Finished sizes. */
function scheduleBlock(ctx: Ctx, maxW: number): Block {
  const b = emptyBlock();
  const head = ["NO.", "PART", "QTY", "MATERIAL", "THK", "WIDTH", "LENGTH", "NOTES"];
  const rows = ctx.marks.map((mk) => {
    const p = mk.first;
    const spec = ctx.spec(p);
    const code = ctx.code.get(spec);
    return [String(mk.mark), mk.label, String(mk.qty), code ?? spec, p.round ? `Ø${mm(p.T)}` : mm(p.T), p.round ? "–" : mm(p.W), mm(p.L), workNote(p, ctx) || "–"];
  });
  const h = TH.note;
  const widths = head.map((hd, i) => Math.max(textWidth(hd, h, true), ...rows.map((r) => textWidth(r[i], h, i === 0))) + 3);
  // the material and the notes wrap; the material no wider than 44
  widths[3] = Math.min(widths[3], 44);
  const fixed = widths.slice(0, 7).reduce((a, c) => a + c, 0);
  widths[7] = Math.max(28, Math.min(widths[7], maxW - fixed));
  const total = widths.reduce((a, c) => a + c, 0);
  const rowH = 5.4;
  const wrapped = rows.map((r) => wrap(r[7], h, widths[7] - 3));
  const wrappedM = rows.map((r) => wrap(r[3], h, widths[3] - 3));
  const heights = wrapped.map((w, i) => Math.max(rowH, 1.9 + Math.max(w.length, wrappedM[i].length) * 3.6));
  const titleH = 7;
  const H = titleH + rowH + heights.reduce((a, c) => a + c, 0);
  const prims: Prim[] = [];
  prims.push(text([0, -titleH + 2.2], "PARTS SCHEDULE", TH.head, { bold: true, layer: "TABLES", role: "title" }));
  prims.push({ t: "poly", pts: [[0, -titleH], [total, -titleH], [total, -H], [0, -H]], closed: true, w: W.visible, layer: "TABLES" });
  let y = -titleH;
  const cols: number[] = [0];
  for (const w of widths) cols.push(cols[cols.length - 1] + w);
  const left = (i: number) => i === 1 || i === 3 || i === 7;
  head.forEach((hd, i) => prims.push(text([left(i) ? cols[i] + 1.5 : (cols[i] + cols[i + 1]) / 2, y - rowH / 2], hd, h, { anchor: left(i) ? "start" : "middle", base: "middle", bold: true, layer: "TABLES", role: "table" })));
  y -= rowH;
  prims.push({ t: "line", a: [0, y], b: [total, y], w: W.visible, layer: "TABLES" });
  rows.forEach((r, ri) => {
    const rh = heights[ri];
    r.forEach((c, i) => {
      if (i === 7) wrapped[ri].forEach((l, li) => prims.push(text([cols[i] + 1.5, y - 1.45 - h - li * 3.6], l, h, { layer: "TABLES", role: "table" })));
      else if (i === 3) wrappedM[ri].forEach((l, li) => prims.push(text([cols[i] + 1.5, y - 1.45 - h - li * 3.6], l, h, { layer: "TABLES", role: "table" })));
      else prims.push(text([left(i) ? cols[i] + 1.5 : (cols[i] + cols[i + 1]) / 2, y - 1.45 - h], c, h, { anchor: left(i) ? "start" : "middle", bold: i === 0, layer: "TABLES", role: "table" }));
    });
    y -= rh;
    if (ri + 1 < rows.length) prims.push({ t: "line", a: [0, y], b: [total, y], w: W.thin, layer: "TABLES" });
  });
  for (let i = 1; i < cols.length - 1; i++) prims.push({ t: "line", a: [cols[i], -titleH], b: [cols[i], -H], w: W.thin, layer: "TABLES" });
  addPrims(b, prims);
  return b;
}

/* ---------------- part views ---------------- */

/** One part's views at a scale: for its part numbers (several when they're the same part under different names), with
 *  its material's code and which way the grain runs on its face (0 along, 2 across), if it shows. */
type PartPlan = { mk: Mark; group: Mark[]; scale: number; views: ViewBuild[]; tag?: string; grain?: 0 | 2 };

/** "BOTTOM, SHELF & TOP" */
const andList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} & ${xs[xs.length - 1]}` : (xs[0] ?? ""));
/** A part view's identifier: its part number, or the run of them ("2-4", "2,5"). */
const groupId = (g: Mark[]) => {
  const ns = g.map((m) => m.mark).sort((a, b) => a - b);
  return ns.length === 1 ? String(ns[0]) : ns.every((n, i) => !i || n === ns[i - 1] + 1) ? `${ns[0]}-${ns[ns.length - 1]}` : ns.join(",");
};


const kindName = (k: WorkKind) => ({ mortise: "MORTISE", slot: "SLOT", tenon: "TENON", housing: "HOUSING", rebate: "REBATE", groove: "GROOVE", notch: "NOTCH", hole: "HOLE", pocket: "POCKET", end: "END", lap: "LAP", scarf: "SCARF" })[k];

/** The plan for one part's views at a scale, or null if it won't go across the sheet even broken. */
function partPlan(ctx: Ctx, mk: Mark, scale: number, maxW: number, group: Mark[] = [mk]): PartPlan | null {
  const p = mk.first;
  const pe = partEdges(p.polys, p.index);
  const k = 1 / scale;
  const frame = `part${mk.mark}`;
  const face = drawView([pe], VIEWS.front, { hidden: true });
  const edge = drawView([pe], VIEWS.top, { hidden: true });
  const end = drawView([pe], VIEWS.right, { hidden: true });
  const hasEnds = p.features.some((f) => f.kind === "tenon" || f.kind === "slot" || f.kind === "end") || p.round;
  // the features in a joint detail (19.2): their sizes across the part are on the detail; along it they set the part out,
  // shown here in brackets where the detail gives them, and the view points to the detail
  const jf = ctx.jfeats.get(p.index) ?? new Map<number, string>();
  const own = (f: Feature) => !jf.has(p.features.indexOf(f));
  // holes: centres in the view where they're circles, with centre lines to start from (across the part, only those not
  // set out on a detail)
  const holesY = p.features.filter((f) => f.hole && f.hole.axis === 1),
    holesZ = p.features.filter((f) => f.hole && f.hole.axis === 2);
  const ownY = holesY.filter(own),
    ownZ = holesZ.filter(own);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  // where two holes share a station, the extension line starts at the one nearer the chain
  const feet = (es: [number, number][], keep: "min" | "max") => {
    const m = new Map<number, number>();
    for (const [st, f] of es) {
      const o = m.get(st);
      if (o === undefined || (keep === "min" ? f < o : f > o)) m.set(st, f);
    }
    return m;
  };
  const faceFeetX = feet(holesY.map((f) => [r3(f.hole!.c[0]), f.hole!.c[2] - f.hole!.d / 2 - 2.5 / k]), "min");
  // a hole's position across is given from the nearer end, so its extension line is short
  const holeSide = (hs: Feature[]) => (hs.length && hs.reduce((t, f) => t + f.hole!.c[0], 0) / hs.length > p.L / 2 ? "right" : "left");
  const sideY = holeSide(holesY),
    sideZ = holeSide(holesZ);
  const faceFeetZ = feet(ownY.map((f) => [r3(f.hole!.c[2]), sideY === "left" ? f.hole!.c[0] - f.hole!.d / 2 - 2.5 / k : f.hole!.c[0] + f.hole!.d / 2 + 2.5 / k]), sideY === "left" ? "min" : "max");
  const edgeFeetX = feet(holesZ.map((f) => [r3(f.hole!.c[0]), f.hole!.c[1] + f.hole!.d / 2 + 2.5 / k]), "max");
  const edgeFeetY = feet(ownZ.map((f) => [r3(f.hole!.c[1]), sideZ === "left" ? f.hole!.c[0] - f.hole!.d / 2 - 2.5 / k : f.hole!.c[0] + f.hole!.d / 2 + 2.5 / k]), sideZ === "left" ? "min" : "max");
  // along the length: what the front shows (feature sides seen, holes seen as circles); the rest from above
  const seenFace = (f: Feature) => !f.hole && (f.lo[1] || (f.lo[1] && f.hi[1]) || f.lo[2] || f.hi[2] || f.lo[0] || f.hi[0]);
  const xsFace = [...p.features.filter(seenFace).flatMap((f) => stationsOf(f, 0)), ...holesY.map((f) => f.hole!.c[0])];
  const xsEdge = [...p.features.filter((f) => !f.hole && !seenFace(f)).flatMap((f) => stationsOf(f, 0)), ...holesZ.map((f) => f.hole!.c[0])].filter((x) => !xsFace.some((y) => Math.abs(y - x) < 0.05));
  const faceDims: DimSpec[] = [];
  const xChain = withRefs(ctx, p, chainSpec(frame, "x", p.L, xsFace, "below", 0, faceFeetX), jf);
  if (xChain) faceDims.push(xChain);
  faceDims.push({ side: "below", stations: [0, p.L], keys: [key(frame, "x", 0, p.L)], overall: true, total: p.L, tier: xChain ? 1 : 0 });
  // across the width: the sides of features not in a detail; hole centres not set out on one
  const zs = p.features.filter((f) => !f.hole && own(f)).flatMap((f) => stationsOf(f, 2));
  const zChain = chainSpec(frame, "z", p.W, zs, "left", 0);
  if (zChain) faceDims.push(zChain);
  // hole centres inside the overall when they're on its side: chains in, the overall outermost
  const zHoles = ownY.length ? chainSpec(`${frame}-c`, "z", p.W, ownY.map((f) => f.hole!.c[2]), sideY, 0, faceFeetZ) : null;
  if (zHoles) faceDims.push(zHoles);
  if (!p.round) faceDims.push({ side: "left", stations: [0, p.W], keys: [key(frame, "z", 0, p.W)], overall: true, total: p.W, tier: (zChain ? 1 : 0) + (zHoles && sideY === "left" ? 1 : 0) });
  const edgeDims: DimSpec[] = [];
  const ys = p.features.filter((f) => !f.hole && own(f)).flatMap((f) => stationsOf(f, 1));
  const yChain = chainSpec(frame, "y", p.T, ys, "left", 0);
  if (yChain) edgeDims.push(yChain);
  const yHoles = ownZ.length ? chainSpec(`${frame}-c`, "y", p.T, ownZ.map((f) => f.hole!.c[1]), sideZ, 0, edgeFeetY) : null;
  if (yHoles) edgeDims.push(yHoles);
  if (!p.round) edgeDims.push({ side: "left", stations: [0, p.T], keys: [key(frame, "y", 0, p.T)], overall: true, total: p.T, tier: (yChain ? 1 : 0) + (yHoles && sideZ === "left" ? 1 : 0) });
  if (xsEdge.length) {
    const xe = withRefs(ctx, p, chainSpec(`${frame}-e`, "x", p.L, xsEdge, "above", 0, edgeFeetX), jf);
    if (xe) edgeDims.push(xe);
  }
  const leaders: { at: P2; s: string }[] = [];
  const edgeLeaders: { at: P2; s: string }[] = [];
  const holeNote = (hs: Feature[]) => {
    const d = hs[0].hole!.d;
    const n = hs.filter((h) => h.hole!.d === d).length;
    return `${n > 1 ? `${n} x ` : ""}Ø${mm(d)}${hs[0].hole!.through ? " THRO" : ""}`;
  };
  if (holesY.length) {
    const h0 = holesY[holesY.length - 1].hole!;
    leaders.push({ at: [h0.c[0] + (h0.d / 2) * Math.SQRT1_2, h0.c[2] + (h0.d / 2) * Math.SQRT1_2], s: holeNote(holesY) });
  }
  if (holesZ.length) {
    const h0 = holesZ[holesZ.length - 1].hole!;
    edgeLeaders.push({ at: [h0.c[0] + (h0.d / 2) * Math.SQRT1_2, h0.c[1] + (h0.d / 2) * Math.SQRT1_2], s: holeNote(holesZ) });
  }
  // one pointer to each detail its joinery is in: "MORTISE, SEE DETAIL B" (on the face, or the edge if it's seen there)
  for (const letter of [...new Set(jf.values())].sort()) {
    const fi = [...jf.entries()].find(([i, l]) => l === letter && !p.features[i].hole)?.[0] ?? [...jf.entries()].find(([, l]) => l === letter)![0];
    const f0 = p.features[fi];
    const onFace = seenFace(f0) || !!f0.hole;
    const word = f0.hole ? "HOLES" : kindName(kindIn(ctx, p, fi));
    const tip: P2 = onFace ? [(f0.box.min[0] + f0.box.max[0]) / 2, f0.lo[1] && !f0.hi[1] ? (f0.box.min[2] + f0.box.max[2]) / 2 : f0.box.max[2]] : [(f0.box.min[0] + f0.box.max[0]) / 2, (f0.box.min[1] + f0.box.max[1]) / 2];
    (onFace ? leaders : edgeLeaders).push({ at: tip, s: `${word}, SEE DETAIL ${letter}` });
  }
  if (p.round) leaders.push({ at: [p.L * 0.3, p.W], s: `Ø${mm(p.W)}` });
  const qty = group.reduce((t, m) => t + m.qty, 0);
  const faceV: ViewBuild = { id: `p${mk.mark}`, lines: face, min: face.min, max: face.max, scale, dims: faceDims, kind: "part", title: `${andList(group.map((m) => m.label))}, ${qty} REQ'D`, mark: mk.mark, ...(group.length > 1 ? { marks: group.map((m) => m.mark) } : {}), leaders };
  // a long plain member is broken rather than shrunk
  const endW = hasEnds ? p.T * k + 22 : 0;
  const room = maxW - dimRoom(faceV).left - dimRoom(faceV).right - endW - 6;
  if (p.L * k > room) {
    if (p.L < 4 * p.W) return null;
    const cuts = [0, ...p.features.flatMap((f) => [f.box.min[0], f.box.max[0]]), p.L].sort((a, b) => a - b);
    let gap = { a: 0, b: 0 };
    for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1] - cuts[i] > gap.b - gap.a) gap = { a: cuts[i], b: cuts[i + 1] };
    const need = p.L * k - room + 8;
    const mid = (gap.a + gap.b) / 2;
    const half = need / k / 2;
    if (mid - half < gap.a + 20 / k || mid + half > gap.b - 20 / k) return null;
    faceV.brk = { u0: mid - half, u1: mid + half, gap: 8 };
  }
  const views = [faceV];
  if (!p.round) views.push({ id: `p${mk.mark}e`, lines: edge, min: edge.min, max: edge.max, scale, dims: edgeDims, kind: "part", title: "", mark: mk.mark, leaders: edgeLeaders, ...(faceV.brk ? { brk: faceV.brk } : {}) });
  if (hasEnds) views.push({ id: `p${mk.mark}n`, lines: end, min: end.min, max: end.max, scale, dims: [], kind: "part", title: "", mark: mk.mark });
  const spec = ctx.spec(p);
  const tag = ctx.code.get(spec);
  const grain = p.grain === 0 || p.grain === 2 ? (p.grain as 0 | 2) : undefined;
  return { mk, group, scale, views, ...(tag ? { tag } : {}), ...(grain !== undefined && !grainless(spec) ? { grain } : {}) };
}

/** A free spot for a w × h box inside a view's linework box (a part's face), searched from the middle out. */
function spotInside(box: Box, w: number, h: number, occ: Occupied, taken: Box[] = []): P2 | null {
  const bw = box[2] - box[0],
    bh = box[3] - box[1];
  if (bw < w + 3 || bh < h + 2) return null;
  for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8])
    for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
      const c: P2 = [box[0] + bw * fx, box[1] + bh * fy];
      const b: Box = [c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2];
      if (b[0] < box[0] + 1.5 || b[2] > box[2] - 1.5 || b[1] < box[1] + 1 || b[3] > box[3] - 1) continue;
      if (taken.some((t) => t[0] < b[2] + 2 && b[0] < t[2] + 2 && t[1] < b[3] + 2 && b[1] < t[3] + 2)) continue;
      if (occ.free([b[0] - 0.8, b[1] - 0.8, b[2] + 0.8, b[3] + 0.8])) return c;
    }
  return null;
}

/** One part's views as a block: face view, the edge view above it, the end view to its right, the title under. */
function partBlock(plan: PartPlan): Block {
  const b = emptyBlock();
  const occ = new Occupied();
  const face = plan.views[0];
  const edge = plan.views.find((v) => v.id.endsWith("e"));
  const endV = plan.views.find((v) => v.id.endsWith("n"));
  const fr = dimRoom(face);
  const fs = paperSize(face);
  const edgeY = edge ? fs[1] + fr.above + dimRoom(edge).below + 7 : 0;
  const endX = fs[0] + fr.right + 12;
  if (edge) reserve(edge, 0, edgeY, occ);
  if (endV) reserve(endV, endX, 0, occ);
  const fb = placeView(face, 0, 0, occ);
  merge(b, fb);
  const fm = fb.views[0];
  if (edge) {
    const eb = placeView(edge, 0, edgeY, occ);
    eb.views[0].aligned = [{ with: face.id, axis: "x", at: eb.views[0].ox, other: fm.ox }];
    merge(b, eb);
  }
  if (endV) {
    const nb = placeView(endV, endX, 0, occ);
    nb.views[0].aligned = [{ with: face.id, axis: "y", at: nb.views[0].oy, other: fm.oy }];
    merge(b, nb);
  }
  // on the face: the grain arrow (half-headed, the way the grain runs) and the material's code tag, where nothing is
  const taken: Box[] = [];
  if (plan.grain !== undefined) {
    const along = plan.grain === 0;
    const span = along ? fm.box[2] - fm.box[0] : fm.box[3] - fm.box[1];
    const len = Math.max(12, Math.min(30, span * 0.3));
    const c = spotInside(fm.box, along ? len : 3.2, along ? 3.2 : len, occ);
    if (c) {
      const a: P2 = along ? [c[0] - len / 2, c[1] - 0.4] : [c[0] + 0.4, c[1] - len / 2];
      const e: P2 = along ? [c[0] + len / 2, c[1] - 0.4] : [c[0] + 0.4, c[1] + len / 2];
      const ps = grainArrow(a, e, fm.id);
      addPrims(b, ps);
      occ.addPrims(ps);
      taken.push(along ? [a[0], c[1] - 1.6, e[0], c[1] + 1.6] : [c[0] - 1.6, a[1], c[0] + 1.6, e[1]]);
      b.legend.add("grain");
    }
  }
  let tagAt: P2 | null = null;
  if (plan.tag) {
    const [tw, th] = tagSize(plan.tag);
    tagAt = spotInside(fm.box, tw, th, occ, taken);
    if (tagAt) {
      const ps = materialTag(tagAt, plan.tag, fm.id);
      addPrims(b, ps);
      occ.addPrims(ps);
    }
    b.legend.add(`mat:${plan.tag}`);
  }
  placeLeaders(b, occ);
  titleUnder(b, fm, groupId(plan.group), face.title, plan.scale);
  // no room on the face: the tag beside the title
  if (plan.tag && !tagAt) {
    const tt = b.prims.filter((q): q is Text => q.t === "text" && q.view === fm.id && q.role === "title");
    const tb = tt.map((q) => textBox(q)).reduce((m, x) => [Math.min(m[0], x[0]), Math.min(m[1], x[1]), Math.max(m[2], x[2]), Math.max(m[3], x[3])] as Box, [Infinity, Infinity, -Infinity, -Infinity] as Box);
    const [tw] = tagSize(plan.tag);
    addPrims(b, materialTag([tb[2] + 3 + tw / 2, (tb[1] + tb[3]) / 2], plan.tag, fm.id));
  }
  return b;
}

/** The scale a part will most likely be drawn at (before any notes): to judge what's too small to read there. */
function estimatedScale(p: PartInfo) {
  const linear = p.L >= 4 * p.W;
  for (const s of SCALES.filter((x) => x >= 2)) if (linear ? p.W / s <= 40 : p.W / s <= 110 && p.L / s <= 170) return s;
  return 50;
}

/** A part's views at one scale, across the sheet (the overrun taken out of the break if it's long), else null. */
function partAt(ctx: Ctx, group: Mark[], scale: number, maxW: number): Block | null {
  const mk = group[0],
    p = mk.first;
  let shrink = 0;
  for (let tries = 0; tries < 3; tries++) {
    const plan = partPlan(ctx, mk, scale, maxW - shrink, group);
    if (!plan) return null;
    const b = partBlock(plan);
    if (blockW(b) <= maxW + 1e-6) return b;
    if (!plan.views[0].brk && p.L < 4 * p.W) return null;
    shrink += blockW(b) - maxW + 2;
  }
  return null;
}

/**
 * A part's views at the scales it can be drawn at, smallest first, and which is its own: the largest at which a
 * member's face is no more than 40 high (broken if long), a panel within 170 × 110, a plain part within 120 × 45. Up to
 * two larger scales are there for a sheet with room (12.10), one smaller for a plain part on a full one.
 */
function partVariants(ctx: Ctx, group: Mark[], maxW: number, maxH: number): { blocks: Block[]; base: number } {
  const p = group[0].first;
  const linear = p.L >= 4 * p.W;
  const plain = !p.features.length;
  const scales = SCALES.filter((s) => s >= 2) as number[];
  let base = -1;
  let baseBlock: Block | null = null;
  for (const [i, scale] of scales.entries()) {
    const k = 1 / scale;
    if (plain ? p.L * k > 120 || p.W * k > 45 : linear ? p.W * k > 40 : p.W * k > 110 || p.L * k > 170) continue;
    baseBlock = partAt(ctx, group, scale, maxW);
    if (baseBlock) {
      base = i;
      break;
    }
  }
  if (!baseBlock) throw new Error(`part ${group[0].mark} won't fit`);
  const all = SCALES as readonly number[];
  const at = all.indexOf(scales[base]);
  const out: Block[] = [];
  if (plain && at + 1 < all.length) {
    const b = partAt(ctx, group, all[at + 1], maxW);
    if (b) out.push(b);
  }
  const own = out.length;
  out.push(baseBlock);
  for (let j = at - 1; j >= Math.max(0, at - 2); j--) {
    const b = partAt(ctx, group, all[j], maxW);
    if (!b || blockH(b) > maxH * 0.8) break;
    out.push(b);
  }
  return { blocks: out, base: own };
}

/* ---------------- sections he asked for (19.3): see details.ts ---------------- */

/* ---------------- the right-hand column and title block ---------------- */

export const STANDING = (inp: { finish?: string }) => [
  "ALL DIMENSIONS IN MILLIMETRES.",
  "DO NOT SCALE FROM THIS DRAWING.",
  "VERIFY ALL DIMENSIONS ON SITE BEFORE FABRICATION.",
  "THIRD ANGLE PROJECTION.",
  "SIZES ARE FINISHED SIZES. MATERIALS AS SCHEDULED.",
  `FINISH: ${inp.finish ? inp.finish.toUpperCase() : "TBC"}.`,
  "SHOP DRAWING FOR FABRICATION AND SET-OUT ONLY. NOT A STRUCTURAL DESIGN OR CERTIFICATION. STRUCTURAL ADEQUACY BY OTHERS UNLESS NOTED.",
];

const LEGEND_LABEL: Record<string, string> = { end: "TIMBER, CUT ACROSS GRAIN", long: "TIMBER, CUT ALONG GRAIN", ply: "PLYWOOD", mdf: "MDF", board: "PARTICLEBOARD", steel: "STEEL", concrete: "CONCRETE", plain: "MATERIAL TBC" };
const LEGEND_STYLE: Record<string, HatchStyle> = { end: { angle: 45, gap: 2 }, long: { angle: 0, gap: 2.5 }, ply: { angle: 45, gap: 1.2 }, mdf: { angle: 45, gap: 2.2, cross: true }, board: { angle: 135, gap: 1.6 }, steel: { angle: 45, gap: 0.8 }, concrete: { angle: 45, gap: 3.5 }, plain: { angle: 45, gap: 3 } };

/** A material's code tag (12.10): the code in a flat hexagon, as on the part views and in the legend. */
export function materialTag(c: P2, code: string, view?: string): Prim[] {
  const w = textWidth(code, TH.note, true) + 4.2,
    h = 4.6;
  const x0 = c[0] - w / 2,
    x1 = c[0] + w / 2;
  return [
    { t: "poly", pts: [[x0, c[1]], [x0 + 1.4, c[1] - h / 2], [x1 - 1.4, c[1] - h / 2], [x1, c[1]], [x1 - 1.4, c[1] + h / 2], [x0 + 1.4, c[1] + h / 2]], closed: true, w: W.thin, layer: "SYMBOLS", ...(view ? { view } : {}) },
    text(c, code, TH.note, { anchor: "middle", base: "middle", bold: true, layer: "SYMBOLS", role: "label", ...(view ? { view } : {}) }),
  ];
}
export const tagSize = (code: string): P2 => [textWidth(code, TH.note, true) + 4.2, 4.6];

/** The grain arrow (12.10): a line with a half head, pointing the way the grain runs. */
export function grainArrow(a: P2, b: P2, view?: string): Prim[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const d: P2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  const n: P2 = [-d[1], d[0]];
  const v = view ? { view } : {};
  return [
    { t: "line", a, b, w: W.thin, layer: "SYMBOLS", ...v },
    { t: "poly", pts: [b, [b[0] - d[0] * 3 + n[0] * 1.2, b[1] - d[1] * 3 + n[1] * 1.2], [b[0] - d[0] * 3, b[1] - d[1] * 3]], closed: true, fill: true, w: W.thin, layer: "SYMBOLS", ...v },
  ];
}

function column(sheet: { notes: string[]; legend: string[]; abbrev: string[]; materials: [string, string][]; grain: boolean }, inp: SetInput, sheetNo: number, of: number, subtitle: string, scaleText: string): { prims: Prim[]; logoAt: [number, number, number, number] } {
  const x0 = COL_X,
    x1 = FRAME[2],
    pad = 3,
    tx = x0 + pad,
    width = x1 - x0 - 2 * pad;
  const out: Prim[] = [];
  const L = (a: P2, b: P2, w: number = W.thin): Prim => ({ t: "line", a, b, w, layer: "TITLE" });
  const T = (at: P2, s: string, h: number, o: Partial<Text> = {}) => text(at, s, h, { layer: "TITLE", role: "block", ...o });
  const mid = x0 + (x1 - x0) / 2;
  out.push(L([x0, FRAME[1]], [x0, FRAME[3]], W.visible));
  // --- title block, bottom up: number / rev / sheet; the grid; the title; project and client; the company ---
  const yb = FRAME[1];
  const nTop = yb + 17;
  const revX = x0 + (x1 - x0) * 0.6,
    shX = x0 + (x1 - x0) * 0.78;
  out.push(L([revX, nTop], [revX, yb]), L([shX, nTop], [shX, yb]));
  out.push(T([tx, nTop - 1.8], "DRAWING NO.", TH.note, { base: "top" }));
  out.push(T([tx, yb + 3], inp.number, TH.big, { bold: true }));
  out.push(T([revX + 2, nTop - 1.8], "REV", TH.note, { base: "top" }));
  out.push(T([(revX + shX) / 2, yb + 3], inp.revision, TH.big, { bold: true, anchor: "middle" }));
  out.push(T([shX + 2, nTop - 1.8], "SHEET", TH.note, { base: "top" }));
  out.push(T([(shX + x1) / 2, yb + 3], `${sheetNo}/${of}`, TH.big, { bold: true, anchor: "middle" }));
  out.push(L([x0, nTop], [x1, nTop], W.visible));
  const rowH = 9.5;
  const gTop = nTop + 3 * rowH;
  const cell = (cx: number, cy: number, cap: string, val: string) => {
    out.push(T([cx + pad, cy - 1.8], cap, TH.note, { base: "top" }));
    if (val) out.push(T([cx + pad, cy - 6.2], val, TH.note, { base: "top", bold: true }));
  };
  cell(x0, gTop, "SCALE", scaleText);
  cell(mid, gTop, "SIZE", "A3");
  cell(x0, gTop - rowH, "DATE", inp.date);
  cell(mid, gTop - rowH, "STATUS", inp.status);
  cell(x0, gTop - 2 * rowH, "DRAWN", inp.drawn.toUpperCase());
  cell(mid, gTop - 2 * rowH, "CHECKED", (inp.checked ?? "").toUpperCase());
  for (let i = 1; i < 3; i++) out.push(L([x0, gTop - i * rowH], [x1, gTop - i * rowH]));
  out.push(L([mid, gTop], [mid, nTop]));
  // the projection symbol in the size cell, right of "A3"
  out.push(...projectionSymbol([mid + 22, gTop - rowH + 1.9], 5.6));
  out.push(L([x0, gTop], [x1, gTop], W.visible));
  // the drawing's title
  const tTop = gTop + 17.5;
  // two lines at 3.5; if it needs more, three at 2.5 (never cut short)
  const full = `${inp.title} – ${subtitle}`.toUpperCase();
  let th: number = TH.head,
    tl = wrap(full, th, width, true);
  if (tl.length > 2) ((th = TH.note), (tl = wrap(full, th, width, true)));
  out.push(T([tx, tTop - 1.8], "DRAWING TITLE", TH.note, { base: "top" }));
  tl.slice(0, 3).forEach((l, i) => out.push(T([tx, tTop - 6.8 - i * (th + 1.4)], l, th, { base: "top", bold: true })));
  out.push(L([x0, tTop], [x1, tTop]));
  // project and client: with no company on the drawings the project leads the block, large; with one, a row each
  const name = (inp.company ?? "").trim().toUpperCase();
  const line = (inp.companyLine ?? "").trim().toUpperCase();
  const hasCo = !!(name || line || inp.logo);
  let pTop: number;
  if (hasCo) {
    pTop = tTop + 12.5;
    out.push(T([tx, pTop - 1.8], "PROJECT", TH.note, { base: "top" }), T([tx + 19, pTop - 1.8], inp.project.toUpperCase().slice(0, 32), TH.note, { base: "top", bold: true }));
    out.push(T([tx, pTop - 7.3], "CLIENT", TH.note, { base: "top" }), T([tx + 19, pTop - 7.3], inp.client.toUpperCase().slice(0, 32), TH.note, { base: "top", bold: true }));
  } else {
    let ph: number = TH.big,
      pl = wrap(inp.project.toUpperCase(), ph, width, true);
    if (pl.length > 2) ((ph = TH.head), (pl = wrap(inp.project.toUpperCase(), ph, width, true).slice(0, 2)));
    pTop = tTop + 11.5 + pl.length * (ph + 1.6);
    out.push(T([tx, pTop - 1.8], "PROJECT", TH.note, { base: "top" }));
    pl.forEach((l, i) => out.push(T([tx, pTop - 6.3 - i * (ph + 1.6)], l, ph, { base: "top", bold: true })));
    out.push(T([tx, tTop + 2.4], "CLIENT", TH.note), T([tx + 19, tTop + 2.4], inp.client.toUpperCase().slice(0, 32), TH.note, { bold: true }));
  }
  out.push(L([x0, pTop], [x1, pTop]));
  // the company, only if he's put one on: a logo, the name set in type, the line under it
  let cTop = pTop;
  let logoAt: [number, number, number, number] = [0, 0, 0, 0];
  if (hasCo) {
    cTop = pTop + 15;
    logoAt = [tx, pTop + 2, width * 0.45, cTop - pTop - 4];
    if (name) {
      const nameH = textWidth(name, TH.big, true) <= width - (inp.logo ? width * 0.5 : 0) ? TH.big : TH.head;
      if (inp.logo) out.push(T([x1 - pad, cTop - 2.5], name, TH.head, { anchor: "end", base: "top", bold: true }));
      else out.push(T([tx, cTop - 2.5], name, nameH, { base: "top", bold: true }));
    }
    if (line) out.push(T([inp.logo ? x1 - pad : tx, name ? cTop - 10 : cTop - 5.5], line.slice(0, 40), name ? TH.note : TH.head, { base: "top", bold: !name, anchor: inp.logo ? "end" : "start" }));
    out.push(L([x0, cTop], [x1, cTop], W.visible));
  }
  // --- checked / approved: left blank for the owner ---
  const ca1 = cTop + 17;
  out.push(T([tx, ca1 - 1.8], "CHECKED", TH.note, { base: "top" }), T([mid + pad, ca1 - 1.8], "DATE", TH.note, { base: "top" }));
  out.push(T([tx, ca1 - 10.3], "APPROVED", TH.note, { base: "top" }), T([mid + pad, ca1 - 10.3], "DATE", TH.note, { base: "top" }));
  out.push(L([x0, ca1 - 8.5], [x1, ca1 - 8.5]), L([mid, cTop], [mid, ca1]));
  out.push(L([x0, ca1], [x1, ca1], W.visible));
  // --- revisions: oldest at the top, the newest (the title block's) last ---
  const revs = inp.revisions.slice(-5);
  const rh = 5;
  const rTop = ca1 + rh * (revs.length + 1) + 7;
  const rc = [x0, x0 + 11, x0 + 30, x1 - 11, x1];
  out.push(T([tx, rTop - 1.6], "REVISIONS", TH.head, { base: "top", bold: true }));
  const hy = rTop - 7;
  out.push(L([x0, hy], [x1, hy], W.visible));
  ["REV", "DATE", "DESCRIPTION", "BY"].forEach((h, i) => out.push(T([rc[i] + 1.5, hy - rh / 2], h, TH.note, { base: "middle", bold: true })));
  out.push(L([x0, hy - rh], [x1, hy - rh]));
  revs.forEach((r, i) => {
    const y = hy - rh * (i + 1);
    if (i) out.push(L([x0, y], [x1, y]));
    [r.rev, r.date, r.text.toUpperCase(), r.by.toUpperCase()].forEach((v, k) => {
      let s = v;
      while (textWidth(s, TH.note) > rc[k + 1] - rc[k] - 2.5 && s.length > 3) s = s.slice(0, -1);
      out.push(T([rc[k] + 1.5, y - rh / 2], s, TH.note, { base: "middle" }));
    });
  });
  for (let i = 1; i < 4; i++) out.push(L([rc[i], hy], [rc[i], ca1]));
  out.push(L([x0, rTop + 1.5], [x1, rTop + 1.5], W.visible));
  // --- notes, numbered, from the top; then the legend ---
  // (Stage 21: when they'd run into the revisions below, the lines close up and the abbreviations share one line, so
  // nothing is drawn over anything; seen when a set's notes ran long)
  const noteLines = sheet.notes.reduce((n, x) => n + wrap(x, TH.note, width - 6).length, 0);
  const legendH = sheet.legend.length || sheet.abbrev.length || sheet.materials.length || sheet.grain
    ? 11 + 6.5 * (sheet.legend.length + (sheet.grain ? 1 : 0)) + (sheet.materials.length ? 7.2 + sheet.materials.reduce((n, [, m]) => n + 3 + 3.6 * Math.max(1, wrap(m, TH.note, width - 16).length), 0) : 0) + 3.9 * sheet.abbrev.length
    : 0;
  const room = FRAME[3] - 4 - (rTop + 3);
  const tight = 7.5 + noteLines * 3.9 + sheet.notes.length * 0.9 + legendH > room;
  const lineH = tight ? 3.4 : 3.9,
    gapH = tight ? 0.5 : 0.9,
    swatchH = tight ? 5.6 : 6.5;
  const abbrev = tight && sheet.abbrev.length > 1 ? [sheet.abbrev.join("   ")] : sheet.abbrev;
  let y = FRAME[3] - 4;
  out.push(T([tx, y], "NOTES", TH.head, { base: "top", bold: true }));
  y -= 7.5;
  sheet.notes.forEach((n, i) => {
    wrap(n, TH.note, width - 6).forEach((l, k) => {
      if (k === 0) out.push(T([tx, y], `${i + 1}.`, TH.note, { base: "top" }));
      out.push(T([tx + 6, y], l, TH.note, { base: "top" }));
      y -= lineH;
    });
    y -= gapH;
  });
  if (sheet.legend.length || sheet.abbrev.length || sheet.materials.length || sheet.grain) {
    y -= 1.5;
    out.push(L([x0, y + 2], [x1, y + 2]));
    y -= 2;
    out.push(T([tx, y], "LEGEND", TH.head, { base: "top", bold: true }));
    y -= 7.5;
    for (const k of sheet.legend) {
      const sw: Box = [tx, y - 4.5, tx + 12, y];
      out.push({ t: "poly", pts: [[sw[0], sw[1]], [sw[2], sw[1]], [sw[2], sw[3]], [sw[0], sw[3]]], closed: true, w: W.thin, layer: "TITLE" });
      for (const [a, b] of hatchLines([[[sw[0], sw[1]], [sw[2], sw[1]], [sw[2], sw[3]], [sw[0], sw[3]]]], LEGEND_STYLE[k])) out.push({ t: "line", a, b, w: W.thin, layer: "TITLE" });
      out.push(T([tx + 15, y - 2.25], LEGEND_LABEL[k], TH.note, { base: "middle" }));
      y -= swatchH;
    }
    if (sheet.grain) {
      out.push(...grainArrow([tx, y - 2.25], [tx + 12, y - 2.25]).map((q) => ({ ...q, layer: "TITLE" as const })));
      out.push(T([tx + 15, y - 2.25], "GRAIN DIRECTION", TH.note, { base: "middle" }));
      y -= swatchH;
    }
    if (sheet.materials.length) {
      y -= 1;
      out.push(T([tx, y], "MATERIALS", TH.note, { base: "top", bold: true }));
      y -= 5.2;
      for (const [c, m] of sheet.materials) {
        out.push(...materialTag([tx + 6, y - 2.25], c).map((q) => ({ ...q, layer: "TITLE" as const })));
        wrap(m, TH.note, width - 16).forEach((l, i) => out.push(T([tx + 15, y - 2.25 - i * 3.6], l, TH.note, { base: "middle" })));
        y -= 3 + 3.6 * Math.max(1, wrap(m, TH.note, width - 16).length);
      }
      y -= 1;
    }
    for (const a of abbrev) {
      out.push(T([tx, y], a, TH.note, { base: "top" }));
      y -= lineH;
    }
  }
  return { prims: out, logoAt };
}

/* ---------------- the set ---------------- */

/** The cover's heading text height: the project's name, the one size larger than the sheet's own (A10 allows four). */
const TH_COVER = 7;

/**
 * The cover sheet for a set of four sheets or more (12.10): the project, client and status set large top left, the
 * drawing index (each sheet's number, title and revision), and the piece assembled in 3D, as large as the room allows.
 */
function coverPage(ctx: Ctx, inp: SetInput, index: { sheet: string; title: string }[]): Page {
  const blocks: Page["blocks"] = [];
  const space = new Space(AREA);
  // the heading
  const hb = emptyBlock();
  const N = (at: P2, sx: string, h: number, o: Partial<Text> = {}) => text(at, sx, h, { base: "top", layer: "NOTES", role: "note", ...o });
  let y = 0;
  hb.prims.push(N([0, y], "SHOP DRAWINGS", TH.head, { bold: true }));
  y -= TH.head + 4;
  for (const l of wrap(inp.project.toUpperCase(), TH_COVER, 190, true).slice(0, 2)) {
    hb.prims.push(N([0, y], l, TH_COVER, { bold: true }));
    y -= TH_COVER + 2.5;
  }
  for (const l of wrap(inp.title.toUpperCase(), TH.big, 190, true).slice(0, 2)) {
    hb.prims.push(N([0, y], l, TH.big));
    y -= TH.big + 2;
  }
  y -= 2;
  hb.prims.push(N([0, y], "CLIENT", TH.note), N([27, y], inp.client.toUpperCase(), TH.note, { bold: true }));
  y -= TH.note + 2.4;
  hb.prims.push(N([0, y], "DRAWING NO.", TH.note), N([27, y], `${inp.number}  REV ${inp.revision}`, TH.note, { bold: true }));
  y -= TH.note + 2.4;
  hb.prims.push(N([0, y], "STATUS", TH.note), N([27, y], inp.status, TH.note, { bold: true }));
  for (const q of hb.prims) growBox(hb.box, primBox(q));
  const hx = AREA[0] + 2 - hb.box[0],
    hy = AREA[3] - 2 - hb.box[3];
  blocks.push({ b: hb, x: hx, y: hy });
  space.fillBlock(moveBlock(hb, hx, hy), 4);
  // the drawing index, bottom right
  const ib = emptyBlock();
  const head = ["SHEET", "DRAWING NO.", "TITLE", "REV"];
  const rows = index.map((r) => [r.sheet, inp.number, r.title, inp.revision]);
  const h = TH.note;
  const widths = head.map((hd, i) => Math.max(textWidth(hd, h, true), ...rows.map((r) => textWidth(r[i], h))) + 4);
  const total = widths.reduce((a, c) => a + c, 0);
  const rowH = 5.4,
    titleH = 7;
  const H = titleH + rowH * (rows.length + 1);
  const cols: number[] = [0];
  for (const w of widths) cols.push(cols[cols.length - 1] + w);
  ib.prims.push(text([0, -titleH + 2.2], "DRAWING INDEX", TH.head, { bold: true, layer: "TABLES", role: "title" }));
  ib.prims.push({ t: "poly", pts: [[0, -titleH], [total, -titleH], [total, -H], [0, -H]], closed: true, w: W.visible, layer: "TABLES" });
  let ty = -titleH;
  head.forEach((hd, i) => ib.prims.push(text([cols[i] + 1.5, ty - rowH / 2], hd, h, { base: "middle", bold: true, layer: "TABLES", role: "table" })));
  ty -= rowH;
  ib.prims.push({ t: "line", a: [0, ty], b: [total, ty], w: W.visible, layer: "TABLES" });
  rows.forEach((r, ri) => {
    r.forEach((c, i) => ib.prims.push(text([cols[i] + 1.5, ty - rowH / 2], c, h, { base: "middle", bold: i === 0, layer: "TABLES", role: "table" })));
    ty -= rowH;
    if (ri + 1 < rows.length) ib.prims.push({ t: "line", a: [0, ty], b: [total, ty], w: W.thin, layer: "TABLES" });
  });
  for (let i = 1; i < cols.length - 1; i++) ib.prims.push({ t: "line", a: [cols[i], -titleH], b: [cols[i], -H], w: W.thin, layer: "TABLES" });
  for (const q of ib.prims) growBox(ib.box, primBox(q));
  const ix = AREA[2] - 2 - ib.box[2],
    iy = AREA[1] + 2 - ib.box[1];
  blocks.push({ b: ib, x: ix, y: iy });
  space.fillBlock(moveBlock(ib, ix, iy), 4);
  // the piece assembled, the largest standard scale with room
  for (const sc of SCALES) {
    const lines = cached(ctx, "iso-0", () => drawView(prepare(ctx.built), ISO, { hidden: false }));
    const v: ViewBuild = { id: "3D", lines, min: lines.min, max: lines.max, scale: sc, dims: [], kind: "iso", title: "ASSEMBLED VIEW" };
    const b = placeView(v, 0, 0, new Occupied());
    titleUnder(b, b.views[0], "3D", "ASSEMBLED VIEW", sc, "NOT DIMENSIONED");
    const spot = space.find(blockW(b) + 10, blockH(b) + 10, "tl");
    if (!spot) continue;
    blocks.push({ b, x: spot[0] + 5 - b.box[0], y: spot[1] + 5 - b.box[1] });
    break;
  }
  return { blocks, subtitle: "COVER SHEET AND DRAWING INDEX" };
}

/** Where a sheet's blocks go: packed from the top left, in a few orders (as given first); null if they don't all fit. */
function layPage(bs: Block[]): P2[] | null {
  const areaW = AREA[2] - AREA[0],
    areaH = AREA[3] - AREA[1];
  const idx = bs.map((_, i) => i);
  const orders = [idx, [...idx].sort((a, b) => blockH(bs[b]) - blockH(bs[a])), [...idx].sort((a, b) => blockW(bs[b]) - blockW(bs[a])), [...idx].sort((a, b) => blockW(bs[b]) * blockH(bs[b]) - blockW(bs[a]) * blockH(bs[a]))];
  const seen = new Set<string>();
  for (const ord of orders) {
    const key = ord.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const sp = new Space(AREA);
    const pos: P2[] = new Array(bs.length);
    let ok = true;
    for (const i of ord) {
      const b = bs[i];
      const w = blockW(b),
        h = blockH(b);
      // room round each, less when it's nearly as wide (or tall) as the sheet
      const pw = Math.min(8, Math.max(0, areaW - w)),
        ph = Math.min(8, Math.max(0, areaH - h));
      const spot = sp.find(w + pw, h + ph, "tl");
      if (!spot) {
        ok = false;
        break;
      }
      pos[i] = [spot[0] + pw / 2 - b.box[0], spot[1] + ph / 2 - b.box[1]];
      sp.fillBlock(moveBlock(b, pos[i][0], pos[i][1]), 3);
    }
    if (ok) return pos;
  }
  return null;
}



type Page = { blocks: { b: Block; x: number; y: number }[]; subtitle: string };

/**
 * The views he asked for (19.3), from what's kept with the drawing: a section through a named part or the whole piece's
 * middle (across or along it), marked with a cutting line; a detail of where two named parts meet, seen from a side;
 * a standard detail drawn bigger; a 3D view, assembled or pulled apart, of the whole piece or named parts. One that no
 * longer fits the model (a part renamed away) is left out. Sizes on an extra detail that a standard one gives are in
 * brackets; sections and 3D views carry no sizes (the part views and details do).
 */
function planExtras(ctx: Ctx, views: ExtraView[]): { list: { id: string; label: string; viewId?: string; group?: string }[]; blocks: { variants: Block[]; base: number }[] } {
  const list: { id: string; label: string; viewId?: string; group?: string }[] = [];
  const blocks: { variants: Block[]; base: number }[] = [];
  let li = ctx.joints.types.filter((t) => t.letter).length;
  let n3 = 0;
  const areaW = AREA[2] - AREA[0],
    areaH = AREA[3] - AREA[1];
  const named = (xs?: string[]) => (xs?.length ? partsNamed(ctx, xs) : []);
  const variantsOf = (make: (s: number) => Block | null) => {
    const vs: { s: number; b: Block }[] = [];
    for (const sc of SCALES) {
      const b = make(sc);
      if (b && blockW(b) <= areaW && blockH(b) <= areaH * 0.8) vs.push({ s: sc, b });
    }
    if (!vs.length) return null;
    // its own: the largest that takes no more than half the sheet each way
    let own = vs.findIndex((x) => blockW(x.b) <= areaW * 0.6 && blockH(x.b) <= areaH * 0.55);
    if (own < 0) own = vs.length - 1;
    const ordered = [...vs].reverse();
    return { variants: ordered.map((x) => x.b), base: ordered.length - 1 - own };
  };
  for (const v of views) {
    if (v.kind === "bigger" || v.kind === "detail") {
      const a = named(v.parts?.slice(0, 1)),
        b = named(v.parts?.slice(1, 2));
      const jb = a.length && b.length ? jointBetween(ctx.joints, a, b) : null;
      if (!jb) continue;
      if (v.kind === "bigger") {
        // (a detail he asked for, seen from a side, drawn larger: that one; else the standard detail)
        const jd = v.from ? ctx.jds.find((x) => !!x.extra && x.type === jb.type && x.sub?.endsWith(FROM[v.from!].words)) : ctx.jds.find((x) => x.type === jb.type && !x.extra);
        if (!jd) continue;
        jd.bigger = (jd.bigger ?? 0) + 1;
        list.push({ id: v.id, label: `Detail ${jd.letter} drawn larger`, group: jd.letter });
        continue;
      }
      const letter = LETTERS[li++ % LETTERS.length];
      const f = FROM[v.from ?? "above"];
      const jd = planOne(ctx, jb.type, jb.inst, letter, { normal: f.c, flip: f.sign < 0, given: ctx.jkeys });
      jd.title = jb.type.title;
      jd.sub = `${jb.type.name}, ${f.words}`;
      jd.extra = v.id;
      ctx.jds.push(jd);
      list.push({ id: v.id, label: `Detail ${letter}`, group: letter });
      continue;
    }
    if (v.kind === "section") {
      const ps = named(v.parts);
      if (v.parts?.length && !ps.length) continue;
      const letter = LETTERS[li++ % LETTERS.length];
      const b = ctx.bbox;
      const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2] as V3;
      let axis: number;
      let at = c;
      let what: string;
      if (ps.length) {
        // through the middle of the part: across it (cutting its length), or along it (through its width)
        const p = ctx.parts[ps[0]];
        const pb = ctx.built.parts[p.index].bbox;
        at = [(pb.min[0] + pb.max[0]) / 2, (pb.min[1] + pb.max[1]) / 2, (pb.min[2] + pb.max[2]) / 2];
        const ax = axesOf(p);
        const pick = v.way === "along" ? ax[2] : ax[0];
        axis = [0, 1, 2].find((i) => Math.abs(pick[i]) > 0.9) ?? 0;
        what = `THROUGH THE ${ctx.marks[p.mark - 1]?.label ?? "PART"}, ${v.way === "along" ? "ALONG IT" : "ACROSS IT"}`;
      } else {
        // through the middle of the piece: across its length, or along it
        const long = b.max[0] - b.min[0] >= b.max[1] - b.min[1] ? 0 : 1;
        axis = v.way === "along" ? 1 - long : long;
        what = `THROUGH THE MIDDLE, ${v.way === "along" ? "ALONG" : "ACROSS"}`;
      }
      const n: V3 = axis === 2 ? [0, 0, 1] : axis === 1 ? [0, -1, 0] : [1, 0, 0];
      const up: V3 = axis === 2 ? [0, 1, 0] : [0, 0, 1];
      const inPlane = [0, 1, 2].filter((i) => i !== axis);
      const d: Detail = { letter, count: 1, plane: { n, w: dot(n, at) }, up, at, halfSpan: Math.max(...inPlane.map((i) => (b.max[i] - b.min[i]) / 2)), marks: [], window: b, title: what };
      ctx.details.push(d);
      const vs = variantsOf((sc) => extraSection(ctx, d, sc));
      if (vs) blocks.push(vs);
      list.push({ id: v.id, label: `Section ${letter}-${letter}`, viewId: letter });
      continue;
    }
    // a 3D view
    const ps = named(v.parts);
    if (v.parts?.length && !ps.length) continue;
    const id = `V${++n3}`;
    const vs = variantsOf((sc) => extra3d(ctx, id, ps.length ? ps : ctx.parts.map((p) => p.index), v.apart ?? false, sc));
    if (vs) blocks.push(vs);
    list.push({ id: v.id, label: `3D view ${id}`, viewId: id });
  }
  return { list, blocks };
}

/** A section he asked for: the whole piece cut by the plane, hatched, titled, no sizes. */
function extraSection(ctx: Ctx, d: Detail, scale: number): Block {
  const lines = cached(ctx, `xs-${d.letter}`, () => drawSection(ctx.built, d.plane, d.up));
  const vd = viewFrom([-d.plane.n[0], -d.plane.n[1], -d.plane.n[2]], d.up);
  const styles = hatchStyles(ctx, lines, d.plane.n, vd);
  const v: ViewBuild = { id: d.letter, lines, min: lines.min, max: lines.max, scale, dims: [], hatch: (p) => styles.get(p) ?? null, kind: "section", title: `SECTION ${d.letter}-${d.letter}` };
  const b = placeView(v, 0, 0, new Occupied());
  for (const h of lines.hatches) {
    const p = ctx.parts[h.part];
    b.legend.add(hatchFor(p.material, Math.abs(dot(axesOf(p)[0], d.plane.n)) > 0.9, ctx.spec(p)).key);
  }
  titleUnder(b, b.views[0], d.letter, `SECTION ${d.letter}-${d.letter}`, scale, "SIZES ON PARTS AND DETAILS", d.title);
  return b;
}

/** A 3D view he asked for: these parts, assembled or pulled apart the way the model pulls apart, no sizes. */
function extra3d(ctx: Ctx, id: string, parts: number[], apart: boolean, scale: number): Block {
  const keep = new Set(parts);
  const sub: BuiltModel = { ...ctx.built, parts: ctx.built.parts.map((p, i) => (keep.has(i) ? p : { ...p, polys: [] })) };
  const shift = new Map<number, V3>();
  if (apart) ctx.built.parts.forEach((p, i) => shift.set(i, p.apart));
  const lines = cached(ctx, `x3-${id}-${apart}`, () => drawView(prepare(sub, shift), ISO, { hidden: false }));
  const title = apart ? "PULLED APART" : "3D VIEW";
  const v: ViewBuild = { id, lines, min: lines.min, max: lines.max, scale, dims: [], kind: "iso", title, role: "extra" };
  const b = placeView(v, 0, 0, new Occupied());
  const names = [...new Set(parts.map((i) => ctx.marks[ctx.parts[i].mark - 1]?.label).filter(Boolean))];
  titleUnder(b, b.views[0], id, title, scale, "NOT DIMENSIONED", names.length < ctx.marks.length ? andList(names).slice(0, 60) : undefined);
  return b;
}

/**
 * The hidden lines on a set's arrangement views, now and as Stage 12 drew them (every member's outline edge that's
 * hidden), as total length in model millimetres: for the check that the rule in 19.4 makes the arrangement clearer.
 */
export function gaHiddenLengths(set: DrawingSet): { now: number; before: number; others: number } {
  const dirOf: Record<string, ViewDir> = { "FRONT ELEVATION": VIEWS.front, PLAN: VIEWS.top, "SIDE ELEVATION": VIEWS.right };
  const len = (pts: P2[], closed?: boolean) => {
    let t = 0;
    for (let i = 0; i + 1 < pts.length + (closed ? 1 : 0); i++) t += Math.hypot(pts[(i + 1) % pts.length][0] - pts[i][0], pts[(i + 1) % pts.length][1] - pts[i][1]);
    return t;
  };
  let now = 0,
    before = 0,
    others = 0;
  const keep = stockEdges(set.model, set.built);
  const prep = prepare(set.built);
  for (const sh of set.sheets)
    for (const v of sh.meta.views) {
      if (v.kind !== "ga" || !dirOf[v.title]) continue;
      for (const p of sh.prims) if (p.view === v.id && p.layer === "HIDDEN") now += (p.t === "line" ? Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) : p.t === "poly" ? len(p.pts, p.closed) : 0) / v.k;
      const old = drawView(prep, dirOf[v.title], { hidden: true, keepHidden: keep });
      for (const c of old.chains) if (c.kind === "hidden") before += len(c.pts, c.closed);
      // the same rule without the joint outlines at the markers
      const rule = drawView(prep, dirOf[v.title], { hidden: true, keepHidden: keep, sparseHidden: true });
      for (const c of rule.chains) if (c.kind === "hidden") others += len(c.pts, c.closed);
    }
  return { now, before, others };
}

/** All the sheets for a model. */
/**
 * The joint schedule's JOINT BY cell (19.7, with 20.2's sources, joined at the merge): his joint AS DIRECTED; the
 * assistant's SUGGESTED, CONFIRM, and under it where its proportions came from, in a few words: the design rule and
 * its book ("TENON 1/3 OF RAIL, FAIRHAM"), a rule not confirmed on the shelf said so, or with no rule the drafter's own
 * judgement. Bolts are spaced by a rule of thumb with no source, so a sourced suggestion that has them says so too.
 */
function jointBy(t: JointType) {
  if (t.by === "owner") return "AS DIRECTED";
  const named = (t.rules ?? []).map(scheduleLabel).filter((x): x is string => !!x);
  const bolted = t.insts.some((j) => j.fixings.some((f) => f.kind === "bolt"));
  const basis = named.length ? [...named.slice(0, 2), ...(bolted ? ["BOLTS BY RULE OF THUMB"] : [])] : ["DRAFTER'S JUDGEMENT"];
  return ["SUGGESTED, CONFIRM", ...basis].join("\n");
}

export function makeSet(inp: SetInput): DrawingSet {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const built = buildModel(inp.model);
  const { parts, marks } = analyseParts(inp.model, built);
  // every joint, grouped into types (19.1); a detail for each type (19.2)
  const joints = findAllJoints(inp.model, built, parts, marks);
  // whose each joint is, and how it's held in his words where the model doesn't say (19.7)
  applyDesign(joints, inp.model.design, inp.model, parts);
  const suggested = joints.types.some((t) => t.by === "assistant");
  const sourced = joints.types.some((t) => t.by === "assistant" && t.rules?.some((id) => scheduleLabel(id)));
  const bbox = emptyBox();
  for (const p of built.parts) if (p.polys.length) (grow(bbox, p.bbox.min), grow(bbox, p.bbox.max));
  // what each part is made of, as said; a code for each when the set has more than one (keyed to the legend)
  const spec = (p: PartInfo) => materialOf(inp.materials, p);
  const specs = [...new Set(marks.map((mk) => spec(mk.first)))];
  const code = new Map<string, string>(specs.length > 1 ? specs.map((x, i) => [x, `M${i + 1}`]) : []);
  const ctx: Ctx = { m: inp.model, built, parts, marks, joints, bbox, details: [], jds: [], jfeats: new Map(), jkeys: new Set(), keepHidden: stockEdges(inp.model, built), cache: new Map(), spec, code };
  ctx.jds = planJointDetails(ctx);
  ctx.jfeats = detailedFeatures(ctx, ctx.jds);
  for (const jd of ctx.jds) jd.keys.forEach((k) => ctx.jkeys.add(k));
  // the views he asked for (19.3), lettered after the standard details
  const extras = planExtras(ctx, inp.views ?? []);
  const areaW = AREA[2] - AREA[0],
    areaH = AREA[3] - AREA[1];
  const pages: Page[] = [];
  const later: { b: Block; kind: "part" | "detail" | "ga"; sub?: string }[] = [];

  // --- the general arrangement: three ways, the one with the largest scale for the front and plan wins ---
  const sched = scheduleBlock(ctx, 165);
  // a long parts list gets a sheet of its own after the arrangement (plan 12.3.1)
  const schedOnGA = blockH(sched) <= areaH * 0.45;
  type Try = { scale: number; rank: number; page: Page; extra: Block[] };
  let best: Try | null = null;
  // the plan alone leads only for something mostly seen from above (a pergola, a deck); else the front leads
  const sz = [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]];
  const planLed = sz[0] * sz[1] > 1.15 * sz[0] * sz[2];
  const arrangements: { rank: number; first: GAName[]; rest: GAName[][] }[] = [
    { rank: 0, first: ["front", "top", "side"], rest: [] },
    { rank: 1, first: ["front", "top"], rest: [["side"]] },
    { rank: 2, first: ["front", "side"], rest: [["top"]] },
    ...(planLed ? [{ rank: 3, first: ["top"] as GAName[], rest: [["front", "side"], ["front"], ["side"]] as GAName[][] }] : []),
  ];
  for (const scale of SCALES) {
    if (best && SCALES.indexOf(scale as (typeof SCALES)[number]) > best.rank + 1) break;
    for (const arr of arrangements) {
      const taken = new Set<string>();
      ctx.gaFirst = arr.first;
      const ortho = orthoBlock(ctx, scale, arr.first, taken, [...arr.first, ...arr.rest.flat()]);
      if (blockW(ortho) > areaW || blockH(ortho) + 0 > areaH) continue;
      const at: P2 = [AREA[0] - ortho.box[0], AREA[1] - ortho.box[1]];
      const ob = moveBlock(ortho, at[0], at[1]);
      // the schedule mustn't sit on the views
      const hit = (a: Box, b: Box) => a[0] < b[2] + 4 && b[0] < a[2] + 4 && a[1] < b[3] + 4 && b[1] < a[3] + 4;
      // the schedule top right, as the template has it; top left only if that's what lets the 3D view on this sheet
      let schedAt: P2 | null = null;
      let iso: { b: Block; x: number; y: number } | null = null;
      for (const corner of schedOnGA ? (["tr", "tl"] as const) : (["tr"] as const)) {
        const sAt: P2 = corner === "tr" ? [AREA[2] - blockW(sched) - sched.box[0], AREA[3] - sched.box[3]] : [AREA[0] - sched.box[0], AREA[3] - sched.box[3]];
        const sb = moveBlock(sched, sAt[0], sAt[1]);
        if (schedOnGA && (ob.views.some((v) => hit(v.box, sb.box)) || ob.prims.some((p) => hit(primBox(p), sb.box)))) continue;
        const space = new Space(AREA);
        space.fillBlock(ob);
        if (schedOnGA) space.fillBlock(sb);
        if (!schedAt) schedAt = sAt;
        // the 3D view: the largest standard scale, no larger than the views', that has room; else it goes with the rest
        // (at most four times smaller than the arrangement's: a thumbnail is no use, it goes on a later sheet instead)
        // (one standard scale larger than the views' when there's room: a sparse sheet gets a bigger 3D view, 12.10)
        const up = SCALES.filter((x) => x < scale).slice(-1);
        for (const s of [...up, ...SCALES.filter((x) => x >= scale && x <= 4 * scale)]) {
          for (const [ring, spread, pad] of [["all", 1, 9], ["tb", 1, 9], ["lr", 1, 9], ["all", 0.55, 9], ["tb", 0.55, 9], ["lr", 0.55, 9], ["tb", 0.55, 6], ["lr", 0.55, 6]] as const) {
            const ib = isoBlock(ctx, s, ring, spread, pad);
            const spot = space.find(blockW(ib) + 3, blockH(ib) + 3, "tr");
            if (spot) {
              iso = { b: ib, x: spot[0] + 1.5 - ib.box[0], y: spot[1] + 1.5 - ib.box[1] };
              break;
            }
          }
          if (iso || (s >= scale && s >= 2 * scale + 1)) break;
        }
        if (iso) {
          schedAt = sAt;
          break;
        }
      }
      if (!schedAt) continue;
      let isoLater: Block | null = null;
      if (!iso) {
        for (const s of SCALES.filter((x) => x >= scale)) {
          const ib = isoBlock(ctx, s, "all");
          if (blockW(ib) <= areaW && blockH(ib) <= areaH * 0.7) {
            isoLater = ib;
            break;
          }
        }
        if (!isoLater) continue;
      }
      // what didn't go on the first sheet, each a block at the same scale (front and side together if they fit)
      const extra: Block[] = [];
      let ok = true;
      for (const group of arr.rest) {
        if (group.some((g) => extra.some((e) => e.views.some((v) => v.title.startsWith(g === "front" ? "FRONT" : g === "side" ? "SIDE" : "PLAN"))))) continue;
        const trial = new Set(taken);
        const eb = orthoBlock(ctx, scale, group, trial, [...arr.first, ...arr.rest.flat()]);
        if (blockW(eb) > areaW || blockH(eb) > areaH) {
          if (group.length === 1) ok = false;
          continue;
        }
        extra.push(eb);
        trial.forEach((l) => taken.add(l));
      }
      if (!ok) continue;
      if (isoLater) extra.push(isoLater);
      // lower is better: a step down in scale costs 1, each view pushed off the arrangement sheet 0.6
      // (a plan pushed off it costs twice: the plan carries the overall sizes, 12.10)
      const rank = SCALES.indexOf(scale as (typeof SCALES)[number]) + extra.reduce((t, e) => t + (e.views.some((v) => v.title === "PLAN") ? 1.2 : 0.6), 0) + 0.05 * arr.rank;
      const tryIt: Try = { scale, rank, page: { blocks: [{ b: ortho, x: at[0], y: at[1] }, ...(schedOnGA ? [{ b: sched, x: schedAt[0], y: schedAt[1] }] : []), ...(iso ? [iso] : [])], subtitle: "GENERAL ARRANGEMENT" }, extra };
      if (!best || rank < best.rank) best = tryIt;
    }
  }
  if (!best) throw new Error("the general arrangement won't fit on A3");
  pages.push(best.page);
  // --- the rest: a long schedule, views off the arrangement, part views (the same part under different names drawn
  //     once), the details; each at a few scales, so a sheet can be filled at the largest that fits (12.10) ---
  type Item = { variants: Block[]; cur: number; kind: "schedule" | "part" | "detail" | "ga"; order: number };
  const items: Item[] = [];
  if (!schedOnGA) items.push({ variants: [sched], cur: 0, kind: "schedule", order: items.length });
  for (const e of best.extra) items.push({ variants: [e], cur: 0, kind: "ga", order: items.length });
  // sections and 3D views he asked for go with the parts, at the scales they fit
  for (const x of extras.blocks) items.push({ variants: x.variants, cur: x.base, kind: "ga", order: items.length });
  // the other sub-assemblies' pulled-apart views (19.4), each at the scales it fits, on the sheets after
  for (const sb of (ctx.subs ??= subAssemblies(ctx)).slice(1)) {
    const vs = [...SCALES].reverse().map((sc) => isoBlock(ctx, sc, "all", 1, 9, sb)).filter((b) => blockW(b) <= areaW && blockH(b) <= areaH * 0.8);
    if (!vs.length) continue;
    const own = vs.map((b, i) => ({ b, i })).filter((x) => blockW(x.b) <= areaW * 0.6 && blockH(x.b) <= areaH * 0.55).pop()?.i ?? 0;
    items.push({ variants: vs, cur: own, kind: "ga", order: items.length });
  }
  const groups = new Map<string, Mark[]>();
  for (const mk of marks) {
    const k = `${mk.shape}|${spec(mk.first)}`;
    groups.set(k, [...(groups.get(k) ?? []), mk]);
  }
  for (const g of groups.values()) {
    const v = partVariants(ctx, g, areaW, areaH);
    items.push({ variants: v.blocks, cur: v.base, kind: "part", order: items.length });
  }
  const blk = (i: number) => items[i].variants[items[i].cur];
  const titledIn = (b: Block) => b.views.filter((v) => v.title).length;
  const titledOf = (pg: number[]) => pg.reduce((t, i) => t + titledIn(blk(i)), 0);
  const fillOf = (pg: number[]) => pg.reduce((t, i) => t + blockW(blk(i)) * blockH(blk(i)), 0) / (areaW * areaH);
  const fits = (pg: number[]) => titledOf(pg) <= 5 && layPage(pg.map(blk)) !== null;
  // first fit, in order: two to five views a sheet (B2)
  let sheetsL: number[][] = [];
  items.forEach((_, i) => {
    const pg = sheetsL.find((q) => fits([...q, i]));
    if (pg) pg.push(i);
    else sheetsL.push([i]);
  });
  // a sheet under 40% used goes: its views onto the others (smaller, down to their own scale, if that's what fits)
  // the arrangement sheet takes views too, in its free space: up to five titled views on it, or eight when that makes
  // the whole set one sheet ("small pieces may put parts and details on one sheet")
  let onGA: number[] = [];
  const gaBlocks = pages[0].blocks.map((bl) => moveBlock(bl.b, bl.x, bl.y));
  const gaTitled = gaBlocks.reduce((t, b) => t + titledIn(b), 0);
  const gaPlace = (extra: number[], cap: number): P2[] | null => {
    if (gaTitled + extra.reduce((t, i) => t + titledIn(blk(i)), 0) > cap) return null;
    const sp = new Space(AREA);
    gaBlocks.forEach((b) => sp.fillBlock(b, 4));
    const pos: P2[] = [];
    for (const i of extra) {
      const b = blk(i);
      const spot = sp.find(blockW(b) + 8, blockH(b) + 8, "tl");
      if (!spot) return null;
      const q: P2 = [spot[0] + 4 - b.box[0], spot[1] + 4 - b.box[1]];
      pos.push(q);
      sp.fillBlock(moveBlock(b, q[0], q[1]), 3);
    }
    return pos;
  };
  // everything on the one sheet, if it all goes (smaller, down to each view's own scale, if that's what fits)
  {
    const all = items.map((_, i) => i);
    const was = items.map((it) => it.cur);
    if (gaPlace(all, 8)) ((onGA = all), (sheetsL = []));
    else {
      items.forEach((it) => (it.cur = 0));
      if (gaPlace(all, 8)) ((onGA = all), (sheetsL = []));
      else items.forEach((it, i) => (it.cur = was[i]));
    }
  }
  const mergeSheets = () => {
    for (let pi = sheetsL.length - 1; pi >= 0; pi--) {
      if (fillOf(sheetsL[pi]) >= 0.4) continue;
      const trial = sheetsL.map((q) => [...q]);
      let ga = [...onGA];
      const was = items.map((it) => it.cur);
      let ok = true;
      for (const i of sheetsL[pi]) {
        let put = false;
        for (let v = items[i].cur; v >= 0 && !put; v--) {
          items[i].cur = v;
          for (let qi = 0; qi < trial.length && !put; qi++)
            if (qi !== pi && fits([...trial[qi], i].sort((a, b) => a - b))) {
              trial[qi].push(i);
              trial[qi].sort((a, b) => a - b);
              put = true;
            }
          if (!put && gaPlace([...ga, i], 5)) {
            ga = [...ga, i];
            put = true;
          }
        }
        // or make room: a view from another sheet onto the arrangement sheet, this one in its place
        if (!put) {
          items[i].cur = was[i];
          for (let qi = 0; qi < trial.length && !put; qi++) {
            if (qi === pi) continue;
            for (const j of [...trial[qi]].sort((a, b) => blockW(blk(a)) * blockH(blk(a)) - blockW(blk(b)) * blockH(blk(b)))) {
              const rest = trial[qi].filter((x) => x !== j);
              if (!gaPlace([...ga, j], 5) || !fits([...rest, i].sort((a, b) => a - b))) continue;
              ga = [...ga, j];
              trial[qi] = [...rest, i].sort((a, b) => a - b);
              put = true;
              break;
            }
          }
        }
        if (!put) {
          ok = false;
          break;
        }
      }
      if (ok) {
        trial.splice(pi, 1);
        sheetsL = trial;
        onGA = ga;
      } else items.forEach((it, i) => (it.cur = was[i]));
    }
  };
  // then each sheet's views as large as will go (a larger standard scale), while the sheet is under 60% used: those of a
  // kind drawn smallest go up a scale together, so like parts on a sheet stay at one scale
  const scaleOf = (i: number) => blk(i).views[0]?.scale ?? 1;
  const enlarge = () => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const pg of sheetsL) {
        if (fillOf(pg) >= 0.6) continue;
        for (const kind of ["part", "detail"] as const) {
          const mine = pg.filter((i) => items[i].kind === kind);
          const can = mine.filter((i) => items[i].cur + 1 < items[i].variants.length);
          if (!can.length) continue;
          const level = Math.max(...can.map(scaleOf));
          if (mine.some((i) => scaleOf(i) === level && !can.includes(i))) continue;
          const grp = can.filter((i) => scaleOf(i) === level);
          grp.forEach((i) => items[i].cur++);
          if (fits(pg) && fillOf(pg) <= 0.85) {
            changed = true;
            break;
          }
          grp.forEach((i) => items[i].cur--);
        }
      }
    }
    // a sheet still well under half used: any one view larger, the biggest gain first (scales may then differ)
    for (let changed = true; changed; ) {
      changed = false;
      for (const pg of sheetsL) {
        if (fillOf(pg) >= 0.45) continue;
        const order = pg.filter((i) => items[i].cur + 1 < items[i].variants.length).sort((a, b) => blockW(blk(b)) * blockH(blk(b)) - blockW(blk(a)) * blockH(blk(a)));
        for (const i of order) {
          items[i].cur++;
          if (fits(pg) && fillOf(pg) <= 0.85) {
            changed = true;
            break;
          }
          items[i].cur--;
        }
      }
    }
  };
  // a sheet still under 40% that can't go: a view from another sheet joins it, if both then come out at 40% or more
  const rebalance = () => {
    for (let pi = 0; pi < sheetsL.length; pi++) {
      if (fillOf(sheetsL[pi]) >= 0.4) continue;
      let done = false;
      for (let qi = 0; qi < sheetsL.length && !done; qi++) {
        if (qi === pi) continue;
        for (const j of [...sheetsL[qi]]) {
          const keep = sheetsL.map((q) => [...q]);
          const was = items.map((it) => it.cur);
          const P = [...sheetsL[pi], j].sort((a, b) => a - b),
            Q = sheetsL[qi].filter((x) => x !== j);
          if (!Q.length || !fits(P) || !fits(Q)) continue;
          sheetsL[pi] = P;
          sheetsL[qi] = Q;
          enlarge();
          if (fillOf(sheetsL[pi]) >= 0.4 && fillOf(sheetsL[qi]) >= 0.4) {
            done = true;
            break;
          }
          sheetsL = keep;
          items.forEach((it, i) => (it.cur = was[i]));
        }
      }
    }
  };
  mergeSheets();
  enlarge();
  mergeSheets();
  enlarge();
  rebalance();
  // laid out from the top left, then the whole group centred on the sheet
  const nameOf = (it: Item) => (it.kind === "schedule" ? "PARTS SCHEDULE" : it.kind === "part" ? "PARTS" : it.kind === "detail" ? "DETAILS" : it.variants[0].views[0]?.kind === "iso" ? "EXPLODED VIEW" : (it.variants[0].views.map((v) => v.title).join(" AND ") || "ELEVATIONS"));
  const subtitleOf = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} AND ${names[names.length - 1]}` : names[0]);
  if (onGA.length) {
    const pos = gaPlace(onGA, sheetsL.length ? 5 : 8)!;
    onGA.forEach((i, k) => pages[0].blocks.push({ b: blk(i), x: pos[k][0], y: pos[k][1] }));
    pages[0].subtitle = subtitleOf([...new Set(["GENERAL ARRANGEMENT", ...onGA.map((i) => nameOf(items[i]))])]);
  }
  for (const pg of sheetsL) {
    const bs = pg.map(blk);
    const pos = layPage(bs)!;
    const u: Box = [Infinity, Infinity, -Infinity, -Infinity];
    bs.forEach((b, i) => growBox(u, mvBox(b.box, pos[i][0], pos[i][1])));
    const dx = (AREA[0] + AREA[2]) / 2 - (u[0] + u[2]) / 2,
      dy = (AREA[1] + AREA[3]) / 2 - (u[1] + u[3]) / 2;
    const at = pos.map((q) => [q[0] + dx, q[1] + dy] as P2);
    // each row of views centred across the sheet too (a short row isn't left at the left), where nothing's in the way
    const boxOf = (i: number): Box => mvBox(bs[i].box, at[i][0], at[i][1]);
    const rows: number[][] = [];
    for (const i of bs.map((_, k) => k).sort((a, b) => boxOf(b)[3] - boxOf(a)[3])) {
      const bi = boxOf(i);
      const row = rows.find((r) => r.some((j) => {
        const bj = boxOf(j);
        return Math.min(bi[3], bj[3]) - Math.max(bi[1], bj[1]) > 0.4 * Math.min(bi[3] - bi[1], bj[3] - bj[1]);
      }));
      if (row) row.push(i);
      else rows.push([i]);
    }
    for (const r of rows) {
      const rb = r.map(boxOf).reduce((m, x) => [Math.min(m[0], x[0]), Math.min(m[1], x[1]), Math.max(m[2], x[2]), Math.max(m[3], x[3])] as Box);
      const sx = (AREA[0] + AREA[2]) / 2 - (rb[0] + rb[2]) / 2;
      if (Math.abs(sx) < 1) continue;
      const moved = r.map((i) => mvBox(boxOf(i), sx, 0));
      const others = bs.map((_, k) => k).filter((k) => !r.includes(k)).map(boxOf);
      if (moved.some((m) => m[0] < AREA[0] || m[2] > AREA[2] || others.some((o) => o[0] < m[2] + 3 && m[0] < o[2] + 3 && o[1] < m[3] + 3 && m[1] < o[3] + 3))) continue;
      for (const i of r) at[i] = [at[i][0] + sx, at[i][1]];
    }
    pages.push({ blocks: bs.map((b, i) => ({ b, x: at[i][0], y: at[i][1] })), subtitle: subtitleOf([...new Set(pg.map((i) => nameOf(items[i])))]) });
  }

  // --- the joint details on their own sheets, the joint schedule heading the first (19.2.5, 19.2.6) ---
  const jsched = joints.types.length ? jointSchedule(ctx, areaW, inp.model.design ? { head: "JOINT BY", cells: new Map(joints.types.map((t) => [t.index, jointBy(t)])) } : undefined) : null;
  if (ctx.jds.length || jsched) {
    const dItems = ctx.jds.map((jd) => {
      const v = jointVariants(ctx, jd, areaW, areaH - (jsched ? 0 : 0));
      return { blocks: v.blocks, cur: v.base, floor: v.floor };
    });
    for (const dp of detailPages(AREA, jsched, dItems)) pages.push(dp);
  }

  // a set of four sheets or more gets a cover sheet with the drawing index (12.10)
  if (pages.length >= 4) {
    const of0 = pages.length + 1;
    pages.unshift(coverPage(ctx, inp, [{ sheet: `1/${of0}`, title: "COVER SHEET AND DRAWING INDEX" }, ...pages.map((pg, i) => ({ sheet: `${i + 2}/${of0}`, title: pg.subtitle }))]));
  }

  // --- each sheet: the blocks, the frame, the scale bar, the column ---
  const of = pages.length;
  // where each section and joint detail is, and where each is marked: for the bubbles' sheet numbers both ways
  const detailSheet = new Map<string, number>();
  const markSheet = new Map<string, number>();
  pages.forEach((pg, i) =>
    pg.blocks.forEach((bl) => {
      bl.b.views.forEach((v) => (v.kind === "section" ? detailSheet.set(v.id, i + 1) : v.group && v.role !== "extra" ? detailSheet.set(v.group, i + 1) : undefined));
      bl.b.markers.forEach((m) => markSheet.set(m.letter, i + 1));
    }),
  );
  const fillToken = (s: string) => s.replace(/^#([DG])([A-Z]{1,2})$/, (_, w: string, l: string) => String((w === "D" ? detailSheet : markSheet).get(l) ?? "–"));
  let logoAt: [number, number, number, number] = [0, 0, 0, 0];
  const sheets: Sheet[] = pages.map((pg, i) => {
    const prims: Prim[] = [];
    const meta: SheetMeta = { number: inp.number, revision: inp.revision, sheet: i + 1, of, title: `${inp.title} – ${pg.subtitle}`, scaleText: "", views: [], dims: [], markers: [], balloons: [], fields: {}, revisions: inp.revisions, notes: [] };
    const legend = new Set<string>();
    meta.blocks = [];
    if (i === 0 && pages.length >= 5 && pg.subtitle.startsWith("COVER")) meta.cover = true;
    for (const bl of pg.blocks) {
      const mb = moveBlock(bl.b, bl.x, bl.y);
      meta.blocks.push(mb.box);
      prims.push(...mb.prims.map((p) => (p.t === "text" && p.s.startsWith("#") ? { ...p, s: fillToken(p.s) } : p)));
      meta.views.push(...mb.views);
      meta.dims.push(...mb.dims);
      meta.balloons.push(...mb.balloons);
      for (const m of mb.markers) meta.markers.push({ letter: m.letter, toSheet: detailSheet.get(m.letter) ?? 0, view: m.view, ...(m.at ? { at: m.at, r: m.r } : {}) });
      mb.legend.forEach((x) => legend.add(x));
    }
    const scales = [...new Set(meta.views.map((v) => v.scale))].sort((a, b) => a - b);
    // the main scale: the one most of the drawing is at (the 3D view doesn't count)
    const area = new Map<number, number>();
    for (const v of meta.views) if (v.kind !== "iso") area.set(v.scale, (area.get(v.scale) ?? 0) + (v.box[2] - v.box[0]) * (v.box[3] - v.box[1]));
    const main = [...area.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? scales[0] ?? 1;
    meta.scaleText = scales.length === 1 ? `1:${scales[0]}` : "AS SHOWN";
    const onSched = pg.blocks.some((bl) => bl.b === sched);
    if (onSched) meta.schedule = marks.map((mk) => ({ mark: mk.mark, qty: mk.qty, T: mk.first.T, W: mk.first.W, L: mk.first.L, material: spec(mk.first) }));
    if (jsched && pg.blocks.some((bl) => bl.b === jsched)) meta.jointSchedule = joints.types.map((t) => ({ detail: t.letter, places: t.insts.length, kind: t.kind }));
    prims.push({ t: "poly", pts: [[FRAME[0], FRAME[1]], [FRAME[2], FRAME[1]], [FRAME[2], FRAME[3]], [FRAME[0], FRAME[3]]], closed: true, w: W.border, layer: "BORDER" });
    prims.push(...scaleBar([AREA[0], FRAME[1] + 4], main));
    // one rule for the grain where it covers every part: a general note (the arrows show it on each part too)
    const grained = marks.filter((mk) => mk.first.grain !== null && !grainless(spec(mk.first)));
    const notes = [...STANDING(inp), ...(grained.length && grained.every((mk) => mk.first.grain === 0) ? ["GRAIN TO RUN ALONG THE LENGTH OF EACH PART UNLESS SHOWN."] : []), ...(suggested ? [`JOINTS MARKED SUGGESTED, CONFIRM ARE THE DRAFTER'S SUGGESTION AND ARE TO BE CONFIRMED BY THE BUILDER.${sourced ? " A BOOK NAMED UNDER ONE IS FOR ITS PROPORTIONS, NOT ITS STRENGTH." : ""}`] : []), ...(inp.notes ?? []).map((n) => n.toUpperCase())];
    const all = prims.filter((p): p is Text => p.t === "text").map((p) => p.s);
    const abbrev: string[] = [];
    if (all.some((s) => /REQ'D/.test(s))) abbrev.push("REQ'D  REQUIRED");
    if (all.some((s) => /\bTHRO\b/.test(s))) abbrev.push("THRO  RIGHT THROUGH");
    if (all.some((s) => /\bTHK\b/.test(s))) abbrev.push("THK  THICKNESS");
    if (all.some((s) => /\bCRS\b/.test(s))) abbrev.push("CRS  CENTRES");
    if (all.some((s) => /Ø/.test(s))) abbrev.push("Ø  DIAMETER");
    // the material codes in use here (all of them beside the schedule)
    const used = new Set([...legend].filter((k) => k.startsWith("mat:")).map((k) => k.slice(4)));
    const mats = [...code.entries()].filter(([, c]) => onSched || used.has(c)).map(([m, c]) => [c, m] as [string, string]);
    const hatches = [...legend].filter((k) => k in LEGEND_LABEL);
    const col = column({ notes, legend: hatches, abbrev, materials: mats, grain: legend.has("grain") }, inp, i + 1, of, pg.subtitle, meta.scaleText);
    logoAt = col.logoAt;
    prims.push(...col.prims);
    meta.notes = notes;
    meta.fields = { company: inp.company ?? "", project: inp.project, client: inp.client, title: meta.title, number: inp.number, sheet: `${i + 1}/${of}`, scale: meta.scaleText, size: "A3", date: inp.date, drawn: inp.drawn, checked: inp.checked ?? "", revision: inp.revision, status: inp.status };
    return { prims, meta };
  });
  const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  // where each view he asked for ended up
  const sheetOf = (pred: (v: ViewMeta) => boolean) => sheets.find((sh) => sh.meta.views.some(pred))?.meta.sheet ?? 0;
  const out = extras.list.map((x) => ({ id: x.id, label: x.label, sheet: sheetOf((v) => v.id === x.viewId || (!!x.group && v.group === x.group)) }));
  const set = { model: inp.model, sheets, parts, marks, built, ms, logoAt, joints, details: ctx.jds, extras: out };
  if (inp.additions) applyAdded(set, inp.additions);
  return set;
}
