import "../isolate.js";
import assert from "node:assert/strict";
import { db } from "../../src/store/db.js";
import { getSettings, type Settings } from "../../src/store/settings.js";
import { createBot } from "../../src/hq/bots.js";
import { fakeAccountProtection } from "../fake-hermes.js";
import { createFinds, findChoice, findMessage, type Find, type FindsDeps } from "../../src/hq/finds/service.js";
import { leads, looks, reactToFind, sentFinds, wishes, recoverLooks, saveLook, saveLead } from "../../src/hq/finds/ledger.js";
import { findsTools, installFinds } from "../../src/hq/finds/tools.js";
import { newTurnCtx } from "../../src/brain/turn.js";

fakeAccountProtection();
const lead = createBot({ id: "main", name: "Main", primary: { provider: "anthropic", model: "main-model", effort: "high" }, fallbacks: [
  { provider: "anthropic", model: "small-model", effort: "low" }, { provider: "openai-codex", model: "other-model", effort: "xhigh" },
] });
const specialist = createBot({ id: "helper", name: "Helper" });
assert.deepEqual(findChoice(lead), lead.fallbacks[1]);
assert.deepEqual(findChoice({ ...lead, fallbacks: [lead.fallbacks[0]] }), lead.primary);
assert.deepEqual(findChoice({ ...lead, primary: lead.fallbacks[1], fallbacks: [lead.primary] }), lead.primary);
assert.deepEqual(findChoice({ ...lead, fallbacks: [] }), lead.primary);
let at = new Date(), quiet = false, voice = false, alerts = 0, level = "open", idle = true, settings: Settings = getSettings();
let subject = "museum", decision = true, calls = 0, sent: string[] = [], prompts: string[] = [];
const finding = (): Find => ({ kind: subject, message: `An evening ${subject} visit is free this month. You mentioned wanting an evening out. Advance booking is required, before 30 November.`, expires: "2026-12-01T00:00:00Z", sources: [`https://example.com/${subject}`] });
const deps = (): FindsDeps => ({ lead: () => lead, level: () => level, available: () => idle, settings: () => settings,
  voice: () => voice, quiet: () => quiet, alerts: () => alerts, now: () => at, dev: true, idle: () => idle,
  turn: async (bot, request) => {
    calls++; prompts.push(request.text); request.signal.throwIfAborted();
    assert.equal(bot.id, lead.id); assert.deepEqual(request.choice, lead.fallbacks[1]);
    assert.ok(request.text.includes("never have known or thought about"));
    assert.ok(request.text.includes("Today: 2026-")); assert.ok(request.text.includes("primary source"));
    request.event({ type: "tool", phase: "start", id: "read", name: "mcp__web__read", input: { url: finding().sources[0] } });
    request.event({ type: "usage", input: 200000, output: 40, engine: request.choice });
    return { ok: true, text: JSON.stringify({ leads: [{ kind: subject, situation: "An evening visit is being planned.", outcome: decision ? "The publisher confirms free entry." : "No useful offer applies." }], find: decision ? finding() : null }), read: finding().sources };
  },
  send: (bot, text) => { assert.equal(bot.id, lead.id); sent.push(text); },
});
function reset() {
  db.exec("DELETE FROM settings WHERE key LIKE 'finds:ledger:%'");
  settings = getSettings(); subject = "museum"; decision = true; calls = 0; sent = []; prompts = [];
  quiet = voice = false; level = "open"; idle = true; alerts = 0; at = new Date("2026-11-20T01:00:00Z");
}

reset(); let service = createFinds(deps()); decision = false;
await service.look(); assert.equal(sent.length, 0); assert.equal(leads()[0].state, "nothing");
assert.equal(looks()[0].usage, 200040); assert.ok(looks()[0].steps?.length);
await service.look(); assert.ok(prompts[1].includes("No useful offer applies.")); assert.equal(calls, 2, "Each look is one turn.");
await service.close();

reset(); service = createFinds(deps());
await service.tick(); assert.equal(calls, 0, "Scheduled looks stay off in the practice run.");
await service.look(); assert.equal(sent.length, 1); assert.equal(sent[0], findMessage(finding()));
assert.equal(sentFinds().length, 1); assert.equal(leads()[0].state, "sent");
await service.look(); assert.equal(sent.length, 1); assert.equal(looks()[0].state, "duplicate");
reactToFind(sentFinds()[0].id, undefined, "not-interested", "Leave this kind alone.");
subject = "museum tickets"; await service.look(); assert.equal(sent.length, 1); assert.equal(looks()[0].state, "dropped");
assert.ok(prompts[2].includes("Leave this kind alone."));
reactToFind(undefined, "museum", "more"); assert.equal(wishes()[0].reaction, "more"); await service.close();

