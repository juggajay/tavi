// Whole sheets for the zoomable viewer (DESIGN §5): a page image to show at once, then sharp tiles for whatever part
// is in view. Zoom level z splits the page into 2^z × 2^z cells; tile (z, x, y) covers the page-fraction box
// [x/2^z, y/2^z, (x+1)/2^z, (y+1)/2^z] and is TILE_PX wide. Rendered once, kept on disk, served with long cache times.
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { DRAWINGS_DIR, findSheet, type Sheet } from "./library.js";
import { DATA_DIR, db } from "../store/db.js";
import { render } from "./engine.js";
import type { Box } from "../shared/protocol.js";

export const TILE_PX = 768;
export const PAGE_WIDTHS = [1024, 2048, 4096] as const;
const MAX_DPI = 600;
const CACHE = path.join(DRAWINGS_DIR, ".cache");
const CROPS = path.join(DRAWINGS_DIR, ".crops");
const REF_PAGES = path.join(DATA_DIR, "reference", "pages"); // reference book pages (reference/pages.ts), same rules

type SheetDims = Sheet & { width_pt: number; height_pt: number };

/** A sheet by id with its page size, or null. Ids come from the URL, so only an exact database match counts. */
export function sheetById(id: string): SheetDims | null {
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  const s = findSheet(id) as SheetDims | undefined;
  return s && s.id === id && s.path && s.width_pt > 0 && s.height_pt > 0 ? s : null;
}

/** The deepest zoom level whose tiles stay within 600 dpi (at most 5). */
export function maxZoom(s: { width_pt: number }) {
  const cells = ((MAX_DPI / 72) * s.width_pt) / TILE_PX; // tiles across at the 600 dpi limit
  return Math.max(0, Math.min(5, Math.floor(Math.log2(cells))));
}

export function sheetInfo(s: SheetDims) {
  return { sheet_id: s.id, sheet_no: s.sheet_no, title: s.title, revision: s.revision, status: s.status, project: s.project, aspect: s.width_pt / s.height_pt, max_z: maxZoom(s) };
}

const inFlight = new Map<string, Promise<string>>();

/** Render once into the cache (temp file, then rename); concurrent requests for the same file share one render. */
function cached(s: SheetDims, name: string, box: Box, width: number): Promise<string> {
  return renderOnce(path.join(CACHE, s.id, name), s.path!, s.page, box, width);
}

/** Render a region of a PDF page (page from 0) into file once; kept on disk and reused. Also used for reference book pages. */
export function renderOnce(file: string, pdf: string, page: number, box: Box, width: number): Promise<string> {
  const known = inFlight.get(file);
  if (known) return known;
  const job = (async () => {
    if (existsSync(file)) {
      const now = new Date();
      await utimes(file, now, now).catch(() => undefined); // the janitor keeps what's still being looked at
      return file;
    }
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await render(pdf, page, box, tmp, width);
    await rename(tmp, file);
    return file;
  })().finally(() => inFlight.delete(file));
  inFlight.set(file, job);
  return job;
}

export function pageImage(s: SheetDims, width: (typeof PAGE_WIDTHS)[number]) {
  return cached(s, `page-${width}.png`, [0, 0, 1, 1], width);
}

/** Null when the tile doesn't exist (out of range, or finer than 600 dpi). */
export function tile(s: SheetDims, z: number, x: number, y: number) {
  const n = 2 ** z;
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || z > maxZoom(s) || x < 0 || y < 0 || x >= n || y >= n) return null;
  return cached(s, `t-${z}-${x}-${y}.png`, [x / n, y / n, (x + 1) / n, (y + 1) / n], TILE_PX);
}

/** The tiles a phone opening this view would ask for first: the zoom level that's sharp on a ~1170 px wide screen. */
export function tilesFor(s: SheetDims, view: Box, screenPx = 1170) {
  const vw = Math.max(1e-3, view[2] - view[0]);
  const z = Math.max(0, Math.min(maxZoom(s), Math.ceil(Math.log2(screenPx / vw / TILE_PX))));
  const n = 2 ** z;
  const out: [number, number, number][] = [];
  for (let x = Math.floor(view[0] * n); x <= Math.min(n - 1, Math.floor(view[2] * n)); x++)
    for (let y = Math.floor(view[1] * n); y <= Math.min(n - 1, Math.floor(view[3] * n)); y++) out.push([z, x, y]);
  return out.slice(0, 16);
}

/** Get a sheet ready to open: the small page image and the first tiles. Never throws. */
export async function warm(sheetId: string, view: Box) {
  const s = sheetById(sheetId);
  if (!s) return;
  try {
    await pageImage(s, 1024);
    await Promise.all(tilesFor(s, view).map(([z, x, y]) => tile(s, z, x, y)));
  } catch (err) {
    console.warn("[tiles] warm failed:", err instanceof Error ? err.message : err);
  }
}

/* ---------------- janitor ---------------- */
const DAY = 86_400_000;

async function filesUnder(dir: string): Promise<{ p: string; size: number; mtime: number }[]> {
  const out: { p: string; size: number; mtime: number }[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = path.join(dir, n);
    const st = await stat(p).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push({ p, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

/** Drop cache files unused for 14 days, keep the cache under 2 GB, and delete old crops nothing refers to any more. */
export async function cleanCaches(now = Date.now(), maxBytes = 2 * 1024 ** 3) {
  let removed = 0;
  const files = [...(await filesUnder(CACHE)), ...(await filesUnder(REF_PAGES))].sort((a, b) => a.mtime - b.mtime);
  let total = files.reduce((t, f) => t + f.size, 0);
  for (const f of files) {
    if (now - f.mtime > 14 * DAY || total > maxBytes) {
      await rm(f.p, { force: true });
      total -= f.size;
      removed++;
    }
  }
  const used = new Set<string>();
  for (const r of db.prepare("SELECT images_json AS t FROM cards UNION ALL SELECT payload_json FROM items").all() as { t: string }[])
    for (const m of r.t.matchAll(/crop_[a-f0-9]{16}/g)) used.add(m[0]);
  for (const f of await filesUnder(CROPS)) {
    const id = path.basename(f.p, ".png");
    if (now - f.mtime > 30 * DAY && !used.has(id)) {
      await rm(f.p, { force: true });
      removed++;
    }
  }
  return removed;
}

export function startCacheJanitor() {
  const run = () => void cleanCaches().catch((err) => console.warn("[tiles] clean-up:", err instanceof Error ? err.message : err));
  setTimeout(run, 90_000).unref();
  setInterval(run, DAY).unref();
}
