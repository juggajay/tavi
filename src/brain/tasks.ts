// Background work (Stage 5; Stage 21.3: working in the open). A piece of work the mind takes away (start_work) runs in
// its own lane while the conversation carries on: it starts from the conversation itself (a copy of the mind's own record,
// so it has everything), says what it's doing at real steps, can be asked about, told more, hurried or stopped, and
// reports back as a notice (and, on a call, out loud when he isn't mid-sentence). Older brief-only jobs (start_task)
// still run the same way. Also the one place anything running (a task, a conversation turn, a browser job) registers how
// to stop it.
import { db, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { createJob, failJob } from "../store/jobs.js";
import { bus } from "../events.js";
import { rejectForJob } from "../broker/broker.js";
import type { Origin } from "../shared/protocol.js";
import { getSettings } from "../store/settings.js";
import { DEV } from "../dev.js";

/** The most one piece of work may take and use (the settings, Stage 21.1). TASK_BUDGET_USD still overrides the money;
 * LH_WORK_LIMIT_MS the time, in dev only (the tests). */
export const workLimits = () => {
  const s = getSettings();
  const ms = DEV && Number(process.env.LH_WORK_LIMIT_MS) ? Number(process.env.LH_WORK_LIMIT_MS) : s["work.max_minutes"] * 60_000;
  return { ms, usd: Number(process.env.TASK_BUDGET_USD) || s["work.max_usd"] };
};

export const MAX_PARALLEL = 2;
const stoppers = new Map<string, () => void>();

/** Whatever is running registers how to stop it; it unregisters when done. */
export function onStop(jobId: string, stop: () => void) {
  stoppers.set(jobId, stop);
  return () => stoppers.delete(jobId);
}
export const canStop = (jobId: string) => stoppers.has(jobId);

/** Stop a job: abort it, mark it stopped, and close any approvals it was waiting on. */
export function cancelJob(jobId: string, by: "user" | "brain" = "user"): boolean {
  const row = db.prepare("SELECT status, kind FROM jobs WHERE id = ?").get(jobId) as { status: string; kind: string } | undefined;
  if (!row || (row.status !== "running" && row.status !== "queued")) return false;
  db.prepare("UPDATE jobs SET status = 'cancelled', lease_until = NULL, updated_at = ? WHERE id = ?").run(nowIso(), jobId);
  rejectForJob(jobId);
  const stop = stoppers.get(jobId);
  stoppers.delete(jobId);
  queue.splice(0, queue.length, ...queue.filter((q) => q.id !== jobId));
  try {
    stop?.();
  } catch {}
  audit(by, "job.cancelled", jobId, { kind: row.kind });
  bus.emit("activity");
  return true;
}

/** The task most recently started that's still going ("stop that"). */
export function latestRunningTask(bot?: string): string | null {
  const rows = db.prepare("SELECT id FROM jobs WHERE kind IN ('task','browser','render') AND status IN ('running','queued') ORDER BY created_at DESC").all() as { id: string }[];
  for (const r of rows) if (bot === undefined || jobBot(r.id) === bot) return r.id;
  return null;
}
/**
 * Which bot a piece of work belongs to (the bot team, v3). Null for the built-in brain's own work.
 * Found the first night two bots were given the same job: one bot's "carry on" was passed into the other bot's
 * running work, and it told the owner it was continuing when it had nothing running. A bot may only see, steer and
 * stop its own work. The bot is in the job's summary once it ends, and in the turn it came from while it runs.
 */
export function jobBot(id: string): string | null {
  const r = db.prepare("SELECT summary FROM jobs WHERE id = ?").get(id) as { summary: string | null } | undefined;
  try {
    const s = JSON.parse(r?.summary ?? "{}") as { bot?: unknown; from_turn?: unknown };
    if (typeof s.bot === "string") return s.bot;
    const m = /^lh-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(String(s.from_turn ?? ""));
    return m ? m[1] : null;
  } catch { return null; }
}
export const runningTaskCount = () => (db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind IN ('task','browser','render') AND status IN ('running','queued')").get() as { n: number }).n;

/* ---------------- the background lane ---------------- */

/**
 * A piece of work. understood/howLong: what the mind took him to want and its guess at how long (Stage 21.3); fromTurn:
 * the conversation turn it was started in, whose record it starts from; open: what it makes opens on the asker's screen
 * (as a conversation turn's would, so it can look at it), rather than only being listed.
 */
export type TaskSpec = { id: string; title: string; brief: string; origin: Origin | null; understood?: string; howLong?: string; fromTurn?: string | null; open?: boolean };
type Runner = (t: TaskSpec, signal: AbortSignal) => Promise<void>;
let runner: Runner | null = null;
/** brain.ts registers how a task is run (it owns the model sessions and tools). */
export const setTaskRunner = (r: Runner) => (runner = r);

const queue: TaskSpec[] = [];
let running = 0;
const titles = new Map<string, { title: string; doing: string }>(); // running task → what the apps show

/** Tell the apps what's running in the background: the newest piece of work and what it's doing now, or that nothing is. */
function announce() {
  const last = [...titles.entries()].at(-1);
  bus.emit("background", last ? { phase: "start", title: last[1].title, doing: last[1].doing, job_id: last[0] } : { phase: "end", title: "" });
}

/** What a piece of work is doing now, in plain words (its own progress line, or the step its tool shows). */
export function workDoing(jobId: string, doing: string) {
  const t = titles.get(jobId);
  db.prepare("UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?").run(doing, nowIso(), jobId);
  if (t) {
    t.doing = doing;
    titles.delete(jobId); // the one that just moved is the one shown
    titles.set(jobId, t);
    announce();
  }
  bus.emit("activity");
}

/** Hand work to the background. Returns its job id at once. */
export function startTask(t: Omit<TaskSpec, "id">): string {
  const id = createJob("task", t.title.slice(0, 120), t.brief);
  db.prepare("UPDATE jobs SET summary = ? WHERE id = ?").run(JSON.stringify({ origin: t.origin, ...(t.understood ? { understood: t.understood } : {}), ...(t.howLong ? { how_long: t.howLong } : {}), ...(t.fromTurn ? { from_turn: t.fromTurn } : {}) }), id);
  audit("brain", "task.started", id, { title: t.title, ...(t.understood ? { understood: t.understood } : {}) });
  queue.push({ id, ...t });
  bus.emit("activity");
  pumpQueue();
  return id;
}

function pumpQueue() {
  while (running < MAX_PARALLEL && queue.length && runner) {
    const t = queue.shift()!;
    if ((db.prepare("SELECT status FROM jobs WHERE id = ?").get(t.id) as { status: string } | undefined)?.status !== "queued") continue;
    running++;
    const ac = new AbortController();
    const unregister = onStop(t.id, () => ac.abort());
    titles.set(t.id, { title: t.title, doing: t.understood ? "Getting started" : t.title });
    announce();
    void runner(t, ac.signal)
      .catch((err) => {
        const stopped = ac.signal.aborted;
        if (!stopped) failJob(t.id, err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        unregister();
        steering.delete(t.id);
        titles.delete(t.id);
        announce();
        running--;
        bus.emit("activity");
        pumpQueue();
      });
  }
}

/* ---------------- a piece of work starts from the conversation turn that started it (21.3) ---------------- */

/** Where the conversation's record stood when a turn finished: its session and last message. null: no record (fake, test). */
export type TurnRecord = { sessionId: string; upTo?: string; model: string } | null;
const records = new Map<string, TurnRecord>();
const waiting = new Map<string, ((r: TurnRecord) => void)[]>();

/** The gateway calls this when a conversation turn has finished (its answer given), with the mind's record as it stood. */
export function turnFinished(jobId: string, record: TurnRecord) {
  records.set(jobId, record);
  for (const w of waiting.get(jobId) ?? []) w(record);
  waiting.delete(jobId);
  if (records.size > 50) records.delete(records.keys().next().value!);
}

/** Wait for a turn to finish (a piece of work started in it begins from its whole record, answer and all). */
export function recordOf(jobId: string, ms = 10 * 60_000): Promise<TurnRecord> {
  if (records.has(jobId)) return Promise.resolve(records.get(jobId)!);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    waiting.set(jobId, [...(waiting.get(jobId) ?? []), (r) => (clearTimeout(t), resolve(r))]);
  });
}

/* ---------------- telling a running piece of work something (21.3) ---------------- */

const steering = new Map<string, (text: string) => void>();
/** A running piece of work registers how to pass it a message; it reads it at its next step. */
export function onSteer(jobId: string, take: (text: string) => void) {
  steering.set(jobId, take);
  return () => steering.delete(jobId);
}
/** Pass a message to a running piece of work (what he added, or "the quick version, now"). False when it isn't running. */
export function steerWork(jobId: string, text: string): boolean {
  const take = steering.get(jobId);
  if (!take) return false;
  take(text);
  audit("brain", "task.steered", jobId, { text: text.slice(0, 300) });
  return true;
}

/* ---------------- what the mind is told about work, in the Context (21.3) ---------------- */

type WorkRow = { id: string; source: string; status: string; progress: string | null; summary: string | null; result: string | null; created_at: string; updated_at: string };
const parse = <T>(s: string | null): T => (s ? (JSON.parse(s) as T) : ({} as T));
const minsAgo = (iso: string, now: number) => Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));

