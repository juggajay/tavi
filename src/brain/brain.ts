// The brain: one long-lived Claude Agent SDK session in streaming-input mode (warm, so a question doesn't pay start-up),
// the mind (Stage 21.1). Every request, typed or by voice, goes to it, so it has the whole conversation. Long jobs run as
// background work in their own sessions. Nothing leaves the PC on the brain's say-so: sends and other writes go through
// the broker and the user's tap.
import { forkSession, query, type EffortLevel, type Query, type SDKUserMessage, type ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import { makeDemoServer, TOOL_LABELS } from "./demoTools.js";
import { makeMailServer } from "./mailTools.js";
import { makeMemoryServer } from "./memoryTools.js";
import { makeDrawingServer } from "./drawingTools.js";
import { makeShowServer } from "./showTools.js";
import { makeModelServer } from "./modelTools.js";
import { makeShopServer } from "./shopTools.js";
import { makeFileServer } from "./fileTools.js";
import { makeReferenceServer } from "./referenceTools.js";
import { makeCalcServer } from "./calcTools.js";
import { makeActionServer } from "./actionTools.js";
import { makeComputerServer } from "./computerTools.js";
import { makeBrainLinkServer } from "../brainlink/tools.js";
import { BACKGROUND_SCHEMA, buildBackgroundPrompt, buildSystemPrompt, OUTPUT_SCHEMA, TASK_RULES, WORK_GO, WORK_SCHEMA } from "./rules.js";
import { adequacyClaim, withoutClaimSentences } from "./claims.js";
import { LimitError, limitIn, limitSentence } from "./limit.js";
import { DEV } from "../dev.js";
import { WEB_GUARDS } from "./guards.js";
import { newTurnCtx, noteOutsideReads, type TurnCtx, newTurn, type TurnInfo } from "./turn.js";
import { noteSources } from "./sourceLedger.js"; // Stage 20.3: drawings and web pages, for "where did you get that?"
import { BRAIN_CWD, CONNECTOR_GUARDS, connectorEnv, connectorLabel, recordConnectorStatus, wantsLoaded } from "../connectors/claudeai.js";
import { assistantName, ownerNames, profileVersion, readSoul, readUser } from "../profile/profile.js";
import { bus } from "../events.js";
import { runKeeper } from "../memory/keeper.js";
import { FAKE, fakeBackground, fakeTask, fakeThink } from "./fake.js";
import { getSettings } from "../store/settings.js";
import { db, nowIso } from "../store/db.js";
import { finishJob, startJob } from "../store/jobs.js";
import { audit } from "../store/log.js";
import { onSteer, recordOf, setTaskRunner, workDoing, workLimits, type TaskSpec } from "./tasks.js";
import { deliverDue, queueNotification } from "../proactive/notify.js";
import { itemsForJob } from "../store/items.js";
import { cleanSpoken, partialSpoken, stripOpening } from "./spoken.js";

// Each Claude session gets its own tool-server instances (an in-process MCP server can only serve one session at a time)
// and its own turn context, so a background run reading email never affects the conversation's trust, or vice versa.
const MCP = (ctx: TurnCtx) => ({
  site: makeDemoServer(ctx),
  mail: makeMailServer(ctx),
  memory: makeMemoryServer(ctx),
  drawings: makeDrawingServer(ctx),
  actions: makeActionServer(ctx),
  show: makeShowServer(ctx),
  files: makeFileServer(ctx),
  reference: makeReferenceServer(ctx),
  calc: makeCalcServer(ctx),
  model: makeModelServer(ctx),
  shop: makeShopServer(ctx),
  computers: makeComputerServer(ctx),
  brainlink: makeBrainLinkServer(ctx), // Stage 16: The Brain (separate service)
});
// Built-in tools: web search and page reading only (no shell, no file access). WebFetch is policed by WEB_GUARDS.
const BUILTIN = ["WebSearch", "WebFetch"];
// Connector tools from the user's Claude account (Gmail, Calendar, Drive...) are deliberately NOT listed here:
// CONNECTOR_GUARDS is their only way in, and it follows the Read/Write permissions the user set in Setup.
const ALLOWED = ["mcp__site__*", "mcp__mail__*", "mcp__memory__*", "mcp__drawings__*", "mcp__actions__*", "mcp__show__*", "mcp__files__*", "mcp__reference__*", "mcp__calc__*", "mcp__model__*", "mcp__shop__*", "mcp__computers__*", "mcp__brainlink__*", ...BUILTIN];
// Before the conversation is ever compacted, the memory keeper reads it first (it works from the saved log, so this is a
// belt-and-braces catch-up; nothing said is lost either way).
const BEFORE_COMPACT = [{ hooks: [async () => (void runKeeper("before compaction"), {})] }];
const hooksFor = (ctx: TurnCtx) => ({ PreToolUse: [noteOutsideReads(ctx), noteSources(ctx), ...WEB_GUARDS, ...CONNECTOR_GUARDS], PreCompact: BEFORE_COMPACT });

const CONNECTOR_LABELS: [RegExp, string][] = [
  [/^mcp__claude_ai_Gmail__/, "Checking your email"],
  [/^mcp__claude_ai_Google_Calendar__/, "Checking your calendar"],
  [/^mcp__claude_ai_Google_Drive__/, "Looking in your Drive"],
];
export const progressLabel = (name: string) =>
  TOOL_LABELS[name.replace(/^mcp__\w+?__/, "")] ??
  CONNECTOR_LABELS.find(([re]) => re.test(name))?.[1] ??
  (name.startsWith("mcp__claude_ai_") ? `Checking ${connectorLabel(name)}` : "Working on it");

/*
 * One mind (Stage 21.1). "How hard it thinks":
 *   Quick     Haiku 5.5 at low effort answers (its background work on Sonnet 5.5): speed over depth
 *   Balanced  Opus 5.5 with adaptive thinking at high effort: it sets its own depth for each thing (the default)
 *   Best      Opus 5.5 with adaptive thinking at xhigh effort: the most depth on everything
 * Nothing picks a model by matching his words (Stage 10.4's routing is gone): what a request needs is the mind's own
 * judgement, inside one conversation it has all of. Haiku never speaks on Balanced or Best: it only does small background
 * steps (the memory keeper, the opening line's checks, the voice card, reading title blocks, the connector check).
 * BRAIN_MODEL (the mind) and BRAIN_MODEL_STRONG (its background work) still override.
 *
 * Thinking: adaptive, which is the SDK's way of letting the model decide when and how much to think (ThinkingAdaptive,
 * "Claude decides when and how much to think"), with effort setting how deep it goes when it does. "summarized" only
 * makes what it thought readable in its own record; it doesn't change the thinking.
 */
const MODE = () => getSettings()["brain.mode"];
/** The mind: the one session that answers him. */
const MIND_MODEL = () => process.env.BRAIN_MODEL || (MODE() === "fast" ? "claude-haiku-5-5" : "claude-opus-5-5");
/** Its background work (a piece of work it takes away, Stage 21.3): the same model, except on Quick. */
const WORK_MODEL = () => process.env.BRAIN_MODEL_STRONG || (MODE() === "fast" ? "claude-sonnet-5-5" : "claude-opus-5-5");
/** How deep it may go: high on Balanced, the most on Best, the least on Quick. */
// The mind at medium on Balanced (21.4): its thinking is adaptive, so a quick question gets a short think and a hard one a
// long one; measured on the same simple cases, medium was as good, quicker, and used about half as much of his plan as
// high. A piece of work (start_work) still thinks at high. LH_MIND_EFFORT is for measuring on the build copy only.
const MIND_EFFORT = (): EffortLevel => (DEV && process.env.LH_MIND_EFFORT ? (process.env.LH_MIND_EFFORT as EffortLevel) : MODE() === "fast" ? "low" : MODE() === "best" ? "xhigh" : "medium");
const WORK_EFFORT = (): EffortLevel => (MODE() === "fast" ? "medium" : MODE() === "best" ? "xhigh" : "high");
/** Adaptive thinking, its summary kept in the record (Opus); other models take their default (adaptive too). */
const thinkingFor = (model: string): ThinkingConfig | undefined => (/opus/.test(model) ? { type: "adaptive", display: "summarized" } : undefined);
/** Routines and follow-up checks that speak to him (the morning brief, the wrap-up): the mind's own model (Stage 21.1). */
const ROUTINE_MODEL = () => process.env.BACKGROUND_MODEL || (MODE() === "fast" ? "claude-haiku-5-5" : MIND_MODEL());
/** Which model and effort under the current setting (for the PC app, the notes, the replay and tests). */
export const brainModels = () => ({ mind: MIND_MODEL(), effort: MIND_EFFORT(), work: WORK_MODEL(), work_effort: WORK_EFFORT(), routine: ROUTINE_MODEL() });
/** "Best": the strong model for everything that thinks on the owner's behalf. */
const BEST = () => getSettings()["brain.mode"] === "best";
/** The model for web jobs in its own browser: Sonnet unless Best (unchanged by Stage 21; the browser has its own loop). */
export const workModel = (usual: string) => (BEST() ? WORK_MODEL() : usual);

/** What the PC app shows about the brain: the model that answers. */
export const brainInfo = {
  get model() {
    return MIND_MODEL();
  },
  apiKeySource: "unknown" as string,
};

export type Card = { title: string; rows: { label: string; value: string }[]; source: string };
export type BrainResult = { spoken: string; card?: Card; ms: number; costUsd?: number; model?: string };
type ThinkOpts = {
  onProgress?: (label: string, tool?: string) => void;
  signal?: AbortSignal;
  test?: boolean;
  turn?: TurnInfo;
  /** Fills RECENT in the request: the conversation lines this session hasn't seen (skip: the turns it has). */
  recent?: (skip: ReadonlySet<string>) => string;
  /** The spoken answer so far, while the model is still writing it (Stage 10.5): only once its other tools are done,
   * and only for an answer that starts with "spoken". */
  onSpoken?: (soFar: string) => void;
  /** The request holds outside words (a round table's guest, Stage 17): memory and profile writes from this turn are held
   * for the owner's OK, as after reading an email. */
  outside?: string;
};

/**
 * Where the recent conversation goes in a request. Each session already remembers the turns it answered, so it is only
 * sent what it missed: voice-only replies, the other brain's turns, notices. A fresh session gets the lot.
 */
export const RECENT = "{{recent conversation}}";

/** The parts of a Messages API stream event the answer stream reads. */
type StreamEvent = { type: string; index?: number; content_block?: { type: string; name?: string }; delta?: { type: string; partial_json?: string } };

type Pending = {
  started: number;
  resolve: (r: BrainResult) => void;
  reject: (e: Error) => void;
  onProgress?: (label: string, tool?: string) => void;
  onSpoken?: (soFar: string) => void;
  /** The answer being written: the StructuredOutput block of the message in progress (if it's the only tool call so far). */
  stream?: { index: number | null; json: string; otherTool: boolean };
};

/** Async queue the SDK reads user messages from. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private done = false;
  push(text: string) {
    const msg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }
  close() {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// What the voice is given (cleaned; no second "okay"; a sentence at a time while it's written): spoken.ts.
export { cleanSpoken, stripOpening } from "./spoken.js";

/** Hit the step limit (a runaway guard, not a cap on ordinary work): say so plainly instead of failing. */
const TOO_LONG = "That one ran away from me: I took more steps than I should for one answer and stopped. Tell me what matters most and I'll take it away as a proper piece of work.";

/** One warm Claude session: the mind. It answers one request at a time (the gateway queues them). */
export class BrainSession {
  private s: { q: Query; inbox: Inbox; ctx: TurnCtx; version: string; model: string; effort: EffortLevel; sessionId?: string } | undefined;
  private pending: Pending | undefined;
  /** Jobs whose turns this session has seen (both sides of them are in its own history). */
  private handled = new Set<string>();
  /** The last message of the session's record (its uuid), so a piece of work can start from exactly here (21.3). */
  private lastUuid: string | undefined;

  constructor(private opts: { name: string; model: () => string; effort: () => EffortLevel; maxTurns: number }) {}

  /** Started at least once in this run. */
  used = false;

  get busy() {
    return !!this.pending;
  }
  get ctx() {
    return this.s?.ctx;
  }
  /** Where the conversation's record is, for a piece of work that starts from it (21.3). */
  get record() {
    return this.s?.sessionId ? { sessionId: this.s.sessionId, upTo: this.lastUuid, model: this.s.model } : null;
  }

  start() {
    this.used = true;
    const inbox = new Inbox();
    const ctx = newTurnCtx();
    const version = profileVersion();
    const model = this.opts.model();
    const effort = this.opts.effort();
    const thinking = thinkingFor(model);
    const q = query({
      prompt: inbox,
      options: {
        model,
        effort,
        ...(thinking ? { thinking } : {}),
        // House rules, then SOUL.md, then USER.md: fixed for the whole session, so it stays in the prompt cache.
        systemPrompt: buildSystemPrompt(readSoul(), readUser(), assistantName()),
        settingSources: [],
        tools: BUILTIN,
        hooks: hooksFor(ctx),
        mcpServers: MCP(ctx),
        allowedTools: ALLOWED,
        cwd: BRAIN_CWD,
        env: connectorEnv(),
        permissionMode: "dontAsk",
        // A guard against a runaway, not a cap on ordinary work: anything long goes away as a piece of work (21.3).
        maxTurns: this.opts.maxTurns,
        // The answer as it's written (Stage 10.5): its "spoken" part goes to the voice a sentence at a time.
        includePartialMessages: true,
        outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
      },
    });
    this.s = { q, inbox, ctx, version, model, effort };
    this.handled = new Set();
    this.lastUuid = undefined;
    void this.pump(q);
    // Connectors come up a few seconds after start. Match them to the user's permissions, then note what's connected.
    setTimeout(() => void checkConnectors(q), 8000);
  }

  close() {
    this.s?.inbox.close();
    this.s = undefined;
  }

  warm() {
    if (!this.s) this.start();
  }

  query() {
    if (!this.s) this.start();
    return this.s!.q;
  }

  /** SOUL.md or USER.md changed, or the setting did: start fresh when idle so the next question uses them. */
  reloadIfStale() {
    if (!this.s || this.pending) return;
    if (this.s.version === profileVersion() && this.s.model === this.opts.model() && this.s.effort === this.opts.effort()) return;
    this.close();
  }

  /**
   * One streaming event of the answer being written. The final answer is a call to the StructuredOutput tool; its JSON
   * comes in pieces. When it's the first tool call in its message (so every other tool the turn used has finished), the
   * "spoken" part so far goes to onSpoken.
   */
  private streamed(e: StreamEvent) {
    const p = this.pending;
    // a long think shows as one (a real step, not a timer), so the line isn't left on a tool that finished long ago
    if (p && e.type === "content_block_start" && e.content_block?.type === "thinking") p.onProgress?.("Thinking");
    if (!p?.onSpoken) return;
    if (e.type === "message_start") p.stream = { index: null, json: "", otherTool: false };
    else if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
      p.stream ??= { index: null, json: "", otherTool: false };
      if (e.content_block.name === "StructuredOutput" && !p.stream.otherTool) p.stream = { index: e.index ?? 0, json: "", otherTool: false };
      else p.stream.otherTool = true;
    } else if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta" && p.stream && p.stream.index === e.index && !p.stream.otherTool) {
      p.stream.json += e.delta.partial_json ?? "";
      const soFar = partialSpoken(p.stream.json);
      if (soFar) p.onSpoken(soFar);
    }
  }

  private async pump(q: Query) {
    try {
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init") {
          brainInfo.apiKeySource = msg.apiKeySource ?? "none";
          if (this.s?.q === q) this.s.sessionId = msg.session_id;
          if (msg.apiKeySource && msg.apiKeySource !== "none") console.warn(`[brain] warning: using ${msg.apiKeySource}, not the Claude subscription login`);
        } else if (msg.type === "stream_event") {
          if (msg.parent_tool_use_id === null) this.streamed(msg.event as StreamEvent);
        } else if (msg.type === "assistant") {
          this.lastUuid = msg.uuid;
          for (const block of msg.message.content) if (block.type === "tool_use" && block.name !== "StructuredOutput" && !block.name.endsWith("__progress")) this.pending?.onProgress?.(progressLabel(block.name), block.name);
        } else if (msg.type === "user") {
          if (msg.uuid) this.lastUuid = msg.uuid;
        } else if (msg.type === "result") {
          const p = this.pending;
          this.pending = undefined;
          if (!p) continue;
          const limit = limitOf(msg);
          if (limit) {
            p.reject(limit);
            continue;
          }
          if (msg.subtype === "error_max_turns") {
            p.resolve({ spoken: TOO_LONG, ms: Date.now() - p.started, costUsd: msg.total_cost_usd, model: this.s?.model });
            continue;
          }
          if (msg.subtype !== "success") {
            p.reject(new Error(`brain stopped: ${msg.subtype}`));
            continue;
          }
          if (!msg.structured_output && apiError(msg.result)) {
            p.reject(new Error(apiError(msg.result)!));
            continue;
          }
          const out = (msg.structured_output ?? safeParse(msg.result)) as { spoken?: string; card?: Card } | undefined;
          if (!out?.spoken) p.reject(new Error("brain returned no spoken answer"));
          else p.resolve({ spoken: cleanSpoken(out.spoken), card: out.card, ms: Date.now() - p.started, costUsd: msg.total_cost_usd, model: this.s?.model });
          this.reloadIfStale();
        }
      }
      throw new Error("brain session ended");
    } catch (err) {
      // A session retired on purpose (fresh start, new profile) just winds down quietly. Only the CURRENT session's
      // failure may fail the question in flight.
      if (this.s?.q !== q) return;
      console.error(`[brain:${this.opts.name}] session error:`, err instanceof Error ? err.message : err);
      const lim = err instanceof Error ? limitIn(err.message) : null;
      this.pending?.reject(lim ? new LimitError(lim, (err as Error).message) : err instanceof Error ? err : new Error(String(err)));
      this.pending = undefined;
      this.s = undefined; // next request starts a fresh session
    }
  }

  think(request: string, opts: ThinkOpts = {}): Promise<BrainResult> {
    if (this.pending) return Promise.reject(new Error("brain is busy"));
    this.reloadIfStale();
    if (!this.s) this.start();
    const s = this.s!;
    s.ctx.external.clear(); // a new request starts with nothing outside read yet
    if (opts.outside) s.ctx.external.add(opts.outside);
    s.ctx.test = opts.test === true; // a test turn may read and show, never save
    s.ctx.turn = opts.turn ?? newTurn({ persist: !s.ctx.test });
    s.ctx.note = (line) => opts.onProgress?.(line);
    return new Promise<BrainResult>((resolve, reject) => {
      this.pending = { started: Date.now(), resolve, reject, onProgress: opts.onProgress, onSpoken: opts.onSpoken };
      opts.signal?.addEventListener("abort", () => {
        void s.q.interrupt().catch(() => undefined);
        if (this.pending?.resolve === resolve) {
          this.pending = undefined;
          reject(new Error("stopped"));
        }
      });
      const job = opts.turn?.job_id;
      s.inbox.push(request.replace(RECENT, () => opts.recent?.(job ? new Set([...this.handled, job]) : this.handled) || "(none)"));
      if (job) this.handled.add(job);
    });
  }
}

