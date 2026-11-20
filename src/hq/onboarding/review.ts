import { randomUUID } from "node:crypto";
import { emptyMap, type KnowledgeMap } from "./map.js";

const sessions = new Map<string, { map: KnowledgeMap; until: number }>();
const jobs = new Map<string, string>();
function sweep() {
  for (const [id, value] of sessions) if (value.until < Date.now()) sessions.delete(id);
  for (const [job, id] of jobs) if (!sessions.has(id)) jobs.delete(job);
}
export function reviewSession(id?: string) {
  sweep();
  if (id) {
    if (!sessions.has(id)) throw new Error("That temporary conversation has ended. Start a fresh check.");
    return id;
  }
  while (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
  const key = randomUUID(); sessions.set(key, { map: emptyMap(), until: Date.now() + 30 * 60_000 }); return key;
}
export function temporaryMap(id: string) { sweep(); return sessions.get(id)?.map; }
export function reviewJob(job: string, session: string) { jobs.set(job, session); }
export function mapForReviewJob(job: string | null) { sweep(); return job ? sessions.get(jobs.get(job) ?? "")?.map : undefined; }
export function keepReviewMap(job: string | null, map: KnowledgeMap) {
  const value = job ? sessions.get(jobs.get(job) ?? "") : undefined;
  if (!value) return false;
  value.map = structuredClone(map); return true;
}
