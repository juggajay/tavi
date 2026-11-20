// The drawing library: finds drawing sets in data/drawings, indexes every sheet, keeps revision
// control (current vs superseded), and answers search / locate / crop requests for the brain.
//
//   data/drawings/<Project>/...pdf     one folder per job (zips are unpacked into a folder named after the zip)
//   data/drawings/inbox/               drop zone (Taildrop lands here); loose PDFs go to project "Unsorted"
//   data/drawings/.index/<hash>/       word boxes per page (rebuildable)
//   data/drawings/.crops/              rendered crops shown to Claude or the phone
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { DATA_DIR, db, newId, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { bus } from "../events.js";
import { pyCrop, pyIngest, type EnginePage } from "./engine.js";
import { readTitleBlock } from "./titleblock.js";
import { insideReference } from "../reference/dir.js";

const execFileP = promisify(execFile);
export const DRAWINGS_DIR = path.join(DATA_DIR, "drawings");
const INBOX = path.join(DRAWINGS_DIR, "inbox");
const INDEX = path.join(DRAWINGS_DIR, ".index");
const CROPS = path.join(DRAWINGS_DIR, ".crops");
const ARCHIVE = path.join(DRAWINGS_DIR, ".archive");
// Windows' own tar reads zips. Git's tar can come first on PATH, and it takes "C:\..." for a remote host.
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

export type Sheet = {
  id: string;
  file_hash: string;
  page: number;
  project: string;
  sheet_no: string | null;
  title: string | null;
  revision: string | null;
  discipline: string | null;
  read_path: string;
  source: string;
  confidence: string;
  status: "current" | "superseded" | "needs_review";
  superseded_by: string | null;
  title_block_box: string | null;
  data_dir: string;
  path?: string;
  name?: string;
};

/* ---------------- finding files ---------------- */

async function sha256(file: string) {
  return new Promise<string>((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

async function walk(dir: string, out: string[] = []) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (insideReference(p)) continue; // the reference books are a shelf, never a drawing set (Stage 8)
    if (e.isDirectory() && path.resolve(p) === path.resolve(DRAWINGS_DIR, "models")) continue; // models and what's made from them (Stage 9)
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

function projectOf(file: string) {
  const rel = path.relative(DRAWINGS_DIR, file).split(path.sep);
  if (rel[0] === "inbox" || rel.length === 1) return "Unsorted";
  return rel[0];
}

/** Unpack zips into a project folder, then look for PDFs we haven't seen. */
export async function scanForNew() {
  await mkdir(INBOX, { recursive: true });
  for (const file of await walk(DRAWINGS_DIR)) {
    if (!/\.zip$/i.test(file)) continue;
    const name = path.basename(file, path.extname(file)).replace(/[-_]?anxF$/i, "").replace(/[^\w .&()-]/g, "").trim() || "Project";
    const dest = path.join(DRAWINGS_DIR, name);
    await mkdir(dest, { recursive: true });
    try {
      await execFileP(TAR, ["-xf", file, "-C", dest], { windowsHide: true, timeout: 10 * 60_000 });
      await mkdir(ARCHIVE, { recursive: true });
      await rename(file, path.join(ARCHIVE, `${Date.now()}-${path.basename(file)}`));
      audit("system", "drawings.unzipped", null, { zip: path.basename(file), project: name });
    } catch (err) {
      audit("system", "drawings.unzip_failed", null, { zip: path.basename(file), error: err instanceof Error ? err.message : String(err) });
    }
  }
  let added = 0;
  for (const file of await walk(DRAWINGS_DIR)) {
    if (!/\.pdf$/i.test(file)) continue;
    const known = db.prepare("SELECT 1 FROM drawing_files WHERE path = ?").get(file);
    if (known) continue;
    const hash = await sha256(file);
    if (db.prepare("SELECT 1 FROM drawing_files WHERE hash = ?").get(hash)) continue; // same PDF already indexed elsewhere
    db.prepare("INSERT INTO drawing_files (hash, path, name, project, status, added_at) VALUES (?, ?, ?, ?, 'queued', ?)").run(
      hash,
      file,
      path.basename(file),
      projectOf(file),
      nowIso(),
    );
    added++;
  }
  return added;
}

/* ---------------- indexing ---------------- */

const DISCIPLINES: [RegExp, string][] = [
  [/^(A|AR|ARC)\b|^A[-.\d]/i, "Architectural"],
  [/^S[-.\d]|^ST\b/i, "Structural"],
  [/^H[-.\d]|^HYD/i, "Hydraulic"],
  [/^E[-.\d]|^EL/i, "Electrical"],
  [/^M[-.\d]|^ME/i, "Mechanical"],
  [/^F[DWS]?[-.\d]|^FP/i, "Fire"],
  [/^C[-.\d]|^CV|^CIV/i, "Civil"],
  [/^L[-.\d]|^LA/i, "Landscape"],
];
function disciplineOf(sheetNo: string | null, title: string | null, file: string) {
  const hay = `${file} ${title ?? ""}`.toLowerCase();
  if (sheetNo) for (const [re, d] of DISCIPLINES) if (re.test(sheetNo.trim())) return d;
  for (const [k, d] of [
    ["structural", "Structural"],
    ["hydraulic", "Hydraulic"],
    ["electrical", "Electrical"],
    ["mechanical", "Mechanical"],
    ["fire", "Fire"],
    ["stormwater", "Civil"],
    ["civil", "Civil"],
    ["landscape", "Landscape"],
    ["survey", "Survey"],
    ["architect", "Architectural"],
  ] as const) {
    if (hay.includes(k)) return d;
  }
  return null;
}

/** Order revisions within one sheet number. null = can't tell (mixed schemes): flag for review instead of guessing. */
export function compareRev(a: string, b: string): number | null {
  const A = a.trim().toUpperCase();
  const B = b.trim().toUpperCase();
  if (A === B) return 0;
  if (/^\d+$/.test(A) && /^\d+$/.test(B)) return Number(A) - Number(B);
  if (/^[A-Z]+$/.test(A) && /^[A-Z]+$/.test(B)) return A.length - B.length || (A < B ? -1 : 1);
  const pa = /^([A-Z]+)(\d+)$/.exec(A);
  const pb = /^([A-Z]+)(\d+)$/.exec(B);
  if (pa && pb && pa[1] === pb[1]) return Number(pa[2]) - Number(pb[2]);
  return null;
}

const normNo = (s: string) => s.toUpperCase().replace(/[\s._-]/g, "");

const titleWords = (t: string) => new Set(t.toUpperCase().match(/[A-Z0-9]+/g) ?? []);
/** Same drawing by title? Missing titles don't count against it; "DRAINAGE - GROUND FLOOR" matches "HYDRAULICS SERVICES DRAINAGE - GROUND FLOOR". */
function sameTitle(a: string | null, b: string | null) {
  if (!a || !b) return true;
  const A = titleWords(a);
  const B = titleWords(b);
  if (!A.size || !B.size) return true;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) >= 0.6;
}

/** Latest of a set of revisions, or null if any pair can't be ordered. */
function latestRev(revs: string[]): string | null {
  let latest: string | null = revs[0] ?? null;
  for (const r of revs.slice(1)) {
    const c = compareRev(r, latest!);
    if (c === null) return null;
    if (c > 0) latest = r;
  }
  return latest;
}

/**
 * Mark each copy of a sheet current, superseded or needs_review. Conservative on purpose:
 * - only confident reads can retire another copy; a shaky read that claims a newer revision gets checked, not believed
 * - copies with the same number but a different title may be a different drawing (renumbered, another consultant): checked, not superseded
 */
function applySupersession(project: string) {
  const rows = db.prepare("SELECT id, sheet_no, revision, confidence, title FROM sheets WHERE project = ? AND sheet_no IS NOT NULL").all(project) as {
    id: string;
    sheet_no: string;
    revision: string | null;
    confidence: string;
    title: string | null;
  }[];
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = normNo(r.sheet_no);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const set = db.prepare("UPDATE sheets SET status = ?, superseded_by = ? WHERE id = ?");
  for (const g of groups.values()) {
    const withRev = g.filter((r) => r.revision);
    const trusted = withRev.filter((r) => r.confidence !== "low");
    const revs = [...new Set(withRev.map((r) => r.revision!.toUpperCase()))];
    // Nothing confident and the copies disagree: can't tell which is current.
    const latest = trusted.length ? latestRev([...new Set(trusted.map((r) => r.revision!.toUpperCase()))]) : revs.length === 1 ? revs[0] : null;
    const top = latest ? (trusted.length ? trusted : withRev).find((r) => r.revision!.toUpperCase() === latest) : undefined;
    const doubt = new Set<string>();
    for (const r of g) {
      if (!top || !r.revision) {
        doubt.add(r.id);
        continue;
      }
      const c = compareRev(r.revision, latest!);
      if (c === null || c > 0) doubt.add(r.id);
      else if (!sameTitle(r.title, top.title)) (doubt.add(r.id), doubt.add(top.id));
    }
    for (const r of g) {
      if (doubt.has(r.id)) set.run("needs_review", null, r.id);
      else if (compareRev(r.revision!, latest!) === 0) set.run("current", null, r.id);
      else set.run("superseded", top!.id, r.id);
    }
  }
}

let indexing = false;
export async function processQueue() {
  if (indexing) return;
  indexing = true;
  try {
    for (;;) {
      const f = db.prepare("SELECT hash, path, name, project FROM drawing_files WHERE status = 'queued' ORDER BY added_at LIMIT 1").get() as
        | { hash: string; path: string; name: string; project: string }
        | undefined;
      if (!f) break;
      db.prepare("UPDATE drawing_files SET status = 'indexing' WHERE hash = ?").run(f.hash);
      bus.emit("drawings", { phase: "indexing", name: f.name, project: f.project });
      try {
        await indexFile(f);
        db.prepare("UPDATE drawing_files SET status = 'ready', indexed_at = ? WHERE hash = ?").run(nowIso(), f.hash);
        bus.emit("drawings", { phase: "ready", name: f.name, project: f.project });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.prepare("UPDATE drawing_files SET status = 'failed', error = ? WHERE hash = ?").run(msg.slice(0, 500), f.hash);
        audit("system", "drawings.index_failed", f.hash, { name: f.name, error: msg.slice(0, 300) });
        bus.emit("drawings", { phase: "failed", name: f.name, project: f.project, detail: msg });
      }
    }
  } finally {
    indexing = false;
  }
}

async function indexFile(f: { hash: string; path: string; name: string; project: string }) {
  const dataDir = path.join(INDEX, f.hash);
  const res = await pyIngest(f.path, dataDir);
  db.prepare("UPDATE drawing_files SET page_count = ? WHERE hash = ?").run(res.page_count, f.hash);
  const register = res.register ?? {};
  const regLookup = (no?: string) => (no ? Object.entries(register).find(([k]) => normNo(k) === normNo(no))?.[1] : undefined);

  const decided = await mapPool(res.pages, 3, (p) => decideFields(f, p, regLookup, dataDir));
  for (const [i, p] of res.pages.entries()) {
    const fields = decided[i];
    const id = newId("sht");
    db.prepare(
      `INSERT INTO sheets (id, file_hash, page, project, sheet_no, title, revision, discipline, read_path, source, confidence, status, title_block_box, width_pt, height_pt, data_dir, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      f.hash,
      p.page,
      f.project,
      fields.sheet_no,
      fields.title,
      fields.revision,
      fields.kind === "document" ? "Document" : disciplineOf(fields.sheet_no, fields.title, f.path),
      p.read_path,
      fields.source,
      fields.confidence,
      fields.kind === "document" ? "current" : "needs_review",
      JSON.stringify(p.title_block_box),
      p.width_pt,
      p.height_pt,
      dataDir,
      nowIso(),
    );
    db.prepare("INSERT INTO sheet_fts (sheet_id, sheet_no, title, body) VALUES (?, ?, ?, ?)").run(id, fields.sheet_no ?? "", fields.title ?? "", p.text);
  }
  applySupersession(f.project);
  audit("system", "drawings.indexed", f.hash, { name: f.name, project: f.project, pages: res.page_count });
}

/** Drop "titles" that are really a status stamp or a table header ("FOR COORDINATION", "BY: BY", "DRAWING"). */
function okTitle(t: string | null | undefined): string | null {
  const s = t?.trim();
  if (!s || s.replace(/[^A-Za-z]/g, "").length < 3 || /^[a-z]/.test(s)) return null;
  if (/^(by|date|rev(ision)?|description|amendments?|issue|status|scale|drawn|checked|title|drawing( title)?|sheet title)\b[\s:.]*$/i.test(s)) return null;
  if (/^(for (coordination|construction|tender|approval|information|review|comment)|preliminary|draft|not for construction|issued for\b.*|by:?\s*by:?)$/i.test(s)) return null;
  return s;
}

async function decideFields(
  f: { path: string; name: string },
  p: EnginePage,
  reg: (no?: string) => { title: string; revision?: string | null } | undefined,
  dataDir: string,
) {
  const fn = p.from_filename ?? {};
  const tb = p.from_title_block ?? {};
  // Brochures, specs, schedules and reports aren't drawing sheets: keep them searchable, skip the title-block read.
  // A4 with no sheet number is a document even if it has "Date" / "Project" labels; A3 only if it has no title-block labels.
  const longSide = Math.max(p.width_pt, p.height_pt);
  const labelsFound = !(p.title_block_box[0] === 0.6 && p.title_block_box[1] === 0.7);
  const doc = () => ({ sheet_no: null, title: f.name.replace(/\.pdf$/i, ""), revision: fn.revision ?? null, source: "document (not a drawing sheet)", confidence: "n/a", kind: "document" as const });
  if (!fn.sheet_no && !tb.sheet_no && (longSide < 900 || (longSide < 1100 && !labelsFound))) return doc();

  let sheet_no = fn.sheet_no ?? tb.sheet_no ?? null;
  // The cover sheet's drawing list beats the title-block text for titles (cleaner); never for revisions (it can lag).
  let title = okTitle(fn.title) ?? okTitle(reg(sheet_no ?? undefined)?.title) ?? okTitle(tb.title) ?? null;
  let revision = fn.revision ?? tb.revision ?? reg(sheet_no ?? undefined)?.revision ?? null;
  const sources: string[] = [];
  if (fn.sheet_no || fn.title || fn.revision) sources.push("file name");
  if (tb.sheet_no || tb.title || tb.revision) sources.push("title block text");
  if (!fn.title && reg(sheet_no ?? undefined)?.title) sources.push("cover drawing list");
  let confidence = sheet_no && revision && title ? (fn.sheet_no && tb.sheet_no && normNo(fn.sheet_no) !== normNo(tb.sheet_no) ? "low" : "high") : "low";

  // Anything missing, or a sheet with no usable text: let Claude read the title block.
  if (!sheet_no || !revision || !title || p.read_path !== "text") {
    try {
      const box = p.read_path === "text" ? p.title_block_box : [0.5, 0.55, 1, 1];
      const png = path.join(dataDir, `p${p.page}.titleblock.png`);
      await pyCrop(f.path, p.page, box, png, 1400);
      const v = await readTitleBlock(png, { file: f.name, sheet_no, title, revision });
      sources.push("Claude read the title block");
      if (!v.is_title_block && !sheet_no && !v.sheet_no) return doc();
      if (!sheet_no && v.sheet_no) sheet_no = v.sheet_no;
      if (!title) title = okTitle(v.title);
      if (!revision && v.revision) revision = v.revision;
      const disagree =
        (fn.revision && v.revision && fn.revision.toUpperCase() !== v.revision.toUpperCase()) ||
        (sheet_no && v.sheet_no && normNo(sheet_no) !== normNo(v.sheet_no));
      if (disagree) confidence = "low"; // two reads of the same sheet don't match: a person should check
      else confidence = sheet_no && revision ? (v.confidence === "high" ? "medium" : "low") : "low";
    } catch (err) {
      sources.push(`title block unreadable (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { sheet_no, title, revision, source: sources.join(" + ") || "none", confidence, kind: "sheet" as const };
}

/** Run fn over items with at most `limit` running at once, keeping order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ---------------- queries for the brain and the PC app ---------------- */

const SHEET_COLS = "s.*, f.path, f.name";

export function listProjects() {
  return db
    .prepare(
      `SELECT f.project, COUNT(DISTINCT f.hash) files, SUM(f.status = 'ready') ready, SUM(f.status IN ('queued','indexing')) pending, SUM(f.status = 'failed') failed,
              (SELECT COUNT(*) FROM sheets s WHERE s.project = f.project) sheets,
              (SELECT COUNT(*) FROM sheets s WHERE s.project = f.project AND s.status = 'needs_review') needs_review
       FROM drawing_files f GROUP BY f.project ORDER BY f.project`,
    )
    .all() as { project: string; files: number; ready: number; pending: number; failed: number; sheets: number; needs_review: number }[];
}

export function listSheets(o: { project?: string; discipline?: string; includeSuperseded?: boolean } = {}) {
  const where = ["1 = 1"];
  const args: string[] = [];
  if (o.project) (where.push("s.project = ?"), args.push(o.project));
  if (o.discipline) (where.push("lower(s.discipline) = lower(?)"), args.push(o.discipline));
  if (!o.includeSuperseded) where.push("s.status != 'superseded'");
  return db.prepare(`SELECT ${SHEET_COLS} FROM sheets s JOIN drawing_files f ON f.hash = s.file_hash WHERE ${where.join(" AND ")} ORDER BY s.project, s.sheet_no, s.page`).all(...args) as Sheet[];
}

/** Find one sheet by id, or by sheet number (prefers the current issue, and single-sheet PDFs over combined sets). */
export function findSheet(ref: string, project?: string): Sheet | undefined {
  const byId = db.prepare(`SELECT ${SHEET_COLS} FROM sheets s JOIN drawing_files f ON f.hash = s.file_hash WHERE s.id = ?`).get(ref) as Sheet | undefined;
  if (byId) return byId;
  const rows = (
    db.prepare(`SELECT ${SHEET_COLS}, f.page_count FROM sheets s JOIN drawing_files f ON f.hash = s.file_hash ${project ? "WHERE s.project = ?" : ""}`).all(...(project ? [project] : [])) as (Sheet & {
      page_count: number;
    })[]
  ).filter((s) => s.sheet_no && normNo(s.sheet_no) === normNo(ref));
  const rank = (s: Sheet & { page_count: number }) => (s.status === "current" ? 0 : s.status === "needs_review" ? 1 : 2) * 10 + (s.page_count === 1 ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b))[0];
}

type Word = [number, number, number, number, string];
async function words(s: Sheet): Promise<Word[]> {
  try {
    return JSON.parse(await readFile(path.join(s.data_dir, `p${s.page}.words.json`), "utf8")) as Word[];
  } catch {
    return [];
  }
}

/** A sheet's text as rows: words at the same height on the page, left to right (a schedule row is one line). */
function rowsOf(ws: Word[]) {
  const rows: Word[][] = [];
  for (const w of [...ws].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const r = rows.at(-1);
    if (r && Math.abs(r[0][1] - w[1]) < 0.004) r.push(w);
    else rows.push([w]);
  }
  return rows.map((r) => r.sort((a, b) => a[0] - b[0]).map((w) => w[4]));
}

/**
 * A schedule table's item-number column: a different value on every row, beside a type column that repeats
 * ("D04S 0033.1 ..." or "0033.1 D04S ..."). Null for sheets that aren't an item table (legends, notes).
 */
function keyColumn(rows: string[][]) {
  const table = rows.filter((r) => r.length >= 6);
  const col = (p: number) => table.map((r) => r[p]).filter((t) => t && /\d/.test(t));
  const repeats = (p: number) => col(p).length >= 5 && new Set(col(p)).size <= col(p).length * 0.6;
  for (let p = 0; p < 3; p++) {
    const c = col(p);
    if (c.length >= 5 && new Set(c).size >= c.length * 0.9 && (repeats(p - 1) || repeats(p + 1))) return p;
  }
  return null;
}

/**
 * Items looked up in a set's schedule sheets, row for row. fromPlan takes every item number printed on that plan, so
 * "which doors are in area 1" is exact. Type codes (D04S) repeat all over the building, so they only answer an explicit
 * "every D04S" lookup and never pick items from a plan.
 */
export async function scheduleRows(project: string, o: { numbers?: string[]; fromPlan?: Sheet; schedule?: string }) {
  const want = (o.schedule ?? "schedule").toLowerCase();
  const candidates = listSheets({ project }).filter((s) => s.discipline !== "Document" && (s.title ?? "").toLowerCase().includes(want));
  type Row = { sheet: Sheet; row: string };
  const items = new Map<string, Row[]>();
  const types = new Map<string, Row[]>();
  const add = (m: Map<string, Row[]>, k: string, r: Row) => m.set(k, [...(m.get(k) ?? []), r]);
  const used: Sheet[] = [];
  for (const s of candidates) {
    // The revision table looks like a table too ("A 50% Tender Issue 05/04/2024"); its rows carry a date, item rows don't.
    const rows = rowsOf(await words(s)).filter((r) => !r.some((t) => /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(t)));
    const k = keyColumn(rows);
    if (k === null) continue;
    used.push(s);
    for (const r of rows) {
      if (r.length < 6 || !r[k] || !/\d/.test(r[k])) continue;
      const row = { sheet: s, row: r.join(" ") };
      add(items, r[k], row);
      for (const t of new Set([r[k - 1], r[k + 1]])) if (t && /\d/.test(t)) add(types, t, row);
    }
  }
  const numbers = o.fromPlan ? [...new Set((await words(o.fromPlan)).map((w) => w[4]).filter((t) => items.has(t)))] : (o.numbers ?? []);
  let budget = 200; // rows returned, so a broad type lookup can't flood the answer
  const found = numbers.map((n) => {
    const rows = (items.get(n) ?? types.get(n) ?? []).slice(0, Math.max(0, budget));
    budget -= rows.length;
    return { number: n, rows: rows.map((r) => ({ sheet: describeSheet(r.sheet), row: r.row })) };
  });
  const twice = numbers.filter((n) => (items.get(n)?.length ?? 0) > 1);
  return {
    schedules: used.map(describeSheet),
    not_tables: candidates.filter((s) => !used.includes(s)).map(describeSheet),
    listed_twice: twice.length ? `${twice.join(", ")}: the same number is on more than one row. Tell the user both rows; it may need an RFI.` : undefined,
    found: found.filter((f) => f.rows.length),
    not_found: found.filter((f) => !f.rows.length).map((f) => f.number),
    truncated: budget < 0 || undefined,
  };
}

/** Where a phrase appears on a sheet: boxes in normalised page coordinates. */
export async function locate(s: Sheet, phrase: string, max = 6) {
  const ws = await words(s);
  const toks = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  const hits: { text: string; box: number[] }[] = [];
  for (let i = 0; i < ws.length && hits.length < max; i++) {
    if (!ws[i][4].toLowerCase().includes(toks[0])) continue;
    let j = 1;
    const run = [ws[i]];
    for (; j < toks.length && i + j < ws.length; j++) {
      if (!ws[i + j][4].toLowerCase().includes(toks[j])) break;
      run.push(ws[i + j]);
    }
    if (j < toks.length) continue;
    hits.push({
      text: run.map((w) => w[4]).join(" "),
      box: [Math.min(...run.map((w) => w[0])), Math.min(...run.map((w) => w[1])), Math.max(...run.map((w) => w[2])), Math.max(...run.map((w) => w[3]))].map((v) =>
        Number(v.toFixed(4)),
      ),
    });
  }
  return hits;
}

export async function search(q: string, o: { project?: string; includeSuperseded?: boolean; limit?: number } = {}) {
  const terms = q
    .replace(/["']/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 8);
  if (!terms.length) return [];
  const match = terms.map((t) => `"${t}"`).join(" AND ");
  const rows = db
    .prepare(
      `SELECT s.id, snippet(sheet_fts, 3, '[', ']', ' … ', 14) snip FROM sheet_fts JOIN sheets s ON s.id = sheet_fts.sheet_id
       WHERE sheet_fts MATCH ? ${o.project ? "AND s.project = ?" : ""} ${o.includeSuperseded ? "" : "AND s.status != 'superseded'"}
       ORDER BY rank LIMIT ?`,
    )
    .all(match, ...(o.project ? [o.project] : []), o.limit ?? 8) as { id: string; snip: string }[];
  const out = [];
  for (const r of rows) {
    const s = findSheet(r.id)!;
    out.push({
      sheet_id: s.id,
      sheet_no: s.sheet_no,
      title: s.title,
      revision: s.revision,
      status: s.status,
      project: s.project,
      snippet: r.snip,
      found_at: (await locate(s, terms[0], 3)).map((h) => h.box),
    });
  }
  return out;
}

const REGIONS: Record<string, number[]> = {
  whole: [0, 0, 1, 1],
  title_block: [0.55, 0.62, 1, 1],
  top_left: [0, 0, 0.55, 0.55],
  top_right: [0.45, 0, 1, 0.55],
  bottom_left: [0, 0.45, 0.55, 1],
  bottom_right: [0.45, 0.45, 1, 1],
  centre: [0.2, 0.2, 0.8, 0.8],
};

/** Work out a crop box from a named region, an explicit box, or text to centre on. */
export async function regionFor(s: Sheet, o: { region?: string; box?: number[]; around?: string; close?: boolean }) {
  if (o.box?.length === 4) return o.box;
  if (o.around) {
    const hit = (await locate(s, o.around, 1))[0];
    if (hit) {
      const mx = o.close ? 0.07 : 0.16;
      const my = o.close ? 0.06 : 0.13;
      return [hit.box[0] - mx, hit.box[1] - my, hit.box[2] + mx, hit.box[3] + my];
    }
  }
  if (o.region === "title_block" && s.title_block_box) return JSON.parse(s.title_block_box) as number[];
  return REGIONS[o.region ?? "whole"] ?? REGIONS.whole;
}

export async function cropSheet(s: Sheet, box: number[], maxPx = 1568) {
  await mkdir(CROPS, { recursive: true });
  const id = newId("crop");
  const out = path.join(CROPS, `${id}.png`);
  const r = await pyCrop(s.path!, s.page, box, out, maxPx);
  db.prepare("INSERT INTO drawing_crops (id, sheet_id, box, path, created_at) VALUES (?, ?, ?, ?, ?)").run(id, s.id, JSON.stringify(box), out, nowIso());
  return { id, path: out, width: r.width, height: r.height };
}

export function cropPath(id: string) {
  if (!/^crop_[a-f0-9]{16}$/.test(id)) return undefined;
  const row = db.prepare("SELECT path FROM drawing_crops WHERE id = ?").get(id) as { path: string } | undefined;
  return row && existsSync(row.path) ? row.path : undefined;
}

export function describeSheet(s: Sheet) {
  const status = s.status === "current" ? "current issue" : s.status === "superseded" ? "SUPERSEDED" : "revision not confirmed";
  return `${s.sheet_no ?? "(no sheet number)"} ${s.title ?? ""} · Rev ${s.revision ?? "?"} · ${status} · ${s.project}`;
}

/* ---------------- background watcher ---------------- */

export function startDrawingWatcher() {
  const run = async () => {
    try {
      const added = await scanForNew();
      if (added) bus.emit("drawings", { phase: "queued", name: `${added} file(s)`, project: "" });
      await processQueue();
    } catch (err) {
      console.warn("[drawings]", err instanceof Error ? err.message : err);
    }
  };
  // Anything stuck mid-index from a previous run gets another go.
  db.prepare("UPDATE drawing_files SET status = 'queued' WHERE status = 'indexing'").run();
  setTimeout(run, 3000);
  setInterval(run, 60_000);
}

export async function drawingsDirInfo() {
  const st = await stat(DRAWINGS_DIR).catch(() => undefined);
  return { dir: DRAWINGS_DIR, inbox: INBOX, exists: !!st };
}
