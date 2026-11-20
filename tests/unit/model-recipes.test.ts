// Joint recipes (Stage 9.2): every recipe with its defaults and with one unusual set of sizes. No clash, nothing
// floating, the overall size is what the member sizes say, something pulls apart, sizes with words are true lengths,
// and it passes the limits. The mortise holds exactly the tenon; a three-tail dovetail has three tails; sizes that
// can't work come back in plain words, never thrown.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { JOINT_NAMES, RECIPES, runRecipe, sectionOf } from "../../src/shared/model3d/recipes/index.js";
import { tailVolume } from "../../src/shared/model3d/recipes/dovetail.js";
import { buildModel } from "../../src/shared/model3d/build.js";
import { checkModel, contains } from "../../src/shared/model3d/check.js";
import { modelProblem } from "../../src/store/model.js";
import { roofGeometry } from "../../src/calc/geometry.js";
import type { ModelPayload } from "../../src/shared/protocol.js";

type P = Record<string, number | string | boolean>;
const sec = (p: P, k: string) => sectionOf(p[k])!;
const n = (p: P, k: string) => Number(p[k]);
const T = (deg: number) => Math.tan((deg * Math.PI) / 180);

/** The overall size each recipe should come to, from the sizes it used. */
const SIZE: Record<string, (p: P) => number[]> = {
  butt: (p) => [sec(p, "post")[0] + n(p, "rail_length"), Math.max(sec(p, "post")[1], sec(p, "rail")[1]), n(p, "post_length")],
  mitre: (p) => {
    const phi = (2 * n(p, "angle") * Math.PI) / 180;
    const [wB] = sec(p, "second");
    const xs = [0, n(p, "first_length"), Math.cos(phi) * n(p, "second_length"), Math.cos(phi) * n(p, "second_length") + Math.sin(phi) * wB];
    const zs = [0, sec(p, "first")[0], Math.sin(phi) * n(p, "second_length"), Math.sin(phi) * n(p, "second_length") - Math.cos(phi) * wB];
    return [Math.max(...xs) - Math.min(...xs), Math.max(sec(p, "first")[1], sec(p, "second")[1]), Math.max(...zs) - Math.min(...zs)];
  },
  half_lap: (p) => [n(p, "first_length"), p.layout === "cross" ? n(p, "second_length") : n(p, "second_length"), Math.max(sec(p, "first")[1], sec(p, "second")[1])],
  housing: (p) => [sec(p, "side")[1] - n(p, "depth") + n(p, "shelf_length"), sec(p, "side")[0], n(p, "side_length")],
  mortise_tenon: (p) => [sec(p, "post")[0] + n(p, "rail_length"), sec(p, "post")[1], n(p, "post_length")],
  bridle: (p) => [n(p, "rail_length"), Math.max(sec(p, "rail")[1], sec(p, "post")[1]), n(p, "post_length")],
  // these two are turned a quarter turn so the corner faces the usual view: the boards run along -x and +y
  dovetail: (p) => [n(p, "tail_length"), n(p, "pin_length"), sec(p, "tail_board")[0]],
  box_joint: (p) => [n(p, "second_length"), n(p, "first_length"), sec(p, "first")[0]],
  dowel: (p) => [sec(p, "post")[0] + n(p, "rail_length"), Math.max(sec(p, "post")[1], sec(p, "rail")[1]), n(p, "post_length")],
  tongue_groove: (p) => [n(p, "length"), sec(p, "tongue_board")[0] + sec(p, "groove_board")[0], sec(p, "tongue_board")[1]],
  birdsmouth: (p) => {
    const [D] = sec(p, "rafter");
    const [pw, pt] = sec(p, "plate");
    const S = n(p, "seat"),
      t = T(n(p, "pitch"));
    const plumb = Number(roofGeometry({ run_mm: 1000, pitch_deg: n(p, "pitch"), rafter_depth_mm: D }).plumb_depth_mm);
    const low = Math.min(-pt, t * (-n(p, "overhang") - S));
    const high = t * (pw + n(p, "rafter_run") - S) + plumb;
    return [n(p, "overhang") + pw + n(p, "rafter_run"), n(p, "plate_length"), high - low];
  },
  scarf: (p) => [n(p, "first_length") + n(p, "slope") * sec(p, "first")[0] + n(p, "second_length"), sec(p, "first")[1], sec(p, "first")[0]],
};

