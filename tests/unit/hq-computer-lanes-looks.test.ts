import "../isolate.js";
import assert from "node:assert/strict";
import { rig, until } from "./hq-api-fixture.test.js";
import type { Engine, TurnInput } from "../../src/hq/contract.js";
import { getBot } from "../../src/hq/bots.js";
import { botTurn } from "../../src/hq/toolbox/turns.js";
import { twinName } from "../../src/hq/toolbox/lanes.js";
import { ScreenGuardClient } from "../../src/hq/screens/guard.js";
import type { ScreenPorts } from "../../src/guard/fence.js";
import { createJob } from "../../src/store/jobs.js";
import { createFinds } from "../../src/hq/finds/service.js";
import { looks } from "../../src/hq/finds/ledger.js";
import { rowsOf } from "../../src/hq/rows.js";
import { updateSettings } from "../../src/store/settings.js";

class Screens extends ScreenGuardClient {
  constructor() { super({} as ConstructorParameters<typeof ScreenGuardClient>[0]); }
  override async setPorts(ports: ScreenPorts) { return { applied: true, ports }; }
  override async prepare() {}
  override async fence() { return { applied: true, ports: null }; }
  override async drop() {}
}
const gates = new Map<string, () => void>();
const seen: { input: TurnInput; signal: AbortSignal }[] = [];
const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), async run(bot, input, on, signal) {
  seen.push({ input, signal });
  const ctx = botTurn(bot.id, input.lane)!; assert.ok(ctx);
  if (input.conversation.startsWith("finds:") || input.conversation.includes("-work-") || input.text === "Hold reply") {
    await new Promise<void>((resolve) => {
      const finish = () => { signal.removeEventListener("abort", finish); gates.delete(ctx.turn.job_id!); resolve(); };
      gates.set(ctx.turn.job_id!, finish); signal.addEventListener("abort", finish, { once: true }); if (signal.aborted) finish();
    });
  }
  if (signal.aborted) { on({ type: "failed", reason: "stopped", message: "Stopped." }); return; }
  on({ type: "done", text: input.conversation.startsWith("finds:") ? JSON.stringify({ leads: [], find: null }) : "Finished checking.", engine: input.choice });
} };
const r = await rig(engine, { screenGuard: new Screens(), screenReady: async () => {} });
const lead = () => getBot("pebble")!;
const ask = (text: string, via: "typed" | "voice" = "typed") => r.hq.answer(text, { bot: "pebble", via, origin: { kind: "voice" }, test: true });
const service = createFinds({ lead, level: () => r.guard.level(), available: (b) => r.hq.quietTurns.available(b), turn: (b, q) => r.hq.quietTurns.run(b, q),
  voice: () => false, quiet: () => false, alerts: () => 0, send: () => { throw new Error("Nothing should be sent."); }, dev: true });
const lookCount = () => seen.filter((s) => s.input.conversation.startsWith("finds:")).length;
async function looking() {
  const n = lookCount(); const done = service.look(); await until(() => lookCount() === n + 1);
  const id = seen.at(-1)!.input.conversation; await until(() => gates.has(id));
  assert.equal(seen.at(-1)!.input.lane, "work");
  return { id, done };
}
function work(title: string) {
  const id = createJob("task", title, title);
  return { id, done: r.hq.work("pebble", { id, title, brief: title, origin: null }) };
}
async function switched(on: boolean) {
  assert.equal(lead().computer, on);
  await until(() => on ? r.hq.computer("pebble").state === "ready" : !r.files.get("/bots/pebble/file/config.yaml")?.includes("terminal, file, browser"));
  await r.hq.ensure(lead());
  const config = r.files.get("/bots/pebble/file/config.yaml")!;
  assert.equal(config.includes("terminal, file, browser"), on);
  const twin = r.files.get(`/bots/${twinName("pebble")}/file/config.yaml`)!;
  assert.match(twin, /api_server: \[todo, skills\]/);
  assert.ok(!twin.includes("ssh_host")); assert.ok(!twin.includes('"computers":'));
}
try {
  updateSettings({ "finds.looks_day": 12 }, "local");
  await r.hq.setComputer("pebble", true); await switched(true);
  const before = rowsOf("pebble", lead().generation);
  const firstLook = await looking();
  await ask("Hello"); assert.ok(gates.has(firstLook.id)); assert.equal(seen.at(-1)!.input.lane, "chat");
  assert.deepEqual(rowsOf("pebble", lead().generation), before);
  const first = work("Read the public dates"); await until(() => gates.has(first.id));
  assert.equal(seen.at(-1)!.input.lane, "chat");
  assert.ok(gates.has(firstLook.id), "A computer job does not need the twin used by the look.");
  assert.equal(r.hq.turns.live("pebble").work?.length, 2, "Both working lights survive job progress.");
  await ask("How is it going?", "voice");
  assert.equal((await firstLook.done).state, "stopped");
  assert.equal(looks()[0].state, "stopped"); assert.ok(looks()[0].ended);
  assert.equal(seen.at(-1)!.input.lane, "work"); assert.ok(gates.has(first.id));
  assert.equal(r.hq.turns.live("pebble").work?.length, 1);
  const secondLook = await looking();
  const held = ask("Hold reply");
  await until(() => !!botTurn("pebble", "work") && !botTurn("pebble", "work")!.background);
  assert.equal((await secondLook.done).state, "stopped"); assert.equal(looks()[0].state, "stopped");
  const replyId = botTurn("pebble", "work")!.turn.job_id!;
  assert.equal(r.hq.quietTurns.available(lead()), false);
  const pending = await r.hq.setComputer("pebble", false);
  assert.match(pending.why, /settings will take effect when every bot is quiet/);
  assert.equal((await r.request("/bots/pebble", "PATCH", { computer: false })).status, 200);
  assert.match(r.hq.computer("pebble").why, /settings will take effect/);
  assert.equal(lead().computer, true); assert.ok(gates.has(first.id)); assert.ok(gates.has(replyId));
  gates.get(first.id)!(); await first.done;
  assert.equal(lead().computer, true, "A reply already on the twin finishes before changing the arrangement.");
  gates.get(replyId)!(); await held;
  await until(() => !lead().computer); await switched(false);
  await ask("No computer now"); assert.equal(seen.at(-1)!.input.lane, "chat");
  const thirdLook = await looking();
  const second = work("Check dates without a computer"); await until(() => gates.has(second.id));
  assert.equal((await thirdLook.done).state, "stopped"); assert.equal(seen.at(-1)!.input.lane, "work");
  const waiting = await r.hq.setComputer("pebble", true);
  assert.match(waiting.why, /settings will take effect/); assert.equal(lead().computer, false);
  await ask("Still here"); assert.equal(seen.at(-1)!.input.lane, "chat"); assert.ok(gates.has(second.id));
  gates.get(second.id)!(); await second.done; await until(() => lead().computer); await switched(true);
  const lastLook = await looking();
  await r.request("/safety", "POST", { level: "paused" });
  assert.equal((await lastLook.done).state, "stopped");
  assert.equal(botTurn("pebble", "work"), null);
  console.log("Looks use the twin with or without a computer, give way to replies during computer work, and computer changes wait without stopping work or replies.");
} finally { for (const release of gates.values()) release(); await service.close(); await r.close(); }
