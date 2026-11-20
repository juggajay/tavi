// All work happens on a separate copy. The live folder is only read.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { spawnSync, execFileSync } from "node:child_process";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { earlier } from "../shared/earlier.js";

type RecordRow = Record<string, SQLInputValue>;
export type CarryOptions = { from: string; to: string; yes?: boolean };
export type CarryResult = { code: 0 | 2 | 3; report: string; backup?: string };
type CopyPlan = { folder: string; previous: string; source: string; destination: string; result: string; sourceStamp: string };
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const command = path.join(repo, "scripts", "carry-over.mjs");
const lockFiles = new WeakMap<DatabaseSync, string>();
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
function readOnly(file: string): DatabaseSync {
  // With no waiting writes, this also prevents SQLite making empty working files beside the source.
  const url = pathToFileURL(file);
  url.search = existsSync(file + "-wal") && statSync(file + "-wal").size > 0 ? "mode=ro" : "mode=ro&immutable=1";
  return new DatabaseSync(url.href, { readOnly: true });
}
const name = (s: string) => `"${s.replace(/"/g, '""')}"`;
const inside = (child: string, parent: string) => {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
};
function resolved(value: string): string {
  const full = path.resolve(value);
  if (existsSync(full)) return realpathSync(full);
  const parent = path.dirname(full);
  return parent === full ? full : path.join(resolved(parent), path.basename(full));
}
function folders(from: string, to: string) {
  const source = resolved(from), destination = resolved(to);
  const live = [...(process.env.TAVI_PROTECTED_DATA_DIRS || "").split(path.delimiter).filter(Boolean), path.join(repo, "data"), path.resolve(repo, "../harness/data")];
  if (inside(destination, source) || inside(source, destination) || live.some((p) => inside(destination, resolved(p)))) {
    throw new Error("Choose separate folders. The Tavi folder cannot be the live folder, inside it, or around it.");
  }
  if (!existsSync(path.join(source, "harness.db"))) throw new Error("The starting folder has no saved database.");
  if (lstatSync(path.join(source, "harness.db")).isSymbolicLink() || (existsSync(path.join(destination, "harness.db")) && lstatSync(path.join(destination, "harness.db")).isSymbolicLink())) {
    throw new Error("The saved database must be an ordinary file, not a file link.");
  }
  return { source, destination };
}
function portBusy(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: 3100 });
    const finish = (busy: boolean) => { socket.destroy(); resolve(busy); };
    socket.setTimeout(400, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (e: NodeJS.ErrnoException) => finish(e.code !== "ECONNREFUSED" && e.code !== "EAFNOSUPPORT"));
  });
}
function exclusive(folder: string): DatabaseSync | undefined {
  const file = path.join(folder, "harness.db");
  if (!existsSync(file)) return;
  const absent = !existsSync(file + "-wal") && !existsSync(file + "-shm");
  const db = new DatabaseSync(file, { readOnly: true });
  if (absent) lockFiles.set(db, file);
  try { db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"); return db; }
  catch (error) { db.close(); tidyLockFiles(db); throw error; }
}
function tidyLockFiles(db: DatabaseSync) {
  const file = lockFiles.get(db);
  // Remove only empty working files made by this check, never anyone's waiting writes.
  if (file && existsSync(file + "-wal") && statSync(file + "-wal").size === 0) {
    rmSync(file + "-wal", { force: true }); rmSync(file + "-shm", { force: true });
  }
}
const unlock = (db?: DatabaseSync) => { if (db) { db.exec("ROLLBACK"); db.close(); tidyLockFiles(db); } };
function snapshot(folder: string, file: string) {
  // Even a read-only SQLite reader can change the source's shared working file.
  // Read stable file bytes first, then let SQLite open only that private copy.
  const mirror = mkdtempSync(path.join(path.dirname(file), ".reading-"));
  const sourceFile = path.join(folder, "harness.db");
  const waiting = () => existsSync(sourceFile + "-wal") ? readFileSync(sourceFile + "-wal") : undefined;
  try {
    let stable = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const main = readFileSync(sourceFile), wal = waiting();
      if (!main.equals(readFileSync(sourceFile))) continue;
      const again = waiting();
      if (wal === undefined ? again !== undefined : again === undefined || !wal.equals(again)) continue;
      writeFileSync(path.join(mirror, "harness.db"), main);
      if (wal?.length) writeFileSync(path.join(mirror, "harness.db-wal"), wal);
      stable = true; break;
    }
    if (!stable) throw new Error("The starting database kept changing. Try again when the assistant has finished its turn.");
    const db = readOnly(path.join(mirror, "harness.db"));
    try { db.exec(`VACUUM INTO ${quote(file)}`); }
    finally { db.close(); }
  } finally { rmSync(mirror, { recursive: true, force: true }); }
}
function entries(folder: string, prefix = "", refuseEnvironment = false): { file: string; size: number }[] {
  if (!existsSync(folder)) return [];
  const files: { file: string; size: number }[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === ".env" || entry.name.toLowerCase().startsWith(".env.")) {
      if (refuseEnvironment) throw new Error("The Tavi folder contains a .env file. Move it aside first so it can be kept without being read.");
      continue;
    }
    if (!prefix && ["backup", "guard"].includes(entry.name.toLowerCase())) continue;
    const relative = path.join(prefix, entry.name), full = path.join(folder, entry.name);
    if (lstatSync(full).isSymbolicLink()) throw new Error("A folder contains a file link. Replace it with an ordinary file before carrying over.");
    if (entry.isDirectory()) files.push(...entries(full, relative, refuseEnvironment));
    else if (entry.isFile() && !(prefix === "" && /^harness\.db(?:-(?:wal|shm|journal))?$/i.test(entry.name))) files.push({ file: relative, size: statSync(full).size });
  }
  return files;
}
function copyFiles(from: string, to: string, files: { file: string }[]) {
  for (const { file } of files) {
    const out = path.join(to, file);
    mkdirSync(path.dirname(out), { recursive: true });
    copyWithTimes(path.join(from, file), out);
  }
}
function copyWithTimes(from: string, to: string) {
  const times = statSync(from);
  copyFileSync(from, to);
  // Keep file times so a scan does not mistake a copy for a changed file.
  utimesSync(to, times.atime, times.mtime);
}
function copyTree(from: string, to: string) {
  if (!existsSync(from)) return;
  if (lstatSync(from).isSymbolicLink()) throw new Error("A folder link cannot be copied safely.");
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (/^\.env(?:\.|$)/i.test(entry.name)) throw new Error("A protected folder contains a settings file that cannot be read by this command.");
    const src = path.join(from, entry.name), dest = path.join(to, entry.name);
    if (lstatSync(src).isSymbolicLink()) throw new Error("A file link cannot be copied safely.");
    if (entry.isDirectory()) copyTree(src, dest);
    else copyWithTimes(src, dest);
  }
}
function transaction(db: DatabaseSync, step: () => void) {
  db.exec("BEGIN");
  try { step(); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
const all = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${name(table)}`).all() as RecordRow[];
function insert(db: DatabaseSync, table: string, row: RecordRow) {
  const columns = Object.keys(row);
  db.prepare(`INSERT OR REPLACE INTO ${name(table)} (${columns.map(name).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map((c) => row[c]));
}
const count = (db: DatabaseSync, table: string) => Number((db.prepare(`SELECT count(*) n FROM ${name(table)}`).get() as { n: number }).n);
const has = (db: DatabaseSync, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table);

type SavedOrigin = { rows: Record<string, string[]>; files: Record<string, string>; ours?: Record<string, string[]> };
type MergeReport = { kinds: Record<string, number>; bots: Record<string, number>; changes: string[] };
class PlacementError extends Error {
  report: MergeReport;
  constructor(message: string, report: MergeReport) { super(message); this.report = report; }
}
function workLines(report: MergeReport): string[] {
  const titles: Record<string, string> = {
    shop_drawings: "drawing sets", shop_drawing_revs: "drawing revisions", docs: "made files", doc_parts: "file parts",
    drawing_files: "drawing files", drawing_crops: "drawing details", ref_books: "reference books", ref_toc: "book contents",
    ref_pages: "book pages", guide_updates: "guide updates", conversation_log: "conversation lines", audit_log: "saved events",
    day_notes: "daily notes", profile_changes: "profile changes", demo_outbox: "practice messages", proactive_log: "follow-up records",
    push_subscriptions: "push subscriptions", shortcut_keys: "Siri keys", image: "pictures", doc: "documents", model: "models",
    shopdrawing: "shop drawing cards", note: "notes", sheet: "drawing sheets", list: "lists", table: "tables",
  };
  return [
    `Tavi work kept, by kind: ${Object.entries(report.kinds).map(([kind, n]) => `${titles[kind] ?? plain(kind).replace(/_/g, " ")}: ${n}`).join(", ") || "none"}.`,
    `Tavi work by bot: ${Object.entries(report.bots).map(([bot, n]) => `${plain(bot)}: ${n}`).join(", ") || "none"}.`,
    ...report.changes,
  ];
}
const originKey = "carry-over:origin";
const json = (value: SQLInputValue) => JSON.parse(String(value ?? "{}"));
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const plain = (value: string) => value.replace(/[\r\n\x00-\x1f]/g, " ");
function tables(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_list").all() as { name: string; type: string }[])
    .filter((t) => t.type === "table" && !t.name.startsWith("sqlite_")).map((t) => t.name).sort();
}
function primary(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${name(table)})`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
}
const rowKey = (row: RecordRow, columns: string[]) => JSON.stringify(columns.map((c) => row[c]));
function fileHashes(folder: string): Record<string, string> {
  return Object.fromEntries(entries(folder).filter(({ file }) => !["logs", "backup"].includes(file.split(path.sep)[0].toLowerCase()))
    .map(({ file }) => [file, digest(readFileSync(path.join(folder, file)))]));
}
function contentStamp(db: DatabaseSync, folder: string): string {
  const rows = tables(db).map((table) => [table, all(db, table)
    .filter((r) => table !== "settings" || r.key !== "carry-over:receipt")
    .map((r) => JSON.stringify(r)).sort()]);
  return digest(JSON.stringify([rows, fileHashes(folder)]));
}

// Work out every new name before writing anything into the prepared copy.
function mergeWork(db: DatabaseSync, previous: DatabaseSync | undefined, plan: CopyPlan): MergeReport {
  const report: MergeReport = { kinds: {}, bots: {}, changes: [] };
  try {
  const saved = previous?.prepare("SELECT value FROM settings WHERE key=?").get(originKey) as { value: string } | undefined;
  const origin: SavedOrigin = saved ? JSON.parse(saved.value) : { rows: {}, files: {} };
  const sourceFiles = fileHashes(plan.source), previousFiles = fileHashes(plan.previous);
  const earlierHashes = new Map(Object.entries(origin.files).map(([file, hash]) => [file.toLowerCase(), hash]));
  const nextOrigin: SavedOrigin = { rows: {}, files: sourceFiles, ours: {} };
  const incomingSettings = all(db, "settings").filter((r) => !/^(?:hq:|team:|bot:|carry-over:)/.test(String(r.key))).map((r) => String(r.key));
  const skip = new Set(["bots", "bot_rows", "bot_cards", "about_card", "settings", "secrets"]);
  const source = new Map<string, RecordRow[]>(), old = new Map<string, RecordRow[]>();
  const keys = new Map<string, string[]>(), kept = new Map<string, Set<string>>();
  const maps = new Map<string, Map<string, SQLInputValue>>();
  const numbers = new Map<string, string>(), paths = new Map<string, string>();
  const get = (table: string) => old.get(table) ?? [];
  const turnMaker = (value: SQLInputValue) => /^lh-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(String(value ?? ""))?.[1] ?? null;
  const jobMaker = (id: SQLInputValue): string | null => {
    try {
      const summary = json(get("jobs").find((r) => r.id === id)?.summary ?? null);
      return typeof summary.bot === "string" ? summary.bot : turnMaker(summary.from_turn);
    } catch { return null; }
  };
  const maker = (row: RecordRow): string | null => {
    const meta = json(row.payload_json)._meta;
    if (meta && "made_by_bot" in meta) return typeof meta.made_by_bot === "string" ? meta.made_by_bot : null;
    return turnMaker(row.job_id) ?? jobMaker(row.job_id);
  };
  for (const table of tables(db)) {
    if (skip.has(table)) continue;
    const pk = primary(db, table);
    if (!pk.length) throw new Error("Could not place saved records: a table has no stable saved name.");
    keys.set(table, pk);
    source.set(table, all(db, table));
    old.set(table, previous && has(previous, table) ? all(previous, table) : []);
    nextOrigin.rows[table] = source.get(table)!.map((r) => rowKey(r, pk));
    kept.set(table, new Set());
    maps.set(table, new Map());
  }
  const keep = (table: string, row: RecordRow) => kept.get(table)?.add(rowKey(row, keys.get(table)!));
  const isKept = (table: string, row: RecordRow) => kept.get(table)?.has(rowKey(row, keys.get(table)!)) ?? false;
  const itemMakers = new Map(get("items").map((r) => [String(r.id), maker(r)]));
  const locallyChanged = (value: SQLInputValue) => {
    if (typeof value !== "string" || !path.isAbsolute(value) || !inside(value, plan.destination)) return false;
    const relative = path.relative(plan.destination, value);
    return Object.entries(previousFiles).some(([file, hash]) => inside(file, relative) && earlierHashes.has(file.toLowerCase()) && earlierHashes.get(file.toLowerCase()) !== hash);
  };
  const ownedItems = new Set([...itemMakers].filter(([, bot]) => bot).map(([id]) => id));
  const ownedDrawings = new Set(get("shop_drawings").filter((r) => ownedItems.has(String(r.model_item)) ||
    get("shop_drawing_revs").some((rev) => rev.drawing_id === r.id && ownedItems.has(String(rev.item_id)))).map((r) => String(r.id)));
  const ownedDocs = new Set(get("docs").filter((r) => {
    const meta = json(r.meta_json);
    return typeof meta.made_by_bot === "string" || ownedItems.has(meta.item) || ownedDrawings.has(meta.drawing) || locallyChanged(r.path);
  }).map((r) => String(r.id)));
  const earlierItems = new Set(get("items").filter((r) => json(r.payload_json)._meta?.made_by_bot === null).map((r) => String(r.id)));
  const earlierDrawings = new Set(get("shop_drawings").filter((r) => !ownedDrawings.has(String(r.id)) &&
    (earlierItems.has(String(r.model_item)) || get("shop_drawing_revs").some((rev) => rev.drawing_id === r.id && earlierItems.has(String(rev.item_id))))).map((r) => String(r.id)));
  const earlierDocs = new Set(get("docs").filter((r) => !ownedDocs.has(String(r.id)) &&
    (json(r.meta_json).made_by_bot === null || earlierItems.has(json(r.meta_json).item) || earlierDrawings.has(json(r.meta_json).drawing))).map((r) => String(r.id)));
  // A managed folder is the same place when its full path is the same.
  const sharedFolders = new Map<string, SQLInputValue>();
  for (const row of get("folders")) {
    const same = source.get("folders")!.find((r) => String(r.path).toLowerCase() === String(row.path).toLowerCase());
    if (same) sharedFolders.set(String(row.id), same.id);
  }
  for (const [table, rows] of old) {
    const pk = keys.get(table)!;
    const incoming = new Map(source.get(table)!.map((r) => [rowKey(r, pk), r]));
    for (const row of rows) {
      if (table === "folders" && sharedFolders.has(String(row.id))) continue;
      const id = rowKey(row, pk), counterpart = incoming.get(id);
      const owned = table === "items" ? ownedItems.has(String(row.id)) : table === "docs" ? ownedDocs.has(String(row.id)) :
        table === "shop_drawings" ? ownedDrawings.has(String(row.id)) : table === "shop_drawing_revs" ? ownedDrawings.has(String(row.drawing_id)) :
        table === "pins" ? (json(row.item_ids) as string[]).some((i) => ownedItems.has(i)) :
        table === "jobs" ? !!jobMaker(row.id) : table === "memories" && String(row.scope).startsWith("bot:");
      // Earlier carry-overs explicitly marked these records as belonging to before the team.
      const earlier = table === "items" ? earlierItems.has(String(row.id)) : table === "docs" ? earlierDocs.has(String(row.id)) :
        table === "shop_drawings" ? earlierDrawings.has(String(row.id)) : table === "shop_drawing_revs" ? earlierDrawings.has(String(row.drawing_id)) :
        table === "doc_parts" ? earlierDocs.has(String(row.doc_id)) : table === "pins" && (json(row.item_ids) as string[]).every((i) => earlierItems.has(i));
      let same = counterpart && JSON.stringify(counterpart) === JSON.stringify(row);
      if (counterpart && table === "items" && !owned) {
        const payload = json(row.payload_json);
        payload._meta = { ...payload._meta, made_by_bot: null };
        same = JSON.stringify(counterpart) === JSON.stringify({ ...row, payload_json: JSON.stringify(payload) });
      }
      if (owned || origin.ours?.[table]?.includes(id) || (!origin.rows[table]?.includes(id) && !earlier && !same)) keep(table, row);
    }
  }
  // A drawing's revisions, a file's searchable parts and a pin follow their parent.
  const links: Record<string, Record<string, string>> = {
    items: { job_id: "jobs" }, shop_drawings: { model_item: "items" }, shop_drawing_revs: { drawing_id: "shop_drawings", item_id: "items" },
    docs: { folder_id: "folders" }, doc_parts: { doc_id: "docs" }, sheets: { file_hash: "drawing_files", superseded_by: "sheets" },
    drawing_files: { folder_id: "folders" }, drawing_crops: { sheet_id: "sheets" },
    ref_toc: { book_id: "ref_books" }, ref_pages: { book_id: "ref_books" }, guide_updates: { book_id: "ref_books" },
    actions: { approval_id: "approvals" }, approvals: { draft_id: "drafts" },
  };
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [table, rows] of old) for (const row of rows) {
      if (isKept(table, row)) continue;
      if (table === "folders" && sharedFolders.has(String(row.id))) continue;
      const follows = Object.entries(links[table] ?? {}).some(([col, parent]) => get(parent).some((r) => r[keys.get(parent)![0]] === row[col] && isKept(parent, r))) ||
        (table === "pins" && (json(row.item_ids) as string[]).some((id) => get("items").some((r) => r.id === id && isKept("items", r)))) ||
        (table === "items" && (get("shop_drawings").some((d) => isKept("shop_drawings", d) && json(row.payload_json).drawing_id === d.id) ||
          get("docs").some((d) => isKept("docs", d) && (json(d.meta_json).item === row.id || json(row.payload_json).file_id === d.id)))) ||
        (table === "shop_drawings" && get("shop_drawing_revs").some((r) => r.drawing_id === row.id && isKept("shop_drawing_revs", r)));
      if (follows) { keep(table, row); expanded = true; }
    }
  }
  for (const [table, rows] of old) for (const row of rows.filter((r) => isKept(table, r))) {
    const kind = table === "items" ? String(row.kind) : table;
    report.kinds[kind] = (report.kinds[kind] ?? 0) + 1;
    const drawingBot = (id: SQLInputValue) => {
      const drawing = get("shop_drawings").find((r) => r.id === id);
      return itemMakers.get(String(drawing?.model_item)) ?? itemMakers.get(String(get("shop_drawing_revs").find((r) => r.drawing_id === id)?.item_id));
    };
    const meta = table === "docs" ? json(row.meta_json) : {};
    const bot = table === "items" ? maker(row) : table === "docs" ? meta.made_by_bot ?? itemMakers.get(meta.item) ?? drawingBot(meta.drawing) :
      table === "shop_drawings" ? drawingBot(row.id) : table === "shop_drawing_revs" ? drawingBot(row.drawing_id) :
      table === "pins" ? itemMakers.get(String(json(row.item_ids)[0])) : table === "jobs" ? jobMaker(row.id) : table === "memories" && String(row.scope).startsWith("bot:") ? String(row.scope).slice(4) : null;
    if (bot) report.bots[bot] = (report.bots[bot] ?? 0) + 1;
  }
  for (const [table, rows] of old) {
    const pk = keys.get(table)!;
    if (pk.length !== 1 || table === "docs") continue;
    const col = pk[0], used = new Set([...source.get(table)!, ...rows].map((r) => String(r[col])));
    const incoming = new Set(source.get(table)!.map((r) => String(r[col])));
    for (const row of rows.filter((r) => isKept(table, r))) {
      if (!incoming.has(String(row[col]))) continue;
      let replacement: SQLInputValue;
      if (typeof row[col] === "number") {
        replacement = Math.max(0, ...[...used].map(Number)) + 1;
      } else {
        const id = String(row[col]), match = /^(.*_)([a-f0-9]+)$/.exec(id);
        let n = 0;
        do { replacement = match ? match[1] + digest(`${table}:${id}:${++n}`).slice(0, match[2].length) : `${id}-tavi-${++n}`; } while (used.has(String(replacement)) && n < 10000);
        if (used.has(String(replacement))) throw new Error("Could not place a saved record: no free saved name was found.");
      }
      maps.get(table)!.set(String(row[col]), replacement);
      used.add(String(replacement));
      report.changes.push(`Saved ${table === "items" ? "item" : table === "shop_drawings" ? "drawing set" : "record"}: ${plain(String(row[col]))} becomes ${plain(String(replacement))}.`);
    }
  }
  for (const [before, after] of sharedFolders) if (before !== after) maps.get("folders")!.set(before, after);
  const usedNumbers = new Set([...source.get("shop_drawings")!, ...get("shop_drawings")].map((r) => String(r.number).toUpperCase()));
  for (const drawing of get("shop_drawings").filter((r) => isKept("shop_drawings", r))) {
    const number = String(drawing.number);
    if (!source.get("shop_drawings")!.some((r) => String(r.number).toUpperCase() === number.toUpperCase())) continue;
    const series = /^(.*?)(\d+)$/.exec(number);
    if (!series) throw new Error("Could not place a drawing set: its number has no running number at the end.");
    let n = Math.max(...[...usedNumbers].filter((s) => s.startsWith(series[1].toUpperCase()) && /^\d+$/.test(s.slice(series[1].length))).map((s) => Number(s.slice(series[1].length)))) + 1;
    let next = series[1] + String(n).padStart(series[2].length, "0");
    while (usedNumbers.has(next.toUpperCase())) next = series[1] + String(++n).padStart(series[2].length, "0");
    if (!Number.isSafeInteger(n)) throw new Error("Could not place a drawing set: its running number is too large.");
    numbers.set(number, next); usedNumbers.add(next.toUpperCase());
    report.changes.push(`Drawing set: ${plain(number)} becomes ${plain(next)}.`);
  }
  const replaceTokens = (value: string, replacements: Map<string, SQLInputValue | string>) => {
    // Match complete names, including names inside routes and file names.
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!replacements.size) return value;
    const pattern = [...replacements.keys()].sort((a, b) => b.length - a.length).map(escape).join("|");
    return value.replace(new RegExp(`(?<![A-Za-z0-9_])(${pattern})(?![A-Za-z0-9_])`, "g"), (s) => String(replacements.get(s)));
  };
  const idTokens = new Map<string, SQLInputValue>();
  for (const map of maps.values()) for (const [before, after] of map) {
    if (typeof after !== "string") continue;
    if (idTokens.has(before) && idTokens.get(before) !== after) throw new Error("Could not place saved references: a name is used for two different things.");
    idTokens.set(before, after);
  }
  const fileTokens = new Map(idTokens);
  const renamedFile = (file: string) => replaceTokens(replaceTokens(file, numbers), fileTokens);
  const protectedFiles = new Set<string>();
  const protectedDirs = new Set<string>();
  const earlierFiles = new Set<string>();
  const markEarlierPaths = (value: unknown) => {
    if (typeof value === "string" && path.isAbsolute(value) && inside(value, plan.destination)) {
      const relative = path.relative(plan.destination, value);
      for (const file of Object.keys(previousFiles)) if (inside(file, relative)) earlierFiles.add(file);
    } else if (Array.isArray(value)) value.forEach(markEarlierPaths);
    else if (value && typeof value === "object") Object.values(value).forEach(markEarlierPaths);
  };
  for (const [table, rows] of old) for (const row of rows) {
    if ((table === "items" && earlierItems.has(String(row.id))) || (table === "docs" && earlierDocs.has(String(row.id))) ||
      (table === "shop_drawing_revs" && earlierDrawings.has(String(row.drawing_id)))) {
      for (const [col, value] of Object.entries(row)) markEarlierPaths(col.endsWith("_json") && typeof value === "string" ? json(value) : value);
    }
  }
  const noticePaths = (value: unknown) => {
    if (typeof value === "string" && path.isAbsolute(value) && inside(value, plan.destination)) {
      const relative = path.relative(plan.destination, value);
      for (const file of Object.keys(previousFiles)) if (inside(file, relative)) protectedFiles.add(file);
      if (existsSync(path.join(plan.previous, relative)) && statSync(path.join(plan.previous, relative)).isDirectory()) protectedDirs.add(relative);
    } else if (Array.isArray(value)) value.forEach(noticePaths);
    else if (value && typeof value === "object") Object.values(value).forEach(noticePaths);
  };
  for (const [table, rows] of old) for (const row of rows.filter((r) => isKept(table, r))) {
    for (const col of table === "docs" ? ["path"] : table === "shop_drawing_revs" ? ["pdf", "dxf", "parts_dir"] : []) {
      const value = String(row[col]);
      if (path.isAbsolute(value) && inside(value, plan.destination) && !existsSync(path.join(plan.previous, path.relative(plan.destination, value)))) {
        throw new Error(`Could not place a saved file: ${plain(path.relative(plan.destination, value))} is missing from Tavi.`);
      }
    }
    for (const [col, value] of Object.entries(row)) noticePaths((col.endsWith("_json") || col === "item_ids") && typeof value === "string" ? json(value) : value);
  }
  const usedFiles = new Set([...Object.keys(sourceFiles), ...Object.keys(previousFiles)].map((f) => f.toLowerCase()));
  const sourceAt = new Map(Object.keys(sourceFiles).map((file) => [file.toLowerCase(), file]));
  const nextFile = (file: string) => {
    const parsed = path.parse(file), series = /^(.*?)(\d+)$/.exec(parsed.name);
    let n = series ? Number(series[2]) + 1 : 1;
    let next: string;
    do {
      next = path.join(parsed.dir, series ? `${series[1]}${String(n++).padStart(series[2].length, "0")}${parsed.ext}` : `${parsed.name}-tavi-${n++}${parsed.ext}`);
      if (!Number.isSafeInteger(n)) throw new Error("Could not place a saved file: its running number is too large.");
    } while ([...usedFiles].some((used) => inside(used, next) || inside(next, used)));
    return next;
  };
  const directoryMoves = new Map<string, string>();
  for (const dir of [...protectedDirs].sort((a, b) => a.length - b.length)) {
    if ([...directoryMoves.keys()].some((parent) => inside(dir, parent))) continue;
    const next = renamedFile(dir);
    if (next !== dir) { directoryMoves.set(dir, next); continue; }
    if (Object.keys(sourceFiles).some((f) => inside(f, dir))) directoryMoves.set(dir, nextFile(dir));
  }
  for (const [before, after] of directoryMoves) {
    paths.set(path.join(plan.destination, before), path.join(plan.destination, after));
    report.changes.push(`Folder: ${plain(before)} becomes ${plain(after)}.`);
  }
  const placements: { from: string; to: string }[] = [];
  for (const [file, hash] of Object.entries(previousFiles)) {
    if (["profile", "secrets"].includes(file.split(path.sep)[0].toLowerCase())) continue;
    const earlierHash = earlierHashes.get(file.toLowerCase());
    const ours = protectedFiles.has(file) || (earlierHash === undefined ? !earlierFiles.has(file) : hash !== earlierHash);
    if (!ours) continue;
    let next = renamedFile(file);
    const directory = [...directoryMoves].find(([dir]) => inside(file, dir));
    if (directory) next = renamedFile(path.join(directory[1], path.relative(directory[0], file)));
    const incoming = sourceAt.get(next.toLowerCase());
    if (incoming && (sourceFiles[incoming] !== hash || protectedFiles.has(file))) {
      next = nextFile(next);
    }
    if (next !== file && usedFiles.has(next.toLowerCase())) throw new Error("Could not place a saved file: its new path is already in use.");
    if (next !== file) {
      paths.set(path.join(plan.destination, file), path.join(plan.destination, next));
      report.changes.push(`File: ${plain(file)} becomes ${plain(next)}.`);
    }
    usedFiles.add(next.toLowerCase());
    placements.push({ from: file, to: next });
  }
  // Parts folders follow all of their files as well as their containing drawing number.
  const rewriteString = (value: string): string => {
    if (paths.has(value)) return paths.get(value)!;
    const diskPath = path.isAbsolute(value) && !value.startsWith("/api/");
    if (diskPath) for (const [before, after] of directoryMoves) {
      const full = path.join(plan.destination, before);
      if (inside(value, full)) return renamedFile(path.join(plan.destination, after, path.relative(full, value)));
    }
    if (diskPath) return inside(value, plan.destination) ? renamedFile(value) : value;
    return replaceTokens(replaceTokens(value, numbers), idTokens);
  };
  // Made files use a saved name based on their path when the app scans them later.
  const usedDocs = new Set([...source.get("docs")!, ...get("docs")].map((r) => String(r.id)));
  for (const row of get("docs").filter((r) => isKept("docs", r))) {
    const nextPath = rewriteString(String(row.path));
    if (nextPath === row.path && !source.get("docs")!.some((r) => r.id === row.id)) continue;
    const next = "doc_" + digest(nextPath.toLowerCase()).slice(0, 16);
    if ((usedDocs.has(next) && next !== row.id) || source.get("docs")!.some((r) => r.id === next)) {
      throw new Error("Could not place a made file: its new saved name is already in use.");
    }
    maps.get("docs")!.set(String(row.id), next);
    idTokens.set(String(row.id), next);
    usedDocs.add(next);
    report.changes.push(`Saved file: ${plain(String(row.id))} becomes ${next}.`);
  }
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return rewriteString(value);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ["made_by_bot", "bot", "scope"].includes(k) ? v : rewrite(v)]));
    return value;
  };
  const rewriteSaved = (value: string) => {
    try {
      const parsed: unknown = JSON.parse(value), moved = rewrite(parsed);
      return JSON.stringify(parsed) === JSON.stringify(moved) ? value : JSON.stringify(moved);
    } catch { return rewriteString(value); }
  };
  const writeRow = (table: string, row: RecordRow) => {
    const next = Object.fromEntries(Object.entries(row).map(([col, value]) => {
      if ((col.endsWith("_json") || col === "item_ids") && typeof value === "string") {
        const moved = rewrite(json(value));
        return [col, JSON.stringify(moved) === JSON.stringify(json(value)) ? value : JSON.stringify(moved)];
      }
      if (["summary", "progress", "result"].includes(col) && typeof value === "string") return [col, rewriteSaved(value)];
      if (typeof value === "string") return [col, rewriteString(value)];
      return [col, value];
    })) as RecordRow;
    for (const [col, parent] of Object.entries(links[table] ?? {})) next[col] = maps.get(parent)?.get(String(row[col])) ?? next[col];
    const pk = keys.get(table)!;
    if (pk.length === 1) next[pk[0]] = maps.get(table)!.get(String(row[pk[0]])) ?? next[pk[0]];
    if (table === "docs" && next.path !== row.path) next.name = path.basename(String(next.path));
    const columns = Object.keys(next);
    try {
      db.prepare(`INSERT INTO ${name(table)} (${columns.map(name).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map((c) => next[c]));
    } catch { throw new Error("Could not place saved records: two records still need the same saved name or path."); }
    (nextOrigin.ours![table] ??= []).push(rowKey(next, pk));
  };
  db.exec("PRAGMA defer_foreign_keys=ON");
  for (const [table, rows] of old) for (const row of rows.filter((r) => isKept(table, r))) writeRow(table, row);
  if (previous) {
    // Team conversations belong to Tavi; only their embedded cards and links change.
    for (const table of ["bot_rows", "bot_cards"]) if (has(previous, table)) for (const row of all(previous, table)) {
      const col = table === "bot_rows" ? "body_json" : "card_json";
      const value = json(row[col]), moved = rewrite(value);
      insert(db, table, { ...row, [col]: JSON.stringify(value) === JSON.stringify(moved) ? row[col] : JSON.stringify(moved) });
    }
  }
  // Rebuild the search views from their kept records, rather than copying stale index rows.
  for (const [fts, columns, select] of [
    ["doc_fts", "doc_id,n,name,label,text", "SELECT p.doc_id,p.n,d.name,p.label,p.text FROM doc_parts p JOIN docs d ON d.id=p.doc_id"],
    ["ref_fts", "book_id,page,heading,text", "SELECT book_id,page,heading,text FROM ref_pages"],
  ]) db.exec(`DELETE FROM ${fts}; INSERT INTO ${fts} (${columns}) ${select};`);
  db.exec("INSERT INTO doc_fts(doc_id,n,name,label,text) SELECT d.id,-1,d.name,'','' FROM docs d WHERE d.skipped_reason IS NULL AND NOT EXISTS (SELECT 1 FROM doc_parts p WHERE p.doc_id=d.id)");
  // The sheet index includes extracted text that is not stored in sheets.
  if (previous && has(previous, "sheet_fts")) for (const row of all(previous, "sheet_fts")) {
    if (get("sheets").some((s) => s.id === row.sheet_id && isKept("sheets", s))) {
      db.prepare("INSERT INTO sheet_fts(sheet_id,sheet_no,title,body) VALUES(?,?,?,?)").run(rewriteString(String(row.sheet_id)), row.sheet_no, row.title, row.body);
    }
  }
  for (const placement of placements) {
    const out = path.join(plan.folder, placement.to);
    mkdirSync(path.dirname(out), { recursive: true });
    copyWithTimes(path.join(plan.previous, placement.from), out);
    if (placement.from !== placement.to && !sourceAt.has(placement.from.toLowerCase())) rmSync(path.join(plan.folder, placement.from), { force: true });
  }
  report.kinds.files = placements.length;
  if (previous) for (const row of all(previous, "settings")) {
    const team = /^(?:hq:|team:|bot:)/.test(String(row.key));
    if (team || (!db.prepare("SELECT 1 FROM settings WHERE key=?").get(row.key) && !origin.rows.settings?.includes(String(row.key)))) {
      insert(db, "settings", { ...row, value: rewriteSaved(String(row.value)) });
    }
  }
  nextOrigin.rows.settings = incomingSettings;
  insert(db, "settings", { key: originKey, value: JSON.stringify(nextOrigin) });
  return report;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Could not place")) throw new PlacementError(error.message, report);
    throw error;
  }
}
function key(folder: string): Buffer {
  const text = readFileSync(path.join(folder, "secrets", "master.key.dpapi"), "utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error("The saved secrets cannot be opened by this Windows user.");
  const script = "Add-Type -AssemblyName System.Security; " +
    `$b=[Convert]::FromBase64String('${text}'); ` +
    "$o=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($o)";
  try {
    return Buffer.from(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(), "base64");
  } catch { throw new Error("The saved secrets cannot be opened by this Windows user."); }
}
function decrypt(row: RecordRow, master: Buffer): unknown {
  const decipher = createDecipheriv("aes-256-gcm", master, Buffer.from(String(row.iv), "base64"));
  decipher.setAuthTag(Buffer.from(String(row.tag), "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(String(row.data), "base64")), decipher.final()]).toString("utf8"));
}

// Only these facts are proposed. Free-form life, work and people notes stay private.
export function aboutDraft(markdown: string): string {
  const lines: string[] = [];
  let section = "";
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) { section = heading[1].toLowerCase(); continue; }
    const line = /^-\s+(.+?)(?:\s+\(\d{4}-\d{2}-\d{2}\s*·[^)]*\))?$/.exec(raw)?.[1]?.trim();
    if (!line || /password|secret|token|api.?key|account|\bbsb\b|https?:|@|[<>\r\n]|ignore|system prompt|instructions/i.test(line)) continue;
    if (section === "basics" && /^(?:name|location|based in|lives in|home town|city|country|time zone):\s*[\p{L}\p{N} ,.'’/()+-]{1,120}$/iu.test(line)) lines.push(line);
    if (section === "how to talk to them" && /^(?:language|tone|style|prefers|likes):\s*[\p{L} ,.'’-]{1,180}$/iu.test(line)) lines.push(line);
  }
  return [...new Set(lines)].join("\n").slice(0, 1500);
}

function remap(db: DatabaseSync, from: string, to: string) {
  const move = (value: unknown): unknown => {
    if (typeof value === "string" && path.isAbsolute(value) && inside(value, from)) return path.join(to, path.relative(from, value));
    if (Array.isArray(value)) return value.map(move);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, move(v)]));
    return value;
  };
  const fields: Record<string, string[]> = {
    folders: ["path"], docs: ["path", "meta_json"], drawing_files: ["path"], sheets: ["data_dir"], drawing_crops: ["path"],
    shop_drawing_revs: ["pdf", "dxf", "parts_dir", "model_json", "input_json", "sheets_json"],
    guide_updates: ["staged"], ref_books: ["path"], items: ["payload_json"],
  };
  for (const [table, columns] of Object.entries(fields)) {
    for (const row of db.prepare(`SELECT rowid AS carry_rowid, * FROM ${name(table)}`).all() as RecordRow[]) {
      for (const col of columns) {
        if (typeof row[col] !== "string") continue;
        let next: unknown;
        if (col.endsWith("_json")) next = JSON.stringify(move(JSON.parse(String(row[col]))));
        else next = move(row[col]);
        if (next !== row[col]) db.prepare(`UPDATE ${name(table)} SET ${name(col)}=? WHERE rowid=?`).run(next as SQLInputValue, row.carry_rowid);
      }
    }
  }
  for (const row of all(db, "settings")) {
    if (["reference.dir", "blender.path", "drawings.logo", "brainlink.home"].includes(String(row.key))) {
      db.prepare("UPDATE settings SET value=? WHERE key=?").run(move(row.value) as SQLInputValue, row.key);
    }
  }
}

export async function prepareCopy(plan: CopyPlan): Promise<void> {
  process.env.LH_DATA_DIR = plan.folder;
  process.env.LH_BRAIN_CWD = path.join(path.dirname(plan.folder), "brain");
  process.env.LH_DEV = "1";
  const { db } = await import("../store/db.js");
  const profiles = ["USER.md", "SOUL.md"].map((file) => {
    const full = path.join(plan.folder, "profile", file);
    return { full, bytes: existsSync(full) ? readFileSync(full) : undefined };
  });
  let previous: DatabaseSync | undefined;
  let step = "database";
  try {
    if (existsSync(path.join(plan.previous, "harness.db"))) previous = new DatabaseSync(path.join(plan.previous, "harness.db"), { readOnly: true });
    const receiptRow = previous?.prepare("SELECT value FROM settings WHERE key='carry-over:receipt'").get() as { value: string } | undefined;
    const receipt = receiptRow ? JSON.parse(receiptRow.value) as { source: string; destination: string } : undefined;
    const unchanged = !!previous && receipt?.source === plan.sourceStamp && receipt.destination === contentStamp(previous, plan.previous);
    const sourceCounts = counts(db);
    const kept = { bots: 0, conversations: 0, cards: 0 };
    let work: MergeReport;
    transaction(db, () => {
      db.exec("UPDATE memories SET scope='lead'");
      // An explicit empty maker prevents an old job name from being mistaken for a team bot.
      db.exec("UPDATE items SET payload_json=json_set(payload_json, '$._meta.made_by_bot', NULL)");
      db.exec("UPDATE docs SET meta_json=json_set(coalesce(meta_json, '{}'), '$.made_by_bot', NULL) WHERE type='made' OR json_extract(meta_json, '$.by')='assistant'");
      remap(db, plan.source, plan.destination);
      if (!previous) { work = mergeWork(db, previous, plan); return; }
      for (const table of ["bots", "bot_cards", "bot_rows", "about_card"]) {
        if (!has(previous, table)) continue;
        for (const row of all(previous, table)) insert(db, table, row);
      }
      kept.bots = has(previous, "bots") ? count(previous, "bots") : 0;
      kept.conversations = has(previous, "bot_rows") ? count(previous, "bot_rows") : 0;
      kept.cards = has(previous, "bot_cards") ? count(previous, "bot_cards") : 0;
      for (const row of all(previous, "settings")) if (/^(?:hq:|team:|bot:|carry-over:)/.test(String(row.key))) insert(db, "settings", row);
      work = mergeWork(db, previous, plan);
      const imported = previous.prepare("SELECT value FROM settings WHERE key='carry-over:history'").get() as { value: string } | undefined;
      if (imported) {
        const old = JSON.parse(imported.value) as { bot: string; generation: number; seqs: number[] };
        for (const seq of old.seqs) {
          db.prepare("DELETE FROM bot_rows WHERE bot=? AND generation=? AND seq=?").run(old.bot, old.generation, seq);
          kept.conversations--;
        }
      }
    });
    step = "secrets";
    const { getSecret, putSecret } = await import("../store/secrets.js");
    const known = db.prepare("SELECT name FROM secrets ORDER BY name LIMIT 1").get() as { name: string } | undefined;
    try { if (known) getSecret(known.name); }
    catch { throw new Error("A carried secret could not be opened. Use the same Windows user as the live assistant."); }
    transaction(db, () => {
      const rows = previous ? all(previous, "secrets").filter((row) => /^(bot:|team:)/.test(String(row.name))) : [];
      if (rows.length) {
        const master = key(plan.previous);
        try { for (const row of rows) putSecret(String(row.name), decrypt(row, master)); }
        finally { master.fill(0); }
      }
    });
    step = "team";
    const { seedTeam } = await import("./bots.js");
    seedTeam();
    const lead = db.prepare("SELECT id,generation FROM bots WHERE lead=1 AND removed_at IS NULL").get() as { id: string; generation: number } | undefined;
    if (!lead) throw new Error("The saved team has no lead bot.");
    let history = 0;
    transaction(db, () => {
      const lines = db.prepare("SELECT * FROM conversation_log WHERE role IN ('user','assistant','guest') AND channel NOT IN ('test','system') ORDER BY id DESC LIMIT 60").all().reverse() as RecordRow[];
      const generation = lead.generation;
      const existing = db.prepare("SELECT * FROM bot_rows WHERE bot=? AND generation=? ORDER BY seq").all(lead.id, generation) as RecordRow[];
      let seq = 0;
      let rev = Number((db.prepare("SELECT max(rev) n FROM bot_rows WHERE bot=?").get(lead.id) as { n: number | null }).n ?? 0);
      db.prepare("DELETE FROM bot_rows WHERE bot=? AND generation=?").run(lead.id, generation);
      for (const line of lines) {
        const body = { kind: "message", from: line.role === "user" ? "owner" : line.role === "guest" ? "other-bot" : "bot", text: line.text, via: line.channel };
        insert(db, "bot_rows", { bot: lead.id, generation, seq: ++seq, rev: ++rev, ts: line.ts, kind: "message", body_json: JSON.stringify(body) });
      }
      for (const row of existing) insert(db, "bot_rows", { ...row, seq: ++seq, rev: ++rev });
      insert(db, "settings", { key: "carry-over:history", value: JSON.stringify({ bot: lead.id, generation, seqs: lines.map((_, i) => i + 1) }) });
      history = lines.length;
    });
    const user = profiles.find((p) => p.full.endsWith("USER.md"))?.bytes?.toString("utf8") ?? "";
    const draft = aboutDraft(user);
    const { proposeAboutChange } = await import("./about.js");
    const approved = db.prepare("SELECT text FROM about_card WHERE id=1").get() as { text: string };
    transaction(db, () => {
      const marker = db.prepare("SELECT value FROM settings WHERE key='carry-over:about'").get() as { value: string } | undefined;
      // A fresh carry-over renews a waiting proposal; a decision is always kept.
      if (marker) db.prepare("UPDATE approvals SET expires_at=? WHERE id=? AND status='pending'").run(new Date(Date.now() + 15 * 60_000).toISOString(), marker.value);
      if (draft && !approved.text && !marker) {
        const approval = proposeAboutChange("Carry-over", draft, "Only your name, location and speaking preferences from your profile. Please check these before sharing them with the team.");
        insert(db, "settings", { key: "carry-over:about", value: approval.id });
      }
    });
    for (const profile of profiles) {
      if (profile.bytes) writeFileSync(profile.full, profile.bytes);
      else rmSync(profile.full, { force: true });
    }
    step = "secrets";
    if (known) getSecret(known.name);
    step = "database";
    const proposal = !approved.text && !!db.prepare("SELECT 1 FROM settings s JOIN approvals a ON a.id=s.value WHERE s.key='carry-over:about' AND a.status='pending'").get();
    if ((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("The copied database did not pass its checks.");
    insert(db, "settings", { key: "carry-over:receipt", value: JSON.stringify({ source: plan.sourceStamp, destination: contentStamp(db, plan.folder) }) });
    writeFileSync(plan.result, JSON.stringify({ counts: sourceCounts, kept, work: work!, unchanged, history, proposal, draft: !!draft, secrets: !!known, outside: outsidePaths(db, plan.destination) }));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
  } catch (error) {
    writeFileSync(plan.result, JSON.stringify({ error: step === "secrets" ? "A copied secret could not be opened. Use the same Windows user as the live assistant. Nothing was replaced." : error instanceof Error && error.message.startsWith("Could not place") ? error.message : "The prepared data did not pass its checks. Nothing was replaced.",
      ...(error instanceof PlacementError ? { work: error.report, counts: counts(db) } : {}) }));
    throw error;
  } finally { previous?.close(); db.close(); }
}

function counts(db: DatabaseSync) {
  return { memories: count(db, "memories"), routines: count(db, "routines"), commitments: count(db, "commitments"),
    items: db.prepare("SELECT kind,count(*) n FROM items GROUP BY kind ORDER BY kind").all() as { kind: string; n: number }[],
    pins: count(db, "pins"), drawings: count(db, "shop_drawings"), models: Number((db.prepare("SELECT count(*) n FROM items WHERE kind='model'").get() as { n: number }).n),
    lines: count(db, "conversation_log"), devices: count(db, "computers"), pushes: count(db, "push_subscriptions"), siri: count(db, "shortcut_keys") };
}
function outsidePaths(db: DatabaseSync, folder: string) {
  const paths = new Set<string>();
  for (const row of db.prepare("SELECT path FROM folders UNION SELECT value path FROM settings WHERE key IN ('reference.dir','brainlink.home','blender.path','drawings.logo')").all() as { path: string }[]) {
    if (row.path && path.isAbsolute(row.path) && !inside(row.path, folder)) paths.add(row.path);
  }
  const reference = db.prepare("SELECT value FROM settings WHERE key='reference.dir'").get() as { value: string } | undefined;
  if (!reference?.value && process.env.USERPROFILE) for (const folder of ["Tavi Reference", earlier.referenceFolder]) paths.add(path.join(process.env.USERPROFILE, folder));
  return [...paths].sort().map((p) => ({ path: p, exists: existsSync(p) }));
}

export async function carryOver(options: CarryOptions): Promise<CarryResult> {
  let source: string, destination: string;
  let sourceFiles: { file: string; size: number }[], targetFiles: { file: string; size: number }[];
  let lock: DatabaseSync | undefined;
  try {
    ({ source, destination } = folders(options.from, options.to));
    if ((await Promise.all([portBusy("127.0.0.1"), portBusy("::1")])).some(Boolean)) throw new Error("Please stop the practice run first (port 3100 is in use).");
    try { lock = exclusive(destination); unlock(lock); lock = undefined; }
    catch { throw new Error("Please stop the practice run first (its saved database is in use)."); }
    sourceFiles = entries(source); targetFiles = entries(destination, "", true);
    for (const sourceFile of sourceFiles) for (const targetFile of targetFiles) {
      if (sourceFile.file.toLowerCase() !== targetFile.file.toLowerCase() && (inside(sourceFile.file, targetFile.file) || inside(targetFile.file, sourceFile.file))) {
        throw new Error(`Could not place saved files: ${plain(sourceFile.file)} and ${plain(targetFile.file)} need the same place as both a file and a folder.`);
      }
    }
  } catch (error) { unlock(lock); return { code: 2, report: error instanceof Error ? error.message : "The folders could not be checked." }; }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  let work: string | undefined, backup: string | undefined, holding: string | undefined, commandLock: string | undefined;
  let moved = false, installed = false, movedBackups = false;
  try {
    // A second command must not prepare a replacement at the same time.
    if (options.yes) mkdirSync(path.dirname(destination), { recursive: true });
    if (options.yes) {
      const lockPath = path.join(path.dirname(destination), `.tavi-carry-${createHash("sha256").update(destination.toLowerCase()).digest("hex").slice(0, 16)}.lock`);
      try { closeSync(openSync(lockPath, "wx")); commandLock = lockPath; }
      catch { return { code: 2, report: "Another carry-over is using this Tavi folder. Wait for it to finish." }; }
    }
    work = mkdtempSync(path.join(options.yes ? path.dirname(destination) : tmpdir(), ".tavi-carry-"));
    const staged = path.join(work, "prepared"), previous = path.join(work, "previous");
    mkdirSync(staged); mkdirSync(previous);
    if (existsSync(path.join(destination, "harness.db"))) {
      snapshot(destination, path.join(previous, "harness.db"));
    }
    copyFiles(destination, previous, targetFiles);
    copyFiles(destination, staged, targetFiles);
    copyTree(path.join(destination, "guard"), path.join(staged, "guard"));
    copyFiles(source, staged, sourceFiles);
    snapshot(source, path.join(staged, "harness.db"));
    const sourceDb = readOnly(path.join(staged, "harness.db"));
    let sourceStamp: string;
    try { sourceStamp = contentStamp(sourceDb, source); } finally { sourceDb.close(); }
    const result = path.join(work, "result.json");
    const child = spawnSync(process.execPath, ["--no-warnings", command, "--prepare-copy", JSON.stringify({ folder: staged, previous, source, destination, result, sourceStamp })], {
      cwd: repo, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
      env: { ...process.env, LH_DATA_DIR: staged, LH_DEV: "1", LH_BRAIN_CWD: path.join(work, "brain") },
    });
    if (child.status !== 0 || child.error) {
      const problem = existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) as { error?: string; work?: MergeReport; counts?: ReturnType<typeof counts> } : {};
      if (problem.work && problem.counts) {
        const c = problem.counts;
        return { code: 3, report: ["Carry-over stopped: the Tavi folder was left as it was.",
          `Would bring in: ${c.memories} memories; ${c.routines} routines; ${c.commitments} commitments; ${c.pins} pins; ${c.drawings} drawing sets.`,
          `Items by kind: ${itemCounts(c.items)}.`, ...workLines(problem.work), problem.error!].join("\n") };
      }
      if (options.yes && existsSync(path.join(previous, "harness.db")) && !problem.error?.startsWith("Could not place")) {
        backup = path.join(destination, "backup", `before-carry-over-${stamp}`);
        mkdirSync(backup, { recursive: true });
        copyFiles(destination, backup, targetFiles);
        copyFileSync(path.join(previous, "harness.db"), path.join(backup, "harness.db"));
        copyTree(path.join(destination, "guard"), path.join(backup, "guard"));
      }
      throw new Error(problem.error ?? "The prepared copy could not be checked. Nothing was replaced.");
    }
    const info = JSON.parse(readFileSync(result, "utf8")) as { counts: ReturnType<typeof counts>; kept: { bots: number; conversations: number; cards: number }; work: MergeReport; unchanged: boolean; history: number; proposal: boolean; draft: boolean; secrets: boolean; outside: { path: string; exists: boolean }[] };
    if (options.yes && !info.unchanged && existsSync(path.join(previous, "harness.db"))) {
      backup = path.join(destination, "backup", `before-carry-over-${stamp}`);
      mkdirSync(backup, { recursive: true });
      copyFiles(destination, backup, targetFiles);
      copyFileSync(path.join(previous, "harness.db"), path.join(backup, "harness.db"));
      copyTree(path.join(destination, "guard"), path.join(backup, "guard"));
    }
    const c = info.counts;
    const bytes = sourceFiles.reduce((sum, file) => sum + file.size, 0) + statSync(path.join(staged, "harness.db")).size;
    const skipped = ["Outside folders are linked, not copied.", "Old backups, the live guard folder and .env files are skipped."];
    if (!existsSync(path.join(source, "profile", "USER.md"))) skipped.push("No user profile file was found.");
    if (!info.draft) skipped.push("No clearly labelled name, location or speaking preferences were found for a new about card.");
    const report = [options.yes ? "Carry-over finished." : "Dry run: nothing changed in the Tavi folder.",
      `${options.yes ? "Carried" : "Would carry"}: ${c.memories} memories; ${c.routines} routines; ${c.commitments} commitments.`,
      `Items by kind: ${itemCounts(c.items)}.`,
      `${c.pins} pins; ${c.drawings} shop drawing sets; ${c.models} models; ${c.lines} conversation lines.`,
      `${c.devices} paired devices; ${c.pushes} push subscriptions; ${c.siri} Siri keys.`,
      `Size ${options.yes ? "copied" : "to copy"}: ${bytes.toLocaleString("en-AU")} bytes.`,
      `Kept from Tavi: ${info.kept.bots} bots; ${info.kept.conversations} conversation rows; ${info.kept.cards} job cards; its about card, guard folder and bot keys.`,
      ...workLines(info.work),
      ...(info.unchanged ? ["Already up to date: no records or files need changing. No new backup or saved report is needed."] : []),
      `Lead chat: the latest ${info.history} earlier lines ${options.yes ? "added" : "would be added"}; repeat runs refresh them without doubling.`,
      info.proposal ? "Needs your tap: review the about-card proposal in Approvals when Tavi starts (approvals last 15 minutes)." : "About card: the existing choice was kept, or no safe draft was found.",
      info.secrets ? "A carried secret opened successfully; saved bot keys were checked as they were kept." : "No earlier secrets to check; new team keys are saved as usual.",
      ...skipped, ...info.outside.map((p) => `Outside path: ${p.path.replace(/[\r\n\x00-\x1f]/g, " ")} (${p.exists ? "exists" : "missing"}).`),
      ...(backup ? [`Backup: ${backup}`] : []),
      options.yes && !info.unchanged ? `Report: ${path.join(destination, "logs", `carry-over-${stamp}.txt`)}` : "No report file was written: the Tavi folder is unchanged.",
    ].join("\n");
    if (!options.yes) return { code: 0, report };
    if (info.unchanged) return { code: 0, report };
    mkdirSync(path.join(staged, "logs"), { recursive: true });
    writeFileSync(path.join(staged, "logs", `carry-over-${stamp}.txt`), report + "\n");
    // Recheck just before replacement, then close the handle so Windows can move the folder.
    if ((await Promise.all([portBusy("127.0.0.1"), portBusy("::1")])).some(Boolean)) throw new Error("Please stop the practice run first. Nothing was replaced.");
    lock = exclusive(destination);
    unlock(lock); lock = undefined;
    holding = path.join(work, "original");
    if (existsSync(destination)) { renameSync(destination, holding); moved = true; }
    if (moved && existsSync(path.join(holding, "backup"))) { renameSync(path.join(holding, "backup"), path.join(staged, "backup")); movedBackups = true; }
    renameSync(staged, destination); installed = true;
    return { code: 0, report, backup };
  } catch (error) {
    let restored = true;
    try {
      if (installed) renameSync(destination, path.join(work!, "prepared"));
      if (movedBackups) renameSync(path.join(work!, "prepared", "backup"), path.join(holding!, "backup"));
      if (moved) renameSync(holding!, destination);
    } catch { restored = false; }
    const reason = error instanceof Error && /^(A copied secret|The prepared|The starting database|Please stop|Could not place)/.test(error.message) ? `\n${error.message}` : "";
    return { code: 3, backup, report: `Carry-over stopped part-way. ${restored ? "The Tavi folder was left as it was." : `The original folder is still at ${holding}. Restore it before starting Tavi.`}${reason}${backup ? `\nBackup: ${backup}` : "\nNo earlier database needed a backup."}` };
  } finally {
    unlock(lock);
    // Keep an original folder if Windows refused to put it back.
    try {
      if (work && !(holding && existsSync(holding) && !installed && !existsSync(destination))) rmSync(work, { recursive: true, force: true });
    } catch { /* Windows may still have a file open; the backup and final report remain available. */ }
    if (commandLock) rmSync(commandLock, { force: true });
  }
}

function itemCounts(items: { kind: string; n: number }[]): string {
  const titles: Record<string, string> = { sheet: "drawing sheets", list: "lists", table: "tables", draft: "drafts", note: "notes", image: "pictures", doc: "documents", legacy: "earlier cards", sketch: "sketches", model: "models", shopdrawing: "shop drawings", reference: "reference pages" };
  const groups = new Map<string, number>();
  for (const item of items) { const title = titles[item.kind] ?? "other items"; groups.set(title, (groups.get(title) ?? 0) + item.n); }
  return [...groups].map(([title, n]) => `${title}: ${n}`).join(", ") || "none";
}
