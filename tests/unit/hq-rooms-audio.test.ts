import "../isolate.js";
import assert from "node:assert/strict";
import { createRoundTable } from "../../src/gateway/roundTable.js";
import { seedTeam, createBot, listBots } from "../../src/hq/bots.js";
import { fakeVoices, clipFor } from "../../src/guest/voice.js";
import type { Ask } from "../../src/hq/turns/index.js";
import { createJob } from "../../src/store/jobs.js";
import { db } from "../../src/store/db.js";
import { fakeAccountProtection } from "../fake-hermes.js";

process.env.LH_V3 = "1";
fakeAccountProtection();
seedTeam();
createBot({ id: "nova", name: "Nova", role: "A second view", voice: "cedar" });
const bots = listBots();
const sent: Record<string, unknown>[] = [];
const asked: { bot: string; ask: Ask }[] = [];
const muted: boolean[] = [];
let autoPlay = true;
const table = createRoundTable({
  think: async () => { throw new Error("The old brain must not run."); }, context: () => "", note: () => {}, notify: () => {},
  toApps: (m) => sent.push(m), callOn: () => true, muteCall: (m) => muted.push(m), voices: () => fakeVoices(),
  toClient: (_id, m) => {
    sent.push(m);
    if (autoPlay && m.type === "table_say") queueMicrotask(() => table.client({ type: "table_played", id: m.id, client_id: "phone" }));
  },
  rooms: { members: () => bots, stop: () => {}, askRoom: async (ids, ask) => {
    asked.push({ bot: ids[0], ask });
    return [{ bot: ids[0], result: { ok: true, text: `${ids[0]} has a view.`, spoken: `${ids[0]} has a view.` } }];
  } },
});
try {
  const job = createJob("ask", "voice", "Let's ask the team");
  await table.handOver("Let's ask the team", { origin: { client: "phone", id: "phone" }, clientId: "phone", jobId: job });
  const audio = sent.filter((m) => m.type === "table_say");
  assert.equal(audio.length, 3);
  assert.deepEqual(audio.map((m) => m.bot), bots.map((b) => b.id));
  assert.deepEqual(audio.map((m) => clipFor(String(m.id))?.voice), bots.map((b) => b.voice));
  assert.match(asked[1].ask.text, /Pebble: pebble has a view/);
  assert.match(asked[2].ask.text, /Tim: tim has a view/);
  assert.equal(table.state().on, true);
  const count = asked.length;
  table.typed("Nova, what would you pick?", { origin: null, clientId: "phone", test: false });
  await table.settled();
  assert.equal(asked.length, count + 1); assert.equal(asked.at(-1)?.bot, "nova");
  table.typed("Nova what about the other choice?", { origin: null, clientId: "phone", test: false });
  await table.settled();
  assert.equal(asked.length, count + 2); assert.equal(asked.at(-1)?.bot, "nova");
  table.typed("let me talk to Tim", { origin: null, clientId: "phone", test: false });
  await table.settled();
  assert.equal(asked.length, count + 3); assert.equal(asked.at(-1)?.bot, "tim");
  assert.ok(table.state().lines.some((l) => l.text.startsWith("Nova:")));
  await table.handOver("thanks, that's all", { origin: null, clientId: "phone", jobId: createJob("ask", "voice", "end") });
  assert.equal(table.on, false); assert.equal(muted.at(-1), false);

  autoPlay = false;
  table.typed("Bring in Tim", { origin: null, clientId: "phone", test: false, asVoice: true });
  const deadline = Date.now() + 1000;
  while (sent.filter((m) => m.type === "table_say").length < 4) {
    assert.ok(Date.now() < deadline); await new Promise((r) => setTimeout(r, 5));
  }
  const playing = sent.findLast((m) => m.type === "table_say")!;
  table.client({ type: "table_cut", id: playing.id, client_id: "phone" });
  await table.settled();
  assert.equal(sent.filter((m) => m.type === "table_say").length, 4, "cutting in stops the rest of the exchange");
  await table.end();
  const trace = db.prepare("SELECT detail FROM audit_log WHERE actor='voice' AND event='table_said'").all() as { detail: string }[];
  assert.deepEqual(trace.slice(0, 3).map((r) => JSON.parse(r.detail).bot), bots.map((b) => b.id));
  assert.ok("askBots" in table);
  if ("askBots" in table) await assert.rejects(() => table.askBots(["tim", "tim"], "Hello", { origin: null, clientId: null, test: true, mode: "typed" }), /different bots/);
  console.log("hq-rooms-audio: three voices in order, earlier replies, addressing, cutting in and ending passed");
} finally { await table.end("replaced"); }
