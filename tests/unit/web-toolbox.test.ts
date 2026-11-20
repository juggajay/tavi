import "../isolate.js";
import assert from "node:assert/strict";
import { createBot } from "../../src/hq/bots.js";
import { fakeAccountProtection } from "../fake-hermes.js";
import { startToolbox } from "../../src/hq/toolbox/server.js";
import { ALL_SERVERS, describeTool, listedTools, type ToolboxTool } from "../../src/hq/toolbox/tools.js";
import { cardSchema, CARD_SERVERS, validateCard, type JobCard } from "../../src/hq/cards/index.js";
import { standingFor } from "../../src/hq/engines/standing.js";
import { newTurnCtx } from "../../src/brain/turn.js";
import { findsTools, installFinds } from "../../src/hq/finds/tools.js";
import { createFinds } from "../../src/hq/finds/service.js";
import { getSettings } from "../../src/store/settings.js";
import { db } from "../../src/store/db.js";
import { hermesMcpServers, ourToolName } from "../../src/hq/toolbox/config.js";
import { wishes } from "../../src/hq/finds/ledger.js";

fakeAccountProtection();
const lead = createBot({ id: "main", name: "Main" });
const card: JobCard = { version: 1, purpose: "Check public information.", notFor: "Changing anything.", handsBack: "A fact with its source.", example: null, given: "A public question.", servers: ["web", "team"], stopAndAsk: "When something private is needed.", choice: lead.primary, fallbacks: [], computer: false, trials: [], privateInfo: "none" };
assert.ok((CARD_SERVERS as readonly string[]).includes("web"));
assert.ok(cardSchema.safeParse(card).success); validateCard(card);
const allowed = createBot({ id: "reader", name: "Reader", card });
const denied = createBot({ id: "helper", name: "Helper", card: { ...card, servers: ["team"] } });
assert.ok(ALL_SERVERS.includes("web"));
assert.deepEqual(listedTools("web").map((t) => t.name), ["search", "read"]);
assert.ok(JSON.stringify(describeTool(listedTools("team", lead.id).find((t) => t.name === "draft_job_card")!)).includes('"web"'), "The card presented to a model includes the new group.");
assert.ok(standingFor(allowed).includes("mcp__public_web__search"));
assert.ok(standingFor({ ...allowed, engine: "builtin" }).includes("mcp__web__search"));
const config = hermesMcpServers(allowed.id, { baseUrl: "http://127.0.0.1:3090", token: "test-only", servers: ["web"] });
assert.equal(config.public_web.url, "http://127.0.0.1:3090/mcp/reader/web");
assert.equal(ourToolName("mcp__public_web__read"), "mcp__web__read");
assert.ok(standingFor(allowed).includes("Specialists never look"));
assert.ok(!standingFor(denied).includes("Use mcp__public_web__search and"));
assert.ok(standingFor(lead).includes("mcp__team__look_now"));
assert.ok(!listedTools("team", allowed.id).some((t) => t.name === "look_now"));
const server = await startToolbox({ host: "127.0.0.1", port: 0, level: () => "open", tokenFor: () => "test-only", serversFor: (id) => id === allowed.id ? allowed.servers : denied.servers });
try {
  for (const [bot, status] of [[allowed.id, 200], [denied.id, 404]] as const) {
    const r = await fetch(`${server.baseUrl}/mcp/${bot}/web`, { method: "POST", headers: { authorization: "Bearer test-only", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(r.status, status);
    if (status === 200) assert.deepEqual((await r.json() as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name), ["search", "read"]);
    else await r.text();
  }
} finally { server.server.closeAllConnections(); await server.close(); }

let modelCalls = 0;
const service = createFinds({ lead: () => lead, level: () => "open", voice: () => false, alerts: () => 0, context: () => "No current plans.", dev: true, send: () => assert.fail("There is nothing to send."), model: async () => { modelCalls++; return { text: '{"leads":[]}', usage: 10 }; } });
const off = installFinds(service);
const ctx = newTurnCtx(); ctx.bot = lead.id;
const tool = (name: string): ToolboxTool => findsTools(ctx).find((t) => t.name === name)!;
try {
  await tool("finds_settings").handler({ enabled: true, looks_day: 2, daily_tokens: 40000 }, {});
  assert.equal(getSettings()["finds.looks_day"], 2); assert.equal(getSettings()["finds.daily_tokens"], 40000);
  await tool("look_now").handler({}, {});
  while (service.busy()) await new Promise((done) => setTimeout(done, 5));
  assert.equal(modelCalls, 1, "The lead can request a look in the practice run.");
  await tool("find_reaction").handler({ kind: "travel", reaction: "not-interested", note: "Leave travel alone." }, {});
  assert.equal(wishes().find((w) => w.kind === "travel")!.reaction, "not-interested");
  ctx.external.add("the web");
  await assert.rejects(tool("finds_settings").handler({ enabled: false }, {}), /fresh turn/);
  ctx.external.clear(); ctx.background = true;
  await assert.rejects(tool("look_now").handler({}, {}), /owner/);
  ctx.background = false; ctx.test = true;
  const before = db.prepare("SELECT * FROM settings").all();
  await tool("finds_settings").handler({ enabled: false }, {});
  assert.deepEqual(db.prepare("SELECT * FROM settings").all(), before);
  await tool("look_now").handler({}, {}); assert.equal(modelCalls, 1);
} finally { off(); await service.close(); }
console.log("Web and finds tools: card choices, allowed groups, specialist limits, plain instructions and owner controls passed.");
