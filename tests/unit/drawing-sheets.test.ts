// Shop drawings, sheets and the set (Stage 12.3): the four test pieces (the mortise and tenon, a table with rails, a
// cabinet carcass with fixed shelves and a back, a pergola frame) each make a set that passes the code checks A1 to
// A15; the right-hand column and title block; the parts schedule; drawing numbers, revisions and status; and a long
// parts list gets a sheet of its own.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { makeSet, type SetInput } from "../../src/shared/drawing/sheets.js";
import { checkSet, summary } from "../../src/shared/drawing/checks.js";
import { TEST_PIECES } from "../../src/shared/drawing/testpieces.js";
import { drawingNumber, jobCode, nextRevision, statusFrom } from "../../src/shared/drawing/numbering.js";
import type { Text } from "../../src/shared/drawing/prims.js";
import type { ModelPart } from "../../src/shared/protocol.js";

const input = (t: (typeof TEST_PIECES)[number], extra: Partial<SetInput> = {}): SetInput => ({
  model: t.payload,
  title: t.title,
  number: drawingNumber(jobCode(t.project), 3),
  revision: "P1",
  status: "PRELIMINARY",
  revisions: [{ rev: "P1", date: "13.11.26", text: "Preliminary issue", by: "LH" }],
  company: "Test Joinery",
  companyLine: "Sydney NSW",
  project: t.project,
  client: t.client,
  drawn: "LH",
  date: "13.11.26",
  ...extra,
});

const times: string[] = [];
for (const t of TEST_PIECES) {
  const s = makeSet(input(t));
  times.push(`${t.id} ${s.sheets.length} sheets ${Math.round(s.ms)} ms`);
  const cs = checkSet(s).filter((c) => c.id !== "A16");
  assert.ok(cs.every((c) => c.ok), `${t.id}:\n${summary(cs)}`);
  // every sheet: the column with notes, legend, revisions, the checked box and the title block, the same fields
  for (const sh of s.sheets) {
    const texts = sh.prims.filter((p): p is Text => p.t === "text").map((p) => p.s);
    for (const w of ["NOTES", "REVISIONS", "CHECKED", "APPROVED", "DRAWING NO.", "SCALE", "A3", "PRELIMINARY", `${sh.meta.sheet}/${s.sheets.length}`]) assert.ok(texts.includes(w), `${t.id} sheet ${sh.meta.sheet}: "${w}"`);
    assert.equal(sh.meta.fields.checked, "", "checked stays empty until the owner says he's checked it");
    assert.ok(texts.some((x) => /SHOP DRAWING FOR FABRICATION AND/.test(x)), "the not-a-certification note");
  }
  // the parts schedule: its columns, finished sizes, quantities that add up to the model
  const first = s.sheets.find((sh) => sh.meta.schedule)!;
  const heads = first.prims.filter((p): p is Text => p.t === "text" && p.layer === "TABLES").map((p) => p.s);
  for (const h of ["NO.", "PART", "QTY", "MATERIAL", "THK", "WIDTH", "LENGTH", "NOTES"]) assert.ok(heads.includes(h), `${t.id}: schedule column ${h}`);
  // a general arrangement first (after the cover, if there is one), with a pulled-apart 3D view somewhere in the set
  assert.match(s.sheets[s.sheets[0].meta.cover ? 1 : 0].meta.title, /GENERAL ARRANGEMENT/);
  assert.ok(s.sheets.some((sh) => sh.meta.views.some((v) => v.kind === "iso")), `${t.id}: a 3D view`);
}
console.log(times.join("\n"));

