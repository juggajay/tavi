import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
// @ts-expect-error The commands are JavaScript files with no separate type files.
import { switchTavi, main, argumentsFor, backupData, fileHashes, recordFile, processIds, verifyRunning, systemOperations } from "../../scripts/tavi-switch.mjs";
// @ts-expect-error The command is a JavaScript file with no separate type file.
import { rollbackTavi, main as rollbackMain } from "../../scripts/tavi-rollback.mjs";

let count = 0;
function fixture() {
  const folder = path.join(TEST_DIR, `switch-${count++}`), live = path.join(folder, "live"), taviData = path.join(folder, "practice");
  mkdirSync(path.join(live, "data", "profile"), { recursive: true });
  mkdirSync(path.join(taviData, "guard"), { recursive: true }); mkdirSync(path.join(taviData, "logs"));
  writeFileSync(path.join(live, "data", "harness.db"), "An old made-up database.");
  writeFileSync(path.join(live, "data", "harness.db-wal"), "Made-up waiting writes.");
  writeFileSync(path.join(live, "data", "profile", "USER.md"), "A made-up profile.");
  writeFileSync(path.join(taviData, "team.txt"), "Keep this practice team.");
  writeFileSync(path.join(taviData, "guard", "pin.json"), JSON.stringify({ salt: "a".repeat(32), hash: "b".repeat(128) }));
  const signedFile = path.join(taviData, "logs", "tavi-practice-status.json");
  writeFileSync(signedFile, JSON.stringify({ data: taviData, at: new Date().toISOString(), subscriptions: { anthropic: true, "openai-codex": true } }));
  const options = { live, taviData, port: 4321, practicePort: 4322, commit: "new-code", yes: true };
  let head = "old-code", tag = "", mode = "v2", running = "v2", fail = "";
  const calls: string[] = [], output: string[] = [];
  const check = (step: string) => { calls.push(step); if (fail === step) throw new Error("A fake program failed."); };
  const ops = {
    target: "new-code",
    async git(...args: string[]) {
      const command = args.join(" "); check(`git ${command}`);
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse") return args[2] === "new-code^{commit}" ? "new-code" : args[1] === "pre-tavi^{commit}" ? tag : head;
      if (command === "tag --list pre-tavi") return tag;
      if (command === "tag pre-tavi") tag = head;
      if (args[0] === "merge") head = "new-code";
      if (args[0] === "checkout") head = tag;
      return "";
    },
    async free() { return true; },
    async backup(from: string, to: string) { check("backup"); backupData(from, to); },
    async stop() { check("stop"); running = "stopped"; },
    async stopGuard() { check("stop guard"); },
    async carry() { check("carry"); writeFileSync(path.join(taviData, "carried.txt"), "New made-up copy."); },
    async build() { check("build"); },
    async autostart(tavi: boolean) { check(`autostart ${tavi}`); mode = tavi ? "Tavi" : "v2"; },
    async start(tavi: boolean) { check(`start ${tavi}`); running = tavi ? "Tavi" : "v2"; },
    async verify(tavi: boolean) { check(`verify ${tavi}`); },
  };
  return { folder, live, taviData, signedFile, options, ops, calls, output, print: (line: string) => output.push(line),
    fail: (step: string) => { fail = step; }, state: () => ({ head, tag, mode, running }) };
}

const dry = fixture();
const before = fileHashes(dry.folder);
assert.equal(await main(["--live", dry.live, "--tavi-data", dry.taviData, "--port", "4321", "--practice-port", "4322"], dry.ops, dry.print), 0);
assert.deepEqual(fileHashes(dry.folder), before, "Every file's hash is unchanged after a dry run.");
assert.ok(dry.output.some(line => line.includes("Dry run only")));
for (let number = 1; number <= 7; number++) assert.ok(dry.output.some(line => line.startsWith(`${number}.`)));
assert.equal(dry.calls.some(line => line === "stop" || line === "carry" || line === "build"), false);
assert.equal(argumentsFor(["--yes", "--dry-run"]).yes, false);
for (const args of [["--port", "no"], ["--port", "3091"], ["--live"], ["--other"], ["--port", "3100"]]) assert.throws(() => argumentsFor(args));

