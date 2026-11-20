import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TurnCtx, TurnInfo } from "../brain/turn.js";
import type { Item } from "../shared/protocol.js";
import { db } from "../store/db.js";
import { getItem } from "../store/items.js";
import { jobBot } from "../brain/tasks.js";
import { getBot } from "./bots.js";
import { clientById } from "../gateway/clients.js";
import { getDrawing, revisionsOf, type Drawing } from "../store/shopdrawings.js";
import type { DocRow } from "../files/library.js";

const makers = new WeakMap<Item, string | null>();
const currentCall = new AsyncLocalStorage<{ turn: TurnInfo; lines: string[] }>();
function noteMaker(turn: TurnInfo, line: string) {
  const call = currentCall.getStore();
  if (call?.turn === turn) call.lines.push(line);
}
export function rememberMaker(item: Item, bot: string | null) { makers.set(item, bot); }
export function makerForJob(job: string | null): string | null {
  if (!job) return null;
  return /^lh-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(job)?.[1] ?? jobBot(job);
}
export function itemBot(item: Item): string | null {
  return makers.has(item) ? makers.get(item)! : makerForJob(item.job_id);
}
export const makerName = (bot: string | null) => bot ? getBot(bot)?.name ?? bot : "the earlier assistant";
export const isLead = (turn: Pick<TurnInfo, "bot">) => !turn.bot || !!getBot(turn.bot)?.lead;
export function screenItem(turn: Pick<TurnInfo, "origin">): string | null {
  const id = turn.origin && "client" in turn.origin ? turn.origin.id : null;
  return id ? clientById(id)?.screen?.item_id ?? null : null;
}
export function mayUseItem(turn: TurnInfo, item: Item): boolean {
  return isLead(turn) || itemBot(item) === turn.bot || !!turn.given_items?.includes(item.id);
}
export function mayLookItem(turn: TurnInfo, item: Item): boolean {
  return mayUseItem(turn, item) || screenItem(turn) === item.id;
}
export function makerLine(turn: Pick<TurnInfo, "bot">, item: Item): string {
  return turn.bot && itemBot(item) !== turn.bot ? `This was made by ${makerName(itemBot(item))}.` : "";
}
export function itemRefusal(item: Item): string {
  const name = makerName(itemBot(item));
  const kind = item.kind === "model" ? "model" : item.kind === "shopdrawing" ? "drawing" : "item";
  return `That ${kind} was made by ${name}. Make your own, or ask the owner to hand ${name}'s over to you.`;
}
/** Check before reading contents or doing anything with them. Looking never grants reuse. */
export function itemAccess(turn: TurnInfo, item: Item, look = false): string | null {
  if (!(look ? mayLookItem(turn, item) : mayUseItem(turn, item))) return itemRefusal(item);
  const line = makerLine(turn, item);
  if (line) {
    noteMaker(turn, line);
    if (!look) (turn.based_on_items ??= new Set()).add(item.id);
  }
  return null;
}
export function drawingItem(d: Drawing): Item | null {
  for (const r of [...revisionsOf(d.id)].reverse()) {
    const it = r.item_id ? getItem(r.item_id) : null;
    if (it) return it;
  }
  return d.model_item ? getItem(d.model_item) : null;
}
export function mayUseDrawing(turn: TurnInfo, d: Drawing): boolean {
  const it = drawingItem(d);
  return isLead(turn) || !!(it && mayUseItem(turn, it));
}
export function drawingAccess(turn: TurnInfo, d: Drawing, look = false): string | null {
  if (isLead(turn)) { const it = drawingItem(d); return it ? itemAccess(turn, it, look) : null; }
  const it = drawingItem(d);
  const on = screenItem(turn);
  const onItem = on ? getItem(on) : null;
  if (look && onItem?.kind === "shopdrawing" && onItem.payload.drawing_id === d.id) return itemAccess(turn, onItem, true);
  return it ? itemAccess(turn, it, look) : "Ask the owner to hand that drawing over to you.";
}
export function fileMeta(d: Pick<DocRow, "meta_json">): Record<string, unknown> {
  try { return JSON.parse(d.meta_json ?? "{}"); } catch { return {}; }
}
export function fileItem(d: Pick<DocRow, "meta_json">): Item | null {
  const meta = fileMeta(d);
  if (typeof meta.item === "string") return getItem(meta.item);
  if (typeof meta.drawing === "string") { const drawing = getDrawing(meta.drawing); return drawing ? drawingItem(drawing) : null; }
  return null;
}
export function madeFileBot(d: Pick<DocRow, "meta_json">): string | null {
  const meta = fileMeta(d);
  if (typeof meta.made_by_bot === "string") return meta.made_by_bot;
  const item = fileItem(d);
  return item ? itemBot(item) : null;
}
export function mayUseFile(turn: TurnInfo, d: DocRow): boolean {
  if (isLead(turn)) return true;
  const meta = fileMeta(d);
  const made = d.type === "made" || meta.by === "assistant" || "made_by_bot" in meta || !!meta.item || !!meta.drawing;
  if (!made) return true;
  const item = fileItem(d);
  return madeFileBot(d) === turn.bot || !!turn.given_items?.includes(d.id) || !!(item && mayUseItem(turn, item));
}
export function fileAccess(turn: TurnInfo, d: DocRow, look = false): string | null {
  const item = fileItem(d);
  const on = screenItem(turn);
  const shown = on ? getItem(on) : null;
  const onScreen = look && shown?.kind === "image" && shown.payload.src.startsWith(`/api/files/${d.id}/`);
  if (!mayUseFile(turn, d) && !onScreen) return `That file was made by ${makerName(madeFileBot(d))}. Make your own, or ask the owner to hand it over to you.`;
  if (item && mayUseItem(turn, item)) itemAccess(turn, item, look);
  else if (turn.bot && madeFileBot(d) && madeFileBot(d) !== turn.bot) noteMaker(turn, `This was made by ${makerName(madeFileBot(d))}.`);
  return null;
}
/** The stored record keeps the maker even if the original work record is later removed. */
export function madeFileMeta(extra: Record<string, unknown>): Record<string, unknown> {
  const item = fileItem({ meta_json: JSON.stringify(extra) });
  const bot = currentCall.getStore()?.turn.bot;
  return bot ? { ...extra, made_by_bot: bot } : "made_by_bot" in extra ? extra : item ? { ...extra, made_by_bot: itemBot(item) } : extra;
}
export function recordFileMaker(id: string, turn: TurnInfo) {
  if (!turn.bot) return;
  const doc = db.prepare("SELECT * FROM docs WHERE id = ?").get(id) as DocRow | undefined;
  if (doc) db.prepare("UPDATE docs SET meta_json = ? WHERE id = ?").run(JSON.stringify({ ...fileMeta(doc), made_by_bot: turn.bot }), id);
}
export function receiptBasis(turn: TurnInfo): string[] {
  return [...new Set([...(turn.based_on_items ?? [])].flatMap((id) => { const it = getItem(id); return it && itemBot(it) !== turn.bot ? [`Built on work made by ${makerName(itemBot(it))}.`] : []; }))];
}
export function itemsInBrief(turn: TurnInfo, given: string): string[] {
  const ids = [...new Set(given.match(/\b(?:itm|doc)_[a-f0-9]{16}\b/g) ?? [])];
  for (const id of ids) {
    const item = getItem(id);
    const doc = db.prepare("SELECT * FROM docs WHERE id = ?").get(id) as DocRow | undefined;
    const refusal = item ? itemAccess(turn, item) : doc ? fileAccess(turn, doc) : "That item is not kept any more. Choose one from your own list.";
    if (refusal) throw new Error(refusal);
  }
  return ids;
}
/** Each call carries its own bot's rules, including calls that only show a test reply. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ownedTools(ctx: TurnCtx, tools: SdkMcpToolDefinition<any>[]): SdkMcpToolDefinition<any>[] {
  return tools.map((tool) => ({ ...tool, handler: async (args, extra) => {
    if (ctx.bot) {
      ctx.turn.bot = ctx.bot;
      ctx.turn.given_items = ctx.given_items;
    }
    const call = { turn: ctx.turn, lines: [] as string[] };
    const result = await currentCall.run(call, () => {
      // These two tools can reach made files without going through the files tools.
      const refs = tool.name === "add_guide" ? [args.file] : tool.name === "brain_start_job" && Array.isArray(args.drawings) ? args.drawings.map((d: { file?: string }) => d.file) : [];
      for (const ref of refs) {
        if (typeof ref !== "string") continue;
        const doc = db.prepare("SELECT * FROM docs WHERE id = ? OR name = ? COLLATE NOCASE OR name = ? COLLATE NOCASE ORDER BY indexed_at DESC LIMIT 1").get(ref.trim(), ref.trim(), `${ref.trim()}.pdf`) as DocRow | undefined;
        if (doc) {
          const refusal = fileAccess(ctx.turn, doc);
          if (refusal) return { content: [{ type: "text" as const, text: JSON.stringify({ error: refusal }, null, 2) }] };
        }
      }
      return tool.handler(args, extra);
    });
    const lines = [...new Set(call.lines)];
    if (!lines.length) return result;
    const first = result.content[0];
    return first?.type === "text" ? { ...result, content: [{ ...first, text: `${lines.join("\n")}\n${first.text}` }, ...result.content.slice(1)] } : result;
  } }));
}