/** Lines for the Context: work running now, and work finished in the last three hours (its result and notes). */
export function workLines(now = Date.now(), bot?: string): string[] {
  const live = db.prepare("SELECT id, source, status, progress, summary, result, created_at, updated_at FROM jobs WHERE kind = 'task' AND status IN ('running','queued') ORDER BY created_at").all() as WorkRow[];
  const done = db
    .prepare("SELECT id, source, status, progress, summary, result, created_at, updated_at FROM jobs WHERE kind = 'task' AND status IN ('done','failed','cancelled') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 3")
    .all(new Date(now - 3 * 3600_000).toISOString()) as WorkRow[];
  const out: string[] = [];
  // In the bot team each bot is told only about its own work (see jobBot).
  if (bot !== undefined) { for (const list of [live, done]) for (let i = list.length - 1; i >= 0; i--) if (jobBot(list[i].id) !== bot) list.splice(i, 1); }
  if (live.length) {
    out.push("Work in progress (yours, going on separately; he can ask how it's going, add to it, hurry it with update_work, or stop it with cancel_task):");
    for (const j of live) {
      const s = parse<{ understood?: string; how_long?: string }>(j.summary);
      out.push(`- [${j.id}] ${j.source}: ${j.status === "queued" ? "waiting its turn" : `started ${minsAgo(j.created_at, now)} min ago${s.how_long ? `, you said ${s.how_long}` : ""}; now: ${j.progress ?? "getting started"}`}${s.understood ? `; you took him to want: ${s.understood}` : ""}`);
    }
  }
  if (done.length) {
    out.push("Work finished lately (what it found is yours now; carry on from it):");
    for (const j of done) {
      const r = parse<{ spoken?: string; notes?: string; limit?: string }>(j.result);
      const how = j.status === "done" ? (r.limit ? "stopped at its limit" : "done") : j.status === "cancelled" ? "stopped" : "failed";
      out.push(`- [${j.id}] ${j.source} (${how}, ${minsAgo(j.updated_at, now)} min ago): ${(r.spoken ?? "").slice(0, 500)}${r.notes ? ` Facts: ${r.notes.slice(0, 1200)}` : ""}`);
    }
  }
  return out;
}

