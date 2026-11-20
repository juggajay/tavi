import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db, nowIso } from "../store/db.js";
import { getSecret, putSecret } from "../store/secrets.js";
import { assistantName } from "../profile/profile.js";
import { BOT_ID, type Bot, type EngineChoice } from "./contract.js";
import { CARD_SERVERS, currentCard, saveCard, validateCard, type JobCard } from "./cards/index.js";

export const DEFAULT_CHOICES = {
  anthropic: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
  openai: { provider: "openai-codex", model: "gpt-6.1-sol", effort: "high" },
} as const satisfies Record<string, EngineChoice>;

const choice = z.object({
  provider: z.enum(["anthropic", "openai-codex", "openrouter", "openai-api"]),
  model: z.string().trim().min(1).max(120),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
}).strict();
const fields = z.object({
  name: z.string().trim().min(1).max(120), role: z.string().max(500), soul: z.string(),
  look: z.object({ shape: z.string().min(1).max(80), colour: z.string().min(1).max(80) }).strict(),
  engine: z.enum(["hermes", "builtin"]), primary: choice, fallbacks: z.array(choice).max(10),
  servers: z.union([z.literal("all"), z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,50}$/))]),
  computer: z.boolean(), voice: z.string().min(1).max(80), lead: z.boolean(),
}).strict();
type Fields = z.infer<typeof fields>;
export type CreateBotInput = { id: string; name: string; card?: JobCard } & Partial<Omit<Fields, "name">>;
export type BotWithCard = Bot & { card?: JobCard | null };
export type BotPatch = Partial<Fields>;
const reserved = new Set(["probe", "livetest", "trial", "root", "hermes", "default"]);
type Row = Record<string, string | number | null>;
function unpack(row: Row): BotWithCard {
  const savedBox = JSON.parse(String(row.box));
  const box: Bot["box"] = { user: "gatewayPort" in savedBox ? null : savedBox.user, display: savedBox.display, vncPort: savedBox.vncPort, cdpPort: savedBox.cdpPort };
  return {
    id: String(row.id), name: String(row.name), role: String(row.role), soul: String(row.soul),
    look: JSON.parse(String(row.look)), engine: row.engine as Bot["engine"], primary: JSON.parse(String(row.primary)),
    fallbacks: JSON.parse(String(row.fallbacks)), servers: JSON.parse(String(row.servers)), computer: !!row.computer,
    voice: String(row.voice), box, generation: Number(row.generation),
    lead: !!row.lead, createdAt: String(row.created_at), card: currentCard(String(row.id)),
  };
}
export function listBots(): BotWithCard[] {
  return (db.prepare("SELECT * FROM bots WHERE removed_at IS NULL ORDER BY rowid").all() as Row[]).map(unpack);
}
export function getBot(id: string): BotWithCard | undefined {
  const row = db.prepare("SELECT * FROM bots WHERE id = ? AND removed_at IS NULL").get(id) as Row | undefined;
  return row && unpack(row);
}
export const leadBot = () => listBots().find((b) => b.lead);
function transaction<T>(fn: () => T): T {
  db.exec("SAVEPOINT bot_change");
  try { const out = fn(); db.exec("RELEASE bot_change"); return out; }
  catch (e) { db.exec("ROLLBACK TO bot_change; RELEASE bot_change"); throw e; }
}
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const out = schema.safeParse(value);
  if (!out.success) throw new Error("Those bot settings are not valid. Check the name and model choices.");
  return out.data;
}
export function createBot(input: CreateBotInput): BotWithCard {
  if (typeof input?.id !== "string" || !BOT_ID.test(input.id) || /^w-[a-f0-9]{20}$/.test(input.id) || reserved.has(input.id)) throw new Error("Choose a short bot name using small letters, numbers and hyphens. That name may be reserved.");
  const { id, card, ...rest } = input;
  if (card) validateCard(card);
  const data = checked(fields, { role: "", soul: "", look: { shape: "pebble", colour: "blue" }, engine: "hermes",
    primary: DEFAULT_CHOICES.anthropic, fallbacks: [], servers: "all", computer: false, voice: "marin", lead: false, ...rest });
  return transaction(() => {
    if (db.prepare("SELECT id FROM bots WHERE id = ?").get(id)) throw new Error("That bot name has already been used. Choose another.");
    const lead = !listBots().length || data.lead;
    if (lead) db.prepare("UPDATE bots SET lead = 0").run();
    const box: Bot["box"] = { user: null, display: null, vncPort: null, cdpPort: null };
    db.prepare('INSERT INTO bots (id,name,role,soul,look,engine,"primary",fallbacks,servers,computer,voice,box,generation,lead,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)')
      .run(id, data.name, data.role, data.soul, JSON.stringify(data.look), data.engine, JSON.stringify(data.primary), JSON.stringify(data.fallbacks),
        JSON.stringify(data.servers), Number(data.computer), data.voice, JSON.stringify(box), Number(lead), nowIso());
    try {
      putSecret(`bot:${id}:gateway-key`, randomBytes(32).toString("hex"));
      putSecret(`bot:${id}:toolbox-token`, randomBytes(32).toString("hex"));
    } catch { throw new Error("The bot's access keys could not be saved safely. The bot has not been added."); }
    if (card) saveCard(id, card, "owner", "First job card.");
    return getBot(id)!;
  });
}
export function updateBot(id: string, patch: BotPatch): Bot {
  const parsed = checked(fields.partial(), patch);
  const clean: BotPatch = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
  return transaction(() => {
    const old = getBot(id);
    if (!old) throw new Error("That bot is no longer on the team.");
    if (old.lead && clean.lead === false) throw new Error("Choose another lead before taking this one off the lead job.");
    if (clean.lead) db.prepare("UPDATE bots SET lead = 0").run();
    const next = { ...old, ...clean };
    db.prepare('UPDATE bots SET name=?,role=?,soul=?,look=?,engine=?,"primary"=?,fallbacks=?,servers=?,computer=?,voice=?,lead=? WHERE id=?')
      .run(next.name, next.role, next.soul, JSON.stringify(next.look), next.engine, JSON.stringify(next.primary), JSON.stringify(next.fallbacks),
        JSON.stringify(next.servers), Number(next.computer), next.voice, Number(next.lead), id);
    return getBot(id)!;
  });
}
export function removeBot(id: string): void {
  transaction(() => {
    const old = getBot(id);
    if (!old) return;
    db.prepare("UPDATE bots SET removed_at = ?, lead = 0 WHERE id = ?").run(nowIso(), id);
    if (old.lead) { const next = listBots()[0]; if (next) db.prepare("UPDATE bots SET lead = 1 WHERE id = ?").run(next.id); }
  });
}
export function newConversation(id: string): Bot {
  if (!getBot(id)) throw new Error("That bot is no longer on the team.");
  db.prepare("UPDATE bots SET generation = generation + 1 WHERE id = ?").run(id);
  return getBot(id)!;
}
function secret(id: string, name: string): string {
  if (!getBot(id)) throw new Error("That bot is no longer on the team.");
  let value: string | undefined;
  try { value = getSecret<string>(`bot:${id}:${name}`); }
  catch { throw new Error("The bot's saved access key could not be opened."); }
  if (!value) throw new Error("The bot's saved access key is missing.");
  return value;
}
export const gatewayKey = (id: string) => secret(id, "gateway-key");
export function teamGatewayKey(): string {
  try {
    let value = getSecret<string>("team:gateway-key");
    if (!value) { value = randomBytes(32).toString("hex"); putSecret("team:gateway-key", value); }
    return value;
  } catch { throw new Error("The team's access key could not be opened or saved safely."); }
}
export const toolboxToken = (id: string) => secret(id, "toolbox-token");
export function seedTeam(): Bot[] {
  if (db.prepare("SELECT id FROM bots LIMIT 1").get()) return listBots();
  return transaction(() => {
    createBot({ id: "pebble", name: assistantName() || "Pebble", role: "Your main assistant", look: { shape: "pebble", colour: "orange" }, primary: DEFAULT_CHOICES.anthropic,
      fallbacks: [DEFAULT_CHOICES.openai], servers: "all", lead: true, voice: process.env.LIVE_VOICE || "marin" });
    createBot({ id: "tim", name: "Tim", role: "Second opinion", look: { shape: "marble", colour: "slate" }, primary: { ...DEFAULT_CHOICES.openai, effort: "medium" },
      fallbacks: [DEFAULT_CHOICES.anthropic], servers: "all", voice: "ash" });
    saveCard("pebble", {
      version: 1, purpose: "Your main assistant", notFor: "Anything that needs your tap must wait for it.",
      handsBack: "A checked answer, with the things you asked for ready to open.", example: null,
      given: "Your requests and the information you have shared.", servers: [...CARD_SERVERS],
      stopAndAsk: "When only you can decide or an action needs your tap.", choice: DEFAULT_CHOICES.anthropic,
      fallbacks: [DEFAULT_CHOICES.openai], computer: false, trials: [], privateInfo: "about-card",
    }, "owner", "First lead job card. The lead may use all the owner's information.");
    return listBots();
  });
}
