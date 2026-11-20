// A saved record lets the way back finish even after a failed switch.
import { earlier } from "./earlier.mjs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, freePort, sleep, stopSupervisor, guardCall } from "./tavi-supervise.mjs";

const execute = promisify(execFile);
export function argumentsFor(args) {
  const values = { live: ROOT, taviData: path.join(ROOT, "data-v3"), port: 3077, practicePort: 3100, yes: false };
  const flags = { "--live": "live", "--tavi-data": "taviData", "--port": "port", "--practice-port": "practicePort", "--commit": "commit" };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") values.yes = true;
    else if (arg === "--dry-run") values.dryRun = true;
    else if (flags[arg] && args[i + 1] && !args[i + 1].startsWith("--") && !seen.has(arg)) {
      seen.add(arg); values[flags[arg]] = args[++i];
    } else throw new Error("Use --live, --tavi-data, --port, --practice-port, --commit, --dry-run or --yes.");
  }
  values.live = path.resolve(values.live); values.taviData = path.resolve(values.taviData);
  for (const name of ["port", "practicePort"]) {
    values[name] = Number(values[name]);
    if (!Number.isInteger(values[name]) || values[name] < 1 || values[name] > 65535 || values[name] === 3091) throw new Error("Choose an app port between 1 and 65535, other than 3091.");
  }
  if (values.port === values.practicePort) throw new Error("The live and practice ports must be different.");
  values.yes &&= !values.dryRun;
  return values;
}
export const recordFile = options => options.taviData + ".switch.json";
const json = file => JSON.parse(readFileSync(file, "utf8"));
export function saveRecord(file, record) {
  writeFileSync(file + ".new", JSON.stringify(record, null, 2), { mode: 0o600 }); renameSync(file + ".new", file);
}
function noLinks(folder) {
  const full = path.resolve(folder);
  for (let current = full;; current = path.dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error("Use ordinary folders, without file links.");
    if (path.dirname(current) === current) break;
  }
  return realpathSync(full);
}
export function checkFolders(options) {
  const live = noLinks(options.live), tavi = noLinks(options.taviData);
  const old = path.join(live, "data");
  noLinks(old);
  const a = live.toLowerCase(), b = tavi.toLowerCase();
  if (a === b || b.startsWith(a + path.sep) || a.startsWith(b + path.sep)) throw new Error("Keep Tavi's data outside the live folder, so v2's data stays separate.");
  return { live, tavi, old };
}
export function fileHashes(folder) {
  const hashes = {};
  const visit = (dir, rel = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(rel, entry.name), file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("A data backup cannot include file links.");
      if (entry.isDirectory()) visit(file, name);
      else hashes[name] = createHash("sha256").update(readFileSync(file)).digest("hex");
    }
  };
  visit(folder); return hashes;
}
export function backupData(from, to) {
  mkdirSync(to, { recursive: false });
  for (const name of ["harness.db", "harness.db-wal", "harness.db-shm", "profile"]) {
    const source = path.join(from, name);
    if (!existsSync(source)) { if (name === "harness.db") throw new Error("The live database is missing."); continue; }
    if (lstatSync(source).isSymbolicLink()) throw new Error("The live data contains a file link.");
    if (lstatSync(source).isDirectory()) fileHashes(source);
    cpSync(source, path.join(to, name), { recursive: true, errorOnExist: true, force: false });
  }
  const copied = fileHashes(to);
  for (const [name, hash] of Object.entries(copied)) {
    if (createHash("sha256").update(readFileSync(path.join(from, name))).digest("hex") !== hash)
      throw new Error("The live data changed during its backup. Nothing has been stopped; try again.");
  }
  for (const name of ["harness.db-wal", "harness.db-shm"]) if (existsSync(path.join(from, name)) !== existsSync(path.join(to, name)))
    throw new Error("The live database changed during its backup. Try again before switching.");
}
export function processIds(rows, connections, live, port) {
  const normal = text => String(text || "").replaceAll("\\", "/").toLowerCase();
  const root = normal(live).replace(/\/$/, "");
  const inside = row => normal(row.CommandLine).includes(root + "/");
  const byId = new Map(rows.map(row => [Number(row.ProcessId), row]));
  const listeners = connections.filter(c => Number(c.LocalPort) === port && c.State === "Listen");
  const isSupervisor = row => /(?:^|[ /])(?:tavi-)?supervise\.mjs(?:[ "']|$)/i.test(normal(row.CommandLine));
  const supervisors = rows.filter(row => inside(row) && isSupervisor(row));
  const ids = new Set(supervisors.map(row => Number(row.ProcessId)));
  for (const listener of listeners) {
    let row = byId.get(Number(listener.OwningProcess)), found = false;
    const chain = [];
    for (let count = 0; row && count < 12; count++, row = byId.get(Number(row.ParentProcessId))) {
      chain.push(row);
      if (ids.has(Number(row.ProcessId))) { found = true; break; }
    }
    const belongs = chain.some(row => inside(row)) && chain.some(row => /src\/gateway\/server\.ts/.test(normal(row.CommandLine)));
    if (!found && !belongs)
      throw new Error("The live port belongs to another program. It has been left alone.");
    for (const ancestor of chain) if (isSupervisor(ancestor)) ids.add(Number(ancestor.ProcessId));
    ids.add(Number(listener.OwningProcess));
  }
  // A desktop is selected by its connection and its own path, never its name alone.
  for (const c of connections.filter(c => Number(c.RemotePort) === port && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(c.RemoteAddress))) {
    const row = byId.get(Number(c.OwningProcess));
    if (row && (inside(row) && /desktop/.test(normal(row.CommandLine)) || ["tavi", earlier.words.toLowerCase(), earlier.joined].some(name => normal(row.ExecutablePath).endsWith("/" + name + ".exe") || normal(row.ExecutablePath).includes("/" + name + "/")))) {
      let main = row;
      for (let count = 0; count < 12; count++) {
        const parent = byId.get(Number(main.ParentProcessId));
        if (!parent || !main.ExecutablePath || normal(parent.ExecutablePath) !== normal(main.ExecutablePath)) break;
        main = parent;
      }
      ids.add(Number(main.ProcessId));
    }
  }
  return [...ids].filter(id => {
    let parent = byId.get(Number(byId.get(id)?.ParentProcessId));
    for (let count = 0; parent && count < 12; count++, parent = byId.get(Number(parent.ParentProcessId))) if (ids.has(Number(parent.ProcessId))) return false;
    return true;
  });
}
export function systemOperations(options, adapter = {}) {
  const executeCommand = adapter.execute || execute;
  const startProgram = adapter.spawn || spawn;
  const portFree = adapter.free || freePort;
  const stopOwned = adapter.stopSupervisor || stopSupervisor;
  const safetyCall = adapter.guardCall || guardCall;
  const run = async (program, args, cwd = options.live, env = process.env) => {
    try { return (await executeCommand(program, args, { cwd, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
    catch { throw new Error("A required command failed. Check the saved step and use the rollback command."); }
  };
  const powershell = script => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  const git = (...args) => run("git", args);
  return {
    git, free: freePort, backup: backupData,
    async stop() {
      await stopOwned(options.taviData);
      if ((adapter.platform || process.platform) !== "win32") throw new Error("The live switch is for this Windows PC.");
      const details = JSON.parse(await powershell("$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath); $ports = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Select-Object LocalPort,RemotePort,RemoteAddress,OwningProcess,@{n='State';e={$_.State.ToString()}}); @{rows=$rows;ports=$ports} | ConvertTo-Json -Depth 4 -Compress"));
      const ids = processIds(details.rows, details.ports, options.live, options.port);
      for (const pid of ids) await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
      if (!await portFree(options.port)) throw new Error("The live app has not stopped. It has been left in place.");
    },
    async stopGuard() {
      if (await portFree(3091)) return;
      await safetyCall(options.taviData, "/space/stop", "POST", 30000);
      // A guard left after a broken supervisor is selected by the port and this data folder.
      const details = JSON.parse(await powershell("@{rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine);ports=@(Get-NetTCPConnection -LocalPort 3091 -State Listen | Select-Object OwningProcess)} | ConvertTo-Json -Depth 4 -Compress"));
      for (const connection of details.ports) {
        const row = details.rows.find(row => row.ProcessId === connection.OwningProcess);
        if (!row || !/src[\\/]guard[\\/]main\.ts/.test(row.CommandLine || "")) throw new Error("The safety-switch port belongs to another program.");
        await run("taskkill.exe", ["/PID", String(row.ProcessId), "/T", "/F"]);
      }
    },
    async carry() { await run(process.execPath, [path.join(ROOT, "scripts", "carry-over.mjs"), "--from", path.join(options.live, "data"), "--to", options.taviData, "--yes"], ROOT); },
    async build() {
      // Installed packages are enough; no package download is part of the switch.
      await run(process.execPath, [path.join(options.live, "ui", "node_modules", "vite", "bin", "vite.js"), "build"], path.join(options.live, "ui"));
      await run(process.execPath, [path.join(options.live, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]);
      await run(process.execPath, [path.join(options.live, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "ui"]);
    },
    async autostart(tavi) {
      await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "tavi-install-autostart.ps1"), "-Root", options.live, "-Install", ...(tavi ? [] : ["-Classic"])], options.live);
    },
    async start(tavi) {
      const child = startProgram("wscript.exe", [path.join(options.live, "scripts", tavi ? "tavi-start-hidden.vbs" : "start-hidden.vbs")],
        { cwd: options.live, env: { ...process.env, PORT: String(options.port), LH_V3: tavi ? "1" : "0", LH_DEV: "0", DOTENV_CONFIG_PATH: path.join(options.live, ".env"), LH_DATA_DIR: tavi ? options.taviData : path.join(options.live, "data"), LH_V3_DATA: options.taviData }, windowsHide: true, detached: true, stdio: "ignore" });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
    },
    verify: tavi => verifyRunning(options.port, tavi),
  };
}
export async function verifyRunning(port, tavi, request = fetch, wait = sleep, timeout = 180000) {
  const base = `http://127.0.0.1:${port}`;
  const get = async (route, body) => {
    const response = await request(base + route, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { Origin: base, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error("A page or check did not answer.");
    return route === "/" || route === "/desktop" ? response.text() : response.json();
  };
  const until = Date.now() + timeout;
  let state;
  while (Date.now() < until) {
    try {
      const health = await get("/api/health"); if (health.ok !== true) throw new Error();
      if (!(await get("/")) || !(await get("/desktop"))) throw new Error();
      if (tavi) {
        const safety = await get("/api/hq/safety"); state = await get("/api/hq/state");
        if (safety.level !== "open" || state.on !== true || state.guard !== "up" || state.toolbox !== "up") throw new Error();
        const lead = state.bots?.find(bot => bot.lead);
        if (!lead || (await get(`/api/hq/bots/${lead.id}/engine`)).status !== "ready") throw new Error();
      }
      break;
    } catch { await wait(500); }
  }
  if (Date.now() >= until) throw new Error("The app did not become ready. Use the rollback command.");
  if (!tavi) return;
  const lead = state.bots.find(bot => bot.lead);
  const job = await get(`/api/hq/bots/${lead.id}/messages`, { text: "Say hello in five words.", test: true });
  if (typeof job.job_id !== "string" || !job.job_id) throw new Error("The lead bot did not accept the test message.");
  while (Date.now() < until) {
    const result = await get(`/api/hq/bots/${lead.id}/rows?job=${encodeURIComponent(job.job_id)}`);
    const rows = result.rows || [];
    if (rows.some(row => row.body?.kind === "notice" && row.body.tone !== "info")) throw new Error("The test message failed. Use the rollback command.");
    if (rows.some(row => row.body?.kind === "message" && row.body.from === "bot" && row.body.streaming === false && row.body.text?.trim())) return;
    await wait(500);
  }
  throw new Error("The lead bot did not finish its test answer. Use the rollback command.");
}
export async function preflight(options, ops, print) {
  checkFolders(options);
  if (existsSync(recordFile(options))) throw new Error("A switch record already exists. Use the rollback command before another switch.");
  if (await ops.git("status", "--porcelain")) throw new Error("The live folder has unsaved code changes. Leave them in place and finish them first.");
  const commit = await ops.git("rev-parse", "--verify", `${options.commit || "HEAD"}^{commit}`);
  const before = await ops.git("rev-parse", "HEAD");
  await ops.git("merge-base", "--is-ancestor", before, commit);
  for (const file of ["scripts/tavi-supervise.mjs", "scripts/tavi-start-hidden.vbs", "scripts/carry-over.mjs"]) await ops.git("cat-file", "-e", `${commit}:${file}`);
  if (await ops.git("tag", "--list", "pre-tavi")) throw new Error("The pre-tavi tag already exists. Keep it; use the rollback command or have its earlier switch reviewed first.");
  if (!await ops.free(options.practicePort) || !await ops.free(3091)) throw new Error("The practice app or safety switch is still running. Stop the practice run first.");
  const guard = path.join(options.taviData, "guard");
  if (!existsSync(guard)) throw new Error("WARNING: the safety-switch folder is missing. Try Tavi and set its PIN first.");
  let pin; try { pin = json(path.join(guard, "pin.json")); } catch {}
  if (!pin || !/^[a-f0-9]{32}$/.test(pin.salt) || !/^[a-f0-9]{128}$/.test(pin.hash)) throw new Error("WARNING: the safety PIN is missing or damaged. Set it in the practice app first.");
  let status; try { status = json(path.join(options.taviData, "logs", "tavi-practice-status.json")); } catch {}
  if (!status || !Number.isFinite(Date.parse(status.at)) || status.data !== options.taviData || !["anthropic", "openai-codex"].every(provider => status.subscriptions?.[provider] === true))
    throw new Error("Both subscriptions must report signed in during the last practice run. Open the practice app and check them, then stop it.");
  print(`1. Checks passed. Code: ${before} to ${commit}. Both subscriptions last checked ${status.at}. Practice app stopped; safety PIN set.`);
  return { before, commit };
}
export const steps = [
  "Tag the old code pre-tavi; back up its database and profile.",
  "Stop the desktop, supervisor and server found through the live port and their own paths.",
  "Carry the final v2 data into Tavi, keeping Tavi's team and sign-ins.",
  "Fast-forward the live code; build both apps and check the code.",
  "Point Windows sign-in at Tavi; start it; check both apps, the safety switch, team and a typed test answer.",
  "Print the switch record and the command for the way back.",
];
export async function switchTavi(options, supplied = {}, print = console.log) {
  const ops = { ...systemOperations(options), ...supplied };
  const checked = await preflight(options, ops, print);
  steps.forEach((step, index) => print(`${index + 2}. ${step}`));
  if (!options.yes) { print("Dry run only. Nothing changed. Add --yes after reviewing these steps."); return; }
  const file = recordFile(options), configFile = path.join(options.live, "tavi-launch.json");
  const record = { ...checked, live: options.live, taviData: options.taviData, port: options.port, started: new Date().toISOString(), step: 1,
    backup: options.taviData + `.v2-backup-${Date.now()}`, originalConfig: existsSync(configFile) ? readFileSync(configFile, "utf8") : null };
  writeFileSync(file, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
  const step = async (number, action) => { record.step = number; saveRecord(file, record); await action(); record.completed = number; saveRecord(file, record); };
  try {
    await step(2, async () => { await ops.git("tag", "pre-tavi"); record.tagged = true; saveRecord(file, record); await ops.backup(path.join(options.live, "data"), record.backup); });
    await step(3, () => ops.stop());
    await step(4, () => ops.carry());
    await step(5, async () => { await ops.git("merge", "--ff-only", record.commit); await ops.build(); });
    await step(6, async () => {
      saveRecord(configFile, { data: options.taviData, port: options.port, host: "127.0.0.1" });
      await ops.autostart(true); await ops.start(true); await ops.verify(true);
    });
    record.completed = 7; record.finished = new Date().toISOString(); saveRecord(file, record);
    print(`7. Switch record: ${record.finished}. Old code ${record.before}; Tavi ${record.commit}. Backup: ${record.backup}. Health, phone, desktop, safety switch, team and typed test answer passed. Phone and voice still need the owner's check.`);
    print(`Way back: node scripts/tavi-rollback.mjs --live "${options.live}" --tavi-data "${options.taviData}" --port ${options.port} --yes`);
  } catch {
    throw new Error(`Stopped at step ${record.step}. Saved record: ${file}. Keep both data folders. Undo with node scripts/tavi-rollback.mjs --live "${options.live}" --tavi-data "${options.taviData}" --port ${options.port} --yes`);
  }
}
export async function main(args = process.argv.slice(2), supplied, print = console.log) {
  try {
    const options = argumentsFor(args);
    if (!options.commit) options.commit = supplied?.target || (await execute("git", ["rev-parse", "HEAD"], { cwd: ROOT, windowsHide: true })).stdout.trim();
    await switchTavi(options, supplied, print); return 0;
  } catch (error) { print(error.message); return 2; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
