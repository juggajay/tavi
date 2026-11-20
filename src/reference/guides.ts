// Makers' guides (Stage 14.1): a second kind of book on the reference shelf. A PDF in the shelf's "Guides" folder
// (Guides\<Maker>\...) is a guide: found, read, cited and shown exactly as the books are (library.ts, referenceTools.ts),
// with the maker and the document's date in every citation. What a guide is comes from the manifest.json beside it
// (written when it was fetched from the maker's own site), or from its folder and the PDF itself when there's none.
//
// The shelf is only ever read, with three exceptions, each only on the owner's word: a guide he asks to add is ADDED as
// a new file (never replacing one); a newer copy he says yes to is added beside the old one and the old one moved into
// that maker's "Superseded" folder; and the manifest beside them is updated to say so. The monthly check downloads a
// newer copy into the data folder, never the shelf, and only tells him: it never swaps anything by itself.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { REF_CACHE, referenceDir } from "./dir.js";
import { stopRenderWorkers } from "../drawings/engine.js";

export const GUIDES = "Guides";
export const SUPERSEDED = "Superseded";
/** A guide older than this is said to be old in any answer from it. */
export const OLD_AFTER_YEARS = 2;
/** The client name the monthly check fetches with: generic, never the owner's name. */
export const FETCH_AGENT = "Mozilla/5.0 (compatible; reference-shelf-fetch/1.0)";

export type GuideDoc = {
  file: string;
  title?: string | null;
  product?: string | null;
  category?: string | null;
  date?: string | null;
  date_text?: string | null;
  version?: string | null;
  source?: string | null;
  found_on?: string | null;
  fetched?: string | null;
  sha256?: string | null;
  bytes?: number | null;
  pages?: number | null;
  copyright?: string | null;
  superseded_by?: string | null;
};
export type Manifest = { maker: string; site?: string; terms?: unknown; documents: GuideDoc[]; skipped?: unknown[] };

export type GuideMeta = { maker: string; product: string | null; title: string | null; doc_date: string | null; doc_version: string | null; source_url: string | null; fetched_at: string | null };

export const isGuideShelf = (shelf: string) => shelf.toLowerCase() === GUIDES.toLowerCase();

/* ---------------- the manifest beside each maker's guides ---------------- */

const manifestPath = (dir: string) => path.join(dir, "manifest.json");

/** A maker folder's manifest, or an empty one named after the folder. Never throws: a broken manifest is ignored. */
export function readManifest(dir: string): Manifest {
  const fallback: Manifest = { maker: path.basename(dir), documents: [] };
  try {
    const m = JSON.parse(readFileSync(manifestPath(dir), "utf8")) as Partial<Manifest>;
    return { ...m, maker: typeof m.maker === "string" && m.maker.trim() ? m.maker.trim() : fallback.maker, documents: Array.isArray(m.documents) ? m.documents.filter((d) => d && typeof d.file === "string") : [] };
  } catch {
    return fallback;
  }
}

function writeManifest(dir: string, m: Manifest) {
  writeFileSync(manifestPath(dir), JSON.stringify(m, null, 2) + "\n", "utf8");
}

const clean = (s: unknown, max = 200) => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : null);
/** "2024", "2024-03" or "2024-03-15"; anything else isn't a date. */
export const isDocDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(s);

/**
 * What a guide is, from the manifest beside it (keyed by file name), else from where it sits: the maker is the folder
 * under Guides (a PDF straight in Guides has no maker), and the title is left to the PDF.
 */
export function guideMetaFor(file: string, root = referenceDir()): GuideMeta {
  const dir = path.dirname(file);
  const rel = path.relative(path.join(root, GUIDES), dir).split(path.sep).filter(Boolean);
  const makerDir = rel.length && rel[0] !== ".." ? path.join(root, GUIDES, rel[0]) : null;
  const m = makerDir ? readManifest(makerDir) : null;
  const d = m?.documents.find((x) => x.file.toLowerCase() === path.basename(file).toLowerCase());
  return {
    maker: m?.maker ?? "",
    product: clean(d?.product),
    title: clean(d?.title),
    doc_date: isDocDate(d?.date) ? d!.date! : null,
    doc_version: clean(d?.version, 60),
    source_url: typeof d?.source === "string" && /^https?:\/\//i.test(d.source) ? d.source : null,
    fetched_at: clean(d?.fetched, 40),
  };
}

