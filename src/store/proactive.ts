// Commitments, memories, routines and settings: what makes the assistant follow through.
import { db, newId, nowIso } from "./db.js";
import { audit } from "./log.js";
import { describe, nextRun, parseTime, validate, type Schedule } from "../proactive/schedule.js";
import { addDays, atLocal, localDay, minutesOfDay, parseLocal } from "../time.js";

/* ---------------- settings ---------------- */

// No quiet hours and no daily limit unless the user asks for them.
const DEFAULTS: Record<string, string> = {
  brief_time: "06:00",
  lunch_time: "12:00", // the middle follow-up window; it only buzzes if something is waiting
  wrap_time: "15:30",
  quiet_start: "", // "" = off
  quiet_end: "",
  workdays: "[1,2,3,4,5]",
  max_interruptions: "0", // 0 = no limit
};

export function getSetting(key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULTS[key] ?? "";
}
export function setSetting(key: string, value: string) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  audit("user", "setting.changed", key, { value });
}
export function allSettings() {
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, getSetting(k)]));
}

const minutes = (t: string) => {
  const [h, m] = parseTime(t);
  return h * 60 + m;
};
export function quietHoursOn() {
  return !!getSetting("quiet_start") && !!getSetting("quiet_end");
}
export function inQuietHours(d = new Date()) {
  if (!quietHoursOn()) return false;
  const now = minutesOfDay(d);
  const start = minutes(getSetting("quiet_start"));
  const end = minutes(getSetting("quiet_end"));
  return start > end ? now >= start || now < end : now >= start && now < end;
}
/** Plain-English summary of the notification rules, for the brain's context and the PC app. */
export function notificationRules() {
  const quiet = quietHoursOn() ? `quiet from ${getSetting("quiet_start")} to ${getSetting("quiet_end")} (urgent still comes through)` : "no quiet hours";
  const cap = Number(getSetting("max_interruptions"));
  return `${quiet}; ${cap > 0 ? `at most ${cap} notifications a day` : "no daily limit"}`;
}

export function quietEndsAt(d = new Date()): Date {
  if (!quietHoursOn()) return d;
  const [h, m] = parseTime(getSetting("quiet_end"));
  const today = localDay(d);
  const c = atLocal(today, h, m);
  return c > d ? c : atLocal(addDays(today, 1), h, m);
}

/* ---------------- commitments ---------------- */

export type Commitment = {
  id: string;
  title: string;
  detail: string | null;
  owner: string;
  counterpart: string | null;
  due_at: string | null;
  next_check_at: string | null;
  status: string;
  created_at: string;
};

export function addCommitment(c: {
  title: string;
  detail?: string;
  owner: string;
  counterpart?: string;
  due_at?: string;
  next_check_at?: string;
  source?: string;
  kind?: string;
  site?: string;
  event_at?: string;
  ask_before?: string;
  ask_after?: string;
  must_confirm?: boolean;
}) {
  const id = newId("cmt");
  const ts = nowIso();
  const check = c.next_check_at ?? c.due_at ?? null;
  db.prepare(
    `INSERT INTO commitments (id, title, detail, owner, counterpart, due_at, next_check_at, status, source, created_at, updated_at,
       kind, site, event_at, ask_before, ask_after, must_confirm, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'before')`,
  ).run(
    id,
    c.title,
    c.detail ?? null,
    c.owner,
    c.counterpart ?? null,
    iso(c.due_at),
    iso(check),
    c.source ?? null,
    ts,
    ts,
    c.kind ?? null,
    c.site ?? null,
    iso(c.event_at),
    c.ask_before ?? null,
    c.ask_after ?? null,
    c.must_confirm ? 1 : 0,
  );
  audit("brain", "commitment.added", id, { title: c.title, owner: c.owner, due_at: c.due_at, kind: c.kind, next_check_at: iso(check) });
  return id;
}