/** The mind: one session for the whole conversation. 100 steps is a runaway guard (the most a look-up took was 12). */
const mind = new BrainSession({ name: "mind", model: MIND_MODEL, effort: MIND_EFFORT, maxTurns: 100 });
/** For a piece of work that starts from the conversation (21.3): where its record is, as of the last answer. */
export const mindRecord = () => mind.record;

/**
 * Load only the connectors the user has given Read or Write; switch the rest off (so their tools aren't even offered).
 * This is remembered by Claude Code for BRAIN_CWD only, never for the user's own sessions.
 */
async function checkConnectors(q: Query, reconnect = false) {
  try {
    let list = await q.mcpServerStatus();
    let changed = false;
    for (const s of list.filter((x) => x.source === "claudeai")) {
      const want = wantsLoaded(s.name);
      if (want && s.status === "disabled") (await q.toggleMcpServer(s.name, true).catch(() => undefined), (changed = true));
      else if (!want && s.status !== "disabled") (await q.toggleMcpServer(s.name, false).catch(() => undefined), (changed = true));
      else if (want && reconnect && s.status !== "connected") (await q.reconnectMcpServer(s.name).catch(() => undefined), (changed = true));
    }
    if (changed) {
      await new Promise((r) => setTimeout(r, 3000)); // give a switched-on connector a moment to connect
      list = await q.mcpServerStatus();
    }
    recordConnectorStatus(list);
  } catch (err) {
    console.warn("[brain] connector status:", err instanceof Error ? err.message : err);
  }
}

