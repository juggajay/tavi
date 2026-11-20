// The one turn the link is holding open right now, if any (Stage 16: one job at a time through the link). Its own file
// so the launcher and the runner can both read it without importing each other. A turn claims the line at once, before
// anything is awaited, so two taps at the same moment can't both get through.
export type Active = { job: string; turn: string; title: string; started: number; stop: () => void };
let active: Active | null = null;
let claimed: string | null = null;
export const activeTurn = () => active;
export const setActive = (a: Active | null) => {
  active = a;
  claimed = null;
};
/** Claim the line for one turn (synchronously). False if a turn holds it or is getting ready to. */
export function claim(job: string): boolean {
  if (active || claimed) return false;
  claimed = job;
  return true;
}
export const unclaim = (job: string) => {
  if (claimed === job) claimed = null;
};
/** The job a turn is getting ready for (claimed, not yet open). */
export const claimedFor = () => claimed;
