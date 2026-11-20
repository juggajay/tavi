import "../isolate.js";
import assert from "node:assert/strict";
import { rig, until } from "./hq-api-fixture.test.js";
import type { Engine, TurnInput } from "../../src/hq/contract.js";
import { botTurn } from "../../src/hq/toolbox/turns.js";
import { getBot, updateBot } from "../../src/hq/bots.js";
import { createJob } from "../../src/store/jobs.js";
import { db } from "../../src/store/db.js";
import { createFinds, findChoice } from "../../src/hq/finds/service.js";
import { looks } from "../../src/hq/finds/ledger.js";
import { recordSource } from "../../src/brain/sourceLedger.js";
import { createWeb } from "../../src/web/index.js";
import type { Backend } from "../../src/web/backends.js";
import { rowsOf } from "../../src/hq/rows.js";
import { findsTools } from "../../src/hq/finds/tools.js";

const seen: TurnInput[] = [], queries: string[] = [];
let hold = false, unread = false, release: (() => void) | undefined, aborted = false, ownerStarted = false, privacyRefused = false;
const address = "https://example.com/free-session";
const backend: Backend = async (request) => {
  assert.ok(!/morgan|lena/i.test(JSON.stringify(request)), "No private detail reaches a query.");
  if (request.kind === "search") { queries.push(request.query); return { results: [{ title: "A public session", url: address, extract: "Read the terms.", date: null }] }; }
  return { title: "A public session", url: address, text: "A free public evening session, booking required, until 30 November 2026.", date: "2026-11-20", cut: false };
};
const web = createWeb({ level: () => "open", known: () => ({ names: ["Morgan", "Lena"], texts: [] }), resolve: async () => [{ address: "93.184.216.34", family: 4 }], backends: { codex: backend, claude: backend } });
const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), async run(bot, input, on, signal) {
  seen.push(input);
  if (input.conversation.startsWith("finds:")) {
    assert.equal(input.lane, "work"); const ctx = botTurn(bot.id, "work")!;
    assert.ok(ctx.background); assert.equal(ctx.turn.job_id, input.conversation);
    assert.deepEqual(bot.servers, ["web", "memory", "files", "drawings", "actions", "team"]);
    assert.deepEqual(input.choice, findChoice(bot));
    assert.ok(input.instructions.includes("Morgan and Lena are planning an evening out."));
    assert.ok(input.instructions.includes("usual-context-marker"));
    on({ type: "tool", phase: "start", id: "search", name: "mcp__public_web__search", input: { query: "public free evening sessions" } });
    await web(ctx, { kind: "search", query: "public free evening sessions" }, signal);
    await assert.rejects(() => web(ctx, { kind: "search", query: "Lena free sessions" }, signal)); privacyRefused = true;
    on({ type: "tool", phase: "end", id: "search", name: "mcp__public_web__search", ok: true });
    await web(ctx, { kind: "read", url: address }, signal);
    // A search hit or a source noted by a different tool must not become a page read.
    recordSource(ctx.turn, { kind: "web", rung: null, what: "A search hit", place: "https://example.com/unread", tool: "mcp__web__search" });
    if (hold) await new Promise<void>((resolve) => {
      const done = () => { signal.removeEventListener("abort", stop); release = undefined; resolve(); };
      const stop = () => { aborted = true; done(); };
      release = done; signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    });
    on({ type: "usage", input: 120, output: 40, engine: input.choice });
    on({ type: "done", text: JSON.stringify({ leads: [{ kind: "free session", situation: "An evening out is planned.", outcome: "The publisher confirms the date and conditions." }], find: { kind: "free session", message: "There is a free evening session this month. You mentioned an evening out. Book before 30 November.", sources: [unread ? "https://example.com/unread" : address], expires: null } }), engine: input.choice });
    return;
  }
  if (input.text === "Change looking") {
    const ctx = botTurn(bot.id)!;
    for (const name of ["look_now", "finds_settings", "find_reaction"]) await assert.rejects(() => findsTools(ctx).find((t) => t.name === name)!.handler({} as never, {}), /owner's own request/);
  }
  if (input.conversation.includes("-work-")) { assert.ok(aborted, "Owner work starts after the look stops."); ownerStarted = true; }
  on({ type: "done", text: "The answer is ready.", engine: bot.primary });
} };
const r = await rig(engine);
let service: ReturnType<typeof createFinds> | undefined;
try {
  updateBot("pebble", { servers: ["web", "memory", "files", "drawings", "actions", "team"], primary: { provider: "anthropic", model: "main", effort: "high" }, fallbacks: [{ provider: "openai-codex", model: "other", effort: "xhigh" }] });
  const lead = () => getBot("pebble")!;
  await new Promise<void>((resolve) => { r.hq.turns.ask("pebble", { text: "Change looking", from: "other-bot", via: "bot", origin: null, test: true, onDone: (result) => { assert.equal(result.ok, true); resolve(); } }); });
  r.hq.turns.post("pebble", { kind: "message", from: "owner", text: "Morgan and Lena are planning an evening out. usual-context-marker", via: "typed" });
  let sent = 0;
  service = createFinds({ lead, level: () => r.guard.level(), available: (b) => r.hq.quietTurns.available(b), turn: (b, q) => r.hq.quietTurns.run(b, q),
    voice: () => false, quiet: () => false, alerts: () => 0, send: () => { sent++; }, dev: true });
  const before = rowsOf("pebble", lead().generation), logs = db.prepare("SELECT * FROM conversation_log").all();
  hold = true;
  const looking = service.look(); await until(() => !!release);
  assert.equal(r.hq.turns.live("pebble").work?.[0].title, "Looking for something useful");
  assert.deepEqual(rowsOf("pebble", lead().generation), before);
  assert.deepEqual(db.prepare("SELECT * FROM conversation_log").all(), logs);
  assert.equal(botTurn("pebble"), null);
  const chat = await r.hq.answer("Hello", { bot: "pebble", via: "typed", origin: null as never, test: true });
  assert.equal(chat.ok, true); assert.ok(botTurn("pebble", "work")); assert.equal(aborted, false);
  const id = createJob("task", "Requested work", "Check the requested dates.");
  const work = r.hq.work("pebble", { id, title: "Requested work", brief: "Check the requested dates.", origin: null });
  await looking; await work;
  assert.ok(aborted && ownerStarted); assert.equal(looks()[0].state, "stopped"); assert.equal(sent, 0);
  assert.ok(looks()[0].steps?.some((e) => e.type === "tool"));
  assert.equal(botTurn("pebble", "work"), null); assert.equal(r.hq.turns.live("pebble").work?.length, 0);
  assert.equal(seen.filter((i) => i.conversation.startsWith("finds:")).length, 1);
  await until(() => r.hq.quietTurns.available(lead()));
  hold = false;
  const saved = db.prepare("SELECT * FROM settings").all(), audit = db.prepare("SELECT * FROM audit_log").all();
  const rows = rowsOf("pebble", lead().generation);
  const trial = await service.look(true);
  assert.ok(trial.found?.includes("There is a free evening session"), JSON.stringify(trial));
  assert.deepEqual(db.prepare("SELECT * FROM settings").all(), saved);
  assert.deepEqual(db.prepare("SELECT * FROM audit_log").all(), audit);
  assert.deepEqual(rowsOf("pebble", lead().generation), rows); assert.equal(sent, 0);
  unread = true; assert.equal((await service.look(true)).state, "nothing: unread source"); unread = false;
  const good = await service.look(); assert.equal(good.state, "found"); assert.equal(sent, 1);
  assert.ok(privacyRefused); assert.ok(queries.length);
  hold = true; aborted = false;
  const stop = service.look(true); await until(() => !!release); r.hq.stopBot("pebble");
  assert.equal((await stop).state, "stopped"); assert.ok(aborted);
  updateBot("pebble", { computer: true }); assert.equal(r.hq.quietTurns.available(lead()), true);
  updateBot("pebble", { computer: false, engine: "builtin" }); assert.equal(r.hq.quietTurns.available(lead()), false);
  console.log("A look uses the lead's tools on the work lane, stays quiet, keeps chat free, gives way to owner work and stops from the working light.");
} finally { release?.(); await service?.close(); await r.close(); }
