// Stairs and barriers (Stage 14.2): from the total rise (finished floor to finished floor) and the run available, the
// workable stairs (risers, rise, going), 2R + G, the stringer's pitch line, cut angles and step-off marks, the headroom
// line, and the barrier, handrail and baluster spacing; each checked against the NCC Housing Provisions (ncc.ts, every
// figure sourced there). Pure geometry and arithmetic: the stringer and tread sizes are not chosen here.
import type { SketchShape } from "../protocol.js";
import { CODE_EDITION_DEFAULT, editionNote, NCC_ATTRIBUTION, NCC_BARRIERS as B, NCC_HEADROOM, NCC_PAGES, NCC_STAIRS as S, nccSource, type CodeEdition, type StairKind } from "./ncc.js";
import { CalcInputError, deg, fmt, mm, need, opt, r1, RAD, workingTable, type CalcResult, type Check } from "./result.js";

export type StairIn = {
  /** Finished floor to finished floor. */
  total_rise_mm: number;
  /** The horizontal room for the flight: from the face of the bottom riser to the face of the top riser (the top floor's edge). */
  run_available_mm?: number;
  /** A going they've picked. */
  going_mm?: number;
  /** A number of risers they've picked. */
  risers?: number;
  kind?: StairKind;
  width_mm?: number;
  open_risers?: boolean;
  tread_thickness_mm?: number;
  /** Height of the ceiling or the floor structure's underside above the lower floor, where the stair passes under it. */
  ceiling_mm?: number;
  /** Or the depth of the upper floor at the opening (the soffit is then total rise less this). */
  upper_floor_depth_mm?: number;
  /** A doorway opens straight onto the top of the stair. */
  door_at_top?: boolean;
  winders?: number;
  turn?: "quarter" | "half";
  /** A side of the stair is open (no wall). */
  open_side?: boolean;
  baluster_mm?: number;
  max_gap_mm?: number;
};

/** Where 2R + G is most comfortable: the middle of the code's range. */
const comfortable = (k: StairKind) => (S.dims[k].twoRG[0] + S.dims[k].twoRG[1]) / 2;

type Option = { risers: number; riser: number; going: number; twoRG: number; totalGoing: number; pitch: number; passes: boolean; fits: boolean; goingRange: [number, number] };

function option(total: number, n: number, kind: StairKind, run?: number, going?: number): Option {
  const d = S.dims[kind];
  const R = total / n;
  const lo = Math.max(d.going[0], d.twoRG[0] - 2 * R);
  const hi = Math.min(d.going[1], d.twoRG[1] - 2 * R);
  const fit = run !== undefined && n > 1 ? run / (n - 1) : Infinity;
  // the going: theirs, else the one nearest the comfortable 2R + G, within the limits and (when it can) the run, in whole
  // mm. When no going in the limits fits the run, it keeps a going in the limits and says it doesn't fit.
  const cap = fit >= lo ? Math.min(hi, fit) : hi;
  const G = going ?? Math.floor(Math.min(cap, Math.max(lo, comfortable(kind) - 2 * R)) + 1e-9);
  const twoRG = 2 * R + G;
  const passes = n >= S.risersPerFlight.min && n <= S.risersPerFlight.max && R >= d.riser[0] - 1e-9 && R <= d.riser[1] + 1e-9 && G >= d.going[0] && G <= d.going[1] && twoRG >= d.twoRG[0] - 1e-9 && twoRG <= d.twoRG[1] + 1e-9;
  const totalGoing = (n - 1) * G;
  return { risers: n, riser: R, going: G, twoRG, totalGoing, pitch: Math.atan(R / G) / RAD, passes, fits: run === undefined || totalGoing <= run + 1e-9, goingRange: [lo, hi] };
}

