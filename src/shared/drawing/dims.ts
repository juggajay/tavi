// Dimensions (Stage 12.2, plan A.2 and A.5). They come from what the model knows: a part's ends and faces, and the
// sides of its features (a mortise's ends, a housing's edges, a hole's centre); never from every edge of the picture.
// A dimension is a chain of stations along one axis of a view; it is written where that feature is seen true and
// visible (each station's extension line must start on a visible line, never a hidden one), set out from one datum end,
// the overall outermost and the smallest chain nearest, every chain adding up to its overall, each size once in the set.
// Placing them: tiers 10 mm off the object then 8 mm steps, 45° ticks, a 2 mm gap before each extension line and 2 mm
// past, text above the line; a value too small for its space goes outside, kept clear of other text and of the lines.
import type { ViewLines } from "./hlr.js";
import { type Box, type DimMeta, type P2, type Prim, TH, W, boxesHit, mm, segHitsBox, textBox, textWidth } from "./prims.js";
import { type Placement, arrow, toPage } from "./render.js";

export type Side = "below" | "above" | "left" | "right";

/** One chain (or a single overall) to place on a view. Stations are model 2D coordinates along the measured axis. */
export type DimSpec = {
  side: Side;
  /** Model stations along u (below/above) or v (left/right), any order. */
  stations: number[];
  /** Where each station's extension line starts, in model 2D across the axis (filled by findFeet when missing). */
  feet?: (number | undefined)[];
  /** A key per segment ("what it measures"), for no size twice. */
  keys: string[];
  /** The total this chain must add up to (the part's or the assembly's size that way). */
  total?: number;
  /** It doesn't run end to end (a detail cropped by its frame): no closing check. */
  partial?: boolean;
  overall?: boolean;
  /** A reference size, shown in brackets. */
  ref?: boolean;
  tier?: number;
  /** Text to use instead of the length (e.g. "6 CRS"). */
  labels?: (string | undefined)[];
  /** It may go on the opposite side if its extension lines are much shorter there. */
  flex?: boolean;
  /** Segments given elsewhere (on a joint detail, Stage 19.2), shown here in brackets for reference: by their stations. */
  refSegs?: [number, number][];
  /** What a segment measures, from its two stations (so a station left out in this view can't shift the keys). */
  keyFn?: (a: number, b: number) => string;
};

const OPP: Record<Side, Side> = { below: "above", above: "below", left: "right", right: "left" };

/** For a flexible dimension, the side whose extension lines are shortest (they shouldn't run across the drawing). */
export function bestSide(spec: DimSpec, lines: ViewLines): Side {
  if (!spec.flex) return spec.side;
  const ext = (side: Side) => {
    let worst = 0;
    const edge = side === "below" ? lines.min[1] : side === "above" ? lines.max[1] : side === "left" ? lines.min[0] : lines.max[0];
    for (let i = 0; i < spec.stations.length; i++) {
      const f = spec.feet?.[i] ?? footAt(lines, side, spec.stations[i]);
      if (f === null || f === undefined) return Infinity;
      worst = Math.max(worst, Math.abs(f - edge));
    }
    return worst;
  };
  const here = ext(spec.side),
    there = ext(OPP[spec.side]);
  return there < here - 1e-6 ? OPP[spec.side] : spec.side;
}

/** Visible (or cut) linework of a view in model 2D, as segments, for finding feet and keeping text clear. */
export function visibleSegs(lines: ViewLines): [P2, P2][] {
  const out: [P2, P2][] = [];
  for (const c of lines.chains) {
    if (c.kind === "hidden") continue;
    const n = c.pts.length;
    for (let i = 0; i + 1 < n + (c.closed ? 1 : 0); i++) out.push([c.pts[i], c.pts[(i + 1) % n]]);
  }
  return out;
}

/**
 * Where an extension line for a station starts: the end, nearest the dimension's side, of a visible edge lying across
 * the measured axis at that station (or the end of a centre line through a hole there). Null: nothing visible there, so
 * it can't be dimensioned in this view (never to a hidden line).
 */
