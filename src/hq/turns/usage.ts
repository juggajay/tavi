// Counts for the owner's local day and week. Test work does not use the real plan totals.
import { db } from "../../store/db.js";
import type { Provider } from "../contract.js";

export type TokenCount = { input: number; output: number };
export type Usage = { day: string; week: string; today: Partial<Record<Provider, TokenCount>>; thisWeek: Partial<Record<Provider, TokenCount>> };
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function usageOf(bot: string, now: Date): Usage {
  const monday = new Date(now);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const empty: Usage = { day: day(now), week: day(monday), today: {}, thisWeek: {} };
  try {
    const saved = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = ?").get(`hq:usage:${bot}`) as { value: string } | undefined)?.value ?? "null") as Usage | null;
    if (!saved) return empty;
    return { ...empty, today: saved.day === empty.day ? saved.today : {}, thisWeek: saved.week === empty.week ? saved.thisWeek : {} };
  } catch { return empty; }
}
export function addUsage(bot: string, provider: Provider, input: number, output: number, now: Date) {
  const usage = usageOf(bot, now);
  for (const totals of [usage.today, usage.thisWeek]) {
    const count = totals[provider] ?? { input: 0, output: 0 };
    totals[provider] = { input: count.input + (Number.isFinite(input) ? Math.max(0, input) : 0), output: count.output + (Number.isFinite(output) ? Math.max(0, output) : 0) };
  }
  db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`hq:usage:${bot}`, JSON.stringify(usage));
}
