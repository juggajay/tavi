// Set-out (Stage 14.2): squaring by diagonals and 3-4-5, falls and gradients, reduced levels from readings, and a stud
// wall's set-out and count. Pure arithmetic and geometry, every step shown.
import type { SketchShape } from "../protocol.js";
import { CalcInputError, fmt, mm, need, opt, r1, r2, r3, RAD, wasteOf, workingTable, type CalcResult } from "./result.js";

export type SetoutIn = {
  kind: "square" | "345" | "fall" | "levels" | "studs";
  length_mm?: number;
  width_mm?: number;
  diagonal1_mm?: number;
  diagonal2_mm?: number;
  /** fall: one of these with the length */
  fall_mm?: number;
  ratio?: number; // 1 in ratio (100 for 1:100)
  percent?: number;
  degrees?: number;
  /** levels, in metres: the benchmark's reduced level and the staff readings in order */
  benchmark_rl_m?: number;
  readings?: { label: string; bs?: number; is?: number; fs?: number; design_rl_m?: number }[];
  /** studs */
  centres_mm?: number;
  stud_mm?: number;
  frame_height_mm?: number;
  plates?: number;
  plate_mm?: number;
  nogging_rows?: number;
  openings?: { width_mm: number; from_mm: number; kind?: "door" | "window" }[];
  stock_mm?: number;
  waste_pct?: number;
};

export function setoutCalc(a: SetoutIn): CalcResult {
  switch (a.kind) {
    case "square":
      return square(a);
    case "345":
      return threeFourFive(a);
    case "fall":
      return fall(a);
    case "levels":
      return levels(a);
    case "studs":
      return studs(a);
    default:
      throw new CalcInputError('kind is "square", "345", "fall", "levels" or "studs".');
  }
}

const done = (title: string, say: string, answer: CalcResult["answer"], steps: string[], extra: Partial<CalcResult> = {}): CalcResult => ({
  title,
  say,
  answer,
  steps,
  checks: [],
  warnings: [],
  sources: ["Arithmetic and geometry only."],
  table: workingTable(steps, []),
  ...extra,
});

function square(a: SetoutIn): CalcResult {
  const L = need(a.length_mm, "length_mm", "the length");
  const W = need(a.width_mm, "width_mm", "the width");
  const d = Math.hypot(L, W);
  const steps = [`Diagonal = √(${fmt(L)}² + ${fmt(W)}²) = ${fmt(mm(d))}. Both diagonals read that when it's square.`];
  let say = `Diagonals ${fmt(Math.round(d))} each.`;
  const d1 = opt(a.diagonal1_mm, "diagonal1_mm");
  const d2 = opt(a.diagonal2_mm, "diagonal2_mm");
  let out: number | null = null;
  if (d1 && d2) {
    out = Math.abs(d1 - d2);
    // racked into a parallelogram by δ along the length: the diagonals differ by about 2·δ·L ÷ d
    const rack = (out * d) / (2 * L);
    steps.push(`Measured ${fmt(d1)} and ${fmt(d2)}: out by ${r1(out)}. Push the long diagonal's corners in until both read ${fmt(mm(d))} (about ${r1(rack)} of sideways movement at the far end).`);
    if (Math.abs((d1 + d2) / 2 - d) > 5) steps.push(`The two average ${r1((d1 + d2) / 2)}, not ${fmt(mm(d))}: check the length and width too.`);
    say = out < 1 ? "It's square." : `Out by ${Math.round(out)}. Both should read ${fmt(Math.round(d))}.`;
  }
  return done(`Squaring ${fmt(L)} × ${fmt(W)}`, say, { diagonal_mm: r1(d), out_by_mm: out === null ? null : r1(out) }, steps, {
    sketch: {
      title: `Square ${fmt(L)} × ${fmt(W)}`,
      shapes: [
        { type: "rect", x: 0, y: 0, w: L, h: W, fill: "none" },
        { type: "line", a: [0, 0], b: [L, W], style: "dashed" },
        { type: "line", a: [0, W], b: [L, 0], style: "dashed" },
        { type: "dim", a: [0, 0], b: [L, 0], offset: -Math.max(200, W * 0.08), text: fmt(L) },
        { type: "dim", a: [0, 0], b: [0, W], offset: Math.max(200, L * 0.06), text: fmt(W) },
        { type: "label", at: [L * 0.55, W * 0.62], text: `${fmt(mm(d))} each`, leader: [L * 0.5, W * 0.5] },
      ],
    },
  });
}

