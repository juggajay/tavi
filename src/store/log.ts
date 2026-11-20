// The logbook: every meaningful thing the system does, plus the searchable conversation history.
import { db, nowIso } from "./db.js";
import { bus } from "../events.js";

const insertAudit = db.prepare("INSERT INTO audit_log (ts, actor, event, ref, detail) VALUES (?, ?, ?, ?, ?)");
const insertConversation = db.prepare("INSERT INTO conversation_log (ts, role, channel, text, job_id) VALUES (?, ?, ?, ?, ?)");

/** helper: a request to another computer's helper (Stage 11), or that helper connecting. guest: the round table's second
 * assistant (Stage 17): everything sent to it and everything it said. */
export type Actor = "user" | "voice" | "brain" | "broker" | "system" | "helper" | "guest";

export function audit(actor: Actor, event: string, ref?: string | null, detail?: unknown) {
  insertAudit.run(nowIso(), actor, event, ref ?? null, detail === undefined ? null : JSON.stringify(detail));
}

/** channel proactive: something the assistant said first (a routine, a follow-up, a finished job). table: a line said at
 * a round table (Stage 17), the assistant's (role assistant) or the guest's (role guest). */
export type Channel = "voice" | "typed" | "system" | "test" | "proactive" | "siri" | "table";

export function logConversation(role: "user" | "assistant" | "system" | "guest", channel: Channel, text: string, jobId: string | null = null) {
  const t = text.trim();
  if (!t) return;
  const at = nowIso();
  const r = insertConversation.run(at, role, channel, t, jobId);
  bus.emit("line", { id: Number(r.lastInsertRowid), role, channel, text: t, at, job_id: jobId });
}

export function searchConversation(query: string, limit = 10) {
  return db
    .prepare(
      `SELECT c.ts, c.role, c.channel, c.text FROM conversation_fts f JOIN conversation_log c ON c.id = f.rowid
       WHERE conversation_fts MATCH ? ORDER BY c.id DESC LIMIT ?`,
    )
    .all(query, limit);
}
