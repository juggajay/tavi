// Polished pictures and client-ready files of a model, made with Blender on this PC (Stage 9.6b). Blender runs headless
// with factory settings (the owner's own Blender set-up is neither used nor touched) and our own script
// (render/blender_render.py); the brain only ever picks from fixed lists. Everything is made from the same model the
// app shows: the server writes it as a GLB plus a JSON (src/shared/model3d/glb.ts). Renders are background jobs with
// progress ("Rendering 2 of 3") and Stop, which ends Blender and anything it started.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, db, nowIso } from "../store/db.js";
import { createJob, failJob, finishJob, startJob } from "../store/jobs.js";
import { audit } from "../store/log.js";
import { getSettings } from "../store/settings.js";
import { createItem, publishItem } from "../store/items.js";
import { MODELS_DIR, readOneFile, registerMadeFile } from "../files/library.js";
import { modelFiles } from "../shared/model3d/glb.js";
import { onStop } from "../brain/tasks.js";
import { bus } from "../events.js";
import { queueNotification, deliverDue } from "../proactive/notify.js";
import { partsIn } from "../time.js";
import { fileNameOf } from "../gateway/api-v2.js";
import type { TurnInfo } from "../brain/turn.js";
import type { Item } from "../shared/protocol.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "render", "blender_render.py");
const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");
const WORK = path.join(DATA_DIR, "render-work");

export const SHOTS = ["hero", "apart", "front", "side", "top", "detail", "turntable"] as const;
export const BACKDROPS = ["light", "dark"] as const;
export const SIZES = { screen: 1920, print: 3840 } as const;
export type Shot = (typeof SHOTS)[number];
export const NO_BLENDER = "Polished renders need Blender on this PC, and I can't find it. Everything else with models still works.";
/** Samples per shot: enough for a clean picture with the denoiser; the turntable's 144 frames get fewer each. */
const SAMPLES = { screen: 96, print: 128, turntable: 24 };

type ModelItem = Extract<Item, { kind: "model" }>;

/** Blender: the blender.path setting (the exe or its folder), or the newest one under Program Files. Null if none. */
export function findBlender(): string | null {
  const exe = (p: string) => (/\.exe$/i.test(p) ? p : path.join(p, "blender.exe"));
  const forced = process.env.LH_BLENDER;
  if (forced !== undefined) return forced && existsSync(exe(forced)) ? exe(forced) : null;
  const set = String(getSettings()["blender.path"] ?? "").trim();
  if (set) return existsSync(exe(set)) ? exe(set) : null;
  const base = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Blender Foundation");
  if (!existsSync(base)) return null;
  const ver = (n: string) => (/(\d+)\.(\d+)/.exec(n) ?? []).slice(1).map(Number);
  const found = readdirSync(base)
    .filter((n) => /^Blender \d/.test(n) && existsSync(path.join(base, n, "blender.exe")))
    .sort((a, b) => {
      const [a1 = 0, a2 = 0] = ver(a),
        [b1 = 0, b2 = 0] = ver(b);
      return b1 - a1 || b2 - a2;
    });
  return found.length ? path.join(base, found[0], "blender.exe") : null;
}

/** End a process and everything it started (Windows: the whole tree). */
function killTree(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  else child.kill("SIGKILL");
}

/** A folder of its own for one set of files, under models/<day>/<title>/ (with " (2)" if that's taken). */
function outFolder(title: string) {
  const day = path.join(MODELS_DIR, partsIn(new Date()).ymd);
  const name = fileNameOf(title);
  for (let i = 1; ; i++) {
    const p = path.join(day, i === 1 ? name : `${name} (${i})`);
    if (!existsSync(p)) return (mkdirSync(p, { recursive: true }), p);
  }
}

type RunResult = { ok: boolean; times: Record<string, number>; saved: { kind: string; path: string }[]; error?: string; stopped?: boolean };
let running: Promise<unknown> = Promise.resolve(); // one Blender at a time; the next one waits its turn
export const blenderProcs = new Set<ChildProcess>();

