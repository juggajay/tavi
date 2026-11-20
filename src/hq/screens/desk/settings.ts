import { db } from "../../../store/db.js";
import { BOT_ID } from "../../contract.js";
import { pinnedAddresses, type PinnedAddress } from "../desktop.js";

export type DeskSettings = { pinnedAddresses: PinnedAddress[]; theme: "light" | "dark" };
export function deskSettings(id: string): DeskSettings {
  if (!BOT_ID.test(id)) throw new Error("That bot name is not valid.");
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(`bot:${id}:desk`) as { value: string } | undefined;
    const value = JSON.parse(row?.value ?? "{}");
    return { pinnedAddresses: pinnedAddresses(value.pinnedAddresses), theme: value.theme === "dark" ? "dark" : "light" };
  } catch { return { pinnedAddresses: [], theme: "light" }; }
}
// The app can pass its chosen appearance here when that setting is connected.
export function saveDeskSettings(id: string, settings: DeskSettings): void {
  if (!BOT_ID.test(id)) throw new Error("That bot name is not valid.");
  const value = { pinnedAddresses: pinnedAddresses(settings.pinnedAddresses), theme: settings.theme === "dark" ? "dark" : "light" };
  db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`bot:${id}:desk`, JSON.stringify(value));
}
