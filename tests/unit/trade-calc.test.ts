// The trade calculators (Stage 14.2), against hand-worked examples (the working is written beside each). Stairs that
// just pass and just fail each NCC rule; the headroom line; barriers and balusters; a hip roof against the textbook's
// closed forms; a valley; set-out and levels; quantities and their rounding; every code figure sourced; the edition
// check; and the tools putting the sketch and working on screen.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stairCalc, barrierCalc, stairOptions } from "../../src/shared/calc/stairs.js";
import { roofCalc, planesMeet } from "../../src/shared/calc/roof.js";
import { setoutCalc } from "../../src/shared/calc/setout.js";
import { quantityCalc } from "../../src/shared/calc/quantity.js";
import { CODE_EDITION_DEFAULT, editionInForce, editionNote, NCC_BARRIERS, NCC_EDITION, NCC_HEADROOM, NCC_REVIEWED_FOR, NCC_STAIRS } from "../../src/shared/calc/ncc.js";
import { CalcInputError, type CalcResult } from "../../src/shared/calc/result.js";
import { sketchProblem } from "../../src/store/sketch.js";
import { getSettings, updateSettings } from "../../src/store/settings.js";
import { calcTools } from "../../src/brain/calcTools.js";
import { newTurn, newTurnCtx } from "../../src/brain/turn.js";
import { getItem } from "../../src/store/items.js";

const near = (a: unknown, b: number, tol: number, what: string) => assert.ok(typeof a === "number" && Math.abs(a - b) <= tol, `${what}: ${a} ≈ ${b}`);
const check = (r: CalcResult, what: string) => (r.checks.find((c) => c.what === what) ?? r.checks.find((c) => c.what.startsWith(what)))!;
const sketchOk = (r: CalcResult) => assert.equal(r.sketch ? sketchProblem({ shapes: r.sketch.shapes, note: r.sketch.note }) : null, null, `${r.title}: the sketch is within the limits`);
const BEFORE = new Date("2026-11-14T00:00:00Z");

/* ================= stairs ================= */

// "Total rise 2650, I've got 3.6 metres of run."
// Risers: 2650 ÷ 190 = 13.95 → 14. Rise 2650 ÷ 14 = 189.29. Going for 2R+G = 625 (the middle of 550–700):
// 625 − 378.57 = 246.4 → 246 (within 240–321 and under 3600 ÷ 13 = 276.9). 2R+G = 624.6. 13 treads × 246 = 3198 ≤ 3600.
// Pitch atan(189.29 ÷ 246) = 37.6°. Each step √(189.29² + 246²) = 310.4; 14 × 310.4 = 4346 along the pitch line.
let s = stairCalc({ total_rise_mm: 2650, run_available_mm: 3600 }, CODE_EDITION_DEFAULT, BEFORE);
assert.equal(s.answer.risers, 14);
assert.equal(s.answer.riser_mm, 189.3);
assert.equal(s.answer.going_mm, 246);
assert.equal(s.answer.two_r_plus_g_mm, 624.6);
assert.equal(s.answer.total_going_mm, 3198);
assert.equal(s.answer.pitch_deg, 37.6);
assert.equal(s.answer.stringer_pitch_line_mm, 4346);
assert.equal(s.answer.passes, true);
assert.equal(s.answer.fits_run, true);
assert.match(s.say, /^14 risers at 189, going 246\. That passes\.$/);
assert.ok(s.steps.some((l) => /Step-off marks .*: 310, 621, 931/.test(l)), "step-off marks at each 310.4");
assert.ok(s.steps.some((l) => /plumb cut \(top\) 52\.4° .* level cut \(bottom\) 37\.6°/.test(l)));
assert.ok(s.checks.every((c) => c.ok && /^NCC 2022 Housing Provisions /.test(c.source)), "every check passes and names its clause");
assert.ok(s.sources.some((x) => x.includes("ncc.abcb.gov.au") && x.includes("part-112")));
assert.ok(s.sources.some((x) => x.includes("© Commonwealth of Australia and the States and Territories 2022")), "the ABCB's attribution");
assert.ok(s.steps.some((l) => /Barrier on any open side from tread 6 up/.test(l)), "1000 ÷ 189.3 = 5.3 → tread 6 is the first 1 m up");
assert.ok(s.steps.some((l) => /Handrail: on at least one side.* 865/.test(l)));
sketchOk(s);
// the other workable stairs it offers pass and fit too
assert.ok(stairOptions(2650, "standard", 3600).filter((o) => o.passes && o.fits).length >= 2);

