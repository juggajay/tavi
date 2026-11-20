import "../isolate.js";
import assert from "node:assert/strict";
import type { Bot, Engine, EngineEvent, Row, SafetyLevel, TurnInput } from "../../src/hq/contract.js";
import { createTurns, type Ask, type TurnDeps, type TurnResult, type Turns } from "../../src/hq/turns/index.js";
import { rowsOf } from "../../src/hq/rows.js";
import { db } from "../../src/store/db.js";
import { bus } from "../../src/events.js";
import { decide, expireDue, requestEmailApproval, saveDraft } from "../../src/broker/broker.js";
import { createItem, publishItem } from "../../src/store/items.js";
import { newTurn } from "../../src/brain/turn.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(fn: () => boolean) {
  const end = Date.now() + 3000;
  while (!fn()) { assert.ok(Date.now() < end, "the expected work finished in time"); await delay(2); }
}
const bot = (id: string): Bot => ({ id, name: id.toUpperCase(), role: "Helping", soul: "", look: { shape: "circle", colour: "blue" }, engine: "hermes", primary: { provider: "anthropic", model: "test-model" }, fallbacks: [{ provider: "openai-codex", model: "other-model" }], servers: "all", computer: false, voice: "ash", box: { user: `bot-${id}`, display: null, vncPort: null, cdpPort: null }, generation: 1, lead: false, createdAt: new Date().toISOString() });
type ScriptStep = EngineEvent | { wait: number } | ((on: (event: EngineEvent) => void, signal: AbortSignal) => void | Promise<void>);
class FakeEngine implements Engine {
  readonly kind = "hermes";
  calls: Array<{ bot: Bot; input: TurnInput; signal: AbortSignal }> = [];
  aborts = 0;
  starts = 0;
  scripts: ScriptStep[][] = [];
  ready = async () => { this.starts++; return { ok: true }; };
  async run(bot: Bot, input: TurnInput, on: (e: EngineEvent) => void, signal: AbortSignal) {
    this.calls.push({ bot, input, signal });
    const script = this.scripts.shift() ?? [{ type: "done", text: `Answer to ${input.text}`, engine: bot.primary }];
    signal.addEventListener("abort", () => { this.aborts++; }, { once: true });
    for (const step of script) {
      if (signal.aborted) break;
      if (typeof step === "function") await step(on, signal);
      else if ("wait" in step) await new Promise<void>((resolve) => {
        const ended = () => { clearTimeout(timer); signal.removeEventListener("abort", ended); resolve(); };
        const timer = setTimeout(ended, step.wait);
        signal.addEventListener("abort", ended, { once: true });
      });
      else on(step);
    }
    if (signal.aborted) on({ type: "failed", reason: "stopped", message: "" });
  }
}
let group = 0;
function setup() {
  const ids = [`a${++group}`, `b${group}`, `c${group}`, `d${group}`];
  const bots = new Map(ids.map((id) => [id, bot(id)]));
  const engine = new FakeEngine();
  const chat = new FakeEngine();
  const begins: Array<{ bot: string; turn: Parameters<TurnDeps["beginBotTurn"]>[1] }> = [];
  const ends: string[] = [];
  const tools: string[] = [];
  let level: SafetyLevel = "open";
  let now = new Date(2026, 10, 18, 12);
  const deps: TurnDeps = { getBot: (id) => bots.get(id) ?? null, engineFor: () => engine, chatOnlyEngine: () => chat, level: () => level,
    beginBotTurn: (id, turn) => { begins.push({ bot: id, turn }); }, endBotTurn: (id) => { ends.push(id); }, noteBuiltinTool: (_, name) => { tools.push(name); }, now: () => now };
  const turns = createTurns(deps);
  return { ids, bots, engine, chat, begins, ends, tools, deps, turns, level: (l: SafetyLevel, notify = true) => { level = l; if (notify) turns.levelChanged(l); }, time: (d: Date) => { now = d; } };
}
function ask(turns: Turns, id: string, text: string, extra: Partial<Ask> = {}) {
  let resolve!: (r: TurnResult) => void;
  const result = new Promise<TurnResult>((r) => { resolve = r; });
  const queued = turns.ask(id, { text, via: "typed", origin: null, ...extra, onDone: resolve });
  return { ...queued, result };
}
const answers = (id: string) => rowsOf(id, 1).filter((r) => r.body.kind === "message" && r.body.from === "bot");
const notices = (id: string) => rowsOf(id, 1).filter((r) => r.body.kind === "notice");

