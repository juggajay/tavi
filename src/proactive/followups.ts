// The "did you get it sorted?" loop. Plain code, no AI: the brain wrote the questions when the user agreed to
// tracking; this decides WHEN to ask and what to do with the answer.
// - Before it's due: one question at a working window (6:00 brief, 12:00 lunch, 15:30 wrap), or straight away if
//   it's inside 24 hours. Once if it goes overdue. "How did it go?" after an inspection, meeting or goal.
// - Never re-pushed when unanswered: it rides along once in the next brief instead (see context.ts).
// - The user's stop words live in the controls table and are checked here, before anything is queued.
import { db, newId, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { getSetting, type Commitment } from "../store/proactive.js";
import { queueNotification } from "./notify.js";
import { addDays, atLocal, formatLocal, localDay, parseLocal, weekdayOf } from "../time.js";

export type FollowUp = Commitment & {
  kind: string | null;
  site: string | null;
  event_at: string | null;
  ask_before: string | null;
  ask_after: string | null;
  must_confirm: number;
  muted: number;
  stage: string | null;
  asks: number;
  last_asked_at: string | null;
  last_answer: string | null;
  outcome: string | null;
};

/* ---------------- windows: the natural breaks in a site day ---------------- */

/** That time of day on a local date ("2026-11-11"), in the owner's time zone. */
const at = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return atLocal(day, h || 0, m || 0);
};
const windowTimes = () => [getSetting("brief_time") || "06:00", getSetting("lunch_time") || "12:00", getSetting("wrap_time") || "15:30"];

/** The next window strictly after `after`, on a workday (the days the brief and wrap run). Time-critical items don't wait for one. */
export function nextWindow(after = new Date()): Date {
  const workdays = JSON.parse(getSetting("workdays") || "[1,2,3,4,5]") as number[];
  const today = localDay(after);
  for (let d = 0; d < 9; d++) {
    const day = addDays(today, d);
    if (workdays.length && !workdays.includes(weekdayOf(day))) continue;
    for (const t of windowTimes()) {
      const w = at(day, t);
      if (w > after) return w;
    }
  }
  return new Date(after.getTime() + 3600_000);
}
const briefOn = (day: Date) => at(localDay(day), getSetting("brief_time") || "06:00");
const wrapOn = (day: Date) => at(localDay(day), getSetting("wrap_time") || "15:30");

/** Two working days before (Mon-Fri), at the morning brief. */
function workingDaysBefore(t: Date, n: number) {
  let day = localDay(t);
  let left = n;
  while (left > 0) {
    day = addDays(day, -1);
    if (weekdayOf(day) !== 0 && weekdayOf(day) !== 6) left--;
  }
  return at(day, getSetting("brief_time") || "06:00");
}

/* ---------------- the user's controls ---------------- */