const refusals: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["unsaved", f => { f.ops.git = async (...args: string[]) => args[0] === "status" ? " M changed.ts" : ""; }],
  ["ancestor", f => f.fail("git merge-base --is-ancestor old-code new-code")],
  ["commit", f => f.fail("git rev-parse --verify new-code^{commit}")],
  ["missing program", f => f.fail("git cat-file -e new-code:scripts/tavi-supervise.mjs")],
  ["practice running", f => { f.ops.free = async () => false; }],
  ["guard running", f => { f.ops.free = async (port?: number) => port !== 3091; }],
  ["guard missing", f => rmSync(path.join(f.taviData, "guard"), { recursive: true })],
  ["PIN missing", f => rmSync(path.join(f.taviData, "guard", "pin.json"))],
  ["PIN damaged", f => writeFileSync(path.join(f.taviData, "guard", "pin.json"), "{}")],
  ["status missing", f => rmSync(f.signedFile)],
  ["not signed in", f => writeFileSync(f.signedFile, JSON.stringify({ data: f.taviData, at: new Date().toISOString(), subscriptions: { anthropic: true, "openai-codex": false } }))],
  ["wrong data", f => writeFileSync(f.signedFile, JSON.stringify({ data: "elsewhere", at: new Date().toISOString(), subscriptions: { anthropic: true, "openai-codex": true } }))],
  ["old tag", f => { const git = f.ops.git; f.ops.git = async (...args: string[]) => args.join(" ") === "tag --list pre-tavi" ? "pre-tavi" : git(...args); }],
  ["saved record", f => writeFileSync(recordFile(f.options), "{}")],
];
for (const [label, change] of refusals) {
  const f = fixture(); change(f); const hashes = fileHashes(f.folder);
  await assert.rejects(switchTavi(f.options, f.ops, f.print), Error, label);
  assert.deepEqual(fileHashes(f.folder), hashes, `${label} changes no file`);
  assert.equal(f.calls.includes("stop"), false);
}

for (const failure of ["git tag pre-tavi", "backup", "stop", "carry", "git merge --ff-only new-code", "build", "autostart true", "start true", "verify true", ""]) {
  const f = fixture(), oldData = fileHashes(path.join(f.live, "data"));
  f.fail(failure);
  if (failure) await assert.rejects(switchTavi(f.options, f.ops, f.print), /Stopped at step/);
  else {
    await switchTavi(f.options, f.ops, f.print);
    assert.deepEqual(f.state(), { head: "new-code", tag: "old-code", mode: "Tavi", running: "Tavi" });
    assert.ok(f.output.some(line => line.includes("Switch record:")));
    assert.ok(f.output.some(line => line.includes("tavi-rollback.mjs")));
    assert.ok(f.calls.indexOf("carry") < f.calls.indexOf("git merge --ff-only new-code"));
    assert.ok(f.calls.indexOf("stop") < f.calls.indexOf("carry"));
  }
  const beforeRollback = fileHashes(f.folder);
  f.fail("");
  await rollbackTavi({ ...f.options, yes: false }, f.ops, f.print);
  assert.deepEqual(fileHashes(f.folder), beforeRollback, "Rollback dry run changes no file.");
  await rollbackTavi(f.options, f.ops, f.print);
  assert.equal(f.state().head, "old-code"); assert.equal(f.state().running, "v2"); assert.equal(f.state().mode, "v2");
  assert.deepEqual(fileHashes(path.join(f.live, "data")), oldData, "v2 data remains exactly as it was.");
  assert.equal(readFileSync(path.join(f.taviData, "team.txt"), "utf8"), "Keep this practice team.");
  if (existsSync(path.join(f.taviData, "carried.txt"))) assert.equal(readFileSync(path.join(f.taviData, "carried.txt"), "utf8"), "New made-up copy.");
  await rollbackTavi(f.options, f.ops, f.print);
  assert.equal(f.state().running, "v2", "Repeating rollback is safe.");
}

const absent = fixture();
assert.equal(await rollbackMain(["--live", absent.live, "--tavi-data", absent.taviData, "--port", "4321"], absent.ops, absent.print), 2);
const retry = fixture(); await switchTavi(retry.options, retry.ops, retry.print);
retry.fail("verify false"); await assert.rejects(rollbackTavi(retry.options, retry.ops, retry.print), /run this same rollback again/);
retry.fail(""); await rollbackTavi(retry.options, retry.ops, retry.print); assert.equal(retry.state().head, "old-code");
await assert.rejects(rollbackTavi({ ...retry.options, port: 5555 }, retry.ops, retry.print), /do not match/);

