import "../isolate.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { request, IncomingMessage, ClientRequest, RequestOptions } from "node:http";
import { publicPage, claudeBackend } from "../../src/web/backends.js";

const known = { names: ["Morgan"], texts: [] };
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
const signal = () => new AbortController().signal;
let addresses: string[] = [], next = "/article", status = 200, type = "text/html", body = "<style>bad</style><script>bad()</script><h1>A useful page</h1><p>A &amp; B &#65;</p>";
const transport = ((url: URL, options: RequestOptions & { autoSelectFamily: boolean }, callback: (res: IncomingMessage) => void) => {
  addresses.push(url.href);
  assert.equal(options.autoSelectFamily, false); assert.equal(options.agent, false);
  (options.lookup as Function)(url.hostname, {}, (_error: unknown, address: string) => assert.equal(address, "93.184.216.34", "The connection uses the checked address."));
  const req = new EventEmitter() as ClientRequest;
  req.destroy = (error?: Error) => { if (error) queueMicrotask(() => req.emit("error", error)); return req; };
  req.end = (() => {
    const res = new PassThrough() as unknown as IncomingMessage;
    res.statusCode = url.pathname === "/start" ? 302 : status;
    res.headers = url.pathname === "/start" ? { location: next } : { "content-type": type };
    queueMicrotask(() => { callback(res); (res as unknown as PassThrough).end(body); });
    return req;
  }) as typeof req.end;
  return req;
}) as unknown as typeof request;
const page = (url = "https://example.com/start") => publicPage(url, signal(), known, resolve, 0, transport);
assert.deepEqual(await page(), { url: "https://example.com/article", text: "A useful page A & B A", title: undefined, date: null });
assert.equal(addresses.length, 2);
for (const target of ["http://127.0.0.1/", "https://abcb.gov.au/", "https://example.com/?name=Morgan"]) {
  addresses = []; next = target; await assert.rejects(page()); assert.equal(addresses.length, 1, "A redirect is checked before connecting.");
}
addresses = []; next = "/start"; await assert.rejects(page(), /redirects/); assert.equal(addresses.length, 4);
next = "http://["; await assert.rejects(page(), /unreadable redirect/);
status = 403; await assert.rejects(page("https://example.com/article"), /would not let this page be read/);
status = 404; await assert.rejects(page("https://example.com/article"), /does not exist/);
status = 200; type = "application/pdf"; await assert.rejects(page("https://example.com/article"), /PDF/);
type = "application/octet-stream"; await assert.rejects(page("https://example.com/article"), /not a page of text/);
type = "text/plain"; body = "x".repeat(1_000_001); await assert.rejects(page("https://example.com/article"), /too large/);
await assert.rejects(publicPage("https://example.com/", AbortSignal.abort(), known, resolve, 0, transport));

let fetched = false;
const claude = claudeBackend(({ options }) => ({ async *[Symbol.asyncIterator]() {
  assert.ok(fetched);
  const check = options.hooks!.PreToolUse![0].hooks[0];
  const hooks = { signal: signal() };
  const input = (name: string, args: unknown) => ({ hook_event_name: "PreToolUse", tool_name: name, tool_input: args }) as never;
  const denied = await check(input("WebFetch", { url: "https://example.com/other" }), undefined, hooks) as { hookSpecificOutput: { permissionDecision: string } };
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  const search = await check(input("WebSearch", { query: "public pages" }), undefined, hooks) as { hookSpecificOutput: { permissionDecision: string } };
  assert.equal(search.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await check(input("WebFetch", { url: "https://example.com/final" }), undefined, hooks), {});
  yield { type: "result", subtype: "success", is_error: false, result: '{"title":"Public page","url":"https://example.com/final","date":null,"text":"A fact.","cut":false}' } as never;
} }), resolve, async () => { fetched = true; return { url: "https://example.com/final", text: "A fact." }; });
const result = JSON.parse(await claude({ kind: "read", url: "https://example.com/start" }, signal(), known, true) as string);
assert.equal(result.url, "https://example.com/final");
console.log("Public pages: checked redirects, fixed connection addresses, readable text, size limits and guarded Claude page reads passed.");
