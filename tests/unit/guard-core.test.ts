import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request } from "node:http";

process.env.LH_V3_DATA = path.join(TEST_DIR, "guard-data");
const { Guard } = await import("../../src/guard/guard.js");
const { scripts, distroName, GuardError } = await import("../../src/guard/runner.js");
const { scrub } = await import("../../src/guard/store.js");
const { createGuardServer } = await import("../../src/guard/http.js");
import type { Clock } from "../../src/guard/guard.js";
import type { Runner, Handle, Result } from "../../src/guard/runner.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
class Time implements Clock {
  time = Date.parse("2026-11-18T00:00:00Z");
  tasks: { at: number; fn: () => void; active: boolean }[] = [];
  now = () => this.time;
  later = (fn: () => void, ms: number) => { const task = { at: this.time + ms, fn, active: true }; this.tasks.push(task); return () => { task.active = false; }; };
  async advance(ms: number) {
    this.time += ms;
    for (const task of [...this.tasks]) if (task.active && task.at <= this.time) { task.active = false; task.fn(); }
    for (let i = 0; i < 12; i++) await flush();
  }
}
class Fake implements Runner {
  calls: string[] = [];
  callsFull: { user: string; script: string; opts?: { args?: string[]; stdin?: string } }[] = [];
  state: "running" | "stopped" | "missing" = "stopped";
  fail = new Set<string>();
  badProbe = false;
  ubuntu = false;
  hold?: (script: string) => Promise<void>;
  nextPid = 100;
  handles: (Handle & { emit(line: string, stream?: "out" | "err"): void; finish(code?: number): void; inputs: string[]; killed: boolean })[] = [];
  label(script: string, args?: string[]) { return `${Object.entries(scripts).find(([, text]) => text === script)?.[0] ?? "unknown"}${args?.length ? ":" + args.join(",") : ""}`; }
  async run(user: string, script: string, opts?: { args?: string[]; stdin?: string }): Promise<Result> {
    const name = this.label(script, opts?.args); this.calls.push(name); this.callsFull.push({ user, script, opts });
    if (this.hold) await this.hold(script);
    this.state = "running";
    if (this.fail.has(name)) throw new Error("Private failure details must never be logged.");
    if (script === scripts.probe) return { code: this.badProbe ? 1 : 0, out: this.badProbe ? "ok    not root\nFAIL  Windows drive visible\n" : "ok    not root\nok    drives hidden\n", err: "" };
    if (script === scripts.make) return { code: 0, out: `/home/${opts?.args?.[0]}/hermes\n`, err: "" };
    if (script === scripts.users) return { code: 0, out: "bot-a\nlh-team\n", err: "" };
    if (script === scripts.evidence) return { code: 0, out: Buffer.from("kept logs").toString("base64"), err: "" };
    if (script === scripts.read) return { code: 0, out: "saved words", err: "" };
    return { code: 0, out: "", err: "" };
  }
  spawn(user: string, script: string, onLine: (line: string, stream: "out" | "err") => void, args?: string[]) {
    this.calls.push(`spawn:${this.label(script, args)}`);
    let end!: (code: number) => void;
    const handle = { pid: this.nextPid++, inputs: [] as string[], killed: false, exited: new Promise<number>((resolve) => { end = resolve; }),
      write(text: string) { this.inputs.push(text); }, kill() { this.killed = true; end(0); }, emit(line: string, stream: "out" | "err" = "out") { onLine(line, stream); }, finish(code = 1) { end(code); } };
    this.handles.push(handle); return handle;
  }
  async terminate() { this.calls.push("terminate"); if (this.fail.has("terminate")) throw new Error("Private failure"); this.state = "stopped"; }
  async spaceState() { return this.state; }
  async ownerUbuntuRunning() { return this.ubuntu; }
}
let number = 0;
function build() {
  const data = path.join(TEST_DIR, `guard-${number++}`); mkdirSync(data);
  const fake = new Fake(), time = new Time();
  const guard = new Guard(fake, { data, clock: time });
  return { guard, fake, time, data };
}
async function refused(work: Promise<unknown>, status: number) {
  await assert.rejects(work, (error: unknown) => error instanceof GuardError && error.status === status);
}
const level = (name: string) => ({ level: name, reason: "Owner used the switch", by: "owner" });