/** Bring every guide's details up to date from the manifests (cheap; run after each look at the shelf). */
export function applyGuideMeta() {
  const rows = db.prepare("SELECT id, path, title, maker, product, doc_date, doc_version, source_url, fetched_at FROM ref_books WHERE kind = 'guide'").all() as { id: string; path: string; title: string; maker: string | null; product: string | null; doc_date: string | null; doc_version: string | null; source_url: string | null; fetched_at: string | null }[];
  const upd = db.prepare("UPDATE ref_books SET maker = ?, product = ?, doc_date = ?, doc_version = ?, source_url = ?, fetched_at = ?, title = COALESCE(?, title) WHERE id = ?");
  for (const r of rows) {
    const g = guideMetaFor(r.path);
    if (g.maker !== r.maker || g.product !== r.product || g.doc_date !== r.doc_date || g.doc_version !== r.doc_version || g.source_url !== r.source_url || g.fetched_at !== r.fetched_at || (g.title && g.title !== r.title))
      upd.run(g.maker || null, g.product, g.doc_date, g.doc_version, g.source_url, g.fetched_at, g.title, r.id);
  }
}

/* ---------------- how a guide is named in an answer ---------------- */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "March 2024", "15 March 2024", "2024", "Version 5", or "date not printed". */
export function dateLabel(date: string | null | undefined, version?: string | null) {
  if (isDocDate(date)) {
    const [y, m, d] = date.split("-");
    return [d ? String(Number(d)) : "", m ? MONTHS[Number(m) - 1] : "", y].filter(Boolean).join(" ");
  }
  return version ? version : "date not printed";
}

/** The moment a guide's date runs out: the end of its day, or of its month or year when that's all it says (so it's never made older). */
function dateEnd(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  if (d) return new Date(Date.UTC(y, m - 1, d + 1));
  if (m) return new Date(Date.UTC(y, m, 1));
  return new Date(Date.UTC(y + 1, 0, 1));
}

/** How old a guide is, and the sentence to say when it's over two years. */
export function guideAge(g: { doc_date: string | null; doc_version?: string | null; maker?: string | null; title?: string }, now = new Date()): { years: number | null; old: boolean; note: string | null } {
  if (!isDocDate(g.doc_date)) return { years: null, old: false, note: `This guide doesn't print a date${g.doc_version ? ` (it says ${g.doc_version})` : ""}, so say you can't tell how current it is.` };
  const end = dateEnd(g.doc_date);
  const years = (now.getTime() - end.getTime()) / (365.25 * 86_400_000);
  const cut = new Date(end);
  cut.setUTCFullYear(cut.getUTCFullYear() + OLD_AFTER_YEARS);
  const old = now >= cut;
  return { years: Math.max(0, Math.floor(years * 10) / 10), old, note: old ? `This guide is dated ${dateLabel(g.doc_date)}, over ${OLD_AFTER_YEARS} years old: say so in the answer, and that the maker may have a newer one.` : null };
}

/** "James Hardie · Scyon Linea Weatherboard Installation Guide · March 2024 · page 12" (the PDF's page). */
export function guideSourceLine(b: { maker: string | null; title: string; name: string; doc_date: string | null; doc_version: string | null }, page: number) {
  return [b.maker || "Maker not known", b.title || b.name.replace(/\.pdf$/i, ""), dateLabel(b.doc_date, b.doc_version), `page ${page}`].join(" · ");
}

/* ---------------- adding a guide on the owner's word ---------------- */

const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
/** A maker's name as a folder name: plain letters, no path characters. */
export const folderName = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|[. ]+$/g, "")
    .slice(0, 60);

