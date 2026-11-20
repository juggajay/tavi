// When his Claude plan's usage limit is reached (Stage 21): recognised wherever a brain call fails or comes back with
// the CLI's own limit text instead of an answer, and said to him in one plain sentence (what it is, when it resets if the
// message says, and that drafts and whatever's on screen still work), never the raw error. Routines and follow-up checks
// that miss their turn for it are said once in the next brief (missedForLimit).
import { getSetting, setSetting } from "../store/proactive.js";

/** The plan's limit, as the CLI says it: "You've hit your weekly limit · resets Nov 17, 9pm (Australia/Sydney)". */
const PLAN_LIMIT = /\b(?:hit your (?:weekly |daily |monthly |5-hour |five-hour |session |opus |usage )?limit|(?:usage|weekly|daily|monthly|plan|session|5-hour|five-hour) limit (?:reached|exceeded|hit)|claude ai usage limit reached|out of (?:usage|credits))\b/i;

export type Limit = { resets: string | null };

/** The plan's limit in a message, with when it resets if the message says. null when it isn't one. */
export function limitIn(text: string | null | undefined): Limit | null {
  if (!text || !PLAN_LIMIT.test(text)) return null;
  const at = /\bresets?\s+(?:at\s+|on\s+)?([^·∙\n|]+?)\s*(?:\(([^)]+)\))?\s*(?:[·∙\n|]|$)/i.exec(text);
  return { resets: at ? at[1].trim() : null };
}

/** A brain call that failed because the plan's limit was reached. */
export class LimitError extends Error {
  constructor(
    readonly limit: Limit,
    raw: string,
  ) {
    super(`usage limit: ${raw.slice(0, 200)}`);
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Nov 17, 9pm" as he'd say it ("9 pm on Tuesday 17 November"); anything else as it came. */
export function whenItResets(resets: string, now = new Date()): string {
  const m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(resets.trim());
  if (m) {
    const mon = MONTHS.indexOf(m[1].toLowerCase());
    if (mon >= 0) {
      let year = now.getFullYear();
      if (mon < now.getMonth() - 6) year++; // early in the new year
      const day = new Date(year, mon, Number(m[2]));
      const time = `${Number(m[3])}${m[4] && m[4] !== "00" ? `:${m[4]}` : ""} ${m[5].toLowerCase()}`;
      return `at ${time} on ${DAYS[day.getDay()]} ${day.getDate()} ${MONTH_NAMES[mon]}`;
    }
  }
  const t = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(resets.trim());
  if (t) return `at ${Number(t[1])}${t[2] && t[2] !== "00" ? `:${t[2]}` : ""} ${t[3].toLowerCase()}`;
  return resets.trim();
}

/** What he's told, in one sentence. */
export function limitSentence(l: Limit, now = new Date()): string {
  const until = l.resets ? `until it resets ${whenItResets(l.resets, now)}` : "until it resets";
  return `I've hit the usage limit on your Claude plan, so I can't work anything out ${until}, but drafts waiting for your tap and anything already on your screen still work.`;
}

/* ---------------- routines and checks that missed their turn, said once in the next brief ---------------- */

type Missed = { title: string; at: string; resets: string | null };
const KEY = "limit_missed";

export function noteMissedForLimit(title: string, l: Limit, at = new Date()) {
  const list = missedForLimit();
  if (!list.some((m) => m.title === title)) list.push({ title, at: at.toISOString(), resets: l.resets });
  setSetting(KEY, JSON.stringify(list.slice(-10)));
}
export function missedForLimit(): Missed[] {
  try {
    return JSON.parse(getSetting(KEY) || "[]") as Missed[];
  } catch {
    return [];
  }
}
export const clearMissedForLimit = () => setSetting(KEY, "[]");

/** For the next brief: what didn't run, said once. Empty when nothing was missed. */
export function missedNote(): string {
  const list = missedForLimit();
  if (!list.length) return "";
  return `While his Claude plan's usage limit was reached, these didn't run: ${list.map((m) => `"${m.title}"`).join(", ")}. Tell him so once, in one short sentence, near the end.`;
}
