// Keep routine choices in settings so the older routine table needs no change.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Hq } from "./hq.js";
import { getBot, leadBot } from "./bots.js";
import { isActive } from "./team/state.js";
import { getSetting, setSetting, listRoutines, getRoutine, createRoutine, updateRoutine, setRoutineStatus } from "../store/proactive.js";
import { LimitError, missedForLimit } from "../brain/limit.js";
import { runRoutine } from "../proactive/scheduler.js";
import type { ProactiveRun, TeamRoutine } from "../proactive/runner.js";
import { BACKGROUND_SCHEMA } from "../brain/rules.js";
import { adequacyClaim, withoutClaimSentences } from "../brain/claims.js";
import type { Schedule } from "../proactive/schedule.js";
import { findsService } from "./finds/tools.js";
import { voiceOn } from "./finds/wiring.js";

const answerSchema = z.object({
  notify: z.boolean(), priority: z.enum(["urgent", "normal", "low"]), title: z.string(), spoken: z.string(),
  card: z.object({ title: z.string(), rows: z.array(z.object({ label: z.string(), value: z.string() })), source: z.string() }).optional(),
  told_commitments: z.array(z.string()).optional(), told_points: z.array(z.string()).optional(),
});
const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), time: z.string() }),
  z.object({ kind: z.literal("weekdays"), time: z.string() }),
  z.object({ kind: z.literal("weekly"), time: z.string(), days: z.array(z.number().int().min(0).max(6)).min(1) }),
  z.object({ kind: z.literal("once"), at: z.string() }),
]);
const routineSchema = z.object({
  id: z.string().optional(), title: z.string().trim().min(1).max(120).optional(), instructions: z.string().trim().min(1).max(50000).optional(),
  bot: z.string().nullable().optional(), schedule: scheduleSchema.optional(), delivery: z.enum(["push", "brief"]).optional(),
  enabled: z.boolean().optional(), time: z.string().optional(), action: z.enum(["run", "pause", "resume", "delete"]).optional(),
}).strict();
const key = (id: string) => `hq:routine-bot:${id}`;
export function routineBot(r: Pick<TeamRoutine, "id" | "builtin" | "bot">): string | undefined {
  return r.builtin ? leadBot()?.id : r.bot ?? (getSetting(key(r.id)) || undefined);
}
export function withRoutineBot<T extends TeamRoutine>(r: T) { return { ...r, bot: routineBot(r) ?? leadBot()?.id }; }
function checkBot(value: unknown) {
  if (value !== null && (typeof value !== "string" || !getBot(value) || !isActive(value))) throw new Error("Choose a bot on the team.");
}
export function setRoutineBot(r: TeamRoutine, value: unknown) {
  checkBot(value);
  if (r.builtin && value !== null && value !== leadBot()?.id) throw new Error("The lead bot gives the brief and wrap-up.");
  setSetting(key(r.id), value === null ? "" : value as string);
}
export function teamProactive(hq: Hq): ProactiveRun {
  return async (task, routine) => {
    const bot = (routine && routineBot(routine)) ?? leadBot()?.id;
    if (!bot || !getBot(bot) || !isActive(bot)) throw new Error("This routine's bot is no longer on the team. Choose another bot.");
    const text = task + "\n\nReturn only one JSON object in this form, with your decision and the words to say:\n" + JSON.stringify(BACKGROUND_SCHEMA);
    const started = Date.now();
    const result = await hq.background(bot, text, routine?.title ?? "Scheduled check");
    if (!result.ok) {
      if (result.failed === "limit") {
        // The scheduler records the short routine title, rather than this whole prompt.
        setSetting("limit_missed", JSON.stringify(missedForLimit().filter((m) => m.title !== text)));
        throw new LimitError({ resets: null }, result.text);
      }
      throw new Error(result.text);
    }
    let value: unknown;
    try { value = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
    catch { throw new Error("The bot did not return a decision for this routine."); }
    const out = answerSchema.safeParse(value);
    if (!out.success) throw new Error("The bot's routine reply was incomplete. Try it again.");
    return { ...out.data, spoken: adequacyClaim(out.data.spoken) ? withoutClaimSentences(out.data.spoken) : out.data.spoken, ms: Date.now() - started };
  };
}

// These routes run after the gateway's usual origin and browser checks.
export async function routineRoute(req: IncomingMessage, res: ServerResponse, url: URL, local: boolean) {
  const p = url.pathname;
  if (p === "/api/hq/finds/status" || p === "/api/hq/finds/look" || p === "/api/hq/finds/record") {
    const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); return true; };
    if (!local) return send(403, { error: "Run this check on the PC." });
    try {
      const service = findsService();
      if (p.endsWith("/status") && req.method === "GET") return send(200, { voice: voiceOn(), ready: service.reviewReady(), busy: service.busy() });
      if (p.endsWith("/record") && req.method === "GET") return send(200, service.record());
      if (p.endsWith("/look") && req.method === "POST") {
        if (!service.reviewReady()) return send(409, { error: "A bot is busy, a voice call is on, or the safety switch is closed. Wait before checking." });
        // ?test=1 runs the whole look but saves nothing and sends nothing; the answer carries what it would have sent.
        const result = await service.look(url.searchParams.get("test") === "1");
        return send(200, { result, leads: result.leads, found: result.found });
      }
      return send(405, { error: "Use GET for status or the record, or POST for one look." });
    } catch { return send(503, { error: "Looking is not ready. Wait until the lead bot is available." }); }
  }
  const match = /^\/api\/(?:hq|v2)\/routines\/([\w-]+)$/.exec(p);
  const collection = p === "/api/hq/routines";
  const setup = p === "/api/setup/routine";
  if (!collection && !match && !setup) return false;
  const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); return true; };
  if (collection && req.method === "GET") return send(200, listRoutines().map(withRoutineBot));
  if (!["POST", "PATCH"].includes(req.method ?? "")) return send(405, { error: "Use GET, POST or PATCH." });
  if ((setup || collection) && !local) return send(403, { error: "Change this routine on the PC." });
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 64000) return send(413, { error: "That routine is too long." }); chunks.push(Buffer.from(chunk)); }
    const parsed = routineSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) throw new Error("Check the routine's title, instructions, time and bot choice.");
    const b = parsed.data;
    if (Object.hasOwn(b, "bot")) checkBot(b.bot);
    const id = match?.[1] ?? b.id;
    let r = typeof id === "string" ? getRoutine(id) : undefined;
    if (collection && !b.id) {
      if (typeof b.title !== "string" || !b.title.trim() || typeof b.instructions !== "string" || !b.instructions.trim()) throw new Error("Give the routine a title and instructions.");
      if (!b.schedule) throw new Error("Choose when this routine should run.");
      const made = createRoutine({ title: b.title, instructions: b.instructions, schedule: b.schedule, delivery: b.delivery });
      r = getRoutine(made.id);
    }
    if (!r) return send(404, { error: "That routine could not be found." });
    if (r.builtin && b.bot !== undefined && b.bot !== null && b.bot !== leadBot()?.id) throw new Error("The lead bot gives the brief and wrap-up.");
    if (b.time) {
      const s = JSON.parse(r.schedule_json) as Schedule;
      if (s.kind === "once") throw new Error("A one-off routine has a date, not a time.");
      updateRoutine(r.id, { schedule: { ...s, time: b.time } as Schedule });
    }
    if (b.schedule || b.instructions || b.title || b.delivery) updateRoutine(r.id, { schedule: b.schedule, instructions: b.instructions, title: b.title, delivery: b.delivery });
    if (Object.hasOwn(b, "bot")) setRoutineBot(r, b.bot);
    if (b.enabled !== undefined) setRoutineStatus(r.id, b.enabled ? "active" : "paused");
    if (b.action === "pause" || b.action === "resume" || b.action === "delete") setRoutineStatus(r.id, b.action === "pause" ? "paused" : b.action === "delete" ? "deleted" : "active");
    if (b.action === "run") void runRoutine(withRoutineBot(r));
    return send(200, { ok: true, ...withRoutineBot(getRoutine(r.id)!) });
  } catch (error) { return send(400, { error: error instanceof Error ? error.message : "That routine could not be changed." }); }
}
