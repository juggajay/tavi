// The team joins the existing server here. With the switch off this file is never loaded.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { Bot, Engine, EngineEvent, TurnInput } from "./contract.js";
import type { Origin, HqSafety, HqEngine } from "../shared/protocol.js";
import { GuardClient, type GuardState } from "./guardClient.js";
import { listBots, getBot, leadBot, seedTeam, toolboxToken, newConversation, createBot, updateBot, removeBot, teamGatewayKey } from "./bots.js";
import { currentCard, saveCard, dangerousThree, type JobCard } from "./cards/index.js";
import { installTeam, teamService, type HandOverRun, type TrialResult } from "./team/index.js";
import { isActive, trialOnly } from "./team/state.js";
import { readEngineOptions } from "./team/engines.js";
import { HermesEngine, BuiltinEngine, limits, standingFor } from "./engines/index.js";
import type { HermesOptions } from "./engines/hermes.js";
import { startToolbox, wslHostAddress, hermesMcpServers, ALL_SERVERS, beginBotTurn, endBotTurn, botTurn, noteBuiltinTool } from "./toolbox/index.js";
import { createTurns, type Ask, type TurnResult } from "./turns/index.js";
import { bus } from "../events.js";
import { rowsOf, rewriteRow } from "./rows.js";
import { adequacyClaim, RESAY, withoutClaimSentences } from "../brain/claims.js";
import { setTaskRunner, onSteer, workDoing, workLimits, turnFinished, type TaskSpec } from "../brain/tasks.js";
import { WORK_GO, OPEN_WORK_RULES } from "../brain/rules.js";
import { addUsage } from "./turns/usage.js";
import { ourToolName } from "./toolbox/config.js";
import { limitSentence } from "../brain/limit.js";
import { progressLabel } from "../brain/brain.js";
import { db } from "../store/db.js";
import { startJob, finishJob, failJob } from "../store/jobs.js";
import { queueNotification, deliverDue } from "../proactive/notify.js";
import { connectScreens, type ScreenGuardClient } from "./screens/index.js";
import { Computers } from "./screens/service.js";
import { fenceApplied } from "./screens/computer.js";
import { setProactiveRunner } from "../proactive/runner.js";
import { teamProactive } from "./proactive.js";
import { installLooks } from "./toolbox/looks.js";
import { twinName, twinSecret, separateWork, workLane, conversationLane, laneKey, type TurnLane } from "./toolbox/lanes.js";
import { wireFinds } from "./finds/wiring.js";
import { installWebLevel } from "../web/index.js";
import { createQuietTurns } from "./turns/quiet.js";

export const publicBot = ({ box: _box, ...bot }: Bot) => bot;
export type HqCall = { type: "hq_call"; bot: string };
export function safetyOf(state?: GuardState): HqSafety {
  return { level: state?.level ?? "walled", until: state?.until ?? null, pinSet: state?.pinSet ?? false,
    ownerUbuntuRunning: state?.ownerUbuntuRunning ?? false };
}
export type HqOptions = {
  guard?: GuardClient;
  toolboxHost?: string | null;
  toolboxPort?: number;
  hermes?: Omit<HermesOptions, "guard">;
  engine?: Engine;
  chat?: Engine;
  screenGuard?: ScreenGuardClient;
  screenReady?: (bot: Bot) => Promise<void>;
};

// Hold answer words until the strength check has passed, including words meant for speech.
// This wrapper is shared by the conversation and work queues, whichever engine is selected.
export function checkedEngine(engine: Engine): Engine {
  return { kind: engine.kind, ready: (bot) => engine.ready(bot), async run(bot, input, on, signal) {
    let done: Extract<EngineEvent, { type: "done" }> | undefined;
    let failed = false;
    const take = (e: EngineEvent) => {
      if (e.type === "text") return;
      if (e.type === "done") { done = e; return; }
      if (e.type === "failed") failed = true;
      on(e);
    };
    await engine.run(bot, input, take, signal);
    if (signal.aborted || failed || !done) return;
    const first = done;
    const claim = adequacyClaim(first.text);
    if (claim) {
      done = undefined;
      // The second answer gets the same conversation and toolbox turn, once only.
      await engine.run(bot, { ...input, text: RESAY(claim) }, (e) => {
        if (e.type === "done") done = e;
        else if (e.type !== "text" && e.type !== "failed") on(e);
      }, signal).catch(() => undefined);
      done ??= first;
    }
    if (signal.aborted) return;
    const answer = done as Extract<EngineEvent, { type: "done" }>;
    const text = adequacyClaim(answer.text) ? withoutClaimSentences(answer.text) : answer.text;
    on({ type: "text", delta: text });
    on({ ...answer, text });
  } };
}

/**
 * A piece of work is asked to end with what to say and the facts behind it (the built-in brain returns those as two
 * fields). A Hermes bot writes them as plain text, "Spoken: … Facts: …", and all of it was shown to the owner. Only the
 * part meant to be said is his answer.
 */
