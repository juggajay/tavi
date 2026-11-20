// The shelf of reference books (Stage 8): the owner's own copies of standards and span tables in the reference folder
// (reference/dir.ts). Each PDF is read once into an index (ref_books, ref_toc, ref_pages, ref_fts) so the brain can look
// things up and quote the table and page. The books themselves are ONLY EVER READ: nothing here writes, moves or
// renames anything in the reference folder, and nothing from them is copied anywhere but this index and the page
// picture cache under the data folder.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { db, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { bus } from "../events.js";
import { referenceDir } from "./dir.js";
import { applyGuideMeta, guideSourceLine, isGuideShelf, SUPERSEDED } from "./guides.js";
import { decodeBook, designMetaFor, designSourceLine, isCodeShelf, isDesignShelf, isTextRef, leftOut, leftOutReason, parseHtmlBook, parseTextBook } from "./design.js";
import { DEV } from "../dev.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");
const ENGINE = path.join(ROOT, "drawings", "engine.py");
const NOTE_CHARS = 6000;
const BATCH = 200;

export type BookState = "waiting" | "reading" | "ready" | "failed";
export type Book = {
  id: string;
  path: string;
  name: string;
  title: string;
  shelf: string;
  pages: number;
  has_toc: number;
  size: number | null;
  mtime: number | null;
  hash: string | null;
  state: BookState;
  error: string | null;
  note: string | null;
  indexed_at: string | null;
  /** book: a standard or span tables; guide: a maker's guide (Stage 14.1, guides.ts); design: a design reference, and
   * code: the National Construction Code (Stage 20.1, design.ts) */
  kind: "book" | "guide" | "design" | "code";
  maker: string | null;
  product: string | null;
  doc_date: string | null;
  doc_version: string | null;
  source_url: string | null;
  fetched_at: string | null;
};

export const REASONS = {
  locked: "This copy is locked, so I can't read it.",
  empty: "There's no text in this copy, so I can't look things up in it.",
  unreadable: "I couldn't open this file.",
  stopped: "Reading it stopped part-way. Press Read again.",
  tools: "The reading tools are not installed on this PC yet, so I can't read documents. Run the set-up again to install them.",
};

const bookId = (p: string) => `ref_${createHash("sha256").update(path.resolve(p).toLowerCase()).digest("hex").slice(0, 12)}`;
export const getBook = (id: string) => db.prepare("SELECT * FROM ref_books WHERE id = ?").get(id) as Book | undefined;
export const listBooks = () => db.prepare("SELECT * FROM ref_books ORDER BY shelf, pages = 0, name").all() as Book[];

/* ---------------- the words both sides are compared in ---------------- */

const DROP = new Set(["the", "a", "an", "of", "for", "at", "in", "on", "to", "and", "or", "what", "which", "mm", "crs", "cts", "centres", "centers", "centre", "center", "cc", "c/c", "spacing", "spacings"]);

/**
 * One normaliser for queries and for what's searched, so these match: "MGP10" / "MGP 10", "N2" / "N1/N2", "f17" / "F17",
 * "450 crs" / "450 centres" / "450", "lower storey" / "lower-storey". Lower case; slashes, hyphens and punctuation are
 * spaces; a short grade or class code is joined to its number ("mgp 10" -> "mgp10"); centre words and "mm" go; a plain
 * plural loses its "s" ("studs" -> "stud").
 */
export function normalise(s: string): string[] {
  const t = s
    .toLowerCase()
    .replace(/�/g, " ")
    .replace(/\b(c\/c|c-c)\b/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\b(mgp|f|n|gl|ssp)\s+(\d{1,3})\b/g, "$1$2")
    .trim();
  return t
    .split(/\s+/)
    .filter((w) => w && !DROP.has(w))
    .map((w) => (w.length > 3 && /[a-z]s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w));
}

/* ---------------- headings and printed page numbers ---------------- */

const clean = (l: string) => l.replace(/�/g, " - ").replace(/\s+/g, " ").trim();
const isNumber = (l: string) => /^\d{1,4}$/.test(l) || /^[ivxlc]{1,7}$/i.test(l);
const isNoise = (l: string) => /^copyright$/i.test(l) || /^©|^\W? ?standards australia/i.test(l);