// the table: four legs, one part number, 4 REQ'D; its joints in details marked on the arrangement (Stage 19)
const table = makeSet(input(TEST_PIECES[1]));
const leg = table.marks.find((m) => m.label === "LEG")!;
assert.equal(leg.qty, 4);
assert.ok(table.sheets.some((sh) => sh.prims.some((p) => p.t === "text" && p.s === "LEG, 4 REQ'D")), "LEG, 4 REQ'D");
const gaSheet = table.sheets.find((sh) => /GENERAL ARRANGEMENT/.test(sh.meta.title))!;
assert.deepEqual(gaSheet.meta.markers.map((m) => m.letter).sort(), ["A", "B", "C"], "each joint type marked on the arrangement");
// from the benchmark rounds (12.8): the overall depth is on the arrangement sheet itself; the joint details sit on
// their own sheets after the parts, A first, with the joint schedule; no sheet has more than five titled views (a
// joint detail's views are one group)
const gaDims = gaSheet.meta.dims.map((d) => Math.round(d.value));
for (const v of [1500, 800, 750]) assert.ok(gaDims.includes(v), `table: ${v} on the arrangement`);
const detailSheets = table.sheets.filter((sh) => /JOINT DETAILS/.test(sh.meta.title));
assert.ok(detailSheets.length >= 1 && table.sheets.indexOf(detailSheets[0]) > table.sheets.indexOf(gaSheet));
assert.equal(detailSheets[0].meta.views.find((v) => v.group)?.group, "A");
assert.ok(detailSheets[0].meta.jointSchedule, "the joint schedule heads the first details sheet");
const groupsOf = (sh: (typeof table.sheets)[number]) => sh.meta.views.filter((v) => v.title && !v.group).length + new Set(sh.meta.views.filter((v) => v.group).map((v) => v.group)).size;
for (const t of TEST_PIECES) for (const sh of makeSet(input(t)).sheets) assert.ok(groupsOf(sh) <= 6, `${t.id} sheet ${sh.meta.sheet}: five views (or six details) at most`);
// 12.10: no company is a whole title block (the project leads, nothing stands in for a company, no empty box);
// materials as said, or TBC (never the model's HARDWOOD), with codes keyed to the legend when there's more than one;
// grain arrows; the same part under different names drawn once; plans carry their sizes; no sheet under 40% used;
// a cover with the drawing index for four sheets or more
for (const t of TEST_PIECES) {
  const bare = makeSet(input(t, { company: undefined, companyLine: undefined, materials: { ...t.materials }, finish: t.finish }));
  const cs = checkSet(bare).filter((c) => c.id !== "A16");
  assert.ok(cs.every((c) => c.ok), `${t.id} without a company:
${summary(cs)}`);
  for (const sh of bare.sheets) {
    const tt = sh.prims.filter((p): p is Text => p.t === "text" && p.layer === "TITLE").map((p) => p.s);
    assert.ok(tt.includes(t.project.toUpperCase()) && !tt.some((x) => /COMPANY/.test(x)), `${t.id} sheet ${sh.meta.sheet}: the project leads`);
  }
}
const tbc = makeSet(input(TEST_PIECES[1]));
assert.ok(tbc.sheets.find((sh) => sh.meta.schedule)!.meta.schedule!.every((r) => r.material === "TBC"), "not said: TBC");
const oak = makeSet(input(TEST_PIECES[1], { materials: { all: "Tas oak, DAR" } }));
assert.ok(oak.sheets.find((sh) => sh.meta.schedule)!.meta.schedule!.every((r) => r.material === "TAS OAK, DAR"));
assert.ok(oak.sheets.some((sh) => sh.prims.some((p) => p.t === "text" && p.s === "GRAIN DIRECTION")), "grain arrows, in the legend");
const cab2 = makeSet(input(TEST_PIECES[2], { materials: { ...TEST_PIECES[2].materials } }));
const cabText = cab2.sheets.flatMap((sh) => sh.prims.filter((p): p is Text => p.t === "text").map((p) => p.s));
for (const w of ["M1", "M2", "18 HMR MELAMINE, WHITE", "6 MDF, WHITE", "BOTTOM, SHELF & TOP, 4 REQ'D", "PARTICLEBOARD"]) assert.ok(cabText.includes(w), `cabinet: "${w}"`);
assert.ok(!cabText.includes("GRAIN DIRECTION"), "melamine has no grain to show");
const tv = makeSet(input(TEST_PIECES[4], { materials: { ...TEST_PIECES[4].materials } }));
assert.ok(tv.sheets.length >= 5 && tv.sheets[0].meta.cover, "the TV unit's set opens on a cover");
const idx = tv.sheets[0].prims.filter((p): p is Text => p.t === "text").map((p) => p.s);
for (const sh of tv.sheets) assert.ok(idx.includes(`${sh.meta.sheet}/${tv.sheets.length}`), `the index lists sheet ${sh.meta.sheet}`);
assert.ok(idx.includes("DRAWING INDEX") && idx.includes("ASSEMBLED VIEW"));
assert.ok(!makeSet(input(TEST_PIECES[0])).sheets[0].meta.cover, "a small set has no cover");

