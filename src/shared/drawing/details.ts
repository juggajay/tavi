// Joint details (Stage 19.2): every joint type gets a detail, lettered A, B, C... at 1:1 or 1:2 (1:5 only for big
// framing joints), in one dashed frame:
//   - a section through the middle of the joint, the pieces hatched differently, its sizes dimensioned (depth, length,
//     thickness, shoulders, the gap at the bottom, the set-out from the end and face): one chain each way, all the joint's
//     stations on it, so the joint reads as the maker sets it out;
//   - a second section at right angles, when the joint is a different shape that way (a tenon's width and its shoulders,
//     a haunch, a stopped housing's length);
//   - a small pulled-apart 3D view of just that joint: the pieces cropped round it and pulled apart the way they go
//     together, each with its part number, no sizes;
//   - the fixing called up with a leader ("2 / M12 x 90 BOLTS", "GLUED", "FIXING TBC").
// Each type is marked once on the general arrangement with a detail bubble (letter over sheet), TYP when there are more.
// A joint schedule heads the first JOINT DETAILS sheet. A size on a detail is given there only; the part views point to
// it ("SEE DETAIL B") and show it in brackets where it's part of their set-out. Everything comes from the model.
import type { ModelPayload } from "../protocol.js";
import type { BuiltModel } from "../model3d/build.js";
import { type Box3, type V3, apply, dot, emptyBox, grow, invert, norm } from "../model3d/math.js";
import { intersect } from "../model3d/csg.js";
import { solidPolys } from "../model3d/solids.js";
import { type ViewDir, type ViewLines, drawSection, drawView, partEdges, viewFrom } from "./hlr.js";
import type { Mark, PartInfo } from "./parts.js";
import { AXIS, type JointInst, type JointSet, type JointType, axisOf, boxCentre3, boxInter3, drawAxis, jointAndList, roundFixing, toModelBox } from "./joints.js";
import { type DimSpec, Occupied, type Side, bestSide, cornerAt, footAt, leaderNote } from "./dims.js";
import { type Block, type ViewBuild, addPrims, blockH, blockW, clipLines, emptyBlock, growBox, key, merge, moveBlock, mvBox, placeView, primBox, r1 } from "./blocks.js";
import { type Box, DASH, type P2, type Prim, TH, type Text, W, textBox, textWidth, wrap } from "./prims.js";
import { type HatchStyle, type Placement, balloon, clipPoly, hatchFor, text, toPage } from "./render.js";

/** What the details need from the set being made. */
export type DCtx = {
  m: ModelPayload;
  built: BuiltModel;
  parts: PartInfo[];
  marks: Mark[];
  bbox: Box3;
  joints: JointSet;
  spec: (p: PartInfo) => string;
  cache: Map<string, ViewLines>;
};

/** A section of a detail: the plane (n points at the viewer, the near side taken away), which way is up on paper. */
export type DView = { id: string; role: "section" | "second"; n: V3; w: number; up: V3; caption: string; dims: DimSpec[]; feetFix: { at: P2; s: string } | null };

export type JointDetail = {
  letter: string;
  type: JointType;
  inst: JointInst;
  /** The crop, in the model. */
  window: Box3;
  /** The parts drawn in its sections: the joint's, and any let into them there (a leg's other apron). */
  drawn: Set<number>;
  views: DView[];
  /** Pulled apart: each joint part's move, and where the 3D view looks from. */
  shift: Map<number, V3>;
  cam: V3;
  /** The keys of the sizes it gives (part frames), so the part views don't give them again. */
  keys: Set<string>;
  /** Asked for bigger (19.3): its scale is at least this many steps up from the one it would get. */
  bigger?: number;
  /** A detail he asked for (19.3): its own title and words under it, and which asked-for view it is. */
  title?: string;
  sub?: string;
  extra?: string;
};

const ext = (b: Box3, i: number) => b.max[i] - b.min[i];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const SCALES_DETAIL = [1, 2, 5, 10, 20] as const;
const AXN = ["x", "y", "z"];

/** Where a section is looked at from: a plan section from above, others from the front or the right, z up. */
function orient(c: number): { n: V3; up: V3 } {
  if (c === 2) return { n: [0, 0, 1], up: [0, 1, 0] };
  if (c === 1) return { n: [0, -1, 0], up: [0, 0, 1] };
  return { n: [1, 0, 0], up: [0, 0, 1] };
}
const viewOf = (n: V3, up: V3): ViewDir => viewFrom([-n[0], -n[1], -n[2]], up);
/** Where a section plane is along its own axis. */
const planeCoord = (v: { n: V3; w: number }) => v.w * v.n[axisOf(v.n)];
/** The fixings lying in a section's plane (a bolt cut along its length). */
function fixingsIn(ctx: DCtx, jd: { inst: JointInst }, v: { n: V3; w: number }) {
  return jd.inst.fixings.filter((f) => {
    const ax = axisOf(drawAxis(ctx.parts[f.part], 0));
    return ax >= 0 && Math.abs(dot(AXIS[ax], v.n)) < 0.5 && Math.abs(boxCentre3(ctx.built.parts[f.part].bbox)[axisOf(v.n)] - planeCoord(v)) < 1;
  });
}

/** The pulled-apart view looks into the opening the guest comes out of, a little from the front or right, and above
 *  (below, for a notch over something: the cut is underneath). */
function camFor(d: V3): V3 {
  const di = axisOf(d);
  if (di === 2) return norm([0.55, -0.65, 0.55 * Math.sign(d[2])]);
  const s: V3 = di === 0 ? [0, -1, 0] : [1, 0, 0];
  return norm([0.42 * d[0] + 0.78 * s[0], 0.42 * d[1] + 0.78 * s[1], 0.5]);
}

/* ---------------- planning: one detail per joint type ---------------- */

export function planJointDetails(ctx: DCtx): JointDetail[] {
  const out: JointDetail[] = [];
  for (const t of ctx.joints.types) {
    if (!t.letter) continue;
    // the instance drawn: one whose host is the part drawn on its part view, so the sizes' keys agree with that view
    const inst = t.insts.find((j) => ctx.marks[ctx.parts[j.host].mark - 1]?.first.index === j.host) ?? t.insts[0];
    out.push(planOne(ctx, t, inst, t.letter));
  }
  return out;
}