export function updateCommitment(id: string, f: { due_at?: string; next_check_at?: string; detail?: string; status?: "open" | "done" | "dropped"; note?: string }) {
  const cur = getCommitment(id);
  if (!cur) throw new Error(`No commitment ${id}`);
  const status = f.status ?? cur.status;
  db.prepare(
    "UPDATE commitments SET due_at = ?, next_check_at = ?, detail = ?, status = ?, updated_at = ?, done_at = CASE WHEN ? IN ('done','dropped') THEN ? ELSE done_at END WHERE id = ?",
  ).run(
    f.due_at !== undefined ? iso(f.due_at) : cur.due_at,
    status !== "open" ? null : f.next_check_at !== undefined ? iso(f.next_check_at) : cur.next_check_at,
    f.detail ?? cur.detail,
    status,
    nowIso(),
    status,
    nowIso(),
    id,
  );
  audit("brain", status === "done" ? "commitment.done" : status === "dropped" ? "commitment.dropped" : "commitment.updated", id, { note: f.note });
}

export function getCommitment(id: string) {
  return db.prepare("SELECT * FROM commitments WHERE id = ?").get(id) as Commitment | undefined;
}

export function listCommitments(status: "open" | "done" | "all" = "open", limit = 30) {
  const where = status === "all" ? "" : "WHERE status = ?";
  const args = status === "all" ? [limit] : [status, limit];
  return db.prepare(`SELECT * FROM commitments ${where} ORDER BY COALESCE(due_at, next_check_at, created_at) LIMIT ?`).all(...args) as Commitment[];
}

export function dueCommitmentChecks(now = new Date()) {
  return db.prepare("SELECT * FROM commitments WHERE status = 'open' AND next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at").all(now.toISOString()) as Commitment[];
}

/* ---------------- memories ---------------- */

export type Memory = { id: string; kind: string; subject: string; fact: string; created_at: string };

export function remember(m: { kind: "user" | "person" | "project" | "preference"; subject: string; fact: string; replaces?: string; source?: string; valid_until?: string }) {
  const id = newId("mem");
  const ts = nowIso();
  db.prepare("INSERT INTO memories (id, kind, subject, fact, source, status, created_at, updated_at, valid_until) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)").run(
    id,
    m.kind,
    m.subject,
    m.fact,
    m.source ?? "user said",
    ts,
    ts,
    iso(m.valid_until),
  );
  if (m.replaces) {
    db.prepare("UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(id, ts, m.replaces);
  }
  audit("brain", "memory.saved", id, { kind: m.kind, subject: m.subject, fact: m.fact, replaces: m.replaces });
  return id;
}

export function forget(id: string) {
  db.prepare("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?").run(nowIso(), id);
  audit("user", "memory.forgotten", id);
}

/** Time-bound facts drop out once their date has passed. */
const CURRENT = "(valid_until IS NULL OR valid_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

export function recallMemories(query: string, limit = 15) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 6);
  if (!words.length) return activeMemories(limit);
  const clause = words.map(() => "(lower(subject) LIKE ? OR lower(fact) LIKE ?)").join(" OR ");
  const args = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
  return db.prepare(`SELECT id, kind, subject, fact, created_at FROM memories WHERE status = 'active' AND ${CURRENT} AND (${clause}) ORDER BY updated_at DESC LIMIT ?`).all(...args, limit) as Memory[];
}

export function activeMemories(limit = 40, kinds?: string[]) {
  const where = kinds?.length ? `AND kind IN (${kinds.map(() => "?").join(",")})` : "";
  return db.prepare(`SELECT id, kind, subject, fact, created_at FROM memories WHERE status = 'active' AND ${CURRENT} ${where} ORDER BY updated_at DESC LIMIT ?`).all(...(kinds ?? []), limit) as Memory[];
}

/* ---------------- routines ---------------- */

export type Routine = {
  id: string;
  title: string;
  instructions: string;
  schedule_json: string;
  delivery: "push" | "brief";
  status: string;
  builtin: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_outcome: string | null;
  failures: number;
};

export function createRoutine(r: { title: string; instructions: string; schedule: Schedule; delivery?: "push" | "brief"; builtin?: string }) {
  const schedule = validate(r.schedule);
  const next = nextRun(schedule);
  if (!next) throw new Error("That schedule never runs (is the time in the past?)");
  const id = newId("rtn");
  const ts = nowIso();
  db.prepare(
    "INSERT INTO routines (id, title, instructions, schedule_json, delivery, status, builtin, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)",
  ).run(id, r.title, r.instructions, JSON.stringify(schedule), r.delivery ?? "push", r.builtin ?? null, next.toISOString(), ts, ts);
  audit(r.builtin ? "system" : "brain", "routine.created", id, { title: r.title, schedule: describe(schedule) });
  return { id, when: describe(schedule), next_run_at: next.toISOString() };
}

