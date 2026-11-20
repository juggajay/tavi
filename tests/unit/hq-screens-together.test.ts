import "../isolate.js"; // first
import assert from "node:assert/strict";
import { ensureComputer, fenceApplied, type ComputerDeps } from "../../src/hq/screens/computer.js";
import type { Bot } from "../../src/hq/contract.js";

// Two bots with computers start together. The safety switch has one answer for "are the checks between bots in
// place?", and takes it away while it adds any one computer. Before, the second bot asked during the first one's
// few seconds, was told no, and lost its computer. Now one computer is set up at a time and a "no" is waited out.
const bot = (id: string, display: number) => ({ id, name: id, role: "helper", computer: true, engine: "hermes",
  look: { shape: "pebble", colour: "blue" }, box: { user: `bot-${id}`, display, vncPort: 5910 + display, cdpPort: 9210 + display } }) as unknown as Bot;
let inPlace = true, busy = 0, most = 0;
const order: string[] = [];
const deps: ComputerDeps = {
  allocate: (b) => ({ user: `bot-${b.id}`, display: b.box.display!, vncPort: b.box.vncPort!, cdpPort: b.box.cdpPort!, width: 1440, height: 900 }),
  // Adding a computer takes the answer away for a moment, as the real switch does.
  register: async (ports) => { busy++; most = Math.max(most, busy); inPlace = false; order.push("add " + ports.user); await new Promise((r) => setTimeout(r, 40)); inPlace = true; return { applied: true }; },
  prepare: async (user) => { order.push("prepare " + user); await new Promise((r) => setTimeout(r, 10)); },
  fence: async () => ({ applied: inPlace }),
  start: async (user, kind) => { order.push(`start ${user} ${kind}`); if (kind === "browser") busy--; },
  fenceWaitMs: 2000,
};
await Promise.all([ensureComputer(bot("one", 1), deps), ensureComputer(bot("two", 2), deps)]);
assert.equal(most, 1, "one computer is set up at a time");
assert.deepEqual(order, ["add bot-one", "prepare bot-one", "start bot-one screen", "start bot-one browser",
  "add bot-two", "prepare bot-two", "start bot-two screen", "start bot-two browser"]);

// A "no" that turns to "yes" within the wait is a pass; one that never does is still a failure.
let asked = 0;
assert.equal(await fenceApplied(async () => ({ applied: ++asked >= 3 }), "bot-one", 1000), true);
assert.equal(asked, 3);
assert.equal(await fenceApplied(async () => ({ applied: false }), "bot-one", 150), false);
// One computer failing does not stop the next from being set up.
const failing: ComputerDeps = { ...deps, register: async () => ({ applied: false }) };
await assert.rejects(ensureComputer(bot("three", 3), failing), /checks between bots/);
order.length = 0;
await ensureComputer(bot("four", 4), deps);
assert.equal(order.at(-1), "start bot-four browser");
console.log("hq-screens-together: computers are set up one at a time and a short gap in the checks is waited out");