export function planOne(ctx: DCtx, t: JointType, inst: JointInst, letter: string, opts: { normal?: number; flip?: boolean; bigger?: number; given?: Set<string> } = {}): JointDetail {
  const P = ctx.parts;
  const bb = (i: number) => ctx.built.parts[i].bbox;
  const di = axisOf(inst.d);
  const cr = [0, 1, 2].filter((i) => i !== di);
  const members = inst.parts.filter((i) => !inst.fixings.some((f) => f.part === i));
  const guest = inst.guests[0];
  // the window: the joint, the small sections of its parts whole, a stub of what runs on
  const core: Box3 = { min: [...inst.region.min] as V3, max: [...inst.region.max] as V3 };
  const win: Box3 = { min: [...core.min] as V3, max: [...core.max] as V3 };
  // (a scarf: along the members only the splice and what holds it, however short the pieces either side)
  const scarf = inst.kind === "scarf";
  const L = axisOf(drawAxis(P[inst.host], 0));
  for (const pi of inst.parts)
    for (let i = 0; i < 3; i++)
      if (!(scarf && i === L) && ext(bb(pi), i) <= Math.max(130, 1.6 * ext(core, i))) {
        win.min[i] = Math.min(win.min[i], bb(pi).min[i]);
        win.max[i] = Math.max(win.max[i], bb(pi).max[i]);
      }
  const span = Math.max(...[0, 1, 2].map((i) => ext(win, i)));
  const pad = clamp(0.12 * span, 8, 45);
  for (let i = 0; i < 3; i++) {
    win.min[i] -= pad;
    win.max[i] += pad;
  }
  // the guest runs out along d at least most of its own section
  if (di >= 0) {
    const sec = Math.max(...cr.map((i) => ext(bb(guest), i)));
    const stub = clamp(0.45 * sec, 25, 90);
    const hb = bb(inst.host);
    if (inst.d[di] > 0) win.max[di] = Math.max(win.max[di], hb.max[di] + stub);
    else win.min[di] = Math.min(win.min[di], hb.min[di] - stub);
    // and the host its whole depth that way (a rafter over its notch), or a stub of it
    const hstub = ext(hb, di) <= 300 ? ext(hb, di) : clamp(0.45 * Math.max(...cr.map((i) => ext(hb, i))), 25, 90);
    if (inst.d[di] > 0) win.min[di] = Math.min(win.min[di], Math.max(hb.min[di], hb.max[di] - hstub));
    else win.max[di] = Math.max(win.max[di], Math.min(hb.max[di], hb.min[di] + hstub));
  }
  for (let i = 0; i < 3; i++) {
    win.min[i] = Math.max(win.min[i], ctx.bbox.min[i]);
    win.max[i] = Math.min(win.max[i], ctx.bbox.max[i]);
  }
  // drawn in the sections: the joint's parts, and parts let into them inside the window (the other apron in a leg)
  const drawn = new Set<number>(inst.parts);
  for (const p of P) {
    if (drawn.has(p.index) || !ctx.built.parts[p.index].polys.length) continue;
    if (!boxInter3(bb(p.index), win)) continue;
    const into = members.some((m) => {
      const o = boxInter3(bb(p.index), bb(m));
      return o && [0, 1, 2].every((i) => o.max[i] - o.min[i] > 0.5);
    });
    if (into) drawn.add(p.index);
  }
  // the sections: through the middle, across the cut's longest way (a tenon's width, a housing's length), so its depth
  // and thickness show; at right angles when the joint's shape changes that way
  const meas = inst.hostCut ?? inst.contact;
  let c1 = cr[0];
  if (cr.length === 2) {
    const e0 = ext(meas, cr[0]),
      e1 = ext(meas, cr[1]);
    if (Math.abs(e0 - e1) > 0.5) c1 = e0 > e1 ? cr[0] : cr[1];
    else {
      const gl = axisOf(drawAxis(P[guest], 0)),
        ht = axisOf(drawAxis(P[inst.host], 1));
      c1 = cr.includes(gl) ? gl : cr.includes(ht) ? ht : cr[0];
    }
  }
  // a scarf: its profile (the splay, the nibs, the table, the bolts), looking across it: neither along the members nor
  // the way its halves step
  if (scarf && cr.length === 2) c1 = cr.find((i) => i !== L) ?? cr[0];
  if (opts.normal !== undefined) c1 = opts.normal;
  const c2 = [0, 1, 2].find((i) => i !== c1 && i !== di) ?? (c1 + 1) % 3;
  const inside = boxInter3(bb(guest), bb(inst.host)) ?? inst.contact;
  const mid = boxCentre3(boxInter3(inside, inst.region) ?? inst.contact);
  const planeAt = (c: number) => {
    // through a bolt or a peg lying in that plane, else the middle of the joint
    for (const f of inst.fixings) {
      if (!roundFixing(f)) continue;
      const ax = axisOf(drawAxis(P[f.part], 0));
      if (ax >= 0 && ax !== c) return boxCentre3(bb(f.part))[c];
    }
    return mid[c];
  };
  const views: DView[] = [];
  const mk = (c: number, role: DView["role"], caption: string) => {
    const o0 = orient(c);
    // (seen from the other side, when asked: from below, from the back, from the left)
    const o = opts.flip && c === opts.normal ? { n: [-o0.n[0], -o0.n[1], -o0.n[2]] as V3, up: o0.up } : o0;
    views.push({ id: `${letter}${views.length + 1}`, role, n: o.n, w: dot(o.n, [0, 0, 0].map((_, i) => (i === c ? planeAt(c) : 0)) as V3), up: o.up, caption, dims: [], feetFix: null });
  };
  mk(c1, "section", "SECTION THROUGH JOINT");
  // a second section: the joint is a different shape that way (a tenon's shoulders or haunch, a stopped cut)
  const s = inst.sizes;
  const tenonShoulders = (s.shU1 ?? 0) > 0.05 || (s.shU2 ?? 0) > 0.05;
  const stopped = !!inst.hostCut && ext(inst.hostCut, c1) < ext(bb(inst.host), c1) - 0.05 && inst.kind !== "butt";
  const lapStopped = inst.kind === "halving" && ext(inst.contact, c1) < ext(bb(guest), c1) - 0.05;
  // (a scarf: across it through a bolt, the key or the plates, when it has them)
  const second = inst.kind === "scarf" ? inst.fixings.length > 0 : tenonShoulders || inst.haunched || stopped || lapStopped;
  if (opts.normal === undefined && di >= 0 && inst.kind !== "butt" && second) mk(c2, "second", "SECTION AT RIGHT ANGLES");
  // pulled apart: the guest out along d, a fixing out along its own axis towards the viewer
  const cam = camFor(di >= 0 ? inst.d : [0, 0, 1]);
  const shift = new Map<number, V3>();
  // (a scarf's half comes off sideways, clear of the other by most of its depth)
  const off = inst.kind === "scarf" && di >= 0 ? clamp(1.2 * ext(bb(guest), di), 40, 140) : clamp(1.4 * (s.len ?? 20) + 15, 30, 140);
  for (const g of inst.guests) shift.set(g, [inst.d[0] * off, inst.d[1] * off, inst.d[2] * off]);
  for (const f of inst.fixings) {
    // a key, a wedge or a plate: out the way the model pulls it apart, clear of what it sits against
    const ap = ctx.m.parts[f.part].apart;
    const apl = ap ? Math.hypot(ap[0], ap[1], ap[2]) : 0;
    if (!roundFixing(f) && ap && apl > 0) {
      const dist = f.kind === "plate" ? 1.5 * f.d + 40 : f.len * 0.8 + 20;
      shift.set(f.part, [(ap[0] / apl) * dist, (ap[1] / apl) * dist, (ap[2] / apl) * dist]);
      continue;
    }
    const ax = drawAxis(P[f.part], 0);
    const sg = dot(ax, cam) >= 0 ? 1 : -1;
    const dist = f.len * 0.8 + 20;
    shift.set(f.part, [ax[0] * sg * dist, ax[1] * sg * dist, ax[2] * sg * dist]);
  }
  const jd: JointDetail = { letter, type: t, inst, window: win, drawn, views, shift, cam, keys: new Set(), ...(opts.bigger ? { bigger: opts.bigger } : {}) };
  for (const v of views) planDims(ctx, jd, v);
  // each way's sizes once in the detail: in the view that shows that way with the most stations
  type PD = DimSpec & { axis: number; owners: string[] };
  for (const a of [0, 1, 2]) {
    const per = views.map((v) => ({ v, n: (v.dims as PD[]).filter((d) => d.axis === a).reduce((t, d) => t + d.stations.length, 0) })).filter((x) => x.n > 0);
    if (per.length < 2) continue;
    const best = per.reduce((x, y) => (y.n > x.n ? y : x));
    for (const x of per) if (x !== best) x.v.dims = (x.v.dims as PD[]).filter((d) => d.axis !== a);
  }
  // a size another view of this detail already gives: in brackets there
  // (a detail he asked for gives in brackets what the standard details already give)
  const given = new Set<string>(opts.given ?? []);
  for (const v of views)
    for (const d of v.dims as PD[]) {
      const st = d.stations;
      const order = st.map((x, i) => ({ x, i })).sort((p, q) => p.x - q.x);
      d.owners = d.owners.filter((k) => {
        if (!given.has(k)) return true;
        const i = d.keys.indexOf(k);
        if (i >= 0 && i + 1 < order.length) (d.refSegs ??= []).push([order[i].x, order[i + 1].x]);
        return false;
      });
      d.owners.forEach((k) => given.add(k));
    }
  // a second section that gives no size of its own repeats the first (a halving seen from its other side): left out
  if (opts.normal === undefined && views.length === 2 && views[1].role === "second" && !(views[1].dims as PD[]).some((d) => d.owners.length)) views.pop();
  for (const v of views) for (const d of v.dims as PD[]) for (const k of d.owners) jd.keys.add(k);
  return jd;
}

/** The section's linework: only the parts drawn, cut by the plane. */
function sectionLines(ctx: DCtx, jd: JointDetail, v: DView): ViewLines {
  return (
    ctx.cache.get(`jd-${jd.letter}-${v.id}`) ??
    (() => {
      // (a part let into the joint's parts but not cut by this plane is left out: only its far edges would show, running
      // off through the crop, as a post's did behind a lap)
      const ax = axisOf(v.n);
      const cutHere = (i: number) => jd.inst.parts.includes(i) || ax < 0 || (ctx.built.parts[i].bbox.min[ax] < planeCoord(v) - 0.01 && ctx.built.parts[i].bbox.max[ax] > planeCoord(v) + 0.01);
      const sub: BuiltModel = { ...ctx.built, parts: ctx.built.parts.map((p, i) => (jd.drawn.has(i) && cutHere(i) ? p : { ...p, polys: [] })) };
      const l = drawSection(sub, { n: v.n, w: v.w }, v.up);
      ctx.cache.set(`jd-${jd.letter}-${v.id}`, l);
      return l;
    })()
  );
}

/** The section's crop on paper (model 2D): the window, down to what's drawn inside it. */
function sectionClip(ctx: DCtx, jd: JointDetail, v: DView, lines: ViewLines, margin: number): [number, number, number, number] {
  const vd = viewOf(v.n, v.up);
  const P = (p: V3): P2 => [dot(p, vd.right), dot(p, vd.up)];
  const cs: P2[] = [];
  for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) cs.push(P([i ? jd.window.max[0] : jd.window.min[0], j ? jd.window.max[1] : jd.window.min[1], k ? jd.window.max[2] : jd.window.min[2]]));
  const win: [number, number, number, number] = [Math.min(...cs.map((c) => c[0])), Math.min(...cs.map((c) => c[1])), Math.max(...cs.map((c) => c[0])), Math.max(...cs.map((c) => c[1]))];
  const seen = clipLines(lines, win).chains.flatMap((c) => c.pts);
  if (!seen.length) return win;
  return [Math.max(win[0], Math.min(...seen.map((q) => q[0])) - margin), Math.max(win[1], Math.min(...seen.map((q) => q[1])) - margin), Math.min(win[2], Math.max(...seen.map((q) => q[0])) + margin), Math.min(win[3], Math.max(...seen.map((q) => q[1])) + margin)];
}

/**
 * A section's sizes (19.2.2), from the model's cuts, never from the picture:
 *   - along the way the joint goes together: the guest's chain from where it enters (its shoulder) through its own cuts
 *     (a haunch) to its end, with that whole length outside it when there's more than one step (the tenon's length); and
 *     on the other side the host's cut, from the same face to its bottom (the mortise's depth; the gap is the difference);
 *   - across it: one chain through every station of the joint's parts there (faces inside the crop, the sides of their
 *     cuts in the joint, hole centres), so shoulders, tenon, mortise and set-out from the face read as one line.
 * A size between two stations of one part is that part's (keyed in its own frame, as its part view keys them; across the
 * part it also carries where along the part the joint is, since the same cut at another place is another size); a part's
 * own whole width or thickness is on its part view, so here it's in brackets; a size already in this detail, in brackets.
 */
type St = { s: number; owners: Set<number>; cut: Set<number>; foot?: [number, number] };
type PlannedDim = DimSpec & { axis: number; owners: string[]; fixFeet?: boolean[] };

