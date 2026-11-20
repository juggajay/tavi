// How much a board or panel moves across its width with a change in moisture content, and so the gap to leave
// (Stage 20.2). Movement = width × unit shrinkage (% per 1% change in moisture content) × the change ÷ 100 (the design
// rule movement_formula, WoodSolutions Timber Flooring guide, Appendix A4, page 92). The unit shrinkage is the species'
// own, from the Queensland data on the shelf, passed in by the tool with its citation; or one the owner gives. Pure code.
import { rule, ruleCite } from "../model3d/designRules.js";
import { CalcInputError, fmt, mm, need, r2, workingTable, type CalcResult } from "./result.js";

export type MovementIn = {
  width_mm: number;
  /** % per 1% change in moisture content, for the way the board is cut (tangential for backsawn, radial for quartersawn) */
  unit_pct: number;
  /** where the unit shrinkage came from, as it's cited ("Business Queensland, Blackbutt, page updated 14 May 2021") */
  unit_source: string;
  cut: "backsawn" | "quartersawn";
  mc_from_pct: number;
  mc_to_pct: number;
  /** what it is, for the words ("panel", "tabletop", "floor of 10 boards") */
  what?: string;
};

export function movementCalc(a: MovementIn): CalcResult {
  const w = need(a.width_mm, "width_mm", "the width across the grain, in millimetres");
  const u = need(a.unit_pct, "unit_pct", "the unit shrinkage (% per 1% change in moisture content)");
  if (u > 1) throw new CalcInputError("A unit shrinkage over 1% per 1% change in moisture content isn't one: check the figure.");
  for (const [k, v] of [["mc_from_pct", a.mc_from_pct], ["mc_to_pct", a.mc_to_pct]] as const)
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v >= 100) throw new CalcInputError(`${k} needs to be a moisture content in per cent, above 0 and below 100.`);
  const change = a.mc_to_pct - a.mc_from_pct;
  if (change === 0) throw new CalcInputError("The moisture content doesn't change, so the board doesn't move.");
  const move = (w * u * Math.abs(change)) / 100;
  const swells = change > 0;
  const f = rule("movement_formula");
  const what = a.what ?? "board";
  const steps = [
    `Unit shrinkage (${a.cut === "quartersawn" ? "quartersawn: radial" : "backsawn: tangential"}): ${u}% per 1% change in moisture content (${a.unit_source})`,
    `Change in moisture content: ${a.mc_to_pct}% − ${a.mc_from_pct}% = ${change > 0 ? "+" : ""}${r2(change)}%`,
    `Movement = ${fmt(w)} × ${u} × ${r2(Math.abs(change))} ÷ 100 = ${r2(move)} mm (${f.words.split("=")[0].trim()})`,
    swells ? `It swells: leave ${mm(move)} mm of room across the ${what} for it.` : `It shrinks: the ${what} gets ${mm(move)} mm narrower, so a groove or cover must hide that much.`,
  ];
  return {
    title: `Movement across a ${fmt(w)} mm ${what}`,
    say: `About ${mm(move)} mil across the ${fmt(w)}, ${swells ? "swelling" : "shrinking"}${swells ? `, so leave that much room` : ""}. It's on screen.`,
    answer: { movement_mm: r2(move), direction: swells ? "swells" : "shrinks", gap_mm: swells ? mm(move) : null, unit_pct: u, change_pct: r2(change) },
    steps,
    checks: [],
    warnings: [
      `${f.note}`,
      "Unit shrinkage holds between about 3% moisture content and the fibre saturation point (WoodSolutions); outside that this sum doesn't apply.",
      "A figure for the species on average: one board can move more or less.",
    ],
    sources: [`Formula: ${ruleCite(f)}`, `Unit shrinkage: ${a.unit_source}`],
    table: workingTable(steps, []),
  };
}