function uniqueIn(dir: string, name: string) {
  const ext = path.extname(name) || ".pdf";
  const base = name.slice(0, name.length - path.extname(name).length) || "Guide";
  for (let i = 1; ; i++) {
    const p = path.join(dir, i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
}

export type AddGuide = { maker: string; title?: string; product?: string; date?: string; source?: string };

/**
 * Put a PDF the owner has given on the shelf as a guide (he asked: "add this to the guides"): a new file in
 * Guides\<Maker>\ (never replacing one) and a line in that maker's manifest. The caller rescans the shelf.
 */
export function addGuide(src: string, a: AddGuide): { file: string; maker: string } | { error: string } {
  if (!/\.pdf$/i.test(src) || !existsSync(src)) return { error: "That isn't a PDF I have." };
  const head = readFileSync(src).subarray(0, 5).toString("latin1");
  if (head !== "%PDF-") return { error: "That file isn't a PDF." };
  const maker = folderName(a.maker);
  if (!maker) return { error: "Say which maker it's from." };
  if (a.date && !isDocDate(a.date)) return { error: "Give the guide's date as a year, year-month or full date (2024, 2024-03, 2024-03-15)." };
  const dir = path.join(referenceDir(), GUIDES, maker);
  mkdirSync(dir, { recursive: true });
  const name = folderName(a.title || path.basename(src, path.extname(src))).replace(/ /g, "-") + ".pdf";
  const target = uniqueIn(dir, name);
  copyFileSync(src, target);
  const m = readManifest(dir);
  if (!existsSync(manifestPath(dir))) m.maker = a.maker.trim().slice(0, 80);
  m.documents.push({
    file: path.basename(target),
    title: a.title?.trim() || null,
    product: a.product?.trim() || null,
    date: a.date ?? null,
    source: a.source?.trim() || "added by the owner",
    fetched: nowIso(),
    sha256: sha256File(target),
    bytes: statSync(target).size,
  });
  writeManifest(dir, m);
  audit("user", "guide.added", null, { maker, file: path.basename(target) });
  return { file: target, maker: m.maker };
}

/* ---------------- the monthly check for newer copies ---------------- */

export const UPDATES_DIR = path.join(REF_CACHE, "guide-updates");
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type GuideRow = { id: string; path: string; name: string; title: string; maker: string | null; hash: string | null; source_url: string | null; doc_date: string | null; size: number | null; fetched_at: string | null };

/** From a HEAD answer: plainly the same file as ours (same size, not changed since we fetched it), so no download. */
function looksSame(res: Response, g: GuideRow) {
  const len = Number(res.headers.get("content-length"));
  if (!len || !g.size || len !== g.size) return false;
  const lm = Date.parse(res.headers.get("last-modified") ?? "");
  const got = Date.parse(g.fetched_at ?? "");
  return !Number.isFinite(lm) || (Number.isFinite(got) && lm <= got);
}

/** The newer copy's date, if it says one in its metadata (the PDF's own date, "D:20240315..."). */
function pdfDate(buf: Buffer): string | null {
  const m = /\/ModDate\s*\(D:(\d{4})(\d{2})?(\d{2})?/.exec(buf.subarray(0, 2_000_000).toString("latin1")) ?? /\/CreationDate\s*\(D:(\d{4})(\d{2})?(\d{2})?/.exec(buf.subarray(0, 2_000_000).toString("latin1"));
  if (!m) return null;
  const d = [m[1], m[2]].filter(Boolean).join("-"); // the file's date, not one it prints: the month is near enough
  return isDocDate(d) ? d : null;
}

/**
 * Look at each guide's source once (one at a time, a pause between, a generic client name): a different file at the
 * address is a newer copy, kept in the data folder until the owner says what to do; an address that's gone is noted.
 * A copy he's already said no to isn't offered again. Returns what it found.
 */
export async function checkGuideUpdates(o: { fetch?: Fetcher; pauseMs?: number; now?: Date } = {}) {
  const get = o.fetch ?? fetch;
  const pause = o.pauseMs ?? 3000;
  const rows = db.prepare("SELECT id, path, name, title, maker, hash, source_url, doc_date, size, fetched_at FROM ref_books WHERE kind = 'guide' AND state = 'ready' AND source_url IS NOT NULL ORDER BY maker, name").all() as GuideRow[];
  const found: { book: string; status: "new" | "gone" }[] = [];
  let first = true;
  const wait = async () => {
    if (!first && pause) await new Promise((r) => setTimeout(r, pause));
    first = false;
  };
  const headers = { "User-Agent": FETCH_AGENT, Accept: "application/pdf" };
  for (const g of rows) {
    const known = db.prepare("SELECT hash, status FROM guide_updates WHERE book_id = ?").get(g.id) as { hash: string; status: string } | undefined;
    let res: Response;
    try {
      await wait();
      // a light look first: when the maker's file is plainly the one we have, nothing is downloaded
      const head = await get(g.source_url!, { method: "HEAD", headers, redirect: "follow", signal: AbortSignal.timeout(30_000) });
      if (head.ok && looksSame(head, g)) continue;
      if (head.status === 404 || head.status === 410) res = head;
      else {
        await wait();
        res = await get(g.source_url!, { headers, redirect: "follow", signal: AbortSignal.timeout(120_000) });
      }
    } catch {
      continue; // no network or the site's down: try again next month
    }
    if (res.status === 404 || res.status === 410) {
      if (!known || known.status !== "gone") {
        db.prepare("INSERT INTO guide_updates (book_id, found_at, url, hash, status) VALUES (?, ?, ?, '', 'gone') ON CONFLICT(book_id) DO UPDATE SET found_at = excluded.found_at, status = 'gone', told_at = NULL").run(g.id, nowIso(), g.source_url);
        found.push({ book: g.id, status: "gone" });
      }
      continue;
    }
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") continue; // a page, a login wall or a bot check: not a guide
    const hash = createHash("sha256").update(buf).digest("hex");
    if (hash === g.hash) continue;
    if (known && known.hash === hash) continue; // already found (and told, swapped or turned down)
    mkdirSync(UPDATES_DIR, { recursive: true });
    const staged = path.join(UPDATES_DIR, `${g.id}.pdf`);
    writeFileSync(staged, buf);
    db.prepare(
      "INSERT INTO guide_updates (book_id, found_at, url, hash, doc_date, staged, status) VALUES (?, ?, ?, ?, ?, ?, 'new') ON CONFLICT(book_id) DO UPDATE SET found_at = excluded.found_at, url = excluded.url, hash = excluded.hash, doc_date = excluded.doc_date, staged = excluded.staged, status = 'new', told_at = NULL, decided_at = NULL",
    ).run(g.id, (o.now ?? new Date()).toISOString(), g.source_url, hash, pdfDate(buf), staged);
    audit("system", "guide.newer_found", g.id, { maker: g.maker, name: g.name });
    found.push({ book: g.id, status: "new" });
  }
  return found;
}

const shortTitle = (g: { title: string; name: string }) => (g.title || g.name.replace(/\.pdf$/i, "")).replace(/\s+/g, " ").slice(0, 80);

/** Newer copies (and gone addresses) not yet told, for the morning brief: said once. */
export function guideUpdatesNote(): { text: string; ids: string[] } {
  const rows = db
    .prepare("SELECT u.book_id, u.status, u.doc_date, b.title, b.name, b.maker FROM guide_updates u JOIN ref_books b ON b.id = u.book_id WHERE u.status IN ('new','gone') AND u.told_at IS NULL ORDER BY b.maker, b.name")
    .all() as { book_id: string; status: "new" | "gone"; doc_date: string | null; title: string; name: string; maker: string | null }[];
  if (!rows.length) return { text: "", ids: [] };
  const lines = rows.map((r) =>
    r.status === "new"
      ? `${r.maker || "A maker"} has a newer copy of "${shortTitle(r)}"${r.doc_date ? ` (${dateLabel(r.doc_date)})` : ""} [book ${r.book_id}]`
      : `${r.maker || "A maker"}'s address for "${shortTitle(r)}" no longer works; it may have been replaced [book ${r.book_id}]`,
  );
  return {
    text: `Makers' guides on the shelf, checked against the makers' sites this month: ${lines.join("; ")}. Say this once, briefly, and for a newer copy ask whether to swap it in (e.g. "Hardie has a newer Linea guide, March 2027; shall I swap it in?"). Never swap one without their yes (answer_guide_update).`,
    ids: rows.map((r) => r.book_id),
  };
}

/** The brief went out with that line: those aren't said again. */
export function guideUpdatesTold(ids: string[], now = new Date()) {
  const upd = db.prepare("UPDATE guide_updates SET told_at = ?, status = CASE status WHEN 'new' THEN 'told' ELSE status END WHERE book_id = ?");
  for (const id of ids) upd.run(now.toISOString(), id);
}

/** What's waiting for the owner's word (for the brain's list). */
export function pendingGuideUpdates() {
  return db
    .prepare("SELECT u.book_id AS book, u.status, u.doc_date, u.found_at, u.url, b.title, b.name, b.maker, b.doc_date AS current_date FROM guide_updates u JOIN ref_books b ON b.id = u.book_id WHERE u.status IN ('new','told','gone') ORDER BY b.maker, b.name")
    .all() as { book: string; status: string; doc_date: string | null; found_at: string; url: string; title: string; name: string; maker: string | null; current_date: string | null }[];
}

/**
 * The owner said yes or no to a newer copy. Yes: the newer copy goes into the maker's folder beside the old one (a new
 * file), the old one into that maker's Superseded folder, and the manifest says so; the caller rescans. No: it isn't
 * offered again (unless the maker changes it again).
 */
export async function answerGuideUpdate(bookId: string, swap: boolean, now = new Date()): Promise<{ ok: true; file?: string } | { error: string }> {
  const u = db.prepare("SELECT u.*, b.path, b.title, b.name, b.maker FROM guide_updates u JOIN ref_books b ON b.id = u.book_id WHERE u.book_id = ?").get(bookId) as
    | { book_id: string; status: string; staged: string | null; url: string; hash: string; doc_date: string | null; path: string; title: string; name: string; maker: string | null }
    | undefined;
  if (!u || !["new", "told"].includes(u.status)) return { error: "There's no newer copy of that guide waiting." };
  if (!swap) {
    db.prepare("UPDATE guide_updates SET status = 'declined', decided_at = ? WHERE book_id = ?").run(now.toISOString(), bookId);
    audit("user", "guide.update_declined", bookId, { name: u.name });
    return { ok: true };
  }
  if (!u.staged || !existsSync(u.staged)) return { error: "The newer copy isn't here any more; it'll be fetched again at the next monthly check." };
  const dir = path.dirname(u.path);
  const ext = path.extname(u.name);
  const stem = u.name.slice(0, u.name.length - ext.length).replace(/[- ]\d{4}(-\d{2}){0,2}$/, "");
  const target = uniqueIn(dir, `${stem}${u.doc_date ? `-${u.doc_date}` : `-${now.toISOString().slice(0, 10)}`}${ext || ".pdf"}`);
  copyFileSync(u.staged, target);
  const old = path.join(dir, SUPERSEDED);
  mkdirSync(old, { recursive: true });
  const moved = uniqueIn(old, u.name);
  // The page-picture workers keep a PDF they've drawn open, and Windows won't move an open file: let them go (they
  // start again on the next picture) and try again for a few seconds.
  for (let i = 0; ; i++) {
    try {
      renameSync(u.path, moved);
      break;
    } catch (e) {
      if (i >= 20 || !["EBUSY", "EPERM", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      if (i === 0) stopRenderWorkers();
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const m = readManifest(dir);
  const prev = m.documents.find((d) => d.file.toLowerCase() === u.name.toLowerCase());
  m.documents = m.documents.filter((d) => d !== prev);
  m.documents.push({
    ...(prev ?? { file: "" }),
    file: path.basename(target),
    date: u.doc_date ?? prev?.date ?? null,
    date_text: u.doc_date ? `from the PDF's own date (${u.doc_date})` : (prev?.date_text ?? null),
    source: u.url,
    fetched: now.toISOString(),
    sha256: u.hash,
    bytes: statSync(target).size,
    pages: null,
  });
  if (prev) m.documents.push({ ...prev, file: `${SUPERSEDED}/${path.basename(moved)}`, superseded_by: path.basename(target) });
  writeManifest(dir, m);
  db.prepare("UPDATE guide_updates SET status = 'swapped', decided_at = ? WHERE book_id = ?").run(now.toISOString(), bookId);
  audit("user", "guide.swapped", bookId, { from: u.name, to: path.basename(target) });
  return { ok: true, file: target };
}