const TRIANGLES = [
  [600, 800, 1000],
  [900, 1200, 1500],
  [1200, 1600, 2000],
  [1800, 2400, 3000],
  [3000, 4000, 5000],
  [6000, 8000, 10000],
];

function threeFourFive(a: SetoutIn): CalcResult {
  const room = opt(a.length_mm, "length_mm");
  const pick = room ? ([...TRIANGLES].reverse().find((t) => t[1] <= room) ?? TRIANGLES[0]) : TRIANGLES[3];
  const steps = [
    `Mark ${fmt(pick[0])} along one line and ${fmt(pick[1])} along the other from the corner; the corner is square when the marks are ${fmt(pick[2])} apart (3-4-5: ${fmt(pick[0])}² + ${fmt(pick[1])}² = ${fmt(pick[2])}²).`,
    `Bigger is more accurate: ${TRIANGLES.map((t) => t.map((v) => fmt(v)).join("-")).join(", ")}.`,
  ];
  return done("3-4-5 square corner", `${fmt(pick[0])}, ${fmt(pick[1])}, and ${fmt(pick[2])} across.`, { a_mm: pick[0], b_mm: pick[1], c_mm: pick[2] }, steps, {
    sketch: {
      title: "3-4-5",
      shapes: [
        { type: "line", a: [0, 0], b: [pick[1], 0], weight: 2 },
        { type: "line", a: [0, 0], b: [0, pick[0]], weight: 2 },
        { type: "line", a: [0, pick[0]], b: [pick[1], 0], style: "dashed" },
        { type: "dim", a: [0, 0], b: [pick[1], 0], offset: -150, text: fmt(pick[1]) },
        { type: "dim", a: [0, 0], b: [0, pick[0]], offset: 150, text: fmt(pick[0]) },
        { type: "label", at: [pick[1] * 0.6, pick[0] * 0.7], text: fmt(pick[2]), leader: [pick[1] / 2, pick[0] / 2] },
      ],
    },
  });
}

function fall(a: SetoutIn): CalcResult {
  const L = need(a.length_mm, "length_mm", "the length the fall is over");
  let f: number;
  const steps: string[] = [];
  if (a.fall_mm !== undefined) f = need(a.fall_mm, "fall_mm", "the fall");
  else if (a.ratio !== undefined) (f = L / need(a.ratio, "ratio", "the gradient (the n in 1 in n)")), steps.push(`1 in ${a.ratio} over ${fmt(L)}: ${fmt(L)} ÷ ${a.ratio} = ${r1(f)}.`);
  else if (a.percent !== undefined) (f = (L * need(a.percent, "percent", "the gradient in per cent")) / 100), steps.push(`${a.percent}% of ${fmt(L)} = ${r1(f)}.`);
  else if (a.degrees !== undefined) (f = L * Math.tan(need(a.degrees, "degrees", "the angle") * RAD)), steps.push(`${fmt(L)} × tan ${a.degrees}° = ${r1(f)}.`);
  else throw new CalcInputError("Give the fall, or the gradient (1 in n, per cent or degrees).");
  const ratio = L / f;
  steps.push(`Fall ${r1(f)} over ${fmt(L)}: 1 in ${r1(ratio)}, ${r2((f / L) * 100)}%, ${r2(Math.atan(f / L) / RAD)}°, ${r1((f / L) * 1000)} per metre.`);
  return done(`Fall over ${fmt(L)}`, `${Math.round(f)} mil over ${fmt(L)}, that's 1 in ${Math.round(ratio)}.`, { fall_mm: r1(f), one_in: r1(ratio), percent: r2((f / L) * 100), degrees: r2(Math.atan(f / L) / RAD), per_metre_mm: r1((f / L) * 1000) }, steps);
}

