import { z } from "zod";
import { db, nowIso } from "../../store/db.js";
import type { EngineChoice } from "../contract.js";

export const CARD_SERVERS = ["site", "mail", "memory", "drawings", "actions", "show", "files", "reference", "calc", "model", "shop", "computers", "brainlink", "team"] as const;
export type JobCard = {
  version: number; purpose: string; notFor: string; handsBack: string; example: string | null;
  given: string; servers: string[]; stopAndAsk: string; choice: EngineChoice; fallbacks: EngineChoice[];
  computer: boolean; trials: { ask: string; goodAnswer: string }[];
  privateInfo: "none" | "about-card" | "named"; named?: string[];
};
const words = z.string().trim().min(1).max(8000);
const choice = z.object({ provider: z.enum(["openai-codex", "anthropic", "openrouter", "openai-api"]), model: words.max(120), effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional() }).strict();
export const cardSchema = z.object({
  version: z.number().int().positive(), purpose: words, notFor: words, handsBack: words,
  example: words.nullable(), given: words, servers: z.array(z.enum(CARD_SERVERS)).max(CARD_SERVERS.length),
  stopAndAsk: words, choice, fallbacks: z.array(choice).max(10), computer: z.boolean(),
  trials: z.array(z.object({ ask: words, goodAnswer: words }).strict()).max(20),
  privateInfo: z.enum(["none", "about-card", "named"]), named: z.array(words.max(500)).max(50).optional(),
}).strict();
export function dangerousThree(card: JobCard): boolean {
  const reads = card.computer || card.servers.some((s) => ["site", "mail", "actions", "brainlink"].includes(s));
  return reads && card.privateInfo === "named" && card.servers.some((s) => ["mail", "actions"].includes(s));
}
export function validateCard(input: unknown, options: { acknowledgedRisk?: boolean } = {}): JobCard {
  const parsed = cardSchema.safeParse(input);
  if (!parsed.success) throw new Error("The job card needs a purpose, limits, a finished result, starting information, tool groups, model choices and trial examples in the right places.");
  const card = parsed.data;
  if (new Set(card.servers).size !== card.servers.length) throw new Error("List each tool group only once.");
  if (card.privateInfo === "named" && !card.named?.length) throw new Error("Name the facts or files this bot may read.");
  if (card.privateInfo !== "named" && card.named?.length) throw new Error("Named facts or files need the named information choice.");
  if (dangerousThree(card) && options.acknowledgedRisk !== true) throw new Error("This combines outside reading, private information and sending. Drop outside reading, use only the about card, or remove mail and actions. Keeping all three needs the owner's tap.");
  return card;
}
export const cardWarnings = (card: JobCard): string[] => [!card.example && "No example of a finished job yet.", !card.trials.length && "No trial examples yet."].filter((s): s is string => !!s);
export function renderCard(card: JobCard): string {
  return [`Your job (version ${card.version})`, `Purpose: ${card.purpose}`, `Not for: ${card.notFor}`, `Hands back: ${card.handsBack}`, `Accepted example: ${card.example ?? "None yet"}`, `Given: ${card.given}`, `Tool groups: ${card.servers.join(", ") || "None"}`, `Stop and ask: ${card.stopAndAsk}`, `Model: ${card.choice.provider}, ${card.choice.model}${card.choice.effort ? `, ${card.choice.effort}` : ""}`, `Other model choices: ${card.fallbacks.map((c) => `${c.provider}, ${c.model}, ${c.effort ?? "usual effort"}`).join("; ") || "None"}`, `Computer: ${card.computer ? "Yes" : "No"}`, `Private information: ${card.privateInfo === "named" ? card.named?.join(", ") : card.privateInfo === "about-card" ? "Approved about card only" : "None"}`, ...card.trials.map((t, i) => `Trial ${i + 1}: ${t.ask}\nGood answer: ${t.goodAnswer}`)].join("\n");
}
export type CardVersion = { bot: string; version: number; card: JobCard; madeAt: string; madeBy: string; note: string; acknowledgedRisk: boolean };
export function cardHistory(bot: string): CardVersion[] {
  return (db.prepare("SELECT * FROM bot_cards WHERE bot = ? ORDER BY version DESC").all(bot) as { bot: string; version: number; card_json: string; made_at: string; made_by: string; note: string; acknowledged_risk: number }[])
    .map((r) => ({ bot: r.bot, version: r.version, card: JSON.parse(r.card_json), madeAt: r.made_at, madeBy: r.made_by, note: r.note, acknowledgedRisk: !!r.acknowledged_risk }));
}
export const currentCard = (bot: string): JobCard | null => cardHistory(bot)[0]?.card ?? null;
export function saveCard(bot: string, input: JobCard, by: string, note: string, options: { acknowledgedRisk?: boolean } = {}): JobCard {
  const card = validateCard(input, options);
  if (!db.prepare("SELECT id FROM bots WHERE id = ? AND removed_at IS NULL").get(bot)) throw new Error("That bot is no longer on the team.");
  db.exec("SAVEPOINT save_card");
  try {
    card.version = (currentCard(bot)?.version ?? 0) + 1;
    db.prepare("INSERT INTO bot_cards (bot,version,card_json,made_at,made_by,note,acknowledged_risk) VALUES (?,?,?,?,?,?,?)").run(bot, card.version, JSON.stringify(card), nowIso(), by, note, Number(options.acknowledgedRisk === true));
    db.prepare('UPDATE bots SET servers=?, "primary"=?, fallbacks=?, computer=? WHERE id=?').run(JSON.stringify([...new Set([...card.servers, "team"])]), JSON.stringify(card.choice), JSON.stringify(card.fallbacks), Number(card.computer), bot);
    db.exec("RELEASE save_card");
    return card;
  } catch (error) { db.exec("ROLLBACK TO save_card; RELEASE save_card"); throw error; }
}
// The caller uses this only after the owner's tap, just like saveCard.
export function restoreCard(bot: string, version: number): JobCard {
  const old = cardHistory(bot).find((c) => c.version === version);
  if (!old) throw new Error("That version of the job card could not be found.");
  return saveCard(bot, old.card, "owner", `Put back version ${version}.`, { acknowledgedRisk: old.acknowledgedRisk });
}
