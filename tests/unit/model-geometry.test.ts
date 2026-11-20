// 3D models (Stage 9.1): the shapes and the checks, in Node with no browser. A box minus a box has the right volume; a
// part turned 90° lands where it should; a tenon that fits its mortise has no clash, the same tenon 5 longer clashes
// naming both parts; a part moved away is floating; each limit is refused with its reason; and it's quick.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { buildModel, buildPart } from "../../src/shared/model3d/build.js";
import { checkModel, contains } from "../../src/shared/model3d/check.js";
import { MAX_PARTS, modelProblem } from "../../src/store/model.js";
import type { ModelPart, ModelPayload } from "../../src/shared/protocol.js";

const near = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);

// A box minus a box: 100 × 50 × 40 with a 30 × 20 × 40 notch through it.
const notched = buildPart({ id: "a", name: "Block", material: "pine", stock: { type: "box", size: [100, 50, 40] }, cuts: [{ type: "box", size: [30, 20, 50], at: [10, -1, -5] }] }, { mesh: true });
near(notched.stockVolume, 200_000);
near(notched.volume, 200_000 - 30 * 19 * 40);
assert.deepEqual(notched.cutEffects, []);
assert.ok(notched.mesh && notched.mesh.positions.length > 0 && notched.edges && notched.edges.length > 0, "it has triangles and edges to draw");
// a cylinder hole: close to πr²h (32 facets)
const holed = buildPart({ id: "h", name: "Plate", material: "steel", stock: { type: "box", size: [100, 100, 10] }, cuts: [{ type: "cyl", r: 20, h: 12, axis: "z", at: [50, 50, -1] }] });
near(holed.volume, 100_000 - 0.5 * 32 * 20 * 20 * Math.sin((2 * Math.PI) / 32) * 10, 1e-2);
// a prism: a dovetail-shaped socket through a board
const socket = buildPart({ id: "s", name: "Board", material: "oak", stock: { type: "box", size: [100, 20, 50] }, cuts: [{ type: "prism", plane: "xz", points: [[40, 30], [60, 30], [65, 51], [35, 51]], depth: 22, at: [0, -1, 0] }] });
near(socket.volume, 100_000 - ((20 + 20 + 2 * 5 * (20 / 21)) / 2) * 20 * 20, 1e-2);

// A cut that removes nothing, and one that removes the whole part, are named.
const odd = buildPart({ id: "o", name: "Odd", material: "pine", stock: { type: "box", size: [10, 10, 10] }, cuts: [{ type: "box", size: [5, 5, 5], at: [50, 50, 50] }, { type: "box", size: [20, 20, 20], at: [-5, -5, -5] }] });
assert.deepEqual(odd.cutEffects, [
  { cut: 1, problem: "removes nothing" },
  { cut: 2, problem: "removes the whole part" },
]);

// A part turned 90° about z lands where it should: a 100 long rail along x, turned, runs along y.
const turned = buildPart({ id: "r", name: "Rail", material: "pine", stock: { type: "box", size: [100, 10, 20] }, rot: [0, 0, 90], at: [500, 0, 0] });
assert.deepEqual(turned.bbox.min.map((v) => Math.round(v * 1e6) / 1e6), [490, 0, 0]);
assert.deepEqual(turned.bbox.max.map((v) => Math.round(v * 1e6) / 1e6), [500, 100, 20]);
assert.deepEqual(turned.size, [100, 10, 20], "its finished size is in its own frame");
// x then y then z: [90, 0, 90] puts the rail's length along y and its 20 depth along x
const both = buildPart({ id: "q", name: "Q", material: "pine", stock: { type: "box", size: [100, 10, 20] }, rot: [90, 0, 90] });
assert.deepEqual(both.bbox.max.map((v, i) => Math.round((v - both.bbox.min[i]) * 1e6) / 1e6), [20, 100, 10]);

