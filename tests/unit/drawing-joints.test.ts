// Joints (Stage 19.1): every place parts meet, found from the model's solids, named from what is cut, sized from the
// cuts, and grouped into joint types with a count. Small models built here for each kind (blind, through and haunched
// mortise and tenon, housing, rebate, groove with a panel, halving, notch, birdsmouth from its recipe, dowelled, bolted,
// screwed, butt, and one the code can't name); a rail into a post with a through bolt is one joint with its fixing; and
// on the eight test pieces the count of joints found equals a count worked out by hand.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { buildModel } from "../../src/shared/model3d/build.js";
import { analyseParts } from "../../src/shared/drawing/parts.js";
import { findAllJoints, type JointSet } from "../../src/shared/drawing/joints.js";
import { TEST_PIECES } from "../../src/shared/drawing/testpieces.js";
import { runRecipe } from "../../src/shared/model3d/recipes/index.js";
import type { ModelPart, ModelPayload, Solid, Vec3 } from "../../src/shared/protocol.js";

const span = (a: Vec3, b: Vec3): Solid => ({ type: "box", size: [b[0] - a[0], b[1] - a[1], b[2] - a[2]], at: a });
const box = (size: Vec3): Solid => ({ type: "box", size });
const joints = (m: ModelPayload): JointSet => {
  const built = buildModel(m);
  const { parts, marks } = analyseParts(m, built);
  return findAllJoints(m, built, parts, marks);
};
const one = (m: ModelPayload) => {
  const js = joints(m);
  assert.equal(js.insts.length, 1, `one joint (${js.insts.map((j) => j.name).join(", ")})`);
  return js.insts[0];
};
const near = (a: number | undefined, b: number, what: string) => assert.ok(a !== undefined && Math.abs(a - b) < 0.05, `${what}: ${a} (want ${b})`);

// a 90 x 90 post 500 high; a 90 x 45 rail coming in from +x, its tenon 15 thick, 60 wide (15 shoulders), `len` long
const post = (cuts: Solid[] = []): ModelPart => ({ id: "post", name: "Post", material: "hardwood", grain: "z", stock: box([90, 90, 500]), cuts });
const rail = (len: number, extra: Partial<ModelPart> = {}): ModelPart => ({
  id: "rail",
  name: "Rail",
  material: "hardwood",
  grain: "x",
  stock: box([400 + len, 45, 90]),
  cuts: [span([-1, -1, -1], [len, 15, 91]), span([-1, 30, -1], [len, 46, 91]), span([-1, -1, -1], [len, 46, 15]), span([-1, -1, 75], [len, 46, 91])],
  at: [90 - len, 22.5, 200],
  ...extra,
});
// the mortise: 15 wide (y 37.5..52.5), 60 long (z 215..275), `depth` in from the post's +x face
const mortise = (depth: number) => span([90 - depth, 37.5, 215], [91, 52.5, 275]);