export function footAt(lines: ViewLines, side: Side, s: number, tol = 1e-3): number | null {
  const hor = side === "below" || side === "above";
  let best: number | null = null;
  const better = (v: number) => (best === null ? true : side === "below" || side === "left" ? v < best : v > best);
  for (const [a, b] of visibleSegs(lines)) {
    // an edge lying across the axis: constant u (for below/above) or constant v (left/right), at s
    const i = hor ? 0 : 1,
      j = hor ? 1 : 0;
    if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i] - s) > tol) continue;
    for (const v of [a[j], b[j]]) if (better(v)) best = v;
  }
  for (const c of lines.arcs) {
    if (c.kind === "hidden") continue;
    const ci = hor ? c.c[0] : c.c[1];
    const cj = hor ? c.c[1] : c.c[0];
    if (Math.abs(ci - s) < tol) {
      const v = side === "below" || side === "left" ? cj - c.r : cj + c.r;
      if (better(v)) best = v;
    }
  }
  return best;
}

/**
 * Where an extension line can start from a corner: the end, nearest the dimension's side, of a visible edge ending at
 * that station (19.8: a scarf's nib, where the splay starts, has no edge across the axis, only its corner).
 */
export function cornerAt(lines: ViewLines, side: Side, s: number, tol = 1e-3): number | null {
  const hor = side === "below" || side === "above";
  const i = hor ? 0 : 1,
    j = hor ? 1 : 0;
  let best: number | null = null;
  for (const [a, b] of visibleSegs(lines))
    for (const p of [a, b]) if (Math.abs(p[i] - s) < tol && (best === null || (side === "below" || side === "left" ? p[j] < best : p[j] > best))) best = p[j];
  return best;
}

/** Text boxes and lines on a block, to keep dimension text clear of. */
export class Occupied {
  texts: Box[] = [];
  lines: [P2, P2][] = [];
  addPrims(ps: Prim[]) {
    for (const p of ps) {
      if (p.t === "text") this.texts.push(textBox(p));
      else if (p.t === "line" && p.layer !== "HATCH") this.lines.push([p.a, p.b]);
      else if (p.t === "poly" && !p.fill) for (let i = 0; i + 1 < p.pts.length + (p.closed ? 1 : 0); i++) this.lines.push([p.pts[i], p.pts[(i + 1) % p.pts.length]]);
      else if (p.t === "circle" || p.t === "arc") this.texts.push([p.c[0] - p.r, p.c[1] - p.r, p.c[0] + p.r, p.c[1] + p.r]);
    }
  }
  free(b: Box, ignore: [P2, P2][] = []) {
    if (this.texts.some((t) => boxesHit(t, b, 0.2))) return false;
    for (const l of this.lines) {
      if (ignore.includes(l)) continue;
      if (segHitsBox(l[0], l[1], b)) return false;
    }
    return true;
  }
}

/** Where a side's tiers start: the object's extent on that side (page mm). */
export type Extent = { below: number; above: number; left: number; right: number };

export const FIRST = 10,
  STEP = 8,
  GAP = 2,
  PAST = 2,
  TICK = 1.3;

