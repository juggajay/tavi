import "../isolate.js";
import assert from "node:assert/strict";
import { rig, until } from "./hq-api-fixture.test.js";
import { createBot, listBots, updateBot, gatewayKey } from "../../src/hq/bots.js";
import { twinName, twinSecret } from "../../src/hq/toolbox/lanes.js";
import { standingFor } from "../../src/hq/engines/standing.js";
import type { EngineEvent, TurnInput } from "../../src/hq/contract.js";
import { completed, frame } from "../fake-hermes.js";

const r = await rig();
try {
  await Promise.all(listBots().map((bot) => r.hq.ensure(bot)));
  await until(() => listBots().every((bot) => r.files.has(`/bots/${twinName(bot.id)}/file/config.yaml`)));
  for (const bot of listBots()) {
    const twin = twinName(bot.id);
    assert.match(twin, /^w-[a-f0-9]{20}$/);
    const config = r.files.get(`/bots/${twin}/file/config.yaml`)!;
    assert.ok(config.includes(`/mcp/${twin}/`));
    assert.ok(config.includes(`Bearer ${twinSecret(bot.id, "toolbox-token")}`));
    assert.ok(config.includes("api_server: [todo, skills]"));
    assert.ok(!config.includes('"computers":')); assert.ok(!config.includes("ssh_host"));
    assert.notEqual(twinSecret(bot.id, "gateway-key"), gatewayKey(bot.id));
  }
  let bot = listBots().find((b) => !b.lead)!;
  r.gateway.options.profiles = Object.fromEntries(listBots().flatMap((b) => [
    [b.id, { key: gatewayKey(b.id), tools: [] }],
    [twinName(b.id), { key: twinSecret(b.id, "gateway-key")!, tools: [] }],
  ]));
  const input: TurnInput = { lane: "work", text: "A test answer", instructions: "Work instructions", conversation: "test-work", choice: bot.primary };
  const run = async () => {
    const events: EngineEvent[] = [];
    await r.hq.hermes.run(bot, { ...input, choice: bot.primary }, (e) => events.push(e), new AbortController().signal);
    return events;
  };
  assert.equal((await run()).at(-1)?.type, "done");
  const requests = () => r.gateway.requests.filter((q) => q.path.endsWith("/v1/responses"));
  const request = requests().at(-1)!;
  assert.equal(request.path, `/p/${twinName(bot.id)}/v1/responses`);
  assert.equal(request.authorization, `Bearer ${twinSecret(bot.id, "gateway-key")}`);
  assert.equal(request.body.instructions, standingFor(bot) + "\n\n" + input.instructions);
  const before = r.calls.filter((c) => c.route.endsWith("/stop")).length;
  bot = updateBot(bot.id, { primary: { provider: "anthropic", model: "new-model", effort: "high" }, fallbacks: [{ provider: "openai-codex", model: "other-model" }] });
  assert.equal((await run()).at(-1)?.type, "done");
  assert.equal(requests().at(-1)!.body.model, "new-model");
  assert.equal(r.calls.filter((c) => c.route.endsWith("/stop")).length, before);
  const tried: string[] = [];
  r.gateway.options.reply = (body) => {
    tried.push(String(body.provider));
    return { script: body.provider === "anthropic" ? frame("response.failed", { response: { error: { message: "No credentials stored" } } }) : completed("Ready.") };
  };
  assert.equal((await run()).at(-1)?.type, "done");
  assert.deepEqual(tried, ["anthropic", "openai-codex"]);
  assert.ok(requests().slice(-2).every((q) => q.path === `/p/${twinName(bot.id)}/v1/responses`));
  assert.throws(() => createBot({ id: twinName(bot.id), name: "Cannot join" }));
  await r.hq.hermes.remove(bot);
  assert.equal(twinSecret(bot.id, "gateway-key"), null);
  assert.equal((await run()).at(-1)?.type, "failed");
  console.log("Each work profile has its own keys, keeps its bot's instructions and choices, and has no computer.");
} finally { await r.close(); }