export function listRoutines(includePaused = true) {
  const rows = db
    .prepare(`SELECT * FROM routines WHERE status ${includePaused ? "IN ('active','paused')" : "= 'active'"} ORDER BY builtin IS NULL, created_at`)
    .all() as Routine[];
  return rows.map((r) => ({ ...r, when: describe(JSON.parse(r.schedule_json) as Schedule) }));
}

export function getRoutine(id: string) {
  return db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as Routine | undefined;
}

export function setRoutineStatus(id: string, status: "active" | "paused" | "deleted") {
  const r = getRoutine(id);
  if (!r) throw new Error(`No routine ${id}`);
  const next = status === "active" ? nextRun(JSON.parse(r.schedule_json) as Schedule)?.toISOString() ?? null : r.next_run_at;
  db.prepare("UPDATE routines SET status = ?, failures = CASE WHEN ? = 'active' THEN 0 ELSE failures END, next_run_at = ?, updated_at = ? WHERE id = ?").run(
    status,
    status,
    next,
    nowIso(),
    id,
  );
  audit("user", `routine.${status}`, id, { title: r.title });
}

export function updateRoutine(id: string, f: { title?: string; instructions?: string; schedule?: Schedule; delivery?: "push" | "brief" }) {
  const r = getRoutine(id);
  if (!r) throw new Error(`No routine ${id}`);
  const schedule = f.schedule ? validate(f.schedule) : (JSON.parse(r.schedule_json) as Schedule);
  const next = nextRun(schedule);
  db.prepare("UPDATE routines SET title = ?, instructions = ?, schedule_json = ?, delivery = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(
    f.title ?? r.title,
    f.instructions ?? r.instructions,
    JSON.stringify(schedule),
    f.delivery ?? r.delivery,
    next?.toISOString() ?? null,
    nowIso(),
    id,
  );
  audit("user", "routine.updated", id, { title: f.title ?? r.title, schedule: describe(schedule) });
  return { when: describe(schedule), next_run_at: next?.toISOString() ?? null };
}

export function dueRoutines(now = new Date()) {
  return db.prepare("SELECT * FROM routines WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at").all(now.toISOString()) as Routine[];
}

/** Record a run and schedule the next one. Three failures in a row pause the routine. */
export function finishRoutineRun(id: string, ok: boolean, outcome: string): { paused: boolean } {
  const r = getRoutine(id);
  if (!r) return { paused: false };
  const schedule = JSON.parse(r.schedule_json) as Schedule;
  const next = nextRun(schedule);
  const failures = ok ? 0 : r.failures + 1;
  const paused = failures >= 3;
  const status = paused ? "paused" : next ? r.status : schedule.kind === "once" ? "deleted" : r.status;
  db.prepare("UPDATE routines SET last_run_at = ?, last_outcome = ?, failures = ?, next_run_at = ?, status = ?, updated_at = ? WHERE id = ?").run(
    nowIso(),
    outcome.slice(0, 500),
    failures,
    next?.toISOString() ?? null,
    status,
    nowIso(),
    id,
  );
  return { paused };
}

// The wording the built-ins were first created with: replaced by the current wording, unless the user changed it.
const OLD_BRIEF =
  "Give the user their morning brief for today. Check today's job status, open commitments that are due or overdue, " +
  "anything waiting for their approval, and anything that came up overnight. Lead with the single most important thing. " +
  "Keep the spoken part to 3 or 4 short sentences and put the details in the card. Always notify.";
const OLD_WRAP =
  "Do the end-of-day wrap. Look at today's conversation and what got done, then list what is still open for tomorrow " +
  "and any follow-ups that should be scheduled (add commitments for them). 2 or 3 spoken sentences, details in the card. " +
  "Only notify if something is still open or needs a decision.";
// v2 wording (follow-up questions, before offers), replaced on startup like OLD_BRIEF.
const BRIEF_V2 =
  "Give the user their morning brief for today. Check today's job status, open commitments due or overdue, anything waiting " +
  "for their approval, and anything that came up overnight. Lead with the single most important thing. Then ask, once each, " +
  "any follow-up questions that went unanswered (the Context lists them under \"You asked the user\"): one short question each. " +
  "Keep the spoken part to 3 or 4 short sentences and put the details in the card. Always notify.";
