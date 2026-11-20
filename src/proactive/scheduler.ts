// The heartbeat. Plain code checks the clock every 30 s; Claude only runs when a routine or follow-up is due.
import { clearMissedForLimit, LimitError, limitIn, missedNote, noteMissedForLimit } from "../brain/limit.js";
import { db, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { createJob, failJob, finishJob, startJob } from "../store/jobs.js";
import { dueCommitmentChecks, dueRoutines, ensureBuiltinRoutines, finishRoutineRun, getSetting, setSetting, type Commitment, type Routine } from "../store/proactive.js";
import { resetConversation, runBackground, warmUp } from "../brain/brain.js";
import { runKeeper } from "../memory/keeper.js";
import { writeOpener } from "../memory/opener.js";
import { alreadyToldSection, recordTold } from "./told.js";
import { oldPinsNote, oldPinsTold } from "../store/pins.js";
import { checkGuideUpdates, guideUpdatesNote, guideUpdatesTold } from "../reference/guides.js";
import { buildContext } from "../brain/context.js";
import { deliverDue, queueNotification } from "./notify.js";
import { askFollowUp, isMuted, pausedUntil, sendReminder, type FollowUp } from "./followups.js";
import { formatLocal, partsIn } from "../time.js";
import { runProactive, writeTeamOpener, type TeamRoutine } from "./runner.js";

const TICK_MS = 30_000;
let busy = false;
const listeners = new Set<(e: { type: "background"; phase: "start" | "end"; title: string }) => void>();
export const onScheduler = (fn: (e: { type: "background"; phase: "start" | "end"; title: string }) => void) => listeners.add(fn);

export function startScheduler() {
  ensureBuiltinRoutines();
  setTimeout(tick, 5_000);
  setInterval(tick, TICK_MS);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = new Date();
    for (const r of dueRoutines(now)) await runRoutine(r);
    // Follow-ups: plain code asks the user's own items; only "someone owes you" needs the AI (to check their email).
    const paused = !!pausedUntil(now);
    const aiChecks: FollowUp[] = [];
    for (const c of dueCommitmentChecks(now) as FollowUp[]) {
      const reminder = c.kind === "remind" || (!c.kind && c.owner.toLowerCase() === "user" && !c.counterpart);
      if (reminder) {
        sendReminder(c); // a time the user set: comes through even while paused
        continue;
      }
      if (paused || isMuted(c)) continue; // stays due; asked once the pause ends or it's unmuted
      if (c.owner.toLowerCase() === "user") askFollowUp(c, now);
      else aiChecks.push(c);
    }
    for (const c of aiChecks.slice(0, 3)) await runCommitmentCheck(c);
    await deliverDue(new Date());
    await morningOpener(now);
    await nightlyFreshStart(now);
    monthlyGuideCheck(now);
  } catch (err) {
    console.error("[scheduler]", err instanceof Error ? err.message : err);
  } finally {
    busy = false;
  }
}

/**
 * Once a night (from 2am): the memory keeper reads the rest of the day, then the brain starts a fresh conversation.
 * Each day begins small and focused, with "yesterday in brief" and everything that matters already saved.
 */
async function nightlyFreshStart(now: Date) {
  const { h: hour, ymd: day } = partsIn(now);
  if (hour < 2 || hour >= 5 || getSetting("fresh_start_day") === day) return;
  setSetting("fresh_start_day", day);
  await runKeeper("nightly");
  if (process.env.LH_V3 !== "1") { resetConversation(); warmUp(); }
  audit("system", "brain.fresh_start", null, { day });
}

let guideCheck: Promise<unknown> | null = null;
/**
 * Once a month, at night (from 2am): look at each maker's guide on its maker's site for a newer copy (14.1). It runs on
 * its own (a look at each, a pause between), so the tick never waits on it. What it finds is told once, in the morning
 * brief. The first look is a month after the guides arrive.
 */
export function monthlyGuideCheck(now: Date, check: typeof checkGuideUpdates = checkGuideUpdates) {
  const last = Date.parse(getSetting("guides_checked_at"));
  if (!Number.isFinite(last)) return setSetting("guides_checked_at", now.toISOString());
  const { h } = partsIn(now);
  if (guideCheck || h < 2 || h >= 5 || now.getTime() - last < 30 * 86_400_000) return;
  setSetting("guides_checked_at", now.toISOString());
  guideCheck = check()
    .then((found) => audit("system", "guides.checked", null, { found: found.length }))
    .catch((err) => console.warn("[guides] check:", err instanceof Error ? err.message : err))
    .finally(() => (guideCheck = null));
  return guideCheck;
}

/** Once a morning, at the brief time: rewrite the opening line from what's on today (memory/opener.ts). */
async function morningOpener(now: Date) {
  const { h, mi, ymd: day } = partsIn(now);
  const [bh, bm] = getSetting("brief_time").split(":").map(Number);
  if (h * 60 + mi < bh * 60 + bm || getSetting("opener_day") === day) return;
  setSetting("opener_day", day);
  await writeOpener("morning", process.env.LH_V3 === "1" ? writeTeamOpener : undefined);
}