// A stair that just passes and one that just fails each rule (risers forced, goings given).
const one = (total: number, risers: number, going: number, more = {}) => stairCalc({ total_rise_mm: total, risers, going_mm: going, ...more }, CODE_EDITION_DEFAULT, BEFORE);
// riser at most 190: 1900 ÷ 10 = 190.0 passes; 1901 ÷ 10 = 190.1 fails
assert.equal(check(one(1900, 10, 250), "Riser").ok, true);
assert.equal(check(one(1901, 10, 250), "Riser").ok, false);
// riser at least 115: 1150 ÷ 10 = 115.0 passes; 1149 ÷ 10 = 114.9 fails
assert.equal(check(one(1150, 10, 300), "Riser").ok, true);
assert.equal(check(one(1149, 10, 300), "Riser").ok, false);
// going 240 to 355
assert.equal(check(one(1800, 10, 240), "Going").ok, true);
assert.equal(check(one(1800, 10, 239), "Going").ok, false);
assert.equal(check(one(1150, 10, 355), "Going").ok, true);
assert.equal(check(one(1150, 10, 356), "Going").ok, false);
// 2R + G at most 700: R 190, G 320 → 700 passes; G 321 → 701 fails
assert.equal(check(one(1900, 10, 320), "2R + G").ok, true);
assert.equal(check(one(1900, 10, 321), "2R + G").ok, false);
// 2R + G at least 550: R 155, G 240 → 550 passes; R 154.9, G 240 → 549.8 fails
assert.equal(check(one(1550, 10, 240), "2R + G").ok, true);
assert.equal(check(one(1549, 10, 240), "2R + G").ok, false);
// risers in a flight, 2 to 18: 3420 ÷ 18 = 190 passes; 19 risers fails and says it needs a landing
assert.equal(check(one(3420, 18, 250), "Risers in the flight").ok, true);
const nineteen = one(3420, 19, 260);
assert.equal(check(nineteen, "Risers in the flight").ok, false);
assert.ok(nineteen.warnings.some((w) => /needs a landing \(at least 750 long, 11\.2\.5\(1\)\), e\.g\. 10 risers then 9/.test(w)));
assert.equal(nineteen.answer.passes, false);
// open risers: the gap between treads under 125: rise 180 − 56 tread = 124 passes; − 55 = 125 fails
assert.equal(check(one(2700, 15, 250, { open_risers: true, tread_thickness_mm: 56 }), "Open riser gap").ok, true);
assert.equal(check(one(2700, 15, 250, { open_risers: true, tread_thickness_mm: 55 }), "Open riser gap").ok, false);
assert.ok(one(2700, 15, 250, { open_risers: true }).warnings.some((w) => /give the tread thickness/.test(w)));
// winders: 3 for a quarter landing passes, 4 fails; 6 for a half passes
assert.equal(check(one(2700, 15, 250, { winders: 3, turn: "quarter" }), "Winders").ok, true);
assert.equal(check(one(2700, 15, 250, { winders: 4, turn: "quarter" }), "Winders").ok, false);
assert.equal(check(one(2700, 15, 250, { winders: 6, turn: "half" }), "Winders").ok, true);
// an attic stair has its own table: R 225 passes (Table 11.2.2b); the same as a standard stair fails
assert.equal(check(stairCalc({ total_rise_mm: 2250, risers: 10, going_mm: 230, kind: "attic" }, CODE_EDITION_DEFAULT, BEFORE), "Riser").ok, true);
assert.equal(check(one(2250, 10, 230), "Riser").ok, false);
// a door at the top of more than 3 risers needs a landing
assert.ok(one(2700, 15, 250, { door_at_top: true }).warnings.some((w) => /needs a landing at the door, at least 750/.test(w)));
// It doesn't fit: 2700 rise in 2000 of run. The shortest that passes needs 14 × 240 = 3360 (15 risers × 180; 2R+G 600).
const tight = stairCalc({ total_rise_mm: 2700, run_available_mm: 2000 }, CODE_EDITION_DEFAULT, BEFORE);
assert.equal(tight.answer.fits_run, false);
assert.ok(tight.warnings.some((w) => /No stair within the limits fits in 2,000: the shortest that passes needs about 3,360/.test(w)), tight.warnings.join(" | "));

