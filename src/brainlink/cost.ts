// What a job in The Brain is likely to cost, before he says go (Stage 16.2). From its own recorded job costs where
// there are finished ones of that kind; otherwise from its own notes on its one test job, marked as rough. The figures
// are US dollars, as The Brain reports them (the model use behind it is priced that way).
import { MODES, type Mode } from "./config.js";
import type { Manifest } from "./client.js";
import { spentToday } from "./store.js";
import { dailyLine } from "./config.js";

/**
 * These are rough starting ranges for a separate service, not measured prices for this installation.
 * Finished jobs replace these estimates with the service's own recorded costs.
 */
export const ROUGH: Record<Mode, { low: number; high: number }> = {
  read: { low: 2, high: 5 },
  takeoff: { low: 5, high: 10 },
  quote: { low: 20, high: 45 },
  price: { low: 10, high: 30 },
};
/** Its own cap on one step (default 20 US dollars): a step stops with a message when it hits it. */
export const STEP_CAP = 20;

export const money = (n: number) => (n < 10 && Math.round(n * 100) % 100 !== 0 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

export type Likely = { low: number; high: number; basis: "recorded" | "rough"; n: number; say: string };

export function likelyCost(mode: Mode, jobs: Manifest[] | null): Likely {
  const done = (jobs ?? []).filter((j) => j.mode === mode && (j.status === "ready" || j.status === "issued") && (j.costUsd ?? 0) > 0).map((j) => j.costUsd!);
  const noun = MODES[mode].noun;
  if (done.length) {
    const low = Math.min(...done),
      high = Math.max(...done);
    const say = done.length === 1 ? `about ${money(low)}, from your one finished ${noun} in The Brain` : `${money(low)} to ${money(high)}, from your last ${done.length} finished ${noun}s in The Brain`;
    return { low, high, basis: "recorded", n: done.length, say };
  }
  const r = ROUGH[mode];
  return { ...r, basis: "rough", n: 0, say: `${money(r.low)} to ${money(r.high)} (rough starting estimate; no recorded jobs yet)` };
}

/** Today's spend through the link and the line he set: over it, every step needs his OK again. */
export function dayLine(now = new Date()) {
  const spent = spentToday(now);
  const line = dailyLine();
  const over = spent >= line;
  return { spent, line, over, say: `${money(spent)} so far today${over ? `, over your ${money(line)} a day line` : ` of your ${money(line)} a day line`}` };
}