/** Place one dimension chain on the page. Returns its prims and what the checks need; text kept clear of occ. */
export function placeDim(spec: DimSpec, lines: ViewLines, pl: Placement, ext: Extent, occ: Occupied, chainId: string): { prims: Prim[]; metas: DimMeta[]; tier: number } | null {
  const hor = spec.side === "below" || spec.side === "above";
  const lowSide = spec.side === "below" || spec.side === "left";
  // stations: sorted, merged, each with a foot
  const pairs: { s: number; foot: number; key?: string }[] = [];
  const sorted = spec.stations.map((s, i) => ({ s, foot: spec.feet?.[i] })).sort((a, b) => a.s - b.s);
  for (const st of sorted) {
    if (pairs.length && Math.abs(pairs[pairs.length - 1].s - st.s) < 0.05) continue;
    const foot = st.foot ?? footAt(lines, spec.side, st.s);
    if (foot === null || foot === undefined) continue;
    pairs.push({ s: st.s, foot });
  }
  if (pairs.length < 2) return null;
  // a chain that lost its middle stations (hidden in this view) is just its overall again: leave it out
  if (!spec.overall && pairs.length === 2 && sorted.length > 2) return null;
  const P = (s: number, across: number): P2 => (hor ? toPage(pl, [s, across]) : toPage(pl, [across, s]));
  // the tier asked for, or further out if its lines would run through text already there (a section marker's letter)
  const lineFor = (tier: number) => {
    const off = FIRST + STEP * tier;
    return spec.side === "below" ? ext.below - off : spec.side === "above" ? ext.above + off : spec.side === "left" ? ext.left - off : ext.right + off;
  };
  // (only when moving out clears it: an extension line through a letter near the object is the letter's to move)
  const clearAt = (t: number) => {
    const at = lineFor(t);
    const segs: [P2, P2][] = pairs.map((p) => {
      const q = P(p.s, p.foot);
      return hor ? [[q[0], q[1]], [q[0], at]] : [[q[0], q[1]], [at, q[1]]];
    });
    const a0 = P(pairs[0].s, 0),
      a1 = P(pairs[pairs.length - 1].s, 0);
    segs.push(hor ? [[a0[0], at], [a1[0], at]] : [[at, a0[1]], [at, a1[1]]]);
    return !occ.texts.some((b) => segs.some(([a, c]) => segHitsBox(a, c, b)));
  };
  let tier = spec.tier ?? 0;
  for (let t = tier; t <= tier + 3; t++)
    if (clearAt(t)) {
      tier = t;
      break;
    }
  const lineAt = lineFor(tier);
  const prims: Prim[] = [];
  const metas: DimMeta[] = [];
  const pts = pairs.map((p) => {
    const q = P(p.s, p.foot);
    return { at: hor ? q[0] : q[1], foot: hor ? q[1] : q[0], s: p.s };
  });
  const dimPt = (along: number): P2 => (hor ? [along, lineAt] : [lineAt, along]);
  const view = pl.view;
  // extension lines: from 2 mm off the object to 2 mm past the dimension line
  for (const p of pts) {
    const dir = lowSide ? -1 : 1;
    const from = p.foot + dir * GAP,
      to = lineAt + dir * PAST;
    if ((to - from) * dir <= 0.5) continue;
    prims.push({ t: "line", a: hor ? [p.at, from] : [from, p.at], b: hor ? [p.at, to] : [to, p.at], w: W.thin, layer: "DIMS", view });
  }
  // the dimension line, end to end, and its ticks
  const first = pts[0].at,
    last = pts[pts.length - 1].at;
  let lo = first,
    hi = last;
  const tick = (along: number) => {
    const c = dimPt(along);
    prims.push({ t: "line", a: [c[0] - TICK, c[1] - TICK], b: [c[0] + TICK, c[1] + TICK], w: W.visible, layer: "DIMS", view });
  };
  pts.forEach((p) => tick(p.at));
  // the extension lines and ticks are there before any text is placed, so no value sits on them
  const own = prims.filter((p): p is Extract<Prim, { t: "line" }> => p.t === "line").map((p) => [p.a, p.b] as [P2, P2]);
  occ.lines.push(...own);
  // the ticks (pushed last): a value centred on its own segment may come close to its two ticks, not across them
  const ticks = own.slice(own.length - pts.length);
  // text for each segment
  const h = TH.note;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i],
      b = pts[i + 1];
    const value = Math.abs(b.s - a.s);
    const isRef = !!spec.ref || !!spec.refSegs?.some(([p, q]) => Math.abs(Math.min(p, q) - a.s) < 0.05 && Math.abs(Math.max(p, q) - b.s) < 0.05);
    const label = spec.labels?.[i] ?? (isRef ? `(${mm(value)})` : mm(value));
    // a reference (in brackets) measures the same thing as the size it repeats, marked as a reference
    const segKey = (k: number) => {
      const base = spec.keyFn ? spec.keyFn(a.s, b.s) : (spec.keys[k] ?? `${chainId}:${k}`);
      return isRef && !spec.ref && !base.startsWith("ref:") ? `ref:${base}` : base;
    };
    const tw = textWidth(label, h);
    const len = b.at - a.at;
    const mid = (a.at + b.at) / 2;
    const above = lowSide ? 0.9 : 0.9; // text sits above the line (to its left for a vertical one)
    // candidate positions along the line: centred; else outside at the chain's end; else below the line
    const cands: { c: number; across: number; anchor: "start" | "middle" | "end"; ext?: number }[] = [];
    if (tw + 0.9 < len) cands.push({ c: mid, across: above, anchor: "middle" });
    // (a short segment: centred a little further off the line, clear of its ticks; 19.5, a 6 mm shoulder at 1:2)
    if (tw + 0.9 < len) cands.push({ c: mid, across: TICK + 0.9, anchor: "middle" });
    // (past the end tick, clear of it)
    const out = TICK + 0.6;
    if (i === 0) cands.push({ c: a.at - out, across: above, anchor: "end", ext: a.at - out - tw - 0.6 });
    if (i + 2 === pts.length) cands.push({ c: b.at + out, across: above, anchor: "start", ext: b.at + out + tw + 0.6 });
    cands.push({ c: mid, across: -(0.9 + h), anchor: "middle" });
    for (const dx of [1, -1, 2, -2, 3, -3]) cands.push({ c: mid + dx * (tw / 2 + 1.5), across: -(0.9 + h), anchor: "middle" });
    if (tw + 1.6 >= len) for (const dx of [1, -1]) cands.push({ c: mid + dx * (tw / 2 + 1.5), across: above, anchor: "middle" });
    let placed = false;
    for (const cd of cands) {
      const t = textAt(hor, cd.c, lineAt, cd.across, cd.anchor, label, h, view);
      const box = textBox(t);
      const mine = cd.c === mid && cd.across === above ? [ticks[i], ticks[i + 1]] : [];
      const tight: Box = [box[0] + 0.35, box[1] + 0.35, box[2] - 0.35, box[3] - 0.35];
      if (!occ.free(box, mine) || mine.some(([p, q]) => segHitsBox(p, q, tight))) continue;
      prims.push(t);
      occ.texts.push(box);
      if (cd.ext !== undefined) {
        if (cd.ext < lo) lo = cd.ext;
        if (cd.ext > hi) hi = cd.ext;
      }
      if (cd.across < 0 && Math.abs(cd.c - mid) > tw / 2 + 0.5) {
        // moved off its segment: a short leader from the segment's middle to the text
        const tip = dimPt(mid);
        const end: P2 = hor ? [cd.c - Math.sign(cd.c - mid) * (tw / 2 + 0.3), lineAt - 0.9 - h / 2] : [lineAt - 0.9 - h / 2, cd.c - Math.sign(cd.c - mid) * (tw / 2 + 0.3)];
        prims.push({ t: "line", a: tip, b: end, w: W.thin, layer: "DIMS", view });
      }
      metas.push({ view, line: [dimPt(a.at), dimPt(b.at)], text: box, value, key: segKey(i), ...(isRef ? { ref: true } : {}), chain: chainId, ...(spec.overall ? { overall: true } : {}), feet: [hor ? [a.at, a.foot] : [a.foot, a.at], hor ? [b.at, b.foot] : [b.foot, b.at]] });
      placed = true;
      break;
    }
    if (!placed) {
      // nowhere clear: centred anyway (the checks will find it)
      const t = textAt(hor, mid, lineAt, above, "middle", label, h, view);
      prims.push(t);
      occ.texts.push(textBox(t));
      metas.push({ view, line: [dimPt(a.at), dimPt(b.at)], text: textBox(t), value, key: segKey(i), ...(isRef ? { ref: true } : {}), chain: chainId, ...(spec.overall ? { overall: true } : {}), feet: [hor ? [a.at, a.foot] : [a.foot, a.at], hor ? [b.at, b.foot] : [b.foot, b.at]] });
    }
  }
  const line: Prim = { t: "line", a: dimPt(lo), b: dimPt(hi), w: W.thin, layer: "DIMS", view };
  prims.push(line);
  occ.lines.push([line.a, line.b]);
  for (const p of prims) if (p.t === "line" && p !== line && !own.some((o) => o[0] === p.a)) occ.lines.push([p.a, p.b]);
  return { prims, metas, tier };
}

