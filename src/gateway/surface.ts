// What each v2 client has on screen (reported with "screen" messages, kept in clients.ts) and commands for its pull-up
// surface. The brain is told what's on screen so "that one" and "zoom in on the laundry" make sense.
import { clientById } from "./clients.js";
import { getItem } from "../store/items.js";
import { revisionsOf } from "../store/shopdrawings.js";
import { bus } from "../events.js";
import type { Item, SurfaceCommand } from "../shared/protocol.js";

export function surfaceOf(clientId: string | null) {
  const c = clientId ? clientById(clientId) : undefined;
  const screen = c?.v === 2 ? c.screen : null;
  const item = screen?.item_id ? getItem(screen.item_id) : null;
  return { client: c ?? null, screen, item };
}

export function command(clientId: string, cmd: SurfaceCommand) {
  bus.emit("surface", { client_id: clientId, cmd });
}

/** One line for the brain's Context, or null when nothing is up. */
export function describeScreen(clientId: string | null): string | null {
  const { screen, item } = surfaceOf(clientId);
  // the sketch pad covers everything else while it's open (Stage 8.5)
  if (screen?.pad) return "On screen now: the sketch pad is open; they're drawing something to show you. It arrives as their sketch when they tap Send.";
  if (!item) return null;
  if (item.kind === "model" && screen?.model) return `On screen now: ${describeItem(item)}${screen.model.apart ? ", pulled apart" : ""}${screen.model.sizes ? ", sizes showing" : ""}`;
  const pages = screen?.page_count && screen.page_count > 1 ? ` (page ${(screen.page_index ?? 0) + 1} of ${screen.page_count}; they can say "next")` : "";
  return `On screen now: ${describeItem(item)}${pages}${item.kind === "shopdrawing" ? onSheet(item.payload, screen?.page_index ?? 0) : ""}`;
}

/**
 * A shop drawing's page (Stage 19.3): its sheet, the joint details on it, and the views he has asked for, newest last,
 * so "make that detail bigger" and "take the last one off" have something to go on.
 */
function onSheet(p: Extract<Item, { kind: "shopdrawing" }>["payload"], page: number): string {
  const rev = revisionsOf(p.drawing_id).find((r) => r.rev === p.rev);
  const sh = rev?.sheets[page];
  if (!rev || !sh) return "";
  const details = sh.details?.length ? `, with detail${sh.details.length > 1 ? "s" : ""} ${sh.details.join(", ")}` : "";
  const here = (sh.asked ?? []).map((a) => a.label);
  const label = new Map(rev.sheets.flatMap((s) => s.asked ?? []).map((a) => [a.id, a.label]));
  const views = (rev.input.views ?? []).map((v) => `${label.get(v.id) ?? "(not drawn)"}: ${v.kind === "3d" ? "a 3D view" : `a ${v.kind}`}${v.parts?.length ? ` of ${v.parts.join(" and ")}` : ""}${v.from ? ` from ${v.from}` : ""}`);
  return `; this page: "${sh.title}"${details}${here.length ? ` (asked for: ${here.join(", ")})` : ""}${views.length ? `; views they asked for, newest last: ${views.join("; ")}` : ""}`;
}

export function describeItem(item: Item): string {
  switch (item.kind) {
    case "sheet": {
      const p = item.payload;
      const rings = p.marks.length ? `, ringed: ${[...new Set(p.marks.map((m) => m.label).filter(Boolean))].join(", ")}` : "";
      return `drawing ${p.sheet_no ?? "(no number)"} ${p.title ?? ""} Rev ${p.revision ?? "?"} (${p.project}), "${item.title}"${rings} [item ${item.id}]`;
    }
    case "sketch": {
      const dims = item.payload.shapes.filter((s) => s.type === "dim").length;
      return `a sketch: ${item.title}, ${count(dims)} ${dims === 1 ? "dimension" : "dimensions"} [item ${item.id}]`;
    }
    case "model": {
      const p = item.payload;
      const made = p.made_by ? `, made by the ${p.made_by.recipe} recipe with ${JSON.stringify(p.made_by.params)}` : "";
      return `a 3D model: ${item.title}, ${count(p.parts.length)} ${p.parts.length === 1 ? "part" : "parts"}${made} [item ${item.id}]`;
    }
    case "shopdrawing": {
      const p = item.payload;
      return `shop drawing ${p.number} revision ${p.rev}, ${p.status.toLowerCase()}: "${item.title}" for ${p.client} (${p.project}), ${count(p.sheets.length)} sheets, drawn from model ${p.model_item ?? "(none)"} [item ${item.id}]`;
    }
    case "reference":
      return `a page from a reference book: "${item.title}" (${item.source})${item.payload.marks.length ? ", the row used is ringed" : ""}; they can zoom in to check it [item ${item.id}]`;
    case "draft":
      return `a draft waiting for their OK: ${item.payload.summary || item.payload.subject} [approval ${item.payload.approval_id}, item ${item.id}]`;
    case "list":
      return `list "${item.title}" (${item.payload.rows.length} rows)${item.source ? `, from ${item.source}` : ""} [item ${item.id}]`;
    case "table":
      return `table "${item.title}" (${item.payload.rows.length} rows)${item.source ? `, from ${item.source}` : ""} [item ${item.id}]`;
    default:
      return `${item.kind} "${item.title}"${item.source ? ` (${item.source})` : ""} [item ${item.id}]`;
  }
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/** A small count as a word, the way the voice would say it ("six dimensions"). */
const count = (n: number) => WORDS[n] ?? String(n);
