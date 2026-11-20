// A small client for The Brain's local API (Stage 16). Only these calls exist, and request() refuses any other:
//   GET  /api/doctor            is this PC ready to run its jobs
//   GET  /api/jobs              its job board
//   GET  /api/jobs/<id>         one job: its manifest, the take-off and quote text, its thread
//   GET  /api/jobs/<id>/pdf     an issued quote's PDF (only ever asked for once it's issued)
//   PUT  /api/jobs/<id>         its conversation thread, mirrored so its own screens show what was asked through here
//   POST /api/quote             a turn (multipart), or {action: "interrupt"} to stop one; never save or issue
// Node's own http (no idle timeout on a body), so a turn's stream can run for as long as the job does.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { brainUrl, JOB_ID, readOnly } from "./config.js";

export type Reach<T> = { ok: true; status: number; data: T } | { ok: false; down: boolean; status?: number; error: string };

const ID = "[A-Za-z0-9_-]{1,64}";
const ALLOWED: [string, RegExp][] = [
  ["GET", /^\/api\/doctor$/],
  ["GET", /^\/api\/jobs$/],
  ["GET", new RegExp(`^/api/jobs/${ID}$`)],
  ["GET", new RegExp(`^/api/jobs/${ID}/pdf$`)],
  ["PUT", new RegExp(`^/api/jobs/${ID}$`)],
  ["POST", /^\/api\/quote$/],
];
/** The only GETs the read-only check may make against the real app. */
const READ_ONLY: RegExp[] = [/^\/api\/doctor$/, /^\/api\/jobs$/, new RegExp(`^/api/jobs/${ID}$`)];

export class LinkRefused extends Error {}

export function allowed(method: string, p: string): boolean {
  if (!ALLOWED.some(([m, re]) => m === method && re.test(p))) return false;
  if (readOnly()) return method === "GET" && READ_ONLY.some((re) => re.test(p));
  return true;
}

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