function planDims(ctx: DCtx, jd: JointDetail, v: DView) {
  const P = ctx.parts;
  const inst = jd.inst;
  const vd = viewOf(v.n, v.up);
  const lines = sectionLines(ctx, jd, v);
  const clip = sectionClip(ctx, jd, v, lines, 0);
  const clipped = clipLines(lines, clip);
  const members = inst.parts.filter((i) => !inst.fixings.some((f) => f.part === i));
  const inWin = (s: number, a: number) => s >= jd.window.min[a] - 0.01 && s <= jd.window.max[a] + 0.01;
  const di = axisOf(inst.d);
  const host = inst.host,
    guest = inst.guests[0];
  const hb = ctx.built.parts[host].bbox;
  const fixIn = fixingsIn(ctx, jd, v);
  // an extension line's foot: on an edge across the way measured; a scarf's also from a corner (where a splay meets a nib)
  const corners = inst.kind === "scarf";
  // (a scarf along its members: its sizes are the joint's, between its ends and bolts, not one part's; its halves are
  // often one part number, mirrored, so a part's frame would give the same size twice)
  const scarfL = corners ? axisOf(drawAxis(P[host], 0)) : -1;
  const ft = (side: Side, s: number) => footAt(clipped, side, s) ?? (corners ? cornerAt(clipped, side, s) : null);
  // where along a part the joint is (its drawing frame's length), for the keys of sizes across the part
  const posOf = (pi: number) => Math.round(apply(P[pi].modelToDraw, boxCentre3(inst.contact))[0]);
  const keyOf = (pi: number, a: number, s0: number, s1: number) => {
    const p = P[pi];
    const b = axisFor(p, a);
    const pt = (s: number) => {
      const q: V3 = [...boxCentre3(ctx.built.parts[pi].bbox)] as V3;
      q[a] = s;
      return apply(p.modelToDraw, q)[b];
    };
    return `${key(`part${p.mark}`, AXN[b], pt(s0), pt(s1))}${b === 0 ? "" : `@${posOf(pi)}`}`;
  };
  const wholeOf = (pi: number, a: number, s0: number, s1: number) => {
    const b = ctx.built.parts[pi].bbox;
    return Math.abs(Math.min(s0, s1) - b.min[a]) < 0.05 && Math.abs(Math.max(s0, s1) - b.max[a]) < 0.05;
  };
  const add = (st: St[], s: number, p: number, a: number, foot?: [number, number], cut = false) => {
    if (!inWin(s, a)) return;
    const e = st.find((x) => Math.abs(x.s - s) < 0.05);
    if (e) {
      if (p >= 0) e.owners.add(p);
      if (p >= 0 && cut) e.cut.add(p);
      if (foot !== undefined && e.foot === undefined) e.foot = foot;
    } else st.push({ s, owners: new Set(p >= 0 ? [p] : []), cut: new Set(p >= 0 && cut ? [p] : []), ...(foot !== undefined ? { foot } : {}) });
  };
  // a part's stations along a model axis: its faces in the crop (or none), its cuts in the joint, its hole centres
  const stationsOf = (st: St[], pi: number, a: number, side: Side, o: { faces?: boolean; within?: Box3 } = {}) => {
    const p = P[pi];
    const b = ctx.built.parts[pi].bbox;
    if (o.faces !== false) {
      add(st, b.min[a], pi, a);
      add(st, b.max[a], pi, a);
    }
    for (const fi of inst.feats.get(pi) ?? []) {
      const f = p.features[fi];
      const mb0 = boxInter3(toModelBox(p, f.box), jd.window);
      const mb = mb0 && o.within ? boxInter3(mb0, o.within) : mb0;
      if (!mb) continue;
      if (f.hole) {
        const hc = apply(invert(p.modelToDraw), f.hole.c);
        if (axisOf(drawAxis(p, f.hole.axis)) === a) continue;
        const fx = fixIn.find((x) => Math.abs(boxCentre3(ctx.built.parts[x.part].bbox)[a] - hc[a]) < 0.5);
        if (fx) {
          // a hole cut along its length here: the foot is at its fixing's centre line's end
          const fb = ctx.built.parts[fx.part].bbox;
          const across = side === "below" || side === "above" ? vd.up : vd.right;
          const ca = axisOf(across);
          const ends = [fb.min[ca] * across[ca], fb.max[ca] * across[ca]];
          add(st, hc[a], pi, a, [Math.min(...ends), Math.max(...ends)], true);
        } else if (Math.abs(dot(drawAxis(p, f.hole.axis), v.n)) > 0.99) add(st, hc[a], pi, a, undefined, true);
        continue;
      }
      // (a side the crop made, where the cut runs on past the window, is no side of the cut)
      const raw = toModelBox(p, f.box);
      if (raw.min[a] >= jd.window.min[a] - 0.01 || o.within) add(st, mb.min[a], pi, a, undefined, true);
      if (raw.max[a] <= jd.window.max[a] + 0.01 || o.within) add(st, mb.max[a], pi, a, undefined, true);
    }
  };
  const chain = (st: St[], side: Side, a: number, opts: { tier?: number; overall?: boolean; flexSide?: boolean } = {}): PlannedDim | null => {
    const hor = side === "below" || side === "above";
    const sg = (hor ? vd.right : vd.up)[a];
    const lowSide = side === "below" || side === "left";
    const sorted = [...st].sort((x, y) => x.s - y.s);
    const ok = sorted.filter((x) => x.foot !== undefined || ft(side, sg * x.s) !== null);
    if (ok.length < 2) return null;
    const keys: string[] = [];
    const owners: string[] = [];
    const refSegs: [number, number][] = [];
    for (let i = 0; i + 1 < ok.length; i++) {
      const A = ok[i],
        B = ok[i + 1];
      const both = [...A.owners].filter((p) => B.owners.has(p));
      const ks = a === scarfL ? [] : both.map((pi) => keyOf(pi, a, A.s, B.s));
      const k = ks[0] ?? key(`joint${jd.letter}`, `${v.id}${AXN[a]}`, A.s, B.s);
      if (a === scarfL) ks.push(k);
      keys.push(k);
      // a part's own whole size (on its part view) is for reference only here, unless it's also a cut's size (a housing
      // as wide as the shelf in it)
      const cutHere = [...A.cut].some((pi) => B.cut.has(pi));
      const whole = !cutHere && both.some((pi) => wholeOf(pi, a, A.s, B.s));
      if (whole) refSegs.push([sg * A.s, sg * B.s]);
      else owners.push(...ks);
    }
    if (refSegs.length === keys.length && !opts.overall) return null; // nothing of its own to say
    const hasFoot = corners || ok.some((x) => x.foot !== undefined);
    return {
      side,
      stations: ok.map((x) => sg * x.s),
      keys,
      partial: true,
      tier: opts.tier ?? 0,
      ...(refSegs.length ? { refSegs } : {}),
      ...(hasFoot ? { feet: ok.map((x) => (x.foot !== undefined ? (lowSide ? x.foot[0] : x.foot[1]) : (ft(side, sg * x.s) ?? undefined))), fixFeet: ok.map((x) => x.foot !== undefined) } : opts.flexSide === false ? {} : { flex: true }),
      axis: a,
      owners,
    };
  };
  for (const [side, dir] of [
    ["below", vd.right],
    ["left", vd.up],
  ] as const) {
    const a = axisOf(dir);
    if (a < 0) continue;
    if (a === di && guest !== undefined) {
      // along the way it goes in: the guest from where it enters, and the host's cut from the same face
      const entry = inst.d[di] > 0 ? hb.max[di] : hb.min[di];
      const len = inst.sizes.len ?? 0;
      const end = entry - Math.sign(inst.d[di]) * len;
      const inHost: Box3 = { min: [...hb.min] as V3, max: [...hb.max] as V3 };
      const G: St[] = [];
      add(G, entry, -1, a);
      if (len > 0.05) add(G, end, guest, a);
      stationsOf(G, guest, a, side, { faces: false, within: inHost });
      for (const x of G) if (Math.abs(x.s - entry) < 0.05) x.owners.add(guest);
      const H: St[] = [];
      add(H, entry, host, a);
      stationsOf(H, host, a, side, { faces: false });
      // where the guest's stations are the host cut's edges too (a back as thick as its rebate is deep), they're the cut's
      for (const x of G) {
        const h = H.find((y) => Math.abs(y.s - x.s) < 0.05);
        if (h) (h.owners.forEach((p) => x.owners.add(p)), h.cut.forEach((p) => x.cut.add(p)));
      }
      // the host's cut from the entry face to its deepest (the mortise's depth in one size), and hole centres; what the
      // guest's chain already gives, left out
      const deep = H.filter((x) => x.cut.size).reduce<St | null>((m, x) => (!m || Math.abs(x.s - entry) > Math.abs(m.s - entry) ? x : m), null);
      const Hx = H.filter((x) => Math.abs(x.s - entry) < 0.05 || x === deep || x.foot !== undefined).filter((x) => Math.abs(x.s - entry) < 0.05 || !G.some((y) => Math.abs(y.s - x.s) < 0.05));
      const gside = bestSideFor(G, side, a);
      const g = chain(G, gside, a, { flexSide: false });
      if (g) v.dims.push(g);
      if (g && G.length > 2) {
        const o = chain(
          G.filter((x) => Math.abs(x.s - entry) < 0.05 || Math.abs(x.s - end) < 0.05),
          gside,
          a,
          { tier: 1, flexSide: false },
        );
        if (o) v.dims.push(o);
      }
      if (Hx.length >= 2) {
        const h = chain(Hx, g ? (gside === "below" ? "above" : gside === "left" ? "right" : side) : side, a, { flexSide: !g });
        if (h) v.dims.push(h);
      }
      continue;
    }
    const st: St[] = [];
    for (const pi of members) stationsOf(st, pi, a, side);
    if (a === scarfL)
      for (const pi of members) {
        // a scarf's two ends (a plain scarf's cut is one long face, so its ends are no cut's sides)
        add(st, inst.contact.min[a], pi, a, undefined, true);
        add(st, inst.contact.max[a], pi, a, undefined, true);
      }
    // fishplates: their faces (their thickness in a section across them, their ends along the members)
    for (const f of inst.fixings) if (f.kind === "plate") stationsOf(st, f.part, a, side);
    const c = chain(st, side, a);
    if (c) v.dims.push(c);
    // a scarf's whole length outside its chain (the bolts' spacing inside it)
    if (c && inst.kind === "scarf" && inst.sizes.splice !== undefined && Math.abs(inst.contact.max[a] - inst.contact.min[a] - inst.sizes.splice) < 0.05 && st.length > 2) {
      const ends = st.filter((x) => Math.abs(x.s - inst.contact.min[a]) < 0.05 || Math.abs(x.s - inst.contact.max[a]) < 0.05);
      const o = ends.length === 2 ? chain(ends, c.side, a, { tier: 1, overall: true, flexSide: false }) : null;
      if (o) v.dims.push(o);
    }
  }
  // the fixing's call-up: on a fixing lying in the plane, else at the joint
  if (v.role === "section") {
    const at = fixIn.length ? boxCentre3(ctx.built.parts[fixIn[0].part].bbox) : boxCentre3(inst.contact);
    const p2: P2 = [dot(at, vd.right), dot(at, vd.up)];
    // (each fixing on its own line: "2 / FOLDING WEDGES" over "2 / M12 BOLTS")
    v.feetFix = { at: p2, s: inst.fixNote.split(" + ").join("\n") };
  }

  /** The side whose extension lines are shorter for these stations (fixed, so the host's chain can take the other). */
  function bestSideFor(st: St[], side: Side, a: number): Side {
    const sg = (side === "below" || side === "above" ? vd.right : vd.up)[a];
    const ok = st.filter((x) => ft(side, sg * x.s) !== null);
    if (ok.length < 2) return side;
    return bestSide({ side, stations: ok.map((x) => sg * x.s), keys: [], flex: true }, clipped);
  }
}

