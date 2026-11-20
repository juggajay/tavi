// Roof framing geometry (Stage 14.2): common, hip, valley and jack (creeper) rafters, equal pitch and unequal pitch.
// Lengths to the birdsmouth and overall with the eave, plumb, level, edge and backing angles, the birdsmouth seat and
// depth, hip drop, creeper length steps at a spacing, and the ridge and wall-plate set-out. Pure geometry: member sizes
// are not chosen here (that's the span tables, the maker's guide or an engineer).
//
// Lines: every length is along the rafter's set-out line, from the ridge's (or hip's) centre line in plan to the outside
// of the wall plate, measured along the slope; the eave adds the overhang measured level. Deductions for the ridge's and
// hip's thickness are given separately, so nothing is taken off without saying.
//
// The hip and valley angles come from one piece of vector geometry (two roof planes meeting), so equal and unequal
// pitches use the same code; for equal pitches it gives the textbook results (tests/unit/trade-calc.test.ts):
//   hip pitch:          tan = tan(pitch) ÷ √2
//   creeper edge cut:   tan = cos(pitch), measured from the rafter's side
//   hip edge cut:       tan = cos(hip pitch), from the hip's side
//   hip backing:        tan = sin(hip pitch)
//   hip drop:           half the hip's thickness × tan(pitch) ÷ √2
import type { SketchShape } from "../protocol.js";
import { CalcInputError, deg, fmt, mm, need, opt, r1, RAD, workingTable, type CalcResult } from "./result.js";

