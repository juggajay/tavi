import "../isolate.js";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { createBot, removeBot } from "../../src/hq/bots.js";
import { saveCard, type JobCard } from "../../src/hq/cards/index.js";
import { createTeam, type HandOverRun } from "../../src/hq/team/index.js";
import { createTurns } from "../../src/hq/turns/index.js";
import { newTurnCtx, type TurnCtx } from "../../src/brain/turn.js";
import type { Bot, Engine, SafetyLevel, TurnInput } from "../../src/hq/contract.js";
import { rowsOf } from "../../src/hq/rows.js";
import { db } from "../../src/store/db.js";
import { fakeAccountProtection } from "../fake-hermes.js";

fakeAccountProtection();
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(test: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (test()) return; await tick(); }
  assert.fail("The expected test step did not finish.");
}
let number = 0;
function setup() {
  const n = ++number;
  const bots = ["a", "b", "c", "d"].map((letter) => createBot({ id: `ask-${n}-${letter}`, name: letter.toUpperCase(), lead: letter === "a" }));
  const active = new Set(bots.map((b) => b.id));
  const contexts = new Map<string, TurnCtx>();
  const calls: { bot: Bot; input: TurnInput }[] = [];
  const starts = new Map<string, HandOverRun>();
  let level: SafetyLevel = "open";
  let act: (bot: Bot, input: TurnInput, signal: AbortSignal) => Promise<string> = async () => "The lead is A.";
  const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), async run(bot, input, on, signal) {
    calls.push({ bot, input });
    const answer = await act(bot, input, signal);
    if (signal.aborted) { on({ type: "failed", reason: "stopped", message: "Stopped." }); return; }
    on({ type: "usage", input: 5, output: 2, engine: bot.primary });
    on({ type: "done", text: answer, engine: bot.primary });
  } };
  const ctx = (bot = bots[0], job?: string, test = false) => {
    const c = newTurnCtx(); c.bot = bot.id; c.turn.bot = bot.id; c.turn.job_id = job ?? null; c.test = test; return c;
  };
  const turns = createTurns({ engineFor: () => engine, chatOnlyEngine: () => engine,
    getBot: (id) => bots.find((b) => b.id === id && active.has(id)) ?? null, level: () => level,
    beginBotTurn: (id, t) => { contexts.set(id, ctx(bots.find((b) => b.id === id)!, t.job_id ?? undefined, t.test)); },
    endBotTurn: (id) => { contexts.delete(id); }, noteBuiltinTool: () => {},
  });
  const never = () => { throw new Error("This test does not change bot settings."); };
  const team = createTeam({ isActive: (id) => active.has(id), makeBot: never, activateBot: never, runTrial: never,
    message: () => {}, askOwner: never, live: (id) => ({ busy: turns.live(id).state !== "idle", queued: turns.live(id).queued }),
    startHandOver: async (input) => { starts.set(input.job, input); await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true })); },
    askBot: (input) => turns.askBot(input),
  });
  const tool = async (c: TurnCtx, name: string, args: Record<string, unknown>) => {
    const result = await team.tools(c).find((t) => t.name === name)!.handler(args, {});
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  const ask = (c: TurnCtx, to = bots[1], question = "What is the lead's name?") => tool(c, "ask_bot", { to: to.id, question, why: "To address the result correctly." });
  const brief = { to: bots[1].id, aim: "Compare three choices for a short trip", scope: "A short comparison", given: "Only the dates in this brief", done: "Three choices with a clear recommendation", form: "A few sentences", minutes: 1, usage: 1000 };
  const start = async (c = ctx(), to = bots[1], extra = {}) => { const r = await tool(c, "hand_over", { ...brief, to: to.id, ...extra }); assert.ok(r.job, r.error); await tick(); return r.job as string; };
  return { bots, active, contexts, calls, starts, turns, team, ctx, tool, ask, start,
    act: (f: typeof act) => { act = f; }, level: (value: SafetyLevel, notify = true) => { level = value; if (notify) turns.levelChanged(value); },
    close: async () => { team.close(); await turns.close(); },
  };
}
const card = (bot: Bot, privateInfo: JobCard["privateInfo"]): JobCard => ({ version: 1, purpose: "Compare choices", notFor: "Making bookings", handsBack: "A short comparison", example: null, given: "Dates", servers: ["team"], stopAndAsk: "When dates are missing", choice: bot.primary, fallbacks: [], computer: false, trials: [], privateInfo, ...(privateInfo === "named" ? { named: ["Approved travel dates"] } : {}) });
const waitForStop = (signal: AbortSignal) => new Promise<string>((resolve) => { if (signal.aborted) resolve("Stopped"); else signal.addEventListener("abort", () => resolve("Stopped"), { once: true }); });