export function getControl(key: string): string | null {
  return (db.prepare("SELECT value FROM controls WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}
function setControl(key: string, value: string | null) {
  if (value === null) db.prepare("DELETE FROM controls WHERE key = ?").run(key);
  else db.prepare("INSERT INTO controls (key, value, set_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at").run(key, value, nowIso());
}
const list = (key: string) => JSON.parse(getControl(key) ?? "[]") as string[];

export function pausedUntil(now = new Date()): Date | null {
  const v = getControl("pause_until");
  return v && new Date(v) > now ? new Date(v) : null;
}
const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
export const isMuted = (c: FollowUp) => !!c.muted || list("muted_kinds").includes(norm(c.kind)) || (!!c.site && list("muted_sites").includes(norm(c.site)));

/** From the user's own words, via the brain (never from a background run or a turn that read outside content). */
export function setControls(f: { pause_until?: string; resume?: boolean; mute_kinds?: string[]; unmute_kinds?: string[]; mute_sites?: string[]; unmute_sites?: string[] }) {
  if (f.resume) setControl("pause_until", null);
  if (f.pause_until) {
    const d = parseLocal(f.pause_until);
    if (Number.isNaN(d.getTime()) || d <= new Date()) throw new Error("pause_until must be a future date-time.");
    setControl("pause_until", d.toISOString());
  }
  const edit = (key: string, add?: string[], remove?: string[]) => {
    const cur = new Set(list(key));
    for (const v of add ?? []) cur.add(norm(v));
    for (const v of remove ?? []) cur.delete(norm(v));
    setControl(key, cur.size ? JSON.stringify([...cur]) : null);
  };
  edit("muted_kinds", f.mute_kinds, f.unmute_kinds);
  edit("muted_sites", f.mute_sites, f.unmute_sites);
  audit("user", "followups.controls", null, { now: describeControls() || "normal" });
  return describeControls() || "Following up as normal.";
}

export function describeControls(now = new Date()): string {
  const parts: string[] = [];
  const p = pausedUntil(now);
  if (p) parts.push(`paused until ${formatLocal(p, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} (reminders set for a time still come through)`);
  const k = list("muted_kinds");
  if (k.length) parts.push(`not chasing: ${k.join(", ")}`);
  const s = list("muted_sites");
  if (s.length) parts.push(`leaving alone: ${s.join(", ")}`);
  return parts.join("; ");
}

/* ---------------- planning when to ask ---------------- */

const AFTER_KINDS = new Set(["inspect", "meeting", "goal"]);

/** When to first ask about a newly tracked item, if the user didn't name a time. */
export function planFirstCheck(c: { kind?: string | null; due_at?: string | null; event_at?: string | null }, now = new Date()): Date {
  const target = c.due_at ? parseLocal(c.due_at) : c.event_at ? parseLocal(c.event_at) : null;
  if (!target) return now < wrapOn(now) ? wrapOn(now) : nextWindow(wrapOn(now)); // today's wrap, else the next morning
  let t: Date;
  if (c.kind === "book" || c.kind === "order") t = workingDaysBefore(target, 2);
  else if (c.kind === "inspect" || c.kind === "meeting") t = briefOn(target);
  else t = briefOn(target);
  if (t > target) t = new Date(target.getTime() - 3600_000);
  return t > now ? t : nextWindow(now);
}

/** After asking, what's the next question and when (or nothing: it stays on the open list). */
function nextAfterAsk(c: FollowUp, trigger: string, now: Date): { stage: string | null; at: Date | null } {
  const due = c.due_at ? parseLocal(c.due_at) : null;
  const event = c.event_at ? parseLocal(c.event_at) : null;
  const after = () => (c.ask_after && event ? { stage: "after", at: nextWindow(event > now ? event : now) } : { stage: null, at: null });
  if (c.must_confirm) {
    // Permits, inspections, safety: every window until it's done.
    if (!(trigger === "after")) return { stage: due && due < now ? "overdue" : trigger, at: nextWindow(now) };
  }
  if (trigger === "before") {
    if (AFTER_KINDS.has(c.kind ?? "") && c.ask_after && event) return after();
    if (due && due > now) return { stage: "overdue", at: nextWindow(due) };
    return after();
  }
  if (trigger === "overdue") return after();
  return { stage: null, at: null };
}

/* ---------------- asking ---------------- */

const dayName = (iso: string) => formatLocal(iso, { weekday: "long" });

export function questionFor(c: FollowUp, trigger: string, now = new Date()): string {
  let line =
    trigger === "after"
      ? c.ask_after ?? `How did it go: ${c.title}?`
      : trigger === "overdue"
        ? `${c.title}${c.site ? ` at ${c.site}` : ""} is past due. Sorted, or want a hand with it?`
        : c.ask_before ?? `${c.title}${c.site ? ` at ${c.site}` : ""}. Sorted yet?`;
  if (now.getTime() - new Date(c.created_at).getTime() > 30 * 3600_000 && trigger !== "after") line += ` (You raised it ${dayName(c.created_at)}.)`;
  return line;
}

/**
 * Ask one follow-up now. Inside 24 hours of the deadline (or a must-confirm item) it pushes straight away;
 * otherwise it shares the buzz with anything else due at this window.
 */
export function askFollowUp(c: FollowUp, now = new Date()) {
  const trigger = c.stage ?? "before";
  const line = questionFor(c, trigger, now);
  const target = c.due_at ?? c.event_at;
  const critical = !!c.must_confirm || (!!target && new Date(target).getTime() - now.getTime() < 24 * 3600_000 && trigger !== "after");
  const notificationId = queueNotification({
    title: c.site || "Follow-up",
    spoken: line,
    priority: "normal",
    source: `commitment:${c.id}`,
    bundle: !critical,
  });
  db.prepare("INSERT INTO proactive_log (id, item_id, trigger, line, notification_id, asked_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    newId("pask"),
    c.id,
    trigger,
    line,
    notificationId,
    nowIso(),
  );
  const next = nextAfterAsk(c, trigger, now);
  db.prepare("UPDATE commitments SET stage = ?, next_check_at = ?, asks = asks + 1, last_asked_at = ?, last_answer = NULL, updated_at = ? WHERE id = ?").run(
    next.stage,
    next.at?.toISOString() ?? null,
    nowIso(),
    nowIso(),
    c.id,
  );
  audit("system", "followup.asked", c.id, { title: c.title, trigger, line, critical });
}

/** A reminder the user set for an exact time: push it then, even while paused. */
export function sendReminder(c: FollowUp) {
  db.prepare("UPDATE commitments SET next_check_at = NULL, asks = asks + 1, last_asked_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), c.id);
  const notificationId = queueNotification({ title: "Reminder", spoken: c.ask_before ?? `Reminder: ${c.title}.`, priority: "normal", source: `commitment:${c.id}`, exact: true });
  db.prepare("INSERT INTO proactive_log (id, item_id, trigger, line, notification_id, asked_at) VALUES (?, ?, 'reminder', ?, ?, ?)").run(newId("pask"), c.id, c.title, notificationId, nowIso());
  audit("system", "commitment.reminded", c.id, { title: c.title });
}

/* ---------------- answers ---------------- */

export type Answer = "done" | "already_done" | "not_yet" | "later" | "stop_asking" | "blocked";

/** The user answered a follow-up (by voice, through the brain). */
export function answerFollowUp(id: string, answer: Answer, opts: { when?: string; note?: string } = {}, now = new Date()) {
  const c = db.prepare("SELECT * FROM commitments WHERE id = ?").get(id) as FollowUp | undefined;
  if (!c) throw new Error(`No commitment ${id}`);
  let status = c.status;
  let next: string | null = c.next_check_at;
  let stage = c.stage;
  let muted = c.muted;
  let outcome = c.outcome ?? null;
  const event = c.event_at ? parseLocal(c.event_at) : null;
  if (answer === "done" || answer === "already_done") {
    if (stage !== "after" && AFTER_KINDS.has(c.kind ?? "") && c.ask_after && event && event > now) {
      stage = "after"; // e.g. inspection booked: still ask how it went afterwards
      next = nextWindow(event).toISOString();
    } else {
      status = "done";
      next = null;
    }
    if (opts.note) outcome = opts.note;
  } else if (answer === "not_yet") {
    next = nextWindow(now).toISOString();
  } else if (answer === "later") {
    const w = opts.when ? parseLocal(opts.when) : null;
    if (!w || Number.isNaN(w.getTime())) throw new Error("For 'later', pass when (ISO date-time), e.g. Monday's brief.");
    next = (w > now ? w : nextWindow(now)).toISOString();
  } else if (answer === "stop_asking") {
    muted = 1;
    next = null;
  } else if (answer === "blocked") {
    outcome = opts.note ?? "blocked";
    next = nextWindow(new Date(now.getTime() + 12 * 3600_000)).toISOString();
  }
  db.prepare(
    "UPDATE commitments SET status = ?, next_check_at = ?, stage = ?, muted = ?, outcome = ?, last_answer = ?, updated_at = ?, done_at = CASE WHEN ? = 'done' THEN ? ELSE done_at END WHERE id = ?",
  ).run(status, next, stage, muted, outcome, answer, nowIso(), status, nowIso(), id);
  db.prepare(
    "UPDATE proactive_log SET answer = ?, answered_at = ? WHERE id = (SELECT id FROM proactive_log WHERE item_id = ? AND answer IS NULL ORDER BY asked_at DESC LIMIT 1)",
  ).run(answer, nowIso(), id);
  audit("user", status === "done" ? "commitment.done" : "followup.answered", id, { title: c.title, answer, note: opts.note });
  return { status, next_check_at: next, muted: !!muted };
}

/** Asked in the last day and not answered: the brain should know what "it" is, and the brief carries them once. */
export function awaitingAnswers(now = new Date()) {
  return db
    .prepare(
      `SELECT c.id, l.line, l.asked_at FROM proactive_log l JOIN commitments c ON c.id = l.item_id
       WHERE l.answer IS NULL AND l.asked_at >= ? AND c.status = 'open' AND l.trigger != 'reminder' ORDER BY l.asked_at DESC LIMIT 6`,
    )
    .all(new Date(now.getTime() - 26 * 3600_000).toISOString()) as { id: string; line: string; asked_at: string }[];
}
