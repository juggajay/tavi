import "../isolate.js";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { fakeAccountProtection } from "../fake-hermes.js";
import { createBot } from "../../src/hq/bots.js";
import { createItem, getItem } from "../../src/store/items.js";
import { newTurn, newTurnCtx, type TurnCtx } from "../../src/brain/turn.js";
import { createTeam, teamTools, type HandOverRun } from "../../src/hq/team/index.js";
import { modelTools } from "../../src/brain/modelTools.js";
import { itemBot, mayUseItem } from "../../src/hq/ownership.js";
import { botTurn } from "../../src/hq/toolbox/turns.js";
import { GuardClient, type GuardState } from "../../src/hq/guardClient.js";
import { Hq } from "../../src/hq/hq.js";
import type { Engine, TurnInput } from "../../src/hq/contract.js";
import { clients } from "../../src/gateway/clients.js";
import { db } from "../../src/store/db.js";
import { createJob } from "../../src/store/jobs.js";

fakeAccountProtection();
const lead = createBot({ id: "main", name: "Main", engine: "builtin" });
const maker = createBot({ id: "pebble", name: "Pebble", engine: "builtin" });
const specialist = createBot({ id: "tim", name: "Tim", engine: "builtin" });
const parts = [{ id: "one", name: "Display", material: "plain" as const, stock: { type: "box" as const, size: [100, 80, 20] as [number, number, number] } }];
const model = createItem(newTurn({ job_id: `lh-${maker.id}-${randomUUID()}` }), { kind: "model", title: "Pebble's display", payload: { parts } });
const context = (bot: string) => { const ctx = newTurnCtx(); ctx.bot = bot; return ctx; };
const first = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
const data = (r: unknown) => JSON.parse(first(r).replace(/^This was made by [^\n]+\.\n/g, ""));
const runTool = async (ctx: TurnCtx, name: string, args: Record<string, unknown>) => teamTools(ctx).find((t) => t.name === name)!.handler(args, {});
const brief = { to: specialist.id, aim: "Make another version of the display", scope: "A new model with a clear explanation", given: model.id, done: "A separate model with its maker named", form: "The model and a short receipt", minutes: 1, usage: 10000 };

// Use the real hand-over tool and its returned receipt, without an engine or a service.
let run: HandOverRun | undefined;
const messages: string[] = [];
const team = createTeam({
  makeBot: async (input) => createBot(input), activateBot: async () => {}, runTrial: async () => ({ ok: true, answer: "Done", usage: 0, ms: 0 }),
  startHandOver: async (input) => { run = input; await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true })); },
  message: (_, text) => messages.push(text), askOwner: async () => {}, live: () => ({ busy: false, queued: 0 }),
});
try {
  const leadCtx = context(lead.id);
  const result = await team.tools(leadCtx).find((t) => t.name === "hand_over")!.handler(brief, {});
  const handed = data(result); assert.ok(handed.job);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(run?.given_items, [model.id]);
  const ctx = context(specialist.id); ctx.turn.job_id = handed.job; ctx.given_items = run!.given_items;
  const revised = await modelTools(ctx).find((t) => t.name === "show_model")!.handler({ title: "Tim's version", parts, replaces: model.id }, {});
  assert.ok(first(revised).startsWith("This was made by Pebble.\n"));
  const item = getItem(data(revised).item)!; assert.equal(itemBot(item), specialist.id);
  const receipt = await team.tools(ctx).find((t) => t.name === "hand_back")!.handler({ summary: "A new version is ready", made: [item.id], sources: [], unsure: "", proposals: [] }, {});
  assert.equal(data(receipt).handedBack, handed.job);
  assert.match(messages.at(-1)!, /Built on work made by Pebble\./);
  const noGift = context(specialist.id);
  const refused = await modelTools(noGift).find((t) => t.name === "show_model")!.handler({ title: "A change", parts, replaces: model.id }, {});
  assert.match(first(refused), /made by Pebble.*hand/s, "the grant belongs to the job, not every later turn");
} finally { team.close(); }

