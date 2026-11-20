import "../isolate.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homePage, wallpaper, pinnedAddresses, type DeskBot } from "../../src/hq/screens/desktop.js";
import { BASIC_APPS, readApps } from "../../src/hq/screens/desk/apps.js";
import { shapes, colours } from "../../src/shared/faces/shapes.js";
import { ICONS } from "../../src/shared/faces/icons.js";
import { deskSettings, saveDeskSettings } from "../../src/hq/screens/desk/settings.js";
import { ensureComputer } from "../../src/hq/screens/computer.js";
import { Computers } from "../../src/hq/screens/service.js";
import { ScreenGuardClient } from "../../src/hq/screens/guard.js";
import { db } from "../../src/store/db.js";
import type { GuardClient } from "../../src/hq/guardClient.js";

const bot: DeskBot = { id: "mira", name: "Mira", role: "Everyday ideas", soul: "", look: { shape: "pebble", colour: "blue" }, engine: "hermes", primary: { provider: "anthropic", model: "test" }, fallbacks: [], servers: [], computer: true, voice: "marin", box: { user: null, display: null, vncPort: null, cdpPort: null }, generation: 0, lead: false, createdAt: "" };
const apps = JSON.parse(readFileSync("box/screen/apps.sh", "utf8").split("<<'JSON'\n")[1].split("\nJSON")[0]);
assert.equal(readApps(apps).length, 9);
for (const invalid of [undefined, null, "broken", {}, [], [null], [{ id: "browser" }], [...apps, apps[0]], apps.map((a: object) => ({ ...a, command: ["/tmp/run"] }))]) assert.deepEqual(readApps(invalid), BASIC_APPS);
for (const icon of ICONS) {
  const page = homePage({ ...bot, look: { shape: icon.id, colour: "plum" } });
  assert(page.includes(icon.body));
  for (const mark of icon.marks ?? []) assert(page.includes(mark));
  assert(page.includes(`r="${icon.eyes.r}"`));
}
for (const [shape, body] of Object.entries(shapes)) {
  for (const theme of ["light", "dark"] as const) {
    const own = { ...bot, look: { shape, colour: "blue" } };
    const page = homePage(own, { theme, apps }), wall = wallpaper(own, 1440, 900, { theme });
    for (const output of [page, wall]) {
      assert(output.includes(body)); assert(output.includes(colours.blue[0]));
      assert(output.includes(bot.name)); assert(output.includes(bot.role));
      assert(!output.includes("Fern")); assert(!output.includes(colours.orange[0]));
    }
    assert(page.includes(`data-theme="${theme}"`)); assert(wall.includes(`|${theme}</metadata>`));
  }
}
const hostile = { ...bot, name: '<Mira & "friends">', role: "</script><img src=x onerror='bad()'>", pinnedAddresses: [{ name: '<Notes & "links">', address: 'https://example.com/?a=1&b=2' }, { name: "Run", address: "javascript:alert(1)" }] };
for (const output of [homePage(hostile), wallpaper(hostile)]) {
  assert(!output.includes(hostile.name)); assert(!output.includes(hostile.role));
  assert(output.includes("&lt;Mira &amp; &quot;friends&quot;&gt;"));
}
const page = homePage(hostile, { apps });
assert(page.includes('href="https://example.com/?a=1&amp;b=2"'));
assert(!page.includes("javascript:")); assert(!page.includes('<img src=x'));
assert.deepEqual([...new Set(page.match(/https?:\/\/[^"<\s]+/g))], ["https://example.com/?a=1&amp;b=2", "https://www.google.com/search"]);
for (const app of apps) assert(page.includes(`data-app="${app.id}"`));
assert(page.includes("allowed.has(tile.dataset.app)")); assert(page.includes("action:'open',id:tile.dataset.app"));
assert(!page.includes("/usr/bin/"));
assert.deepEqual(pinnedAddresses([{ name: "bad", address: "https://name:secret@example.org" }, { name: "bad", address: "file:///home/" }]), []);
assert.deepEqual(deskSettings(bot.id), { pinnedAddresses: [], theme: "light" });
saveDeskSettings(bot.id, { pinnedAddresses: [{ name: "Notes", address: "https://example.org/notes" }], theme: "dark" });
assert.equal(deskSettings(bot.id).pinnedAddresses.length, 1);
assert.equal(deskSettings("fern").pinnedAddresses.length, 0);
let prepared = "";
await ensureComputer(bot, { allocate: () => ({ user: "bot-mira", display: 1, vncPort: 5911, cdpPort: 9211, width: 1440, height: 900 }), register: async () => ({ applied: true }), fence: async () => ({ applied: true }), prepare: async (_user, wall, home) => { prepared = wall + home; }, start: async () => {} });
assert(prepared.includes('data-theme="dark"')); assert(prepared.includes('href="https://example.org/notes"'));
const before = prepared;
await ensureComputer({ ...bot, name: "New Mira", look: { shape: "moon", colour: "green" } }, { allocate: () => ({ user: "bot-mira", display: 1, vncPort: 5911, cdpPort: 9211, width: 1440, height: 900 }), register: async () => ({ applied: true }), fence: async () => ({ applied: true }), prepare: async (_user, wall, home) => { prepared = wall + home; }, start: async () => {} });
assert.notEqual(before, prepared); assert(prepared.includes("New Mira")); assert(prepared.includes(colours.green[0]));
let preparations = 0;
class ScreenStandIn extends ScreenGuardClient {
  override async setPorts(ports: Parameters<ScreenGuardClient["setPorts"]>[0]) { return { applied: true, ports }; }
  override async fence() { return { applied: true, ports: null }; }
  override async prepare(_user: string, _wall: string, _home: string) { preparations++; }
}
const guard = { level: () => "open", startProcess: async () => {} } as unknown as GuardClient;
const computers = new Computers(guard, () => {}, new ScreenStandIn(guard), async () => {});
// This screen check needs a saved bot, without making sign-in keys on Windows.
const saved = { ...bot, id: "look-check", name: "Look check", box: { user: null, display: null, vncPort: null, cdpPort: null } };
db.prepare('INSERT INTO bots (id,name,role,soul,look,engine,"primary",fallbacks,servers,computer,voice,box,generation,lead,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,?)')
  .run(saved.id, saved.name, saved.role, "", JSON.stringify(saved.look), saved.engine, JSON.stringify(saved.primary), "[]", "[]", 1, saved.voice, JSON.stringify(saved.box), "2026-11-20T00:00:00Z");
await computers.prepare(saved); await computers.start(saved.id);
await computers.prepare(saved); assert.equal(preparations, 1, "An unchanged computer can keep its prepared look.");
await computers.prepare({ ...saved, name: "Changed name", look: { shape: "moon", colour: "plum" } });
assert.equal(preparations, 2, "A changed look must be prepared for the next screen start.");
console.log("Own faces, escaped words, program tiles, pinned addresses and refreshed looks passed.");
