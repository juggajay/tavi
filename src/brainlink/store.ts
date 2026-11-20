// What the link remembers about The Brain's jobs (Stage 16): the jobs it started or followed, and every turn it sent
// (who asked, what it cost, how it ended). Its own two tables, made here if missing rather than as a numbered database
// change: the older app ignores them, so a rollback doesn't need them undone, and they can't clash with another stage's
// change at a merge. The Brain's own files are never written; this is only our record of what we asked it.
import { db, newId, nowIso } from "../store/db.js";
import { startOfDay } from "../time.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS brainlink_jobs (
    job TEXT PRIMARY KEY,               -- The Brain's own job id (lh-<8 hex> for one started here)
    title TEXT NOT NULL,
    mode TEXT,                          -- read | takeoff | quote | price
    client TEXT,
    site TEXT,
    session TEXT,                       -- its conversation id, for the next turn
    state TEXT NOT NULL,                -- starting | running | waiting | ready | stopped | failed | cut_off | dropped | done | elsewhere
    gate TEXT,                          -- scope | takeoff | rates | draft, when it stopped at one
    question TEXT,                      -- what it asked him (its words, outside content)
    asked_at TEXT,                      -- when it was put to him; only words of his after this can answer it
    cost_usd REAL NOT NULL DEFAULT 0,   -- what its turns through the link cost, as it reported
    started_by TEXT NOT NULL,           -- link | app (started in The Brain itself, followed here)
    files_json TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS brainlink_turns (
    id TEXT PRIMARY KEY,
    job TEXT NOT NULL,
    kind TEXT NOT NULL,                 -- start | answer
    words TEXT NOT NULL,                -- what was sent: his own words (or the start's brief)
    line_id INTEGER,                    -- the conversation line his words came from (one answer per line)
    approval_id TEXT,                   -- the tap that let it go, when one was needed
    outcome TEXT NOT NULL,              -- running | gate | ready | done | error | stopped | dropped | cut_off | refused
    gate TEXT,
    cost_usd REAL,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX IF NOT EXISTS brainlink_turns_job ON brainlink_turns(job, started_at);
`);

/** elsewhere: he carried it on in The Brain itself, so the link stopped following it. done: finished with (seen, issued, or dropped by him). */
export type LinkState = "starting" | "running" | "waiting" | "ready" | "stopped" | "failed" | "cut_off" | "dropped" | "done" | "elsewhere";
export type LinkJob = {
  job: string;
  title: string;
  mode: string | null;
  client: string | null;
  site: string | null;
  session: string | null;
  state: LinkState;
  gate: string | null;
  question: string | null;
  asked_at: string | null;
  cost_usd: number;
  started_by: "link" | "app";
  files_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};
export type LinkTurn = { id: string; job: string; kind: "start" | "answer"; words: string; line_id: number | null; approval_id: string | null; outcome: string; gate: string | null; cost_usd: number | null; error: string | null; started_at: string; ended_at: string | null };

export const getLinkJob = (job: string) => db.prepare("SELECT * FROM brainlink_jobs WHERE job = ?").get(job) as LinkJob | undefined;
export const linkJobs = () => db.prepare("SELECT * FROM brainlink_jobs ORDER BY updated_at DESC").all() as LinkJob[];

export function saveLinkJob(j: Partial<LinkJob> & { job: string }) {
  const cur = getLinkJob(j.job);
  const at = nowIso();
  if (!cur) {
    db.prepare(
      "INSERT INTO brainlink_jobs (job, title, mode, client, site, session, state, gate, question, asked_at, cost_usd, started_by, files_json, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(j.job, j.title ?? j.job, j.mode ?? null, j.client ?? null, j.site ?? null, j.session ?? null, j.state ?? "starting", j.gate ?? null, j.question ?? null, j.asked_at ?? null, j.cost_usd ?? 0, j.started_by ?? "link", j.files_json ?? null, j.last_error ?? null, at, at);
    return getLinkJob(j.job)!;
  }
  const next = { ...cur, ...j, updated_at: at };
  db.prepare("UPDATE brainlink_jobs SET title = ?, mode = ?, client = ?, site = ?, session = ?, state = ?, gate = ?, question = ?, asked_at = ?, cost_usd = ?, files_json = ?, last_error = ?, updated_at = ? WHERE job = ?").run(
    next.title, next.mode, next.client, next.site, next.session, next.state, next.gate, next.question, next.asked_at, next.cost_usd, next.files_json, next.last_error, at, j.job,
  );
  return getLinkJob(j.job)!;
}

export function addTurn(t: { job: string; kind: "start" | "answer"; words: string; line_id?: number | null; approval_id?: string | null }): string {
  const id = newId("btn");
  db.prepare("INSERT INTO brainlink_turns (id, job, kind, words, line_id, approval_id, outcome, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)").run(id, t.job, t.kind, t.words, t.line_id ?? null, t.approval_id ?? null, nowIso());
  return id;
}

export function endTurn(id: string, e: { outcome: string; gate?: string | null; cost_usd?: number | null; error?: string | null }) {
  db.prepare("UPDATE brainlink_turns SET outcome = ?, gate = ?, cost_usd = ?, error = ?, ended_at = ? WHERE id = ?").run(e.outcome, e.gate ?? null, e.cost_usd ?? null, e.error ?? null, nowIso(), id);
}

export const runningTurns = () => db.prepare("SELECT * FROM brainlink_turns WHERE outcome = 'running' ORDER BY started_at").all() as LinkTurn[];
export const turnsFor = (job: string) => db.prepare("SELECT * FROM brainlink_turns WHERE job = ? ORDER BY started_at").all(job) as LinkTurn[];
/** Has this line of his already answered something? (One line, one answer.) */
export const lineUsed = (lineId: number) => !!db.prepare("SELECT 1 FROM brainlink_turns WHERE line_id = ? AND outcome != 'refused'").get(lineId);

/**
 * Keep our notes in step with The Brain's own board: a job he answered or finished in The Brain itself is no longer
 * waiting on him here. Only jobs we think are waiting or ready are touched, and never one the link is running.
 */
export function syncWithBoard(board: { job: string; status?: string; stage?: string; updatedAt?: string }[]) {
  const seen = new Map(board.map((m) => [m.job, m]));
  for (const j of linkJobs()) {
    if (j.state !== "waiting" && j.state !== "ready") continue;
    const m = seen.get(j.job);
    if (!m?.status) continue;
    const moved = (m.updatedAt ?? "") > (j.updated_at ?? "");
    if (m.status === "issued" || m.status === "superseded") saveLinkJob({ job: j.job, state: "done" });
    else if (m.status === "running" || (moved && m.status === "ready" && j.state === "waiting")) saveLinkJob({ job: j.job, state: m.status === "ready" ? "ready" : "elsewhere", question: null });
    else if (moved && j.state === "waiting" && (m.status !== `gate:${j.gate}` || m.status === "active")) saveLinkJob({ job: j.job, state: "elsewhere", question: null });
  }
}

/** What the link's turns cost today (his time zone), as The Brain reported each. */
export function spentToday(now = new Date()): number {
  const r = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM brainlink_turns WHERE started_at >= ?").get(startOfDay(now).toISOString()) as { s: number };
  return Math.round(r.s * 100) / 100;
}
