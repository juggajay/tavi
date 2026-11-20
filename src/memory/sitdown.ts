// The sit-down: one short conversation, once, where the assistant gets to know the owner properly. Code owns the state
// (one settings key, "sitdown"); the brain reads it from the Context and moves it with one tool, sitdown_update, in a
// live turn only. It's offered once after the owner has said a few things, once more at least two days after a "later"
// (or no answer), then never again. The owner can start it any time by asking ("get to know me").
import { db, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { getSetting, setSetting } from "../store/proactive.js";
import { bus } from "../events.js";
import { SITDOWN_RULES } from "../brain/rules.js";

export type SitdownStatus = "not_offered" | "offered" | "in_progress" | "done" | "declined";
export type Sitdown = { status: SitdownStatus; covered: string[]; started_at: string | null; ended_at: string | null; offered_at: string | null; offers: number };

const KEY = "sitdown";
const DAY = 86_400_000;
const AGAIN_AFTER_MS = 2 * DAY;
const MAX_OFFERS = 2;
/** The words of the offer (the brain says it in its own words; the fake brain says exactly this). */
export const OFFER_LINE = "When you've got five minutes, I'd like to get to know you properly. It'll make me a lot more use to you. Now, or later?";
/** Marks the Context note that asks for the offer (the fake brain looks for it). */
export const OFFER_MARK = "Sit-down offer:";
export const JUST_OFFERED_MARK = "You just offered the sit-down";

const START: Sitdown = { status: "not_offered", covered: [], started_at: null, ended_at: null, offered_at: null, offers: 0 };

export function getSitdown(): Sitdown {
  try {
    const v = getSetting(KEY);
    return v ? { ...START, ...(JSON.parse(v) as Partial<Sitdown>) } : { ...START };
  } catch {
    return { ...START };
  }
}

const save = (s: Sitdown) => setSetting(KEY, JSON.stringify(s));

/**
 * Move the sit-down along (the brain's sitdown_update, or the fake brain). Throws with a plain reason if the move
 * doesn't make sense. "offered" counts an offer: after the second, offering again changes nothing.
 */
export function moveSitdown(change: { status?: SitdownStatus; covered?: string[] }, now = new Date()): Sitdown {
  const was = getSitdown();
  const s: Sitdown = { ...was, covered: [...was.covered] };
  const to = change.status;
  if (to && to !== was.status) {
    if (to === "not_offered") throw new Error("The sit-down can't be un-offered.");
    if (to === "offered") {
      if (was.status !== "not_offered") throw new Error(`The sit-down is ${was.status.replace("_", " ")}; it can't be offered now.`);
      s.status = "offered";
    } else if (to === "in_progress") {
      Object.assign(s, { status: "in_progress", started_at: now.toISOString(), ended_at: null, covered: [] });
    } else if (to === "done") {
      if (was.status !== "in_progress") throw new Error("The sit-down isn't on, so it can't be finished.");
      Object.assign(s, { status: "done", ended_at: now.toISOString() });
    } else if (to === "declined") {
      if (was.status === "done") throw new Error("The sit-down is already done.");
      Object.assign(s, { status: "declined", ended_at: now.toISOString() });
    }
  } else if (to === "in_progress") throw new Error("The sit-down is already on.");
  // Each offer is counted (a "later" or no answer leaves it at "offered", ready for one more go after two days).
  if (to === "offered" && s.offers < MAX_OFFERS) Object.assign(s, { offers: s.offers + 1, offered_at: now.toISOString() });
  for (const c of change.covered ?? []) {
    const t = c.trim().slice(0, 60);
    if (t && !s.covered.some((x) => x.toLowerCase() === t.toLowerCase())) s.covered.push(t);
  }
  s.covered = s.covered.slice(0, 12);
  save(s);
  if (s.status !== was.status) {
    audit("brain", `sitdown.${s.status}`, null, { was: was.status, offers: s.offers });
    bus.emit("sitdown", { status: s.status, was: was.status });
  }
  return s;
}

export const sitdownOn = () => getSitdown().status === "in_progress";

const ownerLines = () => (db.prepare("SELECT COUNT(*) n FROM conversation_log WHERE role = 'user' AND channel != 'test'").get() as { n: number }).n;

/** Time to make the offer: the first time once they've said three things, the second at least two days after the first. */
function offerDue(s: Sitdown, now: Date) {
  if (s.status === "not_offered") return ownerLines() >= 3;
  if (s.status === "offered" && s.offers < MAX_OFFERS) return !!s.offered_at && now.getTime() - new Date(s.offered_at).getTime() >= AGAIN_AFTER_MS;
  return false;
}

/** The sit-down is on offer (an offer is due, or the second one is still to come) or under way: no other getting-to-know-you questions meanwhile. */
export function sitdownBusy(now = new Date()) {
  const s = getSitdown();
  return s.status === "in_progress" || offerDue(s, now) || (s.status === "offered" && s.offers < MAX_OFFERS);
}

/** The Context note for the sit-down (instead of the usual getting-to-know-you note), or null. */
export function sitdownNote(now = new Date()): string | null {
  const s = getSitdown();
  if (s.status === "in_progress") {
    const asked = s.started_at
      ? (db.prepare("SELECT COUNT(*) n FROM conversation_log WHERE role = 'assistant' AND channel != 'test' AND ts >= ?").get(s.started_at) as { n: number }).n
      : 0;
    return [
      SITDOWN_RULES,
      `Covered so far: ${s.covered.length ? s.covered.join(", ") : "nothing yet"}. Questions asked so far: about ${asked}.`,
    ].join("\n");
  }
  if (offerDue(s, now)) {
    const last = s.offers >= 1 ? " You offered once before and they put it off; this is the last time you offer." : "";
    return (
      `${OFFER_MARK} after you've helped with this, at a natural pause (skip it if they're busy or it's urgent), offer once, in your ` +
      `own words, something like: "${OFFER_LINE}" Then call sitdown_update with status "offered".${last}`
    );
  }
  if (s.status === "offered" && s.offered_at && now.getTime() - new Date(s.offered_at).getTime() < 3600_000) {
    return (
      `${JUST_OFFERED_MARK} (a short getting-to-know-you chat). If this answers it: now or yes → sitdown_update status ` +
      `"in_progress", then ask your first question; no → status "declined" and leave it; later → say that's fine and leave it.`
    );
  }
  return null;
}
