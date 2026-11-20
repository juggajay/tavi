// Shop drawings on the server (Stage 12.5): making a revision of a drawing from a model (the set, its PDF, its DXF and
// a DXF per part for a CNC shop, kept in the folder the app manages under models/shop-drawings/<number>/), and the
// routes that show it: each sheet as pictures and zoom tiles for the drawing viewer, drawn from the PDF by the same
// renderer as the drawings library (GET /api/shopdrawings/<drawing>/<rev>/<sheet>…), and the files to download or share.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { MODELS_DIR, registerMadeFile } from "../files/library.js";
import { DRAWINGS_DIR } from "./library.js";
import { renderOnce, TILE_PX } from "./tiles.js";
import { makeSet, type DrawingSet } from "../shared/drawing/sheets.js";
import type { ExtraView } from "../shared/drawing/details.js";
import type { Added } from "../shared/drawing/added.js";
import { setPdf, type Logo } from "./pdf.js";
import { partDxf, setDxf } from "../shared/drawing/dxf.js";
import { drawingNumber, jobCode, nextRevision } from "../shared/drawing/numbering.js";
import { getSettings } from "../store/settings.js";
import { type Drawing, type DrawingRev, getDrawing, getRevision, nextNumberIn, revisionsOf, saveRevision, stamp } from "../store/shopdrawings.js";
import type { ModelPayload, ShopDrawingPayload, ShopDrawingStatus } from "../shared/protocol.js";

export const SHOP_DIR = path.join(MODELS_DIR, "shop-drawings");
const CACHE = path.join(DRAWINGS_DIR, ".cache", "shop");
const PAGE_PT = 420 * (72 / 25.4);

