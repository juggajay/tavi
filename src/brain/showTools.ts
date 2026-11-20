// Putting things on the owner's screen (v2 items): a drawing sheet opened at the spot with the thing ringed, a list
// whose rows open sheets, a table, a note; bringing back something shown earlier; pinning; "what have you shown me
// today"; and pointing at something on the sheet already up. The functions are also used by the fake brain.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { formatLocal } from "../time.js";
import { z } from "zod";
import { describeSheet, findSheet, locate, regionFor, type Sheet } from "../drawings/library.js";
import { createItem, findItems, getItem, publishItem, shownToday, touchItem, updateItem } from "../store/items.js";
import { addPin, clearPins, listPins, pinScreen, unpin, unpinItem } from "../store/pins.js";
import { clientById } from "../gateway/clients.js";
import { bus } from "../events.js";
import { testSafe, type TurnCtx, type TurnInfo } from "./turn.js";
import type { Box, Item, ListTarget, Mark } from "../shared/protocol.js";
import { SHAPE, sketchProblem } from "../store/sketch.js";
import { getDoc } from "../files/library.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assistantName } from "../profile/profile.js";
import { listShortcuts } from "../gateway/shortcut.js";
import { fileAccess, itemAccess, mayUseItem } from "../hq/ownership.js";
import { pageTools } from "./pageTools.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const err = (message: string) => json({ error: message });
const MAX_PAGES = 5;

type SheetDims = Sheet & { width_pt?: number; height_pt?: number };
const asBox = (b: number[]) => b.map((v) => Math.min(1, Math.max(0, v))) as Box;

/** Rings for each phrase on the sheet (up to 6 in all). */
async function marksFor(s: Sheet, around: string[]): Promise<Mark[]> {
  const marks: Mark[] = [];
  for (const phrase of around) {
    for (const hit of await locate(s, phrase, 6 - marks.length)) marks.push({ box: asBox(hit.box), label: phrase });
    if (marks.length >= 6) break;
  }
  return marks;
}

export type ShowSheetArgs = { sheet: string; project?: string; around?: string | string[]; box?: number[]; region?: string; caption: string };

/** A sheet item opened where the answer is, with what was asked about ringed. */
export async function showSheet(turn: TurnInfo, a: ShowSheetArgs): Promise<{ item: Item; marks: number } | { error: string }> {
  const s = findSheet(a.sheet, a.project) as SheetDims | undefined;
  if (!s) return { error: `No sheet "${a.sheet}" found.` };
  if (turn.items.length >= MAX_PAGES) return { error: `Already showing ${MAX_PAGES} things this turn; that's the most that fit.` };
  const around = (Array.isArray(a.around) ? a.around : a.around ? [a.around] : []).filter(Boolean);
  const marks = await marksFor(s, around);
  const view = a.box?.length === 4 || a.region || around.length ? asBox(await regionFor(s, { box: a.box, region: a.region, around: around[0], close: true })) : ([0, 0, 1, 1] as Box);
  const aspect = s.width_pt && s.height_pt ? s.width_pt / s.height_pt : Math.SQRT2;
  const item = createItem(turn, {
    kind: "sheet",
    title: a.caption,
    source: describeSheet(s),
    payload: { sheet_id: s.id, sheet_no: s.sheet_no, title: s.title, revision: s.revision, status: s.status, project: s.project, aspect, marks, view },
  });
  publishItem(item, turn);
  return { item, marks: marks.length };
}

export type ListRowArgs = { cells: string[]; sheet?: string; project?: string; around?: string; item_id?: string; url?: string };

