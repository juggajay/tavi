// Durable jobs: every brain request is a row, so a crash or restart leaves a visible trace
// instead of silently losing work.
import { db, newId, nowIso } from "./db.js";
import { audit } from "./log.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "interrupted" | "cancelled";

const LEASE_MS = 3 * 60_000;

/** The job the brain is working on right now (requests are serialised by the gateway). */
let current: string | undefined;
export const currentJobId = () => current;

export function createJob(kind: string, source: string, request: string): string {
  const id = newId("job");
  const ts = nowIso();
  db.prepare("INSERT INTO jobs (id, kind, source, request, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)").run(
    id,
    kind,
    source,
    request,
    ts,
    ts,
  );
  return id;
}

export function startJob(id: string, opts: { current?: boolean } = {}) {
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE id = ?").run(lease, nowIso(), id);
  if (opts.current !== false) current = id; // background jobs don't claim the foreground slot
}

export function finishJob(id: string, result: unknown) {
  db.prepare("UPDATE jobs SET status = 'done', result = ?, lease_until = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(result), nowIso(), id);
  if (current === id) current = undefined;
}

export function failJob(id: string, error: string) {
  db.prepare("UPDATE jobs SET status = 'failed', error = ?, lease_until = NULL, updated_at = ? WHERE id = ?").run(error, nowIso(), id);
  if (current === id) current = undefined;
}

/** On boot: anything still marked running belonged to a process that died. Mark it, never re-run blindly. */
export function recoverJobs(): { id: string; request: string }[] {
  const stale = db.prepare("SELECT id, request FROM jobs WHERE status IN ('running','queued')").all() as { id: string; request: string }[];
  for (const j of stale) {
    db.prepare("UPDATE jobs SET status = 'interrupted', lease_until = NULL, updated_at = ? WHERE id = ?").run(nowIso(), j.id);
    audit("system", "job.interrupted", j.id, { reason: "process restarted while the job was in progress" });
  }
  return stale;
}
