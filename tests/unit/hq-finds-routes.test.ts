import "../isolate.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createBot } from "../../src/hq/bots.js";
import { fakeAccountProtection } from "../fake-hermes.js";
import { createFinds } from "../../src/hq/finds/service.js";
import { installFinds } from "../../src/hq/finds/tools.js";
import { routineRoute } from "../../src/hq/proactive.js";
import { db } from "../../src/store/db.js";
import { saveLook, looks } from "../../src/hq/finds/ledger.js";

fakeAccountProtection();
const lead = createBot({ id: "main", name: "Main" });
let available = true, sent = 0, calls = 0;
const message = "A free evening session is available this month. You mentioned an evening out. Book by 30 November.";
const service = createFinds({ lead: () => lead, level: () => "open", available: () => available, voice: () => false,
  quiet: () => false, alerts: () => 0, send: () => { sent++; }, idle: () => available,
  turn: async () => { calls++; return { ok: true, read: ["https://example.com/session"], text: JSON.stringify({
    leads: [{ kind: "free session", situation: "An evening out.", outcome: "The publisher confirms the offer and closing date." }],
    find: { kind: "free session", message, sources: ["https://example.com/session"], expires: null },
  }) }; },
});
const off = installFinds(service);
const server = createServer((req, res) => { void routineRoute(req, res, new URL(req.url!, "http://local"), !req.headers["x-forwarded-for"]).then((handled) => {
  if (!handled) { res.writeHead(404); res.end(); }
}); });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/hq/finds`;
async function request(path: string, method = "GET", remote = false) {
  const r = await fetch(base + path, { method, headers: remote ? { "x-forwarded-for": "100.64.0.2" } : {} });
  return { status: r.status, body: await r.json() };
}
try {
  for (const path of ["/status", "/record", "/look"]) assert.equal((await request(path, path === "/look" ? "POST" : "GET", true)).status, 403);
  assert.equal((await request("/status")).body.ready, true);
  const before = db.prepare("SELECT * FROM settings").all(), audit = db.prepare("SELECT * FROM audit_log").all();
  const trial = await request("/look?test=1", "POST");
  assert.equal(trial.status, 200); assert.equal(calls, 1); assert.equal(sent, 0);
  assert.equal(trial.body.found, message + "\nhttps://example.com/session");
  assert.deepEqual(trial.body.leads, trial.body.result.leads); assert.equal(trial.body.leads.length, 1);
  assert.deepEqual(db.prepare("SELECT * FROM settings").all(), before);
  assert.deepEqual(db.prepare("SELECT * FROM audit_log").all(), audit);
  available = false; assert.equal((await request("/look?test=1", "POST")).status, 409); assert.equal(calls, 1);
  available = true;
  assert.equal((await request("/look")).status, 405); assert.equal((await request("/record", "POST")).status, 405);
  const real = await request("/look", "POST"); assert.equal(real.status, 200); assert.equal(sent, 1);
  const record = await request("/record"); assert.equal(record.status, 200); assert.equal(record.body.length, 1);
  assert.equal(record.body[0].leads[0].outcome, "The publisher confirms the offer and closing date.");
  assert.equal(record.body[0].leads[0].state, "sent"); assert.equal(record.body[0].leads[0].sent, true);
  for (let i = 0; i < 23; i++) saveLook({ id: `old-${i}`, bot: lead.id, day: "2026-01-01", started: new Date(Date.UTC(2026, 0, 1, i)).toISOString(), ended: new Date().toISOString(), state: "nothing", usage: 0 });
  const latest = await request("/record"); assert.equal(latest.body.length, 20);
  assert.deepEqual(latest.body.map((r: { id: string }) => r.id), looks().slice(0, 20).map((r) => r.id));
  console.log("Finds routes: PC only, trial message and leads without saving or sending, busy refusal and the last twenty records passed.");
} finally {
  off(); await service.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
}