/** The part's drawing axis that runs along a model axis. */
function axisFor(p: PartInfo, a: number): number {
  for (let b = 0; b < 3; b++) if (Math.abs(p.modelToDraw.r[b * 3 + a]) > 0.99) return b;
  return 0;
}

/* ---------------- drawing a detail ---------------- */

/** The hatch for each part cut in a section: by material, across or along its grain; touching parts that look alike
 *  are turned (as Stage 12's sections). */
export function hatchStyles(ctx: DCtx, lines: ViewLines, n: V3, vd: ViewDir): Map<number, HatchStyle> {
  const styles = new Map<number, HatchStyle>();
  for (const h of lines.hatches) {
    const p = ctx.parts[h.part];
    const g = drawAxis(p, 0);
    const hf = hatchFor(p.material, Math.abs(dot(g, n)) > 0.9, ctx.spec(p));
    const st: HatchStyle = { ...hf.style };
    if (hf.style.along) st.angle = (Math.atan2(dot(g, vd.up), dot(g, vd.right)) * 180) / Math.PI;
    styles.set(h.part, st);
  }
  const hs = lines.hatches;
  const touches = (a: P2[][], b: P2[][]) => a.some((la) => la.some((p) => b.some((lb) => onEdge(p, lb))));
  for (let i = 0; i < hs.length; i++)
    for (let j = 0; j < i; j++) {
      const a = styles.get(hs[i].part)!,
        b = styles.get(hs[j].part)!;
      const sameAngle = Math.abs((((a.angle - b.angle) % 180) + 180) % 180) < 1;
      if (!sameAngle || a.gap !== b.gap || !!a.cross !== !!b.cross) continue;
      if (!touches(hs[i].loops, hs[j].loops)) continue;
      styles.set(hs[i].part, a.along ? { ...a, gap: a.gap * 0.6 } : { ...a, angle: a.angle + 90 });
    }
  return styles;
}
function onEdge(p: P2, loop: P2[]) {
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i],
      b = loop[(i + 1) % loop.length];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    if (!L2) continue;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    if (t < -1e-6 || t > 1 + 1e-6) continue;
    if (Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) < 0.01) return true;
  }
  return false;
}

/** Break lines where the crop cuts through a part (it carries on): a thin line along the cut edge with a Z in it. */
function breakLines(lines: ViewLines, pl: Placement, clip: Box, view: string): Prim[] {
  const out: Prim[] = [];
  const onSide = (p: P2) => [Math.abs(p[0] - clip[0]) < 1e-6 ? 0 : -1, Math.abs(p[1] - clip[1]) < 1e-6 ? 1 : -1, Math.abs(p[0] - clip[2]) < 1e-6 ? 2 : -1, Math.abs(p[1] - clip[3]) < 1e-6 ? 3 : -1].filter((x) => x >= 0);
  const seen = new Set<string>();
  for (const h of lines.hatches)
    for (const l of h.loops) {
      const poly = clipPoly(
        l.map((p) => toPage(pl, p)),
        clip,
      );
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i],
          b = poly[(i + 1) % poly.length];
        const sa = onSide(a),
          sb = onSide(b);
        const side = sa.find((x) => sb.includes(x));
        if (side === undefined) continue;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.5) continue;
        const k = `${a[0].toFixed(2)},${a[1].toFixed(2)},${b[0].toFixed(2)},${b[1].toFixed(2)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const t: P2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        const nn: P2 = [-t[1], t[0]];
        const m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const z = Math.min(1.6, len / 6);
        const pts: P2[] =
          len > 5
            ? [a, [m[0] - t[0] * z, m[1] - t[1] * z], [m[0] - t[0] * (z / 3) + nn[0] * 1.4, m[1] - t[1] * (z / 3) + nn[1] * 1.4], [m[0] + t[0] * (z / 3) - nn[0] * 1.4, m[1] + t[1] * (z / 3) - nn[1] * 1.4], [m[0] + t[0] * z, m[1] + t[1] * z], b]
            : [a, b];
        out.push({ t: "poly", pts, w: W.thin, layer: "SYMBOLS", view });
      }
    }
  return out;
}

/** A section view of a detail at a scale, ready to place. */
function sectionView(ctx: DCtx, jd: JointDetail, v: DView, scale: number): ViewBuild {
  const lines = sectionLines(ctx, jd, v);
  const vd = viewOf(v.n, v.up);
  const clip = sectionClip(ctx, jd, v, lines, 4 * scale);
  const styles = hatchStyles(ctx, lines, v.n, vd);
  // a fixing lying in the plane: its centre line, past its ends
  const P = ctx.parts;
  const fixIn = fixingsIn(ctx, jd, v);
  // a fixing's centre line runs 3 paper mm past its end: the foot of a size to its centre is there
  const dims = v.dims.map((d) => {
    const ff = (d as DimSpec & { fixFeet?: boolean[] }).fixFeet;
    const low = d.side === "below" || d.side === "left";
    return d.feet && ff ? { ...d, feet: d.feet.map((f, i) => (f !== undefined && ff[i] ? f + (low ? -3 : 3) * scale : f)) } : d;
  });
  return {
    id: v.id,
    lines,
    min: lines.min,
    max: lines.max,
    scale,
    dims,
    hatch: (part) => styles.get(part) ?? null,
    clip,
    kind: "detail",
    title: v.caption,
    frame: false,
    group: jd.letter,
    role: v.role,
    leaders: v.feetFix ? [{ at: v.feetFix.at, s: v.feetFix.s }] : [],
    draw: (pl) => {
      const out: Prim[] = [];
      const page: Box = [toPage(pl, [clip[0], clip[1]])[0], toPage(pl, [clip[0], clip[1]])[1], toPage(pl, [clip[2], clip[3]])[0], toPage(pl, [clip[2], clip[3]])[1]];
      out.push(...breakLines(lines, pl, page, v.id));
      for (const f of fixIn) {
        const b = ctx.built.parts[f.part].bbox;
        const ax = axisOf(drawAxis(P[f.part], 0));
        const a3: V3 = boxCentre3(b),
          b3: V3 = boxCentre3(b);
        a3[ax] = b.min[ax];
        b3[ax] = b.max[ax];
        const A = toPage(pl, [dot(a3, vd.right), dot(a3, vd.up)]),
          B = toPage(pl, [dot(b3, vd.right), dot(b3, vd.up)]);
        const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        const t: P2 = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
        out.push({ t: "line", a: [A[0] - t[0] * 3, A[1] - t[1] * 3], b: [B[0] + t[0] * 3, B[1] + t[1] * 3], w: W.thin, dash: DASH.centre, layer: "CENTRE", view: v.id });
      }
      return out;
    },
  };
}

/** The pulled-apart 3D view: the joint's parts cropped to the window and moved apart, part numbers on them. */
function apartView(ctx: DCtx, jd: JointDetail, scale: number): ViewBuild {
  const id = `${jd.letter}${jd.views.length + 1}`;
  const lines =
    ctx.cache.get(`jd-${jd.letter}-apart`) ??
    (() => {
      // the window, but a long run (a groove the height of a door, a housing the depth of a carcass) only a short way
      // either side of the section, so the 3D view stays small
      const w: Box3 = { min: [...jd.window.min] as V3, max: [...jd.window.max] as V3 };
      // (how big the joint is across: its own region's two smaller sizes)
      const cross = Math.max(...[0, 1, 2].map((i) => ext(jd.inst.region, i)).sort((x, y) => x - y).slice(0, 2));
      const c = boxCentre3(jd.inst.contact);
      const at = jd.views.length ? planeCoord(jd.views[0]) : 0;
      // (a scarf's whole splice shows: the window is already just the splice and its bolts and plates)
      const L = jd.inst.kind === "scarf" ? axisOf(drawAxis(ctx.parts[jd.inst.host], 0)) : -1;
      for (let i = 0; i < 3; i++) {
        const lim = Math.max(60, 1.5 * cross);
        if (ext(w, i) <= 2 * lim || i === L) continue;
        const mid = jd.views[0] && axisOf(jd.views[0].n) === i ? at : c[i];
        w.min[i] = Math.max(w.min[i], mid - lim);
        w.max[i] = Math.min(w.max[i], mid + lim);
      }
      const crop = solidPolys({ type: "box", size: [ext(w, 0), ext(w, 1), ext(w, 2)], at: [...w.min] as V3 });
      const pes = jd.inst.parts.flatMap((pi) => {
        const polys = intersect(ctx.built.parts[pi].polys, crop);
        if (!polys.length) return [];
        const d = jd.shift.get(pi) ?? [0, 0, 0];
        const moved = polys.map((p) => ({ v: p.v.map((q) => [q[0] + d[0], q[1] + d[1], q[2] + d[2]] as V3), p: { n: p.p.n, w: p.p.w + dot(p.p.n, d) }, ...(p.sm ? { sm: { ...p.sm, c: [p.sm.c[0] + d[0], p.sm.c[1] + d[1], p.sm.c[2] + d[2]] as V3 } } : {}) }));
        return [partEdges(moved, pi)];
      });
      const l = drawView(pes, viewFrom([-jd.cam[0], -jd.cam[1], -jd.cam[2]], [0, 0, 1]), { hidden: false });
      ctx.cache.set(`jd-${jd.letter}-apart`, l);
      return l;
    })();
  return { id, lines, min: lines.min, max: lines.max, scale, dims: [], kind: "detail", title: "PULLED APART, NOT DIMENSIONED", group: jd.letter, role: "apart" };
}

/** Balloons for a pulled-apart joint: each part number once, on its longest edge, out to the side nearest it. */
function balloonApart(ctx: DCtx, b: Block, jd: JointDetail) {
  const vm = b.views[0];
  const pl: Placement = { ox: vm.ox, oy: vm.oy, k: vm.k, view: vm.id };
  const lines = ctx.cache.get(`jd-${jd.letter}-apart`)!;
  const box = vm.box;
  const pad = 7;
  const ring: Box = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
  const seenMarks = new Set<number>();
  const items: { mark: number; at: P2 }[] = [];
  for (const pi of jd.inst.parts) {
    const mark = ctx.parts[pi].mark;
    if (seenMarks.has(mark)) continue;
    let best: { len: number; at: P2 } | null = null;
    for (const c of lines.chains) {
      if (c.part !== pi || c.kind === "hidden") continue;
      for (let i = 0; i + 1 < c.pts.length + (c.closed ? 1 : 0); i++) {
        const a = c.pts[i],
          e = c.pts[(i + 1) % c.pts.length];
        const len = Math.hypot(e[0] - a[0], e[1] - a[1]);
        if (!best || len > best.len) best = { len, at: [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2] };
      }
    }
    if (!best) continue;
    seenMarks.add(mark);
    items.push({ mark, at: toPage(pl, best.at) });
  }
  const cx = (box[0] + box[2]) / 2,
    cy = (box[1] + box[3]) / 2;
  const sides: Record<string, { mark: number; at: P2; pos: number }[]> = { l: [], r: [], t: [], b: [] };
  for (const it of items) {
    const dx = (it.at[0] - cx) / (box[2] - box[0] + 1),
      dy = (it.at[1] - cy) / (box[3] - box[1] + 1);
    const s = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "l" : "r") : dy < 0 ? "b" : "t";
    sides[s].push({ ...it, pos: s === "l" || s === "r" ? it.at[1] : it.at[0] });
  }
  for (const [s, list] of Object.entries(sides)) {
    list.sort((p, q) => p.pos - q.pos);
    for (let i = 1; i < list.length; i++) if (list[i].pos - list[i - 1].pos < 9) list[i].pos = list[i - 1].pos + 9;
    for (const it of list) {
      const c: P2 = s === "l" ? [ring[0], it.pos] : s === "r" ? [ring[2], it.pos] : s === "t" ? [it.pos, ring[3]] : [it.pos, ring[1]];
      const d = Math.hypot(c[0] - it.at[0], c[1] - it.at[1]) || 1;
      const e: P2 = [c[0] - ((c[0] - it.at[0]) / d) * 3.6, c[1] - ((c[1] - it.at[1]) / d) * 3.6];
      addPrims(b, [{ t: "line", a: it.at, b: e, w: W.thin, layer: "BALLOONS", view: vm.id }, { t: "circle", c: it.at, r: 0.6, w: 0, fill: true, layer: "BALLOONS", view: vm.id }, ...balloon(c, it.mark, vm.id)]);
    }
  }
  vm.ballooned = [...seenMarks].sort((x, y) => x - y);
}

/** A small caption under a view of a detail (2.5 high, centred under what it has below it). */
function caption(b: Block, id: string, s: string) {
  const vm = b.views.find((v) => v.id === id)!;
  const cx = (vm.box[0] + vm.box[2]) / 2;
  const own = b.prims.filter((p) => p.view === id).map(primBox);
  const below = Math.min(vm.box[1], ...own.filter((o) => o[0] < cx + 30 && cx - 30 < o[2]).map((o) => o[1]));
  addPrims(b, [text([cx, below - 3.5], s, TH.note, { anchor: "middle", base: "top", role: "title", view: id })]);
}

/** The detail's bubble: its letter over the number of the sheet it's marked on (filled in once the sheets are known). */
export function splitBubble(c: P2, letter: string, sheetToken: string, view: string, r = 5.5): Prim[] {
  return [
    { t: "circle", c, r, w: W.visible, layer: "SYMBOLS", view },
    { t: "line", a: [c[0] - r, c[1]], b: [c[0] + r, c[1]], w: W.thin, layer: "SYMBOLS", view },
    text([c[0], c[1] + 2.5], letter, TH.head, { anchor: "middle", base: "middle", bold: true, layer: "SYMBOLS", role: "label", view }),
    text([c[0], c[1] - 2.3], sheetToken, TH.note, { anchor: "middle", base: "middle", layer: "SYMBOLS", role: "label", view }),
  ];
}
/** The token standing for a sheet number until the sheets are numbered: replaced in makeSet. */
export const sheetToken = (letter: string, where: "detail" | "ga") => `#${where === "detail" ? "D" : "G"}${letter}`;

