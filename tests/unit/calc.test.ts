// The calculator (Stage 8.3): hand-checked values, the parser's refusals and limits, and proof that text is never run.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { calculate, CalcError, evaluate, tidy } from "../../src/calc/expr.js";
import { roofGeometry, setOut, stairs, STAIR_LIMITS } from "../../src/calc/geometry.js";
import { calcTools } from "../../src/brain/calcTools.js";
import { newTurnCtx } from "../../src/brain/turn.js";

const near = (a: number, b: number, tol = 0.05, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≈ ${b}`);
const fails = (src: string, re: RegExp) => assert.throws(() => evaluate(src), (e: Error) => e instanceof CalcError && re.test(e.message), src);

// Hand-checked values.
assert.equal(evaluate("sqrt(3000^2 + 4000^2)"), 5000);
assert.equal(calculate("tan(22.5) * 3000").rounded, 1242.6);
assert.equal(evaluate("2 + 3 * 4"), 14);
assert.equal(evaluate("(2 + 3) * 4"), 20);
assert.equal(evaluate("2^3^2"), 512, "power runs right to left");
assert.equal(evaluate("-2^2"), -4, "minus applies after the power, as on paper");
assert.equal(evaluate("10 / 4"), 2.5);
near(evaluate("sin(30)"), 0.5, 1e-12, "sin in degrees");
near(evaluate("cos(60)"), 0.5, 1e-12, "cos in degrees");
near(evaluate("atan(1)"), 45, 1e-12, "atan gives degrees");
near(evaluate("asin(0.5)"), 30, 1e-9);
near(evaluate("acos(0.5)"), 60, 1e-9);
assert.equal(evaluate("round(3.14159, 2)"), 3.14);
assert.equal(evaluate("round(2.5)"), 3);
assert.equal(evaluate("floor(7.9) + ceil(7.1)"), 15);
assert.equal(evaluate("min(450, 600, 300) + max(1, 2)"), 302);
assert.equal(evaluate("abs(-12)"), 12);
near(evaluate("2 * pi"), 6.283185, 1e-6);
assert.equal(evaluate("3 × 4 ÷ 2"), 6, "the × and ÷ signs work");
assert.equal(evaluate("1.5e3"), 1500);
assert.equal(tidy(3247.1958), 3247.2);
assert.equal(tidy(0.41421356), 0.414);
assert.equal(tidy(450), 450);

// Refusals, in plain words that name the spot.
fails("2 + x", /I don't know "x" at character 5/);
fails("sqrt(9", /bracket isn't closed/);
fails("(1 + 2", /bracket isn't closed/);
fails("1 + 2)", /closing bracket with no opening one/);
fails("3,600 / 2", /write 3600, not 3,600/);
fails("4 / 0", /Dividing by zero/);
fails("sqrt(-1)", /no answer/);
fails("2 +", /stops before it's finished/);
fails("2 $ 3", /can't use "\$"/);
fails("sqrt", /needs brackets/);
fails("round(1, 2, 3)", /round takes 1 to 2 numbers/);
fails("", /something to work out/);
fails("1+".repeat(150) + "1", /over 300 characters/);
fails("(".repeat(21) + "1" + ")".repeat(21), /Nested more than 20 deep/);
assert.equal(evaluate("(".repeat(19) + "1" + ")".repeat(19)), 1, "19 deep is fine");
// Text is never run as code.
let ran = false;
(globalThis as Record<string, unknown>).__calcRan = () => (ran = true);
for (const bad of ["process.exit()", "process.exit(1)", "__calcRan()", "constructor.constructor('return process')()", "this", "eval(1)", "Function(1)", "require('fs')", "1; process.exit()", "`1`"])
  assert.throws(() => evaluate(bad), CalcError, bad);
assert.equal(ran, false);

// Roof geometry: 3,000 run at 22.5°.
const roof = roofGeometry({ run_mm: 3000, pitch_deg: 22.5 }) as Record<string, number | string | string[]>;
assert.equal(roof.rise_mm, 1242.6);
assert.equal(roof.rafter_length_mm, 3247.2);
assert.equal(roof.rise_per_metre_of_run_mm, 414.2);
assert.match(String(roof.plumb_cut), /67\.5° to the rafter's edge/);
assert.match(String(roof.seat_cut), /22\.5°/);
assert.ok((roof.assumptions as string[]).some((s) => /centre lines/.test(s)), "states its assumptions");
// The same roof from the span and the rise.
const roof2 = roofGeometry({ span_mm: 6000, rise_mm: 1242.6 }) as Record<string, number>;
assert.equal(roof2.run_mm, 3000);
assert.equal(roof2.pitch_deg, 22.5);
// With a level overhang of 450 and a 140 deep rafter.
const roof3 = roofGeometry({ run_mm: 3000, pitch_deg: 22.5, overhang_mm: 450, rafter_depth_mm: 140 }) as Record<string, number>;
assert.equal(roof3.rafter_length_with_overhang_mm, 3734.3); // 3450 ÷ cos 22.5°
assert.equal(roof3.plumb_depth_mm, 151.5); // 140 ÷ cos 22.5°
// A 30° roof with a square corner: hip pitch 22.2°.
const hip = (roofGeometry({ run_mm: 3000, pitch_deg: 30, hip: true }) as { hip: Record<string, number> }).hip;
assert.equal(hip.hip_pitch_deg, 22.2);
assert.equal(hip.hip_run_mm, 4242.6);
assert.equal(hip.hip_length_mm, 4582.6); // √(4242.6² + 1732.1²)
assert.throws(() => roofGeometry({ pitch_deg: 20 }), CalcError);
assert.throws(() => roofGeometry({ run_mm: 3000 }), CalcError);
assert.throws(() => roofGeometry({ run_mm: 3000, pitch_deg: 95 }), CalcError);

// Set-out: 3,600 at a 450 maximum is 9 members at 450 centres.
let s = setOut({ length_mm: 3600, max_spacing_mm: 450 });
assert.equal(s.members, 9);
assert.equal(s.spacing_mm, 450);
s = setOut({ length_mm: 3700, max_spacing_mm: 450 });
assert.equal(s.members, 10);
assert.equal(s.spacing_mm, 411.1);
s = setOut({ length_mm: 2400, max_spacing_mm: 600, member_mm: 45 }); // end centres 22.5 in from each end
assert.equal(s.members, 5);
assert.equal(s.spacing_mm, 588.8);
s = setOut({ length_mm: 2000, max_spacing_mm: 120, ends: "none" }); // balusters between two posts
assert.equal(s.members, 16);
assert.ok(s.spacing_mm <= 120);

// Stairs: a 2,700 rise with a 250 going is 15 risers of 180, and 2R + G of 610.
const st = stairs({ total_rise_mm: 2700, going_mm: 250 });
assert.equal(st.risers, 15);
assert.equal(st.riser_mm, 180);
assert.equal(st.treads, 14);
assert.equal(st.two_r_plus_g_mm, 610);
assert.equal(st.within_limits, true);
assert.match(st.limits_from, /NCC 2022 Housing Provisions.*the code in force when it's built decides/);
assert.equal(STAIR_LIMITS.riser.max, 190);
const st2 = stairs({ total_rise_mm: 2700 });
assert.ok(st2.going_chosen && st2.within_limits, "picks a going in range when none is given");
const st3 = stairs({ total_rise_mm: 2700, going_mm: 200 });
assert.equal(st3.within_limits, false, "a going under 240 is flagged");

// The tools: plain errors, and allowed on test turns (they only compute).
const ctx = { ...newTurnCtx(), test: true };
const tools = Object.fromEntries(calcTools(ctx).map((t) => [t.name, t]));
const out = async (name: string, args: Record<string, unknown>) => JSON.parse(((await tools[name].handler(args, {})) as { content: { text: string }[] }).content[0].text);
assert.equal((await out("calculate", { expression: "sqrt(3000^2 + 4000^2)" })).exact, 5000);
assert.match((await out("calculate", { expression: "process.exit()" })).error, /I don't know "process"/);
assert.equal((await out("roof_geometry", { run_mm: 3000, pitch_deg: 22.5 })).rafter_length_mm, 3247.2);
assert.equal((await out("set_out", { length_mm: 3600, max_spacing_mm: 450 })).members, 9);
// (the Stage 8 "stairs" tool became stair_calc in 14.2: the full stair, checked and sketched; tests/unit/trade-calc.test.ts)
assert.equal((await out("stair_calc", { total_rise_mm: 2700, going_mm: 250, show: false })).answer.risers, 15);

console.log("calculator: ok");
