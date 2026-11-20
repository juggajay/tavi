// A model that can't work is never shown (Stage 19.8). The checks: every fixing sits in a hole, never cutting into solid
// timber; it goes through at least two parts and across the face where they meet, not along it; solid parts don't
// overlap past a whisker; a hole with nothing in it is a warning. Three deck-post splices made up the way the recorded
// ones were (a scarf's bolts with no holes for them; bolts each in one half or along the joint; then bolts square across
// the splay through both halves): the first two are refused with the right words, the third passes. The scarf recipe's
// four kinds, with and without bolts, keys, wedges and fishplates, across their sizes: each one either refused in plain
// words or passing every check; the other recipes that place fixings (a pegged mortise and tenon, dowels) at their
// extremes pass too. The joint finder names and sizes each scarf kind from its faces (the made-up third splice too), and
// the deck post splice test piece's detail is its profile with the splice's length, its nibs and its bolts' spacing.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { checkModel } from "../../src/shared/model3d/check.js";
import { runRecipe } from "../../src/shared/model3d/recipes/index.js";
import { buildModel } from "../../src/shared/model3d/build.js";
import { analyseParts } from "../../src/shared/drawing/parts.js";
import { findAllJoints } from "../../src/shared/drawing/joints.js";
import { makeSet } from "../../src/shared/drawing/sheets.js";
import { checkSet } from "../../src/shared/drawing/checks.js";
import { TEST_PIECES } from "../../src/shared/drawing/testpieces.js";
import type { ModelPart, ModelPayload, Vec3 } from "../../src/shared/protocol.js";

/* ---------------- three made-up deck-post splices, as the recorded ones were built ---------------- */

// two 90 x 90 halves meeting on a splay from (30, 0) to (60, 360) with 30 square nibs; bolts M12 (r 6)
const lower = (cuts: ModelPart["cuts"] = []): ModelPart => ({ id: "lower", name: "Lower post", material: "hardwood", grain: "z", stock: { type: "prism", points: [[0, -400], [90, -400], [90, 360], [60, 360], [30, 0], [0, 0]], plane: "xz", depth: 90 }, cuts });
const upper = (cuts: ModelPart["cuts"] = []): ModelPart => ({ id: "upper", name: "Upper post", material: "hardwood", grain: "z", stock: { type: "prism", points: [[0, 0], [30, 0], [60, 360], [90, 360], [90, 760], [0, 760]], plane: "xz", depth: 90 }, cuts, apart: [0, 0, 150] });
const hole = (axis: "x" | "y", at: Vec3) => ({ type: "cyl" as const, r: 6, h: 130, axis, at });
const bolt = (name: string, axis: "x" | "y", at: Vec3): ModelPart => ({ id: name.toLowerCase().replace(/\W+/g, "-"), name, material: "steel", stock: { type: "cyl", r: 6, h: 110, axis, at } });
const bolts = (axis: "x" | "y", at: (z: number) => Vec3) => [bolt("Bolt M12 low", axis, at(90)), bolt("Bolt M12 mid", axis, at(180)), bolt("Bolt M12 high", axis, at(270))];

// 1: holes away from the joint, the bolts through solid timber
const first: ModelPayload = { parts: [lower([hole("y", [45, -20, -60])]), upper([hole("y", [45, -20, 420])]), ...bolts("y", (z) => [45, -10, z])] };
const f1 = checkModel(first);
assert.deepEqual(f1.errors, [
  "Bolt M12 low cuts into the lower post: there's no hole for it there.",
  "Bolt M12 mid cuts into the lower post: there's no hole for it there.",
  "Bolt M12 mid cuts into the upper post: there's no hole for it there.",
  "Bolt M12 high cuts into the upper post: there's no hole for it there.",
]);
assert.deepEqual(f1.warnings, ["The 12 hole in the lower post has nothing in it.", "The 12 hole in the upper post has nothing in it."]);

