import "../isolate.js";
import assert from "node:assert/strict";
import { rig, until } from "./hq-api-fixture.test.js";
import { ScreenGuardClient } from "../../src/hq/screens/guard.js";
import { createBot, getBot, removeBot, updateBot } from "../../src/hq/bots.js";
import { allocateScreen } from "../../src/hq/screens/computer.js";
import type { ScreenPorts } from "../../src/guard/fence.js";

let record = (_route: string) => {};
let fenced = true;
class ScreenGuard extends ScreenGuardClient {
  constructor() { super({} as ConstructorParameters<typeof ScreenGuardClient>[0]); }
  override async setPorts(ports: ScreenPorts) { record("ports"); return { applied: fenced, ports }; }
  override async prepare(_u: string, picture: string, home: string) { record("prepare"); assert(picture.includes("Tavi")); assert(home.includes('id="search"')); }
  override async fence() { record("fence"); return { applied: fenced, ports: null }; }
  override async drop(user: string) { record(`stop browser ${user}`); record(`stop screen ${user}`); record("drop"); }
}
const r = await rig(undefined, { screenGuard: new ScreenGuard(), screenReady: async () => {} });
record = route => r.calls.push({ route });
try {
  await r.hq.ensure(getBot("pebble")!); await r.hq.ensure(getBot("tim")!);
  const before = r.calls.length;
  assert.equal((await r.request("/bots/tim/computer", "POST", { on: true })).status, 202);
  await until(() => r.hq.computer("tim").state === "ready");
  await until(() => r.calls.slice(before).some(c => c.route === "/bots/lh-team/procs/gateway/start"));
  const calls = r.calls.slice(before).map(c => c.route);
  const ordered = ["ports", "prepare", "/bots/tim/file/config.yaml", "/bots/bot-tim/procs/screen/start", "/bots/bot-tim/procs/browser/start", "/bots/lh-team/procs/gateway/start"];
  let index = -1;
  for (const route of ordered) { const next = calls.indexOf(route, index + 1); assert(next > index, `${route} follows the earlier steps: ${calls.join(", ")}`); index = next; }
  const first = getBot("tim")!;
  assert.equal(first.box.display, 1);
  assert.match(r.files.get("/bots/tim/file/config.yaml")!, /terminal, file, browser/);
  await r.request("/bots/tim/computer", "POST", { on: false });
  await until(() => !r.files.get("/bots/tim/file/config.yaml")!.includes("terminal, file, browser"));
  const off = r.calls.slice(before).map(c => c.route);
  assert(off.indexOf("stop browser bot-tim") < off.indexOf("stop screen bot-tim"));
  assert.equal(getBot("tim")!.box.display, first.box.display);
  await r.request("/bots/tim/computer", "POST", { on: true });
  await until(() => r.hq.computer("tim").state === "ready");
  assert.equal(getBot("tim")!.box.display, first.box.display);
  fenced = false;
  await r.request("/bots/tim/computer", "POST", { on: true });
  await until(() => r.hq.computer("tim").state === "error");
  await until(() => !r.files.get("/bots/tim/file/config.yaml")!.includes("terminal, file, browser"));
  await r.hq.ensure(getBot("tim")!);
  assert.match((await r.hq.engineState(getBot("tim")!)).why!, /checks between bots/);
  const retired = createBot({ id: "retired", name: "Retired" });
  assert.equal(allocateScreen(retired).display, 2); removeBot(retired.id);
  const later = createBot({ id: "later", name: "Later" });
  assert.equal(allocateScreen(later).display, 3);
  fenced = true;
  const chosen = { provider: "openai-codex" as const, model: "chosen-model", effort: "medium" as const };
  updateBot("pebble", { primary: chosen, servers: ["calc"] });
  await r.hq.setComputer("pebble", true); await r.hq.ensure(getBot("pebble")!);
  assert.deepEqual(getBot("pebble")!.primary, chosen, "Giving a computer keeps the chosen model.");
  assert.deepEqual(getBot("pebble")!.servers, ["calc"], "Giving a computer keeps the chosen tools.");
  console.log("Computer setup, stopping, fixed numbers and failed checks passed.");
} finally { await r.close(); }
