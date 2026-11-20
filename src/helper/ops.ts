// The five things the helper does, and nothing else: roots, list, find, stat, read. Every one only reads. Every path is
// checked by safety.ts first; a path it won't show gets the same answer as one that isn't there.
import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Root } from "./config.js";
import { mayShow, neverShown, placeOf, rootReal, type SafetyOpts } from "./safety.js";

export const LIST_MAX = 500;
export const FIND_MAX = 200;
export const FIND_MS = 10_000;
/** The most one piece of a read may be; the assistant asks for a file piece by piece. */
export const PIECE_MAX = 512 * 1024;

export type OpCode = "not_found" | "cant_read" | "too_big" | "bad_request" | "not_a_folder" | "not_a_file";
export class OpError extends Error {
  constructor(
    readonly code: OpCode,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export type OpCtx = SafetyOpts & { roots: Root[]; maxFileBytes: number; findMs?: number };
type Kind = "folder" | "file";
type Entry = { name: string; kind: Kind; size?: number; changed: string };

const changed = (ms: number) => new Date(ms).toISOString();
const notFound = () => new OpError("not_found");

/** The folders it may show, by name. A folder that isn't there right now (an unplugged drive) is listed as away. */
export async function roots(c: OpCtx) {
  const here: { name: string }[] = [];
  const away: string[] = [];
  for (const r of c.roots) ((await rootReal(r, c)) ? here.push({ name: r.name }) : away.push(r.name));
  return { roots: here, ...(away.length ? { away } : {}) };
}

/**
 * What a directory entry really is, if it may be shown. A link or junction is followed only to check where it leads:
 * it's shown only if that's still inside the folder and not on the never list. (A cloud file, such as a OneDrive
 * placeholder, also reads as a link here, and resolves to itself.) itself: the entry IS what it resolves to.
 */
async function entryOf(dir: string, e: Dirent, top: string, c: SafetyOpts): Promise<{ kind: Kind; itself: boolean } | null> {
  if (neverShown(e.name)) return null;
  const p = path.join(dir, e.name);
  if (e.isSymbolicLink()) {
    try {
      const real = await realpath(p);
      if (!(await mayShow(real, top, c))) return null;
      const st = await stat(real);
      return st.isDirectory() ? { kind: "folder", itself: real.toLowerCase() === p.toLowerCase() } : st.isFile() ? { kind: "file", itself: true } : null;
    } catch {
      return null;
    }
  }
  if (!(await mayShow(p, top, c))) return null;
  return e.isDirectory() ? { kind: "folder", itself: true } : e.isFile() ? { kind: "file", itself: true } : null;
}

/** A hard link (a file with a second name) is never shown: the other name may be anywhere on the drive. */
const linkedTwice = (s: { isFile(): boolean; nlink: number }) => s.isFile() && s.nlink > 1;

/** What's in one folder: folders first, then files, by name. At most LIST_MAX, and how many more there were. */
export async function list(c: OpCtx, a: { path?: unknown }) {
  const place = await placeOf(c.roots, a.path, c);
  if (!place) throw notFound();
  const st = await stat(place.real).catch((e) => {
    throw readError(e);
  });
  if (!st.isDirectory()) throw new OpError("not_a_folder");
  let names: Dirent[];
  try {
    names = await readdir(place.real, { withFileTypes: true });
  } catch (e) {
    throw readError(e);
  }
  const shown: { name: string; kind: Kind }[] = [];
  for (const e of names) {
    const it = await entryOf(place.real, e, place.rootReal, c);
    if (it) shown.push({ name: e.name, kind: it.kind });
  }
  shown.sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name, undefined, { sensitivity: "base", numeric: true }) : x.kind === "folder" ? -1 : 1));
  const entries: Entry[] = [];
  for (const e of shown.slice(0, LIST_MAX)) {
    const s = await stat(path.join(place.real, e.name)).catch(() => null);
    if (!s || linkedTwice(s)) continue;
    entries.push({ name: e.name, kind: e.kind, ...(e.kind === "file" ? { size: s.size } : {}), changed: changed(s.mtimeMs) });
  }
  return { path: place.shown, entries, more: Math.max(0, shown.length - LIST_MAX) };
}

/** Plain words to look for: "Example Lake quote" or ["Example Lake", "quote"]. */
function wordsOf(w: unknown): string[] | null {
  const raw = Array.isArray(w) ? w.filter((x) => typeof x === "string").join(" ") : typeof w === "string" ? w : "";
  const words = raw
    .toLowerCase()
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= 60);
  return words.length && words.length <= 8 ? words : null;
}

/**
 * Files (and folders) whose path inside the folder holds every word, under one folder or all of them. Never-shown
 * names are skipped and never looked inside; a link or junction is never followed while looking (what it leads to,
 * if it's inside the folder, is found at its own place). At most FIND_MAX; stops after FIND_MS and says so. Best
 * first: most words in the name itself, then newest.
 */
