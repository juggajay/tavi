// Pictures of reference book pages (Stage 8.2): for the brain to read (read_reference) and for the owner's screen
// (show_reference, the zoomable viewer). Rendered once by the engine from the book in place and kept in a cache under
// the data folder (data/reference/pages); the book is only ever read. Same tile scheme as drawing sheets (drawings/tiles.ts).
import { createHash } from "node:crypto";
import path from "node:path";
import { pageSize } from "../drawings/engine.js";
import { maxZoom, renderOnce, TILE_PX } from "../drawings/tiles.js";
import type { Box } from "../shared/protocol.js";
import { REF_CACHE } from "./dir.js";
import { getBook, type Book } from "./library.js";
import { isTextRef, leftOut } from "./design.js";

export const REF_PAGES = path.join(REF_CACHE, "pages");
/** Widths a page picture comes in: 1024 and 2048 for the screen, 1568 for the brain to read. */
export const REF_WIDTHS = [1024, 1568, 2048] as const;
export type RefWidth = (typeof REF_WIDTHS)[number];

const sizes = new Map<string, { w: number; h: number }>();

/** A ready book by id (ids come from URLs, so only an exact match), with page n inside it. */
export function bookPage(id: string, page: number): Book | null {
  if (!/^ref_[a-f0-9]{12}$/.test(id) || !Number.isInteger(page) || page < 1) return null;
  const b = getBook(id);
  // a design reference read by section has no page to draw, and a page its manifest leaves out is never drawn (20.1)
  if (b && b.kind === "design" && (isTextRef(b.path) || leftOut(b, page))) return null;
  return b && b.state === "ready" && page <= b.pages ? b : null;
}

/** The page's size in points (asked once of the engine, then remembered). */
export async function dims(b: Book, page: number) {
  const key = `${b.id}:${page}:${b.mtime}`;
  let d = sizes.get(key);
  if (!d) {
    d = await pageSize(b.path, page - 1);
    sizes.set(key, d);
  }
  return d;
}

/** What the viewer needs: the page's shape and how far its tiles go. */
export async function refInfo(b: Book, page: number) {
  const d = await dims(b, page);
  return { book_id: b.id, page, aspect: d.w / d.h, max_z: maxZoom({ width_pt: d.w }) };
}

const dir = (b: Book, page: number) => path.join(REF_PAGES, b.id, `p${page}`);

export const refPageImage = (b: Book, page: number, width: RefWidth) => renderOnce(path.join(dir(b, page), `page-${width}.png`), b.path, page - 1, [0, 0, 1, 1], width);

/** Part of a page at the brain's reading width, for a dense table that's hard to read in the whole page. */
export function refCrop(b: Book, page: number, box: Box) {
  const clean = box.map((v) => Math.min(1, Math.max(0, v))) as Box;
  const key = createHash("sha256").update(clean.map((v) => v.toFixed(4)).join(",")).digest("hex").slice(0, 12);
  return renderOnce(path.join(dir(b, page), `crop-${key}.png`), b.path, page - 1, clean, 1568);
}

/** Null when the tile doesn't exist (out of range, or finer than 600 dpi). */
export async function refTile(b: Book, page: number, z: number, x: number, y: number) {
  const n = 2 ** z;
  const d = await dims(b, page);
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || z > maxZoom({ width_pt: d.w }) || x < 0 || y < 0 || x >= n || y >= n) return null;
  return renderOnce(path.join(dir(b, page), `t-${z}-${x}-${y}.png`), b.path, page - 1, [x / n, y / n, (x + 1) / n, (y + 1) / n], TILE_PX);
}

/** Get a page ready to open (its small picture). Never throws. */
export async function warmRef(id: string, page: number) {
  const b = bookPage(id, page);
  if (!b) return;
  await refPageImage(b, page, 1024).catch((err) => console.warn("[reference] warm failed:", err instanceof Error ? err.message : err));
}