// First start leaves WSL stopped. Each level performs the promised steps in order.
{
  const { guard, fake } = build();
  await guard.init(); assert.equal(guard.saved.level, "open"); assert.equal(fake.state, "stopped");
  fake.calls.length = 0;
  await guard.changeLevel(level("paused"), "relay"); assert.deepEqual(fake.calls, ["freeze:stop", "route:close"]);
  fake.calls.length = 0;
  await guard.changeLevel(level("open"), "local"); assert.deepEqual(fake.calls, ["freeze:continue", "route:open"]);
  fake.calls.length = 0;
  await guard.changeLevel(level("walled"), "relay"); assert.deepEqual(fake.calls, ["stopAll", "route:close", "terminate"]);
  fake.calls.length = 0;
  await guard.changeLevel(level("killed"), "relay");
  assert.deepEqual(fake.calls, ["route:close", "freeze:stop", "users", "evidence:bot-a", "evidence:lh-team", "withdraw", "stopAll", "terminate"]);
  await guard.close();
}
// No WSL failure may prevent the later steps, including withdrawal and termination.
{
  const { guard, fake } = build(); fake.fail.add("terminate"); await guard.init();
  assert.equal(guard.saved.level, "walled"); assert.ok(fake.calls.includes("stopAll")); await guard.close();
}
for (const name of ["paused", "walled", "killed"]) {
  const { guard, fake } = build(); await guard.init(); fake.calls.length = 0;
  fake.fail = new Set(["freeze:stop", "route:close", "stopAll", "users", "withdraw", "terminate"]);
  await guard.changeLevel(level(name), "relay");
  assert.equal(guard.saved.level, name);
  assert.ok(fake.calls.includes("route:close"));
  if (name !== "paused") assert.equal(fake.calls.at(-1), "terminate");
  if (name === "killed") {
    assert.ok(fake.calls.includes("withdraw"));
    const audit = guard.store.tail("audit.jsonl", 100).join("\n");
    assert.ok(audit.includes("sign-ins were NOT withdrawn"));
    assert.ok(!audit.includes("Private failure"));
  }
  await guard.close();
}
// PIN checks, persistent lock-out, and the stronger rule after killed.
{
  const { guard, fake, time, data } = build(); await guard.init();
  await refused(guard.setPin("4729", undefined, "relay"), 403);
  await guard.setPin("4729", undefined, "local");
  const pinText = readFileSync(path.join(guard.store.dir, "pin.json"), "utf8"); assert.ok(!pinText.includes("4729"));
  await guard.changeLevel(level("paused"), "relay");
  for (let i = 0; i < 5; i++) await refused(guard.changeLevel({ ...level("open"), pin: i ? "9999" : undefined }, "local"), i === 4 ? 429 : 403);
  await refused(guard.changeLevel({ ...level("open"), pin: "4729" }, "local"), 429);
  const reopened = new Guard(fake, { data, clock: time }); assert.equal(reopened.store.lockedUntil, guard.store.lockedUntil);
  await guard.changeLevel(level("killed"), "relay");
  await refused(guard.changeLevel({ ...level("open"), pin: "4729" }, "relay"), 403);
  await time.advance(600000);
  await guard.changeLevel({ ...level("open"), pin: "4729" }, "local");
  await guard.changeLevel(level("paused"), "relay");
  await guard.changeLevel({ ...level("open"), pin: "4729" }, "relay");
  await refused(guard.setPin("1234", "8888", "local"), 403);
  await guard.setPin("1234", "4729", "local"); await guard.close();
}
{
  const { guard } = build(); await guard.init(); await guard.changeLevel(level("paused"), "relay");
  await refused(guard.changeLevel(level("open"), "relay"), 403);
  await guard.changeLevel(level("open"), "local"); await guard.close();
}
// Timed raises remember their prior level, survive a restart, and cannot lift killed.
{
  const { guard, time, fake, data } = build(); await guard.init();
  await guard.setPin("3851", undefined, "local");
  await guard.changeLevel({ ...level("paused"), minutes: 1 }, "relay");
  await time.advance(60000); assert.equal(guard.saved.level, "open");
  await guard.changeLevel(level("paused"), "relay");
  await guard.changeLevel({ ...level("walled"), minutes: 1 }, "relay");
  await time.advance(60000); assert.equal(guard.saved.level, "paused");
  await guard.changeLevel({ ...level("open"), pin: "3851" }, "local");
  await guard.changeLevel({ ...level("walled"), minutes: 2 }, "relay");
  const restartTime = new Time(); restartTime.time = time.now();
  const restarted = new Guard(fake, { data, clock: restartTime }); await restarted.init();
  await restartTime.advance(120000); assert.equal(restarted.saved.level, "open");
  await restarted.changeLevel(level("killed"), "local"); await restartTime.advance(100000000);
  assert.equal(restarted.saved.level, "killed");
  await refused(restarted.changeLevel({ ...level("killed"), minutes: 1 }, "local"), 400);
  await restarted.close(); await guard.close();
}
// Damaged state fails closed; saved killed re-runs evidence, withdrawal, and shutdown.
for (const saved of ["{broken", JSON.stringify({ level: "open" }), JSON.stringify({ level: "killed", since: "2026-11-18T00:00:00Z", until: null, cameFrom: null, reason: "Used switch", by: "local" })]) {
  const { data, fake, time } = build();
  writeFileSync(path.join(data, "guard", "state.json"), saved);
  const guard = new Guard(fake, { data, clock: time }); await guard.init();
  assert.equal(guard.saved.level, saved.includes("killed") ? "killed" : "walled");
  assert.ok(fake.calls.includes("terminate"));
  if (guard.saved.level === "killed") assert.ok(fake.calls.includes("withdraw"));
  else assert.match(guard.saved.reason, /damaged/);
  await guard.close();
}
// No caller can choose shell text, arbitrary users, or private file names.
{
  const { guard, fake } = build(); await guard.init(); fake.calls.length = 0;
  for (const user of ["UPPER", "bot-a;rm", "../x", "a/b", "default", "root", "", "bot-" + "a".repeat(33)]) {
    await refused(guard.makeBot(user), 400); await refused(guard.startProcess(user, "gateway"), 400);
  }
  for (const name of ["../x", "auth.json", "folder/SOUL.md", "x.env"]) {
    await refused(guard.writeBotFile("bot-a", name, "words"), 400); await refused(guard.readBotFile("bot-a", name), 400);
  }
  await refused(guard.readBotFile("bot-a", ".env"), 400);
  await refused(guard.writeBotFile("bot-a", "SOUL.md", "a".repeat(256 * 1024 + 1)), 400);
  await refused(guard.startProcess("lh-team", "toString"), 400);
  assert.deepEqual(fake.calls, []);
  assert.throws(() => distroName("Ubuntu")); assert.throws(() => distroName("another-space")); assert.equal(distroName("lh-bots"), "lh-bots");
  assert.equal(distroName("tavi-bots"), "tavi-bots"); for (const bad of ["ubuntu", "Tavi-bots", "tavi-", "tavi-bots ", "tavi-bots;x", "tavi--", "lh-bots2", "tavi-" + "a".repeat(40)]) assert.throws(() => distroName(bad));
  await guard.makeBot("bot-a");
  assert.deepEqual(fake.callsFull.at(-1)?.opts?.args, ["bot-a"]); assert.equal(fake.callsFull.at(-1)?.script, scripts.makeProfile);
  for (const name of ["config.yaml", ".env", "SOUL.md"]) await guard.writeBotFile("bot-a", name, "file words\n");
  assert.equal(fake.callsFull.at(-1)?.opts?.stdin, "file words\n");
  assert.equal(fake.callsFull.at(-1)?.user, "lh-team");
  assert.deepEqual(fake.callsFull.at(-1)?.opts?.args, ["bot-a", "SOUL.md"]);
  const from = fake.callsFull.length;
  await guard.writeBotFile("missing", "SOUL.md", "New words");
  assert.deepEqual(fake.callsFull.slice(from).map((c) => c.script), [scripts.makeTeam, scripts.makeProfile, scripts.write]);
  assert.deepEqual(fake.callsFull[from + 1].opts?.args, ["missing"]);
  for (const name of ["auth.json", "SOUL.md", "../config.yaml"]) await refused(guard.writeTeamFile(name, "words"), 400);
  await guard.writeTeamFile("config.yaml", "Team settings");
  assert.equal(fake.callsFull.at(-1)?.user, "lh-team");
  assert.deepEqual(fake.callsFull.at(-1)?.opts?.args, ["", "config.yaml"]);
  assert.equal((await guard.readBotFile("bot-a", "SOUL.md")).content, "saved words");
  await guard.close();
}
// A subscription can have one sign-in window. Other subscriptions have their own window.
{
  const { guard, fake } = build(); await guard.init();
  const first = guard.signIn("anthropic");
  await refused(guard.signIn("anthropic"), 409);
  const { session } = await first;
  const second = await guard.signIn("openai-codex");
  assert.equal(guard.session(session).user, "lh-team");
  assert.equal(guard.session(second.session).user, "lh-team");
  await guard.signOut("anthropic");
  assert.equal(guard.session(session).ended, true);
  assert.equal(guard.session(second.session).ended, false);
  assert.equal(fake.callsFull.at(-1)?.script, scripts.signOut);
  assert.deepEqual(fake.callsFull.at(-1)?.opts?.args, ["anthropic"]);
  assert.equal(fake.callsFull.at(-1)?.user, "lh-team");
  const calls = fake.calls.length;
  for (const provider of ["../x", "anthropic;echo", "openai-api", undefined]) {
    await refused(guard.signIn(provider), 400); await refused(guard.signOut(provider), 400);
  }
  assert.equal(fake.calls.length, calls);
  await guard.close();
}
// A failed probe walls off; non-open levels refuse any new work before touching WSL.
{
  const { guard, fake } = build(); await guard.init(); fake.badProbe = true;
  await refused(guard.startProcess("lh-team", "gateway"), 409);
  assert.equal(guard.saved.level, "walled"); assert.equal(guard.ready, false); assert.equal(fake.handles.length, 0);
  assert.deepEqual(guard.probeResult.failed, ["FAIL  Windows drive visible"]);
  fake.calls.length = 0;
  await refused(guard.startProcess("lh-team", "gateway"), 409); await refused(guard.startSpace(), 409);
  await refused(guard.makeBot("bot-a"), 409); await refused(guard.writeBotFile("bot-a", "SOUL.md", "word"), 409);
  assert.deepEqual(fake.calls, []); await guard.close();
}
{
  const { guard, fake } = build(); await guard.init(); fake.fail.add("boot");
  await refused(guard.startSpace(), 409); assert.equal(guard.saved.level, "walled"); await guard.close();
}
// Restart waits grow, then stop. Explicit stop cancels a queued restart.
{
  const { guard, fake, time } = build(); await guard.init();
  await guard.startProcess("lh-team", "gateway");
  await guard.startProcess("lh-team", "gateway"); assert.equal(fake.handles.length, 1);
  for (const delay of [2000, 5000, 15000, 60000]) {
    fake.handles.at(-1)!.finish(); await flush();
    const before: number = fake.handles.length;
    await time.advance(delay - 1); assert.equal(fake.handles.length, before);
    await time.advance(1); assert.equal(fake.handles.length, before + 1);
  }
  fake.handles.at(-1)!.finish(); await flush();
  assert.equal((await guard.state()).bots.find((b) => b.user === "lh-team")?.procs[0].state, "failed");
  assert.equal(fake.handles.length, 5);
  await time.advance(100000); assert.equal(fake.handles.length, 5);
  await guard.startProcess("lh-team", "gateway"); fake.handles.at(-1)!.finish(); await flush();
  await guard.stopProcess("lh-team", "gateway"); const before = fake.handles.length;
  await time.advance(60000); assert.equal(fake.handles.length, before);
  assert.ok(fake.calls.includes("stop:lh-team")); await guard.close();
}
// Safety raises do not wait for a slow probe, and a late result cannot start a bot.
{
  const { guard, fake } = build(); await guard.init();
  let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
  fake.hold = async (script) => { if (script === scripts.probe) await waiting; };
  const start = guard.startProcess("lh-team", "gateway"); const handled = start.catch((error: unknown) => error);
  for (let i = 0; i < 8; i++) await flush();
  await guard.changeLevel(level("killed"), "relay"); assert.equal(guard.saved.level, "killed");
  release(); assert.ok(await handled instanceof GuardError); assert.equal(fake.handles.length, 0);
  await guard.close();
}
// A late toolbox opening cannot undo a higher safety level.
{
  const { guard, fake } = build(); await guard.init();
  await guard.changeLevel(level("paused"), "relay");
  let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
  fake.hold = async (script) => { if (script === scripts.route && guard.saved.level === "open") await waiting; };
  const opening = guard.changeLevel(level("open"), "local");
  for (let i = 0; i < 8; i++) await flush();
  await guard.changeLevel(level("walled"), "relay"); release(); await opening;
  assert.equal(guard.saved.level, "walled"); assert.equal(fake.state, "stopped"); assert.equal(fake.calls.at(-1), "terminate");
  await guard.close();
}
// A stop requested while the probe is waiting cancels that process start.
{
  const { guard, fake } = build(); await guard.init();
  let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
  fake.hold = async (script) => { if (script === scripts.probe) await waiting; };
  const starting = guard.startProcess("lh-team", "gateway").catch((error: unknown) => error);
  for (let i = 0; i < 8; i++) await flush();
  await guard.stopProcess("lh-team", "gateway"); release();
  assert.ok(await starting instanceof GuardError); assert.equal(fake.handles.length, 0);
  fake.hold = undefined; fake.fail.add("stop:lh-team"); await refused(guard.stopProcess("lh-team", "gateway"), 503);
  await guard.close();
}
// A damaged PIN cannot silently become a guard with no PIN.
{
  const { data, fake, time } = build(); writeFileSync(path.join(data, "guard", "pin.json"), "null");
  const guard = new Guard(fake, { data, clock: time }); await guard.init(); assert.equal(guard.saved.level, "walled");
  await refused(guard.changeLevel(level("open"), "local"), 403); await guard.close();
}
// Pausing keeps a sign-in in place; it still ends at the fifteen minute limit.
{
  const { guard, fake, time } = build(); await guard.init();
  const { session } = await guard.signIn("openai-codex"); const handle = fake.handles.at(-1)!;
  await guard.changeLevel(level("paused"), "relay"); assert.equal(handle.killed, false); assert.equal(guard.session(session).ended, false);
  await guard.changeLevel(level("open"), "local"); guard.signInInput(session, "owner line");
  await time.advance(15 * 60_000); assert.equal(handle.killed, true); assert.equal(guard.session(session).ended, true);
  await time.advance(60_000); assert.throws(() => guard.session(session)); await guard.close();
}
// Process output is scrubbed, bounded in memory, and rotated on disk.
{
  assert.equal(scrub("hello KEY=private rest"), "hello [hidden]");
  for (const value of ["API_KEY=private", "ACCESS_TOKEN=private", "Bearer private", "sk-private", "a".repeat(64), "Ab+/12".repeat(9)]) assert.ok(!scrub(value).includes(value));
  const { guard, fake } = build(); await guard.init(); await guard.startProcess("lh-team", "gateway");
  for (let i = 0; i < 450; i++) fake.handles[0].emit(`line ${i}`);
  const rows = guard.logs("lh-team", "gateway", 500); assert.equal(rows.length, 400); assert.match(rows[0], /line 50$/);
  const logFile = path.join(guard.store.dir, "logs", "lh-team-gateway.log"); writeFileSync(logFile, "x".repeat(2 * 1024 * 1024));
  fake.handles[0].emit("Bearer do-not-keep");
  assert.ok(statSync(logFile + ".1").size >= 2 * 1024 * 1024); assert.ok(!readFileSync(logFile, "utf8").includes("do-not-keep"));
  await guard.close();
}
// File contents, PINs, sign-in input and output, and secrets never reach logs or audit.
{
  const { guard, fake } = build(); await guard.init();
  const pin = "746203", file = "PRIVATE_FILE_WORDS", signLine = "PRIVATE_SIGN_IN_WORDS", input = "PRIVATE_OWNER_INPUT";
  await guard.setPin(pin, undefined, "local"); await guard.writeBotFile("bot-a", ".env", file);
  await guard.startProcess("lh-team", "gateway"); const gateway = fake.handles[0];
  const { session } = await guard.signIn("anthropic"); const signing = fake.handles.at(-1)!;
  signing.emit(signLine); guard.signInInput(session, input); assert.deepEqual(signing.inputs, [input + "\n"]);
  assert.equal(guard.session(session).lines[0], signLine);
  await refused(guard.signIn("anthropic"), 409);
  const second = await guard.signIn("openai-codex");
  guard.endSignIn(guard.session(second.session));
  await refused(Promise.resolve().then(() => guard.signInInput(session, "two\nlines")), 400);
  for (const secret of [pin, file, signLine, input, guard.store.local, guard.store.relay]) gateway.emit(`words ${secret}`);
  guard.endSignIn(guard.session(session)); assert.ok(signing.killed);
  await guard.changeLevel({ ...level("killed"), reason: `${file} ${pin} ${signLine}`, by: guard.store.local }, "relay");
  assert.ok(gateway.killed);
  const walk = (dir: string): string => readdirSync(dir).map((name) => {
    const target = path.join(dir, name);
    if (statSync(target).isDirectory()) return walk(target);
    if (name === "secret-local" || name === "secret-relay" || name.endsWith(".tar.gz")) return "";
    return readFileSync(target, "utf8");
  }).join("\n");
  const all = walk(guard.store.dir);
  for (const secret of [pin, file, signLine, input, guard.store.local, guard.store.relay]) assert.ok(!all.includes(secret), "Private words must stay out of saved records.");
  const evidence = path.join(guard.store.dir, "evidence", readdirSync(path.join(guard.store.dir, "evidence"))[0]);
  assert.ok(readdirSync(evidence).includes("README.txt")); assert.ok(readdirSync(evidence).includes("bot-a.tar.gz"));
  assert.ok(readdirSync(evidence).includes("lh-team.tar.gz"));
  assert.ok(scripts.evidence.includes('--exclude="*token*"')); assert.ok(scripts.evidence.includes("--exclude=.env"));
  await guard.close();
}
// The owner's absence pauses work, and a seen notice starts the clock again.
{
  const { data, fake, time } = build();
  writeFileSync(path.join(data, "guard", "settings.json"), JSON.stringify({ deadmanHours: 1 }));
  const guard = new Guard(fake, { data, clock: time }); await guard.init();
  await time.advance(3599000); assert.equal(guard.saved.level, "open"); guard.markSeen();
  await time.advance(3599000); assert.equal(guard.saved.level, "open");
  await time.advance(1000); assert.equal(guard.saved.level, "paused"); assert.equal(guard.saved.reason, "no word from the owner"); await guard.close();
}