export async function find(c: OpCtx, a: { words?: unknown; root?: unknown }) {
  const words = wordsOf(a.words);
  if (!words) throw new OpError("bad_request");
  const which = typeof a.root === "string" && a.root.trim() ? c.roots.filter((r) => r.name.toLowerCase() === String(a.root).trim().toLowerCase()) : c.roots;
  if (typeof a.root === "string" && a.root.trim() && !which.length) throw notFound();
  const deadline = Date.now() + (c.findMs ?? FIND_MS);
  const hits: { shown: string; real: string; kind: Kind; score: number }[] = [];
  let stoppedEarly = false;
  let more = false;
  outer: for (const root of which) {
    const top = await rootReal(root, c);
    if (!top) continue;
    const queue: { dir: string; shown: string }[] = [{ dir: top, shown: root.name }];
    while (queue.length) {
      if (Date.now() > deadline) {
        stoppedEarly = true;
        break outer;
      }
      const { dir, shown } = queue.shift()!;
      let names: Dirent[];
      try {
        names = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of names) {
        const it = await entryOf(dir, e, top, c);
        if (!it || !it.itself) continue;
        const kind = it.kind;
        const real = path.join(dir, e.name);
        const p = `${shown}/${e.name}`;
        if (kind === "folder") queue.push({ dir: real, shown: p });
        const hay = p.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
        if (hits.length >= FIND_MAX) {
          more = true;
          break outer;
        }
        const name = e.name.toLowerCase();
        hits.push({ shown: p, real, kind, score: words.filter((w) => name.includes(w)).length });
      }
    }
  }
  const results: (Entry & { path: string; score: number })[] = [];
  for (const h of hits) {
    const s = await stat(h.real).catch(() => null);
    if (!s || linkedTwice(s)) continue;
    results.push({ path: h.shown, name: path.basename(h.real), kind: h.kind, ...(h.kind === "file" ? { size: s.size } : {}), changed: changed(s.mtimeMs), score: h.score });
  }
  results.sort((x, y) => y.score - x.score || y.changed.localeCompare(x.changed));
  return { results: results.map(({ score: _s, ...r }) => r), more, stopped_early: stoppedEarly };
}

/** One file's or folder's size, date and kind. */
export async function statOf(c: OpCtx, a: { path?: unknown }) {
  const place = await placeOf(c.roots, a.path, c);
  if (!place) throw notFound();
  const s = await stat(place.real).catch((e) => {
    throw readError(e);
  });
  if (!s.isFile() && !s.isDirectory()) throw notFound();
  const kind: Kind = s.isDirectory() ? "folder" : "file";
  return { path: place.shown, name: path.basename(place.real), kind, ...(kind === "file" ? { size: s.size } : {}), changed: changed(s.mtimeMs) };
}

/** A file that can't be opened (locked, in use, no rights) is "can't be read". The lock is never got around. */
function readError(e: unknown) {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return notFound();
  return new OpError("cant_read");
}

/** One piece of a file's bytes, from offset, at most PIECE_MAX. Files over the size limit aren't read at all. */
export async function read(c: OpCtx, a: { path?: unknown; offset?: unknown; length?: unknown }) {
  const offset = Number(a.offset ?? 0);
  const length = Number(a.length ?? PIECE_MAX);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1) throw new OpError("bad_request");
  const place = await placeOf(c.roots, a.path, c);
  if (!place) throw notFound();
  const s = await stat(place.real, { bigint: true }).catch((e) => {
    throw readError(e);
  });
  if (!s.isFile()) throw new OpError("not_a_file");
  const size = Number(s.size);
  if (size > c.maxFileBytes) throw new OpError("too_big", { size, limit: c.maxFileBytes });
  let fh;
  try {
    fh = await open(place.real, "r");
  } catch (e) {
    throw readError(e);
  }
  try {
    // What was opened must be the file that was checked: if a folder on the way was swapped for a junction in between,
    // the path now leads somewhere else, so check again and compare the file's identity.
    const opened = await fh.stat({ bigint: true });
    const again = await placeOf(c.roots, a.path, c);
    const now = again ? await stat(again.real, { bigint: true }).catch(() => null) : null;
    if (!again || !now || now.ino !== opened.ino || now.dev !== opened.dev || opened.ino !== s.ino) throw notFound();
    const want = Math.max(0, Math.min(length, PIECE_MAX, size - offset));
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const r = await fh.read(buf, got, want - got, offset + got).catch((e) => {
        throw readError(e);
      });
      if (!r.bytesRead) break;
      got += r.bytesRead;
    }
    return { path: place.shown, size, changed: changed(Number(s.mtimeMs)), offset, data: buf.subarray(0, got).toString("base64"), eof: offset + got >= size };
  } finally {
    await fh.close().catch(() => {});
  }
}
