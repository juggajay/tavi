import { db, newId, nowIso } from "../store/db.js";
import { leadBot } from "../hq/bots.js";
import { screen, rememberChecked } from "../profile/profile.js";
import type { TurnCtx } from "../brain/turn.js";
import { trustOf } from "../brain/turn.js";
import { audit } from "../store/log.js";

export const isSpecialist = (ctx: TurnCtx): boolean => !!ctx.bot && ctx.bot !== leadBot()?.id;
export const memoryScope = (ctx: TurnCtx): string => isSpecialist(ctx) ? `bot:${ctx.bot}` : "lead";
type Fact = { kind: "user" | "person" | "project" | "preference"; subject: string; fact: string; replaces?: string };
export function rememberInScope(ctx: TurnCtx, fact: Fact) {
  const scope = memoryScope(ctx);
  if (fact.replaces && !db.prepare("SELECT id FROM memories WHERE id = ? AND scope = ? AND status = 'active'").get(fact.replaces, scope)) throw new Error("That fact is not in your notebook.");
  if (!isSpecialist(ctx)) return rememberChecked(fact, trustOf(ctx));
  const why = screen(`${fact.subject} ${fact.fact}`);
  if (why) throw new Error(`Not saved: ${why}.`);
  if (ctx.external.size) throw new Error("This came from outside words. Use propose_shared_note for the owner's tap before keeping it.");
  const id = newId("mem"), now = nowIso();
  db.exec("SAVEPOINT notebook_write");
  try {
    db.prepare("INSERT INTO memories(id,kind,subject,fact,source,status,created_at,updated_at,scope) VALUES(?,?,?,?,?,'active',?,?,?)").run(id, fact.kind, fact.subject, fact.fact, "own notebook", now, now, scope);
    if (fact.replaces) db.prepare("UPDATE memories SET status='superseded',superseded_by=?,updated_at=? WHERE id=? AND scope=?").run(id, now, fact.replaces, scope);
    audit("brain", "memory.saved", id, { scope, kind: fact.kind });
    db.exec("RELEASE notebook_write");
  } catch (error) { db.exec("ROLLBACK TO notebook_write; RELEASE notebook_write"); throw error; }
  return { status: "applied" as const, id };
}
export function recallInScope(ctx: TurnCtx, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter((s) => s.length > 2).slice(0, 6);
  const clause = words.length ? `AND (${words.map(() => "(lower(subject) LIKE ? OR lower(fact) LIKE ? OR id = ?)").join(" OR ")})` : "";
  return db.prepare(`SELECT id,kind,subject,fact,created_at FROM memories WHERE scope=? AND status='active' AND (valid_until IS NULL OR valid_until > ?) ${clause} ORDER BY updated_at DESC LIMIT 15`).all(memoryScope(ctx), nowIso(), ...words.flatMap((s) => [`%${s}%`, `%${s}%`, s]));
}
export function forgetInScope(ctx: TurnCtx, id: string) {
  const result = db.prepare("UPDATE memories SET status='forgotten',updated_at=? WHERE id=? AND scope=?").run(nowIso(), id, memoryScope(ctx));
  if (!Number(result.changes)) throw new Error("That fact is not in your notebook.");
  audit("user", "memory.forgotten", id, { scope: memoryScope(ctx) });
  return { forgotten: id };
}
