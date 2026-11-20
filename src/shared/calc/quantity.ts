// Quantities (Stage 14.2): concrete with rounding to an order quantity, decking boards and screws, cladding boards or
// sheets for a wall less its openings (with the maker's cover width, looked up in their guide), and plasterboard by real
// sheet sizes. Waste is a stated percentage he can change, and it's shown in the answer. Quantities only: no prices.
import { CalcInputError, fmt, need, opt, r1, r2, r3, wasteOf, workingTable, type CalcResult } from "./result.js";

export type QuantityIn = {
  kind: "concrete" | "decking" | "cladding" | "plasterboard";
  waste_pct?: number;
  /** concrete: the pieces; order rounded up to this step in m³ (default 0.2) */
  pours?: { shape: "pier_square" | "pier_round" | "slab" | "strip"; count?: number; size_mm?: number; length_mm?: number; width_mm?: number; depth_mm: number; label?: string }[];
  order_step_m3?: number;
  /** decking: along the boards and across them */
  length_mm?: number;
  width_mm?: number;
  board_mm?: number;
  gap_mm?: number;
  board_length_mm?: number;
  joist_spacing_mm?: number;
  screws_per_joist?: number;
  /** cladding: the wall, its openings, and the product */
  height_mm?: number;
  openings?: { width_mm: number; height_mm: number; count?: number }[];
  cover_mm?: number;
  cover_source?: string;
  sheet_mm?: [number, number];
  /** plasterboard: each wall or ceiling */
  surfaces?: { kind: "wall" | "ceiling"; length_mm: number; height_mm: number; count?: number; label?: string }[];
  sheet_width_mm?: number;
  sheet_lengths_mm?: number[];
};

export function quantityCalc(a: QuantityIn): CalcResult {
  switch (a.kind) {
    case "concrete":
      return concrete(a);
    case "decking":
      return decking(a);
    case "cladding":
      return cladding(a);
    case "plasterboard":
      return plasterboard(a);
    default:
      throw new CalcInputError('kind is "concrete", "decking", "cladding" or "plasterboard".');
  }
}

const result = (title: string, say: string, answer: CalcResult["answer"], steps: string[], warnings: string[], sources: string[] = ["Arithmetic only."]): CalcResult => ({
  title,
  say,
  answer,
  steps,
  checks: [],
  warnings,
  sources,
  table: workingTable(steps, []),
});

function concrete(a: QuantityIn): CalcResult {
  const pours = a.pours ?? [];
  if (!pours.length) throw new CalcInputError("Say what's being poured: piers (how many, size, depth), a slab or a strip footing.");
  const waste = wasteOf(a.waste_pct, 10);
  const stepM3 = opt(a.order_step_m3, "order_step_m3") ?? 0.2;
  const steps: string[] = [];
  let total = 0;
  for (const [i, p] of pours.entries()) {
    const n = Math.round(opt(p.count, `pours[${i}].count`) ?? 1);
    const d = need(p.depth_mm, `pours[${i}].depth_mm`, "the depth") / 1000;
    let each: number;
    let how: string;
    if (p.shape === "pier_square") {
      const s = need(p.size_mm, `pours[${i}].size_mm`, "the pier's size") / 1000;
      each = s * s * d;
      how = `${n} × ${r3(s)} × ${r3(s)} × ${r3(d)}`;
    } else if (p.shape === "pier_round") {
      const dia = need(p.size_mm, `pours[${i}].size_mm`, "the pier's diameter") / 1000;
      each = Math.PI * (dia / 2) ** 2 * d;
      how = `${n} × π × ${r3(dia / 2)}² × ${r3(d)}`;
    } else if (p.shape === "slab" || p.shape === "strip") {
      const l = need(p.length_mm, `pours[${i}].length_mm`, "the length") / 1000;
      const w = need(p.width_mm, `pours[${i}].width_mm`, "the width") / 1000;
      each = l * w * d;
      how = `${n > 1 ? `${n} × ` : ""}${r3(l)} × ${r3(w)} × ${r3(d)}`;
    } else throw new CalcInputError('Each pour is "pier_square", "pier_round", "slab" or "strip".');
    total += n * each;
    steps.push(`${p.label ?? (p.shape === "pier_square" ? "Square piers" : p.shape === "pier_round" ? "Round piers" : p.shape === "slab" ? "Slab" : "Strip footing")}: ${how} = ${r3(n * each)} m³.`);
  }
  const withWaste = total * (1 + waste / 100);
  const order = Math.ceil(withWaste / stepM3 - 1e-9) * stepM3;
  steps.push(`Total ${r3(total)} m³; with ${waste}% waste ${r3(withWaste)} m³; ordered in ${stepM3} m³ steps: ${r2(order)} m³.`);
  return result(`Concrete: ${r2(order)} m³ to order`, `${r2(total)} cubic metres, so order ${r2(order)} with ${waste} per cent waste.`, { volume_m3: r3(total), with_waste_m3: r3(withWaste), order_m3: r2(order), waste_pct: waste }, steps, [
    `Waste is ${waste}%: change it if you like. Check your supplier's minimum order and steps.`,
  ]);
}