// Headroom: 2700 rise, 15 × 180, going 250, the upper floor 300 deep → its underside at 2400. The line 2000 above the
// nosing line (y = 180 + x·180/250) reaches 2400 at x = (2400 − 2000 − 180) × 250 ÷ 180 = 305.6. Total going 14 × 250
// = 3500, so the opening must run back 3500 − 305.6 = 3194.4 → 3195 from the top riser.
s = stairCalc({ total_rise_mm: 2700, risers: 15, going_mm: 250, upper_floor_depth_mm: 300 }, CODE_EDITION_DEFAULT, BEFORE);
assert.equal(s.answer.opening_from_top_riser_mm, 3195);
assert.ok(s.steps.some((l) => /run back at least 3,195 from the top riser/.test(l)));
assert.ok(s.sources.some((x) => x.includes("part-103-room-heights")));
sketchOk(s);
// Balusters on a stair: going 250, 42 wide, aiming 120: 250 ÷ (120 + 42) = 1.5 → 2 a tread at 125 centres, gap 83.
s = one(2700, 15, 250, { open_side: true, baluster_mm: 42 });
assert.ok(s.steps.some((l) => /Balusters: 2 a tread at 125 centres leaves a 83 gap/.test(l)));

/* ================= barriers ================= */
assert.equal(barrierCalc({ fall_mm: 999 }).answer.needed, false, "under 1 m: no barrier");
assert.equal(barrierCalc({ fall_mm: 1000 }).answer.needed, true, "1 m: a barrier");
assert.equal(barrierCalc({ fall_mm: 1000 }).answer.height_mm, 1000, "a floor or deck: 1 m");
assert.equal(barrierCalc({ fall_mm: 1500, where: "stair" }).answer.height_mm, 865, "a stair: 865 above the nosings");
assert.equal(barrierCalc({ fall_mm: 1500, where: "landing", landing_edge_mm: 500 }).answer.height_mm, 865, "a landing's inside edge up to 500 long: 865");
assert.equal(barrierCalc({ fall_mm: 1500, where: "landing", landing_edge_mm: 501 }).answer.height_mm, 1000);
assert.equal(barrierCalc({ fall_mm: 4000 }).answer.no_climb_zone, false, "4 m exactly: the climbing rule is for over 4 m");
assert.equal(barrierCalc({ fall_mm: 4001 }).answer.no_climb_zone, true);
assert.ok(barrierCalc({ fall_mm: 4001 }).steps.some((l) => /between 150 and 760/.test(l)));
// Balusters in a 2400 run, 42 wide, aiming at 120: N = (2400 − 120) ÷ (42 + 120) = 14.07 → 15; gaps (2400 − 15 × 42) ÷ 16
// = 110.6, centres 152.6, the first centre 131.6 from the post.
let b = barrierCalc({ fall_mm: 1200, run_mm: 2400, baluster_mm: 42 });
assert.equal(b.answer.balusters, 15);
assert.equal(b.answer.gap_mm, 110.6);
assert.ok(b.steps.some((l) => /at 152\.6 centres; the first centre 131\.6 from the post/.test(l)));
sketchOk(b);
// the gap test: 124.9 passes, 125 fails (one baluster in a 292 run, 42 wide: (292 − 42) ÷ 2 = 125)
b = barrierCalc({ fall_mm: 1200, run_mm: 292, baluster_mm: 42, max_gap_mm: 125 });
assert.equal(b.answer.gap_mm, 125);
assert.equal(check(b, "Gap").ok, false);
b = barrierCalc({ fall_mm: 1200, run_mm: 291.8, baluster_mm: 42, max_gap_mm: 125 });
assert.equal(check(b, "Gap").ok, true);

