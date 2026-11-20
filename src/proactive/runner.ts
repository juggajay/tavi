// Scheduled work uses the team when it is on. A missing team never falls back silently.
import type { BackgroundResult } from "../brain/brain.js";
import type { Routine } from "../store/proactive.js";

export type TeamRoutine = Routine & { bot?: string };
export type ProactiveRun = (task: string, routine?: TeamRoutine) => Promise<BackgroundResult>;
let runner: ProactiveRun | undefined;
export function setProactiveRunner(next?: ProactiveRun) {
  runner = next;
  return () => { if (runner === next) runner = undefined; };
}
export async function runProactive(task: string, routine?: TeamRoutine): Promise<BackgroundResult> {
  if (runner) return runner(task, routine);
  if (process.env.LH_V3 === "1") throw new Error("The bot team is not available for scheduled work.");
  return (await import("../brain/brain.js")).runBackground(task);
}
export const writeTeamOpener = async (prompt: string) => (await runProactive(
  "Write the opening line for Tavi from the material below. Under fifteen words, no greeting. " +
  "Return it as spoken, or leave spoken empty if nothing needs saying.\n\n" + prompt,
)).spoken;
