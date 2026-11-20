// Keeps the safety switch and Tavi running together.
import { spawn, execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import configuration from "./setup/config.cjs";
import { checkDataFolder } from './v3-dev.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function settings(source = process.env, root = ROOT, read = readFileSync) {
  const config = configuration.loadRun(source, root, read);
  const { folder, port, host, run } = config;
  if (run.mode === 'practice') checkDataFolder(folder, root);
  let savedVoiceKey = '';
  if (run.voice) {
    try { savedVoiceKey = configuration.voiceKey(read(config.voiceFile)); } catch (error) {
      if (error.code !== "ENOENT") throw new Error("The optional voice settings file could not be read.");
    }
  }
  // A voice file contributes just the voice key. It cannot change the mode or folder.
  const voiceKey = run.voice ? String(source.OPENAI_API_KEY || savedVoiceKey || '').trim() : '';
  const env = { ...source, PORT: String(port), HOST: host, LH_V3: "1", LH_DEV: run.mode === 'practice' ? '1' : '0',
    LH_DATA_DIR: folder, LH_V3_DATA: folder, LH_V3_DISTRO: run.distro, LH_NO_VOICE: voiceKey ? '0' : '1',
    OPENAI_API_KEY: voiceKey, DOTENV_CONFIG_PATH: path.join(folder, 'no-env-file') };
  for (const key of ['LH_DEV_SCHEDULER', 'LH_DEV_KEEPER', 'LH_DEV_BROWSER', 'LH_DEV_PUSH']) delete env[key];
  return { ...config, env };
}
export async function freePort(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const server = net.createServer(); server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}
export function rotatingLog(file, limit = 5_000_000) {
  mkdirSync(path.dirname(file), { recursive: true });
  return text => {
    const bytes = Buffer.from(text);
    for (let start = 0; start < bytes.length;) {
      let size = existsSync(file) ? statSync(file).size : 0;
      if (size >= limit) { rmSync(file + ".1", { force: true }); renameSync(file, file + ".1"); size = 0; }
      const end = Math.min(bytes.length, start + limit - size);
      appendFileSync(file, bytes.subarray(start, end)); start = end;
    }
  };
}
export function safeOutput(write, env = {}) {
  const hidden = Object.entries(env).filter(([name, value]) => /key|token|secret|password/i.test(name) && typeof value === "string" && value.length).map(([, value]) => value);
  let pending = "", dropping = false;
  const decoder = new StringDecoder("utf8");
  const clean = line => {
    for (const value of hidden) line = line.split(value).join("[hidden]");
    return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/(?:Bearer\s+|sk-)[^\r\n ]+/gi, "[hidden]")
      .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[hidden]");
  };
  const input = part => {
    pending += decoder.write(Buffer.from(part));
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      if (!dropping) write(clean(pending.slice(0, end + 1)));
      dropping = false; pending = pending.slice(end + 1);
    }
    if (pending.length > 65536) { write("A long output line was left out.\n"); pending = ""; dropping = true; }
  };
  input.end = () => { pending += decoder.end(); if (pending && !dropping) write(clean(pending) + "\n"); pending = ""; };
  return input;
}
export async function guardCall(folder, route, method = "GET", timeout = 1500) {
  const secret = readFileSync(path.join(folder, "guard", "secret-local"), "utf8").trim();
  const response = await fetch("http://127.0.0.1:3091" + route, { method, redirect: "error",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: method === "POST" ? "{}" : undefined, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error("The safety switch did not answer.");
  return response.json();
}
async function endChild(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); resolve(); };
    child.once("exit", done);
    if (process.platform === "win32") execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, error => {
      if (error) child.kill();
    });
    else { child.kill("SIGTERM"); timer = setTimeout(() => child.kill("SIGKILL"), 5000); }
  });
}
export async function supervise(options = {}) {
  const root = options.root || ROOT, config = options.config || settings(process.env, root);
  const { folder, port, host, env } = config;
  const free = options.free || freePort;
  if (!await free(port, host) || !await free(3091)) throw new Error("An app or safety-switch port is already taken. Stop that run first.");
  const logs = path.join(folder, "logs"), statusFile = path.join(logs, "tavi-status.json"), runFile = path.join(folder, "tavi-run.json");
  const log = rotatingLog(path.join(logs, "supervisor.log"), options.logLimit);
  const note = reason => { log(`${new Date().toISOString()} ${reason}\n`); writeFileSync(statusFile, JSON.stringify({ name: "Tavi", reason, at: new Date().toISOString() })); };
  const launch = options.launch || ((name) => spawn(process.execPath, ["--import", "tsx", `src/${name === "guard" ? "guard/main" : "gateway/server"}.ts`],
    { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
  const ready = options.ready || (() => guardCall(folder, "/state"));
  const stopSpace = options.stopSpace || (() => guardCall(folder, "/space/stop", "POST", 15000));
  const stopChild = options.stopChild || endChild;
  const guardDelay = options.guardDelay ?? 60000, stable = options.stable ?? 60000, poll = options.poll ?? 250;
  let stopping = false, guard, server, wake, control, stopPromise;
  const pause = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); wake = () => { clearTimeout(timer); resolve(); }; });
  const stop = () => stopPromise ??= (async () => {
    stopping = true; wake?.();
    await stopChild(server);
    if (guard && guard.exitCode === null && guard.signalCode === null) {
      try { await stopSpace(); } catch { note("Could not confirm that the bots stopped. On this PC run npm run guard -- kill."); }
    }
    await stopChild(guard);
    if (control) await new Promise(resolve => { control.close(resolve); });
    rmSync(runFile, { force: true });
  })();
  const token = randomBytes(24).toString("hex");
  const address = process.platform === "win32" ? `\\\\.\\pipe\\tavi-${token}` : path.join(folder, `tavi-${token}.sock`);
  control = net.createServer(socket => {
    socket.setTimeout(2000, () => socket.destroy());
    let input = "";
    socket.on("data", part => {
      input += part;
      if (input.length > 256) return socket.destroy();
      if (input.includes("\n")) {
        if (input.trim() !== token) return socket.destroy();
        socket.end("Stopping Tavi.\n"); void stop();
      }
    });
  });
  await new Promise((resolve, reject) => { control.once("error", reject); control.listen(address, resolve); });
  try {
    if (existsSync(runFile)) {
      const previous = JSON.parse(readFileSync(runFile, 'utf8'));
      try { process.kill(previous.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') rmSync(runFile); else throw error; }
    }
    writeFileSync(runFile, JSON.stringify({ pid: process.pid, address, token, folder, port, distro: config.run?.distro }), { mode: 0o600, flag: 'wx' });
  } catch {
    await new Promise(resolve => control.close(resolve));
    throw new Error('A keeper record is already present. Use status and stop, or check for an interrupted start before trying again.');
  }
  const signal = () => void stop();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(name, signal);
  const message = msg => { if (msg === "stop") void stop(); };
  process.on("message", message);
  const start = name => {
    const child = launch(name), logOutput = rotatingLog(path.join(logs, name + ".log"), options.logLimit);
    const out = safeOutput(logOutput, env), err = safeOutput(logOutput, env);
    child.stdout?.on("data", part => out(part)); child.stderr?.on("data", part => err(part));
    child.once("close", () => { out.end(); err.end(); });
    child.on("error", () => { note(`The ${name === "guard" ? "safety switch" : "app"} could not start.`); });
    return child;
  };
  const alive = child => child && child.pid && child.exitCode === null && child.signalCode === null;
  let guardBackoff = guardDelay, serverBackoff = options.serverDelay ?? 1000;
  note("Starting Tavi and its safety switch.");
  try {
    while (!stopping) {
      const guardStarted = Date.now(); guard = start("guard");
      let answered = false;
      const deadline = Date.now() + (options.readyTimeout ?? 30000);
      while (!stopping && alive(guard) && Date.now() < deadline) {
        try { await ready(); answered = true; break; } catch {}
        await pause(poll);
      }
      if (!stopping && answered && alive(guard)) {
        note("Tavi's safety switch is answering.");
        while (!stopping && alive(guard)) {
          const started = Date.now(); server = start("server");
          while (!stopping && alive(guard) && alive(server)) await pause(poll);
          if (stopping || !alive(guard)) break;
          note("The app stopped. It will be started again.");
          if (Date.now() - started >= stable) serverBackoff = options.serverDelay ?? 1000;
          await pause(serverBackoff); serverBackoff = Math.min(serverBackoff * 2, 30000);
        }
      }
      if (stopping) break;
      await stopChild(server);
      if (alive(guard)) { try { await stopSpace(); } catch {} await stopChild(guard); }
      note("The safety switch will not stay up. Tavi has been stopped too. Check the guard log; another start will be tried after a wait.");
      if (Date.now() - guardStarted >= stable && answered) guardBackoff = guardDelay;
      await pause(Math.max(guardDelay, guardBackoff - (Date.now() - guardStarted)));
      guardBackoff = Math.min(guardBackoff * 2, 15 * 60000);
    }
  } finally {
    await stop();
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.off(name, signal);
    process.off("message", message);
  }
}
export async function stopSupervisor(folder) {
  const file = path.join(folder, "tavi-run.json");
  if (!existsSync(file)) return false;
  const info = JSON.parse(readFileSync(file, "utf8"));
  try { await new Promise((resolve, reject) => {
    const socket = net.createConnection(info.address);
    socket.setTimeout(3000, () => socket.destroy(new Error("Tavi did not accept the stop request.")));
    socket.once("error", reject); socket.once("connect", () => socket.end(info.token + "\n")); socket.once("data", resolve);
  }); } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
    // A dead supervisor can leave its record behind. Its children are found by port next.
    try { process.kill(info.pid, 0); }
    catch (check) { if (check.code === "ESRCH") { rmSync(file, { force: true }); return false; } }
    throw new Error("The saved supervisor is still present but will not accept a stop. Leave it in place and check its log.");
  }
  const until = Date.now() + 30000;
  while (existsSync(file) && Date.now() < until) await sleep(100);
  if (existsSync(file)) throw new Error("Tavi has not finished stopping. Keep the saved switch record and try again.");
  return true;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  supervise().catch(() => { console.error("Tavi could not be kept running. Check its logs and make sure its ports are free."); process.exitCode = 1; });
}
