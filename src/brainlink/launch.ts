// Starting The Brain when a job needs it and it isn't running (Stage 16.1), hidden (no window), never a second copy,
// and remembering that the assistant started it (so it may stop it again later, but only if nothing is running and
// the owner asks).
//
// Its own start command, start-brain.cmd, does three things in ui\: `npm install` if ui\node_modules is missing, open
// the owner's browser at its page after 6 seconds, then `npm run dev` (next dev on port 3877). The link runs only the
// last of those, the same way: an install could change its folder, and a browser popping up on the PC (whose page
// then calls the app by itself) isn't wanted when he's not there. If its parts aren't installed it says so instead.
import { spawn, execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DEV } from "../dev.js";
import { DATA_DIR } from "../store/db.js";
import { audit } from "../store/log.js";
import { getSetting, setSetting } from "../store/proactive.js";
import { brainHome, brainUrl, mayStart } from "./config.js";
import { answering, doctor, listJobs } from "./client.js";
import { activeTurn } from "./state.js";

export type StartCmd = { cmd: string; args: string[]; cwd: string; env?: Record<string, string> };
export const LOG = () => path.join(DATA_DIR, "brainlink", "the-brain.log");
const RECORD = "brainlink_started"; // internal: { pid, at } of the copy the assistant started

/**
 * How to start it: its own `npm run dev` in ui\, which is `next dev -p 3877` (read from its package.json each time, so
 * it stays in step). That's run straight through Node: a hidden child started through cmd and npm on Windows loses
 * its output (so a failed start couldn't say why). Tests and the read-only check can name a stand-in.
 */