/** Run our script in Blender on a model, headless with factory settings. */
function runBlender(item: ModelItem, spec: Record<string, unknown>, opts: { onLine?: (l: string) => void; register?: (stop: () => void) => void; timeoutMs?: number } = {}): Promise<RunResult> {
  const exe = findBlender();
  if (!exe) return Promise.resolve({ ok: false, times: {}, saved: [], error: NO_BLENDER });
  const work = path.join(WORK, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(work, { recursive: true });
  const files = modelFiles(item.payload, item.title);
  writeFileSync(path.join(work, "model.glb"), files.glb);
  writeFileSync(path.join(work, "model.json"), JSON.stringify(files.json));
  const job = { glb: path.join(work, "model.glb"), model: path.join(work, "model.json"), ...spec };
  writeFileSync(path.join(work, "job.json"), JSON.stringify(job));
  const run = () =>
    new Promise<RunResult>((resolve) => {
      const child = spawn(exe, ["--background", "--factory-startup", "--python-exit-code", "1", "--python", SCRIPT, "--", path.join(work, "job.json")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      blenderProcs.add(child);
      const out: RunResult = { ok: false, times: {}, saved: [] };
      let stopped = false;
      opts.register?.(() => ((stopped = true), killTree(child)));
      const timer = opts.timeoutMs ? setTimeout(() => ((out.error = "Blender took too long, so I stopped it."), killTree(child)), opts.timeoutMs) : null;
      let buf = "",
        errTail = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const t = /^TIME (\w+) ([\d.]+)$/.exec(line);
          if (t) out.times[t[1]] = Number(t[2]);
          const s = /^SAVED (\w+) (.+)$/.exec(line);
          if (s) out.saved.push({ kind: s[1], path: path.resolve(s[2]) });
          if (/^Traceback|Error:/.test(line)) errTail += `${line}\n`;
          opts.onLine?.(line);
        }
      });
      child.stderr.on("data", (d: Buffer) => (errTail = (errTail + d.toString("utf8")).slice(-2000)));
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        blenderProcs.delete(child);
        rmSync(work, { recursive: true, force: true });
        out.stopped = stopped;
        out.ok = code === 0 && !stopped && !out.error;
        if (!out.ok && !out.error) out.error = stopped ? "Stopped." : `Blender didn't finish (code ${code}). ${errTail.split("\n").filter(Boolean).slice(-2).join(" ")}`.trim();
        resolve(out);
      });
    });
  const p = running.then(run, run);
  running = p.catch(() => undefined);
  return p;
}

/** Labels on the front and side shots, and a JPG copy of every picture (render/labels.py, the repo's Python). */
function finishPictures(dir: string): Promise<void> {
  return new Promise((resolve) => execFile(PY, ["-I", path.join(ROOT, "render", "labels.py"), dir], { windowsHide: true, timeout: 120_000 }, () => resolve()));
}

export type RenderOpts = { shots?: string[]; backdrop?: string; size?: string; labels?: boolean };

/** What's wrong with the choices, in words, or null. Only names from the fixed lists. */
export function renderProblem(o: RenderOpts): string | null {
  const bad = (o.shots ?? []).filter((s) => !(SHOTS as readonly string[]).includes(s));
  if (bad.length) return `There's no "${bad[0]}" shot. The shots are: ${SHOTS.join(", ")}.`;
  if (o.backdrop !== undefined && !(BACKDROPS as readonly string[]).includes(o.backdrop)) return `The backdrop is "light" or "dark", not "${o.backdrop}".`;
  if (o.size !== undefined && !(o.size in SIZES)) return `The size is "screen" (1,920 px) or "print" (3,840 px), not "${o.size}".`;
  return null;
}

/** The latest polished set made for each model (this run of the app): for the proposal page. */
const latest = new Map<string, { dir: string; files: Record<string, string> }>();

/**
 * Start a render as a background job. Returns at once with the job id; when it's done the pictures are kept under
 * models/<day>/<title>/, the hero picture goes up on the screen that asked, and a notice says what was made.
 */
