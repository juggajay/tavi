// Drawing numbers, revisions and status (Stage 12.3): a job code, a running number and the revision, for example
// "HOU-SD-003 B". Revisions run P1, P2 while the drawing is preliminary, then A, B, C once it's issued for approval or
// construction. Status is PRELIMINARY (the default), FOR APPROVAL or FOR CONSTRUCTION, set by the owner asking.
import type { Status } from "./sheets.js";

export const STATUSES: Status[] = ["PRELIMINARY", "FOR APPROVAL", "FOR CONSTRUCTION"];

/** Three letters for a job, from its project (or client) name: "Household project" → "HOU". */
export function jobCode(project: string, client = ""): string {
  const words = `${project} ${client}`.toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/).filter(Boolean);
  const skip = new Set(["THE", "A", "AN", "AND", "OF", "FOR", "MR", "MRS", "MS", "DR", "JOB", "PROJECT"]);
  const w = words.find((x) => !skip.has(x) && x.length >= 3) ?? words[0] ?? "";
  return (w.slice(0, 3) || "LH").padEnd(3, "X");
}

/** "HOU-SD-003": the job code, SD for shop drawing, and the running number in that job. */
export const drawingNumber = (code: string, n: number) => `${code}-SD-${String(n).padStart(3, "0")}`;

/**
 * The next revision after `current` for a drawing at `status`: P1, P2... while preliminary; the first issue for approval
 * or construction is A, then B, C... (a preliminary drawing issued for the first time goes from P-something to A).
 */
export function nextRevision(current: string | null, status: Status): string {
  if (status === "PRELIMINARY") {
    if (!current) return "P1";
    const m = /^P(\d+)$/.exec(current);
    // once it's been issued it stays lettered, even if it goes back to preliminary
    return m ? `P${Number(m[1]) + 1}` : nextLetter(current);
  }
  if (!current || /^P\d+$/.test(current)) return "A";
  return nextLetter(current);
}

/** A → B … Z → AA; I and O are skipped (they read as 1 and 0). */
function nextLetter(r: string): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const i = letters.indexOf(r.slice(-1));
  if (i < 0) return "A";
  if (i + 1 < letters.length) return r.slice(0, -1) + letters[i + 1];
  return (r.length > 1 ? nextLetter(r.slice(0, -1)) : "A") + "A";
}

/** The status the owner asked for, from his words ("mark it for approval", "for construction", "back to preliminary"). */
export function statusFrom(words: string): Status | null {
  const s = words.toUpperCase();
  if (/CONSTRUCT|BUILD|FABRICAT/.test(s)) return "FOR CONSTRUCTION";
  if (/APPROV/.test(s)) return "FOR APPROVAL";
  if (/PRELIM|DRAFT/.test(s)) return "PRELIMINARY";
  return null;
}