/* ================= roofs ================= */
// Common rafter, 3000 run at 22.5°: rise 3000 × tan 22.5 = 1242.6; length 3000 ÷ cos 22.5 = 3247.2 (Stage 8's figure).
// Birdsmouth on a 90 seat, 140 deep: plumb cut 90 × tan 22.5 = 37.3; 90 × sin 22.5 = 34.4 square to the rafter (25%);
// above the plate 140 ÷ cos 22.5 − 37.3 = 151.5 − 37.3 = 114.3.
let r = roofCalc({ kind: "common", run_mm: 3000, pitch_deg: 22.5, rafter_depth_mm: 140, seat_mm: 90, overhang_mm: 450 });
assert.equal(r.answer.rise_mm, 1243);
assert.equal(r.answer.rafter_mm, 3247);
assert.equal(r.answer.rafter_overall_mm, 3734, "(3000 + 450) ÷ cos 22.5 = 3734.2");
assert.equal(r.answer.birdsmouth_plumb_mm, 37.3);
assert.equal(r.answer.height_above_plate_mm, 114.3);
assert.ok(r.steps.some((l) => /34\.4 deep square to the rafter .* 25% of its 140 depth/.test(l)));
sketchOk(r);

// The textbook's closed forms for an equal-pitch hip with a square corner (see roof.ts):
//   hip pitch tan = tan p ÷ √2; creeper edge cut tan = cos p (from the side); hip edge cut tan = cos(hip pitch);
//   backing tan = sin(hip pitch); creeper step = spacing ÷ cos p; hip drop = half thickness × tan p ÷ √2.
for (const p of [15, 22.5, 30, 35, 45, 60]) {
  const m = planesMeet(p, p, 1000);
  const t = Math.tan((p * Math.PI) / 180);
  const hipP = (Math.atan(t / Math.SQRT2) * 180) / Math.PI;
  near(m.pitch, hipP, 1e-9, `hip pitch at ${p}`);
  near(90 - m.creeperOffSquare1, (Math.atan(Math.cos((p * Math.PI) / 180)) * 180) / Math.PI, 1e-9, `creeper edge at ${p}`);
  near(90 - m.hipOffSquareRidge, (Math.atan(Math.cos((hipP * Math.PI) / 180)) * 180) / Math.PI, 1e-9, `hip edge at ${p}`);
  near(m.backing1, (Math.atan(Math.sin((hipP * Math.PI) / 180)) * 180) / Math.PI, 1e-9, `backing at ${p}`);
  near(m.backing1, m.backing2, 1e-9, "both sides alike");
  near(m.dropPer1, t / Math.SQRT2, 1e-9, `drop at ${p}`);
  near(m.stepPer1, 1 / Math.cos((p * Math.PI) / 180), 1e-9, `creeper step at ${p}`);
}
// the textbook's numbers: 45° → hip 35.26°, backing 30°; 30° → hip 22.2°, backing 20.7°; 22.5° → hip 16.3°, creeper edge 42.7°
near(planesMeet(45, 45, 1).pitch, 35.264, 0.001, "45: hip pitch");
near(planesMeet(45, 45, 1).backing1, 30, 1e-9, "45: backing 30");
near(planesMeet(30, 30, 1).pitch, 22.208, 0.001, "30: hip pitch");
near(planesMeet(30, 30, 1).backing1, 20.705, 0.001, "30: backing");

