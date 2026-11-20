// One turn of the round table's guest (Stage 17.1), run through the owner's Codex program, signed in to his OpenAI plan.
//
// How it is run, every time (tests/unit/guest.test.ts holds this to the letter):
//   codex exec --skip-git-repo-check -s read-only --ignore-user-config --ignore-rules --json -m <model>
//              -c model_reasoning_effort="<effort>" -c web_search="disabled" -c project_doc_max_bytes=0
//              --disable <every tool feature> [resume <session id>] -
// - read-only, and his own Codex settings are never loaded (they bring in computer-control add-ons the guest must never
//   have); nothing in his Codex folder is read or changed by this code. Everything is on the command line.
// - Every tool feature Codex has is switched off. It still names a few in its own prompt, but code mode "fails closed",
//   and any tool use that shows up in the event stream throws the turn away (it's a breach; the turn isn't used).
// - The prompt goes in on stdin; the working folder is an empty one made for the round table.
// - The environment is pared down to what Codex needs to find its login: no OpenAI key (it would bill the pay-per-use
//   account instead of his plan), no Claude key, nothing else of Tavi's.
// - A hard time limit (the whole process tree is stopped when it runs out).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Where the Codex program is. LH_CODEX overrides it (a .mjs/.js file is run with Node: the tests' stand-in). */
export const codexPath = () => process.env.LH_CODEX || path.join(process.env.LOCALAPPDATA ?? "", "Programs", "OpenAI", "Codex", "bin", "codex.exe");

/** Every Codex feature that would give the guest a tool. Switching one off only ever takes something away. */
export const TOOLS_OFF = [
  "shell_tool", "unified_exec", "code_mode_host", "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external",
  "in_app_browser", "computer_use", "image_generation", "view_image", "multi_agent", "multi_agent_v2", "in_app_chat",
  "skill_search", "hooks", "goals", "sleep_tool", "tool_suggest",
] as const;

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The exact arguments for one turn. session: resume that conversation (a later turn); otherwise a new one starts. */
export function codexArgs(o: { model: string; effort: Effort; session?: string | null }): string[] {
  if (!/^[\w.-]{1,40}$/.test(o.model)) throw new Error(`not a model name: ${o.model}`);
  if (!EFFORTS.includes(o.effort)) throw new Error(`not an effort: ${o.effort}`);
  if (o.session && !/^[\w-]{1,80}$/.test(o.session)) throw new Error("not a session id");
  return [
    "exec",
    "--skip-git-repo-check",
    "-s", "read-only",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "-m", o.model,
    "-c", `model_reasoning_effort="${o.effort}"`,
    "-c", 'web_search="disabled"',
    "-c", "project_doc_max_bytes=0",
    ...TOOLS_OFF.flatMap((f) => ["--disable", f]),
    ...(o.session ? ["resume", o.session] : []),
    "-",
  ];
}

/** What the child process may see: enough to run and find his Codex login, nothing of Tavi's. */
const PASS_ENV = ["SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATH", "Path", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "LOCALAPPDATA", "APPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "TEMP", "TMP", "USERNAME", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "CODEX_HOME"];
export function childEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASS_ENV) if (from[k] !== undefined) env[k] = from[k];
  // the tests' stand-in reads where to write its log; never set in real use
  if (from.FAKE_CODEX_LOG) env.FAKE_CODEX_LOG = from.FAKE_CODEX_LOG;
  if (from.FAKE_CODEX_MODE) env.FAKE_CODEX_MODE = from.FAKE_CODEX_MODE;
  return env;
}

export type CodexFail = "missing" | "signed_out" | "timeout" | "tool" | "failed";
export type CodexResult =
  | { ok: true; text: string; session: string; ms: number; usage: Record<string, number> | null }
  | { ok: false; why: CodexFail; detail: string; session: string | null; ms: number };

/** Plain words for the owner when the guest can't answer. */
export function failLine(why: CodexFail, name: string) {
  if (why === "missing") return `${name} isn't available: I can't find the Codex program on this PC. I'll carry on by myself.`;
  if (why === "signed_out") return `${name} isn't available: Codex isn't signed in to your OpenAI account. I'll carry on by myself.`;
  if (why === "timeout") return `${name}'s taking too long.`;
  if (why === "tool") return `${name} tried to use a tool, which he isn't allowed to, so I've left that one out.`;
  return `${name} couldn't answer just now.`;
}

