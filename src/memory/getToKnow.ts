// Getting to know the user the way a person would, not with a form. Code decides WHEN a question is allowed: about once a
// day at most, never in the first two things they say, never while the sit-down is on offer or under way, and the
// "what do you want to call me?" invite at most twice ever. The brain decides what to ask: one question that grows out of
// what the owner is doing right now and would help next time. If two questions in a row go unanswered (the memory keeper
// judges that), it waits three days instead of one, until one is answered.
import { db, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { assistantName, profileGaps } from "../profile/profile.js";
import { sitdownBusy } from "./sitdown.js";
import { AREAS, gaps as mapGaps, readMap } from "../hq/onboarding/map.js";

const ASK_GAP_MS = 20 * 3600_000;
const BACKED_OFF_MS = 3 * 86_400_000;
/** answered: the keeper's verdict on whether the owner took it up (unset until it has read the conversation). */
export type Asked = { at: string; q: string; answered?: boolean };

export function curiousHistory(): Asked[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'curious_history'").get() as { value: string } | undefined;
  try {
    return row ? (JSON.parse(row.value) as Asked[]) : [];
  } catch {
    return [];
  }
}
const saveHistory = (all: Asked[]) =>
  db.prepare("INSERT INTO settings (key, value) VALUES ('curious_history', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(all.slice(-20)));

/** The brain asked a getting-to-know-you question (or invited a name). */
export function noteCuriousQuestion(q: string) {
  saveHistory([...curiousHistory(), { at: nowIso(), q: q.slice(0, 200) }]);
  audit("brain", "relationship.asked", null, { question: q.slice(0, 200) });
  return { noted: true };
}

/** Questions asked at or after this time that the keeper hasn't judged yet. */
export const unjudgedQuestions = (since: string) => curiousHistory().filter((a) => a.answered === undefined && a.at >= since);

/** The keeper's verdicts, by when each question was asked. */
export function markAnswered(verdicts: { at: string; answered: boolean }[]) {
  if (!verdicts.length) return;
  const all = curiousHistory().map((a) => {
    const v = verdicts.find((x) => x.at === a.at);
    return v ? { ...a, answered: v.answered } : a;
  });
  saveHistory(all);
}

/** How long to wait after the last question: a day, or three days after two in a row went unanswered. */
export function askGapMs(asked = curiousHistory()) {
  const [a, b] = asked.slice(-2);
  return a && b && a.answered === false && b.answered === false ? BACKED_OFF_MS : ASK_GAP_MS;
}

const isNameInvite = (q: string) => /\b(name|call you|call me)\b/i.test(q) && /\byou\b/i.test(q);

/** A line for the Context when a getting-to-know-you question is allowed right now, or null. */
export function gettingToKnowNote(now = Date.now()): string | null {
  const map = readMap();
  if (map.status === "active" || map.status === "paused") return null;
  if (!map.updated && sitdownBusy(new Date(now))) return null; // The older conversation still serves existing callers.
  const asked = curiousHistory();
  const last = asked[asked.length - 1];
  if (last && now - new Date(last.at).getTime() < askGapMs(asked)) return null;
  const said = (db.prepare("SELECT COUNT(*) n FROM conversation_log WHERE role = 'user' AND channel != 'test'").get() as { n: number }).n;
  if (said < 3) return null; // never in the first two things they say
  if (map.updated) {
    const missing = mapGaps(map);
    if (!missing.length) return null;
    return `Getting to know them: only after helping, and only if it fits naturally, ask one short question from these gaps: ${missing.map(k => AREAS[k]).join(", ")}. Gaps come first. Never ask about a deliberately skipped subject. Ask nothing if there is no reason today. Call noted_question if you ask.${asked.length ? ` Do not repeat: ${asked.slice(-8).map(a => a.q).join(" | ")}.` : ""}`;
  }
  const before = asked.slice(-8).map((a) => a.q);
  const dontRepeat = before.length ? ` Already asked (don't repeat): ${before.join(" | ")}.` : "";
  if (!assistantName() && asked.filter((a) => isNameInvite(a.q)).length < 2) {
    return (
      "Getting to know them: you don't have a name yet and they should give you one. At the end of this answer, after you've " +
      "helped (skip it only if they're dealing with something urgent), invite them to name you: once, lightly, in your own " +
      "words, e.g. \"By the way, I'll be around a fair bit. What do you want to call me?\" Then call noted_question." +
      dontRepeat
    );
  }
  const gaps = profileGaps();
  return (
    "Getting to know them (optional; only after you've helped, never mid-task): if what they're doing right now raises one " +
    "question whose answer would help you next time, ask it, short and in your own words (after showing a club " +
    "calendar: \"Do you organise these or just attend?\"). If nothing comes up naturally, ask nothing. Then noted_question." +
    (gaps.length ? ` (Background only, don't ask about it directly: USER.md says little yet about ${gaps.slice(0, 3).join(", ").toLowerCase()}.)` : "") +
    dontRepeat
  );
}
