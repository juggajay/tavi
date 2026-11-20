import "../isolate.js";
import assert from "node:assert/strict";
import { db } from "../../src/store/db.js";
import { newTurn, newTurnCtx } from "../../src/brain/turn.js";
import { sourcesOf } from "../../src/brain/sourceLedger.js";
import { createWeb } from "../../src/web/index.js";
import { publicIP, checkAddress } from "../../src/web/addresses.js";
import { privacyReason, privateWords } from "../../src/web/privacy.js";
import { codexBackend, claudeBackend, type Backend, type Search, type Page } from "../../src/web/backends.js";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { TEST_DIR } from "../isolate.js";
import { webArgs, codexText } from "../../src/web/process.js";

const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
const known = { names: ["Morgan", "Lena Vale"], texts: ["The private note contains an unusual arrangement of blue folders for next week."] };
const result: Search = { results: [{ title: "Public information", url: "https://example.com/info", extract: "A public fact.", date: "2026-11-20" }] };
const page: Page = { title: "Public information", url: "https://example.com/info", text: "A public fact.", date: null, cut: false };
const context = (test = false) => { const c = newTurnCtx(); c.test = test; c.turn = newTurn({ job_id: "web-check", persist: !test }); return c; };
let calls: string[] = [];
const backend: Backend = async (r) => { calls.push(r.kind); return r.kind === "search" ? result : page; };
const make = (overrides: Parameters<typeof createWeb>[0] = {}) => createWeb({ backends: { codex: backend, claude: backend }, first: () => "codex", known: () => known, level: () => "open", resolve, ...overrides });
const lookup = make();
for (const query of ["Morgan benefits", "Lena Vale research", "call +1 202-555-0100", "hello@example.com", "12 Example Avenue", "unusual arrangement of blue folders"]) {
  await assert.rejects(lookup(context(), { kind: "search", query }));
}
assert.equal(calls.length, 0);
assert.equal(privacyReason("public museum opening dates", known), null);
const ctx = context();
assert.deepEqual(await lookup(ctx, { kind: "search", query: "public museum opening dates" }), result);
assert.ok(ctx.external.has("the web"));
assert.equal(sourcesOf(ctx.turn).length, 0, "A search extract is a lead, not a page read.");
await lookup(ctx, { kind: "read", url: page.url });
assert.equal(sourcesOf(ctx.turn)[0].place, page.url);
assert.ok(db.prepare("SELECT id FROM audit_log WHERE event='source.used'").get());
const auditBefore = db.prepare("SELECT * FROM audit_log").all();
await lookup(context(true), { kind: "read", url: page.url });
assert.deepEqual(db.prepare("SELECT * FROM audit_log").all(), auditBefore);
assert.equal(calls.length, 3);
for (const url of ["file:///C:/notes", "http://localhost/", "http://10.0.0.1/", "http://100.64.0.1/", "http://[::ffff:127.0.0.1]/", "http://[fc00::1]/", "https://abcb.gov.au/", "https://abcb.gov.au./", "https://example.com:3091/", "https://u:p@example.com/"]) {
  await assert.rejects(lookup(context(), { kind: "read", url }));
}
assert.equal(calls.length, 3);
await assert.rejects(checkAddress(page.url, async () => [{ address: "127.0.0.1", family: 4 }]));
await assert.rejects(checkAddress(page.url, async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]));
for (const ip of ["0.1.2.3", "127.1.1.1", "192.168.2.3", "169.254.1.2", "100.100.1.1", "224.0.0.1", "::1", "fe80::1", "::ffff:10.1.2.3"]) assert.equal(publicIP(ip), false, ip);
assert.equal(publicIP("8.8.8.8"), true);
assert.equal(publicIP("2606:4700:4700::1111"), true);
await assert.rejects(make({ level: () => "paused" })(context(), { kind: "search", query: "public dates" }), /safety/);
let fallback = 0;
const fallbackLookup = make({ backends: { codex: async () => "bad JSON", claude: async () => { fallback++; return result; } } });
assert.deepEqual(await fallbackLookup(context(), { kind: "search", query: "public dates" }), result);
assert.equal(fallback, 1);
assert.deepEqual(await make({ first: () => "claude" })(context(), { kind: "search", query: "public dates" }), result);
await assert.rejects(make({ backends: { codex: async () => "bad JSON", claude: async () => ({ bad: true }) } })(context(), { kind: "search", query: "public dates" }), /Neither/);
const stalled: Backend = async () => new Promise(() => undefined);
assert.deepEqual(await make({ timeoutMs: 100, backends: { codex: stalled, claude: backend } })(context(), { kind: "search", query: "public dates" }), result);
await assert.rejects(make({ timeoutMs: 15, backends: { codex: stalled, claude: stalled } })(context(), { kind: "search", query: "public dates" }), /too long/);
const limited = make(), many = context(true);
for (let i = 0; i < 20; i++) await limited(many, { kind: "search", query: "public dates" });
await assert.rejects(limited(many, { kind: "search", query: "public dates" }), /twenty/);
const held = make({ backends: { codex: async () => new Promise((r) => setTimeout(() => r(result), 20)), claude: backend } });
const lane = context(), first = held(lane, { kind: "search", query: "public dates" });
await assert.rejects(held(lane, { kind: "search", query: "public dates" }), /Wait/); await first;
const cut = await make({ backends: { codex: async () => ({ ...page, text: "x".repeat(20000) }), claude: backend } })(context(true), { kind: "read", url: page.url }) as Page;
assert.equal(cut.text.length, 16000); assert.equal(cut.cut, true);

