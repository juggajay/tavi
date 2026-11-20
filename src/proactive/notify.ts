// Deciding when to tell the user something, and getting it to them.
// Policy: urgent goes now; normal respects quiet hours and a daily interruption budget; low waits for the app/brief.
import { db, newId, nowIso } from "../store/db.js";
import { audit, logConversation } from "../store/log.js";
import { getSetting, inQuietHours, quietEndsAt } from "../store/proactive.js";
import { startOfDay } from "../time.js";

export type Priority = "urgent" | "normal" | "low";
/** source: what it came from ("task:<job>" for a piece of work, Stage 21.3), for the channels that treat it differently. */
export type Notice = { id: string; title: string; spoken: string; card: unknown; priority: Priority; created_at: string; source?: string };
type Channel = (n: Notice, opts: { push: boolean }) => Promise<void> | void;

const channels: Channel[] = [];
export const addChannel = (c: Channel) => channels.push(c);

function nextBrief(): Date {
  const r = db.prepare("SELECT next_run_at FROM routines WHERE builtin = 'morning_brief' AND status = 'active'").get() as { next_run_at: string } | undefined;
  return r?.next_run_at ? new Date(r.next_run_at) : quietEndsAt();
}

function pushesToday(): number {
  const start = startOfDay();
  return (
    db.prepare("SELECT COUNT(*) n FROM notifications WHERE delivered_at >= ? AND priority IN ('urgent','normal')").get(start.toISOString()) as { n: number }
  ).n;
}

/** One buzz for several follow-ups due at the same window (set by the gateway to Web Push). */
let bundlePush: ((title: string, body: string) => Promise<void>) | undefined;
export const setBundlePush = (fn: (title: string, body: string) => Promise<void>) => (bundlePush = fn);

/**
 * exact: a reminder the user set for a specific time (comes through even while paused).
 * bundle: a non-urgent follow-up that can share one buzz with others due at the same moment.
 */
export function queueNotification(n: { title: string; spoken: string; card?: unknown; priority: Priority; source: string; exact?: boolean; bundle?: boolean }) {
  const id = newId("ntf");
  db.prepare(
    "INSERT INTO notifications (id, title, spoken, card_json, priority, status, source, deliver_after, created_at, exact, bundle) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
  ).run(id, n.title, n.spoken, n.card ? JSON.stringify(n.card) : null, n.priority, n.source, nowIso(), nowIso(), n.exact ? 1 : 0, n.bundle ? 1 : 0);
  audit("system", "notification.queued", id, { title: n.title, priority: n.priority, source: n.source });
  return id;
}

/** Deliver whatever is due, applying the user's pause, quiet hours and interruption budget (the last two only if they set them). */
export async function deliverDue(now = new Date()) {
  const due = db.prepare("SELECT * FROM notifications WHERE status = 'queued' AND deliver_after <= ? ORDER BY created_at").all(now.toISOString()) as (Notice & {
    card_json: string | null;
    exact: number;
    bundle: number;
  })[];
  // "Go quiet till Monday": everything proactive waits, except reminders the user set for a time.
  const pause = db.prepare("SELECT value FROM controls WHERE key = 'pause_until'").get() as { value: string } | undefined;
  const pausedTill = pause && new Date(pause.value) > now ? pause.value : null;
  const bundled = due.filter((r) => r.bundle && !(pausedTill && !r.exact) && !(r.priority === "normal" && inQuietHours(now)));
  const shareBuzz = bundled.length >= 2 && !!bundlePush;
  for (const row of due) {
    const notice: Notice = { id: row.id, title: row.title, spoken: row.spoken, card: row.card_json ? JSON.parse(row.card_json) : null, priority: row.priority, created_at: row.created_at, source: (row as { source?: string }).source };
    if (pausedTill && !row.exact) {
      db.prepare("UPDATE notifications SET deliver_after = ? WHERE id = ?").run(pausedTill, row.id);
      continue;
    }
    let push = notice.priority !== "low";
    if (notice.priority === "normal") {
      if (inQuietHours(now)) {
        db.prepare("UPDATE notifications SET deliver_after = ? WHERE id = ?").run(quietEndsAt(now).toISOString(), row.id);
        continue;
      }
      const cap = Number(getSetting("max_interruptions"));
      if (cap > 0 && pushesToday() >= cap) push = false; // only if the user asked for a limit: still shows in the app, no buzz
    }
    if (shareBuzz && row.bundle) push = false; // one combined buzz below
    for (const c of channels) {
      try {
        await c(notice, { push });
      } catch (err) {
        console.warn("[notify] channel failed:", err instanceof Error ? err.message : err);
      }
    }
    db.prepare("UPDATE notifications SET status = 'delivered', delivered_at = ? WHERE id = ?").run(nowIso(), row.id);
    // The thread shows what it said first, too; a background task's line carries its job, so its items show with it.
    logConversation("assistant", "proactive", notice.spoken, /^task:(.+)$/.exec((row as { source?: string }).source ?? "")?.[1] ?? null);
    if (!(shareBuzz && row.bundle)) audit("system", push ? "notification.pushed" : "notification.delivered_quietly", row.id, { title: row.title });
  }
  if (shareBuzz) {
    const body = bundled.map((r) => r.spoken.replace(/\s*\(You raised it \w+\.\)$/, "")).join(" · ");
    try {
      await bundlePush!(`${bundled.length} things to check`, body.length > 230 ? `${body.slice(0, 227)}…` : body);
    } catch (err) {
      console.warn("[notify] bundle push failed:", err instanceof Error ? err.message : err);
    }
    audit("system", "notification.pushed", null, { title: `${bundled.length} things to check`, bundled: bundled.map((r) => r.id) });
  }
}

export function listWaiting() {
  return (
    db.prepare("SELECT id, title, spoken, card_json, priority, created_at FROM notifications WHERE status = 'delivered' ORDER BY created_at DESC LIMIT 10").all() as (Notice & {
      card_json: string | null;
    })[]
  ).map((r) => ({ id: r.id, title: r.title, spoken: r.spoken, card: r.card_json ? JSON.parse(r.card_json) : null, priority: r.priority, created_at: r.created_at }));
}

export function markSeen(ids: string[]) {
  const stmt = db.prepare("UPDATE notifications SET status = 'seen', seen_at = ? WHERE id = ? AND status = 'delivered'");
  for (const id of ids) stmt.run(nowIso(), id);
}

export { nextBrief };
