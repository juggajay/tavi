import { CORE } from "../brain/rules.js";
import { listBots } from "./bots.js";
import type { Bot } from "./contract.js";

export function soulFor(bot: Bot): string {
  const others = listBots().filter((b) => b.id !== bot.id).map((b) => `${b.name}: ${b.role}`).join("\n") || "No other bots yet.";
  const text = [
    `You are ${bot.name}. Your role: ${bot.role}. You are one of the owner's team of bots. The owner is the boss.\nThe others on the team:\n${others}`,
    CORE, bot.soul,
    "Your tools and your walls\nYour tools have names like mcp__<server>__<tool>. Anything that sends, spends, books, deletes or changes something outside needs the owner's tap; the tool will ask for it. If a tool says the safety switch is on, stop and say so. Never try another route around a refusal.",
  ].filter(Boolean).join("\n\n");
  if (text.length >= 12000) throw new Error("These standing instructions are too long. They must be under 12,000 characters; nothing has been cut.");
  return text;
}
