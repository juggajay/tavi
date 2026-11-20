import "../isolate.js";
import assert from "node:assert/strict";
import { configYaml } from "../../src/hq/engines/hermes.js";
import { homePage, wallpaper } from "../../src/hq/screens/desktop.js";
import { ensureComputer } from "../../src/hq/screens/computer.js";
import type { Bot } from "../../src/hq/contract.js";

const bot: Bot = { id: "test-a", name: '<A & "B">', role: "Everyday help", soul: "", look: { shape: "moon", colour: "blue" }, engine: "hermes",
  primary: { provider: "anthropic", model: "test" }, fallbacks: [], servers: [], computer: false, voice: "marin", box: { user: null, display: null, vncPort: null, cdpPort: null }, generation: 0, lead: true, createdAt: "" };
const plain = configYaml(bot, {});
assert(plain.includes("api_server: [todo, skills]")); assert(!plain.includes("terminal:")); assert(!plain.includes("cdp_url"));
bot.computer = true;
assert.throws(() => configYaml(bot, {}));
const calls: string[] = [];
let fenced = true;
const deps = {
  allocate: () => ({ user: "bot-test-a", display: 11, vncPort: 5921, cdpPort: 9221, width: 1440, height: 900 }),
  async register() { calls.push("register"); return { applied: fenced }; },
  async prepare() { calls.push("prepare"); },
  async fence() { calls.push("check"); return { applied: fenced }; },
  async start(_u: string, kind: string) { calls.push(kind); },
};
await ensureComputer(bot, deps);
assert.deepEqual(calls, ["register", "prepare", "check", "screen", "browser"]);
const computer = configYaml(bot, {}, true);
assert(computer.includes("api_server: [todo, skills, web, terminal, file, browser, vision]"));
assert(computer.includes('backend: "ssh"')); assert(computer.includes('ssh_user: "bot-test-a"'));
assert(computer.includes('ssh_key: "/srv/lh/team/keys/test-a"')); assert(computer.includes("ssh_port: 2222"));
assert(computer.includes('cwd: "/home/bot-test-a/work"')); assert(computer.includes('cdp_url: "http://127.0.0.1:9221"'));
assert(!computer.includes("code_execution")); assert(!computer.includes("computer_use")); assert(!computer.includes("DISPLAY"));
calls.length = 0; fenced = false;
await assert.rejects(ensureComputer(bot, deps)); assert.deepEqual(calls, ["register"]);
assert(wallpaper(bot).includes("&lt;A &amp; &quot;B&quot;&gt;"));
assert(!wallpaper({ ...bot, look: { shape: '<script>', colour: 'red" onload="alert(1)' } }).includes("onload"));
assert(homePage(bot).includes("&lt;A &amp; &quot;B&quot;&gt;"));
assert(homePage(bot).includes('id="search"')); assert(homePage(bot).includes("setInterval(tick,1000)"));
assert(!homePage(bot).includes(bot.name));
console.log("computer setup and settings: ok");
