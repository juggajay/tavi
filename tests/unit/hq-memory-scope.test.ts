import "../isolate.js";
import assert from "node:assert/strict";
import { db } from "../../src/store/db.js";
import { createBot } from "../../src/hq/bots.js";
import { newTurnCtx } from "../../src/brain/turn.js";
import { memoryTools } from "../../src/brain/memoryTools.js";
import { remember } from "../../src/store/proactive.js";
import { memoryScope } from "../../src/memory/scope.js";
import { fakeAccountProtection } from "../fake-hermes.js";

fakeAccountProtection();
const lead = createBot({ id: "main", name: "Main" });
const bot = createBot({ id: "reader", name: "Reader" });
const secret = "PRIVATE LEAD WORDS 839271";
const leadFact = remember({ kind: "user", subject: "Private detail", fact: secret });
db.prepare("INSERT INTO conversation_log(ts,role,channel,text) VALUES(?, 'user','text',?)").run(new Date().toISOString(), secret);
const ctx = newTurnCtx(); ctx.bot = bot.id;
const tools = memoryTools(ctx);
const call = async (name: string, args: Record<string, unknown>) => {
  const tool = tools.find((t) => t.name === name)!;
  assert.ok(tool, name);
  const result = await tool.handler(args, {});
  assert.ok(!JSON.stringify(result).includes(secret), name);
  return JSON.parse((result.content[0] as { text: string }).text);
};
assert.equal(memoryScope(newTurnCtx()), "lead");
const leadCtx = newTurnCtx(); leadCtx.bot = lead.id;
assert.equal(memoryScope(leadCtx), "lead");
assert.equal(memoryScope(ctx), `bot:${bot.id}`);
const saved = await call("remember", { kind: "preference", subject: "Trips", fact: "Prefer trains" });
assert.ok(saved.saved);
const recalled = await call("recall", { query: "Trips" });
assert.equal(recalled.facts.length, 1);
assert.equal(recalled.facts[0].fact, "Prefer trains");
assert.equal((await call("recall", { query: "Private detail" })).facts.length, 0);
assert.equal((await call("recall", { query: leadFact })).facts.length, 0);
assert.match((await call("forget", { id: leadFact })).error, /not in your notebook/);
assert.match((await call("remember", { kind: "user", subject: "Trips", fact: "Change", replaces: leadFact })).error, /not in your notebook/);
assert.equal((db.prepare("SELECT status FROM memories WHERE id=?").get(leadFact) as { status: string }).status, "active");

const args: Record<string, Record<string, unknown>> = {
  remember: { kind: "person", subject: "Someone", fact: "A separate note", scope: "lead" },
  recall: { query: "", scope: "lead", id: leadFact }, forget: { id: leadFact, scope: "lead" },
  update_profile: { op: "add", section: "Basics", text: "Not allowed" }, answer_held_write: { id: leadFact, yes: true },
  propose_personality_change: { old_text: "", new_text: "Not allowed", summary: "Test" },
  search_history: { query: "PRIVATE" }, set_my_name: { name: "Changed" }, noted_question: { question: "A question?" },
  sitdown_update: { status: "done" }, answer_offer: { id: leadFact, yes: true },
  add_commitment: { title: "A task", owner: "user", kind: "other" }, list_commitments: { status: "all" },
  answer_followup: { id: leadFact, answer: "done" }, set_followup_controls: { resume: true },
  update_commitment: { id: leadFact, status: "done" },
  create_routine: { title: "A routine", instructions: "A task", schedule: { kind: "daily", time: "08:00" }, delivery: "push" },
  list_routines: {}, update_routine: { id: leadFact, status: "paused" },
  set_notification_rules: { max_per_day: 2 }, set_pebble_colour: { colour: "normal" }, todays_activity: {},
};
for (const tool of tools) {
  assert.ok(Object.hasOwn(args, tool.name), `Give ${tool.name} a check too.`);
  const result = await call(tool.name, args[tool.name]);
  if (!["remember", "recall", "forget"].includes(tool.name)) assert.match(result.error, /propose_shared_note/);
}
ctx.external.add("the web");
assert.match((await call("remember", { kind: "user", subject: "Outside", fact: "Unconfirmed" })).error, /owner's tap/);
ctx.external.clear();
const revised = await call("remember", { kind: "preference", subject: "Trips", fact: "Prefer direct trains", replaces: saved.saved });
assert.ok(revised.saved);
assert.equal((await call("recall", { query: "Trips" })).facts.length, 1);
await call("forget", { id: revised.saved });
assert.equal((await call("recall", { query: "Trips" })).facts.length, 0);
const other = createBot({ id: "another", name: "Another" });
const otherCtx = newTurnCtx(); otherCtx.bot = other.id;
const otherResult = await memoryTools(otherCtx).find((t) => t.name === "recall")!.handler({ query: "Someone" }, {});
assert.ok(!JSON.stringify(otherResult).includes("A separate note"));
const leadRead = await memoryTools(leadCtx).find((t) => t.name === "recall")!.handler({ query: "Private" }, {});
assert.ok(JSON.stringify(leadRead).includes(secret));
ctx.test = true;
const before = db.prepare("SELECT * FROM memories").all();
for (const t of tools) await t.handler(args[t.name], {});
assert.deepEqual(db.prepare("SELECT * FROM memories").all(), before);
console.log(`notebook scopes: all ${tools.length} memory tools checked; private lead words stay private`);