// 2: holes for them now, but the bolts run along y, in the plane of the splay: low only in the lower post, high only in
// the upper, the middle one along the joint
const second: ModelPayload = { parts: [lower([hole("y", [45, -20, 90]), hole("y", [45, -20, 180])]), upper([hole("y", [45, -20, 180]), hole("y", [45, -20, 270])]), ...bolts("y", (z) => [45, -10, z])] };
const f2 = checkModel(second);
assert.deepEqual(f2.errors, [
  "Bolt M12 low is only in the lower post; it has to go through both pieces it joins.",
  "Bolt M12 mid runs along the joint between the lower post and the upper post; it has to go through both.",
  "Bolt M12 high is only in the upper post; it has to go through both pieces it joins.",
]);

// 3: bolts along x, square across the splay, through both halves (the splice here from z 400 to 760)
const third: ModelPayload = {
  parts: [
    { ...lower(), stock: { type: "prism", points: [[0, 0], [90, 0], [90, 760], [60, 760], [30, 400], [0, 400]], plane: "xz", depth: 90 }, cuts: [490, 580, 670].map((z) => hole("x", [-20, 45, z])) },
    { ...upper(), stock: { type: "prism", points: [[0, 400], [30, 400], [60, 760], [90, 760], [90, 1160], [0, 1160]], plane: "xz", depth: 90 }, cuts: [490, 580, 670].map((z) => hole("x", [-20, 45, z])), apart: [-200, 0, 0] },
    ...[490, 580, 670].map((z, i) => bolt(`Bolt M12 ${["low", "mid", "high"][i]}`, "x", [-10, 45, z])),
  ],
};
const f3 = checkModel(third);
assert.deepEqual(f3.errors, [], "bolts square across the splay, through both halves");
assert.deepEqual(f3.warnings, []);

// solid parts overlapping: which two and roughly how much; a whisker is no error
const block = (id: string, x: number): ModelPart => ({ id, name: id === "a" ? "Leg" : "Rail", material: "pine", stock: { type: "box", size: [100, 50, 50] }, at: [x, 0, 0] });
assert.deepEqual(checkModel({ parts: [block("a", 0), block("b", 75)] }).errors, ["The leg and the rail overlap: about 25 mm into each other (25 x 50 x 50 mm)."]);
assert.deepEqual(checkModel({ parts: [block("a", 0), block("b", 99.8)] }).errors, []);

/* ---------------- the scarf recipe's kinds across their sizes ---------------- */