/**
 * One joint's detail: its sections, kept in projection where they share the way the joint goes together across the
 * paper (a plan section over the elevation section, aligned; or side by side, level), the pulled-apart view beside them
 * (a scale smaller if that's what fits: it carries no sizes), captions, the title, one dashed frame round it all.
 */
export function jointGroup(ctx: DCtx, jd: JointDetail, scale: number, maxW: number, maxH: number, isoScale = scale, stack = true): Block | null {
  const secs: Block[] = [];
  for (const v of jd.views) {
    const vb = sectionView(ctx, jd, v, scale);
    const occ = new Occupied();
    const b = placeView(vb, 0, 0, occ);
    // a note's words off the hatching where there's room (on a long section they'd sit on its grain), else where they fit
    const vm = b.views[0];
    const cut: Box[] = vb.lines.hatches.flatMap((h) =>
      h.loops.map((l): Box => {
        const q = l.map((p) => [vm.ox + p[0] * vm.k, vm.oy + p[1] * vm.k]);
        return [Math.max(vm.box[0], Math.min(...q.map((x) => x[0]))), Math.max(vm.box[1], Math.min(...q.map((x) => x[1]))), Math.min(vm.box[2], Math.max(...q.map((x) => x[0]))), Math.min(vm.box[3], Math.max(...q.map((x) => x[1])))];
      }),
    );
    for (const ld of b.pending ?? []) {
      const r = leaderNote(ld.tip, ld.s, occ, ld.view, [], cut) ?? leaderNote(ld.tip, ld.s, occ, ld.view);
      if (r) addPrims(b, r.prims);
    }
    b.pending = [];
    caption(b, v.id, `${v.id}  ${v.caption}`);
    // each hatch used goes in the sheet's legend
    for (const h of vb.lines.hatches) {
      const p = ctx.parts[h.part];
      b.legend.add(hatchFor(p.material, Math.abs(dot(drawAxis(p, 0), v.n)) > 0.9, ctx.spec(p)).key);
    }
    secs.push(b);
  }
  const av = apartView(ctx, jd, isoScale);
  const iso = placeView({ ...av, title: isoScale === scale ? av.title : `${av.title}, SCALE 1:${isoScale}` }, 0, 0, new Occupied());
  balloonApart(ctx, iso, jd);
  caption(iso, av.id, `${av.id}  ${isoScale === scale ? av.title : `${av.title}, SCALE 1:${isoScale}`}`);
  // the sections: in projection if they can be
  const col = emptyBlock();
  if (secs.length === 2) {
    const [v1, v2] = jd.views;
    const d1 = viewOf(v1.n, v1.up),
      d2 = viewOf(v2.n, v2.up);
    const same = (p: V3, q: V3) => Math.abs(dot(p, q) - 1) < 1e-6;
    const [b1, b2] = secs;
    const m1 = b1.views[0],
      m2 = b2.views[0];
    if (stack && same(d1.right, d2.right)) {
      // one over the other, lined up across: the plan section on top (third angle)
      const top = axisOf(v2.n) === 2 ? b2 : b1,
        bot = top === b1 ? b2 : b1;
      const mt = top === b1 ? m1 : m2,
        mb = top === b1 ? m2 : m1;
      const placedBot = moveBlock(bot, 0, 0);
      const placedTop = moveBlock(top, mb.ox - mt.ox, placedBot.box[3] + 8 - top.box[1]);
      placedTop.views[0].aligned = [{ with: mb.id, axis: "x", at: placedTop.views[0].ox, other: placedBot.views[0].ox }];
      merge(col, placedBot);
      merge(col, placedTop);
    } else if (same(d1.up, d2.up)) {
      // side by side, level
      const placed2 = moveBlock(b2, b1.box[2] + 12 - b2.box[0], m1.oy - m2.oy);
      placed2.views[0].aligned = [{ with: m1.id, axis: "y", at: placed2.views[0].oy, other: m1.oy }];
      merge(col, b1);
      merge(col, placed2);
    } else {
      merge(col, b1);
      merge(col, moveBlock(b2, b1.box[2] + 12 - b2.box[0], (m1.box[1] + m1.box[3]) / 2 - (m2.box[1] + m2.box[3]) / 2));
    }
  } else for (const b of secs) merge(col, b);
  const t = jd.type;
  const places = t.insts.length;
  // the pulled-apart view to the right of the sections, its middle level with theirs; else under them
  for (const beside of [true, false]) {
    const g = emptyBlock();
    merge(g, col);
    if (beside) merge(g, moveBlock(iso, col.box[2] + 12 - iso.box[0], (col.box[1] + col.box[3]) / 2 - (iso.box[1] + iso.box[3]) / 2));
    else merge(g, moveBlock(iso, col.box[0] - iso.box[0], col.box[1] - 8 - iso.box[3]));
    // the title under it all: the bubble (its letter over the sheet it's marked on), the parts, what it is and how many
    // places, the scale
    const left = g.box[0];
    const below = g.box[1] - 4;
    const r = 5.5;
    const bc: P2 = [left + r, below - r - 0.5];
    const tx = bc[0] + r + 3;
    const tp: Prim[] = [...splitBubble(bc, jd.letter, sheetToken(jd.letter, "ga"), jd.letter)];
    let ty = bc[1] + 1.8;
    const lines = wrap(jd.title ?? t.title, TH.head, Math.max(60, blockW(g) - 16), true);
    lines.forEach((l, i) => {
      tp.push(text([tx, ty], l, TH.head, { bold: true, role: "title", view: jd.letter }));
      tp.push({ t: "line", a: [tx, ty - 1.3], b: [tx + textWidth(l, TH.head, true), ty - 1.3], w: W.visible, layer: "SYMBOLS", view: jd.letter });
      if (i + 1 < lines.length) ty -= TH.head + 2.2;
    });
    const sub = jd.sub ?? `${t.name}, ${places} ${places === 1 ? "PLACE" : "PLACES"}${places > 1 ? " (TYP)" : ""}`;
    for (const l of wrap(sub, TH.note, Math.max(60, blockW(g) - 16))) {
      ty -= TH.note + 2.4;
      tp.push(text([tx, ty], l, TH.note, { role: "title", view: jd.letter }));
    }
    ty -= TH.note + 2.4;
    tp.push(text([tx, ty], `SCALE 1:${scale}`, TH.note, { role: "title", view: jd.letter }));
    addPrims(g, tp);
    const fb: Box = [g.box[0] - 4, g.box[1] - 3, g.box[2] + 4, g.box[3] + 4];
    addPrims(g, [{ t: "poly", pts: [[fb[0], fb[1]], [fb[2], fb[1]], [fb[2], fb[3]], [fb[0], fb[3]]], closed: true, w: W.thin, dash: DASH.frame, layer: "SYMBOLS", view: jd.letter }]);
    if (blockW(g) <= maxW && blockH(g) <= maxH) return g;
  }
  return null;
}

