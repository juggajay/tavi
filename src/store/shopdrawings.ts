// Shop drawings kept (Stage 12.5): each drawing's number, job, who it's for and its status, and every revision with the
// model it was drawn from and where its files are. A test turn's drawings are kept in memory only (never the database),
// like a test turn's items, so a later test turn can reissue one.
import { z } from "zod";
import { db, nowIso } from "./db.js";
import type { ModelPayload, ShopDrawingStatus } from "../shared/protocol.js";
import type { ExtraView } from "../shared/drawing/details.js";
import type { Added } from "../shared/drawing/added.js";

const STATUS = z.enum(["PRELIMINARY", "FOR APPROVAL", "FOR CONSTRUCTION"]);
const ownFile = z.string().regex(/^\/api\/shopdrawings\/sd_[a-f0-9]{8}\/[A-Z0-9]{1,4}\/file\.(pdf|dxf)$/);

/** The item's payload, checked on the way in like every other item. */
export const SHOPDRAWING = z.object({
  drawing_id: z.string().regex(/^sd_[a-f0-9]{8}$/),
  number: z.string().max(40),
  rev: z.string().regex(/^[A-Z0-9]{1,4}$/),
  status: STATUS,
  project: z.string().max(80),
  client: z.string().max(80),
  model_item: z.string().max(60).nullable(),
  sheets: z.array(z.object({ title: z.string().max(200), aspect: z.number().positive() })).min(1).max(40),
  revisions: z.array(z.object({ rev: z.string().max(4), date: z.string().max(20), text: z.string().max(120), status: STATUS })).max(60),
  pdf: ownFile,
  dxf: ownFile,
  open_at: z.number().int().min(1).max(40).optional(),
});

export type Drawing = { id: string; number: string; job: string; project: string; client: string; title: string; status: ShopDrawingStatus; rev: string; model_item: string | null; created_at: string; updated_at: string };
export type DrawingRev = {
  drawing_id: string;
  rev: string;
  status: ShopDrawingStatus;
  text: string;
  date: string;
  model: ModelPayload;
  input: { title: string; finish?: string; notes?: string[]; materials?: Record<string, string>; views?: ExtraView[]; additions?: Added[]; by?: string };
  sheets: { title: string; aspect: number; details?: string[]; asked?: { id: string; label: string }[]; views?: { id: string; title: string }[] }[];
  pdf: string;
  dxf: string;
  parts_dir: string;
  item_id: string | null;
  made_at: string;
};

// a test turn's drawings and revisions (newest 20)
const testDrawings = new Map<string, Drawing>();
const testRevs = new Map<string, DrawingRev[]>();

type RevRow = { drawing_id: string; rev: string; status: ShopDrawingStatus; text: string; date: string; model_json: string; input_json: string; sheets_json: string; pdf: string; dxf: string; parts_dir: string; item_id: string | null; made_at: string };
const revFrom = (r: RevRow): DrawingRev => ({ ...r, model: JSON.parse(r.model_json), input: JSON.parse(r.input_json), sheets: JSON.parse(r.sheets_json) });

export function getDrawing(id: string): Drawing | null {
  // a test turn's change to a kept drawing is newer than the database's copy (in memory only)
  return testDrawings.get(id) ?? (db.prepare("SELECT * FROM shop_drawings WHERE id = ?").get(id) as Drawing | undefined) ?? null;
}

export function drawingByNumber(number: string): Drawing | null {
  const n = number.trim().toUpperCase();
  return [...testDrawings.values()].find((d) => d.number.toUpperCase() === n) ?? (db.prepare("SELECT * FROM shop_drawings WHERE upper(number) = ?").get(n) as Drawing | undefined) ?? null;
}

/** All drawings, newest first (a test turn's too). */
export function allDrawings(): Drawing[] {
  const rows = (db.prepare("SELECT * FROM shop_drawings ORDER BY updated_at DESC").all() as Drawing[]).filter((r) => !testDrawings.has(r.id));
  return [...[...testDrawings.values()].reverse(), ...rows];
}

export function revisionsOf(id: string): DrawingRev[] {
  const rows = (db.prepare("SELECT * FROM shop_drawing_revs WHERE drawing_id = ? ORDER BY made_at").all(id) as RevRow[]).map(revFrom);
  const test = (testRevs.get(id) ?? []).filter((t) => !rows.some((r) => r.rev === t.rev));
  return [...rows, ...test];
}

export const getRevision = (id: string, rev: string): DrawingRev | null => revisionsOf(id).find((r) => r.rev === rev) ?? null;

/** The next running number in a job: COO-SD-001, -002... (a test turn's count too). */
export function nextNumberIn(job: string): number {
  const nums = allDrawings()
    .filter((d) => d.job === job)
    .map((d) => Number(/-SD-(\d+)$/.exec(d.number)?.[1] ?? 0));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

/** Keep a drawing (new or changed) and one revision of it. persist false: in memory only (a test turn). */
export function saveRevision(d: Drawing, r: DrawingRev, persist: boolean) {
  if (!persist) {
    testDrawings.delete(d.id);
    testDrawings.set(d.id, d);
    testRevs.set(d.id, [...(testRevs.get(d.id) ?? []).filter((x) => x.rev !== r.rev), r]);
    while (testDrawings.size > 20) {
      const k = testDrawings.keys().next().value!;
      testDrawings.delete(k);
      testRevs.delete(k);
    }
    return;
  }
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO shop_drawings (id, number, job, project, client, title, status, rev, model_item, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project = excluded.project, client = excluded.client, title = excluded.title, status = excluded.status, rev = excluded.rev, model_item = excluded.model_item, updated_at = excluded.updated_at`,
    ).run(d.id, d.number, d.job, d.project, d.client, d.title, d.status, d.rev, d.model_item, d.created_at, d.updated_at);
    db.prepare(
      `INSERT OR REPLACE INTO shop_drawing_revs (drawing_id, rev, status, text, date, model_json, input_json, sheets_json, pdf, dxf, parts_dir, item_id, made_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.drawing_id, r.rev, r.status, r.text, r.date, JSON.stringify(r.model), JSON.stringify(r.input), JSON.stringify(r.sheets), r.pdf, r.dxf, r.parts_dir, r.item_id, r.made_at);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** The item a revision is shown with, once it exists. */
export function setRevisionItem(id: string, rev: string, itemId: string, persist: boolean) {
  if (!persist) {
    const r = testRevs.get(id)?.find((x) => x.rev === rev);
    if (r) r.item_id = itemId;
    return;
  }
  db.prepare("UPDATE shop_drawing_revs SET item_id = ? WHERE drawing_id = ? AND rev = ?").run(itemId, id, rev);
}

export const stamp = () => nowIso();
