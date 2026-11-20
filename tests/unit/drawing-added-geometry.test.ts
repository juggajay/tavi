import "../isolate.js";
import assert from "node:assert/strict";
import { makeSet, AREA, type SetInput } from "../../src/shared/drawing/sheets.js";
import { TEST_PIECES } from "../../src/shared/drawing/testpieces.js";
import { AddedError, applyAdded, featureChoices, resolveFeature, type AddedDimension } from "../../src/shared/drawing/added.js";
import { checkSet, summary } from "../../src/shared/drawing/checks.js";
import { readDxf, setDxf } from "../../src/shared/drawing/dxf.js";
import { text } from "../../src/shared/drawing/render.js";

const input = (id: string, extra: Partial<SetInput> = {}): SetInput => {
  const t = TEST_PIECES.find((t) => t.id === id) ?? TEST_PIECES[0];
  return { model: t.payload, title: t.title, number: "TST-SD-001", revision: "P1", status: "PRELIMINARY", revisions: [{ rev: "P1", date: "19.11.26", text: "First issue", by: "LH" }], project: t.project, client: t.client, drawn: "LH", date: "19.11.26", materials: t.materials, finish: t.finish, ...extra };
};
const passes = (s: ReturnType<typeof makeSet>) => {
  const checks = checkSet(s, { dxf: readDxf(setDxf(s)) });
  assert.ok(checks.every((c) => c.ok), summary(checks));
};
const faces: AddedDimension = { id: "faces", kind: "dimension", sheet: 1, view: "G1", from: { part: 1, feature: "left" }, to: { part: 2, feature: "right" }, label: "between faces" };
const first = makeSet(input("mortise"));
const earlier = JSON.stringify(first.sheets);
const measured = makeSet(input("mortise", { additions: [faces] }));
const d = measured.sheets[0].meta.dims.find((d) => d.chain === "added:faces")!;
const modelDistance = measured.built.parts[1].bbox.max[0] - measured.built.parts[0].bbox.min[0];
assert.equal(d.value, modelDistance);
assert.equal(d.value, 450);
assert.ok(measured.sheets[0].prims.some((p) => p.t === "text" && p.s === "450 between faces"));
assert.equal(JSON.stringify(first.sheets), earlier, "the old drawing stays as it was");
passes(measured);
assert.throws(() => makeSet(input("mortise", { additions: [faces, { ...faces, id: "same", from: faces.to, to: faces.from }] })), /already added/);

const holes: AddedDimension = { id: "holes", kind: "dimension", sheet: 3, view: "p1", from: { part: 1, feature: "hole:1" }, to: { part: 1, feature: "hole:3" } };
const drilled = makeSet(input("pergola", { additions: [holes] }));
const holePoints = drilled.marks[0].first.features.filter((f) => f.hole).map((f) => f.hole!.c);
assert.equal(drilled.sheets[2].meta.dims.find((d) => d.chain === "added:holes")!.value, Math.abs(holePoints[2][0] - holePoints[0][0]));
assert.equal(drilled.sheets[2].meta.dims.at(-1)!.value, 3000, "a shortened picture still measures the full model");
passes(drilled);

const diagonal: AddedDimension = { id: "diagonal", kind: "dimension", sheet: 3, view: "p1", from: { part: 1, feature: "corner:tl" }, to: { part: 1, feature: "corner:br" } };
const across = makeSet(input("table", { additions: [diagonal] }));
assert.equal(across.sheets[2].meta.dims.at(-1)!.value, 1700);
assert.ok(across.sheets[2].prims.some((p) => p.t === "text" && p.s === "1700 (1500 x 800)"));
passes(across);

// A size inside a joint section leaves a gap in the hatching, like the existing sizes.
const detail = makeSet(input("table", { additions: [{ id: "detail", kind: "dimension", sheet: 5, view: "A1", from: { part: 2, feature: "corner:bl" }, to: { part: 2, feature: "cut:1" } }] }));
assert.equal(detail.sheets[4].meta.dims.at(-1)!.value, Math.hypot(55, 26));
passes(detail);

const top = makeSet(input("table"));
const v = top.sheets[2].meta.views.find((v) => v.id === "p1")!;
assert.throws(() => resolveFeature(top, v, { part: 1, feature: "hole:99" }), (e) => e instanceof AddedError && !!e.choices?.includes("left") && !e.choices.includes("hole:99"));
assert.ok(featureChoices(top, v, 1).has("centre"));
const assembled = top.sheets[1].meta.views.find((v) => v.kind === "ga")!;
assert.equal(featureChoices(top, assembled, 2).size, 0, "a repeated part mark needs a clearer view");

// Words cover every possible position: the addition must be refused, leaving the sheet alone.
const blocked = makeSet(input("table"));
blocked.sheets[2].prims.push(text([AREA[0], AREA[1]], "BLOCKED".repeat(200), AREA[3] - AREA[1]));
const before = JSON.stringify(blocked.sheets);
assert.throws(() => applyAdded(blocked, [diagonal]), /overlap|frame|cross/);
assert.equal(JSON.stringify(blocked.sheets), before);

const note = { id: "note", kind: "note" as const, sheet: 3, view: "p1", at: { part: 1, feature: "corner:tr" }, text: "Keep this edge clear" };
const noted = makeSet(input("table", { additions: [note] }));
assert.ok(noted.sheets[2].prims.some((p) => p.t === "text" && p.layer === "NOTES" && p.s === note.text));
passes(noted);
assert.throws(() => makeSet(input("table", { additions: [{ ...note, text: "x".repeat(81) }] })), /80 characters/);
assert.throws(() => makeSet(input("table", { additions: [{ ...note, text: "two\nlines" }] })), /one line/);
assert.throws(() => makeSet(input("table", { additions: [{ ...diagonal, sheet: 99 }] })), /no sheet/);
assert.throws(() => makeSet(input("table", { additions: [{ ...diagonal, view: "missing" }] })), /Its views are/);
console.log("added drawing geometry: ok");
