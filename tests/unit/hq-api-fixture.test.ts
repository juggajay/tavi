import { TEST_DIR } from "../isolate.js";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Engine, SafetyLevel } from "../../src/hq/contract.js";
import type { HqOptions } from "../../src/hq/hq.js";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

process.env.LH_FAKE_BRAIN = "1";
process.env.LH_V3_DATA = TEST_DIR;
process.env.DOTENV_CONFIG_PATH = path.join(TEST_DIR, "no-env-file");

export async function rig(engine?: Engine, options: Partial<HqOptions> = {}, startChecks = 0) {
  const { GuardClient } = await import("../../src/hq/guardClient.js");
  const { startHq, stopHq } = await import("../../src/hq/hq.js");
  const { fakeHermes, fakeAccountProtection } = await import("../fake-hermes.js");
  fakeAccountProtection();
  const { handleHq } = await import("../../src/hq/api.js");
  const folder = path.join(TEST_DIR, "guard"); mkdirSync(folder, { recursive: true });
  const relayKey = "ab".repeat(32), localKey = "cd".repeat(32);
  const secretPath = path.join(folder, "secret-relay");
  writeFileSync(secretPath, relayKey); writeFileSync(path.join(folder, "secret-local"), localKey);
  let level: SafetyLevel = "open", until: string | null = null;
  const events = new Set<ServerResponse>();
  const calls: { route: string; authorization?: string }[] = [];
  const files = new Map<string, string>();
  let signInput = "";
  let spaceStarted = false, checksLeft = startChecks;
  const guardServer = createServer(async (req, res) => {
    const route = req.url ?? "";
    calls.push({ route, authorization: req.headers.authorization });
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (![relayKey, localKey].some((key) => req.headers.authorization === `Bearer ${key}`)) return json(401, { error: "The access key was refused." });
    let text = ""; for await (const chunk of req) text += chunk;
    const data = JSON.parse(text || "{}");
    if (req.method === "PUT" && route.endsWith("/config.yaml")) files.set(route, data.content);
    if (route === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); events.add(res);
      res.once("close", () => events.delete(res)); return;
    }
    if (route === "/space/start") { spaceStarted = true; return json(200, { ok: true }); }
    if (route === "/state") {
      if (spaceStarted && checksLeft > 0) checksLeft--;
      return json(200, { level, until, pinSet: true, ownerUbuntuRunning: false,
        probe: { ok: true, at: new Date().toISOString(), failed: [] }, bots: [], ready: checksLeft === 0, privateValue: "must stay inside" });
    }
    if (checksLeft > 0 && (route === "/team" || route.includes("/file/"))) return json(503, { error: "The space has not finished its checks." });
    if (route === "/level") {
      if (["open", "paused", "walled", "killed"].indexOf(data.level) < ["open", "paused", "walled", "killed"].indexOf(level) && data.pin !== "1357")
        return json(403, { error: "Enter your safety PIN before lowering the switch." });
      if (!["open", "paused", "walled", "killed"].includes(data.level)) return json(400, { error: "Choose a safety level." });
      level = data.level; until = data.minutes ? new Date(Date.now() + data.minutes * 60000).toISOString() : null;
      for (const stream of events) stream.write(`event: level\ndata: ${JSON.stringify({ level })}\n\n`);
      return json(200, { ok: true });
    }
    if (route === "/pin") return json(req.headers.authorization === `Bearer ${localKey}` ? 200 : 403, { ok: true });
    if (route === "/subscriptions/anthropic/sign-in") return json(200, { session: "signin-1" });
    if (route === "/sign-in/signin-1/input") { signInput = data.text; return json(200, { ok: true }); }
    if (route === "/sign-in/signin-1/events") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end('event: line\ndata: "Please sign in"\n\nevent: ended\ndata: {}\n\n'); return; }
    return json(200, { ok: true });
  });
  await new Promise<void>((resolve) => guardServer.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(guardServer.address() as AddressInfo).port}`;
  const guard = new GuardClient({ baseUrl, secretPath, timeoutMs: 300, reconnectMs: 20 });
  const gateway = await fakeHermes();
  const hq = await startHq({ guard, engine, chat: engine, toolboxHost: "127.0.0.1", toolboxPort: 0,
    hermes: { teamGatewayUrl: gateway.url, startupMs: 500, pollMs: 5, requestTimeoutMs: 100, firstByteMs: 1000 }, ...options });
  const { listBots } = await import("../../src/hq/bots.js");
  const end = Date.now() + 5000;
  while ((await Promise.all(listBots().map((bot) => hq.engineState(bot)))).some((state) => state.status === "starting")) {
    if (Date.now() > end) throw new Error("The test team did not finish starting.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const server = createServer((req, res) => {
    void handleHq(req, res, new URL(req.url ?? "/", "http://local"), hq, {
      isLocal: (r) => !r.headers["x-forwarded-for"], sameOrigin: (r) => !r.headers.origin || r.headers.origin === `http://${r.headers.host}`,
    }, { baseUrl, secretPath, timeoutMs: 300 }).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (route: string, method = "GET", data?: unknown, phone = false, headers: Record<string, string> = {}) => {
    const response = await fetch(base + "/api/hq" + route, { method, headers: { "Content-Type": "application/json", ...(phone ? { "x-forwarded-for": "100.64.0.2" } : {}), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    const text = await response.text();
    return { status: response.status, text, data: (() => { try { return JSON.parse(text); } catch { return text; } })() };
  };
  const stopGuard = async () => {
    for (const stream of events) stream.destroy();
    guardServer.closeAllConnections();
    if (guardServer.listening) await new Promise<void>((resolve) => guardServer.close(() => resolve()));
  };
  return { hq, guard, gateway, request, base, calls, files, get input() { return signInput; }, stopGuard,
    async close() { await stopHq(); await stopGuard(); await gateway.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
export const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error("The expected test result did not arrive."); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const r = await rig(undefined, { toolboxHost: null });
  try {
    const state = await r.request("/state");
    assert.equal(state.status, 200); assert.equal(state.data.toolbox, "off");
    assert.equal(state.data.guard, "up"); assert.equal(state.data.bots.length, 2);
    assert.equal(r.calls.filter((c) => c.route === "/team").length, 0, "no gateway is started without a toolbox address");
    console.log("hq-api-fixture: ok (the team can start with the Linux address missing)");
  } finally { await r.close(); }
}
