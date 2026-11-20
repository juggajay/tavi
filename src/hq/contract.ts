// The shared shapes of v3 (see docs/v3/PLAN.md). Every part of src/hq imports its types from here, so the
// engine manager, the turn layer, the toolbox and the apps agree on one description of a bot, a turn and a row.
// Types and constants only: nothing in this file does anything.

/** The safety switch. Held by the guard (src/guard); everything else only reads it. */
export type SafetyLevel = "open" | "paused" | "walled" | "killed";

/** Which subscription or key a bot thinks on. Hermes provider ids. */
export type Provider = "openai-codex" | "anthropic" | "openrouter" | "openai-api";
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type EngineChoice = { provider: Provider; model: string; effort?: Effort };

/**
 * A bot: one member of the team. `id` is a short slug ("pebble", "tim") used in addresses, file names and the
 * Linux user name (`bot-<id>`), so it never changes once made.
 */
export type Bot = {
  id: string;
  name: string;
  /** One line under the name: what this bot is for. */
  role: string;
  /** Standing instructions, in the owner's words plus the outcome-first core. Becomes the bot's SOUL.md. */
  soul: string;
  /** How it looks in the apps: a shape and colour from our own set (ui), never a picture from elsewhere. */
  look: { shape: string; colour: string };
  /** `hermes`: a gateway in the Linux space. `builtin`: the Claude Agent SDK brain on the Windows side. */
  engine: "hermes" | "builtin";
  /** What it thinks on first, then what it falls back to, in order. */
  primary: EngineChoice;
  fallbacks: EngineChoice[];
  /** Toolbox servers it may use ("all" or a list of names from ALL_SERVERS). */
  servers: string[] | "all";
  /** Whether it has its own screen, browser and command line inside the Linux space (Stage 6). */
  computer: boolean;
  /** The voice it speaks with on a call. */
  voice: string;
  /** Linux user, gateway port and the like. Set when the bot is made; never shown to the owner. */
  box: { user: string | null; display: number | null; vncPort: number | null; cdpPort: number | null };
  /** Counts up each time the owner starts a fresh conversation with this bot. */
  generation: number;
  /** The first bot is the lead: voice calls and Siri go to it unless the owner picks another. */
  lead: boolean;
  createdAt: string;
};

/** What comes out of an engine while it works on one message. The turn layer turns these into rows. */
export type EngineEvent =
  | { type: "text"; delta: string }
  /** A short line of its reasoning, when the engine shares one. Never shown as the answer. */
  | { type: "thinking"; delta: string }
  /** It started or finished using a tool. `name` is the full name the model used (e.g. mcp__drawings__read_sheet, or a
   * Hermes built-in such as web_search). `id` pairs the start with the end. */
  | { type: "tool"; phase: "start" | "end"; id: string; name: string; input?: unknown; ok?: boolean; summary?: string }
  /** A plain status line from the engine itself (connecting, retrying, switched model). */
  | { type: "status"; text: string }
  | { type: "usage"; input: number; output: number; engine: EngineChoice }
  /** The whole answer, once, at the end. */
  | { type: "done"; text: string; engine: EngineChoice }
  | { type: "failed"; reason: FailReason; message: string; resetsAt?: string | null };

export type FailReason =
  /** Nobody is signed in to this provider for this bot. */
  | "not_signed_in"
  /** The plan's limit is reached (resetsAt says when, if the engine told us). */
  | "limit"
  /** The owner stopped it, or the safety switch did. */
  | "stopped"
  /** The gateway or the Linux space is not running or not answering. */
  | "engine_down"
  | "error";

export type TurnInput = {
  lane?: "chat" | "work";
  text: string;
  /** Pictures the owner sent with the message (data URLs or https URLs). */
  images?: string[];
  /** Fresh context for this one turn: the time, who is asking and how, what is on their screen. */
  instructions: string;
  /** Conversation key. Same key = the engine remembers the earlier turns. */
  conversation: string;
  choice: EngineChoice;
};

export interface Engine {
  readonly kind: "hermes" | "builtin";
  /** Is this bot able to take a message right now? `why` is plain words for the owner when it is not. */
  ready(bot: Bot): Promise<{ ok: boolean; why?: string; reason?: FailReason }>;
  /**
   * Run one message. Calls `on` for each event in order and resolves after the `done` or `failed` event.
   * Aborting `signal` stops the engine's work and ends with `failed: stopped`. Never rejects: every failure is an event.
   */
  run(bot: Bot, input: TurnInput, on: (e: EngineEvent) => void, signal: AbortSignal): Promise<void>;
}

/** One line of a bot's conversation as the apps show it. Append-mostly: a streaming answer is the same row rewritten. */
export type Row = {
  bot: string;
  generation: number;
  /** Position in the conversation. */
  seq: number;
  /** Goes up every time any row of this bot changes, so an app can ask "what changed since N". */
  rev: number;
  ts: string;
  kind: RowKind;
  body: RowBody;
};
export type RowKind = "message" | "step" | "card" | "notice";
export type RowBody =
  | { kind: "message"; from: "owner" | "bot" | "other-bot" | "system"; who?: string; text: string; via?: "typed" | "voice" | "siri" | "routine" | "bot"; streaming?: boolean; images?: string[]; engine?: EngineChoice }
  /** Something it did while working: shown as "Reading sheet A-201" and folded into "Worked for 2m, 7 steps". */
  | { kind: "step"; id: string; tool: string; label: string; state: "running" | "ok" | "failed"; ms?: number; job?: string; jobTitle?: string; jobSince?: string; jobEndedAt?: string }
  /** Something put on the owner's screen during the turn: an item (drawing, model, sheet…) or a request for his tap. */
  | { kind: "card"; card: "item" | "approval"; ref: string; title: string; state?: "waiting" | "approved" | "declined" | "expired" }
  /** A plain line from the system: limit reached, switched engine, safety switch, sign-in needed. */
  | { kind: "notice"; tone: "info" | "warn" | "stop"; text: string; action?: "sign_in" | "open_switch" };

/** What a bot is doing right now, for the "working" chip and the sidebar. */
export type Live = {
  reason?: string;
  work?: { id: string; title: string; state?: "queued" | "working"; doing: string | null; since: string; steps: number }[];
  bot: string;
  state: "idle" | "queued" | "thinking" | "working" | "waiting_for_owner";
  /** Plain words: "Reading sheet A-201". */
  doing: string | null;
  since: string | null;
  waitingSince?: string | null;
  steps: number;
  queued: number;
};

/** Ports and names fixed by the plan. */
export const PORTS = { guard: 3091, toolbox: 3090, hq: 3100, gatewayBase: 8650, vncBase: 5910, cdpBase: 9210 } as const;
export const DISTRO = "lh-bots";
export const botUser = (id: string) => `bot-${id}`;
export const BOT_ID = /^[a-z0-9][a-z0-9-]{0,24}$/;
