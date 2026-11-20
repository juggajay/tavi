// No repeats in the morning brief and the end-of-day wrap. After each one that was sent, the commitments it raised (with
// their state at the time) and a short key for every other point are kept (the last five runs). The next run's Context
// carries "Already told them": a commitment comes off that list when its due day arrives or its state changes.
import { getCommitment, getSetting, setSetting } from "../store/proactive.js";
import { localDay } from "../time.js";

const KEY = "told_history";
const KEEP = 5;
type Told = { at: string; routine: string; commitments: { id: string; title: string; key: string }[]; points: string[] };
type Row = { status: string; due_at: string | null; stage?: string | null; last_answer?: string | null; muted?: number | null };

/** What counts as a change: done or dropped, a new due date, a new stage (before, overdue, after), an answer, muting. */
const stateKey = (c: Row) => JSON.stringify([c.status, c.due_at, c.stage ?? null, c.last_answer ?? null, !!c.muted]);

function history(): Told[] {
  try {
    return JSON.parse(getSetting(KEY) || "[]") as Told[];
  } catch {
    return [];
  }
}

/** A brief or wrap went out: remember what it raised. Unknown ids are ignored. */
export function recordTold(routine: string, commitmentIds: string[] = [], points: string[] = [], now = new Date()) {
  const commitments = [...new Set(commitmentIds)].flatMap((id) => {
    const c = getCommitment(id) as (Row & { id: string; title: string }) | undefined;
    return c ? [{ id, title: c.title, key: stateKey(c) }] : [];
  });
  const clean = points.map((p) => p.trim().slice(0, 120)).filter(Boolean).slice(0, 8);
  if (!commitments.length && !clean.length) return;
  setSetting(KEY, JSON.stringify([...history(), { at: now.toISOString(), routine, commitments, points: clean }].slice(-KEEP)));
}

/** The Context section for the next brief or wrap, or "" when there's nothing it has told them that still stands. */
export function alreadyToldSection(now = new Date()): string {
  const today = localDay(now);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const t of [...history()].reverse()) {
    for (const c of t.commitments) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const cur = getCommitment(c.id) as (Row & { title: string }) | undefined;
      if (!cur || cur.status !== "open" || stateKey(cur) !== c.key) continue; // closed or changed: fair to mention
      if (cur.due_at && localDay(new Date(cur.due_at)) === today && localDay(new Date(t.at)) < today) continue; // its day has come
      lines.push(`- [${c.id}] ${cur.title}`);
    }
  }
  const points = [...new Set(history().flatMap((t) => t.points))];
  for (const p of points) lines.push(`- ${p}`);
  return lines.length ? ["Already told them (leave out unless it has changed):", ...lines].join("\n") : "";
}
