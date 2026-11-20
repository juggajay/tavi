// Bridge to the Python drawing engine (drawings/engine.py, PyMuPDF in the project's .venv).
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");
const ENGINE = path.join(ROOT, "drawings", "engine.py");

export type EnginePage = {
  page: number;
  width_pt: number;
  height_pt: number;
  rotation: number;
  read_path: "text" | "outlined" | "scanned" | "empty";
  signals: { text_chars: number; drawings: number; images: number };
  is_register: boolean;
  title_block_box: [number, number, number, number];
  title_block_text: string;
  from_title_block: { sheet_no?: string; title?: string; revision?: string };
  from_filename: { sheet_no?: string; title?: string; revision?: string };
  text: string;
};
export type EngineResult = { pdf: string; page_count: number; pages: EnginePage[]; register: Record<string, { title: string; revision?: string | null }>; warnings: string[] };

export async function pyIngest(pdf: string, outDir: string): Promise<EngineResult> {
  const { stdout } = await execFileP(PY, [ENGINE, "ingest", pdf, outDir], { maxBuffer: 1024 * 1024 * 1024, windowsHide: true, timeout: 15 * 60_000 });
  return JSON.parse(stdout) as EngineResult;
}

export async function pyCrop(pdf: string, page: number, box: number[], outPng: string, maxPx = 1568) {
  const [x0, y0, x1, y1] = box.map((v) => Math.min(1, Math.max(0, v)));
  const { stdout } = await execFileP(PY, [ENGINE, "crop", pdf, String(page), String(x0), String(y0), String(x1), String(y1), outPng, String(maxPx)], {
    windowsHide: true,
    timeout: 120_000,
  });
  return JSON.parse(stdout) as { path: string; width: number; height: number; dpi: number };
}

/* ---------------- long-lived render workers (engine.py serve) ---------------- */
// Sheet pages and zoom tiles need many small renders; starting Python for each would be far too slow. Two workers
// stay running; a request goes to the one with the fewest waiting. A worker that dies or hangs is replaced and the
// request retried once. If Python can't be started at all, renders fall back to one process each (pyCrop).

type Waiting = { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Worker = { proc: ChildProcessWithoutNullStreams; waiting: Map<number, Waiting>; dead: boolean };
export type RenderResult = { w: number; h: number; dpi: number };

const POOL = 2;
const TIMEOUT_MS = 20_000;
const workers: Worker[] = [];
let nextId = 1;
let broken = false; // Python wouldn't start: use one-shot renders

function startWorker(): Worker {
  const proc = spawn(PY, ["-I", ENGINE, "serve"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  // An idle worker must not keep the process alive (tests, scripts); a request's own timeout timer does while it waits.
  proc.unref();
  for (const s of [proc.stdin, proc.stdout, proc.stderr] as unknown as { unref?: () => void }[]) s.unref?.();
  const w: Worker = { proc, waiting: new Map(), dead: false };
  const fail = (why: string) => {
    if (w.dead) return;
    w.dead = true;
    for (const [, p] of w.waiting) (clearTimeout(p.timer), p.reject(new Error(why)));
    w.waiting.clear();
    const i = workers.indexOf(w);
    if (i >= 0) workers.splice(i, 1);
  };
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let r: { id: number; ok: boolean; error?: string } & Record<string, unknown>;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    const p = w.waiting.get(r.id);
    if (!p) return;
    w.waiting.delete(r.id);
    clearTimeout(p.timer);
    const { id: _id, ok, error, ...rest } = r;
    if (ok) p.resolve(rest);
    else p.reject(new Error(error ?? "render failed"));
  });
  proc.stderr.on("data", () => undefined);
  proc.on("error", (err) => {
    broken = true;
    fail(`render worker could not start: ${err.message}`);
  });
  proc.on("exit", (code) => fail(`render worker stopped (exit ${code})`));
  return w;
}

function pick(): Worker {
  while (workers.length < POOL) workers.push(startWorker());
  return workers.reduce((a, b) => (b.waiting.size < a.waiting.size ? b : a));
}

function ask<T = RenderResult>(req: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<T> {
  const w = pick();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      w.waiting.delete(id);
      reject(new Error("render timed out"));
      w.proc.kill(); // a hung worker is replaced on the next request
    }, timeoutMs);
    w.waiting.set(id, { resolve: resolve as (r: Record<string, unknown>) => void, reject, timer });
    w.proc.stdin.write(JSON.stringify({ ...req, id }) + "\n");
  });
}

/** Render a region of a page (box in 0..1 page fractions) `width` pixels wide, capped at 600 dpi, to outPng. */
export async function render(pdf: string, page: number, box: number[], outPng: string, width: number): Promise<RenderResult> {
  const req = { op: "render", pdf, page, box, out: outPng, width };
  if (!broken) {
    try {
      return await ask(req);
    } catch (err) {
      if (broken) return oneShot();
      if (/render (worker|timed)/.test(String((err as Error).message))) return ask(req); // retry once on a fresh worker
      throw err;
    }
  }
  return oneShot();
  async function oneShot() {
    const r = await pyCrop(pdf, page, box, outPng, width * Math.max(1, (box[3] - box[1]) / Math.max(1e-6, box[2] - box[0])));
    return { w: r.width, h: r.height, dpi: r.dpi };
  }
}

export type Extracted = { parts?: { label: string; text: string; grid?: string[][] }[]; meta?: Record<string, unknown>; skipped?: string };

/** Text and tables from a Word, Excel, text or email file, a photo's size and date, or why it couldn't be read. */
export async function extract(path: string, kind: string): Promise<Extracted> {
  try {
    return await ask<Extracted>({ op: "extract", path, kind }, 30_000);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { skipped: /timed out/.test(m) ? "Took too long to read." : "Couldn't open it." };
  }
}

/** A photo straightened and resized for the screen, saved as JPEG without its EXIF details. */
export const imageForScreen = (src: string, out: string, width: number) => ask<{ w: number; h: number }>({ op: "image", src, out, width });

/** Part of a photo (box in 0..1 fractions of the upright photo) at full sharpness, as JPEG without EXIF. */
export const imageCrop = (src: string, out: string, box: number[]) => ask<{ w: number; h: number }>({ op: "image_crop", src, out, box });

/** A page's size in points as displayed (rotation applied). page counts from 0. */
export const pageSize = (pdf: string, page: number) => ask<{ w: number; h: number }>({ op: "size", pdf, page });

/** Stop the workers (tests; the process exiting stops them too). */
export function stopRenderWorkers() {
  for (const w of [...workers]) w.proc.kill();
}
process.on("exit", stopRenderWorkers);

/** For tests: kill one worker as if it crashed. */
export const _killOneWorker = () => workers[0]?.proc.kill();
