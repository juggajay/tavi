// Extra sizes and notes refer to the model. Their page positions are worked out afresh for every issue.
import { apply, dot, invert, type V3 } from "../model3d/math.js";
import { Occupied, leaderNote, placeDim, type Side } from "./dims.js";
import { checkSet } from "./checks.js";
import { gapHatch, primBox } from "./blocks.js";
import { AREA, type DrawingSet } from "./sheets.js";
import { DASH, W, mm, segHitsBox, textBox, type Box, type DimMeta, type P2, type Prim, type ViewMeta } from "./prims.js";
import { toPage, type Placement } from "./render.js";

export type FeatureRef = { part: number; feature: string };
type AddedBase = { id: string; sheet: number; view: string };
export type AddedDimension = AddedBase & { kind: "dimension"; from: FeatureRef; to: FeatureRef; label?: string; side?: Side };
export type AddedNote = AddedBase & { kind: "note"; at: FeatureRef; text: string };
export type Added = AddedDimension | AddedNote;

export class AddedError extends Error {
  constructor(message: string, public choices?: string[]) { super(message); }
}

const placement = (v: ViewMeta): Placement => ({ ox: v.ox, oy: v.oy, k: v.k, view: v.id, brk: v.geometry?.brk });
const inside = (p: P2, b: Box) => p[0] >= b[0] - 1e-6 && p[0] <= b[2] + 1e-6 && p[1] >= b[1] - 1e-6 && p[1] <= b[3] + 1e-6;
const distance = (p: P2, a: P2, b: P2) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/** Choices are limited to geometry actually shown here, including hole centre lines. Numbers start at one. */
export function featureChoices(set: DrawingSet, v: ViewMeta, mark: number): Map<string, P2> {
  const g = v.geometry;
  if (!g || v.kind === "iso" || v.role === "apart") return new Map();
  const ps = set.parts.filter((p) => p.mark === mark && g.parts.includes(p.index));
  // A repeated part number in an assembly does not say which copy the owner means.
  const p = v.mark === mark || v.marks?.includes(mark) ? set.marks.find((m) => m.mark === mark)?.first : ps.length === 1 ? ps[0] : undefined;
  if (!p) return new Map();
  const partView = v.kind === "part";
  const representative = partView ? g.parts[0] : p.index;
  const polys = partView ? p.polys : set.built.parts[p.index].polys;
  const project = (q: V3): P2 => [dot(q, g.dir.right), dot(q, g.dir.up)];
  const pts = polys.flatMap((poly) => poly.v.map(project));
  if (!pts.length) return new Map();
  const lo: P2 = [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1]))];
  const hi: P2 = [Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
  const mid: P2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  const segments: [P2, P2][] = [];
  for (const c of g.lines.chains.filter((c) => c.part === representative && c.kind !== "hidden"))
    for (let i = 0; i + 1 < c.pts.length + (c.closed ? 1 : 0); i++) segments.push([c.pts[i], c.pts[(i + 1) % c.pts.length]]);
  const arcs = g.lines.arcs.filter((a) => a.part === representative && a.kind !== "hidden");
  const visible = (q: P2) => {
    const brk = g.brk;
    if (brk && q[0] > brk.u0 + 1e-6 && q[0] < brk.u1 - 1e-6) return false;
    return inside(toPage(placement(v), q), v.box) && (segments.some(([a, b]) => distance(q, a, b) < 1e-4) || arcs.some((a) => Math.hypot(q[0] - a.c[0], q[1] - a.c[1]) < 1e-4));
  };
  const choices = new Map<string, P2>();
  const put = (name: string, q: P2) => { if (visible(q)) choices.set(name, q); };
  // On an irregular face, use the middle of a real edge on that face.
  for (const [name, axis, value] of [["left", 0, lo[0]], ["right", 0, hi[0]], ["bottom", 1, lo[1]], ["top", 1, hi[1]]] as const) {
    const runs = segments.filter(([a, b]) => Math.abs(a[axis] - value) < 1e-4 && Math.abs(b[axis] - value) < 1e-4)
      .sort((a, b) => Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1]) - Math.hypot(a[1][0] - a[0][0], a[1][1] - a[0][1]));
    for (const [a, b] of runs) {
      const q: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (visible(q)) { put(name, q); break; }
    }
  }
  if (inside(toPage(placement(v), mid), v.box) && (!g.brk || mid[0] <= g.brk.u0 || mid[0] >= g.brk.u1) && (segments.length || arcs.length)) choices.set("centre", mid);
  for (const [name, q] of [["tl", [lo[0], hi[1]]], ["tr", hi], ["bl", lo], ["br", [hi[0], lo[1]]]] as [string, P2][]) put(`corner:${name}`, q);
  const fromDraw = invert(p.modelToDraw);
  const featurePoint = (q: V3) => project(partView ? q : apply(fromDraw, q));
  let hole = 0, cut = 0;
  for (const f of p.features) {
    if (f.hole) {
      const q = featurePoint(f.hole.c);
      const name = `hole:${++hole}`;
      // Only a hole seen end on has a centre in this view.
      if (arcs.some((a) => Math.hypot(a.c[0] - q[0], a.c[1] - q[1]) < 0.05)) put(name, q);
    } else {
      const name = `cut:${++cut}`;
      const corners: P2[] = [];
      for (const x of [f.box.min[0], f.box.max[0]]) for (const y of [f.box.min[1], f.box.max[1]]) for (const z of [f.box.min[2], f.box.max[2]]) corners.push(featurePoint([x, y, z]));
      const box: Box = [Math.min(...corners.map((q) => q[0])), Math.min(...corners.map((q) => q[1])), Math.max(...corners.map((q) => q[0])), Math.max(...corners.map((q) => q[1]))];
      const candidates = segments.flatMap(([a, b]) => [a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as P2]).filter((q) => inside(q, box) && visible(q));
      const c: P2 = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      candidates.sort((a, b) => Math.hypot(a[0] - c[0], a[1] - c[1]) - Math.hypot(b[0] - c[0], b[1] - c[1]));
      if (candidates.length) put(name, candidates[0]);
    }
  }
  return choices;
}

