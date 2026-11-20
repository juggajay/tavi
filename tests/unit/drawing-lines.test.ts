// Shop drawings, the linework (Stage 12.1): hidden-line removal on the 3D models' solids. A box is its outline only; a
// through mortise is visible on the face and hidden from the side; a dowel hole is one true circle from the end and
// hidden lines from the side, never facets; two parts sharing a face show one line between them, one part's coplanar
// faces none; a section through a mortise and tenon gives two hatched regions that meet cleanly; every recipe and the
// gallery models draw in four views with no dangling or doubled lines; and a 60-part model is quick.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { buildModel } from "../../src/shared/model3d/build.js";
import { JOINT_NAMES, runRecipe } from "../../src/shared/model3d/recipes/index.js";
import { SAMPLE_MODELS } from "../../src/shared/model3d/samples.js";
import { ISO, VIEWS, danglingEnds, doubledLines, drawSection, drawView, partEdges, prepare, type ViewLines } from "../../src/shared/drawing/hlr.js";
import { TEST_PIECES } from "../../src/shared/drawing/testpieces.js";
import type { ModelPart, ModelPayload } from "../../src/shared/protocol.js";

const view = (m: ModelPayload, v: keyof typeof VIEWS | "iso", hidden = true) => drawView(prepare(buildModel(m)), v === "iso" ? ISO : VIEWS[v], { hidden: v === "iso" ? false : hidden });
const one = (p: Omit<ModelPart, "id" | "name" | "material">): ModelPayload => ({ parts: [{ id: "a", name: "A", material: "pine", ...p }] });
const lengthOf = (v: ViewLines, kind: string) =>
  v.chains.filter((c) => c.kind === kind).reduce((t, c) => t + c.pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - c.pts[i - 1][0], p[1] - c.pts[i - 1][1]) : s), 0) + (c.closed ? Math.hypot(c.pts[0][0] - c.pts[c.pts.length - 1][0], c.pts[0][1] - c.pts[c.pts.length - 1][1]) : 0), 0);
const clean = (v: ViewLines, what: string) => {
  assert.deepEqual(danglingEnds(v), [], `${what}: no line ends in mid-air`);
  assert.equal(doubledLines(v), 0, `${what}: no line drawn twice`);
};

// A box: exactly its outline, one closed line, nothing inside, from the front, top and side; in 3D its nine edges.
const box = one({ stock: { type: "box", size: [100, 60, 40] } });
for (const side of ["front", "top", "right"] as const) {
  const v = view(box, side);
  assert.equal(v.chains.length, 1, `box ${side}: one line`);
  assert.ok(v.chains[0].closed && v.chains[0].pts.length === 4 && v.chains[0].kind === "visible", `box ${side}: a closed rectangle`);
}
near(lengthOf(view(box, "front"), "visible"), 2 * (100 + 40));
const isoBox = view(box, "iso");
assert.equal(isoBox.chains.filter((c) => c.kind === "hidden").length, 0);
clean(isoBox, "box in 3D");

// A through mortise: seen from the top it's a rectangle of visible lines; from the front and the side, hidden lines.
const mortised = one({ stock: { type: "box", size: [200, 60, 80] }, cuts: [{ type: "box", size: [60, 20, 100], at: [70, 20, -10] }] });
const top = view(mortised, "top");
assert.equal(top.chains.filter((c) => c.kind === "visible" && c.closed).length, 2, "top: the outline and the mortise");
near(lengthOf(top, "visible"), 2 * (200 + 60) + 2 * (60 + 20));
assert.equal(lengthOf(top, "hidden"), 0);
const front = view(mortised, "front");
near(lengthOf(front, "hidden"), 2 * 80, 1e-3, "front: the mortise's two ends, hidden, full height");
near(lengthOf(front, "visible"), 2 * (200 + 80));
const side = view(mortised, "right");
near(lengthOf(side, "hidden"), 2 * 80, 1e-3, "side: the mortise's two sides, hidden");
for (const v of [top, front, side]) clean(v, "mortise");

// A dowel hole 10 across, 30 deep into the end: one circle from that end (no facets), hidden lines from the side.
const hole = one({ stock: { type: "box", size: [100, 60, 40] }, cuts: [{ type: "cyl", r: 5, h: 31, axis: "x", at: [-1, 30, 20] }] });
const fromEnd = view(hole, "left");
assert.equal(fromEnd.arcs.length, 1, "one circle");
assert.ok(fromEnd.arcs[0].a1 - fromEnd.arcs[0].a0 >= 2 * Math.PI - 1e-6 && Math.abs(fromEnd.arcs[0].r - 5) < 1e-6 && fromEnd.arcs[0].kind === "visible", "a whole visible circle, radius 5");
assert.equal(fromEnd.chains.length, 1, "and the outline: no facet lines");
const farEnd = view(hole, "right");
assert.equal(farEnd.arcs.length, 1);
assert.equal(farEnd.arcs[0].kind, "hidden", "from the far end the hole is a hidden circle");
const fromSide = view(hole, "front");
const hid = fromSide.chains.filter((c) => c.kind === "hidden");
near(lengthOf(fromSide, "hidden"), 30 + 30 + 10, 1e-3, "two hidden lines 30 long and the hole's bottom");
assert.ok(hid.length >= 1 && fromSide.arcs.length === 0, "no facets, no circles from the side");
clean(fromSide, "dowel hole from the side");
clean(fromEnd, "dowel hole from the end");