/** One unusual set of sizes for each. */
const ODD: Record<string, { members?: number[][]; params?: Record<string, unknown> }> = {
  butt: { members: [[140, 35], [70, 70]], params: { layout: "tee" } },
  mitre: { members: [[66, 19], [42, 19]], params: { angle: 30 } },
  half_lap: { members: [[120, 45], [90, 35]], params: { layout: "cross", depth: 20 } },
  housing: { members: [[290, 32], [250, 25]], params: { depth: 12, stop: 15 } },
  mortise_tenon: { members: [[140, 35], [70, 70]], params: { type: "through", peg: true, peg_diameter: 12 } },
  bridle: { members: [[70, 42], [90, 42]], params: { layout: "tee", slot: 12 } },
  dovetail: { members: [[200, 22], [200, 16]], params: { tails: 5, slope: 6, pin: 6 } },
  box_joint: { members: [[96, 12], [96, 18]], params: { finger: 15 } },
  dowel: { members: [[190, 42], [70, 42]], params: { count: 4, diameter: 12, depth: 35 } },
  tongue_groove: { members: [[90, 22], [180, 22]], params: { tongue: 6, tongue_length: 10 } },
  birdsmouth: { members: [[190, 45], [140, 45]], params: { pitch: 35, plumb_cut: 50, overhang: 450 } },
  scarf: { members: [[140, 45], [140, 45]], params: { slope: 4 } },
};

assert.deepEqual(JOINT_NAMES, ["butt", "mitre", "half_lap", "housing", "mortise_tenon", "bridle", "dovetail", "box_joint", "dowel", "tongue_groove", "birdsmouth", "scarf"]);
assert.equal(RECIPES.length, 12);
for (const r of RECIPES) assert.ok(r.what && r.members.length === 2 && r.params.some((p) => p.startsWith("fit_gap")), `${r.name} is listed with its sizes`);

const runs: { name: string; payload: ModelPayload; ms: number }[] = [];
for (const name of JOINT_NAMES)
  for (const [label, input] of [
    ["defaults", {}],
    ["unusual", ODD[name]],
  ] as const) {
    const r = runRecipe(name, input);
    assert.ok(!("error" in r), `${name} ${label}: ${"error" in r ? r.error : ""}`);
    const m = r.payload;
    assert.equal(modelProblem(m), null, `${name} ${label} passes the limits`);
    const t0 = performance.now();
    const f = checkModel(m);
    runs.push({ name: `${name} (${label})`, payload: m, ms: performance.now() - t0 });
    assert.deepEqual(f.clashes, [], `${name} ${label}: no clash`);
    assert.deepEqual(f.floating, [], `${name} ${label}: nothing floating`);
    assert.deepEqual(f.cuts, [], `${name} ${label}: every cut removes something`);
    const want = SIZE[name](m.made_by!.params);
    f.size_mm.forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 0.15, `${name} ${label}: overall size ${f.size_mm.join(" x ")}, expected ${want.map((w) => Math.round(w * 10) / 10).join(" x ")}`));
    assert.ok(m.parts.some((p) => p.apart && Math.hypot(...p.apart) > 0), `${name} ${label}: something pulls apart`);
    assert.ok((m.dims ?? []).length >= 2, `${name} ${label}: shows its sizes`);
    for (const d of m.dims ?? []) {
      const len = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1], d.b[2] - d.a[2]);
      assert.ok(len > 0, `${name}: a size has length`);
      if (d.text) assert.ok(Math.abs(Number.parseFloat(d.text) - len) < 0.5, `${name}: "${d.text}" is the true length ${len}`);
      if (d.part) assert.ok(m.parts.some((p) => p.id === d.part), `${name}: a size names a real part`);
    }
    // what it assumed is said: with nothing given, the members and every size are assumed
    if (label === "defaults") assert.ok(Object.keys(r.assumed).length >= 3, `${name}: it lists what it assumed`);
    // pulled apart: the moving parts come clear of the rest
    const apart = { parts: m.parts.map((p) => ({ ...p, at: p.apart ? ([0, 1, 2].map((i) => (p.at?.[i] ?? 0) + p.apart![i]) as [number, number, number]) : p.at })) };
    assert.deepEqual(checkModel(apart).clashes, [], `${name} ${label}: pulled apart, nothing overlaps`);
  }

// The mortise holds exactly the tenon (fit_gap 0): the volume taken from the post is what the rail keeps past its shoulder.
for (const input of [{}, ODD.mortise_tenon]) {
  const r = runRecipe("mortise_tenon", { ...input, params: { ...(input.params ?? {}), peg: false } });
  assert.ok(!("error" in r));
  const b = buildModel(r.payload);
  const post = b.parts.find((p) => p.id === "post")!,
    rail = b.parts.find((p) => p.id === "rail")!;
  const P = r.payload.made_by!.params;
  const [rw, rt] = sec(P, "rail");
  const mortise = post.stockVolume - post.volume;
  const tenon = rail.volume - n(P, "rail_length") * rw * rt;
  assert.ok(Math.abs(mortise - tenon) < 0.01, `mortise ${mortise} = tenon ${tenon}`);
  assert.ok(Math.abs(tenon - n(P, "tenon") * n(P, "length") * (rw - 2 * n(P, "shoulder"))) < 0.01);
}