db.prepare("INSERT INTO memories(id,kind,subject,fact,status,created_at,updated_at) VALUES ('privacy-person','person','Lena Vale','Lena prefers private notes.','active','now','now')").run();
db.prepare("UPDATE about_card SET text='Morgan lives nearby.' WHERE id=1").run();
db.prepare("INSERT INTO doc_parts VALUES ('private-file',1,NULL,'The private file has seven green folders arranged by room.',NULL)").run();
const stored = privateWords();
assert.ok(privacyReason("Lena public information", stored));
assert.ok(privacyReason("Morgan public information", stored));
assert.ok(privacyReason("why the private file has seven green folders arranged by room", stored), "a long run copied from a file is refused");
assert.equal(privacyReason("seven green folders arranged by room", stored), null, "a few ordinary words that are also in a file are not private");

let live = false, asked = 0;
const words = "A public fact about opening dates, written out at enough length to be a real page of text for a reader. ".repeat(2).trim();
const codex = codexBackend(async (_prompt, _signal, search) => { live = search; asked++; return { text: JSON.stringify(search ? result : page), usage: 5 }; }, async () => ({ url: page.url, text: words, title: page.title, date: null }));
assert.deepEqual(JSON.parse(await codex({ kind: "search", query: "public dates" }, new AbortController().signal, known) as string), result); assert.equal(live, true);
assert.deepEqual(await codex({ kind: "read", url: page.url }, new AbortController().signal, known), { ...page, text: words }); assert.equal(asked, 1, "A page is read directly, with no model in between.");
let sdkCalls = 0;
const claude = claudeBackend(({ options }) => ({ async *[Symbol.asyncIterator]() {
  sdkCalls++;
  assert.deepEqual(options.tools, ["WebSearch", "WebFetch"]);
  assert.equal(options.persistSession, false); assert.deepEqual(options.settingSources, []);
  const check = options.hooks!.PreToolUse![0].hooks[0];
  const allowed = await check({ hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input: { query: "public dates" } } as never, undefined, { signal: new AbortController().signal });
  assert.notEqual((allowed as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, "deny");
  const denied = await check({ hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input: { query: "Morgan notes" } } as never, undefined, { signal: new AbortController().signal });
  assert.equal((denied as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, "deny");
  yield { type: "result", subtype: "success", is_error: false, result: JSON.stringify(result) } as never;
} }), resolve);
const beforeClaude = db.prepare("SELECT * FROM audit_log").all();
assert.deepEqual(JSON.parse(await claude({ kind: "search", query: "public dates" }, new AbortController().signal, known, true) as string), result);
assert.equal(sdkCalls, 1); assert.deepEqual(db.prepare("SELECT * FROM audit_log").all(), beforeClaude);

const args = webArgs(true);
for (const arg of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "read-only", 'web_search="live"']) assert.ok(args.includes(arg));
assert.ok(args.includes("shell_tool")); assert.ok(!args.includes("resume"));
const fake = path.join(TEST_DIR, "web-fake.mjs"), capture = path.join(TEST_DIR, "web-capture.json");
writeFileSync(fake, `import fs from 'node:fs'; let prompt=''; process.stdin.on('data',d=>prompt+=d); process.stdin.on('end',()=>{ fs.writeFileSync(process.env.FAKE_CODEX_LOG,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),prompt,key:process.env.OPENAI_API_KEY})); console.log(JSON.stringify({type:'item.completed',item:{type:'web_search',action:{type:'search'}}})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"results":[]}'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:4,output_tokens:2}})); });`);
process.env.LH_CODEX = fake; process.env.FAKE_CODEX_LOG = capture; process.env.OPENAI_API_KEY = "never-pass-this";
try {
  assert.deepEqual(await codexText("public dates", AbortSignal.timeout(3000), true), { text: '{"results":[]}', usage: 6 });
  const captured = JSON.parse(readFileSync(capture, "utf8")); assert.equal(captured.key, undefined); assert.equal(captured.prompt, "public dates"); assert.notEqual(captured.cwd, process.cwd());
  writeFileSync(fake, "setInterval(()=>{},1000);");
  await assert.rejects(codexText("public dates", AbortSignal.timeout(100), true), /stopped/);
} finally { delete process.env.LH_CODEX; delete process.env.FAKE_CODEX_LOG; delete process.env.OPENAI_API_KEY; }
console.log("Web look-ups: privacy, public addresses, sources, test turns, both services, fallback, limits and child shutdown passed.");
