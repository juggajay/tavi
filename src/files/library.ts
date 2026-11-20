import { earlier } from "../shared/earlier.js";
// Folders the owner lets Tavi read, and every file in them. The drawings folder it manages (data/drawings) is
// the first one; "linked" folders are anywhere on the PC and are ONLY EVER READ: nothing here creates, changes, moves
// or deletes a file in a linked folder. PDFs go through the drawings indexer; Word, Excel, text, photos and saved
// emails are read by the Python engine into docs / doc_parts, searchable through doc_fts.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { DEV } from "../dev.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, db, newId, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { bus } from "../events.js";
import { DRAWINGS_DIR, processQueue } from "../drawings/library.js";
import { extract } from "../drawings/engine.js";
import { containsReference, insideReference } from "../reference/dir.js";
import { fileMeta, madeFileMeta, mayUseFile } from "../hq/ownership.js";
import type { TurnInfo } from "../brain/turn.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_FILES = 20_000;
const MAX_BYTES = 200 * 1024 * 1024;

export type Folder = { id: string; path: string; label: string; kind: "managed" | "linked" | "remote"; enabled: number; split_subfolders: number; added_at: string; last_scan_at: string | null; last_error: string | null };
/** made: a file the assistant made (Stage 9: a 3D model file, a turntable video, a proposal page). Kept and findable by
 * name, never read as text. */
export type DocKind = "docx" | "xlsx" | "text" | "eml" | "image" | "old" | "pdf" | "made";

const KINDS: Record<string, DocKind> = {
  ".docx": "docx",
  ".docm": "docx",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".csv": "text",
  ".txt": "text",
  ".md": "text",
  ".json": "text",
  ".log": "text",
  ".eml": "eml",
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".heic": "image",
  ".heif": "image",
  ".webp": "image",
  ".doc": "old",
  ".xls": "old",
  ".ppt": "old",
  ".pptx": "old",
  ".msg": "old",
  ".pdf": "pdf",
  ".html": "made",
  ".glb": "made",
  ".stl": "made",
  ".blend": "made",
  ".usdz": "made",
  ".mp4": "made",
};
export const kindOf = (name: string): DocKind | null => KINDS[path.extname(name).toLowerCase()] ?? null;
const docId = (p: string) => `doc_${createHash("sha256").update(p.toLowerCase()).digest("hex").slice(0, 16)}`;

/* ---------------- folders ---------------- */

/** The drawings folder is always there, as the first (managed) folder. */
export function ensureManagedFolder() {
  const known = db.prepare("SELECT id FROM folders WHERE kind = 'managed'").get() as { id: string } | undefined;
  if (known) return known.id;
  const id = newId("fld").slice(0, 16);
  db.prepare("INSERT INTO folders (id, path, label, kind, enabled, split_subfolders, added_at) VALUES (?, ?, 'Drawings', 'managed', 1, 1, ?)").run(id, path.resolve(DRAWINGS_DIR), nowIso());
  db.prepare("UPDATE drawing_files SET folder_id = ? WHERE folder_id IS NULL").run(id);
  return id;
}

/**
 * The inbox for files brought from the owner's other computers (Stage 11.5): data/remote/<computer>/. Read like any
 * folder (so a photo, a document or a PDF can be shown with the usual tools), labelled so it's clear they came from
 * there and aren't filed in a job. Only bring_from_computer puts files in it.
 */
export const REMOTE_DIR = path.join(DATA_DIR, "remote");
export const REMOTE_LABEL = "From the other computer";
export function ensureRemoteFolder() {
  const known = db.prepare("SELECT id FROM folders WHERE kind = 'remote'").get() as { id: string } | undefined;
  if (known) return known.id;
  mkdirSync(REMOTE_DIR, { recursive: true });
  const id = newId("fld").slice(0, 16);
  db.prepare("INSERT INTO folders (id, path, label, kind, enabled, split_subfolders, added_at) VALUES (?, ?, ?, 'remote', 1, 0, ?)").run(id, path.resolve(REMOTE_DIR), REMOTE_LABEL, nowIso());
  bus.emit("files", {});
  return id;
}

