// Joint details (Stage 19.2): every joint type has a detail (a section through it, one at right angles where its shape
// changes, a pulled-apart 3D view with part numbers and no sizes), lettered and marked once on the arrangement, with a
// joint schedule; a size on a detail isn't repeated on a part view (it's there in brackets where it sets the part out).
// Less clutter (19.4): fewer hidden lines on the arrangement, no pulled-apart view with more than eight part numbers.
// The new code checks A22 to A28 pass on the test pieces (drawing-sheets runs them on all eight) and each fails when its
// fault is planted.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { AREA, gaHiddenLengths, makeSet, type SetInput } from "../../src/shared/drawing/sheets.js";
import { checkSet, summary } from "../../src/shared/drawing/checks.js";
import { TEST_PIECES } from "../../src/shared/drawing/testpieces.js";
import type { Text } from "../../src/shared/drawing/prims.js";

const input = (t: (typeof TEST_PIECES)[number]): SetInput => ({
  model: t.payload,
  title: t.title,
  number: "TST-SD-001",
  revision: "P1",
  status: "PRELIMINARY",
  revisions: [{ rev: "P1", date: "14.11.26", text: "Preliminary issue", by: "LH" }],
  project: t.project,
  client: t.client,
  drawn: "LH",
  date: "14.11.26",
  materials: { ...t.materials },
  finish: t.finish,
});
const piece = (id: string) => makeSet(input(TEST_PIECES.find((t) => t.id === id)!));
const texts = (s: ReturnType<typeof piece>) => s.sheets.flatMap((sh) => sh.prims.filter((p): p is Text => p.t === "text").map((p) => p.s));
const detailDims = (s: ReturnType<typeof piece>, letter: string) =>
  s.sheets.flatMap((sh) => {
    const ids = new Set(sh.meta.views.filter((v) => v.group === letter).map((v) => v.id));
    return sh.meta.dims.filter((d) => ids.has(d.view));
  });
const has = (ds: { value: number; ref?: boolean }[], v: number) => ds.some((d) => !d.ref && Math.abs(d.value - v) < 0.06);

// the table: one detail for the eight apron-to-leg joints, titled as the plan has it; its tenon, shoulders and set-out
{
  const s = piece("table");
  const all = texts(s);
  assert.ok(all.includes("APRON & END APRON TO LEG"), "the detail's title");
  assert.ok(all.includes("MORTISE AND TENON, 8 PLACES (TYP)"), "what it is and how many");
  const a = detailDims(s, "A");
  for (const v of [10, 6, 90, 30]) assert.ok(has(a, v), `detail A gives ${v}`);
  assert.ok(all.some((x) => /^A[12] {2}SECTION/.test(x)) && all.includes("A3  PULLED APART, NOT DIMENSIONED, SCALE 1:5"), "its views and their captions");
  // the leg's part view points to it and doesn't give its sizes again
  assert.ok(all.includes("MORTISE, SEE DETAIL A"));
  const cs = checkSet(s).filter((c) => /^A2[2-6]$/.test(c.id));
  assert.ok(cs.every((c) => c.ok), summary(cs));
  // the schedule: three types, 16 joints, the butts with their faces
  const rows = s.sheets.flatMap((sh) => sh.meta.jointSchedule ?? []);
  assert.deepEqual(
    rows.map((r) => `${r.detail} ${r.kind} ${r.places}`),
    ["A mortise and tenon 8", "B butt 4", "C butt 4"],
  );
  assert.ok(all.includes("END TO FACE") && all.includes("EDGE TO FACE"));
}
// the door: a haunched tenon's length and haunch, the mortise's depth (2 clear at its bottom), the panel floating
{
  const s = piece("door");
  const top = s.joints.types.find((t) => t.title === "TOP RAIL TO STILE")!;
  const d = detailDims(s, top.letter!);
  for (const v of [75, 60, 15, 77, 35, 12, 14]) assert.ok(has(d, v), `the top rail's detail gives ${v}`);
  const groove = s.joints.types.find((t) => t.kind === "groove")!;
  const g = detailDims(s, groove.letter!);
  for (const v of [15, 13, 12, 14]) assert.ok(has(g, v), `the groove's detail gives ${v}`);
  assert.ok(texts(s).includes("FLOATING, NO GLUE"), "the panel's fixing, from the model's note");
}
// the pergola: the bolts called up with a leader, the bolt centres set out from the beam's top
{
  const s = piece("pergola");
  const slot = s.joints.types.find((t) => t.title === "BEAM TO POST")!;
  assert.ok(texts(s).includes("2 / M12 x 90 BOLTS"));
  const d = detailDims(s, slot.letter!);
  for (const v of [50, 90, 190, 45, 22.5]) assert.ok(has(d, v), `the slot's detail gives ${v}`);
  // the pulled-apart view numbers the post, the beam and the bolt, and has no sizes
  const ap = s.sheets.flatMap((sh) => sh.meta.views).find((v) => v.group === slot.letter && v.role === "apart")!;
  assert.deepEqual(ap.ballooned, [...new Set(slot.insts[0].parts.map((i) => s.parts[i].mark))].sort((x, y) => x - y));
}
// the TV unit: more than six kinds of plain butt joint, so those are in the schedule only, and it says so
{
  const s = piece("tv");
  assert.ok(s.joints.buttsInScheduleOnly);
  assert.ok(texts(s).some((x) => /PLAIN BUTT JOINTS .* LISTED HERE ONLY/.test(x)));
  assert.ok(checkSet(s).find((c) => c.id === "A22")!.ok);
}

