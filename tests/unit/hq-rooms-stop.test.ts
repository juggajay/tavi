import "../isolate.js";
import assert from "node:assert/strict";
import { rig, until } from "./hq-api-fixture.test.js";
import type { Engine } from "../../src/hq/contract.js";
import { createRoundTable } from "../../src/gateway/roundTable.js";

process.env.LH_V3 = "1";
let release!: () => void;
let ownerStarted = false;
let ownerStopped = false;
let roomStarted = false;
let roomStopped = false;
const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), async run(bot, input, on, signal) {
  if (input.text === "An owner turn") {
    ownerStarted = true;
    signal.addEventListener("abort", () => { ownerStopped = true; }, { once: true });
    await new Promise<void>((resolve) => { release = resolve; });
  }
  if (input.text.startsWith("Room discussion")) {
    roomStarted = true;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { roomStopped = true; resolve(); }, { once: true }));
    return;
  }
  on({ type: "done", text: "Done.", engine: bot.primary });
} };
const r = await rig(engine);
try {
  const owner = r.hq.answer("An owner turn", { bot: "pebble", via: "typed", origin: { client: "phone", id: "test" }, test: true });
  await until(() => ownerStarted);
  const controller = new AbortController();
  const queued = r.hq.room("pebble", { text: "A cancelled room turn", via: "typed", origin: null, test: true }, controller.signal);
  controller.abort(); release();
  assert.equal((await owner).ok, true);
  assert.equal(ownerStopped, false, "ending a queued room never stops the owner's other turn");
  assert.equal((await queued).failed, "stopped");

  const messages: Record<string, unknown>[] = [];
  const table = createRoundTable({
    think: async () => { throw new Error("The old brain must not run."); }, context: () => "", note: () => {}, notify: () => {}, toApps: (m) => messages.push(m),
    rooms: { members: () => r.hq.members(), stop: () => {}, askRoom: async (ids, ask, signal) => [{ bot: ids[0], result: await r.hq.room(ids[0], ask, signal) }] },
  });
  table.typed("Let's ask the team", { origin: null, clientId: null, test: true });
  await until(() => roomStarted);
  await table.end("replaced");
  assert.equal(roomStopped, true);
  assert.equal(table.on, false);
  assert.equal(messages.filter((m) => m.type === "table_say").length, 0);
  console.log("hq-rooms-stop: ending a room stops its work and leaves another queued turn alone");
} finally { release?.(); await r.close(); }
