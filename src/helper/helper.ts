// The helper's line to the assistant. It calls OUT to the gateway (wss://<main PC>.ts.net/helper, through Tailscale,
// the same address and encryption the phone uses) and keeps the line open; it listens on no port. It says who it is,
// answers the five requests in ops.ts, and refuses anything else. If the gateway says no, or the line drops, it waits
// and tries again, the wait growing to a minute at most.
import { VERSION, type Config } from "./config.js";
import type { Log } from "./log.js";
import { find, list, OpError, read, roots, statOf, type OpCtx } from "./ops.js";
import type { SafetyOpts } from "./safety.js";
import { connectWs, type WsConn } from "./ws.js";

export const OPS = ["roots", "list", "find", "stat", "read"] as const;
type Op = (typeof OPS)[number];

export type HelperState = "connecting" | "connected" | "waiting" | "stopped";
export type HelperOpts = {
  /** The settings as they are now (helper.json is re-read when it changes). */
  config: () => Config;
  log: Log;
  /** How long to wait before try number n (from 1). Default: 1, 2, 4 ... seconds, at most a minute. */
  backoffMs?: (attempt: number) => number;
  findMs?: number;
  /** How often it checks the line is alive (default 25 s); it's dropped and redialled after 2.5 times that in silence. */
  pingMs?: number;
  onState?: (s: HelperState, detail?: string) => void;
  /** Its own files (never served), and the test-only allowance for a folder in the temp folder. */
  safety?: SafetyOpts;
};

export const defaultBackoff = (attempt: number) => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 400);

/** What one request is about, for the log line (never anything from inside a file). */
function about(op: string, m: Record<string, unknown>) {
  if (op === "find") return `"${String(Array.isArray(m.words) ? m.words.join(" ") : (m.words ?? "")).slice(0, 120)}"${m.root ? ` in ${String(m.root).slice(0, 60)}` : ""}`;
  if (op === "read") return `"${String(m.path ?? "").slice(0, 300)}" from ${Number(m.offset) || 0}`;
  if (op === "roots") return "";
  return `"${String(m.path ?? "").slice(0, 300)}"`;
}

/** The answer to one request: the result, or a refusal by code. Unknown requests are refused, never guessed at. */
export async function answer(op: unknown, m: Record<string, unknown>, c: OpCtx): Promise<Record<string, unknown>> {
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) return { ok: false, error: "unknown_request" };
  try {
    const run: Record<Op, () => Promise<Record<string, unknown>>> = {
      roots: () => roots(c),
      list: () => list(c, m),
      find: () => find(c, m),
      stat: () => statOf(c, m),
      read: () => read(c, m),
    };
    return { ok: true, ...(await run[op as Op]()) };
  } catch (e) {
    if (e instanceof OpError) return { ok: false, error: e.code, ...e.extra };
    return { ok: false, error: "cant_read" };
  }
}

function summary(op: string, r: Record<string, unknown>) {
  if (!r.ok) return String(r.error);
  if (op === "list") return `ok, ${(r.entries as unknown[]).length} shown${r.more ? `, ${r.more} more` : ""}`;
  if (op === "find") return `ok, ${(r.results as unknown[]).length} found${r.more ? ", more" : ""}${r.stopped_early ? ", stopped early" : ""}`;
  if (op === "read") return `ok, ${Buffer.byteLength(String(r.data), "base64")} bytes`;
  if (op === "roots") return `ok, ${(r.roots as unknown[]).length} ${(r.roots as unknown[]).length === 1 ? "folder" : "folders"}`;
  return "ok";
}

