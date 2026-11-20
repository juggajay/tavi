import "../isolate.js";
import assert from "node:assert/strict";
import { rig } from "./hq-api-fixture.test.js";
import type { Engine, TurnInput } from "../../src/hq/contract.js";
import { db } from "../../src/store/db.js";
import { createRoutine, getRoutine, getSetting, ensureBuiltinRoutines, listRoutines, addCommitment, getCommitment } from "../../src/store/proactive.js";
import { runRoutine, runCommitmentCheck } from "../../src/proactive/scheduler.js";
import { addChannel, deliverDue } from "../../src/proactive/notify.js";
import { missedForLimit, clearMissedForLimit } from "../../src/brain/limit.js";
import { setRoutineBot } from "../../src/hq/proactive.js";
import { runProactive } from "../../src/proactive/runner.js";
import { rowsOf } from "../../src/hq/rows.js";

process.env.LH_V3 = "1";
const requests: { bot: string; input: TurnInput; background?: boolean }[] = [];
let limited = false;
let notify = true;
const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), async run(bot, input, on) {
  const { botTurn } = await import("../../src/hq/toolbox/index.js");
  requests.push({ bot: bot.id, input, background: botTurn(bot.id)?.turn.background });
  if (limited) return on({ type: "failed", reason: "limit", message: "The subscription limit was reached." });
  const text = JSON.stringify({ notify, priority: "normal", title: "Today's update", spoken: "The delivery is due at ten.",
    card: { title: "Today", rows: [{ label: "Delivery", value: "10 am" }], source: "Calendar" }, told_commitments: [], told_points: ["delivery at ten"] });
  on({ type: "done", text, engine: bot.primary });
} };
const r = await rig(engine);
try {
  const made = createRoutine({ title: "Check delivery", instructions: "Check the delivery", schedule: { kind: "daily", time: "10:00" } });
  const routine = getRoutine(made.id)!;
  setRoutineBot(routine, "tim");
  const notices: { title: string; card: unknown; push: boolean }[] = [];
  addChannel((n, o) => { notices.push({ title: n.title, card: n.card, push: o.push }); });
  await runRoutine(routine);
  await deliverDue(new Date(Date.now() + 1000));
  assert.equal(requests.at(-1)?.bot, "tim");
  assert.equal(requests.at(-1)?.background, true);
  assert.match(requests.at(-1)!.input.instructions, /routine with nobody listening/);
  assert.match(requests.at(-1)!.input.conversation, /^lh-tim-routine-/);
  assert.ok(notices.some((n) => n.title === "Today's update" && n.push && (n.card as { title: string }).title === "Today"));
  const messages = rowsOf("tim", 0).flatMap((r) => r.body.kind === "message" ? [r.body.text] : []);
  assert.deepEqual(messages, ["Check delivery", "The delivery is due at ten."], "the phone sees plain words, not the reply form");

  ensureBuiltinRoutines();
  for (const kind of ["morning_brief", "wrap_up"]) {
    const builtin = listRoutines().find((b) => b.builtin === kind)!;
    assert.ok(builtin);
    await runRoutine(builtin);
    assert.equal(requests.at(-1)?.bot, "pebble");
    assert.match(requests.at(-1)!.input.text, new RegExp(builtin.instructions.slice(0, 15).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.ok(JSON.parse(getSetting("told_history")).some((r: { routine: string }) => r.routine === "morning_brief"));
  const c = addCommitment({ title: "Reply from Alex", owner: "Alex", counterpart: "Alex" });
  await runCommitmentCheck(getCommitment(c)!);
  assert.equal(requests.at(-1)?.bot, "pebble");
  assert.match(requests.at(-1)!.input.text, /Follow-up check for commitment/);
  await deliverDue(new Date(Date.now() + 1000));
  assert.ok(notices.length >= 4);

  clearMissedForLimit(); limited = true;
  await runRoutine(routine);
  assert.equal(getRoutine(routine.id)!.failures, 0);
  assert.equal(getRoutine(routine.id)!.status, "active");
  assert.equal(getRoutine(routine.id)!.last_outcome, "Missed: a subscription's usage limit was reached");
  assert.equal(missedForLimit().length, 1);
  assert.equal(missedForLimit()[0].title, routine.title);
  limited = false;
  await runRoutine(listRoutines().find((b) => b.builtin === "morning_brief")!);
  assert.match(requests.at(-1)!.input.text, /Check delivery/);
  assert.match(requests.at(-1)!.input.text, /a subscription's usage limit/);
  assert.equal(missedForLimit().length, 0);
  await deliverDue(new Date(Date.now() + 1000));
  notify = false;
  const count = notices.length;
  await runRoutine(routine); await deliverDue(new Date(Date.now() + 1000));
  assert.equal(getRoutine(routine.id)!.last_outcome, "Nothing to report");
  assert.equal(notices.length, count);
  console.log("hq-proactive-team: routines, brief, wrap-up, checks, notices and missed runs passed");
} finally { await r.close(); }
await assert.rejects(() => runProactive("Try after the team has stopped"), /team is not available/);
