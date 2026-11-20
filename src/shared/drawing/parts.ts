// What a shop drawing needs to know about a model's parts (Stage 12): which parts are the same (one part number, a
// quantity), what each is called, its finished size (thickness, width, length), how to lay it on the paper (length
// across, the face with its joinery towards you, set out from the end its joinery is nearest), its features (each cut is
// a mortise, a housing, a hole...), and where parts meet in a joint. Everything comes from the model's own sizes and
// cuts; nothing is guessed from pictures.
import type { ModelMaterial, ModelPayload, Solid } from "../protocol.js";
import type { BuiltModel, BuiltPart } from "../model3d/build.js";
import { type Box3, type V3, type Xf, apply, applyDir, compose, emptyBox, grow, invert } from "../model3d/math.js";
import type { Poly } from "../model3d/csg.js";
import { solidPolys } from "../model3d/solids.js";

export type FeatureKind = "mortise" | "slot" | "tenon" | "housing" | "rebate" | "groove" | "notch" | "hole" | "pocket" | "end";
export type Feature = {
  kind: FeatureKind;
  /** Where it is, in the part's drawing frame (x along the length from the datum end, y through the thickness, z across the width). */
  box: Box3;
  /** Per axis: does it reach the low face, the high face. */
  lo: [boolean, boolean, boolean];
  hi: [boolean, boolean, boolean];
  /** A hole: its axis in the drawing frame, centre (on the other two axes) and diameter. */
  hole?: { axis: 0 | 1 | 2; c: V3; d: number; through: boolean };
};

export type PartInfo = {
  index: number;
  mark: number;
  /** The part's name on the drawing, upper case ("LEG"). */
  label: string;
  name: string;
  material: ModelMaterial;
  /** Finished sizes: thickness, width, length (a round part: its diameter twice, and its length). */
  T: number;
  W: number;
  L: number;
  round: boolean;
  /** The part's own frame to its drawing frame (length along x from 0, thickness along y from 0, width along z from 0). */
  toDraw: Xf;
  /** The model to the drawing frame. */
  modelToDraw: Xf;
  /** The finished part in its drawing frame. */
  polys: Poly[];
  features: Feature[];
  /** Grain runs along x in the drawing frame for timber laid out this way (false for ply, mdf, steel...). */
  grainAlongLength: boolean;
  /** The way the grain runs in the drawing frame (0 length, 1 thickness, 2 width): timber and plywood only. */
  grain: 0 | 1 | 2 | null;
};

/** A part number: its parts, and its shape (the same for parts that differ only in name: drawn once, 12.10). */
export type Mark = { mark: number; label: string; qty: number; parts: number[]; first: PartInfo; shape: string };

export type Joint = {
  /** The parts that meet (model indices), and the region where they overlap or touch, in the model. */
  parts: number[];
  box: Box3;
  /** Same arrangement of the same part numbers: one detail covers them all. */
  key: string;
};

export const TIMBER_MATERIALS: ModelMaterial[] = ["pine", "hardwood", "oak", "walnut"];