export function startHelper(o: HelperOpts) {
  const backoff = o.backoffMs ?? defaultBackoff;
  const pingMs = o.pingMs ?? 25_000;
  let stopped = false;
  let conn: WsConn | null = null;
  let wake: (() => void) | null = null;
  const state = (s: HelperState, detail?: string) => o.onState?.(s, detail);

  /** One go at the line, until it closes. "dropped": it was connected, then the line went. "replaced": another copy of
   * the helper took over, so this one stops. "failed" / "refused": it never got in. */
  const once = (): Promise<"replaced" | "dropped" | "failed" | "refused"> =>
    new Promise((resolve) => {
      const cfg = o.config();
      let welcomed = false;
      let outcome: "replaced" | "dropped" | "failed" | "refused" = "failed";
      let timer: ReturnType<typeof setInterval> | null = null;
      let helloWait: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (timer) clearInterval(timer);
        if (helloWait) clearTimeout(helloWait);
        resolve(outcome);
      };
      state("connecting");
      connectWs(cfg.gateway, { "User-Agent": `TaviHelper/${VERSION}` }, {
        onMessage: (text) => {
          let m: Record<string, unknown>;
          try {
            m = JSON.parse(text) as Record<string, unknown>;
          } catch {
            return;
          }
          if (!welcomed) {
            if (m.type === "welcome") {
              welcomed = true;
              if (helloWait) clearTimeout(helloWait);
              state("connected");
              o.log("connected to Tavi");
            } else if (m.type === "refused") {
              outcome = "refused";
              o.log("the main computer said no (this computer may have been unpaired, or helper.json has an old secret)");
              conn?.close(1000);
            }
            return;
          }
          if (m.type === "replaced") {
            outcome = "replaced";
            return;
          }
          if (m.type === "unpaired") {
            o.log("this computer was unpaired on the main computer");
            return;
          }
          if (m.type !== "req" || typeof m.id !== "string") return;
          const id = m.id.slice(0, 64);
          const op = typeof m.op === "string" ? m.op.slice(0, 40) : "?";
          const now = o.config();
          void answer(m.op, m, { ...o.safety, roots: now.folders, maxFileBytes: now.maxFileBytes, findMs: o.findMs }).then((r) => {
            if (!(OPS as readonly string[]).includes(op)) o.log(`refused an unknown request: ${op}`);
            else o.log(`${op} ${about(op, m)} → ${summary(op, r)}`.replace(/\s+→/, " →"));
            conn?.send(JSON.stringify({ type: "res", id, ...r }));
          });
        },
        onClose: (code) => {
          if (code === 4001) outcome = "replaced";
          else if (welcomed && outcome !== "replaced") {
            outcome = "dropped";
            o.log("the line to the main computer dropped");
          }
          conn = null;
          done();
        },
      })
        .then((c) => {
          if (stopped) return c.close(1000);
          conn = c;
          c.send(JSON.stringify({ type: "hello", name: cfg.computer, version: VERSION, secret: cfg.secret, max_file_mb: Math.round(cfg.maxFileBytes / 1024 / 1024) }));
          helloWait = setTimeout(() => {
            if (!welcomed) c.close(1000);
          }, 15_000);
          timer = setInterval(() => {
            if (Date.now() - c.lastHeard() > pingMs * 2.5) return c.close(4000, "no answer");
            c.ping();
          }, pingMs);
        })
        .catch((e: Error) => {
          o.log(`can't reach the main computer (${e.message})`);
          done();
        });
    });

  const loop = (async () => {
    let attempt = 0;
    while (!stopped) {
      const r = await once();
      if (stopped) break;
      if (r === "replaced") {
        o.log("another copy of the helper took over, so this one has stopped");
        stopped = true;
        state("stopped", "replaced");
        return "replaced";
      }
      attempt = r === "dropped" ? 1 : attempt + 1;
      const ms = backoff(attempt);
      state("waiting", `${Math.round(ms / 1000)} s`);
      await new Promise<void>((res) => {
        const t = setTimeout(res, ms);
        wake = () => (clearTimeout(t), res());
      });
      wake = null;
    }
    state("stopped");
    return "stopped";
  })();

  return {
    /** Ends the line and stops trying. */
    stop: () => {
      stopped = true;
      conn?.close(1000);
      wake?.();
      return loop;
    },
    done: loop,
  };
}