// A mortise and tenon: a 90 × 90 post with a 15 × 70 mortise 60 deep; the rail's tenon 60 long fits it exactly.
function mt(tenon: number, railAt = 0): ModelPayload {
  const post: ModelPart = { id: "post", name: "Post", material: "hardwood", stock: { type: "box", size: [90, 90, 600], at: [-90, -45, 0] }, cuts: [{ type: "box", size: [61, 15, 70], at: [-60, -7.5, 265] }] };
  const rail: ModelPart = {
    id: "rail",
    name: "Rail",
    material: "hardwood",
    stock: { type: "box", size: [400 + tenon, 45, 90], at: [-tenon, -22.5, 255] },
    cuts: [
      { type: "box", size: [tenon + 1, 16, 92], at: [-tenon - 1, -23.5, 254] },
      { type: "box", size: [tenon + 1, 16, 92], at: [-tenon - 1, 7.5, 254] },
      { type: "box", size: [tenon + 1, 47, 11], at: [-tenon - 1, -23.5, 254] },
      { type: "box", size: [tenon + 1, 47, 11], at: [-tenon - 1, -23.5, 335] },
    ],
    at: [railAt, 0, 0],
    apart: [150, 0, 0],
  };
  return { parts: [post, rail] };
}
const fits = checkModel(mt(60));
assert.deepEqual(fits.clashes, [], "a tenon that fits has no clash");
assert.deepEqual(fits.floating, []);
assert.deepEqual(fits.size_mm, [490, 90, 600]);
const built = buildModel(mt(60));
const tenonVol = built.parts[1].volume - 400 * 45 * 90;
const mortiseVol = built.parts[0].stockVolume - built.parts[0].volume;
near(tenonVol, 60 * 15 * 70, 1e-2);
near(mortiseVol, 60 * 15 * 70, 1e-2);
const long = checkModel(mt(65));
assert.equal(long.clashes.length, 1, "5 too long clashes");
assert.deepEqual([long.clashes[0].a, long.clashes[0].b], ["Post", "Rail"]);
near(long.clashes[0].overlap_mm3, 5 * 15 * 70, 1);
assert.deepEqual(long.clashes[0].overlap_size_mm, [5, 15, 70]);
// moved 50 away: floating, both of them (two parts, neither touches)
const away = checkModel(mt(60, 50 + 60));
assert.deepEqual(away.floating, ["Post", "Rail"]);
// 0.4 off still counts as touching
assert.deepEqual(checkModel(mt(60, 0.4)).floating, []);
// a third part sitting on top of the post touches it; one 50 above floats
const cap = (z: number): ModelPart => ({ id: "cap", name: "Cap", material: "oak", stock: { type: "box", size: [120, 120, 20], at: [-105, -60, z] } });
assert.deepEqual(checkModel({ parts: [...mt(60).parts, cap(600)] }).floating, []);
assert.deepEqual(checkModel({ parts: [...mt(60).parts, cap(650)] }).floating, ["Cap"]);

// A section through a solid: contains() counts the inside.
const board = buildPart({ id: "b", name: "B", material: "pine", stock: { type: "box", size: [100, 20, 50] }, cuts: [{ type: "box", size: [20, 22, 51], at: [40, -1, 0] }] });
assert.ok(contains(board.polys, [10, 10, 25]) && !contains(board.polys, [50, 10, 25]) && contains(board.polys, [90, 10, 25]));