// Wording and addresses also prevent repeats when the subject changes.
for (const by of ["words", "address"] as const) {
  reset(); service = createFinds(deps()); await service.look(); await service.close();
  const previous = finding(); subject = "gallery";
  service = createFinds({ ...deps(), turn: async (_bot, r) => {
    const f = { ...finding(), ...(by === "words" ? { message: previous.message } : { sources: [previous.sources[0] + "?view=all#offer"] }) };
    return { ok: true, text: JSON.stringify({ leads: [{ kind: subject, situation: "An evening visit.", outcome: "Checked." }], find: f }), read: f.sources };
  } });
  await service.look(); assert.equal(sent.length, 1, by); assert.equal(looks()[0].state, "duplicate"); await service.close();
}

for (const hold of ["quiet", "alerts", "voice", "safety"] as const) {
  reset(); settings.max_interruptions = 1;
  if (hold === "quiet") quiet = true;
  if (hold === "alerts") alerts = 1;
  if (hold === "voice") voice = true;
  service = createFinds(deps());
  if (hold === "safety") { voice = true; }
  await service.look(); assert.equal(sent.length, 0); assert.equal(leads()[0].state, "waiting");
  if (hold === "safety") { voice = false; level = "paused"; await service.flush(); assert.equal(sent.length, 0); }
  await service.close(); service = createFinds(deps());
  quiet = voice = false; alerts = 0; level = "open";
  await service.flush(); assert.equal(sent.length, 1, hold); await service.flush(); assert.equal(sent.length, 1); await service.close();
}

reset(); service = createFinds(deps());
for (const s of ["museum", "gallery", "cinema"]) { subject = s; await service.look(); }
assert.equal(sent.length, 2); assert.equal(leads()[0].state, "waiting");
assert.equal((await service.look()).state, "daily limit"); assert.equal(calls, 3);
at = new Date("2026-11-21T01:00:00Z"); await service.flush(); assert.equal(sent.length, 3); await service.close();

reset(); settings["finds.dev_schedule"] = true; decision = false; service = createFinds(deps());
idle = false; await service.tick(); assert.equal(calls, 0); assert.equal((await service.look()).state, "work lane busy or unavailable");
idle = true; await service.tick(); assert.equal(calls, 1);
at = new Date(at.getTime() + 3600000); await service.tick(); assert.equal(calls, 1);
at = new Date(at.getTime() + 3 * 3600000); await service.tick(); assert.equal(calls, 2); await service.close();

reset();
for (const changes of [{ lead: () => specialist }, { lead: () => ({ ...lead, servers: ["team"] }) }, { level: () => "paused" }]) {
  service = createFinds({ ...deps(), ...changes }); await service.look(); assert.equal(calls, 0); await service.close();
}
settings["finds.pause_until"] = "2026-11-25T00:00:00Z"; service = createFinds(deps()); await service.look(); assert.equal(calls, 0); await service.close();
reset(); settings["finds.enabled"] = false; service = createFinds(deps()); await service.look(); assert.equal(calls, 0); await service.close();

reset(); service = createFinds(deps());
const before = db.prepare("SELECT * FROM settings").all(), audit = db.prepare("SELECT * FROM audit_log").all();
const trial = await service.look(true); assert.equal(trial.found, findMessage(finding())); assert.equal(trial.leads.length, 1);
assert.equal(sent.length, 0); assert.deepEqual(db.prepare("SELECT * FROM settings").all(), before);
assert.deepEqual(db.prepare("SELECT * FROM audit_log").all(), audit); await service.close();

for (const bad of ["unread", "malformed", "missing", "extra link", "query differs"] as const) {
  reset(); service = createFinds({ ...deps(), turn: async () => {
    const f = finding(); if (bad === "extra link") f.message += " https://unread.example/details";
    return { ok: true, text: bad === "malformed" ? "Here is a maybe." : bad === "missing" ? '{"find":null}' : JSON.stringify({ leads: [{ kind: subject, situation: "An evening visit.", outcome: "Checked." }], find: f }), read: bad === "unread" ? [] : bad === "query differs" ? [f.sources[0] + "?other=1"] : f.sources };
  } });
  await service.look(); assert.equal(sent.length, 0, bad); assert.match(looks()[0].state, /nothing/); await service.close();
}

