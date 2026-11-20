import "../isolate.js";
import assert from "node:assert/strict";
import { rig, until } from "./hq-api-fixture.test.js";
import type { Engine, EngineEvent, Row } from "../../src/hq/contract.js";
import { createJob } from "../../src/store/jobs.js";
import { rowsOf } from "../../src/hq/rows.js";
import { getBot } from "../../src/hq/bots.js";
import { botTurn } from "../../src/hq/toolbox/turns.js";

const held = new Map<string, { event: (event: EngineEvent) => void; release: () => void }>();
const limitedJobs = new Set<string>();
process.env.TASK_BUDGET_USD = "1";
let parent = "";
const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), async run(bot, input, event, signal) {
  if (!input.conversation.includes("-work-")) {
    parent = botTurn(bot.id)!.turn.job_id!;
    event({ type: "done", text: "Ready.", engine: bot.primary }); return;
  }
  const id = botTurn(bot.id, input.lane)!.turn.job_id!;
  event({ type: "tool", phase: "start", id: "read", name: "read_file" });
  event({ type: "tool", phase: "start", id: "read", name: "read_file" });
  await new Promise<void>(resolve => {
    const release = () => { signal.removeEventListener("abort", release); held.delete(id); resolve(); };
    held.set(id, { event, release }); signal.addEventListener("abort", release, { once: true });
    if (signal.aborted) release();
  });
  if (signal.aborted) { event({ type: "failed", reason: "stopped", message: "Stopped." }); return; }
  if (input.text === "Limited") {
    limitedJobs.add(id);
    event({ type: "done", text: "I checked two options. The third still needs a closer look. [MORE]", engine: bot.primary });
    return;
  }
  if (limitedJobs.has(id)) {
    event({ type: "usage", input: 21_000_000, output: 100, engine: bot.primary });
    return;
  }
  event({ type: "tool", phase: "end", id: "read", name: "read_file", ok: true });
  event({ type: "tool", phase: "end", id: "read", name: "read_file", ok: true });
  event({ type: "done", text: input.text === "Two parts" ? "First part. [MORE]" : "The result is ready.", engine: bot.primary });
} };
const r = await rig(engine);
const events: Row[] = [];
r.hq.turns.on("row", row => { if (row.body.kind === "step") events.push(structuredClone(row)); });
function start(bot: string, title: string, fromTurn?: string) {
  const id = createJob("task", title, title);
  const controller = new AbortController();
  const done = r.hq.work(bot, { id, title, brief: title, origin: null, fromTurn }, controller.signal);
  return { id, controller, done };
}
const steps = (bot: string, job: string) => rowsOf(bot, getBot(bot)!.generation).filter(row => row.body.kind === "step" && row.body.job === job);
try {
  const first = start("tim", "Two parts"), other = start("pebble", "Another comparison");
  await until(() => held.has(first.id) && held.has(other.id));
  assert.equal(steps("tim", first.id).length, 1, "Repeated starts make one step.");
  assert.equal(steps("pebble", first.id).length, 0, "Work belongs only to its own conversation.");
  const row = steps("tim", first.id)[0];
  assert.equal(row.body.kind === "step" && row.body.state, "running");
  held.get(first.id)!.release();
  await until(() => steps("tim", first.id).length === 2 && held.has(first.id));
  const ended = steps("tim", first.id)[0];
  assert.equal(ended.seq, row.seq);
  assert.ok(ended.rev > row.rev);
  assert.equal(ended.body.kind === "step" && ended.body.state, "ok");
  assert.ok(ended.body.kind === "step" && typeof ended.body.ms === "number");
  held.get(first.id)!.release(); held.get(other.id)!.release();
  await Promise.all([first.done, other.done]);
  const completed = steps("tim", first.id);
  assert.equal(completed.length, 2, "The same tool id in a later part is a new step.");
  assert.ok(completed.every(row => row.body.kind === "step" && row.body.jobTitle === "Two parts" && row.body.jobSince && row.body.state === "ok"));
  const last = completed.at(-1)!.body;
  assert.ok(last.kind === "step" && last.jobEndedAt);
  assert.equal(events.filter(row => row.bot === "tim" && row.body.kind === "step" && row.body.job === first.id && row.body.state === "running").length, 2);
  assert.equal(steps("tim", other.id).length, 0);

  const limited = start("tim", "Limited");
  await until(() => held.has(limited.id));
  held.get(limited.id)!.release();
  await until(() => held.has(limited.id));
  held.get(limited.id)!.release(); await limited.done;
  const closing = rowsOf("tim", getBot("tim")!.generation).slice(-2).map(row => row.body);
  assert.ok(closing[0].kind === "notice" && closing[0].tone === "info" && !closing[0].text.includes("two options"), JSON.stringify(closing));
  assert.ok(closing[1].kind === "message" && closing[1].text === "I checked two options. The third still needs a closer look.");

  const interrupted = start("tim", "Stop here");
  await until(() => held.has(interrupted.id));
  interrupted.controller.abort(); await interrupted.done;
  assert.ok(steps("tim", interrupted.id).every(row => row.body.kind === "step" && row.body.state === "failed" && row.body.jobEndedAt));

  await r.hq.answer("Ready", { bot: "tim", via: "typed", origin: { kind: "voice" }, test: true });
  const trial = start("tim", "A test job", parent);
  await until(() => held.has(trial.id));
  assert.equal(steps("tim", trial.id).length, 0);
  assert.equal(r.hq.testRows("tim", parent).filter(row => row.kind === "step").length, 0);
  held.get(trial.id)!.release(); await trial.done;
  assert.equal(events.filter(row => row.body.kind === "step" && row.body.job === trial.id).length, 0, "Test jobs publish no steps.");
  console.log("Work steps start once, finish in place, stay with their bot, and are absent for test jobs.");
} finally { for (const gate of held.values()) gate.release(); await r.close(); }