/** The date as a drawing writes it: 13.11.26, in the owner's time zone. */
export function drawingDate(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-AU", { timeZone: getSettings()["time.zone"], day: "2-digit", month: "2-digit", year: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")}`;
}

/** The title block's details, as the owner set them by talking (all optional; nothing is filled in for him). */
export type DrawingDetails = { name: string; line: string; logo: Logo | null; logoPath: string; drawn: string };
/** What a test turn set (never the settings): it shows on that run's drawings only. */
const testDetails: Partial<Record<"drawings.company" | "drawings.company_line" | "drawings.logo" | "drawings.drawn_by", string>> = {};
export const setTestDetails = (patch: typeof testDetails) => Object.assign(testDetails, patch);

export function companyDetails(test = false): DrawingDetails {
  const s = { ...getSettings(), ...(test ? testDetails : {}) };
  const logoPath = s["drawings.logo"].trim();
  return { name: s["drawings.company"].trim(), line: s["drawings.company_line"].trim(), logo: readLogo(logoPath), logoPath, drawn: s["drawings.drawn_by"].trim() || "LH" };
}

/** A logo file: a PNG or JPEG (by its first bytes), else nothing. */
export function readLogo(p: string): Logo | null {
  if (!p || !existsSync(p)) return null;
  try {
    const data = new Uint8Array(readFileSync(p));
    const kind = data[0] === 0x89 && data[1] === 0x50 ? "png" : data[0] === 0xff && data[1] === 0xd8 ? "jpeg" : null;
    return kind ? { kind, data } : null;
  } catch {
    return null;
  }
}

const safeName = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "Drawing";

export type MakeArgs = {
  model: ModelPayload;
  modelItem: string | null;
  title: string;
  project: string;
  client: string;
  finish?: string;
  notes?: string[];
  /** What each part is made of, as the owner said it ("Tas oak, DAR"): by part name, its kind ("hardwood") or "all". */
  materials?: Record<string, string>;
  /** The status for this revision (default: the drawing's, or PRELIMINARY). */
  status?: ShopDrawingStatus;
  /** What changed, one line, for the revision table; or worked out from what was drawn ("Section D-D added"). */
  text?: string | ((set: DrawingSet) => string);
  /** Views he asked for (19.3), kept with the drawing and drawn on every reissue. */
  views?: ExtraView[];
  additions?: Added[];
  /** A drawing this is the next revision of. */
  drawing?: Drawing;
  persist: boolean;
  now?: Date;
};

export type Made = { drawing: Drawing; rev: DrawingRev; set: DrawingSet; files: { pdf: string; dxf: string; parts: string[] }; pdfFile?: string };

/** Make the next revision of a drawing (or its first), write its files, and keep it. */
export async function makeRevision(a: MakeArgs): Promise<Made> {
  const now = a.now ?? new Date();
  const prev = a.drawing ?? null;
  const job = prev?.job ?? jobCode(a.project, a.client);
  const number = prev?.number ?? drawingNumber(job, nextNumberIn(job));
  const status = a.status ?? prev?.status ?? "PRELIMINARY";
  const rev = nextRevision(prev?.rev ?? null, status);
  const date = drawingDate(now);
  const history = prev ? revisionsOf(prev.id) : [];
  const additions = a.additions ?? history.at(-1)?.input.additions ?? [];
  // the details as they are now (a drawing already made keeps what it had until its next revision)
  const co = companyDetails(!a.persist);
  const input = (text: string) => ({
    model: a.model,
    title: a.title,
    number,
    revision: rev,
    status,
    revisions: [...history.map((r) => ({ rev: r.rev, date: r.date, text: r.text, by: r.input.by ?? "LH" })), { rev, date, text, by: co.drawn }],
    ...(co.name ? { company: co.name } : {}),
    ...(co.line ? { companyLine: co.line } : {}),
    project: a.project,
    client: a.client,
    drawn: co.drawn,
    date,
    ...(a.finish ? { finish: a.finish } : {}),
    ...(a.notes?.length ? { notes: a.notes } : {}),
    ...(a.materials && Object.keys(a.materials).length ? { materials: a.materials } : {}),
    ...(a.views?.length ? { views: a.views } : {}),
    additions,
    logo: !!co.logo,
  });
  const fallback = prev ? (status !== prev.status ? `Issued ${status === "PRELIMINARY" ? "as preliminary" : status.toLowerCase()}` : "Revised") : "Preliminary issue";
  // a note worked out from what was drawn ("Section D-D added") needs the set first: drawn once to learn it, then again
  let text = typeof a.text === "string" ? a.text : fallback;
  if (typeof a.text === "function") text = a.text(makeSet(input(fallback)));
  text = text.slice(0, 60);
  const set = makeSet(input(text));
  const id = prev?.id ?? `sd_${randomBytes(4).toString("hex")}`;
  const dir = path.join(SHOP_DIR, safeName(number));
  mkdirSync(dir, { recursive: true });
  const base = `${safeName(number)} ${rev}`;
  const pdfPath = path.join(dir, `${base}.pdf`);
  const dxfPath = path.join(dir, `${base}.dxf`);
  const partsDir = path.join(dir, `${base} parts`);
  mkdirSync(partsDir, { recursive: true });
  await writeFile(pdfPath, setPdf(set.sheets, { title: `${number} ${rev} ${a.title}`, subject: `Shop drawing, ${a.project}` }, co.logo ? { ...co.logo, at: set.logoAt } : undefined));
  await writeFile(dxfPath, setDxf(set));
  const parts: string[] = [];
  for (const mk of set.marks) {
    const f = path.join(partsDir, `${mk.mark} ${safeName(mk.label)}.dxf`);
    await writeFile(f, partDxf(set, mk.mark));
    parts.push(f);
  }
  const at = stamp();
  const drawing: Drawing = { id, number, job, project: a.project, client: a.client, title: a.title, status, rev, model_item: a.modelItem, created_at: prev?.created_at ?? at, updated_at: at };
  const r: DrawingRev = {
    drawing_id: id,
    rev,
    status,
    text,
    date,
    model: a.model,
    input: { title: a.title, ...(a.finish ? { finish: a.finish } : {}), ...(a.notes?.length ? { notes: a.notes } : {}), ...(a.materials && Object.keys(a.materials).length ? { materials: a.materials } : {}), ...(a.views?.length ? { views: a.views } : {}), ...(additions.length ? { additions } : {}), by: co.drawn },
    // each sheet's title, the joint details on it, and the views he asked for on it (so "make that detail bigger" and
    // "take the last one off" know which they're looking at)
    sheets: set.sheets.map((s, i) => {
      const asked = set.extras.filter((x) => x.sheet === i + 1).map((x) => ({ id: x.id, label: x.label }));
      return { title: s.meta.title, aspect: 420 / 297, views: s.meta.views.map((v) => ({ id: v.id, title: v.title })), details: [...new Set(s.meta.views.flatMap((v) => (v.group ? [v.group] : [])))], ...(asked.length ? { asked } : {}) };
    }),
    pdf: pdfPath,
    dxf: dxfPath,
    parts_dir: partsDir,
    item_id: null,
    made_at: at,
  };
  saveRevision(drawing, r, a.persist);
  // the PDF is findable with the file tools like anything else the app made (not on a test turn: that writes the database)
  if (a.persist) await registerMadeFile(pdfPath, { drawing: id, rev, title: a.title }).catch(() => undefined);
  return { drawing, rev: r, set, files: { pdf: pdfPath, dxf: dxfPath, parts } };
}

/** The item payload for a revision. */
export function payloadFor(d: Drawing, r: DrawingRev, openAt?: number): ShopDrawingPayload {
  const all = revisionsOf(d.id);
  const upTo = all.slice(0, all.findIndex((x) => x.rev === r.rev) + 1);
  return {
    drawing_id: d.id,
    number: d.number,
    rev: r.rev,
    status: r.status,
    project: d.project,
    client: d.client,
    model_item: d.model_item,
    sheets: r.sheets,
    revisions: (upTo.length ? upTo : [r]).map((x) => ({ rev: x.rev, date: x.date, text: x.text, status: x.status })),
    pdf: `/api/shopdrawings/${d.id}/${r.rev}/file.pdf`,
    dxf: `/api/shopdrawings/${d.id}/${r.rev}/file.dxf`,
    ...(openAt ? { open_at: openAt } : {}),
  };
}

/** A file's name for downloading or sharing: "COO-SD-003 B Dining table.pdf". */
export const fileNameFor = (d: Drawing, rev: string, ext: string) => `${safeName(`${d.number} ${rev} ${d.title}`)}.${ext}`;

/**
 * A sheet as a picture, made here from the PDF (no app needs to be open): for the assistant to look at what it drew
 * before calling it done (look_at_drawing, Stage 21.2). box: part of the sheet, as fractions [x0, y0, x1, y1].
 */
export async function sheetPicture(drawingId: string, rev: string, n: number, width = 2048, box: [number, number, number, number] = [0, 0, 1, 1]): Promise<Buffer | null> {
  const r = getRevision(drawingId, rev);
  if (!r || !existsSync(r.pdf) || !(n >= 1 && n <= r.sheets.length)) return null;
  const key = box.map((v) => Math.round(v * 1000)).join("-");
  const f = await renderOnce(path.join(CACHE, `${drawingId}-${rev}`, `s${n}-look-${width}-${key}.png`), r.pdf, n - 1, box, width);
  return readFile(f);
}

/* ---------------- routes (phone and PC, GET only, by id only) ---------------- */

const maxZ = () => Math.max(0, Math.min(5, Math.floor(Math.log2(((600 / 72) * PAGE_PT) / TILE_PX))));

/**
 * GET /api/shopdrawings/<sd_…>/<rev>/<n>                    {max_z} for the viewer
 *     /api/shopdrawings/<sd_…>/<rev>/<n>/page.png?w=1024|2048
 *     /api/shopdrawings/<sd_…>/<rev>/<n>/tile/<z>/<x>/<y>.png
 *     /api/shopdrawings/<sd_…>/<rev>/file.pdf | file.dxf      (downloads, named from the drawing)
 *     /api/shopdrawings/<sd_…>/<rev>/parts/<mark>.dxf         (a part's outline for a CNC shop)
 * Returns false when the path isn't one of these.
 */
export async function handleShopRoute(req: IncomingMessage, res: ServerResponse, url: URL, send: (res: ServerResponse, code: number, body: unknown) => void): Promise<boolean> {
  const m = /^\/api\/shopdrawings\/(sd_[a-f0-9]{8})\/([A-Z0-9]{1,4})\/(?:(\d{1,2})(?:\/page\.png|\/tile\/(\d)\/(\d{1,2})\/(\d{1,2})\.png)?|file\.(pdf|dxf)|parts\/(\d{1,3})\.dxf)$/.exec(url.pathname);
  if (!m || req.method !== "GET") return false;
  const d = getDrawing(m[1]);
  const r = d ? getRevision(d.id, m[2]) : null;
  if (!d || !r || !existsSync(r.pdf)) return send(res, 404, { error: "not found" }), true;
  const head = (type: string, name?: string) => ({ "Content-Type": type, "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff", ...(name ? { "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"` } : {}) });
  if (m[7]) {
    const file = m[7] === "pdf" ? r.pdf : r.dxf;
    res.writeHead(200, head(m[7] === "pdf" ? "application/pdf" : "application/dxf", fileNameFor(d, r.rev, m[7])));
    res.end(await readFile(file));
    return true;
  }
  if (m[8]) {
    const want = `${Number(m[8])} `;
    const { readdirSync } = await import("node:fs");
    const f = existsSync(r.parts_dir) ? readdirSync(r.parts_dir).find((x) => x.startsWith(want)) : undefined;
    if (!f) return send(res, 404, { error: "not found" }), true;
    res.writeHead(200, head("application/dxf", `${safeName(`${d.number} ${r.rev} part ${f.replace(/\.dxf$/, "")}`)}.dxf`));
    res.end(await readFile(path.join(r.parts_dir, f)));
    return true;
  }
  const n = Number(m[3]);
  if (!(n >= 1 && n <= r.sheets.length)) return send(res, 404, { error: "not found" }), true;
  const page = n - 1;
  const dir = path.join(CACHE, `${d.id}-${r.rev}`);
  if (url.pathname.endsWith("/page.png")) {
    const w = Number(url.searchParams.get("w") ?? 1024);
    if (w !== 1024 && w !== 2048) return send(res, 404, { error: "not found" }), true;
    const f = await renderOnce(path.join(dir, `s${n}-page-${w}.png`), r.pdf, page, [0, 0, 1, 1], w);
    res.writeHead(200, head("image/png"));
    res.end(await readFile(f));
    return true;
  }
  if (m[4] !== undefined) {
    const z = Number(m[4]),
      x = Number(m[5]),
      y = Number(m[6]);
    const k = 2 ** z;
    if (z > maxZ() || x >= k || y >= k) return send(res, 404, { error: "not found" }), true;
    const f = await renderOnce(path.join(dir, `s${n}-t-${z}-${x}-${y}.png`), r.pdf, page, [x / k, y / k, (x + 1) / k, (y + 1) / k], TILE_PX);
    res.writeHead(200, head("image/png"));
    res.end(await readFile(f));
    return true;
  }
  send(res, 200, { sheet: n, of: r.sheets.length, aspect: r.sheets[page].aspect, max_z: maxZ() });
  return true;
}
