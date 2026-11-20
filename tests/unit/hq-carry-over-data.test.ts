import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs, { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { MIGRATIONS } from "../../src/store/db.js";
import { aboutDraft, carryOver } from "../../src/hq/carryOver.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repo, "scripts", "carry-over.mjs");
const from = path.join(TEST_DIR, "earlier"), to = path.join(TEST_DIR, "tavi");
const at = "2026-11-19T00:00:00.000Z";
const privateWords = "Private words that must stay out of the report";
// A real practice run may be open on this PC. These tests never connect to it.
let busy = false;
const connection = mock.method(net, "createConnection", () => {
  const socket = new net.Socket();
  queueMicrotask(() => busy ? socket.emit("connect") : socket.emit("error", Object.assign(new Error("Test port is closed."), { code: "ECONNREFUSED" })));
  return socket;
});
syncBuiltinESMExports();
// The sandbox has no loaded Windows account. Only Windows' outer key wrapping is replaced.
// The real encryption and decryption of saved secrets still run, with different folder keys.
const protection = path.join(TEST_DIR, "test-account.mjs");
writeFileSync(protection, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
net.createConnection = function() {
  const socket = new net.Socket();
  queueMicrotask(() => socket.emit('error', Object.assign(new Error('Test port is closed.'), { code: 'ECONNREFUSED' })));
  return socket;
};
const original = childProcess.execFileSync;
childProcess.execFileSync = function(file, args, options) {
  if (String(file).toLowerCase() === 'powershell.exe' && args?.at(-1)?.includes('Security.Cryptography.ProtectedData')) {
    const value = /FromBase64String\\('([^']+)'\\)/.exec(args.at(-1))?.[1];
    if (!value) throw new Error('The test key was missing.');
    return value;
  }
  return original(file, args, options);
};
syncBuiltinESMExports();
`);
const oldNodeOptions = process.env.NODE_OPTIONS;
process.env.NODE_OPTIONS = `${oldNodeOptions ?? ""} --import=${pathToFileURL(protection).href}`.trim();
function protect(master: Buffer) {
  return master.toString("base64");
}
function make(folder: string, version: number) {
  mkdirSync(folder, { recursive: true });
  const db = new DatabaseSync(path.join(folder, "harness.db"));
  MIGRATIONS.slice(0, version).forEach((sql) => db.exec(sql));
  db.exec(`PRAGMA user_version=${version}`);
  return db;
}
function secret(db: DatabaseSync, folder: string, master: Buffer, label: string, value: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", master, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  db.prepare("INSERT INTO secrets VALUES(?,?,?,?,?)").run(label, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64"), at);
  mkdirSync(path.join(folder, "secrets"), { recursive: true });
  writeFileSync(path.join(folder, "secrets", "master.key.dpapi"), protect(master));
}
function hashes(folder: string, skipSavedReports = false, prefix = ""): Record<string, string> {
  if (!existsSync(folder)) return {};
  return Object.fromEntries(readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (skipSavedReports && !prefix && ["backup", "logs"].includes(entry.name)) return [];
    const file = path.join(prefix, entry.name), full = path.join(folder, entry.name);
    return entry.isDirectory() ? Object.entries(hashes(full, skipSavedReports, file)) : [[file, createHash("sha256").update(readFileSync(full)).digest("hex")]];
  }));
}
function run(args: string[]) {
  return spawnSync(process.execPath, ["--no-warnings", script, ...args], { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 120000 });
}

const master = randomBytes(32), otherMaster = randomBytes(32);
let source = make(from, 18);
source.prepare("INSERT INTO memories(id,kind,subject,fact,status,created_at,updated_at) VALUES('mem_old','user','A fact',?,'active',?,?)").run(privateWords, at, at);
source.prepare("INSERT INTO routines(id,title,instructions,schedule_json,delivery,status,created_at,updated_at) VALUES('routine','A routine',?,'{}','brief','active',?,?)").run(privateWords, at, at);
source.prepare("INSERT INTO commitments(id,title,owner,status,created_at,updated_at) VALUES('promise','A promise','user','open',?,?)").run(at, at);
for (const kind of ["note", "model", "shopdrawing"]) source.prepare("INSERT INTO items(id,kind,title,payload_json,origin,created_at,shown_at,pinned_at,job_id) VALUES(?,?,?,'{}','answer',?,?,?,?)").run(`itm_${kind}`, kind, privateWords, at, at, at, "lh-tim-00000000-0000-0000-0000-000000000000");
source.prepare("INSERT INTO pins(id,item_ids,pinned_at,updated_at) VALUES('pin','[\"itm_model\"]',?,?)").run(at, at);
source.prepare("INSERT INTO shop_drawings VALUES('sd_one','ONE-1','ONE','A project','A client','A drawing','PRELIMINARY','A','itm_model',?,?)").run(at, at);
source.prepare("INSERT INTO shop_drawing_revs VALUES('sd_one','A','PRELIMINARY','First','19.11.26','{}','{}','[]',?,?,?,'itm_shopdrawing',?)").run(path.join(from, "drawings", "made.pdf"), path.join(from, "drawings", "made.dxf"), path.join(from, "drawings", "parts"), at);
for (let i = 1; i <= 65; i++) source.prepare("INSERT INTO conversation_log(ts,role,channel,text) VALUES(?,?,?,?)").run(at, i % 2 ? "user" : "assistant", i % 3 ? "typed" : "voice", `Earlier line ${i}`);
source.prepare("INSERT INTO conversation_log(ts,role,channel,text) VALUES(?, 'system','typed',?)").run(at, privateWords);
source.prepare("INSERT INTO conversation_log(ts,role,channel,text) VALUES(?, 'user','test',?)").run(at, privateWords);
source.prepare("INSERT INTO conversation_log(ts,role,channel,text) VALUES(?, 'user','siri','A Siri line')").run(at);
source.prepare("INSERT INTO computers VALUES('phone',NULL,'paired hash',?,NULL)").run(at);
source.prepare("INSERT INTO push_subscriptions VALUES('https://example.invalid/push','{}',?)").run(at);
source.prepare("INSERT INTO shortcut_keys VALUES('phone','siri hash',?,NULL,NULL)").run(at);
source.prepare("INSERT INTO settings VALUES('assistant_name','An Earlier Name')").run();
source.prepare("INSERT INTO settings VALUES('reference.dir',?)").run(path.join(TEST_DIR, "outside shelf"));
source.prepare("INSERT INTO folders(id,path,label,kind,added_at) VALUES('folder',?,'Made files','managed',?)").run(path.join(from, "drawings"), at);
source.prepare("INSERT INTO folders(id,path,label,kind,added_at) VALUES('linked',?,'Allowed folder','linked',?)").run(path.join(TEST_DIR, "missing folder"), at);
source.prepare("INSERT INTO docs(id,folder_id,path,name,type,meta_json,indexed_at) VALUES('doc_one','folder',?,'made.glb','made','{}',?)").run(path.join(from, "drawings", "models", "made.glb"), at);
source.prepare("INSERT INTO drawing_files(hash,path,name,project,status,added_at) VALUES('drawing',?,'made.pdf','Project','ready',?)").run(path.join(from, "drawings", "made.pdf"), at);
source.prepare("INSERT INTO sheets(id,file_hash,page,project,status,data_dir,created_at) VALUES('sheet','drawing',1,'Project','current',?,?)").run(path.join(from, "drawings", ".index", "drawing"), at);
source.prepare("INSERT INTO ref_books(id,path,name,state) VALUES('ref_one',?,'A book','ready')").run(path.join(TEST_DIR, "outside shelf", "book.pdf"));
secret(source, from, master, "google.client", privateWords);
source.close();
mkdirSync(path.join(from, "profile"));
const userProfile = "# About you\r\n## Basics\r\n- Name: Nemi Venn (2026-11-19 · said)\r\n- Location: Sydney\r\n- Account number: private\r\n## Work\r\n- A private project\r\n## How to talk to them\r\n- Tone: Plain Australian English\r\n## People\r\n- A private person\r\n";
writeFileSync(path.join(from, "profile", "USER.md"), userProfile);
writeFileSync(path.join(from, "profile", "SOUL.md"), "The earlier assistant's own words, kept exactly.\r\n");
mkdirSync(path.join(from, "drawings", "models"), { recursive: true });
writeFileSync(path.join(from, "drawings", "models", "made.glb"), "A made file");
utimesSync(path.join(from, "drawings", "models", "made.glb"), new Date(at), new Date(at));
writeFileSync(path.join(from, "drawings", "made.pdf"), "A drawing file");
mkdirSync(path.join(from, "reference")); writeFileSync(path.join(from, "reference", "index.txt"), "A reference index");
mkdirSync(path.join(TEST_DIR, "outside shelf"));
let target = make(to, 21);
const choice = JSON.stringify({ provider: "anthropic", model: "claude-opus-5-5" });
for (const [id, lead] of [["main", 1], ["reader", 0]] as const) {
  target.prepare('INSERT INTO bots(id,name,role,soul,look,engine,"primary",fallbacks,servers,computer,voice,box,lead,created_at) VALUES(?,?,\'A job\',\'\',\'{}\',\'hermes\',?,\'[]\',\'"all"\',0,\'marin\',\'{}\',?,?)').run(id, id, choice, lead, at);
}
const practiceBody = JSON.stringify({ kind: "message", from: "owner", text: "Practice conversation", via: "typed" });
target.prepare("INSERT INTO bot_rows VALUES('main',0,1,1,?,'message',?)").run(at, practiceBody);
target.prepare("INSERT INTO bot_rows VALUES('reader',0,1,1,?,'message',?)").run(at, practiceBody);
target.prepare("INSERT INTO bot_cards VALUES('main',1,'{}',?,'owner','First card',0)").run(at);
target.prepare("INSERT INTO memories(id,kind,subject,fact,status,created_at,updated_at,scope) VALUES('mem_reader','preference','Own note','Own words','active',?,?,'bot:reader')").run(at, at);
target.prepare("INSERT INTO settings VALUES('team:ready','yes')").run();
secret(target, to, otherMaster, "bot:reader:toolbox-token", "Original bot key");
target.close();
mkdirSync(path.join(to, "guard")); writeFileSync(path.join(to, "guard", "secret-relay"), "A guard key");
mkdirSync(path.join(to, "profile")); writeFileSync(path.join(to, "profile", "USER.md"), "Old practice profile");

const sourceBefore = hashes(from), targetBefore = hashes(to);
let result = await carryOver({ from, to });
assert.equal(result.code, 0, result.report);
assert.deepEqual(hashes(from), sourceBefore);
assert.deepEqual(hashes(to), targetBefore);
assert.match(result.report, /1 memories; 1 routines; 1 commitments/);
assert.match(result.report, /models: 1, notes: 1, shop drawings: 1/);
assert.match(result.report, /1 pins; 1 shop drawing sets; 1 models; 68 conversation lines/);
assert.match(result.report, /2 bots; 2 conversation rows; 1 job cards/);
assert.match(result.report, /outside shelf.*exists/);
assert.match(result.report, /missing folder.*missing/);
assert.ok(!result.report.includes(privateWords));
assert.ok(!result.report.includes("Nemi Venn"));
assert.equal(aboutDraft(userProfile), "Name: Nemi Venn\nLocation: Sydney\nTone: Plain Australian English");
assert.ok(aboutDraft(userProfile.repeat(100)).length <= 1500);

const real = run(["--from", from, "--to", to, "--yes"]);
assert.equal(real.status, 0, real.stdout + real.stderr);
assert.deepEqual(hashes(from), sourceBefore);
assert.ok(!real.stdout.includes(privateWords));
target = new DatabaseSync(path.join(to, "harness.db"));
assert.equal((target.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 21);
for (const [table, n] of [["memories", 2], ["routines", 1], ["commitments", 1], ["items", 3], ["pins", 1], ["shop_drawings", 1], ["shop_drawing_revs", 1], ["computers", 1], ["push_subscriptions", 1], ["shortcut_keys", 1], ["conversation_log", 68], ["ref_books", 1], ["bots", 2], ["bot_cards", 1], ["bot_rows", 62]] as const) {
  assert.equal((target.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, n, table);
}
assert.equal((target.prepare("SELECT scope FROM memories WHERE id='mem_old'").get() as { scope: string }).scope, "lead");
assert.equal((target.prepare("SELECT scope FROM memories WHERE id='mem_reader'").get() as { scope: string }).scope, "bot:reader");
for (const row of target.prepare("SELECT payload_json FROM items").all() as { payload_json: string }[]) assert.equal(JSON.parse(row.payload_json)._meta.made_by_bot, null);
const rows = target.prepare("SELECT * FROM bot_rows WHERE bot='main' ORDER BY seq").all() as { body_json: string }[];
assert.equal(JSON.parse(rows[0].body_json).text, "Earlier line 7");
assert.equal(JSON.parse(rows[59].body_json).via, "siri");
assert.equal(rows[60].body_json, practiceBody);
assert.equal((target.prepare("SELECT text FROM about_card").get() as { text: string }).text, "");
const approval = target.prepare("SELECT grant_json FROM approvals WHERE operation='team.about'").get() as { grant_json: string };
assert.equal(JSON.parse(approval.grant_json).text, aboutDraft(userProfile));
assert.equal((target.prepare("SELECT value FROM settings WHERE key='team:ready'").get() as { value: string }).value, "yes");
assert.equal((target.prepare("SELECT value FROM settings WHERE key='assistant_name'").get() as { value: string }).value, "An Earlier Name");
assert.equal((target.prepare("SELECT path FROM docs").get() as { path: string }).path, path.join(to, "drawings", "models", "made.glb"));
assert.equal((target.prepare("SELECT data_dir FROM sheets").get() as { data_dir: string }).data_dir, path.join(to, "drawings", ".index", "drawing"));
for (const [label, expected] of [["google.client", privateWords], ["bot:reader:toolbox-token", "Original bot key"]]) {
  const row = target.prepare("SELECT * FROM secrets WHERE name=?").get(label) as { iv: string; tag: string; data: string };
  const cipher = createDecipheriv("aes-256-gcm", master, Buffer.from(row.iv, "base64"));
  cipher.setAuthTag(Buffer.from(row.tag, "base64"));
  assert.equal(JSON.parse(Buffer.concat([cipher.update(Buffer.from(row.data, "base64")), cipher.final()]).toString()), expected);
}
target.close();
assert.equal(readFileSync(path.join(to, "profile", "USER.md"), "utf8"), userProfile);
assert.equal(readFileSync(path.join(to, "guard", "secret-relay"), "utf8"), "A guard key");
assert.equal(readFileSync(path.join(to, "drawings", "models", "made.glb"), "utf8"), "A made file");
assert.ok(Math.abs(statSync(path.join(to, "drawings", "models", "made.glb")).mtimeMs - statSync(path.join(from, "drawings", "models", "made.glb")).mtimeMs) < 1);
assert.equal(readFileSync(path.join(to, "reference", "index.txt"), "utf8"), "A reference index");
const backups = readdirSync(path.join(to, "backup")); assert.equal(backups.length, 1);
const backupDb = new DatabaseSync(path.join(to, "backup", backups[0], "harness.db"), { readOnly: true });
assert.equal((backupDb.prepare("SELECT count(*) n FROM items").get() as { n: number }).n, 0); backupDb.close();
assert.equal(readFileSync(path.join(to, "logs", readdirSync(path.join(to, "logs"))[0]), "utf8"), real.stdout);

result = await carryOver({ from, to, yes: true }); assert.equal(result.code, 0, result.report);
target = new DatabaseSync(path.join(to, "harness.db"));
assert.equal((target.prepare("SELECT count(*) n FROM bot_rows").get() as { n: number }).n, 62);
assert.equal((target.prepare("SELECT count(*) n FROM approvals WHERE operation='team.about'").get() as { n: number }).n, 1);
target.close(); assert.deepEqual(hashes(from), sourceBefore);

source = new DatabaseSync(path.join(from, "harness.db"));
source.prepare("INSERT INTO conversation_log(ts,role,channel,text) VALUES(?, 'assistant','typed','Final day line')").run(at); source.close();
const changedSource = hashes(from);
result = await carryOver({ from, to, yes: true }); assert.equal(result.code, 0, result.report);
target = new DatabaseSync(path.join(to, "harness.db"));
assert.equal((target.prepare("SELECT count(*) n FROM bot_rows").get() as { n: number }).n, 62);
const refreshed = target.prepare("SELECT body_json FROM bot_rows WHERE bot='main' AND seq=60").get() as { body_json: string };
assert.equal(JSON.parse(refreshed.body_json).text, "Final day line");
target.close(); assert.deepEqual(hashes(from), changedSource);

target = new DatabaseSync(path.join(to, "harness.db"));
target.exec("UPDATE about_card SET text='An approved card', revision=7"); target.close();
result = await carryOver({ from, to, yes: true }); assert.equal(result.code, 0, result.report);
target = new DatabaseSync(path.join(to, "harness.db"));
assert.deepEqual({ ...target.prepare("SELECT text,revision FROM about_card").get() }, { text: "An approved card", revision: 7 }); target.close();
assert.ok(!result.report.includes("Needs your tap"));

const beforeFailure = hashes(to, true);
const keyFile = path.join(from, "secrets", "master.key.dpapi");
const savedKey = readFileSync(keyFile);
writeFileSync(keyFile, protect(randomBytes(32)));
const failed = run(["--from", from, "--to", to, "--yes"]);
assert.equal(failed.status, 3, failed.stdout + failed.stderr);
assert.match(failed.stdout, /secret could not be opened/);
assert.match(failed.stdout, /Backup:/);
assert.deepEqual(hashes(to, true), beforeFailure);
const refusedNew = path.join(TEST_DIR, "bad-key-new-folder");
result = await carryOver({ from, to: refusedNew, yes: true });
assert.equal(result.code, 3, result.report);
assert.ok(!existsSync(refusedNew), "A failed first carry-over leaves no destination folder behind.");
writeFileSync(keyFile, savedKey);

const empty = path.join(TEST_DIR, "new-team");
result = await carryOver({ from, to: empty }); assert.equal(result.code, 0, result.report); assert.ok(!existsSync(empty));
result = await carryOver({ from, to: empty, yes: true }); assert.equal(result.code, 0, result.report);
const seeded = new DatabaseSync(path.join(empty, "harness.db"));
assert.equal((seeded.prepare("SELECT name FROM bots WHERE lead=1").get() as { name: string }).name, "An Earlier Name");
assert.equal((seeded.prepare("SELECT count(*) n FROM bot_rows").get() as { n: number }).n, 60); seeded.close();

// A settled WAL file must also stay unchanged when it is the source.
const walFolder = path.join(TEST_DIR, "wal-source"); mkdirSync(walFolder);
copyFileSync(path.join(from, "harness.db"), path.join(walFolder, "harness.db"));
const wal = new DatabaseSync(path.join(walFolder, "harness.db")); wal.exec("PRAGMA journal_mode=WAL"); wal.close();
const walBefore = hashes(walFolder);
// No key was copied, so the check fails safely; opening the source still must not change it.
result = await carryOver({ from: walFolder, to: path.join(TEST_DIR, "wal-target") });
assert.equal(result.code, 3); assert.deepEqual(hashes(walFolder), walBefore);

// A running source can have waiting writes. They must be present in the copy too.
source = new DatabaseSync(path.join(from, "harness.db"));
source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
source.prepare("INSERT INTO conversation_log(ts,role,channel,text) VALUES(?, 'user','voice','Waiting write')").run(at);
const activeBefore = hashes(from);
result = await carryOver({ from, to }); assert.equal(result.code, 0, result.report);
assert.match(result.report, /70 conversation lines/);
assert.deepEqual(hashes(from), activeBefore);
source.close();

const beforeRefusals = hashes(to);
process.env.TAVI_PROTECTED_DATA_DIRS = "C:\\Users\\you\\other-app\\data";
for (const destination of [from, path.join(from, "inside"), TEST_DIR, "C:\\Users\\you\\other-app\\data", "C:\\Users\\you\\other-app\\data\\child"]) {
  result = await carryOver({ from, to: destination, yes: true }); assert.equal(result.code, 2, result.report);
}
result = await carryOver({ from: path.join(TEST_DIR, "missing-source"), to }); assert.equal(result.code, 2);
const alias = path.join(TEST_DIR, "source-alias"); symlinkSync(from, alias, "junction");
result = await carryOver({ from, to: alias, yes: true }); assert.equal(result.code, 2);
busy = true;
result = await carryOver({ from, to, yes: true }); assert.equal(result.code, 2); assert.match(result.report, /stop the practice run first/);
busy = false;
target = new DatabaseSync(path.join(to, "harness.db")); target.exec("BEGIN EXCLUSIVE");
try {
  result = await carryOver({ from, to, yes: true }); assert.equal(result.code, 2); assert.match(result.report, /stop the practice run first/);
} finally { target.exec("ROLLBACK"); target.close(); }
assert.deepEqual(hashes(to), beforeRefusals);
assert.equal(run(["--from", from, "--to", to, "--unknown"]).status, 2);
assert.equal(run(["--from", from]).status, 2);

// Force a failure after the old folder has moved, to prove it is put back.
const beforeSwap = hashes(to, true);
const rename = fs.renameSync;
const refusedMove = mock.method(fs, "renameSync", (oldPath: fs.PathLike, newPath: fs.PathLike) => {
  if (path.basename(String(oldPath)) === "prepared" && String(newPath) === to) throw new Error("Test replacement was refused.");
  return rename(oldPath, newPath);
});
syncBuiltinESMExports();
try {
  result = await carryOver({ from, to, yes: true }); assert.equal(result.code, 3, result.report);
  assert.ok(result.backup && existsSync(result.backup));
  assert.deepEqual(hashes(to, true), beforeSwap);
} finally { refusedMove.mock.restore(); syncBuiltinESMExports(); }

// Checking a stopped practice database in WAL mode leaves its bytes and file list alone.
target = new DatabaseSync(path.join(to, "harness.db")); target.exec("PRAGMA journal_mode=WAL"); target.close();
const stoppedBefore = hashes(to);
result = await carryOver({ from, to }); assert.equal(result.code, 0, result.report);
assert.deepEqual(hashes(to), stoppedBefore);
if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldNodeOptions;
connection.mock.restore(); syncBuiltinESMExports();
console.log("Carry-over checks passed: counts, private words, files, keys, backup, repeat, final-day refresh and safe failure.");
