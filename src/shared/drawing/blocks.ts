// Blocks and views for shop drawing sheets (Stage 12.3, moved here in Stage 19 so the joint details can share them):
// a block is linework, sizes and notes laid out together in paper millimetres and then moved into place; a view is a
// view's linework placed at a scale with its dimensions and notes kept clear of it; free space on a sheet in 2 mm cells.
import type { ViewLines } from "./hlr.js";
import { type DimSpec, type Extent, Occupied, bestSide, leaderNote, placeDim } from "./dims.js";
import { type Box, DASH, type DimMeta, type P2, type Prim, TH, type Text, type ViewMeta, W, segHitsBox, textBox } from "./prims.js";
import { type Break, type HatchStyle, type Placement, breakSymbol, drawLines, text, toPage, viewTitle } from "./render.js";

export const r1 = (v: number) => Math.round(v * 10) / 10;
export const key = (frame: string, axis: string, a: number, b: number) => `${frame}:${axis}:${r1(Math.min(a, b))}:${r1(Math.max(a, b))}`;

/* ---------------- blocks: things laid out together, then moved into place ---------------- */

export type Block = { prims: Prim[]; box: Box; views: ViewMeta[]; dims: DimMeta[]; balloons: { mark: number; at: P2; view?: string }[]; markers: { letter: string; view: string; at?: P2; r?: number }[]; legend: Set<string>; pending?: { tip: P2; s: string; view: string }[] };

/** The notes with leaders a block's views asked for, placed once everything else in the block is there. */
export function placeLeaders(b: Block, occ: Occupied) {
  for (const ld of b.pending ?? []) {
    const r = leaderNote(ld.tip, ld.s, occ, ld.view);
    if (r) addPrims(b, r.prims);
  }
  b.pending = [];
}
export const emptyBlock = (): Block => ({ prims: [], box: [Infinity, Infinity, -Infinity, -Infinity], views: [], dims: [], balloons: [], markers: [], legend: new Set() });

export function primBox(p: Prim): Box {
  switch (p.t) {
    case "line":
      return [Math.min(p.a[0], p.b[0]), Math.min(p.a[1], p.b[1]), Math.max(p.a[0], p.b[0]), Math.max(p.a[1], p.b[1])];
    case "poly": {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const q of p.pts) (x0 = Math.min(x0, q[0])), (y0 = Math.min(y0, q[1])), (x1 = Math.max(x1, q[0])), (y1 = Math.max(y1, q[1]));
      return [x0, y0, x1, y1];
    }
    case "arc":
    case "circle":
      return [p.c[0] - p.r, p.c[1] - p.r, p.c[0] + p.r, p.c[1] + p.r];
    case "text":
      return textBox(p);
  }
}
export const growBox = (b: Box, c: Box) => {
  b[0] = Math.min(b[0], c[0]);
  b[1] = Math.min(b[1], c[1]);
  b[2] = Math.max(b[2], c[2]);
  b[3] = Math.max(b[3], c[3]);
};
export function addPrims(b: Block, ps: Prim[]) {
  for (const p of ps) {
    b.prims.push(p);
    growBox(b.box, primBox(p));
  }
}
export const mv = (p: P2, dx: number, dy: number): P2 => [p[0] + dx, p[1] + dy];
export const mvBox = (b: Box, dx: number, dy: number): Box => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
export function moveBlock(b: Block, dx: number, dy: number): Block {
  const prims = b.prims.map((p): Prim => {
    switch (p.t) {
      case "line":
        return { ...p, a: mv(p.a, dx, dy), b: mv(p.b, dx, dy) };
      case "poly":
        return { ...p, pts: p.pts.map((q) => mv(q, dx, dy)) };
      case "arc":
      case "circle":
        return { ...p, c: mv(p.c, dx, dy) };
      case "text":
        return { ...p, at: mv(p.at, dx, dy) };
    }
  });
  return {
    prims,
    box: mvBox(b.box, dx, dy),
    views: b.views.map((v) => ({ ...v, box: mvBox(v.box, dx, dy), ox: v.ox + dx, oy: v.oy + dy, aligned: v.aligned?.map((a) => ({ ...a, at: a.at + (a.axis === "x" ? dx : dy), other: a.other + (a.axis === "x" ? dx : dy) })) })),
    dims: b.dims.map((d) => ({ ...d, line: [mv(d.line[0], dx, dy), mv(d.line[1], dx, dy)], text: mvBox(d.text, dx, dy), feet: d.feet.map((f) => mv(f, dx, dy)) })),
    balloons: b.balloons.map((x) => ({ ...x, at: mv(x.at, dx, dy) })),
    markers: b.markers.map((m) => (m.at ? { ...m, at: mv(m.at, dx, dy) } : m)),
    legend: b.legend,
  };
}
export const blockW = (b: Block) => b.box[2] - b.box[0];
export const blockH = (b: Block) => b.box[3] - b.box[1];
export function merge(into: Block, b: Block) {
  into.pending = [...(into.pending ?? []), ...(b.pending ?? [])];
  addPrims(into, b.prims);
  into.views.push(...b.views);
  into.dims.push(...b.dims);
  into.balloons.push(...b.balloons);
  into.markers.push(...b.markers);
  b.legend.forEach((x) => into.legend.add(x));
}

