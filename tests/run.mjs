// Test runner: runs each test file in its own Node process (so each gets its own throwaway data folder) and reports.
//   node tests/run.mjs          unit tests (tests/unit/**/*.test.ts): no network, no model calls
//   node tests/run.mjs --ui     UI tests (tests/ui/**/*.test.mjs): Playwright against an in-process gateway
//   node tests/run.mjs <filter> only files whose path contains <filter>
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ui = args.includes("--ui");
const filter = args.find((a) => !a.startsWith("--"));
const root = path.join(here, ui ? "ui" : "unit");
const pattern = ui ? /\.test\.mjs$/ : /\.test\.ts$/;

const walk = (dir) => {
  let out = [];
  try {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) out = out.concat(walk(p));
      else if (pattern.test(name)) out.push(p);
    }
  } catch {}
  return out;
};
const files = walk(root).filter((f) => !filter || f.includes(filter)).sort();
if (!files.length) {
  console.log(`no ${ui ? "UI" : "unit"} tests found${filter ? ` matching "${filter}"` : ""}`);
  process.exit(0);
}

const run = (file) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", "--no-warnings", file], { cwd: path.join(here, ".."), env: { ...process.env, LH_QUIET: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0, ms: Date.now() - t0, out });
    });
  });

// A few tests time real waits and can trip on a busy PC. A file that fails gets one more try, by itself, and the
// report says so: a test that fails twice is a failure, and one that needed its second try is named, never hidden.
let failed = 0;
const secondTry = [];
for (const file of files) {
  let r = await run(file);
  const name = path.relative(here, file);
  if (!r.ok && !args.includes("--once")) {
    const first = r;
    r = await run(file);
    if (r.ok) secondTry.push(name);
    else r.out = first.out;
  }
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${name}  (${(r.ms / 1000).toFixed(1)}s)${secondTry.includes(name) ? "  (on its second try)" : ""}`);
  if (!r.ok) {
    failed++;
    console.log(r.out.trimEnd().split("\n").map((l) => `      ${l}`).join("\n"));
  }
}
console.log(`\n${files.length - failed} of ${files.length} passed`);
if (secondTry.length) console.log(`Passed only on a second try (worth a look if it keeps happening): ${secondTry.join(", ")}`);
process.exit(failed ? 1 : 0);
