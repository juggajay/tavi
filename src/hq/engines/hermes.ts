import { createHash } from "node:crypto";
import { db } from "../../store/db.js";
import { gatewayKey, teamGatewayKey, toolboxToken, getBot } from "../bots.js";
import { guardClient, type GuardClient } from "../guardClient.js";
import { soulFor, standingFor } from "./standing.js";
import { BOT_ID, PORTS, type Bot, type Engine, type EngineChoice, type EngineEvent, type TurnInput } from "../contract.js";
import { EngineParser } from "./parser.js";
import { engineDown, failure, stopped, type Failure } from "./failures.js";
import { ensureComputer, stopComputer } from "../screens/computer.js";
import { ScreenGuardClient } from "../screens/guard.js";
import { screenPorts } from "../../guard/fence.js";
import { twinName, twinSecret, forgetTwin, separateWork } from "../toolbox/lanes.js";

export type McpServers = Record<string, { url: string; headers: { Authorization: string }; timeout: number; connect_timeout: number }>;
export type HermesMcpServers = (botId: string, options: { baseUrl: string; token: string; servers: string[] }) => McpServers;
type Guard = Pick<GuardClient, "level" | "makeTeam" | "writeTeamFile" | "makeBot" | "writeBotFile" | "startProcess" | "stopProcess"> & Partial<Pick<GuardClient, "events">>;
export type HermesOptions = {
  guard?: Guard; toolboxBaseUrl?: string; hermesMcpServers?: HermesMcpServers; allServers?: readonly string[];
  gatewayUrl?: (bot: Bot) => string; requestTimeoutMs?: number; firstByteMs?: number; startupMs?: number; pollMs?: number;
  now?: () => number; busy?: () => boolean; teamGatewayUrl?: string;
  computer?: (bot: Bot) => Promise<void>;
  computerFenced?: (user: string) => Promise<boolean>;
  computerStop?: (bot: Bot) => Promise<void>;
};
export type ProviderLimit = { bot: string; provider: EngineChoice["provider"]; resetsAt: string };
const heldLimits = new Map<string, ProviderLimit>();
export function limits(now = Date.now()): ProviderLimit[] {
  for (const [key, limit] of heldLimits) if (Date.parse(limit.resetsAt) <= now) heldLimits.delete(key);
  return [...heldLimits.values()].map((l) => ({ ...l }));
}
const label = (choice: EngineChoice) => choice.provider === "anthropic" ? "Claude" : choice.provider.startsWith("openai") ? "OpenAI" : "OpenRouter";
type Ready = Awaited<ReturnType<Engine["ready"]>>;