/** Only plain web links make it onto the screen (no javascript:, file: or app links). */
function webLink(u: string | undefined) {
  if (!u) return undefined;
  try {
    const url = new URL(u.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString().slice(0, 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** A list; a row naming a sheet (and what to look for on it) opens that sheet at that spot. */
export async function showList(turn: TurnInfo, a: { heading: string; sub?: string; columns?: string[]; rows: ListRowArgs[]; source?: string }) {
  for (const row of a.rows) {
    const item = row.item_id ? getItem(row.item_id) : null;
    if (item) { const refusal = itemAccess(turn, item); if (refusal) throw new Error(refusal); }
  }
  const rows = [];
  let n = 0;
  for (const r of a.rows.slice(0, 500)) {
    let target: ListTarget | undefined;
    if (r.item_id && getItem(r.item_id)) target = { type: "item", item_id: r.item_id };
    else if (r.sheet) {
      const s = findSheet(r.sheet, r.project);
      if (s) {
        const hit = r.around ? (await locate(s, r.around, 1))[0] : undefined;
        const box = hit ? asBox(await regionFor(s, { around: r.around, close: true })) : ([0, 0, 1, 1] as Box);
        target = { type: "sheet", sheet_id: s.id, box, label: r.around ?? s.sheet_no ?? "" };
      }
    }
    const url = webLink(r.url);
    rows.push({ id: `r${n++}`, cells: r.cells.slice(0, 12).map(String), ...(target ? { target } : {}), ...(url ? { url } : {}) });
  }
  const item = createItem(turn, { kind: "list", title: a.heading, source: a.source ?? "", payload: { heading: a.heading, sub: a.sub, columns: a.columns, rows } });
  publishItem(item, turn);
  return { item, linked: rows.filter((r) => r.target).length, links: rows.filter((r) => r.url).length, cut: a.rows.length > 500 };
}

export function showTable(turn: TurnInfo, a: { title: string; columns: string[]; rows: string[][]; highlight?: { row: number; col: number }[]; note?: string; source?: string }) {
  const cutCols = a.columns.length > 12;
  const cutRows = a.rows.length > 200;
  const item = createItem(turn, {
    kind: "table",
    title: a.title,
    source: a.source ?? "",
    payload: { columns: a.columns.slice(0, 12), rows: a.rows.slice(0, 200).map((r) => r.slice(0, 12).map(String)), highlight: a.highlight, note: a.note },
  });
  publishItem(item, turn);
  return { item, cut: cutCols || cutRows ? `Cut to ${Math.min(12, a.columns.length)} columns and ${Math.min(200, a.rows.length)} rows.` : undefined };
}

export function showNote(turn: TurnInfo, a: { title: string; rows?: { label: string; value: string }[]; text?: string; source?: string }) {
  const item = createItem(turn, { kind: "note", title: a.title, source: a.source ?? "", payload: { rows: a.rows ?? [], text: a.text } });
  publishItem(item, turn);
  return { item };
}

/** A sketch (Stage 8.5): checked against the limits first, so a bad one comes back with a plain reason to fix. */
export function showSketch(turn: TurnInfo, a: { title: string; shapes: unknown[]; note?: string }): { item: Item } | { error: string } {
  const payload = { shapes: a.shapes, ...(a.note ? { note: a.note } : {}) };
  const problem = sketchProblem(payload);
  if (problem) return { error: problem };
  const item = createItem(turn, { kind: "sketch", title: a.title || "Sketch", source: "Sketch", payload });
  publishItem(item, turn);
  return { item };
}

/**
 * Open the sketch pad on the screen the turn came from (Stage 8.5 Part B): blank, or over a photo they sent (by its file
 * id) so they can draw on it. Writes nothing; the drawing comes back as their sketch when they tap Send.
 */
export function openSketchPad(turn: TurnInfo, a: { prompt?: string; over?: string }): { opened: string } | { error: string } {
  const clientId = turn.origin && "client" in turn.origin ? turn.origin.id : null;
  if (!clientId || !clientById(clientId)) return { error: "There's no phone or PC app open to put the pad on." };
  let over: { file: string; src: string; w: number; h: number } | undefined;
  if (a.over) {
    const d = getDoc(a.over);
    if (d) { const refusal = fileAccess(turn, d); if (refusal) return { error: refusal }; }
    if (!d || d.type !== "image") return { error: `No photo "${a.over}" to draw on.` };
    const meta = d.meta_json ? (JSON.parse(d.meta_json) as { w?: number; h?: number }) : {};
    if (!meta.w || !meta.h) return { error: "I can't tell that photo's size, so I can't put it under the pad." };
    over = { file: d.id, src: `/api/files/${d.id}/image-2048.jpg`, w: meta.w, h: meta.h };
  }
  const prompt = a.prompt?.trim().slice(0, 120) || undefined;
  bus.emit("surface", { client_id: clientId, cmd: { cmd: "pad", ...(prompt ? { prompt } : {}), ...(over ? { over } : {}) } });
  return { opened: over ? `the sketch pad over ${over.file}` : "the sketch pad" };
}

/** Bring something shown earlier back up. One clear match: shown. Several: their titles, so the model can ask. */
export function showAgain(turn: TurnInfo, query: string) {
  const direct = turn.bot ? getItem(query) : null;
  if (direct) { const refusal = itemAccess(turn, direct); if (refusal) return { error: refusal }; }
  const found = direct ? [direct] : findItems(query, turn.bot ? 500 : 5).filter((it) => mayUseItem(turn, it)).slice(0, 5);
  if (!found.length) return { error: "Nothing shown earlier matches. Find it again and show it." };
  const best = found[0];
  const refusal = itemAccess(turn, best);
  if (refusal) return { error: refusal };
  const clear = found.length === 1 || query.trim() === "" || best.title.toLowerCase().includes(query.trim().toLowerCase());
  if (!clear) return { several: found.map((i) => `${i.title} (${i.source || i.kind})`) };
  const item = turn.persist ? touchItem(best.id)! : best;
  turn.items.push(item.id);
  publishItem(item, turn);
  return { item };
}

/** A pin as the brain is told about it. */
function pinInfo(p: ReturnType<typeof listPins>[number]) {
  const it = p.items[p.idx];
  const days = Math.floor((Date.now() - Date.parse(p.pinned_at)) / 86_400_000);
  return {
    pin_id: p.id,
    label: p.label,
    title: it?.title,
    kind: it?.kind,
    ...(p.items.length > 1 ? { pages: p.items.length, left_on_page: p.idx + 1 } : {}),
    pinned: days <= 0 ? `today at ${formatLocal(p.pinned_at, { hour: "numeric", minute: "2-digit" })}` : days === 1 ? "yesterday" : `${days} days ago`,
    ...(p.until ? { just_for_today: true } : {}),
  };
}

/** What the asking client's screen shows, whole (13.2: what pin_item pins). */
function screenNow(turn: TurnInfo) {
  const id = turn.origin && "client" in turn.origin ? turn.origin.id : null;
  return (id ? clientById(id)?.screen : null) ?? null;
}

/** What the asking client has on screen, if it told us (v2 clients report it). */
export function screenOf(turn: TurnInfo) {
  const id = turn.origin && "client" in turn.origin ? turn.origin.id : null;
  const c = id ? clientById(id) : undefined;
  return { clientId: id, itemId: c?.screen?.item_id ?? null };
}

/** "Shown today": pinned first, then today's, as a list whose rows open each one. */
export function listShown(turn: TurnInfo) {
  const items = shownToday().filter((it) => mayUseItem(turn, it)).slice(0, 60);
  for (const it of items) itemAccess(turn, it, true);
  const label = (i: Item) => (i.kind === "page" ? "Page" : i.kind === "sheet" ? "Drawing" : i.kind === "reference" ? "Table" : i.kind === "sketch" ? "Sketch" : i.kind === "model" ? "3D model" : i.kind === "shopdrawing" ? "Shop drawing" : i.kind === "draft" ? "Draft" : i.kind === "table" ? "Table" : i.kind === "list" ? "List" : "Note");
  const time = (i: Item) => formatLocal(i.shown_at, { hour: "numeric", minute: "2-digit" });
  const item = createItem(turn, {
    kind: "list",
    title: "Shown today",
    payload: {
      heading: "Shown today",
      sub: items.length ? `${items.filter((i) => i.pinned).length} kept handy` : "Nothing yet today.",
      rows: items.map((i) => ({ id: i.id, cells: [i.title, i.pinned ? "Kept handy" : time(i), label(i)], target: { type: "item" as const, item_id: i.id } })),
    },
  });
  publishItem(item, turn);
  // models made by a recipe carry the sizes used, so one can be changed by talking ("make the tenon 10 longer")
  const models = items.flatMap((i) => (i.kind === "model" ? [{ item: i.id, title: i.title, made_by: i.payload.made_by }] : []));
  return { item, count: items.length, models };
}

/** Ring something on the sheet that's already on the owner's screen, and fly there. */
export async function pointAt(turn: TurnInfo, text: string) {
  const { clientId, itemId } = screenOf(turn);
  const it = itemId ? getItem(itemId) : null;
  if (!it || it.kind !== "sheet") return { error: "There's no drawing on their screen right now. Use show_drawing." };
  const refusal = itemAccess(turn, it);
  if (refusal) return { error: refusal };
  const s = findSheet(it.payload.sheet_id);
  if (!s) return { error: "That sheet isn't in the library any more." };
  const marks = await marksFor(s, [text]);
  if (!marks.length) return { error: `"${text}" isn't on ${it.payload.sheet_no ?? "that sheet"}.` };
  const view = asBox(await regionFor(s, { around: text, close: true }));
  if (turn.persist) updateItem(it.id, { payload: { marks, view } });
  if (clientId) bus.emit("surface", { client_id: clientId, cmd: { cmd: "focus", box: view, mark: marks[0] } });
  return { item: it, marks: marks.length };
}

const rowArg = z.object({
  cells: z.array(z.string()).min(1).max(12).describe("The row's cells, in column order"),
  sheet: z.string().optional().describe("Sheet number or id: tapping the row opens this sheet"),
  around: z.string().optional().describe("Text to ring on that sheet, e.g. the door mark D07"),
  item_id: z.string().optional().describe("Or: an earlier item to open"),
  url: z.string().optional().describe("A web link for this row, its own: the place's website or booking page if found, else a Google Maps search for it. Tapping the row opens it."),
});

export const showTools = (ctx: TurnCtx) =>
  testSafe(ctx, [
    ...pageTools(ctx),
    tool(
      "show_list",
      "Put a list on the owner's screen. Rows can open a sheet at the spot (give sheet and around), so 'which doors are on the " +
        "ground floor' is a list whose rows open the plan at each door. For places, businesses, products or web pages give each " +
        "row a url, with cells [name, one-line description, then short facts like suburb, rating, price, hours]: it shows as a " +
        "tidy list of links. Then say one short sentence; don't read the list out.",
      {
        heading: z.string().describe("e.g. 'Doors on the ground floor'"),
        sub: z.string().optional().describe("One short line under the heading, e.g. 'A-101 Rev C · 8 doors'"),
        columns: z.array(z.string()).max(12).optional(),
        rows: z.array(rowArg).max(500),
        source: z.string().optional().describe("Where it came from: sheet and revision, account, or website"),
      },
      async (a) => {
        for (const row of a.rows) { const it = row.item_id ? getItem(row.item_id) : null; if (it) { const refusal = itemAccess(ctx.turn, it); if (refusal) return err(refusal); } }
        const r = await showList(ctx.turn, a);
        // Web results without their links: ask for them once, while the search results are still at hand.
        const missing = !r.links && !r.linked && !a.rows.some((x) => x.item_id) && ctx.external.has("the web");
        return json({
          shown: r.item.title,
          rows: a.rows.length,
          rows_that_open_a_sheet: r.linked,
          rows_with_links: r.links || undefined,
          cut: r.cut || undefined,
          note: missing ? "These look like web results but no row has a url. Show the list again with each row's url (the links from your search results), so the owner can tap through." : undefined,
        });
      },
    ),
    tool(
      "show_table",
      "Put a table on the owner's screen (prices to compare, quantities, a schedule extract). highlight marks cells to look at. " +
        "Then say one short sentence; don't read the table out.",
      {
        title: z.string(),
        columns: z.array(z.string()).min(1),
        rows: z.array(z.array(z.string())),
        highlight: z.array(z.object({ row: z.number().int(), col: z.number().int() })).optional(),
        note: z.string().optional().describe("One line under the table, e.g. 'Prices include GST, checked 9:40am'"),
        source: z.string().optional(),
      },
      async (a) => {
        const r = showTable(ctx.turn, a);
        return json({ shown: r.item.title, cut: r.cut });
      },
    ),
    tool(
      "show_note",
      "Put a short note on the owner's screen: label/value rows and/or a few lines of text, for exact figures worth seeing.",
      { title: z.string(), rows: z.array(z.object({ label: z.string(), value: z.string() })).optional(), text: z.string().optional(), source: z.string().optional() },
      async (a) => json({ shown: showNote(ctx.turn, a).item.title }),
    ),
    tool(
      "show_sketch",
      "Put a clean line sketch on the owner's screen: a side view or a plan, with the sizes on. You describe shapes; the app " +
        "draws them. Draw to real sizes in millimetres, x to the right and y UP. Dimension every length that matters (dim: " +
        "from a to b, set off to the left of a→b by offset; leave text out and it writes the true length). Lengths you worked " +
        "out come from the calculator. Keep it to what helps: one view, not a side view and a plan crammed together. The app " +
        "adds 'Sketch only. Check sizes on site.' under it, so you needn't. Shapes: line {a, b, style?, weight? 1-3}; rect " +
        "{x, y, w, h, fill? none|timber|hatch} and poly {points, fill?} for a member at its real size; arc {c, r, from_deg, " +
        "to_deg}; dim {a, b, offset, text?}; angle {at, from_deg, to_deg, text?}; label {at, text, leader?}. Points are " +
        "[x, y]. At most 200 shapes; text 60 characters; note 200. Then say one short sentence.",
      {
        title: z.string().max(120).describe("e.g. 'Rafter birdsmouth'"),
        shapes: z.array(SHAPE).min(1), // the count is checked in showSketch, for a plain reason
        note: z.string().max(200).optional().describe("One line under it, e.g. 'Birdsmouth no deeper than a third of the rafter'"),
      },
      async (a) => {
        const r = showSketch(ctx.turn, a);
        return "error" in r ? err(r.error) : json({ shown: r.item.title, shapes: a.shapes.length, dimensions: a.shapes.filter((s) => s.type === "dim").length });
      },
    ),
    tool(
      "open_sketch_pad",
      "Open the sketch pad on their screen so they can draw what they mean with a finger: on blank paper, or over a photo " +
        "they sent (over: its file id). Use it when they ask ('let me draw it', 'I'll sketch it', 'can I show you'), or when " +
        "they said yes to your offer to draw it. prompt: one short line shown at the top, e.g. 'Draw me the corner you mean'. " +
        "Then say one short line ('Go ahead, draw it'). Their drawing comes back as their sketch when they tap Send.",
      { prompt: z.string().max(120).optional(), over: z.string().optional().describe("File id of a photo to draw on") },
      async (a) => {
        const r = openSketchPad(ctx.turn, a);
        return "error" in r ? err(r.error) : json(r);
      },
    ),
    tool(
      "show_again",
      "Bring something already shown back up ('show me that again', 'put the floor plan back up'). Searches what was shown by " +
        "its words; no query means the last thing. If several match you get their titles: ask which.",
      { query: z.string().optional() },
      async ({ query }) => {
        const r = showAgain(ctx.turn, query ?? "");
        return "error" in r ? err(r.error!) : "several" in r ? json({ several_match: r.several, note: "Ask which one." }) : json({ shown: r.item!.title });
      },
    ),
    tool(
      "show_card_again",
      "Same as show_again (older name).",
      { query: z.string().optional() },
      async ({ query }) => {
        const r = showAgain(ctx.turn, query ?? "");
        return "error" in r ? err(r.error!) : "several" in r ? json({ several_match: r.several }) : json({ shown: r.item!.title });
      },
    ),
    tool(
      "list_shown",
      "'What have you shown me today?': puts a list of today's items (kept-handy ones first) on screen; each row opens it.",
      {},
      async () => {
        const r = listShown(ctx.turn);
        return json({ shown: "Shown today", count: r.count, ...(r.models.length ? { models: r.models } : {}) });
      },
    ),
    tool(
      "point_at",
      "Ring something on the drawing that's already on the owner's screen and zoom to it ('where's the laundry door?' while the " +
        "plan is up). Use show_drawing instead if no drawing is up.",
      { text: z.string().describe("Text on the sheet, e.g. 'D07' or 'LAUNDRY'") },
      async ({ text }) => {
        const r = await pointAt(ctx.turn, text);
        return "error" in r ? err(r.error!) : json({ pointed_at: text, marks: r.marks });
      },
    ),
    // Pins (Stage 13.2): up to five things on the phone's home screen, under Pebble. Only when the owner asks.
    tool(
      "pin_item",
      "Pin something to the owner's phone home screen, ONLY when they ask ('pin this', 'pin the Example Lake floor plan', " +
        "'pin this for today', 'keep that handy'). No item_id: what's on their screen now, with the pages beside it, " +
        "where they're looking. To pin something that isn't up, bring it up first (show_again or show_drawing), then " +
        "pin_item. for_today: it clears itself at their midnight. Five at most: if it says full, name the five briefly " +
        "and ask which one to drop, then call again with replace.",
      { item_id: z.string().optional(), for_today: z.boolean().optional(), replace: z.string().optional().describe("The pin_id to drop for this one") },
      async ({ item_id, for_today, replace }) => {
        const screen = screenNow(ctx.turn);
        const ids = item_id ? [item_id] : ctx.turn.items.length ? ctx.turn.items.slice(-MAX_PAGES) : screen?.set?.length ? screen.set : screen?.item_id ? [screen.item_id] : [];
        for (const id of ids) { const it = getItem(id); if (it) { const refusal = itemAccess(ctx.turn, it); if (refusal) return err(refusal); } }
        const pins = listPins().filter((p) => p.items.every((it) => mayUseItem(ctx.turn, it)));
        if (replace && !pins.some((p) => p.id === replace)) return err("That pin is not available to this bot. Ask the owner to hand it over.");
        // No id: what this answer has just put up (the phone hasn't reported its screen yet), else what's on screen.
        const shown = ctx.turn.items.filter((id) => getItem(id)?.kind !== "list" || getItem(id)?.title !== "Shown today");
        const r = item_id
          ? addPin({ item_ids: [item_id], for_today, replace })
          : shown.length
            ? addPin({ item_ids: shown.slice(-MAX_PAGES), for_today, replace })
            : pinScreen(screenNow(ctx.turn), { for_today, replace });
        if ("error" in r) return err(item_id ? r.error : "Nothing is on their screen. Bring it up first (show_again), then pin_item.");
        if ("full" in r) return json({ full: true, pinned_now: r.pins.filter((p) => p.items.every((it) => mayUseItem(ctx.turn, it))).map(pinInfo), ask: "Five are pinned. Ask the owner which one to drop." });
        return json({ pinned: r.pin.label, for_today: !!r.pin.until, ...(r.already ? { was_already_pinned: true } : {}) });
      },
    ),
    tool(
      "unpin_item",
      "Unpin, ONLY when the owner asks: 'unpin that' (no ids: what's on their screen), a pin by pin_id ('unpin the " +
        "Example Lake one', after list_pins), or all: true for 'clear my pins'.",
      { pin_id: z.string().optional(), item_id: z.string().optional(), all: z.boolean().optional() },
      async ({ pin_id, item_id, all }) => {
        if (ctx.turn.bot) {
          const pins = listPins().filter((p) => p.items.every((it) => mayUseItem(ctx.turn, it)));
          if (all) return json({ unpinned: pins.reduce((n, p) => n + Number(unpin(p.id)), 0) });
          if (pin_id && !pins.some((p) => p.id === pin_id)) return err("That pin is not available to this bot. Ask the owner to hand it over.");
          const it = getItem(item_id ?? screenOf(ctx.turn).itemId ?? "");
          if (it) { const refusal = itemAccess(ctx.turn, it); if (refusal) return err(refusal); }
        }
        if (all) return json({ unpinned: clearPins() });
        if (pin_id) return unpin(pin_id) ? json({ unpinned: 1 }) : err("No pin with that id. Call list_pins.");
        const id = item_id ?? screenOf(ctx.turn).itemId;
        if (!id) return err("Nothing is on their screen; say which pin (list_pins).");
        const n = unpinItem(id);
        return n ? json({ unpinned: n }) : err("That isn't pinned.");
      },
    ),
    tool(
      "list_pins",
      "'What have I got pinned?': the pins on their phone's home screen, in the order they pinned them, with how long " +
        "each has been there and whether it's just for today.",
      {},
      async () => json({ pins: listPins().filter((p) => p.items.every((it) => mayUseItem(ctx.turn, it))).map(pinInfo) }),
    ),
    tool(
      "siri_setup",
      "Setting up Siri on their iPhone (\"Tell <name>\" to ask by voice, \"Open <name>\" to open the app talking), the " +
        "Action Button, \"Send to <name>\" on the Share button, using it in the car, or taking it off: that part of the Siri " +
        "guide, with your name in it, and whether their phone has a key yet. Walk them through it a step or two at a time, " +
        "waiting for them; show: true puts that part on their screen. A key is only ever made on the PC (Settings, Siri on " +
        "your iPhone) and shown there once; you never see, say or ask for one. Nothing has been tried on a real iPhone yet: " +
        "if a step doesn't match their screen, ask what they see.",
      { part: z.enum(["all", "before", "name", "tell", "open", "action", "share", "car", "remove", "trouble"]).optional(), show: z.boolean().optional() },
      async ({ part, show }) => {
        const g = siriGuide(part ?? "all");
        if ("error" in g) return err(g.error);
        if (show) publishItem(createItem(ctx.turn, { kind: "note", title: g.title, source: "Siri guide (docs/v2/SIRI.md)", payload: { rows: [], text: g.text.slice(0, 4000) } }), ctx.turn);
        return json({ ...g, keys: listShortcuts().map((k) => ({ phone: k.name, made: k.made_at.slice(0, 10), used: k.last_used ? "yes" : "not yet" })), on_screen: show ? "that part of the guide" : "nothing" });
      },
    ),
    tool(
      "whats_new",
      "'What's new?', 'what's changed lately?', 'what can you do now that you couldn't before?', 'were you updated?': " +
        "what has changed in you (the assistant and its apps), newest first, from the list that is added to every time " +
        "something goes live. days: how many of the latest dated entries to give (default 1; 'this week' is about 5; " +
        "all: true for everything). Say the two or three that matter most in a sentence each, not the whole list; " +
        "show: true puts the list on their screen. Only say what the list says: if they ask about a change that isn't " +
        "in it, say you've no record of it. Entries marked not yet tried on the phone are untested there; say so if asked.",
      { days: z.number().int().min(1).max(60).optional(), all: z.boolean().optional(), show: z.boolean().optional() },
      async ({ days, all, show }) => {
        const w = whatsNew(all ? 1000 : (days ?? 1));
        if ("error" in w) return err(w.error);
        if (show) publishItem(createItem(ctx.turn, { kind: "note", title: w.entries.length === 1 ? `What's new: ${w.entries[0].date}` : "What's new", source: "What's new (docs/v2/CHANGELOG.md)", payload: { rows: [], text: w.text.slice(0, 6000) } }), ctx.turn);
        return json({ ...w, on_screen: show ? "the list" : "nothing" });
      },
    ),
  ], ["show_page", "save_page", "show_list", "show_table", "show_note", "show_sketch", "open_sketch_pad", "show_again", "show_card_again", "list_shown", "point_at", "list_pins", "siri_setup", "whats_new"]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PARTS: Record<string, RegExp> = { before: /^What you need first/, name: /^Pick a name/, tell: /^1\./, open: /^2\./, action: /^3\./, share: /^4\./, car: /^5\./, remove: /^6\./, trouble: /^If something/ };

/**
 * A part of the owner's Siri guide (docs/v2/SIRI.md) in plain text, with the assistant's own name where the guide says
 * "Mate", and a word on whether that name will work well for Siri.
 */
export function siriGuide(part: string): { title: string; text: string; name: string; shortcut_names: string[]; name_note?: string } | { error: string } {
  let md: string;
  try {
    md = readFileSync(path.join(ROOT, "docs", "v2", "SIRI.md"), "utf8");
  } catch {
    return { error: "The Siri guide isn't here (docs/v2/SIRI.md)." };
  }
  const own = assistantName();
  const name = own?.trim() || "Tavi";
  const sections = md.split(/\n(?=## )/).slice(1);
  const pick = part === "all" ? sections : sections.filter((s) => PARTS[part]?.test(s.slice(3)));
  if (!pick.length) return { error: `No part "${part}" in the guide.` };
  const plain = pick
    .join("\n")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^## /gm, "")
    .replace(/\bMate\b/g, name)
    .trim();
  const letters = name.replace(/[^a-z]/gi, "").length;
  const name_note = !own
    ? "They haven't named you yet: the Shortcuts can be \"Tell Tavi\" and \"Open Tavi\", or they can name you first."
    : letters <= 3 || /siri|hey/i.test(name)
      ? `"${name}" is short or close to Siri's own words; Siri may mishear it. Suggest a longer Shortcut name, like "Tell ${name} Mate" or "Ask Tavi".`
      : undefined;
  return { title: part === "all" ? "Siri: setting it up" : `Siri: ${pick[0].slice(3).split("\n")[0].replace(/\bMate\b/g, name)}`, text: plain, name, shortcut_names: [`Tell ${name}`, `Open ${name}`, `Send to ${name}`], ...(name_note ? { name_note } : {}) };
}

/**
 * The latest dated entries of the owner's "What's new" list (docs/v2/CHANGELOG.md, newest first: a "## <date>" heading,
 * then "- **Name.** what changed" lines), in plain text. An entry is added at every switch-over (TASKS.md section 7).
 */
export function whatsNew(days: number, file = path.join(ROOT, "docs", "v2", "CHANGELOG.md")): { entries: { date: string; changes: { name: string; what: string }[] }[]; text: string; older: number } | { error: string } {
  let md: string;
  try {
    md = readFileSync(file, "utf8");
  } catch {
    return { error: "The list of changes isn't here (docs/v2/CHANGELOG.md)." };
  }
  const sections = md.split(/\r?\n(?=## )/).slice(1);
  if (!sections.length) return { error: "The list of changes is empty." };
  const all = sections.map((s) => {
    const [head, ...rest] = s.split(/\r?\n/);
    const changes = rest
      .join("\n")
      .split(/\n(?=- )/)
      .map((c) => c.trim())
      .filter((c) => c.startsWith("- "))
      .map((c) => {
        const m = /^- \*\*(.+?)\*\*\s*([\s\S]*)$/.exec(c);
        const tidy = (t: string) => t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
        return m ? { name: tidy(m[1]).replace(/\.$/, ""), what: tidy(m[2]) } : { name: "", what: tidy(c.slice(2)) };
      });
    return { date: head.slice(3).trim(), changes };
  });
  const entries = all.slice(0, Math.max(1, days));
  const text = entries.map((e) => `${e.date}\n${e.changes.map((c) => `- ${c.name ? `${c.name}. ` : ""}${c.what}`).join("\n")}`).join("\n\n");
  return { entries, text, older: all.length - entries.length };
}

export const makeShowServer = (ctx: TurnCtx) => createSdkMcpServer({ name: "show", version: "0.1.0", alwaysLoad: true, tools: showTools(ctx) });
