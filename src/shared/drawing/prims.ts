// One drawing description for three writers (Stage 12, plan A.4): every sheet is a plain list of primitives in paper
// millimetres, origin at the bottom left of an A3 landscape page, y up. Lines with a weight and a dash pattern, arcs,
// circles, filled regions, and text with a height and an anchor. The PDF, SVG and DXF writers only read this.
// Text is Helvetica (built into every PDF reader, so no font file); its widths are here so boxes can be kept apart.
export type P2 = [number, number];

export const PAGE: P2 = [420, 297];

/** Line weights in mm (plan A.5). */
export const W = { border: 0.7, plane: 0.7, cut: 0.5, visible: 0.35, hidden: 0.25, thin: 0.18 } as const;
/** Dash patterns in paper mm. */
export const DASH = { hidden: [3, 1.5], centre: [12, 2, 1.5, 2], plane: [12, 2, 1.5, 2], frame: [4, 2] } as const;
/** Text heights in mm (capital height): notes and dimensions, view titles and table heads, sheet title and number. */
export const TH = { note: 2.5, head: 3.5, big: 5 } as const;

export type Layer = "BORDER" | "TITLE" | "OUTLINE" | "HIDDEN" | "CUT" | "HATCH" | "CENTRE" | "DIMS" | "NOTES" | "SYMBOLS" | "BALLOONS" | "TABLES";

export type Line = { t: "line"; a: P2; b: P2; w: number; dash?: readonly number[]; layer: Layer; view?: string };
export type Poly = { t: "poly"; pts: P2[]; closed?: boolean; w: number; dash?: readonly number[]; layer: Layer; fill?: boolean; view?: string };
/** Angles in degrees, counter-clockwise from a0 to a1. */
export type Arc = { t: "arc"; c: P2; r: number; a0: number; a1: number; w: number; dash?: readonly number[]; layer: Layer; view?: string };
export type Circle = { t: "circle"; c: P2; r: number; w: number; dash?: readonly number[]; layer: Layer; fill?: boolean; view?: string };
/**
 * Text: at is the anchor point; h the capital height in mm; anchor along the line, base across it (baseline, middle of
 * the capitals, or their top). rot 90 reads upwards (from the right of the sheet, as AS 1100 allows).
 */
export type Text = { t: "text"; at: P2; s: string; h: number; anchor: "start" | "middle" | "end"; base: "baseline" | "middle" | "top"; rot?: 0 | 90; bold?: boolean; layer: Layer; role?: TextRole; view?: string };
export type TextRole = "dim" | "note" | "title" | "label" | "table" | "balloon" | "block";
export type Prim = Line | Poly | Arc | Circle | Text;

/* ---------------- Helvetica widths (per 1000 of the font size), WinAnsi ---------------- */

// prettier-ignore
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
// prettier-ignore
const HELVB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
/** Characters past ASCII the drawings use, with their WinAnsi code and widths (regular, bold). */
export const EXTRA: Record<string, [number, number, number]> = {
  "°": [0xb0, 400, 400],
  "±": [0xb1, 584, 584],
  "×": [0xd7, 584, 584],
  Ø: [0xd8, 778, 778],
  "–": [0x96, 556, 556],
};
/** Helvetica's capital height, as a fraction of the font size. */
export const CAP = 0.718;

export function charWidth(ch: string, bold = false) {
  const c = ch.charCodeAt(0);
  if (c >= 32 && c <= 126) return (bold ? HELVB : HELV)[c - 32];
  const e = EXTRA[ch];
  return e ? (bold ? e[2] : e[1]) : 556;
}

/** A text's width in mm at capital height h. */
export function textWidth(s: string, h: number, bold = false) {
  let w = 0;
  for (const ch of s) w += charWidth(ch, bold);
  return (w / 1000) * (h / CAP);
}

/** The box a text covers on the page: [x0, y0, x1, y1]. Capitals only (drawings are upper case): no descenders. */
export function textBox(t: Text): [number, number, number, number] {
  const w = textWidth(t.s, t.h, t.bold);
  const h = t.h;
  let x0 = t.anchor === "start" ? 0 : t.anchor === "middle" ? -w / 2 : -w;
  let y0 = t.base === "baseline" ? 0 : t.base === "middle" ? -h / 2 : -h;
  // a little room round it: half a millimetre, and below the baseline for a comma or Ø's tail
  const pad = 0.4;
  let x1 = x0 + w + pad,
    y1 = y0 + h + pad;
  x0 -= pad;
  y0 -= pad;
  if (t.rot === 90) return [t.at[0] - y1, t.at[1] + x0, t.at[0] - y0, t.at[1] + x1];
  return [t.at[0] + x0, t.at[1] + y0, t.at[0] + x1, t.at[1] + y1];
}

