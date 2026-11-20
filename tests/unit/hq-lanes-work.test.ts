import "../isolate.js";
import assert from "node:assert/strict";
import { rig, until } from "./hq-api-fixture.test.js";
import type { Engine, TurnInput } from "../../src/hq/contract.js";
import { botTurn } from "../../src/hq/toolbox/turns.js";
import { twinName, twinSecret } from "../../src/hq/toolbox/lanes.js";
import { getBot, listBots, updateBot, toolboxToken } from "../../src/hq/bots.js";
import { createJob } from "../../src/store/jobs.js";
import { db } from "../../src/store/db.js";
import { steerWork } from "../../src/brain/tasks.js";

const gates = new Map<string, () => void>();
const seen: { bot: string; input: TurnInput; job: string; signal: AbortSignal }[] = [];
let lastParent = "";
const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), async run(bot, input, on, signal) {
  const ctx = botTurn(bot.id, input.lane)!;
  assert.ok(ctx); assert.equal(ctx.bot, bot.id); assert.equal(ctx.turn.bot, bot.id);
  seen.push({ bot: bot.id, input, job: ctx.turn.job_id!, signal });
  const work = input.conversation.includes("-work-");
  if (!work) lastParent = ctx.turn.job_id!;
  if (work || input.text === "Hold chat") await new Promise<void>((resolve) => {
    const done = () => { signal.removeEventListener("abort", done); gates.delete(ctx.turn.job_id!); resolve(); };
    gates.set(ctx.turn.job_id!, done); signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
  if (signal.aborted) { on({ type: "failed", reason: "stopped", message: "Stopped." }); return; }
  const text = work ? input.text === "Continue" ? "First part. [MORE]" : "Spoken: The result is ready. Facts: Checked." : "The chat answer is ready.";
  on({ type: "done", text, engine: bot.primary });
} };
const r = await rig(engine);
const status = (id: string) => db.prepare("SELECT status FROM jobs WHERE id=?").get(id)?.status;
const parent = async () => { await r.hq.answer("Ready", { bot: "tim", via: "typed", origin: { kind: "voice" }, test: true }); return lastParent; };
function work(title: string, fromTurn: string, brief = title, signal?: AbortSignal) {
  const id = createJob("task", title, brief);
  const done = r.hq.work("tim", { id, title, brief, origin: null, fromTurn }, signal);
  return { id, done };
}
const call = async (address: string, token: string, now: string, server = "actions") => {
  const base = r.hq.trialState().toolboxAddress!;
  const response = await fetch(`${base}/mcp/${address}/${server}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "progress", arguments: { now } } }) });
  return { status: response.status, text: await response.text() };
};
try {
  const from = await parent();
  const first = work("Longer work", from, "Continue");
  await until(() => gates.has(first.id));
  assert.equal(r.hq.turns.live("tim").work?.[0].title, "Longer work");
  const second = work("Second job", from);
  assert.equal(status(second.id), "queued");
  assert.equal(r.hq.turns.live("tim").work?.[1].state, "queued");
  const answer = await r.hq.answer("How is it going?", { bot: "tim", via: "typed", origin: { kind: "voice" }, test: true });
  assert.equal(answer.ok, true); assert.equal(status(first.id), "running");
  assert.ok(seen.at(-1)!.input.instructions.includes("Longer work"));
  assert.equal(steerWork(first.id, "Use the new details"), true);
  updateBot("tim", { primary: { provider: "anthropic", model: "changed-choice" }, fallbacks: [] });
  const held = r.hq.answer("Hold chat", { bot: "tim", via: "typed", origin: { kind: "voice" }, test: true });
  await until(() => !!botTurn("tim"));
  const chatId = botTurn("tim")!.turn.job_id!;
  assert.notEqual(botTurn("tim"), botTurn("tim", "work"));
  assert.equal((await call("tim", toolboxToken("tim"), "Chat only")).status, 200);
  assert.equal(r.hq.turns.live("tim").doing, "Chat only");
  assert.equal((await call(twinName("tim"), twinSecret("tim", "toolbox-token")!, "Work only")).status, 200);
  assert.equal(r.hq.turns.live("tim").work?.[0].doing, "Work only");
  assert.equal(r.hq.turns.live("tim").doing, "Chat only");
  assert.equal((await call(twinName("tim"), toolboxToken("tim"), "Wrong key")).status, 401);
  assert.equal((await call(twinName("tim"), twinSecret("tim", "toolbox-token")!, "No computer", "computers")).status, 404);
  gates.get(chatId)!(); await held;
  gates.get(first.id)!();
  await until(() => seen.some((s) => s.job === first.id && s.input.instructions.includes("Use the new details")));
  assert.equal(seen.filter((s) => s.job === first.id).at(-1)!.input.choice.model, "changed-choice");
  assert.equal(gates.has(second.id), false);
  gates.get(first.id)!(); await first.done;
  await until(() => gates.has(second.id));
  const resultRows = r.hq.testRows("tim", from).filter((row) => row.body.kind === "message" && row.body.text === "The result is ready.");
  assert.equal(resultRows.length, 1);
  gates.get(second.id)!(); await second.done;
  assert.equal(status(second.id), "done");
  assert.equal(r.hq.turns.live("tim").work?.length, 0);
  const state = await r.hq.snapshot();
  assert.equal(state.bots.length, 2); assert.equal(state.live.length, 2); assert.equal(listBots().length, 2);
  assert.ok(!JSON.stringify(state).includes(twinName("tim")));
  assert.throws(() => r.hq.pick("Hello", twinName("tim")));
  assert.throws(() => r.hq.turns.tell("pebble", twinName("tim"), "Hello"));
  assert.throws(() => r.hq.turns.ask(twinName("tim"), { text: "Hello", via: "typed", origin: null }));
  for (const route of ["", "/messages", "/engine"]) assert.equal((await r.request(`/bots/${twinName("tim")}${route}`, route === "/messages" ? "POST" : "GET", route === "/messages" ? { text: "Hello", test: true } : undefined)).status, 404);

  // Stopping a job leaves a conversation free to finish.
  const stoppedJob = work("Stop just this job", from, undefined, undefined);
  await until(() => gates.has(stoppedJob.id));
  const chat = r.hq.answer("Hold chat", { bot: "tim", via: "typed", origin: { kind: "voice" }, test: true });
  await until(() => !!botTurn("tim"));
  const stopChatId = botTurn("tim")!.turn.job_id!;
  const controller = new AbortController();
  // A second queued job can be cancelled without starting it.
  const cancelled = work("Cancelled while waiting", from, undefined, controller.signal);
  controller.abort();
  await cancelled.done;
  assert.ok(!r.hq.turns.live("tim").work?.some((w) => w.id === cancelled.id));
  const afterCancelled = work("After the cancelled job", from);
  await until(() => r.hq.turns.live("tim").work?.some((w) => w.id === afterCancelled.id) ?? false);
  assert.equal(gates.has(afterCancelled.id), false, "a cancelled waiting job does not let later work pass the active job");
  r.hq.stopBot("tim"); await Promise.all([stoppedJob.done, afterCancelled.done, chat]);
  assert.equal(botTurn("tim"), null); assert.equal(botTurn("tim", "work"), null);
  assert.ok(seen.find((s) => s.job === stopChatId)!.signal.aborted);
  assert.ok(!seen.some((s) => s.job === cancelled.id));
  const justController = new AbortController();
  const justJob = work("Cancel one", from, undefined, justController.signal);
  await until(() => gates.has(justJob.id));
  const justChat = r.hq.answer("Hold chat", { bot: "tim", via: "typed", origin: { kind: "voice" }, test: true });
  await until(() => !!botTurn("tim"));
  const justChatId = botTurn("tim")!.turn.job_id!;
  justController.abort(); await justJob.done;
  assert.equal(seen.find((s) => s.job === justChatId)!.signal.aborted, false);
  gates.get(justChatId)!(); await justChat;

  const remainingWork = work("Keep working while chat stops", from);
  await until(() => gates.has(remainingWork.id));
  const chatController = new AbortController();
  const cancelledChat = r.hq.answer("Hold chat", { bot: "tim", via: "typed", origin: { kind: "voice" }, test: true, signal: chatController.signal });
  await until(() => !!botTurn("tim"));
  chatController.abort(); await cancelledChat;
  assert.equal(seen.find((s) => s.job === remainingWork.id)!.signal.aborted, false);
  gates.get(remainingWork.id)!(); await remainingWork.done;

  for (const level of ["paused", "walled", "killed"] as const) {
    const running = work("Safety check", from);
    await until(() => gates.has(running.id));
    const chat = r.hq.answer("Hold chat", { bot: "tim", via: "typed", origin: { kind: "voice" }, test: true });
    await until(() => !!botTurn("tim"));
    await r.request("/safety", "POST", { level });
    await Promise.all([running.done, chat]);
    assert.equal(botTurn("tim"), null); assert.equal(botTurn("tim", "work"), null);
    assert.match((await call(twinName("tim"), twinSecret("tim", "toolbox-token")!, "Blocked")).text, /safety switch/);
    await r.request("/safety", "POST", { level: "open", pin: "1357" });
    await until(() => r.guard.level() === "open");
  }

  for (const mode of ["computer", "builtin"] as const) {
    updateBot("tim", mode === "computer" ? { computer: true } : { computer: false, engine: "builtin" });
    const running = work("Taking turns", from);
    await until(() => gates.has(running.id));
    assert.equal(seen.find((s) => s.job === running.id)!.input.lane, "chat");
    if (mode === "builtin") assert.match(r.hq.turns.live("tim").reason!, /built-in/);
    else assert.equal(r.hq.turns.live("tim").reason, undefined);
    let answered = false;
    const chat = r.hq.answer("Wait for the work", { bot: "tim", via: "typed", origin: { kind: "voice" }, test: true }).then(() => { answered = true; });
    if (mode === "computer") {
      await chat;
      assert.equal(answered, true);
      assert.equal(seen.at(-1)!.input.lane, "work");
    } else {
      await until(() => r.hq.turns.live("tim").state === "thinking");
      assert.equal(answered, false);
    }
    gates.get(running.id)!(); await running.done; await chat;
    assert.equal(answered, true);
  }
  updateBot("tim", { engine: "hermes", computer: false });
  const oldToken = twinSecret("tim", "toolbox-token")!;
  const removed = work("Removed bot", from); await until(() => gates.has(removed.id));
  assert.equal((await r.request("/bots/tim", "DELETE")).status, 200);
  await removed.done;
  assert.equal(getBot("tim"), undefined); assert.equal(twinSecret("tim", "toolbox-token"), null);
  assert.equal((await call(twinName("tim"), oldToken, "Removed")).status, 401);
  console.log("Work and chat run together, stay separate, stop safely and keep one result per job.");
} finally { for (const release of gates.values()) release(); await r.close(); }
