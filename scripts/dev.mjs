// Dev gateway: runs the code in this folder on port 3078 against made-up data, beside the live assistant on 3077.
//
//   npm run dev                  fixture data in data-dev/ (built on first run)
//   npm run dev -- --fresh       rebuild data-dev/ first
//   npm run dev -- --fake        scripted fake brain (no model calls)
//   npm run dev -- --voice       allow voice sessions (off by default: they cost money)
//   npm run dev -- --snapshot    a read-only copy of the live data in data-dev-snapshot/ (to see real data; never commit
//                                screenshots from it). Secrets are not copied, so no real account is reachable.
import { savedFolder } from "./earlier.mjs";
import { checkDataFolder } from "./v3-dev.mjs";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const local = process.env.LOCALAPPDATA ?? path.join(ROOT, ".local");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

let dataDir = checkDataFolder(path.join(ROOT, "data-dev"), ROOT);
if (args.has("--snapshot")) {
  if (!process.env.LH_SNAPSHOT_SOURCE) throw new Error("Choose the snapshot source explicitly with LH_SNAPSHOT_SOURCE.");
  const live = realpathSync(path.resolve(process.env.LH_SNAPSHOT_SOURCE));
  dataDir = checkDataFolder(path.join(ROOT, "data-dev-snapshot"), ROOT);
  const actual = existsSync(dataDir) ? realpathSync(dataDir) : dataDir;
  const inside = (child, parent) => {
    const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
    return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  };
  if (inside(live, actual) || inside(actual, live)) throw new Error("The snapshot source and destination must be separate folders.");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const src = new DatabaseSync(path.join(live, "harness.db"), { readOnly: true });
  src.exec(`VACUUM INTO '${path.join(dataDir, "harness.db").replace(/'/g, "''")}'`);
  src.close();
  if (existsSync(path.join(live, "profile"))) cpSync(path.join(live, "profile"), path.join(dataDir, "profile"), { recursive: true });
  console.log(`snapshot of ${live} in ${dataDir} (secrets not copied)`);
} else {
  if (args.has("--fresh")) rmSync(dataDir, { recursive: true, force: true });
  if (!existsSync(dataDir) || !readdirSync(dataDir).length) {
    console.log(`building fixture data in ${dataDir} ...`);
    const r = spawnSync(process.execPath, [TSX, path.join(ROOT, "src", "practice.ts"), dataDir], { stdio: "inherit", cwd: ROOT, env: { ...process.env, LH_DEV: "1", LH_DATA_DIR: dataDir } });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

const env = {
  ...process.env,
  PORT: process.env.PORT ?? "3078",
  LH_DEV: "1",
  LH_DATA_DIR: dataDir,
  LH_BRAIN_CWD: savedFolder(local, "brain-dev"),
  LH_BROWSER_DIR: savedFolder(local, "browser-dev"),
  ...(args.has("--fake") ? { LH_FAKE_BRAIN: "1" } : {}),
  ...(args.has("--voice") ? {} : { LH_NO_VOICE: "1" }),
};
const child = spawn(process.execPath, [TSX, "watch", "src/gateway/server.ts"], { stdio: "inherit", cwd: ROOT, env });
const stop = () => child.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