// Work stays in order for one bot, and another bot does not have to wait for it.
{
  const s = setup();
  const [a, b] = s.ids;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  s.engine.scripts.push([async () => gate, { type: "done", text: "First answer", engine: bot(a).primary }]);
  const first = ask(s.turns, a, "First");
  const second = ask(s.turns, a, "Second");
  const parallel = ask(s.turns, b, "Other bot");
  assert.equal(first.position, 0);
  assert.equal(second.position, 1);
  assert.equal(parallel.position, 0);
  assert.equal((await parallel.result).ok, true);
  assert.equal(s.engine.calls.filter((c) => c.bot.id === a).length, 1);
  assert.equal(s.turns.live(a).queued, 1);
  release();
  await Promise.all([first.result, second.result]);
  assert.deepEqual(s.engine.calls.filter((c) => c.bot.id === a).map((c) => c.input.text), ["First", "Second"]);
  assert.equal(s.turns.live(a).state, "idle");
  assert.equal(s.turns.liveAll().length, 2);
  assert.deepEqual(s.begins.map((b) => b.bot).sort(), [...s.ends].sort());
  assert.ok(s.engine.calls[0].input.instructions.includes("Now:"));
  assert.ok(s.engine.calls[0].input.instructions.includes("typed this on the phone"));
  assert.equal(s.engine.calls[0].input.conversation, `lh-${a}-g1`);
  await s.turns.close();
}

// Every kind of engine event reaches the right part of the conversation.
{
  const s = setup(); const [a] = s.ids;
  const seen: Row[] = []; const lives: string[] = [];
  s.turns.on("row", (r) => seen.push(r));
  s.turns.on("live", (l) => lives.push(`${l.state}:${l.doing}`));
  s.engine.scripts.push([
    { type: "thinking", delta: "Considering the plan" }, { type: "status", text: "Connecting" },
    { type: "text", delta: "First" }, { type: "text", delta: " second" },
    () => s.time(new Date(2026, 10, 18, 12, 0, 0, 160)), { type: "text", delta: " third" },
    { type: "tool", phase: "start", id: "hidden", name: "tool_search" }, { type: "tool", phase: "end", id: "hidden", name: "tool_search" },
    { type: "tool", phase: "start", id: "one", name: "web_search" }, { type: "tool", phase: "end", id: "one", name: "web_search", ok: true },
    { type: "tool", phase: "start", id: "two", name: "mcp__drawings__read_sheet" }, { type: "tool", phase: "end", id: "two", name: "mcp__drawings__read_sheet", ok: false },
    () => s.begins.at(-1)!.turn.note!("Checking the sizes"),
    { type: "status", text: "Claude's limit is reached, carrying on with OpenAI" },
    { type: "usage", input: 20, output: 10, engine: bot(a).fallbacks[0] },
    { type: "done", text: "The full final answer", engine: bot(a).fallbacks[0] },
    { type: "text", delta: "Must be ignored" },
  ]);
  const result = await ask(s.turns, a, "Check", { onScreen: "On screen now: the drawing" }).result;
  assert.equal(result.text, "The full final answer");
  const streamed = seen.filter((r) => r.body.kind === "message" && r.body.from === "bot");
  assert.equal(streamed.length, 3, "the first piece, the later piece, and the final answer are published");
  assert.equal(new Set(streamed.map((r) => r.seq)).size, 1);
  assert.equal(answers(a).length, 1);
  const finalBody = streamed.at(-1)!.body;
  assert.equal(finalBody.kind === "message" && finalBody.streaming, false);
  const steps = rowsOf(a, 1).filter((r) => r.body.kind === "step").map((r) => r.body);
  assert.equal(steps.length, 2);
  assert.ok(steps[0].kind === "step" && steps[0].label === "Searching the web" && steps[0].state === "ok" && steps[0].ms === 0);
  assert.ok(steps[1].kind === "step" && steps[1].state === "failed" && steps[1].label !== "Working on it");
  assert.deepEqual(s.tools, ["tool_search", "web_search"]);
  assert.ok(lives.includes("thinking:Considering the plan"));
  assert.ok(lives.includes("working:Checking the sizes"));
  assert.equal(s.turns.live(a).steps, 2);
  assert.equal(notices(a).length, 1);
  assert.deepEqual(s.turns.usage(a).today["openai-codex"], { input: 20, output: 10 });
  assert.ok(s.engine.calls[0].input.instructions.includes("On screen now: the drawing"));
  await s.turns.close();
}