// a blind mortise and tenon: 50 long into a 52 mortise (2 clear)
{
  const j = one({ parts: [post([mortise(52)]), rail(50)] });
  assert.equal(j.kind, "mortise and tenon");
  assert.equal(j.name, "MORTISE AND TENON");
  near(j.sizes.len, 50, "tenon length");
  near(j.sizes.depth, 52, "mortise depth");
  near(j.sizes.gap, 2, "clear at the bottom");
  near(j.sizes.inU, 60, "tenon width");
  near(j.sizes.inV, 15, "tenon thickness");
  near(j.sizes.shU1, 15, "shoulder");
  near(j.sizes.shV1, 15, "cheek shoulder");
  near(j.sizes.fromV, 37.5, "set out from the face");
  assert.deepEqual(j.d, [1, 0, 0], "it comes out along the rail");
  assert.equal(j.fixNote, "FIXING TBC");
  assert.match(j.sizesText, /^TENON 15 x 60 x 50 LONG, 2 CLEAR$/);
}
// a through mortise and tenon
{
  const j = one({ parts: [post([span([-1, 37.5, 215], [91, 52.5, 275])]), rail(90)] });
  assert.equal(j.name, "THROUGH MORTISE AND TENON");
  near(j.sizes.len, 90, "tenon length");
  assert.equal(j.sizes.gap, undefined);
}
// haunched: the door's rails into its stiles (the haunch fills the stile's groove to its end)
{
  const door = joints(TEST_PIECES.find((t) => t.id === "door")!.payload);
  const top = door.types.find((t) => t.title === "TOP RAIL TO STILE")!;
  assert.equal(top.name, "HAUNCHED MORTISE AND TENON");
  assert.equal(top.insts.length, 2);
  near(top.insts[0].sizes.haunch, 15, "haunch length");
  near(top.insts[0].sizes.haunchW, 35, "haunch width");
  near(top.insts[0].sizes.inU, 60, "tenon width past the haunch");
  assert.match(top.sizesText, /^TENON 12 x 60 x 75 LONG, 2 CLEAR, HAUNCH 15 x 35$/);
  assert.equal(top.fixNote, "GLUED", "the model's note says the frame is glued");
  const panel = door.types.find((t) => t.kind === "groove")!;
  assert.equal(panel.insts.length, 8, "a panel in each of its four grooves, twice");
  assert.match(panel.title, /^PANEL TO /);
  assert.match(panel.sizesText, /^GROOVE 12 x 15 DEEP, 2 CLEAR$/);
  assert.equal(panel.fixNote, "FLOATING, NO GLUE");
  const mull = door.types.find((t) => t.title.startsWith("MULLION"))!;
  assert.equal(mull.kind, "mortise and tenon");
  assert.equal(mull.insts.length, 2, "into the top rail and the bottom rail: one type");
}
// a housing: a shelf into a cabinet side, 9 deep
{
  const side: ModelPart = { id: "side", name: "Side", material: "ply", stock: box([18, 300, 600]), cuts: [span([9, -1, 300], [19, 301, 318])] };
  const shelf: ModelPart = { id: "shelf", name: "Shelf", material: "ply", stock: box([500, 300, 18]), at: [9, 0, 300] };
  const j = one({ parts: [side, shelf] });
  assert.equal(j.kind, "housing");
  near(j.sizes.depth, 9, "housing depth");
  assert.match(j.sizesText, /^HOUSING 18 x 9 DEEP$/);
  assert.equal(j.host, 0, "the side is let into");
}
// a rebate: a 6 back in a 6 x 9 rebate
{
  const side: ModelPart = { id: "side", name: "Side", material: "ply", stock: box([18, 300, 600]), cuts: [span([9, 294, -1], [19, 301, 601])] };
  const back: ModelPart = { id: "back", name: "Back", material: "ply", stock: box([300, 6, 600]), at: [9, 294, 0] };
  const j = one({ parts: [side, back] });
  assert.equal(j.kind, "rebate");
  assert.match(j.sizesText, /^REBATE 9 x 6 DEEP$/);
  assert.deepEqual(j.d, [0, 1, 0], "the back comes off the back");
}
// a groove with a panel in it
{
  const rl: ModelPart = { id: "rail", name: "Rail", material: "hardwood", grain: "x", stock: box([600, 30, 80]), cuts: [span([-1, 9, 65], [601, 21, 81])] };
  const pn: ModelPart = { id: "panel", name: "Panel", material: "ply", stock: box([600, 12, 300]), at: [0, 9, 70] };
  const j = one({ parts: [rl, pn] });
  assert.equal(j.kind, "groove");
  near(j.sizes.depth, 15, "groove depth");
  near(j.sizes.gap, 5, "clear at its bottom");
}
// a halving: two boards crossing, each cut half its depth
{
  const a: ModelPart = { id: "a", name: "Rail", material: "pine", grain: "x", stock: box([600, 45, 90]), cuts: [span([280, -1, 45], [325, 46, 91])] };
  const b: ModelPart = { id: "b", name: "Cross rail", material: "pine", grain: "y", stock: box([45, 600, 90]), cuts: [span([-1, 280, -1], [46, 325, 45])], at: [280, -280, 0] };
  const j = one({ parts: [a, b] });
  assert.equal(j.kind, "halving");
  near(j.sizes.len, 45, "lap depth");
}
// a notch: a rafter notched 20 over a beam
{
  const beam: ModelPart = { id: "beam", name: "Beam", material: "pine", grain: "x", stock: box([1200, 45, 190]) };
  const raf: ModelPart = { id: "raf", name: "Rafter", material: "pine", grain: "y", stock: box([45, 1000, 140]), cuts: [span([-1, 300, -1], [46, 345, 20])], at: [500, -300, 170] };
  const j = one({ parts: [beam, raf] });
  assert.equal(j.kind, "notch");
  assert.equal(j.host, 1, "the rafter is the one cut");
  near(j.sizes.depth, 20, "notch depth");
}
// a birdsmouth, named from its recipe
{
  const r = runRecipe("birdsmouth", {});
  assert.ok("payload" in r);
  assert.equal(one(r.payload).kind, "birdsmouth");
}
// dowelled: two boards end to face with two dowels through both
{
  const a: ModelPart = { id: "a", name: "Rail", material: "pine", grain: "x", stock: box([300, 20, 90]), cuts: [30, 60].map((z) => ({ type: "cyl" as const, r: 4, h: 31, axis: "x" as const, at: [-1, 10, z] as Vec3 })) };
  const b: ModelPart = { id: "b", name: "Leg", material: "pine", grain: "z", stock: box([40, 20, 400]), cuts: [30, 60].map((z) => ({ type: "cyl" as const, r: 4, h: 21, axis: "x" as const, at: [20, 10, z + 100] as Vec3 })), at: [-40, 0, -100] };
  const dowels: ModelPart[] = [30, 60].map((z, i) => ({ id: `d${i}`, name: "Dowel", material: "oak", stock: { type: "cyl", r: 4, h: 50, axis: "x", at: [0, 0, 0] }, at: [-20, 10, z] }));
  const js = joints({ parts: [a, b, ...dowels] });
  assert.equal(js.insts.length, 1, "the two dowels are part of the one joint");
  const j = js.insts[0];
  assert.equal(j.kind, "dowelled");
  assert.equal(j.fixings.length, 2);
  assert.equal(j.fixNote, "2 / Ø8 x 50 DOWELS");
}
// a rail into a post with a through bolt: three parts, one joint, the bolt its fixing
{
  const p = post([span([80, 22.5, 200], [91, 67.5, 290]), { type: "cyl", r: 6, h: 92, axis: "x", at: [-1, 45, 245] }]);
  const r: ModelPart = { id: "rail", name: "Rail", material: "hardwood", grain: "x", stock: box([400, 45, 90]), cuts: [{ type: "cyl", r: 6, h: 46, axis: "x", at: [-1, 22.5, 45] }], at: [80, 22.5, 200] };
  const bolt: ModelPart = { id: "bolt", name: "Bolt", material: "steel", stock: { type: "cyl", r: 6, h: 135, axis: "x", at: [0, 0, 0] }, at: [0, 45, 245] };
  const js = joints({ parts: [p, r, bolt] });
  assert.equal(js.insts.length, 1, `one joint: ${js.insts.map((j) => j.name)}`);
  const j = js.insts[0];
  assert.deepEqual([...j.parts].sort(), [0, 1, 2]);
  assert.equal(j.kind, "housing");
  assert.equal(j.name, "HOUSING, BOLTED");
  assert.equal(j.fixNote, "1 / M12 x 135 BOLT");
}
// screwed: two boards face to face with a screw through
{
  const a: ModelPart = { id: "a", name: "Cleat", material: "pine", grain: "x", stock: box([300, 19, 42]), cuts: [{ type: "cyl", r: 2.5, h: 21, axis: "y", at: [150, -1, 21] }] };
  const b: ModelPart = { id: "b", name: "Board", material: "pine", grain: "x", stock: box([300, 19, 140]), cuts: [{ type: "cyl", r: 2.5, h: 32, axis: "y", at: [150, -1, 21] }], at: [0, 19, 0] };
  const sc: ModelPart = { id: "s", name: "Screw", material: "steel", stock: { type: "cyl", r: 2.5, h: 50, axis: "y", at: [0, 0, 0] }, at: [150, 0, 21] };
  const j = one({ parts: [a, b, sc] });
  assert.equal(j.kind, "screwed");
  assert.equal(j.fixNote, "1 / Ø5 x 50 SCREW");
}
// a plain butt: nothing cut, end to face
{
  const a: ModelPart = { id: "a", name: "Top", material: "pine", grain: "x", stock: box([600, 300, 19]), at: [0, 0, 400] };
  const b: ModelPart = { id: "b", name: "Leg", material: "pine", grain: "z", stock: box([45, 45, 400]) };
  const j = one({ parts: [a, b] });
  assert.equal(j.kind, "butt");
  assert.equal(j.faces, "END TO FACE");
  assert.equal(j.host, 0, "the leg meets the top");
}
// one the code can't name: a block's tenon sat in a board's rebate. Listed, with what is cut
{
  const board: ModelPart = { id: "board", name: "Board", material: "pine", grain: "x", stock: box([300, 40, 100]), cuts: [span([-1, 30, 80], [301, 41, 101])] };
  const block: ModelPart = { id: "block", name: "Block", material: "pine", grain: "z", stock: box([50, 40, 80]), cuts: [span([-1, -1, -1], [51, 30, 20])], at: [125, 0, 80] };
  const j = one({ parts: [board, block] });
  assert.equal(j.kind, "unnamed");
  assert.match(String(j.what), /REBATE IN BOARD.*TENON IN BLOCK/);
  const js = joints({ parts: [board, block] });
  assert.match(js.types[0].title, /BLOCK TO BOARD/);
}

