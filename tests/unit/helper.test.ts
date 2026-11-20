// The helper for the second PC (Stage 11.1), run here against a throwaway folder and a stand-in gateway: each request
// gives the right answer, the limits hold, an unknown request is refused, its log says what was asked (never what's in
// a file), and it reconnects, backing off, when the line drops or the gateway says no.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkGateway, foldersFrom, parseLoose, readConfig, type Config } from "../../src/helper/config.js";
import { startHelper } from "../../src/helper/helper.js";
import { makeLog } from "../../src/helper/log.js";
import { find, LIST_MAX, FIND_MAX, PIECE_MAX } from "../../src/helper/ops.js";
import { fakeGateway } from "../fake-gateway.js";

const base = path.join(tmpdir(), `lh-helper-${process.pid}`);
rmSync(base, { recursive: true, force: true });
const jobs = path.join(base, "Jobs");
const put = (rel: string, body: string | Buffer) => {
  const p = path.join(base, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
};
put("Jobs/Lumi/Quote v2.pdf", "%PDF-1.4 quote");
put("Jobs/Lumi/notes.txt", "SECRET-CONTENT-123 ring the plumber");
put("Jobs/Lumi Deck/plan.pdf", "%PDF-1.4 deck");
put("Jobs/notes.txt", "top notes");
for (let i = 0; i < LIST_MAX + 100; i++) put(`Jobs/Big/f${String(i).padStart(3, "0")}.txt`, "x");
for (let i = 0; i < FIND_MAX + 50; i++) put(`Jobs/Many/match-${i}.txt`, "y");
const middle = randomBytes(Math.round(1.5 * 1024 * 1024));
put("Jobs/middle.bin", middle);
put("Jobs/huge.bin", randomBytes(3 * 1024 * 1024));
put("Outside/secret.txt", "never shown");

const logFile = path.join(base, "helper.log");
const SECRET = "test-secret-" + randomBytes(12).toString("hex");
const gw = await fakeGateway();
const config: Config = { computer: "test-pc", gateway: gw.url, secret: SECRET, folders: [{ name: "Jobs", dir: jobs }], maxFileBytes: 2 * 1024 * 1024, problems: [] };
const attempts: number[] = [];
// The throwaway folder is in the temp folder, under AppData, which the helper refuses unless told it's a test.
const safety = { allowTemp: true };
const helper = startHelper({ config: () => config, log: makeLog(logFile, false), backoffMs: (n) => (attempts.push(n), 20), safety });
await gw.connected();

// It says who it is, its version and its secret, and its size limit.
assert.equal(gw.hellos[0].name, "test-pc");
assert.equal(gw.hellos[0].secret, SECRET);
assert.equal(gw.hellos[0].version, "1.0");
assert.equal(gw.hellos[0].max_file_mb, 2);

// roots
assert.deepEqual(await gw.ask("roots"), { type: "res", id: "r1", ok: true, roots: [{ name: "Jobs" }] });

// list: folders first then files, with size and date; a missing path and a file are answered plainly
const top = await gw.ask("list", { path: "Jobs" });
assert.equal(top.ok, true);
const entries = top.entries as { name: string; kind: string; size?: number; changed: string }[];
assert.deepEqual(
  entries.map((e) => `${e.kind}:${e.name}`),
  ["folder:Big", "folder:Lumi", "folder:Lumi Deck", "folder:Many", "file:huge.bin", "file:middle.bin", "file:notes.txt"],
);
assert.equal(entries.find((e) => e.name === "notes.txt")!.size, 9);
assert.ok(!Number.isNaN(Date.parse(entries[0].changed)));
assert.equal(top.more, 0);
const big = await gw.ask("list", { path: "Jobs\\Big" }); // either slash
assert.equal((big.entries as unknown[]).length, LIST_MAX, "at most 500 entries");
assert.equal(big.more, 100, "and it says how many more");
assert.equal((await gw.ask("list", { path: "Jobs/notes.txt" })).error, "not_a_folder");
assert.equal((await gw.ask("list", { path: "Jobs/nothing-here" })).error, "not_found");
assert.equal((await gw.ask("list", { path: "Elsewhere" })).error, "not_found");
assert.equal((await gw.ask("list", { path: "jobs/lumi" })).ok, true, "names don't care about capitals");

// find: every word in the path, the best match first; at most 200, and it says there were more
const lumi = await gw.ask("find", { words: "lumi quote" });
assert.equal(lumi.ok, true);
assert.deepEqual(
  (lumi.results as { path: string }[]).map((r) => r.path),
  ["Jobs/Lumi/Quote v2.pdf"],
);
const plans = await gw.ask("find", { words: ["lumi"], root: "Jobs" });
assert.ok((plans.results as { path: string }[]).some((r) => r.path === "Jobs/Lumi Deck/plan.pdf"));
assert.equal((plans.results as { path: string }[])[0].path.split("/").pop()!.toLowerCase().includes("lumi"), true, "names that hold the word come first");
const many = await gw.ask("find", { words: "match" });
assert.equal((many.results as unknown[]).length, FIND_MAX);
assert.equal(many.more, true);
assert.equal(many.stopped_early, false);
assert.equal((await gw.ask("find", { words: "" })).error, "bad_request");
assert.equal((await gw.ask("find", { words: "x", root: "Nope" })).error, "not_found");
// it stops after its time limit and says so (the limit is 10 s; 0 here)
const early = await find({ ...safety, roots: config.folders, maxFileBytes: config.maxFileBytes, findMs: -1 }, { words: "match" });
assert.equal(early.stopped_early, true);

// stat
const st = await gw.ask("stat", { path: "Jobs/Lumi/Quote v2.pdf" });
assert.equal(st.kind, "file");
assert.equal(st.size, 14);
assert.equal((await gw.ask("stat", { path: "Jobs/Lumi" })).kind, "folder");

// read: in pieces, byte for byte; over the size limit it isn't read at all
let got = Buffer.alloc(0);
for (let off = 0; ; ) {
  const r = await gw.ask("read", { path: "Jobs/middle.bin", offset: off, length: PIECE_MAX });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  const piece = Buffer.from(String(r.data), "base64");
  assert.ok(piece.length <= PIECE_MAX);
  got = Buffer.concat([got, piece]);
  off += piece.length;
  if (r.eof) break;
}
assert.ok(got.equals(middle), "the pieces put back together are the file");
const huge = await gw.ask("read", { path: "Jobs/huge.bin" });
assert.equal(huge.error, "too_big");
assert.equal(huge.limit, 2 * 1024 * 1024);
assert.equal((await gw.ask("read", { path: "Jobs/Lumi" })).error, "not_a_file");
assert.equal((await gw.ask("read", { path: "Jobs/notes.txt", offset: -1 })).error, "bad_request");

// Nothing but those five: anything else is refused, never guessed at.
for (const op of ["delete", "write", "rename", "run", "move", "exec", "setFolders", ""]) assert.equal((await gw.ask(op, { path: "Jobs/notes.txt" })).error, "unknown_request", op);

// Outside the folder is the same as not there.
assert.equal((await gw.ask("read", { path: "Jobs/../Outside/secret.txt" })).error, "not_found");
assert.equal((await gw.ask("stat", { path: path.join(base, "Outside", "secret.txt") })).error, "not_found");

// The log: one line per request, never a file's contents or the secret.
const log = readFileSync(logFile, "utf8");
assert.match(log, /list "Jobs\\Big" → ok, 500 shown, 100 more/);
assert.match(log, /read "Jobs\/middle.bin" from 0 → ok, 524288 bytes/);
assert.match(log, /refused an unknown request: delete/);
assert.ok(!log.includes("SECRET-CONTENT-123") && !log.includes("ring the plumber"), "no file contents");
assert.ok(!log.includes(SECRET), "no secret");
// kept to its cap: oldest half dropped
const small = path.join(base, "small.log");
const l = makeLog(small, false, 2000);
for (let i = 0; i < 200; i++) l(`line ${i} ${"z".repeat(30)}`);
assert.ok(statSync(small).size <= 2000, `log kept under its cap (${statSync(small).size})`);
assert.match(readFileSync(small, "utf8"), /line 199/);

// The line drops: it dials again by itself.
gw.drop();
await new Promise((r) => setTimeout(r, 50));
await gw.connected();
assert.equal((await gw.ask("roots")).ok, true);
assert.deepEqual(attempts, [1], "one quick retry after a drop");

// Another copy takes over: this one stops for good.
gw.send({ type: "replaced" });
gw.drop(4001);
assert.equal(await helper.done, "replaced");
await gw.close();

// The gateway says no: it waits longer each time, and gets in once it's let.
const gw2 = await fakeGateway({ accept: (_h, n) => n >= 3 });
const waits: number[] = [];
const h2 = startHelper({ config: () => ({ ...config, gateway: gw2.url }), log: () => {}, backoffMs: (n) => (waits.push(n), 10), safety });
await gw2.connected();
assert.deepEqual(waits, [1, 2], "two refusals, then in");
await h2.stop();
await gw2.close();

// Settings: Windows paths pasted with single backslashes are read right; the address must be encrypted unless local.
assert.deepEqual(parseLoose('{"folders": ["C:\\Users\\you\\Documents", "D:\\new jobs\\tiles", "C:\\\\ok\\\\already"]}'), { folders: ["C:\\Users\\you\\Documents", "D:\\new jobs\\tiles", "C:\\ok\\already"] });
assert.deepEqual(foldersFrom(["C:\\Users\\you\\Documents", "D:\\", "E:\\Work\\Documents", { name: "Job files", path: "F:\\J" }, "relative\\x"]), {
  folders: [
    { name: "Documents", dir: "C:\\Users\\you\\Documents" },
    { name: "D drive", dir: "D:\\" },
    { name: "Documents 2", dir: "E:\\Work\\Documents" },
    { name: "Job files", dir: "F:\\J" },
  ],
  problems: ['"relative\\x" needs to be a full folder path, like C:\\Users\\you\\Documents.'],
});
assert.throws(() => checkGateway("ws://desktop-example/helper"), /wss:\/\//);
assert.doesNotThrow(() => checkGateway("wss://desktop-example/helper"));
assert.doesNotThrow(() => checkGateway("ws://127.0.0.1:3078/helper"));
const cfgFile = put("cfg/helper.json", '{"computer":"pc2","gateway":"wss://service.example.com/helper","secret":"s","folders":["C:\\Users\\you\\Documents"]}');
assert.deepEqual(readConfig(cfgFile).folders, [{ name: "Documents", dir: "C:\\Users\\you\\Documents" }]);
assert.equal(readConfig(cfgFile).maxFileBytes, 50 * 1024 * 1024, "50 MB unless helper.json says otherwise");
writeFileSync(cfgFile, '{"computer":"pc2", "gateway": }');
assert.throws(() => readConfig(cfgFile), /isn't written right/);

rmSync(base, { recursive: true, force: true });
console.log("helper: ok");
