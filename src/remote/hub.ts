// The gateway's side of the helper's line (Stage 11.3). A paired computer's helper calls in on /helper (on the live PC,
// through Tailscale Serve: the same https address and encryption the phone uses) and says who it is with its secret.
// One line per computer: a new one replaces the old. Everything else gets the same plain refusal.
//
// ask() sends one request down a computer's line and waits for the answer, with a time limit. If the computer isn't
// connected it fails at once ("away"), so the assistant never waits on a computer that's off.
// Every request the assistant makes is written to audit_log (actor "helper"): the request, the path, the result and the
// size, never what's in a file.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { isAgentRequest, AGENT_HEADER } from "../browser/sites.js";
import { audit } from "../store/log.js";
import { awayLine, checkSecret, getComputer, touchSeen, type Computer } from "./computers.js";
import { bus } from "../events.js";

/** Timings, changeable by tests. */
export const hubTiming = { helloMs: 10_000, pingMs: 25_000, watchMs: 5_000, defaultMs: 20_000 };

export type RemoteCode = "away" | "timed_out" | "not_found" | "cant_read" | "too_big" | "not_a_folder" | "not_a_file" | "bad_request" | "unknown_request" | "dropped";
export class RemoteError extends Error {
  constructor(
    readonly code: RemoteCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Waiting = { resolve: (m: Record<string, unknown>) => void; reject: (e: RemoteError) => void; timer: ReturnType<typeof setTimeout> };
type Line = { name: string; ws: WebSocket; hash: string; alive: boolean; seq: number; waiting: Map<string, Waiting>; version: string; maxFileMb: number; since: string; folders: string[] | null };

const lines = new Map<string, Line>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
let timers: ReturnType<typeof setInterval>[] = [];

const refuse = (ws: WebSocket) => {
  try {
    ws.send(JSON.stringify({ type: "refused" }));
  } catch {}
  ws.close(4003, "refused");
};

/** For server.ts: takes the upgrade if it's for /helper (true), else leaves it alone (false). */
export function helperUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  if (new URL(req.url ?? "/", "http://local").pathname !== "/helper") return false;
  // The helper is a program, not a web page: a browser (which always sends Origin) and Tavi's own browser are
  // turned away before anything is said.
  if (req.headers.origin || isAgentRequest(req.headers)) {
    socket.destroy();
    return true;
  }
  wss.handleUpgrade(req, socket, head, (ws) => accept(ws));
  return true;
}

function accept(ws: WebSocket) {
  startTimers();
  let line: Line | null = null;
  const helloWait = setTimeout(() => refuse(ws), hubTiming.helloMs);
  ws.on("message", (raw) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return line ? undefined : refuse(ws);
    }
    if (!line) {
      clearTimeout(helloWait);
      const c = m.type === "hello" ? checkSecret(m.name, m.secret) : null;
      if (!c) {
        audit("helper", "computer.refused", null, { name: typeof m.name === "string" ? m.name.slice(0, 40) : null });
        return refuse(ws);
      }
      line = {
        name: c.name,
        ws,
        hash: c.secret_hash,
        alive: true,
        seq: 0,
        waiting: new Map(),
        version: String(m.version ?? "").slice(0, 20),
        maxFileMb: Number(m.max_file_mb) > 0 ? Number(m.max_file_mb) : 50,
        since: new Date().toISOString(),
        folders: null,
      };
      const old = lines.get(c.name);
      lines.set(c.name, line);
      if (old) {
        try {
          old.ws.send(JSON.stringify({ type: "replaced" }));
        } catch {}
        old.ws.close(4001, "replaced");
        fail(old, "dropped");
      }
      ws.send(JSON.stringify({ type: "welcome" }));
      touchSeen(c.name);
      audit("helper", "computer.connected", c.name, { version: line.version, replaced: !!old });
      bus.emit("activity");
      const me = line;
      void ask(c.name, "roots", {}, { quiet: true })
        .then((r) => (me.folders = ((r.roots as { name: string }[]) ?? []).map((x) => x.name)))
        .catch(() => {});
      return;
    }
    if (m.type === "res" && typeof m.id === "string") {
      const w = line.waiting.get(m.id);
      if (!w) return;
      line.waiting.delete(m.id);
      clearTimeout(w.timer);
      w.resolve(m);
    }
  });
  ws.on("pong", () => line && (line.alive = true));
  ws.on("close", () => {
    clearTimeout(helloWait);
    if (!line) return;
    fail(line, "dropped");
    if (lines.get(line.name) === line) {
      lines.delete(line.name);
      touchSeen(line.name);
      audit("helper", "computer.disconnected", line.name, null);
      bus.emit("activity");
    }
  });
  ws.on("error", () => {});
}

/** Everything waiting on a line that went: answered at once, never left hanging. */
function fail(line: Line, code: RemoteCode) {
  for (const [, w] of line.waiting) {
    clearTimeout(w.timer);
    w.reject(new RemoteError(code, "The line to the other computer dropped."));
  }
  line.waiting.clear();
}