const live = "C:/Made Up/Live";
const rows = [
  { ProcessId: 1, ParentProcessId: 0, CommandLine: `node "${live}/scripts/supervise.mjs"` },
  { ProcessId: 2, ParentProcessId: 1, CommandLine: "node src/gateway/server.ts" },
  { ProcessId: 3, ParentProcessId: 0, CommandLine: "another program" },
];
const connections = [{ LocalPort: 4321, State: "Listen", OwningProcess: 2 }];
assert.deepEqual(processIds(rows, connections, live, 4321), [1]);
assert.throws(() => processIds(rows, [{ ...connections[0], OwningProcess: 3 }], live, 4321), /another program/);
assert.deepEqual(processIds([
  { ProcessId: 1, ParentProcessId: 0, CommandLine: "node scripts/supervise.mjs" },
  { ProcessId: 2, ParentProcessId: 1, CommandLine: `node "${live}/node_modules/tsx/dist/cli.mjs" src/gateway/server.ts` },
], connections, live, 4321), [1], "The old supervisor's relative command is found through its own server.");

let requests: { route: string; body: unknown }[] = [];
const fakeFetch = async (url: string, init: RequestInit) => {
  const route = new URL(url).pathname, body = init.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ route, body });
  const values: Record<string, unknown> = {
    "/api/health": { ok: true }, "/": "Phone", "/desktop": "Desktop", "/api/hq/safety": { level: "open" },
    "/api/hq/state": { on: true, guard: "up", toolbox: "up", bots: [{ id: "lead", lead: true }] },
    "/api/hq/bots/lead/engine": { status: "ready" }, "/api/hq/bots/lead/messages": { job_id: "test-job" },
    "/api/hq/bots/lead/rows": { rows: [{ kind: "message", body: { kind: "message", from: "bot", text: "Hello from a fake bot.", streaming: false } }] },
  };
  if (route.endsWith("/rows")) assert.equal(new URL(url).searchParams.get("job"), "test-job");
  return new Response(typeof values[route] === "string" ? values[route] as string : JSON.stringify(values[route]));
};
await verifyRunning(4321, true, fakeFetch, async () => {}, 1000);
assert.deepEqual(requests.find(r => r.route.endsWith("/messages"))?.body, { text: "Say hello in five words.", test: true });
requests = []; await verifyRunning(4321, false, fakeFetch, async () => {}, 1000);
assert.equal(requests.some(r => r.route.startsWith("/api/hq")), false);
const badFetch = async (url: string, init: RequestInit) => url.includes("/rows") ? new Response(JSON.stringify({ rows: [{ body: { kind: "notice", tone: "warn", text: "Not signed in." } }] })) : fakeFetch(url, init);
await assert.rejects(verifyRunning(4321, true, badFetch, async () => {}, 1000), /test message failed/);

// Exercise the real command choices with fake programs. No Windows setting is changed.
const commands: { program: string; args: string[]; options: { cwd: string; env: Record<string, string> } }[] = [];
const commandFixture = fixture();
const concrete = systemOperations(commandFixture.options, {
  platform: "win32", free: async () => true, stopSupervisor: async () => false,
  execute: async (program: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
    commands.push({ program, args, options });
    if (program === "powershell.exe" && args.includes("-EncodedCommand")) return { stdout: JSON.stringify({ rows: rows.map(row => row.ProcessId === 1 ? { ...row, CommandLine: `node "${commandFixture.live}/scripts/supervise.mjs"` } : row), ports: connections }) };
    return { stdout: "" };
  },
  spawn: (program: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
    commands.push({ program, args, options });
    const child = Object.assign(new EventEmitter(), { unref: () => {} }); queueMicrotask(() => child.emit("spawn")); return child;
  },
});
await concrete.stop(); await concrete.carry(); await concrete.build(); await concrete.autostart(true); await concrete.autostart(false); await concrete.start(true); await concrete.start(false);
assert.deepEqual(commands.filter(c => c.program === "taskkill.exe").map(c => c.args), [["/PID", "1", "/T", "/F"]]);
assert.ok(commands.find(c => c.args.includes("--from"))?.args.includes(path.join(commandFixture.live, "data")));
const startup = commands.filter(c => c.args.includes("-Install"));
assert.equal(startup.length, 2); assert.ok(startup.every(c => c.args.includes(commandFixture.live)));
assert.equal(startup[0].args.includes("-Classic"), false); assert.equal(startup[1].args.includes("-Classic"), true);
const launches = commands.filter(c => c.program === "wscript.exe");
assert.equal(launches[0].options.env.LH_V3, "1"); assert.equal(launches[1].options.env.LH_V3, "0");
assert.equal(launches[1].options.env.LH_DATA_DIR, path.join(commandFixture.live, "data"));
assert.equal(commands.some(c => c.program === "npm" || c.args.includes("ci")), false);
console.log("Tavi switch and rollback: dry runs, refusals, every failed step, recovery, records and the test answer passed.");