type V = [number, number, number];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => {
  const l = len(a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

const pitchIn = (pitch: number | undefined, name: string) => {
  if (pitch === undefined) return undefined;
  if (!Number.isFinite(pitch) || pitch <= 0 || pitch >= 75) throw new CalcInputError(`${name} needs to be a pitch between 0 and 75 degrees.`);
  return pitch;
};

/**
 * Two roof planes meeting at a hip (or, the same geometry, a valley). Plane 1 rises at p1 across its rafters (they run
 * in +y, its eave on the x axis); plane 2 rises at p2 (rafters in +x, eave on the y axis). They meet on a line from the
 * corner to the height `rise`. All the roof cutting angles come from this.
 */
export function planesMeet(p1: number, p2: number, rise: number) {
  const t1 = Math.tan(p1 * RAD);
  const t2 = Math.tan(p2 * RAD);
  const run1 = rise / t1; // plane 1's rafter run to that height
  const run2 = rise / t2;
  const planRun = Math.hypot(run1, run2); // the hip's run in plan: from the corner to (run2, run1)
  const hx = run2 / planRun;
  const hy = run1 / planRun;
  const pitch = Math.atan(rise / planRun) / RAD;
  const cosH = Math.cos(pitch * RAD);
  const H: V = [hx * cosH, hy * cosH, Math.sin(pitch * RAD)]; // along the hip
  const across: V = [-hy, hx, 0]; // level, square across the hip's top
  const z: V = [0, 0, 1];
  const up = unit([z[0] - dot(z, H) * H[0], z[1] - dot(z, H) * H[1], z[2] - dot(z, H) * H[2]]);
  // backing: in the section square to the hip, the angle each roof plane makes with the level line across its top
  const backing = (n: V) => {
    const v = cross(H, n);
    return Math.atan(Math.abs(dot(v, up)) / Math.abs(dot(v, across))) / RAD;
  };
  const c1 = Math.cos(p1 * RAD);
  const c2 = Math.cos(p2 * RAD);
  return {
    run1,
    run2,
    planRun,
    length: Math.hypot(planRun, rise),
    pitch,
    /** the hip in plan, as an angle from plane 1's eave */
    planAngle: Math.atan2(hy, hx) / RAD,
    // A creeper's edge cut: the vertical face of the hip met on the creeper's sloping top edge. tan(off square) = a ÷ b
    // where the cut line is a·(along the rafter) + b·(square across); see the derivation in the notes.
    creeperOffSquare1: Math.atan(hy / (hx * c1)) / RAD,
    creeperOffSquare2: Math.atan(hx / (hy * c2)) / RAD,
    // the hip's own edge cuts at the top, against the ridge's side (plane 1's side) and the crown end rafter (plane 2's)
    hipOffSquareRidge: Math.atan(hx / (hy * cosH)) / RAD,
    hipOffSquareCrown: Math.atan(hy / (hx * cosH)) / RAD,
    backing1: backing([0, -t1, 1]),
    backing2: backing([-t2, 0, 1]),
    /** hip drop for each side, per mm of half the hip's thickness */
    dropPer1: t1 * hx,
    dropPer2: t2 * hy,
    /** creeper length along the slope per mm along the plate: plane 1's creepers step along x, plane 2's along y */
    stepPer1: hy / hx / c1,
    stepPer2: hx / hy / c2,
    /** half the hip's thickness, measured level along a creeper (per mm of half thickness) */
    halfHipAlong1: 1 / hx,
    halfHipAlong2: 1 / hy,
  };
}

export type RoofIn = {
  kind: "common" | "hip" | "valley";
  /** common or hip: wall to wall, outside of the plates, across the rafters. */
  span_mm?: number;
  /** common: or the run, ridge centre to the outside of the plate. */
  run_mm?: number;
  /** hip: the building's length (along the ridge), outside of the plates. */
  length_mm?: number;
  pitch_deg?: number;
  rise_mm?: number;
  /** hip: the ends' pitch, when different (unequal pitch). */
  end_pitch_deg?: number;
  /** valley: the wing's span and pitch; the main roof is span_mm/pitch_deg. */
  wing_span_mm?: number;
  wing_pitch_deg?: number;
  overhang_mm?: number;
  spacing_mm?: number;
  rafter_depth_mm?: number;
  /** the birdsmouth's seat: usually the wall plate's width */
  seat_mm?: number;
  ridge_thickness_mm?: number;
  hip_thickness_mm?: number;
};

const ASSUME = "Lengths are along the set-out line, from the ridge's or hip's centre line (in plan) to the outside of the wall plate; the eave adds the overhang measured level.";

/** A common rafter: lengths, cuts, the birdsmouth, the ridge deduction. Shared by all three kinds. */
function common(run: number, pitch: number, a: RoofIn, label: string) {
  const c = Math.cos(pitch * RAD);
  const rise = run * Math.tan(pitch * RAD);
  const o = opt(a.overhang_mm, "overhang_mm", true) ?? 0;
  const steps: string[] = [];
  const L = run / c;
  steps.push(`${label}: run ${fmt(mm(run))} at ${deg(pitch)}: rise ${fmt(mm(rise))} (run × tan pitch); length ${fmt(mm(L))} (run ÷ cos pitch).`);
  if (o) steps.push(`With the ${fmt(o)} eave (level): ${fmt(mm((run + o) / c))} overall.`);
  steps.push(`Cuts: plumb ${deg(90 - pitch)} to the rafter's edge (bevel ${deg(pitch)} off square); seat (level) ${deg(pitch)} to the edge.`);
  const ridge = opt(a.ridge_thickness_mm, "ridge_thickness_mm");
  if (ridge) steps.push(`Ridge ${ridge} thick: take ${r1(ridge / 2 / c)} off the length at the top (half the ridge, level, ÷ cos pitch).`);
  const D = opt(a.rafter_depth_mm, "rafter_depth_mm");
  const seat = opt(a.seat_mm, "seat_mm");
  let bird: { seat: number; plumb: number; square: number; hap: number; frac: number } | null = null;
  if (D) {
    const s = seat ?? 0;
    const plumbDepth = D / c;
    if (s) {
      bird = { seat: s, plumb: s * Math.tan(pitch * RAD), square: s * Math.sin(pitch * RAD), hap: plumbDepth - s * Math.tan(pitch * RAD), frac: (s * Math.sin(pitch * RAD)) / D };
      steps.push(
        `Birdsmouth on a ${s} seat: plumb cut ${r1(bird.plumb)} high (seat × tan pitch), ${r1(bird.square)} deep square to the rafter (seat × sin pitch, ${Math.round(bird.frac * 100)}% of its ${D} depth); ${r1(bird.hap)} of rafter left above the plate, measured plumb (depth ÷ cos pitch − the plumb cut).`,
      );
    } else steps.push(`The ${D} rafter measures ${r1(plumbDepth)} plumb (depth ÷ cos pitch). Give the seat (the plate's width) for the birdsmouth.`);
  }
  return { rise, length: L, overall: (run + o) / c, steps, bird, o };
}

export function roofCalc(a: RoofIn): CalcResult {
  if (a.kind === "hip") return hipRoof(a);
  if (a.kind === "valley") return valley(a);
  if (a.kind !== "common") throw new CalcInputError('kind is "common", "hip" or "valley".');
  const run = opt(a.run_mm, "run_mm") ?? (a.span_mm !== undefined ? need(a.span_mm, "span_mm", "the span") / 2 : undefined);
  if (run === undefined) throw new CalcInputError("I need the span (wall to wall, outside of the plates) or the run.");
  const pitch = pitchIn(a.pitch_deg, "pitch_deg") ?? (a.rise_mm !== undefined ? Math.atan(need(a.rise_mm, "rise_mm", "the rise") / run) / RAD : undefined);
  if (pitch === undefined) throw new CalcInputError("I need the pitch (or the rise).");
  const cm = common(run, pitch, a, "Common rafter");
  const steps = [...cm.steps];
  const warnings = [ASSUME, "Member sizes, spacing limits and tie-down aren't chosen here: the span tables, the maker's guide or an engineer."];
  if (cm.bird) warnings.push(`How deep a birdsmouth may be is set by the framing rules (AS 1684) or the maker; check ${Math.round(cm.bird.frac * 100)}% against them.`);
  let count: number | null = null;
  if (a.spacing_mm !== undefined && a.length_mm !== undefined) {
    const S = need(a.spacing_mm, "spacing_mm", "the spacing");
    const Lb = need(a.length_mm, "length_mm", "the building's length");
    const spaces = Math.ceil(Lb / S - 1e-9);
    count = spaces + 1;
    steps.push(`Along ${fmt(Lb)} at no more than ${S} centres: ${spaces} spaces, ${count} pairs, at ${r1(Lb / spaces)} centres.`);
  }
  return {
    title: `Common rafters: ${deg(pitch)}, run ${fmt(mm(run))}`,
    say: `Rafter ${speakMm(cm.length)} to the birdsmouth${cm.o ? `, ${speakMm(cm.overall)} with the eave` : ""}, plumb cut ${Math.round(pitch * 10) / 10} degrees.`,
    answer: { run_mm: mm(run), rise_mm: mm(cm.rise), pitch_deg: r1(pitch), rafter_mm: mm(cm.length), rafter_overall_mm: mm(cm.overall), plumb_cut_deg: r1(90 - pitch), birdsmouth_plumb_mm: cm.bird ? r1(cm.bird.plumb) : null, height_above_plate_mm: cm.bird ? r1(cm.bird.hap) : null, pairs: count },
    steps,
    checks: [],
    warnings,
    sources: ["Geometry only: lengths from the run and pitch (run ÷ cos pitch)."],
    table: workingTable(steps, []),
    sketch: rafterSketch(run, pitch, cm.o, a.rafter_depth_mm, cm.bird?.seat),
  };
}

const speakMm = (v: number) => `${(Math.round(v / 10) / 100).toFixed(2)} m`;

function hipRoof(a: RoofIn): CalcResult {
  const W = need(a.span_mm, "span_mm", "the width (span), outside of the plates");
  const Lb = need(a.length_mm, "length_mm", "the length, outside of the plates");
  const p1 = pitchIn(a.pitch_deg, "pitch_deg");
  if (p1 === undefined) throw new CalcInputError("I need the roof's pitch.");
  const p2 = pitchIn(a.end_pitch_deg, "end_pitch_deg") ?? p1;
  const run1 = W / 2;
  const rise = run1 * Math.tan(p1 * RAD);
  const m = planesMeet(p1, p2, rise);
  const run2 = m.run2;
  const ridge = Lb - 2 * run2;
  if (ridge < -1e-6) throw new CalcInputError(`At ${deg(p2)} the ends would each run ${fmt(mm(run2))}, more than half the ${fmt(Lb)} length. Use a steeper end pitch or check the sizes.`);
  const equal = Math.abs(p1 - p2) < 1e-9;
  const steps: string[] = [];
  const cm1 = common(run1, p1, a, equal ? "Commons" : "Commons, sides");
  steps.push(...cm1.steps);
  if (!equal) steps.push(...common(run2, p2, { ...a, rafter_depth_mm: undefined }, "Commons, ends").steps);
  steps.push(`Ridge: ${fmt(Lb)} − 2 × ${fmt(mm(run2))} = ${fmt(mm(ridge))} long, centre to centre where the hips meet it${ridge < 1 ? " (none: it's a pyramid)" : ""}, ${fmt(mm(rise))} above the plates.`);
  steps.push(`Wall plates: on the long sides, the ridge-end commons ${fmt(mm(run2))} in from each corner; on each end, the centring common in the middle (${fmt(mm(W / 2))} from the corners).`);
  // hips
  const o1 = opt(a.overhang_mm, "overhang_mm", true) ?? 0;
  const o2 = equal ? o1 : (o1 * Math.tan(p1 * RAD)) / Math.tan(p2 * RAD); // level fascias: the steeper side's eave is shorter
  const hipOver = Math.hypot(o1, o2) / Math.cos(m.pitch * RAD);
  steps.push(
    `Hip: plan run √(${fmt(mm(run1))}² + ${fmt(mm(run2))}²) = ${fmt(mm(m.planRun))}, pitch atan(${fmt(mm(rise))} ÷ ${fmt(mm(m.planRun))}) = ${deg(m.pitch)}, length ${fmt(mm(m.length))}${o1 ? `, ${fmt(mm(m.length + hipOver))} with the eave` : ""}.`,
  );
  if (!equal && o1) steps.push(`Unequal pitch: an ${fmt(mm(o1))} eave on the sides needs ${fmt(mm(o2))} on the ends to keep the fascias level.`);
  const sideCut = (off: number) => `${deg(off)} off square (${deg(90 - off)} to the side)`;
  steps.push(`Hip cuts: plumb ${deg(90 - m.pitch)} to its edge; seat ${deg(m.pitch)}; edge cuts at the top ${equal ? sideCut(m.hipOffSquareRidge) : `${sideCut(m.hipOffSquareRidge)} against the ridge, ${sideCut(m.hipOffSquareCrown)} against the crown end`}.`);
  steps.push(`Backing: ${equal ? deg(m.backing1) : `${deg(m.backing1)} on the side face, ${deg(m.backing2)} on the end face`} (or drop the hip instead).`);
  const th = opt(a.hip_thickness_mm, "hip_thickness_mm");
  if (th) steps.push(`Hip drop for a ${th} hip: ${equal ? r1((th / 2) * m.dropPer1) : `${r1((th / 2) * m.dropPer1)} (sides), ${r1((th / 2) * m.dropPer2)} (ends)`} (half its thickness × the slope across it).`);
  const rt = opt(a.ridge_thickness_mm, "ridge_thickness_mm");
  if (rt) steps.push(`Where the hip butts the ridge's side, take ${r1(rt / 2 / m.halfHipAlong1 === 0 ? 0 : (rt / 2) * (1 / (m.run1 / m.planRun)) / Math.cos(m.pitch * RAD))} off the hip (half the ridge, along the hip).`);
  // creepers
  const S = opt(a.spacing_mm, "spacing_mm");
  const creepers: { side: string; at: number; length: number }[] = [];
  if (S) {
    steps.push(`Creepers, sides: each one ${r1(S * m.stepPer1)} shorter than the last at ${S} centres; edge cut ${sideCut(m.creeperOffSquare1)}.`);
    for (let x = run2 - S; x > 1; x -= S) creepers.push({ side: "side", at: run2 - x, length: (x * (run1 / run2)) / Math.cos(p1 * RAD) });
    if (!equal) {
      steps.push(`Creepers, ends: each one ${r1(S * m.stepPer2)} shorter at ${S} centres; edge cut ${sideCut(m.creeperOffSquare2)}.`);
      for (let y = run1 - S; y > 1; y -= S) creepers.push({ side: "end", at: run1 - y, length: (y * (run2 / run1)) / Math.cos(p2 * RAD) });
    }
    if (th) steps.push(`Take ${r1((th / 2) * m.halfHipAlong1 / Math.cos(p1 * RAD))} off each side creeper for half the hip's thickness${equal ? "" : `, ${r1((th / 2) * m.halfHipAlong2 / Math.cos(p2 * RAD))} off each end creeper`}.`);
    steps.push(`Creeper lengths to the hip's centre line, from the ridge-end common towards the corner: ${creepers.filter((c) => c.side === "side").map((c) => fmt(mm(c.length))).join(", ")}${o1 ? ` (each plus ${fmt(mm(o1 / Math.cos(p1 * RAD)))} for the eave)` : ""}.`);
  } else if (!S) steps.push("Give the rafter spacing for the creepers' lengths.");
  const warnings = [ASSUME, "Member sizes, spacing limits and tie-down aren't chosen here: the span tables, the maker's guide or an engineer."];
  const table = workingTable(steps, []);
  if (creepers.length) {
    table.rows.push(["", "Creepers", "", ""]);
    for (const c of creepers) table.rows.push(["", `${c.side === "side" ? "Side" : "End"} creeper ${fmt(mm(c.at))} from the ridge-end common: ${fmt(mm(c.length))}`, "", ""]);
  }
  return {
    title: `Hip roof: ${fmt(W)} × ${fmt(Lb)}, ${equal ? deg(p1) : `${deg(p1)} / ${deg(p2)}`}`,
    say: `Commons ${speakMm(cm1.length)}, hips ${speakMm(m.length)} at ${r1(m.pitch)} degrees, ridge ${speakMm(Math.max(0, ridge))}.`,
    answer: {
      rise_mm: mm(rise),
      common_mm: mm(cm1.length),
      common_overall_mm: mm(cm1.overall),
      hip_mm: mm(m.length),
      hip_overall_mm: mm(m.length + hipOver),
      hip_pitch_deg: r1(m.pitch),
      hip_backing_deg: r1(m.backing1),
      hip_edge_cut_to_side_deg: r1(90 - m.hipOffSquareRidge),
      creeper_edge_cut_to_side_deg: r1(90 - m.creeperOffSquare1),
      creeper_step_mm: S ? r1(S * m.stepPer1) : null,
      hip_drop_mm: th ? r1((th / 2) * m.dropPer1) : null,
      ridge_mm: mm(Math.max(0, ridge)),
      end_overhang_mm: equal ? null : mm(o2),
    },
    steps,
    checks: [],
    warnings,
    sources: ["Geometry only: two roof planes meeting (see the formulas in the working)."],
    table,
    sketch: hipPlanSketch(W, Lb, run2, ridge, S, run1),
  };
}

function valley(a: RoofIn): CalcResult {
  const Wm = need(a.span_mm, "span_mm", "the main roof's span");
  const pm = pitchIn(a.pitch_deg, "pitch_deg");
  if (pm === undefined) throw new CalcInputError("I need the main roof's pitch.");
  const Ww = need(a.wing_span_mm, "wing_span_mm", "the wing's span (the part joining on)");
  const pw = pitchIn(a.wing_pitch_deg, "wing_pitch_deg") ?? pm;
  const wingRise = (Ww / 2) * Math.tan(pw * RAD);
  const mainRise = (Wm / 2) * Math.tan(pm * RAD);
  if (wingRise > mainRise + 1e-6) throw new CalcInputError(`The wing's ridge (${fmt(mm(wingRise))} up) would be above the main ridge (${fmt(mm(mainRise))}): that's not a simple valley.`);
  // the valley is plane geometry the same as a hip: main plane (1) and wing plane (2), up to the wing's ridge height
  const m = planesMeet(pm, pw, wingRise);
  const equal = Math.abs(pm - pw) < 1e-9;
  const steps: string[] = [];
  const o = opt(a.overhang_mm, "overhang_mm", true) ?? 0;
  steps.push(`Wing ridge ${fmt(mm(wingRise))} above the plates (half its span × tan pitch); main ridge ${fmt(mm(mainRise))}.`);
  steps.push(`Valley: plan run √(${fmt(mm(m.run1))}² + ${fmt(mm(m.run2))}²) = ${fmt(mm(m.planRun))}, pitch ${deg(m.pitch)}, length ${fmt(mm(m.length))} from the internal corner to the wing's ridge${o ? `, plus ${fmt(mm(Math.hypot(o, equal ? o : (o * Math.tan(pm * RAD)) / Math.tan(pw * RAD)) / Math.cos(m.pitch * RAD)))} for the eave` : ""}.`);
  steps.push(`Valley cuts: plumb ${deg(90 - m.pitch)} to its edge; seat ${deg(m.pitch)}; it sits ${equal ? deg(m.backing1) : `${deg(m.backing1)} / ${deg(m.backing2)}`} below level across its top (the backing angle, if it's backed).`);
  steps.push(`The wing's ridge runs into the main roof ${fmt(mm(m.run1))} up the main slope from the main wall's plate (in plan).`);
  const S = opt(a.spacing_mm, "spacing_mm");
  const jacks: string[] = [];
  if (S) {
    steps.push(`Jack rafters on the main roof: each ${r1(S * m.stepPer1)} longer than the one before, going away from the corner, at ${S} centres; edge cut ${deg(m.creeperOffSquare1)} off square.`);
    steps.push(`Jack rafters on the wing: each ${r1(S * m.stepPer2)} shorter going towards the main roof; edge cut ${deg(m.creeperOffSquare2)} off square.`);
    const fullMain = (Wm / 2) / Math.cos(pm * RAD);
    for (let x = S; x < m.run2 - 1; x += S) jacks.push(`main ${fmt(x)} from the corner: ${fmt(mm(fullMain - (x * (m.run1 / m.run2)) / Math.cos(pm * RAD)))}`);
  }
  if (jacks.length) steps.push(`Main roof jacks, valley to main ridge centre: ${jacks.join("; ")}.`);
  return {
    title: `Valley: ${fmt(Wm)} main, ${fmt(Ww)} wing`,
    say: `Valley ${speakMm(m.length)} at ${r1(m.pitch)} degrees${S ? `, jacks step ${Math.round(S * m.stepPer1)}` : ""}.`,
    answer: { valley_mm: mm(m.length), valley_pitch_deg: r1(m.pitch), wing_rise_mm: mm(wingRise), jack_step_mm: S ? r1(S * m.stepPer1) : null, backing_deg: r1(m.backing1) },
    steps,
    checks: [],
    warnings: [ASSUME, "Member sizes and valley boards or gutters aren't chosen here: the span tables, the roofing maker's guide or an engineer."],
    sources: ["Geometry only: two roof planes meeting."],
    table: workingTable(steps, []),
  };
}

function rafterSketch(run: number, pitch: number, o: number, depth: number | undefined, seat: number | undefined) {
  const r = (v: number) => Math.round(v * 10) / 10;
  const t = Math.tan(pitch * RAD);
  const D = (depth ?? 140) / Math.cos(pitch * RAD);
  const s = seat ?? 90;
  // rafter's underside meets the plate's inside top corner at x = s; the set-out line (top of the plate's outside) at x = 0
  const under = (x: number) => t * (x - s);
  const shapes: SketchShape[] = [
    { type: "rect", x: 0, y: -400, w: s, h: 365, fill: "timber" },
    { type: "rect", x: 0, y: -35, w: s, h: 35, fill: "timber" },
    { type: "poly", points: [[r(-o), r(under(-o))], [0, r(under(0))], [0, 0], [r(s), 0], [r(run), r(under(run))], [r(run), r(under(run) + D)], [r(-o), r(under(-o) + D)]], fill: "timber" },
    { type: "line", a: [r(run), r(under(run) - 200)], b: [r(run), r(under(run) + D + 200)], style: "dashed" },
    { type: "dim", a: [0, r(under(run) + D + 400)], b: [r(run), r(under(run) + D + 400)], offset: 0, text: `run ${fmt(mm(run))}` },
    { type: "angle", at: [r(s), 0], from_deg: 0, to_deg: r1(pitch), text: deg(pitch) },
  ];
  if (o) shapes.push({ type: "dim", a: [r(-o), r(under(-o))], b: [0, r(under(-o))], offset: -150, text: `${fmt(o)} eave` });
  if (seat) shapes.push({ type: "dim", a: [0, 0], b: [r(s), 0], offset: -80, text: String(s) });
  return { title: `Rafter, ${deg(pitch)}`, shapes, note: `Run ${fmt(mm(run))}, length ${fmt(mm(run / Math.cos(pitch * RAD)))} to the birdsmouth.` };
}

function hipPlanSketch(W: number, L: number, run2: number, ridge: number, S: number | undefined, run1: number) {
  const r = (v: number) => Math.round(v * 10) / 10;
  const shapes: SketchShape[] = [
    { type: "rect", x: 0, y: 0, w: r(L), h: r(W), fill: "none" },
    { type: "line", a: [r(run2), r(run1)], b: [r(run2 + Math.max(0, ridge)), r(run1)], weight: 3 },
    { type: "line", a: [0, 0], b: [r(run2), r(run1)], weight: 2 },
    { type: "line", a: [0, r(W)], b: [r(run2), r(run1)], weight: 2 },
    { type: "line", a: [r(L), 0], b: [r(L - run2), r(run1)], weight: 2 },
    { type: "line", a: [r(L), r(W)], b: [r(L - run2), r(run1)], weight: 2 },
    { type: "dim", a: [0, 0], b: [r(L), 0], offset: -400, text: fmt(L) },
    { type: "dim", a: [0, 0], b: [0, r(W)], offset: 400, text: fmt(W) },
    { type: "dim", a: [r(run2), r(run1)], b: [r(run2 + Math.max(0, ridge)), r(run1)], offset: 250, text: `ridge ${fmt(mm(Math.max(0, ridge)))}` },
    { type: "dim", a: [0, r(W)], b: [r(run2), r(W)], offset: 300, text: fmt(mm(run2)) },
  ];
  if (S) {
    // the creepers on one long side, from the ridge-end common to the corner
    for (let x = run2 - S; x > 1; x -= S) shapes.push({ type: "line", a: [r(x), 0], b: [r(x), r(x * (run1 / run2))], style: "dashed" });
  }
  return { title: `Hip roof plan, ${fmt(W)} × ${fmt(L)}`, shapes, note: "Plan: hips solid, ridge thick, creepers on one side dashed. Centre lines." };
}