/** The printed page number (the first or last line, when it's just a number) and the page's heading lines. */
export function pageHeading(text: string): { printed: string | null; heading: string } {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  let printed: string | null = null;
  if (lines.length && isNumber(lines[0])) printed = lines[0];
  else if (lines.length && /^\d{1,4}$/.test(lines[lines.length - 1])) printed = lines[lines.length - 1];
  const body = lines.filter((l) => !isNoise(l) && !(l === printed));
  const parts: string[] = [];
  const add = (l: string | undefined) => l && !parts.includes(l) && parts.length < 6 && parts.push(l.slice(0, 120));
  // a running header at the foot of the page (a book line, a wind class and grade line) belongs at the top
  for (const l of body.slice(-3)) if (/^AS\s?\d|^wind classification/i.test(l)) add(l);
  for (const l of body.slice(0, 3)) if (/^AS\s?\d|^wind classification/i.test(l)) add(l);
  const t = body.slice(0, 15).findIndex((l) => /^(span\s+)?(table|figure)\s+[\w.]+(\s|$)/i.test(l));
  if (t >= 0) (add(body[t]), add(body[t + 1]));
  for (const l of body.slice(0, 5)) if (parts.length < 4) add(l);
  return { printed, heading: parts.join(" · ") };
}

/** "Table 29" from a page heading, whether the number sits on its own line or shares it with the title. */
export function tableOf(heading: string): string | null {
  const m = /(?:^|· )(?:span\s+)?table\s+([\w.]+)/i.exec(heading);
  return m ? `Table ${m[1]}` : null;
}

/* ---------------- scanning the shelf (read-only) ---------------- */

type Found = { path: string; size: number; mtime: number; shelf: string };

async function walk(root: string, dir = root, depth = 0, out: Found[] = []): Promise<Found[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n.startsWith(".") || n.startsWith("~$")) continue;
    const p = path.join(dir, n);
    const st = await stat(p).catch(() => null);
    if (!st) continue;
    // a maker's guides that a newer copy replaced (Guides\<Maker>\Superseded, 14.1) stay off the shelf
    if (st.isDirectory() && depth === 2 && n.toLowerCase() === SUPERSEDED.toLowerCase() && isGuideShelf(path.relative(root, dir).split(path.sep)[0])) continue;
    if (st.isDirectory() && depth < 3) await walk(root, p, depth + 1, out);
    else if (st.isFile() && /\.(pdf|md|txt|html?)$/i.test(n)) {
      const rel = path.relative(root, p).split(path.sep);
      const shelf = rel.length > 1 ? rel[0] : "";
      // an HTML book is only a design reference (Stage 20.1); anywhere else it isn't for the shelf
      if (/\.html?$/i.test(n) && !isDesignShelf(shelf)) continue;
      out.push({ path: p, size: st.size, mtime: Math.round(st.mtimeMs), shelf });
    }
  }
  return out;
}

const queue: string[] = [];
let running: Promise<void> | null = null;
let scanning: Promise<void> | null = null;

/** Look at the shelf ("Read again" also retries a book that failed): new or changed books are queued to read (one at a time, in the background); gone ones are forgotten. */
export function scanShelf(o: { retryFailed?: boolean } = {}): Promise<void> {
  scanning ??= scanOnce(!!o.retryFailed).finally(() => (scanning = null));
  return scanning;
}

