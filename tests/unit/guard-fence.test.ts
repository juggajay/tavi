import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { screenPorts, fenceInput, fenceRules } from "../../src/guard/fence.js";
import { Guard } from "../../src/guard/guard.js";
import { scripts, type Runner } from "../../src/guard/runner.js";

const ports = (n: number) => screenPorts(`bot-test-${n}`, { display: n, vncPort: 5910 + n, cdpPort: 9210 + n });
for (const count of [1, 2, 5]) {
  const bots = Array.from({ length: count }, (_, n) => ports(n + 1));
  const rules = fenceRules(bots);
  assert.equal(rules.length, 9 + 2 * count);
  assert.equal(rules.filter((r) => r.includes("-j REJECT")).length, 8);
  for (const b of bots) {
    assert(rules.includes(`-A LHFENCE -o lo -p tcp -m owner --uid-owner ${b.user} --dport ${b.vncPort} -j RETURN`));
    assert(!rules.some((r) => r.includes(`--uid-owner ${b.user}`) && r.includes(String(b.cdpPort))));
  }
  assert.equal(fenceInput(bots).trim().split("\n").length, count);
}
for (const value of [0, 100, 1.5, "1", null]) assert.throws(() => screenPorts("bot-a", { display: value, vncPort: 5911, cdpPort: 9211 }));
assert.throws(() => screenPorts("lh-team", { display: 1, vncPort: 5911, cdpPort: 9211 }));
assert.throws(() => screenPorts("bot-a", { display: 1, vncPort: 5912, cdpPort: 9211 }));
assert.throws(() => screenPorts("bot-a", { display: 1, vncPort: 5911, cdpPort: 9211, width: 99999 }));
const shell = readFileSync("box/fence.sh", "utf8");
assert(shell.includes("ip6tables-restore")); assert(shell.includes("--noflush"));
assert(shell.includes("-I OUTPUT 1 -j LHFENCE"));
for (const range of ["2222", "5910:6009", "8650:8749", "9210:9309"]) assert(shell.includes(range));

const calls: string[] = [];
let fail = false;
const runner: Runner = {
  async run(_u, script) { calls.push(script); return { code: fail && script === scripts.fence ? 1 : 0, out: script === scripts.probe ? "ok safe\n" : "", err: "" }; },
  spawn() { return { pid: 1, write() {}, kill() {}, exited: new Promise(() => {}) }; },
  async terminate() {}, async spaceState() { return "stopped"; },
};
const guard = new Guard(runner, { data: path.join(TEST_DIR, "fence") });
await guard.init();
await guard.setPorts("bot-test-1", ports(1));
assert.equal(guard.fenceState("bot-test-1").applied, true);
assert(calls.indexOf(scripts.fence) < calls.indexOf(scripts.screenProbe));
await assert.rejects(guard.setPorts("bot-test-2", ports(1)));
fail = true;
await assert.rejects(guard.setPorts("bot-test-2", ports(2)));
assert.equal(guard.fenceState("bot-test-1").applied, false);
assert.equal(guard.saved.level, "walled");
await guard.close();
guard.store.save("screen-ports.json", { damaged: true });
for (const level of ["killed", "paused"] as const) {
  guard.store.save("state.json", { level, since: new Date().toISOString(), until: level === "paused" ? new Date(Date.now() + 60000).toISOString() : null,
    cameFrom: level === "paused" ? "open" : null, reason: "Test", by: "test" });
  const reopened = new Guard(runner, { data: path.join(TEST_DIR, "fence") });
  assert.equal(reopened.saved.level, level === "killed" ? "killed" : "walled");
  assert.equal(reopened.saved.until, null); assert.equal(reopened.saved.cameFrom, null);
}

const processCalls: { name: string; args: string[] }[] = [];
const savedSecrets = new Map<string, string>();
const exits: (() => void)[] = [];
const later: (() => void)[] = [];
const processRunner: Runner = {
  ...runner,
  async run(_user, script, opts) {
    processCalls.push({ name: Object.entries(scripts).find(([, value]) => value === script)?.[0] ?? "unknown", args: opts?.args ?? [] });
    return { code: 0, out: script === scripts.probe ? "ok safe\n" : "", err: "" };
  },
  spawn(_user, script, _line, args) {
    processCalls.push({ name: Object.entries(scripts).find(([, value]) => value === script)?.[0] ?? "unknown", args: args ?? [] });
    let end!: (code: number) => void;
    const exited = new Promise<number>((r) => { end = r; }); exits.push(() => end(1));
    return { pid: exits.length, write() {}, kill() { end(0); }, exited };
  },
};
const second = new Guard(processRunner, { data: path.join(TEST_DIR, "processes"),
  clock: { now: Date.now, later(fn) { later.push(fn); return () => {}; } },
  secrets: { get: (key) => savedSecrets.get(key), put: (key, value) => { savedSecrets.set(key, value); } },
});
await second.init(); await second.setPorts("bot-test-1", ports(1));
await assert.rejects(second.startProcess("bot-test-1", "browser"));
await second.prepareScreen("bot-test-1", { wallpaper: "picture", home: "page" });
assert.equal(savedSecrets.get("bot:test-1:vnc")?.length, 8);
const password = savedSecrets.get("bot:test-1:vnc")!;
await second.prepareScreen("bot-test-1", { wallpaper: "picture", home: "page" });
assert.equal(savedSecrets.get("bot:test-1:vnc"), password);
assert.equal(second.store.clean(password), "[hidden]");
await second.startProcess("bot-test-1", "screen");
await second.startProcess("bot-test-1", "browser");
await second.startProcess("lh-team", "gateway");
assert.deepEqual(processCalls.find((c) => c.name === "screen")?.args, ["1", "5911", "1440", "900"]);
assert.deepEqual(processCalls.find((c) => c.name === "browser")?.args, ["1", "9211"]);
await assert.rejects(second.startProcess("bot-test-1", "gateway"));
await assert.rejects(second.startProcess("lh-team", "screen"));
assert(processCalls.findIndex((c) => c.name === "screen") < processCalls.findIndex((c) => c.name === "browser"));
assert(processCalls.findIndex((c) => c.name === "browser") < processCalls.findIndex((c) => c.name === "gateway"));
// A browser that exits is started again while its screen stays up.
exits[1](); await new Promise<void>((r) => setImmediate(r));
later[later.length - 1]();
for (let n = 0; n < 25; n++) await new Promise<void>((r) => setImmediate(r));
assert.equal(processCalls.filter((c) => c.name === "browser").length, 2);
await second.changeLevel({ level: "paused" }, "local");
await assert.rejects(second.startProcess("bot-test-1", "screen"));
assert.equal(second.fenceState("bot-test-1").applied, false);
await second.changeLevel({ level: "open" }, "local");
processCalls.length = 0;
await second.dropPorts("bot-test-1");
assert.equal(second.ports.size, 0);
assert(processCalls.findIndex((c) => c.name === "stopBrowser") < processCalls.findIndex((c) => c.name === "stopScreen"));
assert(processCalls.some((c) => c.name === "fence"));
assert.equal(second.fenceState("bot-test-1").applied, false);
await second.close();
console.log("guard fences: ok");
