// Sketches the assistant draws (Stage 8.5 Part A): the limits refuse with a plain reason, a dimension without text gets
// its true length, a good sketch is kept as an item, and the voice is told what's on screen in one line.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { dimLength, MAX_SHAPES, sketchProblem } from "../../src/store/sketch.js";
import { showSketch, showTools } from "../../src/brain/showTools.js";
import { newTurn, newTurnCtx } from "../../src/brain/turn.js";
import { getItem } from "../../src/store/items.js";
import { describeItem } from "../../src/gateway/surface.js";
import { SAMPLE_SKETCHES } from "../../src/shared/sketches.js";
import type { SketchShape } from "../../src/shared/protocol.js";

const line: SketchShape = { type: "line", a: [0, 0], b: [1000, 0] };

// The limits, each with a plain reason.
assert.match(sketchProblem({ shapes: Array.from({ length: MAX_SHAPES + 1 }, () => line) })!, /That's 201 shapes; a sketch takes 200 at most/);
assert.equal(sketchProblem({ shapes: Array.from({ length: MAX_SHAPES }, () => line) }), null, "200 is fine");
assert.match(sketchProblem({ shapes: [line, { type: "line", a: [0, Infinity], b: [1, 1] }] })!, /^Shape 2 \(a\.1\): must be a real number\.$/);
assert.match(sketchProblem({ shapes: [{ type: "line", a: [0, NaN], b: [1, 1] }] })!, /must be a real number/);
assert.match(sketchProblem({ shapes: [{ type: "line", a: [0, 0], b: [250_000, 0] }] })!, /within ±200,000 mm/);
assert.match(sketchProblem({ shapes: [{ type: "label", at: [0, 0], text: "x".repeat(61) }] })!, /text is 60 characters at most/);
assert.match(sketchProblem({ shapes: [line], note: "n".repeat(201) })!, /the note is 200 characters at most/);
assert.match(sketchProblem({ shapes: [{ type: "rect", x: 0, y: 0, w: -5, h: 10 }] })!, /must be above zero/);
assert.match(sketchProblem({ shapes: [{ type: "blob", at: [0, 0] }] })!, /^Shape 1/);
assert.match(sketchProblem({ shapes: [] })!, /at least one shape/);
for (const s of SAMPLE_SKETCHES) assert.equal(sketchProblem(s.payload), null, `${s.title} passes`);

// A dimension without text: the true length in whole millimetres.
assert.equal(dimLength([0, 0], [3000, 4000]), 5000);
assert.equal(dimLength([0, 0], [0, 151.5]), 152);
const plumb = SAMPLE_SKETCHES[0].payload.shapes.find((s) => s.type === "dim" && !s.text) as Extract<SketchShape, { type: "dim" }>;
assert.ok(plumb, "the rafter example has a dimension left for the app to write");
assert.equal(dimLength(plumb.a, plumb.b), 152);

// Showing one: kept as an item; a bad one comes back with the reason, nothing shown.
const turn = newTurn({ origin: { client: "phone", id: "phone-sketch" } });
const r = showSketch(turn, { title: "Rafter birdsmouth", shapes: [...SAMPLE_SKETCHES[0].payload.shapes], note: SAMPLE_SKETCHES[0].payload.note });
assert.ok("item" in r);
const item = getItem(r.item.id)!;
assert.equal(item.kind, "sketch");
assert.equal(describeItem(item), `a sketch: Rafter birdsmouth, four dimensions [item ${item.id}]`);
const bad = showSketch(turn, { title: "Too many", shapes: Array.from({ length: 201 }, () => line) });
assert.ok("error" in bad && /201 shapes/.test(bad.error));
assert.equal(turn.items.length, 1, "a refused sketch shows nothing");

// The tool, as the brain calls it; allowed in a test turn (it only shows).
const ctx = { ...newTurnCtx(), test: true, turn: newTurn({ persist: false }) };
const tool = showTools(ctx).find((t) => t.name === "show_sketch")!;
const out = JSON.parse(((await tool.handler({ title: "Stair", shapes: [...SAMPLE_SKETCHES[1].payload.shapes] }, {})) as { content: { text: string }[] }).content[0].text);
assert.deepEqual(out, { shown: "Stair", shapes: SAMPLE_SKETCHES[1].payload.shapes.length, dimensions: 4 });

console.log("sketch: ok");
