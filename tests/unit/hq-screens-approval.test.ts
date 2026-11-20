import "../isolate.js";
import assert from "node:assert/strict";
import { fakeAccountProtection } from "../fake-hermes.js";
import { createBot } from "../../src/hq/bots.js";
import { createTeam } from "../../src/hq/team/index.js";
import { newTurnCtx } from "../../src/brain/turn.js";
import { decide, onBrokerEvent, type ApprovalView } from "../../src/broker/broker.js";
fakeAccountProtection();
const lead = createBot({ id: "main", name: "Main" }), other = createBot({ id: "other", name: "Other" });
const changed: unknown[] = [], views = new Map<string, ApprovalView>();
const off = onBrokerEvent(e => { if (e.type === "approval") views.set(e.approval.id, e.approval); });
const missing = async (): Promise<never> => { throw new Error("This test does not use that step."); };
const team = createTeam({ makeBot: missing, activateBot: missing, runTrial: missing, startHandOver: missing, message() {}, askOwner: missing, live: () => ({ busy: false, queued: 0 }),
  async computerChanged(bot, on) { changed.push({ bot, on }); } });
try {
  const ctx = newTurnCtx(); ctx.bot = lead.id;
  const tool = team.tools(ctx).find(t => t.name === "give_computer")!; assert(tool);
  const ask = async () => JSON.parse(((await tool.handler({ bot: other.id, on: true }, {})).content[0] as { text: string }).text).approval as string;
  const id = await ask(); assert.equal(changed.length, 0);
  const view = views.get(id)!; assert(view.rows?.some(r => r.value === "A bot with a computer can browse and run commands in its own space."));
  await decide(id, view.nonce, "reject"); assert.equal(changed.length, 0);
  const yes = await ask(); await decide(yes, views.get(yes)!.nonce, "approve"); assert.deepEqual(changed, [{ bot: other.id, on: true }]);
  await decide(yes, views.get(yes)!.nonce, "approve"); assert.equal(changed.length, 1);
  const specialist = newTurnCtx(); specialist.bot = other.id;
  assert(!team.tools(specialist).some(t => t.name === "give_computer"));
  assert(!team.tools(newTurnCtx()).some(t => t.name === "give_computer"));
  const test = newTurnCtx(); test.test = true; test.bot = lead.id;
  const testTool = team.tools(test).find(t => t.name === "give_computer")!;
  const count = views.size; await testTool.handler({ bot: other.id, on: true }, {}); assert.equal(views.size, count);
  console.log("Giving a computer needs the lead, the owner's tap and a real turn.");
} finally { team.close(); off(); }
