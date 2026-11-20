import type { Bot } from "../contract.js";
import type { GuardClient } from "../guardClient.js";
import { getBot } from "../bots.js";
import { allocateScreen, prepareComputer } from "./computer.js";
import { ScreenGuardClient } from "./guard.js";
import { screenshot } from "./relay.js";
import { screenPorts } from "../../guard/fence.js";
import { deskSettings } from "./desk/settings.js";

export async function waitForScreen(bot: Bot, guard: GuardClient) {
  const ports = screenPorts(bot.box.user, bot.box), end = Date.now() + 30000;
  while (Date.now() < end && guard.level() === "open") {
    try {
      const response = await fetch(`http://127.0.0.1:${ports.cdpPort}/json/version`, { signal: AbortSignal.timeout(1000), redirect: "error" });
      if (response.ok) { await screenshot(bot.id); return; }
    } catch { /* The browser may still be opening. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("Its screen and browser did not finish opening.");
}

export type Computer = { has: boolean; state: "off" | "starting" | "ready" | "stopped" | "error"; why: string; width: number; height: number; controlledBy: "owner" | null };
export class Computers {
  private states = new Map<string, Computer>();
  private prepared = new Map<string, Bot>();
  private appearances = new Map<string, string>();
  readonly screens: ScreenGuardClient;
  constructor(private guard: GuardClient, private changed: (bot: string, computer: Computer) => void, screens?: ScreenGuardClient, private waitUntilReady: (bot: Bot) => Promise<void> = bot => waitForScreen(bot, guard)) {
    this.screens = screens ?? new ScreenGuardClient(guard);
  }
  get(bot: Bot): Computer {
    const saved = this.states.get(bot.id);
    return { has: bot.computer, state: !bot.computer ? "off" : this.guard.level() !== "open" ? "stopped" : saved?.state ?? "starting",
      why: !bot.computer ? "This bot has no computer." : this.guard.level() !== "open" ? "The safety switch is on." : saved?.why ?? "Setting up its screen…",
      width: 1440, height: 900, controlledBy: bot.computer && this.guard.level() === "open" && saved?.state === "ready" ? saved.controlledBy : null };
  }
  private set(bot: Bot, state: Computer["state"], why: string) {
    const value: Computer = { has: bot.computer, state, why, width: 1440, height: 900, controlledBy: null };
    this.states.set(bot.id, value); this.changed(bot.id, this.get(bot));
  }
  error(bot: Bot, why = "Its computer could not start. Check the safety switch and try again.") {
    this.prepared.delete(bot.id); this.set(bot, "error", why);
  }
  begin(bot: Bot) { this.set(bot, bot.computer ? "starting" : "off", bot.computer ? "Setting up its screen…" : "This bot has no computer."); }
  process(value: unknown) {
    if (!value || typeof value !== "object") return;
    const proc = value as { user?: string; kind?: string; state?: string };
    if (!proc.user?.startsWith("bot-") || !["screen", "browser"].includes(proc.kind ?? "")) return;
    const bot = getBot(proc.user.slice(4)); if (!bot?.computer) return;
    if (proc.state === "failed") this.error(bot, "Its screen or browser stopped unexpectedly. Try setting up its computer again.");
    else if (proc.state === "stopped") this.set(bot, "stopped", "Its computer is stopped.");
  }
  async prepare(bot: Bot) {
    const appearance = JSON.stringify([bot.name, bot.role, bot.look, deskSettings(bot.id)]);
    if (this.appearances.get(bot.id) === appearance && this.states.get(bot.id)?.state === "ready" && bot.box.user && (await this.screens.fence(bot.box.user)).applied) return;
    this.set(bot, "starting", "Setting up its screen…");
    try {
      await prepareComputer(bot, { allocate: allocateScreen, register: p => this.screens.setPorts(p),
        prepare: (u, w, h) => this.screens.prepare(u, w, h), fence: u => this.screens.fence(u),
        start: (u, k) => this.guard.startProcess(u, k) });
      this.prepared.set(bot.id, bot);
      this.appearances.set(bot.id, appearance);
    } catch (err) {
      console.warn(`[computer] ${bot.id}: ${(err instanceof Error ? err.message : "set-up failed").replace(/\s+/g, " ").slice(0, 200)}`);
      const why = "The checks between bots have not passed. Its computer tools are off.";
      this.error(bot, why); throw new Error(why);
    }
  }
  async start(id?: string) {
    for (const bot of [...this.prepared.values()].filter(b => !id || b.id === id)) {
      if (!getBot(bot.id)?.computer || this.guard.level() !== "open") throw new Error("The computer is stopped.");
      try {
        await this.guard.startProcess(bot.box.user!, "screen");
        await this.guard.startProcess(bot.box.user!, "browser");
        await this.waitUntilReady(bot);
        this.prepared.delete(bot.id); this.set(bot, "ready", "Its screen is ready.");
      } catch (err) { console.warn(`[computer] ${bot.id}: ${(err instanceof Error ? err.message : "could not start").replace(/\s+/g, " ").slice(0, 200)}`); this.error(bot); throw new Error("Its screen or browser could not start."); }
    }
  }
  async stop(bot: Bot) {
    this.prepared.delete(bot.id);
    if (bot.box.user && bot.box.display !== null) await this.screens.drop(bot.box.user);
    this.set(bot, "off", "This bot has no computer.");
  }
  control(id: string, controlled: boolean) {
    const bot = getBot(id); if (!bot) return;
    const value = { ...this.get(bot), controlledBy: controlled ? "owner" as const : null };
    this.states.set(id, value); this.changed(id, value);
  }
  refresh(bots: Bot[]) { for (const bot of bots) this.changed(bot.id, this.get(bot)); }
}