/** For the PC app: re-check the Claude-account connectors (after connecting one on claude.ai, or changing permissions). */
export async function refreshConnectors(reconnect: boolean) {
  await checkConnectors(mind.query(), reconnect);
}

/** Start the mind early so the first question doesn't pay start-up cost. */
export function warmUp() {
  if (FAKE) return;
  mind.warm();
}

export function resetConversation() {
  mind.close();
}
bus.on("profile", () => mind.reloadIfStale());
bus.on("settings", () => {
  mind.reloadIfStale(); // the model and effort follow the setting
  if (!FAKE && mind.used) mind.warm(); // ready for the next question (once the brain has been used at all)
});

type Thinker = { think: (request: string, opts: ThinkOpts) => Promise<BrainResult> };
/** said: his words alone (the request carries the Context too). voice: the answer will be spoken by the voice after a
 * hand-over (it has already said its "okay"). */
type AskOpts = ThinkOpts & { said?: string; voice?: boolean };

/** One request to the mind (exported with the session as a parameter so tests can stub it). */
export async function askMind(session: Thinker, request: string, opts: AskOpts = {}): Promise<BrainResult> {
  const res = await session.think(request, opts);
  // A voice turn: no second "okay" in front of the answer (the voice said one when it handed over).
  if (opts.voice) res.spoken = stripOpening(res.spoken, opts.said ?? "", ownerNames());
  return res;
}