// "Hip roof, 22 and a half degrees, 7.2 by 9.6, 450 eaves": run 3600, rise 3600 × tan 22.5 = 1491.2; commons
// 3600 ÷ cos 22.5 = 3896.6, with the eave 4050 ÷ cos 22.5 = 4383.7; hip plan 3600√2 = 5091.2, length √(5091.2² + 1491.2²)
// = 5305.1, pitch 16.3°, with the eave + 450√2 ÷ cos 16.3 = 663.1 → 5968.2; ridge 9600 − 7200 = 2400. Hip drop for a 45
// hip: 22.5 × tan 22.5 ÷ √2 = 6.6. Creepers at 450: each 450 ÷ cos 22.5 = 487.1 shorter.
r = roofCalc({ kind: "hip", span_mm: 7200, length_mm: 9600, pitch_deg: 22.5, overhang_mm: 450, spacing_mm: 450, hip_thickness_mm: 45 });
assert.equal(r.answer.rise_mm, 1491);
assert.equal(r.answer.common_mm, 3897);
assert.equal(r.answer.common_overall_mm, 4384);
assert.equal(r.answer.hip_mm, 5305);
assert.equal(r.answer.hip_overall_mm, 5968);
assert.equal(r.answer.hip_pitch_deg, 16.3);
assert.equal(r.answer.hip_backing_deg, 15.7);
assert.equal(r.answer.hip_edge_cut_to_side_deg, 43.8);
assert.equal(r.answer.creeper_edge_cut_to_side_deg, 42.7);
assert.equal(r.answer.creeper_step_mm, 487.1);
assert.equal(r.answer.hip_drop_mm, 6.6);
assert.equal(r.answer.ridge_mm, 2400);
// creepers from the ridge-end common: runs 3150, 2700, ... → lengths 3150 ÷ cos 22.5 = 3409.5, 2922.4, ...
assert.ok(r.steps.some((l) => /Creeper lengths .*: 3,410, 2,922, 2,435, 1,948, 1,461, 974, 487/.test(l)), r.steps.join("\n"));
assert.ok(r.steps.some((l) => /ridge-end commons 3,600 in from each corner/.test(l)));
sketchOk(r);
// Unequal: sides 22.5°, ends 30°: end run 1491.2 ÷ tan 30 = 2582.8; ridge 9600 − 2 × 2582.8 = 4434.4; hip plan
// √(3600² + 2582.8²) = 4430.7, pitch atan(1491.2 ÷ 4430.7) = 18.6°. The ends' eave for level fascias: 450 × tan 22.5 ÷ tan 30 = 322.8.
r = roofCalc({ kind: "hip", span_mm: 7200, length_mm: 9600, pitch_deg: 22.5, end_pitch_deg: 30, overhang_mm: 450 });
assert.equal(r.answer.ridge_mm, 4434);
assert.equal(r.answer.hip_pitch_deg, 18.6);
assert.equal(r.answer.end_overhang_mm, 323);
const u = planesMeet(22.5, 30, 1491.2);
assert.ok(Math.abs(u.backing1 - u.backing2) > 1, "unequal pitches: each side backs differently");
const swapped = planesMeet(30, 22.5, 1491.2);
near(swapped.backing1, u.backing2, 1e-9, "the same geometry from the other side");
assert.throws(() => roofCalc({ kind: "hip", span_mm: 7200, length_mm: 5000, pitch_deg: 22.5, end_pitch_deg: 10 }), CalcInputError);

// Valley: main 7200 and wing 4800, both 22.5°: wing ridge 2400 × tan 22.5 = 994.1; valley plan 2400√2 = 3394.1, length
// √(3394.1² + 994.1²) = 3536.7, pitch 16.3° (the same as a hip).
r = roofCalc({ kind: "valley", span_mm: 7200, pitch_deg: 22.5, wing_span_mm: 4800, spacing_mm: 450 });
assert.equal(r.answer.valley_mm, 3537);
assert.equal(r.answer.valley_pitch_deg, 16.3);
assert.equal(r.answer.jack_step_mm, 487.1);
assert.throws(() => roofCalc({ kind: "valley", span_mm: 4000, pitch_deg: 22.5, wing_span_mm: 7200 }), /above the main ridge/);
assert.throws(() => roofCalc({ kind: "common", run_mm: 3000 }), /pitch/);

