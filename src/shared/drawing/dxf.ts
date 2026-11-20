// DXF files (Stage 12.4, plan A.4): our own minimal writer, AutoCAD R12 ASCII (the plainest kind, read by CAD and CNC
// programs alike). Lines, arcs, circles, polylines and text, on named layers, in millimetres, every view at 1:1, the
// dimensions exploded to lines and text on their own layer. And one file per part for a CNC shop: its outline only,
// closed, with through holes as circles. A small reader for the tests (and nothing else).
import type { DxfEntity, DxfFile, Layer, Prim, Sheet } from "./prims.js";
import { CAP, textWidth } from "./prims.js";
import type { DrawingSet } from "./sheets.js";
import { drawView, VIEWS, partEdges } from "./hlr.js";
import type { V3 } from "../model3d/math.js";

type P2 = [number, number];

const LAYERS: { name: Layer | "HOLES"; color: number; ltype: string }[] = [
  { name: "OUTLINE", color: 7, ltype: "CONTINUOUS" },
  { name: "CUT", color: 7, ltype: "CONTINUOUS" },
  { name: "HIDDEN", color: 8, ltype: "HIDDEN" },
  { name: "HATCH", color: 9, ltype: "CONTINUOUS" },
  { name: "CENTRE", color: 1, ltype: "CENTER" },
  { name: "DIMS", color: 3, ltype: "CONTINUOUS" },
  { name: "NOTES", color: 2, ltype: "CONTINUOUS" },
  { name: "SYMBOLS", color: 4, ltype: "CONTINUOUS" },
  { name: "BALLOONS", color: 5, ltype: "CONTINUOUS" },
  { name: "HOLES", color: 6, ltype: "CONTINUOUS" },
];

const n = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
};

