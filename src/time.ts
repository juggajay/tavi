// One idea of local time for the whole app: the owner's time zone setting (time.zone, Australia/Sydney by default),
// never the PC's own clock zone. Everything that decides "today", a time of day, a weekday, quiet hours or a routine
// time goes through here. Timestamps are still stored in UTC.
import { getSettings } from "./store/settings.js";

export const zone = () => getSettings()["time.zone"];

export type LocalParts = { y: number; mo: number; d: number; h: number; mi: number; dow: number; ymd: string };

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (tz: string) => {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
    formatters.set(tz, f);
  }
  return f;
};
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The local date and time at an instant. dow: 0 = Sunday. */
export function partsIn(date = new Date(), tz = zone()): LocalParts {
  const p = Object.fromEntries(formatter(tz).formatToParts(date).map((x) => [x.type, x.value]));
  const ymd = `${p.year}-${p.month}-${p.day}`;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, dow: DOW[p.weekday], ymd };
}

/** "2026-11-11": the local date at an instant. */
export const localDay = (date = new Date(), tz = zone()) => partsIn(date, tz).ymd;
/** Minutes since local midnight at an instant. */
export const minutesOfDay = (date = new Date(), tz = zone()) => {
  const p = partsIn(date, tz);
  return p.h * 60 + p.mi;
};

/** How many minutes the zone is ahead of UTC at an instant. */
export function offsetMinutes(date = new Date(), tz = zone()) {
  const p = partsIn(date, tz);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
}

/** The instant when it's h:m on that local date (after a clock change, the time as the clock shows it). */
export function atLocal(ymd: string, h: number, m: number, tz = zone()): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, m);
  let t = wall - offsetMinutes(new Date(wall), tz) * 60_000;
  t = wall - offsetMinutes(new Date(t), tz) * 60_000; // again, in case the guess crossed a clock change
  return new Date(t);
}

/** A local date n days later (or earlier). */
export function addDays(ymd: string, n: number) {
  const [y, mo, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}
/** 0 = Sunday, for a local date. */
export const weekdayOf = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

/** Local midnight at the start of the day containing `date`. */
export const startOfDay = (date = new Date(), tz = zone()) => atLocal(localDay(date, tz), 0, 0, tz);
/** The next local midnight, as an ISO string (when a "just for today" setting runs out). */
export const nextLocalMidnight = (now = new Date(), tz = zone()) => atLocal(addDays(localDay(now, tz), 1), 0, 0, tz).toISOString();

/**
 * A date-time the brain or the owner wrote. "2026-11-09T07:00" (no zone) is read as the owner's local time; anything
 * with a zone or Z is taken as it says.
 */
export function parseLocal(s: string, tz = zone()): Date {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(s.trim());
  return m ? atLocal(m[1], Number(m[2] ?? 0), Number(m[3] ?? 0), tz) : new Date(s);
}

/** An instant written in the owner's time, e.g. formatLocal(d, { weekday: "short", hour: "numeric" }). */
export const formatLocal = (date: Date | string, opts: Intl.DateTimeFormatOptions, tz = zone()) => new Date(date).toLocaleString("en-AU", { timeZone: tz, ...opts });

/** "Friday 6 November 2026, 8:10 pm (Australia/Sydney, UTC+11:00)": now, for prompts. */
export function nowLine(d = new Date(), tz = zone()) {
  const off = offsetMinutes(d, tz);
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  const text = formatLocal(d, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" }, tz);
  return `${text} (${tz}, UTC${off >= 0 ? "+" : "-"}${hh}:${mm})`;
}