/** Ask the brain one thing. Callers must not overlap conversation requests (the gateway queues them). */
export async function think(request: string, opts: AskOpts = {}): Promise<BrainResult> {
  if (FAKE) return askMind({ think: (r, o) => fakeThink(r.replace(RECENT, () => o.recent?.(new Set()) || "(none)"), o) }, request, opts);
  return askMind(mind, request, opts);
}

/** What kinds of outside content the request in progress (or the last one) has read, e.g. "the drawings". */
export const readThisTurn = () => [...(mind.ctx?.external ?? [])];

/** A result that is really the plan's usage limit (its text, or its errors, say so): a LimitError, else null. */
function limitOf(msg: { subtype: string; result?: string; errors?: string[]; structured_output?: unknown }): LimitError | null {
  if (msg.structured_output) return null;
  const text = [msg.result ?? "", ...(msg.errors ?? [])].join("\n");
  const lim = limitIn(text);
  return lim ? new LimitError(lim, text) : null;
}

/** The CLI's own error text standing in for an answer ("API Error: ..."): never said to him as if it were one. */
function apiError(text: string | undefined): string | null {
  if (!text || !/^\s*API Error\b/.test(text)) return null;
  return /safeguards flagged/i.test(text) ? `the model's safeguard stopped it (${/\[(\w+)\]/.exec(text)?.[1] ?? "no reason given"})` : text.slice(0, 200);
}