function levels(a: SetoutIn): CalcResult {
  const bm = a.benchmark_rl_m;
  if (bm === undefined || !Number.isFinite(bm)) throw new CalcInputError("I need the benchmark's reduced level (in metres).");
  const rs = a.readings ?? [];
  if (!rs.length || rs[0].bs === undefined) throw new CalcInputError("The first reading is the backsight on the benchmark.");
  const rows: string[][] = [];
  const steps: string[] = [];
  let hi = bm + rs[0].bs;
  steps.push(`Height of instrument = ${r3(bm)} + backsight ${r3(rs[0].bs)} = ${r3(hi)}.`);
  rows.push([rs[0].label || "BM", r3(rs[0].bs).toFixed(3), "", "", r3(hi).toFixed(3), r3(bm).toFixed(3), ""]);
  let sumBs = rs[0].bs;
  let sumFs = 0;
  let last = bm;
  const out: { label: string; rl: number; cut?: number }[] = [];
  for (const r of rs.slice(1)) {
    const read = r.fs ?? r.is;
    if (read === undefined || !Number.isFinite(read)) throw new CalcInputError(`Reading "${r.label}" needs an intermediate or a foresight.`);
    const rl = hi - read;
    last = rl;
    if (r.fs !== undefined) sumFs += r.fs;
    const diff = r.design_rl_m !== undefined ? rl - r.design_rl_m : undefined; // positive: above design, so cut
    out.push({ label: r.label, rl, cut: diff });
    const note = diff === undefined ? "" : diff > 0.0005 ? `cut ${Math.round(diff * 1000)}` : diff < -0.0005 ? `fill ${Math.round(-diff * 1000)}` : "on level";
    rows.push([r.label, r.bs !== undefined ? r3(r.bs).toFixed(3) : "", r.is !== undefined ? r3(r.is).toFixed(3) : "", r.fs !== undefined ? r3(r.fs).toFixed(3) : "", r.bs !== undefined ? r3(rl + r.bs).toFixed(3) : "", r3(rl).toFixed(3), note]);
    if (r.bs !== undefined) {
      hi = rl + r.bs; // a change point: the level moves; new height of instrument
      sumBs += r.bs;
      steps.push(`${r.label} is a change point: RL ${r3(rl)}, new height of instrument ${r3(hi)}.`);
    }
  }
  steps.push(`Each RL = height of instrument − reading.`);
  // the arithmetic check: Σ backsights − Σ foresights = last RL − first RL (the last reading must be a foresight,
  // and a change point's backsight after the last foresight doesn't count)
  const closed = rs[rs.length - 1].fs !== undefined;
  const lastBs = closed && rs[rs.length - 1].bs !== undefined ? rs[rs.length - 1].bs! : 0;
  const check = sumBs - lastBs - sumFs;
  const agrees = Math.abs(check - (last - bm)) < 0.0005;
  steps.push(`Check: Σ backsights ${r3(sumBs - lastBs)} − Σ foresights ${r3(sumFs)} = ${r3(check)}; last RL − first = ${r3(last - bm)}${closed ? (agrees ? ": agrees." : ": doesn't agree, recheck the bookings.") : " (finish on a foresight to close the check)."}`);
  return {
    title: "Reduced levels",
    say: `${out.length} levels worked out from the benchmark at ${r3(bm)}.`,
    answer: Object.fromEntries(out.map((o) => [o.label, r3(o.rl)])),
    steps,
    checks: [],
    warnings: [],
    sources: ["Height-of-instrument method: RL = HI − reading; HI = RL + backsight."],
    table: { columns: ["Point", "BS", "IS", "FS", "HI", "RL", "Design"], rows },
  };
}

