// Chat requests take turns per bot. Longer work has its own queue in HQ.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Bot, Engine, EngineChoice, EngineEvent, FailReason, Live, Row, RowBody, SafetyLevel } from "../contract.js";
import type { Origin } from "../../shared/protocol.js";
import { appendRow, dropRow, rewriteRow, rowsOf, type DroppedRow, type RowOptions } from "../rows.js";
import { buildContext } from "../../brain/context.js";
import { progressLabel } from "../../brain/brain.js";
import { cleanSpoken, stripOpening } from "../../brain/spoken.js";
import { SPOKEN_AFTER_HANDOVER } from "../../brain/rules.js";
import { limitIn, limitSentence, noteMissedForLimit } from "../../brain/limit.js";
import { logConversation, type Channel } from "../../store/log.js";
import { db } from "../../store/db.js";
import { bus } from "../../events.js";
import { onBrokerEvent, type BrokerEvent } from "../../broker/broker.js";
import { addUsage, usageOf } from "./usage.js";
import { ourToolName } from "../toolbox/config.js";
import { screenItem } from "../ownership.js";
import { describeScreen } from "../../gateway/surface.js";
import { laneReason } from "../toolbox/lanes.js";
import { noteRequester, forgetRequester } from "./requester.js";

export type TurnDeps = {
  engineFor(bot: Bot): Engine;
  chatOnlyEngine(): Engine;
  getBot(id: string): Bot | null;
  level(): SafetyLevel;
  beginBotTurn(botId: string, t: { job_id: string | null; origin: Origin | null; test: boolean; background: boolean; given_items?: string[]; note?: (line: string) => void }): unknown;
  endBotTurn(botId: string): void;
  noteBuiltinTool(botId: string, toolName: string): void;
  now?: () => Date;
  stopWork?(bot: string): void;
};
export type TurnResult = { ok: boolean; text: string; spoken: string; failed?: FailReason };
export type BotQuestion = {
  from: string; to: string; question: string; instructions: string; test: boolean;
  signal?: AbortSignal; started(id: string): void; progress(used: number): void;
};
export type Ask = {
  text: string;
  images?: string[];
  via: "typed" | "voice" | "siri" | "routine" | "bot";
  origin: Origin | null;
  test?: boolean;
  background?: boolean;
  onScreen?: string | null;
  given_items?: string[];
  from?: "owner" | "other-bot" | "system";
  who?: string;
  question?: string;
  onUsage?: (used: number) => void;
  onDone?: (result: TurnResult) => void;
};
export type TurnEnded = { bot: string; job_id: string; generation: number; test: boolean; background: boolean; result: TurnResult };
type Events = { row: [Row]; "row-dropped": [DroppedRow]; live: [Live]; "turn-ended": [TurnEnded] };
type Job = { id: string; bot: Bot; ask: Ask; rows: RowOptions; hops: number; chain?: string[] };
type Active = { job: Job; abort: AbortController; safety: boolean };
type Lane = { queue: Job[]; active?: Active; live: Live; draining: boolean };
type Approval = { job: Job; row: Row; settled: boolean };
const providerName = (p: EngineChoice["provider"]) => p === "anthropic" ? "Claude" : p === "openrouter" ? "OpenRouter" : "OpenAI";
const switched = (text: string) => /\b(switch(?:ed|ing)?|carrying on with|fall(?:ing)? back|using .* instead|changed? (?:engine|model|provider))\b/i.test(text);
function label(name: string) {
  if (name.startsWith("mcp__")) return progressLabel(name);
  if (name.startsWith("browser_")) return "Using its browser";
  if (name.startsWith("skill")) return "Checking how it's done";
  return ({ web_search: "Searching the web", web_extract: "Reading a web page", terminal: "Running a command on its computer", read_file: "Working on a file on its computer", write_file: "Working on a file on its computer", patch: "Working on a file on its computer", execute_code: "Running some code", todo: "Planning the steps" } as Record<string, string>)[name] ?? "Working";
}

/**
 * What a bot is told when its answer will be said aloud. On the owner's first real calls (19 November) a simple question
 * ("how many people are coming") got ten sentences read out over half a minute, and "the club weekend" got a recap of
 * everything done so far. A person on a call wants the answer, then to be able to ask for more.
 */