export function startCommand(): StartCmd | { error: string } {
  if (process.env.LH_BRAINLINK_START_CMD) return JSON.parse(process.env.LH_BRAINLINK_START_CMD) as StartCmd;
  if (DEV && process.env.LH_DEV_BRAINLINK_START !== "1") return { error: "Dev mode never starts the real Brain." };
  const home = brainHome();
  if (!home) return { error: "The Brain is not set up. Choose its folder in Settings." };
  if (!home) return { error: "The Brain is not set up. Choose its folder in Settings." };
  const ui = path.join(home, "ui");
  if (!existsSync(path.join(home, "start-brain.cmd")) || !existsSync(path.join(ui, "package.json"))) return { error: `The Brain isn't where I expected it (${home}).` };
  if (!existsSync(path.join(ui, "node_modules"))) return { error: "The Brain's parts aren't installed, and its start command would install them first, which I won't do. Start it once yourself on the PC." };
  let dev = "";
  try {
    dev = String((JSON.parse(readFileSync(path.join(ui, "package.json"), "utf8")) as { scripts?: { dev?: string } }).scripts?.dev ?? "");
  } catch {}
  const next = path.join(ui, "node_modules", "next", "dist", "bin", "next");
  const m = /^next\s+(dev(?:\s+[\w.=:-]+)*)\s*$/.exec(dev.trim());
  if (m && existsSync(next)) return { cmd: process.execPath, args: thisPcOnly([next, ...m[1].split(/\s+/)]), cwd: ui };
  return { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm run dev"], cwd: ui };
}

/**
 * Its own `next dev -p 3877` listens on every network address, and its API has no login, so anything on the same
 * Wi-Fi could read his jobs or start one. When the assistant starts it, it listens on this PC only (the link talks to
 * 127.0.0.1). A host it names itself is left alone. Nothing in its folder changes; this is only how we start it.
 */
export function thisPcOnly(args: string[]): string[] {
  return args.some((a) => a === "-H" || a === "--hostname" || a.startsWith("--hostname=")) ? args : [...args, "-H", "127.0.0.1"];
}

type Record_ = { pid: number; at: number };
function record(): Record_ | null {
  try {
    const r = JSON.parse(getSetting(RECORD)) as Record_;
    return Number.isInteger(r.pid) && r.pid > 0 ? r : null;
  } catch {
    return null;
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
};
/** The assistant started the copy that's running now. */
export const startedByUs = () => {
  const r = record();
  return !!r && alive(r.pid);
};

/** Something is listening on its port (it may still be starting up, so not answering yet). */
function portTaken(): Promise<boolean> {
  const base = brainUrl();
  if (!base) return Promise.resolve(false);
  const u = new URL(base);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    const done = (v: boolean) => (s.destroy(), resolve(v));
    s.setTimeout(1000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function logTail(n = 6) {
  try {
    const t = readFileSync(LOG(), "utf8").trim().split(/\r?\n/).slice(-n).join(" | ");
    return t.slice(-600);
  } catch {
    return "";
  }
}

export type Ready = { ok: true; started: boolean; ms: number } | { ok: false; error: string; notAllowed?: boolean };
let launching: Promise<Ready> | null = null;

/**
 * Make sure it's answering: if it is, nothing to do; if not and the setting allows, start it hidden and wait until its
 * readiness check (/api/doctor) answers, up to limitMs. Callers at the same time share one start.
 */
export async function ensureRunning(o: { limitMs?: number } = {}): Promise<Ready> {
  if (await answering()) return { ok: true, started: false, ms: 0 };
  if (launching) return launching;
  launching = launch(o.limitMs ?? 150_000).finally(() => (launching = null));
  return launching;
}

async function launch(limitMs: number): Promise<Ready> {
  if (!brainUrl()) return { ok: false, error: "The Brain is not set up, or its link is off in practice mode." };
  if (!mayStart()) return { ok: false, notAllowed: true, error: "The Brain isn't running, and your settings say I mustn't start it." };
  const t0 = Date.now();
  const rec = record();
  let exited: number | null = null;
  // A copy is already on its way up (one we started a moment ago, or anything holding its port): wait for that one.
  const onItsWay = (rec && alive(rec.pid) && Date.now() - rec.at < limitMs) || (await portTaken());
  if (!onItsWay) {
    const c = startCommand();
    if ("error" in c) return { ok: false, error: c.error };
    mkdirSync(path.dirname(LOG()), { recursive: true });
    const out = openSync(LOG(), "a");
    let child;
    try {
      child = spawn(c.cmd, c.args, { cwd: c.cwd, env: { ...process.env, ...c.env }, detached: true, windowsHide: true, stdio: ["ignore", out, out] });
    } catch (err) {
      closeSync(out);
      return { ok: false, error: `It wouldn't start: ${err instanceof Error ? err.message : String(err)}` };
    }
    closeSync(out);
    if (!child.pid) return { ok: false, error: "It wouldn't start (no process)." };
    child.on("exit", (code) => (exited = code ?? -1));
    child.on("error", () => (exited = -1));
    child.unref();
    setSetting(RECORD, JSON.stringify({ pid: child.pid, at: Date.now() }));
    audit("system", "brainlink.app_started", null, { pid: child.pid, cwd: c.cwd });
  }
  while (Date.now() - t0 < limitMs) {
    if (exited !== null) {
      setSetting(RECORD, "");
      const tail = logTail();
      return { ok: false, error: `It stopped straight after starting (code ${exited}).${tail ? ` Its last words: ${tail}` : ""}` };
    }
    const d = await doctor(20_000);
    if (d.ok) return { ok: true, started: true, ms: Date.now() - t0 };
    await sleep(1000);
  }
  return { ok: false, error: `It didn't answer within ${Math.round(limitMs / 1000)} seconds of starting.${logTail() ? ` Its last words: ${logTail()}` : ""}` };
}

/**
 * Stop the copy the assistant started: only that one, only when nothing is running through the link or in The Brain,
 * and only when the owner asked (the tool checks that). Returns what happened, in plain words.
 */
export async function stopOurs(): Promise<{ ok: boolean; say: string }> {
  const r = record();
  if (!r || !alive(r.pid)) return { ok: false, say: "I didn't start the copy that's running (or it's not running), so I'll leave it." };
  if (activeTurn()) return { ok: false, say: "It's working on a job for you right now, so I'll leave it running." };
  const jobs = await listJobs();
  if (jobs.ok && jobs.data.jobs.some((j) => j.status === "running")) return { ok: false, say: "It's working on a job right now, so I'll leave it running." };
  await new Promise<void>((resolve) =>
    process.platform === "win32" ? execFile("taskkill", ["/PID", String(r.pid), "/T", "/F"], { windowsHide: true }, () => resolve()) : (process.kill(-r.pid, "SIGTERM"), resolve()),
  );
  for (let i = 0; i < 20 && (await portTaken()); i++) await sleep(500);
  setSetting(RECORD, "");
  audit("system", "brainlink.app_stopped", null, { pid: r.pid });
  return (await portTaken()) ? { ok: false, say: "I asked it to stop, but something is still on its address." } : { ok: true, say: "Stopped The Brain (the copy I started)." };
}

/** Size of its start-up log, for the notes. */
export const logBytes = () => {
  try {
    return statSync(LOG()).size;
  } catch {
    return 0;
  }
};