function studs(a: SetoutIn): CalcResult {
  const L = need(a.length_mm, "length_mm", "the wall's length");
  const c = need(a.centres_mm, "centres_mm", "the stud centres (450 or 600)");
  const t = opt(a.stud_mm, "stud_mm") ?? 45;
  const plates = Math.round(opt(a.plates, "plates") ?? 2);
  const pt = opt(a.plate_mm, "plate_mm") ?? 45;
  const H = opt(a.frame_height_mm, "frame_height_mm");
  const rows = Math.round(opt(a.nogging_rows, "nogging_rows", true) ?? 1);
  const stock = opt(a.stock_mm, "stock_mm") ?? 6000;
  const waste = wasteOf(a.waste_pct, 10);
  const steps: string[] = [];
  // layout: a stud each end; the rest at exact centres measured from the start, so sheet joints land on studs
  const marks: number[] = [t / 2];
  for (let x = c; x < L - t / 2 - t; x += c) marks.push(x);
  marks.push(L - t / 2);
  steps.push(`Studs at ${c} centres from the start end (so sheet joints land on studs), plus one at each end: ${marks.length} positions (centres at ${marks.slice(0, 6).map((m) => fmt(Math.round(m))).join(", ")}${marks.length > 6 ? ", …" : ""}).`);
  let full = marks.length;
  let short = 0;
  const openings = a.openings ?? [];
  for (const [i, o] of openings.entries()) {
    const w = need(o.width_mm, `openings[${i}].width_mm`, "the opening's width");
    const from = o.from_mm;
    if (!Number.isFinite(from) || from < 0 || from + w > L) throw new CalcInputError(`Opening ${i + 1} doesn't fit in the wall: give where it starts (from the start end) and its width.`);
    const inside = marks.filter((m) => m > from - t / 2 && m < from + w + t / 2).length;
    full -= inside;
    full += 2; // a full-height stud each side
    short += inside * (o.kind === "door" ? 1 : 2);
    steps.push(`Opening ${i + 1} (${o.kind ?? "window"}, ${fmt(w)} wide at ${fmt(from)}): ${inside} layout studs become ${o.kind === "door" ? "short studs above" : "short studs above and below"}; a full-height stud each side.`);
  }
  const studLen = H ? H - plates * pt : null;
  const plateLm = (L * plates) / 1000;
  const plateLengths = Math.ceil((plateLm * (1 + waste / 100) * 1000) / stock - 1e-9);
  const nogLm = rows * Math.max(0, L - marks.length * t) / 1000;
  const nogLengths = Math.ceil((nogLm * (1 + waste / 100) * 1000) / stock - 1e-9);
  steps.push(`Full-height studs: ${full}${studLen ? `, each ${fmt(studLen)} long (frame ${fmt(H!)} less ${plates} plates of ${pt})` : ""}.${short ? ` Short studs: ${short} (lengths from the opening heights).` : ""}`);
  steps.push(`Plates: ${plates} × ${fmt(L)} = ${r2(plateLm)} m; with ${waste}% waste, ${plateLengths} × ${fmt(stock)} lengths.`);
  if (rows) steps.push(`Noggings: ${rows} row${rows > 1 ? "s" : ""} between the studs, about ${r2(nogLm)} m; with ${waste}% waste, ${nogLengths} × ${fmt(stock)} lengths.`);
  const shapes: SketchShape[] = [
    { type: "rect", x: 0, y: 0, w: L, h: pt, fill: "timber" },
    { type: "rect", x: 0, y: (H ?? 2400) - pt * Math.max(1, plates - 1), w: L, h: pt * Math.max(1, plates - 1), fill: "timber" },
  ];
  const top = (H ?? 2400) - pt * Math.max(1, plates - 1);
  for (const m of marks.slice(0, 120)) {
    const inOpening = openings.some((o) => m > o.from_mm - t / 2 && m < o.from_mm + o.width_mm + t / 2);
    if (!inOpening) shapes.push({ type: "rect", x: r1(m - t / 2), y: pt, w: t, h: r1(top - pt), fill: "none" });
  }
  for (const o of openings) shapes.push({ type: "rect", x: o.from_mm, y: o.kind === "door" ? pt : 900, w: o.width_mm, h: o.kind === "door" ? 2100 - pt : 1200, fill: "hatch" });
  shapes.push({ type: "dim", a: [0, 0], b: [L, 0], offset: -250, text: fmt(L) });
  if (marks.length > 1) shapes.push({ type: "dim", a: [marks[0], top + 100], b: [marks[1], top + 100], offset: 200, text: `${c} crs` });
  return {
    title: `Stud wall ${fmt(L)} at ${c} centres`,
    say: `${full} studs${short ? ` and ${short} short ones` : ""}, ${plateLengths} lengths of plate.`,
    answer: { studs: full, short_studs: short, stud_length_mm: studLen, plate_lengths: plateLengths, nogging_lengths: rows ? nogLengths : 0, waste_pct: waste },
    steps,
    checks: [],
    warnings: [
      `Assumed: studs ${t} thick, ${plates} plates ${pt} thick, ${fmt(stock)} stock lengths, ${waste}% waste. Change any of them.`,
      "Jamb studs, lintels, trimmers, bracing and tie-down follow the span tables or the engineer; only the layout and counts are here.",
    ],
    sources: ["Arithmetic only."],
    table: workingTable(steps, []),
    sketch: { title: `Wall ${fmt(L)}, studs at ${c}`, shapes, note: "Elevation. Studs at exact centres from the left end." },
  };
}
