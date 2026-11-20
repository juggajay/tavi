import "../isolate.js";
import { earlier } from "../../src/shared/earlier.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { WebSocket } from "ws";
import { rig, until } from "./hq-api-fixture.test.js";
import { ScreenGuardClient, configureScreens } from "../../src/hq/screens/index.js";
import { handleScreenUpgrade } from "../../src/hq/api.js";
import { getBot } from "../../src/hq/bots.js";
import { fakeScreen } from "./hq-screens-fake.test.js";
import { ByteQueue, VERSION } from "../../src/hq/screens/rfb.js";
import type { ScreenPorts } from "../../src/guard/fence.js";
class ScreenGuard extends ScreenGuardClient {
  constructor() { super({} as ConstructorParameters<typeof ScreenGuardClient>[0]); }
  override async setPorts(ports: ScreenPorts) { return { applied: true, ports }; }
  override async prepare() {}
  override async fence() { return { applied: true, ports: null }; }
  override async drop() {}
}
const r = await rig(undefined, { screenGuard: new ScreenGuard(), screenReady: async () => {} }), screen = await fakeScreen();
const relay = configureScreens({ bot: getBot, password: () => screen.password, level: () => r.guard.level(), events: on => r.guard.events(on),
  audit() {}, notice() {}, connect: () => createConnection({ host: "127.0.0.1", port: screen.port }) });
const server = createServer();
server.on("upgrade", (req, socket, head) => {
  if (!handleScreenUpgrade(req, socket, head, r.hq, { isLocal: req => !req.headers["x-forwarded-for"], sameOrigin: req => req.headers.origin === `http://${req.headers.host}` })) socket.destroy();
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const clients = new Set<WebSocket>();
const open = (mode: string, headers: Record<string, string> = {}) => {
  const socket = new WebSocket(base.replace("http", "ws") + `/api/hq/bots/tim/screen?mode=${mode}`, "binary", { headers: { Origin: base, ...headers } }); clients.add(socket);
  return { socket, result: new Promise<number>(resolve => { socket.once("open", () => resolve(101)); socket.once("unexpected-response", (_, res) => { resolve(res.statusCode!); res.resume(); socket.terminate(); }); socket.on("error", () => {}); }) };
};
try {
  assert.equal((await r.request("/bots/tim/screen.png")).status, 404);
  assert.equal((await r.request("/bots/tim/computer", "POST", { on: true }, true)).status, 403);
  assert.equal((await r.request("/bots/tim/computer", "POST", { on: "yes" })).status, 400);
  await r.request("/bots/tim/computer", "POST", { on: true }); await until(() => r.hq.computer("tim").state === "ready");
  assert.equal((await r.request("/bots/tim/computer", "GET", undefined, true)).data.state, "ready");
  const count = screen.connections;
  const first = await fetch(r.base + "/api/hq/bots/tim/screen.png"), second = await fetch(r.base + "/api/hq/bots/tim/screen.png");
  assert.equal(first.status, 200); assert.equal(first.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), Buffer.from(await second.arrayBuffer())); assert.equal(screen.connections, count + 1);
  assert.equal(await open("control", { "x-forwarded-for": "100.64.0.2" }).result, 403);
  assert.equal(await open("watch", { Origin: "https://elsewhere.invalid" }).result, 403);
  assert.equal(await open("watch", { Origin: "" }).result, 403);
  assert.equal(await open("unknown").result, 403);
  assert.equal(await open("watch", { "x-tavi-agent": "1" }).result, 403);
  assert.equal(await open("watch", { [earlier.agentHeader]: "1" }).result, 403);
  const watch = open("watch", { "x-forwarded-for": "100.64.0.2" }), q = new ByteQueue();
  watch.socket.on("message", (b: Buffer) => q.push(b)); assert.equal(await watch.result, 101); assert.deepEqual(await q.read(12), VERSION); watch.socket.close();
  await r.request("/safety", "POST", { level: "paused" }); await until(() => r.guard.level() === "paused");
  assert.equal((await r.request("/bots/tim/screen.png")).status, 409);
  assert.equal((await r.request("/bots/tim/computer", "POST", { on: false })).status, 409);
  assert.equal(await open("watch").result, 403);
  assert.equal((await r.request("/bots/tim/computer")).data.state, "stopped");
  console.log("Screen pictures, caching, devices, origin and safety checks passed.");
} finally {
  for (const socket of clients) socket.terminate(); relay.close();
  await new Promise<void>(resolve => server.close(() => resolve())); await r.close(); await screen.close();
}