/** Run one routine now (also used by "Run now" in the PC app). */
/** run: the background brain (tests pass a stub). now: the time the brief or wrap is for (tests move it). */
export async function runRoutine(r: TeamRoutine, opts: { run?: typeof runBackground; now?: Date } = {}) {
  const run = opts.run ?? ((task: string) => runProactive(task, r));
  const now = opts.now ?? new Date();
  // Push next_run_at forward before running, so a crash mid-run can't make it fire again and again.
  db.prepare("UPDATE routines SET next_run_at = NULL WHERE id = ?").run(r.id);
  const jobId = createJob("routine", r.id, r.instructions);
  startJob(jobId, { current: false });
  audit("system", "routine.run", r.id, { title: r.title });
  listeners.forEach((fn) => fn({ type: "background", phase: "start", title: r.title }));
  try {
    // The brief and the wrap are told what they've already said, so they don't say it again (proactive/told.ts).
    const told = r.builtin ? alreadyToldSection(now) : "";
    const pins = r.builtin === "wrap_up" ? oldPinsNote(now) : { text: "", ids: [] }; // pins over a week old: said once (13.2)
    const guides = r.builtin === "morning_brief" ? guideUpdatesNote() : { text: "", ids: [] }; // newer makers' guides: said once (14.1)
    const missedText = r.builtin === "morning_brief" ? missedNote() : ""; // what didn't run while the plan's limit was reached (21)
    const missed = process.env.LH_V3 === "1" ? missedText.replace("his Claude plan's usage limit", "a subscription's usage limit") : missedText;
    const res = await run(`Routine: "${r.title}"\nInstructions: ${r.instructions}\n\nContext:\n${buildContext("", undefined, { background: true })}${told ? `\n${told}` : ""}${pins.text ? `\n${pins.text}` : ""}${guides.text ? `\n${guides.text}` : ""}${missed ? `\n${missed}` : ""}`);
    finishJob(jobId, res);
    // Even the morning brief only comes through when there's something to say.
    if (res.notify && r.builtin) recordTold(r.builtin, res.told_commitments, res.told_points, now);
    if (res.notify) oldPinsTold(pins.ids);
    if (res.notify) guideUpdatesTold(guides.ids, now);
    if (missed && res.notify) clearMissedForLimit();
    if (res.notify) {
      queueNotification({
        title: res.title,
        spoken: res.spoken,
        card: res.card,
        // The user asked for this routine, so it always comes through as a real notification.
        priority: r.delivery === "brief" ? "low" : res.priority === "urgent" ? "urgent" : "normal",
        source: `routine:${r.id}`,
      });
    }
    finishRoutineRun(r.id, true, res.notify ? res.title : "Nothing to report");
    audit("brain", "routine.done", r.id, { title: r.title, notified: res.notify, ms: res.ms });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failJob(jobId, msg);
    // his plan's limit isn't the routine's fault: it doesn't count towards pausing it, and the next brief says it missed
    const lim = err instanceof LimitError ? err.limit : limitIn(msg);
    if (lim) {
      noteMissedForLimit(r.title, lim, now);
      finishRoutineRun(r.id, true, process.env.LH_V3 === "1" ? "Missed: a subscription's usage limit was reached" : "Missed: the Claude plan's usage limit was reached");
      audit("system", "routine.missed_limit", r.id, { title: r.title });
      return;
    }
    const { paused } = finishRoutineRun(r.id, false, msg);
    audit("system", "routine.failed", r.id, { title: r.title, error: msg, paused });
    if (paused) {
      queueNotification({
        title: `Paused: ${r.title}`,
        spoken: `I've paused your "${r.title}" routine because it failed three times in a row. You can turn it back on in Setup on your PC.`,
        priority: "normal",
        source: `routine:${r.id}`,
      });
    }
  } finally {
    listeners.forEach((fn) => fn({ type: "background", phase: "end", title: r.title }));
  }
}

/** Someone owes the user something (or Tavi said it would check): look for it with read tools, then report. */
export async function runCommitmentCheck(c: Commitment) {
  // Provisional next check in 4 hours, so a failure doesn't re-run it every tick. The brain usually sets a better one.
  db.prepare("UPDATE commitments SET next_check_at = ?, updated_at = ? WHERE id = ?").run(new Date(Date.now() + 4 * 3600_000).toISOString(), nowIso(), c.id);
  const jobId = createJob("followup", c.id, c.title);
  startJob(jobId, { current: false });
  audit("system", "commitment.check", c.id, { title: c.title });
  try {
    const due = c.due_at ? formatLocal(c.due_at, { dateStyle: "medium", timeStyle: "short" }) : "no due date";
    const res = await runProactive(
      `Follow-up check for commitment [${c.id}]: "${c.title}" (owner: ${c.owner}${c.counterpart ? `, with ${c.counterpart}` : ""}; due ${due}).` +
        (c.detail ? ` Detail: ${c.detail}.` : "") +
        `\nCheck whether it has happened with your tools (for example, search email for a reply${c.counterpart ? ` from ${c.counterpart}` : ""}). ` +
        "If it's done, call update_commitment with status done. If not, decide the next step: if someone needs chasing, draft the chase " +
        "(it waits for the user's tap) and set next_check_at to tomorrow morning; if it's the user's own task, remind them. " +
        `Notify unless it's done and needs nothing.\n\nContext:\n${buildContext("", undefined, { background: true })}`,
    );
    finishJob(jobId, res);
    if (res.notify) queueNotification({ title: res.title, spoken: res.spoken, card: res.card, priority: res.priority, source: `commitment:${c.id}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failJob(jobId, msg);
    audit("system", "commitment.check_failed", c.id, { error: msg });
    const lim = err instanceof LimitError ? err.limit : limitIn(msg);
    if (lim) noteMissedForLimit(`checking on "${c.title}"`, lim);
  }
}