async function scanOnce(retryFailed: boolean) {
  const dir = referenceDir();
  const found = existsSync(dir) ? await walk(dir) : [];
  const seen = new Set<string>();
  for (const f of found) {
    const id = bookId(f.path);
    seen.add(id);
    const name = path.basename(f.path);
    const known = getBook(id);
    // a text file a design source's manifest lists is a book read by section, not a shelf note (Stage 20.1)
    const designText = isDesignShelf(f.shelf) && (/\.html?$/i.test(name) || (/\.txt$/i.test(name) && designMetaFor(f.path).listed));
    if (/\.(md|txt)$/i.test(name) && !designText) {
      if (known && known.size === f.size && known.mtime === f.mtime) continue;
      const note = (await readFile(f.path, "utf8").catch(() => "")).slice(0, NOTE_CHARS);
      db.prepare("DELETE FROM ref_books WHERE id = ?").run(id);
      db.prepare("INSERT INTO ref_books (id, path, name, title, shelf, pages, size, mtime, state, note, indexed_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'ready', ?, ?)").run(
        id,
        f.path,
        name,
        name.replace(/\.(md|txt)$/i, ""),
        f.shelf,
        f.size,
        f.mtime,
        note,
        nowIso(),
      );
      continue;
    }
    const kind = isGuideShelf(f.shelf) ? "guide" : isDesignShelf(f.shelf) ? "design" : isCodeShelf(f.shelf) ? "code" : "book";
    // A guide read before guides were a kind of their own (the version before 14.1 shares the same folder) is marked
    // a guide here, without reading it again.
    if (known && known.kind !== kind) db.prepare("UPDATE ref_books SET kind = ? WHERE id = ?").run(kind, id);
    const unchanged = known && known.size === f.size && known.mtime === f.mtime && (known.state === "ready" || (known.state === "failed" && !retryFailed));
    if (unchanged) continue;
    if (!known) db.prepare("INSERT INTO ref_books (id, path, name, title, shelf, size, mtime, state, kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)").run(id, f.path, name, name.replace(/\.pdf$/i, ""), f.shelf, f.size, f.mtime, kind);
    else db.prepare("UPDATE ref_books SET size = ?, mtime = ?, shelf = ?, kind = ?, state = 'waiting', error = NULL WHERE id = ?").run(f.size, f.mtime, f.shelf, kind, id);
    if (!queue.includes(id)) queue.push(id);
  }
  for (const b of listBooks()) if (!seen.has(b.id)) forget(b.id);
  applyGuideMeta(); // a guide's maker, title and date come from the manifest beside it (14.1)
  applyDesignMeta(); // and a design reference's from its own (20.1)
  bus.emit("files", {});
  if (queue.length) void drain();
}

function forget(id: string) {
  db.prepare("DELETE FROM ref_fts WHERE book_id = ?").run(id);
  db.prepare("DELETE FROM ref_pages WHERE book_id = ?").run(id);
  db.prepare("DELETE FROM ref_toc WHERE book_id = ?").run(id);
  db.prepare("DELETE FROM ref_books WHERE id = ?").run(id);
  db.prepare("DELETE FROM guide_updates WHERE book_id = ?").run(id);
  tocCache.delete(id);
}

function drain(): Promise<void> {
  running ??= (async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const b = getBook(id);
      if (b) await readBook(b).catch((err) => setState(id, "failed", REASONS.unreadable, err));
    }
  })().finally(() => (running = null));
  return running;
}

/** Everything queued has been read (tests, and the rescan route's callers). */
export async function whenIdle() {
  while (scanning || running) await (scanning ?? running);
}

function setState(id: string, state: BookState, error: string | null = null, detail?: unknown) {
  db.prepare("UPDATE ref_books SET state = ?, error = ?, indexed_at = CASE WHEN ? IN ('ready','failed') THEN ? ELSE indexed_at END WHERE id = ?").run(state, error, state, nowIso(), id);
  if (state === "failed") audit("system", "reference.failed", id, { error, detail: detail instanceof Error ? detail.message : detail });
  bus.emit("files", {});
}