// grouping: identical joints are one type with the right count
{
  const table = joints(TEST_PIECES[1].payload);
  const mt = table.types.find((t) => t.kind === "mortise and tenon")!;
  assert.equal(mt.insts.length, 8, "8 places");
  assert.equal(mt.title, "APRON & END APRON TO LEG");
  assert.match(mt.sizesText, /^TENON 10 x 90 x 30 LONG$/);
  const cab = joints(TEST_PIECES[2].payload);
  assert.deepEqual(
    cab.types.map((t) => `${t.title} ${t.name} ${t.insts.length}`),
    ["BOTTOM & SHELF TO SIDE HOUSING 6", "TOP TO SIDE HOUSING 2", "BACK TO SIDE REBATE 2", "BOTTOM, SHELF & TOP TO BACK BUTT 4"],
    "the top's housing is 18 from the side's end, so its detail shows that: a type of its own",
  );
  const perg = joints(TEST_PIECES[3].payload);
  const slot = perg.types.find((t) => t.title === "BEAM TO POST")!;
  assert.equal(slot.fixNote, "2 / M12 x 90 BOLTS");
  assert.equal(slot.insts.length, 4);
  assert.equal(perg.types.find((t) => t.kind === "notch")!.insts.length, 10);
  // more than six butt types: those go in the schedule only (no letter)
  const tv = joints(TEST_PIECES[4].payload);
  assert.ok(tv.buttsInScheduleOnly);
  assert.ok(tv.types.filter((t) => t.butt).every((t) => t.letter === null) && tv.types.filter((t) => !t.butt).every((t) => t.letter));
  assert.ok(!table.buttsInScheduleOnly && table.types.every((t) => t.letter));
}