function decking(a: QuantityIn): CalcResult {
  const L = need(a.length_mm, "length_mm", "the deck's length along the boards");
  const W = need(a.width_mm, "width_mm", "the deck's width across the boards");
  const b = need(a.board_mm, "board_mm", "the board's width");
  const g = opt(a.gap_mm, "gap_mm", true);
  if (g === undefined) throw new CalcInputError("I need the gap between boards (from the board maker's guide, or what you use).");
  const waste = wasteOf(a.waste_pct, 10);
  const js = opt(a.joist_spacing_mm, "joist_spacing_mm");
  const per = Math.round(opt(a.screws_per_joist, "screws_per_joist") ?? 2);
  const steps: string[] = [];
  const rows = Math.ceil(W / (b + g) - 1e-9);
  steps.push(`Boards across: ${fmt(W)} ÷ (${b} + ${g} gap) = ${r2(W / (b + g))}, so ${rows} rows.`);
  const lm = (rows * L) / 1000;
  const lmW = lm * (1 + waste / 100);
  steps.push(`Lineal metres: ${rows} × ${r3(L / 1000)} = ${r2(lm)} m; with ${waste}% waste ${r2(lmW)} m.`);
  let boards: number | null = null;
  const bl = opt(a.board_length_mm, "board_length_mm");
  if (bl) {
    boards = Math.ceil((lmW * 1000) / bl - 1e-9);
    steps.push(`In ${fmt(bl)} lengths: ${boards} boards.`);
  }
  let screws: number | null = null;
  if (js) {
    const joists = Math.floor(L / js + 1e-9) + 1;
    screws = Math.ceil(rows * joists * per * (1 + waste / 100) - 1e-9);
    steps.push(`Joists under: ${fmt(L)} ÷ ${js} + 1 = ${joists}. Screws: ${rows} rows × ${joists} joists × ${per} = ${rows * joists * per}; with ${waste}% waste ${screws}.`);
  }
  return result(
    `Decking ${fmt(L)} × ${fmt(W)}`,
    `${r1(lmW)} lineal metres${boards ? `, ${boards} boards` : ""}${screws ? `, ${screws} screws` : ""}.`,
    { rows, lineal_m: r2(lm), lineal_with_waste_m: r2(lmW), boards, screws, waste_pct: waste },
    steps,
    [`Waste is ${waste}%: change it if you like. Board gap and fixing pattern come from the board maker's guide.`],
  );
}

function netWall(a: QuantityIn, steps: string[]) {
  const L = need(a.length_mm, "length_mm", "the wall's length");
  const H = need(a.height_mm, "height_mm", "the wall's height");
  const gross = (L * H) / 1e6;
  let less = 0;
  for (const [i, o] of (a.openings ?? []).entries()) less += ((o.count ?? 1) * need(o.width_mm, `openings[${i}].width_mm`, "the opening's width") * need(o.height_mm, `openings[${i}].height_mm`, "the opening's height")) / 1e6;
  const net = gross - less;
  if (net <= 0) throw new CalcInputError("The openings are bigger than the wall.");
  steps.push(`Wall ${r3(L / 1000)} × ${r3(H / 1000)} = ${r2(gross)} m²${less ? `, less openings ${r2(less)} m²` : ""} = ${r2(net)} m².`);
  return { L, H, net };
}

