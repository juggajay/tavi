// Putting a view's linework on the page (Stage 12.3): model millimetres to paper at a standard scale, with the line
// weights and dashes of plan A.5; hatching per material, angled the other way where two cut parts touch; centre lines
// through holes seen end on; long plain members broken rather than shrunk; details clipped to their frame. And the
// drafting symbols every sheet uses: view titles, section markers, balloons, arrows, the scale bar, the projection
// symbol.
import type { ModelMaterial } from "../protocol.js";
import type { Arc2, Chain, P2 as MP2, ViewLines } from "./hlr.js";
import { type Box, DASH, type Layer, type P2, type Prim, TH, type Text, W, segHitsBox, textBox, textWidth } from "./prims.js";

export const SCALES = [1, 2, 5, 10, 20, 50] as const;

/** A long plain stretch taken out of a view: model u from u0 to u1 removed, the ends drawn gap (paper mm) apart. */
export type Break = { u0: number; u1: number; gap: number };

export type Placement = { ox: number; oy: number; k: number; brk?: Break; view: string };

/** Model 2D (u, v) to the page. */
export function toPage(pl: Placement, p: MP2): P2 {
  let u = p[0];
  if (pl.brk && u >= pl.brk.u1 - 1e-9) u = u - (pl.brk.u1 - pl.brk.u0) + pl.brk.gap / pl.k;
  return [pl.ox + u * pl.k, pl.oy + p[1] * pl.k];
}

/** A chain's points with the break taken out: one or two runs. */
function breakChain(pts: MP2[], closed: boolean, brk?: Break): MP2[][] {
  const ring = closed ? [...pts, pts[0]] : pts;
  if (!brk) return [ring];
  const runs: MP2[][] = [];
  let cur: MP2[] = [];
  const inside = (u: number) => u > brk.u0 + 1e-9 && u < brk.u1 - 1e-9;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i],
      b = ring[i + 1];
    // clip ab against the removed band
    const segs: [MP2, MP2][] = [];
    const lerp = (t: number): MP2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const ts = [0, 1];
    for (const u of [brk.u0, brk.u1]) {
      const d = b[0] - a[0];
      if (Math.abs(d) > 1e-12) {
        const t = (u - a[0]) / d;
        if (t > 1e-9 && t < 1 - 1e-9) ts.push(t);
      }
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      const p = lerp(ts[k]),
        q = lerp(ts[k + 1]);
      if (!inside((p[0] + q[0]) / 2)) segs.push([p, q]);
    }
    for (const [p, q] of segs) {
      const last = cur[cur.length - 1];
      if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 1e-6) cur.push(q);
      else {
        if (cur.length > 1) runs.push(cur);
        cur = [p, q];
      }
    }
    if (!segs.length && cur.length) {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

const kindStyle = (k: Chain["kind"]): { w: number; dash?: readonly number[]; layer: Layer } => (k === "cut" ? { w: W.cut, layer: "CUT" } : k === "visible" ? { w: W.visible, layer: "OUTLINE" } : { w: W.hidden, dash: DASH.hidden, layer: "HIDDEN" });

/** Paper rectangle a detail is clipped to. */
export type Clip = Box;

/** Clip a polyline to a box: the runs inside. */
function clipRun(pts: P2[], b: Box): P2[][] {
  const out: P2[][] = [];
  let cur: P2[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i],
      c = pts[i + 1];
    let t0 = 0,
      t1 = 1;
    const dx = c[0] - a[0],
      dy = c[1] - a[1];
    let ok = true;
    for (const [p, q] of [
      [-dx, a[0] - b[0]],
      [dx, b[2] - a[0]],
      [-dy, a[1] - b[1]],
      [dy, b[3] - a[1]],
    ]) {
      if (Math.abs(p) < 1e-12) {
        if (q < 0) ok = false;
        continue;
      }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
    if (!ok || t0 > t1 - 1e-9) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      continue;
    }
    const p: P2 = [a[0] + dx * t0, a[1] + dy * t0],
      q: P2 = [a[0] + dx * t1, a[1] + dy * t1];
    const last = cur[cur.length - 1];
    if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 1e-6) cur.push(q);
    else {
      if (cur.length > 1) out.push(cur);
      cur = [p, q];
    }
    if (t1 < 1 - 1e-9) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** A polygon clipped to a box (Sutherland–Hodgman; fine for a box). */
export function clipPoly(pts: P2[], b: Box): P2[] {
  let poly = pts;
  const edges: [(p: P2) => boolean, (p: P2, q: P2) => P2][] = [
    [(p) => p[0] >= b[0], (p, q) => [b[0], p[1] + ((q[1] - p[1]) * (b[0] - p[0])) / (q[0] - p[0])]],
    [(p) => p[0] <= b[2], (p, q) => [b[2], p[1] + ((q[1] - p[1]) * (b[2] - p[0])) / (q[0] - p[0])]],
    [(p) => p[1] >= b[1], (p, q) => [p[0] + ((q[0] - p[0]) * (b[1] - p[1])) / (q[1] - p[1]), b[1]]],
    [(p) => p[1] <= b[3], (p, q) => [p[0] + ((q[0] - p[0]) * (b[3] - p[1])) / (q[1] - p[1]), b[3]]],
  ];
  for (const [inside, cut] of edges) {
    const out: P2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i],
        q = poly[(i + 1) % poly.length];
      if (inside(q)) {
        if (!inside(p)) out.push(cut(p, q));
        out.push(q);
      } else if (inside(p)) out.push(cut(p, q));
    }
    poly = out;
    if (!poly.length) break;
  }
  return poly;
}

