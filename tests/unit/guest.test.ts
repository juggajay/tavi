// The round table's guest (Stage 17.1), with a stand-in for the Codex program (tests/fixtures/fake-codex.mjs): the exact
// arguments it's run with, a new conversation then resumed ones, the time limit, one turn at a time, what its environment
// holds, a missing or signed-out Codex, a tool used, a lost conversation, the audit log, and archiving at the end.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DIR } from "../isolate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "..", "fixtures", "fake-codex.mjs");
const LOG = path.join(TEST_DIR, "fake-codex.log");
process.env.LH_CODEX = FAKE;
process.env.FAKE_CODEX_LOG = LOG;
// stand-ins for keys the child must never see
process.env.OPENAI_API_KEY = "example key never passed";
process.env.ANTHROPIC_API_KEY = "another example key never passed";

const { codexArgs, childEnv, TOOLS_OFF } = await import("../../src/guest/codex.js");
const { Guest, guestConfig } = await import("../../src/guest/guest.js");
const { firstPrompt, nextPrompt, standingBrief } = await import("../../src/guest/brief.js");
const { getSettings, updateSettings } = await import("../../src/store/settings.js");
const { db } = await import("../../src/store/db.js");

type Run = { args: string[]; cwd: string; prompt: string | null; env: string[] };
const runs = (): Run[] => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const mode = (m: string) => (process.env.FAKE_CODEX_MODE = m);

// ---- settings: the defaults the plan names
const s = getSettings();
assert.equal(s["guest.enabled"], true);
assert.equal(s["guest.name"], "Echo");
assert.equal(s["guest.model"], "gpt-6.1-terra");
assert.equal(s["guest.effort"], "low");
assert.equal(s["guest.deep_model"], "gpt-6-astra");
assert.equal(s["guest.deep_effort"], "xhigh");
assert.equal(s["guest.rounds"], 2);
assert.equal(s["guest.timeout_s"], 25);
assert.throws(() => updateSettings({ "guest.rounds": 5 }, "local"), /Bad value/, "at most four rounds");
assert.throws(() => updateSettings({ "guest.model": "gpt; rm -rf" }, "local"), /Bad value/);
assert.throws(() => updateSettings({ "guest.name": "Tim" }, "remote"), /only be changed on the PC/);

// ---- the exact arguments: read-only, his config ignored, every tool feature off, nothing else
const OFF = TOOLS_OFF.flatMap((f) => ["--disable", f]);
const BASE = ["exec", "--skip-git-repo-check", "-s", "read-only", "--ignore-user-config", "--ignore-rules", "--json", "-m", "gpt-6.1-terra", "-c", 'model_reasoning_effort="low"', "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0", ...OFF];
assert.deepEqual(codexArgs({ model: "gpt-6.1-terra", effort: "low" }), [...BASE, "-"]);
assert.deepEqual(codexArgs({ model: "gpt-6.1-terra", effort: "low", session: "abc-123" }), [...BASE, "resume", "abc-123", "-"]);
for (const f of ["shell_tool", "unified_exec", "code_mode_host", "apps", "plugins", "computer_use", "browser_use", "multi_agent"]) assert.ok((TOOLS_OFF as readonly string[]).includes(f), f);
const every = codexArgs({ model: "gpt-6-astra", effort: "xhigh", session: "s1" }).join(" ");
for (const bad of ["--dangerously", "--add-dir", "--enable", "--full-auto", "workspace-write", "danger-full-access", "-C ", "--cd", "--profile", "-p ", "--oss", "--image", "--approve"]) assert.ok(!every.includes(bad), `no ${bad}`);
assert.throws(() => codexArgs({ model: "x y", effort: "low" }), /model/);
assert.throws(() => codexArgs({ model: "m", effort: "turbo" as never }), /effort/);
assert.throws(() => codexArgs({ model: "m", effort: "low", session: "a b" }), /session/);

// ---- what the child can see: never a key
const env = childEnv();
assert.equal(env.OPENAI_API_KEY, undefined);
assert.equal(env.ANTHROPIC_API_KEY, undefined);
assert.equal(env.LH_DATA_DIR, undefined, "nothing of Tavi's");
assert.ok(env["USERPROFILE"] || env["HOME"], "enough to find its login");