function textAt(hor: boolean, c: number, lineAt: number, across: number, anchor: "start" | "middle" | "end", s: string, h: number, view: string) {
  if (hor) return { t: "text" as const, at: [c, lineAt + across] as P2, s, h, anchor, base: "baseline" as const, layer: "DIMS" as const, role: "dim" as const, view };
  // vertical: reads upwards, its baseline to the left of the line
  return { t: "text" as const, at: [lineAt - across, c] as P2, s, h, anchor, base: "baseline" as const, rot: 90 as const, layer: "DIMS" as const, role: "dim" as const, view };
}

/** A leader note: an arrow on the object at tip, a line out to the text, the text beside its end. Tries places in order. */
export function leaderNote(tip: P2, s: string, occ: Occupied, view: string, prefer: P2[] = [], avoid: Box[] = []): { prims: Prim[]; box: Box } | null {
  const h = TH.note;
  // a note of several lines ("2 / KEYS" over "2 / M12 BOLTS", 19.8): stacked, the shelf at the first
  if (s.includes("\n")) return leaderLines(tip, s.split("\n"), occ, view, prefer, avoid);
  const tw = textWidth(s, h);
  const tries: P2[] = [...prefer];
  for (const r of [12, 18, 26, 34])
    for (const ang of [45, 135, -45, -135, 20, 160, -20, -160, 70, 110, -70, -110]) {
      const a = (ang * Math.PI) / 180;
      tries.push([tip[0] + r * Math.cos(a), tip[1] + r * Math.sin(a)]);
    }
  for (const e of tries) {
    const right = e[0] >= tip[0];
    const shelfEnd: P2 = [e[0] + (right ? 3 : -3), e[1]];
    const t = { t: "text" as const, at: [shelfEnd[0] + (right ? 0.8 : -0.8), e[1]] as P2, s, h, anchor: right ? ("start" as const) : ("end" as const), base: "middle" as const, layer: "NOTES" as const, role: "note" as const, view };
    const box = textBox(t);
    // (avoid: where its words shouldn't sit, though its line may cross: a section's hatching)
    if (!occ.free(box) || avoid.some((a) => boxesHit(a, box, 0))) continue;
    // the leader shouldn't cross other text
    const lb: Box = [Math.min(tip[0], e[0]), Math.min(tip[1], e[1]), Math.max(tip[0], e[0]), Math.max(tip[1], e[1])];
    if (occ.texts.some((b) => segHitsBox(tip, e, b) || segHitsBox(e, shelfEnd, b))) continue;
    void lb;
    const prims: Prim[] = [{ t: "line", a: tip, b: e, w: W.thin, layer: "NOTES", view }, { t: "line", a: e, b: shelfEnd, w: W.thin, layer: "NOTES", view }, arrow(tip, [tip[0] - e[0], tip[1] - e[1]], "NOTES"), t];
    occ.texts.push(box);
    occ.lines.push([tip, e], [e, shelfEnd]);
    return { prims, box };
  }
  return null;
}