class Writer {
  out: string[] = [];
  min: P2 = [Infinity, Infinity];
  max: P2 = [-Infinity, -Infinity];
  g(code: number, value: string | number) {
    this.out.push(String(code), typeof value === "number" ? n(value) : value);
  }
  grow(p: P2) {
    this.min = [Math.min(this.min[0], p[0]), Math.min(this.min[1], p[1])];
    this.max = [Math.max(this.max[0], p[0]), Math.max(this.max[1], p[1])];
  }
  line(a: P2, b: P2, layer: string) {
    this.g(0, "LINE");
    this.g(8, layer);
    this.g(10, a[0]), this.g(20, a[1]), this.g(30, 0), this.g(11, b[0]), this.g(21, b[1]), this.g(31, 0);
    this.grow(a), this.grow(b);
  }
  circle(c: P2, r: number, layer: string) {
    this.g(0, "CIRCLE");
    this.g(8, layer);
    this.g(10, c[0]), this.g(20, c[1]), this.g(30, 0), this.g(40, r);
    this.grow([c[0] - r, c[1] - r]), this.grow([c[0] + r, c[1] + r]);
  }
  arc(c: P2, r: number, a0: number, a1: number, layer: string) {
    this.g(0, "ARC");
    this.g(8, layer);
    this.g(10, c[0]), this.g(20, c[1]), this.g(30, 0), this.g(40, r), this.g(50, a0), this.g(51, a1);
    this.grow([c[0] - r, c[1] - r]), this.grow([c[0] + r, c[1] + r]);
  }
  poly(pts: P2[], closed: boolean, layer: string) {
    this.g(0, "POLYLINE");
    this.g(8, layer);
    this.g(66, 1);
    this.g(10, 0), this.g(20, 0), this.g(30, 0);
    this.g(70, closed ? 1 : 0);
    for (const p of pts) {
      this.g(0, "VERTEX");
      this.g(8, layer);
      this.g(10, p[0]), this.g(20, p[1]), this.g(30, 0);
      this.grow(p);
    }
    this.g(0, "SEQEND");
    this.g(8, layer);
  }
  text(at: P2, s: string, h: number, rot: number, align: 0 | 1 | 2, layer: string) {
    this.g(0, "TEXT");
    this.g(8, layer);
    this.g(10, at[0]), this.g(20, at[1]), this.g(30, 0);
    this.g(40, h);
    this.g(1, s.replace(/Ø/g, "%%c").replace(/°/g, "%%d").replace(/±/g, "%%p").replace(/[^\x20-\x7e%]/g, "?"));
    if (rot) this.g(50, rot);
    if (align) {
      this.g(72, align);
      this.g(11, at[0]), this.g(21, at[1]), this.g(31, 0);
    }
    this.grow(at);
  }
  file(): string {
    const head: string[] = [];
    const h = (c: number, v: string | number) => head.push(String(c), typeof v === "number" ? n(v) : v);
    const min = Number.isFinite(this.min[0]) ? this.min : [0, 0],
      max = Number.isFinite(this.max[0]) ? this.max : [0, 0];
    h(0, "SECTION"), h(2, "HEADER");
    h(9, "$ACADVER"), h(1, "AC1009");
    h(9, "$INSUNITS"), h(70, 4); // millimetres
    h(9, "$MEASUREMENT"), h(70, 1);
    h(9, "$EXTMIN"), h(10, min[0]), h(20, min[1]), h(30, 0);
    h(9, "$EXTMAX"), h(10, max[0]), h(20, max[1]), h(30, 0);
    h(0, "ENDSEC");
    h(0, "SECTION"), h(2, "TABLES");
    h(0, "TABLE"), h(2, "LTYPE"), h(70, 3);
    for (const [name, desc, pat] of [
      ["CONTINUOUS", "Solid line", [] as number[]],
      ["HIDDEN", "Hidden __ __ __", [6, -3]],
      ["CENTER", "Center ____ _ ____", [24, -4, 4, -4]],
    ] as const) {
      h(0, "LTYPE"), h(2, name), h(70, 0), h(3, desc), h(72, 65), h(73, pat.length), h(40, pat.reduce((t, x) => t + Math.abs(x), 0));
      for (const x of pat) h(49, x);
    }
    h(0, "ENDTAB");
    h(0, "TABLE"), h(2, "LAYER"), h(70, LAYERS.length);
    for (const l of LAYERS) h(0, "LAYER"), h(2, l.name), h(70, 0), h(62, l.color), h(6, l.ltype);
    h(0, "ENDTAB");
    h(0, "TABLE"), h(2, "STYLE"), h(70, 1);
    h(0, "STYLE"), h(2, "STANDARD"), h(70, 0), h(40, 0), h(41, 1), h(50, 0), h(71, 0), h(42, 2.5), h(3, "txt"), h(4, "");
    h(0, "ENDTAB");
    h(0, "ENDSEC");
    return [...head, "0", "SECTION", "2", "ENTITIES", ...this.out, "0", "ENDSEC", "0", "EOF", ""].join("\r\n");
  }
}

/** A prim from the page to the model: (paper − view origin) / k, then moved by off. */
function emit(w: Writer, p: Prim, k: number, ox: number, oy: number, off: P2) {
  const M = (q: P2): P2 => [(q[0] - ox) / k + off[0], (q[1] - oy) / k + off[1]];
  const layer = p.layer === "TABLES" || p.layer === "TITLE" || p.layer === "BORDER" ? "NOTES" : p.layer;
  switch (p.t) {
    case "line":
      return w.line(M(p.a), M(p.b), layer);
    case "poly":
      if (p.fill) return w.poly(p.pts.map(M), true, layer);
      return w.poly(p.pts.map(M), !!p.closed, layer);
    case "circle":
      return w.circle(M(p.c), p.r / k, layer);
    case "arc":
      return w.arc(M(p.c), p.r / k, p.a0, p.a1, layer);
    case "text": {
      const h = p.h / k;
      // R12 text sits on its baseline at its start; work that out from the anchor
      const wdt = textWidth(p.s, p.h, p.bold) / k;
      const dx = p.anchor === "start" ? 0 : p.anchor === "middle" ? -wdt / 2 : -wdt;
      const dy = p.base === "baseline" ? 0 : p.base === "middle" ? -h / 2 : -h;
      const at = M(p.at);
      const start: P2 = p.rot === 90 ? [at[0] - dy, at[1] + dx] : [at[0] + dx, at[1] + dy];
      return w.text(start, p.s, h, p.rot ?? 0, 0, layer);
    }
  }
}

