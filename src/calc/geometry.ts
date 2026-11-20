// Worked figures for building things (Stage 8.3): roof geometry, setting out members along a length, and stairs.
// Pure functions, millimetres and degrees. Each result says what it assumed, so nobody reads more into it than it is.
import { CalcError, tidy } from "./expr.js";
import { NCC_EDITION, NCC_STAIRS } from "../shared/calc/ncc.js";

const RAD = Math.PI / 180;
const pos = (v: number | undefined, name: string) => {
  if (v === undefined) return undefined;
  if (!Number.isFinite(v) || v <= 0) throw new CalcError(`${name} needs to be a number above zero.`);
  return v;
};

/* ---------------- roof geometry ---------------- */

export type RoofIn = { run_mm?: number; span_mm?: number; pitch_deg?: number; rise_mm?: number; overhang_mm?: number; rafter_depth_mm?: number; hip?: boolean };

export function roofGeometry(a: RoofIn) {
  // run: horizontal distance from the ridge centre line to the outside of the wall plate; half the span for a gable roof
  const run = pos(a.run_mm, "run_mm") ?? (pos(a.span_mm, "span_mm") !== undefined ? a.span_mm! / 2 : undefined);
  if (run === undefined) throw new CalcError("Give the run (ridge centre to outside of the wall plate) or the span (wall to wall, outside of plates).");
  let pitch: number;
  let rise: number;
  if (a.pitch_deg !== undefined) {
    if (!(a.pitch_deg > 0 && a.pitch_deg < 90)) throw new CalcError("pitch_deg needs to be between 0 and 90 degrees.");
    pitch = a.pitch_deg;
    rise = run * Math.tan(pitch * RAD); // rise = run × tan(pitch)
  } else if (a.rise_mm !== undefined) {
    rise = pos(a.rise_mm, "rise_mm")!;
    pitch = Math.atan(rise / run) / RAD; // pitch = atan(rise ÷ run)
  } else throw new CalcError("Give the pitch in degrees or the rise.");
  const overhang = a.overhang_mm === undefined ? 0 : a.overhang_mm >= 0 && Number.isFinite(a.overhang_mm) ? a.overhang_mm : NaN;
  if (Number.isNaN(overhang)) throw new CalcError("overhang_mm needs to be zero or more (measured level, out from the wall plate).");
  const cos = Math.cos(pitch * RAD);
  const rafter = run / cos; // along the slope: run ÷ cos(pitch), the same as √(run² + rise²)
  const rafterWithOverhang = (run + overhang) / cos; // the level overhang adds overhang ÷ cos(pitch) along the slope
  const out: Record<string, unknown> = {
    run_mm: tidy(run),
    rise_mm: tidy(rise),
    pitch_deg: tidy(pitch),
    rise_per_metre_of_run_mm: tidy(Math.tan(pitch * RAD) * 1000), // tan(pitch) × 1000
    rafter_length_mm: tidy(rafter),
    ...(overhang ? { overhang_mm: tidy(overhang), rafter_length_with_overhang_mm: tidy(rafterWithOverhang) } : {}),
    // The plumb cut is vertical and the seat cut level; measured against the rafter's edge they sit at these angles.
    plumb_cut: `vertical: ${tidy(90 - pitch)}° to the rafter's edge (set the bevel to ${tidy(pitch)}° off square)`,
    seat_cut: `level: ${tidy(pitch)}° to the rafter's edge`,
  };
  const depth = pos(a.rafter_depth_mm, "rafter_depth_mm");
  if (depth) out.plumb_depth_mm = tidy(depth / cos); // the rafter's depth measured plumb: depth ÷ cos(pitch)
  if (a.hip) {
    // Equal-pitch roof with a square (90°) corner: the hip runs on the diagonal, so its run is run × √2.
    const hipRun = run * Math.SQRT2;
    const hipPitch = Math.atan(rise / hipRun) / RAD; // hip pitch = atan(rise ÷ (run × √2))
    out.hip = {
      hip_run_mm: tidy(hipRun),
      hip_length_mm: tidy(Math.hypot(hipRun, rise)), // √(hip run² + rise²)
      ...(overhang ? { hip_length_with_overhang_mm: tidy(Math.hypot((run + overhang) * Math.SQRT2, (run + overhang) * Math.tan(pitch * RAD))) } : {}),
      hip_pitch_deg: tidy(hipPitch),
      note: "The same lengths do for a valley on an equal-pitch roof with a square corner.",
    };
  }
  out.assumptions = [
    "Measured to centre lines: from the ridge centre line to the outside of the wall plate.",
    "No allowance for the ridge board's or the plate's thickness (take half the ridge thickness off the run yourself if you need it).",
    ...(overhang ? ["The overhang is measured level, out from the outside of the wall plate."] : []),
    ...(a.hip ? ["Hip or valley: equal pitches both sides and a square corner."] : []),
  ];
  return out;
}

/* ---------------- set-out ---------------- */

export type SetOutIn = { length_mm: number; max_spacing_mm: number; member_mm?: number; ends?: "both" | "none" };

