// Dev mode (LH_DEV=1): the copy being built runs beside the owner's live assistant and must never reach the outside
// world for them. No phone pushes, no routines, no memory keeper, no browser jobs, and approved writes land in the
// local demo outbox instead of being sent. Each switch can be turned back on for a test (LH_DEV_SCHEDULER=1, etc.).
// This file imports nothing from the app so the database module can use it before it opens anything.
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";

export const DEV = process.env.LH_DEV === "1";

/** True when a background part should run: always outside dev, and in dev only when its switch is set. */
export const devAllows = (what: "SCHEDULER" | "KEEPER" | "BROWSER" | "PUSH") => !DEV || process.env[`LH_DEV_${what}`] === "1";

/** Dev must always say which data folder it uses, and it can never be the live one. */
export function devCheckDataDir(dataDir: string, repoRoot: string) {
  if (!DEV) return;
  if (!process.env.LH_DATA_DIR) throw new Error("Dev mode needs LH_DATA_DIR set to a dev or test data folder (npm run dev does this).");
  const resolved = (value: string): string => {
    const full = path.resolve(value);
    if (existsSync(full)) return realpathSync(full).toLowerCase();
    const parent = path.dirname(full);
    return parent === full ? full.toLowerCase() : path.join(resolved(parent), path.basename(full)).toLowerCase();
  };
  const live = [path.join(repoRoot, "data"), ...(process.env.TAVI_PROTECTED_DATA_DIRS || "").split(path.delimiter).filter(Boolean)];
  const target = resolved(dataDir);
  if (live.some(p => target === resolved(p) || target.startsWith(resolved(p) + path.sep))) throw new Error(`Dev mode refuses to use ${dataDir}: that is a live data folder or a protected data folder.`);
}
