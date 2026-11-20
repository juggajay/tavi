import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ScreenGuardClient } from "../../src/hq/screens/guard.js";
import { GuardClient } from "../../src/hq/guardClient.js";
import { screenPorts } from "../../src/guard/fence.js";

const key = "a".repeat(64), file = path.join(TEST_DIR, "screen-relay-key"); writeFileSync(file, key);
const calls: { method: string; route: string; body: unknown }[] = [];
let refuse = false;
const server = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${key}`);
  let text = ""; for await (const data of req) text += data;
  calls.push({ method: req.method!, route: req.url!, body: text ? JSON.parse(text) : undefined });
  res.writeHead(refuse ? 503 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ applied: true, password: "test1234" }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const guard = new GuardClient({ baseUrl, watch: false });
const screens = new ScreenGuardClient(guard, { secretPath: file });
try {
  const ports = screenPorts("bot-a", { display: 1, vncPort: 5911, cdpPort: 9211 });
  assert.equal((await screens.setPorts(ports)).applied, true);
  assert.equal((await screens.fence("bot-a")).applied, true);
  await screens.prepare("bot-a", "picture", "page");
  await screens.audit("a", true); assert.equal(await screens.password("bot-a"), "test1234"); await screens.drop("bot-a");
  assert.deepEqual(calls.map((c) => [c.method, c.route]), [["PUT", "/bots/bot-a/ports"], ["GET", "/bots/bot-a/ports"],
    ["PUT", "/bots/bot-a/screen"], ["POST", "/screen-audit"], ["GET", "/bots/bot-a/screen/key"], ["DELETE", "/bots/bot-a/ports"]]);
  assert.deepEqual(calls[2].body, { wallpaper: "picture", home: "page" });
  refuse = true; await assert.rejects(screens.fence("bot-a"), /The safety switch/);
  writeFileSync(file, "damaged"); await assert.rejects(screens.fence("bot-a"), /The safety switch/);
} finally { guard.close(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
console.log("screen calls to the safety switch: ok");