/** Free space on a sheet, in 2 mm cells, for putting a block where nothing is. */
export class Space {
  private cell = 2;
  private nx: number;
  private ny: number;
  private sat: Int32Array;
  private grid: Uint8Array;
  constructor(private area: Box) {
    this.nx = Math.ceil((area[2] - area[0]) / this.cell);
    this.ny = Math.ceil((area[3] - area[1]) / this.cell);
    this.grid = new Uint8Array(this.nx * this.ny);
    this.sat = new Int32Array((this.nx + 1) * (this.ny + 1));
  }
  fill(b: Box, pad = 0) {
    const i0 = Math.max(0, Math.floor((b[0] - pad - this.area[0]) / this.cell)),
      i1 = Math.min(this.nx - 1, Math.floor((b[2] + pad - this.area[0]) / this.cell));
    const j0 = Math.max(0, Math.floor((b[1] - pad - this.area[1]) / this.cell)),
      j1 = Math.min(this.ny - 1, Math.floor((b[3] + pad - this.area[1]) / this.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.grid[j * this.nx + i] = 1;
  }
  fillBlock(b: Block, pad = 4) {
    // a view's whole area is taken (nothing goes in the space inside a frame), then everything drawn round it
    for (const v of b.views) this.fill(v.box, pad);
    for (const p of b.prims) {
      if (p.t === "line" && p.layer === "HATCH") continue;
      // long slanted lines (leaders): their cells along the way, not their whole box
      if (p.t === "line" && Math.abs(p.a[0] - p.b[0]) > 4 && Math.abs(p.a[1] - p.b[1]) > 4) {
        const n = Math.ceil(Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) / this.cell);
        for (let k = 0; k <= n; k++) {
          const x = p.a[0] + ((p.b[0] - p.a[0]) * k) / n,
            y = p.a[1] + ((p.b[1] - p.a[1]) * k) / n;
          this.fill([x, y, x, y], pad);
        }
        continue;
      }
      this.fill(primBox(p), pad);
    }
  }
  private build() {
    const W1 = this.nx + 1;
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) this.sat[(j + 1) * W1 + (i + 1)] = this.grid[j * this.nx + i] + this.sat[j * W1 + (i + 1)] + this.sat[(j + 1) * W1 + i] - this.sat[j * W1 + i];
  }
  /** The first free spot for a w × h box, searched from the given corner. */
  find(w: number, h: number, from: "tr" | "br" | "tl" | "bl"): P2 | null {
    this.build();
    const cw = Math.ceil(w / this.cell),
      ch = Math.ceil(h / this.cell);
    if (cw > this.nx || ch > this.ny) return null;
    const W1 = this.nx + 1;
    const xs: number[] = [],
      ys: number[] = [];
    for (let i = 0; i + cw <= this.nx; i++) xs.push(i);
    for (let j = 0; j + ch <= this.ny; j++) ys.push(j);
    if (from === "tr" || from === "br") xs.reverse();
    if (from === "tr" || from === "tl") ys.reverse();
    for (const j of ys)
      for (const i of xs) {
        const s = this.sat[(j + ch) * W1 + (i + cw)] - this.sat[j * W1 + (i + cw)] - this.sat[(j + ch) * W1 + i] + this.sat[j * W1 + i];
        if (s === 0) return [this.area[0] + i * this.cell, this.area[1] + j * this.cell];
      }
    return null;
  }
}

/* ---------------- a view: linework placed, dimensioned, titled ---------------- */