/** One request. down: nothing answered (not running, or not listening yet). timeoutMs: for the whole of a short call. */
export function request(method: string, p: string, o: { body?: Buffer; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Raw> {
  const base = brainUrl();
  if (!base) return Promise.reject(new LinkRefused("The Brain is not set up, or its link is off in practice mode (set LH_BRAINLINK_URL to a stand-in for tests)."));
  if (!allowed(method, p)) return Promise.reject(new LinkRefused(`Not a call the link makes: ${method} ${p}`));
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${p}`, { method, headers: { ...(o.body ? { "Content-Length": String(o.body.length) } : {}), ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    if (o.timeoutMs) req.setTimeout(o.timeoutMs, () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(o.body);
  });
}

const DOWN = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND", "EADDRNOTAVAIL", "EPIPE"]);
function failed(err: unknown): { ok: false; down: boolean; error: string } {
  if (err instanceof LinkRefused) return { ok: false, down: false, error: err.message };
  const code = (err as { code?: string }).code ?? "";
  return { ok: false, down: DOWN.has(code), error: DOWN.has(code) ? "The Brain isn't running (nothing answered on its address)." : err instanceof Error ? err.message : String(err) };
}

/** The app's own error text from a refusal ({ error } JSON), else the status. */
export function whyNot(r: Raw): string {
  try {
    const j = JSON.parse(r.body.toString("utf8")) as { error?: unknown };
    if (typeof j.error === "string" && j.error) return j.error.slice(0, 300);
  } catch {}
  return `it answered ${r.status}`;
}

async function getJson<T>(p: string, timeoutMs: number): Promise<Reach<T>> {
  try {
    const r = await request("GET", p, { timeoutMs, headers: { Accept: "application/json" } });
    if (r.status !== 200) return { ok: false, down: false, status: r.status, error: whyNot(r) };
    return { ok: true, status: r.status, data: JSON.parse(r.body.toString("utf8")) as T };
  } catch (err) {
    return failed(err);
  }
}

/** One of its readiness checks (lib/doctor.ts). */
export type Check = { id: string; label: string; ok: boolean; detail: string; required: boolean; fix?: string };
export type Doctor = { checks: Check[]; ok: boolean; packOk: boolean; python: string | null };
/** One job on its board (lib/stages.ts JobManifest). */
export type Manifest = { job: string; title?: string; mode?: string; client?: string; site?: string; session?: string; status?: string; stage?: string; quoteRef?: string; issueId?: string; issuedAt?: string; costUsd?: number; updatedAt?: string };
export type Thread = { s?: string; j?: string; m: ThreadLine[]; st?: number; r?: boolean; c?: number; sv?: string };
export type ThreadLine = { kind: "user" | "agent" | "activity"; text: string; turn?: number; at?: number; action?: string; detail?: string; durationMs?: number };
export type JobDetail = { manifest: Manifest; readFile: string | null; takeoffFile: string | null; quoteFile: string | null; takeoffBody: string | null; quoteBody: string | null; thread: Thread | null; docs?: { name: string; size: number }[] };

/** Its doctor runs a few small programs (git, Python, Tesseract) each time, so it can take several seconds. */
export const doctor = (timeoutMs = 45_000) => getJson<Doctor>("/api/doctor", timeoutMs);
export const listJobs = (timeoutMs = 8000) => getJson<{ jobs: Manifest[] }>("/api/jobs", timeoutMs);
export const getJob = (id: string, timeoutMs = 15_000) => (JOB_ID.test(id) ? getJson<JobDetail>(`/api/jobs/${id}`, timeoutMs) : Promise.resolve({ ok: false as const, down: false, error: "not a job id" }));

/** Answers at all: its job board is a quick read of a folder. */
export async function answering(timeoutMs = 2500): Promise<boolean> {
  const r = await listJobs(timeoutMs);
  return r.ok;
}

export async function putThread(id: string, slot: Thread): Promise<Reach<null>> {
  if (!JOB_ID.test(id)) return { ok: false, down: false, error: "not a job id" };
  try {
    const r = await request("PUT", `/api/jobs/${id}`, { body: Buffer.from(JSON.stringify(slot)), headers: { "Content-Type": "application/json" }, timeoutMs: 15_000 });
    return r.status === 200 ? { ok: true, status: 200, data: null } : { ok: false, down: false, status: r.status, error: whyNot(r) };
  } catch (err) {
    return failed(err);
  }
}

/** Stop the turn it's running on this job (its own Stop button does the same). */
export async function interrupt(id: string): Promise<Reach<{ interrupted: boolean }>> {
  if (!JOB_ID.test(id)) return { ok: false, down: false, error: "not a job id" };
  try {
    const r = await request("POST", "/api/quote", { body: Buffer.from(JSON.stringify({ action: "interrupt", job: id })), headers: { "Content-Type": "application/json" }, timeoutMs: 15_000 });
    if (r.status !== 200) return { ok: false, down: false, status: r.status, error: whyNot(r) };
    return { ok: true, status: 200, data: { interrupted: !!(JSON.parse(r.body.toString("utf8")) as { interrupted?: boolean }).interrupted } };
  } catch (err) {
    return failed(err);
  }
}

/** An issued quote's PDF, as it saved it (a read; the link never asks it to make one). */
export async function issuedPdf(id: string): Promise<Reach<Buffer>> {
  if (!JOB_ID.test(id)) return { ok: false, down: false, error: "not a job id" };
  try {
    const r = await request("GET", `/api/jobs/${id}/pdf`, { timeoutMs: 60_000 });
    if (r.status !== 200 || !/application\/pdf/.test(String(r.headers["content-type"] ?? ""))) return { ok: false, down: false, status: r.status, error: whyNot(r) };
    return { ok: true, status: 200, data: r.body };
  } catch (err) {
    return failed(err);
  }
}

/* ---------------- a turn: multipart up, NDJSON events down, held to the end ---------------- */

export type TurnFields = { message: string; job: string; sessionId?: string; mode?: string; client?: string; site?: string; persona?: string; template?: string };
export type TurnFile = { name: string; data: Buffer; type?: string };
/** Its stream's events (app/api/quote/route.ts). */
export type BrainEvent =
  | { type: "session"; id: string }
  | { type: "job"; id: string }
  | { type: "delta"; text: string }
  | { type: "spawn"; id: string; agent: string; label: string }
  | { type: "agent-done"; id: string }
  | { type: "tool"; agent: string; name: string; target: string }
  | { type: "text"; text: string }
  | { type: "done"; costUsd: number; gate: string | null; ready: boolean }
  | { type: "error"; error: string };

export function multipart(fields: Record<string, string | undefined>, files: TurnFile[]): { body: Buffer; type: string } {
  const boundary = `----lh${randomBytes(12).toString("hex")}`;
  const parts: Buffer[] = [];
  const q = (s: string) => s.replace(/["\r\n\\]/g, "_");
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== "") parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${q(k)}"\r\n\r\n${v}\r\n`, "utf8"));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="doc"; filename="${q(f.name)}"\r\nContent-Type: ${f.type ?? "application/octet-stream"}\r\n\r\n`, "utf8"), f.data, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

export type TurnStream = {
  /** Resolves when it answered: the stream is open (ok) or it refused the turn (its reason). */
  opened: Promise<{ ok: true } | { ok: false; down: boolean; status?: number; error: string }>;
  /** Resolves when the stream ends: closed normally (it finished, with or without a done) or cut (the line dropped). */
  ended: Promise<{ cut: boolean; error?: string }>;
  /** Close our end (only used when the gateway shuts down; a turn is stopped with interrupt()). */
  close: () => void;
};

/** Send one turn and hold the line: every event goes to onEvent as it comes. No timeout on the body, on purpose. */
export function openTurn(fields: TurnFields, files: TurnFile[], onEvent: (e: BrainEvent) => void): TurnStream {
  let openedResolve!: (v: Awaited<TurnStream["opened"]>) => void;
  let endedResolve!: (v: Awaited<TurnStream["ended"]>) => void;
  const opened = new Promise<Awaited<TurnStream["opened"]>>((r) => (openedResolve = r));
  const ended = new Promise<Awaited<TurnStream["ended"]>>((r) => (endedResolve = r));
  const base = brainUrl();
  if (!base || !allowed("POST", "/api/quote")) {
    openedResolve({ ok: false, down: false, error: base ? "Not a call the link makes now." : "The link to The Brain is off in dev mode (set LH_BRAINLINK_URL to a stand-in)." });
    endedResolve({ cut: false });
    return { opened, ended, close: () => {} };
  }
  const { body, type } = multipart({ ...fields }, files);
  let isOpen = false;
  let finished = false;
  const finish = (v: Awaited<TurnStream["ended"]>) => {
    if (finished) return;
    finished = true;
    endedResolve(v);
  };
  const req = http.request(`${base}/api/quote`, { method: "POST", headers: { "Content-Type": type, "Content-Length": String(body.length), Accept: "application/x-ndjson" } }, (res) => {
    if (res.statusCode !== 200) {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        openedResolve({ ok: false, down: false, status: res.statusCode, error: whyNot({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }) });
        finish({ cut: false });
      });
      return;
    }
    isOpen = true;
    openedResolve({ ok: true });
    let buf = "";
    const line = (l: string) => {
      const t = l.trim();
      if (!t) return;
      try {
        onEvent(JSON.parse(t) as BrainEvent);
      } catch {}
    };
    res.setEncoding("utf8");
    res.on("data", (c: string) => {
      buf += c;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    res.on("end", () => {
      line(buf);
      finish({ cut: !res.complete });
    });
    res.on("aborted", () => finish({ cut: true, error: "the connection dropped" }));
    res.on("error", (e) => finish({ cut: true, error: e.message }));
    res.on("close", () => finish({ cut: !res.complete, ...(res.complete ? {} : { error: "the connection dropped" }) }));
  });
  req.on("error", (err) => {
    if (!isOpen) {
      const f = failed(err);
      openedResolve({ ok: false, down: f.down, error: f.error });
      finish({ cut: false });
    } else finish({ cut: true, error: err.message });
  });
  req.end(body);
  return { opened, ended, close: () => req.destroy() };
}