const POSITION_WORDS = /\b(front|back|rear|left|right|inner|outer|upper|lower|middle|centre|center|north|south|east|west|first|second|third|fourth|fifth|sixth|lh|rh|no\.?\s*\d+|#\d+|\d+|[a-d]\b)\b/gi;

/** "Front left leg" → "LEG", "Left end rail" → "END RAIL", "Top" stays "TOP"; "Drawer front" stays "DRAWER FRONT". */
export function labelOf(name: string) {
  const s = name
    .replace(/\(.*?\)/g, " ")
    // a size in the name ("Bolt 1, M12", "Ø10 dowel") is in the schedule's own columns
    .replace(/\bM\d+(?:\.\d+)?\b|Ø\s*\d+(?:\.\d+)?/gi, " ")
    // a front or back last, after a thing's name, is that part of it (a drawer front, a chair back), not where it is
    .replace(/\b([A-Za-z]{3,})\s+(front|back)\s*$/gi, (m, a: string, b: string) => (POSITION_WORDS.test(a) ? ((POSITION_WORDS.lastIndex = 0), m) : `${a} ${b.toUpperCase()}_KEEP`))
    .replace(POSITION_WORDS, " ")
    .replace(/_KEEP/g, "")
    .replace(/[^A-Za-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (s || name).toUpperCase().slice(0, 28);
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const boxOf = (polys: Poly[]) => {
  const b = emptyBox();
  for (const p of polys) for (const v of p.v) grow(b, v);
  return b;
};
const sizeOf = (b: Box3): V3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
const xfBox = (x: Xf, b: Box3): Box3 => {
  const out = emptyBox();
  for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) grow(out, apply(x, [i ? b.max[0] : b.min[0], j ? b.max[1] : b.min[1], k ? b.max[2] : b.min[2]]));
  return out;
};
const inter = (a: Box3, b: Box3): Box3 | null => {
  const min: V3 = [0, 0, 0],
    max: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    min[i] = Math.max(a.min[i], b.min[i]);
    max[i] = Math.min(a.max[i], b.max[i]);
    if (max[i] - min[i] < -1e-6) return null;
  }
  return { min, max };
};

/** Rotations that send own axes (a permutation, with signs) to the drawing axes, keeping it right-handed. */
function axisXf(len: number, thick: number, wide: number, sx: number, sy: number, sz: number): Xf {
  // row i of r: which own axis becomes drawing axis i, and its sign
  const r = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  r[0 * 3 + len] = sx;
  r[1 * 3 + thick] = sy;
  r[2 * 3 + wide] = sz;
  return { r, t: [0, 0, 0] };
}
const det3 = (r: number[]) => r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);

/** A cut's region inside the stock (bounding box), and its hole if it's a cylinder; in the part's own frame. */
function cutRegion(c: Solid, stock: Box3): { box: Box3; cyl?: { axis: number; c: V3; r: number } } | null {
  const b = boxOf(solidPolys(c));
  const box = inter(b, stock);
  if (!box) return null;
  if (sizeOf(box).some((v) => v < 1e-6)) return null;
  if (c.type === "cyl") {
    const axis = c.axis === "x" ? 0 : c.axis === "y" ? 1 : 2;
    return { box, cyl: { axis, c: [c.at[0], c.at[1], c.at[2]], r: c.r } };
  }
  return { box };
}

function classify(lo: boolean[], hi: boolean[], len: number, hole: boolean): FeatureKind {
  if (hole) return "hole";
  const through = [0, 1, 2].map((i) => lo[i] && hi[i]);
  const open = [0, 1, 2].map((i) => lo[i] || hi[i]);
  const nThrough = through.filter(Boolean).length;
  const endOpen = lo[0] !== hi[0] && open[0] && !through[0] && (lo[0] || hi[0]);
  // a cut reaching one end of the length and through one or both cross axes: the cheeks or shoulders of a tenon
  if (endOpen && (through[1] || through[2])) {
    // through one cross way and clear of both faces the other: a slot (a bridle's open mortise); else a tenon's cheek or shoulder
    const other = through[1] ? 2 : 1;
    return !lo[other] && !hi[other] ? "slot" : "tenon";
  }
  if (nThrough >= 2) return "end";
  if (through[1] && !open[0] && !open[2]) return "mortise"; // right through the thickness
  // across the thickness, in from one edge: a notch (a rafter's cog over a beam); across the width from a face: a housing
  if (through[1] && !open[0] && (lo[2] || hi[2]) && !through[2]) return "notch";
  if (!open[0] && (through[2] || through[1]) && open.filter(Boolean).length === 2) return "housing";
  if (!open[0] && [1, 2].some((i) => open[i] && !through[i]) && [1, 2].filter((i) => open[i]).length === 1 && !through[1] && !through[2]) return "mortise";
  // along the length, in from one face clear of the edges: a groove (a drawer side's for its bottom); at an edge, a rebate
  if (through[0] && nThrough === 1 && [open[1], open[2]].filter(Boolean).length === 1) return "groove";
  if (open.filter(Boolean).length >= 2 && nThrough === 1 && open[0]) return "rebate";
  if (open.filter(Boolean).length >= 2 && nThrough === 1) return "housing";
  if (nThrough === 1) return "slot";
  if (open.filter(Boolean).length === 2) return "notch";
  void len;
  return "pocket";
}

/** Everything about the parts a drawing needs. */
export function analyseParts(m: ModelPayload, built: BuiltModel): { parts: PartInfo[]; marks: Mark[] } {
  const infos: PartInfo[] = [];
  built.parts.forEach((bp, index) => {
    const mp = m.parts[index];
    const invFrame = invert(bp.frame);
    const ownPolys = bp.polys.map((p) => ({ ...p, v: p.v.map((q) => apply(invFrame, q)) }));
    const stockBox = boxOf(solidPolys(mp.stock));
    const fin = boxOf(ownPolys.length ? ownPolys : solidPolys(mp.stock));
    const s = sizeOf(fin);
    const round = mp.stock.type === "cyl";
    const gi = bp.grain === "x" ? 0 : bp.grain === "y" ? 1 : 2;
    const longest = s[0] >= s[1] && s[0] >= s[2] ? 0 : s[1] >= s[2] ? 1 : 2;
    const timber = TIMBER_MATERIALS.includes(mp.material);
    // length runs with the grain for timber (a wide board's length is still its grain way), else its longest side
    const len = round ? (mp.stock.type === "cyl" ? (mp.stock.axis === "x" ? 0 : mp.stock.axis === "y" ? 1 : 2) : longest) : timber && s[gi] >= 0.5 * s[longest] ? gi : longest;
    const others = [0, 1, 2].filter((i) => i !== len);
    const thick = s[others[0]] <= s[others[1]] ? others[0] : others[1];
    const wide = others[0] === thick ? others[1] : others[0];
    const regions = (mp.cuts ?? []).map((c) => cutRegion(c, stockBox)).filter((x): x is NonNullable<typeof x> => !!x);
    // try the four right-handed ways of laying it down; keep the one with its joinery facing you and nearest the left end
    let best: { score: number; x: Xf } | null = null;
    for (const sx of [1, -1])
      for (const sy of [1, -1])
        for (const sz of [1, -1]) {
          const x0 = axisXf(len, thick, wide, sx, sy, sz);
          if (det3(x0.r) < 0) continue;
          const b = xfBox(x0, fin);
          const x: Xf = { r: x0.r, t: [-b.min[0], -b.min[1], -b.min[2]] };
          const Ls = s[len],
            Ts = s[thick];
          let score = 0;
          for (const rg of regions) {
            const rb = xfBox(x, rg.box);
            if (rb.min[1] <= 1e-6) score += 4; // opens on the face towards you
            if (rb.max[1] >= Ts - 1e-6 && rb.min[1] > 1e-6) score -= 2; // only on the far face
            const mid = (rb.min[0] + rb.max[0]) / 2;
            score += mid < Ls / 2 ? 1 : 0; // nearer the left (datum) end
            if (rb.max[2] >= s[wide] - 1e-6) score += 0.5; // on the top edge, seen in the view above
          }
          // a part lying across the model (a beam, a rafter, a shelf) is drawn the way up it sits
          const up = applyDir(invFrame, [0, 0, 1]);
          const zUp = x0.r[6] * up[0] + x0.r[7] * up[1] + x0.r[8] * up[2];
          if (Math.abs(zUp) > 0.99) score += zUp > 0 ? 3 : -3;
          // with nothing to choose, keep the part's own way up
          if (sx === 1) score += 0.01;
          if (sz === 1) score += 0.02;
          if (!best || score > best.score) best = { score, x };
        }
    const toDraw = best!.x;
    const modelToDraw = compose(toDraw, invert(bp.frame));
    const polys = transformPolys(bp.polys, modelToDraw);
    const D = sizeOf(xfBox(toDraw, fin));
    const features: Feature[] = regions.map((rg) => {
      const box = xfBox(toDraw, rg.box);
      const lo = [0, 1, 2].map((i) => box.min[i] <= 1e-3) as [boolean, boolean, boolean];
      const hi = [0, 1, 2].map((i) => box.max[i] >= D[i] - 1e-3) as [boolean, boolean, boolean];
      const f: Feature = { kind: classify(lo, hi, D[0], !!rg.cyl), box: { min: box.min.map(r3) as V3, max: box.max.map(r3) as V3 }, lo, hi };
      if (rg.cyl) {
        const ax = applyDir(toDraw, rg.cyl.axis === 0 ? [1, 0, 0] : rg.cyl.axis === 1 ? [0, 1, 0] : [0, 0, 1]);
        const axis = (Math.abs(ax[0]) > 0.5 ? 0 : Math.abs(ax[1]) > 0.5 ? 1 : 2) as 0 | 1 | 2;
        const c: V3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
        f.hole = { axis, c: c.map(r3) as V3, d: r3(rg.cyl.r * 2), through: lo[axis] && hi[axis] };
      }
      return f;
    });
    infos.push({
      index,
      mark: 0,
      label: labelOf(mp.name),
      name: mp.name,
      material: mp.material,
      T: r3(D[1]),
      W: r3(D[2]),
      L: r3(D[0]),
      round,
      toDraw,
      modelToDraw,
      polys,
      features,
      grainAlongLength: timber,
      grain: (() => {
        if (!timber && mp.material !== "ply") return null;
        const g = applyDir(toDraw, gi === 0 ? [1, 0, 0] : gi === 1 ? [0, 1, 0] : [0, 0, 1]);
        return Math.abs(g[0]) > 0.5 ? 0 : Math.abs(g[1]) > 0.5 ? 1 : 2;
      })(),
    });
  });
  // the same part: same material, sizes, volume and features (mirror images count as the same; noted as a pair)
  const shape = (p: PartInfo) => {
    const bp = built.parts[p.index];
    const feats = p.features
      .map((f) => `${f.kind}:${sizeOf(f.box).map((v) => Math.round(v)).join("x")}`)
      .sort()
      .join(",");
    return `${p.material}|${Math.round(p.T)}|${Math.round(p.W)}|${Math.round(p.L)}|${Math.round(bp.volume / 10)}|${feats}`;
  };
  const sig = (p: PartInfo) => `${p.label}|${shape(p)}`;
  const groups = new Map<string, PartInfo[]>();
  for (const p of infos) {
    if (!built.parts[p.index].polys.length) continue;
    const k = sig(p);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const ordered = [...groups.values()].sort((a, b) => built.parts[b[0].index].volume - built.parts[a[0].index].volume || a[0].index - b[0].index);
  // one name per part number: the most common label in the group; two different parts with one name get a letter
  const marks: Mark[] = ordered.map((g, i) => {
    const counts = new Map<string, number>();
    for (const p of g) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
    const label = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (const p of g) p.mark = i + 1;
    return { mark: i + 1, label, qty: g.length, parts: g.map((p) => p.index), first: g[0], shape: shape(g[0]) };
  });
  const byLabel = new Map<string, Mark[]>();
  for (const mk of marks) byLabel.set(mk.label, [...(byLabel.get(mk.label) ?? []), mk]);
  for (const [, list] of byLabel) if (list.length > 1) list.forEach((mk, i) => (mk.label = `${mk.label} ${String.fromCharCode(65 + i)}`));
  for (const mk of marks) for (const i of mk.parts) infos[i].label = mk.label;
  return { parts: infos, marks };
}

/** Where parts meet with one let into the other (their boxes overlap), grouped where they're close, keyed by arrangement. */
export function findJoints(built: BuiltModel, infos: PartInfo[]): Joint[] {
  const ps = built.parts;
  const raw: { a: number; b: number; box: Box3 }[] = [];
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      if (!ps[i].polys.length || !ps[j].polys.length) continue;
      const b = inter(ps[i].bbox, ps[j].bbox);
      if (!b) continue;
      const s = sizeOf(b);
      if (s.some((v) => v < 0.5)) continue; // only touching: a butt, not a joint to detail
      raw.push({ a: i, b: j, box: b });
    }
  // join overlaps that cross each other (a bolt through a post and a beam), and small ones close together on a shared
  // part (a leg's two tenons); long ones that only meet end on (a shelf's housing and the back's rebate) stay apart
  const clusters: { parts: Set<number>; box: Box3 }[] = [];
  for (const r of raw) {
    const near = (c: { parts: Set<number>; box: Box3 }) => {
      const crossing = [0, 1, 2].every((i) => r.box.min[i] < c.box.max[i] - 0.5 && c.box.min[i] < r.box.max[i] - 0.5);
      if (crossing) return true;
      const shared = c.parts.has(r.a) || c.parts.has(r.b);
      const small = Math.max(...sizeOf(r.box)) <= 150 && Math.max(...sizeOf(c.box)) <= 150;
      return shared && small && [0, 1, 2].every((i) => r.box.min[i] <= c.box.max[i] + 20 && c.box.min[i] <= r.box.max[i] + 20);
    };
    const hits = clusters.filter(near);
    const merged = { parts: new Set<number>([r.a, r.b]), box: { min: [...r.box.min] as V3, max: [...r.box.max] as V3 } };
    for (const h of hits) {
      h.parts.forEach((p) => merged.parts.add(p));
      for (let i = 0; i < 3; i++) {
        merged.box.min[i] = Math.min(merged.box.min[i], h.box.min[i]);
        merged.box.max[i] = Math.max(merged.box.max[i], h.box.max[i]);
      }
      clusters.splice(clusters.indexOf(h), 1);
    }
    clusters.push(merged);
  }
  return clusters.map((c) => {
    const marks = [...c.parts].map((p) => infos[p].mark).sort((a, b) => a - b);
    const s = sizeOf(c.box)
      .map((v) => Math.round(v))
      .sort((a, b) => a - b);
    return { parts: [...c.parts], box: c.box, key: `${marks.join("+")}|${s.join("x")}` };
  });
}

/** Polygons moved and turned by x (planes and round faces with them). */
export function transformPolys(polys: Poly[], x: Xf): Poly[] {
  return polys.map((p) => {
    const v = p.v.map((q) => apply(x, q));
    const n = applyDir(x, p.p.n);
    const w = v.reduce((t, q) => t + n[0] * q[0] + n[1] * q[1] + n[2] * q[2], 0) / v.length;
    return { v, p: { n, w }, ...(p.sm ? { sm: { c: apply(x, p.sm.c), d: applyDir(x, p.sm.d), s: p.sm.s } } : {}) };
  });
}

/** A part's mark and name for a schedule or a title: "LEG". */
export const partTitle = (mk: Mark) => mk.label;
export type { BuiltPart };