/** The stairs that work: every riser count the riser limits allow, best first (passes, fits the run, comfortable). */
export function stairOptions(total: number, kind: StairKind = "standard", run?: number): Option[] {
  const d = S.dims[kind];
  const from = Math.max(S.risersPerFlight.min, Math.ceil(total / d.riser[1] - 1e-9));
  const to = Math.floor(total / d.riser[0] + 1e-9);
  const out: Option[] = [];
  for (let n = from; n <= Math.min(to, from + 8); n++) out.push(option(total, n, kind, run));
  const score = (o: Option) => (o.passes ? 0 : 2000) + (o.fits ? 0 : 1000) + Math.abs(o.twoRG - comfortable(kind)) + (o.risers > S.risersPerFlight.max ? 3000 : 0);
  return out.sort((a, b) => score(a) - score(b));
}

const fmtR = (v: number) => (Number.isInteger(r1(v)) ? String(r1(v)) : r1(v).toFixed(1));

export function stairCalc(a: StairIn, edition: CodeEdition = CODE_EDITION_DEFAULT, now = new Date()): CalcResult {
  const total = need(a.total_rise_mm, "total_rise_mm", "the total rise, finished floor to finished floor");
  const kind: StairKind = a.kind ?? "standard";
  if (!S.dims[kind]) throw new CalcInputError('kind is "standard", "spiral" or "attic".');
  const run = opt(a.run_available_mm, "run_available_mm");
  const goingIn = opt(a.going_mm, "going_mm");
  const tread = opt(a.tread_thickness_mm, "tread_thickness_mm");
  const width = opt(a.width_mm, "width_mm");
  if (a.risers !== undefined && (!Number.isInteger(a.risers) || a.risers < 1)) throw new CalcInputError("risers needs to be a whole number.");
  const d = S.dims[kind];
  const src = (clause: string) => nccSource(clause);
  const steps: string[] = [];
  const checks: Check[] = [];
  const warnings: string[] = [];

  // 1. the number of risers
  const minRisers = Math.max(S.risersPerFlight.min, Math.ceil(total / d.riser[1] - 1e-9));
  const options = stairOptions(total, kind, run);
  let chosen: Option;
  if (a.risers) chosen = option(total, a.risers, kind, run, goingIn);
  else if (goingIn) chosen = [...options].map((o) => option(total, o.risers, kind, run, goingIn)).sort((x, y) => Number(y.passes) - Number(x.passes) || Number(y.fits) - Number(x.fits) || Math.abs(x.twoRG - comfortable(kind)) - Math.abs(y.twoRG - comfortable(kind)))[0];
  else chosen = options[0];
  if (!chosen) throw new CalcInputError("That rise is too small for a stair: it needs at least two risers.");
  const n = chosen.risers;
  const R = chosen.riser;
  const G = chosen.going;
  steps.push(`Total rise ${fmt(total)} ÷ ${d.riser[1]} (most a riser may be) = ${r1(total / d.riser[1])}, so at least ${minRisers} risers.`);
  steps.push(`${fmt(total)} ÷ ${n} risers = ${fmtR(R)} each.`);
  if (goingIn) steps.push(`Going: ${G}, as given.`);
  else steps.push(`Going: the one that puts 2R + G nearest ${comfortable(kind)} within the limits${run ? `, and fits ${n - 1} treads in ${fmt(run)}` : ""}: ${G}.`);
  steps.push(`2R + G = 2 × ${fmtR(R)} + ${G} = ${fmtR(chosen.twoRG)}.`);
  steps.push(`Treads: ${n - 1} (the top floor is the last step). Total going ${n - 1} × ${G} = ${fmt(chosen.totalGoing)}${run ? (chosen.fits ? `, inside the ${fmt(run)} available` : `, more than the ${fmt(run)} available`) : ""}.`);
  const hyp = Math.hypot(R, G);
  const pitch = Math.atan(R / G) / RAD;
  steps.push(`Pitch: atan(${fmtR(R)} ÷ ${G}) = ${deg(pitch)}.`);
  steps.push(`Each step along the stringer: √(${fmtR(R)}² + ${G}²) = ${r1(hyp)}. Pitch line, floor to floor: ${n} × ${r1(hyp)} = ${fmt(Math.round(n * hyp))}.`);
  steps.push(`Cuts: plumb cut (top) ${deg(90 - pitch)} to the stringer's edge; level cut (bottom) ${deg(pitch)} to the edge. Framing square: ${fmtR(R)} on the tongue, ${G} on the blade.`);
  const marks = Array.from({ length: n - 1 }, (_, k) => Math.round((k + 1) * hyp));
  steps.push(`Step-off marks along the pitch line from the bottom floor's nosing point: ${marks.map((m) => fmt(m)).join(", ")}.`);
  if (tread) steps.push(`Cut-out stringer sitting on the floor: take ${fmtR(tread)} (one tread's thickness) off the bottom so the first and last risers come out at ${fmtR(R)}.`);

  // 2. the code's limits
  checks.push({ what: "Risers in the flight", value: String(n), limit: `${S.risersPerFlight.min} to ${S.risersPerFlight.max}`, ok: n >= S.risersPerFlight.min && n <= S.risersPerFlight.max, source: src(S.risersPerFlight.clause) });
  checks.push({ what: "Riser", value: fmtR(R), limit: `${d.riser[0]} to ${d.riser[1]}`, ok: R >= d.riser[0] - 1e-9 && R <= d.riser[1] + 1e-9, source: src(d.clause) });
  checks.push({ what: "Going", value: String(G), limit: `${d.going[0]} to ${d.going[1]}`, ok: G >= d.going[0] && G <= d.going[1], source: src(d.clause) });
  checks.push({ what: "2R + G", value: fmtR(chosen.twoRG), limit: `${d.twoRG[0]} to ${d.twoRG[1]}`, ok: chosen.twoRG >= d.twoRG[0] - 1e-9 && chosen.twoRG <= d.twoRG[1] + 1e-9, source: src(d.clause) });
  if (kind !== "attic")
    checks.push({ what: "Risers and goings all equal", value: "0 variation as set out", limit: `${S.variation.adjacent} next to each other, ${S.variation.flight} over the flight`, ok: true, source: src(S.variation.clause) });
  if (n > S.risersPerFlight.max) {
    const a1 = Math.ceil(n / 2);
    warnings.push(`${n} risers is more than ${S.risersPerFlight.max} in one flight: it needs a landing (at least ${S.landing.length} long, ${S.landing.clause}), e.g. ${a1} risers then ${n - a1}.`);
  }
  if (a.open_risers) {
    if (tread === undefined) warnings.push(`Open risers: give the tread thickness and I'll check the gap between treads against the ${S.openRiserSphere.mm} mm sphere.`);
    else {
      const gap = R - tread;
      checks.push({ what: "Open riser gap", value: fmtR(gap), limit: `under ${S.openRiserSphere.mm} (sphere mustn't pass)`, ok: gap < S.openRiserSphere.mm, source: src(S.openRiserSphere.clause) });
      if (gap >= S.openRiserSphere.mm) warnings.push(`The gap between treads is ${fmtR(gap)}: a ${S.openRiserSphere.mm} mm sphere would pass. Add a riser bar or close it up.`);
    }
  }
  if (a.winders !== undefined) {
    const max = a.turn === "half" ? S.winders.half : S.winders.quarter;
    checks.push({ what: `Winders in place of a ${a.turn === "half" ? "half" : "quarter"} landing`, value: String(a.winders), limit: `${max} at most`, ok: a.winders <= max, source: src(S.winders.clause) });
    const at = width === undefined ? "at the middle of the width (1 m or narrower), or 400 in from each side (wider)" : width <= S.taperedGoing.narrowMax ? `at the middle of the width (${fmt(width / 2)} in)` : `${S.taperedGoing.inFromSide} in from each side`;
    steps.push(`Winders: their going is measured ${at}, and must be the same for every winder (${S.taperedGoing.clause}, ${S.winders.clause}).`);
  }
  if (a.door_at_top && (n > S.thresholdLanding.risers || total > S.thresholdLanding.mm))
    warnings.push(`A doorway opening onto the top of a stair that rises more than ${S.thresholdLanding.risers} risers or ${S.thresholdLanding.mm} mm needs a landing at the door, at least ${S.landing.length} long and the door's width (${S.thresholdLanding.clause}, ${S.landing.clause}).`);

  // 3. headroom
  const soffit = a.ceiling_mm !== undefined ? need(a.ceiling_mm, "ceiling_mm", "the ceiling height") : a.upper_floor_depth_mm !== undefined ? total - need(a.upper_floor_depth_mm, "upper_floor_depth_mm", "the floor depth") : undefined;
  let openingFrom: number | undefined;
  if (soffit !== undefined) {
    // nosing line: y = R + x·R/G (x from the bottom riser's face); headroom line 2,000 above it meets the soffit at x
    const x = ((soffit - NCC_HEADROOM.mm - R) * G) / R;
    openingFrom = Math.max(0, x);
    const length = chosen.totalGoing - openingFrom;
    steps.push(
      `Headroom: ${fmt(NCC_HEADROOM.mm)} above the nosing line. The line ${fmt(NCC_HEADROOM.mm)} up reaches the ceiling (${fmt(soffit)} above the lower floor) ${x <= 0 ? "before the first nosing" : `${fmt(Math.round(x))} along from the bottom riser`}, so the opening above must run back at least ${fmt(Math.ceil(length))} from the top riser (measured level).`,
    );
    checks.push({ what: "Headroom", value: `opening ${fmt(Math.ceil(length))} long from the top riser`, limit: `${fmt(NCC_HEADROOM.mm)} above the nosing line`, ok: true, source: src(NCC_HEADROOM.clause) });
  }

  // 4. barriers and handrails
  const fallFrom = Math.ceil(B.requiredFall.mm / R - 1e-9); // the first tread 1 m or more above the floor below
  if (total >= B.handrail.notNeededUnder)
    steps.push(`Handrail: on at least one side, the full length of the flight, its top at least ${B.handrail.height} above the nosings (${B.handrail.clause}).`);
  if (a.open_side || total >= B.requiredFall.mm) {
    if (fallFrom < n)
      steps.push(
        `Barrier on any open side from tread ${fallFrom} up (${fmt(fallFrom * R)} above the floor, where a fall is ${fmt(B.requiredFall.mm)} or more, ${B.requiredFall.clause}): at least ${B.height.stair} above the nosings, ${fmt(B.height.floor)} at the top floor or a landing, no opening a ${B.sphere.mm} mm sphere could pass (${B.height.clause}, ${B.sphere.clause}).`,
      );
    if (a.baluster_mm !== undefined) {
      const b = need(a.baluster_mm, "baluster_mm", "the baluster width");
      const gapMax = opt(a.max_gap_mm, "max_gap_mm") ?? 120;
      const per = Math.ceil(G / (gapMax + b) - 1e-9);
      const gap = G / per - b;
      steps.push(`Balusters: ${per} a tread at ${r1(G / per)} centres leaves a ${r1(gap)} gap (aiming at ${gapMax} or less; the test is a ${B.sphere.mm} mm sphere).`);
      checks.push({ what: "Baluster gap", value: r1(gap).toString(), limit: `under ${B.sphere.mm}`, ok: gap < B.sphere.mm, source: src(B.sphere.clause) });
    }
  }
  const note = editionNote(edition, now);
  if (note) warnings.push(note);
  warnings.push("Stringer and tread sizes, and fixing, aren't worked out here: those come from the span tables, the maker or an engineer.");

  const passes = checks.every((c) => c.ok) && n <= S.risersPerFlight.max;
  const others = options.filter((o) => o.risers !== n && o.passes && o.fits).slice(0, 3);
  if (others.length) steps.push(`Other workable stairs: ${others.map((o) => `${o.risers} risers at ${fmtR(o.riser)}, going ${o.going} (2R + G ${fmtR(o.twoRG)})`).join("; ")}.`);
  if (run && !options.some((o) => o.passes && o.fits)) {
    const shortest = options.filter((o) => o.passes || o.goingRange[0] <= o.goingRange[1]).map((o) => (o.risers - 1) * Math.ceil(o.goingRange[0]));
    const least = shortest.length ? Math.min(...shortest) : undefined;
    warnings.push(`No stair within the limits fits in ${fmt(run)}${least ? `: the shortest that passes needs about ${fmt(least)}` : ""}.`);
  }

  const say = `${n} risers at ${Math.round(R)}, going ${G}. ${passes && (chosen.fits || !run) ? "That passes." : "That doesn't pass: see the checks."}`;
  return {
    title: `Stair: ${fmt(total)} rise`,
    say,
    answer: { risers: n, riser_mm: Math.round(R * 10) / 10, going_mm: G, treads: n - 1, two_r_plus_g_mm: Math.round(chosen.twoRG * 10) / 10, total_going_mm: chosen.totalGoing, pitch_deg: r1(pitch), stringer_pitch_line_mm: Math.round(n * hyp), passes, fits_run: run === undefined ? null : chosen.fits, opening_from_top_riser_mm: openingFrom === undefined ? null : Math.ceil(chosen.totalGoing - openingFrom) },
    steps,
    checks,
    warnings,
    sources: [`${NCC_PAGES.stairs} (Part 11.2)`, `${NCC_PAGES.barriers} (Part 11.3)`, ...(soffit !== undefined ? [`${NCC_PAGES.heights} (10.3.1)`] : []), `NCC 2022 as in force in NSW (Amendment 2); read ${"14 Nov 2026"}. ${NCC_ATTRIBUTION}`],
    table: workingTable(steps, checks),
    sketch: stairSketch(total, n, R, G, soffit, openingFrom, chosen.twoRG, d.clause),
  };
}