/**
 * How many members fit along a length without going over a maximum spacing (centre to centre), and the actual spacing.
 * ends "both": a member at each end (studs in a wall, joists along a floor). "none": the ends are already there (posts),
 * so only the ones between are counted.
 */
export function setOut(a: SetOutIn) {
  const length = pos(a.length_mm, "length_mm")!;
  const max = pos(a.max_spacing_mm, "max_spacing_mm")!;
  const member = a.member_mm === undefined ? 0 : pos(a.member_mm, "member_mm")!;
  const ends = a.ends ?? "both";
  // With the members' thickness given, the end members' centres sit half a member in from each end.
  const between = length - (ends === "both" ? member : 0);
  if (between <= 0) throw new CalcError("The length is shorter than the member.");
  const spaces = Math.ceil(between / max - 1e-9); // fewest spaces that keep every space at or under the maximum
  const members = ends === "both" ? spaces + 1 : spaces - 1;
  const spacing = between / spaces;
  return {
    members,
    spaces,
    spacing_mm: tidy(spacing),
    spacing_exact_mm: spacing,
    ...(member ? { clear_gap_mm: tidy(spacing - member) } : {}),
    assumptions: [
      ends === "both" ? "A member at each end; spacing is centre to centre." : "The ends are already there (posts or walls); these are the members between them, centre to centre from the end centres.",
      ...(member ? [`Members ${member} mm thick${ends === "both" ? ", so the end centres sit half that in from each end" : ""}.`] : ["No member thickness given, so measured from end to end."]),
    ],
  };
}

/* ---------------- stairs ---------------- */

/**
 * The limits a stair is checked against: NCC 2022 Housing Provisions Table 11.2.2a (stairs other than spiral), read from
 * the ABCB's site with its address in src/shared/calc/ncc.ts (Stage 14.2), the one place the code's figures live.
 */
const STD = NCC_STAIRS.dims.standard;
export const STAIR_LIMITS = {
  source: `${NCC_EDITION} Housing Provisions ${STD.clause}, stairway construction (riser and going dimensions)`,
  edition: NCC_EDITION,
  riser: { min: STD.riser[0], max: STD.riser[1] },
  going: { min: STD.going[0], max: STD.going[1] },
  twoRPlusG: { min: STD.twoRG[0], max: STD.twoRG[1] },
} as const;

export type StairsIn = { total_rise_mm: number; going_mm?: number; max_riser_mm?: number; min_going_mm?: number };

export function stairs(a: StairsIn) {
  const total = pos(a.total_rise_mm, "total_rise_mm")!;
  const maxR = Math.min(pos(a.max_riser_mm, "max_riser_mm") ?? STAIR_LIMITS.riser.max, STAIR_LIMITS.riser.max);
  const risers = Math.ceil(total / maxR - 1e-9); // fewest risers that keep each one at or under the maximum
  const riser = total / risers;
  // Going: the one given, or the one that puts 2R + G nearest the middle of its range, within the going limits.
  const minG = Math.max(pos(a.min_going_mm, "min_going_mm") ?? STAIR_LIMITS.going.min, STAIR_LIMITS.going.min);
  const going = pos(a.going_mm, "going_mm") ?? Math.min(STAIR_LIMITS.going.max, Math.max(minG, Math.round((STAIR_LIMITS.twoRPlusG.min + STAIR_LIMITS.twoRPlusG.max) / 2 - 2 * riser)));
  const twoRG = 2 * riser + going;
  const treads = risers - 1; // the top landing or floor is the last step up
  const checks = [
    { what: "riser", value: tidy(riser), ok: riser >= STAIR_LIMITS.riser.min && riser <= STAIR_LIMITS.riser.max, limits: `${STAIR_LIMITS.riser.min} to ${STAIR_LIMITS.riser.max}` },
    { what: "going", value: tidy(going), ok: going >= STAIR_LIMITS.going.min && going <= STAIR_LIMITS.going.max, limits: `${STAIR_LIMITS.going.min} to ${STAIR_LIMITS.going.max}` },
    { what: "2R + G", value: tidy(twoRG), ok: twoRG >= STAIR_LIMITS.twoRPlusG.min && twoRG <= STAIR_LIMITS.twoRPlusG.max, limits: `${STAIR_LIMITS.twoRPlusG.min} to ${STAIR_LIMITS.twoRPlusG.max}` },
  ];
  return {
    risers,
    riser_mm: tidy(riser),
    riser_exact_mm: riser,
    treads,
    going_mm: tidy(going),
    going_chosen: a.going_mm === undefined,
    two_r_plus_g_mm: tidy(twoRG),
    total_going_mm: tidy(treads * going),
    within_limits: checks.every((c) => c.ok),
    checks,
    limits_from: `${STAIR_LIMITS.source}. Those are the limits as at ${STAIR_LIMITS.edition}; the code in force when it's built decides, so check the current edition.`,
    assumptions: ["All risers equal, all goings equal.", `Treads: one fewer than risers (the top floor or landing is the last step).`, "Doesn't cover handrails, balustrades, headroom, landings, or open risers."],
  };
}