// each new check fails when its fault is planted
{
  const fail = (s: ReturnType<typeof piece>, id: string, re: RegExp) => {
    const c = checkSet(s).find((x) => x.id === id)!;
    assert.ok(!c.ok && c.why.some((w) => re.test(w)), `${id} should fail (${re}): ${summary([c])}`);
  };
  // A22: a detail's marker gone from the arrangement
  let s = piece("table");
  for (const sh of s.sheets) sh.meta.markers = sh.meta.markers.filter((m) => m.letter !== "A");
  fail(s, "A22", /detail A .* isn't marked/);
  // A23: a size on a detail that isn't the model's
  s = piece("table");
  const d = s.sheets.flatMap((sh) => sh.meta.dims).find((x) => /^part\d+:/.test(x.key) && s.sheets.some((sh) => sh.meta.views.some((v) => v.id === x.view && v.group)))!;
  d.value += 3;
  fail(s, "A23", /isn't the model's/);
  // A24: a size on a pulled-apart view
  s = piece("table");
  const sh = s.sheets.find((x) => x.meta.views.some((v) => v.role === "apart"))!;
  const ap = sh.meta.views.find((v) => v.role === "apart")!;
  sh.meta.dims.push({ ...sh.meta.dims[0], view: ap.id });
  fail(s, "A24", /has sizes on it/);
  // A25: the schedule counting wrong
  s = piece("table");
  s.sheets.find((x) => x.meta.jointSchedule)!.meta.jointSchedule![0].places = 7;
  fail(s, "A25", /schedule counts 15 joints; 16 were found/);
  // A26: a detail's size given again on a part view
  s = piece("table");
  const det = s.sheets.flatMap((x) => x.meta.dims.filter((y) => !y.ref && x.meta.views.some((v) => v.id === y.view && v.group)))[0];
  const partSheet = s.sheets.find((x) => x.meta.views.some((v) => v.kind === "part"))!;
  partSheet.meta.dims.push({ ...det, view: partSheet.meta.views.find((v) => v.kind === "part")!.id });
  fail(s, "A26", /on part view .* and on a detail/);
}
console.log("drawing details: ok");

// Less clutter (Stage 19.4), on the TV unit: the arrangement's hidden lines fall (only a part's outline where none of it
// is seen from that side, and each marked joint's outline), every joint marked keeps its outline inside the marker; no
// pulled-apart view has more than eight part numbers (the carcass with its doors on the arrangement, the drawer on its
// own, 2 REQ'D, each part number once)
{
  const s = piece("tv");
  const h = gaHiddenLengths(s);
  assert.ok(h.now < h.before * 0.9, `the arrangement's hidden lines fall: ${Math.round(h.now)} mm against ${Math.round(h.before)} mm`);
  const cs = checkSet(s).filter((c) => c.id === "A27" || c.id === "A28");
  assert.ok(cs.every((c) => c.ok), summary(cs));
  const isos = s.sheets.flatMap((sh) => sh.meta.views.filter((v) => v.kind === "iso" && /^G\d$/.test(v.id)));
  assert.deepEqual(
    isos.map((v) => v.title),
    ["EXPLODED VIEW, CARCASS", "EXPLODED VIEW, DRAWER, 2 REQ'D"],
  );
  const per = new Map<string, number>();
  for (const sh of s.sheets) for (const b of sh.meta.balloons) per.set(b.view!, (per.get(b.view!) ?? 0) + 1);
  assert.ok([...per.values()].every((n) => n <= 8) && [...per.values()].reduce((a, b) => a + b, 0) === s.marks.length, JSON.stringify([...per]));
  // the checks fail when planted: a ninth balloon on one view; a marker with nothing inside it
  const sh = s.sheets.find((x) => x.meta.balloons.length)!;
  for (let i = 0; i < 9; i++) sh.meta.balloons.push({ mark: 1, at: [0, 0], view: "G4" });
  assert.ok(!checkSet(s).find((c) => c.id === "A28")!.ok);
  const s2 = piece("table");
  const ga = s2.sheets.find((x) => x.meta.markers.some((m) => m.at))!;
  const m = ga.meta.markers.find((x) => x.at)!;
  m.at = [AREA[0] + 1, AREA[1] + 1];
  const a27 = checkSet(s2).find((c) => c.id === "A27")!;
  assert.ok(!a27.ok && a27.why.some((w) => /nothing of joint/.test(w)), summary([a27]));
}
console.log("drawing clutter: ok");
