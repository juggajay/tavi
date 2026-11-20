import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createBot, updateBot, gatewayKey, teamGatewayKey, toolboxToken, DEFAULT_CHOICES } from "../../src/hq/bots.js";
import { GuardClient } from "../../src/hq/guardClient.js";
import { db } from "../../src/store/db.js";
import { HermesEngine, limits, configYaml, type HermesMcpServers } from "../../src/hq/engines/hermes.js";
import type { Bot, EngineEvent, SafetyLevel, TurnInput } from "../../src/hq/contract.js";
import { fakeHermes, scripts, frame, fakeAccountProtection } from "../fake-hermes.js";
import { standingFor } from "../../src/hq/engines/standing.js";

fakeAccountProtection();

let bot = createBot({ id: "worker", name: "Worker", fallbacks: [DEFAULT_CHOICES.openai] });
let level: SafetyLevel = "open";
const relay = "a".repeat(64);
const secretPath = path.join(TEST_DIR, "relay");
writeFileSync(secretPath, relay);
const files = new Map<string, string>();
const writes = new Map<string, number>();
const calls: string[] = [];
let refuseWrites: boolean | string = false;
let busy = false;
const guardServer = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${relay}`);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const url = req.url || "";
  calls.push(`${req.method} ${url}`);
  res.setHeader("Content-Type", "application/json");
  if (url === "/state") { res.end(JSON.stringify({ level })); return; }
  if (req.method === "PUT") {
    const name = decodeURIComponent(url.split("/").at(-1)!);
    if (refuseWrites === true || refuseWrites === name) { res.writeHead(500); res.end(JSON.stringify({ error: body.content })); return; }
    const twin = /\/bots\/(w-[a-f0-9]{20})\//.exec(url)?.[1];
    const key = url.startsWith("/team/") ? `team:${name}` : twin ? `${twin}:${name}` : name;
    files.set(key, body.content); writes.set(key, (writes.get(key) || 0) + 1);
  }
  res.end("{}");
});
await new Promise<void>((resolve) => guardServer.listen(0, "127.0.0.1", resolve));
const address = guardServer.address();
assert.ok(address && typeof address !== "string");
const guard = new GuardClient({ baseUrl: `http://127.0.0.1:${address.port}`, secretPath, watch: false });
const gateway = await fakeHermes();
const mcp: HermesMcpServers = (id, o) => Object.fromEntries(o.servers.map((name) => [name, {
  url: `${o.baseUrl}/bots/${id}/${name}`, headers: { Authorization: `Bearer ${o.token}` }, timeout: 600, connect_timeout: 30,
}]));
const options = { guard, busy: () => busy, teamGatewayUrl: gateway.url, gatewayUrl: (bot: Bot) => `${gateway.url}/p/${bot.id}`, toolboxBaseUrl: "http://172.22.160.1:3090", allServers: ["drawings", "calc"], hermesMcpServers: mcp, startupMs: 100, pollMs: 5, requestTimeoutMs: 50, firstByteMs: 80 };
let engine = new HermesEngine(options);
const starts = () => calls.filter((c) => c.endsWith("/start")).length;
const stops = () => calls.filter((c) => c.endsWith("/stop")).length;
const input: TurnInput = { text: "Check it", instructions: "Be careful", conversation: "hq-worker-g0", choice: bot.primary };
const run = async (e = engine, b = bot, request = input, controller = new AbortController()) => {
  const events: EngineEvent[] = [];
  await e.run(b, request, (event) => events.push(event), controller.signal);
  assert.equal(events.filter((e) => e.type === "done" || e.type === "failed").length, 1, "one ending for each request");
  return events;
};
try {
  assert.equal((await engine.ensure(bot)).ok, false, "an unknown guard is walled off");
  assert.equal(calls.length, 0);
  await guard.state();
  assert.equal((await engine.ensureTeam()).ok, true);
  assert.equal(writes.get("team:config.yaml"), 1);
  assert.equal(writes.get("team:.env"), 1);
  assert.equal(files.get("team:.env"), `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${teamGatewayKey()}\nAPI_SERVER_PORT=8650\nAPI_SERVER_HOST=127.0.0.1\n`);
  for (const line of ["api_server: []", "adopt_external_logins: false", "check: false", "enabled: false"]) assert.ok(files.get("team:config.yaml")!.includes(line));
  const teamStart = starts();
  await Promise.all([engine.ensure(bot), engine.ensure(bot)]);
  assert.equal(writes.get("config.yaml"), 1);
  assert.equal(writes.get(".env"), 1);
  assert.equal(writes.get("SOUL.md"), 1);
  assert.equal(starts(), teamStart + 1, "overlapping starts write settings once");
  const env = files.get(".env")!;
  assert.equal(env, `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${gatewayKey(bot.id)}\n`);
  const yaml = files.get("config.yaml")!;
  assert.ok(yaml.includes("api_server: [todo, skills]"));
  assert.ok(yaml.includes('enabled: "off"'));
  for (const line of ["adopt_external_logins: false", "check: false", "mode: manual", "memory_enabled: false", "user_profile_enabled: false", "connect_timeout: 30", "timeout: 600"])
    assert.ok(yaml.includes(line), line);
  assert.ok(yaml.includes(`Bearer ${toolboxToken(bot.id)}`));
  assert.ok(yaml.includes("fallback_providers:"));
  assert.ok(!yaml.includes("terminal") && !yaml.includes("computer_use"));
  const before = stops();
  engine = new HermesEngine(options);
  await engine.ensure(bot);
  assert.equal(writes.get("config.yaml"), 1, "saved hashes survive a manager restart");
  assert.equal(stops(), before);
  bot = updateBot(bot.id, { role: "Watch the names." });
  await engine.ensure(bot);
  assert.equal(writes.get("SOUL.md"), 2);
  assert.equal(stops(), before, "standing instructions do not need a restart");
  bot = updateBot(bot.id, { primary: { ...bot.primary, effort: "low" } });
  await engine.ensure(bot);
  assert.equal(writes.get("config.yaml"), 2);
  assert.equal(writes.get(".env"), 1);
  assert.equal(stops(), before + 1);
  busy = true;
  bot = updateBot(bot.id, { primary: { ...bot.primary, effort: "medium" } });
  const beforeQuiet = stops();
  const delayed = await engine.ensure(bot);
  assert.equal(delayed.ok, false);
  assert.match(delayed.why!, /quiet/);
  assert.equal(stops(), beforeQuiet);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(stops(), beforeQuiet, "another bot's turn prevents a restart");
  assert.equal((await engine.ready(bot)).ok, false);
  level = "paused"; await guard.state();
  busy = false;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(stops(), beforeQuiet, "the safety switch holds a waiting restart");
  level = "open"; await guard.state();
  const quietEnd = Date.now() + 2000;
  while (stops() === beforeQuiet && Date.now() < quietEnd) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stops(), beforeQuiet + 1, "the gateway restarts by itself when the team is quiet");
  while (db.prepare("SELECT value FROM settings WHERE key='team:restart-needed'").get()?.value === "yes" && Date.now() < quietEnd) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await engine.ready(bot)).ok, true);
  const runningController = new AbortController();
  gateway.options.script = frame("response.output_text.delta", { delta: "Still working" });
  gateway.options.holdOpen = true;
  const runningEvents: EngineEvent[] = [];
  const working = engine.run(bot, input, event => runningEvents.push(event), runningController.signal);
  // Wait for a streamed word, then keep the reply open until the test stops it.
  const turnDeadline = Date.now() + 5000;
  while (!runningEvents.some(event => event.type === "text") && Date.now() < turnDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(runningEvents.some(event => event.type === "text"), "the turn has started answering");
  const ownTurnStops = stops();
  bot = updateBot(bot.id, { primary: { ...bot.primary, effort: "xhigh" } });
  assert.equal((await engine.ensure(bot)).ok, false);
  assert.equal(stops(), ownTurnStops, "a running turn prevents a restart even without a busy answer from HQ");
  runningController.abort(); await working;
  assert.equal(runningEvents.filter(event => event.type === "failed" || event.type === "done").length, 1);
  const ending = runningEvents.at(-1);
  assert.ok(ending?.type === "failed");
  assert.equal(ending.reason, "stopped");
  gateway.options.holdOpen = false;
  const ownTurnEnd = Date.now() + 2000;
  while (db.prepare("SELECT value FROM settings WHERE key='team:restart-needed'").get()?.value === "yes" && Date.now() < ownTurnEnd) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stops(), ownTurnStops + 1);
  gateway.options.script = scripts.plain;
  assert.deepEqual(await engine.subscriptions(), [
    { provider: "anthropic", name: "Claude", signedIn: true, limitedUntil: null },
    { provider: "openai-codex", name: "OpenAI", signedIn: true, limitedUntil: null },
  ]);
  const signRequest = gateway.requests.filter((r) => r.path === "/api/model/options").at(-1)!;
  assert.equal(signRequest.authorization, `Bearer ${teamGatewayKey()}`);
  gateway.options.authenticated = false;
  assert.equal((await engine.ready(bot)).reason, "not_signed_in");
  assert.equal((await engine.signedIn()).anthropic, false);
  gateway.options.authenticated = true;
  gateway.options.health = false;
  assert.equal((await engine.ready(bot)).reason, "engine_down");
  assert.equal((await engine.ensure(bot)).reason, "engine_down");
  gateway.options.health = true;
  gateway.options.health = false;
  const starting = engine.ensure(bot);
  const stopping = engine.stop(bot);
  assert.equal((await starting).reason, "stopped", "stop also cancels a start that is still waiting");
  await stopping;
  gateway.options.health = true;

  for (const closed of ["paused", "walled", "killed"] as const) {
    level = closed; await guard.state();
    const count: number = calls.length;
    assert.equal((await engine.ensure(bot)).reason, "stopped");
    assert.equal((await engine.restart(bot)).reason, "stopped");
    assert.equal((await engine.ready(bot)).reason, "stopped");
    assert.equal((await run()).at(-1)?.type, "failed");
    assert.equal(calls.length, count);
  }
  level = "open"; await guard.state();
  await engine.restart(bot);
  await engine.remove(bot);
  assert.ok(stops() >= before + 2);
  const logged: string[] = [];
  const oldLog = console.log, oldWarn = console.warn, oldError = console.error;
  console.log = console.warn = console.error = (...args) => { logged.push(args.join(" ")); };
  const failedSetups: unknown[] = [];
  try {
    bot = updateBot(bot.id, { primary: { ...bot.primary, effort: "high" } });
    refuseWrites = "config.yaml";
    failedSetups.push(await engine.ensure(bot));
    await guard.state();
    const incompleteStops = stops();
    assert.equal((await engine.ensureTeam()).ok, false, "a failed profile write cannot be hidden by starting the root alone");
    assert.equal(stops(), incompleteStops);
    refuseWrites = ".env";
    db.prepare("DELETE FROM settings WHERE key=?").run(`bot:${bot.id}:file:.env`);
    failedSetups.push(await engine.ensure(bot));
  }
  finally { console.log = oldLog; console.warn = oldWarn; console.error = oldError; }
  const visible = JSON.stringify([failedSetups, logged]);
  for (const secret of [gatewayKey(bot.id), toolboxToken(bot.id), relay, "API_SERVER_KEY", ".env"]) assert.ok(!visible.includes(secret));
  refuseWrites = false; await guard.state(); await engine.ensure(bot);

  gateway.options.script = scripts.plain;
  const soulWrites = writes.get("SOUL.md"), soulStops = stops();
  bot = updateBot(bot.id, { soul: "The owner's full instructions. ".repeat(1000) });
  assert.equal((await engine.ensure(bot)).ok, true);
  assert.equal(writes.get("SOUL.md"), soulWrites);
  assert.equal(stops(), soulStops);
  const plain = await run();
  assert.equal(plain.at(-1)?.type, "done");
  const sent = gateway.requests.filter((r) => r.path === `/p/${bot.id}/v1/responses`).at(-1)!;
  assert.equal(sent.authorization, `Bearer ${gatewayKey(bot.id)}`);
  assert.deepEqual(sent.body, { model: input.choice.model, provider: input.choice.provider, model_options: { reasoning_effort: input.choice.effort }, input: input.text, instructions: standingFor(bot) + "\n\n" + input.instructions, conversation: input.conversation, stream: true, store: true });
  await run(engine, bot, { ...input, images: ["https://example.test/picture.png"] });
  assert.deepEqual((gateway.requests.at(-1)!.body.input as { content: unknown[] }[])[0].content[1], { type: "input_image", image_url: "https://example.test/picture.png" });
  gateway.options.script = scripts.tools;
  assert.equal((await run()).filter((e) => e.type === "tool").length, 4);
  gateway.options.script = scripts.commentary;
  assert.equal((await run()).find((e) => e.type === "done")?.text, "All checked.");

  const noFallback = { ...bot, fallbacks: [] };
  const cases = [
    { script: scripts.notSignedIn, reason: "not_signed_in" },
    { script: scripts.cutOff, reason: "engine_down" },
    { script: null, reason: "engine_down" },
    { script: frame("response.cancelled"), reason: "stopped" },
    { script: frame("response.failed", { response: { error: { message: "unknown fault" } } }), reason: "error" },
  ];
  for (const c of cases) {
    gateway.options.script = c.script;
    const events = await run(engine, noFallback);
    assert.equal((events.at(-1) as { reason: string }).reason, c.reason);
    assert.ok(!events.some((e) => e.type === "done"));
  }
  for (const [status, reason] of [[401, "not_signed_in"], [503, "engine_down"]] as const) {
    gateway.options.script = "no"; gateway.options.status = status;
    assert.equal((await run(engine, noFallback)).find((e) => e.type === "failed")?.reason, reason);
  }
  gateway.options.status = 200;
  gateway.options.script = scripts.plain;
  const stopOnText = new AbortController();
  const stoppedRows: EngineEvent[] = [];
  await engine.run(bot, input, (event) => {
    stoppedRows.push(event);
    if (event.type === "text") stopOnText.abort();
  }, stopOnText.signal);
  assert.equal(stoppedRows.find((e) => e.type === "failed")?.reason, "stopped");
  assert.ok(!stoppedRows.some((e) => e.type === "done"), "stop wins even when the last words arrived together");
  gateway.options.chunkBytes = 20; gateway.options.delayMs = 10;
  const controller = new AbortController();
  const pending = run(engine, bot, input, controller);
  setTimeout(() => controller.abort(), 25);
  assert.equal((await pending).find((e) => e.type === "failed")?.reason, "stopped");
  const alreadyStopped = new AbortController(); alreadyStopped.abort();
  const requestCount = gateway.requests.length;
  await run(engine, bot, input, alreadyStopped);
  assert.equal(gateway.requests.length, requestCount);
  assert.ok(gateway.disconnected > 0, "the fake engine sees the caller stop listening");
  gateway.options.script = null;
  const switching = run();
  setTimeout(() => { level = "walled"; void guard.state(); }, 20);
  assert.equal((await switching).find((e) => e.type === "failed")?.reason, "stopped");
  level = "open"; await guard.state();
  gateway.options.chunkBytes = undefined; gateway.options.delayMs = 0;
  gateway.options.script = scripts.plain;

  const fallbackBot = createBot({ id: "fallback", name: "Fallback", fallbacks: [DEFAULT_CHOICES.openai] });
  const fallbackInput = { ...input, choice: fallbackBot.primary };
  let now = Date.now();
  const fallbackEngine = new HermesEngine({ ...options, now: () => now });
  const tried: string[] = [];
  gateway.options.reply = (body) => {
    tried.push(String(body.provider));
    return { script: body.provider === "anthropic" ? scripts.limit : scripts.plain };
  };
  const events = await run(fallbackEngine, fallbackBot, fallbackInput);
  assert.deepEqual(tried, ["anthropic", "openai-codex"]);
  assert.equal(events.filter((e) => e.type === "done").length, 1);
  assert.ok(events.some((e) => e.type === "status" && e.text.includes("carrying on with OpenAI")));
  assert.equal(events.filter((e) => e.type === "failed").length, 0);
  assert.equal(limits(now).find((l) => l.bot === fallbackBot.id)?.provider, "anthropic");
  assert.equal((await fallbackEngine.subscriptions()).find((s) => s.provider === "anthropic")?.limitedUntil, new Date(now + 120000).toISOString());
  tried.length = 0;
  await run(fallbackEngine, fallbackBot, fallbackInput);
  assert.deepEqual(tried, ["openai-codex"]);
  now += 121000; tried.length = 0;
  await run(fallbackEngine, fallbackBot, fallbackInput);
  assert.deepEqual(tried, ["anthropic", "openai-codex"]);
  now += 121000;
  tried.length = 0;
  gateway.options.reply = (body) => { tried.push(String(body.provider)); return { script: scripts.notSignedIn }; };
  assert.equal((await run(fallbackEngine, fallbackBot, fallbackInput)).find((e) => e.type === "failed")?.reason, "not_signed_in");
  assert.equal(tried.length, 1, "warning text was already streamed, so this turn cannot switch providers");
  tried.length = 0;
  const noCredentials = frame("response.failed", { response: { error: { message: "No credentials stored" } } });
  gateway.options.reply = (body) => { tried.push(String(body.provider)); return { script: noCredentials }; };
  const many = { ...fallbackBot, fallbacks: [DEFAULT_CHOICES.openai, { provider: "openrouter", model: "other" } as const] };
  await run(fallbackEngine, many, fallbackInput);
  assert.deepEqual(tried, ["anthropic", "openai-codex"], "only one retry");
  tried.length = 0;
  gateway.options.reply = (body) => { tried.push(String(body.provider)); return { script: frame("response.output_text.delta", { delta: "Already answering" }) + scripts.limit }; };
  await run(fallbackEngine, fallbackBot, fallbackInput);
  assert.deepEqual(tried, ["anthropic"]);
  now += 121000;
  gateway.options.reply = () => ({ status: 429, script: "limit" });
  await run(fallbackEngine, fallbackBot, fallbackInput);
  assert.ok(fallbackEngine.limits().some((l) => l.bot === fallbackBot.id && Date.parse(l.resetsAt) === now + 900000));
  assert.equal((await run(fallbackEngine, fallbackBot, fallbackInput)).find((e) => e.type === "failed")?.reason, "limit");
  const down = new HermesEngine({ ...options, gatewayUrl: () => "http://127.0.0.1:1" });
  assert.equal((await run(down, noFallback)).find((e) => e.type === "failed")?.reason, "engine_down");
  const quoted = configYaml({ ...bot, primary: { ...bot.primary, model: 'name\nupdates:\n  check: true' } }, {});
  assert.ok(quoted.includes('name\\nupdates:\\n  check: true'));
  gateway.options.reply = undefined;
  gateway.options.status = 200;
  const secondBot = createBot({ id: "second", name: "Second", servers: ["calc"], fallbacks: [] });
  gateway.options.rootKey = teamGatewayKey();
  gateway.options.profiles = {
    [bot.id]: { key: gatewayKey(bot.id), tools: ["drawings"] },
    [secondBot.id]: { key: gatewayKey(secondBot.id), tools: ["calc"] },
  };
  assert.equal((await engine.ensure(secondBot)).ok, true);
  assert.ok(!files.get("config.yaml")!.includes('"drawings":'));
  const defaultAddress = new HermesEngine({ ...options, gatewayUrl: undefined });
  for (const b of [bot, secondBot]) {
    const route = `${gateway.url}/p/${b.id}/v1/toolsets`;
    const own = await fetch(route, { headers: { Authorization: `Bearer ${gatewayKey(b.id)}` } });
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { tools: b.id === bot.id ? ["drawings"] : ["calc"] });
    for (const key of [teamGatewayKey(), gatewayKey(b.id === bot.id ? secondBot.id : bot.id)]) {
      assert.equal((await fetch(route, { headers: { Authorization: `Bearer ${key}` } })).status, 401);
    }
    assert.equal((await run(defaultAddress, b, { ...input, choice: b.primary })).at(-1)?.type, "done");
    assert.equal(gateway.requests.at(-1)?.path, `/p/${b.id}/v1/responses`);
  }
  const removeStops = stops();
  await engine.remove(secondBot);
  assert.equal(stops(), removeStops, "removing one bot leaves the shared gateway running");
} finally {
  guard.close(); await gateway.close(); guardServer.closeAllConnections();
  await new Promise<void>((resolve) => guardServer.close(() => resolve()));
}
console.log("Hermes engine: ok");
