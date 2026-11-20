// What the current turn has read from outside. Planted instructions hide in email, documents, calendar invites,
// drawings and web pages, so memory and profile writes from a turn that read any of those are held for the user's
// OK instead of saved. One context per Claude session; the main session resets it at the start of every request.
import type { HookCallbackMatcher, PreToolUseHookInput, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { WriteTrust } from "../profile/profile.js";
import type { Origin } from "../shared/protocol.js";
import { ownedTools } from "../hq/ownership.js";

/** background: a routine or follow-up check with nobody listening; it can never confirm writes or touch the personality.
 * test: a turn from a test script; it may read and show things but must never save anything (see dryRun).
 * note: where a plain-words progress line goes (the progress tool, Stage 21.3): the asker's working line. */
export type TurnCtx = { external: Set<string>; background: boolean; test: boolean; turn: TurnInfo; bot?: string; given_items?: string[]; note?: (line: string) => void };
export const newTurnCtx = (background = false): TurnCtx => ({ external: new Set(), background, test: false, turn: newTurn({ background }) });

/**
 * The turn in progress, for things it shows: which job, who asked (so only their screen pops it up), whether to keep
 * what it shows (not on test turns), and the order of items within the turn. Set at the start of each request.
 */
export type TurnInfo = { job_id: string | null; origin: Origin | null; persist: boolean; seq: number; items: string[]; background: boolean; bot?: string; given_items?: string[]; based_on_items?: Set<string> };
export const newTurn = (t: Partial<TurnInfo> = {}): TurnInfo => ({ job_id: null, origin: null, persist: true, seq: 0, items: [], background: false, ...t });

/** On a test turn, the reply a writing tool gives instead of doing anything. Null on a normal turn. */
export function dryRun(ctx: TurnCtx, what: string) {
  if (!ctx.test) return null;
  return { content: [{ type: "text" as const, text: `(test run: nothing was saved) This would have run ${what}.` }] };
}

/**
 * Wraps a tool server's tools for test turns: every tool NOT named in readOnly answers with dryRun instead of running.
 * Writing is the default, so a writing tool added later is safe on test turns without anyone remembering to guard it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function testSafe(ctx: TurnCtx, tools: SdkMcpToolDefinition<any>[], readOnly: string[]): SdkMcpToolDefinition<any>[] {
  const known = new Set(tools.map((t) => t.name));
  for (const n of readOnly) if (!known.has(n)) throw new Error(`testSafe: no tool called ${n}`);
  return ownedTools(ctx, tools.map((t) =>
    readOnly.includes(t.name)
      ? t
      : { ...t, handler: async (args, extra) => dryRun(ctx, `${t.name} with ${JSON.stringify(args).slice(0, 300)}`) ?? t.handler(args, extra) },
  ));
}

const OUTSIDE: [RegExp, string][] = [
  [/^Web(Fetch|Search)$/, "the web"],
  [/^mcp__mail__(search_email|read_email)$/, "email"],
  [/^mcp__claude_ai_Gmail__/, "email"],
  [/^mcp__claude_ai_Google_Calendar__/, "the calendar"],
  [/^mcp__claude_ai_Google_Drive__/, "Drive"],
  [/^mcp__claude_ai_/, "a connector"],
  [/^mcp__drawings__(read_sheet|search_drawings|view_drawing|find_on_sheet|schedule_rows)$/, "the drawings"],
  [/^mcp__files__(search_files|read_file|view_file|show_file)$/, "your files"],
  [/^mcp__reference__/, "the reference books"],
  // Stage 11: file names and files on another computer are other people's writing too
  [/^mcp__computers__(list_computer_folder|find_on_computer|read_from_computer|bring_from_computer)$/, "the other computer"],
  // Stage 16: The Brain's questions and what it wrote come from its agents, which read documents and the web
  [/^mcp__brainlink__(brain_jobs|brain_results)$/, "The Brain"],
];

/** Keep track of the kinds of outside words this request has read. */
export function noteOutsideRead(ctx: TurnCtx, toolName: string): void {
  const hit = OUTSIDE.find(([re]) => re.test(toolName));
  if (hit) ctx.external.add(hit[1]);
}

export const noteOutsideReads = (ctx: TurnCtx): HookCallbackMatcher => ({
  hooks: [
    async (input) => {
      noteOutsideRead(ctx, (input as PreToolUseHookInput).tool_name);
      return {};
    },
  ],
});

export const trustOf = (ctx: TurnCtx): WriteTrust =>
  ctx.external.size ? { trust: "external", source: `read: ${[...ctx.external].join(", ")}` } : { trust: "user", source: "said" };
