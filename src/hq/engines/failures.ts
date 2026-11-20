import { limitIn } from "../../brain/limit.js";
import type { EngineEvent } from "../contract.js";

export type Failure = Extract<EngineEvent, { type: "failed" }>;
export function failure(message: string, status?: number, now = Date.now()): Failure {
  if (/connection refused|econnrefused|timed?\s*out|\btimeout\b/i.test(message)) return engineDown();
  // Hermes' own wordings, seen on the real gateway: "No Codex credentials stored. Run `hermes auth add …`" and
  // "No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / …".
  if (status === 401 || /no\b[^\n]*\bcredentials (?:stored|found)|hermes (?:-p \S+ )?auth add|not logged in|re-authenticate|\b401\b|sign in again/i.test(message))
    return { type: "failed", reason: "not_signed_in", message: "This bot needs you to sign in to its chosen service." };
  const known = limitIn(message);
  if (known || status === 429 || /\blimit\b|\b429\b|\bquota\b|\busage\b/i.test(message))
    return { type: "failed", reason: "limit", message: "This service's usage limit has been reached.", resetsAt: resetTime(message, known?.resets, now) };
  return { type: "failed", reason: "error", message: "The bot's service could not finish that request." };
}

/** Read the time the service gave us; keep an unknown time unknown. */
export function resetTime(message: string, known?: string | null, now = Date.now()): string | null {
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/.exec(message)?.[0];
  if (iso && Number.isFinite(Date.parse(iso))) return new Date(iso).toISOString();
  const relative = /(?:retry|try again|resets?)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i.exec(message);
  if (relative) return new Date(now + Number(relative[1]) * (/^(h)/i.test(relative[2]) ? 3600000 : /^(m)/i.test(relative[2]) ? 60000 : 1000)).toISOString();
  const raw = known || /\bresets?\s+(?:at\s+|on\s+)?([^\n|·]+)/i.exec(message)?.[1]?.trim();
  if (!raw) return null;
  const clock = /^(?:([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?$/i.exec(raw);
  if (clock) {
    const zone = clock[6] || /\(([^)]+)\)/.exec(message)?.[1] || "Australia/Sydney";
    try {
      const parts = (stamp: number) => Object.fromEntries(new Intl.DateTimeFormat("en-AU", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(stamp).map((p) => [p.type, p.value]));
      const today = parts(now);
      const month = clock[1] ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(clock[1].toLowerCase()) + 1 : Number(today.month);
      if (!month || Number(clock[3]) < 1 || Number(clock[3]) > 12 || Number(clock[4] || 0) > 59) return null;
      let year = Number(today.year);
      if (month < Number(today.month) - 6) year++;
      const hour = Number(clock[3]) % 12 + (clock[5].toLowerCase() === "pm" ? 12 : 0);
      const desired = Date.UTC(year, month - 1, Number(clock[2] || today.day), hour, Number(clock[4] || 0));
      let guess = desired;
      for (let n = 0; n < 3; n++) {
        const p = parts(guess);
        guess += desired - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
      }
      if (!clock[1] && guess <= now) guess += 86400000;
      return new Date(guess).toISOString();
    } catch { return null; }
  }
  return null;
}
export const stopped = (): Failure => ({ type: "failed", reason: "stopped", message: "The bot was stopped." });
export const engineDown = (): Failure => ({ type: "failed", reason: "engine_down", message: "The bot's engine is not answering. Try starting it again." });
