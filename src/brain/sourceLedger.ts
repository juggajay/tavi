// What each answer drew on (Stage 20.3), for "where did you get that?" (how_do_you_know). Every tool that hands the brain
// something from a source records it here against the turn: a page or passage read from the shelf, a species looked up,
// a calculator's clauses, a design rule a recipe used, a drawing sheet, a web page. The sources of the last answer are
// then the ones recorded against the turn that wrote it. Kept in memory for the session, and in the audit log (not on
// test turns) so it survives a restart.
import type { HookCallbackMatcher, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../store/db.js";
import { audit } from "../store/log.js";
import { RUNGS, type Rung } from "../reference/rungs.js";
import { webFetchBlockReason } from "./guards.js";
import type { TurnCtx, TurnInfo } from "./turn.js";

export type SourceKind = "drawing" | "file" | "code" | "book" | "guide" | "design" | "species" | "calculator" | "rule" | "web";
export type SourceUse = {
  /** the ladder's rung; null for something whose standing depends on who published it (a web page) */
  rung: Rung | null;
  kind: SourceKind;
  /** the source, as it would be cited: "Fairham, Woodwork Joints (c. 1930)", "NCC 2022 Housing Provisions" */
  what: string;
  /** where in it: a page, a section, a clause, a sheet and revision */
  place?: string;
  /** its edition, date or year */
  date?: string;
  /** a caution that goes with it ("over two years old", "imperial; hand-tool era") */
  note?: string;
  tool: string;
};

type Entry = { job_id: string | null; at: number; sources: SourceUse[] };
const byTurn = new WeakMap<TurnInfo, Entry>();
const recent: Entry[] = [];

/** Record that this turn used a source. The same source and place is kept once. */
export function recordSource(turn: TurnInfo | undefined, s: SourceUse) {
  if (!turn) return;
  let e = byTurn.get(turn);
  if (!e) {
    e = { job_id: turn.job_id, at: Date.now(), sources: [] };
    byTurn.set(turn, e);
    recent.push(e);
    if (recent.length > 40) recent.shift();
  }
  e.job_id ??= turn.job_id;
  if (e.sources.some((x) => x.kind === s.kind && x.what === s.what && x.place === s.place)) return;
  e.sources.push(s);
  if (turn.persist && turn.job_id) audit("brain", "source.used", turn.job_id, s);
}

/** This turn's sources so far. */
export const sourcesOf = (turn: TurnInfo) => byTurn.get(turn)?.sources ?? [];

/** Every source recorded by turns that started recording at or after a moment (the source checks, 20.4). */
export const sourcesSince = (ms: number) => recent.filter((e) => e.at >= ms).flatMap((e) => e.sources);

/**
 * The sources of the last answer before this turn. The last answer is the newest line the assistant wrote under a
 * different job (the conversation log knows); its sources are what was recorded against that job. found false: there
 * was no earlier answer to ask about. sources []: that answer used nothing from the shelf, a calculator or the web.
 */
export function lastAnswerSources(current: TurnInfo): { found: boolean; job_id: string | null; sources: SourceUse[] } {
  const row = db.prepare("SELECT job_id FROM conversation_log WHERE role = 'assistant' AND job_id IS NOT NULL AND (? IS NULL OR job_id <> ?) ORDER BY id DESC LIMIT 1").get(current.job_id, current.job_id) as { job_id: string } | undefined;
  if (row) {
    const mem = [...recent].reverse().find((e) => e.job_id === row.job_id);
    if (mem) return { found: true, job_id: row.job_id, sources: mem.sources };
    const saved = db.prepare("SELECT detail FROM audit_log WHERE event = 'source.used' AND ref = ? ORDER BY id").all(row.job_id) as { detail: string }[];
    return { found: true, job_id: row.job_id, sources: saved.map((r) => JSON.parse(r.detail) as SourceUse) };
  }
  // no logged answer (a test turn isn't kept): the newest other turn that recorded anything
  const mine = byTurn.get(current);
  const mem = [...recent].reverse().find((e) => e !== mine);
  return mem ? { found: true, job_id: mem.job_id, sources: mem.sources } : { found: false, job_id: null, sources: [] };
}

/** One line per source for the screen and the brain: rung, source, place, date, caution. */
export function describeSources(sources: SourceUse[]) {
  return sources
    .slice()
    .sort((a, b) => (a.rung ?? 8) - (b.rung ?? 8))
    .map((s) => ({
      rung: s.rung === null ? "-" : String(s.rung),
      rung_is: s.rung === null ? "a web page: its standing depends on who published it" : RUNGS[s.rung].name,
      source: s.what,
      place: s.place ?? "",
      date: s.date ?? "",
      note: s.note ?? "",
    }));
}

/* ---------------- sources noticed from tool calls the brain makes (the drawings, the web) ---------------- */

/** Extra recorders for tools whose results this module doesn't see (registered by other modules, e.g. a joint recipe's rules). */
const watchers: ((name: string, input: Record<string, unknown>, turn: TurnInfo) => void)[] = [];
export const watchToolCalls = (f: (name: string, input: Record<string, unknown>, turn: TurnInfo) => void) => void watchers.push(f);

/** Keep track of a drawing sheet read or a web page opened. */
export function noteSourceCall(ctx: TurnCtx, name: string, args: Record<string, unknown>): void {
  try {
    // A page the web guard refuses was never read, so it isn't a source.
    if (name === "WebFetch" && typeof args.url === "string" && !webFetchBlockReason(args.url)) recordSource(ctx.turn, { rung: null, kind: "web", what: "a web page", place: args.url.slice(0, 300), tool: name });
    else if (/^mcp__drawings__(read_sheet|view_drawing)$/.test(name) && args.sheet) recordSource(ctx.turn, { rung: 1, kind: "drawing", what: "the job's drawings", place: `sheet ${String(args.sheet).slice(0, 60)}`, tool: name.replace(/^mcp__\w+?__/, "") });
    for (const w of watchers) w(name.replace(/^mcp__\w+?__/, ""), args, ctx.turn);
  } catch {
    // Taking notes never stops a tool.
  }
}

export const noteSources = (ctx: TurnCtx): HookCallbackMatcher => ({
  hooks: [
    async (input) => {
      const i = input as PreToolUseHookInput;
      noteSourceCall(ctx, i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>);
      return {};
    },
  ],
});
