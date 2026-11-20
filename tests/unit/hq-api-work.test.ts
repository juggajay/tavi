import "../isolate.js";
import assert from "node:assert/strict";
import { rig, until } from "./hq-api-fixture.test.js";
import type { Engine, TurnInput, EngineEvent } from "../../src/hq/contract.js";

const { startTask, steerWork, cancelJob } = await import("../../src/brain/tasks.js");
const { botTurn } = await import("../../src/hq/toolbox/index.js");
const { db } = await import("../../src/store/db.js");
const requests: { bot: string; input: TurnInput; job: string | null; test: boolean }[] = [];
const workIds: string[] = [];
let release: (() => void) | undefined;
let workMode: "hold" | "finish" | "time" | "usage" | "claim" = "hold";
let workStep = 0;
const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), async run(bot, input, on, signal) {
  const ctx = botTurn(bot.id, input.lane)!;
  assert.ok(ctx, "every open turn has its own toolbox context");
  requests.push({ bot: bot.id, input, job: ctx.turn.job_id, test: ctx.test });
  const done = (text: string) => { on({ type: "text", delta: text }); on({ type: "done", text, engine: bot.primary }); };
  if (!input.conversation.includes("-work-")) {
    if (input.text.startsWith("Build")) {
      workIds.push(startTask({ title: "A hall table", brief: "Make a hall table", understood: "A hall table for the entry", howLong: "five to ten minutes", origin: null, fromTurn: ctx.turn.job_id, open: true }));
      done("You want a hall table for the entry. I'm working on it; five to ten minutes.");
    } else done("I can answer while the work carries on.");
    return;
  }
  workStep++;
  const mode = workMode;
  on({ type: "status", text: "Checking the table's proportions" });
  on({ type: "usage", input: workMode === "usage" ? 120_000_001 : 5, output: 4, engine: bot.primary });
  if (workMode === "hold" || workMode === "time") {
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      signal.addEventListener("abort", stop, { once: true });
      release = () => { signal.removeEventListener("abort", stop); resolve(); };
      if (signal.aborted) resolve();
    });
  }
  if (signal.aborted) { on({ type: "failed", reason: "stopped", message: "Stopped." }); return; }
  done(mode === "claim" ? "It is strong enough. The model is ready." : mode === "finish" ? "The table is ready." : "The proportions are checked. [MORE]");
} };
const r = await rig(engine);
const job = (id: string) => db.prepare("SELECT status, progress, result, error FROM jobs WHERE id=?").get(id) as { status: string; progress: string; result: string | null; error: string | null };
try {
  const first = await r.hq.answer("Build a hall table", { bot: "tim", via: "typed", origin: { kind: "voice" } });
  assert.match(first.spoken, /hall table.*five to ten minutes/);
  await until(() => workStep === 1 && !!release);
  const id = workIds[0];
  assert.equal(job(id).status, "running"); assert.equal(job(id).progress, "Checking the table's proportions");
  const background = requests.find((q) => q.input.conversation.includes("-work-"))!;
  assert.equal(background.bot, "tim", "work stays with the bot which started it");
  assert.match(background.input.conversation, new RegExp(`^lh-tim-work-${id}$`));
  assert.match(background.input.instructions, /hall table for the entry/);
  assert.match(background.input.instructions, /five to ten minutes/, "work includes the parent's finished answer");
  assert.equal(steerWork(id, "Use a thinner top, and give me the quick version"), true);
  const next = r.hq.answer("How is that going?", { bot: "tim", via: "typed", origin: { kind: "voice" } });
  workMode = "finish"; release!();
  assert.match((await next).spoken, /answer while the work carries on/);
  await until(() => job(id).status === "done");
  assert.ok(requests.some((q) => q.input.instructions.includes("thinner top")));
  assert.ok(db.prepare("SELECT id FROM notifications WHERE source=?").get(`task:${id}`));
  assert.ok(r.hq.turns.usage("tim").today["openai-codex"]!.input > 0);
  assert.equal(botTurn("tim"), null);

  workMode = "hold"; release = undefined;
  await r.hq.answer("Build a bench", { bot: "pebble", via: "typed", origin: { kind: "voice" } });
  await until(() => !!release);
  const cancelled = workIds[1]; assert.equal(cancelJob(cancelled), true);
  await until(() => botTurn("pebble", "work") === null);
  assert.equal(job(cancelled).status, "cancelled");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE source=?").get(`task:${cancelled}`)?.n, 0);

  workMode = "time"; release = undefined; process.env.LH_WORK_LIMIT_MS = "50";
  await r.hq.answer("Build a chair", { bot: "pebble", via: "typed", origin: { kind: "voice" } });
  const timed = workIds[2];
  await until(() => job(timed).status === "done");
  assert.match(JSON.parse(job(timed).result!).spoken, /time limit/);
  assert.equal(JSON.parse(job(timed).result!).limit, "time");
  delete process.env.LH_WORK_LIMIT_MS;

  workMode = "usage";
  await r.hq.answer("Build a gate", { bot: "pebble", via: "typed", origin: { kind: "voice" } });
  const usage = workIds[3];
  await until(() => job(usage).status === "done");
  assert.match(JSON.parse(job(usage).result!).spoken, /usage limit/);
  assert.equal(JSON.parse(job(usage).result!).limit, "usage");

  workMode = "claim";
  await r.hq.answer("Build a stool", { bot: "pebble", via: "typed", origin: { kind: "voice" } });
  const claim = workIds[4];
  await until(() => job(claim).status === "done");
  assert.ok(!JSON.parse(job(claim).result!).spoken.includes("It is strong enough"));

  const { checkedEngine } = await import("../../src/hq/hq.js");
  const bot = r.hq.pick("").bot;
  let tries = 0;
  const unsafe: Engine = { kind: "hermes", ready: engine.ready, async run(_bot, _input, on) {
    tries++; on({ type: "text", delta: "It is strong enough." }); on({ type: "done", text: "It is strong enough. The sizes are shown.", engine: bot.primary });
  } };
  const events: EngineEvent[] = [];
  await checkedEngine(unsafe).run(bot, { text: "Check this", instructions: "", conversation: "claim-test", choice: bot.primary }, (e) => events.push(e), new AbortController().signal);
  assert.equal(tries, 2);
  assert.ok(events.every((e) => e.type !== "text" || !e.delta.includes("It is strong enough")));
  assert.ok(events.some((e) => e.type === "done" && /engineer/.test(e.text)));
  console.log("hq-api-work: ok (same bot, shared context, owner turns, changes, stop, time, usage and strength claims)");
} finally { release?.(); await r.close(); }