// ---- a new conversation, then resumed ones, in an empty folder of its own
const names = { guest: "Tim", pebble: "Pebble" };
mode("");
const g = new Guest("tbl_test1", { ...guestConfig(), timeoutMs: 15_000 });
assert.ok(g.dir.startsWith(TEST_DIR), "under the data folder");
assert.deepEqual(readdirSync(g.dir), [], "empty");
const lines = [{ speaker: "owner" as const, text: "Should I hire a second ute or buy one?" }];
const r1 = await g.turn((fresh) => (fresh ? firstPrompt({ names, brief: "He's weighing up a second ute.", lines, task: "respond" }) : nextPrompt({ names, lines, task: "respond" })));
assert.ok(r1.ok, JSON.stringify(r1));
const first = runs().at(-1)!;
assert.deepEqual(first.args, [...BASE, "-"], "a new conversation");
assert.equal(path.resolve(first.cwd), path.resolve(g.dir), "run in its own folder");
assert.ok(first.prompt!.startsWith(standingBrief(names)), "the standing brief first");
assert.match(first.prompt!, /He's weighing up a second ute\./);
assert.match(first.prompt!, /^Owner: Should I hire a second ute or buy one\?$/m);
assert.ok(!first.env.includes("OPENAI_API_KEY") && !first.env.includes("ANTHROPIC_API_KEY"), "no keys in its environment");
const sid = g.session!;
assert.ok(sid);
const more = [{ speaker: "pebble" as const, text: "Hire it for a month first." }];
const r2 = await g.turn((fresh) => (fresh ? firstPrompt({ names, brief: "x", lines: [...lines, ...more], task: "again" }) : nextPrompt({ names, lines: more, task: "again" })));
assert.ok(r2.ok);
const second = runs().at(-1)!;
assert.deepEqual(second.args, [...BASE, "resume", sid, "-"], "the same conversation, resumed");
assert.ok(!second.prompt!.includes("You are Tim"), "only what's new goes in a resumed turn");
assert.match(second.prompt!, /^Since you last spoke:\nPebble: Hire it for a month first\.$/m);
assert.equal(g.session, sid);

// ---- the audit log has everything sent and received
const rows = db.prepare("SELECT event, detail FROM audit_log WHERE actor = 'guest' AND ref = 'tbl_test1' ORDER BY id").all() as { event: string; detail: string }[];
assert.deepEqual(rows.map((r) => r.event), ["sent", "said", "sent", "said"]);
assert.equal(JSON.parse(rows[0].detail).prompt, first.prompt);
assert.equal(JSON.parse(rows[1].detail).text, (r1 as { text: string }).text);
assert.equal(g.sent.length, 2);

// ---- one turn at a time
mode("slow");
const slowG = new Guest("tbl_test2", { ...guestConfig(), timeoutMs: 1200 });
const t0 = Date.now();
const [a, b] = await Promise.all([slowG.turn(() => "first"), slowG.turn(() => "second")]);
assert.equal(b.ok, false);
assert.equal(!b.ok && b.why, "busy", "the second is refused, not queued");
// ---- the time limit
assert.equal(!a.ok && a.why, "timeout");
assert.equal(!a.ok && a.line, "Echo's taking too long.");
assert.ok(Date.now() - t0 < 6000, `stopped at the limit (${Date.now() - t0} ms)`);
assert.equal(runs().filter((r) => r.prompt === "second").length, 0, "the refused turn never ran");

// ---- a tool used: the turn is thrown away
mode("tool");
const toolR = await new Guest("tbl_test3", { ...guestConfig(), timeoutMs: 15_000 }).turn(() => "anything");
assert.equal(!toolR.ok && toolR.why, "tool");
assert.match(!toolR.ok ? toolR.line : "", /isn't allowed/);

// ---- signed out, and missing
mode("signedout");
const so = await new Guest("tbl_test4", { ...guestConfig(), timeoutMs: 15_000 }).turn(() => "anything");
assert.equal(!so.ok && so.why, "signed_out");
assert.match(!so.ok ? so.line : "", /isn't signed in to your OpenAI account\. I'll carry on by myself\./);
process.env.LH_CODEX = path.join(TEST_DIR, "no-such-codex.exe");
const miss = await new Guest("tbl_test5", { ...guestConfig(), timeoutMs: 15_000 }).turn(() => "anything");
assert.equal(!miss.ok && miss.why, "missing");
assert.match(!miss.ok ? miss.line : "", /can't find the Codex program on this PC\. I'll carry on by myself\./);
process.env.LH_CODEX = FAKE;

// ---- switched off in settings
const off = await new Guest("tbl_test6", { ...guestConfig(), enabled: false }).turn(() => "anything");
assert.equal(!off.ok && off.why, "off");

// ---- a conversation that's gone: started again, once, with the whole table
mode("");
const lostG = new Guest("tbl_test7", { ...guestConfig(), timeoutMs: 15_000 });
await lostG.turn(() => "fresh one");
mode("lost");
const before = runs().length;
const lostR = await lostG.turn((fresh) => (fresh ? "FRESH: whole table" : "only the new lines"));
const after = runs().slice(before);
assert.equal(after.length, 2);
assert.ok(after[0].args.includes("resume") && after[0].prompt === "only the new lines");
assert.ok(!after[1].args.includes("resume") && after[1].prompt === "FRESH: whole table", "the retry starts afresh");
assert.ok(lostR.ok, "and answers");

// ---- archived at the end (not deleted), and its empty folder goes
mode("");
const sessions = [...new Set(runs().filter((r) => r.prompt !== null).map((r) => r.args[r.args.indexOf("resume") + 1]).filter((x) => x && x !== "-"))];
await g.close();
const archived = runs().filter((r) => r.args[0] === "archive").map((r) => r.args[1]);
assert.ok(archived.includes(sid), "its conversation archived");
assert.ok(!runs().some((r) => r.args[0] === "delete"), "never deleted");
assert.equal(existsSync(g.dir), false, "its empty folder removed");
assert.ok(sessions.length >= 1);

console.log("guest: ok");