// HTTP checks use a short-lived listener, with the real required Host header.
{
  const { guard, fake } = build(); await guard.init();
  const server = createGuardServer(guard); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const port = address.port;
  const send = (method: string, route: string, data?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: route, headers: { Host: "127.0.0.1:3091", Authorization: `Bearer ${guard.store.local}`, "Content-Type": "application/json", ...headers } }, (res) => {
      let text = ""; res.on("data", (part) => text += part); res.on("end", () => resolve({ status: res.statusCode!, text }));
    }); req.on("error", reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  const watch = (route: string) => new Promise<{ text: () => string; close: () => void }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path: route, headers: { Host: "127.0.0.1:3091", Authorization: `Bearer ${guard.store.local}` } }, (res) => {
      assert.equal(res.statusCode, 200); let text = ""; res.on("data", (chunk) => text += chunk);
      resolve({ text: () => text, close: () => { res.destroy(); req.destroy(); } });
    }); req.on("error", reject); req.end();
  });
  try {
    const denied = await send("GET", "/state", undefined, { Authorization: "" }); assert.equal(denied.status, 401); assert.equal(denied.text, "");
    assert.equal((await send("GET", "/state", undefined, { Host: "evil.example:3091" })).status, 403);
    assert.equal((await send("GET", "/state", undefined, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await send("GET", "/state", undefined, { Origin: "http://127.0.0.1:3091" })).status, 200);
    assert.equal((await send("POST", "/pin", { pin: "1234" }, { Authorization: `Bearer ${guard.store.relay}` })).status, 403);
    assert.equal((await send("POST", "/bots", { id: "http" })).status, 200);
    assert.equal((await send("POST", "/team", {})).status, 200);
    assert.equal((await send("PUT", "/team/file/config.yaml", { content: "No root tools" })).status, 200);
    assert.equal((await send("GET", "/team/file/.env")).status, 404);
    assert.equal((await send("GET", "/bots/http/file/.env")).status, 400);
    assert.equal((await send("POST", "/bots", { id: "default" })).status, 400);
    assert.equal((await send("POST", "/bots", { id: "a/b" })).status, 400);
    assert.equal((await send("PUT", "/bots/http/file/SOUL.md", { content: "http words" })).status, 200);
    assert.equal((await send("GET", "/bots/http/file/auth.json")).status, 400);
    assert.equal((await send("POST", "/bots", { id: "bot-a;rm" })).status, 400);
    assert.equal((await send("POST", "/bots", { text: "a".repeat(512 * 1024) })).status, 413);
    fake.ubuntu = true;
    const state = JSON.parse((await send("GET", "/state")).text); assert.equal(state.ownerUbuntuRunning, true);
    assert.equal((await send("POST", "/bots/lh-team/procs/gateway/start")).status, 200);
    const sign = JSON.parse((await send("POST", "/subscriptions/openai-codex/sign-in", {})).text) as { session: string };
    const signEvents = await watch(`/sign-in/${sign.session}/events`);
    fake.handles.at(-1)!.emit("Sign in on the page shown by the provider.");
    assert.equal((await send("POST", `/sign-in/${sign.session}/input`, { text: "owner-code" })).status, 200);
    assert.equal((await send("DELETE", `/sign-in/${sign.session}`)).status, 200);
    assert.equal((await send("DELETE", "/subscriptions/openai-codex")).status, 200);
    await flush(); assert.match(signEvents.text(), /event: line/); assert.match(signEvents.text(), /event: ended/); signEvents.close();
    const events = await watch("/events");
    assert.equal((await send("POST", "/seen")).status, 200);
    assert.equal((await send("POST", "/trip", { reason: "Something looked wrong." }, { Authorization: `Bearer ${guard.store.relay}` })).status, 200);
    assert.equal(guard.saved.level, "walled"); assert.equal(fake.state, "stopped");
    await flush(); assert.match(events.text(), /event: level/); assert.match(events.text(), /event: proc/); assert.match(events.text(), /event: space/); events.close();
    assert.equal((await send("POST", "/space/start")).status, 409);
    assert.equal((await send("GET", "/audit?lines=2")).status, 200);
    assert.equal((await send("GET", "/missing")).status, 404);
  } finally {
    await guard.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
console.log("guard-core: ok");
