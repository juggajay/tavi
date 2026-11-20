// "Look, don't touch" (Stage 11.1): the helper's source, and the one file it's shipped as, have no call that writes,
// renames, deletes, copies, makes folders, changes rights or dates, starts a program or listens for connections. The
// only writes are to its own log (helper.log, in log.ts), to the line it opened (ws.ts) and to its own window. Files are
// only ever opened to read. This is the search the plan asks for, kept as a test so it stays true.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.join(repo, "src", "helper");

/** Code without its comments (a comment may say "delete"; code may not). Keeps "wss://" in strings. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}()])\/\/.*$/gm, "$1");

const FORBIDDEN = new RegExp(
  "\\b(" +
    [
      "writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "write", "writeSync", "writev", "writevSync",
      "rename", "renameSync", "unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync",
      "copyFile", "copyFileSync", "cp", "cpSync", "symlink", "symlinkSync", "link", "linkSync", "truncate", "truncateSync", "ftruncate",
      "chmod", "chmodSync", "fchmod", "lchmod", "chown", "chownSync", "fchown", "lchown", "utimes", "utimesSync", "futimes", "lutimes",
      "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "eval", "Function", "Worker", "dlopen",
      "listen", "createServer", "createConnection", "openAsBlob", "watch", "watchFile",
    ].join("|") +
    ")\\s*\\(",
  "g",
);
/** The only writes allowed, and where. */
const ALLOWED: Record<string, RegExp[]> = {
  // (in the shipped file the bundler may rename logFile to logFile2)
  "log.ts": [/appendFileSync\(logFile\d*,/, /writeFileSync\(logFile\d*,/, /process\.stdout\.write\(/],
  "ws.ts": [/sock\.write\(/],
  "main.ts": [/process\.stdout\.write\(/],
};
const BANNED_MODULES = /from "(node:)?(child_process|worker_threads|vm|wasi|cluster|dgram|net|inspector|module|repl|tls)"/;

function check(name: string, text: string, allowed: RegExp[]) {
  const c = code(text);
  const bad: string[] = [];
  for (const m of c.matchAll(FORBIDDEN)) {
    const at = m.index!;
    const around = c.slice(Math.max(0, at - 20), at + 40);
    if (!allowed.some((re) => re.test(around))) bad.push(around.replace(/\s+/g, " ").trim());
  }
  assert.deepEqual(bad, [], `${name}: a call that writes, deletes, runs or listens`);
  assert.ok(!BANNED_MODULES.test(c), `${name}: imports a module for running programs or opening ports`);
  // Files are only ever opened to read.
  for (const m of c.matchAll(/\bopen\s*\(([^)]*)\)/g)) assert.match(m[1], /,\s*"r"\s*$/, `${name}: open() must be read-only: open(${m[1]})`);
  for (const m of c.matchAll(/\b(openSync|createReadStream)\s*\(/g)) assert.fail(`${name}: use open(…, "r") only (${m[0]})`);
  return c;
}

/** Every name the helper may take from Node, so a renamed import ("rm as zap") can't hide a write. */
const MAY_IMPORT: Record<string, string[]> = {
  "node:fs": ["readFileSync", "statSync", "type Dirent"],
  "node:fs/promises": ["open", "readdir", "realpath", "stat"],
  "node:path": ["default"],
  "node:url": ["fileURLToPath"],
  "node:os": ["tmpdir"],
  "node:crypto": ["createHash", "randomBytes"],
  "node:http": ["request as httpRequest", "type IncomingMessage"],
  "node:https": ["request as httpsRequest"],
  "node:stream": ["type Duplex"],
};
const LOG_MAY_IMPORT = ["appendFileSync", "readFileSync", "statSync", "writeFileSync"]; // log.ts, its own log only

const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
assert.deepEqual(files.sort(), ["config.ts", "helper.ts", "log.ts", "main.ts", "ops.ts", "safety.ts", "ws.ts"], "the files this test knows about");
for (const f of files) {
  const text = readFileSync(path.join(dir, f), "utf8");
  check(f, text, ALLOWED[f] ?? []);
  // Only Node's own modules and its own files: nothing from the rest of Tavi (no database, no brain).
  for (const m of text.matchAll(/^import (type )?([^;]*?) from "([^"]+)";/gm)) {
    const [, typeOnly, what, from] = m;
    if (/^\.\/\w+\.js$/.test(from)) continue;
    assert.ok(from.startsWith("node:"), `${f} imports ${from}`);
    if (typeOnly) continue;
    assert.ok(!/\*/.test(what), `${f}: no "import * as" (${what})`);
    const names = what.startsWith("{") ? what.replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean) : ["default"];
    const may = f === "log.ts" && from === "node:fs" ? LOG_MAY_IMPORT : (MAY_IMPORT[from] ?? []);
    for (const n of names) assert.ok(may.includes(n), `${f} takes "${n}" from ${from}, which this test doesn't allow`);
  }
}

// The same search over the file that's shipped.
const bundle = path.join(repo, "dist", "helper", "tavi-helper.mjs");
if (existsSync(bundle)) {
  check("tavi-helper.mjs", readFileSync(bundle, "utf8"), [...ALLOWED["log.ts"], ...ALLOWED["ws.ts"]]);
  console.log("helper-readonly: the bundled file checked too");
} else console.log("helper-readonly: no bundle yet (npm run build:helper); the source was checked");

console.log("helper-readonly: ok");