export const listFolderRows = () => db.prepare("SELECT * FROM folders ORDER BY kind DESC, added_at").all() as Folder[];
export const getFolder = (id: string) => db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as Folder | undefined;

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Why a folder can't be added, in plain words, or null if it's fine. */
export function folderProblem(raw: string): { real?: string; problem: string | null } {
  const p = raw.trim().replace(/^"(.*)"$/, "$1");
  if (!p) return { problem: "Say which folder." };
  if (!path.isAbsolute(p)) return { problem: "That needs to be a full folder path, like C:\\Users\\you\\Jobs\\Club weekend." };
  if (!existsSync(p)) return { problem: "I can't find that folder." };
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    return { problem: "I can't open that folder." };
  }
  if (/^[A-Za-z]:\\?$/.test(real) || real === "/") return { real, problem: "That's a whole drive. Pick the folder with the jobs in it." };
  if (path.resolve(real).toLowerCase() === path.resolve(homedir()).toLowerCase()) return { real, problem: "That's your whole user folder. Pick the folder with the jobs in it." };
  const blocked = [process.env.SystemRoot ?? "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData", REPO, DATA_DIR, ...(["Tavi", earlier.folder].map(name => path.join(process.env.LOCALAPPDATA ?? "", name)))].filter(Boolean);
  const devTemp = DEV && inside(real, realpathSync(tmpdir())); // tests and dev use folders under the system temp folder (inside AppData)
  if (blocked.some((b) => inside(real, b)) || (/\\appdata\\/i.test(real + "\\") && !devTemp)) return { real, problem: "That's a system or program folder. I only read your own files." };
  if (insideReference(real)) return { real, problem: "That's your reference books folder. I already read those as books, so it can't be a job folder too." };
  if (containsReference(real)) return { real, problem: "Your reference books folder is inside that one. Pick a folder that doesn't hold the reference books." };
  for (const f of listFolderRows()) if (inside(real, f.path) || inside(f.path, real)) return { real, problem: `That overlaps a folder I already read (${f.label}).` };
  return { real, problem: null };
}

export function addFolder(raw: string, label?: string) {
  const { real, problem } = folderProblem(raw);
  if (problem || !real) throw new Error(problem ?? "I can't use that folder.");
  const id = newId("fld").slice(0, 16);
  db.prepare("INSERT INTO folders (id, path, label, kind, enabled, split_subfolders, added_at) VALUES (?, ?, ?, 'linked', 1, 0, ?)").run(id, real, (label || path.basename(real)).slice(0, 80), nowIso());
  audit("user", "folder.added", id, { path: real });
  bus.emit("files", {});
  void scanFolder(id);
  return getFolder(id)!;
}

export function setFolder(id: string, f: { enabled?: boolean; label?: string; split_subfolders?: boolean }) {
  const cur = getFolder(id);
  if (!cur) throw new Error("No such folder.");
  if (f.enabled !== undefined) db.prepare("UPDATE folders SET enabled = ? WHERE id = ?").run(f.enabled ? 1 : 0, id);
  if (f.label) db.prepare("UPDATE folders SET label = ? WHERE id = ?").run(f.label.slice(0, 80), id);
  if (f.split_subfolders !== undefined && cur.kind === "linked") db.prepare("UPDATE folders SET split_subfolders = ? WHERE id = ?").run(f.split_subfolders ? 1 : 0, id);
  bus.emit("files", {});
  return getFolder(id)!;
}

/** Stop reading a folder: forget what was read from it. The files themselves are never touched. */
export function removeFolder(id: string) {
  const f = getFolder(id);
  if (!f) throw new Error("No such folder.");
  if (f.kind === "managed") throw new Error("The drawings folder stays; you can turn it off instead.");
  forgetDocs(db.prepare("SELECT id FROM docs WHERE folder_id = ?").all(id) as { id: string }[]);
  const hashes = db.prepare("SELECT hash FROM drawing_files WHERE folder_id = ?").all(id) as { hash: string }[];
  for (const h of hashes) {
    for (const s of db.prepare("SELECT id FROM sheets WHERE file_hash = ?").all(h.hash) as { id: string }[]) db.prepare("DELETE FROM sheet_fts WHERE sheet_id = ?").run(s.id);
    db.prepare("DELETE FROM sheets WHERE file_hash = ?").run(h.hash);
    db.prepare("DELETE FROM drawing_files WHERE hash = ?").run(h.hash);
  }
  db.prepare("DELETE FROM folders WHERE id = ?").run(id);
  audit("user", "folder.removed", id, { path: f.path });
  bus.emit("files", {});
}

function forgetDocs(ids: { id: string }[]) {
  for (const { id } of ids) {
    db.prepare("DELETE FROM doc_fts WHERE doc_id = ?").run(id);
    db.prepare("DELETE FROM doc_parts WHERE doc_id = ?").run(id);
    db.prepare("DELETE FROM docs WHERE id = ?").run(id);
  }
}

