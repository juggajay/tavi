import "../isolate.js";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createGuardServer } from "../../src/guard/http.js";
import { GuardError } from "../../src/guard/runner.js";
import type { Guard } from "../../src/guard/guard.js";

const lines: string[] = [];
const guard = {
  store: { local: "local-test", relay: "relay-test" },
  audit: (_event: string, _who: string, words: string) => lines.push(words),
  state: async () => { throw new GuardError(503, "Please try again."); },
} as unknown as Guard;
const server = createGuardServer(guard);
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address === "object");
const port = address.port;
function send(method: string, path: string, headers: Record<string, string> = {}, body = "") {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { Host: "127.0.0.1:3091", Authorization: "Bearer local-test", ...headers } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.end(body);
  });
}
try {
  assert.equal(await send("GET", "/state?private=query-value"), 503);
  assert.match(lines.at(-1)!, /^GET \/state:.*503/);
  assert.equal(await send("POST", "/space/start?private=query-value", { Authorization: "Bearer header-value", "Content-Length": "10" }, "body-value"), 401);
  assert.match(lines.at(-1)!, /^POST \/space\/start:.*valid secret/);
  assert.equal(await send("GET", "/sign-in/session-value/events?private=query-value", { Origin: "https://origin-value.invalid" }), 403);
  assert.match(lines.at(-1)!, /^GET \/sign-in\/:session\/events:.*403/);
  assert.equal(await send("GET", "/bots/bot-value/ports", { Host: "bad-host-value" }), 403);
  assert.match(lines.at(-1)!, /^GET \/bots\/:bot\/ports:.*403/);
  assert.equal(await send("DELETE", "/unknown-path-value?private=query-value"), 404);
  assert.match(lines.at(-1)!, /^DELETE unknown route:.*404/);
  assert.doesNotMatch(lines.join("\n"), /query-value|body-value|header-value|session-value|origin-value|bot-value|host-value|unknown-path-value/);
  console.log("Refused requests name their method and route without keeping private values.");
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