export function resolveFeature(set: DrawingSet, v: ViewMeta, ref: FeatureRef): P2 {
  const choices = featureChoices(set, v, ref.part);
  const q = choices.get(ref.feature);
  if (!q) throw new AddedError(`Part ${ref.part} has no usable ${ref.feature} in view ${v.id}. The choices here are: ${[...choices.keys()].join(", ") || "none; use a part view or a section where this part is visible"}.`, [...choices.keys()]);
  return q;
}

const failures = (set: DrawingSet) => checkSet(set).flatMap((c) => c.why.map((why) => `${c.id}: ${why}`));

/** Place every kept addition, refusing a change before any file or revision is written. */
export function applyAdded(set: DrawingSet, additions: Added[]): void {
  const baseline = new Set(failures(set));
  const seen = new Set<string>();
  const measures = new Set<string>();
  for (const a of additions) {
    if (seen.has(a.id)) throw new AddedError(`The addition ${a.id} is listed twice.`);
    seen.add(a.id);
    const sh = set.sheets[a.sheet - 1];
    if (!Number.isInteger(a.sheet) || !sh) throw new AddedError(`There is no sheet ${a.sheet}.`);
    const v = sh.meta.views.find((v) => v.id === a.view);
    if (!v) throw new AddedError(`Sheet ${a.sheet} has no view ${a.view}. Its views are: ${sh.meta.views.map((v) => v.id).join(", ")}.`);
    const frame = v.group ? sh.prims.find((p) => p.t === "poly" && p.closed && p.dash && p.view === v.group && p.layer === "SYMBOLS") : undefined;
    const room = frame ? primBox(frame) : AREA;
    const occupied = () => { const occ = new Occupied(); occ.addPrims(sh.prims); return occ; };
    let reason = "It would overlap the drawing or leave the drawing area.";
    const accept = (ps: Prim[], ds: DimMeta[] = []) => {
      if (ps.some((p) => { const b = primBox(p); return !inside([b[0], b[1]], AREA) || !inside([b[2], b[3]], AREA) || !inside([b[0], b[1]], room) || !inside([b[2], b[3]], room); })) { reason = "It would leave the drawing area or its frame."; return false; }
      // Added lines must leave every existing word readable, including other dimensions.
      const words = sh.prims.filter((p) => p.t === "text").map(textBox);
      if (ps.some((p) => p.t === "line" && words.some((b) => segHitsBox(p.a, p.b, b)))) { reason = "Its line would cross words already on the sheet."; return false; }
      const previous = sh.prims;
      const cutters = ps.flatMap((p) => p.t === "line" && p.layer === "DIMS" ? [[p.a, p.b] as [P2, P2]] : []);
      sh.prims = cutters.length ? gapHatch([...previous, ...ps], cutters) : [...previous, ...ps];
      sh.meta.dims.push(...ds);
      const bad = failures(set).filter((f) => !baseline.has(f));
      if (bad.length) { sh.prims = previous; sh.meta.dims.splice(sh.meta.dims.length - ds.length); reason = `It would overlap or fail the sheet checks: ${bad.join("; ")}`; return false; }
      return true;
    };
    let placed = false;
    if (a.kind === "note") {
      if (!a.text.trim() || a.text.length > 80 || /[\r\n\x00-\x1f]/.test(a.text)) throw new AddedError("A note needs one line of words, up to 80 characters.");
      const tip = toPage(placement(v), resolveFeature(set, v, a.at));
      // Keep a note inside the frame while the existing placer tries its usual directions.
      const avoid: Box[] = [[-10000, -10000, room[0], 10000], [room[2], -10000, 10000, 10000], [-10000, -10000, 10000, room[1]], [-10000, room[3], 10000, 10000]];
      const r = leaderNote(tip, a.text, occupied(), v.id, [], avoid);
      if (r) placed = accept(r.prims.map((p) => ({ ...p, view: v.id })));
    } else {
      if (a.label && (a.label.length > 40 || /[\r\n\x00-\x1f]/.test(a.label))) throw new AddedError("A dimension label may add words on one line, up to 40 characters; the number comes from the model.");
      const from = resolveFeature(set, v, a.from), to = resolveFeature(set, v, a.to);
      const dx = Math.abs(to[0] - from[0]), dy = Math.abs(to[1] - from[1]);
      const value = Math.hypot(dx, dy);
      if (value < 0.05) throw new AddedError("Those features are at the same point in this view.");
      const diagonal = dx >= 0.05 && dy >= 0.05;
      const label = `${mm(value)}${diagonal ? ` (${mm(dx)} x ${mm(dy)})` : ""}${a.label ? ` ${a.label.trim()}` : ""}`;
      const measureKey = `added:${a.sheet}:${v.id}:${[`${a.from.part}:${a.from.feature}`, `${a.to.part}:${a.to.feature}`].sort().join("/")}`;
      if (measures.has(measureKey)) throw new AddedError("That dimension is already added to this view. Use look_at_drawing to find its id.");
      measures.add(measureKey);
      const centres: Prim[] = [];
      for (const [ref, point] of [[a.from, from], [a.to, to]] as const) if (ref.feature === "centre") {
        const q = toPage(placement(v), point);
        centres.push({ t: "line", a: [q[0] - 2.5, q[1]], b: [q[0] + 2.5, q[1]], w: W.thin, dash: DASH.centre, layer: "CENTRE", view: v.id }, { t: "line", a: [q[0], q[1] - 2.5], b: [q[0], q[1] + 2.5], w: W.thin, dash: DASH.centre, layer: "CENTRE", view: v.id });
      }
      const travel = (side: Side) => {
        const hor = side === "above" || side === "below";
        const edge = side === "above" ? v.box[3] : side === "below" ? v.box[1] : side === "left" ? v.box[0] : v.box[2];
        return [from, to].reduce((sum, q) => sum + Math.abs(toPage(placement(v), q)[hor ? 1 : 0] - edge), 0);
      };
      const sides: Side[] = a.side ? [a.side] : (["above", "below", "right", "left"] as Side[]).sort((a, b) => travel(a) - travel(b));
      if (a.side && !["above", "below", "right", "left"].includes(a.side)) throw new AddedError("Choose above, below, left or right for the dimension.");
      for (const side of sides) {
        const hor = side === "above" || side === "below";
        if ((hor ? dx : dy) < 0.05) continue;
        for (let tier = 0; tier < 8; tier++) {
          const r = placeDim({ side, stations: [from[hor ? 0 : 1], to[hor ? 0 : 1]], feet: [from[hor ? 1 : 0], to[hor ? 1 : 0]], keys: [measureKey], labels: [label], tier }, v.geometry!.lines, placement(v), { below: v.box[1], above: v.box[3], left: v.box[0], right: v.box[2] }, occupied(), `added:${a.id}`);
          if (r && accept([...centres, ...r.prims], r.metas.map((d) => ({ ...d, value })))) { placed = true; break; }
        }
        if (placed) break;
      }
    }
    if (!placed) throw new AddedError(`Could not place ${a.kind} ${a.id} on sheet ${a.sheet}: ${reason}`);
  }
}

export const addedText = (additions: Added[], sheet: number) => additions.filter((a) => a.sheet === sheet).map((a) => `${a.id}: ${a.kind} in view ${a.view}, ${a.kind === "note" ? a.text : `part ${a.from.part} ${a.from.feature} to part ${a.to.part} ${a.to.feature}${a.label ? `, ${a.label}` : ""}`}`).join("; ") || "none";
