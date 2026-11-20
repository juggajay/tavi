// Stages 19 and 20 joined (at their merge onto the build line): a joint the assistant suggested says on the shop
// drawing's joint schedule where its proportions came from. A recipe's design rules go into the model's design record
// by code; the assistant may name design rules for a joint it built itself (show_model), and those become sources of
// its answer; the schedule names a rule and its book under SUGGESTED, CONFIRM ("TENON 1/3 OF RAIL, FAIRHAM"), says a
// rule not confirmed on the shelf is unconfirmed, and with no rule says it was the drafter's own judgement. A rule the
// joint's sizes don't bear out is never named. His joints say only AS DIRECTED. A record is matched to the joint whose
// two sides it names. Each source fits one line of the column.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { z } from "zod";
import { jointModel, modelTools } from "../../src/brain/modelTools.js";
import { newTurn, newTurnCtx } from "../../src/brain/turn.js";
import { sourcesOf } from "../../src/brain/sourceLedger.js";
import { makeSet } from "../../src/shared/drawing/sheets.js";
import { doorPiece, mortiseTenonPiece, tablePiece } from "../../src/shared/drawing/testpieces.js";
import { TH, textWidth, type Text } from "../../src/shared/drawing/prims.js";
import { JOINT_RULE_IDS, scheduleLabel } from "../../src/shared/model3d/designRules.js";
import { runRecipe } from "../../src/shared/model3d/recipes/index.js";
import { stopRenderWorkers } from "../../src/drawings/engine.js";
import type { ModelDesign, ModelPayload } from "../../src/shared/protocol.js";

const drawn = (m: ModelPayload) => {
  const set = makeSet({ model: m, title: "Test piece", number: "TST-SD-001", revision: "P1", status: "PRELIMINARY", revisions: [{ rev: "P1", date: "15.11.26", text: "Preliminary issue", by: "LH" }], project: "Tests", client: "Nobody", drawn: "LH", date: "15.11.26", materials: { all: "Tas oak, DAR" } });
  return { set, texts: set.sheets.flatMap((sh) => sh.prims.filter((p): p is Text => p.t === "text").map((p) => p.s)), notes: set.sheets[0].meta.notes };
};
const recipe = (name: string, input: Record<string, unknown>) => {
  const r = runRecipe(name, input as never);
  if ("error" in r) throw new Error(r.error);
  return r;
};
const SOURCE_NOTE = /A BOOK NAMED UNDER ONE IS FOR ITS PROPORTIONS, NOT ITS STRENGTH/;
const origin = { client: "phone" as const, id: "phone-sources" };
const turn = newTurn({ origin });

/* ---------- a recipe's rule, in the record by code, under the suggestion ---------- */
const mt = jointModel(turn, { type: "mortise_tenon", title: "M&T", members: [[90, 45], [90, 90]], by: "assistant" });
assert.ok("item" in mt);
assert.deepEqual(mt.item.payload.design?.joints?.[0].rules, ["tenon_third"], "the recipe's rule is recorded with the joint");
{
  const { texts, notes } = drawn(mt.item.payload);
  assert.ok(texts.includes("SUGGESTED, CONFIRM") && texts.includes("TENON 1/3 OF RAIL, FAIRHAM"), "the suggestion names its rule and book");
  assert.ok(notes.some((x) => SOURCE_NOTE.test(x)), "and the note says a book named is for proportions, not strength");
}
// the same joint, his: AS DIRECTED and nothing more, though its record keeps the rule
const his = jointModel(turn, { type: "mortise_tenon", title: "M&T", members: [[90, 45], [90, 90]] });
assert.ok("item" in his && his.item.payload.design?.by === "owner");
{
  const { texts, notes } = drawn(his.item.payload);
  assert.ok(texts.includes("AS DIRECTED") && !texts.some((x) => /FAIRHAM|JUDGEMENT/.test(x)), "his joint names no source");
  assert.ok(!notes.some((x) => SOURCE_NOTE.test(x)));
}

/* ---------- the scarf: Fairham's length, bolts by rule of thumb; a halved splice is the drafter's own ---------- */
const sc = jointModel(turn, { type: "scarf", title: "Scarf", members: [[90, 90], [90, 90]], params: { kind: "stop_splayed", bolts: 3 }, by: "assistant" });
assert.ok("item" in sc);
{
  const { texts } = drawn(sc.item.payload);
  assert.ok(texts.includes("SCARF 4-5 X DEPTH, FAIRHAM") && texts.includes("BOLTS BY RULE OF THUMB"));
}
const hv = jointModel(turn, { type: "scarf", title: "Halved", members: [[90, 90], [90, 90]], params: { kind: "halved" }, by: "assistant" });
assert.ok("item" in hv && !hv.item.payload.design?.joints?.[0].rules);
{
  const { texts, notes } = drawn(hv.item.payload);
  assert.ok(texts.includes("DRAFTER'S JUDGEMENT") && !texts.some((x) => /FAIRHAM/.test(x)), "no rule: the drafter's own judgement");
  assert.ok(!notes.some((x) => SOURCE_NOTE.test(x)), "no book named, no note about books");
}

