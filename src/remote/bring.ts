// Bringing files across from another computer (Stage 11.5). Each file is copied into this PC's inbox for it
// (data/remote/<computer>/, keeping its name; "(2)" if a different file has that name already) or, only when the owner
// asks for a reference book, onto the reference shelf (added, never replacing a book). Where it came from is written to
// audit_log (computer.bring: the computer, its path there, where it went here, its size and fingerprint) and, for a
// file the files library reads, into its record too. Nothing is filed into a job or anywhere else on its own.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../store/db.js";
import { audit } from "../store/log.js";
import { ensureRemoteFolder, REMOTE_DIR, scanFolder } from "../files/library.js";
import { referenceDir } from "../reference/dir.js";
import { scanShelf } from "../reference/library.js";
import type { Computer } from "./computers.js";
import { readWhole, mb } from "./files.js";
import { ask, lineInfo, RemoteError } from "./hub.js";

/** Ask the owner before more than this in one go (11.5). */
export const ASK_OVER_FILES = 5;
export const ASK_OVER_BYTES = 200 * 1024 * 1024;

export type BringTo = "inbox" | "shelf";
export type Brought = { from: string; name: string; local: string; size: number; sha256: string; same_as_before: boolean };

/** A file name that's safe here: no folder parts, nothing Windows won't take. */
export function safeName(name: string) {
  const clean = path
    .basename(name.replace(/\\/g, "/"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 150);
  return clean || "file";
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Where it goes: name.ext, or "name (2).ext" if another file has that name; the same file already there is reused. */
async function placeFor(dir: string, name: string, hash: string): Promise<{ file: string; same: boolean }> {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const file = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`);
    if (!existsSync(file)) return { file, same: false };
    if (sha(await readFile(file)) === hash) return { file, same: true };
  }
}

/** What would be brought: each file's size, so the owner can be asked first when it's a lot. */
export async function sizeUp(c: Computer, paths: string[]) {
  const files: { path: string; size: number }[] = [];
  for (const p of paths) {
    const st = await ask(c.name, "stat", { path: p });
    if (st.kind !== "file") throw new RemoteError("not_a_file", `${p} is a folder, not a file. Say which files in it.`);
    files.push({ path: p, size: Number(st.size) });
  }
  const total = files.reduce((t, f) => t + f.size, 0);
  return { files, total, needsAsking: files.length > ASK_OVER_FILES || total > ASK_OVER_BYTES };
}

/**
 * Copies the files here, one at a time, each checked to have arrived whole. Inbox files are then read by the files
 * library (photos, documents and text are searchable and can be shown; a PDF opens in the drawing viewer, under "From
 * the other computer"); a book for the shelf is added to the reference folder and read there.
 */
export async function bringFiles(c: Computer, paths: string[], to: BringTo): Promise<Brought[]> {
  const limit = Math.min(4096, lineInfo(c.name)?.maxFileMb ?? 50) * 1024 * 1024;
  const dir = to === "shelf" ? referenceDir() : path.join(REMOTE_DIR, c.name);
  mkdirSync(dir, { recursive: true });
  const out: Brought[] = [];
  for (const p of paths) {
    const f = await readWhole(c.name, p, limit, "bring");
    const hash = sha(f.data);
    const { file, same } = await placeFor(dir, safeName(f.name), hash);
    if (!same) {
      const part = `${file}.${process.pid}.part`;
      try {
        await writeFile(part, f.data);
        if (sha(await readFile(part)) !== hash) throw new Error("The copy here doesn't match. Nothing was kept.");
        await rename(part, file);
      } catch (e) {
        await rm(part, { force: true });
        throw e;
      }
    }
    const where = to === "shelf" ? `reference shelf: ${path.basename(file)}` : path.relative(REMOTE_DIR, file).replace(/\\/g, "/");
    audit("helper", "computer.bring", c.name, { from: p.slice(0, 400), to: where, size: f.size, sha256: hash, ...(same ? { already_here: true } : {}) });
    out.push({ from: p, name: path.basename(file), local: file, size: f.size, sha256: hash, same_as_before: same });
  }
  if (to === "shelf") void scanShelf();
  else {
    await scanFolder(ensureRemoteFolder());
    // Where each came from, on its record in the files library (a PDF's is in the audit log).
    for (const b of out) db.prepare("UPDATE docs SET meta_json = json_set(COALESCE(meta_json, '{}'), '$.from', json(?)) WHERE path = ?").run(JSON.stringify({ computer: c.name, path: b.from }), b.local);
  }
  return out;
}

/** A PDF brought into the inbox, once the drawings indexer has read it: its first sheet, or null if it isn't ready. */
export async function sheetFor(sha256: string, waitMs = 60_000): Promise<{ sheet: string | null; state: string }> {
  const t0 = Date.now();
  for (;;) {
    const row = db.prepare("SELECT status FROM drawing_files WHERE hash = ?").get(sha256) as { status: string } | undefined;
    if (row?.status === "ready") {
      const s = db.prepare("SELECT id FROM sheets WHERE file_hash = ? ORDER BY page LIMIT 1").get(sha256) as { id: string } | undefined;
      return { sheet: s?.id ?? null, state: s ? "ready" : "no pages" };
    }
    if (row?.status === "failed") return { sheet: null, state: "failed" };
    if (Date.now() - t0 > waitMs) return { sheet: null, state: row?.status ?? "not queued" };
    await new Promise((r) => setTimeout(r, 300));
  }
}

export { mb };