/** JSON strings are also safe quoted words in YAML. No caller's text becomes a setting name. */
export function configYaml(bot: Bot, servers: McpServers, fenceApplied = false): string {
  if (bot.computer && !fenceApplied) throw new Error("The checks between bots must pass before giving a bot its computer tools.");
  if (bot.computer) {
    screenPorts(bot.box.user, bot.box);
    if (bot.box.user !== `bot-${bot.id}`) throw new Error("The computer must belong to this bot.");
  }
  const q = (text: string) => JSON.stringify(text);
  const lines = ["model:", `  default: ${q(bot.primary.model)}`, `  provider: ${q(bot.primary.provider)}`,
    "agent:", `  reasoning_effort: ${q(bot.primary.effort || "medium")}`,
    ...(bot.fallbacks.length ? ["fallback_providers:", ...bot.fallbacks.flatMap((c) => [`  - provider: ${q(c.provider)}`, `    model: ${q(c.model)}`])] : ["fallback_providers: []"]),
    "platform_toolsets:", bot.computer ? "  api_server: [todo, skills, web, terminal, file, browser, vision]" : "  api_server: [todo, skills]",
    ...(bot.computer ? ["terminal:", '  backend: "ssh"', '  ssh_host: "127.0.0.1"', `  ssh_user: ${q(bot.box.user!)}`, "  ssh_port: 2222",
      `  ssh_key: ${q(`/srv/lh/team/keys/${bot.id}`)}`, `  cwd: ${q(`/home/${bot.box.user}/work`)}`, "browser:", `  cdp_url: ${q(`http://127.0.0.1:${bot.box.cdpPort}`)}`] : []),
    "tools:", "  tool_search:", '    enabled: "off"',
    "auth:", "  adopt_external_logins: false", "updates:", "  check: false", "approvals:", "  mode: manual",
    "memory:", "  memory_enabled: false", "  user_profile_enabled: false", "curator:", "  enabled: false",
    ...(Object.keys(servers).length ? ["mcp_servers:"] : ["mcp_servers: {}"]),
  ];
  for (const [name, server] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${q(name)}:`, `    url: ${q(server.url)}`, "    headers:", `      Authorization: ${q(server.headers.Authorization)}`,
      `    timeout: ${server.timeout}`, `    connect_timeout: ${server.connect_timeout}`);
  }
  return lines.join("\n") + "\n";
}

export class HermesEngine implements Engine {
  readonly kind = "hermes" as const;
  private guard: Guard;
  private queue: Promise<unknown> = Promise.resolve();
  private active = 0;
  private restarting = false;
  private quietTimer?: ReturnType<typeof setTimeout>;
  private quietOff?: () => void;
  private stopRequested = new Set<string>();
  private clock: () => number;
  constructor(private options: HermesOptions = {}) { this.guard = options.guard || guardClient(); this.clock = options.now || Date.now; }
  private rootUrl() { return this.options.teamGatewayUrl || `http://127.0.0.1:${PORTS.gatewayBase}`; }
  private url(bot: Bot, work = false) {
    this.checkId(bot);
    const profile = work ? { ...bot, id: twinName(bot.id), computer: false } : bot;
    return this.options.gatewayUrl?.(profile) || `${this.rootUrl()}/p/${profile.id}`;
  }
  private checkId(bot: Bot) { if (!BOT_ID.test(bot.id) || ["default", "root", "hermes"].includes(bot.id)) throw new Error("That bot name cannot be used."); }
  private busy() { return this.active > 0 || (this.options.busy?.() ?? false); }
  private allowed(): boolean { return this.guard.level() === "open"; }
  private blocked(): Ready { return { ok: false, reason: "stopped", why: "The safety switch is on. The bot has not been started." }; }
  private pending(): Ready { return { ok: false, reason: "engine_down", why: "The team's settings will take effect when every bot is quiet." }; }
  private async getRoot(route: string, keyed = false, timeout = this.options.requestTimeoutMs ?? 2500): Promise<unknown> {
    const response = await fetch(this.rootUrl() + route, { headers: keyed ? { Authorization: `Bearer ${teamGatewayKey()}` } : {}, signal: AbortSignal.timeout(timeout), redirect: "error" });
    if (!response.ok) throw new Error();
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
  private async healthy(timeout?: number): Promise<boolean> { try { await this.getRoot("/health", false, timeout); return true; } catch { return false; } }
  async signedIn(): Promise<Record<string, boolean>> {
    const data = await this.getRoot("/api/model/options", true) as { providers?: { slug?: string; id?: string; provider?: string; authenticated?: boolean }[] };
    return Object.fromEntries((data.providers || []).map((p) => [p.slug || p.id || p.provider || "", p.authenticated === true]));
  }
  async subscriptions() {
    const signed = await this.signedIn();
    const held = this.limits();
    return ([{ provider: "anthropic", name: "Claude" }, { provider: "openai-codex", name: "OpenAI" }] as const).map((s) => ({
      ...s, signedIn: signed[s.provider] === true,
      limitedUntil: held.filter((l) => l.provider === s.provider).map((l) => l.resetsAt).sort().at(-1) ?? null,
    }));
  }
  async ready(bot: Bot): Promise<Ready> {
    if (!this.allowed()) return this.blocked();
    if (this.setting("team:restart-needed") === "yes" || this.restarting) return this.pending();
    if (!await this.healthy()) return { ok: false, reason: "engine_down", why: "The team's engine is not answering." };
    try {
      const signed = await this.signedIn();
      if (!this.allowed()) return this.blocked();
      return signed[bot.primary.provider] ? { ok: true } : { ok: false, reason: "not_signed_in", why: "Sign in to this bot's chosen subscription before asking it to work." };
    } catch { return { ok: false, reason: "engine_down", why: "The bot's engine could not check its sign-in." }; }
  }
  private one<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work); this.queue = pending.catch(() => {}); return pending;
  }
  ensureTeam(): Promise<Ready> { return this.one(() => this.provisionTeam()); }
  ensure(bot: Bot): Promise<Ready> {
    if (!getBot(bot.id)) return Promise.resolve(this.blocked());
    this.stopRequested.delete(bot.id);
    return this.one(() => this.provision(bot));
  }
  private setting(key: string): string | undefined { return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value; }
  private saveSetting(key: string, value: string) { db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
  private async writeFiles(id: string | null, files: Record<string, string>) {
    const incomplete = `team:incomplete:${id ?? "root"}`;
    for (const [name, content] of Object.entries(files)) {
      if (!this.allowed() || id && this.stopRequested.has(id)) throw new Error();
      const key = `${id === null ? "team" : "bot:" + id}:file:${name}`;
      const hash = createHash("sha256").update(content).digest("hex");
      if (this.setting(key) === hash) continue;
      this.saveSetting(incomplete, "yes");
      if (name !== "SOUL.md") this.saveSetting("team:restart-needed", "yes");
      if (id === null) await this.guard.writeTeamFile(name as "config.yaml" | ".env", content);
      else await this.guard.writeBotFile(id, name as "config.yaml" | ".env" | "SOUL.md", content);
      this.saveSetting(key, hash);
    }
    this.saveSetting(incomplete, "no");
  }
  private async teamFiles() {
    await this.guard.makeTeam();
    await this.writeFiles(null, {
      "config.yaml": "platform_toolsets:\n  api_server: []\nauth:\n  adopt_external_logins: false\nupdates:\n  check: false\ncurator:\n  enabled: false\n",
      ".env": `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${teamGatewayKey()}\nAPI_SERVER_PORT=${PORTS.gatewayBase}\nAPI_SERVER_HOST=127.0.0.1\n`,
    });
  }
  private async provisionTeam(): Promise<Ready> {
    if (!this.allowed()) return this.blocked();
    try { await this.teamFiles(); return await this.startWhenQuiet(); }
    catch { return this.setupFailed(); }
  }
  private setupFailed(): Ready { return this.allowed() ? { ok: false, reason: "engine_down", why: "The team's engine could not be set up. Check that the safety switch is running." } : this.blocked(); }
  private async provision(bot: Bot): Promise<Ready> {
    const canStart = () => this.allowed() && !this.stopRequested.has(bot.id) && !!getBot(bot.id);
    if (!canStart()) return this.blocked();
    try {
      this.checkId(bot);
      if (getBot(twinName(bot.id))) throw new Error("That work profile name is already in use.");
      const { hermesMcpServers, toolboxBaseUrl, allServers } = this.options;
      if (!hermesMcpServers || !toolboxBaseUrl || bot.servers === "all" && !allServers)
        return { ok: false, reason: "engine_down", why: "The bot's toolbox address and tool list have not been set up yet." };
      const servers = hermesMcpServers(bot.id, { baseUrl: toolboxBaseUrl, token: toolboxToken(bot.id), servers: bot.servers === "all" ? [...allServers!] : bot.servers });
      await this.teamFiles();
      if (!canStart()) return this.blocked();
      await this.guard.makeBot(bot.id);
      let fenced = false;
      if (bot.computer) {
        await (this.options.computer ?? ensureComputer)(bot);
        if (!canStart()) return this.blocked();
        fenced = this.options.computerFenced ? await this.options.computerFenced(bot.box.user!) :
          (await new ScreenGuardClient().fence(bot.box.user!)).applied;
        if (!fenced) throw new Error("The checks between bots must pass first.");
      } else if (bot.box.user && bot.box.display !== null) await (this.options.computerStop ?? stopComputer)(bot);
      await this.writeFiles(bot.id, {
        "config.yaml": configYaml(bot, servers, fenced),
        ".env": `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${gatewayKey(bot.id)}\n`,
        "SOUL.md": soulFor(bot),
      });
      if (!canStart()) return this.blocked();
      const twin = twinName(bot.id);
      const twinServers = hermesMcpServers(twin, { baseUrl: toolboxBaseUrl, token: twinSecret(bot.id, "toolbox-token", true)!,
        servers: (bot.servers === "all" ? [...allServers!] : bot.servers).filter((s) => s !== "computers") });
      await this.guard.makeBot(twin);
      await this.writeFiles(twin, {
        "config.yaml": configYaml({ ...bot, computer: false }, twinServers),
        ".env": `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${twinSecret(bot.id, "gateway-key", true)}\n`,
        "SOUL.md": soulFor(bot),
      });
      if (!canStart()) return this.blocked();
      return await this.startWhenQuiet(canStart);
    } catch { return this.setupFailed(); }
  }
  private scheduleQuiet() {
    if (this.quietTimer) return;
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined;
      if (this.setting("team:restart-needed") !== "yes") return;
      if (!this.allowed()) {
        if (this.guard.events) this.quietOff ??= this.guard.events(() => {
          if (!this.allowed()) return;
          this.quietOff?.(); this.quietOff = undefined; this.scheduleQuiet();
        });
        else this.scheduleQuiet();
        return;
      }
      if (this.busy()) { this.scheduleQuiet(); return; }
      void this.one(() => this.startWhenQuiet());
    }, 100);
    this.quietTimer.unref();
  }
  private async startWhenQuiet(canStart = () => this.allowed()): Promise<Ready> {
    if (!canStart()) return this.blocked();
    if (db.prepare("SELECT key FROM settings WHERE key LIKE 'team:incomplete:%' AND value='yes' LIMIT 1").get()) return this.setupFailed();
    const changed = this.setting("team:restart-needed") === "yes";
    if (changed && this.busy()) { this.scheduleQuiet(); return this.pending(); }
    this.restarting = true;
    try {
      const healthy = await this.healthy();
      if (!canStart()) return this.blocked();
      // A turn may have started while the health reply was on its way.
      if (changed && this.busy()) { this.scheduleQuiet(); return this.pending(); }
      if (changed && healthy) await this.guard.stopProcess("lh-team");
      if (!canStart()) return this.blocked();
      if (!healthy || changed) await this.guard.startProcess("lh-team");
      const end = Date.now() + (this.options.startupMs ?? 90000);
      do {
        if (!canStart()) return this.blocked();
        if (await this.healthy(Math.max(1, Math.min(this.options.requestTimeoutMs ?? 1500, end - Date.now())))) {
          if (!canStart()) return this.blocked();
          this.saveSetting("team:restart-needed", "no");
          return canStart() ? { ok: true } : this.blocked();
        }
        if (Date.now() >= end) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(this.options.pollMs ?? 1000, Math.max(0, end - Date.now()))));
      } while (Date.now() < end);
      return { ok: false, reason: "engine_down", why: "The team's engine did not start in time." };
    } catch { return this.setupFailed(); }
    finally { this.restarting = false; }
  }
  async stop(bot: Bot): Promise<void> {
    this.stopRequested.add(bot.id);
    await this.one(async () => {
      if (this.busy()) throw new Error("Wait until every bot is quiet before stopping the team's engine.");
      clearTimeout(this.quietTimer); this.quietTimer = undefined;
      this.quietOff?.(); this.quietOff = undefined;
      await this.guard.stopProcess("lh-team");
    });
  }
  async restart(bot: Bot): Promise<Ready> {
    if (!this.allowed()) return this.blocked();
    this.saveSetting("team:restart-needed", "yes");
    return this.ensure(bot);
  }
  async remove(bot: Bot) {
    this.stopRequested.add(bot.id); await this.queue;
    forgetTwin(bot.id);
    const twin = twinName(bot.id);
    for (const name of ["config.yaml", ".env", "SOUL.md"]) db.prepare("DELETE FROM settings WHERE key=?").run(`bot:${twin}:file:${name}`);
    db.prepare("DELETE FROM settings WHERE key=?").run(`team:incomplete:${twin}`);
    if (bot.box.user && bot.box.display !== null) await (this.options.computerStop ?? stopComputer)(bot);
  }
  limits() { return limits(this.clock()); }
  async run(bot: Bot, input: TurnInput, on: (event: EngineEvent) => void, signal: AbortSignal): Promise<void> {
    if (!getBot(bot.id) || this.stopRequested.has(bot.id) || input.lane === "work" && (!separateWork(bot) || !twinSecret(bot.id, "gateway-key"))) { on(stopped()); return; }
    if (signal.aborted || !this.allowed()) { on(stopped()); return; }
    if (this.restarting || this.setting("team:restart-needed") === "yes") { on(engineDown()); return; }
    this.active++;
    try { await this.runTurn(bot, input, on, signal); }
    finally { this.active--; if (this.setting("team:restart-needed") === "yes") this.scheduleQuiet(); }
  }
  private async runTurn(bot: Bot, input: TurnInput, on: (event: EngineEvent) => void, signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted || !this.allowed()) { on(stopped()); return; }
      let choices = [input.choice, ...bot.fallbacks].filter((c, i, all) => all.findIndex((a) => a.provider === c.provider) === i);
      const limited = this.limits().filter((l) => l.bot === bot.id);
      choices = choices.filter((c) => !limited.some((l) => l.provider === c.provider));
      if (!choices.length) {
        on({ type: "failed", reason: "limit", message: "The chosen services have reached their usage limits.", resetsAt: limited.map((l) => l.resetsAt).sort()[0] });
        return;
      }
      if (choices[0].provider !== input.choice.provider) on({ type: "status", text: `${label(input.choice)}'s limit is reached, carrying on with ${label(choices[0])}.` });
      for (let attempt = 0; attempt < Math.min(2, choices.length); attempt++) {
        let wrote = false;
        const choice = choices[attempt];
        const result = await this.request(bot, { ...input, choice }, (event) => {
          if (event.type === "text" && event.delta) wrote = true;
          on(event);
        }, signal);
        if (!result) return;
        if (result.reason === "limit") {
          const resetsAt = result.resetsAt && Date.parse(result.resetsAt) > this.clock() ? result.resetsAt : new Date(this.clock() + 15 * 60000).toISOString();
          heldLimits.set(`${bot.id}:${choice.provider}`, { bot: bot.id, provider: choice.provider, resetsAt });
        }
        if (!wrote && attempt === 0 && choices[1] && (result.reason === "limit" || result.reason === "not_signed_in") && !signal.aborted && this.allowed()) {
          on({ type: "status", text: `${label(choice)}${result.reason === "limit" ? "'s limit is reached" : " needs a sign-in"}, carrying on with ${label(choices[1])}.` });
          continue;
        }
        on(result);
        return;
      }
    } catch { on(signal.aborted ? stopped() : engineDown()); }
  }
  private async request(bot: Bot, input: TurnInput, on: (event: EngineEvent) => void, signal: AbortSignal): Promise<Failure | undefined> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const off = this.guard.events?.(() => { if (!this.allowed()) abort(); });
    const timer = setTimeout(abort, this.options.firstByteMs ?? 30000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const work = input.lane === "work";
      const key = work ? twinSecret(bot.id, "gateway-key") : gatewayKey(bot.id);
      if (!key) return stopped();
      const response = await fetch(this.url(bot, work) + "/v1/responses", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: input.choice.model, provider: input.choice.provider,
          model_options: { reasoning_effort: input.choice.effort || "medium" },
          input: input.images?.length ? [{ role: "user", content: [{ type: "input_text", text: input.text }, ...input.images.map((image_url) => ({ type: "input_image", image_url }))] }] : input.text,
          instructions: standingFor(bot) + "\n\n" + input.instructions, conversation: input.conversation, stream: true, store: true }),
      });
      if (!response.ok) {
        if (response.status >= 500) return engineDown();
        const message = await response.text();
        const retry = response.headers.get("Retry-After");
        let hint = message;
        if (retry && /^\d+$/.test(retry)) hint += ` Retry in ${retry} seconds.`;
        else if (retry && Number.isFinite(Date.parse(retry))) hint += ` resets at ${new Date(retry).toISOString()}`;
        return failure(hint, response.status, this.clock());
      }
      if (!response.body) return engineDown();
      reader = response.body.getReader();
      const parser = new EngineParser(input.choice, this.clock());
      while (true) {
        const { value, done } = await reader.read();
        if (done) return engineDown();
        if (value.byteLength) clearTimeout(timer);
        if (signal.aborted || !this.allowed()) return stopped();
        for (const event of parser.push(value)) {
          if (signal.aborted || !this.allowed()) return stopped();
          if (event.type === "failed") return event;
          on(event);
        }
        if (parser.terminal) return;
      }
    } catch { return signal.aborted || !this.allowed() ? stopped() : engineDown(); }
    finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort); off?.();
      controller.abort();
      await reader?.cancel().catch(() => {});
    }
  }
}