/* ---------- a rule not confirmed on the shelf; a rule the sizes don't bear out ---------- */
const glued = (slope: number): ModelPayload => ({ ...recipe("scarf", { params: { kind: "plain", slope } }).payload, design: { by: "assistant", joints: [{ parts: ["First member", "Second member"], kind: "scarf", by: "assistant", rules: ["glued_scarf"] }] } });
assert.ok(drawn(glued(12)).texts.includes("SLOPE 1 IN 12+, UNCONFIRMED"), "an unconfirmed rule says so, not a book");
{
  const { texts } = drawn(glued(8));
  assert.ok(!texts.some((x) => /1 IN 12\+/.test(x)) && texts.includes("DRAFTER'S JUDGEMENT"), "a 1 in 8 scarf isn't put down to the 1 in 12 rule");
}
// the table's tenons are 10 in a 22 apron: not a third, so "a third of the rail" is never written under them
const claimed: ModelDesign = { by: "assistant", joints: [{ parts: ["apron", "leg"], kind: "mortise and tenon", by: "assistant", rules: ["tenon_third"] }] };
{
  const { set, texts } = drawn({ ...tablePiece(), design: claimed });
  assert.ok(!texts.includes("TENON 1/3 OF RAIL, FAIRHAM"));
  assert.equal(set.joints.types.find((t) => t.kind === "mortise and tenon")?.rules, undefined);
}
// the mortise and tenon test piece's 15 in a 45 rail is a third, so the same claim stands there
{
  const { set } = drawn({ ...mortiseTenonPiece(), design: { by: "assistant", joints: [{ parts: ["rail", "post"], kind: "mortise and tenon", by: "assistant", rules: ["tenon_third"] }] } });
  assert.deepEqual(set.joints.types[0].rules, ["tenon_third"]);
}

/* ---------- a record goes to the joint whose two sides it names ---------- */
// the door's groove type has stiles, rails and the mullion as hosts: the rails-into-stiles record, listed first, isn't it
const door: ModelDesign = {
  by: "assistant",
  joints: [
    { parts: ["rail", "stile"], kind: "haunched mortise and tenon", by: "assistant", rules: ["haunch_groove", "groove_square"] },
    { parts: ["panel"], kind: "panel in a groove", by: "assistant", rules: ["panel_float"] },
    { parts: ["mullion", "rail"], kind: "stub tenon", by: "assistant" },
  ],
};
{
  const { set, texts } = drawn({ ...doorPiece(), design: door });
  const byKind = (k: string) => set.joints.types.filter((t) => t.kind === k);
  assert.deepEqual(byKind("groove").map((t) => t.rules), [["panel_float"]], "the panels' grooves take the panel's record");
  const mts = byKind("mortise and tenon");
  assert.ok(mts.some((t) => t.rules?.join() === "haunch_groove,groove_square"), "the rails into the stiles take theirs");
  assert.ok(mts.some((t) => !t.rules), "the mullion's stub tenons have none: the drafter's own");
  assert.ok(texts.includes("PANEL FLOATS, NOYES") && texts.includes("HAUNCH = GROOVE, NOYES") && texts.includes("DRAFTER'S JUDGEMENT"));
}

/* ---------- a joint built by hand: the rules it names are sources of the answer ---------- */
{
  const t2 = newTurn({ origin, persist: false });
  const show = modelTools({ ...newTurnCtx(), turn: t2 }).find((t) => t.name === "show_model")!;
  const table = tablePiece({ L: 1200, D: 350, H: 800 });
  const out = (await show.handler({ title: "Hall table", parts: table.parts, design: { by: "assistant", joints: [{ parts: ["top", "apron"], kind: "buttons", by: "assistant", rules: ["top_buttoned"] }] } }, {})) as { content: { text: string }[] };
  assert.ok(!JSON.parse(out.content[0].text).error, out.content[0].text);
  assert.ok(sourcesOf(t2).some((s) => s.kind === "rule" && s.rung === 6 && /Buttoning/.test(s.place ?? "")), "Fairham's buttoning is on record for 'where did you get that?'");
  // a rule the table doesn't have is refused by the tool's own schema (the brain can't invent a source for a drawing)
  const schema = z.object(show.inputSchema as z.ZodRawShape);
  const design = (rules: string[]) => ({ title: "Hall table", parts: table.parts, design: { by: "assistant", joints: [{ parts: ["top", "apron"], kind: "buttons", by: "assistant", rules }] } });
  assert.ok(schema.safeParse(design(["top_buttoned"])).success);
  assert.ok(!schema.safeParse(design(["made_up_rule"])).success);
  assert.ok(!schema.safeParse(design(["movement_formula"])).success, "nor a rule that isn't about joints");
}

/* ---------- every source fits one line of the JOINT BY column ---------- */
for (const id of JOINT_RULE_IDS) assert.ok(textWidth(scheduleLabel(id)!, TH.note) <= 54, `${scheduleLabel(id)} fits one line`);
assert.ok(textWidth("BOLTS BY RULE OF THUMB", TH.note) <= 54 && textWidth("DRAFTER'S JUDGEMENT", TH.note) <= 54);
assert.equal(scheduleLabel("movement_formula"), null, "only joint rules go on a joint schedule");

stopRenderWorkers();
console.log("joint sources: ok");