// v3 wording (before Stage 7.5: "Always notify"), replaced on startup like the others.
const BRIEF_V3 =
  "Give the user their morning brief for today. Check today's job status, open commitments due or overdue, anything waiting " +
  "for their approval, and anything that came up overnight; use Yesterday in brief for continuity. Lead with the single most " +
  "important thing. Then ask, once each, any follow-up questions that went unanswered (the Context lists them under \"You asked " +
  "the user\") and at most one thing noticed but not tracked: one short question each. " +
  "Keep the spoken part to 3 or 4 short sentences and put the details in the card. Always notify.";
const WRAP_V2 =
  "Do the end-of-day wrap. Look at today's conversation and what got done. For the user's own open items due today or " +
  "tomorrow that you haven't asked about today, ask if they're sorted (one short question each). Finish with \"Anything for " +
  "tomorrow?\" 2 or 3 spoken sentences, details in the card. Only notify if something is still open or needs a decision.";
// Stage 7.5: quiet when there's nothing new. Only real reasons, never a repeat, and drawing or file findings aren't news.
const NOT_NEWS =
  "Leave out anything under \"Already told them\" unless it has changed. Things found in a drawing or a file while answering a " +
  "question aren't brief material unless the user asked you to watch them (an open commitment or a routine). ";
const TOLD = "In told_commitments put the id of every commitment you mentioned, and in told_points a few words for each other point. ";
const BRIEF_INSTRUCTIONS =
  "The morning brief, only if there's a reason for it. Reasons: an open commitment due today or tomorrow, anything overdue, " +
  "anything waiting for the user's approval tap, a follow-up question that went unanswered (the Context lists them under \"You " +
  "asked the user\"), or something new since the last brief (overnight, or in Yesterday in brief). " +
  NOT_NEWS +
  "If there's a reason: notify, lead with the single most important thing, ask each unanswered follow-up question once (one " +
  "short question each), 2 to 4 short spoken sentences, details in the card. " +
  TOLD +
  "If there's no reason: notify false and nothing else. Never a brief just to say good morning or that nothing's on.";
const WRAP_INSTRUCTIONS =
  "The end-of-day wrap, only if there's a reason for it. Look at today's conversation and what got done. For the user's own " +
  "open items due today or tomorrow that you haven't asked about today, ask if they're sorted (one short question each). " +
  NOT_NEWS +
  "Notify only if something is still open for today or tomorrow, or needs a decision; then 2 or 3 spoken sentences, details " +
  "in the card, and you may finish with \"Anything for tomorrow?\". " +
  TOLD +
  "Otherwise notify false.";
/** Earlier wordings of the built-ins, replaced on start-up when the routine still has them word for word (for tests). */
export const OLD_BUILTIN_WORDING = { morning_brief: [OLD_BRIEF, BRIEF_V2, BRIEF_V3], wrap_up: [OLD_WRAP, WRAP_V2] } as const;
export const BUILTIN_WORDING = { morning_brief: BRIEF_INSTRUCTIONS, wrap_up: WRAP_INSTRUCTIONS } as const;

/** The morning brief and end-of-day wrap are ordinary routines, created once (and their wording kept current unless the user changed it). */
export function ensureBuiltinRoutines() {
  const days = JSON.parse(getSetting("workdays")) as number[];
  const has = (b: string) => !!db.prepare("SELECT 1 FROM routines WHERE builtin = ?").get(b);
  if (!has("morning_brief")) {
    createRoutine({ title: "Morning brief", builtin: "morning_brief", schedule: { kind: "weekly", days, time: getSetting("brief_time") }, instructions: BRIEF_INSTRUCTIONS });
  }
  if (!has("wrap_up")) {
    createRoutine({ title: "End-of-day wrap", builtin: "wrap_up", schedule: { kind: "weekly", days, time: getSetting("wrap_time") }, instructions: WRAP_INSTRUCTIONS });
  }
  for (const b of ["morning_brief", "wrap_up"] as const)
    for (const old of OLD_BUILTIN_WORDING[b]) db.prepare("UPDATE routines SET instructions = ?, updated_at = ? WHERE builtin = ? AND instructions = ?").run(BUILTIN_WORDING[b], nowIso(), b, old);
}

const iso = (v: string | undefined | null) => {
  if (!v) return null;
  const d = parseLocal(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Bad date-time "${v}"`);
  return d.toISOString();
};
