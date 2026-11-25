import "../isolate.js";
import assert from "node:assert/strict";
import type WebSocket from "ws";
import { fakeAccountProtection } from "../fake-hermes.js";
import { createBot, getBot, listBots } from "../../src/hq/bots.js";
import { newTurnCtx } from "../../src/brain/turn.js";
import { clients, toAll } from "../../src/gateway/clients.js";
import { installLooks, lookTools } from "../../src/hq/toolbox/looks.js";
import { lookChoices, colours, shapeNamed, colourNamed } from "../../src/hq/looks/choices.js";
import { memoryTools } from "../../src/brain/memoryTools.js";
import { standingFor } from "../../src/hq/engines/standing.js";
import { hermesMcpServers } from "../../src/hq/toolbox/config.js";

fakeAccountProtection();
const lead = createBot({ id: "pebble", name: "Pebble" });
const other = createBot({ id: "ruvo", name: "Ruvo", servers: [] });
const desk: object[] = [], phone: object[] = [];
function connect(id: string, out: object[], kind: "phone" | "desktop") {
  const ws = { readyState: 1, send: (raw: string) => out.push(JSON.parse(raw)) } as unknown as WebSocket;
  clients.set(ws, { v: 2, kind, id, screen: null, connectedAt: Date.now() });
  return ws;
}
const a = connect("desk", desk, "desktop"), b = connect("phone", phone, "phone");
const changed: string[] = [];
const off = installLooks({ changed: bot => { changed.push(bot.id); toAll({ type: "hq_bots", bots: listBots() }); } });
const ctx = newTurnCtx(); ctx.bot = lead.id; ctx.turn.origin = { client: "phone", id: "phone" };
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await lookTools(ctx).find(t => t.name === name)!.handler(args, {});
  const text = result.content[0]; assert.equal(text.type, "text");
  return { error: result.isError, data: JSON.parse(text.text as string) };
};
try {
  assert.equal((await call("show_looks", {})).error, false);
  assert.deepEqual(phone.at(-1), { type: "hq_show_looks", bot: lead.id });
  assert.equal(desk.length, 0, "Only the asking screen opens the picker");
  await call("show_looks", { bot: "Ruvo" });
  assert.deepEqual(phone.at(-1), { type: "hq_show_looks", bot: other.id });
  assert.equal((await call("set_look", { colour: "green", ownerAsked: true })).error, false);
  assert.deepEqual(getBot(lead.id)!.look, { shape: "pebble", colour: "green" });
  assert.equal((desk.at(-1) as { type: string }).type, "hq_bots");
  assert.equal((phone.at(-1) as { type: string }).type, "hq_bots");
  const now = await call("set_look", { shape: "the round one", ownerAsked: true });
  assert.deepEqual(now.data.look, { shape: "marble", colour: "green" });
  await call("set_look", { bot: "Ruvo", shape: "Toast", colour: "purple", ownerAsked: true });
  assert.deepEqual(getBot(other.id)!.look, { shape: "breakfast-club/toast", colour: "plum" });
  const count = changed.length;
  for (const args of [{ shape: "not a look", ownerAsked: true }, { colour: "invisible", ownerAsked: true }, { shape: "constructor", ownerAsked: true }, { colour: "blue", ownerAsked: false }]) {
    const result = await call("set_look", args); assert.equal(result.error, true);
    assert.match(result.data.error, /owner|marble.*jellyfish.*blue/);
  }
  ctx.bot = other.id;
  assert.equal((await call("set_look", { bot: lead.id, colour: "blue", ownerAsked: true })).error, true);
  assert.equal((await call("show_looks", { bot: lead.id })).error, true);
  assert.equal(changed.length, count);
  assert.equal((await call("set_look", { colour: "yellow", ownerAsked: true })).error, false);
  ctx.background = true;
  assert.equal((await call("set_look", { colour: "blue", ownerAsked: true })).error, true);
  assert.equal((await call("show_looks", {})).error, true);
  ctx.background = false; ctx.test = true;
  const saved = getBot(other.id)!.look;
  const trial = await lookTools(ctx).find(t => t.name === "set_look")!.handler({ colour: "blue", ownerAsked: true }, {});
  assert.match(JSON.stringify(trial), /nothing was saved/);
  assert.deepEqual(getBot(other.id)!.look, saved);
  ctx.test = false; ctx.turn.origin = null;
  assert.equal((await call("show_looks", {})).error, true);
  for (const choice of lookChoices) assert.equal(shapeNamed(choice.name), choice.id);
  for (const colour of Object.keys(colours)) assert.equal(colourNamed(colour), colour);
  assert.equal(colourNamed("__proto__"), undefined);
  assert.equal(shapeNamed("constructor"), undefined);
  process.env.LH_V3 = "1";
  assert.ok(!memoryTools(ctx).some(t => t.name === "set_pebble_colour"));
  const { listedTools } = await import("../../src/hq/toolbox/tools.js");
  assert.ok(!listedTools("memory", other.id).some(t => t.name === "set_pebble_colour"));
  for (const bot of [lead, other]) {
    const names = listedTools("team", bot.id).map(t => t.name);
    assert.ok(names.includes("show_looks") && names.includes("set_look"));
    const words = standingFor(bot);
    assert.match(words, /show_looks.*wait/); assert.match(words, /set_look/);
    assert.match(words, /Never say a look cannot be changed/);
  }
  assert.ok(hermesMcpServers(other.id, { baseUrl: "http://127.0.0.1:3090", token: "test", servers: [] }).team);
  delete process.env.LH_V3;
  assert.ok(memoryTools(ctx).some(t => t.name === "set_pebble_colour"));
  console.log("Own and lead changes, refusals, aliases, saved looks, screen events, picker routing, test turns, tool lists and standing words passed.");
} finally { off(); clients.delete(a); clients.delete(b); delete process.env.LH_V3; }