/** A detail at a scale, its pulled-apart view at the same scale or, if that's what fits, one or two smaller. */
function groupAt(ctx: DCtx, jd: JointDetail, s: number, areaW: number, areaH: number, isoSmaller = false): Block | null {
  const all = [1, 2, 5, 10, 20, 50];
  // (a small pulled-apart view, 19.2.2: a step smaller than sections drawn at 1:1 or 1:2)
  for (const iso of all.filter((x) => x > s || (x === s && s >= 5 && !isoSmaller)).slice(0, 3)) {
    const b = jointGroup(ctx, jd, s, areaW, areaH, iso) ?? (jd.views.length === 2 ? jointGroup(ctx, jd, s, areaW, areaH, iso, false) : null);
    if (b) return b;
  }
  return null;
}

/**
 * A detail at the scales it fits at, and which is its own (J3, plan 19.2.1: 1:1 or 1:2, 1:5 only for big framing joints):
 * 1:1 or 1:2 with its smallest size 4 mm or more on paper, in half the sheet's height, else three quarters (19.5: a 6 mm
 * shoulder at 1:2 was cramped); else 1:1 or 1:2 in half, or three quarters, of the sheet's height; else the largest that
 * takes half; asked bigger (19.3), that many steps up. Returned smallest scale first.
 */
export function jointVariants(ctx: DCtx, jd: JointDetail, areaW: number, areaH: number): { blocks: Block[]; base: number; floor: number } {
  // (at 1:1 and 1:2 there's also a larger one, its pulled-apart view at the sections' scale, for a sheet with room)
  const fits: { s: number; b: Block; alt?: boolean }[] = [];
  for (const s of SCALES_DETAIL) {
    let b = groupAt(ctx, jd, s, areaW, areaH);
    if (!b) continue;
    let alt = s <= 2 ? jointGroup(ctx, jd, s, areaW, areaH, s) : null;
    // (at 1:5 and smaller, its pulled-apart view at the sections' scale is the larger one; with it a step smaller, the
    // detail may share a sheet with the schedule: a long scarf)
    if (s >= 5) {
      const small = groupAt(ctx, jd, s, areaW, areaH, true);
      if (small && blockW(b) * blockH(b) > blockW(small) * blockH(small) * 1.15) ((alt = b), (b = small));
    }
    // (at 1:1 or 1:2, two sections one over the other too tall for most of a sheet: side by side, if that goes in)
    if (s <= 2 && jd.views.length === 2 && blockH(b) > areaH * 0.78) {
      for (const iso of [1, 2, 5, 10].filter((x) => x > s).slice(0, 2)) {
        const flat = jointGroup(ctx, jd, s, areaW, areaH * 0.78, iso, false);
        if (flat) {
          b = flat;
          break;
        }
      }
    }
    if (alt && blockW(alt) * blockH(alt) > blockW(b) * blockH(b) * 1.15) fits.push({ s, b: alt, alt: true });
    fits.push({ s, b });
  }
  if (!fits.length) throw new Error(`detail ${jd.letter} won't fit`);
  const h = (f: { b: Block }) => blockH(f.b);
  // its smallest size (on paper, 5 mm at least is comfortable to read: Stage 12's line for a detail)
  const segs = jd.views.flatMap((v) =>
    v.dims.flatMap((d) => {
      const st = [...d.stations].sort((x, y) => x - y);
      return st.slice(1).map((x, i) => x - st[i]).filter((x) => x > 0.05);
    }),
  );
  const minSeg = segs.length ? Math.min(...segs) : 20;
  // (its own scale: 4 mm reads, a housing 9 deep at 1:2; to share a sheet it keeps to 5)
  const readable = (f: { s: number }, mm = 4) => minSeg / f.s >= mm - 1e-6;
  // 1:1 or 1:2 where its smallest size reads, in half the sheet's height, else three quarters; then as before
  let own = fits.findIndex((f) => !f.alt && f.s <= 2 && readable(f) && h(f) <= areaH * 0.5 + 1e-6);
  if (own < 0) own = fits.findIndex((f) => !f.alt && f.s <= 2 && readable(f) && h(f) <= areaH * 0.78 + 1e-6);
  if (own < 0) own = fits.findIndex((f) => !f.alt && f.s <= 2 && h(f) <= areaH * 0.5 + 1e-6);
  if (own < 0) own = fits.findIndex((f) => !f.alt && f.s <= 2 && h(f) <= areaH * 0.78 + 1e-6);
  if (own < 0) own = fits.findIndex((f) => !f.alt && h(f) <= areaH * 0.5 + 1e-6);
  if (own < 0) own = fits.findIndex((f) => !f.alt);
  // asked bigger (19.3): that many scales up
  if (jd.bigger) {
    const s0 = fits[own].s;
    const up = SCALES_DETAIL.filter((x) => x < s0).slice(-jd.bigger)[0];
    const j = up !== undefined ? fits.findIndex((f) => !f.alt && f.s === up) : -1;
    if (j >= 0) own = j;
  }
  const ordered = [...fits].reverse();
  // the smallest it may be drawn to share a sheet: its smallest size still 5 mm on paper
  const ok = ordered.findIndex((f) => readable(f, 5));
  const base = ordered.length - 1 - own;
  return { blocks: ordered.map((f) => f.b), base, floor: Math.min(base, ok < 0 ? base : ok) };
}


/* ---------------- the joint schedule ---------------- */

