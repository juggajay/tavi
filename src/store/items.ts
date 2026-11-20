import { PAGE } from "../shared/pages/shape.js";
// Items: everything the assistant shows on the phone and desktop (v2). A drawing sheet opened at the right spot, a list
// whose rows open sheets, a table, a draft waiting for the owner's OK, a note, a picture. Every item is kept so it can
// be brought back ("show me that again", "what have you shown me today"); pinned ones (in a pin on the phone's home
// screen, store/pins.ts; "keep that handy" makes one) are never trimmed. Items a turn makes share its job_id and are ordered by seq: on the phone they are pages to swipe between.
import { z } from "zod";
import { db, newId, nowIso } from "./db.js";
import { bus } from "../events.js";
import { getSettings } from "./settings.js";
import { localDay } from "../time.js";
import type { TurnInfo } from "../brain/turn.js";
import type { Item, ItemKind } from "../shared/protocol.js";
import { SKETCH } from "./sketch.js";
import { MODEL } from "./model.js";
import { SHOPDRAWING } from "./shopdrawings.js";
import { itemBot, makerForJob, rememberMaker } from "../hq/ownership.js";

const KEEP = 500;

const box = z.tuple([z.number(), z.number(), z.number(), z.number()]).transform((b) => b.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number, number]);
const row = z.object({ label: z.string().max(200), value: z.string().max(2000) });
// Pictures only from this gateway's own routes.
const ownSrc = z.string().regex(/^\/api\/(drawings\/crop|browser\/shot|sheets|files)\/[\w./-]+$/);