// Three tails: a section through the joint, along its width, finds three runs of the tail board, and the volume agrees.
{
  const r = runRecipe("dovetail", { params: { tails: 3 } });
  assert.ok(!("error" in r));
  const P = r.payload.made_by!.params;
  const [W, tT] = sec(P, "tail_board");
  const tP = sec(P, "pin_board")[1];
  const tails = buildModel(r.payload).parts.find((p) => p.id === "tails")!;
  let runs = 0,
    inside = false;
  for (let z = 0.25; z < W; z += 0.5) {
    const now = contains(tails.polys, [-tP / 2, tT / 2, z]); // the joint turned a quarter: (x, y) is now (-y, x)
    if (now && !inside) runs++;
    inside = now;
  }
  assert.equal(runs, 3, "three tails across the section");
  const inJoint = tT * n(P, "tail_length") * W - tails.volume; // what the sockets took
  const tailsHand = tailVolume(W, tT, tP, 3, n(P, "slope"), n(P, "pin"));
  assert.ok(Math.abs(tT * tP * W - inJoint - tailsHand) < 0.01, "the tails' volume, worked out by hand, is what's left in the joint");
}

// fit_gap opens the joint along the moving part's way out, and nothing overlaps.
{
  const r = runRecipe("mortise_tenon", { params: { fit_gap: 4 } });
  assert.ok(!("error" in r));
  assert.deepEqual(r.payload.parts.find((p) => p.id === "rail")!.at, [4, 0, 0]);
  assert.deepEqual(checkModel(r.payload).clashes, []);
}

// Sizes that can't work come back in plain words, not thrown.
const refused: [string, Parameters<typeof runRecipe>[1], RegExp][] = [
  ["mortise_tenon", { params: { tenon: 50 } }, /can't work: the tenon is as thick as the rail, or thicker\.$/],
  ["mortise_tenon", { params: { length: 95 } }, /come out the far side of the post/],
  ["mortise_tenon", { params: { shoulder: 45 } }, /the shoulders leave no tenon/],
  ["mortise_tenon", { params: { type: "through", length: 60 } }, /goes right through the post, which is 90 wide/],
  ["mortise_tenon", { params: { peg: true, fit_gap: 2 } }, /can't be shown with the peg in/],
  ["dovetail", { params: { tails: 12 } }, /12 tails won't fit in 140/],
  ["dovetail", { members: [[140, 19], [120, 19]] }, /the same width/],
  ["half_lap", { params: { depth: 45 } }, /as deep as the first member is thick/],
  ["housing", { params: { depth: 19 } }, /the trench is as deep as the side is thick/],
  ["birdsmouth", { params: { seat: 120 } }, /a 120 seat is wider than the 90 plate/],
  ["birdsmouth", { params: { seat: 80, plumb_cut: 30 } }, /give the seat or the plumb cut, not both/],
  ["birdsmouth", { members: [[40, 45]], params: { pitch: 45 } }, /cut right through the rafter/],
  ["dowel", { members: [[90, 35]], params: { diameter: 40 } }, /the dowels are as thick as the rail/],
  ["dowel", { params: { count: 8 } }, /8 dowels of 10 won't fit across a 90 rail/],
  ["tongue_groove", { params: { tongue: 19 } }, /the tongue is as thick as the boards/],
  ["bridle", { params: { slot: 45 } }, /the slot is as wide as the post is thick/],
  ["scarf", { members: [[90, 45], [70, 45]] }, /the same section/],
  ["box_joint", { params: { finger: 100 } }, /fewer than two/],
  ["mitre", { params: { angle: 80 } }, /angle can be at most 75°/],
  ["butt", { params: { colour: "red" } }, /butt doesn't take "colour"\. It takes: layout, rail_length/],
  ["butt", { members: [[90, -45]] }, /needs a section \[width, thickness\]/],
  ["butt", { members: [[90, 45], [90, 45], [90, 45]] }, /joins 2 members: rail and post/],
  ["half_lap", { params: { layout: "diagonal" } }, /layout is one of: corner, tee, cross/],
];
for (const [name, input, re] of refused) {
  const r = runRecipe(name, input);
  assert.ok("error" in r, `${name} ${JSON.stringify(input)} is refused`);
  assert.match(r.error, re);
}
assert.match((runRecipe("shoji") as { error: string }).error, /There's no "shoji" joint\. The joints are: butt, mitre, half_lap/);

// The birdsmouth uses the Stage 8 roof maths: its notch and plumb depth are the calculator's figures.
{
  const r = runRecipe("birdsmouth", {});
  assert.ok(!("error" in r));
  assert.match(r.payload.note!, /22\.5° pitch: seat 90 on the plate, 37\.3 deep at the plumb cut/);
  assert.equal(roofGeometry({ run_mm: 90, pitch_deg: 22.5 }).rise_mm, 37.3);
}

const slowest = runs.reduce((a, b) => (b.ms > a.ms ? b : a));
console.log(`model-recipes: ok (24 runs; slowest check ${slowest.name}, ${Math.round(slowest.ms)} ms)`);