/* ================= set-out ================= */
// 6000 × 8000: √(6000² + 8000²) = 10000. Measured 10010 and 9990: out by 20.
let so = setoutCalc({ kind: "square", length_mm: 8000, width_mm: 6000, diagonal1_mm: 10010, diagonal2_mm: 9990 });
assert.equal(so.answer.diagonal_mm, 10000);
assert.equal(so.answer.out_by_mm, 20);
sketchOk(so);
// 3-4-5 with 2500 to work in: 1800-2400-3000 is the biggest that fits
assert.deepEqual([setoutCalc({ kind: "345", length_mm: 2500 }).answer.a_mm, setoutCalc({ kind: "345", length_mm: 2500 }).answer.b_mm, setoutCalc({ kind: "345", length_mm: 2500 }).answer.c_mm], [1800, 2400, 3000]);
// falls: 1 in 100 over 6000 = 60; 2% over 3000 = 60 = 1 in 50
assert.equal(setoutCalc({ kind: "fall", length_mm: 6000, ratio: 100 }).answer.fall_mm, 60);
assert.equal(setoutCalc({ kind: "fall", length_mm: 3000, percent: 2 }).answer.one_in, 50);
assert.throws(() => setoutCalc({ kind: "fall", length_mm: 3000 }), /Give the fall/);
// Levels: BM 100.000, BS 1.500 → HI 101.500; IS 1.200 → 100.300; CP FS 2.000 → 99.500, BS 0.800 → HI 100.300;
// FS 1.100 → 99.200 (design 99.300: fill 100). Check: ΣBS 2.300 − ΣFS 3.100 = −0.800 = 99.200 − 100.000.
so = setoutCalc({
  kind: "levels",
  benchmark_rl_m: 100,
  readings: [
    { label: "BM", bs: 1.5 },
    { label: "A", is: 1.2 },
    { label: "CP1", fs: 2.0, bs: 0.8 },
    { label: "B", fs: 1.1, design_rl_m: 99.3 },
  ],
});
assert.equal(so.answer.A, 100.3);
assert.equal(so.answer.CP1, 99.5);
assert.equal(so.answer.B, 99.2);
assert.ok(so.steps.some((l) => /Σ backsights 2\.3 − Σ foresights 3\.1 = -0\.8; last RL − first = -0\.8: agrees/.test(l)), so.steps.join("\n"));
assert.equal(so.table.rows[3][6], "fill 100");
// A 3600 wall at 450: studs centred at 22.5 (end), 450, 900 … 3150, and 3577.5 (end): 9. A 900 window from 1000 takes
// the ones at 1350 and 1800 (2 → short studs above and below: 4) and adds one each side: 9 full. Plates 2 × 3.6 = 7.2 m,
// + 10% = 7.92 m → 2 × 6000. Studs for a 2700 frame: 2700 − 2 × 45 = 2610.
so = setoutCalc({ kind: "studs", length_mm: 3600, centres_mm: 450, frame_height_mm: 2700, openings: [{ width_mm: 900, from_mm: 1000, kind: "window" }] });
assert.equal(so.answer.studs, 9);
assert.equal(so.answer.short_studs, 4);
assert.equal(so.answer.stud_length_mm, 2610);
assert.equal(so.answer.plate_lengths, 2);
sketchOk(so);