function safeParse(text: string | undefined) {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return { spoken: text };
  }
}

/* ---------------- background runs (routines, follow-up checks) ---------------- */

export type BackgroundResult = { notify: boolean; priority: "urgent" | "normal" | "low"; title: string; spoken: string; card?: Card; ms: number; told_commitments?: string[]; told_points?: string[] };

/**
 * A one-off run in its own Claude process, separate from the conversation: no chat history,
 * same tools (drafts still need the user's tap), capped turns and budget.
 */
export async function runBackground(task: string, opts: { onProgress?: (label: string, tool?: string) => void; turn?: TurnInfo; signal?: AbortSignal } = {}): Promise<BackgroundResult> {
  if (FAKE) return fakeBackground(task);
  const started = Date.now();
  const ctx = newTurnCtx(true);
  if (opts.turn) ctx.turn = opts.turn;
  const abortController = new AbortController();
  opts.signal?.addEventListener("abort", () => abortController.abort());
  const q = query({
    prompt: task,
    options: {
      abortController,
      model: ROUTINE_MODEL(),
      effort: MODE() === "fast" ? "low" : "medium",
      systemPrompt: buildBackgroundPrompt(readSoul(), readUser(), assistantName()),
      settingSources: [],
      tools: BUILTIN,
      hooks: hooksFor(ctx),
      mcpServers: MCP(ctx),
      allowedTools: ALLOWED,
      cwd: BRAIN_CWD,
      env: connectorEnv(),
      permissionMode: "dontAsk",
      maxTurns: 15,
      maxBudgetUsd: 1,
      persistSession: false,
      outputFormat: { type: "json_schema", schema: BACKGROUND_SCHEMA as unknown as Record<string, unknown> },
    },
  });
  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) if (block.type === "tool_use" && block.name !== "StructuredOutput") opts.onProgress?.(progressLabel(block.name), block.name);
    } else if (msg.type === "result") {
      const limit = limitOf(msg);
      if (limit) throw limit;
      if (msg.subtype !== "success") throw new Error(`background run stopped: ${msg.subtype}`);
      const out = (msg.structured_output ?? safeParse(msg.result)) as Omit<BackgroundResult, "ms"> | undefined;
      if (!out || typeof out.notify !== "boolean") throw new Error("background run returned no decision");
      return { ...out, spoken: cleanSpoken(out.spoken ?? ""), ms: Date.now() - started };
    }
  }
  throw new Error("background run ended without a result");
}