/** The whole set's drawing at 1:1: each sheet's views side by side in a row (sheets one above the other), 500 apart. */
export function setDxf(set: DrawingSet): string {
  const w = new Writer();
  let y = 0;
  set.sheets.forEach((sh: Sheet) => {
    let x = 0,
      rowH = 0;
    for (const v of sh.meta.views) {
      const prims = sh.prims.filter((p) => p.view === v.id);
      if (!prims.length) continue;
      const k = v.k;
      // the view's box on the page, in model units
      const bw = (v.box[2] - v.box[0]) / k,
        bh = (v.box[3] - v.box[1]) / k;
      // its lower-left goes to (x, y): model = (paper − origin) / k + off, with off chosen so the box's corner lands there
      const off: P2 = [x - (v.box[0] - v.ox) / k, y - (v.box[1] - v.oy) / k];
      for (const p of prims) emit(w, p, k, v.ox, v.oy, off);
      x += bw + 500;
      rowH = Math.max(rowH, bh);
    }
    y -= rowH + 1000;
  });
  return w.file();
}

/** Directed boundary of the region a part covers seen face on: closed loops (its outline, and any hole right through). */
function outlineLoops(polys: { v: V3[]; p: { n: V3 } }[]): P2[][] {
  // flatten the faces that face the viewer onto the paper (u = x, v = z, seen from -y), then add up their edges
  const segs: { a: P2; b: P2 }[] = [];
  for (const p of polys) {
    if (p.p.n[1] >= -1e-9) continue;
    const q = p.v.map((v) => [v[0], v[2]] as P2);
    // a face towards a viewer at -y runs counter-clockwise with u = x, v = z
    for (let i = 0; i < q.length; i++) segs.push({ a: q[i], b: q[(i + 1) % q.length] });
  }
  // net coverage per straight line
  type It = { t0: number; t1: number; v: number };
  const groups: { d: P2; o: number; items: It[] }[] = [];
  for (const s of segs) {
    let dx = s.b[0] - s.a[0],
      dy = s.b[1] - s.a[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    dx /= L;
    dy /= L;
    if (dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dy < 0)) ((dx = -dx), (dy = -dy));
    const o = -dy * s.a[0] + dx * s.a[1];
    let g = groups.find((x) => Math.abs(x.d[0] * dx + x.d[1] * dy) > 1 - 1e-10 && Math.abs(x.o - o) < 1e-4);
    if (!g) groups.push((g = { d: [dx, dy], o, items: [] }));
    const ta = s.a[0] * g.d[0] + s.a[1] * g.d[1],
      tb = s.b[0] * g.d[0] + s.b[1] * g.d[1];
    g.items.push({ t0: Math.min(ta, tb), t1: Math.max(ta, tb), v: ta < tb ? 1 : -1 });
  }
  const bound: { a: P2; b: P2 }[] = [];
  for (const g of groups) {
    const ts = [...new Set(g.items.flatMap((i) => [i.t0, i.t1]).map((t) => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b);
    for (let k = 0; k + 1 < ts.length; k++) {
      const m = (ts[k] + ts[k + 1]) / 2;
      const v = g.items.filter((i) => i.t0 <= m && i.t1 >= m).reduce((t, i) => t + i.v, 0);
      if (!v) continue;
      const nx = -g.d[1],
        ny = g.d[0];
      const P = (t: number): P2 => [nx * g.o + g.d[0] * t, ny * g.o + g.d[1] * t];
      bound.push(v > 0 ? { a: P(ts[k]), b: P(ts[k + 1]) } : { a: P(ts[k + 1]), b: P(ts[k]) });
    }
  }
  // chain into loops
  const key = (p: P2) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)}`;
  const from = new Map<string, number[]>();
  bound.forEach((s, i) => from.set(key(s.a), [...(from.get(key(s.a)) ?? []), i]));
  const used = new Set<number>();
  const loops: P2[][] = [];
  for (let i = 0; i < bound.length; i++) {
    if (used.has(i)) continue;
    const loop: P2[] = [];
    let cur = i;
    for (let guard = 0; guard <= bound.length; guard++) {
      used.add(cur);
      loop.push(bound[cur].a);
      const nx = (from.get(key(bound[cur].b)) ?? []).filter((x) => !used.has(x));
      if (!nx.length) break;
      cur = nx[0];
    }
    // drop points in the middle of straight runs
    const clean = loop.filter((p, k) => {
      const a = loop[(k - 1 + loop.length) % loop.length],
        c = loop[(k + 1) % loop.length];
      return Math.abs((p[0] - a[0]) * (c[1] - p[1]) - (p[1] - a[1]) * (c[0] - p[0])) > 1e-6;
    });
    if (clean.length >= 3) loops.push(clean);
  }
  return loops;
}

/** One part, for a CNC shop: its outline seen face on, closed, at 1:1; a hole right through as a true circle. */
export function partDxf(set: DrawingSet, mark: number): string {
  const mk = set.marks.find((m) => m.mark === mark);
  if (!mk) throw new Error(`no part ${mark}`);
  const w = new Writer();
  for (const loop of outlineLoops(mk.first.polys)) {
    // a loop all the same distance from its middle is a hole's facets: a circle
    const c: P2 = [loop.reduce((t, p) => t + p[0], 0) / loop.length, loop.reduce((t, p) => t + p[1], 0) / loop.length];
    const rs = loop.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]));
    const r = rs.reduce((t, x) => t + x, 0) / rs.length;
    if (loop.length >= 16 && rs.every((x) => Math.abs(x - r) < 0.02 * r)) {
      const rr = Math.max(...rs); // the facets' corners are on the true circle
      w.circle(c, rr, "HOLES");
    } else w.poly(loop, true, "OUTLINE");
  }
  w.text([0, -15], `${mk.label} (PART ${mk.mark}), ${mk.qty} REQ'D, ${mk.first.T} THICK`, 5, 0, 0, "NOTES");
  void CAP;
  void drawView;
  void VIEWS;
  void partEdges;
  return w.file();
}