/* ================= quantities ================= */
// "How much concrete for 14 piers 450 square, 600 deep": 14 × 0.45 × 0.45 × 0.6 = 1.701 m³; + 10% = 1.871; in 0.2 steps → 2.0.
let q = quantityCalc({ kind: "concrete", pours: [{ shape: "pier_square", count: 14, size_mm: 450, depth_mm: 600 }] });
assert.equal(q.answer.volume_m3, 1.701);
assert.equal(q.answer.with_waste_m3, 1.871);
assert.equal(q.answer.order_m3, 2);
assert.match(q.say, /1\.7 cubic metres, so order 2 with 10 per cent waste/);
// rounding: exactly 1.8 m³ with no waste orders 1.8, not 2.0 (no floating-point creep); 1.801 orders 2.0
assert.equal(quantityCalc({ kind: "concrete", waste_pct: 0, pours: [{ shape: "slab", length_mm: 3000, width_mm: 1000, depth_mm: 600 }] }).answer.order_m3, 1.8);
assert.equal(quantityCalc({ kind: "concrete", waste_pct: 0, pours: [{ shape: "slab", length_mm: 3001, width_mm: 1000, depth_mm: 600 }] }).answer.order_m3, 2);
assert.equal(quantityCalc({ kind: "concrete", waste_pct: 0, order_step_m3: 0.5, pours: [{ shape: "slab", length_mm: 3001, width_mm: 1000, depth_mm: 600 }] }).answer.order_m3, 2);
// round piers: 10 × π × 0.225² × 0.9 = 1.431
assert.equal(quantityCalc({ kind: "concrete", waste_pct: 0, pours: [{ shape: "pier_round", count: 10, size_mm: 450, depth_mm: 900 }] }).answer.volume_m3, 1.431);
// Decking 5000 × 3000, 86 boards, 4 gap: 3000 ÷ 90 = 33.3 → 34 rows; 34 × 5 = 170 m; +10% = 187 m; in 5400s: 35.
// Joists at 450: 5000 ÷ 450 + 1 = 12; screws 34 × 12 × 2 = 816; +10% = 897.6 → 898.
q = quantityCalc({ kind: "decking", length_mm: 5000, width_mm: 3000, board_mm: 86, gap_mm: 4, board_length_mm: 5400, joist_spacing_mm: 450 });
assert.equal(q.answer.rows, 34);
assert.equal(q.answer.lineal_with_waste_m, 187);
assert.equal(q.answer.boards, 35);
assert.equal(q.answer.screws, 898);
assert.throws(() => quantityCalc({ kind: "decking", length_mm: 5000, width_mm: 3000, board_mm: 86 }), /gap between boards/);
// Cladding: 6000 × 2700 = 16.2 m² less a 1800 × 1200 window (2.16) = 14.04 m²; at 180 cover: 78 m; +10% = 85.8 m; 4200s: 21.
q = quantityCalc({ kind: "cladding", length_mm: 6000, height_mm: 2700, openings: [{ width_mm: 1800, height_mm: 1200 }], cover_mm: 180, cover_source: "Made-up maker, made-up guide, page 1", board_length_mm: 4200 });
assert.equal(q.answer.net_m2, 14.04);
assert.equal(q.answer.lineal_m, 78);
assert.equal(q.answer.boards, 21);
assert.ok(q.sources.some((x) => /Cover 180 mm: Made-up maker/.test(x)), "the maker's cover width is cited");
assert.throws(() => quantityCalc({ kind: "cladding", length_mm: 6000, height_mm: 2700 }), /effective cover \(from the maker's guide/);
// Plasterboard: a 4000 × 2400 wall: 2 rows, a 4200 each (2); a 3600 × 3000 ceiling: 3 rows of 3600 (3). +10%: 3 × 4200,
// 4 × 3600 = 7. A 7000 wall is longer than 6000: two 6000s a row, butt joined.
q = quantityCalc({ kind: "plasterboard", surfaces: [{ kind: "wall", length_mm: 4000, height_mm: 2400 }, { kind: "ceiling", length_mm: 3600, height_mm: 3000 }] });
assert.equal(q.answer.sheets_4200, 3);
assert.equal(q.answer.sheets_3600, 4);
assert.equal(q.answer.sheets, 7);
assert.ok(quantityCalc({ kind: "plasterboard", surfaces: [{ kind: "wall", length_mm: 7000, height_mm: 2400 }] }).steps.some((l) => /2 × 6,000 a row \(butt joins\)/.test(l)));
// waste is stated and can be changed
assert.ok(quantityCalc({ kind: "decking", length_mm: 5000, width_mm: 3000, board_mm: 86, gap_mm: 4, waste_pct: 5 }).steps.some((l) => /with 5% waste/.test(l)));
assert.throws(() => quantityCalc({ kind: "decking", length_mm: 5000, width_mm: 3000, board_mm: 86, gap_mm: 4, waste_pct: 150 }), /0 to 100/);

/* ================= the code's figures: sourced, and reviewed for the edition in force ================= */
// Every figure in ncc.ts sits under a comment naming the clause, the edition and the page it was read from.
const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../../src/shared/calc/ncc.ts"), "utf8").split("\n");
let figures = 0;
src.forEach((line, i) => {
  if (!/clause: "/.test(line)) return;
  figures++;
  let j = i - 1;
  while (j >= 0 && !src[j].trim().endsWith("*/")) j--;
  let k = j;
  while (k >= 0 && !src[k].trim().startsWith("/**")) k--;
  const comment = src.slice(k, j + 1).join(" ");
  assert.ok(/NCC 2022/.test(comment) && /NCC_PAGES\.\w+/.test(comment) && /\d+\.\d+/.test(comment), `ncc.ts line ${i + 1}: its comment names the clause, the edition and the page`);
});
assert.ok(figures >= 15, `${figures} sourced figures`);
const pages = readFileSync(path.join(here, "../../src/shared/calc/ncc.ts"), "utf8");
assert.match(pages, /stairs: `\$\{HP\}\/11-safe-movement-and-access\/part-112-stairway-and-ramp-construction`/);
// The figures as reviewed on 14 November 2026 against NCC 2022 (as amended, in force in NSW). If one changes, this
// fails: review the figure against the ABCB's page and update this record with the date.
const fingerprint = createHash("sha256").update(JSON.stringify({ NCC_EDITION, NCC_STAIRS, NCC_BARRIERS, NCC_HEADROOM })).digest("hex").slice(0, 16);
assert.equal(fingerprint, "b16aa0f9fc297b10", "the code's figures are as reviewed on 14 Nov 2026 (NCC 2022)");
// The edition setting names the edition these figures were read from...
assert.equal(CODE_EDITION_DEFAULT.current, NCC_EDITION);
assert.deepEqual(getSettings()["code.edition"], CODE_EDITION_DEFAULT, "the setting's default");
// ...and NSW's change to NCC 2025 on 1 May 2027 (nsw.gov.au, 13 May 2026) is in it.
assert.equal(editionInForce(CODE_EDITION_DEFAULT, new Date("2027-04-30T13:59:00Z")), "NCC 2022", "30 April 2027, 11:59 pm Sydney");
assert.equal(editionInForce(CODE_EDITION_DEFAULT, new Date("2027-04-30T14:00:00Z")), "NCC 2025", "1 May 2027, midnight Sydney");
assert.equal(editionNote(CODE_EDITION_DEFAULT, BEFORE), null);
assert.match(editionNote(CODE_EDITION_DEFAULT, new Date("2027-05-02T00:00:00Z")) ?? "", /read from NCC 2022, but NCC 2025 is in force now \(from 2027-05-01\)/);
assert.ok(stairCalc({ total_rise_mm: 2650 }, CODE_EDITION_DEFAULT, new Date("2027-05-02T00:00:00Z")).warnings.some((w) => /NCC 2025 is in force now/.test(w)), "every answer says so after the change");
// The edition in force today must be one these figures were reviewed for. From 1 May 2027 this fails until the stair,
// barrier and headroom figures are read again from NCC 2025 and NCC_REVIEWED_FOR says so.
assert.ok((NCC_REVIEWED_FOR as readonly string[]).includes(editionInForce(getSettings()["code.edition"])), `the edition in force (${editionInForce(getSettings()["code.edition"])}) hasn't been reviewed: read Parts 10.3, 11.2 and 11.3 for it`);

/* ================= the tools: the sketch and the working on screen ================= */
const ctx = { ...newTurnCtx(), test: true, turn: newTurn({ persist: false, origin: { client: "phone", id: "phone-test" } }) };
const tools = Object.fromEntries(calcTools(ctx).map((t) => [t.name, t]));
const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await tools[name].handler(args, {})) as { content: { text: string }[] }).content[0].text);
let out = await call("stair_calc", { total_rise_mm: 2650, run_available_mm: 3600 });
assert.equal(out.answer.risers, 14);
assert.match(out.say, /14 risers at 189, going 246/);
assert.ok(out.checks.every((c: string) => c.startsWith("passes")));
assert.match(out.on_screen, /sketch "Stair, 2,650 rise" and table "Stair: 2,650 rise"/);
const shown = ctx.turn.items.map((id) => getItem(id)!);
assert.deepEqual(
  shown.map((i) => i.kind),
  ["sketch", "table"],
);
assert.equal(shown[1].source, "NCC 2022 Housing Provisions (ABCB), as in force in NSW");
assert.ok(shown[1].kind === "table" && /© Commonwealth of Australia/.test(shown[1].payload.note ?? ""));
out = await call("quantity_calc", { kind: "concrete", pours: [{ shape: "pier_square", count: 14, size_mm: 450, depth_mm: 600 }] });
assert.equal(out.answer.order_m3, 2);
out = await call("stair_calc", {});
assert.match(out.error, /I need the total rise, finished floor to finished floor/, "a missing input is a plain question");
out = await call("roof_calc", { kind: "hip", span_mm: 7200, length_mm: 9600, pitch_deg: 22.5, show: false });
assert.equal(out.on_screen, "nothing");
// After the edition changes (here: the setting says NCC 2025 is in force), the warning is in the answer and on screen.
updateSettings({ "code.edition": { current: "NCC 2025", next: null } }, "local");
const before = ctx.turn.items.length;
out = await call("stair_calc", { total_rise_mm: 2650, run_available_mm: 3600, open_side: true, baluster_mm: 42, door_at_top: true, winders: 3 });
assert.ok(out.warnings.some((w: string) => /read from NCC 2022, but NCC 2025 is in force now/.test(w)));
const t = getItem(ctx.turn.items[before + 1])!;
assert.ok(t.kind === "table" && t.payload.rows.some((r) => r[0] === "!" && /NCC 2025 is in force now/.test(r[1])), "the warning is a row of the working on screen");
updateSettings({ "code.edition": CODE_EDITION_DEFAULT }, "local");

console.log("trade calculators: ok");