// the eight test pieces: joints found = joints counted by hand
const BY_HAND: Record<string, number> = {
  // rail into post (the peg its fixing)
  mt: 1,
  // 8 apron ends into legs, 4 legs under the top, 4 aprons under the top
  table: 16,
  // 8 housings (bottom, 2 shelves, top, each side), the back in 2 rebates, the back against bottom, 2 shelves, top
  cabinet: 14,
  // 4 beams in post slots (2 bolts each, part of those joints), 5 rafters notched over 2 beams
  pergola: 14,
  // carcass 20: bottom and shelf into each end (4), back in 2 rebates, ends under the top (2), divider into the bottom,
  // divider under the top, shelves against the divider (2), bottom, shelves, divider and top against the back (5), kick
  // under the bottom and between the ends (3). Each drawer 7: its bottom in 2 grooves, its back between the sides (2),
  // the sides and bottom against the front (3); the back sits above the bottom's edge, touching it only along a line.
  // Doors and drawer fronts closing against the carcass aren't joints.
  tv: 34,
  // each of 3 levels: 2 shelves housed into the post, the 2 shelves lapped
  corner: 9,
  // 2 rails into 2 stiles, the mullion into 2 rails, each panel in 4 grooves
  door: 14,
  // the two lengths of post in their scarf (its three bolts part of it)
  scarf: 1,
};
for (const t of TEST_PIECES) {
  const js = joints(t.payload);
  assert.equal(js.insts.length, BY_HAND[t.id], `${t.id}: ${js.insts.length} joints found, ${BY_HAND[t.id]} by hand`);
  assert.ok(js.types.every((ty) => ty.insts.length >= 1));
  assert.equal(
    js.types.reduce((s, ty) => s + ty.insts.length, 0),
    js.insts.length,
    `${t.id}: every joint in one type`,
  );
}
console.log("drawing joints: ok");