function stairSketch(total: number, n: number, R: number, G: number, soffit: number | undefined, openingFrom: number | undefined, twoRG: number, clause: string) {
  const r = (v: number) => Math.round(v * 10) / 10;
  const pts: [number, number][] = [[0, 0]];
  for (let k = 1; k <= n; k++) {
    pts.push([r((k - 1) * G), r(k * R)]);
    if (k < n) pts.push([r(k * G), r(k * R)]);
  }
  const topX = (n - 1) * G;
  const mid = Math.max(1, Math.round(n / 2));
  const shapes: SketchShape[] = [
    { type: "line", a: [-500, 0], b: [0, 0], weight: 2 },
    { type: "line", a: [r(topX), r(total)], b: [r(topX + 700), r(total)], weight: 2 },
    { type: "poly", points: pts, fill: "none" },
    { type: "line", a: [r(-G), 0], b: [r(topX), r(total)], style: "dashed" },
    { type: "dim", a: [0, 0], b: [0, r(total)], offset: 350, text: `${fmt(total)} total rise` },
    { type: "dim", a: [0, 0], b: [r(topX), 0], offset: -280, text: `${fmt(n - 1)} × ${G} = ${fmt(topX)}` },
    { type: "dim", a: [r(topX - G), r(total - R)], b: [r(topX), r(total - R)], offset: 240, text: String(G) },
    { type: "dim", a: [r(topX), r(total - R)], b: [r(topX), r(total)], offset: -240, text: fmtR(R) },
    { type: "angle", at: [r(-G), 0], from_deg: 0, to_deg: r1(Math.atan(R / G) / RAD) },
    { type: "label", at: [r(topX * 0.6 + 300), r(total * 0.22)], text: `${n} risers @ ${fmtR(R)}, ${n - 1} goings @ ${G}`.slice(0, 60), leader: [r((mid - 1) * G + G / 2), r(mid * R)] },
  ];
  if (soffit !== undefined) {
    const from = openingFrom ?? 0;
    // the headroom line, 2,000 above the nosing line, and the ceiling stopping at the opening
    shapes.push({ type: "line", a: [0, r(R + NCC_HEADROOM.mm)], b: [r(topX), r(total + NCC_HEADROOM.mm)], style: "dashed" });
    shapes.push({ type: "label", at: [r(topX * 0.2 - 400), r(R + NCC_HEADROOM.mm + topX * 0.2 * (R / G) + 350)], text: `${fmt(NCC_HEADROOM.mm)} headroom line`, leader: [r(topX * 0.2), r(R + NCC_HEADROOM.mm + topX * 0.2 * (R / G))] });
    shapes.push({ type: "line", a: [-500, r(soffit)], b: [r(from), r(soffit)], weight: 3 });
    shapes.push({ type: "dim", a: [r(from), r(soffit)], b: [r(topX), r(soffit)], offset: 300, text: `opening ${fmt(Math.ceil(topX - from))}` });
  }
  return { title: `Stair, ${fmt(total)} rise`, shapes, note: `2R + G = ${fmtR(twoRG)}. Checked to NCC 2022 ${clause}.` };
}