/** Item kinds in Codex's event stream that are words, not actions. Anything else is a tool being used. */
const WORDS = new Set(["agent_message", "reasoning", "error"]);

/** The JSON lines Codex prints, read into the answer. */
export function readEvents(out: string) {
  let session: string | null = null;
  const texts: string[] = [];
  let usage: Record<string, number> | null = null;
  let failed: string | null = null;
  const tools: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let e: { type?: string; thread_id?: string; item?: { type?: string; text?: string; message?: string }; usage?: Record<string, number>; error?: { message?: string }; message?: string };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "thread.started" && e.thread_id) session = e.thread_id;
    else if ((e.type === "item.completed" || e.type === "item.started") && e.item) {
      if (!WORDS.has(e.item.type ?? "")) tools.push(e.item.type ?? "unknown");
      else if (e.type === "item.completed" && e.item.type === "agent_message" && e.item.text) texts.push(e.item.text);
    } else if (e.type === "turn.completed") usage = e.usage ?? null;
    else if (e.type === "turn.failed") failed = e.error?.message ?? "turn failed";
    else if (e.type === "error") failed = e.message ?? "error";
  }
  return { session, text: texts.join("\n\n").trim(), usage, failed, tools: [...new Set(tools)] };
}

const SIGNED_OUT = /not (logged|signed) in|log ?in again|please (log|sign) in|unauthori[sz]ed|\b401\b|authentication|refresh token|expired token/i;

/** Stop the process and anything it started (Windows keeps children alive otherwise). */
function stopTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
  else
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
}

/** Run one turn. Never throws: a failure comes back as { ok: false, why }. signal: the owner cut in, so stop it now. */
export function runCodex(o: { prompt: string; model: string; effort: Effort; session?: string | null; cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<CodexResult> {
  const t0 = Date.now();
  const file = codexPath();
  const session = o.session ?? null;
  if (!existsSync(file)) return Promise.resolve({ ok: false, why: "missing", detail: `no program at ${file}`, session, ms: 0 });
  const args = codexArgs(o);
  const node = /\.(m?js)$/i.test(file); // the tests' stand-in
  return new Promise((resolve) => {
    let out = "",
      err = "",
      done = false;
    const finish = (r: CodexResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(node ? process.execPath : file, node ? [file, ...args] : args, { cwd: o.cwd, env: childEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      stopTree(child.pid);
      finish({ ok: false, why: "timeout", detail: `over ${Math.round(o.timeoutMs / 1000)} s`, session: readEvents(out).session ?? session, ms: Date.now() - t0 });
    }, o.timeoutMs);
    const onAbort = () => {
      stopTree(child.pid);
      finish({ ok: false, why: "failed", detail: "stopped: the owner cut in", session: readEvents(out).session ?? session, ms: Date.now() - t0 });
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) => finish({ ok: false, why: e.code === "ENOENT" ? "missing" : "failed", detail: e.message, session, ms: Date.now() - t0 }));
    child.on("close", (code) => {
      const ev = readEvents(out);
      const ms = Date.now() - t0;
      const sid = ev.session ?? session;
      if (ev.tools.length) return finish({ ok: false, why: "tool", detail: `used: ${ev.tools.join(", ")}`, session: sid, ms });
      if (ev.text && code === 0 && sid) return finish({ ok: true, text: ev.text, session: sid, ms, usage: ev.usage });
      const detail = (ev.failed ?? err.trim().split(/\r?\n/).slice(-3).join(" ")) || `exit ${code}`;
      finish({ ok: false, why: SIGNED_OUT.test(`${detail} ${err}`) ? "signed_out" : "failed", detail: detail.slice(0, 400), session: sid, ms });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(o.prompt);
  });
}

/** Archive a round table's Codex conversation once it's over (never deleted): it stays in his Codex history, tidied away. */
export function archiveCodex(session: string): Promise<boolean> {
  const file = codexPath();
  if (!existsSync(file) || !/^[\w-]{1,80}$/.test(session)) return Promise.resolve(false);
  const node = /\.(m?js)$/i.test(file);
  return new Promise((resolve) => {
    const child = spawn(node ? process.execPath : file, node ? [file, "archive", session] : ["archive", session], { env: childEnv(), windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => (stopTree(child.pid), resolve(false)), 20_000);
    child.on("error", () => (clearTimeout(timer), resolve(false)));
    child.on("close", (code) => (clearTimeout(timer), resolve(code === 0)));
  });
}