export type ViewBuild = {
  id: string;
  lines: ViewLines;
  min: P2;
  max: P2;
  scale: number;
  brk?: Break;
  dims: DimSpec[];
  hatch?: (part: number) => HatchStyle | null;
  clip?: [number, number, number, number]; // model 2D window
  kind: ViewMeta["kind"];
  title: string;
  extra?: string;
  mark?: number;
  /** A part view drawn for several part numbers (the same part under different names, 12.10). */
  marks?: number[];
  /** Notes with leaders: model 2D point and text. */
  leaders?: { at: P2; s: string }[];
  /** A cropped view gets its own dashed frame unless it sits in a framed group (a joint detail, Stage 19.2). */
  frame?: boolean;
  /** Linework drawn with the view, once it's placed (centre lines along a bolt, break lines where a crop cuts a part). */
  draw?: (pl: Placement) => Prim[];
  /** A view in a joint detail: the detail's letter, and what this view is. */
  group?: string;
  role?: ViewMeta["role"];
  /** The part numbers ballooned on it (a pulled-apart joint). */
  ballooned?: number[];
};

export function paperSize(v: ViewBuild): P2 {
  const k = 1 / v.scale;
  const [u0, v0] = v.clip ? [v.clip[0], v.clip[1]] : v.min;
  const [u1, v1] = v.clip ? [v.clip[2], v.clip[3]] : v.max;
  let w = (u1 - u0) * k;
  if (v.brk) w -= (v.brk.u1 - v.brk.u0) * k - v.brk.gap;
  return [w, (v1 - v0) * k];
}
export function dimRoom(v: ViewBuild): Extent {
  const tiers: Record<string, number> = {};
  for (const d of v.dims) tiers[d.side] = Math.max(tiers[d.side] ?? 0, (d.tier ?? 0) + 1);
  const room = (s: string) => (tiers[s] ? 10 + 8 * (tiers[s] - 1) + TH.note + 2.2 : 0);
  return { below: room("below"), above: room("above"), left: room("left"), right: room("right") };
}

/**
 * Puts a view on the page with its low-left linework corner at (x, y): lines, then anything drawn over them (section
 * markers), then dimensions and notes kept clear of all that.
 */
export function placeView(v: ViewBuild, x: number, y: number, occ: Occupied, over?: (pl: Placement, occ: Occupied, again?: boolean) => Prim[]): Block {
  const b = emptyBlock();
  const k = 1 / v.scale;
  const u0 = v.clip ? v.clip[0] : v.min[0],
    v0 = v.clip ? v.clip[1] : v.min[1];
  const pl: Placement = { ox: x - u0 * k, oy: y - v0 * k, k, ...(v.brk ? { brk: v.brk } : {}), view: v.id };
  const sz = paperSize(v);
  const clip: Box | undefined = v.clip ? [x, y, x + sz[0], y + sz[1]] : undefined;
  const lines = drawLines(v.lines, pl, { hatch: v.hatch, clip });
  addPrims(b, lines);
  if (v.brk) {
    const bx0 = toPage(pl, [v.brk.u0, 0])[0],
      bx1 = bx0 + v.brk.gap;
    const ys = lines.filter((p) => p.t === "poly" && p.layer !== "HATCH").flatMap((p) => (p as { pts: P2[] }).pts.filter((q) => Math.abs(q[0] - bx0) < 1e-6 || Math.abs(q[0] - bx1) < 1e-6).map((q) => q[1]));
    const ya = ys.length ? Math.min(...ys) : y,
      yb = ys.length ? Math.max(...ys) : y + sz[1];
    addPrims(b, [breakSymbol(bx0, ya, yb, v.id), breakSymbol(bx1, ya, yb, v.id)]);
  }
  if (v.draw) addPrims(b, v.draw(pl));
  if (clip && v.frame !== false) addPrims(b, [{ t: "poly", pts: [[clip[0] - 3, clip[1] - 3], [clip[2] + 3, clip[1] - 3], [clip[2] + 3, clip[3] + 3], [clip[0] - 3, clip[3] + 3]], closed: true, w: W.thin, dash: DASH.frame, layer: "SYMBOLS", view: v.id }]);
  occ.addPrims(b.prims.filter((p) => p.layer !== "HATCH"));
  let extra: Prim[] = [];
  if (over) {
    extra = over(pl, occ);
    addPrims(b, extra);
    occ.addPrims(extra);
  }
  const box: Box = clip ? [clip[0] - 3, clip[1] - 3, clip[2] + 3, clip[3] + 3] : [x, y, x + sz[0], y + sz[1]];
  const ext: Extent = { below: box[1], above: box[3], left: box[0], right: box[2] };
  // tiers on each side stay in order: inner chains first, the overall outermost, each at least a step past the last
  const used: Record<string, number> = {};
  const feetLines = v.clip ? clipLines(v.lines, v.clip) : v.lines;
  // a flexible chain and its overall move together, to the side where their extension lines are shortest
  const sideMap: Record<string, DimSpec["side"]> = {};
  for (const d of [...v.dims].sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0))) if (!(d.side in sideMap)) sideMap[d.side] = bestSide(d, feetLines);
  [...v.dims.map((d, i) => ({ d: { ...d, side: d.flex ? sideMap[d.side] : d.side }, i }))].sort((a, b) => (a.d.tier ?? 0) - (b.d.tier ?? 0)).forEach(({ d, i }) => {
    const r = placeDim({ ...d, tier: Math.max(d.tier ?? 0, used[d.side] ?? 0) }, v.clip ? clipLines(v.lines, v.clip) : v.lines, pl, ext, occ, `${v.id}.${i}`);
    if (!r) return;
    used[d.side] = r.tier + 1;
    addPrims(b, r.prims);
    for (const m of r.metas) b.dims.push({ ...m, chain: d.partial ? `${m.chain}~partial` : d.total !== undefined ? `${m.chain}=${r1(d.total)}` : m.chain });
  });
  // in a section, the hatching stops 1 mm short of each size's lines where they pass over the cut (12.10, AS 1100's
  // "hatching is interrupted" for dimensions): no extension line runs through hatching
  if (v.hatch) {
    const cutters = b.prims.flatMap((q) => (q.layer === "DIMS" && q.t === "line" ? [[q.a, q.b] as [P2, P2]] : []));
    if (cutters.length) b.prims = gapHatch(b.prims, cutters);
  }
  // a section marker's letter that a size's lines now run through moves to a free spot (the marker's lines stay)
  if (over && extra.length) {
    const dimSegs = b.prims.flatMap((p) => (p.layer === "DIMS" && p.t === "line" ? [[p.a, p.b] as [P2, P2]] : []));
    const crossed = extra.some((p) => p.t === "text" && dimSegs.some(([a, c]) => segHitsBox(a, c, textBox(p))));
    if (crossed) {
      const again = over(pl, occ, true);
      b.prims = b.prims.filter((p) => !extra.includes(p));
      addPrims(b, again);
      occ.addPrims(again);
    }
  }
  // notes with leaders go last (after every view's sizes in a block): see placeLeaders
  b.pending = (v.leaders ?? []).map((ld) => ({ tip: toPage(pl, ld.at), s: ld.s, view: v.id }));
  b.views.push({ id: v.id, title: v.title, scale: v.scale, kind: v.kind, box, ox: pl.ox, oy: pl.oy, k, ...(v.mark ? { mark: v.mark } : {}), ...(v.marks ? { marks: v.marks } : {}), ...(v.group ? { group: v.group } : {}), ...(v.role ? { role: v.role } : {}), ...(v.ballooned ? { ballooned: v.ballooned } : {}) });
  if (v.lines.dir) b.views[b.views.length - 1].geometry = { dir: v.lines.dir, lines: v.lines, parts: [...new Set([...v.lines.chains, ...v.lines.arcs, ...v.lines.hatches].map((p) => p.part))], ...(v.brk ? { brk: v.brk } : {}) };
  return b;
}