/* ---------------- a small reader, for the tests ---------------- */


export function readDxf(src: string): DxfFile {
  const lines = src.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([Number(lines[i].trim()), lines[i + 1].trim()]);
  let version = "",
    units: number | null = null;
  const layers: string[] = [];
  const entities: DxfEntity[] = [];
  let section = "";
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0 && v === "SECTION") {
      section = pairs[i + 1][1];
      continue;
    }
    if (section === "HEADER" && c === 9) {
      if (v === "$ACADVER") version = pairs[i + 1][1];
      if (v === "$INSUNITS") units = Number(pairs[i + 1][1]);
    }
    if (section === "TABLES" && c === 0 && v === "LAYER") {
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) if (pairs[j][0] === 2) layers.push(pairs[j][1]);
    }
    if (section === "ENTITIES" && c === 0 && ["LINE", "CIRCLE", "ARC", "POLYLINE", "TEXT"].includes(v)) {
      const e: DxfEntity = { type: v, layer: "", pts: [] };
      let j = i + 1;
      const xs: number[] = [],
        ys: number[] = [];
      for (; j < pairs.length && pairs[j][0] !== 0; j++) {
        const [cc, vv] = pairs[j];
        if (cc === 8) e.layer = vv;
        if (cc === 10 || cc === 11) xs.push(Number(vv));
        if (cc === 20 || cc === 21) ys.push(Number(vv));
        if (cc === 40) e.r = Number(vv);
        if (cc === 1) e.text = vv;
        if (cc === 70 && v === "POLYLINE") e.closed = (Number(vv) & 1) === 1;
      }
      if (v === "POLYLINE") {
        // its vertices follow, each its own entity, until SEQEND
        for (; j < pairs.length; j++) {
          if (pairs[j][0] === 0 && pairs[j][1] === "SEQEND") break;
          if (pairs[j][0] === 0 && pairs[j][1] === "VERTEX") {
            let x = 0,
              y = 0;
            for (let k = j + 1; k < pairs.length && pairs[k][0] !== 0; k++) {
              if (pairs[k][0] === 10) x = Number(pairs[k][1]);
              if (pairs[k][0] === 20) y = Number(pairs[k][1]);
            }
            e.pts.push([x, y]);
          }
        }
      } else for (let k = 0; k < Math.min(xs.length, ys.length); k++) e.pts.push([xs[k], ys[k]]);
      entities.push(e);
      i = j - 1;
    }
  }
  return { version, units, layers, entities };
}