export const ALOUD = "You are being read aloud on a call, so answer the way a person would across a table: the answer first, in one or two short sentences, about ten seconds of speech. If more is worth having (exact figures, several items, a list, your reasoning, what you are unsure of), put it on screen with a show tool and say in a few words that it is there; do not read it out and do not recap earlier work unless asked. If they only name a job or a thing without asking anything, say in a sentence that you have it and ask what they need. One question back at most.";
const aloud = (via: string) => via === "voice" || via === "siri";
/**
 * A bot's own words reach us a few letters at a time. Shown as they came, the "what it's doing" line flickered through
 * half-words ("I'm sett", "leaners clos"). Keep what has arrived and show the sentence it is on, cut at a whole word.
 */
export function inWords(said: { text: string }, piece: string): string | null {
  said.text = (said.text + piece).slice(-600);
  const sentence = said.text.replace(/\s+/g, " ").split(/(?<=[.!?:])\s+/).filter((part) => part.trim()).at(-1) ?? "";
  // The last word may still be arriving: leave it off until a space or a full stop follows it.
  // (A status line from the engine arrives whole, several words at once: that is shown as it is.)
  const arrivedWhole = piece.trim().split(/\s+/).length >= 3;
  const whole = arrivedWhole || /\s$/.test(said.text) || /[.!?:,;]$/.test(sentence) ? sentence : sentence.replace(/\s*\S*$/, "");
  const line = whole.trim().replace(/^[#*\->\s]+/, "");
  return line.length < 3 ? null : line.length > 110 ? line.slice(0, 110).replace(/\s+\S*$/, "") + "…" : line;
}
/**
 * A spoken turn thinks at medium at most: on a call he is waiting in silence, and anything that needs longer thought is
 * taken away as longer work, which runs at the bot's full setting. (His main bot at high took 14 to 35 seconds a reply.)
 */
export function quickChoice(choice: EngineChoice): EngineChoice {
  return choice.effort === "high" || choice.effort === "xhigh" || (choice.effort as string) === "max" ? { ...choice, effort: "medium" } : choice;
}

export class TurnQueues extends EventEmitter<Events> {
  private lanes = new Map<string, Lane>();
  private jobs = new Map<string, Job>();
  private approvals = new Map<string, Approval>();
  private questions = new Set<{ from: string; to: string; cancel(reason: string): void }>();
  private wallNotices = new Map<string, string>();
  private closed = false;
  private lastLevel: SafetyLevel;
  private unsubscribe: () => void;
  private now: () => Date;
  constructor(private deps: TurnDeps) {
    super();
    this.now = deps.now ?? (() => new Date());
    this.lastLevel = deps.level();
    this.unsubscribe = onBrokerEvent((event) => this.broker(event));
    bus.on("item", this.item);
  }
  private lane(bot: string): Lane {
    let lane = this.lanes.get(bot);
    if (!lane) {
      lane = { queue: [], draining: false, live: { bot, state: "idle", doing: null, since: null, steps: 0, queued: 0 } };
      this.lanes.set(bot, lane);
    }
    return lane;
  }
  live(bot: string): Live {
    const current = this.deps.getBot(bot);
    return { ...this.lane(bot).live, ...(current ? { reason: laneReason(current) } : {}) };
  }
  workState(bot: string, work: NonNullable<Live["work"]>) { this.update(bot, { work }); }
  liveAll(): Live[] { return [...this.lanes.keys()].map((id) => this.live(id)); }
  usage(bot: string) { return usageOf(bot, this.now()); }
  /**
   * A row that belongs to no running turn: what a longer piece of work made, or said when it finished. Without this a
   * job's model and its closing words never reached the conversation (the owner's first table: made, and not shown).
   */
  post(botId: string, body: RowBody, opts: { test?: boolean; scope?: string } = {}): Row | null {
    const bot = this.deps.getBot(botId);
    if (!bot) return null;
    const row = appendRow(bot.id, bot.generation, body, { test: !!opts.test, ...(opts.scope ? { scope: opts.scope } : {}), now: this.now() });
    this.emit("row", row);
    return row;
  }
  workSteps(botId: string, job: string, title: string, since: string, test = false) {
    const bot = this.deps.getBot(botId);
    const steps = new Map<string, { row: Row; at: number }>();
    let finished = false;
    const rewrite = (step: { row: Row; at: number }, patch: Partial<Extract<RowBody, { kind: "step" }>>) => {
      if (step.row.body.kind !== "step") return;
      step.row = rewriteRow(step.row.bot, step.row.generation, step.row.seq, { ...step.row.body, ...patch });
      this.emit("row", step.row);
    };
    return {
      tool: (event: Extract<EngineEvent, { type: "tool" }>) => {
        const name = ourToolName(event.name);
        if (test || !bot || finished) return label(name);
        if (name === "tool_search" || name === "tool_describe") return;
        const step = steps.get(event.id);
        if (event.phase === "start") {
          if (step) return label(name);
          const row = appendRow(bot.id, bot.generation, { kind: "step", id: `${job}:${event.id}`, job, jobTitle: title, jobSince: since, tool: name, label: label(name), state: "running" }, { now: this.now() });
          steps.set(event.id, { row, at: this.now().getTime() });
          this.emit("row", row);
        } else if (step?.row.body.kind === "step" && step.row.body.state === "running") {
          rewrite(step, { state: event.ok === false ? "failed" : "ok", ms: Math.max(0, this.now().getTime() - step.at) });
        }
        return label(name);
      },
      finish: (ok: boolean) => {
        if (finished) return;
        finished = true;
        for (const step of steps.values()) if (step.row.body.kind === "step" && step.row.body.state === "running") rewrite(step, { state: ok ? "ok" : "failed", ms: Math.max(0, this.now().getTime() - step.at) });
        const last = [...steps.values()].at(-1);
        if (last) rewrite(last, { jobEndedAt: this.now().toISOString() });
      },
    };
  }
  private update(bot: string, patch: Partial<Live>) {
    const lane = this.lane(bot);
    Object.assign(lane.live, patch, { queued: lane.queue.length });
    this.emit("live", this.live(bot));
  }
  ask(botId: string, ask: Ask): { job_id: string; position: number } { return this.enqueue(botId, ask, 0); }
  private enqueue(botId: string, ask: Ask, hops: number, chain?: string[]) {
    if (this.closed) throw new Error("The turn queue is closed.");
    const bot = this.deps.getBot(botId);
    if (!bot) throw new Error("That bot could not be found.");
    const lane = this.lane(botId);
    const id = `lh-${botId}-${randomUUID()}`;
    const job: Job = { id, bot: structuredClone(bot), ask: structuredClone({ ...ask, onDone: undefined, onUsage: undefined }), rows: { test: !!ask.test, scope: id }, hops, chain };
    if (!ask.background && ["typed", "voice", "siri"].includes(ask.via) && (!ask.from || ask.from === "owner")) {
      const open = screenItem({ origin: ask.origin });
      job.ask.given_items = open ? [open] : [];
      const client = ask.origin && "client" in ask.origin ? ask.origin.id : null;
      if (ask.onScreen === undefined && client) job.ask.onScreen = describeScreen(client);
    }
    job.ask.background = ask.background || ask.via === "routine";
    job.ask.onDone = ask.onDone;
    job.ask.onUsage = ask.onUsage;
    const position = lane.queue.length + (lane.active ? 1 : 0);
    const owner = !ask.from || ask.from === "owner";
    const question = owner ? lane.queue.findIndex((j) => j.ask.question !== undefined) : -1;
    if (question >= 0) lane.queue.splice(question, 0, job);
    else lane.queue.push(job);
    this.update(botId, lane.active ? {} : { state: "queued" });
    if (!lane.draining) {
      lane.draining = true;
      queueMicrotask(() => { void this.drain(botId); });
    }
    return { job_id: id, position };
  }
  private async drain(botId: string) {
    const lane = this.lane(botId);
    try {
      while (lane.queue.length) {
        const level = this.deps.level();
        if (level !== this.lastLevel) this.levelChanged(level);
        const job = lane.queue.shift()!;
        const active: Active = { job, abort: new AbortController(), safety: false };
        if (this.closed) active.abort.abort();
        lane.active = active;
        this.jobs.set(job.id, job);
        this.update(botId, { state: "thinking", doing: null, steps: 0, since: this.now().toISOString() });
        let result: TurnResult;
        try { result = await this.run(active); }
        catch { result = this.result(job, false, "Something went wrong on my side: I couldn't finish that request.", "error"); }
        lane.active = undefined;
        if (![...this.approvals.values()].some((a) => a.job === job && !a.settled)) this.jobs.delete(job.id);
        this.update(botId, { state: lane.queue.length ? "queued" : this.waiting(botId) ? "waiting_for_owner" : "idle", doing: null, since: null });
        // A callback belongs to the caller. A faulty callback must not hold up this bot's next request.
        try { job.ask.onDone?.(result); } catch {}
        this.emit("turn-ended", { bot: botId, job_id: job.id, generation: job.bot.generation, test: !!job.ask.test, background: !!job.ask.background, result });
      }
    } finally { lane.draining = false; }
  }
  stopChat(botId: string) { this.lanes.get(botId)?.active?.abort.abort(); }
  stop(botId: string) {
    for (const q of [...this.questions]) if (q.from === botId || q.to === botId) q.cancel("The owner stopped one of the bots. Ask the owner before trying again.");
    this.stopChat(botId); this.deps.stopWork?.(botId);
  }
  stopAll() { for (const id of this.lanes.keys()) this.stop(id); }
  levelChanged(level: SafetyLevel) {
    if (level === this.lastLevel) return;
    this.wallNotices.clear();
    this.lastLevel = level;
    if (level !== "open") for (const q of [...this.questions]) q.cancel("The safety switch stopped the question.");
    if (level !== "open") for (const lane of this.lanes.values()) if (lane.active) {
      lane.active.safety = true;
      lane.active.abort.abort();
    }
  }
  private add(job: Job, body: RowBody) {
    const row = appendRow(job.bot.id, job.bot.generation, body, { ...job.rows, now: this.now() });
    this.emit("row", row);
    return row;
  }
  private rewrite(job: Job, row: Row, body: RowBody) {
    const next = rewriteRow(row.bot, row.generation, row.seq, body, job.rows);
    this.emit("row", next);
    return next;
  }
  private result(job: Job, ok: boolean, text: string, failed?: FailReason): TurnResult {
    const spoken = job.ask.via === "voice" || job.ask.via === "siri" ? stripOpening(cleanSpoken(text), job.ask.text) : text;
    return { ok, text, spoken, ...(failed ? { failed } : {}) };
  }
  private instructions(job: Job) {
    const a = job.ask;
    const how = a.background || a.via === "routine" ? "This is a routine with nobody listening."
      : a.from === "system" ? "This is a system update about this bot's work."
      : a.via === "voice" ? `The owner is asking by voice (transcribed; may contain errors). ${ALOUD}`
      : a.via === "siri" ? `The owner is asking from Siri. ${ALOUD}`
      : a.via === "bot" ? `This message is from ${a.who ?? "another bot"}.` : "The owner typed this on the phone.";
    const messages = a.test ? [] : rowsOf(job.bot.id, job.bot.generation).filter((r) => r.kind === "message" && r.body.kind === "message" && !r.body.streaming);
    const recent = a.question !== undefined ? messages.slice(-17) : messages.slice(-17, -1);
    return [
      `Context:\n${buildContext(a.text, a.onScreen, { background: a.background || a.via === "routine", bot: job.bot.id, given_items: a.given_items })}`,
      `You are ${job.bot.name}, one of the owner's team of bots. Your role: ${job.bot.role}.`,
      how,
      `Recent conversation:\n${recent.map((r) => r.body.kind === "message" ? `${r.body.who ?? r.body.from}: ${r.body.text}` : "").join("\n")}`,
      `Current work:\n${(this.live(job.bot.id).work ?? []).map((w) => `${w.title}: ${w.state}; ${w.doing ?? "waiting to start"}; ${w.steps} steps`).join("\n") || "Nothing running."}`,
      ...(a.via === "voice" || a.via === "siri" ? [SPOKEN_AFTER_HANDOVER] : []),
      ...(a.images?.length ? [`Sent with this message: ${a.images.length} ${a.images.length === 1 ? "picture" : "pictures"}. Look at them before answering about them.`] : []),
      ...(a.question !== undefined ? [a.question] : []),
    ].join("\n\n");
  }
  quietInstructions(bot: Bot, text: string) {
    return this.instructions({ id: "quiet", bot, hops: 0, rows: { test: true }, ask: {
      text, via: "routine", origin: null, background: true, question: "This is a quiet look. Return only the requested decision. Change nothing and send nothing.",
    } });
  }
  conversationContext(bot: Bot) {
    const recent = rowsOf(bot.id, bot.generation).filter((r) => r.body.kind === "message" && !r.body.streaming).slice(-17);
    return `Recent conversation:\n${recent.map((r) => r.body.kind === "message" ? `${r.body.who ?? r.body.from}: ${r.body.text}` : "").join("\n")}\n\nCurrent work:\n${(this.live(bot.id).work ?? []).map((w) => `${w.title}: ${w.state}; ${w.doing ?? "waiting to start"}; ${w.steps} steps`).join("\n") || "Nothing running."}`;
  }
  private async run(active: Active): Promise<TurnResult> {
    const { job } = active;
    const { bot, ask } = job;
    const channel: Channel = ask.test ? "test" : ask.via === "routine" || ask.via === "bot" ? "system" : ask.via;
    const level = this.deps.level();
    if (level !== this.lastLevel) this.levelChanged(level);
    if (ask.question !== undefined && (level !== "open" || active.abort.signal.aborted || !this.deps.getBot(bot.id))) return this.result(job, false, "The question was stopped.", "stopped");
    const conversation = ask.test ? `lh-${bot.id}-test-${job.id}` : `lh-${bot.id}-g${bot.generation}`;
    const wallKey = ask.test ? conversation : `lh-${bot.id}-g${bot.generation}`;
    if (level === "walled" && this.wallNotices.get(wallKey) !== level) {
      this.add(job, { kind: "notice", tone: "stop", action: "open_switch", text: "The safety switch is on (walled off). I can talk, but I can't look at anything or do anything until you switch it back." });
      this.wallNotices.set(wallKey, level);
    }
    if (ask.question === undefined) this.add(job, { kind: "message", from: ask.from ?? (ask.via === "routine" ? "system" : "owner"), ...(ask.who ? { who: ask.who } : {}), text: ask.text, via: ask.via, ...(ask.images ? { images: ask.images } : {}) });
    const keepLog = !ask.test || ask.question === undefined;
    if (keepLog) logConversation(ask.from === "system" || ask.via === "routine" ? "system" : "user", channel, ask.text, job.id);
    const finish = (result: TurnResult) => { if (keepLog) logConversation("assistant", channel, result.spoken, job.id); return result; };
    if (level === "paused" || level === "killed") {
      const text = level === "paused" ? "The safety switch is on (paused). Your message is kept, but I can't work on it until you switch it back." : "The safety switch is on (killed). Your message is kept, but I can't work on it until you switch it back.";
      this.add(job, { kind: "notice", tone: "stop", action: "open_switch", text });
      return finish(this.result(job, false, text, "stopped"));
    }
    let answer: Row | undefined;
    let text = "";
    let lastFlush = -Infinity;
    let choice = bot.primary;
    let terminal: Extract<EngineEvent, { type: "done" | "failed" }> | undefined;
    const steps = new Map<string, { row: Row; at: number }>();
    const said = { text: "" };
    let began = false;
    let used = 0;
    const flush = (final = false) => {
      if (ask.question !== undefined) return;
      if (!text && !answer && !final) return;
      const body: RowBody = { kind: "message", from: "bot", text, streaming: !final, ...(final ? { engine: choice } : {}) };
      answer = answer ? this.rewrite(job, answer, body) : this.add(job, body);
      lastFlush = this.now().getTime();
    };
    const event = (e: EngineEvent) => {
      if (active.abort.signal.aborted || terminal) return;
      switch (e.type) {
        case "text":
          text += e.delta;
          this.update(bot.id, { state: this.waiting(bot.id) ? "waiting_for_owner" : "working" });
          if (this.now().getTime() - lastFlush >= 150) flush();
          break;
        case "tool": {
          // Hermes knows one of our tool servers by another name (see toolbox/config.ts); use ours from here on.
          e = { ...e, name: ourToolName(e.name) };
          if (e.phase === "start" && !e.name.startsWith("mcp__")) this.deps.noteBuiltinTool(bot.id, e.name);
          if (e.name === "tool_search" || e.name === "tool_describe") break;
          if (e.phase === "start") {
            if (steps.has(e.id)) break;
            const plain = label(e.name);
            steps.set(e.id, { row: this.add(job, { kind: "step", id: e.id, tool: e.name, label: plain, state: "running" }), at: this.now().getTime() });
            said.text = "";
            this.update(bot.id, { state: this.waiting(bot.id) ? "waiting_for_owner" : "working", doing: plain, steps: this.lane(bot.id).live.steps + 1 });
          } else {
            const step = steps.get(e.id);
            if (step?.row.body.kind === "step" && step.row.body.state === "running") step.row = this.rewrite(job, step.row, { ...step.row.body, state: e.ok === false ? "failed" : "ok", ms: Math.max(0, this.now().getTime() - step.at) });
          }
          break;
        }
        case "thinking": { const line = inWords(said, e.delta); if (line) this.update(bot.id, { doing: line }); break; }
        case "status":
          // A switch of subscription arrives whole; a bot's own words arrive a few letters at a time.
          { const line = switched(e.text) ? e.text : inWords(said, e.text); if (line) this.update(bot.id, { doing: line }); }
          if (switched(e.text)) {
            this.add(job, { kind: "notice", tone: "info", text: e.text });
            const target = e.text.split(/\b(?:with|to|using)\b/i).at(-1) ?? "";
            choice = [bot.primary, ...bot.fallbacks].find((c) => target.toLowerCase().includes(providerName(c.provider).toLowerCase())) ?? choice;
          }
          break;
        case "usage":
          choice = e.engine;
          used += e.input + e.output;
          ask.onUsage?.(used);
          if (!ask.test) addUsage(bot.id, e.engine.provider, e.input, e.output, this.now());
          break;
        case "done": choice = e.engine; text = e.text; terminal = e; break;
        case "failed": terminal = e; break;
      }
    };
    try {
      const instructions = this.instructions(job);
      const engine = level === "walled" ? this.deps.chatOnlyEngine() : this.deps.engineFor(bot);
      noteRequester(job.id, (!ask.from || ask.from === "owner") && ["typed", "voice", "siri"].includes(ask.via));
      began = true;
      const ctx = this.deps.beginBotTurn(bot.id, { job_id: job.id, origin: ask.origin, test: !!ask.test, background: !!ask.background || ask.via === "routine", given_items: ask.given_items, note: (line) => {
        if (!active.abort.signal.aborted && !terminal) this.update(bot.id, { doing: line });
      } });
      if (ctx && typeof ctx === "object") Object.assign(ctx, { given_items: ask.given_items });
      if (!active.abort.signal.aborted) await engine.run(bot, { text: ask.text, images: ask.images, instructions, conversation, choice: aloud(ask.via) ? quickChoice(bot.primary) : bot.primary }, event, active.abort.signal);
      if (active.abort.signal.aborted) terminal = { type: "failed", reason: "stopped", message: "" };
      terminal ??= { type: "failed", reason: "engine_down", message: "" };
    } catch (e) {
      terminal = { type: "failed", reason: active.abort.signal.aborted ? "stopped" : "error", message: e instanceof Error ? e.message : String(e) };
    } finally {
      forgetRequester(job.id);
      if (began) {
        try { this.deps.endBotTurn(bot.id); }
        catch { terminal = { type: "failed", reason: "error", message: "I couldn't finish closing that request" }; }
      }
    }
    for (const step of steps.values()) if (step.row.body.kind === "step" && step.row.body.state === "running") {
      step.row = this.rewrite(job, step.row, { ...step.row.body, state: terminal?.type === "done" ? "ok" : "failed", ms: Math.max(0, this.now().getTime() - step.at) });
    }
    if (terminal?.type === "done") {
      flush(true);
      return finish(this.result(job, true, text));
    }
    if (answer) {
      const dropped = dropRow(answer.bot, answer.generation, answer.seq, job.rows);
      if (dropped) this.emit("row-dropped", dropped);
    }
    const failure = terminal?.type === "failed" ? terminal : { reason: "error" as const, message: "I couldn't finish that request" };
    const plan = providerName(choice.provider);
    let message: string;
    switch (failure.reason) {
      case "not_signed_in": message = `${bot.name} isn't signed in to ${plan} yet. Sign in from the bot's Engine panel on the desktop app.`; break;
      case "limit": {
        const lim = { resets: ("resetsAt" in failure ? failure.resetsAt : null) ?? limitIn(failure.message)?.resets ?? null };
        message = limitSentence(lim, this.now()).replace("Claude plan", `${plan} plan`);
        if (!ask.test && (ask.background || ask.via === "routine")) noteMissedForLimit(ask.text, lim, this.now());
        break;
      }
      case "stopped": message = active.safety ? "Stopped by the safety switch." : "Stopped."; break;
      case "engine_down":
        message = `${bot.name}'s engine isn't running. I've asked it to start; try again in a minute.`;
        // Starting is a best effort. The caller can retry without waiting for a slow start here.
        try { void this.deps.engineFor(bot).ready(bot).catch(() => undefined); } catch {}
        break;
      default: message = `Something went wrong on my side: ${failure.message.replace(/[\r\n]+/g, " ").trim().slice(0, 160).replace(/[.!]+$/, "") || "I couldn't finish that request"}.`;
    }
    this.add(job, { kind: "notice", tone: failure.reason === "stopped" ? "info" : "warn", text: message, ...(failure.reason === "not_signed_in" ? { action: "sign_in" as const } : {}) });
    return finish(this.result(job, false, message, failure.reason));
  }
  private waiting(botId: string) { return [...this.approvals.values()].some((a) => a.job.bot.id === botId && !a.settled); }
  private item = (event: Parameters<typeof bus.emit<"item">>[1]) => {
    const id = event.turn?.job_id ?? event.item.job_id;
    const job = id ? this.jobs.get(id) : undefined;
    if (!job || this.lanes.get(job.bot.id)?.active?.job !== job || this.lanes.get(job.bot.id)?.active?.abort.signal.aborted) return;
    this.add(job, { kind: "card", card: "item", ref: event.item.id, title: event.item.title });
  };
  private broker(event: BrokerEvent) {
    if (event.type === "approval") {
      const id = event.approval.id;
      const jobId = (db.prepare("SELECT job_id FROM approvals WHERE id = ?").get(id) as { job_id: string | null } | undefined)?.job_id;
      const job = jobId ? this.jobs.get(jobId) : undefined;
      if (!job || this.lanes.get(job.bot.id)?.active?.job !== job || this.lanes.get(job.bot.id)?.active?.abort.signal.aborted || this.approvals.has(id)) return;
      if (event.replaces) {
        const previous = this.approvals.get(event.replaces);
        if (previous) {
          previous.settled = true;
          previous.row = this.rewrite(previous.job, previous.row, { kind: "card", card: "approval", ref: event.replaces, title: previous.row.body.kind === "card" ? previous.row.body.title : "Earlier request", state: "declined" });
          this.approvals.delete(event.replaces);
        }
      }
      const row = this.add(job, { kind: "card", card: "approval", ref: id, title: event.approval.subject || "Waiting for your tap", state: "waiting" });
      this.approvals.set(id, { job, row, settled: false });
      this.update(job.bot.id, { state: "waiting_for_owner", doing: "Waiting for your tap", waitingSince: this.lane(job.bot.id).live.waitingSince ?? this.now().toISOString() });
      return;
    }
    const id = event.type === "expired" ? event.approvalId : event.outcome.approvalId;
    const approval = this.approvals.get(id);
    if (!approval || approval.settled) return;
    const status = event.type === "expired" ? "expired" : event.outcome.status;
    if (status === "refused" || status === "pending" || status === "executing") return;
    const state = status === "expired" ? "expired" : status === "rejected" ? "declined" : "approved";
    const message = event.type === "expired" ? "That one timed out. Ask me again and I'll redo it." : event.outcome.message;
    const title = approval.row.body.kind === "card" ? approval.row.body.title : "Request";
    approval.settled = true;
    approval.row = this.rewrite(approval.job, approval.row, { kind: "card", card: "approval", ref: id, title, state });
    this.approvals.delete(id);
    const job = approval.job;
    if (!this.waiting(job.bot.id)) this.update(job.bot.id, { waitingSince: null });
    if (!this.closed && this.deps.getBot(job.bot.id)) this.enqueue(job.bot.id, {
      text: `The owner ${state}: ${title}. Result: ${message.replace(/[.!]+$/, "")}.`, from: "system", via: "bot", origin: job.ask.origin, test: job.ask.test, background: job.ask.background,
    }, job.hops, job.chain);
    if (this.lanes.get(job.bot.id)?.active?.job !== job && ![...this.approvals.values()].some((a) => a.job === job && !a.settled)) this.jobs.delete(job.id);
  }
  askBot(input: BotQuestion): Promise<TurnResult> {
    if (this.closed || this.deps.level() !== "open") throw new Error("The safety switch must be open to ask another bot.");
    const from = this.deps.getBot(input.from), to = this.deps.getBot(input.to);
    if (!from || !to) throw new Error("That bot is no longer on the team.");
    if (input.signal?.aborted) throw new Error("The job has stopped, so its question was not sent.");
    const source = this.lanes.get(from.id)?.active?.abort.signal;
    if (source?.aborted) throw new Error("The asking bot has stopped, so its question was not sent.");
    return new Promise<TurnResult>((resolve) => {
      let id = "", settled = false;
      const lane = this.lane(to.id);
      const line = (text: string) => {
        if (input.test) return;
        this.post(from.id, { kind: "message", from: "other-bot", who: to.id, via: "bot", text });
        this.post(to.id, { kind: "message", from: "other-bot", who: from.id, via: "bot", text });
      };
      const clean = () => {
        clearTimeout(timer); clearInterval(check);
        input.signal?.removeEventListener("abort", stopped);
        source?.removeEventListener("abort", sourceStopped);
        this.questions.delete(wait);
      };
      const cancel = (reason: string) => {
        if (settled) return;
        settled = true; clean();
        const queued = lane.queue.findIndex((j) => j.id === id);
        if (queued >= 0) lane.queue.splice(queued, 1);
        if (lane.active?.job.id === id) lane.active.abort.abort();
        this.update(to.id, lane.active ? {} : { state: lane.queue.length ? "queued" : "idle" });
        resolve({ ok: false, text: reason, spoken: reason, failed: "stopped" });
      };
      const wait = { from: from.id, to: to.id, cancel };
      const stopped = () => cancel("The job stopped while waiting for the answer. Say so in the hand-back or ask the owner.");
      const sourceStopped = () => cancel("The asking bot stopped waiting. Ask the owner before trying again.");
      const timer = setTimeout(() => cancel(`${to.name} did not answer in two minutes. Carry on and say so in the hand-back, or ask the owner.`), 120_000);
      const check = setInterval(() => {
        if (this.deps.level() !== "open") cancel("The safety switch stopped the question.");
        else if (!this.deps.getBot(from.id) || !this.deps.getBot(to.id)) cancel("One of the bots was removed while waiting for the answer.");
      }, 50);
      this.questions.add(wait);
      input.signal?.addEventListener("abort", stopped, { once: true });
      source?.addEventListener("abort", sourceStopped, { once: true });
      try {
        const queued = this.enqueue(to.id, {
          text: input.question, question: input.instructions, from: "other-bot", who: from.id, via: "bot", origin: null,
          test: input.test, onUsage: input.progress,
          onDone: (result) => {
            if (settled) return;
            if (input.signal?.aborted) { stopped(); return; }
            if (this.deps.level() !== "open") { cancel("The safety switch stopped the question."); return; }
            if (!this.deps.getBot(from.id) || !this.deps.getBot(to.id)) { cancel("One of the bots was removed while waiting for the answer."); return; }
            settled = true; clean();
            if (result.ok) line(`${to.name} answered ${from.name}: ${result.text}`);
            resolve(result);
          },
        }, 0);
        id = queued.job_id;
        input.started(id);
        line(`${from.name} asked ${to.name}: ${input.question}`);
      } catch { cancel("The question could not be sent."); }
    });
  }
  tell(fromBot: string, toBot: string, text: string, hops?: number): { job_id: string; position: number } {
    if (fromBot === toBot) throw new Error("A bot cannot send a message to itself.");
    if (!this.deps.getBot(fromBot)) throw new Error("That bot could not be found.");
    if (hops !== undefined && (!Number.isSafeInteger(hops) || hops < 0)) throw new Error("The number of messages in this chain must be a whole number from zero.");
    const current = this.lanes.get(fromBot)?.active?.job;
    const depth = Math.max(hops ?? 0, current?.hops ?? 0);
    if (depth >= 4) throw new Error("That's enough back and forth; ask the owner.");
    const chain = [...(current?.chain ?? [fromBot]), toBot];
    const queued = this.enqueue(toBot, {
      text, from: "other-bot", who: fromBot, via: "bot", origin: null, test: current?.ask.test, background: current?.ask.background,
      onDone: (result) => {
        if (this.closed || !this.deps.getBot(fromBot)) return;
        if (depth + 1 >= 4) {
          this.add(targetJob, { kind: "notice", tone: "info", text: "That's enough back and forth; ask the owner." });
          return;
        }
        this.enqueue(fromBot, { text: result.text, from: "other-bot", who: toBot, via: "bot", origin: null, test: current?.ask.test, background: current?.ask.background }, depth + 2, [...chain, fromBot]);
      },
    }, depth + 1, chain);
    const targetJob = this.lane(toBot).queue.find((job) => job.id === queued.job_id)!;
    return queued;
  }
  async askRoom(botIds: string[], message: string | Ask): Promise<Array<{ bot: string; result: TurnResult }>> {
    if (botIds.length > 4) throw new Error("A room can have at most four bots.");
    if (new Set(botIds).size !== botIds.length) throw new Error("Each bot can be in the room only once.");
    for (const id of botIds) if (!this.deps.getBot(id)) throw new Error("That bot could not be found.");
    const results: Array<{ bot: string; result: TurnResult }> = [];
    const original: Ask = typeof message === "string" ? { text: message, via: "typed", origin: null } : message;
    for (const bot of botIds) {
      const earlier = results.map((r) => `${this.deps.getBot(r.bot)?.name ?? r.bot}: ${r.result.text}`).join("\n\n");
      const result = await new Promise<TurnResult>((resolve) => this.ask(bot, { ...original, text: original.text + (earlier ? `\n\nEarlier answers in this room:\n${earlier}` : ""), onDone: resolve }));
      results.push({ bot, result });
    }
    return results;
  }
  // Call when the containing app closes, so no shared listeners are left behind.
  async close() {
    this.closed = true;
    this.stopAll();
    this.unsubscribe();
    bus.off("item", this.item);
    await Promise.all([...this.lanes.values()].map(async (lane) => {
      while (lane.draining) await new Promise((resolve) => setTimeout(resolve, 1));
    }));
    this.jobs.clear();
    this.approvals.clear();
  }
}
export type Turns = TurnQueues;
export const createTurns = (deps: TurnDeps): Turns => new TurnQueues(deps);