/**
 * After a restart: a task that was cut off within its first 10 minutes is tried once more; otherwise it's left as
 * interrupted (recoverJobs marks it) and the owner is offered a restart by the caller.
 */
export function requeueInterruptedTasks(): { retried: string[]; givenUp: { id: string; title: string }[] } {
  const rows = db.prepare("SELECT id, source, request, summary, created_at FROM jobs WHERE kind = 'task' AND status = 'interrupted'").all() as { id: string; source: string; request: string; summary: string | null; created_at: string }[];
  const retried: string[] = [];
  const givenUp: { id: string; title: string }[] = [];
  for (const r of rows) {
    const s = (r.summary ? JSON.parse(r.summary) : {}) as { origin?: Origin | null; retried?: boolean; understood?: string };
    if (!s.retried && Date.now() - new Date(r.created_at).getTime() < 10 * 60_000) {
      db.prepare("UPDATE jobs SET status = 'queued', summary = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...s, retried: true }), nowIso(), r.id);
      // (its conversation record is gone with the restart: it runs again from its brief)
      queue.push({ id: r.id, title: r.source, brief: r.request, origin: s.origin ?? null, understood: s.understood });
      retried.push(r.id);
    } else {
      db.prepare("UPDATE jobs SET status = 'failed', error = 'cut off by a restart', updated_at = ? WHERE id = ?").run(nowIso(), r.id);
      givenUp.push({ id: r.id, title: r.source });
    }
  }
  pumpQueue();
  return { retried, givenUp };
}
