// Pins (Stage 13.2): up to five things the owner keeps on his phone's home screen, under Pebble, to open with one tap.
// A pin points at an item and the pages it was opened with (a set of sheets he swipes between), and remembers where he
// left it: which page, the zoom and the place, or a 3D model's camera. "For today" pins clear themselves at his
// midnight. Pins are his: they're only made or taken away when he asks (the pin button, press-and-hold, or saying so).
// Items in a pin are marked pinned (items.pinned_at), so they're never trimmed and "Shown today" lists them first.
// A set of shop drawings (Stage 12) is one item that opens as a page per sheet: its pin keeps the item once, and which
// sheet he left it on beside the zoom and place (view_json's sheet).
import { db, newId, nowIso } from "./db.js";
import { bus } from "../events.js";
import { getItem, setPinnedFlag } from "./items.js";
import { nextLocalMidnight } from "../time.js";
import { getSetting, setSetting } from "./proactive.js";
import type { CamPlace, Item, Pin, ViewPlace } from "../shared/protocol.js";

export const MAX_PINS = 5;
type Row = { id: string; item_ids: string; idx: number; view_json: string | null; pinned_at: string; until: string | null };
type Place = { view?: ViewPlace | null; camera?: CamPlace | null; sheet?: number | null };

/** A short name for the row under Pebble: a sheet's number, a book page's table ("Table 29"), otherwise its title. */
export function pinLabel(it: Item): string {
  const table = it.kind === "reference" ? /\b(?:Table|Figure|Clause|Section)\s+[\w.]+/i.exec(it.source)?.[0] : undefined;
  const s = it.kind === "sheet" ? (it.payload.sheet_no ?? it.payload.title ?? it.title) : table ? table : it.kind === "doc" ? it.payload.name : it.title;
  const t = (s || it.kind).trim();
  return t.length > 28 ? `${t.slice(0, 27).trimEnd()}…` : t;
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
/** Only the shapes the apps send; anything else is dropped rather than kept. */
function cleanPlace(p: Place): Place {
  const v = p.view;
  const c = p.camera;
  const vec = (a: unknown) => Array.isArray(a) && a.length === 3 && a.every(num);
  return {
    view: v && num(v.s) && num(v.cx) && num(v.cy) && v.s > 0 && v.s < 1000 ? { s: v.s, cx: v.cx, cy: v.cy } : null,
    camera: c && vec(c.pos) && vec(c.target) ? { pos: [c.pos[0], c.pos[1], c.pos[2]], target: [c.target[0], c.target[1], c.target[2]] } : null,
    ...(Number.isInteger(p.sheet) && p.sheet! >= 1 && p.sheet! <= 99 ? { sheet: p.sheet } : {}),
  };
}
/** The sheet a pin on this item is left on: a set of shop drawings only, within its sheets. */
const sheetFor = (it: Item, sheet: number | null | undefined) => (it.kind === "shopdrawing" ? Math.min(Math.max(1, sheet ?? 1), it.payload.sheets.length || 1) : undefined);

/** A row as the apps get it, with its items. Items that have gone are left out; null when none are left. */
function load(r: Row): Pin | null {
  let ids: string[] = [];
  try {
    ids = (JSON.parse(r.item_ids) as unknown[]).filter((x): x is string => typeof x === "string");
  } catch {}
  const at = ids[r.idx] ?? ids[0];
  const items = ids.map((id) => getItem(id)).filter((i): i is Item => !!i);
  if (!items.length) return null;
  const idx = Math.max(0, items.findIndex((i) => i.id === at));
  let place: Place = {};
  try {
    place = r.view_json ? (JSON.parse(r.view_json) as Place) : {};
  } catch {}
  const sheet = sheetFor(items[idx], place.sheet);
  return { id: r.id, item_ids: items.map((i) => i.id), items, idx, view: place.view ?? null, camera: place.camera ?? null, ...(sheet ? { sheet } : {}), label: pinLabel(items[idx]), pinned_at: r.pinned_at, until: r.until };
}

const rows = () => db.prepare("SELECT id, item_ids, idx, view_json, pinned_at, until FROM pins ORDER BY pinned_at, id").all() as Row[];

/** Tell the apps, and mark exactly the items in a pin as pinned. */
function changed(touched: string[] = []) {
  const inPins = new Set(rows().flatMap((r) => JSON.parse(r.item_ids) as string[]));
  const marked = (db.prepare("SELECT id FROM items WHERE pinned_at IS NOT NULL").all() as { id: string }[]).map((r) => r.id);
  for (const id of new Set([...touched, ...marked, ...inPins])) setPinnedFlag(id, inPins.has(id));
  bus.emit("pins", listPins());
}

/**
 * Every pin, oldest first (the row reads left to right in the order he pinned them). "For today" pins past his
 * midnight are cleared, and a pin whose items have all been deleted is dropped quietly (one that lost some pages keeps
 * the rest).
 */
export function listPins(now = new Date()): Pin[] {
  expirePins(now, false);
  const out: Pin[] = [];
  for (const r of rows()) {
    const p = load(r);
    if (!p) db.prepare("DELETE FROM pins WHERE id = ?").run(r.id);
    else {
      if (p.item_ids.length !== (JSON.parse(r.item_ids) as string[]).length) db.prepare("UPDATE pins SET item_ids = ?, idx = ? WHERE id = ?").run(JSON.stringify(p.item_ids), p.idx, r.id);
      out.push(p);
    }
  }
  return out;
}

export const getPin = (id: string) => listPins().find((p) => p.id === id) ?? null;

export type PinRequest = { item_ids: string[]; idx?: number; for_today?: boolean; replace?: string } & Place;
export type PinResult = { pin: Pin; already: boolean } | { full: true; pins: Pin[] } | { error: string };

/**
 * Pin an item and the pages it was opened with, open at idx. Asking again for something already pinned (any page of
 * its set) updates that pin instead of taking another place. A sixth asks which to drop: { full } until he says
 * (replace: the pin to take its place).
 */
export function addPin(req: PinRequest, now = new Date()): PinResult {
  const given = req.item_ids.filter((x) => typeof x === "string");
  const ids = [...new Set(given)].slice(0, 20);
  const items = ids.map((id) => getItem(id)).filter((i): i is Item => !!i);
  if (!items.length) return { error: "That isn't something I've shown, so it can't be pinned." };
  // idx counts the pages as given: the page it's on is found by its id, so a repeated or missing page doesn't move it
  const anchor = given[Math.min(given.length - 1, Math.max(0, req.idx ?? 0))];
  const at = items.find((i) => i.id === anchor) ?? items[Math.min(items.length - 1, Math.max(0, req.idx ?? 0))] ?? items[0];
  const idx = items.indexOf(at);
  const until = req.for_today ? nextLocalMidnight(now) : null;
  const place = JSON.stringify(cleanPlace(req));
  const pins = listPins(now);
  const same = pins.find((p) => p.item_ids.includes(at.id));
  if (same) {
    db.prepare("UPDATE pins SET item_ids = ?, idx = ?, view_json = ?, until = ? WHERE id = ?").run(JSON.stringify(items.map((i) => i.id)), idx, place, until, same.id);
    changed(items.map((i) => i.id));
    return { pin: getPin(same.id)!, already: true };
  }
  if (req.replace && pins.some((p) => p.id === req.replace)) {
    const old = pins.find((p) => p.id === req.replace)!;
    db.prepare("DELETE FROM pins WHERE id = ?").run(old.id);
    return addPinned(items, idx, place, until, now, old.item_ids);
  }
  if (pins.length >= MAX_PINS) return { full: true, pins };
  return addPinned(items, idx, place, until, now, []);
}
function addPinned(items: Item[], idx: number, place: string, until: string | null, now: Date, touched: string[]): PinResult {
  const id = newId("pin");
  const at = now.toISOString();
  db.prepare("INSERT INTO pins (id, item_ids, idx, view_json, pinned_at, until, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, JSON.stringify(items.map((i) => i.id)), idx, place, at, until, at);
  changed([...touched, ...items.map((i) => i.id)]);
  return { pin: getPin(id)!, already: false };
}

/** Where he left it, when he leaves the viewer: the page, and the zoom and place (or a model's camera). */
export function setPinPlace(id: string, p: { idx?: number } & Place): Pin | null {
  const r = db.prepare("SELECT id, item_ids, idx, view_json, pinned_at, until FROM pins WHERE id = ?").get(id) as Row | undefined;
  if (!r) return null;
  const n = (JSON.parse(r.item_ids) as string[]).length;
  const idx = Number.isInteger(p.idx) ? Math.max(0, Math.min(n - 1, p.idx!)) : r.idx;
  db.prepare("UPDATE pins SET idx = ?, view_json = ?, updated_at = ? WHERE id = ?").run(idx, JSON.stringify(cleanPlace(p)), nowIso(), id);
  bus.emit("pins", listPins());
  return getPin(id);
}

export function unpin(id: string): boolean {
  const r = db.prepare("SELECT item_ids FROM pins WHERE id = ?").get(id) as { item_ids: string } | undefined;
  if (!r) return false;
  db.prepare("DELETE FROM pins WHERE id = ?").run(id);
  changed(JSON.parse(r.item_ids) as string[]);
  return true;
}

/** Unpin whatever pin holds this item (as the anchor or any page of its set). How many went. */
export function unpinItem(itemId: string): number {
  const hit = rows().filter((r) => (JSON.parse(r.item_ids) as string[]).includes(itemId));
  for (const r of hit) db.prepare("DELETE FROM pins WHERE id = ?").run(r.id);
  if (hit.length) changed(hit.flatMap((r) => JSON.parse(r.item_ids) as string[]));
  return hit.length;
}

/** "Clear my pins". How many there were. */
export function clearPins(): number {
  const all = rows();
  if (!all.length) return 0;
  db.prepare("DELETE FROM pins").run();
  changed(all.flatMap((r) => JSON.parse(r.item_ids) as string[]));
  return all.length;
}

/** "For today" pins past their midnight go. Checked every 30 seconds by the gateway, and whenever pins are listed. */
export function expirePins(now = new Date(), announce = true): number {
  const gone = db.prepare("SELECT item_ids FROM pins WHERE until IS NOT NULL AND until <= ?").all(now.toISOString()) as { item_ids: string }[];
  if (!gone.length) return 0;
  db.prepare("DELETE FROM pins WHERE until IS NOT NULL AND until <= ?").run(now.toISOString());
  if (announce) changed(gone.flatMap((r) => JSON.parse(r.item_ids) as string[]));
  else for (const id of gone.flatMap((r) => JSON.parse(r.item_ids) as string[])) setPinnedFlag(id, isPinned(id));
  return gone.length;
}

const isPinned = (itemId: string) => rows().some((r) => (JSON.parse(r.item_ids) as string[]).includes(itemId));

/** Pins older than a week (the wrap-up may mention them once). */
export const oldPins = (now = new Date(), days = 7) => listPins(now).filter((p) => now.getTime() - new Date(p.pinned_at).getTime() > days * 86_400_000);

const TOLD = "pins_told"; // pins the wrap-up has mentioned as old, so it's said once
const toldIds = () => {
  try {
    return new Set(JSON.parse(getSetting(TOLD) || "[]") as string[]);
  } catch {
    return new Set<string>();
  }
};
/** For the end-of-day wrap: pins older than a week it hasn't mentioned yet, as a line for its Context ("" if none). */
export function oldPinsNote(now = new Date()): { text: string; ids: string[] } {
  const told = toldIds();
  const old = oldPins(now).filter((p) => !told.has(p.id));
  if (!old.length) return { text: "", ids: [] };
  const list = old.map((p) => `${p.label} (${Math.floor((now.getTime() - Date.parse(p.pinned_at)) / 86_400_000)} days)`).join(", ");
  return {
    text: `Pinned on their phone's home screen for over a week: ${list}. If you're sending the wrap anyway, you may say once, in a few words, that these are still pinned. Never unpin them yourself, and don't send a wrap just for this.`,
    ids: old.map((p) => p.id),
  };
}
/** The wrap went out with that line: it isn't said again for those pins. */
export function oldPinsTold(ids: string[]) {
  if (ids.length) setSetting(TOLD, JSON.stringify([...new Set([...toldIds(), ...ids])].slice(-50)));
}

/**
 * Pin what a screen shows: the page on it and the pages beside it, where it's looking. A set of shop drawings is in
 * the set once per sheet (the phone) or on its own (the desktop's pane); page_index says which sheet is up.
 */
export function pinScreen(screen: { item_id: string | null; set?: string[]; page_index?: number; view?: ViewPlace; camera?: CamPlace } | null, o: { for_today?: boolean; replace?: string } = {}): PinResult {
  if (!screen?.item_id) return { error: "Nothing is on the screen to pin." };
  const pages = screen.set?.length && screen.set.includes(screen.item_id) ? screen.set : [screen.item_id];
  const set = [...new Set(pages)];
  const it = getItem(screen.item_id);
  const sheet = it?.kind === "shopdrawing" ? sheetFor(it, (screen.page_index ?? 0) - pages.indexOf(screen.item_id) + 1) : undefined;
  return addPin({ item_ids: set, idx: set.indexOf(screen.item_id), view: screen.view ?? null, camera: screen.camera ?? null, ...(sheet ? { sheet } : {}), ...o });
}
