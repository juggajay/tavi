import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { childEnv, codexArgs, codexPath } from "../guest/codex.js";

export function webArgs(live: boolean, model = "gpt-6.1-sol"): string[] {
  return codexArgs({ model, effort: "low" }).map((arg) => arg === 'web_search="disabled"' && live ? 'web_search="live"' : arg).toSpliced(1, 0, "--ephemeral");
}

export async function codexText(prompt: string, signal: AbortSignal, live: boolean, model?: string): Promise<{ text: string; usage: number }> {
  signal.throwIfAborted();
  const cwd = await mkdtemp(path.join(tmpdir(), "tavi-web-"));
  try {
    return await new Promise((resolve, reject) => {
      const file = codexPath(), node = /\.m?js$/i.test(file);
      const args = webArgs(live, model);
      const child = spawn(node ? process.execPath : file, node ? [file, ...args] : args, {
        cwd, env: childEnv(), windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"],
      });
      let out = "", breach = false, stopping = false;
      const stop = () => {
        if (stopping) return; stopping = true;
        if (!child.pid) return;
        if (process.platform === "win32") execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, () => { child.kill(); });
        else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      };
      const abort = () => stop();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on("data", (data: Buffer) => {
        out += data.toString();
        if (out.length > 1_000_000) { breach = true; stop(); }
      });
      child.once("error", () => { signal.removeEventListener("abort", abort); reject(new Error("The research program could not start. Check the sign-in on the PC or try again later.")); });
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) return reject(new Error("The look-up stopped. Try a narrower question later."));
        let text = "", usage = 0, searched = false;
        for (const line of out.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "turn.failed" || event.type === "error") breach = true;
            const item = event.item;
            if (item && ["item.started", "item.completed"].includes(event.type)) {
              if (item.type === "agent_message" && event.type === "item.completed") text = item.text;
              else if (item.type === "web_search" && live) {
                searched = true;
                if (item.action?.type && item.action.type !== "search") breach = true;
              } else if (!["agent_message", "reasoning"].includes(item.type)) breach = true;
            }
            if (event.usage) usage += (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0);
          } catch { breach = true; }
        }
        if (code !== 0 || breach || !text || live && !searched) reject(new Error("The research reply could not be checked. Try another public source or try again later."));
        else resolve({ text, usage });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(prompt);
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
