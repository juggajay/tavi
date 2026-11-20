import "../isolate.js";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { rig, until } from "./hq-api-fixture.test.js";
import { db } from "../../src/store/db.js";
import { decide, onBrokerEvent, type ApprovalView } from "../../src/broker/broker.js";
import { getBot, listBots } from "../../src/hq/bots.js";
import { currentCard, type JobCard } from "../../src/hq/cards/index.js";
import { teamTools } from "../../src/hq/team/index.js";
import { botTurn } from "../../src/hq/toolbox/turns.js";
import { runTool } from "../../src/hq/toolbox/calls.js";
import { newTurnCtx } from "../../src/brain/turn.js";
import type { Engine, TurnInput } from "../../src/hq/contract.js";

const card: JobCard = { version: 1, purpose: "Compare travel choices", notFor: "Booking or paying", handsBack: "Two sourced choices", example: "A short comparison", given: "Dates and places", servers: ["calc"], stopAndAsk: "When dates are missing", choice: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" }, fallbacks: [], computer: false, trials: [{ ask: "Compare two short trips", goodAnswer: "Two clear choices with costs" }], privateInfo: "none" };
const views = new Map<string, ApprovalView>();
const off = onBrokerEvent((e) => { if (e.type === "approval") views.set(e.approval.id, e.approval); });
let release!: () => void;
let hold = true, fail = false, missingReceipt = false, waitForStop = false;
const seen: { bot: string; input: TurnInput; test: boolean; job: string | null }[] = [];
const receipt = { summary: "Two routes compared", made: ["A comparison"], sources: [{ what: "The dates", where: "The brief" }], unsure: "Check the final price", proposals: [{ kind: "do", text: "Book a ticket" }] };
const brief = { to: "travel", aim: "Compare the available travel choices", scope: "Two routes", given: "Dates and places only", done: "Two clear choices with checked costs", form: "A short table", minutes: 1, usage: 1000 };
const read = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text);
const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), run: async (bot, input, on, signal) => {
  const ctx = botTurn(bot.id)!;
  seen.push({ bot: bot.id, input, test: ctx.test, job: ctx.turn.job_id });
  if (input.text === "Set up Travel") {
    const made = await runTool(bot.id, "team", "propose_bot", { id: "travel", name: "Travel", look: { shape: "moon", colour: "blue" }, card }, () => "open");
    assert.ok(read(made).approval);
  } else if (ctx.test) {
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    on({ type: "tool", id: "number", name: "mcp__calc__check", phase: "start" });
    on({ type: "tool", id: "number", name: "mcp__calc__check", phase: "end", ok: true });
    on({ type: "usage", engine: bot.primary, input: 8, output: 3 });
    if (fail) { on({ type: "failed", reason: "error", message: "The example needs work" }); return; }
  } else if (input.text.startsWith('{\n  "to"')) {
    assert.ok(input.instructions.includes("Use only this brief"));
    assert.ok(!input.instructions.includes("Recent conversation"));
    assert.match(input.conversation, /-brief-teamjob_/);
    on({ type: "usage", engine: bot.primary, input: 8, output: 3 });
    if (waitForStop) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    if (!missingReceipt && !signal.aborted) assert.ok(read(await runTool(bot.id, "team", "hand_back", receipt, () => "open")).handedBack);
  }
  if (!signal.aborted) on({ type: "done", text: "Two clear choices with costs", engine: bot.primary });
} };
const r = await rig(engine);
const call = async (name: string, args: Record<string, unknown> = {}, bot = "pebble") => {
  const ctx = newTurnCtx(); ctx.bot = bot;
  const t = teamTools(ctx).find((t) => t.name === name)!; assert.ok(t, name);
  return read(await t.handler(args, {}));
};
try {
  await r.request("/bots/pebble/messages", "POST", { text: "Set up Travel" });
  await until(() => views.size === 1 && r.hq.turns.live("pebble").state === "waiting_for_owner");
  const view = [...views.values()][0];
  assert.equal(getBot("travel"), undefined);
  const approval = decide(view.id, view.nonce, "approve");
  await until(() => !!release);
  assert.ok(getBot("travel"));
  assert.ok(!(await r.request("/state")).data.bots.some((b: { id: string }) => b.id === "travel"));
  assert.ok(!(await call("list_team")).some((b: { id: string }) => b.id === "travel"));
  assert.match((await call("hand_over", brief)).error, /not on the team/);
  assert.equal((await r.request("/bots/travel/messages", "POST", { text: "Too early" })).status, 409);
  hold = false; release();
  assert.equal((await approval).status, "verified");
  assert.ok((await r.request("/state")).data.bots.some((b: { id: string }) => b.id === "travel"));
  assert.equal(currentCard("travel")?.version, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bot_rows WHERE bot='travel'").get()?.n, 0);
  const trial = seen.find((s) => s.bot === "travel" && s.test)!;
  const trialRows = await r.request(`/bots/travel/rows?job=${trial.job}`);
  assert.ok(trialRows.data.rows.some((row: { body: { tool?: string } }) => row.body.tool === "mcp__calc__check"));
  assert.equal((await r.request(`/bots/pebble/rows?job=${trial.job}`)).data.rows.length, 0);
  assert.equal((await r.request("/bots/travel/rows?job=missing")).data.rows.length, 0);

  const groups = await r.request("/tool-groups", "GET", undefined, true);
  assert.equal(groups.status, 200); assert.equal(groups.data.length, 14);
  assert.match(groups.data.find((g: { id: string }) => g.id === "files").what, /folders you've allowed/);
  assert.equal((await r.request("/bots/travel/card", "GET", undefined, true)).data.versions.length, 1);
  assert.equal((await r.request("/bots/travel/card", "PUT", card, true)).status, 403);
  assert.equal((await r.request("/bots/travel/card/restore", "POST", { version: 1 }, true)).status, 403);
  const changed = await r.request("/bots/travel/card", "PUT", { ...card, purpose: "Compare rail choices" });
  assert.equal(changed.status, 200); assert.equal(changed.data.passed, true);
  assert.equal(changed.data.before.length, 1); assert.equal(changed.data.after.length, 1);
  assert.deepEqual(changed.data.after[0].tools, ["mcp__calc__check"]);
  assert.ok((await r.request(`/bots/travel/rows?job=${changed.data.after[0].job}`)).data.rows.length >= 2);
  assert.equal(currentCard("travel")?.version, 2);
  assert.equal(currentCard("travel")?.purpose, "Compare rail choices");
  assert.ok(!(await r.request("/state")).data.bots.some((b: { id: string }) => b.id.startsWith("try-")));
  assert.equal((await r.request("/bots/travel/card/restore", "POST", { version: 1 })).status, 200);
  assert.equal(currentCard("travel")?.version, 3);
  assert.equal(currentCard("travel")?.purpose, card.purpose);
  assert.equal((await r.request("/bots/travel/card/restore", "POST", { version: 999 })).status, 400);
  assert.equal((await r.request("/bots/travel/card", "PUT", { ...card, servers: ["calc", "calc"] })).status, 400);
  fail = true;
  const failed = await r.request("/bots/travel/card", "PUT", { ...card, purpose: "This trial fails" });
  assert.equal(failed.data.passed, false); assert.equal(currentCard("travel")?.version, 3);
  const madeFailed = await r.request("/bots", "POST", { id: "waiting", name: "Waiting", look: { shape: "moon", colour: "blue" }, card });
  assert.equal(madeFailed.data.passed, false);
  assert.ok(!(await r.request("/state")).data.bots.some((b: { id: string }) => b.id === "waiting"));
  fail = false;
  assert.equal((await r.request("/bots", "POST", { id: "direct", name: "Direct", look: { shape: "moon", colour: "blue" }, card })).data.passed, true);
  assert.equal(views.size, 1, "the PC request needs no second tap");

  assert.equal((await r.request("/about", "PUT", { text: "Prefers direct routes" }, true)).status, 403);
  assert.equal((await r.request("/about", "PUT", { text: "x".repeat(1501) })).status, 400);
  assert.equal((await r.request("/about", "PUT", { text: "Prefers direct routes" })).data.revision, 1);
  assert.equal((await r.request("/about", "GET", undefined, true)).data.text, "Prefers direct routes");

  const job = await call("hand_over", brief);
  await until(() => r.hq.team().handovers().some((j) => j.job === job.job && j.state === "done"));
  await until(() => r.hq.turns.live("pebble").state === "idle");
  const rows = (await r.request("/bots/pebble/rows")).data.rows;
  assert.ok(rows.some((row: { body: { from?: string; text?: string } }) => row.body.from === "other-bot" && row.body.text?.startsWith("Result from Travel")));
  const sent = seen.find((s) => s.job === job.job)!;
  assert.equal(sent.bot, "travel"); assert.equal(sent.input.text, JSON.stringify(brief, null, 2));
  const handedRows = (await r.request("/bots/travel/rows")).data.rows;
  assert.ok(handedRows.some((row: { body: { from?: string; who?: string } }) => row.body.from === "other-bot" && row.body.who === "Pebble"));
  const handovers = await r.request("/handovers", "GET", undefined, true);
  assert.ok(handovers.data.some((j: { job: string; minutesUsed: number; state: string }) => j.job === job.job && j.state === "done" && j.minutesUsed >= 0));
  missingReceipt = true;
  const empty = await call("hand_over", brief);
  await until(() => r.hq.team().handovers().some((j) => j.job === empty.job && j.state === "failed"));
  await until(() => r.hq.turns.live("pebble").state === "idle");
  assert.ok((await r.request("/bots/pebble/rows")).data.rows.some((row: { body: { text?: string } }) => row.body.text?.includes("finished without handing anything back")));
  const limited = await call("hand_over", { ...brief, usage: 5 });
  await until(() => r.hq.team().handovers().some((j) => j.job === limited.job && j.state === "stopped"));
  waitForStop = true;
  const timed = await call("hand_over", { ...brief, minutes: 0.002 });
  await until(() => r.hq.team().handovers().some((j) => j.job === timed.job && j.state === "stopped"));
  await until(() => r.hq.turns.live("travel").state === "idle");
  waitForStop = false;

  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  mock.timers.tick(10 * 60_000 + 1);
  assert.equal((await r.request(`/bots/travel/rows?job=${trial.job}`)).data.rows.length, 0);
  mock.timers.reset();
  assert.ok(listBots().length >= 4);
  console.log("Team wiring: a proposal, approval, trials, active bot, card changes, rights and returned results pass.");
} finally { mock.timers.reset(); release?.(); off(); await r.close(); }