/** Why a bot's computer did not start, for the log only: our own short reasons, never a request's words. */
function whyNot(bot: string, why: unknown) {
  const text = why instanceof Error ? why.message : typeof why === "string" ? why : "no reason given";
  console.warn(`[computer] ${bot}: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
}
export function saidPart(text: string): string {
  const lower = text.toLowerCase();
  const start = lower.search(/^[\s*]*spoken[\s*]*:/);
  if (start < 0) return text.trim();
  const from = text.indexOf(":", start) + 1;
  const facts = lower.slice(from).search(/[\s*]facts[\s*]*:/);
  return text.slice(from, facts < 0 ? undefined : from + facts).replace(/^[\s*]+|[\s*]+$/g, "");
}
type WorkRun = { bot: string; computer: boolean; spec: TaskSpec; controller: AbortController; test: boolean; messages: string[]; total: number; done: Promise<void>; started: boolean; doing: string | null; since: string; steps: number };
type BotTurn = Parameters<typeof beginBotTurn>[1] & { given_items?: string[] };
type ManagedTurn = { job?: string; signal?: AbortSignal; brief?: string; background?: boolean; bot?: string; text?: string; title?: string; test?: boolean; firstSeq?: number; given_items?: string[]; event?: (e: EngineEvent) => void };
export class Hq extends EventEmitter {
  readonly guard: GuardClient;
  readonly hermes: HermesEngine;
  readonly computers: Computers;
  private screens?: ReturnType<typeof connectScreens>;
  readonly turns: ReturnType<typeof createTurns> & { work: (bot: string, spec: TaskSpec, signal?: AbortSignal) => Promise<void> };
  private toolbox?: Awaited<ReturnType<typeof startToolbox>>;
  private sockets = new Set<WebSocket>();
  private offGuard: () => void;
  private seenAt = -Infinity;
  private state?: GuardState;
  private starting = new Set<string>();
  private pendingBots = new Map<string, Bot>();
  private closed = false;
  private stopped = false;
  private turnBots = new Map<string, { bot: string; test: boolean; given_items?: string[] }>();
  private workRuns = new Map<string, WorkRun>();
  private workTails = new Map<string, Promise<void>>();
  readonly quietTurns: ReturnType<typeof createQuietTurns>;
  private busyBots = new Set<string>();
  private chatLanes = new Map<string, TurnLane>();
  private pendingComputers = new Map<string, boolean>();
  private engineStops = new Set<AbortController>();
  private changed = new EventEmitter();
  private hermesSetup: HermesOptions;
  private offTeam?: () => void;
  private offLooks: () => void;
  private offProactive?: () => void;
  private offFinds?: () => Promise<void>;
  private offWeb?: () => void;
  private booted = false;
  private spaceReady?: Promise<void>;
  private setups = new Map<string, Promise<void>>();
  private managed = new Map<string, ManagedTurn>();
  private testJobs = new Map<string, { bot: string; generation: number; owner?: string; shownGeneration?: number; until: number; timer?: ReturnType<typeof setTimeout> }>();

  constructor(readonly options: HqOptions = {}) {
    super();
    this.offLooks = installLooks({ changed: bot => { this.botsChanged(); void this.ensure(bot); } });
    this.guard = options.guard ?? new GuardClient();
    const guard = this.guard;
    this.computers = new Computers(guard, (bot, computer) => {
      if (!computer.has || computer.state === "error" || computer.state === "stopped") this.screens?.invalidate(bot);
      this.publish({ type: "hq_computer", bot, computer });
    }, options.screenGuard, options.screenReady);
    this.hermesSetup = { ...options.hermes, guard: new Proxy(guard, { get: (target, key) => {
      if (key === "makeTeam") return async () => { await this.waitForSpace(); return guard.makeTeam(); };
      if (key === "writeBotFile") return async (id: string, name: Parameters<GuardClient["writeBotFile"]>[1], content: string) => {
        await guard.writeBotFile(id, name, content);
        if (name === "config.yaml") await this.computers.start(id);
      };
      if (key === "startProcess") return async (user: string, kind?: string) => {
        if (user === "lh-team") await this.computers.start();
        return guard.startProcess(user, kind);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } }),
      busy: () => this.busyBots.size > 0,
      computer: (bot) => this.computers.prepare(bot),
      computerFenced: async (user) => {
        const applied = await fenceApplied((u) => this.computers.screens.fence(u), user);
        if (!applied) { const bot = getBot(user.slice(4)); if (bot) this.computers.error(bot, "The checks between bots have not passed. Its computer tools are off."); }
        return applied;
      },
      computerStop: (bot) => this.computers.stop(bot),
      hermesMcpServers, allServers: ALL_SERVERS };
    this.hermes = new HermesEngine(this.hermesSetup);
    const builtin = (bot: Bot) => this.builtinFor(bot);
    const chat = checkedEngine(options.chat ?? new BuiltinEngine({ guard: this.guard, chatOnly: true }));
    const chosen = new Map<Engine, Engine>();
    const wrap = (engine: Engine) => {
      let safe = chosen.get(engine);
      if (!safe) { safe = checkedEngine(engine); chosen.set(engine, safe); }
      return safe;
    };
    const base = createTurns({
      engineFor: (bot) => {
        const engine = wrap(options.engine ?? (bot.engine === "hermes" ? this.hermes : builtin(bot)));
        return { kind: engine.kind, ready: async (b) => {
          if (b.engine === "hermes") this.ensure(b);
          return engine.ready(b);
        }, run: async (b, input, on, signal) => {
          const job = this.pendingTurns.get(b.id)?.job_id;
          if (job && this.cancelled.has(job)) { on({ type: "failed", reason: "stopped", message: "Stopped." }); return; }
          const details = job ? this.requestContext.get(job) : undefined;
          const managed = job ? this.managed.get(job) : undefined;
          const stop = new AbortController(); this.engineStops.add(stop);
          const together = AbortSignal.any([signal, stop.signal, ...(managed?.signal ? [managed.signal] : [])]);
          try {
            await this.setups.get(b.id);
            const current = getBot(b.id);
            if (current) { b = { ...b, computer: current.computer, primary: current.primary, fallbacks: current.fallbacks }; input = { ...input, choice: current.primary }; }
            const lane = conversationLane(b, [...this.workRuns.values()].some((r) => r.bot === b.id));
            this.chatLanes.set(b.id, lane);
            if (lane === "work") this.quietTurns.stop(b.id);
            input = { ...input, lane, instructions: input.instructions +
              (lane === "work" && b.computer ? "\nYour computer is busy with the running job. You have no computer tools here; offer to wait for that job or stop it first." : "") +
              (!this.pendingTurns.get(b.id)?.test ? "\n\n" + base.conversationContext(b) : "") };
            await this.withBot(b.id, together, () => engine.run(b, { ...input,
              ...(managed?.background ? { conversation: `lh-${b.id}-routine-${managed.job}`, instructions: input.instructions + "\nThis is separate scheduled work. Return the requested decision." } :
                managed?.brief ? { conversation: `lh-${b.id}-brief-${managed.job}`, instructions: "This is a separate job from another bot. Use only this brief and your job card.\n" + managed.brief } :
                { instructions: input.instructions + "\n\n" + OPEN_WORK_RULES + (details ? `\n\nDetails supplied with this request:\n${details}` : "") }),
            }, (event) => { managed?.event?.(event); on(event); }, together),
              managed?.job && !managed.background ? { ...this.pendingTurns.get(b.id)!, job_id: managed.job, given_items: managed.given_items } : undefined, lane);
            if (together.aborted) on({ type: "failed", reason: "stopped", message: "Stopped." });
          } finally { this.chatLanes.delete(b.id); this.engineStops.delete(stop); }
        } };
      },
      chatOnlyEngine: () => ({ kind: chat.kind, ready: (b) => chat.ready(b), run: async (b, input, on, signal) => {
        const job = this.pendingTurns.get(b.id)?.job_id;
        if (job && this.managed.has(job)) { on({ type: "failed", reason: "stopped", message: "Stopped by the safety switch." }); return; }
        const stop = new AbortController(); this.engineStops.add(stop);
        try { await chat.run(b, input, on, AbortSignal.any([signal, stop.signal])); }
        finally { this.engineStops.delete(stop); }
      } }), getBot: (id) => getBot(id) ?? null,
      level: () => this.stopped ? "killed" : this.guard.level(),
      // The queue reserves the toolbox before it calls run. Work uses this same lock.
      beginBotTurn: (id, t) => {
        this.turnBots.set(t.job_id!, { bot: id, test: t.test, given_items: t.given_items });
        // The engine starts the context after it has obtained the bot's lock.
        this.pendingTurns.set(id, t);
        return null;
      },
      endBotTurn: (id) => { this.pendingTurns.delete(id); },
      noteBuiltinTool: (id, name) => noteBuiltinTool(id, name, this.chatLanes.get(id) ?? "chat"),
      stopWork: (id) => { this.quietTurns.stop(id); for (const run of this.workRuns.values()) if (run.bot === id) run.controller.abort(); },
    });
    this.turns = Object.assign(base, { work: (bot: string, spec: TaskSpec, signal?: AbortSignal) => this.work(bot, spec, signal) });
    this.quietTurns = createQuietTurns({
      available: (bot) => !this.closed && !this.stopped && this.guard.level() === "open" && separateWork(bot)
        && !this.busyBots.has(laneKey(bot.id, "work")) && this.chatLanes.get(bot.id) !== "work"
        && (bot.computer ? ![...this.workRuns.values()].some((r) => r.bot === bot.id) || !this.pendingTurns.has(bot.id) && !base.live(bot.id).queued : !this.workTails.has(bot.id)
          && ![...this.workRuns.values()].some((r) => r.bot === bot.id)),
      engine: (bot) => options.engine ?? (bot.engine === "hermes" ? this.hermes : builtin(bot)),
      context: (bot, text) => base.quietInstructions(bot, text),
      run: async (bot, signal, body, request) => {
        await this.setups.get(bot.id);
        await this.withBot(bot.id, signal, body, {
          job_id: request.id, origin: null, background: true, test: request.test,
        }, "work");
      },
      turn: (bot) => botTurn(bot.id, "work"),
      live: (id) => base.live(id), show: (id, work) => base.workState(id, work),
    });
    this.screens = connectScreens(this.turns, guard, { screens: this.computers.screens, control: (id, on) => this.computers.control(id, on) });
    base.on("row", (row) => {
      if (!isActive(row.bot)) return;
      const routine = [...this.managed.entries()].find(([job, m]) => m.background && m.bot === row.bot &&
        (this.pendingTurns.get(row.bot)?.job_id === job || (m.firstSeq !== undefined && row.seq >= m.firstSeq) ||
          (row.body.kind === "message" && row.body.from === "system" && row.body.text === m.text)));
      if (routine && row.body.kind === "message") {
        if (row.body.streaming) return;
        const [job, m] = routine;
        m.firstSeq ??= row.seq;
        let text = m.title ?? "Scheduled work";
        if (row.body.from === "bot") {
          try { const answer = JSON.parse(row.body.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); text = typeof answer.spoken === "string" ? answer.spoken : "The routine did not return an answer."; }
          catch { text = "The routine did not return a usable answer."; }
        }
        row = rewriteRow(row.bot, row.generation, row.seq, { ...row.body, text }, { test: !!m.test, scope: job });
      }
      this.publish({ type: "hq_row", row });
    });
    base.on("row-dropped", ({ bot, generation, seq }) => { if (isActive(bot)) this.publish({ type: "hq_row_dropped", bot, generation, seq }); });
    base.on("live", (live) => { if (isActive(live.bot)) this.publish({ type: "hq_live", live }); });
    base.on("turn-ended", (e) => {
      turnFinished(e.job_id, null); this.changed.emit("free");
      this.requestContext.delete(e.job_id); this.cancelled.delete(e.job_id);
      this.managed.delete(e.job_id);
      const test = this.testJobs.get(e.job_id);
      if (test) {
        test.until = Date.now() + 10 * 60_000;
        test.timer = setTimeout(() => this.testJobs.delete(e.job_id), 10 * 60_000); test.timer.unref();
      }
      if (this.turnBots.size > 100) this.turnBots.delete(this.turnBots.keys().next().value!);
      this.applyWaitingComputers();
    });
    this.changed.on("free", () => this.applyWaitingComputers());
    this.offGuard = this.guard.events((event) => {
      if (event.event === "proc") this.computers.process(event.data);
      this.computers.refresh(this.members());
      if (event.event === "level") {
        const level = this.guard.level();
        base.levelChanged(level);
        if (level !== "open") for (const run of this.workRuns.values()) run.controller.abort();
        if (level !== "open") for (const bot of this.members()) this.quietTurns.stop(bot.id);
        this.publish({ type: "hq_safety", safety: { ...safetyOf(this.state), level } });
        void this.refreshSafety();
        if (level === "open" && this.booted) for (const bot of this.members()) void this.ensure(bot);
        if (level === "open") this.applyWaitingComputers();
      }
    });
  }
  private pendingTurns = new Map<string, BotTurn>();
  private requestContext = new Map<string, string>();
  private cancelled = new Set<string>();
  private builtinEngines = new Map<string, Engine>();
  private builtinFor(bot: Bot) {
    let engine = this.builtinEngines.get(bot.id);
    if (!engine) {
      engine = new BuiltinEngine({ guard: this.guard, ask: async (request, options) => {
        const ctx = botTurn(bot.id);
        return (await import("../brain/brain.js")).think(standingFor(bot) + "\n\n" + request, { ...options, test: ctx?.test ?? true, turn: ctx?.turn });
      } });
      this.builtinEngines.set(bot.id, engine);
    }
    return engine;
  }
  async start() {
    seedTeam();
    await this.guard.state().then((s) => { this.state = s; }).catch(() => undefined);
    const host = this.options.toolboxHost === undefined ? wslHostAddress() : this.options.toolboxHost;
    if (host) {
      try {
        this.toolbox = await startToolbox({ host, port: this.options.toolboxPort ?? 3090,
          tokenFor: (id) => {
            const target = this.toolboxTarget(id);
            return target ? target.lane === "work" ? twinSecret(target.bot.id, "toolbox-token") : toolboxToken(target.bot.id) : null;
          },
          resolveAddress: (id) => { const target = this.toolboxTarget(id); return target ? { bot: target.bot.id, lane: target.lane } : null; },
          serversFor: (id) => {
            const target = this.toolboxTarget(id);
            if (!target) return [];
            return target.lane === "work" ? (target.bot.servers === "all" ? [...ALL_SERVERS] : target.bot.servers).filter((s) => s !== "computers") : target.bot.servers;
          }, level: () => this.stopped ? "killed" : this.guard.level() });
        // The address is chosen only after the listener has opened, including a random port in tests.
        this.hermesAddress = this.toolbox.baseUrl;
        this.hermesSetup.toolboxBaseUrl = this.toolbox.baseUrl;
      } catch { console.warn("The bots' toolbox could not open. The team cannot use tools yet."); }
    } else console.warn("The Linux space is off, so the bots' toolbox is off.");
    this.offTeam = installTeam({
      isActive,
      makeBot: async ({ trialOnly: _trial, card, ...input }) => {
        // The owner has approved this exact card, including any named information.
        const bot = createBot({ ...input, ...(card && !dangerousThree(card) ? { card } : {}) });
        trialOnly(bot.id, true);
        if (card && dangerousThree(card)) saveCard(bot.id, card, "owner", "Approved first job card.", { acknowledgedRisk: true });
        await this.ensure(getBot(bot.id)!);
        return getBot(bot.id)!;
      },
      activateBot: async (id) => {
        if (this.closed || this.stopped) throw new Error("The team is stopped.");
        const card = currentCard(id);
        if (card) updateBot(id, { role: card.purpose.slice(0, 500) });
        trialOnly(id, false); this.turns.live(id); this.botsChanged();
        await this.ensure(getBot(id)!);
      },
      runTrial: (input) => this.runTrial(input),
      startHandOver: (input) => this.startHandOver(input),
      askBot: (input) => {
        if (this.closed || this.stopped || !isActive(input.to)) throw new Error("That bot is not live on the team.");
        return this.turns.askBot(input);
      },
      message: (bot, text) => { if (!this.closed && !this.stopped) this.ask(bot, { text, via: "bot", from: "other-bot", who: "Team", origin: null }); },
      askOwner: async ({ bot, question, why }) => {
        this.publish({ type: "hq_question", bot, question, why });
        const lead = leadBot();
        if (lead) this.ask(lead.id, { text: `${getBot(bot)?.name ?? bot} asks: ${question}\nWhy: ${why}`, via: "bot", from: "other-bot", who: getBot(bot)?.name, origin: null });
      },
      live: (id) => { const live = this.turns.live(id); return { busy: live.state !== "idle", queued: live.queued }; },
      engineOptions: () => this.engineOptions(),
      // The model and effort travel on each request. A settings-only change needs no gateway restart.
      engineChanged: async () => { this.botsChanged(); },
      computerChanged: (id, on) => this.setComputer(id, on),
    });
    this.booted = true;
    for (const bot of this.members()) { this.turns.live(bot.id); void this.ensure(bot); }
    setTaskRunner((spec, signal) => {
      const from = spec.fromTurn ? this.turnBots.get(spec.fromTurn) : undefined;
      return this.turns.work(from?.bot ?? leadBot()!.id, spec, signal);
    });
    if (process.env.LH_V3 === "1") {
      this.offProactive = setProactiveRunner(teamProactive(this));
      this.offWeb = installWebLevel(() => this.closed || this.stopped ? "killed" : this.guard.level());
      this.offFinds = wireFinds(this, () => this.closed || this.stopped ? "killed" : this.guard.level());
    }
    return this;
  }
  private hermesAddress?: string;
  private toolboxTarget(address: string): { bot: Bot; lane: TurnLane } | null {
    const bot = getBot(address);
    if (bot) return { bot, lane: "chat" };
    const owner = listBots().find((b) => separateWork(b) && twinName(b.id) === address);
    return owner ? { bot: owner, lane: "work" } : null;
  }
  members() { return listBots().filter((bot) => isActive(bot.id)); }
  team() { return teamService(); }
  private waitForSpace(): Promise<void> {
    if (this.spaceReady) return this.spaceReady;
    const waiting = (async () => {
      let state = await this.guard.state();
      if (state.level !== "open" || this.closed || this.stopped) throw new Error("The safety switch is on.");
      if (!state.ready) await this.guard.startSpace();
      const end = Date.now() + 90_000;
      while (!state.ready) {
        if (this.closed || this.stopped || this.guard.level() !== "open") throw new Error("The safety switch is on.");
        state = await this.guard.state();
        if (state.ready) break;
        if (Date.now() >= end) throw new Error("The Linux space did not finish its start checks.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      this.state = state;
    })();
    this.spaceReady = waiting;
    void waiting.finally(() => { if (this.spaceReady === waiting) this.spaceReady = undefined; }).catch(() => undefined);
    return waiting;
  }
  ensure(bot: Bot) {
    // Older settings forms save first. Keep the job's arrangement until its work has ended.
    const working = [...this.workRuns.values()].find((r) => r.bot === bot.id);
    if (working && working.computer !== bot.computer) {
      this.pendingComputers.set(bot.id, bot.computer);
      bot = updateBot(bot.id, { computer: working.computer });
      this.botsChanged();
      this.publish({ type: "hq_computer", bot: bot.id, computer: this.computer(bot.id) });
      return Promise.resolve();
    }
    if (bot.engine !== "hermes" || this.closed || this.stopped || !this.hermesAddress) {
      if (bot.computer && !this.closed) this.computers.error(bot, "Its computer needs Hermes and the bots' toolbox to be available.");
      return Promise.resolve();
    }
    this.pendingBots.set(bot.id, bot);
    if (this.starting.has(bot.id)) return this.setups.get(bot.id)!;
    this.starting.add(bot.id);
    const setup = (async () => {
      try {
        await this.waitForSpace();
        while (this.pendingBots.has(bot.id) && !this.closed && !this.stopped) {
          const next = this.pendingBots.get(bot.id)!; this.pendingBots.delete(bot.id);
          if (getBot(bot.id)) try {
            const result = await this.hermes.ensure(next);
            const waiting = result.why === "The team's settings will take effect when every bot is quiet.";
            if (next.computer && !result.ok && !waiting && this.computers.get(next).state !== "error") { whyNot(next.id, result.why); this.computers.error(next); }
            if (next.computer && this.computers.get(next).state === "error") {
              const why = this.computers.get(next).why;
              // Remove any earlier computer tools while the switch still allows settings to be written.
              await this.hermes.ensure({ ...next, computer: false });
              this.computers.error(next, why);
            } else if (next.computer) {
              await this.computers.start(next.id);
              if (!result.ok && this.computers.get(next).state !== "ready") this.computers.error(next);
            }
          } catch (err) { whyNot(next.id, err); this.computers.error(next); }
        }
      } finally {
        this.starting.delete(bot.id);
        if (!this.closed) for (const member of this.members())
          void this.engineState(member).then((engine) => this.publish({ type: "hq_engine", bot: member.id, engine }));
      }
    })().catch((err) => { if (bot.computer) { whyNot(bot.id, err); this.computers.error(bot); } });
    this.setups.set(bot.id, setup);
    return setup;
  }
  computer(id: string) {
    const bot = getBot(id); if (!bot) throw new Error("That bot is no longer on the team.");
    const computer = this.computers.get(bot);
    return this.pendingComputers.has(id) ? { ...computer, why: "The team's settings will take effect when every bot is quiet." } : computer;
  }
  async setComputer(id: string, on: boolean) {
    if (this.guard.level() !== "open") throw new Error("The safety switch is on.");
    const bot = getBot(id); if (!bot) throw new Error("That bot is no longer on the team.");
    if (bot.engine !== "hermes") throw new Error("Choose the Hermes engine before giving this bot a computer.");
    this.pendingComputers.set(id, on);
    this.applyWaitingComputers();
    const computer = this.computer(id);
    this.publish({ type: "hq_computer", bot: id, computer });
    return computer;
  }
  private applyWaitingComputers() {
    if (this.closed || this.stopped || this.guard.level() !== "open") return;
    for (const [id, on] of this.pendingComputers) {
      const bot = getBot(id);
      if (!bot || bot.engine !== "hermes") { this.pendingComputers.delete(id); continue; }
      if ([...this.workRuns.values()].some((r) => r.bot === id) || this.pendingTurns.has(id)
        || this.busyBots.has(laneKey(id)) || this.busyBots.has(laneKey(id, "work"))
        || this.turns.live(id).state !== "idle" || this.turns.live(id).queued) continue;
      this.pendingComputers.delete(id);
      this.quietTurns.stop(id);
      this.applyComputer(bot, on);
    }
  }
  private applyComputer(bot: Bot, on: boolean) {
    const id = bot.id;
    const card = currentCard(id);
    if (card && card.computer !== on) saveCard(id, { ...card, computer: on, choice: bot.primary, fallbacks: bot.fallbacks }, "owner", "Changed its computer.", { acknowledgedRisk: true });
    const next = updateBot(id, { computer: on, servers: bot.servers });
    this.computers.begin(next);
    this.botsChanged(); this.computers.refresh([next]);
    void this.ensure(next);
  }
  seen() {
    if (Date.now() - this.seenAt < 60000 || this.closed) return;
    this.seenAt = Date.now();
    void this.guard.seen().catch(() => undefined);
  }
  attach(socket: WebSocket) { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); }
  publish(message: Record<string, unknown>) {
    for (const socket of this.sockets) if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }
  botsChanged() { this.publish({ type: "hq_bots", bots: this.members().map(publicBot) }); }
  callChanged(bot: string) { this.publish({ type: "hq_call", bot } satisfies HqCall); }
  pick(text: string, id?: string) {
    if (id !== undefined) {
      const bot = getBot(id);
      if (!bot || !isActive(id)) throw new Error("That bot is no longer on the team.");
      return { bot, text };
    }
    const match = /^\s*([^,:]+)[,:]\s*([\s\S]*)$/.exec(text);
    const named = match && this.members().find((b) => b.name.toLowerCase() === match[1].trim().toLowerCase());
    return { bot: named || leadBot()!, text: named ? match![2] : text };
  }
  switchCall(text: string): Bot | undefined {
    const name = /^\s*let me talk to\s+(.+?)[.!?]?\s*$/i.exec(text)?.[1];
    if (name) return this.members().find((b) => b.name.toLowerCase() === name.toLowerCase());
    return this.members().find((b) => {
      const start = text.trimStart().slice(0, b.name.length);
      return start.toLowerCase() === b.name.toLowerCase() && /^[\s,:]/.test(text.trimStart().slice(b.name.length));
    });
  }
  background(bot: string, text: string, title = "Scheduled work") {
    return this.managedTurn(bot, { text, via: "routine", background: true, origin: { kind: "routine" } }, { job: randomUUID(), background: true, title }).done;
  }
  async room(bot: string, ask: Ask, signal?: AbortSignal) {
    if (signal?.aborted) return { ok: false, text: "Stopped.", spoken: "Stopped.", failed: "stopped" as const };
    return this.managedTurn(bot, ask, { signal }).done;
  }
  ask(bot: string, ask: Ask) {
    if (this.stopped || this.closed) throw new Error("The team is stopped. Restart the server after checking the safety switch.");
    if (!ask.background && ask.via !== "routine" && ask.via !== "bot" && ask.from !== "system" && ask.from !== "other-bot") this.seen();
    if (!isActive(bot)) throw new Error("That bot is still waiting for its trials to pass.");
    const queued = this.turns.ask(bot, ask);
    if (ask.test) this.keepTest(bot, queued.job_id);
    return queued;
  }
  private keepTest(bot: string, job: string) {
    this.testJobs.set(job, { bot, generation: getBot(bot)!.generation, until: Infinity });
  }
  testRows(bot: string, job: string) {
    const test = this.testJobs.get(job);
    if (!test || (test.owner ?? test.bot) !== bot || Date.now() >= test.until) return [];
    return rowsOf(test.bot, test.generation, { test: true, scope: job }).map((row) => ({ ...row, bot, generation: test.shownGeneration ?? row.generation }));
  }
  private managedTurn(bot: string, ask: Ask, managed: ManagedTurn = {}) {
    if (this.closed || this.stopped || this.guard.level() !== "open") throw new Error("The safety switch has stopped this job.");
    let job = "";
    const done = new Promise<TurnResult>((resolve) => {
      const queued = this.turns.ask(bot, { ...ask, onDone: resolve });
      job = queued.job_id;
      this.managed.set(job, { ...managed, bot, text: ask.text, test: ask.test });
      if (ask.test) this.keepTest(bot, job);
    });
    return { job, done };
  }
  private async runTrial(input: { bot: string; card: JobCard; trial: JobCard["trials"][number]; test: true }): Promise<TrialResult> {
    const started = Date.now();
    const ownerBot = getBot(input.bot);
    if (!ownerBot) throw new Error("That bot is no longer on the team.");
    let bot = ownerBot;
    let preview = false;
    const same = (card: JobCard | null) => card && JSON.stringify({ ...card, version: 1 }) === JSON.stringify({ ...input.card, version: 1 });
    // A changed card is tried with its own tools and information, without changing the live bot.
    if (!same(currentCard(bot.id)) || JSON.stringify(bot.primary) !== JSON.stringify(input.card.choice) || JSON.stringify(bot.fallbacks) !== JSON.stringify(input.card.fallbacks)) {
      const id = `try-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      bot = createBot({ id, name: ownerBot.name, role: input.card.purpose, primary: input.card.choice, fallbacks: input.card.fallbacks,
        servers: [...new Set([...input.card.servers, "team"])], computer: input.card.computer,
        ...(!dangerousThree(input.card) ? { card: input.card } : {}) });
      trialOnly(bot.id, true); preview = true;
      if (dangerousThree(input.card)) saveCard(bot.id, input.card, "owner", "Trial of an approved card.", { acknowledgedRisk: true });
    }
    try {
      await this.ensure(bot);
      let usage = 0;
      const tools = new Set<string>();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5 * 60_000);
      try {
        const turn = this.managedTurn(bot.id, { text: input.trial.ask, test: true, origin: null, via: "bot", from: "system" }, {
          signal: controller.signal,
          event: (e) => {
            if (e.type === "usage") { usage += e.input + e.output; if (usage >= 1_500_000) controller.abort(); } // a trial is one short job; see the note on tokenLimit
            if (e.type === "tool" && e.phase === "start") tools.add(ourToolName(e.name));
          },
        });
        const result = await turn.done;
        const kept = this.testJobs.get(turn.job);
        if (kept) { kept.owner = input.bot; kept.shownGeneration = ownerBot.generation; }
        return { ok: result.ok, answer: result.text, usage, ms: Date.now() - started, tools: [...tools], job: turn.job };
      } finally { clearTimeout(timer); }
    } finally {
      if (preview) { await this.hermes.remove(bot); removeBot(bot.id); }
    }
  }
  private async startHandOver(input: HandOverRun) {
    const brief = JSON.stringify(input.brief, null, 2);
    let usage = 0;
    const turn = this.managedTurn(input.to, { text: brief, via: "bot", from: "other-bot", who: getBot(input.from)?.name ?? input.from, origin: null }, {
      job: input.job, signal: input.signal, brief, given_items: input.given_items,
      event: (event) => { if (event.type === "usage") { usage += event.input + event.output; input.progress(usage); } },
    });
    await turn.done;
  }
  async engineOptions() {
    const response = await fetch((this.options.hermes?.teamGatewayUrl ?? "http://127.0.0.1:8650") + "/api/model/options", {
      headers: { Authorization: `Bearer ${teamGatewayKey()}` }, redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("The team's known models could not be read. Try again when the engine is running.");
    return readEngineOptions(await response.json());
  }
  async answer(text: string, o: { bot?: string; via: Ask["via"]; origin: Origin; test?: boolean; request?: string; signal?: AbortSignal; onProgress?: (label: string, tool?: string) => void; onSpoken?: (text: string) => void }) {
    const picked = this.pick(text, o.bot);
    if (o.signal?.aborted) return { ok: false, text: "Stopped.", spoken: "Stopped.", failed: "stopped" as const };
    let jobId: string | undefined;
    const row = (r: import("./contract.js").Row) => {
      if (r.bot !== picked.bot.id || this.pendingTurns.get(r.bot)?.job_id !== jobId) return;
      if (r.body.kind === "step" && r.body.state === "running") o.onProgress?.(r.body.label, r.body.tool);
    };
    const live = (l: import("./contract.js").Live) => { if (l.bot === picked.bot.id && this.pendingTurns.get(l.bot)?.job_id === jobId && l.doing) o.onProgress?.(l.doing); };
    this.turns.on("row", row); this.turns.on("live", live);
    const stop = () => {
      if (jobId) this.cancelled.add(jobId);
      if (this.pendingTurns.get(picked.bot.id)?.job_id === jobId) this.turns.stopChat(picked.bot.id);
    };
    o.signal?.addEventListener("abort", stop, { once: true });
    try {
      const result = await new Promise<TurnResult>((resolve) => {
        const queued = this.ask(picked.bot.id, { text: picked.text, via: o.via, origin: o.origin, test: o.test, onDone: resolve });
        jobId = queued.job_id;
        if (o.request) this.requestContext.set(jobId, o.request);
      });
      o.onSpoken?.(result.spoken);
      return result;
    } finally {
      this.turns.off("row", row); this.turns.off("live", live); o.signal?.removeEventListener("abort", stop);
    }
  }
  fresh(id: string) { this.turns.stop(id); const bot = newConversation(id); this.botsChanged(); return publicBot(bot); }
  stopBot(id: string) {
    this.turns.stop(id);
    for (const run of this.workRuns.values()) if (run.bot === id) run.controller.abort();
  }
  async snapshot() {
    await this.guard.state().then((s) => { this.state = s; }).catch(() => { this.state = undefined; });
    return { on: true as const, bots: this.members().map(publicBot), live: this.turns.liveAll().filter((l) => isActive(l.bot) && !!getBot(l.bot)), safety: safetyOf(this.state),
      guard: this.guard.guardDown() ? "down" : "up", toolbox: this.toolbox ? "up" : "off", limits: limits() };
  }
  async refreshSafety() {
    await this.guard.state().then((state) => { this.state = state; }).catch(() => { this.state = undefined; });
    if (!this.closed) this.publish({ type: "hq_safety", safety: safetyOf(this.state) });
  }
  trialState() { return { probe: this.state?.probe ?? null, toolboxAddress: this.toolbox?.baseUrl ?? null }; }
  async engineState(bot: Bot): Promise<HqEngine> {
    let signedIn: Record<string, boolean> = {};
    if (bot.engine === "hermes" && this.guard.level() === "open") signedIn = await this.hermes.signedIn().catch(() => ({}));
    const ready = await (this.options.engine ?? (bot.engine === "hermes" ? this.hermes : new BuiltinEngine({ guard: this.guard }))).ready(bot);
    const starting = bot.engine === "hermes" && this.guard.level() === "open" && this.starting.has(bot.id) && !ready.ok && ready.reason === "engine_down";
    const computer = this.computers.get(bot);
    if (bot.computer && computer.state === "error") return { status: "error", why: computer.why, version: "0.23.2", primary: bot.primary, fallbacks: bot.fallbacks, signedIn, limits: [], usage: this.turns.usage(bot.id) };
    return { status: starting ? "starting" : ready.ok ? "ready" : ready.reason === "not_signed_in" ? "not_signed_in" : ready.reason === "stopped" ? "stopped" : "error",
      why: starting ? "The team is starting. Wait a moment." : ready.why ?? "", version: bot.engine === "hermes" ? "0.23.2" : "built-in", primary: bot.primary, fallbacks: bot.fallbacks,
      signedIn, limits: limits().filter((l) => l.bot === bot.id), usage: this.turns.usage(bot.id) };
  }
  async subscriptions() {
    const subscriptions = await this.hermes.subscriptions().catch(() => ([
      { provider: "anthropic", name: "Claude", signedIn: false, limitedUntil: null },
      { provider: "openai-codex", name: "OpenAI", signedIn: false, limitedUntil: null },
    ]));
    // The models each subscription offers, read from the engine itself so the app can list them (never guessed). Kept
    // for a minute; if the engine cannot say just now, the last list stands.
    if (!this.knownModels || Date.now() - this.knownModels.at > 60_000) {
      try { this.knownModels = { at: Date.now(), value: await this.engineOptions() }; } catch { /* keep what we had */ }
    }
    const offered = (provider: string) => (this.knownModels?.value.find((o) => o.provider === provider)?.models ?? []).map((id) => ({ id, name: id }));
    return subscriptions.map((s) => ({ ...s, models: offered(s.provider), usedBy: this.members().filter((b) => [b.primary, ...b.fallbacks].some((c) => c.provider === s.provider)).map((b) => b.id) }));
  }
  private knownModels?: { at: number; value: Awaited<ReturnType<Hq["engineOptions"]>> };
  private async withBot(id: string, signal: AbortSignal, run: () => Promise<void>, context?: BotTurn, lane: TurnLane = "chat") {
    const key = laneKey(id, lane);
    while (this.busyBots.has(key) && !signal.aborted) await new Promise<void>((resolve) => {
      const wake = () => { this.changed.off("free", wake); signal.removeEventListener("abort", wake); resolve(); };
      this.changed.once("free", wake); signal.addEventListener("abort", wake, { once: true });
    });
    if (signal.aborted || !getBot(id)) return;
    this.busyBots.add(key);
    let began = false;
    try {
      const details = context ?? this.pendingTurns.get(id)!;
      const ctx = beginBotTurn(id, details, lane);
      began = true;
      ctx.given_items = details.given_items;
      ctx.turn.bot = id;
      ctx.turn.given_items = details.given_items;
      if (details.job_id) this.turnBots.set(details.job_id, { bot: id, test: details.test, given_items: details.given_items });
      await run();
    }
    finally { if (began) endBotTurn(id, lane); this.busyBots.delete(key); this.changed.emit("free"); }
  }
  private publishWork(bot: string) {
    const looking = (this.turns.live(bot).work ?? []).filter((w) => this.quietTurns.owns(bot, w.id));
    this.turns.workState(bot, [...looking, ...[...this.workRuns.values()].filter((r) => r.bot === bot).map((r) => ({
      id: r.spec.id, title: r.spec.title, state: r.started ? "working" as const : "queued" as const, doing: r.doing, since: r.since, steps: r.steps,
    }))]);
  }
  async work(botId: string, spec: TaskSpec, signal: AbortSignal = new AbortController().signal) {
    const bot = getBot(botId);
    if (!bot) throw new Error("That bot is no longer on the team.");
    if (this.workRuns.has(spec.id)) throw new Error("That piece of work is already queued.");
    if (workLane(bot) === "work") this.quietTurns.stop(botId);
    const ahead = this.workTails.get(botId);
    const from = spec.fromTurn ? this.turnBots.get(spec.fromTurn) : undefined;
    const lim = workLimits();
    // Hermes reports tokens, not money, and counts the whole standing text and every tool description again on each
    // step (about 35,000 tokens a step). The first ceiling here was 100,000 tokens, which stopped a real job after three
    // steps and 38 seconds (the owner's coffee table, given to Tim). The owner's setting is in dollars per job; one
    // dollar is taken as a million tokens, which is roughly what a subscription's mixed, mostly re-read, tokens come to.
    // That too was far too low: the owner's first real job after it (Tim counting doors across a drawing set, 19 November)
    // was cut off unfinished after six minutes at "about 6 million tokens", every one of its steps re-reading the same
    // cached text. Hermes gives no split of re-read and new tokens and a subscription has no price per token, so tokens
    // cannot stand in for money. A job's real limit is the owner's time limit (work.max_minutes); the token count is
    // only a far backstop against a runaway loop: twenty million for each dollar of his per-job setting.
    const tokenLimit = Math.max(20_000_000, Math.round(lim.usd * 20_000_000));
    // What the work puts on his screen goes into the bot's conversation as it happens, and its closing words when it ends.
    const shown = new Set<string>();
    const onItem = (event: { item: { id: string; title: string; job_id?: string | null }; turn?: { job_id: string | null } | null }) => {
      if ((event.turn?.job_id ?? event.item.job_id) !== spec.id || shown.has(event.item.id)) return;
      shown.add(event.item.id);
      this.turns.post(botId, { kind: "card", card: "item", ref: event.item.id, title: event.item.title }, { test: from?.test ?? false, scope: spec.fromTurn ?? undefined });
    };
    bus.on("item", onItem as never);
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    // A cancelled waiting job can disappear at once without letting the next one pass earlier work.
    const tail = (ahead ?? Promise.resolve()).then(() => done);
    this.workTails.set(botId, tail);
    void tail.then(() => { if (this.workTails.get(botId) === tail) this.workTails.delete(botId); });
    const run: WorkRun = { bot: botId, computer: bot.computer, spec, controller: new AbortController(), test: from?.test ?? false, messages: [], total: 0, done, started: false, doing: null, since: new Date().toISOString(), steps: 0 };
    this.workRuns.set(spec.id, run);
    const summary = db.prepare("SELECT summary FROM jobs WHERE id=?").get(spec.id) as { summary: string | null } | undefined;
    db.prepare("UPDATE jobs SET summary=? WHERE id=?").run(JSON.stringify({ ...(summary?.summary ? JSON.parse(summary.summary) : {}), bot: botId }), spec.id);
    this.publishWork(botId);
    const progress = (line: string) => { run.doing = line; workDoing(spec.id, line); this.publishWork(botId); };
    const abort = () => run.controller.abort();
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const offSteer = onSteer(spec.id, (text) => run.messages.push(text));
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let recent = "";
    const conversation = `lh-${botId}-work-${spec.id}`;
    let text = "";
    let choice = bot.primary;
    let reported = false;
    let failure: string | undefined;
    let steps = 0;
    let heldLimit: string | undefined;
    const started = Date.now();
    const tools = new Map<string, { name: string; label: string; at: number; ms: number }>();
    let workSteps: ReturnType<typeof this.turns.workSteps> | undefined;
    try {
      if (ahead) await new Promise<void>((resolve) => {
        const wake = () => { run.controller.signal.removeEventListener("abort", wake); resolve(); };
        run.controller.signal.addEventListener("abort", wake, { once: true });
        void ahead.then(wake);
        if (run.controller.signal.aborted) wake();
      });
      if (signal.aborted) return;
      if (!run.controller.signal.aborted) await this.setups.get(botId);
      if (!getBot(botId) || this.closed || this.stopped || this.guard.level() !== "open") abort();
      if (!run.controller.signal.aborted) {
        run.started = true; run.since = new Date().toISOString(); this.publishWork(botId);
        workSteps = this.turns.workSteps(botId, spec.id, spec.title, run.since, run.test);
        timer = setTimeout(() => { timedOut = true; abort(); }, lim.ms);
        startJob(spec.id, { current: false });
      }
      // Wait for the parent turn and give messages already queued by the owner first place.
      for (let step = 0; step < 250 && !run.controller.signal.aborted; step++) {
        const current = getBot(botId);
        if (!current) break;
        const lane = workLane(current);
        const base = checkedEngine(this.options.engine ?? (current.engine === "hermes" ? this.hermes : this.builtinFor(current)));
        while ((this.busyBots.has(laneKey(botId, lane)) || !separateWork(current) && ["thinking", "working", "queued"].includes(this.turns.live(botId).state) ||
          step === 0 && !!spec.fromTurn && this.pendingTurns.get(botId)?.job_id === spec.fromTurn) && !run.controller.signal.aborted)
          await new Promise((resolve) => setTimeout(resolve, 10));
        if (run.controller.signal.aborted || this.guard.level() !== "open" || this.stopped) break;
        recent = rowsOf(botId, bot.generation, run.test && spec.fromTurn ? { test: true, scope: spec.fromTurn } : {}).slice(-20)
          .map((r) => r.body.kind === "message" ? `${r.body.from}: ${r.body.text}` : "").join("\n");
        const instructions = `${recent}\n\n${WORK_GO(spec.title, spec.understood ?? spec.brief)}\n\nWork in small steps. Do one useful part now, then return. If there is more to do, end with [MORE]. Otherwise give the finished result in plain words, including the key facts.\n${run.messages.splice(0).map((s) => `The owner added: ${s}`).join("\n")}`;
        let ended = false;
        await this.withBot(botId, run.controller.signal, () => base.run(current, {
          text: step ? "Carry on with the next part, or give the result if finished." : spec.brief,
          instructions, conversation, choice: current.primary, lane,
        }, (e) => {
          const stepLabel = e.type === "tool" ? workSteps?.tool({ ...e, id: `${step}:${e.id}` }) : undefined;
          if (e.type === "tool" && e.phase === "start") {
            if (tools.has(`${step}:${e.id}`)) return;
            if (["tool_search", "tool_describe"].includes(ourToolName(e.name))) return;
            // A far backstop like the token count: a real job ran about twenty tool steps a minute, so 250 would have ended
            // a twelve-minute job. The owner's time limit is what ends a job.
            if (++steps >= 3000) { heldLimit = "I stopped at this job's step limit."; abort(); }
            run.steps = steps;
            const name = ourToolName(e.name);
            if (!name.startsWith("mcp__")) noteBuiltinTool(botId, name, lane);
            const label = stepLabel ?? (name.startsWith("mcp__") ? progressLabel(name) : name === "web_search" ? "Searching the web" : "Working on " + spec.title);
            tools.set(`${step}:${e.id}`, { name, label, at: Date.now(), ms: 0 });
            progress(label);
          }
          if (e.type === "tool" && e.phase === "end") { const tool = tools.get(`${step}:${e.id}`); if (tool) tool.ms = Date.now() - tool.at; }
          if (e.type === "status") progress(e.text);
          if (e.type === "usage") {
            choice = e.engine;
            // Token totals come from Hermes. The subscription has no dollar price per token.
            run.total += e.input + e.output;
            if (!run.test) addUsage(botId, e.engine.provider, e.input, e.output, new Date());
            if (run.total >= tokenLimit) { heldLimit = `I stopped at this job's usage limit (about ${Math.round(tokenLimit / 1_000_000)} million tokens).`; abort(); }
          }
          if (e.type === "done") { text = e.text; choice = e.engine; ended = true; }
          if (e.type === "failed") {
            failure = e.reason === "limit" ? limitSentence({ resets: e.resetsAt ?? null }).replace("Claude plan", `${current.primary.provider === "anthropic" ? "Claude" : "OpenAI"} plan`) : e.reason === "not_signed_in" ? "Sign in to this bot's subscription on the PC before asking it to work." : e.message || "The work could not finish.";
            ended = true;
          }
        }, run.controller.signal), { job_id: spec.id, origin: spec.open ? spec.origin : null, test: run.test, background: true, given_items: from?.given_items, note: progress }, lane);
        if (failure || !ended || !text.endsWith("[MORE]")) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (signal.aborted) return;
      if (heldLimit) failure = heldLimit + " " + text.replace(/\[MORE\]$/, "");
      else if (timedOut) failure = "I stopped at this job's time limit. " + text.replace(/\[MORE\]$/, "");
      else if (run.controller.signal.aborted || this.guard.level() !== "open" || this.stopped) failure = this.guard.level() !== "open" || this.stopped ? "Stopped by the safety switch." : "Stopped.";
      else if (text.endsWith("[MORE]")) failure ??= "I stopped at this job's step limit. " + text.replace(/\[MORE\]$/, "");
      const spoken = failure ?? (saidPart(text) || "The work ended without an answer.");
      const limit = heldLimit ? heldLimit.includes("usage") ? "usage" : "steps" : timedOut ? "time" : text.endsWith("[MORE]") ? "steps" : undefined;
      const saved = db.prepare("SELECT summary FROM jobs WHERE id=?").get(spec.id) as { summary: string | null } | undefined;
      db.prepare("UPDATE jobs SET summary=?, result=? WHERE id=?").run(JSON.stringify({ ...(saved?.summary ? JSON.parse(saved.summary) : {}),
        bot: botId, tools: [...tools.values()].map(({ at: _at, ...tool }) => tool), ms: Date.now() - started,
        model: choice.model, tokens: run.total, ...(limit ? { limit } : {}) }), JSON.stringify({ spoken, ...(limit ? { limit } : {}) }), spec.id);
      if (failure && !limit) failJob(spec.id, spoken); else finishJob(spec.id, { spoken, ...(limit ? { limit } : {}) });
      workSteps?.finish(!failure);
      bus.off("item", onItem as never);
      if (failure) {
        const end = spoken.search(/(?<=[.!?])\s/);
        const reason = end < 0 ? spoken : spoken.slice(0, end);
        const rest = end < 0 ? "" : spoken.slice(end).trim();
        this.turns.post(botId, { kind: "notice", tone: "info", text: `${spec.title}: ${reason}` }, { test: run.test, scope: spec.fromTurn ?? undefined });
        if (rest) this.turns.post(botId, { kind: "message", from: "bot", text: rest, engine: choice }, { test: run.test, scope: spec.fromTurn ?? undefined });
      }
      else this.turns.post(botId, { kind: "message", from: "bot", text: spoken, engine: choice }, { test: run.test, scope: spec.fromTurn ?? undefined });
      reported = true;
      if (!run.test) {
        queueNotification({ title: spec.title, spoken, priority: "normal", source: `task:${spec.id}` });
        await deliverDue(new Date());
      }
    } catch {
      if (!signal.aborted && !reported) {
        const spoken = "I couldn't finish that work. Something went wrong on my side. Ask me again and I'll pick it up.";
        failJob(spec.id, spoken);
        this.turns.post(botId, { kind: "notice", tone: "warn", text: `${spec.title}: ${spoken}` }, { test: run.test, scope: spec.fromTurn ?? undefined });
        if (!run.test) { queueNotification({ title: spec.title, spoken, priority: "normal", source: `task:${spec.id}` }); await deliverDue(new Date()); }
      }
    } finally {
      workSteps?.finish(false);
      bus.off("item", onItem as never);
      clearTimeout(timer); offSteer(); signal.removeEventListener("abort", abort);
      this.workRuns.delete(spec.id);
      this.publishWork(botId);
      finished();
      this.applyWaitingComputers();
    }
  }
  async emergencyStop() {
    this.stopped = true;
    await this.offFinds?.();
    this.screens?.close();
    for (const stop of this.engineStops) stop.abort();
    try { this.turns.stopAll(); } catch { /* The toolbox still closes if the turn queue has broken. */ }
    for (const run of this.workRuns.values()) run.controller.abort();
    const toolbox = this.toolbox; this.toolbox = undefined;
    if (toolbox) { toolbox.server.closeAllConnections(); await toolbox.close().catch(() => undefined); }
  }
  async close() {
    this.offLooks();
    this.closed = true; this.offGuard(); this.offTeam?.(); this.offProactive?.();
    await this.emergencyStop();
    this.offWeb?.();
    this.guard.close();
    await this.turns.close();
    await Promise.all([...this.workRuns.values()].map((run) => run.done));
    for (const test of this.testJobs.values()) clearTimeout(test.timer);
    this.testJobs.clear();
    this.sockets.clear();
  }
}
let active: Promise<Hq> | undefined;
export function startHq(options: HqOptions = {}) {
  if (!active) {
    const hq = new Hq(options);
    active = hq.start().catch(async (error) => { await hq.close(); active = undefined; throw error; });
  }
  return active;
}
export async function stopHq() { const current = active; active = undefined; if (current) await (await current).close(); }
