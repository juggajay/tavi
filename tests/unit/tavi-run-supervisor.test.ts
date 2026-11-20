import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
// These commands are plain JavaScript so Windows can run them without a build.
// @ts-expect-error The command has no separate type file.
import { supervise, stopSupervisor, rotatingLog, freePort, settings, safeOutput } from "../../scripts/tavi-supervise.mjs";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!test()) { assert.ok(Date.now() < end, "The fake program finished in time."); await wait(10); }
}
const root = path.join(TEST_DIR, "supervisor"); mkdirSync(root);
const config = { folder: root, port: 4567, host: "127.0.0.1", env: {} };
const children: ChildProcess[] = [];
let launches: { name: string; time: number; child: ChildProcess }[] = [];
function launch(name: string) {
  const child = spawn(process.execPath, ["-e", "console.log('Fake program started.'); setInterval(()=>{},1000)"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); launches.push({ name, time: Date.now(), child }); return child;
}
const stopped: string[] = [];
let allowReady = false;
const run = supervise({ root, config, free: async () => true, launch, guardDelay: 100, serverDelay: 60, poll: 5, stable: 10000,
  ready: async () => { if (!allowReady) throw new Error("Still starting."); }, stopSpace: async () => { stopped.push("space"); } });
try {
  await until(() => launches.length > 0); await wait(60);
  await assert.rejects(supervise({ root, config, free: async () => true }), /keeper record/);
  assert.deepEqual(launches.map(v => v.name), ["guard"], "The app waits until the guard answers.");
  allowReady = true; await until(() => launches.some(v => v.name === "server"));
  const first = launches.find(v => v.name === "server")!;
  first.child.kill();
  await until(() => launches.filter(v => v.name === "server").length === 2);
  const second = launches.filter(v => v.name === "server")[1];
  assert.ok(second.time - first.time >= 60);
  second.child.kill();
  await until(() => launches.filter(v => v.name === "server").length === 3);
  const third = launches.filter(v => v.name === "server")[2];
  assert.ok(third.time - second.time >= 120, "Repeated app failures increase the wait.");
  launches[0].child.kill();
  await until(() => third.child.exitCode !== null || third.child.signalCode !== null);
  await until(() => readFileSync(path.join(root, "logs", "tavi-status.json"), "utf8").includes("will not stay up"));
  assert.match(readFileSync(path.join(root, "logs", "supervisor.log"), "utf8"), /Tavi has been stopped too/);
  await until(() => launches.filter(v => v.name === "guard").length === 2);
  const guards = launches.filter(v => v.name === "guard");
  assert.ok(guards[1].time - guards[0].time >= 100);
  await until(() => launches.filter(v => v.name === "server").length === 4);
  await stopSupervisor(root); await run;
  assert.deepEqual(stopped, ["space"], "Windows shutdown asks the guard to stop Linux before ending it.");
  assert.ok(children.every(c => c.exitCode !== null || c.signalCode !== null));
  assert.equal(existsSync(path.join(root, "tavi-run.json")), false);
} finally {
  if (existsSync(path.join(root, "tavi-run.json"))) await stopSupervisor(root);
  await run;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
}

const failedRoot = path.join(TEST_DIR, "failing-guard"); mkdirSync(failedRoot);
launches = [];
const failed = supervise({ config: { ...config, folder: failedRoot }, free: async () => true, guardDelay: 80, poll: 5, ready: async () => { throw new Error(); },
  launch(name: string) {
    assert.equal(name, "guard");
    const child = spawn(process.execPath, ["-e", "process.exit(1)"], { windowsHide: true });
    launches.push({ name, time: Date.now(), child }); return child;
  }, stopSpace: async () => {} });
try {
  await until(() => launches.length === 3);
  assert.ok(launches[1].time - launches[0].time >= 80);
  assert.ok(launches[2].time - launches[1].time >= 80);
} finally { await stopSupervisor(failedRoot); await failed; }

const logFile = path.join(TEST_DIR, "rotate", "test.log");
const log = rotatingLog(logFile, 100);
log("a".repeat(90)); log("b".repeat(35));
assert.equal(readFileSync(logFile + ".1", "utf8"), "a".repeat(90) + "b".repeat(10));
assert.equal(readFileSync(logFile, "utf8"), "b".repeat(25));
rotatingLog(logFile, 100)("c");
assert.equal(readFileSync(logFile, "utf8"), "b".repeat(25) + "c", "A new start appends to the log.");

const listener = net.createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
try {
  const port = (listener.address() as net.AddressInfo).port;
  assert.equal(await freePort(port), false);
  const untouched = path.join(TEST_DIR, "taken-port");
  await assert.rejects(supervise({ config: { ...config, folder: untouched, port }, launch: () => { throw new Error("Must not launch."); } }), /already taken/);
  assert.equal(existsSync(untouched), false);
} finally { await new Promise<void>(resolve => listener.close(() => resolve())); }

const fakeRead = (file: string) => {
  if (file.endsWith("tavi-launch.json")) return JSON.stringify({ data: root, port: 4321 });
  const missing = Object.assign(new Error(), { code: "ENOENT" }); throw missing;
};
const saved = settings({}, root, fakeRead);
assert.equal(saved.port, 4321); assert.equal(saved.env.LH_V3, "1");
assert.equal(saved.env.LH_DATA_DIR, saved.env.LH_V3_DATA);
assert.throws(() => settings({ LH_DATA_DIR: root, LH_V3_DATA: failedRoot }, root, fakeRead), /same data folder/);
const plainDefaults = settings({}, root, () => { throw Object.assign(new Error(), { code: "ENOENT" }); });
assert.equal(plainDefaults.port, 3077); assert.equal(plainDefaults.host, "127.0.0.1");
assert.equal(plainDefaults.folder, path.join(root, 'data'));
let cleaned = "";
const output = safeOutput((line: string) => { cleaned += line; }, { OPENAI_API_KEY: "a-made-up-private-key" });
output("a-made-up-"); output("private-key\nA readable line.\n"); output.end();
assert.equal(cleaned, "[hidden]\nA readable line.\n");
console.log("Tavi supervisor: order, restarts, waits, failed guard, clean stop, logs and taken ports passed.");
