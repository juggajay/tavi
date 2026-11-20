import "../isolate.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALL_SERVERS, toolsFor, argumentSchema } from "../../src/hq/toolbox/tools.js";
import { newTurnCtx } from "../../src/brain/turn.js";
import { beginBotTurn, endBotTurn } from "../../src/hq/toolbox/turns.js";
import { startToolbox } from "../../src/hq/toolbox/server.js";
import { createBot } from "../../src/hq/bots.js";
import { installTeam } from "../../src/hq/team/index.js";
import { fakeAccountProtection } from "../fake-hermes.js";

const brain = readFileSync(new URL("../../src/brain/brain.ts", import.meta.url), "utf8");
const table = brain.match(/const MCP = \(ctx: TurnCtx\) => \(\{([\s\S]*?)\n\}\);/)![1];
const original = [...table.matchAll(/^\s+(\w+): (\w+)\(ctx\)/gm)].map((m) => m[1]);
assert.equal(original.length, 13);
assert.deepEqual(ALL_SERVERS, [...original, "team", "web"]);
assert.ok(!table.includes("team:"));
const tools = toolsFor(newTurnCtx(), "team");
assert.deepEqual(tools.map((t) => t.name), ["list_team", "ask_bot", "draft_job_card", "propose_bot", "change_job_card", "hand_over", "job_status", "stop_job", "hand_back", "propose_shared_note", "ask_owner", "list_engines", "set_engine", "look_now", "finds_settings", "find_reaction", "sent_finds"]);
for (const tool of tools) assert.ok(argumentSchema(tool.inputSchema));
const ctx = beginBotTurn("test-bot", { job_id: null, origin: null, test: true, background: false });
assert.equal(ctx.bot, "test-bot");
endBotTurn("test-bot");
fakeAccountProtection();
const lead = createBot({ id: "main", name: "Main" });
const missing = () => { throw new Error("This check should only list the team."); };
const disconnect = installTeam({ makeBot: missing, activateBot: missing, runTrial: missing, startHandOver: missing, message: missing, askOwner: missing, live: () => ({ busy: false, queued: 0 }) });
const server = await startToolbox({ host: "127.0.0.1", port: 0, tokenFor: (id) => id === lead.id ? "test-token" : null, level: () => "open" });
try {
  beginBotTurn(lead.id, { job_id: null, origin: null, test: true, background: false });
  const response = await fetch(`${server.baseUrl}/mcp/${lead.id}/team`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_team", arguments: {} } }) });
  assert.equal(response.status, 200);
  const result = await response.json() as { result: { content: { text: string }[] } };
  assert.equal(JSON.parse(result.result.content[0].text)[0].id, lead.id);
} finally { endBotTurn(lead.id); await server.close(); disconnect(); }
console.log("toolbox: the original thirteen groups plus team; bot identity travels with each request");
