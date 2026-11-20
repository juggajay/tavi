// Shelf sag (Stage 20.2): how far a shelf resting on its two ends sags under an even load, by the standard beam formula
// 5wL⁴ / (384EI) with I = bd³/12; against a target of about 1.7 mm per metre of span when first loaded, and half as much
// again over time (creep). The stiffness E is the species' own where an open figure exists, else a general figure for
// its group (WoodSolutions), and the answer says which. Furniture and joinery shelves only: anything people stand on,
// or that holds up part of a building, is the code's, the maker's or an engineer's. Pure code.
import { rule, ruleCite } from "../model3d/designRules.js";
import { CalcInputError, fmt, need, opt, r1, r2, workingTable, type CalcResult, type Check } from "./result.js";

export const G = 9.81; // m/s², to turn kilograms into newtons

export type ShelfIn = {
  span_mm: number;
  /** front to back */
  depth_mm: number;
  thickness_mm: number;
  /** the load spread along it: kg per metre of shelf, or kg in all */
  load_kg_per_m?: number;
  load_kg?: number;
  /** stiffness, MPa, with where it came from and whether it's a general figure for a group rather than the species' own */
  e_mpa: number;
  e_source: string;
  e_general: boolean;
  /** the timber's density, kg/m³, to add the shelf's own weight (from the species data when known) */
  density_kg_m3?: number;
  density_source?: string;
};

export function shelfCalc(a: ShelfIn): CalcResult {
  const L = need(a.span_mm, "span_mm", "the clear span between the supports, in millimetres");
  const b = need(a.depth_mm, "depth_mm", "the shelf's depth front to back, in millimetres");
  const d = need(a.thickness_mm, "thickness_mm", "the shelf's thickness, in millimetres");
  const E = need(a.e_mpa, "e_mpa", "the timber's stiffness (modulus of elasticity) in MPa");
  const perM = opt(a.load_kg_per_m, "load_kg_per_m", true);
  const total = opt(a.load_kg, "load_kg", true);
  if (perM === undefined && total === undefined) throw new CalcInputError("I need the load: how many kilograms along it (or per metre), spread evenly.");
  if (perM !== undefined && total !== undefined) throw new CalcInputError("Give the load one way: kilograms per metre, or kilograms in all.");
  const loadPerM = perM ?? (total! / (L / 1000));
  const dens = opt(a.density_kg_m3, "density_kg_m3");
  const selfPerM = dens ? dens * (b / 1000) * (d / 1000) : 0; // kg per metre of shelf
  const w = ((loadPerM + selfPerM) * G) / 1000; // N per mm
  const I = (b * d ** 3) / 12; // mm⁴
  const sag = (5 * w * L ** 4) / (384 * E * I);
  const target = rule("shelf_sag_target").value.prefer!;
  const creep = rule("shelf_creep").value.prefer!;
  const limit = (target * L) / 1000;
  const longTerm = sag * creep;
  const formula = rule("beam_sag");
  const steps = [
    `Load: ${perM !== undefined ? `${r2(perM)} kg/m` : `${r2(total!)} kg over ${fmt(L)} mm = ${r2(loadPerM)} kg/m`}${selfPerM ? ` + the shelf's own ${r2(selfPerM)} kg/m (density ${fmt(dens!)} kg/m³${a.density_source ? `, ${a.density_source}` : ""})` : ""}`,
    `w = ${r2(loadPerM + selfPerM)} × ${G} ÷ 1000 = ${w.toFixed(4)} N/mm`,
    `I = b × d³ ÷ 12 = ${fmt(b)} × ${fmt(d)}³ ÷ 12 = ${fmt(Math.round(I))} mm⁴`,
    `E = ${fmt(E)} MPa (${a.e_source}${a.e_general ? "; a general figure, not this species' own" : ""})`,
    `Sag = 5 × w × L⁴ ÷ (384 × E × I) = 5 × ${w.toFixed(4)} × ${fmt(L)}⁴ ÷ (384 × ${fmt(E)} × ${fmt(Math.round(I))}) = ${r2(sag)} mm`,
    `Over time (creep, about ${creep} times): ${r2(sag)} × ${creep} = ${r2(longTerm)} mm`,
  ];
  const checks: Check[] = [
    { what: "Sag when first loaded", value: `${r2(sag)} mm`, limit: `${r2(limit)} mm (about ${target} mm per metre of span)`, ok: sag <= limit, source: ruleCite(rule("shelf_sag_target")) },
    { what: "Sag over time", value: `${r2(longTerm)} mm`, limit: `${r2(limit * creep)} mm (the same target allowing for creep)`, ok: longTerm <= limit * creep, source: ruleCite(rule("shelf_creep")) },
  ];
  const ok = checks[0].ok;
  const warnings = [
    ...(a.e_general ? [`The stiffness is a general figure for the group (${a.e_source}), not this species' own: the real sag could differ.`] : []),
    `The ${target} mm per metre target and the ${creep} times allowance for creep are rules of thumb from a summary, not confirmed on the shelf.`,
    "For a furniture or joinery shelf only. Anything people stand on, or that holds up part of the building, is for the code, the maker's tables or an engineer.",
  ];
  return {
    title: `Shelf sag, ${fmt(L)} span, ${fmt(b)} × ${fmt(d)}`,
    say: `About ${r1(sag)} mil of sag when first loaded, ${ok ? "inside" : "more than"} the ${r1(limit)} that looks flat${ok ? "" : ", so go thicker, deeper or shorter"}. It's on screen.`,
    answer: { sag_mm: r2(sag), long_term_mm: r2(longTerm), target_mm: r2(limit), passes: ok, e_mpa: E, e_general: a.e_general, load_kg_per_m: r2(loadPerM + selfPerM) },
    steps,
    checks,
    warnings,
    sources: [`Formula: ${ruleCite(formula)}`, `Stiffness: ${a.e_source}`, ...(a.density_source ? [`Density: ${a.density_source}`] : [])],
    table: workingTable(steps, checks),
  };
}
