// Where the owner's reference books are (Stage 8). The folder is only ever read: nothing here or anywhere else writes,
// moves or renames anything in it, with one exception: a book brought from the owner's other computer when he asks
// (Stage 11.5, remote/bring.ts) is ADDED as a new file, never replacing one. Page pictures made from the books are a
// cache under the data folder.
import { earlier } from "../shared/earlier.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEV } from "../dev.js";
import { DATA_DIR } from "../store/db.js";
import { getSettings } from "../store/settings.js";

/** The cache of page pictures (data/reference/pages), never inside the reference folder. */
export const REF_CACHE = path.join(DATA_DIR, "reference");

export function defaultReferenceDir(home: string): string {
  const current = path.join(home, 'Tavi Reference'), old = path.join(home, earlier.referenceFolder);
  return existsSync(current) || !existsSync(old) ? current : old;
}

/**
 * The reference folder. REFERENCE_DIR wins (the live checks point dev at the real books, read-only). Otherwise, in dev
 * and tests it is a folder inside the dev or test data folder, never the owner's; on the live assistant it is the
 * reference.dir setting, or %USERPROFILE%\Tavi Reference.
 */
export function referenceDir(): string {
  if (process.env.REFERENCE_DIR) return path.resolve(process.env.REFERENCE_DIR);
  if (DEV) return path.join(DATA_DIR, "reference-shelf");
  const set = getSettings()["reference.dir"].trim();
  const home = process.env.USERPROFILE || homedir();
  // Reference books are read only: keep an existing earlier shelf without moving its files.
  return path.resolve(set || defaultReferenceDir(home));
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** True for the reference folder itself and anything inside it. */
export const insideReference = (p: string) => inside(path.resolve(p), referenceDir());
/** True when a folder holds the reference folder somewhere inside it. */
export const containsReference = (p: string) => inside(referenceDir(), path.resolve(p));