// The limits, each refused with its reason.
const okPart: ModelPart = { id: "p", name: "Part", material: "pine", stock: { type: "box", size: [10, 10, 10] } };
const parts = (n: number) => Array.from({ length: n }, (_, i) => ({ ...okPart, id: `p${i}` }));
assert.equal(modelProblem({ parts: parts(MAX_PARTS) }), null, "60 parts is fine");
assert.match(modelProblem({ parts: parts(61) })!, /That's 61 parts; a model takes 60 at most/);
assert.match(modelProblem({ parts: [{ ...okPart, cuts: Array.from({ length: 25 }, () => ({ type: "box", size: [1, 1, 1] })) }] })!, /^Part 1 \(Part\) \(cuts\): a part takes 24 cuts at most\.$/);
assert.match(modelProblem({ parts: [okPart], dims: Array.from({ length: 41 }, () => ({ a: [0, 0, 0], b: [1, 0, 0] })) })!, /That's 41 sizes; a model takes 40 at most/);
assert.match(modelProblem({ parts: [{ ...okPart, at: [0, Infinity, 0] }] })!, /must be a real number/);
assert.match(modelProblem({ parts: [{ ...okPart, at: [0, NaN, 0] }] })!, /must be a real number/);
assert.match(modelProblem({ parts: [{ ...okPart, at: [60_000, 0, 0] }] })!, /within ±50,000 mm/);
assert.match(modelProblem({ parts: [{ ...okPart, stock: { type: "box", size: [10, 0, 10] } }] })!, /^Part 1 \(Part\) \(stock\.size\.1\): must be above zero\.$/);
assert.match(modelProblem({ parts: [{ ...okPart, stock: { type: "cyl", r: -2, h: 10, axis: "z", at: [0, 0, 0] } }] })!, /must be above zero/);
assert.match(modelProblem({ parts: [{ ...okPart, name: "n".repeat(41) }] })!, /name is 40 characters at most/);
assert.match(modelProblem({ parts: [okPart], note: "n".repeat(201) })!, /the note is 200 characters at most/);
assert.match(modelProblem({ parts: [{ ...okPart, material: "gold" }] })!, /material must be pine, hardwood/);
assert.match(modelProblem({ parts: [okPart, okPart] })!, /"p" is used by two parts/);
assert.match(modelProblem({ parts: [okPart], dims: [{ a: [0, 0, 0], b: [1, 0, 0], part: "nope" }] })!, /^Size 1 \(part\): there's no part "nope"\.$/);
const prism = (points: [number, number][]) => ({ parts: [{ ...okPart, cuts: [{ type: "prism", plane: "xy", depth: 5, points }] }] });
assert.match(modelProblem(prism([[0, 0], [1, 1]]))!, /an outline needs 3 points at least/);
assert.match(modelProblem(prism(Array.from({ length: 25 }, (_, i) => [Math.cos(i), Math.sin(i)] as [number, number])))!, /24 points at most/);
// a bow tie crosses itself
assert.match(modelProblem(prism([[0, 0], [10, 10], [10, 0], [0, 10]]))!, /^Part 1 \(Part\), cut 1 \(points\): the outline crosses itself\.$/);
assert.match(modelProblem(prism([[0, 0], [5, 0], [10, 0]]))!, /no area/);
assert.equal(modelProblem(prism([[0, 0], [10, 0], [10, 10], [5, 3], [0, 10]])), null, "a notched (not convex) outline is fine");
// the concave prism builds to the right volume (area 100 - 35 = 65, times 5 deep)
near(buildPart({ id: "c", name: "C", material: "pine", stock: { type: "prism", plane: "xy", depth: 5, points: [[0, 0], [10, 0], [10, 10], [5, 3], [0, 10]] } }).volume, 65 * 5, 1e-6);

// Quick: a 20-part frame built and checked well under two seconds.
const frame: ModelPart[] = [];
for (let i = 0; i < 10; i++) frame.push({ id: `s${i}`, name: `Stud ${i + 1}`, material: "pine", stock: { type: "box", size: [45, 90, 2400] }, at: [i * 450, 0, 45], cuts: [{ type: "box", size: [47, 20, 30], at: [-1, -1, 1200] }] });
frame.push({ id: "bp", name: "Bottom plate", material: "pine", stock: { type: "box", size: [4095, 90, 45] } });
frame.push({ id: "tp", name: "Top plate", material: "pine", stock: { type: "box", size: [4095, 90, 45] }, at: [0, 0, 2445] });
for (let i = 0; i < 8; i++) frame.push({ id: `n${i}`, name: `Nogging ${i + 1}`, material: "pine", stock: { type: "box", size: [405, 90, 45] }, at: [45 + i * 450, 0, 1200] });
const t0 = performance.now();
const facts = checkModel({ parts: frame });
const ms = performance.now() - t0;
assert.equal(frame.length, 20);
assert.deepEqual(facts.clashes, []);
assert.deepEqual(facts.floating, []);
const t1 = performance.now();
buildModel({ parts: frame }, { mesh: true });
const meshMs = performance.now() - t1;
assert.ok(ms < 2000, `checks took ${Math.round(ms)} ms`);
console.log(`model-geometry: ok (20-part frame: checks ${Math.round(ms)} ms, meshes ${Math.round(meshMs)} ms)`);