// A failed answer is taken back, and each reason has a useful next step.
for (const reason of ["not_signed_in", "limit", "stopped", "engine_down", "error"] as const) {
  const s = setup(); const [a] = s.ids;
  const dropped: unknown[] = [];
  s.turns.on("row-dropped", (row) => dropped.push(row));
  s.engine.scripts.push([{ type: "text", delta: "Provider warning" }, { type: "tool", phase: "start", id: "unfinished", name: "terminal" }, { type: "failed", reason, message: "Something broke", resetsAt: "9pm" }]);
  const result = await ask(s.turns, a, "Try").result;
  assert.equal(result.failed, reason);
  assert.equal(answers(a).length, 0);
  assert.equal(dropped.length, 1);
  const notice = notices(a)[0].body;
  assert.ok(notice.kind === "notice");
  assert.equal(notice.text, result.text);
  assert.equal(notice.tone, reason === "stopped" ? "info" : "warn");
  if (reason === "not_signed_in") assert.equal(notice.action, "sign_in");
  if (reason === "limit") assert.match(result.text, /Claude plan.*9 pm/);
  if (reason === "stopped") assert.equal(result.text, "Stopped.");
  assert.equal(s.engine.starts, reason === "engine_down" ? 1 : 0);
  assert.equal(s.begins.length, 1); assert.equal(s.ends.length, 1);
  assert.ok(rowsOf(a, 1).some((r) => r.body.kind === "step" && r.body.state === "failed"));
  await s.turns.close();
}

// Stop cancels the running engine, then the waiting message gets its turn.
{
  const s = setup(); const [a, b] = s.ids;
  s.engine.scripts.push([{ type: "text", delta: "Half an answer" }, { wait: 10000 }]);
  const first = ask(s.turns, a, "Slow");
  const next = ask(s.turns, a, "Next");
  await until(() => s.engine.calls.length === 1);
  s.turns.stop(a);
  assert.equal((await first.result).text, "Stopped.");
  assert.equal((await next.result).ok, true);
  assert.equal(s.engine.aborts, 1);
  s.engine.scripts.push([{ wait: 10000 }], [{ wait: 10000 }]);
  const one = ask(s.turns, a, "Again"); const two = ask(s.turns, b, "Also slow");
  await until(() => s.engine.calls.length === 4);
  s.turns.stopAll();
  assert.equal((await one.result).failed, "stopped");
  assert.equal((await two.result).failed, "stopped");
  assert.equal(s.begins.length, s.ends.length);
  await s.turns.close();
}

// The safety level is read at the start, and a change stops work already running.
{
  const s = setup(); const [a] = s.ids;
  s.level("walled");
  await ask(s.turns, a, "Talk").result; await ask(s.turns, a, "Talk more").result;
  assert.equal(s.chat.calls.length, 2); assert.equal(s.engine.calls.length, 0);
  assert.equal(notices(a).length, 1);
  const wall = notices(a)[0].body;
  assert.ok(wall.kind === "notice" && wall.action === "open_switch");
  s.level("open"); s.level("walled");
  await ask(s.turns, a, "Talk again").result;
  assert.equal(notices(a).length, 2);
  s.bots.get(a)!.generation = 2;
  await ask(s.turns, a, "Fresh conversation").result;
  assert.equal(rowsOf(a, 2).filter((r) => r.kind === "notice").length, 1);
  for (const level of ["paused", "killed"] as const) {
    s.level(level);
    const before: number = s.chat.calls.length + s.engine.calls.length;
    const result = await ask(s.turns, a, level).result;
    assert.match(result.text, new RegExp(level));
    assert.equal(s.chat.calls.length + s.engine.calls.length, before);
    assert.ok(rowsOf(a, 2).some((r) => r.body.kind === "message" && r.body.text === level));
  }
  s.level("open"); s.engine.scripts.push([{ wait: 10000 }]);
  const running = ask(s.turns, a, "Work");
  await until(() => s.engine.calls.length === 1);
  s.level("walled");
  assert.equal((await running.result).text, "Stopped by the safety switch.");
  assert.equal(s.engine.aborts, 1);
  assert.equal(s.begins.length, s.ends.length);
  await s.turns.close();
}

