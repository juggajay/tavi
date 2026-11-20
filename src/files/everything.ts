// Everything the assistant holds, as one list for the desktop's file viewer (Stage 15.1): drawings by job, shop drawings
// with their revisions, 3D models, sketches, photos, documents, reference books and makers' guides, things it made,
// files from the other computer, and uploads. Plain groups, not folders, taken from what is actually in the stores.
//
// Only ever read. Nothing here creates, changes, moves or deletes a file; a name the owner gives an entry ("rename") is a
// label kept in the database, and the file keeps its own name. A preview is never kept either: only "tell the assistant
// about this" and "pin" make a real item, the way the assistant showing it would.
import { statSync } from "node:fs";
import path from "node:path";
import { db, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { createItem, getItem, previewItem, touchItem } from "../store/items.js";
import { allDrawings, getRevision, revisionsOf, setRevisionItem, type Drawing } from "../store/shopdrawings.js";
import { payloadFor } from "../drawings/shop.js";
import { getPage, listBooks, sourceLine, type Book } from "../reference/library.js";
import { dims } from "../reference/pages.js";
import { isTextRef } from "../reference/design.js";
import { DRAWINGS_DIR } from "../drawings/library.js";
import { REMOTE_DIR } from "./library.js";
import type { Item, ItemKind } from "../shared/protocol.js";

export type GroupId = "drawings" | "shop" | "models" | "sketches" | "photos" | "documents" | "books" | "guides" | "made" | "remote" | "uploads";
/** The groups, in the order the viewer shows them. Only those with something in them are listed. */
export const GROUPS: { id: GroupId; label: string }[] = [
  { id: "drawings", label: "Drawings" },
  { id: "shop", label: "Shop drawings" },
  { id: "models", label: "3D models" },
  { id: "sketches", label: "Sketches" },
  { id: "photos", label: "Photos" },
  { id: "documents", label: "Documents" },
  { id: "books", label: "Reference books" },
  { id: "guides", label: "Makers' guides" },
  { id: "made", label: "Things made" },
  { id: "remote", label: "From the other computer" },
  { id: "uploads", label: "Uploads" },
];
const GROUP_IDS = new Set(GROUPS.map((g) => g.id));
export const isGroup = (g: unknown): g is GroupId => typeof g === "string" && GROUP_IDS.has(g as GroupId);

/** How a selected entry is shown: one of the viewers the apps already have, or the plain panel. */
export type Viewer = "sheet" | "shopdrawing" | "model" | "sketch" | "image" | "doc" | "table" | "reference" | "note" | "plain";

export type Entry = {
  id: string;
  group: GroupId;
  /** The owner's label if he gave one, else its own name. */
  name: string;
  /** Its own name (the file's, or the drawing's), when a label is showing instead. */
  own?: string;
  kind: string;
  job: string;
  at: string;
  size: number | null;
  viewer: Viewer;
  /** Sheets, pages or parts it opens to (more than one). */
  pages?: number;
  /** One short line under the name (sheet numbers, revisions, where a search found it). */
  sub?: string;
  /** Has a file behind it that "Save a copy" can hand over. */
  file: boolean;
};
type Built = Entry & { text: string };

/* ---------------- labels ("rename"): kept in the settings table, never on disk ---------------- */

const LABELS = "file_labels";
function labels(): Record<string, string> {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(LABELS) as { value: string } | undefined;
  try {
    return r ? (JSON.parse(r.value) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
/** A name for an entry the owner chose. Empty puts its own name back. The file itself is never renamed. */
export function setLabel(id: string, label: string) {
  if (!findEntry(id)) throw new Error("I don't have that one any more.");
  const clean = label.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const all = labels();
  if (clean) all[id] = clean;
  else delete all[id];
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(LABELS, JSON.stringify(all));
  audit("user", "file.labelled", id, { label: clean || null });
  return findEntry(id)!;
}

/* ---------------- building the list ---------------- */

const lower = (p: string) => path.resolve(p).toLowerCase();
const under = (file: string, dir: string) => {
  const rel = path.relative(lower(dir), lower(file));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};
const sizeCache = new Map<string, number | null>();
/** A file's size when the store didn't keep it (drawings dropped in the folder, shop drawing PDFs), remembered. */
function sizeOf(file: string) {
  if (!sizeCache.has(file)) {
    try {
      sizeCache.set(file, statSync(file).size);
    } catch {
      sizeCache.set(file, null);
    }
  }
  return sizeCache.get(file)!;
}
const iso = (ms: number | null | undefined, fallback: string | null | undefined) => (ms ? new Date(ms).toISOString() : (fallback ?? nowIso()));

const DOC_KIND: Record<string, string> = { docx: "Word", xlsx: "Excel", eml: "Email", old: "Old format" };
const MADE_KIND: Record<string, string> = { glb: "3D file (GLB)", stl: "3D file (STL)", usdz: "3D file (USDZ)", blend: "Blender file", mp4: "Video", pdf: "PDF" };
const TEXT_KIND: Record<string, string> = { ".csv": "Spreadsheet (CSV)", ".md": "Text", ".txt": "Text", ".json": "Text", ".log": "Text" };

type DocRow = { id: string; folder_id: string | null; project: string | null; path: string; name: string; type: string; mtime: number | null; size: number | null; parts: number; meta_json: string | null; skipped_reason: string | null; indexed_at: string; fkind: string | null };
type PdfRow = { hash: string; path: string; name: string; project: string; status: string; error: string | null; added_at: string; mtime: number | null; size: number | null; fkind: string | null; sheets: number; numbers: string | null };
type ItemRow = { id: string; kind: "model" | "sketch"; title: string; source: string; payload_json: string; created_at: string };

const APP_FOLDERS = new Set(["photos", "sketches", "models"]);
/** The computer a brought file came from: the first folder under the inbox for it. */
const computerOf = (file: string) => path.relative(REMOTE_DIR, file).split(path.sep)[0] || "The other computer";

function build(): Built[] {
  const out: Built[] = [];
  const inbox = path.join(DRAWINGS_DIR, "inbox");
  const where = (file: string, fkind: string | null): GroupId | null => (fkind === "remote" || under(file, REMOTE_DIR) ? "remote" : under(file, inbox) ? "uploads" : null);

  // Files it has read: Word, Excel, text, emails, photos, sketches drawn on the pad, and the files it made.
  const docs = db.prepare("SELECT d.id, d.folder_id, d.project, d.path, d.name, d.type, d.mtime, d.size, d.parts, d.meta_json, d.skipped_reason, d.indexed_at, f.kind AS fkind FROM docs d LEFT JOIN folders f ON f.id = d.folder_id").all() as DocRow[];
  for (const d of docs) {
    let meta: { kind?: string; by?: string; drawing?: string; format?: string; item?: string } = {};
    try {
      meta = d.meta_json ? JSON.parse(d.meta_json) : {};
    } catch {
      /* no meta */
    }
    if (meta.drawing) continue; // a shop drawing's PDF: it's under Shop drawings, with its revisions
    if (meta.kind === "render-jpg") continue; // the small copy of a render, for the phone; the render itself is listed
    const ext = path.extname(d.name).toLowerCase();
    const place = where(d.path, d.fkind);
    let group: GroupId;
    let kind: string;
    if (d.type === "made") {
      group = "made";
      kind = meta.kind === "proposal" ? "Proposal page (PDF)" : (MADE_KIND[meta.format ?? ext.slice(1)] ?? "A file I made");
    } else if (d.type === "image") {
      if (meta.kind === "sketch") (group = "sketches"), (kind = "Your sketch");
      else if (meta.by === "assistant") (group = "made"), (kind = meta.kind === "render" ? "Render" : meta.kind === "model-picture" ? "Picture of a model" : "Picture");
      else (group = "photos"), (kind = "Photo");
    } else {
      group = "documents";
      kind = d.type === "text" ? (TEXT_KIND[ext] ?? "Text") : d.type === "old" ? `Old format (${ext.slice(1).toUpperCase()})` : (DOC_KIND[d.type] ?? d.type);
    }
    const readable = !d.skipped_reason && (d.type === "image" || d.parts > 0);
    const viewer: Viewer = !readable || d.type === "made" || d.type === "old" ? "plain" : d.type === "image" ? "image" : d.type === "xlsx" ? "table" : "doc";
    out.push({
      id: d.id,
      group: place ?? group,
      name: d.name,
      kind,
      // photos/, sketches/ and models/ are the app's own folders, not jobs
      job: place === "remote" ? computerOf(d.path) : d.fkind === "managed" && APP_FOLDERS.has((d.project ?? "").toLowerCase()) ? "" : (d.project ?? ""),
      at: iso(d.mtime, d.indexed_at),
      size: d.size,
      viewer,
      ...(viewer !== "plain" && viewer !== "image" && d.parts > 1 ? { pages: d.parts } : {}),
      ...(d.skipped_reason ? { sub: d.skipped_reason } : {}),
      file: true,
      text: `${d.name} ${d.project ?? ""} ${kind}`,
    });
  }

  // Drawing sets (PDFs read sheet by sheet).
  const pdfs = db
    .prepare(
      `SELECT f.hash, f.path, f.name, f.project, f.status, f.error, f.added_at, f.mtime, f.size, fo.kind AS fkind,
              (SELECT COUNT(*) FROM sheets s WHERE s.file_hash = f.hash) AS sheets,
              (SELECT group_concat(COALESCE(s.sheet_no, ''), ' ') FROM (SELECT sheet_no FROM sheets WHERE file_hash = f.hash ORDER BY page) s) AS numbers
       FROM drawing_files f LEFT JOIN folders fo ON fo.id = f.folder_id`,
    )
    .all() as PdfRow[];
  for (const f of pdfs) {
    const place = where(f.path, f.fkind);
    const ready = f.status === "ready" && f.sheets > 0;
    const nums = (f.numbers ?? "").split(" ").filter(Boolean);
    const named = nums.every((n) => f.name.includes(n)); // "A-101 Ground floor plan.pdf": the number is already there
    out.push({
      id: `dwg_${f.hash}`,
      group: place ?? "drawings",
      name: f.name,
      kind: !ready ? "Drawing (PDF)" : f.sheets > 1 ? `Drawing set, ${f.sheets} sheets` : "Drawing",
      job: place === "remote" ? computerOf(f.path) : f.project,
      at: iso(f.mtime, f.added_at),
      size: f.size ?? sizeOf(f.path),
      viewer: ready ? "sheet" : "plain",
      ...(ready && f.sheets > 1 ? { pages: f.sheets } : {}),
      ...(nums.length && !named ? { sub: nums.length > 6 ? `${nums.slice(0, 6).join(", ")} and ${nums.length - 6} more` : nums.join(", ") } : f.status === "failed" ? { sub: f.error ?? "I couldn't read it." } : !ready ? { sub: "Still reading it." } : {}),
      file: true,
      text: `${f.name} ${f.project} ${nums.join(" ")}`,
    });
  }

  // Shop drawings: one row a drawing, its newest revision, every revision named.
  for (const d of allDrawings()) {
    const revs = revisionsOf(d.id);
    const newest = revs.at(-1);
    if (!newest) continue;
    out.push({
      id: d.id,
      group: "shop",
      name: `${d.number} ${d.title}`,
      kind: `Shop drawing, Rev ${newest.rev}`,
      job: d.project,
      at: d.updated_at,
      size: sizeOf(newest.pdf),
      viewer: "shopdrawing",
      sub: `${d.status === "PRELIMINARY" ? "Preliminary" : d.status === "FOR APPROVAL" ? "For approval" : "For construction"} · ${revs.length === 1 ? "1 revision" : `revisions ${revs.map((r) => r.rev).join(", ")}`}${d.client ? ` · for ${d.client}` : ""}`,
      file: true,
      text: `${d.number} ${d.title} ${d.project} ${d.client} ${d.job} ${revs.map((r) => r.text).join(" ")}`,
    });
  }

  // 3D models and the assistant's sketches: kept as items.
  for (const it of db.prepare("SELECT id, kind, title, source, payload_json, created_at FROM items WHERE kind IN ('model','sketch')").all() as ItemRow[]) {
    let words = "";
    try {
      const p = JSON.parse(it.payload_json) as { parts?: { name: string }[]; note?: string; shapes?: { text?: string }[] };
      words = [...(p.parts ?? []).map((x) => x.name), ...(p.shapes ?? []).map((s) => s.text ?? ""), p.note ?? ""].join(" ");
    } catch {
      /* just the title */
    }
    const model = it.kind === "model";
    const parts = model ? (JSON.parse(it.payload_json) as { parts?: unknown[] }).parts?.length ?? 0 : 0;
    out.push({
      id: it.id,
      group: model ? "models" : "sketches",
      name: it.title,
      kind: model ? `3D model, ${parts} ${parts === 1 ? "part" : "parts"}` : "Sketch I drew",
      job: "",
      at: it.created_at,
      size: null,
      viewer: model ? "model" : "sketch",
      ...(model && it.source && it.source !== "3D model" ? { sub: it.source.replace(/^3D model · /, "Made by the ") + (it.source.startsWith("3D model · ") ? " recipe" : "") } : {}),
      file: false,
      text: `${it.title} ${it.source} ${words}`,
    });
  }

  // The reference shelf: books (and the notes beside them) and makers' guides.
  for (const b of listBooks()) {
    const guide = b.kind === "guide";
    const note = b.pages === 0 && !!b.note;
    const ready = b.state === "ready" && (b.pages > 0 || note);
    out.push({
      id: b.id,
      group: guide ? "guides" : "books",
      name: guide ? b.title || b.product || b.name : b.title || b.name,
      ...(guide || (b.title && b.title !== b.name) ? { own: b.name } : {}),
      kind: note
        ? "Shelf note"
        : guide
          ? `Maker's guide${b.doc_date ? `, ${b.doc_date.slice(0, 4)}` : ""}`
          : b.kind === "design"
            ? `Design reference${b.doc_version ? `, ${b.doc_version}` : ""}`
            : b.kind === "code"
              ? `Building code${b.doc_version ? `, ${b.doc_version}` : ""}`
              : `Reference book${b.pages ? `, ${b.pages.toLocaleString("en-AU")} ${b.pages === 1 ? "page" : "pages"}` : ""}`,
      job: guide ? (b.maker ?? "") : b.shelf,
      at: iso(b.mtime, b.indexed_at),
      size: b.size,
      // a design reference read by section (20.1) opens as text, a section at a time; a PDF opens as its pages
      viewer: !ready ? "plain" : note ? "note" : b.kind === "design" && isTextRef(b.path) ? "doc" : "reference",
      ...(ready && b.pages > 1 ? { pages: b.pages } : {}),
      ...(b.state === "failed" ? { sub: b.error ?? "I couldn't read it." } : !ready ? { sub: "Still reading it." } : {}),
      file: true,
      text: `${b.name} ${b.title} ${b.shelf} ${b.maker ?? ""} ${b.product ?? ""}`,
    });
  }

  const named = labels();
  for (const e of out) {
    const label = named[e.id];
    if (label && label !== e.name) {
      e.own = e.own ?? e.name;
      e.name = label;
      e.text += ` ${label}`;
    }
    e.text = `${e.text} ${e.name} ${e.job} ${e.kind}`.toLowerCase();
  }
  return out;
}

/* ---------------- searching ---------------- */

const words = (q: string) =>
  q
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}.'-]/gu, ""))
    .filter((w) => w.length > 0);
const ftsQuery = (ws: string[]) =>
  ws
    .filter((w) => w.length > 1)
    .map((w) => `"${w.replace(/"/g, "")}"*`)
    .join(" ");

type Hit = { n: number; where: string };
/** Entries whose indexed text has every word: the files' words, the drawing sheets' words, the books' pages. */
function textHits(ws: string[]): Map<string, Hit> {
  const hits = new Map<string, Hit>();
  const q = ftsQuery(ws);
  if (!q) return hits;
  const run = <T>(sql: string): T[] => {
    try {
      return db.prepare(sql).all(q) as T[];
    } catch {
      return []; // a query FTS can't parse finds nothing, rather than failing the list
    }
  };
  for (const r of run<{ doc_id: string; n: number; label: string | null; snip: string }>("SELECT doc_id, n, label, snippet(doc_fts, 4, '', '', '…', 8) AS snip FROM doc_fts WHERE doc_fts MATCH ? ORDER BY rank LIMIT 5000"))
    if (!hits.has(r.doc_id)) hits.set(r.doc_id, { n: Math.max(0, r.n), where: r.snip ? `“${r.snip.trim()}”` : (r.label ?? "") });
  for (const r of run<{ file_hash: string; idx: number; sheet_no: string | null; snip: string }>(
    `SELECT s.file_hash, (SELECT COUNT(*) FROM sheets x WHERE x.file_hash = s.file_hash AND x.page < s.page) AS idx, s.sheet_no, snippet(sheet_fts, 3, '', '', '…', 8) AS snip
     FROM sheet_fts f JOIN sheets s ON s.id = f.sheet_id WHERE sheet_fts MATCH ? ORDER BY rank LIMIT 5000`,
  )) {
    const id = `dwg_${r.file_hash}`;
    if (!hits.has(id)) hits.set(id, { n: r.idx, where: `${r.sheet_no ? `${r.sheet_no}: ` : ""}${r.snip ? `“${r.snip.trim()}”` : ""}` });
  }
  for (const r of run<{ book_id: string; page: number; snip: string }>("SELECT book_id, page, snippet(ref_fts, 3, '', '', '…', 8) AS snip FROM ref_fts WHERE ref_fts MATCH ? ORDER BY rank LIMIT 5000"))
    if (!hits.has(r.book_id)) hits.set(r.book_id, { n: r.page - 1, where: `page ${r.page}${r.snip ? `: “${r.snip.trim()}”` : ""}` });
  return hits;
}

export type Sort = "name" | "kind" | "job" | "date" | "size" | "best";
export type ListOpts = { group?: GroupId | null; job?: string | null; q?: string | null; sort?: Sort; dir?: "asc" | "desc"; offset?: number; limit?: number };
export type Listing = {
  groups: { id: GroupId; label: string; count: number }[];
  jobs: { job: string; count: number }[];
  total: number;
  sort: Sort;
  dir: "asc" | "desc";
  entries: (Entry & { hit?: { n: number; where: string } })[];
};

const collate = new Intl.Collator("en-AU", { numeric: true, sensitivity: "base" });

/** The viewer's list: one group (or all), one job, the words searched for, sorted, a page at a time. */
export function listEverything(o: ListOpts = {}): Listing {
  const all = build();
  const ws = words(o.q ?? "");
  const hits = ws.length ? textHits(ws) : new Map<string, Hit>();
  // Every word in its name, label, job or kind; or every word in the text the app has read from it.
  const named = (e: Built) => ws.every((w) => e.text.includes(w));
  const found = ws.length ? all.filter((e) => named(e) || hits.has(e.id)) : all;
  const groups = GROUPS.map((g) => ({ ...g, count: found.filter((e) => e.group === g.id).length })).filter((g) => all.some((e) => e.group === g.id));
  const inGroup = o.group ? found.filter((e) => e.group === o.group) : found;
  const jobsMap = new Map<string, number>();
  for (const e of inGroup) if (e.job) jobsMap.set(e.job, (jobsMap.get(e.job) ?? 0) + 1);
  const jobs = [...jobsMap].map(([job, count]) => ({ job, count })).sort((a, b) => collate.compare(a.job, b.job));
  const rows = o.job ? inGroup.filter((e) => e.job.toLowerCase() === o.job!.toLowerCase()) : inGroup;
  const sort: Sort = o.sort ?? (ws.length ? "best" : "date");
  const dir = o.dir ?? (sort === "date" || sort === "size" ? "desc" : "asc");
  const by: Record<Sort, (a: Built, b: Built) => number> = {
    name: (a, b) => collate.compare(a.name, b.name),
    kind: (a, b) => collate.compare(a.kind, b.kind) || collate.compare(a.name, b.name),
    job: (a, b) => collate.compare(a.job || "~", b.job || "~") || collate.compare(a.name, b.name),
    date: (a, b) => a.at.localeCompare(b.at),
    size: (a, b) => (a.size ?? -1) - (b.size ?? -1),
    best: (a, b) => Number(!named(a)) - Number(!named(b)) || b.at.localeCompare(a.at),
  };
  const sorted = [...rows].sort((a, b) => (dir === "desc" && sort !== "best" ? -1 : 1) * by[sort](a, b));
  const offset = Math.max(0, o.offset ?? 0);
  const limit = Math.min(500, Math.max(1, o.limit ?? 100));
  // where the words were found inside it, when it wasn't by its name
  const page = sorted.slice(offset, offset + limit).map((e) => {
    const hit = ws.length && !named(e) ? hits.get(e.id) : undefined;
    const { text: _text, ...rest } = e;
    return hit ? { ...rest, hit } : rest;
  });
  return { groups, jobs, total: sorted.length, sort, dir, entries: page };
}

/** One entry by id (labels applied), or null. */
export function findEntry(id: string): Entry | null {
  const e = build().find((x) => x.id === id);
  if (!e) return null;
  const { text: _t, ...rest } = e;
  return rest;
}

/** The file behind an entry, for "Save a copy": its path and the name to save it as. Null when there's none. */
export function fileFor(id: string): { path: string; name: string } | null {
  if (/^doc_[a-f0-9]{16}$/.test(id)) {
    const d = db.prepare("SELECT path, name FROM docs WHERE id = ?").get(id) as { path: string; name: string } | undefined;
    return d ?? null;
  }
  if (/^dwg_[a-f0-9]{64}$/.test(id)) {
    const f = db.prepare("SELECT path, name FROM drawing_files WHERE hash = ?").get(id.slice(4)) as { path: string; name: string } | undefined;
    return f ?? null;
  }
  if (/^sd_[a-f0-9]{8}$/.test(id)) {
    const r = revisionsOf(id).at(-1);
    return r ? { path: r.pdf, name: path.basename(r.pdf) } : null;
  }
  if (/^ref_[a-f0-9]{12}$/.test(id)) {
    const b = listBooks().find((x) => x.id === id);
    return b ? { path: b.path, name: b.name } : null;
  }
  return null;
}

/* ---------------- previews ---------------- */

export type Preview = {
  entry: Entry;
  /** What the pane shows. Its id is pv_… unless it is an item the assistant already showed (a model, a sketch). */
  item: Item | null;
  /** Sheets, pages or parts: which one this is (from 1) and how many. */
  pages?: { n: number; total: number; unit: "sheet" | "page" | "part" };
  /** For kinds with no viewer: what it is, in plain words. */
  plain?: { badge: string; what: string; lines: string[] };
  /** The model a file was made from, when that model is still kept (a GLB, a render). */
  from_model?: string;
  /** A shop drawing's revisions, newest last, and which one is showing. */
  revisions?: { rev: string; date: string; text: string }[];
  rev?: string;
};

type Made = { kind: ItemKind; title: string; source: string; payload: unknown };

/** What an entry looks like as an item, at sheet / page / part n (from 0). Null for the plain panel. */
async function itemOf(e: Entry, n: number, rev?: string): Promise<{ made: Made | null; real?: Item; pages?: Preview["pages"]; revisions?: Preview["revisions"]; rev?: string; plain?: Preview["plain"]; from_model?: string }> {
  const id = e.id;
  if (id.startsWith("itm_")) {
    const it = getItem(id);
    return it ? { made: null, real: it } : { made: null, plain: { badge: "?", what: "I don't keep this one any more.", lines: [] } };
  }
  if (id.startsWith("dwg_")) {
    const sheets = db.prepare("SELECT id, sheet_no, title, revision, status, project, width_pt, height_pt FROM sheets WHERE file_hash = ? ORDER BY page").all(id.slice(4)) as { id: string; sheet_no: string | null; title: string | null; revision: string | null; status: string; project: string; width_pt: number | null; height_pt: number | null }[];
    if (!sheets.length) return { made: null, plain: plainFor(e) };
    const i = Math.min(Math.max(0, n), sheets.length - 1);
    const s = sheets[i];
    return {
      made: {
        kind: "sheet",
        title: [s.sheet_no, s.title].filter(Boolean).join(" ") || e.name,
        source: `${e.name} · ${s.project}${s.status === "superseded" ? " · superseded" : ""}`,
        payload: { sheet_id: s.id, sheet_no: s.sheet_no, title: s.title, revision: s.revision, status: s.status, project: s.project, aspect: s.width_pt && s.height_pt ? s.width_pt / s.height_pt : Math.SQRT2, marks: [], view: [0, 0, 1, 1] },
      },
      ...(sheets.length > 1 ? { pages: { n: i + 1, total: sheets.length, unit: "sheet" as const } } : {}),
    };
  }
  if (id.startsWith("sd_")) {
    const d = allDrawings().find((x) => x.id === id) as Drawing | undefined;
    const revs = d ? revisionsOf(d.id) : [];
    const r = (rev && revs.find((x) => x.rev === rev)) || revs.at(-1);
    if (!d || !r) return { made: null, plain: plainFor(e) };
    return {
      made: { kind: "shopdrawing", title: d.title, source: `Shop drawing ${d.number} ${r.rev} · ${r.sheets.length} sheets`, payload: payloadFor(d, r) },
      revisions: revs.map((x) => ({ rev: x.rev, date: x.date, text: x.text })),
      rev: r.rev,
    };
  }
  if (id.startsWith("ref_")) {
    const b = listBooks().find((x) => x.id === id) as Book | undefined;
    if (!b || e.viewer === "plain") return { made: null, plain: plainFor(e) };
    if (e.viewer === "note") return { made: { kind: "note", title: e.name, source: `Shelf note · ${b.shelf || "reference shelf"}`, payload: { rows: [], text: (b.note ?? "").slice(0, 4000) } } };
    if (e.viewer === "doc") {
      const part = Math.min(Math.max(1, n + 1), b.pages);
      const p = getPage(b.id, part);
      if ("error" in p) return { made: null, plain: plainFor(e) };
      return {
        made: { kind: "doc", title: e.name, source: sourceLine(p), payload: { file_id: b.id, name: b.title || b.name, part_label: p.heading, text: p.text.slice(0, 12_000), more: part < b.pages } },
        ...(b.pages > 1 ? { pages: { n: part, total: b.pages, unit: "part" as const } } : {}),
      };
    }
    const page = Math.min(Math.max(1, n + 1), b.pages);
    const d = await dims(b, page);
    return {
      made: { kind: "reference", title: e.name, source: `${b.kind === "guide" ? b.maker || "Maker's guide" : b.shelf || "Reference book"} · page ${page}`, payload: { book_id: b.id, page, printed: null, aspect: d.w / d.h, marks: [], view: [0, 0, 1, 1] } },
      ...(b.pages > 1 ? { pages: { n: page, total: b.pages, unit: "page" as const } } : {}),
    };
  }
  if (id.startsWith("doc_")) {
    const d = db.prepare("SELECT id, name, project, type, parts, meta_json FROM docs WHERE id = ?").get(id) as { id: string; name: string; project: string; type: string; parts: number; meta_json: string | null } | undefined;
    if (!d) return { made: null, plain: plainFor(e) };
    const meta = d.meta_json ? (JSON.parse(d.meta_json) as { w?: number; h?: number; item?: string }) : {};
    const fromModel = meta.item && getItem(meta.item)?.kind === "model" ? meta.item : undefined;
    if (e.viewer === "plain") return { made: null, plain: plainFor(e), from_model: fromModel };
    const source = e.job || d.project || "";
    if (e.viewer === "image") return { made: { kind: "image", title: e.name, source, payload: { src: `/api/files/${d.id}/image-2048.jpg`, w: meta.w ?? 1600, h: meta.h ?? 1200, alt: d.name } }, from_model: fromModel };
    const part = Math.min(Math.max(0, n), Math.max(0, d.parts - 1));
    const p = db.prepare("SELECT n, label, text, grid_json FROM doc_parts WHERE doc_id = ? AND n = ?").get(d.id, part) as { n: number; label: string | null; text: string; grid_json: string | null } | undefined;
    if (!p) return { made: null, plain: plainFor(e) };
    const pages = d.parts > 1 ? { pages: { n: part + 1, total: d.parts, unit: d.type === "xlsx" ? ("sheet" as const) : ("part" as const) } } : {};
    if (p.grid_json) {
      const [head, ...rest] = JSON.parse(p.grid_json) as string[][];
      return { made: { kind: "table", title: e.name, source: [source, p.label].filter(Boolean).join(" · "), payload: { columns: (head ?? []).slice(0, 12).map(String), rows: rest.slice(0, 200).map((r) => r.slice(0, 12).map(String)), note: rest.length > 200 ? `First 200 of ${rest.length} rows.` : undefined } }, ...pages };
    }
    return { made: { kind: "doc", title: e.name, source, payload: { file_id: d.id, name: d.name, part_label: p.label ?? "", text: p.text.slice(0, 200_000), more: part + 1 < d.parts } }, ...pages };
  }
  return { made: null, plain: plainFor(e) };
}

function ext(e: Entry) {
  const f = fileFor(e.id);
  return f ? path.extname(f.name).slice(1).toUpperCase() : "";
}
function plainFor(e: Entry): Preview["plain"] {
  const x = ext(e);
  const size = e.size == null ? "" : e.size > 1024 * 1024 ? `${(e.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(e.size / 1024))} KB`;
  const when = new Date(e.at).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  const why = e.sub && /couldn|can't|password|locked|still reading/i.test(e.sub) ? e.sub : null;
  return {
    badge: (x || "FILE").slice(0, 5),
    what: why ?? (e.group === "made" ? "A file I made. There's no viewer for this kind here." : "There's no viewer for this kind of file here."),
    lines: [e.kind, [size, when].filter(Boolean).join(" · "), e.job ? `${e.group === "remote" ? "From" : e.group === "guides" ? "By" : "Job:"} ${e.job}` : ""].filter(Boolean),
  };
}

/** What the viewer shows for an entry: never kept, nothing written. n: sheet, page or part from 0; rev: a shop drawing's. */
export async function previewOf(id: string, o: { n?: number; rev?: string } = {}): Promise<Preview | null> {
  const e = findEntry(id);
  if (!e) return null;
  const r = await itemOf(e, o.n ?? 0, o.rev);
  const item = r.real ?? (r.made ? previewItem(`pv_${e.id}${r.pages ? `_${r.pages.n}` : ""}${r.rev ? `_${r.rev}` : ""}`, { ...r.made, title: r.made.kind === "sheet" || r.made.kind === "shopdrawing" ? r.made.title : e.name }) : null);
  return { entry: e, item, ...(r.pages ? { pages: r.pages } : {}), ...(r.plain ? { plain: r.plain } : {}), ...(r.from_model ? { from_model: r.from_model } : {}), ...(r.revisions ? { revisions: r.revisions, rev: r.rev } : {}) };
}

/**
 * A real item for an entry (kept, like one the assistant showed): for "tell the assistant about this" (it goes up on
 * the right, so "this" in the next sentence means it) and for pinning. A kind with no viewer becomes a note saying what
 * it is and its file id, so the assistant can find it with its file tools.
 */
export async function itemForEntry(id: string, o: { n?: number; rev?: string } = {}): Promise<Item | null> {
  const e = findEntry(id);
  if (!e) return null;
  const r = await itemOf(e, o.n ?? 0, o.rev);
  if (r.real) return touchItem(r.real.id);
  if (id.startsWith("sd_") && r.made && r.rev) {
    const kept = getRevision(id, r.rev)?.item_id;
    const it = kept ? getItem(kept) : null;
    if (it) return touchItem(it.id);
    const made = createItem(null, r.made as Parameters<typeof createItem>[1]);
    setRevisionItem(id, r.rev, made.id, true);
    return made;
  }
  if (r.made) return createItem(null, { ...(r.made as Parameters<typeof createItem>[1]), title: r.made.kind === "sheet" ? r.made.title : e.name, source: id.startsWith("doc_") ? [r.made.source, `file ${id}`].filter(Boolean).join(" · ") : r.made.source });
  return createItem(null, {
    kind: "note",
    title: e.name,
    source: `${e.kind} · file ${id}`,
    payload: { rows: [{ label: "What", value: e.kind }, ...(r.plain?.lines.slice(1).map((v) => ({ label: v.startsWith("Job:") ? "Job" : "Size, date", value: v.replace(/^Job: /, "") })) ?? []), { label: "File", value: id }] },
  });
}