/** The joint schedule (19.2.5): Detail, Joint, Between, Places, Key sizes, Fixing; a row per joint type. */
export function jointSchedule(ctx: DCtx, maxW: number, extraCol?: { head: string; cells: Map<number, string> }): Block {
  const b = emptyBlock();
  const types = ctx.joints.types;
  const label = (n: number) => `${n} ${ctx.marks[n - 1]?.label ?? ""}`.trim();
  const head = ["DETAIL", "JOINT", "BETWEEN", "PLACES", "KEY SIZES", "FIXING", ...(extraCol ? [extraCol.head] : [])];
  const rows = types.map((t) => [t.letter ?? "–", t.name, jointAndList([...new Set([...t.guestMarks, ...t.hostMarks, ...t.fixMarks])].sort((x, y) => x - y).map(label)), String(t.insts.length), t.butt ? (t.insts[0].faces ?? "–") : t.sizesText || "–", t.fixNote, ...(extraCol ? [extraCol.cells.get(t.index) ?? ""] : [])]);
  const h = TH.note;
  const fixed = [16, 14];
  // (a cell may hold lines of its own, "\n" between: JOINT BY's SUGGESTED, CONFIRM and where it came from)
  const natural = head.map((hd, i) => Math.max(textWidth(hd, h, true), ...rows.map((r) => Math.max(...r[i].split("\n").map((l) => textWidth(l, h, i === 0))))) + 3);
  // DETAIL and PLACES narrow; the rest share what's left, as needed, wrapping
  const widths = natural.map((w, i) => (i === 0 ? fixed[0] : i === 3 ? fixed[1] : w));
  // (JOINT BY: wide enough for a suggestion's source on one line, "TENON 1/3 OF RAIL, FAIRHAM")
  const caps = [16, 46, 62, 14, 62, 46, 57];
  for (let i = 0; i < widths.length; i++) widths[i] = Math.min(widths[i], caps[i] ?? 40);
  let total = widths.reduce((a, c) => a + c, 0);
  if (total > maxW) {
    // (DETAIL, PLACES and JOINT BY keep their widths; the rest share what's left)
    const keep = fixed[0] + fixed[1] + (widths[6] ?? 0);
    const k = (maxW - keep) / (total - keep);
    for (let i = 0; i < widths.length; i++) if (i !== 0 && i !== 3 && i !== 6) widths[i] *= k;
    total = widths.reduce((a, c) => a + c, 0);
  }
  const wrapped = rows.map((r) => r.map((c, i) => (i === 0 || i === 3 ? [c] : c.split("\n").flatMap((l) => wrap(l, h, widths[i] - 3)))));
  const rowH = 5.4;
  const heights = wrapped.map((w) => Math.max(rowH, 1.9 + Math.max(...w.map((x) => x.length)) * 3.6));
  const titleH = 7;
  const H = titleH + rowH + heights.reduce((a, c) => a + c, 0);
  const prims: Prim[] = [];
  prims.push(text([0, -titleH + 2.2], "JOINT SCHEDULE", TH.head, { bold: true, layer: "TABLES", role: "title" }));
  prims.push({ t: "poly", pts: [[0, -titleH], [total, -titleH], [total, -H], [0, -H]], closed: true, w: W.visible, layer: "TABLES" });
  const cols: number[] = [0];
  for (const w of widths) cols.push(cols[cols.length - 1] + w);
  const centred = (i: number) => i === 0 || i === 3;
  let y = -titleH;
  head.forEach((hd, i) => prims.push(text([centred(i) ? (cols[i] + cols[i + 1]) / 2 : cols[i] + 1.5, y - rowH / 2], hd, h, { anchor: centred(i) ? "middle" : "start", base: "middle", bold: true, layer: "TABLES", role: "table" })));
  y -= rowH;
  prims.push({ t: "line", a: [0, y], b: [total, y], w: W.visible, layer: "TABLES" });
  wrapped.forEach((r, ri) => {
    r.forEach((cell, i) => cell.forEach((l, li) => prims.push(text([centred(i) ? (cols[i] + cols[i + 1]) / 2 : cols[i] + 1.5, y - 1.45 - h - li * 3.6], l, h, { anchor: centred(i) ? "middle" : "start", bold: i === 0, layer: "TABLES", role: "table" }))));
    y -= heights[ri];
    if (ri + 1 < rows.length) prims.push({ t: "line", a: [0, y], b: [total, y], w: W.thin, layer: "TABLES" });
  });
  for (let i = 1; i < cols.length - 1; i++) prims.push({ t: "line", a: [cols[i], -titleH], b: [cols[i], -H], w: W.thin, layer: "TABLES" });
  if (ctx.joints.buttsInScheduleOnly) prims.push(text([0, -H - 2], "PLAIN BUTT JOINTS (NO DETAIL LETTER) ARE LISTED HERE ONLY: MORE THAN SIX KINDS. FIXING TBC.", h, { base: "top", layer: "NOTES", role: "note" }));
  addPrims(b, prims);
  return b;
}

/* ---------------- the details sheets ---------------- */

export type DPage = { blocks: { b: Block; x: number; y: number }[]; subtitle: string };

/**
 * The JOINT DETAILS sheets (19.2.6): the schedule at the top of the first, then the details in rows, in letter order,
 * evenly spaced; each sheet's details drawn a scale larger together while there's room.
 */
export function detailPages(area: Box, schedule: Block | null, items: { blocks: Block[]; cur: number; floor?: number }[]): DPage[] {
  const areaW = area[2] - area[0],
    areaH = area[3] - area[1];
  const gapX = 10,
    gapY = 9;
  const blk = (i: number) => items[i].blocks[items[i].cur];
  // rows of details, greedily; a sheet's rows while they fit under what's above
  const layout = (idx: number[], top: number): number[][] | null => {
    const rows: number[][] = [];
    let row: number[] = [],
      w = 0;
    for (const i of idx) {
      const bw = blockW(blk(i));
      if (row.length && w + gapX + bw > areaW) {
        rows.push(row);
        row = [];
        w = 0;
      }
      row.push(i);
      w += (row.length > 1 ? gapX : 0) + bw;
    }
    if (row.length) rows.push(row);
    const h = rows.reduce((t, r) => t + Math.max(...r.map((i) => blockH(blk(i)))), 0) + gapY * Math.max(0, rows.length - 1);
    return h <= areaH - top ? rows : null;
  };
  const schedH = schedule ? blockH(schedule) + 8 : 0;
  // sheets: as many details as fit, in order
  const sheets: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const top = sheets.length === 0 ? schedH : 0;
    if (layout([...cur, i], top) && cur.length < 6) {
      cur.push(i);
      continue;
    }
    // one or two scales smaller, as far as each stays readable, if that's what puts it on this sheet
    const was = [...cur, i].map((j) => items[j].cur);
    let shared = false;
    for (let step = 1; step <= 2 && !shared && cur.length < 6 && cur.length > 0; step++) {
      [...cur, i].forEach((j, k) => (items[j].cur = Math.max(items[j].floor ?? was[k], was[k] - step)));
      if (layout([...cur, i], top)) shared = true;
      else [...cur, i].forEach((j, k) => (items[j].cur = was[k]));
    }
    if (shared) cur.push(i);
    else {
      if (cur.length) sheets.push(cur);
      cur = [i];
      // a detail too big for a sheet with the schedule on it: down a scale
      while (!layout(cur, sheets.length === 0 ? schedH : 0) && items[i].cur > 0) items[i].cur--;
    }
  }
  if (cur.length || !sheets.length) sheets.push(cur);
  // each sheet's details a scale larger together while they still fit (and no larger than their largest)
  sheets.forEach((pg, si) => {
    const top = si === 0 ? schedH : 0;
    for (let guard = 0; guard < 4; guard++) {
      const can = pg.filter((i) => items[i].cur + 1 < items[i].blocks.length);
      if (!can.length) break;
      can.forEach((i) => items[i].cur++);
      const used = pg.reduce((t, i) => t + blockW(blk(i)) * blockH(blk(i)), 0) / (areaW * (areaH - top));
      if (!layout(pg, top) || used > 0.8) {
        can.forEach((i) => items[i].cur--);
        // one at a time, the smallest first
        let any = false;
        for (const i of [...can].sort((a, b) => blockW(blk(a)) * blockH(blk(a)) - blockW(blk(b)) * blockH(blk(b)))) {
          items[i].cur++;
          const u2 = pg.reduce((t, j) => t + blockW(blk(j)) * blockH(blk(j)), 0) / (areaW * (areaH - top));
          if (layout(pg, top) && u2 <= 0.8) any = true;
          else items[i].cur--;
        }
        if (!any) break;
      }
    }
  });
  // a sheet under 40% used (J5, A17): the sheet before's last detail joins it, if both then come out at 40% or more
  const fill = (pg: number[], si: number) => (pg.reduce((t, i) => t + blockW(blk(i)) * blockH(blk(i)), 0) + (si === 0 && schedule ? blockW(schedule) * blockH(schedule) : 0)) / (areaW * areaH);
  for (let si = sheets.length - 1; si > 0; si--) {
    if (fill(sheets[si], si) >= 0.4 || sheets[si - 1].length < 2) continue;
    const prev = sheets[si - 1];
    const j = prev[prev.length - 1];
    const P = prev.slice(0, -1),
      Q = [j, ...sheets[si]];
    if (layout(P, si - 1 === 0 ? schedH : 0) && layout(Q, 0) && fill(P, si - 1) >= 0.4 && fill(Q, si) >= 0.4) {
      sheets[si - 1] = P;
      sheets[si] = Q;
    }
  }
  // place: the schedule top left, then the rows spread evenly down the rest, each row centred with even gaps
  return sheets.map((pg, si) => {
    const top = si === 0 ? schedH : 0;
    const rows = layout(pg, top) ?? pg.map((i) => [i]);
    const blocks: DPage["blocks"] = [];
    if (si === 0 && schedule) blocks.push({ b: schedule, x: area[0] - schedule.box[0], y: area[3] - schedule.box[3] });
    const rowH = rows.map((r) => Math.max(...r.map((i) => blockH(blk(i)))));
    const free = areaH - top - rowH.reduce((a, c) => a + c, 0);
    const gap = rows.length > 1 ? Math.min(free / (rows.length + 1), 30) : free / 2;
    let y = area[3] - top - Math.max(gapY * 0.3, rows.length > 1 ? Math.min(gap, free / (rows.length + 1)) : gap * 0.6);
    rows.forEach((r, ri) => {
      const ws = r.map((i) => blockW(blk(i)));
      const spare = areaW - ws.reduce((a, c) => a + c, 0);
      const g = Math.min(spare / (r.length + 1), 25);
      let x = area[0] + (spare - g * (r.length - 1)) / 2;
      for (const i of r) {
        const b = blk(i);
        // tops level along the row
        blocks.push({ b, x: x - b.box[0], y: y - b.box[3] });
        x += blockW(b) + g;
      }
      y -= rowH[ri] + (rows.length > 1 ? Math.max(gapY, (free - gap * 0.6 * 2) / Math.max(1, rows.length - 1)) : 0);
    });
    return { blocks, subtitle: si === 0 && schedule ? "JOINT SCHEDULE AND JOINT DETAILS" : "JOINT DETAILS" };
  });
}

/* ---------------- the markers on the general arrangement ---------------- */

export type GAName = "front" | "top" | "side";
export type MarkerPlan = Map<string, { view: GAName; inst: JointInst }>;

/** Which view and which of its places each joint type is marked at: seen side on (not end on), the place nearest the
 *  viewer, not on top of another marker. */