function cladding(a: QuantityIn): CalcResult {
  const waste = wasteOf(a.waste_pct, 10);
  const steps: string[] = [];
  const { net } = netWall(a, steps);
  const warnings = [`Waste is ${waste}%: change it if you like.`];
  const sources: string[] = [];
  if (a.sheet_mm) {
    const [sw, sh] = a.sheet_mm.map((v, i) => need(v, `sheet_mm[${i}]`, "the sheet size"));
    const area = (sw * sh) / 1e6;
    const sheets = Math.ceil((net * (1 + waste / 100)) / area - 1e-9);
    steps.push(`Sheets ${fmt(sw)} × ${fmt(sh)} = ${r2(area)} m² each: ${r2(net)} × ${1 + waste / 100} ÷ ${r2(area)} = ${sheets} sheets.`);
    if (a.cover_source) sources.push(a.cover_source);
    return result("Cladding sheets", `${sheets} sheets with ${waste} per cent waste.`, { net_m2: r2(net), sheets, waste_pct: waste }, steps, warnings, sources.length ? sources : ["Arithmetic only."]);
  }
  const cover = opt(a.cover_mm, "cover_mm");
  if (!cover) throw new CalcInputError("I need the board's effective cover (from the maker's guide: look it up first and give the page), or the sheet size.");
  if (!a.cover_source) warnings.push("Say where the cover width came from (the maker's guide and page).");
  else sources.push(`Cover ${cover} mm: ${a.cover_source}`);
  const lm = net / (cover / 1000);
  const lmW = lm * (1 + waste / 100);
  steps.push(`Lineal metres: ${r2(net)} m² ÷ ${r3(cover / 1000)} m cover = ${r2(lm)} m; with ${waste}% waste ${r2(lmW)} m.`);
  let boards: number | null = null;
  const bl = opt(a.board_length_mm, "board_length_mm");
  if (bl) {
    boards = Math.ceil((lmW * 1000) / bl - 1e-9);
    steps.push(`In ${fmt(bl)} lengths: ${boards} boards.`);
  }
  return result("Cladding boards", `${r1(lmW)} lineal metres${boards ? `, ${boards} boards` : ""}.`, { net_m2: r2(net), lineal_m: r2(lm), lineal_with_waste_m: r2(lmW), boards, waste_pct: waste }, steps, warnings, sources.length ? sources : ["Arithmetic only."]);
}

/** Common plasterboard lengths in mm. The maker's range differs by thickness and type: check before ordering. */
export const SHEET_LENGTHS = [2400, 2700, 3000, 3600, 4200, 4800, 5400, 6000];

function plasterboard(a: QuantityIn): CalcResult {
  const surfaces = a.surfaces ?? [];
  if (!surfaces.length) throw new CalcInputError("Give the walls and ceilings: length and height (or width) of each.");
  const waste = wasteOf(a.waste_pct, 10);
  const sw = opt(a.sheet_width_mm, "sheet_width_mm") ?? 1200;
  const lengths = [...(a.sheet_lengths_mm?.length ? a.sheet_lengths_mm : SHEET_LENGTHS)].sort((x, y) => x - y);
  const steps: string[] = [];
  const bySize = new Map<number, number>();
  let area = 0;
  for (const [i, s] of surfaces.entries()) {
    const L = need(s.length_mm, `surfaces[${i}].length_mm`, "the length");
    const H = need(s.height_mm, `surfaces[${i}].height_mm`, s.kind === "ceiling" ? "the ceiling's width" : "the wall's height");
    const n = Math.round(s.count ?? 1);
    area += (n * L * H) / 1e6;
    // sheets run along the length: rows across the height (a wall) or width (a ceiling)
    const rows = Math.ceil(H / sw - 1e-9);
    const one = lengths.find((x) => x >= L);
    const pieces = one ? [{ len: one, count: 1 }] : [{ len: lengths[lengths.length - 1], count: Math.ceil(L / lengths[lengths.length - 1] - 1e-9) }];
    for (const p of pieces) bySize.set(p.len, (bySize.get(p.len) ?? 0) + p.count * rows * n);
    steps.push(`${s.label ?? (s.kind === "ceiling" ? "Ceiling" : "Wall")}${n > 1 ? ` × ${n}` : ""} ${fmt(L)} × ${fmt(H)}: ${rows} row${rows > 1 ? "s" : ""} of ${sw} sheets, ${pieces.map((p) => `${p.count} × ${fmt(p.len)}`).join(" + ")} a row${one ? "" : " (butt joins)"}: ${pieces.reduce((t, p) => t + p.count, 0) * rows * n} sheets.`);
  }
  const order = [...bySize.entries()].sort(([x], [y]) => x - y).map(([len, count]) => ({ len, count, withWaste: Math.ceil(count * (1 + waste / 100) - 1e-9) }));
  const total = order.reduce((t, o) => t + o.withWaste, 0);
  steps.push(`Area ${r2(area)} m². To order with ${waste}% waste: ${order.map((o) => `${o.withWaste} × ${fmt(o.len)}`).join(", ")} (${sw} wide): ${total} sheets.`);
  return result(
    "Plasterboard",
    `${total} sheets: ${order.map((o) => `${o.withWaste} at ${(o.len / 1000).toFixed(1)}`).join(", ")}.`,
    { area_m2: r2(area), sheets: total, ...Object.fromEntries(order.map((o) => [`sheets_${o.len}`, o.withWaste])), waste_pct: waste },
    steps,
    [`Waste is ${waste}%: change it if you like.`, `Sheet lengths assumed: ${lengths.map((l) => fmt(l)).join(", ")} at ${sw} wide; the maker's range depends on the board's thickness and type, so check it (their guide is on the shelf).`],
  );
}
