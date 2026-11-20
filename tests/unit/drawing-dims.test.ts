// Shop drawings, the dimensions (Stage 12.2): from what the model knows (a part's ends and faces, its features' sides,
// a hole's centre), each size once, set out from a datum end, never to a hidden line. Checks A7 (dimension lines clear
// of each other and of the drawing), A8 (chains add up, nothing given twice) and A9 (nothing to a hidden line) on the
// gallery models and every joint recipe; and the mortise in the mortise-and-tenon example is set out from the post's
// end, then its length, then its width, each once.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { makeSet } from "../../src/shared/drawing/sheets.js";
import { checkSet, summary } from "../../src/shared/drawing/checks.js";
import { SAMPLE_MODELS } from "../../src/shared/model3d/samples.js";
import { JOINT_NAMES, runRecipe } from "../../src/shared/model3d/recipes/index.js";
import type { ModelPayload } from "../../src/shared/protocol.js";

const set = (model: ModelPayload, title: string) =>
  makeSet({ model, title, number: "TST-SD-001", revision: "P1", status: "PRELIMINARY", revisions: [{ rev: "P1", date: "13.11.26", text: "Preliminary issue", by: "LH" }], company: "Test Joinery", project: "Tests", client: "Nobody", drawn: "LH", date: "13.11.26" });

const models: { title: string; payload: ModelPayload }[] = [...SAMPLE_MODELS.map((s) => ({ title: s.title, payload: s.payload as ModelPayload })), ...JOINT_NAMES.map((n) => ({ title: n, payload: (runRecipe(n, {}) as { payload: ModelPayload }).payload }))];
for (const m of models) {
  const s = set(m.payload, m.title);
  const cs = checkSet(s).filter((c) => ["A7", "A8", "A9"].includes(c.id));
  assert.ok(cs.every((c) => c.ok), `${m.title}:\n${summary(cs)}`);
  assert.ok(s.sheets.reduce((t, sh) => t + sh.meta.dims.length, 0) > 0, `${m.title}: some sizes`);
}

// The mortise and tenon: the post's mortise set out from its end, then its length, along the post; across it, its width
const mt = set(SAMPLE_MODELS[0].payload as ModelPayload, "mt");
const post = mt.marks.find((k) => k.label === "POST")!;
const dims = mt.sheets.flatMap((sh) => sh.meta.dims);
// (a size the joint detail gives is on the post's view in brackets, for reference: Stage 19.2)
const along = dims.filter((d) => d.key.replace(/^ref:/, "").startsWith(`part${post.mark}:x:`)).sort((a, b) => a.line[0][0] - b.line[0][0]);
const m = post.first.features.find((f) => f.kind === "mortise")!;
const from = Math.min(m.box.min[0], post.first.L - m.box.max[0]);
assert.ok(along.some((d) => Math.abs(d.value - from) < 0.05), `the mortise is set out ${from} from the post's end`);
const len = m.box.max[0] - m.box.min[0];
assert.equal(dims.filter((d) => d.key === `part${post.mark}:x:${m.box.min[0]}:${m.box.max[0]}`).length, 1, `its length ${len} once (on the joint detail)`);
assert.ok(along.some((d) => d.overall && Math.abs(d.value - post.first.L) < 0.05), "and the post's overall length outside them");
// the chain along the post adds up to the overall
const postChain = along.find((x) => !x.overall && x.chain?.includes("=") && dims.some((y) => y.chain === x.chain && y.ref))!.chain;
const chainSum = along.filter((d) => !d.overall && d.chain === postChain).reduce((t, d) => t + d.value, 0);
assert.ok(Math.abs(chainSum - post.first.L) < 0.05, `the chain adds to ${post.first.L} (${chainSum})`);
// its width (across the post) once, wherever it's shown: on the post's view or in the section
const wz = m.box.max[2] - m.box.min[2],
  wy = m.box.max[1] - m.box.min[1];
const width = Math.min(wz, wy);
const across = dims.filter((d) => d.key.startsWith(`part${post.mark}:`) && !d.key.includes(":x:") && Math.abs(d.value - width) < 0.05);
assert.equal(across.length, 1, `the mortise's width ${width} once (${across.map((d) => d.key).join(", ")})`);
// no size anywhere in the set given twice
const keys = dims.filter((d) => !d.ref).map((d) => d.key);
assert.equal(new Set(keys).size, keys.length, "no size twice");
console.log("drawing dims: ok");