export type HatchStyle = { angle: number; gap: number; cross?: boolean; along?: boolean };

/** Hatch lines over even-odd loops (page mm), as real line segments. */
export function hatchLines(loops: P2[][], s: HatchStyle): [P2, P2][] {
  const out: [P2, P2][] = [];
  const angles = s.cross ? [s.angle, s.angle + 90] : [s.angle];
  for (const deg of angles) {
    const a = (deg * Math.PI) / 180;
    const d: P2 = [Math.cos(a), Math.sin(a)],
      nrm: P2 = [-d[1], d[0]];
    let lo = Infinity,
      hi = -Infinity;
    for (const l of loops) for (const p of l) (lo = Math.min(lo, p[0] * nrm[0] + p[1] * nrm[1])), (hi = Math.max(hi, p[0] * nrm[0] + p[1] * nrm[1]));
    // lines at whole multiples of the gap, so neighbouring regions' lines would line up; offset half a gap from the edge
    for (let o = Math.ceil(lo / s.gap) * s.gap; o <= hi; o += s.gap) {
      const ts: number[] = [];
      for (const l of loops)
        for (let i = 0; i < l.length; i++) {
          const p = l[i],
            q = l[(i + 1) % l.length];
          const sp = p[0] * nrm[0] + p[1] * nrm[1] - o,
            sq = q[0] * nrm[0] + q[1] * nrm[1] - o;
          if ((sp > 0) === (sq > 0)) continue;
          const t = sp / (sp - sq);
          const x: P2 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
          ts.push(x[0] * d[0] + x[1] * d[1]);
        }
      ts.sort((x, y) => x - y);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        if (ts[i + 1] - ts[i] < 0.3) continue;
        const base: P2 = [nrm[0] * o, nrm[1] * o];
        out.push([
          [base[0] + d[0] * ts[i], base[1] + d[1] * ts[i]],
          [base[0] + d[0] * ts[i + 1], base[1] + d[1] * ts[i + 1]],
        ]);
      }
    }
  }
  return out;
}