/** Hatch lines broken g each side of every cutter (a size's line) that crosses or runs along them. */
export function gapHatch(prims: Prim[], cutters: [P2, P2][], g = 1): Prim[] {
  const out: Prim[] = [];
  for (const p of prims) {
    if (!(p.t === "line" && p.layer === "HATCH")) {
      out.push(p);
      continue;
    }
    const ax = p.b[0] - p.a[0],
      ay = p.b[1] - p.a[1];
    const L = Math.hypot(ax, ay);
    if (L < 1e-9) continue;
    const cuts: [number, number][] = [];
    for (const [c, e] of cutters) {
      const bx = e[0] - c[0],
        by = e[1] - c[1];
      const M = Math.hypot(bx, by);
      if (M < 1e-9) continue;
      const den = ax * by - ay * bx;
      const rx = c[0] - p.a[0],
        ry = c[1] - p.a[1];
      if (Math.abs(den) < 1e-6 * L * M) {
        // running along it: the stretch they share goes, if they're within a millimetre
        if (Math.abs(rx * ay - ry * ax) / L > g) continue;
        const t0 = (rx * ax + ry * ay) / (L * L),
          t1 = ((e[0] - p.a[0]) * ax + (e[1] - p.a[1]) * ay) / (L * L);
        cuts.push([Math.min(t0, t1) - g / L, Math.max(t0, t1) + g / L]);
        continue;
      }
      const t = (rx * by - ry * bx) / den,
        u = (rx * ay - ry * ax) / den;
      if (t < -g / L || t > 1 + g / L || u < 0 || u > 1) continue;
      const sin = Math.abs(den) / (L * M);
      const half = g / Math.max(sin, 0.2) / L;
      cuts.push([t - half, t + half]);
    }
    if (!cuts.length) {
      out.push(p);
      continue;
    }
    cuts.sort((x, y) => x[0] - y[0]);
    let from = 0;
    const at = (t: number): P2 => [p.a[0] + ax * t, p.a[1] + ay * t];
    for (const [c0, c1] of cuts) {
      if (c0 > from + 1e-6) out.push({ ...p, a: at(from), b: at(Math.min(c0, 1)) });
      from = Math.max(from, c1);
      if (from >= 1) break;
    }
    if (from < 1 - 1e-6) out.push({ ...p, a: at(from), b: at(1) });
  }
  return out;
}