export function planMarkers(ctx: DCtx, details: JointDetail[], which: { name: GAName; dir: ViewDir }[], scale: number): MarkerPlan {
  const out: MarkerPlan = new Map();
  const spots: { view: GAName; at: P2 }[] = [];
  const k = 1 / scale;
  for (const jd of details) {
    let best: { s: number; view: GAName; inst: JointInst; at: P2 } | null = null;
    for (const [vi, w] of which.entries())
      for (const inst of jd.type.insts) {
        const c = boxCentre3(inst.contact);
        const at: P2 = [dot(c, w.dir.right) * k, dot(c, w.dir.up) * k];
        const depths = jd.type.insts.map((j) => dot(boxCentre3(j.contact), w.dir.f));
        const lo = Math.min(...depths),
          hi = Math.max(...depths);
        const rank = hi > lo ? (dot(c, w.dir.f) - lo) / (hi - lo) : 0;
        const endOn = Math.abs(dot(inst.d, w.dir.f)) > 0.9 ? 1.5 : 0;
        const crowd = spots.some((s) => s.view === w.name && Math.hypot(s.at[0] - at[0], s.at[1] - at[1]) < 9) ? 3 : 0;
        const s = endOn + rank + crowd + vi * 0.15;
        if (!best || s < best.s) best = { s, view: w.name, inst, at };
      }
    if (best) {
      out.set(jd.letter, { view: best.view, inst: best.inst });
      spots.push({ view: best.view, at: best.at });
    }
  }
  return out;
}

/** The markers on one view: a circle round the joint, a leader out to the detail bubble, TYP beside it if there are more. */
export function jointMarkers(ctx: DCtx, details: JointDetail[], plan: MarkerPlan, view: GAName, dir: ViewDir, pl: Placement, occ: Occupied, taken: Set<string>, vbox: Box, again?: string[]): { prims: Prim[]; letters: string[]; spots: { letter: string; at: P2; r: number }[] } {
  const prims: Prim[] = [];
  const letters: string[] = [];
  const spots: { letter: string; at: P2; r: number }[] = [];
  for (const jd of details) {
    const p = plan.get(jd.letter);
    if (!p || p.view !== view) continue;
    if (again ? !again.includes(jd.letter) : taken.has(jd.letter)) continue;
    const b = p.inst.contact;
    const cs: P2[] = [];
    for (const i of [0, 1]) for (const j of [0, 1]) for (const kk of [0, 1]) cs.push(toPage(pl, [dot([i ? b.max[0] : b.min[0], j ? b.max[1] : b.min[1], kk ? b.max[2] : b.min[2]], dir.right), dot([i ? b.max[0] : b.min[0], j ? b.max[1] : b.min[1], kk ? b.max[2] : b.min[2]], dir.up)]));
    const c: P2 = [(Math.min(...cs.map((q) => q[0])) + Math.max(...cs.map((q) => q[0]))) / 2, (Math.min(...cs.map((q) => q[1])) + Math.max(...cs.map((q) => q[1]))) / 2];
    const pw = Math.max(...cs.map((q) => q[0])) - Math.min(...cs.map((q) => q[0])),
      ph = Math.max(...cs.map((q) => q[1])) - Math.min(...cs.map((q) => q[1]));
    // round a compact joint; a long contact (an apron's edge under a top) marked at its middle, the circle small
    const lo = Math.min(pw, ph),
      hi = Math.max(pw, ph);
    const r = clamp((hi <= 3 * Math.max(lo, 1) ? Math.hypot(pw, ph) / 2 : lo / 2) + 1, 2.5, 12);
    const R = 5.5;
    const typ = jd.type.insts.length > 1;
    // the bubble where nothing is, out from the circle: inside the view's empty space if there's room (it doesn't push the
    // arrangement apart), else outside it; TYP to its side
    let placed: Prim[] | null = null;
    const cands: { dist: number; ang: number; inside: boolean }[] = [];
    for (const dist of [r + 7, r + 10, r + 14, r + 19, r + 25, r + 33])
      for (const ang of [45, 135, -45, -135, 90, -90, 20, 160, -20, -160, 0, 180]) {
        const a = (ang * Math.PI) / 180;
        const bc: P2 = [c[0] + dist * Math.cos(a), c[1] + dist * Math.sin(a)];
        const inside = bc[0] - R - 9 > vbox[0] && bc[0] + R + 9 < vbox[2] && bc[1] - R - 1 > vbox[1] && bc[1] + R + 1 < vbox[3];
        cands.push({ dist, ang, inside });
      }
    cands.sort((p, q) => (p.inside === q.inside ? 0 : p.inside ? -1 : 1) || p.dist - q.dist);
    for (const { dist, ang } of cands) {
      {
        const a = (ang * Math.PI) / 180;
        const bc: P2 = [c[0] + dist * Math.cos(a), c[1] + dist * Math.sin(a)];
        const bb: Box = [bc[0] - R - 0.6, bc[1] - R - 0.6, bc[0] + R + 0.6, bc[1] + R + 0.6];
        const right = Math.cos(a) >= 0;
        const tt = typ ? text([right ? bc[0] + R + 1.2 : bc[0] - R - 1.2, bc[1]], "TYP", TH.note, { anchor: right ? "start" : "end", base: "middle", layer: "SYMBOLS", role: "label", view: pl.view }) : null;
        if (!occ.free(bb) || (tt && !occ.free(textBox(tt)))) continue;
        const from: P2 = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
        const to: P2 = [bc[0] - R * Math.cos(a), bc[1] - R * Math.sin(a)];
        if (occ.texts.some((x) => segHits(from, to, x))) continue;
        placed = [
          { t: "circle", c, r, w: W.thin, layer: "SYMBOLS", view: pl.view },
          { t: "line", a: from, b: to, w: W.thin, layer: "SYMBOLS", view: pl.view },
          ...splitBubble(bc, jd.letter, sheetToken(jd.letter, "detail"), pl.view, R),
          ...(tt ? [tt] : []),
        ];
        break;
      }
      if (placed) break;
    }
    if (!placed) continue;
    occ.addPrims(placed);
    prims.push(...placed);
    letters.push(jd.letter);
    spots.push({ letter: jd.letter, at: c, r });
    taken.add(jd.letter);
  }
  return { prims, letters, spots };
}
const segHits = (a: P2, b: P2, box: Box) => {
  let t0 = 0,
    t1 = 1;
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - box[0]],
    [dx, box[2] - a[0]],
    [-dy, a[1] - box[1]],
    [dy, box[3] - a[1]],
  ]) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
  }
  return t0 <= t1;
};

/* ---------------- what the part views need ---------------- */

/**
 * For a part view: which of its features are in a detailed joint (feature index → letter), so it points there and leaves
 * their sizes across it to the detail; matched on the part drawn (the mark's first part) by kind and place.
 */
export function detailedFeatures(ctx: DCtx, details: JointDetail[]): Map<number, Map<number, string>> {
  const out = new Map<number, Map<number, string>>();
  for (const jd of details)
    for (const inst of jd.type.insts)
      for (const [pi, fs] of inst.feats) {
        const p = ctx.parts[pi];
        const first = ctx.marks[p.mark - 1]?.first;
        if (!first) continue;
        const m = out.get(first.index) ?? new Map<number, string>();
        for (const fi of fs) {
          const f = p.features[fi];
          const j = first.index === pi ? fi : first.features.findIndex((g) => g.kind === f.kind && !!g.hole === !!f.hole && [0, 1, 2].every((i) => Math.abs(g.box.min[i] - f.box.min[i]) < 0.6 && Math.abs(g.box.max[i] - f.box.max[i]) < 0.6));
          if (j >= 0 && !m.has(j)) m.set(j, jd.letter);
        }
        out.set(first.index, m);
      }
  return out;
}
export { boxCentre3, r1, mvBox, growBox, emptyBox, grow };

/* ---------------- views he asked for (19.3) ---------------- */

/**
 * A view he asked for, kept with the drawing so it comes back on every reissue: a section (through a named part, or the
 * whole piece's middle, across or along), a detail (of where two named parts meet, seen from a side), a standard detail
 * drawn bigger, or a 3D view (assembled or pulled apart, the whole piece or named parts). Parts are kept by their names
 * in the model, so a changed model still finds them.
 */
export type ExtraView = {
  id: string;
  kind: "section" | "detail" | "bigger" | "3d";
  parts?: string[];
  way?: "across" | "along";
  from?: "above" | "below" | "front" | "back" | "left" | "right";
  apart?: boolean;
};

const norm1 = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
/** The model's parts with these names (exactly, or by their label: "Left stile" or "STILE"). */
export function partsNamed(ctx: { m: ModelPayload; parts: PartInfo[] }, names: string[]): number[] {
  const want = names.map(norm1);
  const exact = ctx.parts.filter((p) => want.includes(norm1(ctx.m.parts[p.index].name))).map((p) => p.index);
  if (exact.length) return exact;
  return ctx.parts.filter((p) => want.includes(norm1(p.label))).map((p) => p.index);
}

/** The joint instance where parts of these two groups meet (the first found), and its type. */
export function jointBetween(js: JointSet, a: number[], b: number[]): { type: JointType; inst: JointInst } | null {
  for (const t of js.types)
    for (const inst of t.insts) {
      const ps = inst.parts;
      if (ps.some((p) => a.includes(p)) && ps.some((p) => b.includes(p))) return { type: t, inst };
    }
  return null;
}

export const FROM: Record<NonNullable<ExtraView["from"]>, { c: number; sign: 1 | -1; words: string }> = {
  above: { c: 2, sign: 1, words: "SEEN FROM ABOVE" },
  below: { c: 2, sign: -1, words: "SEEN FROM BELOW" },
  front: { c: 1, sign: 1, words: "SEEN FROM THE FRONT" },
  back: { c: 1, sign: -1, words: "SEEN FROM THE BACK" },
  right: { c: 0, sign: 1, words: "SEEN FROM THE RIGHT" },
  left: { c: 0, sign: -1, words: "SEEN FROM THE LEFT" },
};