const PAYLOADS: Record<ItemKind, z.ZodType> = {
  page: PAGE,
  sheet: z.object({
    sheet_id: z.string(),
    sheet_no: z.string().nullable(),
    title: z.string().nullable(),
    revision: z.string().nullable(),
    status: z.string(),
    project: z.string(),
    aspect: z.number().positive(),
    marks: z.array(z.object({ box, label: z.string().max(80).optional() })).max(12),
    view: box,
  }),
  list: z.object({
    heading: z.string().max(200),
    sub: z.string().max(300).optional(),
    columns: z.array(z.string().max(60)).max(12).optional(),
    rows: z
      .array(
        z.object({
          id: z.string().max(80),
          cells: z.array(z.string().max(500)).max(12),
          target: z
            .union([
              z.object({ type: z.literal("sheet"), sheet_id: z.string(), box, label: z.string().max(80) }),
              z.object({ type: z.literal("item"), item_id: z.string() }),
            ])
            .optional(),
          url: z.string().max(1000).regex(/^https?:\/\//i).optional(),
        }),
      )
      .max(500),
  }),
  table: z.object({
    columns: z.array(z.string().max(80)).max(12),
    rows: z.array(z.array(z.string().max(500)).max(12)).max(200),
    highlight: z.array(z.object({ row: z.number().int(), col: z.number().int() })).max(200).optional(),
    note: z.string().max(500).optional(),
  }),
  draft: z.object({
    approval_id: z.string(),
    operation: z.string(),
    account: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    summary: z.string(),
    details: z.array(row).max(60),
    image: ownSrc.optional(),
    editable: z.boolean(),
    status: z.enum(["pending", "sent", "done", "declined", "expired", "failed"]),
    outcome_message: z.string().optional(),
  }),
  note: z.object({ rows: z.array(row).max(60), text: z.string().max(4000).optional() }),
  image: z.object({ src: ownSrc, w: z.number().positive(), h: z.number().positive(), alt: z.string().max(300) }),
  legacy: z.object({ images: z.array(z.object({ src: z.string(), caption: z.string().optional(), source: z.string().optional() })), rows: z.array(row) }),
  doc: z.object({ file_id: z.string(), name: z.string(), part_label: z.string(), text: z.string().max(200_000), more: z.boolean() }),
  sketch: SKETCH,
  model: MODEL,
  shopdrawing: SHOPDRAWING,
  reference: z.object({
    book_id: z.string().regex(/^ref_[a-f0-9]{12}$/),
    page: z.number().int().min(1),
    printed: z.string().max(20).nullable(),
    aspect: z.number().positive(),
    marks: z.array(z.object({ box, label: z.string().max(80).optional() })).max(12),
    view: box,
  }),
};

type DbRow = { id: string; kind: ItemKind; title: string; source: string; payload_json: string; origin: Item["origin"]; job_id: string | null; seq: number; created_at: string; shown_at: string; pinned_at: string | null };

const fromRow = (r: DbRow): Item => {
  const { _meta, ...payload } = JSON.parse(r.payload_json);
  const item = { id: r.id, kind: r.kind, title: r.title, source: r.source, payload, origin: r.origin, job_id: r.job_id, seq: r.seq, created_at: r.created_at, shown_at: r.shown_at, pinned: !!r.pinned_at } as Item;
  if (_meta && "made_by_bot" in _meta) rememberMaker(item, _meta.made_by_bot);
  return item;
};

function storedPayload(item: Item) {
  const bot = itemBot(item);
  return JSON.stringify(bot ? { ...item.payload, _meta: { made_by_bot: bot } } : item.payload);
}

export type NewItem = { kind: ItemKind; title: string; source?: string; payload: unknown; origin?: Item["origin"] };

/** Validate and (unless the turn is a test) keep a new item. Throws with a plain reason if the payload is wrong. */
export function createItem(turn: TurnInfo | null, n: NewItem): Item {
  const parsed = PAYLOADS[n.kind]?.safeParse(n.payload);
  if (!parsed) throw new Error(`Unknown item kind: ${n.kind}`);
  if (!parsed.success) throw new Error(`Bad ${n.kind} item: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const at = nowIso();
  const item = {
    id: newId("itm"),
    kind: n.kind,
    title: (n.title || "Untitled").slice(0, 200),
    source: (n.source ?? "").slice(0, 300),
    payload: parsed.data,
    origin: n.origin ?? "answer",
    job_id: turn?.job_id ?? null,
    seq: turn ? turn.seq++ : 0,
    created_at: at,
    shown_at: at,
    pinned: false,
  } as Item;
  rememberMaker(item, turn?.bot ?? makerForJob(item.job_id));
  turn?.items.push(item.id);
  if (turn?.persist === false) keepTestItem(item);
  else {
    db.prepare("INSERT INTO items (id, kind, title, source, payload_json, origin, job_id, seq, created_at, shown_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      item.id,
      item.kind,
      item.title,
      item.source,
      storedPayload(item),
      item.origin,
      item.job_id,
      item.seq,
      at,
      at,
    );
    trim();
  }
  return item;
}

/**
 * An item checked like createItem but never kept (Stage 15.1: the file viewer's previews). id: what the apps call it,
 * never an itm_ id, so nothing mistakes a preview for something the assistant showed.
 */
export function previewItem(id: string, n: NewItem): Item {
  const parsed = PAYLOADS[n.kind]?.safeParse(n.payload);
  if (!parsed) throw new Error(`Unknown item kind: ${n.kind}`);
  if (!parsed.success) throw new Error(`Bad ${n.kind} item: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const at = nowIso();
  return { id, kind: n.kind, title: (n.title || "Untitled").slice(0, 200), source: (n.source ?? "").slice(0, 300), payload: parsed.data, origin: "answer", job_id: null, seq: 0, created_at: at, shown_at: at, pinned: false } as Item;
}

/**
 * Put an item in front of the owner: open on the screen of whoever asked, listed everywhere else (gateway decides).
 * replaces: a model it takes the place of (Stage 9.3); a screen showing that one swaps this in and keeps its view.
 */
export function publishItem(item: Item, turn: TurnInfo | null, open = true, v1 = true, replaces?: string) {
  const bot = itemBot(item);
  if (bot && turn?.persist !== false) db.prepare("UPDATE items SET payload_json = ? WHERE id = ?").run(storedPayload(item), item.id);
  bus.emit("item", { item, open, turn, v1, ...(replaces ? { replaces } : {}) });
}

/**
 * Items a test turn showed are never written to the database (Stage 0.5), but a later test turn may need the one on
 * screen ("make the tenon 10 longer", look at it, save it). They're kept here, in memory only, the newest 50.
 */
const testItems = new Map<string, Item>();
function keepTestItem(item: Item) {
  testItems.set(item.id, item);
  while (testItems.size > 50) testItems.delete(testItems.keys().next().value!);
}

export function getItem(id: string): Item | null {
  const r = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as DbRow | undefined;
  return r ? fromRow(r) : (testItems.get(id) ?? null);
}

/** Change an item (title, source or payload fields) and tell the apps. The payload patch is merged and re-validated. */
export function updateItem(id: string, patch: { title?: string; source?: string; payload?: Record<string, unknown> }): Item | null {
  const it = getItem(id);
  if (!it) return null;
  const payload = patch.payload ? PAYLOADS[it.kind].parse({ ...(it.payload as object), ...patch.payload }) : it.payload;
  const next = { ...it, title: patch.title ?? it.title, source: patch.source ?? it.source, payload } as Item;
  rememberMaker(next, itemBot(it));
  db.prepare("UPDATE items SET title = ?, source = ?, payload_json = ? WHERE id = ?").run(next.title, next.source, storedPayload(next), id);
  bus.emit("item_update", { id, patch: { title: next.title, source: next.source, payload: next.payload } as Partial<Item> });
  return next;
}

/** Brought back up: moves to the top of "recent". */
export function touchItem(id: string): Item | null {
  db.prepare("UPDATE items SET shown_at = ? WHERE id = ?").run(nowIso(), id);
  return getItem(id);
}

export function pinItem(id: string, on: boolean): Item | null {
  db.prepare("UPDATE items SET pinned_at = ? WHERE id = ?").run(on ? nowIso() : null, id);
  const it = getItem(id);
  if (it) bus.emit("item_update", { id, patch: { pinned: on } });
  return it;
}

/** Marked pinned or not (store/pins.ts keeps this in step with the pins); the apps are told only when it changes. */
export function setPinnedFlag(id: string, on: boolean) {
  const r = db.prepare("SELECT pinned_at FROM items WHERE id = ?").get(id) as { pinned_at: string | null } | undefined;
  if (!r || !!r.pinned_at === on) return;
  db.prepare("UPDATE items SET pinned_at = ? WHERE id = ?").run(on ? nowIso() : null, id);
  bus.emit("item_update", { id, patch: { pinned: on } });
}

export const itemsForJob = (jobId: string) => (db.prepare("SELECT * FROM items WHERE job_id = ? ORDER BY seq").all(jobId) as DbRow[]).map(fromRow);

export const recentItems = (limit = 50) => (db.prepare("SELECT * FROM items ORDER BY shown_at DESC LIMIT ?").all(limit) as DbRow[]).map(fromRow);

/** "What have you shown me today": pinned first, then today's (in the owner's time zone), newest first. */
export function shownToday(now = new Date(), tz = getSettings()["time.zone"]): Item[] {
  const day = localDay(now, tz);
  const rows = db.prepare("SELECT * FROM items WHERE pinned_at IS NOT NULL OR shown_at >= ? ORDER BY shown_at DESC").all(new Date(now.getTime() - 36 * 3600_000).toISOString()) as DbRow[];
  const items = rows.map(fromRow).filter((i) => !(i.kind === "list" && i.title === "Shown today")); // not a thing it showed you
  const today = items.filter((i) => !i.pinned && localDay(new Date(i.shown_at), tz) === day);
  return [...items.filter((i) => i.pinned), ...today];
}

/** Items matching the words (title, source, and the text inside), best match first; no words means the latest. */
export function findItems(query = "", limit = 5): Item[] {
  const words = query.toLowerCase().split(/[^a-z0-9.-]+/).filter((w) => w.length > 1);
  const all = recentItems(KEEP);
  if (!words.length) return all.slice(0, limit);
  // A word in the title counts most, then the source, then anywhere inside; newer wins a tie.
  const score = (i: Item, n: number) => {
    const title = i.title.toLowerCase();
    const source = i.source.toLowerCase();
    const body = JSON.stringify(i.payload).toLowerCase();
    return words.reduce((t, w) => t + (title.includes(w) ? 3000 : source.includes(w) ? 2000 : body.includes(w) ? 1000 : 0), 0) - n;
  };
  return all
    .map((i, n) => ({ i, score: score(i, n) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.i);
}

/** Keep every pinned item and the newest 500 others. */
function trim() {
  db.prepare(`DELETE FROM items WHERE pinned_at IS NULL AND id NOT IN (SELECT id FROM items WHERE pinned_at IS NULL ORDER BY shown_at DESC LIMIT ${KEEP})`).run();
}
