import { createHash, randomBytes } from "node:crypto";
import type { Bot } from "../contract.js";
import { getSecret, putSecret, deleteSecret } from "../../store/secrets.js";

export type TurnLane = "chat" | "work" | "finds";
export const twinName = (id: string) => `w-${createHash("sha256").update(id).digest("hex").slice(0, 20)}`;
export const isTwinName = (id: string) => /^w-[a-f0-9]{20}$/.test(id);
export const laneKey = (id: string, lane: TurnLane = "chat") => `${id}:${lane}`;

// These names identify profiles: chat is the main profile, work is its twin.
// Only the main profile has a computer. Work keeps it; conversation borrows the twin.
export const separateWork = (bot: Bot) => bot.engine === "hermes";
export const workLane = (bot: Bot): "chat" | "work" => separateWork(bot) && !bot.computer ? "work" : "chat";
export const conversationLane = (bot: Bot, working: boolean): "chat" | "work" => separateWork(bot) && bot.computer && working ? "work" : "chat";
export const laneReason = (bot: Bot) => bot.engine === "builtin" ? "Longer work and conversation take turns on the built-in engine." : undefined;

export function twinSecret(id: string, name: "gateway-key" | "toolbox-token", create = false): string | null {
  const key = `work:${id}:${name}`;
  let value = getSecret<string>(key);
  if (!value && create) { value = randomBytes(32).toString("hex"); putSecret(key, value); }
  return value ?? null;
}
export function forgetTwin(id: string) {
  deleteSecret(`work:${id}:gateway-key`);
  deleteSecret(`work:${id}:toolbox-token`);
}