// Cards follow their job, including decisions that arrive after the engine has finished.
for (const decision of ["approve", "reject", "expire"] as const) {
  const s = setup(); const [a, b] = s.ids;
  let approval!: ReturnType<typeof requestEmailApproval>;
  let foreign!: ReturnType<typeof requestEmailApproval>;
  s.engine.scripts.push([
    () => {
      const jobId = s.begins.at(-1)!.turn.job_id!;
      const turn = newTurn({ job_id: jobId });
      publishItem(createItem(turn, { kind: "note", title: "Sizes", payload: { rows: [], text: "A note" } }), turn);
      const unrelated = newTurn({ job_id: "someone-else" });
      publishItem(createItem(unrelated, { kind: "note", title: "Unrelated", payload: { rows: [], text: "Another note" } }), unrelated);
      approval = requestEmailApproval(saveDraft({ account: "demo", to: ["builder@example.invalid"], subject: "Send the sizes", body: "The sizes", jobId }), jobId);
      foreign = requestEmailApproval(saveDraft({ account: "demo", to: ["builder@example.invalid"], subject: "Other job", body: "Other", jobId: "someone-else" }), "someone-else");
    },
    { type: "done", text: "Waiting for your tap", engine: bot(a).primary },
  ]);
  assert.equal((await ask(s.turns, a, "Prepare it").result).ok, true);
  assert.equal(s.turns.live(a).state, "waiting_for_owner");
  const cards = rowsOf(a, 1).filter((r) => r.kind === "card");
  assert.equal(cards.length, 2);
  const card = cards.find((r) => r.body.kind === "card" && r.body.card === "approval")!;
  assert.ok(card.body.kind === "card" && card.body.state === "waiting");
  assert.equal(rowsOf(b, 1).length, 0);
  await decide(foreign.id, foreign.nonce, "reject");
  assert.equal(s.engine.calls.length, 1);
  if (decision === "expire") {
    db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00Z", approval.id);
    expireDue();
  } else await decide(approval.id, approval.nonce, decision);
  await until(() => s.engine.calls.length === 2 && s.turns.live(a).state === "idle");
  const rewritten = rowsOf(a, 1).find((r) => r.seq === card.seq)!;
  assert.ok(rewritten.rev > card.rev);
  assert.ok(rewritten.body.kind === "card" && rewritten.body.state === (decision === "approve" ? "approved" : decision === "reject" ? "declined" : "expired"));
  assert.equal(s.engine.calls[1].bot.id, a);
  assert.match(s.engine.calls[1].input.text, /^The owner (approved|declined|expired): Send the sizes\. Result: /);
  assert.ok(rowsOf(a, 1).some((r) => r.body.kind === "message" && r.body.from === "system"));
  await decide(approval.id, approval.nonce, "reject");
  assert.equal(s.engine.calls.length, 2, "a repeat tap does not queue another message");
  await s.turns.close();
}

