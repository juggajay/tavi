// Where The Brain (a separately configured service) is and what the assistant may do with it (Stage 16).
// The two apps stay separate: nothing here writes inside its folder. Its address and folders can be pointed at a
// stand-in for tests (LH_BRAINLINK_URL, LH_BRAINLINK_JOBS_DIR); in dev nothing reaches the real app unless the
// read-only check asks (LH_BRAINLINK_READONLY=1: GETs only).
import path from "node:path";
import { DEV } from "../dev.js";
import { getSettings } from "../store/settings.js";

export const REAL_URL = "http://127.0.0.1:3877";

/** Only these GETs may reach the real app from dev, and only with LH_BRAINLINK_READONLY=1 (the 16.1 check). */
export const readOnly = () => !process.env.LH_BRAINLINK_URL && DEV && process.env.LH_BRAINLINK_READONLY === "1";

/** Where The Brain answers, or null when the link is off (dev without a stand-in). */
export function brainUrl(): string | null {
  const env = process.env.LH_BRAINLINK_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  if (DEV && !readOnly()) return null;
  return readOnly() || brainHome() ? REAL_URL : null;
}

/** The app's folder: the saved setting; empty until configured. */
export const brainHome = () => getSettings()["brainlink.home"].trim();
/** Its job folders (read only to us): <home>\out\jobs\<id>. */
export const jobsDir = () => process.env.LH_BRAINLINK_JOBS_DIR || (brainHome() ? path.join(brainHome(), "out", "jobs") : "");
/**
 * Where a job's folder may be: the dev version's (<home>\out\jobs), or the installed desktop version's, which keeps its
 * data in its own app-data folder (its electron/main.js sets its data setting to Electron's userData).
 */
export const jobsDirs = () => {
  if (process.env.LH_BRAINLINK_JOBS_DIR) return [process.env.LH_BRAINLINK_JOBS_DIR];
  return jobsDir() ? [jobsDir()] : [];
};
export const mayStart = () => getSettings()["brainlink.autostart"];
export const dailyLine = () => getSettings()["brainlink.daily_usd"];

/** Its own job ids: letters, digits, _ and - (its route refuses anything else). The ones started here are lh-<8 hex>. */
export const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What each mode is, in plain words. */
export const MODES = {
  read: { say: "just read the scope", noun: "scope read" },
  takeoff: { say: "a take-off", noun: "take-off" },
  quote: { say: "a full quote", noun: "full quote" },
  price: { say: "price your own quantities", noun: "pricing of your quantities" },
} as const;
export type Mode = keyof typeof MODES;

/** Its gates, in plain words. */
export const GATES: Record<string, string> = { scope: "the scope check", takeoff: "the take-off check", rates: "the rates check", draft: "the draft check" };