const ENGINEER = "A spliced post or beam carrying a floor or deck needs an engineer's detail.";
const built = new Map<string, number>();
let refused = 0;
const sections: [number, number][] = [
  [45, 45],
  [90, 90],
  [240, 90],
];
const kinds: [string, Record<string, unknown>[]][] = [
  ["plain", [{}, { slope: 2 }, { slope: 16 }]],
  ["stop_splayed", [{}, { nib: 3 }, { length: 3000, nib: 40 }]],
  ["tabled", [{ key: "key" }, { key: "wedges", table: 3 }, { key: "none" }]],
  ["halved", [{}, { length: 3000 }]],
];
for (const [kind, extras] of kinds)
  for (const sec of sections)
    for (const extra of extras)
      for (const fix of [{ bolts: 0 }, { bolts: 1 }, { bolts: 3 }, { bolts: 2, bolt_diameter: 24 }, { bolts: 1, plates: "timber" }, { bolts: 3, plates: "steel", bolt_diameter: 6 }]) {
        const params = { kind, ...extra, ...fix };
        const label = `${kind} ${sec.join(" x ")} ${JSON.stringify(params)}`;
        const r = runRecipe("scarf", { members: [sec, sec], params, material: "hardwood" });
        if ("error" in r) {
          refused++;
          assert.match(r.error, /^That scarf can't work: [a-z0-9].+\.$/, label);
          assert.doesNotMatch(r.error, /undefined|NaN/, label);
          continue;
        }
        const f = checkModel(r.payload);
        assert.deepEqual(f.errors, [], `${label}: nothing that stops it working`);
        assert.deepEqual(f.warnings, [], `${label}: every hole has its bolt`);
        assert.deepEqual(f.clashes.filter((c) => c.overlap_mm3 > 1), [], `${label}: no clashes`);
        assert.ok(r.payload.note!.length <= 200 && r.payload.note!.endsWith(ENGINEER), `${label}: the note says it needs an engineer (${r.payload.note})`);
        assert.doesNotMatch(r.payload.note!, /adequate|rated for|strong enough|certif/i, label);
        const nb = r.payload.parts.filter((p) => /^Bolt \d/.test(p.name)).length;
        assert.equal(nb, fix.bolts * (fix.plates ? 2 : 1), `${label}: the bolts asked for`);
        built.set(kind, (built.get(kind) ?? 0) + 1);
      }
for (const [kind] of kinds) assert.ok((built.get(kind) ?? 0) >= 8, `${kind}: built in plenty of sizes (${built.get(kind)})`);
assert.ok(refused > 0, "the impossible ones are refused");
// the words for what can't work
const why = (params: Record<string, unknown>, members: [number, number][] = [[90, 45], [90, 45]]) => {
  const r = runRecipe("scarf", { members, params });
  return "error" in r ? r.error : "";
};
assert.equal(why({ kind: "halved", bolts: 5 }), "That scarf can't work: 5 M12 bolts want a splice at least 288 long (4 diameters from each end and between bolts, a rule of thumb).");
assert.equal(why({ kind: "plain", bolts: 1, bolt_diameter: 16 }), "That scarf can't work: an M16 bolt wants a member at least 48 thick (1.5 diameters each side of it, a rule of thumb).");
assert.equal(why({ plates: "steel", bolts: 0 }), "That scarf can't work: fishplates need bolts through them; give at least one each side.");
assert.equal(why({ kind: "stop_splayed", length: 150 }), "That scarf can't work: a stop-splayed scarf wants at least twice the width, 180, to have a splay.");
assert.equal(why({ kind: "tabled", table: 88 }), "That scarf can't work: the table is as deep as the member.");
// the geometric defaults for these recipes: a plain scarf 1 in 8; the others 4 times the width, nibs and tables a quarter of it
const d = runRecipe("scarf", { members: [[90, 90], [90, 90]], params: { kind: "stop_splayed", bolts: 3 } });
assert.ok(!("error" in d));
assert.deepEqual([d.assumed.length, d.assumed.nib, d.assumed.bolt_diameter], [360, 23, 12]);
assert.equal(d.payload.note, `Stop-splayed scarf, 23 nibs, 360 long, 3 M12 bolts. Nibs stop it sliding; suits end-on load. Bolts spaced by rule of thumb. ${ENGINEER}`);
const plain = runRecipe("scarf", {});
assert.ok(!("error" in plain));
assert.equal(plain.assumed.length, 720, "the old plain scarf, unchanged: 1 in 8 of a 90 wide member");

// the other recipes that place fixings, at their extremes
const others: [string, { members?: [number, number][]; params: Record<string, unknown> }][] = [
  ["mortise_tenon", { params: { peg: true } }],
  ["mortise_tenon", { params: { peg: true, peg_diameter: 3 } }],
  ["mortise_tenon", { members: [[140, 70], [140, 140]], params: { peg: true, peg_diameter: 20, type: "through" } }],
  ["dowel", { params: { count: 1 } }],
  ["dowel", { params: { count: 8, diameter: 3 } }],
  ["dowel", { members: [[240, 45], [240, 45]], params: { count: 4, diameter: 12, depth: 40 } }],
];
for (const [name, input] of others) {
  const r = runRecipe(name, input);
  if ("error" in r) continue;
  const f = checkModel(r.payload);
  assert.deepEqual([f.errors, f.warnings], [[], []], `${name} ${JSON.stringify(input)}`);
}

/* ---------------- the drawings: each scarf named and sized from its faces ---------------- */

const joints = (m: ModelPayload) => {
  const b = buildModel(m);
  const { parts, marks } = analyseParts(m, b);
  return findAllJoints(m, b, parts, marks);
};
const one = (m: ModelPayload) => {
  const js = joints(m);
  assert.equal(js.insts.length, 1, js.insts.map((j) => j.name).join(", "));
  return js.insts[0];
};
const scarf = (members: [number, number][], params: Record<string, unknown>) => {
  const r = runRecipe("scarf", { members, params, material: "hardwood" });
  if ("error" in r) throw new Error(r.error);
  return one(r.payload);
};
{
  const j = scarf([[90, 90], [90, 90]], { kind: "stop_splayed", bolts: 3 });
  assert.deepEqual([j.kind, j.name, j.sizesText, j.fixNote], ["scarf", "STOP-SPLAYED SCARF, BOLTED", "360 LONG, NIBS 23", "3 / M12 x 120 BOLTS"]);
}
{
  const j = scarf([[90, 45], [90, 45]], { kind: "plain" });
  assert.deepEqual([j.name, j.sizesText, j.fixNote], ["SCARF", "1 IN 8, 720 LONG", "GLUED"]);
}
{
  const j = scarf([[140, 70], [140, 70]], { kind: "tabled", key: "wedges", bolts: 2 });
  assert.deepEqual([j.name, j.sizesText, j.fixNote], ["TABLED SCARF, WEDGED, BOLTED", "560 LONG, TABLE 35", "2 / 35 x 35 x 70 FOLDING WEDGES + 2 / M12 x 180 BOLTS"]);
}
{
  const j = scarf([[90, 45], [90, 45]], { kind: "tabled" });
  assert.deepEqual([j.name, j.fixNote], ["TABLED SCARF, KEYED", "1 / 23 x 23 x 45 KEY"]);
}
{
  // the plates and the bolts through them are all the one joint
  const j = scarf([[90, 45], [90, 45]], { kind: "halved", plates: "steel" });
  assert.deepEqual([j.name, j.sizesText, j.fixNote, j.fixings.length], ["HALVED SPLICE, STEEL FISHPLATES, BOLTED", "270 LONG, LAP 45 DEEP", "2 / 6 x 90 x 558 STEEL PLATES + 4 / M12 x 90 BOLTS", 6]);
}
{
  // drawn by hand, not by the recipe: still a scarf, found from its faces
  const j = one(third);
  assert.deepEqual([j.kind, j.name, j.sizesText, j.fixNote], ["scarf", "STOP-SPLAYED SCARF, BOLTED", "360 LONG, NIBS 30", "3 / M12 x 110 BOLTS"]);
}

// the deck post splice test piece: its detail is the scarf's profile, with the splice's length, the nibs and the bolts'
// spacing; a section across it through a bolt; every code check passes
{
  const t = TEST_PIECES.find((x) => x.id === "scarf")!;
  const set = makeSet({ model: t.payload, title: t.title, number: "CLO-SD-008", revision: "P1", status: "PRELIMINARY", revisions: [{ rev: "P1", date: "14.11.26", text: "Preliminary issue", by: "LH" }], project: t.project, client: t.client, drawn: "LH", date: "14.11.26", materials: { ...t.materials }, finish: t.finish });
  assert.equal(set.joints.types.length, 1);
  const jd = set.details[0];
  assert.equal(jd.views[0].role, "section");
  assert.deepEqual(
    jd.views[0].n.map((v) => Math.abs(v)),
    [0, 1, 0],
    "the profile: looking across the post, neither along it nor the way its halves step",
  );
  assert.equal(jd.views[1]?.role, "second", "and a section across it");
  const sizes = set.sheets.flatMap((s) => s.meta.dims.filter((dm) => jd.views.some((v) => v.id === dm.view)).map((dm) => dm.value));
  for (const v of [360, 23, 44, 48, 132]) assert.ok(sizes.some((x) => Math.abs(x - v) < 0.06), `the detail gives ${v} (${sizes.join(", ")})`);
  const cs = checkSet(set);
  const bad = cs.filter((c) => !c.ok && !["A1", "A16"].includes(c.id));
  assert.deepEqual(bad, [], "every code check passes");
  const sched = set.sheets.flatMap((s) => s.meta.jointSchedule ?? []);
  assert.deepEqual(
    sched.map((r) => [r.kind, r.places]),
    [["scarf", 1]],
  );
}
