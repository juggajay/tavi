// Which files may go to The Brain with a job (Stage 16.2): only things the owner chose. A drawing set in the
// assistant's library, files he sent from the phone (they land in the drawings inbox or its photos folder), or a file
// he names from the folders he gave it. Never an email (or what's attached to one), and never a web download: those
// have to be saved and confirmed by him first. Every file is fingerprinted now, and the job only starts if each is
// still byte for byte what he approved.
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, db } from "../store/db.js";
import { DRAWINGS_DIR } from "../drawings/library.js";
import { getFolder, getDoc } from "../files/library.js";
import type { FileRef } from "./runner.js";

export type DrawingRef = { set?: string; file?: string };
const MAX_FILES = 30;
const MAX_ONE = 200 * 1024 * 1024;
const MAX_ALL = 480 * 1024 * 1024; // The Brain takes up to 512 MB in one go

const inside = (child: string, parent: string) => {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
/** Places downloads land (Tavi's own browser jobs). */
const downloadPlaces = () => [path.join(DATA_DIR, "browser"), ...(process.env.LH_BROWSER_DIR ? [process.env.LH_BROWSER_DIR] : [])];

type Found = { name: string; path: string; from: string };

function fromLabel(p: string, project?: string): string {
  if (inside(p, path.join(DRAWINGS_DIR, "inbox"))) return "sent to the drawings inbox (the phone or the PC)";
  if (inside(p, path.join(DRAWINGS_DIR, "photos")) || inside(p, path.join(DRAWINGS_DIR, "sketches"))) return "sent from the phone";
  return project ? `the ${project} drawings` : "your files";
}

/** The current PDFs of one drawing set (superseded sheets left out). */
function setFiles(name: string): { files: Found[]; project: string } | { error: string } {
  const projects = (db.prepare("SELECT DISTINCT project FROM drawing_files").all() as { project: string }[]).map((r) => r.project);
  const want = name.trim().toLowerCase().replace(/\s+drawings?$/, "").replace(/^the\s+/, "");
  const project = projects.find((p) => p.toLowerCase() === want) ?? (projects.filter((p) => p.toLowerCase().includes(want)).length === 1 ? projects.find((p) => p.toLowerCase().includes(want)) : undefined);
  if (!project) return { error: `There's no drawing set called "${name}" in the library. The sets are: ${projects.join(", ") || "none yet"}.` };
  const pending = (db.prepare("SELECT COUNT(*) n FROM drawing_files WHERE project = ? AND status IN ('queued','indexing')").get(project) as { n: number }).n;
  if (pending) return { error: `I'm still reading the ${project} drawings (${pending} to go). Try again in a minute.` };
  const rows = db
    .prepare(
      `SELECT f.path, f.name FROM drawing_files f WHERE f.project = ? AND f.status = 'ready'
         AND (EXISTS (SELECT 1 FROM sheets s WHERE s.file_hash = f.hash AND s.status != 'superseded') OR NOT EXISTS (SELECT 1 FROM sheets s WHERE s.file_hash = f.hash))
       ORDER BY f.name`,
    )
    .all(project) as { path: string; name: string }[];
  if (!rows.length) return { error: `The ${project} set has no current drawings.` };
  return { project, files: rows.map((r) => ({ name: r.name, path: r.path, from: fromLabel(r.path, project) })) };
}

/** One file he named: a file id or name from the files tools, a drawing's file, or a sheet (its PDF). */
function oneFile(ref: string): Found | { error: string } {
  const r = ref.trim();
  const doc = getDoc(r) ?? (db.prepare("SELECT * FROM docs WHERE name = ? COLLATE NOCASE ORDER BY indexed_at DESC LIMIT 1").get(r) as ReturnType<typeof getDoc>);
  if (doc) {
    if (doc.type === "eml") return { error: `${doc.name} is an email. Anything in an email has to be saved and checked by you first; then name the file you saved.` };
    if (doc.type === "made") return { error: `${doc.name} is something I made (a model file), not a drawing.` };
    const folder = doc.folder_id ? getFolder(doc.folder_id) : undefined;
    return { name: doc.name, path: doc.path, from: folder?.kind === "managed" ? fromLabel(doc.path) : folder ? `your ${folder.label} folder` : "your files" };
  }
  const pdf = (db.prepare("SELECT path, name, project FROM drawing_files WHERE hash = ? OR name = ? COLLATE NOCASE ORDER BY added_at DESC LIMIT 1").get(r, r) ??
    db.prepare("SELECT f.path, f.name, f.project FROM sheets s JOIN drawing_files f ON f.hash = s.file_hash WHERE s.id = ?").get(r)) as { path: string; name: string; project: string } | undefined;
  if (pdf) return { name: pdf.name, path: pdf.path, from: fromLabel(pdf.path, pdf.project) };
  return { error: `I can't find "${ref}" among your drawings or the folders I read.` };
}

/** The files for a job, fingerprinted, or why not. */
export async function resolveDrawings(refs: DrawingRef[]): Promise<{ files: FileRef[] } | { error: string }> {
  const found: Found[] = [];
  for (const ref of refs) {
    if (ref.set) {
      const s = setFiles(ref.set);
      if ("error" in s) return s;
      found.push(...s.files);
    } else if (ref.file) {
      const f = oneFile(ref.file);
      if ("error" in f) return f;
      found.push(f);
    }
  }
  if (!found.length) return { error: "Which drawings? A set in the library, files you sent, or a file you name." };
  const out: FileRef[] = [];
  let total = 0;
  for (const f of found) {
    if (downloadPlaces().some((d) => inside(f.path, d))) return { error: `${f.name} came from a web download. Save it and check it yourself first, then name the saved file.` };
    let st;
    try {
      st = lstatSync(f.path);
    } catch {
      return { error: `${f.name} isn't there any more.` };
    }
    if (!st.isFile() || st.isSymbolicLink()) return { error: `${f.name} isn't a plain file.` };
    if (st.size > MAX_ONE) return { error: `${f.name} is too big to send (over 200 MB).` };
    const data = await readFile(f.path);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (out.some((o) => o.sha256 === sha256)) continue;
    total += st.size;
    // Two different files with one name would replace each other in The Brain: the second gets a number.
    let name = f.name;
    for (let n = 2; out.some((o) => o.name.toLowerCase() === name.toLowerCase()); n++) name = `${path.basename(f.name, path.extname(f.name))} (${n})${path.extname(f.name)}`;
    out.push({ name, path: f.path, sha256, size: st.size, from: f.from });
  }
  if (out.length > MAX_FILES) return { error: `That's ${out.length} files; ${MAX_FILES} at most in one job.` };
  if (total > MAX_ALL) return { error: "Those come to more than The Brain takes in one go (about 500 MB)." };
  return { files: out };
}