/* ---------------- pieces of work (Stage 21.3: working in the open; 21.1: room to work, and the limit) ---------------- */

export { workLimits } from "./tasks.js";
/** Steps: a runaway guard well past any real job. */
const WORK_MAX_TURNS = 250;
/** Told to the work when it reaches a limit, or he wants it now: it stops working and reports, from its own record. */
export const WRAP_UP = (why: string) =>
  `(Tavi) ${why} Do no more work. Answer now: what you have (the result so far, plainly), what's left undone, and what you'd do next. If something you made is on screen, say so; don't show anything new.`;
/** A wrap-up he asked for that the work hasn't come back from within this long is made to answer from its record. */
const HURRY_MS = 90_000;

type WorkOut = { spoken: string; notes?: string; costUsd?: number; limit?: "time" | "budget" | "steps" | "asked" };

/** Run one piece of work: the work model, its own session (a copy of the conversation's, when it came from one), its tools,
 * the limits; then its result to him. */
async function runTask(t: TaskSpec, signal: AbortSignal) {
  startJob(t.id, { current: false });
  bus.emit("activity");
  // what it makes opens on the screen of whoever asked (so it can look at it, and the result is there when it's done)
  const turn = newTurn({ job_id: t.id, origin: t.open ? t.origin : null, background: true });
  const steps: { name: string; label: string; ms: number; at: number }[] = [];
  const onProgress = (label: string, tool?: string) => {
    if (tool) steps.push({ name: tool, label, ms: 0, at: Date.now() });
    workDoing(t.id, label);
  };
  const started = Date.now();
  let out: WorkOut;
  try {
    out = FAKE ? await fakeTask(t, turn, onProgress, signal) : await runTaskQuery(t, turn, onProgress, signal);
  } catch (err) {
    if (signal.aborted) return;
    // stuck: he hears so, plainly, with what's on screen (never silence), and the job is marked failed
    const why = err instanceof Error ? err.message : String(err);
    const shown = itemsForJob(t.id).length;
    const lim = err instanceof LimitError ? err.limit : limitIn(why);
    queueNotification({
      title: t.title,
      spoken: lim
        ? `I couldn't finish "${t.title}": ${limitSentence(lim)}${shown ? " What I'd made so far is on your screen." : ""}`
        : `I couldn't finish "${t.title}": something went wrong on my side${/safeguard/.test(why) ? " (a safety check stopped it)" : ""}.${shown ? " What I'd made so far is on your screen." : ""} Ask me again and I'll pick it up.`,
      priority: "normal",
      source: `task:${t.id}`,
    });
    void deliverDue(new Date());
    throw err;
  }
  if (signal.aborted) return;
  // the adequacy wall holds for a piece of work's result too (Stage 21.2)
  let spoken = out.spoken;
  const claim = adequacyClaim(spoken);
  if (claim) {
    spoken = withoutClaimSentences(spoken);
    audit("brain", "claim_resaid", t.id, { claim: claim.slice(0, 200), fixed: false, work: true });
  }
  const tools = steps.map((s, i) => ({ name: s.name, label: s.label, ms: (steps[i + 1]?.at ?? Date.now()) - s.at }));
  const prev = (db.prepare("SELECT summary FROM jobs WHERE id = ?").get(t.id) as { summary: string | null }).summary;
  db.prepare("UPDATE jobs SET summary = ? WHERE id = ?").run(JSON.stringify({ ...(prev ? JSON.parse(prev) : {}), tools, ms: Date.now() - started, model: FAKE ? "fake" : WORK_MODEL(), costUsd: out.costUsd, ...(out.limit ? { limit: out.limit } : {}) }), t.id);
  finishJob(t.id, { spoken, ...(out.notes ? { notes: out.notes } : {}), ...(out.limit ? { limit: out.limit } : {}) });
  const shown = itemsForJob(t.id);
  // Reported the way a routine is: a notice (on a call, said out loud when he isn't mid-sentence), and a line in the thread.
  queueNotification({ title: t.title, spoken: spoken + (shown.length && !t.open ? " Want to see it?" : ""), priority: "normal", source: `task:${t.id}` });
  await deliverDue(new Date());
  audit("brain", "task.finished", t.id, { ms: Date.now() - started, ...(out.limit ? { limit: out.limit } : {}) });
}