// The actual HQ carries permissions through the queue, the toolbox, longer work and a separate bot job.
const guard = new GuardClient({ watch: false });
mock.method(guard, "level", () => "open");
mock.method(guard, "seen", async () => {});
mock.method(guard, "state", async () => ({ level: "open", ready: true } as GuardState));
const calls: { input: TurnInput; job: string | null; given: string[]; permitted: boolean }[] = [];
const failures: unknown[] = [];
let receipt = "";
const engine: Engine = {
  kind: "builtin", ready: async () => ({ ok: true }),
  async run(bot, input, on) {
    try {
      const ctx = botTurn(bot.id)!; assert.ok(ctx);
      calls.push({ input, job: ctx.turn.job_id, given: [...ctx.given_items ?? []], permitted: mayUseItem(ctx.turn, model) });
      if (input.text === "Pass the display") {
        const r = await runTool(ctx, "hand_over", brief); assert.ok(data(r).job);
      } else if (input.text.startsWith("{")) {
        assert.deepEqual(ctx.given_items, [model.id]);
        assert.ok(!input.instructions?.includes("PRIVATE EARLIER WORDS"));
        const changed = await modelTools(ctx).find((t) => t.name === "show_model")!.handler({ title: "A shared version", parts, replaces: model.id }, {});
        const item = getItem(data(changed).item)!; assert.equal(itemBot(item), specialist.id);
        const back = await runTool(ctx, "hand_back", { summary: "A separate version", made: [item.id], sources: [], unsure: "", proposals: [] });
        assert.ok(data(back).handedBack);
      } else if (input.text.startsWith("Result from")) receipt = input.text;
      on({ type: "done", text: "Ready.", engine: bot.primary });
    } catch (error) { failures.push(error); throw error; }
  },
};
const hq = new Hq({ guard, engine, toolboxHost: null });
const socket = {} as WebSocket;
const origin = { client: "desktop" as const, id: "owner" };
clients.set(socket, { v: 2, kind: "desktop", id: origin.id, screen: { item_id: model.id }, connectedAt: Date.now() });
const ask = (bot: string, text: string, extra: Record<string, unknown> = {}) => new Promise<void>((resolve) => {
  hq.ask(bot, { text, via: "typed", origin, test: true, ...extra, onDone: (r) => { assert.ok(r.ok, r.text); resolve(); } });
});
try {
  await hq.start();
  await ask(specialist.id, "Explain the display");
  const firstTurn = calls.at(-1)!;
  assert.deepEqual(firstTurn.given, [model.id]); assert.equal(firstTurn.permitted, true);
  assert.match(firstTurn.input.instructions!, /This was made by Pebble/);
  clients.get(socket)!.screen = null;
  const id = createJob("task", "A longer version", "Continue the display");
  await hq.work(specialist.id, { id, title: "A longer version", brief: "Continue the display", origin, fromTurn: firstTurn.job });
  assert.deepEqual(calls.at(-1)!.given, [model.id]); assert.equal(calls.at(-1)!.permitted, true);
  assert.equal((JSON.parse((db.prepare("SELECT summary FROM jobs WHERE id=?").get(id) as { summary: string }).summary)).bot, specialist.id);
  await ask(specialist.id, "A new request");
  assert.deepEqual(calls.at(-1)!.given, []); assert.equal(calls.at(-1)!.permitted, false);
  clients.get(socket)!.screen = { item_id: model.id };
  await ask(specialist.id, "A timed request", { via: "routine", background: true });
  assert.equal(calls.at(-1)!.permitted, false, "a routine cannot borrow the owner's open screen");
  await ask(specialist.id, "Words from another bot", { via: "bot", from: "other-bot" });
  assert.equal(calls.at(-1)!.permitted, false);
  clients.get(socket)!.screen = null;
  await ask(lead.id, "PRIVATE EARLIER WORDS");
  // This is a real hand-over within the isolated test store, so the test-write guard is off for this turn.
  await ask(lead.id, "Pass the display", { test: false });
  const end = Date.now() + 3000;
  while (!receipt && !failures.length && Date.now() < end) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(failures, []);
  assert.match(receipt, /Built on work made by Pebble\./);
  assert.ok(calls.some((call) => call.job?.startsWith("teamjob_") && call.given.includes(model.id)), "the brief's items reach the specialist's actual toolbox context");
  console.log("Handed-over work: the queue, longer work and separate bot jobs keep the right permissions and name the original maker.");
} finally { clients.clear(); await hq.close(); mock.restoreAll(); }