reset(); service = createFinds({ ...deps(), turn: async () => {
  const url = "https://example.com/session_(evening)";
  const f = { ...finding(), sources: [url], message: `There is a free evening session. [Read the conditions](${url}).` };
  return { ok: true, text: JSON.stringify({ leads: [{ kind: subject, situation: "An evening visit.", outcome: "Checked." }], find: f }), read: [url] };
} });
await service.look(); assert.equal(sent.length, 1, "Read links with brackets or sentence punctuation remain valid."); await service.close();

for (const stop of ["time", "close", "safety", "usage", "daily usage"] as const) {
  reset(); let aborted = false, started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  if (stop === "time") settings["finds.minutes"] = 0.0005;
  if (stop === "daily usage") settings["finds.look_tokens"] = settings["finds.daily_tokens"] * 2;
  service = createFinds({ ...deps(), turn: async (_bot, r) => {
    started();
    if (stop === "usage" || stop === "daily usage") r.event({ type: "usage", input: stop === "usage" ? settings["finds.look_tokens"] : settings["finds.daily_tokens"], output: 0, engine: r.choice });
    await new Promise<void>((resolve) => { const done = () => { aborted = true; resolve(); }; r.signal.addEventListener("abort", done, { once: true }); if (r.signal.aborted) done(); });
    return { ok: false, text: "", read: [] };
  } });
  const running = service.look(); await ready; assert.equal((await service.look()).state, "already looking");
  if (stop === "close") await service.close();
  if (stop === "safety") level = "walled";
  await running; assert.ok(aborted); assert.equal(sent.length, 0); assert.equal(looks()[0].state, "stopped");
  if (stop === "time") assert.equal(looks()[0].usage, 0, "Only reported usage is counted.");
  await service.close();
}

for (const drop of ["wish", "expired"] as const) {
  reset(); voice = true; service = createFinds(deps()); await service.look();
  if (drop === "wish") reactToFind(undefined, "museum", "not-interested"); else at = new Date("2026-12-02T01:00:00Z");
  voice = false; await service.flush(); assert.equal(sent.length, 0); assert.equal(leads()[0].state, "dropped"); await service.close();
}

reset(); saveLook({ id: "unfinished", bot: lead.id, day: "2026-11-20", started: at.toISOString(), ended: null, state: "looking", usage: 27 });
saveLead({ id: "unfinished-lead", look_id: "unfinished", fingerprint: "unfinished", kind: "a session", situation: "An evening visit.", query: "", found: null, state: "checking", checked_at: at.toISOString(), sent_at: null, reaction: null, reaction_note: null });
recoverLooks(); assert.equal(looks()[0].state, "stopped after restart"); assert.equal(leads()[0].state, "stopped after restart");

reset(); service = createFinds(deps()); const off = installFinds(service);
try {
  const ctx = newTurnCtx(); ctx.bot = lead.id;
  assert.deepEqual(findsTools(ctx).map((t) => t.name), ["look_now", "finds_settings", "find_reaction", "sent_finds"]);
  const other = newTurnCtx(); other.bot = specialist.id; assert.deepEqual(findsTools(other), []);
  for (const reason of ["background", "external"] as const) {
    const blocked = newTurnCtx(reason === "background"); blocked.bot = lead.id;
    if (reason === "external") blocked.external.add("the web");
    for (const name of ["look_now", "finds_settings", "find_reaction"]) {
      const t = findsTools(blocked).find((t) => t.name === name)!;
      await assert.rejects(() => t.handler({} as never, {} as never), /owner's own request/);
    }
  }
  ctx.test = true;
  for (const name of ["look_now", "finds_settings", "find_reaction"]) await findsTools(ctx).find((t) => t.name === name)!.handler({} as never, {} as never);
  assert.equal(calls, 0); assert.equal(leads().length, 0);
} finally { off(); await service.close(); }
console.log("Finds: one real turn, full effort, silence, read sources, repeats, wishes, held messages, limits, trial, restart and owner controls passed.");