/** A view's linework, put into the occupancy ahead of time, so notes and sizes placed earlier keep clear of it. */
export function reserve(v: ViewBuild, x: number, y: number, occ: Occupied) {
  const k = 1 / v.scale;
  const u0 = v.clip ? v.clip[0] : v.min[0],
    v0 = v.clip ? v.clip[1] : v.min[1];
  const pl: Placement = { ox: x - u0 * k, oy: y - v0 * k, k, ...(v.brk ? { brk: v.brk } : {}), view: v.id };
  occ.addPrims(drawLines(v.lines, pl, { clip: v.clip ? [x, y, x + paperSize(v)[0], y + paperSize(v)[1]] : undefined }));
}

/** Only the linework inside a window (feet for a cropped detail must be inside it). */
export function clipLines(l: ViewLines, c: [number, number, number, number]): ViewLines {
  const inside = (p: P2) => p[0] >= c[0] - 1e-6 && p[0] <= c[2] + 1e-6 && p[1] >= c[1] - 1e-6 && p[1] <= c[3] + 1e-6;
  const chains: ViewLines["chains"] = [];
  for (const ch of l.chains) {
    const n = ch.pts.length;
    for (let i = 0; i + 1 < n + (ch.closed ? 1 : 0); i++) {
      const a = ch.pts[i],
        b = ch.pts[(i + 1) % n];
      // Liang-Barsky: the part of ab inside the window
      let t0 = 0,
        t1 = 1;
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      let ok = true;
      for (const [p, q] of [
        [-dx, a[0] - c[0]],
        [dx, c[2] - a[0]],
        [-dy, a[1] - c[1]],
        [dy, c[3] - a[1]],
      ]) {
        if (Math.abs(p) < 1e-12) {
          if (q < -1e-9) ok = false;
        } else if (p < 0) t0 = Math.max(t0, q / p);
        else t1 = Math.min(t1, q / p);
      }
      if (!ok || t0 > t1 - 1e-9) continue;
      chains.push({ kind: ch.kind, part: ch.part, pts: [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1]] });
    }
  }
  return { ...l, chains, arcs: l.arcs.filter((a) => inside(a.c)) };
}

/** Title under a view (below its dimensions), centred: bubble, title, scale. */
export function titleUnder(b: Block, v: ViewMeta, id: string, title: string, scale: number | null, extra?: string, sub?: string) {
  const t = viewTitle([0, 0], id, title, scale, v.id, extra);
  const w = t.box[2] - t.box[0];
  const cx = (v.box[0] + v.box[2]) / 2;
  // under the view and what it has below it there (a section letter off to one side doesn't push it down)
  const own = b.prims.filter((p) => p.view === v.id && !(p.t === "text" && p.role === "title")).map(primBox);
  const below = Math.min(v.box[1], ...own.filter((o) => o[0] < cx + w / 2 + 1 && cx - w / 2 - 1 < o[2]).map((o) => o[1]));
  // and lower still if a neighbour's sizes or markers are in the way; never inside another view
  const others = [...b.prims.filter((p) => !(p.t === "line" && p.layer === "HATCH")).map(primBox), ...b.views.filter((o) => o.id !== v.id).map((o) => o.box)];
  const subH = sub ? 4 : 0;
  let y = below - 4;
  for (let guard = 0; guard < 30; guard++) {
    const box: Box = [cx - w / 2 - 1, y + t.box[1] - 1 - subH, cx + w / 2 + 1, y + t.box[3] + 1];
    if (!others.some((o) => o[0] < box[2] && box[0] < o[2] && o[1] < box[3] && box[1] < o[3])) break;
    y -= 2;
  }
  const moved = moveBlock({ ...emptyBlock(), prims: t.prims }, cx - w / 2, y);
  addPrims(b, moved.prims);
  if (sub) addPrims(b, [text([cx - w / 2 + 10.9, y - (t.box[3] - t.box[1]) - 1.2], sub, TH.note, { base: "top", role: "title", view: v.id })]);
}
