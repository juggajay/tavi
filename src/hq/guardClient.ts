import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SafetyLevel } from "./contract.js";
import { SseDecoder } from "./engines/sse.js";

export type GuardProcess = { kind: string; state: string; pid: number | null; startedAt: string | null; restarts: number };
export type GuardState = {
  level: SafetyLevel; since: string; until: string | null; cameFrom: SafetyLevel | null; reason: string; by: string;
  pinSet: boolean; pinLockedUntil: string | null; space: string; ready: boolean;
  probe: { ok: boolean; at: string | null; failed: string[] };
  bots: { user: string; procs: GuardProcess[] }[]; ownerUbuntuRunning: boolean;
};
export type GuardEvent = { event: string; data: unknown };
export type GuardFile = "config.yaml" | ".env" | "SOUL.md";
export type SignInProvider = "anthropic" | "openai-codex";
type Options = { baseUrl?: string; secretPath?: string; timeoutMs?: number; streamIdleMs?: number; reconnectMs?: number; watch?: boolean };
const validLevel = (s: unknown): s is SafetyLevel => ["open", "paused", "walled", "killed"].includes(String(s));
const piece = (s: string) => encodeURIComponent(s);

const SETUP_MS = 90_000;
export class GuardClient {
  private known: SafetyLevel = "walled";
  private down = true;
  private closed = false;
  private watchController?: AbortController;
  private reconnect?: ReturnType<typeof setTimeout>;
  private listeners = new Set<(event: GuardEvent) => void>();
  readonly baseUrl: string;
  readonly timeoutMs: number;
  constructor(private options: Options = {}) {
    this.baseUrl = options.baseUrl || "http://127.0.0.1:3091";
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (options.watch !== false) void this.watch();
  }
  level(): SafetyLevel { return this.down ? "walled" : this.known; }
  guardDown(): boolean { return this.down; }
  private secretPath() {
    return this.options.secretPath || path.join(process.env.LH_V3_DATA || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data-v3"), "guard", "secret-relay");
  }
  private async authorization() {
    try {
      const key = (await readFile(this.secretPath(), "utf8")).trim();
      if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error();
      return `Bearer ${key}`;
    } catch { throw new Error("The safety switch's saved access key is not available."); }
  }
  private accept(level: unknown, publish = true) {
    if (this.closed) return;
    if (validLevel(level)) {
      const changed = this.down || this.known !== level;
      this.known = level; this.down = false;
      if (changed && publish) for (const listener of this.listeners) listener({ event: "level", data: { level } });
    }
  }
  private unavailable() {
    const changed = !this.down;
    this.down = true;
    if (changed) for (const listener of this.listeners) listener({ event: "level", data: { level: "walled" } });
  }
  private async call<T>(method: string, route: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    try {
      if (this.closed) throw new Error();
      const response = await fetch(`${this.baseUrl}${route}`, {
        method, headers: { Authorization: await this.authorization(), "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error",
      });
      if (!response.ok) {
        const shown = route.split("?")[0].replace(/\/\.(?=[^/]*$)/, "/%2E");
        console.warn(`The safety switch refused ${shown} (${response.status}).`);
        throw new Error();
      }
      const text = await response.text();
      const result = text ? JSON.parse(text) : undefined;
      if (route === "/state") {
        if (!validLevel(result?.level)) throw new Error();
        this.accept(result.level);
      } else if (route === "/level" || route === "/trip") {
        // Read back the held level rather than trusting what was requested.
        await this.state();
      }
      return result as T;
    } catch {
      this.unavailable();
      throw new Error("The safety switch could not complete that request. The bots are treated as walled off.");
    }
  }
  state() { return this.call<GuardState>("GET", "/state"); }
  setLevel(request: { level: SafetyLevel; reason: string; by: string; minutes?: number; pin?: string }) { return this.call<void>("POST", "/level", request); }
  setPin(pin: string, old?: string) { return this.call<void>("POST", "/pin", { pin, old }); }
  // The lock-down check can take two minutes. Ordinary requests still have their short wait.
  startSpace() { return this.call<void>("POST", "/space/start", {}, 125000); }
  stopSpace() { return this.call<void>("POST", "/space/stop", {}); }
  // Set-up steps run commands inside the Linux space; making a new bot's settings folder alone took longer than the
  // short wait on the first real try, and a timed-out step makes the app treat the whole team as walled off.
  makeTeam() { return this.call<{ home: string }>("POST", "/team", {}, SETUP_MS); }
  writeTeamFile(name: Exclude<GuardFile, "SOUL.md">, content: string) { return this.call<void>("PUT", `/team/file/${piece(name)}`, { content }, SETUP_MS); }
  makeBot(id: string) { return this.call<{ home: string }>("POST", "/bots", { id }, SETUP_MS); }
  writeBotFile(user: string, name: GuardFile, content: string) { return this.call<void>("PUT", `/bots/${piece(user)}/file/${piece(name)}`, { content }, SETUP_MS); }
  readBotFile(user: string, name: Exclude<GuardFile, ".env">) { return this.call<{ content: string }>("GET", `/bots/${piece(user)}/file/${piece(name)}`); }
  startProcess(user: string, kind = "gateway") { return this.call<GuardProcess>("POST", `/bots/${piece(user)}/procs/${piece(kind)}/start`, {}, 125000); }
  stopProcess(user: string, kind = "gateway") { return this.call<void>("POST", `/bots/${piece(user)}/procs/${piece(kind)}/stop`, {}, SETUP_MS); }
  processLog(user: string, kind = "gateway", lines = 200) { return this.call<{ lines: string[] }>("GET", `/bots/${piece(user)}/procs/${piece(kind)}/log?lines=${lines}`); }
  signIn(provider: SignInProvider) { return this.call<{ session: string }>("POST", `/subscriptions/${piece(provider)}/sign-in`, {}); }
  signOut(provider: SignInProvider) { return this.call<void>("DELETE", `/subscriptions/${piece(provider)}`); }
  signInInput(session: string, text: string) { return this.call<void>("POST", `/sign-in/${piece(session)}/input`, { text }); }
  endSignIn(session: string) { return this.call<void>("DELETE", `/sign-in/${piece(session)}`); }
  seen() { return this.call<void>("POST", "/seen", {}); }
  trip(reason: string) { return this.call<void>("POST", "/trip", { reason }); }
  audit(lines = 200) { return this.call<{ lines: string[] }>("GET", `/audit?lines=${lines}`); }
  events(on: (event: GuardEvent) => void) { this.listeners.add(on); return () => { this.listeners.delete(on); }; }
  async signInEvents(session: string, on: (event: GuardEvent) => void, signal: AbortSignal): Promise<void> {
    try { await this.stream(`/sign-in/${piece(session)}/events`, on, signal); }
    catch { throw new Error("The sign-in window lost its connection to the safety switch."); }
  }
  private async stream(route: string, on: (event: GuardEvent) => void, signal: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let timer = setTimeout(abort, this.timeoutMs);
    const idleCheck = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (route === "/events") {
          // A quiet switch is normal. Check that it still answers before putting the wall up.
          void this.state().then(() => { if (!controller.signal.aborted) idleCheck(); }).catch(abort);
        } else abort();
      }, this.options.streamIdleMs ?? (route === "/events" ? 30000 : 15 * 60000));
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${this.baseUrl}${route}`, { headers: { Authorization: await this.authorization(), Accept: "text/event-stream" }, signal: controller.signal, redirect: "error" });
      if (!response.ok || !response.body) throw new Error();
      idleCheck();
      reader = response.body.getReader();
      const parser = new SseDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        idleCheck();
        for (const frame of parser.push(value)) {
          let data: unknown;
          try { data = JSON.parse(frame.data); } catch { continue; }
          on({ event: frame.event, data });
        }
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => {});
      controller.abort();
    }
  }
  private async watch() {
    if (this.closed) return;
    const controller = this.watchController = new AbortController();
    try {
      await this.state();
      if (this.closed) return;
      await this.stream("/events", (event) => {
        if (event.event === "level") this.accept(typeof event.data === "string" ? event.data : (event.data as { level?: unknown })?.level, false);
        for (const listener of this.listeners) listener(event);
      }, controller.signal);
    } catch { /* A lost guard means the wall stays up until the next connection. */ }
    finally {
      this.unavailable();
      if (!this.closed) {
        this.reconnect = setTimeout(() => void this.watch(), this.options.reconnectMs ?? 1000);
        this.reconnect.unref();
      }
    }
  }
  close() { this.closed = true; clearTimeout(this.reconnect); this.watchController?.abort(); this.unavailable(); }
}

let shared: GuardClient | undefined;
export const guardClient = () => shared ??= new GuardClient();