/** Breaks words into lines no wider than width. */
export function wrap(s: string, h: number, width: number, bold = false): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, h, bold) <= width || !line) line = next;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** A number as a drawing writes it: whole millimetres, or one place when the model has a half. */
export function mm(v: number) {
  const r = Math.round(v);
  if (Math.abs(v - r) < 0.05) return String(r);
  return (Math.round(v * 10) / 10).toFixed(1);
}

export type Box = [number, number, number, number];
export const boxesHit = (a: Box, b: Box, gap = 0) => a[0] < b[2] + gap && b[0] < a[2] + gap && a[1] < b[3] + gap && b[1] < a[3] + gap;

/** Whether segment ab crosses (or lies in) box b. */
export function segHitsBox(a: P2, b: P2, box: Box): boolean {
  let t0 = 0,
    t1 = 1;
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, a[0] - box[0]) && clip(dx, box[2] - a[0]) && clip(-dy, a[1] - box[1]) && clip(dy, box[3] - a[1]) && t0 <= t1;
}

/** A sheet: its primitives and what the checks need to know about it. */
export type Sheet = { prims: Prim[]; meta: SheetMeta };

export type ViewMeta = {
  /** The model directions and parts used to draw this view, before it was put on the page. */
  geometry?: { dir: import("./hlr.js").ViewDir; lines: import("./hlr.js").ViewLines; parts: number[]; brk?: import("./render.js").Break };
  id: string;
  title: string;
  scale: number;
  kind: "ga" | "iso" | "part" | "detail" | "section";
  /** Linework's extent on the page. */
  box: Box;
  /** Model 2D → page: x = ox + u * k (before any break), y = oy + v * k. */
  ox: number;
  oy: number;
  k: number;
  /** In projection with: which view, and the shared axis ("x": same x on the page; "y": same y). */
  aligned?: { with: string; axis: "x" | "y"; at: number; other: number }[];
  /** A section or detail: the sheet and view it's marked on. */
  markedOn?: string;
  /** A part view: the part number. */
  mark?: number;
  /** A part view drawn once for several part numbers (the same part under different names). */
  marks?: number[];
  /** A view in a joint detail (Stage 19.2): the detail's letter, and what the view is (the section through the joint,
   *  the one at right angles, the pulled-apart 3D view); or a view he asked for (19.3). */
  group?: string;
  role?: "section" | "second" | "apart" | "extra";
  /** The part numbers ballooned on a pulled-apart joint. */
  ballooned?: number[];
};
export type DimMeta = {
  view: string;
  /** The dimension line and the text box. */
  line: [P2, P2];
  text: Box;
  value: number;
  /** What it measures, for "no size twice": frame (a part number or the assembly), axis, from, to. */
  key: string;
  ref?: boolean;
  /** Chain id and whether it's the overall. */
  chain?: string;
  overall?: boolean;
  /** The extension lines' feet on the object (each must touch visible linework). */
  feet: P2[];
};
export type SheetMeta = {
  number: string;
  revision: string;
  sheet: number;
  of: number;
  title: string;
  scaleText: string;
  views: ViewMeta[];
  dims: DimMeta[];
  /** Section and detail markers drawn on this sheet: the letter and where it points (sheet number). */
  markers: { letter: string; toSheet: number; view?: string; at?: P2; r?: number }[];
  balloons: { mark: number; at: P2; view?: string }[];
  schedule?: { mark: number; qty: number; T: number; W: number; L: number; material: string }[];
  /** The joint schedule (19.2.5), on the sheet it's on: each joint type's detail letter (null: in the schedule only),
   *  its places, its kind. */
  jointSchedule?: { detail: string | null; places: number; kind: string }[];
  fields: Record<string, string>;
  revisions: { rev: string; date: string; text: string; by: string }[];
  notes: string[];
  /** What's laid out on the sheet: each block's box (its views with their sizes, notes and titles), for A17. */
  blocks?: Box[];
  /** The cover sheet (12.10). */
  cover?: boolean;
};

/** A DXF file as read back (dxf.ts readDxf): its version, units, layers and entities. */
export type DxfEntity = { type: string; layer: string; pts: P2[]; r?: number; text?: string; closed?: boolean };
export type DxfFile = { version: string; units: number | null; layers: string[]; entities: DxfEntity[] };