async function runTaskQuery(t: TaskSpec, turn: TurnInfo, onProgress: (label: string, tool?: string) => void, signal: AbortSignal): Promise<WorkOut> {
  const ctx = newTurnCtx(true);
  ctx.turn = turn;
  ctx.note = (line) => onProgress(line);
  const lim = workLimits();
  // A piece of work from the conversation starts from the conversation's own record, as it stood when the answer was given.
  let fork: string | undefined;
  if (t.fromTurn) {
    const rec = await recordOf(t.fromTurn);
    if (signal.aborted) throw new Error("stopped");
    if (rec)
      fork = await forkSession(rec.sessionId, { dir: BRAIN_CWD, ...(rec.upTo ? { upToMessageId: rec.upTo } : {}), title: t.title })
        .then((r) => r.sessionId)
        .catch((err) => (console.warn("[work] couldn't start from the conversation:", err instanceof Error ? err.message : err), undefined));
  }
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort());
  let limit: WorkOut["limit"];
  const timer = setTimeout(() => ((limit = "time"), abortController.abort()), lim.ms);
  let hurry: ReturnType<typeof setTimeout> | undefined;
  const model = WORK_MODEL();
  const thinking = thinkingFor(model);
  const inbox = new Inbox();
  inbox.push(fork ? WORK_GO(t.title, t.understood ?? t.brief) : `${TASK_RULES}\n\nThe job: ${t.title}\n\n${t.brief}`);
  // what he adds or changes while it works, or "the quick version, now": read at its next step
  const unsteer = onSteer(t.id, (text) => {
    inbox.push(text);
    if (/^\(Tavi\) He wants it now/.test(text) && !hurry) hurry = setTimeout(() => ((limit = "asked"), abortController.abort()), HURRY_MS);
  });
  let sessionId: string | undefined;
  let cost = 0;
  try {
    const q = query({
      prompt: inbox,
      options: {
        abortController,
        ...(fork ? { resume: fork } : {}),
        model,
        effort: WORK_EFFORT(),
        ...(thinking ? { thinking } : {}),
        // the conversation's own standing rules when it carries the conversation on (and so its prompt cache)
        systemPrompt: fork ? buildSystemPrompt(readSoul(), readUser(), assistantName()) : buildBackgroundPrompt(readSoul(), readUser(), assistantName()),
        settingSources: [],
        tools: BUILTIN,
        hooks: hooksFor(ctx),
        mcpServers: MCP(ctx),
        allowedTools: ALLOWED,
        cwd: BRAIN_CWD,
        env: connectorEnv(),
        permissionMode: "dontAsk",
        maxTurns: WORK_MAX_TURNS,
        maxBudgetUsd: lim.usd,
        outputFormat: { type: "json_schema", schema: WORK_SCHEMA as unknown as Record<string, unknown> },
      },
    });
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
      else if (msg.type === "assistant") {
        for (const block of msg.message.content) if (block.type === "tool_use" && block.name !== "StructuredOutput" && !block.name.endsWith("__progress")) onProgress(progressLabel(block.name), block.name);
      } else if (msg.type === "result") {
        inbox.close();
        cost = msg.total_cost_usd ?? 0;
        const planLimit = limitOf(msg);
        if (planLimit) throw planLimit;
        if (msg.subtype === "error_max_turns") limit = "steps";
        else if (msg.subtype === "error_max_budget_usd") limit = "budget";
        else if (msg.subtype !== "success") throw new Error(`task stopped: ${msg.subtype}`);
        else if (!msg.structured_output && apiError(msg.result)) throw new Error(apiError(msg.result)!);
        else {
          const out = (msg.structured_output ?? safeParse(msg.result)) as { spoken?: string; facts?: string } | undefined;
          return { spoken: cleanSpoken(out?.spoken ?? "") || `Finished "${t.title}".`, notes: out?.facts, costUsd: cost };
        }
        break;
      }
    }
  } catch (err) {
    if (signal.aborted || !limit) throw err; // stopped by him, or a real failure
  } finally {
    clearTimeout(timer);
    if (hurry) clearTimeout(hurry);
    unsteer();
    inbox.close();
  }
  if (!limit) throw new Error("task ended without a result");
  // It reached a limit (or he wanted it now and it hadn't come back): the work itself says what it has and what's left,
  // from its own record (a short resumed run).
  const why =
    limit === "asked"
      ? "He wants it now: stop where you are."
      : limit === "time"
        ? `This piece of work has reached the most time one may take (${Math.round(lim.ms / 60_000)} minutes).`
        : limit === "budget"
          ? "This piece of work has used the most of his plan one may use."
          : "This piece of work has taken the most steps one may take.";
  audit("brain", "task.limit", t.id, { limit });
  const wrap = sessionId ? await wrapUp(sessionId, WRAP_UP(why), ctx, signal).catch(() => null) : null;
  return {
    spoken:
      wrap?.spoken ||
      `I ran out of room on "${t.title}" (${limit === "asked" ? "you wanted it now" : limit === "time" ? "the time" : limit === "budget" ? "the usage" : "the steps"} one piece of work may take) before I finished, and couldn't put together what I had. Ask me to carry on and I'll pick it up.`,
    notes: wrap?.notes,
    costUsd: cost + (wrap?.costUsd ?? 0),
    limit,
  };
}