/** A leader to a note of several lines: the first on the shelf, the rest under it, all from the same edge. */
function leaderLines(tip: P2, lines: string[], occ: Occupied, view: string, prefer: P2[], avoid: Box[]): { prims: Prim[]; box: Box } | null {
  const h = TH.note;
  const step = h + 1.4;
  const tries: P2[] = [...prefer];
  for (const r of [12, 18, 26, 34]) for (const ang of [45, 135, -45, -135, 20, 160, -20, -160, 70, 110, -70, -110]) tries.push([tip[0] + r * Math.cos((ang * Math.PI) / 180), tip[1] + r * Math.sin((ang * Math.PI) / 180)]);
  for (const e of tries) {
    const right = e[0] >= tip[0];
    const shelfEnd: P2 = [e[0] + (right ? 3 : -3), e[1]];
    const ts = lines.map((s, i) => ({ t: "text" as const, at: [shelfEnd[0] + (right ? 0.8 : -0.8), e[1] - i * step] as P2, s, h, anchor: right ? ("start" as const) : ("end" as const), base: "middle" as const, layer: "NOTES" as const, role: "note" as const, view }));
    const boxes = ts.map((t) => textBox(t));
    const box: Box = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
    if (!occ.free(box) || avoid.some((a) => boxesHit(a, box, 0))) continue;
    if (occ.texts.some((b) => segHitsBox(tip, e, b) || segHitsBox(e, shelfEnd, b))) continue;
    const prims: Prim[] = [{ t: "line", a: tip, b: e, w: W.thin, layer: "NOTES", view }, { t: "line", a: e, b: shelfEnd, w: W.thin, layer: "NOTES", view }, arrow(tip, [tip[0] - e[0], tip[1] - e[1]], "NOTES"), ...ts];
    occ.texts.push(...boxes);
    occ.lines.push([tip, e], [e, shelfEnd]);
    return { prims, box };
  }
  return null;
}
