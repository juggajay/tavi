// Routine schedules, in the owner's time zone (the time.zone setting, through src/time.ts).
import { addDays, atLocal, formatLocal, localDay, parseLocal, weekdayOf } from "../time.js";
export type Schedule =
  | { kind: "daily"; time: string } // "HH:MM"
  | { kind: "weekdays"; time: string } // Mon to Fri
  | { kind: "weekly"; days: number[]; time: string } // 0 = Sunday ... 6 = Saturday
  | { kind: "once"; at: string }; // local date-time, e.g. "2026-11-09T07:00"

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function parseTime(t: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) throw new Error(`Bad time "${t}" (use HH:MM, 24-hour)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Bad time "${t}"`);
  return [h, min];
}

export function validate(s: Schedule): Schedule {
  if (s.kind === "once") {
    if (Number.isNaN(parseLocal(s.at).getTime())) throw new Error(`Bad date-time "${s.at}"`);
    return s;
  }
  parseTime(s.time);
  if (s.kind === "weekly" && (!s.days.length || s.days.some((d) => d < 0 || d > 6))) throw new Error("Weekly schedules need days 0-6");
  return s;
}

/** Next time this schedule fires strictly after `after`, or null if it never will again. */
export function nextRun(s: Schedule, after = new Date()): Date | null {
  if (s.kind === "once") {
    const at = parseLocal(s.at);
    return at > after ? at : null;
  }
  const [h, m] = parseTime(s.time);
  const today = localDay(after);
  for (let i = 0; i < 9; i++) {
    const day = addDays(today, i);
    const c = atLocal(day, h, m);
    if (c <= after) continue;
    const dow = weekdayOf(day);
    if (s.kind === "daily") return c;
    if (s.kind === "weekdays" && dow >= 1 && dow <= 5) return c;
    if (s.kind === "weekly" && s.days.includes(dow)) return c;
  }
  return null;
}

function time12(t: string) {
  const [h, m] = parseTime(t);
  const suffix = h < 12 ? "am" : "pm";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, "0")}${suffix}` : `${hh}${suffix}`;
}

export function describe(s: Schedule): string {
  if (s.kind === "once") return `Once, ${formatLocal(parseLocal(s.at), { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`;
  if (s.kind === "daily") return `Every day at ${time12(s.time)}`;
  if (s.kind === "weekdays") return `Weekdays at ${time12(s.time)}`;
  const days = [...s.days].sort();
  const label = days.join() === "1,2,3,4,5" ? "Weekdays" : days.map((d) => DAY[d]).join(", ");
  return `${label} at ${time12(s.time)}`;
}