export type BarrierIn = {
  /** How far it is to fall: from the floor (deck, landing, stair tread) to the surface beneath. */
  fall_mm: number;
  where?: "stair" | "floor" | "landing";
  /** The clear run between posts, to space balusters in. */
  run_mm?: number;
  baluster_mm?: number;
  max_gap_mm?: number;
  /** A landing's barrier along its inside edge: its length. */
  landing_edge_mm?: number;
  attic?: boolean;
};

/** Is a barrier needed, how high, the sphere, the climbing zone, and an even baluster spacing for a run. */
export function barrierCalc(a: BarrierIn, edition: CodeEdition = CODE_EDITION_DEFAULT, now = new Date()): CalcResult {
  const fall = need(a.fall_mm, "fall_mm", "how far it is to fall (from the floor to the ground or floor below)");
  const where = a.where ?? "floor";
  const src = (clause: string) => nccSource(clause);
  const steps: string[] = [];
  const checks: Check[] = [];
  const warnings: string[] = [];
  const needed = fall >= B.requiredFall.mm;
  steps.push(`Fall ${fmt(fall)}: ${needed ? `${fmt(B.requiredFall.mm)} or more, so a barrier is needed` : `under ${fmt(B.requiredFall.mm)}, so the code doesn't call for a barrier`} (${B.requiredFall.clause}).`);
  let height: number | null = null;
  if (needed) {
    height = where === "stair" ? B.height.stair : where === "landing" && a.landing_edge_mm !== undefined && a.landing_edge_mm <= B.height.landingInsideEdgeMaxLength ? B.height.landingInsideEdge : B.height.floor;
    steps.push(`Height: at least ${fmt(height)} ${where === "stair" ? "above the nosings" : "above the floor"} (${B.height.clause}).`);
    steps.push(a.attic ? `Openings: an attic stair's barrier may let a ${B.attic.sphere} mm sphere through, or have rails no more than ${B.attic.railGap} apart (${B.attic.clause}).` : `Openings: nothing a ${B.sphere.mm} mm sphere could pass through (${B.sphere.clause}); fixed to the edge face, no more than ${B.edgeGap.mm} from the edge (${B.edgeGap.clause}).`);
    if (fall > B.climb.fallOver) steps.push(`The fall is over ${fmt(B.climb.fallOver)}: nothing between ${B.climb.from} and ${B.climb.to} above the floor that helps climbing, so no horizontal rails or wires in that band (${B.climb.clause}).`);
    else steps.push(`The fall isn't over ${fmt(B.climb.fallOver)}, so the no-climbing band (${B.climb.from} to ${B.climb.to}) doesn't apply (${B.climb.clause}).`);
    if (where === "stair") steps.push(`Handrail: at least one side, full length, top at least ${B.handrail.height} above the nosings (${B.handrail.clause}).`);
  }
  let balusters: number | null = null;
  let gap: number | null = null;
  if (a.run_mm !== undefined || a.baluster_mm !== undefined) {
    const run = need(a.run_mm, "run_mm", "the clear run between the posts");
    const b = need(a.baluster_mm, "baluster_mm", "the baluster width");
    const gapMax = opt(a.max_gap_mm, "max_gap_mm") ?? 120;
    // N balusters make N + 1 equal gaps: (run − N·b) ÷ (N + 1) ≤ gap  ⇒  N ≥ (run − gap) ÷ (b + gap)
    balusters = Math.max(0, Math.ceil((run - gapMax) / (b + gapMax) - 1e-9));
    gap = (run - balusters * b) / (balusters + 1);
    steps.push(`Balusters: (${fmt(run)} − ${gapMax}) ÷ (${b} + ${gapMax}) = ${r1((run - gapMax) / (b + gapMax))}, so ${balusters}. Gaps: (${fmt(run)} − ${balusters} × ${b}) ÷ ${balusters + 1} = ${r1(gap)}, at ${r1(gap + b)} centres; the first centre ${r1(gap + b / 2)} from the post.`);
    checks.push({ what: "Gap between balusters", value: r1(gap).toString(), limit: `under ${B.sphere.mm} (aiming at ${gapMax})`, ok: gap < B.sphere.mm, source: src(B.sphere.clause) });
  }
  if (height !== null) checks.push({ what: "Barrier height", value: `${fmt(height)} at least`, limit: where === "stair" ? "above the nosings" : "above the floor", ok: true, source: src(B.height.clause) });
  const note = editionNote(edition, now);
  if (note) warnings.push(note);
  warnings.push("How strong the barrier must be (posts, fixings, glass) isn't worked out here: the code sends that to AS/NZS 1170.1 and the glass rules; ask an engineer or the maker.");
  return {
    title: `Barrier: ${fmt(fall)} fall`,
    say: needed ? `A barrier's needed: ${fmt(height!)} high${balusters !== null ? `, ${balusters} balusters with ${Math.round(gap!)} gaps` : ""}.` : "No barrier needed by the code for that fall.",
    answer: { needed, height_mm: height, balusters, gap_mm: gap === null ? null : r1(gap), no_climb_zone: needed && fall > B.climb.fallOver },
    steps,
    checks,
    warnings,
    sources: [`${NCC_PAGES.barriers} (Part 11.3)`, `NCC 2022 as in force in NSW (Amendment 2); read 14 Nov 2026. ${NCC_ATTRIBUTION}`],
    table: workingTable(steps, checks),
    sketch: balusters !== null && gap !== null ? balusterSketch(a.run_mm!, a.baluster_mm!, balusters, gap, height ?? B.height.floor) : undefined,
  };
}

function balusterSketch(run: number, b: number, count: number, gap: number, height: number) {
  const r = (v: number) => Math.round(v * 10) / 10;
  const shapes: SketchShape[] = [
    { type: "rect", x: -90, y: 0, w: 90, h: height + 100, fill: "timber" },
    { type: "rect", x: r(run), y: 0, w: 90, h: height + 100, fill: "timber" },
    { type: "rect", x: 0, y: r(height - 65), w: r(run), h: 65, fill: "timber" },
    { type: "rect", x: 0, y: 60, w: r(run), h: 45, fill: "timber" },
  ];
  const show = Math.min(count, 40);
  for (let i = 0; i < show; i++) shapes.push({ type: "rect", x: r(gap + i * (gap + b)), y: 105, w: b, h: r(height - 170), fill: "none" });
  shapes.push({ type: "dim", a: [0, 0], b: [r(run), 0], offset: -200, text: `${fmt(run)} clear` });
  if (count) shapes.push({ type: "dim", a: [0, r(height / 2)], b: [r(gap), r(height / 2)], offset: 0, text: String(Math.round(gap)) });
  shapes.push({ type: "dim", a: [r(run + 90), 0], b: [r(run + 90), r(height)], offset: 200, text: `${fmt(height)} min` });
  return { title: `Balusters, ${fmt(run)} run`, shapes, note: `${count} balusters ${b} wide, gaps ${r1(gap)}. Openings must stop a 125 mm sphere (NCC 2022 11.3.4(4)).` };
}
