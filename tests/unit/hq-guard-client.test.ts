import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GuardClient, type GuardEvent } from "../../src/hq/guardClient.js";
import type { SafetyLevel } from "../../src/hq/contract.js";

const dir = path.join(TEST_DIR, "guard"); mkdirSync(dir);
const secretPath = path.join(dir, "secret-relay");
let relay = "b".repeat(64);
writeFileSync(secretPath, relay);
let level: SafetyLevel = "open";
let unavailable = false;
let slow = false;
let quiet = false;
let subscriptions = 0;
const streams = new Set<ServerResponse>();
const requests: { route: string; method: string; body: Record<string, unknown>; auth: string }[] = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  requests.push({ route: req.url!, method: req.method!, body, auth: req.headers.authorization || "" });
  if (unavailable || req.headers.authorization !== `Bearer ${relay}` || req.url === "/pin") {
    res.writeHead(401); res.end(`This should never reach the owner: ${relay}`); return;
  }
  if (slow && req.url === "/seen") return;
  if (req.url === "/events") {
    subscriptions++;
    streams.add(res);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: level\ndata: ${JSON.stringify({ level })}\n\n`);
    const heartbeat = setInterval(() => { if (!quiet) res.write(": still here\n\n"); }, 10);
    res.on("close", () => { clearInterval(heartbeat); streams.delete(res); });
    return;
  }
  if (/\/sign-in\/.*\/events/.test(req.url!)) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('event: line\ndata: {"text":"Open the sign-in page"}\n\nevent: ended\ndata: {"code":0}\n\n'); return;
  }
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/state") res.end(JSON.stringify({ level, bots: [], ready: true }));
  else if (req.url === "/level") { level = body.level as SafetyLevel; res.end("{}"); }
  else if (req.url === "/trip") { level = "walled"; res.end("{}"); }
  else if (/\/sign-in$/.test(req.url!)) res.end('{"session":"test-session"}');
  else if (req.url === "/bots") res.end('{"home":"/srv/lh/team/profiles/test"}');
  else if (req.method === "GET" && req.url!.includes("/file/")) res.end('{"content":"standing instructions"}');
  else if (req.url!.includes("/log?") || req.url!.startsWith("/audit?")) res.end('{"lines":["All well"]}');
  else res.end("{}");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;
const waitFor = async (check: () => boolean) => {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "the safety switch connection changed in time");
};
const client = new GuardClient({ baseUrl, secretPath, timeoutMs: 100, streamIdleMs: 100, reconnectMs: 20, watch: false });
let watcher: GuardClient | undefined;
try {
  assert.equal(client.level(), "walled"); assert.equal(client.guardDown(), true);
  await client.state();
  assert.equal(client.level(), "open"); assert.equal(client.guardDown(), false);
  assert.equal((await client.makeBot("test")).home, "/srv/lh/team/profiles/test");
  await client.writeBotFile("test", "config.yaml", "settings");
  await client.writeBotFile("test", ".env", "private test settings");
  assert.equal((await client.readBotFile("test", "SOUL.md")).content, "standing instructions");
  await client.makeTeam(); await client.writeTeamFile("config.yaml", "team settings"); await client.signOut("openai-codex");
  await client.startSpace(); await client.stopSpace();
  await client.startProcess("lh-team"); await client.stopProcess("lh-team");
  assert.deepEqual((await client.processLog("lh-team", "gateway", 17)).lines, ["All well"]);
  const signIn = await client.signIn("anthropic");
  assert.equal(signIn.session, "test-session");
  const signInEvents: GuardEvent[] = [];
  await client.signInEvents(signIn.session, (e) => signInEvents.push(e), new AbortController().signal);
  assert.deepEqual(signInEvents.map((e) => e.event), ["line", "ended"]);
  await client.signInInput(signIn.session, "a code the owner typed");
  await client.endSignIn(signIn.session);
  await client.seen(); await client.audit(12);
  await client.setLevel({ level: "paused", reason: "test", by: "owner", minutes: 2, pin: "1234" });
  assert.equal(client.level(), "paused");
  await client.trip("a check failed"); assert.equal(client.level(), "walled");
  const expected = ["/team", "/team/file/config.yaml", "/subscriptions/openai-codex", "/space/start", "/space/stop", "/bots", "/bots/test/file/config.yaml", "/bots/test/file/.env", "/bots/test/file/SOUL.md",
    "/bots/lh-team/procs/gateway/start", "/bots/lh-team/procs/gateway/stop", "/bots/lh-team/procs/gateway/log?lines=17", "/subscriptions/anthropic/sign-in",
    "/sign-in/test-session/events", "/sign-in/test-session/input", "/sign-in/test-session", "/seen", "/audit?lines=12", "/level", "/trip"];
  for (const route of expected) assert.ok(requests.some((r) => r.route === route), route);
  assert.equal(requests.find((r) => r.route === "/sign-in/test-session")?.method, "DELETE");
  const signRequest = requests.find((r) => r.route === "/subscriptions/anthropic/sign-in")!;
  assert.deepEqual(signRequest.body, {});
  assert.deepEqual(requests.find((r) => r.route === "/bots")?.body, { id: "test" });
  await assert.rejects(() => client.setPin("1234"), (e: unknown) => e instanceof Error && !e.message.includes(relay) && !e.message.includes("1234"));
  assert.equal(client.level(), "walled"); assert.equal(client.guardDown(), true);
  relay = "c".repeat(64); writeFileSync(secretPath, relay);
  await client.state();
  assert.equal(requests.at(-1)?.auth, `Bearer ${relay}`, "the saved relay key is read again for each call");
  slow = true;
  await assert.rejects(() => client.seen(), /could not complete/);
  assert.equal(client.guardDown(), true);
  slow = false;
  process.env.LH_V3_DATA = path.join(TEST_DIR, "default-guard-data");
  mkdirSync(path.join(process.env.LH_V3_DATA, "guard"), { recursive: true });
  writeFileSync(path.join(process.env.LH_V3_DATA, "guard", "secret-relay"), relay);
  const defaultPath = new GuardClient({ baseUrl, watch: false });
  await defaultPath.state(); defaultPath.close();

  level = "open";
  watcher = new GuardClient({ baseUrl, secretPath, timeoutMs: 100, streamIdleMs: 100, reconnectMs: 20 });
  const updates: GuardEvent[] = [];
  watcher.events((e) => updates.push(e));
  await waitFor(() => subscriptions > 0 && watcher!.level() === "open");
  for (const res of streams) res.write('event: level\ndata: {"level":"paused"}\n\n');
  await waitFor(() => watcher!.level() === "paused");
  unavailable = true;
  for (const res of streams) res.destroy();
  await waitFor(() => watcher!.guardDown());
  assert.equal(watcher.level(), "walled");
  assert.ok(updates.some((e) => (e.data as { level?: string }).level === "walled"));
  const before = subscriptions;
  unavailable = false; level = "open";
  await waitFor(() => subscriptions > before && watcher!.level() === "open");
  watcher.close();
  assert.equal(watcher.level(), "walled");
  await waitFor(() => streams.size === 0);
  quiet = true;
  watcher = new GuardClient({ baseUrl, secretPath, timeoutMs: 100, streamIdleMs: 20, reconnectMs: 20 });
  await waitFor(() => streams.size > 0 && watcher!.level() === "open");
  const quietSubscriptions = subscriptions;
  const stateCalls = requests.filter((r) => r.route === "/state").length;
  level = "paused";
  await waitFor(() => requests.filter((r) => r.route === "/state").length > stateCalls && watcher!.level() === "paused");
  assert.equal(subscriptions, quietSubscriptions, "a quiet but reachable switch keeps its connection");
  watcher.close();
  const bad = new GuardClient({ baseUrl, secretPath: path.join(TEST_DIR, "absent-key"), watch: false });
  await assert.rejects(() => bad.state(), /safety switch/); assert.equal(bad.level(), "walled"); bad.close();
  unavailable = true;
  await assert.rejects(() => client.state(), (e: unknown) => e instanceof Error && !e.message.includes(relay));
} finally {
  client.close(); watcher?.close(); for (const res of streams) res.destroy(); server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
console.log("guard client: ok");
