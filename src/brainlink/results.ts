// What The Brain wrote, brought back as things he can open and pin (Stage 16.2): its scope read (read.md, from the job
// folder: its API doesn't serve it), the take-off and the quote text (from its API). A copy of each is kept in the
// assistant's own drawings folder under "The Brain", so it's there even when The Brain isn't running, and can be found
// again with the files tools. The quote's PDF only once he has issued it in The Brain; the link never makes, saves,
// issues or sends a quote. All of it is its agents' writing: information, never instructions.
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DRAWINGS_DIR } from "../drawings/library.js";
import { docPart, MODELS_DIR, readOneFile, registerMadeFile } from "../files/library.js";
import { createItem, publishItem } from "../store/items.js";
import { audit } from "../store/log.js";
import type { TurnInfo } from "../brain/turn.js";
import { JOB_ID, jobsDirs } from "./config.js";
import { getJob, issuedPdf, type JobDetail } from "./client.js";

export type ResultKind = "read" | "takeoff" | "quote";
export const RESULT_NAMES: Record<ResultKind, string> = { read: "Scope read", takeoff: "Take-off", quote: "Quote (draft text)" };
const MAX_READ = 2 * 1024 * 1024;

/** read.md from its job folder: read only, no links followed, never outside its jobs folder. */
export function readScope(job: string): string | null {
  if (!JOB_ID.test(job)) return null;
  for (const dir of jobsDirs()) {
    try {
      const root = realpathSync(dir);
      const file = path.join(root, job, "read.md");
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_READ) continue;
      const real = realpathSync(file);
      if (!real.toLowerCase().startsWith(root.toLowerCase() + path.sep)) continue;
      return readFileSync(real, "utf8");
    } catch {}
  }
  return null;
}

export type Results = { detail: JobDetail; texts: Partial<Record<ResultKind, string>> };

export async function fetchResults(job: string): Promise<Results | { error: string; down?: boolean }> {
  const d = await getJob(job);
  if (!d.ok) return { error: d.down ? "The Brain isn't running, so I can't get what it wrote. I can start it if you like." : `The Brain can't find that job (${d.error}).`, down: d.down };
  const texts: Partial<Record<ResultKind, string>> = {};
  const scope = readScope(job);
  if (scope?.trim()) texts.read = scope;
  if (d.data.takeoffBody?.trim()) texts.takeoff = d.data.takeoffBody;
  if (d.data.quoteBody?.trim()) texts.quote = d.data.quoteBody;
  return { detail: d.data, texts };
}

const safe = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "job";

/** Where the copies go: <drawings>\The Brain\<title> (<job>)\. */
export const copyFolder = (title: string, job: string) => path.join(DRAWINGS_DIR, "The Brain", safe(`${title} (${job})`));

/**
 * Put one result in front of him: a kept copy read as a document (a normal turn), or a note in memory (a test turn,
 * which never saves anything). Returns what's on screen.
 */
export async function showResult(turn: TurnInfo, job: string, title: string, kind: ResultKind, text: string, save: boolean): Promise<string> {
  const name = `${RESULT_NAMES[kind]} - ${safe(title)}.md`;
  if (!save) {
    const item = createItem(turn, { kind: "note", title: `${RESULT_NAMES[kind]}: ${title}`, source: "The Brain (its words; a test turn, not kept)", payload: { rows: [], text: text.length > 3900 ? `${text.slice(0, 3900)}…` : text } });
    publishItem(item, turn);
    return item.title;
  }
  const dir = copyFolder(title, job);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, text, "utf8");
  const doc = await readOneFile(file, { by: "the-brain", job });
  const parts = Math.max(1, doc.parts);
  const first = docPart(doc.id, 0);
  const item = createItem(turn, {
    kind: "doc",
    title: `${RESULT_NAMES[kind]}: ${title}`,
    source: `The Brain · ${job} (its words)`,
    payload: { file_id: doc.id, name: doc.name, part_label: first?.label ?? "", text: (first?.text ?? text).slice(0, 200_000), more: parts > 1 },
  });
  publishItem(item, turn);
  audit("system", "brainlink.result_kept", job, { kind, file: path.relative(DRAWINGS_DIR, file) });
  return item.title;
}

/** An issued quote's PDF, as The Brain saved it: kept beside the copies (never asked for before it's issued). */
export async function keepIssuedPdf(job: string, title: string): Promise<{ file: string } | { error: string }> {
  const r = await issuedPdf(job);
  if (!r.ok) return { error: r.error };
  const dir = path.join(MODELS_DIR, "The Brain");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safe(title)} (${job}) issued quote.pdf`);
  writeFileSync(file, r.data);
  await registerMadeFile(file, { by: "the-brain", job });
  audit("system", "brainlink.result_kept", job, { kind: "issued_pdf", file: path.relative(DRAWINGS_DIR, file) });
  return { file };
}