/** A short run on a piece of work's own record, after it stopped at a limit: it reports, it doesn't work. */
async function wrapUp(sessionId: string, prompt: string, ctx: TurnCtx, signal: AbortSignal): Promise<{ spoken: string; notes?: string; costUsd?: number } | null> {
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort());
  const timer = setTimeout(() => abortController.abort(), 3 * 60_000);
  try {
    const q = query({
      prompt,
      options: {
        abortController,
        resume: sessionId,
        model: WORK_MODEL(),
        effort: "medium",
        systemPrompt: buildBackgroundPrompt(readSoul(), readUser(), assistantName()),
        settingSources: [],
        tools: [],
        hooks: hooksFor(ctx),
        mcpServers: MCP(ctx),
        allowedTools: [],
        cwd: BRAIN_CWD,
        env: connectorEnv(),
        permissionMode: "dontAsk",
        maxTurns: 4,
        maxBudgetUsd: 1,
        outputFormat: { type: "json_schema", schema: WORK_SCHEMA as unknown as Record<string, unknown> },
      },
    });
    for await (const msg of q) {
      if (msg.type !== "result") continue;
      if (msg.subtype !== "success") return null;
      const out = (msg.structured_output ?? safeParse(msg.result)) as { spoken?: string; facts?: string } | undefined;
      return out?.spoken ? { spoken: cleanSpoken(out.spoken), notes: out.facts, costUsd: msg.total_cost_usd } : null;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
setTaskRunner(runTask);