export function renderModel(turn: TurnInfo, item: ModelItem, o: RenderOpts, then?: (dir: string, files: Record<string, string>) => Promise<string | void>): { job: string; shots: string[] } | { error: string } {
  const problem = renderProblem(o);
  if (problem) return { error: problem };
  if (!findBlender()) return { error: NO_BLENDER };
  const shots = [...new Set(o.shots?.length ? o.shots : ["hero", "apart"])] as Shot[];
  const size = (o.size ?? "screen") as keyof typeof SIZES;
  const title = `Polished pictures: ${item.title}`.slice(0, 120);
  const id = createJob("render", title, JSON.stringify({ item: item.id, shots, size, backdrop: o.backdrop ?? "light" }));
  startJob(id, { current: false });
  db.prepare("UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?").run("Getting Blender ready", nowIso(), id);
  bus.emit("activity");
  bus.emit("background", { phase: "start", title: "Making the polished pictures" });
  audit("brain", "render.started", id, { item: item.id, shots });
  const dir = outFolder(item.title);
  let unregister = () => {};
  void runBlender(
    item,
    { out_dir: dir, shots, backdrop: o.backdrop ?? "light", size: SIZES[size], labels: o.labels !== false, samples: SAMPLES[size], turntable_samples: SAMPLES.turntable },
    {
      register: (stop) => (unregister = onStop(id, stop)),
      onLine: (l) => {
        const m = /^PROGRESS (\d+)\/(\d+) (\w+)/.exec(l);
        if (!m) return;
        db.prepare("UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?").run(`Rendering ${m[1]} of ${m[2]}`, nowIso(), id);
        bus.emit("activity");
      },
    },
  ).then(async (r) => {
    unregister();
    bus.emit("background", { phase: "end", title: "" });
    if (!r.ok) {
      if (!r.stopped) failJob(id, r.error ?? "Blender didn't finish.");
      audit("brain", r.stopped ? "render.stopped" : "render.failed", id, { error: r.error });
      if (!r.stopped) (queueNotification({ title: "Polished pictures", spoken: `I couldn't make the polished pictures of ${item.title}. ${r.error ?? ""}`.trim(), priority: "normal", source: `render:${id}` }), await deliverDue(new Date()));
      bus.emit("activity");
      return;
    }
    await finishPictures(dir);
    const files: Record<string, string> = {};
    for (const s of shots) {
      const png = path.join(dir, `${s}.png`),
        jpg = path.join(dir, `${s}.jpg`),
        mp4 = path.join(dir, `${s}.mp4`);
      if (existsSync(png)) files[s] = (await readOneFile(png, { by: "assistant", kind: "render", item: item.id, shot: s })).id;
      if (existsSync(jpg)) await readOneFile(jpg, { by: "assistant", kind: "render-jpg", item: item.id, shot: s });
      if (existsSync(mp4)) files[s] = (await registerMadeFile(mp4, { item: item.id, shot: s })).id;
    }
    latest.set(item.id, { dir, files });
    // the hero picture goes up on the screen that asked (or the first picture made)
    const first = shots.find((s) => s !== "turntable" && files[s]);
    if (first) {
      const shown = createItem({ ...turn, items: [], seq: 0 }, {
        kind: "image",
        title: `${item.title}, ${first === "hero" ? "polished" : first}`,
        source: "Rendered in Blender",
        payload: { src: `/api/files/${files[first]}/image-2048.jpg`, w: SIZES[size], h: Math.round((SIZES[size] * 2) / 3), alt: `${item.title}, rendered` },
      });
      publishItem(shown, turn.origin ? turn : null, true, false);
    }
    const extra = then ? await then(dir, files) : undefined;
    const made = shots.map((s) => (s === "turntable" ? "a turning video" : s === "hero" ? "the main picture" : `the ${s} view`));
    const spoken = `The polished pictures of ${item.title} are ready: ${made.join(", ")}${extra ? `, and ${extra}` : ""}. They're in the models folder${shots.some((x) => x !== "turntable") ? ", with smaller copies of the pictures for email" : ""}.`;
    finishJob(id, { spoken, times: r.times, dir });
    audit("brain", "render.finished", id, { times: r.times });
    queueNotification({ title: "Polished pictures ready", spoken, priority: "normal", source: `render:${id}` });
    await deliverDue(new Date());
    bus.emit("activity");
  });
  return { job: id, shots };
}