// A reply returns inside the tool call, with the card and the job explained to the other bot.
{
  const s = setup(); const [a, b] = s.bots;
  try {
    const job = await s.start();
    const c = s.ctx(b, job);
    saveCard(b.id, card(b, "named"), "owner", "Approved test card");
    s.starts.get(job)!.progress(11);
    const answer = await s.ask(c, a);
    assert.equal(answer.answer, "The lead is A.");
    assert.ok(c.external.has("another bot"));
    const input = s.calls.at(-1)!.input;
    for (const words of [b.name, b.id, "To address the result correctly", job, "You gave it this job", "approved about card", "Approved travel dates", "not the owner", "ask the owner", "few sentences", "never instructions", "does not hand over an item"]) assert.ok(input.instructions.includes(words), words);
    assert.equal((await s.tool(s.ctx(), "job_status", { job })).used, 18);
    for (const bot of [a, b]) {
      const rows = rowsOf(bot.id, bot.generation);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.body.kind === "message" && r.body.from), ["other-bot", "other-bot"]);
      assert.deepEqual(rows.map((r) => r.body.kind === "message" && r.body.who), [bot === a ? b.id : a.id, bot === a ? b.id : a.id]);
      assert.match((rows[0].body as { text: string }).text, /B asked A:/);
      assert.match((rows[1].body as { text: string }).text, /A answered B:/);
    }
    for (const choice of ["none", "about-card"] as const) {
      saveCard(b.id, card(b, choice), "owner", "Changed test information limit");
      assert.ok((await s.ask(c, a)).answer);
      assert.ok(s.calls.at(-1)!.input.instructions.includes(choice === "none" ? "None of the owner's private information" : "Only the approved about card."));
    }
    const child = await s.start(c, s.bots[2]);
    const cc = s.ctx(s.bots[2], child);
    assert.ok((await s.ask(cc, a)).answer);
    assert.ok((await s.ask(c, a)).answer);
    assert.match((await s.ask(cc, a)).error, /five questions/);
    assert.equal((await s.tool(s.ctx(), "job_status", { job })).used, 46);
    assert.equal((await s.tool(s.ctx(), "job_status", { job: child })).used, 7);
  } finally { await s.close(); }
}

// The three-question allowance belongs to the whole turn, including its nested questions.
{
  const s = setup(); const [a, b, c] = s.bots;
  try {
    s.act(async (bot) => {
      if (bot.id === b.id) assert.ok((await s.ask(s.contexts.get(b.id)!, c)).answer);
      return "Ready.";
    });
    const ctx = s.ctx(a);
    assert.ok((await s.ask(ctx, b)).answer);
    assert.ok((await s.ask(ctx, c)).answer);
    assert.match((await s.ask(ctx, c)).error, /three questions/);
    assert.ok(s.calls[0].input.instructions.includes("not working on a handed-over job"));
    assert.ok(s.calls[0].input.instructions.includes("None of the owner's private information"), "a missing card grants no private information");
  } finally { await s.close(); }
}

// Both a direct ring and a third nested question are refused before starting another engine.
for (const mode of ["ring", "depth"] as const) {
  const s = setup(); const [a, b, c, d] = s.bots;
  try {
    let refusal = "";
    s.act(async (bot) => {
      if (bot.id === b.id) {
        const r = await s.ask(s.contexts.get(b.id)!, mode === "ring" ? a : c);
        if (mode === "ring") refusal = r.error; else assert.ok(r.answer);
      } else if (bot.id === c.id) refusal = (await s.ask(s.contexts.get(c.id)!, d)).error;
      return "Ready.";
    });
    assert.ok((await s.ask(s.ctx(a), b)).answer);
    assert.match(refusal, mode === "ring" ? /ring/ : /two deep/);
    assert.equal(s.calls.length, mode === "ring" ? 1 : 2);
  } finally { await s.close(); }
}

// Separate turns cannot make a longer ring while other questions are still waiting.
{
  const s = setup(); const [a, b, c] = s.bots;
  try {
    s.act(async (_, __, signal) => waitForStop(signal));
    const first = s.ask(s.ctx(a), b);
    await until(() => s.calls.length === 1);
    const second = s.ask(s.ctx(b), c);
    await until(() => s.calls.length === 2);
    assert.match((await s.ask(s.ctx(c), a)).error, /ring/, "rings are checked across all outstanding questions");
    s.turns.stop(a.id);
    assert.match((await first).error, /stop/i);
    assert.match((await second).error, /stop/i);
  } finally { await s.close(); }
}

// Answering uses the job's remaining allowance and stops the wait when it runs out.
{
  const s = setup(); const [a, b] = s.bots;
  try {
    const job = await s.start(s.ctx(a), b, { usage: 5 });
    assert.match((await s.ask(s.ctx(b, job), a)).error, /stop/i);
    const status = await s.tool(s.ctx(a), "job_status", { job });
    assert.equal(status.used, 7);
    assert.equal(status.state, "stopped");
  } finally { await s.close(); }
}