/** Which hatch a cut part gets: timber across the grain, timber along it, sheet goods, metal (plan A.5, B9). */
export function hatchFor(material: ModelMaterial, endGrain: boolean, spec = ""): { key: string; label: string; style: HatchStyle } {
  // what it really is, when the owner said (a melamine board modelled as ply is hatched as board, 12.10)
  if (/\bMDF\b/.test(spec)) return { key: "mdf", label: "MDF", style: { angle: 45, gap: 2.2, cross: true } };
  if (/MELAMINE|HMR|PARTICLE|CHIPBOARD/.test(spec)) return { key: "board", label: "PARTICLEBOARD", style: { angle: 135, gap: 1.6 } };
  if (/\bPLY/.test(spec)) return { key: "ply", label: "PLYWOOD", style: { angle: 45, gap: 1.2 } };
  if (/STEEL|GALV|BOLT|SCREW/.test(spec)) return { key: "steel", label: "STEEL", style: { angle: 45, gap: 0.8 } };
  if (material === "ply") return { key: "ply", label: "PLYWOOD", style: { angle: 45, gap: 1.2 } };
  if (material === "mdf") return { key: "mdf", label: "MDF", style: { angle: 45, gap: 2.2, cross: true } };
  if (material === "steel") return { key: "steel", label: "STEEL", style: { angle: 45, gap: 0.8 } };
  if (material === "concrete") return { key: "concrete", label: "CONCRETE", style: { angle: 45, gap: 3.5 } };
  if (material === "plain") return { key: "plain", label: "MATERIAL TBC", style: { angle: 45, gap: 3 } };
  return endGrain ? { key: "end", label: "TIMBER, CUT ACROSS GRAIN", style: { angle: 45, gap: 2 } } : { key: "long", label: "TIMBER, CUT ALONG GRAIN", style: { angle: 0, gap: 2.5, along: true } };
}

export type DrawOpts = {
  /** Hatch per part index (already chosen, alternating where parts touch). */
  hatch?: (part: number) => HatchStyle | null;
  clip?: Clip;
  /** Centre lines through circles (holes seen end on). */
  centres?: boolean;
  layer?: Layer;
};

