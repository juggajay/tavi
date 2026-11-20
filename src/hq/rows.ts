// The conversation shown in the apps. Test conversations stay here in memory.
import { db } from "../store/db.js";
import type { Row, RowBody } from "./contract.js";

export type RowOptions = { test?: boolean; scope?: string; now?: Date };
export type RowQuery = RowOptions & { afterSeq?: number; limit?: number };
export type DroppedRow = Pick<Row, "bot" | "generation" | "seq" | "rev">;
const temporary = new Map<string, Row[]>();
const counters = new Map<string, number>();
const revisions = new Map<string, number>();
const key = (bot: string, o: RowOptions) => JSON.stringify([bot, o.scope ?? "test"]);
const copy = <T>(value: T): T => structuredClone(value);
const setting = (k: string) => Number((db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? 0);
function next(k: string, floor: number, o: RowOptions) {
  const n = Math.max(o.test ? counters.get(k) ?? 0 : setting(k), floor) + 1;
  if (o.test) counters.set(k, n);
  else db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(n));
  return n;
}
function revision(bot: string, o: RowOptions) {
  const floor = Math.max(revisions.get(bot) ?? 0, Number((db.prepare("SELECT MAX(rev) n FROM bot_rows WHERE bot = ?").get(bot) as { n: number | null }).n ?? 0), setting(`hq:rows:rev:${bot}`));
  const rev = next(o.test ? `test-rev:${bot}` : `hq:rows:rev:${bot}`, floor, o);
  revisions.set(bot, rev);
  return rev;
}
function transaction<T>(o: RowOptions, fn: () => T): T {
  if (o.test) return fn();
  db.exec("SAVEPOINT hq_rows");
  try {
    const result = fn();
    db.exec("RELEASE hq_rows");
    return result;
  } catch (e) {
    db.exec("ROLLBACK TO hq_rows; RELEASE hq_rows");
    throw e;
  }
}
type Stored = Omit<Row, "body"> & { body_json: string };
const read = ({ body_json, ...r }: Stored): Row => ({ ...r, body: JSON.parse(body_json) as RowBody });

export function appendRow(bot: string, generation: number, body: RowBody, o: RowOptions = {}): Row {
  return transaction(o, () => {
    const previous = o.test ? Math.max(0, ...(temporary.get(key(bot, o)) ?? []).filter((r) => r.generation === generation).map((r) => r.seq))
      : Number((db.prepare("SELECT MAX(seq) n FROM bot_rows WHERE bot = ? AND generation = ?").get(bot, generation) as { n: number | null }).n ?? 0);
    const seq = next(o.test ? `test-seq:${key(bot, o)}:${generation}` : `hq:rows:seq:${bot}:${generation}`, previous, o);
    const row: Row = { bot, generation, seq, rev: revision(bot, o), ts: (o.now ?? new Date()).toISOString(), kind: body.kind, body: copy(body) };
    if (o.test) temporary.set(key(bot, o), [...(temporary.get(key(bot, o)) ?? []), row]);
    else db.prepare("INSERT INTO bot_rows(bot, generation, seq, rev, ts, kind, body_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(bot, generation, seq, row.rev, row.ts, row.kind, JSON.stringify(body));
    return copy(row);
  });
}

export function rewriteRow(bot: string, generation: number, seq: number, body: RowBody, o: RowOptions = {}): Row {
  return transaction(o, () => {
    const old = o.test ? temporary.get(key(bot, o))?.find((r) => r.generation === generation && r.seq === seq)
      : (() => { const r = db.prepare("SELECT * FROM bot_rows WHERE bot = ? AND generation = ? AND seq = ?").get(bot, generation, seq) as Stored | undefined; return r && read(r); })();
    if (!old) throw new Error("That conversation line could not be found.");
    const row: Row = { ...old, rev: revision(bot, o), kind: body.kind, body: copy(body) };
    if (o.test) temporary.set(key(bot, o), temporary.get(key(bot, o))!.map((r) => r === old ? row : r));
    else db.prepare("UPDATE bot_rows SET rev = ?, kind = ?, body_json = ? WHERE bot = ? AND generation = ? AND seq = ?").run(row.rev, row.kind, JSON.stringify(body), bot, generation, seq);
    return copy(row);
  });
}

// Only a failed turn may take back its unfinished answer.
export function dropRow(bot: string, generation: number, seq: number, o: RowOptions = {}): DroppedRow | null {
  return transaction(o, () => {
    const exists = o.test ? temporary.get(key(bot, o))?.some((r) => r.generation === generation && r.seq === seq)
      : !!db.prepare("SELECT 1 FROM bot_rows WHERE bot = ? AND generation = ? AND seq = ?").get(bot, generation, seq);
    if (!exists) return null;
    const dropped = { bot, generation, seq, rev: revision(bot, o) };
    if (o.test) temporary.set(key(bot, o), temporary.get(key(bot, o))!.filter((r) => r.generation !== generation || r.seq !== seq));
    else db.prepare("DELETE FROM bot_rows WHERE bot = ? AND generation = ? AND seq = ?").run(bot, generation, seq);
    return dropped;
  });
}

export function rowsOf(bot: string, generation: number, o: RowQuery = {}): Row[] {
  const limit = Math.max(0, Math.floor(o.limit ?? 2147483647));
  if (o.test) return copy((temporary.get(key(bot, o)) ?? []).filter((r) => r.generation === generation && r.seq > (o.afterSeq ?? 0)).slice(0, limit));
  return (db.prepare("SELECT * FROM bot_rows WHERE bot = ? AND generation = ? AND seq > ? ORDER BY seq LIMIT ?").all(bot, generation, o.afterSeq ?? 0, limit) as Stored[]).map(read);
}
export function changedSince(bot: string, rev: number, o: RowOptions = {}): Row[] {
  if (o.test) return copy((temporary.get(key(bot, o)) ?? []).filter((r) => r.rev > rev).sort((a, b) => a.rev - b.rev));
  return (db.prepare("SELECT * FROM bot_rows WHERE bot = ? AND rev > ? ORDER BY rev").all(bot, rev) as Stored[]).map(read);
}
export function latestGeneration(bot: string, o: RowOptions = {}): number {
  if (o.test) return Math.max(0, ...(temporary.get(key(bot, o)) ?? []).map((r) => r.generation));
  return Number((db.prepare("SELECT MAX(generation) n FROM bot_rows WHERE bot = ?").get(bot) as { n: number | null }).n ?? 0);
}
