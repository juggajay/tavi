import { createHash } from "node:crypto";
import { db } from "../../store/db.js";
import type { EngineEvent } from "../contract.js";

export const normal = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const fingerprint = (s: string) => createHash("sha256").update(normal(s)).digest("hex");
export type LeadRow = { id: string; look_id: string; fingerprint: string; kind: string; situation: string; query: string; found: string | null; state: string; sent_at: string | null; reaction: string | null; reaction_note: string | null; checked_at: string };
export type LookRow = { id: string; bot: string; day: string; started: string; ended: string | null; state: string; usage: number;
  steps?: EngineEvent[]; leads?: { kind: string; situation: string; state: string }[] };
type Wish = { kind: string; reaction: string; note: string };
const prefix = "finds:ledger:";
// These are small bookkeeping records, kept apart from the settings the owner can change.
function rows<T>(kind: string): T[] {
  return (db.prepare("SELECT value FROM settings WHERE key LIKE ? ORDER BY rowid DESC").all(`${prefix}${kind}:%`) as { value: string }[]).map((r) => JSON.parse(r.value) as T);
}
function save(kind: string, id: string, row: unknown) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`${prefix}${kind}:${id}`, JSON.stringify(row));
}
export const looks = () => rows<LookRow>("look").sort((a, b) => b.started.localeCompare(a.started));
export const leads = () => rows<LeadRow>("lead").sort((a, b) => b.checked_at.localeCompare(a.checked_at));
export const saveLook = (row: LookRow) => save("look", row.id, row);
export function saveLead(row: LeadRow) {
  if (leads().some((r) => r.id !== row.id && r.fingerprint === row.fingerprint)) throw new Error("This lead has already been checked.");
  if (!looks().some((r) => r.id === row.look_id)) throw new Error("This lead needs its own look record.");
  save("lead", row.id, row);
}
export function changeLook(id: string, patch: Partial<LookRow>) {
  const row = looks().find((r) => r.id === id); if (row) saveLook({ ...row, ...patch, id });
}
export function changeLead(id: string, patch: Partial<LeadRow>) {
  const row = leads().find((r) => r.id === id); if (row) saveLead({ ...row, ...patch, id });
}
export function recoverLooks() {
  for (const row of leads().filter((r) => r.state === "checking")) changeLead(row.id, { state: "stopped after restart" });
  for (const row of looks().filter((r) => !r.ended)) changeLook(row.id, { state: "stopped after restart", ended: new Date().toISOString() });
}
export const sentFinds = () => leads().filter((r) => r.sent_at).slice(0, 100);
export const wishes = () => rows<Wish>("wish");
export function reactToFind(id: string | undefined, kind: string | undefined, reaction: "more" | "not-interested", note = "") {
  const row = id ? leads().find((r) => r.id === id && r.sent_at) : undefined;
  if (id && !row) throw new Error("Choose a find that has been sent.");
  const topic = normal(kind ?? row?.kind ?? "");
  if (!topic) throw new Error("Name the kind of thing to leave alone or find more of.");
  save("wish", fingerprint(topic), { kind: topic, reaction, note });
  if (row) changeLead(row.id, { reaction, reaction_note: note });
}