/** Keeps each line honest: a helper that stops answering pings is dropped; one that's been unpaired is told and dropped. */
function startTimers() {
  if (timers.length) return;
  timers = [
    setInterval(() => {
      for (const l of lines.values()) {
        if (!l.alive) {
          l.ws.terminate();
          continue;
        }
        l.alive = false;
        try {
          l.ws.ping();
        } catch {}
      }
    }, hubTiming.pingMs),
    setInterval(() => {
      for (const l of lines.values()) {
        const now = getComputer(l.name);
        if (now && now.secret_hash === l.hash) continue;
        try {
          l.ws.send(JSON.stringify({ type: "unpaired" }));
        } catch {}
        l.ws.close(4004, "unpaired");
        lines.delete(l.name);
        fail(l, "away");
        audit("helper", "computer.dropped", l.name, { why: now ? "paired again" : "unpaired" });
      }
    }, hubTiming.watchMs),
  ];
  for (const t of timers) t.unref();
}

/** For tests: stop the timers (they start again with the next connection). */
export function stopHub() {
  for (const t of timers) clearInterval(t);
  timers = [];
  for (const l of lines.values()) l.ws.terminate();
  lines.clear();
}

export const isConnected = (name: string) => lines.has(name.toLowerCase());
/** The folders it last said it may show (null until it's said). */
export const foldersOf = (name: string) => lines.get(name.toLowerCase())?.folders ?? null;
export const lineInfo = (name: string) => {
  const l = lines.get(name.toLowerCase());
  return l ? { since: l.since, version: l.version, maxFileMb: l.maxFileMb } : null;
};

/** What each request is about, for audit_log: the path or the words, never anything read. */
function about(op: string, args: Record<string, unknown>) {
  if (op === "find") return { words: String(args.words ?? "").slice(0, 200), ...(args.root ? { root: String(args.root).slice(0, 80) } : {}) };
  if (op === "roots") return {};
  return { path: String(args.path ?? "").slice(0, 400) };
}

/**
 * One request down a computer's line, and its answer (ok: true), or a RemoteError: "away" at once when it isn't
 * connected, "timed_out" when it doesn't answer in time, or the helper's own refusal ("not_found", "cant_read" ...).
 * quiet: not written to audit_log (the pieces of a read; the whole read is written once by whoever asked).
 */
export function ask(name: string, op: string, args: Record<string, unknown> = {}, o: { timeoutMs?: number; quiet?: boolean } = {}): Promise<Record<string, unknown>> {
  const n = name.toLowerCase();
  const line = lines.get(n);
  const note = (result: string, extra: Record<string, unknown> = {}) => o.quiet || audit("helper", `computer.${op}`, n, { ...about(op, args), result, ...extra });
  if (!line) {
    const c: Pick<Computer, "name" | "called"> = getComputer(n) ?? { name: n, called: null };
    note("away");
    return Promise.reject(new RemoteError("away", awayLine(c)));
  }
  const id = `q${++line.seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      line.waiting.delete(id);
      note("timed_out");
      reject(new RemoteError("timed_out", "The other computer didn't answer in time."));
    }, o.timeoutMs ?? hubTiming.defaultMs);
    line.waiting.set(id, {
      timer,
      resolve: (m) => {
        touchSeen(n);
        const { type: _t, id: _i, ok, error, ...rest } = m;
        if (ok === true) {
          note("ok", sizeOf(op, rest));
          // its folders, as they are now (they change when the owner edits helper.json on that computer)
          if (op === "roots" && Array.isArray(rest.roots)) line.folders = (rest.roots as { name: string }[]).map((x) => String(x.name));
          return resolve(rest);
        }
        const code = (typeof error === "string" ? error : "cant_read") as RemoteCode;
        note(code);
        reject(new RemoteError(code, plainError(code), rest));
      },
      reject: (e) => {
        note(e.code);
        reject(e);
      },
    });
    line.ws.send(JSON.stringify({ type: "req", id, op, ...args }), (err) => {
      if (!err) return;
      const w = line.waiting.get(id);
      if (!w) return;
      line.waiting.delete(id);
      clearTimeout(w.timer);
      w.reject(new RemoteError("dropped", "The line to the other computer dropped."));
    });
  });
}

/** The size of an answer, for the audit row (a count, or bytes): never its contents. */
function sizeOf(op: string, r: Record<string, unknown>) {
  if (op === "list") return { count: Array.isArray(r.entries) ? r.entries.length : 0, ...(r.more ? { more: r.more } : {}) };
  if (op === "find") return { count: Array.isArray(r.results) ? r.results.length : 0 };
  if (op === "stat" || op === "read") return { size: r.size };
  return {};
}

export function plainError(code: RemoteCode | string) {
  switch (code) {
    case "not_found":
      return "There's nothing by that name there (or it's somewhere the helper doesn't show).";
    case "cant_read":
      return "It's there, but it can't be read: it may be open in another program, or locked.";
    case "too_big":
      return "That file is over the size limit for bringing across.";
    case "not_a_folder":
      return "That's a file, not a folder.";
    case "not_a_file":
      return "That's a folder, not a file.";
    case "timed_out":
      return "The other computer didn't answer in time.";
    default:
      return "The other computer couldn't do that.";
  }
}