// a view's title moved into another view (round 6's fault) fails A6
{
  const s = makeSet(input(TEST_PIECES[1]));
  const sh = s.sheets.find((x) => /GENERAL ARRANGEMENT/.test(x.meta.title))!;
  const front = sh.meta.views.find((v) => v.id === "G1")!;
  const plan = sh.prims.find((p) => p.t === "text" && p.role === "title" && p.s === "PLAN")!;
  if (plan.t === "text") plan.at = [(front.box[0] + front.box[2]) / 2, (front.box[1] + front.box[3]) / 2];
  const a6 = checkSet(s).find((c) => c.id === "A6")!;
  assert.ok(!a6.ok && a6.why.some((w) => /inside view G1/.test(w)), summary([a6]));
}
// the cabinet: a handed pair of sides is one part number; plywood hatch in its legend
const cab = makeSet(input(TEST_PIECES[2]));
assert.equal(cab.marks.find((m) => m.label === "SIDE")!.qty, 2);
assert.ok(cab.sheets.some((sh) => sh.prims.some((p) => p.t === "text" && p.s === "PLYWOOD")), "plywood in a legend");

// numbering: job code, running number, revision; P1, P2 while preliminary, then A, B
assert.equal(jobCode("Household cabinet"), "HOU");
assert.equal(jobCode("The club room"), "CLU");
assert.equal(drawingNumber("COO", 3), "COO-SD-003");
assert.equal(nextRevision(null, "PRELIMINARY"), "P1");
assert.equal(nextRevision("P1", "PRELIMINARY"), "P2");
assert.equal(nextRevision("P2", "FOR APPROVAL"), "A");
assert.equal(nextRevision("A", "FOR APPROVAL"), "B");
assert.equal(nextRevision("H", "FOR CONSTRUCTION"), "J", "I is skipped");
assert.equal(nextRevision("B", "PRELIMINARY"), "C", "once issued it stays lettered");
assert.equal(statusFrom("mark it for approval"), "FOR APPROVAL");
assert.equal(statusFrom("issue it for construction"), "FOR CONSTRUCTION");
// the status and revision show in the title block, and the revision table's last row matches
const issued = makeSet(input(TEST_PIECES[0], { status: "FOR APPROVAL", revision: "A", revisions: [{ rev: "P1", date: "12.11.26", text: "Preliminary issue", by: "LH" }, { rev: "A", date: "13.11.26", text: "Issued for approval", by: "LH" }] }));
assert.ok(checkSet(issued).find((c) => c.id === "A3")!.ok);
assert.ok(issued.sheets[0].prims.some((p) => p.t === "text" && p.s === "FOR APPROVAL"));

// a long parts list: the schedule goes on a sheet of its own after the arrangement
const parts: ModelPart[] = [];
for (let i = 0; i < 26; i++) parts.push({ id: `b${i}`, name: `Board ${String.fromCharCode(65 + i)}`, material: "pine", stock: { type: "box", size: [300 + i * 20, 90, 19] }, at: [0, i * 90, 0] });
for (const p of parts) p.name = `Shelf ${p.id}`; // one label, so 26 different parts get letters
const many = makeSet({ ...input(TEST_PIECES[0]), model: { parts } });
assert.equal(many.marks.length, 26);
const ga = many.sheets.findIndex((sh) => /GENERAL ARRANGEMENT/.test(sh.meta.title));
const at = many.sheets.findIndex((sh) => sh.meta.schedule);
assert.ok(at > ga && !many.sheets[ga].meta.schedule, "the schedule on a sheet after the arrangement");
assert.match(many.sheets[at].meta.title, /PARTS SCHEDULE/);
const mcs = checkSet(many).filter((c) => ["A12", "A13"].includes(c.id));
assert.ok(mcs.every((c) => c.ok), summary(mcs));
console.log("drawing sheets: ok");