const sha256 = (p: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(p)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

/**
 * A text or HTML design reference (20.1), read here by chapter and section: each section is one of its "pages" (the
 * heading is its place, "The Mortise and Tenon Joint › General Rule"; printed is the book's own page where it starts),
 * and the contents are its chapters and sections, so the contents-first search finds a place by its name.
 */
async function readTextBook(b: Book) {
  const t0 = Date.now();
  setState(b.id, "reading");
  tocCache.delete(b.id);
  const meta = designMetaFor(b.path);
  let parsed: ReturnType<typeof parseHtmlBook>;
  let buf: Buffer;
  try {
    buf = await readFile(b.path);
    const text = decodeBook(buf);
    parsed = /\.html?$/i.test(b.path) ? parseHtmlBook(text, meta.skip_sections) : parseTextBook(text, meta.skip_sections);
  } catch (err) {
    return setState(b.id, "failed", REASONS.unreadable, err);
  }
  forgetPages(b.id);
  if (!parsed.sections.length) return setState(b.id, "failed", REASONS.empty);
  const toc: [number, string, number][] = [];
  let prev: string[] = [];
  parsed.sections.forEach((s, i) => {
    s.trail.forEach((t, d) => {
      if (prev[d] !== t || prev.slice(0, d).join("\u0000") !== s.trail.slice(0, d).join("\u0000")) toc.push([d + 1, t, i + 1]);
    });
    prev = s.trail;
  });
  db.exec("BEGIN");
  try {
    const ins = db.prepare("INSERT INTO ref_pages (book_id, page, printed, heading, text) VALUES (?, ?, ?, ?, ?)");
    const fts = db.prepare("INSERT INTO ref_fts (book_id, page, heading, text) VALUES (?, ?, ?, ?)");
    parsed.sections.forEach((s, i) => {
      const heading = s.trail.join(" › ");
      ins.run(b.id, i + 1, s.printed, heading, s.text);
      fts.run(b.id, i + 1, normalise(heading).join(" "), normalise(s.text).join(" "));
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  writeToc(b.id, toc);
  const title = meta.title ?? parsed.title ?? b.name.replace(/\.[^.]+$/, "");
  db.prepare("UPDATE ref_books SET title = ?, pages = ?, has_toc = 1, hash = ? WHERE id = ?").run(title.slice(0, 200), parsed.sections.length, createHash("sha256").update(buf).digest("hex"), b.id);
  applyDesignMeta();
  setState(b.id, "ready");
  audit("system", "reference.read", b.id, { name: b.name, sections: parsed.sections.length, ms: Date.now() - t0 });
  console.log(`[reference] read ${b.name}: ${parsed.sections.length} sections in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

/** Bring every design reference's and code book's details up to date from the manifests beside them (cheap). */
export function applyDesignMeta() {
  const rows = db.prepare("SELECT id, path, shelf, title, maker, product, doc_date, doc_version, source_url, fetched_at FROM ref_books WHERE kind IN ('design','code')").all() as { id: string; path: string; shelf: string; title: string; maker: string | null; product: string | null; doc_date: string | null; doc_version: string | null; source_url: string | null; fetched_at: string | null }[];
  const upd = db.prepare("UPDATE ref_books SET maker = ?, product = ?, doc_date = ?, doc_version = ?, source_url = ?, fetched_at = ?, title = COALESCE(?, title) WHERE id = ?");
  const drop = db.prepare("DELETE FROM ref_pages WHERE book_id = ? AND page = ?");
  const dropFts = db.prepare("DELETE FROM ref_fts WHERE book_id = ? AND page = ?");
  for (const r of rows) {
    const m = designMetaFor(r.path, referenceDir(), r.shelf);
    // a page the manifest leaves out is never kept in the index, even one read before the manifest said so (or by the
    // version before this one, which shares the folder and didn't know about leaving pages out)
    for (const p of m.leave_out) (drop.run(r.id, p), dropFts.run(r.id, p));
    const year = m.year && /^\d{4}$/.test(m.year) ? m.year : null;
    const version = m.edition ?? m.year;
    if (m.author !== r.maker || m.short !== r.product || year !== r.doc_date || version !== r.doc_version || m.source_url !== r.source_url || m.fetched !== r.fetched_at || (m.title && m.title !== r.title))
      upd.run(m.author, m.short, year, version, m.source_url, m.fetched, m.title, r.id);
  }
}

/** Read one book through the engine, a page at a time, writing in batches. */
async function readBook(b: Book) {
  if (b.kind === "design" && isTextRef(b.path)) return readTextBook(b);
  const t0 = Date.now();
  setState(b.id, "reading");
  tocCache.delete(b.id);
  const hash = sha256(b.path).catch(() => null);
  const proc = spawn(PY, ["-I", ENGINE, "ref_index", b.path], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", () => undefined); // MuPDF's harmless colour-profile noise
  let error: string | null = null;
  // If the reading tools are not installed the program cannot start at all. That must fail this one book with a
  // plain reason, never stop the whole app (found on a fresh PC, where it stopped the app in a loop).
  const exited = new Promise<number | null>((r) => {
    proc.on("close", r);
    proc.on("error", () => { error = REASONS.tools; r(null); });
  });
  let pages = 0;
  let chars = 0;
  let batch: { page: number; text: string }[] = [];
  // pages a design reference's manifest leaves off the shelf (they copy Australian Standards design values): never indexed
  const skip = b.kind === "design" ? designMetaFor(b.path).leave_out : new Set<number>();
  const flush = () => {
    if (!batch.length) return;
    db.exec("BEGIN");
    try {
      const ins = db.prepare("INSERT INTO ref_pages (book_id, page, printed, heading, text) VALUES (?, ?, ?, ?, ?)");
      const fts = db.prepare("INSERT INTO ref_fts (book_id, page, heading, text) VALUES (?, ?, ?, ?)");
      for (const p of batch) {
        const h = pageHeading(p.text);
        ins.run(b.id, p.page, h.printed, h.heading, p.text);
        fts.run(b.id, p.page, normalise(h.heading).join(" "), normalise(p.text).join(" "));
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    batch = [];
  };
  db.prepare("DELETE FROM ref_fts WHERE book_id = ?").run(b.id);
  db.prepare("DELETE FROM ref_pages WHERE book_id = ?").run(b.id);
  db.prepare("DELETE FROM ref_toc WHERE book_id = ?").run(b.id);
  for await (const line of createInterface({ input: proc.stdout })) {
    if (!line.trim()) continue;
    let m: { error?: string; book?: { pages: number; title: string; toc: [number, string, number][] }; page?: number; text?: string };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.error) {
      error = m.error === "locked" ? REASONS.locked : REASONS.unreadable;
      continue;
    }
    if (m.book) {
      pages = m.book.pages;
      const title = m.book.title && !/^untitled|\.(pdf|docx?)$|^microsoft/i.test(m.book.title) ? m.book.title : b.name.replace(/\.pdf$/i, "");
      db.prepare("UPDATE ref_books SET title = ?, pages = ?, has_toc = ? WHERE id = ?").run(title.slice(0, 200), pages, m.book.toc.length ? 1 : 0, b.id);
      writeToc(b.id, m.book.toc);
      continue;
    }
    if (typeof m.page === "number") {
      chars += (m.text ?? "").trim().length;
      if (skip.has(m.page)) continue;
      batch.push({ page: m.page, text: m.text ?? "" });
      if (batch.length >= BATCH) flush();
    }
  }
  flush();
  const code = await exited;
  if (!error && code !== 0) error = REASONS.stopped;
  if (!error && pages && !chars) error = REASONS.empty;
  if (!error && !pages) error = REASONS.unreadable;
  if (error) {
    forgetPages(b.id);
    return setState(b.id, "failed", error);
  }
  db.prepare("UPDATE ref_books SET hash = ? WHERE id = ?").run(await hash, b.id);
  if (b.kind === "guide") applyGuideMeta(); // the manifest's title wins over the PDF's own
  if (b.kind === "design" || b.kind === "code") applyDesignMeta();
  setState(b.id, "ready");
  audit("system", "reference.read", b.id, { name: b.name, pages, ms: Date.now() - t0 });
  console.log(`[reference] read ${b.name}: ${pages} pages in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

function forgetPages(id: string) {
  db.prepare("DELETE FROM ref_fts WHERE book_id = ?").run(id);
  db.prepare("DELETE FROM ref_pages WHERE book_id = ?").run(id);
  db.prepare("DELETE FROM ref_toc WHERE book_id = ?").run(id);
}

function writeToc(id: string, toc: [number, string, number][]) {
  const path: string[] = [];
  const ins = db.prepare("INSERT INTO ref_toc (book_id, seq, level, title, page, trail) VALUES (?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    toc.forEach(([level, title, page], seq) => {
      path.length = Math.max(0, level - 1);
      path[level - 1] = clean(title);
      ins.run(id, seq, level, clean(title), page, path.filter(Boolean).join(" › "));
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/* ---------------- start-up ---------------- */

/** Read anything new or changed shortly after start-up, then glance at the shelf every ten minutes (a stat, nothing more). */
export function startReferenceShelf() {
  // anything cut off by a restart is read again
  for (const b of db.prepare("SELECT id FROM ref_books WHERE state IN ('waiting','reading')").all() as { id: string }[]) db.prepare("UPDATE ref_books SET state = 'waiting', mtime = NULL WHERE id = ?").run(b.id);
  setTimeout(() => void scanShelf().catch((err) => console.warn("[reference] scan:", err)), DEV ? 300 : 4000).unref();
  setInterval(() => void scanShelf().catch(() => undefined), 10 * 60_000).unref();
}

/** For the desktop's Files page. */
export function shelfSummary() {
  return {
    dir: referenceDir(),
    books: listBooks().map((b) => ({ id: b.id, name: b.name, title: b.title, shelf: b.shelf, pages: b.pages, note: b.pages === 0 && b.note !== null, state: b.state, error: b.error, ...(b.kind === "guide" ? { kind: b.kind, maker: b.maker, doc_date: b.doc_date } : b.kind === "design" || b.kind === "code" ? { kind: b.kind, maker: b.maker, doc_date: b.doc_date } : {}) })),
  };
}

/* ---------------- looking things up ---------------- */

type TocRow = { seq: number; level: number; title: string; page: number; trail: string; words: Set<string> };
const tocCache = new Map<string, TocRow[]>();
function tocOf(id: string): TocRow[] {
  let rows = tocCache.get(id);
  if (!rows) {
    rows = (db.prepare("SELECT seq, level, title, page, trail FROM ref_toc WHERE book_id = ? ORDER BY seq").all(id) as Omit<TocRow, "words">[]).map((r) => ({ ...r, words: new Set(normalise(r.trail)) }));
    tocCache.set(id, rows);
  }
  return rows;
}

export const readyBooks = () => listBooks().filter((b) => b.state === "ready" && b.pages > 0);
/** The standards and span-table books (searched exactly as before guides came, Stage 8). */
export const readyStandardBooks = () => readyBooks().filter((b) => b.kind === "book");
/** The makers' guides (14.1). */
export const readyGuides = () => readyBooks().filter((b) => b.kind === "guide");
/** The design references (20.1). */
export const readyDesign = () => readyBooks().filter((b) => b.kind === "design");
/** The National Construction Code books (20.1), when the owner has put them on the shelf. */
export const readyCode = () => readyBooks().filter((b) => b.kind === "code");
export const shelfNotes = () => listBooks().filter((b) => b.pages === 0 && b.note);

/** A book by its id, or by (part of) its name or title. */
export function findBook(ref: string): Book | undefined {
  const books = readyBooks();
  const r = ref.trim().toLowerCase();
  return books.find((b) => b.id === ref) ?? books.find((b) => b.name.toLowerCase() === r) ?? books.find((b) => b.name.toLowerCase().includes(r) || b.title.toLowerCase().includes(r));
}

export function tocTop(id: string) {
  return tocOf(id)
    .filter((r) => r.level === 1)
    .map((r) => ({ title: r.title, page: r.page }));
}

export type Hit = { book: string; book_name: string; page: number; printed: string | null; where: string; snippet: string; from: "contents" | "text" };

function snippetOf(text: string, words: string[]) {
  const flat = text.replace(/�/g, " - ").replace(/\s+/g, " ").trim();
  const low = flat.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const from = Math.max(0, at - 60);
  return (from ? "…" : "") + flat.slice(from, from + 220) + (flat.length > from + 220 ? "…" : "");
}

/**
 * Look something up: the table of contents first (every word of the query in an entry's trail; deepest entries first),
 * then the page text. At most 12 results.
 */
export function findInReference(query: string, o: { book?: string; limit?: number; kind?: "book" | "design" | "code" } = {}): { results: Hit[]; error?: string } {
  const words = [...new Set(normalise(query))];
  if (!words.length) return { results: [], error: "Say what to look for." };
  // the books, not the makers' guides (those have their own search, findInGuides, so this one answers as it always has);
  // the design references and the code are searched the same way, on their own (20.1)
  const pool = o.kind === "design" ? readyDesign() : o.kind === "code" ? readyCode() : readyStandardBooks();
  const books = o.book ? [findBook(o.book)].filter((b): b is Book => !!b) : pool;
  if (o.book && !books.length) return { results: [], error: `No book "${o.book}" on the shelf.` };
  // none of that kind on the shelf: nothing to find (an empty list would otherwise search every book's text)
  if (!books.length) return { results: [] };
  const limit = Math.min(12, Math.max(1, o.limit ?? 12));
  const out: Hit[] = [];
  const page = db.prepare("SELECT printed, heading, text FROM ref_pages WHERE book_id = ? AND page = ?");
  for (const b of books) {
    const hits = tocOf(b.id)
      .filter((r) => words.every((w) => r.words.has(w)))
      .sort((x, y) => y.level - x.level || x.seq - y.seq);
    for (const r of hits) {
      const p = page.get(b.id, r.page) as { printed: string | null; heading: string; text: string } | undefined;
      out.push({ book: b.id, book_name: b.name, page: r.page, printed: p?.printed ?? null, where: r.trail, snippet: p ? snippetOf(p.heading, []) : "", from: "contents" });
    }
  }
  if (out.length < limit) {
    const ids = books.map((b) => b.id);
    const q = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" ");
    const rows = db
      .prepare(`SELECT book_id, page FROM ref_fts WHERE ref_fts MATCH ? ${ids.length ? `AND book_id IN (${ids.map(() => "?").join(",")})` : ""} ORDER BY rank LIMIT ?`)
      .all(q, ...ids, limit * 2) as { book_id: string; page: number }[];
    for (const r of rows) {
      if (out.some((h) => h.book === r.book_id && h.page === Number(r.page))) continue;
      const p = page.get(r.book_id, r.page) as { printed: string | null; heading: string; text: string };
      const b = books.find((x) => x.id === r.book_id)!;
      out.push({ book: r.book_id, book_name: b.name, page: Number(r.page), printed: p.printed, where: p.heading, snippet: snippetOf(p.text, words), from: "text" });
    }
  }
  return { results: out.slice(0, limit) };
}

export type GuideHit = Hit & { maker: string | null; title: string; doc_date: string | null; doc_version: string | null };

/**
 * Look something up in the makers' guides (14.1). Words that name a guide (its maker, product or title: "Hardie",
 * "Linea", "HardieDeck") pick the guide; the rest must all be on the page (or in a contents entry). A query that only
 * names a guide gives its contents. maker narrows it to one maker. Guides that match more of the query come first.
 */
export function findInGuides(query: string, o: { maker?: string; book?: string; limit?: number } = {}): { results: GuideHit[]; error?: string } {
  const words = [...new Set(normalise(query))];
  if (!words.length) return { results: [], error: "Say what to look for." };
  let guides = readyGuides();
  if (o.book) guides = guides.filter((g) => g.id === o.book || g.name.toLowerCase().includes(o.book!.toLowerCase()) || g.title.toLowerCase().includes(o.book!.toLowerCase()));
  if (o.maker) {
    const m = normalise(o.maker);
    guides = guides.filter((g) => m.every((w) => normalise(`${g.maker ?? ""} ${g.path}`).includes(w)));
  }
  if (!guides.length) return { results: [], error: o.maker || o.book ? `No guide${o.maker ? ` from ${o.maker}` : ""}${o.book ? ` called "${o.book}"` : ""} on the shelf.` : "There are no makers' guides on the shelf." };
  const limit = Math.min(12, Math.max(1, o.limit ?? 12));
  const scored = guides.map((g) => {
    const name = new Set(normalise(`${g.maker ?? ""} ${g.product ?? ""} ${g.title} ${g.name.replace(/\.pdf$/i, "").replace(/[-_]/g, " ")}`));
    const rest = words.filter((w) => !name.has(w));
    return { g, score: words.length - rest.length, rest };
  });
  // When some guide's name matches, only guides whose name matches are searched: "Hardie nail spacing" is about Hardie.
  const best = Math.max(...scored.map((s) => s.score));
  const pool = best > 0 ? scored.filter((s) => s.score > 0) : scored;
  const out: (GuideHit & { score: number; order: number })[] = [];
  const page = db.prepare("SELECT printed, heading, text FROM ref_pages WHERE book_id = ? AND page = ?");
  const hit = (s: (typeof scored)[number], pg: number, where: string, snippet: string, from: Hit["from"], order: number) => {
    if (out.some((h) => h.book === s.g.id && h.page === pg)) return;
    const p = page.get(s.g.id, pg) as { printed: string | null } | undefined;
    out.push({ book: s.g.id, book_name: s.g.name, page: pg, printed: p?.printed ?? null, where, snippet, from, maker: s.g.maker, title: s.g.title, doc_date: s.g.doc_date, doc_version: s.g.doc_version, score: s.score, order });
  };
  // contents entries first
  for (const s of pool) {
    const toc = tocOf(s.g.id);
    const rows = s.rest.length ? toc.filter((r) => s.rest.every((w) => r.words.has(w))).sort((x, y) => y.level - x.level || x.seq - y.seq) : toc.filter((r) => r.level === 1);
    for (const r of rows.slice(0, limit)) {
      const p = page.get(s.g.id, r.page) as { heading: string } | undefined;
      hit(s, r.page, r.trail, p ? snippetOf(p.heading, []) : "", "contents", 0);
    }
    if (!s.rest.length && !rows.length) {
      const p = page.get(s.g.id, 1) as { heading: string; text: string } | undefined;
      hit(s, 1, p?.heading ?? "", p ? snippetOf(p.text, []) : "", "text", 0);
    }
  }
  // then page text, one search per set of remaining words
  const groups = new Map<string, typeof pool>();
  for (const s of pool.filter((x) => x.rest.length)) groups.set(s.rest.join(" "), [...(groups.get(s.rest.join(" ")) ?? []), s]);
  for (const [, group] of groups) {
    const q = group[0].rest.map((w) => `"${w.replace(/"/g, "")}"`).join(" ");
    const rows = db
      .prepare(`SELECT book_id, page, rank FROM ref_fts WHERE ref_fts MATCH ? AND book_id IN (${group.map(() => "?").join(",")}) ORDER BY rank LIMIT ?`)
      .all(q, ...group.map((s) => s.g.id), limit * 3) as { book_id: string; page: number; rank: number }[];
    for (const r of rows) {
      const s = group.find((x) => x.g.id === r.book_id)!;
      const p = page.get(r.book_id, r.page) as { heading: string; text: string } | undefined;
      if (p) hit(s, Number(r.page), p.heading, snippetOf(p.text, s.rest), "text", 1 + r.rank / 1000);
    }
  }
  out.sort((x, y) => y.score - x.score || x.order - y.order);
  return { results: out.slice(0, limit).map(({ score: _s, order: _o, ...h }) => h) };
}

export type RefPage = { book: Book; page: number; printed: string | null; heading: string; text: string };

/** One page of a ready book, or a plain reason it can't be had. */
export function getPage(bookRef: string, n: number): RefPage | { error: string } {
  const b = findBook(bookRef);
  if (!b) return { error: `No book "${bookRef}" on the shelf.` };
  if (!Number.isInteger(n) || n < 1 || n > b.pages) return { error: `${b.name} has ${b.kind === "design" && isTextRef(b.path) ? "sections" : "pages"} 1 to ${b.pages}; there's no ${b.kind === "design" && isTextRef(b.path) ? "section" : "page"} ${n}.` };
  if (leftOut(b, n)) return { error: `Page ${n} of ${b.title || b.name} is left off the shelf: ${leftOutReason(b)}` };
  const p = db.prepare("SELECT printed, heading, text FROM ref_pages WHERE book_id = ? AND page = ?").get(b.id, n) as { printed: string | null; heading: string; text: string } | undefined;
  if (!p) return { error: `Page ${n} of ${b.name} isn't in the index; it may still be reading.` };
  return { book: b, page: n, ...p };
}

/**
 * The short line under a reference page on screen: "AS 1684.2 N1/N2 Supp 4 · Table 29 · page 212". From the page's
 * own heading (its book line and table number) and its printed page number when it has one.
 */
export function sourceLine(p: RefPage) {
  if (p.book.kind === "guide") return guideSourceLine(p.book, p.page); // "James Hardie · <title> · March 2024 · page 12"
  if (p.book.kind === "design" || p.book.kind === "code") return designSourceLine(p.book, p.page, p.heading, p.printed); // "Fairham, Woodwork Joints (c. 1930) · The Mortise and Tenon Joint › General Rule · book page 82"
  const parts = p.heading.split(" · ");
  const bookLine = parts.find((l) => /^AS\s?\d/i.test(l))?.replace(/\bsupp\.?\s*/i, "Supp ").replace(/\s*-\s*\d{4}\s*$/, "").replace(/\s+/g, " ");
  const name = bookLine ?? (p.book.title || p.book.name.replace(/\.pdf$/i, ""));
  const tbl = tableOf(p.heading);
  return [name, tbl, `page ${p.printed ?? p.page}`].filter(Boolean).join(" · ");
}
