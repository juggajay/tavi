import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { db, MIGRATIONS } from "../../src/store/db.js";
import { createBot, getBot, listBots, leadBot, updateBot, removeBot, newConversation, gatewayKey, teamGatewayKey, toolboxToken, seedTeam, DEFAULT_CHOICES } from "../../src/hq/bots.js";
import { PORTS } from "../../src/hq/contract.js";
import { setAssistantName } from "../../src/profile/profile.js";
import { soulFor, standingFor } from "../../src/hq/engines/standing.js";
import { fakeAccountProtection } from "../fake-hermes.js";

fakeAccountProtection();

assert.equal(MIGRATIONS.length, 21);
assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 21);
for (const start of [0, 18]) {
  const dir = path.join(TEST_DIR, `older-${start}`);
  mkdirSync(dir);
  const older = new DatabaseSync(path.join(dir, "harness.db"));
  for (const migration of MIGRATIONS.slice(0, start)) older.exec(migration);
  older.exec(`PRAGMA user_version = ${start}`);
  if (start) older.prepare("INSERT INTO settings(key,value) VALUES('kept','yes')").run();
  older.close();
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import {db} from './src/store/db.ts'; if(db.prepare('PRAGMA user_version').get().user_version !== 21) process.exit(2); db.prepare('SELECT * FROM bots').all(); db.close();"],
    { env: { ...process.env, LH_DATA_DIR: dir }, encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const migrated = new DatabaseSync(path.join(dir, "harness.db"));
  if (start) assert.equal((migrated.prepare("SELECT value FROM settings WHERE key='kept'").get() as { value: string }).value, "yes");
  migrated.close();
}

setAssistantName("Rocky", "test");
process.env.LIVE_VOICE = "cedar";
const team = seedTeam();
assert.deepEqual(team.map((b) => b.id), ["pebble", "tim"]);
assert.equal(team[0].name, "Rocky");
assert.equal(team[0].voice, "cedar");
assert.equal(team[1].voice, "ash");
assert.equal(team[0].role, "Your main assistant");
assert.equal(team[1].role, "Second opinion");
assert.deepEqual(team[0].primary, DEFAULT_CHOICES.anthropic);
assert.deepEqual(team[0].fallbacks, [DEFAULT_CHOICES.openai]);
assert.equal(team[1].primary.effort, "medium");
assert.equal(seedTeam().length, 2);
const oldBox = { user: "bot-tim", gatewayPort: 8651, display: null, vncPort: null, cdpPort: null };
db.prepare("UPDATE bots SET box=? WHERE id='tim'").run(JSON.stringify(oldBox));
assert.deepEqual(getBot("tim")!.box, { user: null, display: null, vncPort: null, cdpPort: null });
assert.equal(leadBot()?.id, "pebble");
assert.equal(team[0].box.user, null);
assert.deepEqual(Object.keys(team[0].box), ["user", "display", "vncPort", "cdpPort"]);

for (const id of ["", "UPPER", "has space", "../bad", "a".repeat(26), "probe", "livetest", "trial", "a/b", "default", "root", "hermes"])
  assert.throws(() => createBot({ id, name: "Bad" }));
for (const id of [null, undefined, 123]) assert.throws(() => createBot({ id, name: "Bad" } as never));
const edge = createBot({ id: "a".repeat(25), name: "Edge" });
assert.throws(() => createBot({ id: "pebble", name: "Again" }));
assert.throws(() => updateBot("tim", { primary: { provider: "anthropic", model: "" } }));
assert.throws(() => updateBot("tim", { box: { user: "root" } } as never));
assert.throws(() => updateBot("pebble", { lead: false }));
updateBot("tim", { lead: true, soul: "Take care with names." });
assert.equal(updateBot("tim", { name: "  Tim  ", primary: undefined }).name, "Tim");
assert.equal(leadBot()?.id, "tim");
assert.equal(listBots().filter((b) => b.lead).length, 1);
assert.equal(newConversation("tim").generation, 1);
assert.equal(newConversation("tim").generation, 2);

for (const b of listBots()) {
  const key = gatewayKey(b.id), token = toolboxToken(b.id);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(key, token);
  assert.equal(gatewayKey(b.id), key);
  const row = JSON.stringify(db.prepare("SELECT * FROM bots WHERE id=?").get(b.id));
  assert.ok(!row.includes(key) && !row.includes(token));
  const encrypted = JSON.stringify(db.prepare("SELECT * FROM secrets WHERE name=?").get(`bot:${b.id}:gateway-key`));
  assert.ok(!encrypted.includes(key));
}
assert.notEqual(gatewayKey("tim"), gatewayKey("pebble"));
assert.equal(teamGatewayKey(), teamGatewayKey());
assert.notEqual(teamGatewayKey(), gatewayKey("tim"));
assert.ok(!JSON.stringify(db.prepare("SELECT * FROM secrets WHERE name='team:gateway-key'").get()).includes(teamGatewayKey()));
db.exec("CREATE TEMP TRIGGER refuse_test_key BEFORE INSERT ON secrets WHEN NEW.name='bot:broken:toolbox-token' BEGIN SELECT RAISE(ABORT, 'private test detail'); END");
assert.throws(() => createBot({ id: "broken", name: "Broken" }), (e: unknown) => e instanceof Error && e.message.includes("not been added") && !e.message.includes("private test detail"));
assert.equal(getBot("broken"), undefined);
assert.equal(db.prepare("SELECT name FROM secrets WHERE name='bot:broken:gateway-key'").get(), undefined, "a failed second key also rolls back the first key");
db.exec("DROP TRIGGER refuse_test_key");
const soul = soulFor(getBot("tim")!);
assert.ok(soul.includes("You are Tim"));
assert.ok(soul.includes("Your tools and your walls"));
assert.ok(!soul.includes("Take care with names."));
assert.ok(standingFor(getBot("tim")!).endsWith("Take care with names."));
assert.ok(soul.includes("Rocky: Your main assistant"));
assert.ok(soul.length < 20000);
assert.ok(standingFor({ ...getBot("tim")!, soul: "a".repeat(30000) }).endsWith("a".repeat(30000)));

removeBot("tim");
assert.equal(getBot("tim"), undefined);
assert.ok(db.prepare("SELECT removed_at FROM bots WHERE id='tim'").get());
assert.equal(leadBot()?.id, "pebble");
assert.throws(() => gatewayKey("tim"));
assert.throws(() => createBot({ id: "tim", name: "New Tim" }));
assert.throws(() => newConversation("tim"));
for (const b of listBots()) removeBot(b.id);
assert.deepEqual(seedTeam(), [], "removed bots are never brought back behind the owner's back");
assert.equal(createBot({ id: "fresh", name: "Fresh" }).lead, true);
console.log("bots: ok");