/** A view's linework on the page. */
export function drawLines(lines: ViewLines, pl: Placement, o: DrawOpts = {}): Prim[] {
  const out: Prim[] = [];
  const view = pl.view;
  // hatches first, under the lines
  if (o.hatch)
    for (const h of lines.hatches) {
      const st = o.hatch(h.part);
      if (!st) continue;
      let loops = h.loops.map((l) => l.map((p) => toPage(pl, p)));
      if (o.clip) loops = loops.map((l) => clipPoly(l, o.clip!)).filter((l) => l.length >= 3);
      for (const [a, b] of hatchLines(loops, st)) out.push({ t: "line", a, b, w: W.thin, layer: "HATCH", view });
    }
  for (const c of lines.chains) {
    const st = kindStyle(c.kind);
    for (const run of breakChain(c.pts, !!c.closed, pl.brk)) {
      const pts = run.map((p) => toPage(pl, p));
      const runs = o.clip ? clipRun(pts, o.clip) : [pts];
      for (const r of runs) {
        const closed = !pl.brk && !o.clip && c.closed && r.length === c.pts.length + 1;
        out.push({ t: "poly", pts: closed ? r.slice(0, -1) : r, closed, ...st, view });
      }
    }
  }
  for (const a of lines.arcs) out.push(...arcPrims(a, pl, o.clip));
  if (o.centres !== false) {
    const seen = new Set<string>();
    for (const a of lines.arcs) {
      if (a.kind === "hidden" && lines.arcs.some((b) => b !== a && b.kind !== "hidden" && Math.hypot(b.c[0] - a.c[0], b.c[1] - a.c[1]) < 1e-6)) continue;
      const c = toPage(pl, a.c);
      const k = `${c[0].toFixed(2)},${c[1].toFixed(2)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const r = a.r * pl.k + 2.5;
      if (o.clip && (c[0] < o.clip[0] || c[0] > o.clip[2] || c[1] < o.clip[1] || c[1] > o.clip[3])) continue;
      out.push({ t: "line", a: [c[0] - r, c[1]], b: [c[0] + r, c[1]], w: W.thin, dash: r > 8 ? DASH.centre : undefined, layer: "CENTRE", view });
      out.push({ t: "line", a: [c[0], c[1] - r], b: [c[0], c[1] + r], w: W.thin, dash: r > 8 ? DASH.centre : undefined, layer: "CENTRE", view });
    }
  }
  return out;
}

function arcPrims(a: Arc2, pl: Placement, clip?: Clip): Prim[] {
  const st = kindStyle(a.kind);
  const c = toPage(pl, a.c);
  const r = a.r * pl.k;
  const full = a.a1 - a.a0 >= 2 * Math.PI - 1e-6;
  const deg = (x: number) => (x * 180) / Math.PI;
  if (!clip || (c[0] - r >= clip[0] && c[0] + r <= clip[2] && c[1] - r >= clip[1] && c[1] + r <= clip[3])) {
    if (full) return [{ t: "circle", c, r, ...st, view: pl.view }];
    return [{ t: "arc", c, r, a0: deg(a.a0), a1: deg(a.a1), ...st, view: pl.view }];
  }
  // partly outside the clip: as short straight pieces, clipped
  const n = 48;
  const pts: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a.a0 + ((full ? 2 * Math.PI : a.a1 - a.a0) * i) / n;
    pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return clipRun(pts, clip).map((run) => ({ t: "poly" as const, pts: run, ...st, view: pl.view }));
}

/** The long-break symbol across a member at page x, from y0 to y1: a thin line with a Z in the middle, past the edges. */
export function breakSymbol(x: number, y0: number, y1: number, view: string): Prim {
  const m = (y0 + y1) / 2,
    h = Math.min(3, (y1 - y0) / 4);
  return {
    t: "poly",
    pts: [
      [x, y0 - 2],
      [x, m - h],
      [x + 1.6, m - h / 3],
      [x - 1.6, m + h / 3],
      [x, m + h],
      [x, y1 + 2],
    ],
    w: W.thin,
    layer: "SYMBOLS",
    view,
  };
}

/* ---------------- symbols ---------------- */

export const text = (at: P2, s: string, h: number, o: Partial<Omit<Text, "t" | "at" | "s" | "h">> = {}): Text => ({ t: "text", at, s, h, anchor: "start", base: "baseline", layer: "NOTES", ...o });

/** A filled arrowhead with its tip at tip, pointing along dir; length 2.5, half-width 0.6. */
export function arrow(tip: P2, dir: P2, layer: Layer = "DIMS", len = 2.5): Prim {
  const l = Math.hypot(dir[0], dir[1]) || 1;
  const d: P2 = [dir[0] / l, dir[1] / l];
  const n: P2 = [-d[1], d[0]];
  const b: P2 = [tip[0] - d[0] * len, tip[1] - d[1] * len];
  return {
    t: "poly",
    pts: [tip, [b[0] + n[0] * 0.6, b[1] + n[1] * 0.6], [b[0] - n[0] * 0.6, b[1] - n[1] * 0.6]],
    closed: true,
    fill: true,
    w: W.thin,
    layer,
  };
}

/**
 * A view's title under it (plan A.5): a bubble with its identifier, the title underlined beside it, the scale under the
 * title. at: the top-left of the title block's space; returns the prims and the box it takes.
 */
export function viewTitle(at: P2, id: string, title: string, scale: number | null, view: string, extra?: string): { prims: Prim[]; box: Box } {
  const r = 4.2;
  const c: P2 = [at[0] + r, at[1] - r - 0.5];
  const tx = c[0] + r + 2.5;
  const lines = [title];
  const tw = Math.max(...lines.map((l) => textWidth(l, TH.head, true)), scale ? textWidth(`SCALE 1:${scale}${extra ? `  ${extra}` : ""}`, TH.note) : 0);
  const prims: Prim[] = [
    { t: "circle", c, r, w: W.visible, layer: "SYMBOLS", view },
    text(c, id, id.length > 1 ? TH.note : TH.head, { anchor: "middle", base: "middle", bold: true, layer: "SYMBOLS", role: "title", view }),
    text([tx, c[1] + 0.9], title, TH.head, { bold: true, role: "title", view }),
    { t: "line", a: [tx, c[1] - 0.4], b: [tx + textWidth(title, TH.head, true), c[1] - 0.4], w: W.visible, layer: "SYMBOLS", view },
  ];
  if (scale) prims.push(text([tx, c[1] - 1.6], `SCALE 1:${scale}${extra ? `  ${extra}` : ""}`, TH.note, { base: "top", role: "title", view }));
  return { prims, box: [at[0], c[1] - r - 1, tx + tw + 0.5, at[1]] };
}

/** A balloon: a circle with the part number. */
export function balloon(c: P2, mark: number, view: string): Prim[] {
  return [
    { t: "circle", c, r: 3.6, w: W.visible, layer: "BALLOONS", view },
    text(c, String(mark), TH.note, { anchor: "middle", base: "middle", bold: true, layer: "BALLOONS", role: "balloon", view }),
  ];
}

/**
 * A cutting-plane line from a to b on the page (plan A.5): thin chain, thick at the ends, arrows at the ends pointing
 * the way it's looked at (dir), and the letter beside each arrow.
 */
export function sectionMarker(a: P2, b: P2, dir: P2, letter: string, view: string, free: (box: Box) => boolean = () => true): Prim[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const t: P2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  // one style everywhere (12.10): thick ends 5 long, arrows 7 out, the letter in the same place at both ends
  const end = Math.min(5, L / 3);
  const dl = Math.hypot(dir[0], dir[1]) || 1;
  const d: P2 = [dir[0] / dl, dir[1] / dl];
  const out: Prim[] = [
    { t: "line", a, b, w: W.thin, dash: DASH.plane, layer: "SYMBOLS", view },
    { t: "line", a, b: [a[0] + t[0] * end, a[1] + t[1] * end], w: W.plane, layer: "SYMBOLS", view },
    { t: "line", a: [b[0] - t[0] * end, b[1] - t[1] * end], b, w: W.plane, layer: "SYMBOLS", view },
  ];
  // the letter beside the arrow, away from the drawing: beyond the line's end first, then past the arrow's tip, then
  // further out; the first spot free at both ends is used at both, so the pair match
  const cands = (p: P2): P2[] => {
    const s: P2 = [p[0] + d[0] * 7, p[1] + d[1] * 7];
    const away: P2 = p === a ? [-t[0], -t[1]] : t;
    return [
      [p[0] + d[0] * 3.5 + away[0] * 3.2, p[1] + d[1] * 3.5 + away[1] * 3.2],
      [s[0] + d[0] * 3 + away[0] * 1.5, s[1] + d[1] * 3 + away[1] * 1.5],
      [p[0] + d[0] * 3.5 + away[0] * 6.5, p[1] + d[1] * 3.5 + away[1] * 6.5],
      [s[0] + d[0] * 6.5, s[1] + d[1] * 6.5],
      [p[0] + d[0] * 3.5 + away[0] * 10, p[1] + d[1] * 3.5 + away[1] * 10],
      [s[0] + d[0] * 3 + away[0] * 6, s[1] + d[1] * 3 + away[1] * 6],
      [s[0] + d[0] * 10, s[1] + d[1] * 10],
      [s[0] + away[0] * 4.5, s[1] + away[1] * 4.5],
      [s[0] - away[0] * 4.5, s[1] - away[1] * 4.5],
      [p[0] + d[0] * 3.5 - away[0] * 4.5, p[1] + d[1] * 3.5 - away[1] * 4.5],
      [s[0] + d[0] * 6 + away[0] * 9, s[1] + d[1] * 6 + away[1] * 9],
      [s[0] + d[0] * 14, s[1] + d[1] * 14],
      [p[0] - d[0] * 3.5 + away[0] * 3.2, p[1] - d[1] * 3.5 + away[1] * 3.2],
      [p[0] - d[0] * 3.5 + away[0] * 6.5, p[1] - d[1] * 3.5 + away[1] * 6.5],
    ];
  };
  const mk = (at: P2) => text(at, letter, TH.head, { anchor: "middle", base: "middle", bold: true, layer: "SYMBOLS", role: "label", view });
  const ca = cands(a).map(mk),
    cb = cands(b).map(mk);
  const both = ca.findIndex((x, i) => free(textBox(x)) && free(textBox(cb[i])));
  for (const [p, cs] of [
    [a, ca],
    [b, cb],
  ] as const) {
    const s: P2 = [p[0] + d[0] * 7, p[1] + d[1] * 7];
    out.push({ t: "line", a: p, b: s, w: W.visible, layer: "SYMBOLS", view });
    out.push(arrow(s, d, "SYMBOLS", 3));
    out.push(both >= 0 ? cs[both] : (cs.find((x) => free(textBox(x))) ?? cs[0]));
  }
  return out;
}

/** The third-angle projection symbol (ISO 5456-2 / AS 1100.101): the cone's side view, then its end view to the right. */
export function projectionSymbol(at: P2, h = 6): Prim[] {
  const [x, y] = at; // bottom-left
  const R = h / 2,
    r = h / 4,
    L = h * 1.1;
  const cy = y + R;
  return [
    // the cone narrows towards the circles: tall on the left, short on the right
    { t: "poly", pts: [[x, cy - R], [x + L, cy - r], [x + L, cy + r], [x, cy + R]], closed: true, w: W.thin, layer: "TITLE" },
    { t: "line", a: [x - 1.5, cy], b: [x + L + 3 + 2 * R + 1.5, cy], w: W.thin, dash: [3, 1, 1, 1], layer: "TITLE" },
    { t: "circle", c: [x + L + 3 + R, cy], r: R, w: W.thin, layer: "TITLE" },
    { t: "circle", c: [x + L + 3 + R, cy], r, w: W.thin, layer: "TITLE" },
    { t: "line", a: [x + L + 3 + R, cy - R - 1.5], b: [x + L + 3 + R, cy + R + 1.5], w: W.thin, dash: [3, 1, 1, 1], layer: "TITLE" },
  ];
}

/** A scale bar: 100 mm on the paper long, in ten steps, labelled in model millimetres at that scale. */
export function scaleBar(at: P2, scale: number): Prim[] {
  const [x, y] = at;
  const len = 100,
    h = 1.6;
  const out: Prim[] = [{ t: "poly", pts: [[x, y], [x + len, y], [x + len, y + h], [x, y + h]], closed: true, w: W.thin, layer: "TITLE" }];
  for (let i = 0; i < 10; i++) if (i % 2 === 0) out.push({ t: "poly", pts: [[x + i * 10, y], [x + i * 10 + 10, y], [x + i * 10 + 10, y + h], [x + i * 10, y + h]], closed: true, fill: true, w: 0, layer: "TITLE" });
  for (const i of [0, 5, 10]) out.push(text([x + i * 10, y + h + 1], `${(i * 10 * scale).toLocaleString("en-AU")}`, TH.note, { anchor: i === 0 ? "start" : i === 10 ? "end" : "middle", layer: "TITLE", role: "block" }));
  out.push(text([x + len + 2, y + h / 2], `MM AT 1:${scale} ON A3`, TH.note, { base: "middle", layer: "TITLE", role: "block" }));
  return out;
}
