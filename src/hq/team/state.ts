import { db } from "../../store/db.js";

// Keep trial bots hidden after a restart too. Existing bots have no entry and stay on the team.
const key = (bot: string) => `team:trial-only:${bot}`;
export const isActive = (bot: string) => (db.prepare("SELECT value FROM settings WHERE key=?").get(key(bot)) as { value?: string } | undefined)?.value !== "yes";
export function trialOnly(bot: string, hidden: boolean) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key(bot), hidden ? "yes" : "no");
}