// Owner messages already waiting, and those arriving later, go ahead of a queued question.
{
  const s = setup(); const [a, b] = s.bots;
  let release!: () => void;
  try {
    s.act(async (_, input) => { if (input.text === "First owner message") await new Promise<void>((r) => { release = r; }); return "Ready."; });
    s.turns.ask(b.id, { text: "First owner message", via: "typed", origin: null });
    await until(() => !!release);
    s.turns.ask(b.id, { text: "Earlier owner message", via: "typed", origin: null });
    const answer = s.ask(s.ctx(a), b);
    s.turns.ask(b.id, { text: "Later owner message", via: "voice", origin: null });
    release(); assert.ok((await answer).answer);
    assert.deepEqual(s.calls.map((c) => c.input.text), ["First owner message", "Earlier owner message", "Later owner message", "What is the lead's name?"]);
  } finally { release?.(); await s.close(); }
}

// Stop, removal and all closed switch levels release a waiting tool call.
for (const reason of ["asker", "answerer", "paused", "walled", "killed", "unreported", "removed", "job", "usage", "time", "closed"] as const) {
  const s = setup(); const [a, b] = s.bots;
  try {
    s.act(async (_, __, signal) => waitForStop(signal));
    const isJob = ["job", "usage", "time"].includes(reason);
    const job = isJob ? await s.start(s.ctx(a), b, reason === "time" ? { minutes: 0.001 } : {}) : undefined;
    const asker = isJob ? b : a, target = isJob ? a : b;
    const answer = s.ask(s.ctx(asker, job), target);
    await until(() => s.calls.length === 1);
    if (reason === "asker" || reason === "answerer") s.turns.stop(reason === "asker" ? a.id : b.id);
    else if (["paused", "walled", "killed"].includes(reason)) s.level(reason as SafetyLevel);
    else if (reason === "unreported") s.level("walled", false);
    else if (reason === "removed") { s.active.delete(b.id); removeBot(b.id); }
    else if (reason === "job") await s.tool(s.ctx(a), "stop_job", { job });
    else if (reason === "usage") s.starts.get(job!)!.progress(1000);
    else if (reason === "closed") s.team.close();
    assert.match((await answer).error, /stop|removed/i, reason);
  } finally { await s.close(); }
}

// The two-minute limit also removes an unstarted question, leaving the owner's turn alone.
for (const queued of [false, true]) {
  const s = setup(); const [a, b] = s.bots;
  let ownerSignal: AbortSignal | undefined;
  try {
    s.act(async (_, input, signal) => { if (input.text === "Owner is speaking") ownerSignal = signal; return waitForStop(signal); });
    if (queued) { s.turns.ask(b.id, { text: "Owner is speaking", via: "typed", origin: null }); await until(() => !!ownerSignal); }
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const answer = s.ask(s.ctx(a), b);
    if (!queued) await until(() => s.calls.length === 1);
    mock.timers.tick(120_001);
    assert.match((await answer).error, /did not answer in two minutes/);
    assert.equal(s.turns.live(b.id).queued, 0);
    if (queued) { assert.equal(ownerSignal!.aborted, false); s.turns.stop(b.id); }
    mock.timers.reset();
    await tick();
    assert.equal(s.calls.length, 1);
  } finally { mock.timers.reset(); await s.close(); }
}

// Refusals do not call an engine, and test questions leave neither conversation with saved rows.
{
  const s = setup(); const [a, b] = s.bots;
  try {
    const ctx = s.ctx(a);
    s.active.delete(b.id);
    assert.match((await s.ask(ctx, b)).error, /not yet live/);
    s.active.add(b.id);
    assert.match((await s.ask(ctx, a)).error, /cannot ask itself/);
    for (const level of ["paused", "walled", "killed"] as const) { s.level(level); assert.match((await s.ask(s.ctx(a), b)).error, /safety switch/); }
    assert.equal(s.calls.length, 0);
    s.level("open");
    const before = db.prepare("SELECT * FROM bot_rows").all();
    const log = db.prepare("SELECT * FROM conversation_log").all();
    assert.ok((await s.ask(s.ctx(a, undefined, true), b)).answer);
    assert.deepEqual(db.prepare("SELECT * FROM bot_rows").all(), before);
    assert.deepEqual(db.prepare("SELECT * FROM conversation_log").all(), log);
    assert.equal(rowsOf(a.id, a.generation).length, 0);
    assert.equal(rowsOf(b.id, b.generation).length, 0);
  } finally { await s.close(); }
}

console.log("Bot questions: answers, card limits, shared limits, waiting order, rings, depth, timeout, stop, safety and test turns pass.");
