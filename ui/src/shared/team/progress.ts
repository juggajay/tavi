import type { Row } from "../../../../src/hq/contract";

export const stepCount = (count: number) => `${count} ${count === 1 ? "step" : "steps"}`;
export function duration(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds || 0));
  if (whole < 60) return `${whole} sec`;
  const minutes = Math.floor(whole / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}
export const elapsed = (since: string | null, now = Date.now()) => duration((now - Date.parse(since ?? new Date(now).toISOString())) / 1000);
// Older saved steps named the work on the row instead of inside the step.
export const stepJob = (row: Row) => row.body.kind === "step" ? row.body.job ?? (row as Row & { job?: string }).job : undefined;
export type RunningWork = { id: string; title: string; since: string; steps?: number };
// From the first step starting to the last one ending: the tools take milliseconds, the thinking between them the minutes.
function wallTime(rows: Row[]): number {
  const times = rows.map(r => Date.parse(r.ts)).filter(Number.isFinite);
  const last = rows[rows.length - 1]?.body;
  return times.length ? Math.max(...times) + (last?.kind === "step" ? last.ms ?? 0 : 0) - Math.min(...times) : 0;
}
export function stepSummary(rows: Row[], running?: RunningWork, now = Date.now()) {
  const steps = rows.flatMap(row => row.body.kind === "step" ? [row.body] : []);
  const first = steps[0];
  const title = running?.title || first?.jobTitle || "Longer work";
  const ended = steps.map(s => s.jobEndedAt).filter((value): value is string => !!value).sort().at(-1);
  const since = running?.since || first?.jobSince;
  const seconds = since ? ((ended ? Date.parse(ended) : running ? now : Math.max(...rows.map(r => Date.parse(r.ts)))) - Date.parse(since)) / 1000 : Math.max(steps.reduce((sum, s) => sum + (s.ms ?? 0), 0), wallTime(rows)) / 1000;
  const count = stepCount(running?.steps ?? steps.length);
  const time = seconds >= 1 ? `${duration(seconds)} · ` : "";
  return stepJob(rows[0]) ? `${title} · ${time}${count}` : `${seconds >= 1 ? `Worked for ${duration(seconds)} · ` : ""}${count}`;
}