/* ---------------- scanning (read-only) ---------------- */

type Found = { path: string; size: number; mtime: number };

/** Every readable file under a folder: no hidden or system files, no Office lock files, no links followed out. */
async function walk(root: string, out: Found[] = [], dir = root): Promise<Found[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (out.length >= MAX_FILES) break;
    if (n.startsWith(".") || n.startsWith("~$") || n === "node_modules" || n === "$RECYCLE.BIN" || n === "System Volume Information" || /^thumbs\.db$|^desktop\.ini$/i.test(n)) continue;
    const p = path.join(dir, n);
    if (insideReference(p)) continue; // the reference books are read by the shelf, not as job files (Stage 8)
    const st = await lstat(p).catch(() => null);
    if (!st || st.isSymbolicLink()) continue; // links and junctions could lead out of the folder
    if (st.isDirectory()) await walk(root, out, p);
    else if (st.isFile() && st.size <= MAX_BYTES && kindOf(n)) out.push({ path: p, size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  return out;
}

function projectFor(f: Folder, file: string) {
  if (f.split_subfolders) {
    const rel = path.relative(f.path, file).split(path.sep);
    if (rel.length > 1) return rel[0] === "inbox" ? "Unsorted" : rel[0];
  }
  return f.label;
}

const scanning = new Map<string, Promise<void>>(); // a second request for the same folder waits for the read in progress
const sha256 = async (p: string) => {
  const { readFile } = await import("node:fs/promises");
  return createHash("sha256").update(await readFile(p)).digest("hex");
};

/** Read what's new or changed in one folder, and forget what's gone. */
export function scanFolder(id: string): Promise<void> {
  const running = scanning.get(id);
  if (running) return running;
  const job = scanOnce(id).finally(() => {
    scanning.delete(id);
    bus.emit("files", { folder: id });
  });
  scanning.set(id, job);
  return job;
}

async function scanOnce(id: string) {
  const f = getFolder(id);
  if (!f || !f.enabled) return;
  {
    if (!existsSync(f.path)) {
      db.prepare("UPDATE folders SET last_error = ? WHERE id = ?").run("Can't find this folder right now.", id);
      return;
    }
    const files = await walk(f.path);
    const capped = files.length >= MAX_FILES;
    const known = new Map((db.prepare("SELECT id, path, mtime, size FROM docs WHERE folder_id = ?").all(id) as { id: string; path: string; mtime: number; size: number }[]).map((d) => [d.path, d]));
    const seen = new Set<string>();
    let queued = 0;
    for (const file of files) {
      const kind = kindOf(file.path)!;
      // a page the assistant made from a model (Stage 9.6b) is its own file, not a drawing
      if (kind === "made" && f.kind !== "managed") continue; // only the ones it made itself, in its own folder
      if (kind === "made" || (kind === "pdf" && f.kind === "managed" && insideModels(file.path))) {
        seen.add(file.path);
        const k = known.get(file.path);
        if (!k || k.mtime !== file.mtime || k.size !== file.size) registerMade(f, file);
        continue;
      }
      if (kind === "pdf") {
        if (f.kind === "managed") continue; // the drawings watcher handles its own PDFs (and zips)
        const row = db.prepare("SELECT hash, mtime, size FROM drawing_files WHERE path = ?").get(file.path) as { hash: string; mtime: number | null; size: number | null } | undefined;
        if (row && row.mtime === file.mtime && row.size === file.size) continue;
        const hash = await sha256(file.path);
        if (row?.hash === hash) {
          db.prepare("UPDATE drawing_files SET mtime = ?, size = ? WHERE hash = ?").run(file.mtime, file.size, hash);
          continue;
        }
        if (db.prepare("SELECT 1 FROM drawing_files WHERE hash = ?").get(hash)) continue; // the same PDF is already read elsewhere
        db.prepare("INSERT INTO drawing_files (hash, path, name, project, status, added_at, folder_id, type, mtime, size) VALUES (?, ?, ?, ?, 'queued', ?, ?, 'pdf', ?, ?)").run(
          hash,
          file.path,
          path.basename(file.path),
          projectFor(f, file.path),
          nowIso(),
          id,
          file.mtime,
          file.size,
        );
        queued++;
        continue;
      }
      seen.add(file.path);
      const k = known.get(file.path);
      if (k && k.mtime === file.mtime && k.size === file.size) continue;
      await indexDoc(f, file, kind);
      bus.emit("files", { folder: id });
    }
    forgetDocs([...known.values()].filter((d) => !seen.has(d.path)));
    db.prepare("UPDATE folders SET last_scan_at = ?, last_error = ? WHERE id = ?").run(nowIso(), capped ? `More than ${MAX_FILES.toLocaleString()} files: I've read the first ${MAX_FILES.toLocaleString()}.` : null, id);
    if (queued) void processQueue();
  }
}

/** The folder (inside the one it manages) where models and the files made from them are kept (Stage 9). */
export const MODELS_DIR = path.join(DRAWINGS_DIR, "models");
export const insideModels = (p: string) => {
  const rel = path.relative(MODELS_DIR, p);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** A file the assistant made: a row with its name (so it's findable), nothing read from inside it. */
function registerMade(f: Folder, file: Found, extra: Record<string, unknown> = {}) {
  const id = docId(file.path);
  const name = path.basename(file.path);
  const old = getDoc(id);
  const meta = madeFileMeta({ ...(old ? fileMeta(old) : {}), ...extra });
  forgetDocs([{ id }]);
  db.prepare("INSERT INTO docs (id, folder_id, project, path, name, type, mtime, size, parts, meta_json, skipped_reason, indexed_at) VALUES (?, ?, ?, ?, ?, 'made', ?, ?, 0, ?, NULL, ?)").run(
    id,
    f.id,
    projectFor(f, file.path),
    file.path,
    name,
    file.mtime,
    file.size,
    JSON.stringify({ format: path.extname(name).slice(1).toLowerCase(), ...meta }),
    nowIso(),
  );
  db.prepare("INSERT INTO doc_fts (doc_id, n, name, label, text) VALUES (?, -1, ?, '', '')").run(id, name);
}

/** Keep a file the assistant just made in the models folder (a GLB, an STL, a proposal page...) and return its row. */
export async function registerMadeFile(file: string, extra: Record<string, unknown> = {}): Promise<DocRow> {
  const id = ensureManagedFolder();
  const st = await lstat(file);
  registerMade(getFolder(id)!, { path: file, size: st.size, mtime: Math.round(st.mtimeMs) }, extra);
  bus.emit("files", { folder: id });
  return getDoc(docId(file))!;
}

async function indexDoc(f: Folder, file: Found, kind: DocKind) {
  const id = docId(file.path);
  const old = getDoc(id);
  const name = path.basename(file.path);
  const r = await extract(file.path, kind);
  forgetDocs([{ id }]);
  const parts = r.parts ?? [];
  db.prepare("INSERT INTO docs (id, folder_id, project, path, name, type, mtime, size, parts, meta_json, skipped_reason, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    f.id,
    projectFor(f, file.path),
    file.path,
    name,
    kind,
    file.mtime,
    file.size,
    parts.length,
    old?.meta_json || r.meta ? JSON.stringify({ ...(old ? fileMeta(old) : {}), ...r.meta }) : null,
    r.skipped ?? null,
    nowIso(),
  );
  parts.forEach((p, n) => {
    db.prepare("INSERT INTO doc_parts (doc_id, n, label, text, grid_json) VALUES (?, ?, ?, ?, ?)").run(id, n, p.label, p.text, p.grid ? JSON.stringify(p.grid) : null);
    db.prepare("INSERT INTO doc_fts (doc_id, n, name, label, text) VALUES (?, ?, ?, ?, ?)").run(id, n, name, p.label, p.text);
  });
  if (!parts.length && !r.skipped) db.prepare("INSERT INTO doc_fts (doc_id, n, name, label, text) VALUES (?, -1, ?, '', '')").run(id, name); // photos: findable by name
}

/**
 * Read one file the app just saved into the folder it manages (a photo or sketch sent from the phone, a file attached
 * on the desktop), straight away, so its row exists before the reply goes back. extra is merged into its meta: who
 * made it and, for a sketch, the photo underneath.
 */
export async function readOneFile(file: string, extra: Record<string, unknown> = {}): Promise<DocRow> {
  const id = ensureManagedFolder();
  const f = getFolder(id)!;
  const st = await lstat(file);
  const kind = kindOf(file);
  if (!kind || kind === "pdf" || kind === "made") throw new Error("Not a file I read this way.");
  await indexDoc(f, { path: file, size: st.size, mtime: Math.round(st.mtimeMs) }, kind);
  const row = getDoc(docId(file))!;
  if (Object.keys(extra).length) {
    const meta = madeFileMeta({ ...(row.meta_json ? (JSON.parse(row.meta_json) as Record<string, unknown>) : {}), ...extra });
    db.prepare("UPDATE docs SET meta_json = ? WHERE id = ?").run(JSON.stringify(meta), row.id);
  }
  bus.emit("files", { folder: id });
  return getDoc(row.id)!;
}

/** Photos and sketches the owner sent in the last 30 minutes, newest first (at most four), for the brain's Context. */
export function recentPictures(now = Date.now(), minutes = 30) {
  const since = new Date(now - minutes * 60_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, name, meta_json, indexed_at, path FROM docs WHERE type = 'image' AND indexed_at >= ?
         AND (json_extract(meta_json, '$.by') = 'owner' OR path LIKE ?) ORDER BY indexed_at DESC LIMIT 4`,
    )
    .all(since, `${path.join(DRAWINGS_DIR, "inbox")}${path.sep}%`) as { id: string; name: string; meta_json: string | null; indexed_at: string }[];
  return rows.map((r) => {
    const meta = r.meta_json ? (JSON.parse(r.meta_json) as { kind?: string; over?: string }) : {};
    return { id: r.id, name: r.name, kind: meta.kind === "sketch" ? ("sketch" as const) : ("photo" as const), over: meta.over, at: r.indexed_at };
  });
}

let scanAllRunning = false;
export async function scanAll() {
  if (scanAllRunning) return;
  scanAllRunning = true;
  try {
    for (const f of listFolderRows()) if (f.enabled) await scanFolder(f.id);
  } finally {
    scanAllRunning = false;
  }
}

export function startFileWatcher() {
  ensureManagedFolder();
  setTimeout(() => void scanAll(), 20_000).unref();
  setInterval(() => void scanAll(), 5 * 60_000).unref();
}

/* ---------------- reading ---------------- */

export type DocRow = { id: string; folder_id: string; project: string; path: string; name: string; type: DocKind; mtime: number; size: number; parts: number; meta_json: string | null; skipped_reason: string | null; indexed_at: string };
export const getDoc = (id: string) => db.prepare("SELECT * FROM docs WHERE id = ?").get(id) as DocRow | undefined;
export const docPart = (id: string, n: number) => db.prepare("SELECT n, label, text, grid_json FROM doc_parts WHERE doc_id = ? AND n = ?").get(id, n) as { n: number; label: string; text: string; grid_json: string | null } | undefined;

/** A folder's state for the Files page: counts by type, how much is read, what couldn't be. */
export function folderSummaries(turn?: TurnInfo) {
  return listFolderRows().map((f) => {
    const docs = turn?.bot
      ? (db.prepare("SELECT * FROM docs WHERE folder_id = ?").all(f.id) as DocRow[]).filter((d) => mayUseFile(turn, d))
      : db.prepare("SELECT type, skipped_reason FROM docs WHERE folder_id = ?").all(f.id) as { type: string; skipped_reason: string | null }[];
    const pdfs = db.prepare("SELECT status FROM drawing_files WHERE folder_id = ?").all(f.id) as { status: string }[];
    const types: Record<string, number> = {};
    for (const d of docs) types[d.type] = (types[d.type] ?? 0) + 1;
    if (pdfs.length) types.pdf = pdfs.length;
    const unread = docs.filter((d) => d.skipped_reason).length + pdfs.filter((p) => p.status === "failed").length;
    const pending = pdfs.filter((p) => p.status === "queued" || p.status === "indexing").length + (scanning.has(f.id) ? 1 : 0);
    return { ...f, enabled: !!f.enabled, split_subfolders: !!f.split_subfolders, count: docs.length + pdfs.length, read: docs.length + pdfs.length - unread - pending, unread, pending, scanning: scanning.has(f.id), types };
  });
}

export function folderFiles(id: string, offset = 0, limit = 200) {
  return db
    .prepare(
      `SELECT id, name, type, size, mtime, skipped_reason, project FROM docs WHERE folder_id = ?
       UNION ALL SELECT hash AS id, name, 'pdf' AS type, size, mtime, CASE WHEN status = 'failed' THEN COALESCE(error, 'Couldn''t open it.') END, project FROM drawing_files WHERE folder_id = ?
       ORDER BY name LIMIT ? OFFSET ?`,
    )
    .all(id, id, limit, offset);
}