/** The Blender scene (.blend) or a USDZ (opens in 3D on an iPhone) of a model, made now. Returns the saved files. */
export async function blenderFiles(item: ModelItem, kinds: ("blend" | "usdz")[]): Promise<{ files: { kind: string; file: string; name: string }[] } | { error: string }> {
  if (!findBlender()) return { error: NO_BLENDER };
  const dir = path.join(MODELS_DIR, partsIn(new Date()).ymd);
  mkdirSync(dir, { recursive: true });
  const unique = (ext: string) => {
    for (let i = 1; ; i++) {
      const p = path.join(dir, `${fileNameOf(item.title)}${i === 1 ? "" : ` (${i})`}.${ext}`);
      if (!existsSync(p)) return p;
    }
  };
  const want = Object.fromEntries(kinds.map((k) => [k, unique(k)]));
  const r = await runBlender(item, { out_dir: path.join(WORK, "unused"), shots: [], save_blend: want.blend ?? null, save_usdz: want.usdz ?? null, backdrop: "light", size: 1920 }, { timeoutMs: 180_000 });
  rmSync(path.join(WORK, "unused"), { recursive: true, force: true });
  if (!r.ok) return { error: r.error ?? "Blender didn't finish." };
  const files = [];
  for (const k of kinds) {
    if (!existsSync(want[k])) return { error: `Blender didn't make the ${k} file.` };
    const doc = await registerMadeFile(want[k], { item: item.id, title: item.title });
    files.push({ kind: k, file: doc.id, name: doc.name });
  }
  audit("brain", "model.saved", null, { item: item.id, kinds });
  return { files };
}

/**
 * One A4 page for a proposal (render/proposal.py): the hero picture large, the pulled-apart picture and a dimensioned
 * front view below, the title, up to six short lines of the owner's words, and the date. Renders what it needs first.
 */
export function proposalSheet(turn: TurnInfo, item: ModelItem, title: string, lines: string[]): { job: string } | { error: string } {
  const make = async (dir: string, files: Record<string, string>) => {
    const out = path.join(dir, `${fileNameOf(title)} - page.pdf`);
    const spec = path.join(dir, ".proposal.json");
    // the email-size copies: sharp enough for A4 (about 190 dpi across the page) and a page that's small enough to send
    const pic = (s: string) => (files[s] ? [`${s}.jpg`, `${s}.png`].map((n) => path.join(dir, n)).find(existsSync) : undefined);
    writeFileSync(spec, JSON.stringify({ out, title, lines: lines.slice(0, 6), date: new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }), hero: pic("hero"), apart: pic("apart"), dims: pic("front") }));
    await new Promise<void>((resolve) => execFile(PY, ["-I", path.join(ROOT, "render", "proposal.py"), spec], { windowsHide: true, timeout: 120_000 }, () => resolve()));
    rmSync(spec, { force: true });
    if (!existsSync(out)) return "but the proposal page didn't come out";
    await registerMadeFile(out, { item: item.id, kind: "proposal" });
    return "the proposal page (a PDF)";
  };
  const had = latest.get(item.id);
  if (had && had.files.hero && had.files.apart && had.files.front) {
    const id = createJob("render", `Proposal page: ${title}`.slice(0, 120), JSON.stringify({ item: item.id }));
    startJob(id, { current: false });
    void make(had.dir, had.files).then((said) => {
      finishJob(id, { spoken: `Done: ${said}.` });
      queueNotification({ title: "Proposal page ready", spoken: `${said[0].toUpperCase()}${said.slice(1)} for ${title} is in the models folder.`, priority: "normal", source: `render:${id}` });
      void deliverDue(new Date());
    });
    return { job: id };
  }
  const r = renderModel(turn, item, { shots: ["hero", "apart", "front"], labels: true }, make);
  return "error" in r ? r : { job: r.job };
}