// Coplanar faces of one part show no line between them; two parts sharing a face show one line.
const stepped = one({ stock: { type: "box", size: [100, 50, 40] }, cuts: [{ type: "box", size: [30, 60, 20], at: [-1, -5, 25] }] });
const sf = view(stepped, "front");
assert.equal(sf.chains.filter((c) => c.kind === "visible").length, 1, "a notched block: one outline");
const two: ModelPayload = {
  parts: [
    { id: "a", name: "A", material: "pine", stock: { type: "box", size: [100, 50, 40] } },
    { id: "b", name: "B", material: "pine", stock: { type: "box", size: [80, 50, 40] }, at: [100, 0, 0] },
  ],
};
const tf = view(two, "front");
near(lengthOf(tf, "visible"), 2 * (180 + 40) + 40, 1e-3, "two blocks end to end: the outline and one line between them");
clean(tf, "two blocks");

// A section through a mortise and tenon: two hatched regions (the post round the mortise, the rail with its tenon) that
// meet cleanly: the tenon's loop and the mortise's notch share their edges exactly, no gaps, no stray pieces.
const mtr = runRecipe("mortise_tenon", {});
assert.ok("payload" in mtr);
const mt = buildModel(mtr.payload);
const z = 250; // through the middle of the tenon (rail 90 wide, centred on the 500 post)
const sec = drawSection(mt, { n: [0, 0, 1], w: z }, [0, 1, 0]);
assert.equal(sec.hatches.length, 2, "two regions");
assert.ok(sec.hatches.every((h) => h.loops.length === 1), "each one closed loop");
const area = (l: [number, number][]) => Math.abs(l.reduce((t, p, i) => t + p[0] * l[(i + 1) % l.length][1] - l[(i + 1) % l.length][0] * p[1], 0) / 2);
const [postA, railA] = [0, 1].map((i) => area(sec.hatches.find((h) => h.part === i)!.loops[0]));
near(postA, 90 * 90 - 60 * 15, 1e-3, "the post's cut: its square less the mortise");
near(railA, 360 * 45 + 60 * 15, 1e-3, "the rail's cut: its section along the length plus the tenon");
const keyOf = (p: [number, number]) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
const tenonCorners = sec.hatches.find((h) => h.part === 1)!.loops[0].map(keyOf);
const notchCorners = new Set(sec.hatches.find((h) => h.part === 0)!.loops[0].map(keyOf));
assert.ok(tenonCorners.filter((k) => notchCorners.has(k)).length >= 4, "the tenon's corners are the mortise's: they meet cleanly");
assert.ok(sec.chains.every((c) => c.kind === "cut"), "everything in the section is cut outline (nothing beyond shows above a flat floor)");
clean(sec, "section");

// Every recipe and the gallery models, in front, top, side and 3D: nothing dangling, nothing doubled.
const times: number[] = [];
for (const name of JOINT_NAMES) {
  const r = runRecipe(name, {});
  assert.ok(!("error" in r));
  const prep = prepare(buildModel(r.payload));
  for (const [vn, vd] of [["front", VIEWS.front], ["top", VIEWS.top], ["side", VIEWS.right], ["3D", ISO]] as const) {
    const v = drawView(prep, vd, { hidden: vn !== "3D" });
    times.push(v.ms);
    assert.ok(v.chains.length > 0, `${name} ${vn}: something drawn`);
    clean(v, `${name} ${vn}`);
  }
}
for (const s of SAMPLE_MODELS) {
  const prep = prepare(buildModel(s.payload));
  for (const vd of [VIEWS.front, VIEWS.top, VIEWS.right, ISO]) clean(drawView(prep, vd, { hidden: vd !== ISO }), s.title);
}

// Speed: a 60-part model (a deck frame: bearers, joists with notches, posts with holes), four views, under 5 seconds.
const parts: ModelPart[] = [];
for (let i = 0; i < 20; i++) parts.push({ id: `j${i}`, name: `Joist ${i + 1}`, material: "pine", stock: { type: "box", size: [45, 3600, 140] }, cuts: [{ type: "box", size: [47, 50, 20], at: [-1, 300, -1] }, { type: "box", size: [47, 50, 20], at: [-1, 3250, -1] }], at: [i * 450, 0, 200] });
for (let i = 0; i < 20; i++) parts.push({ id: `p${i}`, name: `Post ${i + 1}`, material: "pine", stock: { type: "box", size: [90, 90, 200] }, cuts: [{ type: "cyl", r: 6, h: 92, axis: "y", at: [45, -1, 100] }], at: [(i % 10) * 900, i < 10 ? 280 : 3230, 0] });
for (let i = 0; i < 20; i++) parts.push({ id: `b${i}`, name: `Block ${i + 1}`, material: "pine", stock: { type: "box", size: [405, 45, 140] }, at: [i * 450 + 45, 1800, 200] });
const t0 = performance.now();
const prep60 = prepare(buildModel({ parts }));
for (const vd of [VIEWS.front, VIEWS.top, VIEWS.right, ISO]) drawView(prep60, vd, { hidden: vd !== ISO });
const ms60 = performance.now() - t0;
console.log(`60 parts, built and drawn in four views: ${ms60.toFixed(0)} ms; recipes: slowest view ${Math.max(...times).toFixed(1)} ms`);
assert.ok(ms60 < 5000, `60 parts in four views took ${ms60.toFixed(0)} ms`);

// A bolt hole the cutting left in pieces (a corner on a facet's chord) is still one round face, so seen side-on it's
// two hidden lines, not a band of facet edges (found in the 12.8 round 5 pictures: the pergola's beam, four holes).
{
  const perg = TEST_PIECES.find((t) => t.id === "pergola")!;
  const built = buildModel(perg.payload);
  built.parts.forEach((p, i) => {
    if (!/^Beam/.test(p.name)) return;
    assert.equal(partEdges(p.polys, i).faces.filter((f) => f.cyl).length, 4, `${p.name}: four holes, four round faces`);
  });
}

function near(a: number, b: number, tol = 1e-3, what = "") {
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not ${b}`);
}
console.log("drawing lines: ok");
