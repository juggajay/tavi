import { EventEmitter } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { screenPorts, fenceInput, type ScreenPorts } from "./fence.js";
import { ScreenSecrets } from "./screenSecrets.js";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Store } from "./store.js";
import { linuxUser, profileId, GuardError, scripts, type Handle, type Runner, type Session } from "./runner.js";

export const levels = ["open", "paused", "walled", "killed"] as const;
export type Level = typeof levels[number];
export type Who = "local" | "relay";
type Saved = { level: Level; since: string; until: string | null; cameFrom: Level | null; reason: string; by: string };
type Proc = { user: string; kind: string; state: "running" | "stopped" | "waiting" | "failed"; pid: number | null; startedAt: string | null; restarts: number; lines: string[]; handle?: Handle; cancel?: () => void; wanted: boolean };
export type Clock = { now(): number; later(fn: () => void, ms: number): () => void };
const realClock: Clock = { now: Date.now, later(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer); } };
const kinds: Record<string, { script: string; stop: string }> = {
  gateway: { script: scripts.gateway, stop: scripts.stop },
  screen: { script: scripts.screen, stop: scripts.stopScreen },
  browser: { script: scripts.browser, stop: scripts.stopBrowser },
};
const backoff = [2000, 5000, 15000, 60000];

export class Guard extends EventEmitter {
  readonly store: Store;
  saved: Saved;
  ready = false;
  probeResult: { ok: boolean; at: string | null; failed: string[] } = { ok: false, at: null, failed: [] };
  readonly processes = new Map<string, Proc>();
  readonly sessions = new Map<string, Session>();
  readonly bots = new Set<string>();
  readonly ports = new Map<string, ScreenPorts>();
  private fenced = false;
  private fenceManaged = false;
  private fenceQueue: Promise<unknown> = Promise.resolve();
  private fenceApplyQueue: Promise<unknown> = Promise.resolve();
  private version = 0;
  private clock: Clock;
  private cancelTick?: () => void;
  private untilCancel?: () => void;
  private seen: number;
  private deadmanHours = 0;
  private closing = false;
  private starting = new Set<string>();
  private signing = new Set<string>();
  private processVersions = new Map<string, number>();
  private stopping = false;
  private initialized = false;
  private pinQueue: Promise<unknown> = Promise.resolve();
  constructor(readonly runner: Runner, private options: { data?: string; clock?: Clock; secrets?: { get(name: string): string | undefined; put(name: string, value: string): void } } = {}) {
    super();
    this.clock = options.clock ?? realClock;
    this.store = new Store(options.data);
    this.seen = this.clock.now();
    this.saved = { level: "open", since: this.iso(), until: null, cameFrom: null, reason: "First start. The Linux space stays stopped.", by: "guard" };
    try {
      const saved = this.store.read("state.json") as Saved | undefined;
      if (saved !== undefined) {
        this.fenceManaged = true;
        if (!saved || !levels.includes(saved.level) || !Number.isFinite(Date.parse(saved.since)) || typeof saved.reason !== "string" || typeof saved.by !== "string" ||
          (saved.until !== null && (typeof saved.until !== "string" || !Number.isFinite(Date.parse(saved.until)))) ||
          (saved.cameFrom !== null && !levels.includes(saved.cameFrom)) ||
          (saved.until !== null && (!(saved.level === "paused" || saved.level === "walled") || saved.cameFrom === null || levels.indexOf(saved.cameFrom) >= levels.indexOf(saved.level)))) throw new Error();
        this.saved = saved;
      }
    } catch { this.saved = { ...this.saved, level: "walled", reason: "The saved safety level is damaged or cannot be read. The bots are walled off." }; }
    if (this.store.pinBroken && this.saved.level === "open") this.saved = { ...this.saved, level: "walled", reason: "The saved PIN cannot be read. The bots are walled off." };
    try {
      const settings = this.store.read("settings.json") as { deadmanHours?: number } | undefined;
      if (settings?.deadmanHours !== undefined) {
        if (!Number.isFinite(settings.deadmanHours) || settings.deadmanHours < 0) throw new Error();
        this.deadmanHours = settings.deadmanHours;
      }
    } catch { this.saved = { ...this.saved, level: this.saved.level === "killed" ? "killed" : "walled", until: null, cameFrom: null, reason: "The guard settings cannot be read. The bots must stay shut down." }; }
    try {
      const saved = this.store.read("screen-ports.json");
      if (saved !== undefined) {
        if (!Array.isArray(saved)) throw new Error();
        for (const p of saved) {
          const port = screenPorts(p.user, p);
          if (this.ports.has(port.user) || [...this.ports.values()].some((b) => b.display === port.display)) throw new Error();
          this.ports.set(port.user, port);
        }
      }
    } catch { this.saved = { ...this.saved, level: this.saved.level === "killed" ? "killed" : "walled", until: null, cameFrom: null,
      reason: "The saved screen numbers cannot be read. The bots must stay shut down." }; }
  }
  private iso() { return new Date(this.clock.now()).toISOString(); }
  audit(event: string, by: string, detail: string) { this.store.audit(event, by, detail); }
  private persist() { this.store.save("state.json", this.saved); }
  private announce(event: string, detail: unknown) { this.emit("change", { event, detail }); }
  async init() {
    // A missing state file never grants permission to keep old processes running.
    if (this.saved.level === "open" && !existsSync(path.join(this.store.dir, "state.json"))) {
      const stopped = await this.step("stop the Linux space on first start", () => this.terminate());
      if (!stopped && this.saved.level === "open") {
        this.saved = { ...this.saved, level: "walled", reason: "Could not confirm the Linux space was stopped on first start. The bots are walled off." };
        this.version++;
      }
    }
    await this.enforce(this.saved.level, this.version);
    this.persist(); this.initialized = true; this.armUntil(); this.armTick();
    return this;
  }
  private armTick() { this.cancelTick = this.clock.later(() => { void this.tick().catch(() => {}).finally(() => { if (!this.closing) this.armTick(); }); }, 1000); }
  async tick() {
    if (this.deadmanHours > 0 && this.saved.level === "open" && this.clock.now() - this.seen >= this.deadmanHours * 3600_000) {
      await this.changeLevel({ level: "paused", reason: "no word from the owner", by: "guard" }, "local", true);
    }
  }
  markSeen() { this.seen = this.clock.now(); }
  private armUntil() {
    this.untilCancel?.(); this.untilCancel = undefined;
    if (!this.saved.until || !this.saved.cameFrom || this.saved.level === "killed") return;
    const version = this.version, target = this.saved.cameFrom;
    this.untilCancel = this.clock.later(() => {
      if (version !== this.version || this.closing) return;
      if (this.saved.until && this.clock.now() < Date.parse(this.saved.until)) { this.armUntil(); return; }
      void this.changeLevel({ level: target, reason: "The set time has ended.", by: "timer" }, "local", true).catch(() => {});
    }, Math.min(2_147_000_000, Math.max(0, Date.parse(this.saved.until) - this.clock.now())));
  }
  assertOpen(version = this.version) {
    if (!this.initialized || this.closing || this.stopping || this.saved.level !== "open" || version !== this.version) throw new GuardError(409, "The guard must be ready and its safety switch open before starting the Linux space or doing work in it.");
  }
  private async command(user: string, script: string, args: string[] = [], stdin?: string, timeoutMs?: number) {
    const result = await this.runner.run(user, script, { args, stdin, timeoutMs });
    if (result.code !== 0) throw new GuardError(503, "A step in the Linux space could not be completed.");
    return result;
  }
  private async step(name: string, fn: () => Promise<unknown>): Promise<boolean> {
    try { await fn(); return true; }
    catch { try { this.audit("step-failed", "guard", `Could not ${name}.`); } catch {} return false; }
  }
  private async checked(user: string, script: string, args: string[] = [], stdin?: string) {
    const version = this.version; this.assertOpen(version);
    const result = await this.command(user, script, args, stdin);
    if (version !== this.version || this.saved.level !== "open" || this.stopping) {
      // A command that was already on its way must not undo a safety raise.
      if (this.saved.level === "open") await this.step("finish stopping the Linux space", () => this.terminate());
      else await this.enforce(this.saved.level, this.version);
      this.assertOpen(version);
    }
    return result;
  }
  private onePin<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.pinQueue.then(fn); this.pinQueue = pending.catch(() => {}); return pending;
  }
  async setPin(pin: unknown, old: unknown, who: Who) {
    if (who !== "local") throw new GuardError(403, "Only this PC can change the PIN.");
    return this.onePin(() => this.store.setPin(pin, old, this.clock.now()));
  }
  async changeLevel(body: { level: unknown; reason?: unknown; by?: unknown; minutes?: unknown; pin?: unknown }, who: Who, timed = false) {
    if (!levels.includes(body.level as Level)) throw new GuardError(400, "Choose open, paused, walled or killed.");
    if (typeof body.pin === "string") this.store.hide(body.pin);
    const target = body.level as Level, old = this.saved.level, version = this.version;
    const raising = levels.indexOf(target) > levels.indexOf(old);
    if (body.minutes !== undefined && (!raising || !(target === "paused" || target === "walled") || typeof body.minutes !== "number" || !Number.isFinite(body.minutes) || body.minutes <= 0 || body.minutes > 525600)) throw new GuardError(400, "A pause or wall can have a time from above zero to one year, in minutes.");
    if (!raising && target !== old && !timed) {
      if ((old === "killed" || (!this.store.pin && !this.store.pinBroken)) && who !== "local") throw new GuardError(403, "Use the safety switch on this PC to lower this level.");
      await this.onePin(() => this.store.checkPin(body.pin, this.clock.now()));
      if (version !== this.version) throw new GuardError(409, "The safety level changed. Check it before trying again.");
    }
    if (target === old) return this.saved;
    this.version++;
    this.saved = { level: target, since: this.iso(), until: body.minutes ? new Date(this.clock.now() + (body.minutes as number) * 60_000).toISOString() : null,
      cameFrom: body.minutes ? old : null, reason: this.store.clean(typeof body.reason === "string" ? body.reason.slice(0, 1000) : "The safety switch was used."), by: this.store.clean(typeof body.by === "string" ? body.by.slice(0, 100) : who) };
    const changed = this.saved;
    this.untilCancel?.();
    if (target !== "open") this.ready = false;
    // Save before touching WSL, so a crash cannot quietly undo a raise.
    await this.step("save the safety level", async () => this.persist());
    await this.step("record the safety change", async () => this.audit("level", changed.by, `${old} to ${target}: ${changed.reason}`));
    this.announce("level", { ...changed });
    await this.enforce(target, version + 1);
    this.armUntil();
    return this.saved;
  }
  private async enforce(level: Level, version: number) {
    if (version !== this.version) return;
    if (level === "open") {
      if (await this.runner.spaceState().catch(() => "stopped") === "running" && version === this.version) {
        const thawed = await this.step("continue the bots", () => this.command("root", scripts.freeze, ["continue"]));
        const opened = version === this.version ? await this.step("open the toolbox route", () => this.command("root", scripts.route, ["open"])) : false;
        if (version !== this.version) await this.enforce(this.saved.level, this.version);
        else if (!thawed || !opened) await this.changeLevel({ level: "walled", by: "guard", reason: "Could not safely reopen the Linux space." }, "local");
      }
      if (version === this.version) for (const proc of this.processes.values()) {
        if (proc.wanted && !proc.handle) { proc.cancel?.(); proc.cancel = this.clock.later(() => { void this.restart(proc); }, 0); }
      }
      return;
    }
    // Paused sign-ins keep their place, just like the gateway. Higher levels end them.
    if (level !== "paused") for (const session of this.sessions.values()) if (!session.ended) this.endSignIn(session);
    const steps: [string, () => Promise<unknown>][] = level === "paused" ? [
      ["freeze the bots", () => this.command("root", scripts.freeze, ["stop"])],
      ["close the toolbox route", () => this.command("root", scripts.route, ["close"])],
    ] : level === "walled" ? [
      ["stop the bots", () => this.stopAll()],
      ["close the toolbox route", () => this.command("root", scripts.route, ["close"])],
      ["shut down the Linux space", () => this.terminate()],
    ] : [
      ["close the toolbox route", () => this.command("root", scripts.route, ["close"])],
      ["freeze the bots", () => this.command("root", scripts.freeze, ["stop"])],
      ["keep the evidence", () => this.evidence()],
      ["withdraw sign-ins", async () => {
        const withdrawn = await this.step("withdraw sign-ins; sign-ins were NOT withdrawn", () => this.command("root", scripts.withdraw));
        this.audit("withdraw", "guard", withdrawn ? "Sign-ins withdrawn." : "Sign-ins were NOT withdrawn.");
      }],
      ["stop the bots", () => this.stopAll()],
      ["shut down the Linux space", () => this.terminate()],
    ];
    for (const [name, action] of steps) {
      if (version !== this.version) return;
      await this.step(name, action);
      if (version !== this.version) { await this.enforce(this.saved.level, this.version); return; }
    }
  }
  async terminate() {
    this.fenced = false;
    this.ready = false;
    try { await this.runner.terminate(); }
    catch (error) { this.announce("space", { space: await this.runner.spaceState().catch(() => "missing"), ready: false }); throw error; }
    this.announce("space", { space: "stopped", ready: false });
  }
  async withdrawSignIns() { await this.command("root", scripts.withdraw); }
  async freeze(on: boolean) {
    if (!on && this.saved.level !== "open") throw new GuardError(409, "Open the safety switch before continuing the bots.");
    await this.command("root", scripts.freeze, [on ? "stop" : "continue"]);
  }
  async toolboxRoute(open: boolean) {
    if (open && this.saved.level !== "open") throw new GuardError(409, "Open the safety switch before opening the toolbox route.");
    await this.command("root", scripts.route, [open ? "open" : "close"]);
  }
  async stopSpace() {
    this.version++; this.stopping = true;
    try {
      await this.step("stop the bots", () => this.stopAll());
      await this.step("shut down the Linux space", () => this.terminate());
    } finally { this.stopping = false; this.armUntil(); }
  }
  async startSpace() { this.assertOpen(); return this.probe(); }
  async probe() {
    this.assertOpen(); this.ready = false;
    try {
      await this.checked("root", scripts.boot);
      await this.checked("root", scripts.route, ["open"]);
      await this.checked("root", scripts.makeTeam);
      await this.checked("root", scripts.make, ["bot-probe"]);
      if (this.fenceManaged) await this.applyFence();
    } catch (error) {
      if (this.saved.level !== "open") throw error;
      this.probeResult = { ok: false, at: this.iso(), failed: ["The Linux space could not complete its start checks."] };
      this.audit("probe", "guard", "The start checks failed."); this.announce("probe", this.probeResult);
      await this.changeLevel({ level: "walled", by: "guard", reason: "The Linux space could not complete its start checks." }, "local");
      throw new GuardError(409, "The start checks failed. The bots are walled off.", this.probeResult.failed);
    }
    this.bots.add("bot-probe");
    const version = this.version;
    let lines: string[], ok: boolean;
    try {
      const r = await this.runner.run("bot-probe", scripts.probe, { timeoutMs: 120_000 });
      lines = (r.out + "\n" + r.err).split(/\r?\n/).filter(Boolean).map((line) => this.store.clean(line));
      ok = r.code === 0 && lines.some((line) => /^ok\s/.test(line)) && !lines.some((line) => /^FAIL\b/.test(line));
    } catch { ok = false; lines = ["The lock-down check could not run."]; }
    this.assertOpen(version);
    this.probeResult = { ok, at: this.iso(), failed: ok ? [] : lines.filter((line) => !/^ok\s|^info\s/.test(line)) };
    if (!ok && !this.probeResult.failed.length) this.probeResult.failed = ["The lock-down check did not pass."];
    this.audit("probe", "guard", ok ? "The lock-down check passed." : "The lock-down check failed.");
    this.announce("probe", this.probeResult); this.ready = ok;
    this.announce("space", { space: "running", ready: ok });
    if (!ok) {
      await this.changeLevel({ level: "walled", reason: "The lock-down check failed.", by: "guard" }, "local");
      throw new GuardError(409, "The lock-down check failed. The bots are walled off.", this.probeResult.failed);
    }
    return { ok, lines };
  }
  async makeTeam() {
    await this.checked("root", scripts.makeTeam);
    return { home: "/srv/lh/team" };
  }
  async makeBot(id: unknown) {
    profileId(id); this.assertOpen();
    await this.makeTeam();
    await this.checked("lh-team", scripts.makeProfile, [id]);
    return { home: `/srv/lh/team/profiles/${id}` };
  }
  fenceState(user: unknown) {
    const port = typeof user === "string" ? this.ports.get(user) : undefined;
    return { applied: this.fenced && this.saved.level === "open" && !!port, ports: port ?? null };
  }
  async setPorts(user: unknown, value: unknown) {
    const port = screenPorts(user, value);
    const work = this.fenceQueue.then(async () => {
      this.assertOpen();
      const previous = this.ports.get(port.user);
      if (previous && JSON.stringify(previous) !== JSON.stringify(port)) throw new GuardError(409, "A bot's screen numbers stay fixed.");
      if ([...this.ports.values()].some((b) => b.user !== port.user && b.display === port.display)) throw new GuardError(409, "That screen number already belongs to another bot.");
      this.fenced = false;
      this.fenceManaged = true;
      this.ports.set(port.user, port);
      this.store.save("screen-ports.json", [...this.ports.values()]);
      try {
        await this.checked("root", scripts.make, [port.user]);
        await this.probe();
      } catch {
        this.fenced = false;
        if (this.saved.level === "open") await this.changeLevel({ level: "walled", by: "guard", reason: "The checks between bots failed." }, "local");
        throw new GuardError(409, "The checks between bots failed. The bots are walled off.");
      }
      return this.fenceState(port.user);
    });
    this.fenceQueue = work.catch(() => {}); return work;
  }
  async dropPorts(user: unknown) {
    if (typeof user !== "string" || !/^bot-[a-z0-9][a-z0-9-]{0,24}$/.test(user)) throw new GuardError(400, "Choose a bot's computer.");
    const work = this.fenceQueue.then(async () => {
      this.assertOpen();
      if (!this.ports.has(user)) return;
      await this.stopProcess(user, "screen");
      this.fenced = false; this.ports.delete(user);
      this.store.save("screen-ports.json", [...this.ports.values()]);
      try { await this.probe(); }
      catch {
        if (this.saved.level === "open") await this.changeLevel({ level: "walled", reason: "The checks between bots failed.", by: "guard" }, "local");
        throw new GuardError(409, "The checks between bots failed. The bots are walled off.");
      }
    });
    this.fenceQueue = work.catch(() => {}); return work;
  }
  private async applyFence() {
    const work = this.fenceApplyQueue.then(async () => {
      this.fenced = false;
      await this.checked("root", scripts.screenBoot);
      await this.checked("root", scripts.fence, [], fenceInput([...this.ports.values()]));
      await this.checked("root", scripts.screenProbe);
      this.fenced = true;
    });
    this.fenceApplyQueue = work.catch(() => {}); return work;
  }
  async prepareScreen(user: unknown, value: { wallpaper?: unknown; home?: unknown }) {
    if (typeof user !== "string" || !this.fenceState(user).applied) throw new GuardError(409, "The checks between bots must pass first.");
    if (typeof value.wallpaper !== "string" || typeof value.home !== "string" || value.wallpaper.length > 32768 || value.home.length > 32768) throw new GuardError(400, "Send the screen picture and home page.");
    const key = `bot:${user.slice(4)}:vnc`;
    const secrets = this.options.secrets ?? new ScreenSecrets(this.store.dir);
    let password = secrets.get(key);
    if (!password) { password = randomBytes(6).toString("base64"); secrets.put(key, password); }
    if (!/^[A-Za-z0-9+/]{8}$/.test(password)) throw new GuardError(503, "The screen's saved access key cannot be read.");
    this.store.hide(password);
    await this.checked("root", scripts.screenPrepare, [user], JSON.stringify({ password, wallpaper: value.wallpaper, home: value.home }));
    await this.checked("root", scripts.screenKeyProbe, [user]);
    this.audit("screen-ready", "guard", user);
  }
  getScreenPassword(user: unknown): string {
    this.assertOpen();
    if (typeof user !== "string" || !this.fenceState(user).applied) throw new GuardError(409, "The checks between bots must pass first.");
    const value = (this.options.secrets ?? new ScreenSecrets(this.store.dir)).get(`bot:${user.slice(4)}:vnc`);
    if (!value) throw new GuardError(409, "The screen has no saved access key.");
    this.store.hide(value); return value;
  }
  private checkFile(name: unknown, content: unknown, team = false): asserts name is string {
    if (typeof name !== "string" || !(team ? ["config.yaml", ".env"] : ["config.yaml", ".env", "SOUL.md"]).includes(name)) throw new GuardError(400, "That file cannot be written here.");
    if (typeof content !== "string" || Buffer.byteLength(content) > 256 * 1024) throw new GuardError(400, "The file must be text, no more than 256 KB.");
    this.store.hide(content);
  }
  async writeTeamFile(name: unknown, content: unknown) {
    this.checkFile(name, content, true);
    await this.makeTeam();
    await this.checked("lh-team", scripts.write, ["", name], content as string);
  }
  async writeBotFile(id: unknown, name: unknown, content: unknown) {
    profileId(id); this.checkFile(name, content);
    await this.makeBot(id);
    await this.checked("lh-team", scripts.write, [id, name], content as string);
  }
  async readBotFile(id: unknown, name: unknown) {
    profileId(id);
    if (typeof name !== "string" || !["config.yaml", "SOUL.md"].includes(name)) throw new GuardError(400, "Only config.yaml and SOUL.md can be read here.");
    const result = await this.checked("lh-team", scripts.read, [id, name]); this.store.hide(result.out); return { content: result.out };
  }
  private processKey(user: unknown, kind: unknown) {
    if (typeof kind !== "string" || !Object.hasOwn(kinds, kind)) throw new GuardError(400, "Choose the gateway process.");
    if (kind === "gateway") { if (user !== "lh-team") throw new GuardError(400, "The gateway belongs to the whole team."); }
    else if (typeof user !== "string" || !this.ports.has(user)) throw new GuardError(400, "Set up this bot's screen numbers first.");
    return `${user}-${kind}`;
  }
  async startProcess(user: unknown, kind: unknown) {
    const key = this.processKey(user, kind); this.assertOpen();
    if (this.starting.has(key)) throw new GuardError(409, "That process is already starting.");
    const previous = this.processes.get(key);
    if (previous?.wanted) return this.procView(previous);
    this.starting.add(key);
    const version = this.version;
    const processVersion = this.processVersions.get(key) ?? 0;
    try {
      // Recheck every start: WSL may have been stopped and restarted outside the guard.
      await this.probe(); this.assertOpen(version);
      if (kind === "browser" && !this.processes.get(`${user}-screen`)?.handle) throw new GuardError(409, "Start the screen before its browser.");
      if ((this.processVersions.get(key) ?? 0) !== processVersion) throw new GuardError(409, "That process was stopped while it was starting.");
      const proc: Proc = { user: user as string, kind: kind as string, state: "stopped", pid: null, startedAt: null, restarts: 0, lines: previous?.lines ?? [], wanted: true };
      this.processes.set(key, proc); this.bots.add(proc.user); this.launch(proc); return this.procView(proc);
    } finally { this.starting.delete(key); }
  }
  private launch(proc: Proc) {
    this.assertOpen();
    let handle: Handle;
    const p = this.ports.get(proc.user);
    const args = proc.kind === "screen" && p ? [p.display, p.vncPort, p.width, p.height].map(String) : proc.kind === "browser" && p ? [p.display, p.cdpPort].map(String) : [];
    if (proc.kind !== "gateway" && !this.fenceState(proc.user).applied) throw new GuardError(409, "The checks between bots must pass first.");
    try { handle = this.runner.spawn(proc.user, kinds[proc.kind].script, (line, stream) => this.logLine(proc, line, stream), args); }
    catch {
      proc.state = "failed"; proc.wanted = false;
      this.audit("process-exit", "guard", `${proc.user} ${proc.kind}: could not start`); this.announce("proc", this.procView(proc));
      throw new GuardError(503, "The bot process could not start.");
    }
    proc.handle = handle; proc.pid = handle.pid; proc.state = "running"; proc.startedAt = this.iso();
    this.audit("process-start", "guard", `${proc.user} ${proc.kind}`); this.announce("proc", this.procView(proc));
    void handle.exited.then(() => {
      this.audit("process-exit", "guard", `${proc.user} ${proc.kind}`);
      if (proc.handle !== handle) return;
      proc.handle = undefined; proc.pid = null; proc.state = "stopped";
      if (proc.wanted && this.saved.level === "open" && !this.closing) {
        const delay = backoff[proc.restarts];
        if (delay === undefined) { proc.state = "failed"; proc.wanted = false; }
        else {
          proc.state = "waiting"; proc.restarts++;
          proc.cancel = this.clock.later(() => { void this.restart(proc); }, delay);
        }
      }
      this.announce("proc", this.procView(proc));
    }).catch(() => {});
  }
  private async restart(proc: Proc) {
    if (!proc.wanted || this.saved.level !== "open" || this.closing) return;
    try {
      if (proc.kind === "browser" && !this.processes.get(`${proc.user}-screen`)?.handle) {
        proc.cancel = this.clock.later(() => { void this.restart(proc); }, 2000); return;
      }
      await this.probe(); if (proc.wanted) this.launch(proc);
    }
    catch { proc.state = "failed"; proc.wanted = false; this.announce("proc", this.procView(proc)); }
  }
  private logLine(proc: Proc, line: string, stream: "out" | "err") {
    const clean = this.store.clean(line.slice(0, 16384));
    const row = `${this.iso()} ${stream}: ${clean}`;
    proc.lines.push(row); if (proc.lines.length > 400) proc.lines.shift();
    const file = path.join(this.store.dir, "logs", `${proc.user}-${proc.kind}.log`);
    try {
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(row) + 1 > 2 * 1024 * 1024) renameSync(file, file + ".1");
      appendFileSync(file, row + "\n", { mode: 0o600 });
    } catch { this.audit("log-failure", "guard", "Could not save a process log."); }
  }
  async stopProcess(user: unknown, kind: unknown) {
    const key = this.processKey(user, kind);
    if (kind === "screen") await this.stopProcess(user, "browser");
    this.processVersions.set(key, (this.processVersions.get(key) ?? 0) + 1);
    const proc = this.processes.get(key);
    if (proc) this.stopHandle(proc);
    // This stage has one kind. Later kinds can add their own process selectors here.
    let failed = false;
    try { await this.command("root", kinds[kind as string].stop, [user as string]); }
    catch { failed = true; if (proc) proc.state = "failed"; this.audit("step-failed", "guard", "Could not confirm the bot process has stopped."); }
    this.audit("process-stop", "guard", `${user} ${kind}`);
    if (proc) this.announce("proc", this.procView(proc));
    if (this.saved.level === "walled" || this.saved.level === "killed") await this.step("shut down the Linux space", () => this.terminate());
    if (failed) throw new GuardError(503, "Could not confirm the bot process has stopped. Use wall or kill to shut down the Linux space.");
  }
  private stopHandle(proc: Proc) {
    proc.wanted = false; proc.cancel?.();
    const handle = proc.handle; proc.handle = undefined; proc.state = "stopped"; proc.pid = null;
    try { handle?.kill(); } catch { try { this.audit("step-failed", "guard", "Could not close a process handle."); } catch {} }
  }
  private async stopAll() {
    const order = ["gateway", "browser", "screen"];
    for (const proc of [...this.processes.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))) { this.stopHandle(proc); this.audit("process-stop", "guard", `${proc.user} ${proc.kind}`); this.announce("proc", this.procView(proc)); }
    for (const session of this.sessions.values()) if (!session.ended) this.endSignIn(session);
    this.ready = false;
    await this.command("root", scripts.stopAll);
  }
  logs(user: unknown, kind: unknown, lines: number) {
    const key = this.processKey(user, kind);
    return (this.processes.get(key)?.lines ?? this.store.tail(`logs/${key}.log`, Math.min(lines, 400))).slice(-Math.min(lines, 400));
  }
  private provider(provider: unknown): asserts provider is string {
    if (provider !== "openai-codex" && provider !== "anthropic") throw new GuardError(400, "Choose OpenAI Codex or Anthropic.");
  }
  async signOut(provider: unknown) {
    this.provider(provider); this.assertOpen();
    if (this.signing.has(provider)) throw new GuardError(409, "This subscription is being changed. Try again when it has finished.");
    this.signing.add(provider);
    try {
      for (const session of this.sessions.values()) if (session.provider === provider && !session.ended) this.endSignIn(session);
      await this.makeTeam();
      await this.checked("lh-team", scripts.signOut, [provider]);
    } finally { this.signing.delete(provider); }
  }
  async signIn(provider: unknown) {
    this.provider(provider);
    const user = "lh-team";
    this.assertOpen();
    if (this.signing.has(provider) || [...this.sessions.values()].some((s) => s.provider === provider && !s.ended)) throw new GuardError(409, "That subscription already has a sign-in open.");
    this.signing.add(provider);
    try {
      await this.probe(); this.assertOpen();
      const id = randomUUID(), events = new EventEmitter(), lines: string[] = [];
      const handle = this.runner.spawn(user, scripts.signIn, (raw) => {
        // Hermes wraps the link and the code in colour codes even when told not to. Left in, they are invisible on the
        // screen but travel with a copy or a click, and the link then fails (the owner hit this on his OpenAI sign-in).
        const line = raw.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[ -/]*[@-~]", "g"), "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
        this.store.hide(line); lines.push(line); if (lines.length > 400) lines.shift(); events.emit("line", line);
      }, [provider]);
      const cancel = this.clock.later(() => { const session = this.sessions.get(id); if (session) this.endSignIn(session); }, 15 * 60_000);
      const session: Session = { id, user, provider, handle, lines, events, cancel, ended: false };
      this.sessions.set(id, session);
      this.audit("sign-in-start", "guard", `${user} ${provider}`);
      void handle.exited.then(() => this.endSignIn(session, false));
      return { session: id };
    } finally { this.signing.delete(provider); }
  }
  session(id: string) { const session = this.sessions.get(id); if (!session) throw new GuardError(404, "That sign-in has ended or was not found."); return session; }
  signInInput(id: string, text: unknown) {
    this.assertOpen(); const session = this.session(id);
    if (session.ended) throw new GuardError(409, "That sign-in has ended.");
    if (typeof text !== "string" || /[\r\n\0]/.test(text) || Buffer.byteLength(text) > 8192) throw new GuardError(400, "Send one line, no more than 8 KB.");
    this.store.hide(text); session.handle.write(text + "\n");
  }
  endSignIn(session: Session, kill = true) {
    if (session.ended) return;
    session.ended = true; session.cancel();
    try { if (kill) session.handle.kill(); } catch {}
    this.audit("sign-in-end", "guard", `${session.user} ${session.provider}`); session.events.emit("ended", {});
    // A caller can collect the end notice for a short time; no sign-in output survives on disk.
    this.clock.later(() => { session.lines.length = 0; this.sessions.delete(session.id); }, 60_000);
  }
  private procView(proc: Proc) { return { user: proc.user, kind: proc.kind, state: proc.state, pid: proc.pid, startedAt: proc.startedAt, restarts: proc.restarts }; }
  async state() {
    const space = await this.runner.spaceState().catch(() => "missing" as const);
    if (space !== "running") this.ready = false;
    return { ...this.saved, pinSet: !!this.store.pin || this.store.pinBroken, pinLockedUntil: this.store.lockedUntil ? new Date(this.store.lockedUntil).toISOString() : null,
      space, ready: this.ready, probe: this.probeResult, bots: [...this.bots].map((user) => ({ user, procs: [...this.processes.values()].filter((proc) => proc.user === user).map((proc) => this.procView(proc)) })),
      ownerUbuntuRunning: await this.runner.ownerUbuntuRunning?.().catch(() => false) ?? false };
  }
  private async evidence() {
    const dir = path.join(this.store.dir, "evidence", `${this.iso().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const notes = ["Evidence kept when the safety switch was set to killed."];
    const copy = (from: string, to: string) => { try { copyFileSync(from, to); } catch { notes.push(`Missing or unreadable: ${path.basename(from)}.`); } };
    copy(path.join(this.store.dir, "audit.jsonl"), path.join(dir, "audit.jsonl"));
    copy(path.join(this.store.dir, "state.json"), path.join(dir, "state.json"));
    mkdirSync(path.join(dir, "logs"));
    for (const name of readdirSync(path.join(this.store.dir, "logs"))) if (/^(?:lh-team|bot-[a-z0-9-]+)-gateway\.log(?:\.1)?$/.test(name)) copy(path.join(this.store.dir, "logs", name), path.join(dir, "logs", name));
    try {
      if (await this.runner.spaceState() === "running") {
        const result = await this.command("root", scripts.users);
        for (const user of result.out.split(/\r?\n/).filter(Boolean)) {
          try {
            linuxUser(user);
            if (user === "root") throw new Error();
            const archive = await this.command("root", scripts.evidence, [user], undefined, 30_000);
            if (!/^[A-Za-z0-9+/=\s]+$/.test(archive.out)) throw new Error();
            writeFileSync(path.join(dir, `${user}.tar.gz`), Buffer.from(archive.out, "base64"), { mode: 0o600 });
            if (archive.err.trim()) notes.push("Part of a bot's logs or sessions was missing. The available folders were kept.");
          } catch { notes.push("A bot's logs and sessions could not be copied in full."); }
        }
      } else notes.push("The Linux space was stopped. Its logs and sessions could not be copied.");
    } catch { notes.push("The Linux space could not supply its logs and sessions."); }
    writeFileSync(path.join(dir, "README.txt"), notes.join("\n") + "\n", { mode: 0o600 });
    const seal = (folder: string) => { for (const name of readdirSync(folder)) { const file = path.join(folder, name); if (statSync(file).isDirectory()) seal(file); else chmodSync(file, 0o444); } chmodSync(folder, 0o555); };
    seal(dir);
  }
  async close() {
    this.closing = true; this.version++; this.cancelTick?.(); this.untilCancel?.();
    await this.step("stop the bots as the guard closes", () => this.stopAll());
    // Termination also covers child processes that outlived a Windows handle.
    await this.step("shut down the Linux space as the guard closes", () => this.terminate());
    this.emit("closed"); this.removeAllListeners();
  }
  emergencyClose() {
    this.closing = true;
    for (const proc of this.processes.values()) { try { this.stopHandle(proc); } catch {} }
    for (const session of this.sessions.values()) if (!session.ended) { try { this.endSignIn(session); } catch {} }
  }
}