// A bot's reply goes back once. The hop count follows further messages in that chain.
{
  const s = setup(); const [a, b, c] = s.ids;
  s.turns.tell(a, b, "What do you think?");
  await until(() => s.engine.calls.length === 2 && s.turns.live(a).state === "idle");
  assert.deepEqual(s.engine.calls.map((r) => r.bot.id), [b, a]);
  assert.ok(rowsOf(b, 1).some((r) => r.body.kind === "message" && r.body.from === "other-bot" && r.body.who === a));
  assert.ok(rowsOf(a, 1).some((r) => r.body.kind === "message" && r.body.who === b));
  assert.throws(() => s.turns.tell(a, b, "Too far", 4), /enough back and forth/);
  assert.throws(() => s.turns.tell(a, a, "Self"), /itself/);
  s.engine.scripts.push([
    () => { assert.throws(() => s.turns.tell(b, c, "Further"), /enough back and forth/); },
    { type: "done", text: "Last reply", engine: bot(b).primary },
  ]);
  s.turns.tell(a, b, "Last hop", 3);
  await until(() => s.engine.calls.length === 3 && s.turns.live(b).state === "idle");
  assert.equal(s.engine.calls.length, 3);
  assert.ok(notices(b).some((r) => r.body.kind === "notice" && /enough back and forth/.test(r.body.text)));
  assert.throws(() => s.turns.tell(a, b, "Bad count", NaN), /whole number/);
  s.engine.scripts.push([{ type: "failed", reason: "not_signed_in", message: "No sign-in" }]);
  s.turns.tell(a, b, "Can you help?");
  await until(() => s.engine.calls.length === 5 && s.turns.live(a).state === "idle");
  assert.match(s.engine.calls[4].input.text, /isn't signed in/);
  await s.turns.close();
}

// Room members hear earlier answers in order, with a hard cap of four members.
{
  const s = setup();
  const result = await s.turns.askRoom(s.ids, "Plan the job");
  assert.equal(result.length, 4);
  assert.deepEqual(s.engine.calls.map((r) => r.bot.id), s.ids);
  assert.equal(s.engine.calls[0].input.text, "Plan the job");
  for (let i = 1; i < 4; i++) for (let j = 0; j < i; j++) assert.ok(s.engine.calls[i].input.text.includes(result[j].result.text));
  await assert.rejects(s.turns.askRoom([...s.ids, "extra"], "Too many"), /at most four/);
  await assert.rejects(s.turns.askRoom([s.ids[0], s.ids[0]], "Repeated"), /only once/);
  assert.deepEqual(await s.turns.askRoom([], "Empty"), []);
  await s.turns.close();
}

// Usage follows the local day and the week starting Monday, and survives a new queue.
{
  const s = setup(); const [a] = s.ids;
  const count = async (provider: "anthropic" | "openai-codex", input: number) => {
    s.engine.scripts.push([{ type: "usage", input, output: 2, engine: { provider, model: "test" } }, { type: "done", text: "Done", engine: { provider, model: "test" } }]);
    await ask(s.turns, a, "Count").result;
  };
  s.time(new Date(2026, 10, 18, 23));
  await count("anthropic", 10); await count("openai-codex", 20);
  assert.equal(s.turns.usage(a).today.anthropic!.input, 10);
  assert.equal(s.turns.usage(a).today["openai-codex"]!.input, 20);
  s.time(new Date(2026, 10, 19, 1));
  assert.deepEqual(s.turns.usage(a).today, {});
  assert.equal(s.turns.usage(a).thisWeek.anthropic!.input, 10);
  await count("anthropic", 5);
  assert.equal(s.turns.usage(a).thisWeek.anthropic!.input, 15);
  const another = createTurns(s.deps);
  assert.deepEqual(another.usage(a), s.turns.usage(a));
  await another.close();
  s.time(new Date(2026, 10, 23));
  assert.deepEqual(s.turns.usage(a).thisWeek, {});
  await count("anthropic", 3);
  assert.equal(s.turns.usage(a).thisWeek.anthropic!.input, 3);
  await s.turns.close();
}

// Thrown failures and missing final events do not strand the toolbox turn or the queue.
{
  const s = setup(); const [a] = s.ids;
  s.engine.scripts.push([() => { throw new Error("A short fault"); }], []);
  assert.match((await ask(s.turns, a, "Throw").result).text, /A short fault/);
  assert.equal((await ask(s.turns, a, "No ending").result).failed, "engine_down");
  assert.equal(s.engine.starts, 1);
  assert.equal(s.begins.length, 2); assert.equal(s.ends.length, 2);
  s.deps.beginBotTurn = () => { throw new Error("Could not open the turn"); };
  assert.equal((await ask(s.turns, a, "Begin fails").result).failed, "error");
  assert.equal(s.ends.length, 3);
  s.deps.beginBotTurn = () => {};
  s.engine.scripts.push([{ type: "failed", reason: "limit", message: "limit" }]);
  await ask(s.turns, a, "Morning work", { via: "routine" }).result;
  assert.match((db.prepare("SELECT value FROM settings WHERE key = 'limit_missed'").get() as { value: string }).value, /Morning work/);
  assert.ok(s.engine.calls.at(-1)!.input.instructions.includes("nobody listening"));
  await s.turns.close();
}
// All built-in tool labels stay in plain words, including an unknown tool.
{
  const s = setup(); const [a] = s.ids;
  const expected: Record<string, string> = { web_search: "Searching the web", web_extract: "Reading a web page", terminal: "Running a command on its computer", read_file: "Working on a file on its computer", write_file: "Working on a file on its computer", patch: "Working on a file on its computer", browser_click: "Using its browser", execute_code: "Running some code", todo: "Planning the steps", skills_list: "Checking how it's done", unfamiliar: "Working" };
  s.engine.scripts.push([
    ...Object.keys(expected).flatMap((name): ScriptStep[] => [{ type: "tool", phase: "start", id: name, name }, { type: "tool", phase: "end", id: name, name, ok: true }]),
    { type: "done", text: "Done", engine: bot(a).primary },
  ]);
  await ask(s.turns, a, "Use the tools").result;
  for (const row of rowsOf(a, 1)) if (row.body.kind === "step") assert.equal(row.body.label, expected[row.body.tool]);
  assert.deepEqual(s.tools, Object.keys(expected));
  await s.turns.close();
}

// A repeated safety report is harmless. Closing the queue cancels queued work too.
{
  const s = setup(); const [a] = s.ids;
  s.level("walled");
  s.chat.scripts.push([() => s.level("walled"), { type: "done", text: "Still talking", engine: bot(a).primary }]);
  assert.equal((await ask(s.turns, a, "Talk").result).ok, true);
  assert.equal(s.chat.aborts, 0);
  s.chat.scripts.push([{ type: "failed", reason: "engine_down", message: "Unavailable" }]);
  assert.equal((await ask(s.turns, a, "Try the chat engine").result).failed, "engine_down");
  assert.equal(s.engine.starts, 1, "a failed engine gets one readiness request");
  assert.equal(s.engine.calls.length, 0, "the bot's own engine does not run while walled off");
  s.level("open");
  s.engine.scripts.push([{ wait: 10000 }]);
  const first = ask(s.turns, a, "Working");
  const second = ask(s.turns, a, "Waiting");
  await until(() => s.engine.calls.length === 1);
  await s.turns.close();
  assert.equal((await first.result).failed, "stopped");
  assert.equal((await second.result).failed, "stopped");
  assert.equal(s.engine.calls.length, 1);
  assert.throws(() => s.turns.ask(a, { text: "Closed", via: "typed", origin: null }), /closed/);
}

// Practice work has its own conversation, rows, and no saved usage or missed routine.
{
  const s = setup(); const [a] = s.ids;
  const seen: Row[] = [];
  s.turns.on("row", (row) => seen.push(row));
  const before = db.prepare("SELECT COUNT(*) n FROM bot_rows").get();
  const settings = db.prepare("SELECT COUNT(*) n FROM settings").get();
  s.engine.scripts.push([{ type: "usage", input: 50, output: 20, engine: bot(a).primary }, { type: "done", text: "Okay, <spoken>the drawing is ready.</spoken>", engine: bot(a).primary }]);
  const asked = ask(s.turns, a, "Show it", { test: true, via: "voice", images: ["https://example.invalid/picture"], onScreen: null });
  const result = await asked.result;
  assert.equal(result.spoken, "The drawing is ready.");
  assert.ok(s.engine.calls[0].input.instructions.includes("read aloud on a call")); assert.ok(s.engine.calls[0].input.instructions.includes("one or two short sentences"));
  assert.deepEqual(s.engine.calls[0].input.images, ["https://example.invalid/picture"]);
  assert.equal(s.engine.calls[0].input.conversation, `lh-${a}-test-${asked.job_id}`);
  assert.equal(s.begins[0].turn.test, true);
  assert.equal(seen.length, 2);
  assert.deepEqual(db.prepare("SELECT COUNT(*) n FROM bot_rows").get(), before);
  assert.deepEqual(db.prepare("SELECT COUNT(*) n FROM settings").get(), settings);
  assert.equal(rowsOf(a, 1, { test: true, scope: asked.job_id }).length, 2);
  const logs = db.prepare("SELECT channel, job_id FROM conversation_log WHERE job_id = ?").all(asked.job_id) as Array<{ channel: string; job_id: string }>;
  assert.equal(logs.length, 2); assert.ok(logs.every((r) => r.channel === "test" && r.job_id.includes(a)));
  assert.equal((db.prepare("SELECT text FROM conversation_log WHERE job_id = ? AND role = 'assistant'").get(asked.job_id) as { text: string }).text, result.spoken);
  s.engine.scripts.push([{ type: "failed", reason: "limit", message: "limit", resetsAt: "9pm" }]);
  await ask(s.turns, a, "Practice routine", { test: true, via: "routine" }).result;
  assert.deepEqual(db.prepare("SELECT COUNT(*) n FROM settings").get(), settings);
  await s.turns.close();
}
assert.equal(bus.listenerCount("item"), 0, "closed queues leave no shared listeners");
console.log("hq-turns: ok");
