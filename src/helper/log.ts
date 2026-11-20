// The helper's own log, helper.log beside it: the ONLY file the helper ever writes. One line per request (the time, the
// request, the path, the result), never what's in a file and never the secret. Kept under 5 MB by dropping the oldest
// half when it grows past that.
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";

export const LOG_CAP = 5 * 1024 * 1024;

export type Log = (line: string) => void;

/**
 * logFile: where to write (null: nowhere). echo: also print it (when run in a window, so the owner sees what it does).
 * A log that can't be written (a read-only folder) is skipped quietly: it never stops the helper.
 */
export function makeLog(logFile: string | null, echo: boolean, cap = LOG_CAP): Log {
  let size = 0;
  if (logFile) {
    try {
      size = statSync(logFile).size;
    } catch {}
  }
  return (line: string) => {
    const stamped = `${new Date().toISOString()} ${line.replace(/[\r\n]+/g, " ")}\n`;
    if (echo) process.stdout.write(`${new Date().toLocaleTimeString()}  ${line}\n`);
    if (!logFile) return;
    try {
      appendFileSync(logFile, stamped, "utf8");
      size += Buffer.byteLength(stamped);
      if (size > cap) size = trim(logFile, cap);
    } catch {}
  };
}

/** Keep the newest half, from the start of a line. Returns the new size. */
function trim(logFile: string, cap: number) {
  const all = readFileSync(logFile);
  let from = all.length - Math.floor(cap / 2);
  while (from < all.length && all[from - 1] !== 0x0a) from++;
  const kept = all.subarray(from);
  writeFileSync(logFile, kept);
  return kept.length;
}
