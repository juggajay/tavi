// The assistant's browser, watched and handed over (Stage 15.2). A browser job's own Playwright tools start Edge exactly as
// before (the assistant's own profile, never the owner's Chrome or Edge profile), now with a debugging port on this PC
// only, and the gateway attaches to that same browser without changing anything about it; when the owner signs in to a
// site, the gateway starts it itself (no job involved). From here it is streamed to the desktop's right-hand
// pane (the browser's own screencast: a picture each time the page changes), and the owner can take it over: while he
// has it, his clicks, scrolling and typing go straight to the page, and the assistant's browsing waits and sees nothing
// (src/browser/gate.ts). Nothing he types passes through anything but the page: it isn't logged, kept or shown to the model.
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { audit } from "../store/log.js";
import { bus } from "../events.js";
import { zone } from "../time.js";
import { AGENT_HEADER, ownersBrowserProfile, siteDomain } from "./sites.js";
import { secretField } from "./guard.js";

/**
 * The Playwright the browser tools themselves use (it comes with them). It can attach to their browser with `noDefaults`,
 * which leaves the browser exactly as they set it up (downloads included); the app's own Playwright can't.
 */
const toolsPlaywright = () => createRequire(createRequire(import.meta.url).resolve("@playwright/mcp/package.json"))("playwright-core") as typeof import("playwright-core");
/** The debugging port, on this PC only, that lets the gateway attach to a job's browser. */
export const PORT_ARGS = ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"];

import type { BrowserView } from "../shared/protocol.js";
export type { BrowserView };
/**
 * What the desktop's pane shows besides the picture (src/shared/protocol.ts BrowserView): mode job (the assistant is
 * browsing) or owner (he opened it to sign in; the assistant isn't involved); the site's real domain, shown big so a
 * look-alike can't hide; what it's doing in plain words; taken over or not; why it's asking him to take over; a go-ahead
 * waiting; and the instructions it found on a page and ignored.
 */
export type Frame = { jpeg: Buffer; w: number; h: number; dw: number; dh: number; at: number };
type Watcher = (m: { view: BrowserView } | { frame: Frame }) => void;

const CLOSED: BrowserView = { open: false, mode: null, job_id: null, summary: "", url: "", domain: "", secure: false, title: "", doing: "", takeover: "off", asking: null, approval: null, notes: [], started_at: null };
export const VIEWPORT = { width: 1280, height: 900 };
/** The shortest gap between two pictures sent to the desktop: about 30 a second. */
export const FRAME_MS = 33;
/** How long Take over waits for the step the assistant is in the middle of before handing over anyway. */
export const DRAIN_MS = 10_000;

/** Turn off the browser's own password, address and card saving in a profile (as the sign-in window always did). */
export function noSavedSecrets(profile: string) {
  const file = path.join(profile, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    if (existsSync(file)) prefs = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    /* rewritten below */
  }
  prefs.credentials_enable_service = false;
  prefs.profile = { ...((prefs.profile as Record<string, unknown>) ?? {}), password_manager_enabled: false };
  prefs.autofill = { ...((prefs.autofill as Record<string, unknown>) ?? {}), profile_enabled: false, credit_card_enabled: false, enabled: false };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(prefs));
}

const watchers = new Set<Watcher>();
let current: Host | null = null;

export const browserState = (): BrowserView => current?.view ?? CLOSED;
export const liveHost = () => current;

/** Follow the desktop's live view: the state at once, then every change and every new picture. */
export function watchBrowser(fn: Watcher) {
  watchers.add(fn);
  fn({ view: browserState() });
  void current?.cast();
  return () => {
    watchers.delete(fn);
    if (!watchers.size) void current?.uncast();
  };
}

/** The browser's own pages (settings, its downloads list): never shown as "the page". */
const INTERNAL = /^(edge|chrome|devtools|chrome-extension):/i;

export class Host {
  view: BrowserView;
  endpoint = "";
  /** Bumped each time he takes over: anything the assistant started before then never sees what came after. */
  epoch = 0;
  stopped = false;
  inflight = 0;
  /** pictures made by the browser, and sent to whoever's watching */
  frames = 0;
  sent = 0;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private casting = false;
  private released: (() => void)[] = [];
  private onClose: (() => void)[] = [];
  private seen = new Set<string>();
  private backs: (() => void)[] = [];
  /** null until attached: a job's browser starts when its first step needs it */
  ctx: BrowserContext | null = null;
  private browser: Browser | null = null;

  constructor(
    ctx: BrowserContext | null,
    readonly profile: string,
    readonly throwaway: boolean,
    o: { mode: "job" | "owner"; job_id: string | null; summary: string },
  ) {
    this.ctx = ctx;
    this.view = { ...CLOSED, open: true, mode: o.mode, job_id: o.job_id, summary: o.summary, started_at: new Date().toISOString(), doing: o.mode === "owner" ? "Waiting for you" : "Starting the browser", notes: [] };
  }

  emit() {
    bus.emit("browser", this.view);
    for (const w of watchers) w({ view: this.view });
  }
  set(patch: Partial<BrowserView>) {
    this.view = { ...this.view, ...patch };
    this.emit();
  }
  /** Plain words for what it's doing ("Clicking “Add to cart”"); never what's typed. */
  doing(text: string) {
    if (this.view.doing !== text) this.set({ doing: text.slice(0, 120) });
  }
  /** Instructions found on a page that it ignored, kept for the pane (the last five, each once). */
  note(text: string) {
    const t = text.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!t || this.view.notes.includes(t)) return;
    this.set({ notes: [...this.view.notes, t].slice(-5) });
    audit("brain", "browser.ignored_instructions", this.view.job_id, { url: this.view.url.slice(0, 200), note: t });
  }
  /**
   * What's in every password, card, security-code and one-time-code box on its pages now (three characters or more),
   * whoever typed it: blanked out of anything the model gets (gate.ts). Frames on other sites (a card form) included.
   */
  async secrets(): Promise<string[]> {
    const out = new Set<string>();
    for (const p of this.ctx?.pages() ?? [])
      for (const f of p.frames()) {
        const fields = await f
          .$$eval("input, textarea", (els) =>
            els.map((e) => {
              const i = e as HTMLInputElement;
              return { type: (i.type || "").toLowerCase(), auto: (i.autocomplete || "").toLowerCase(), label: [i.name, i.id, i.getAttribute("aria-label"), i.placeholder, i.labels?.[0]?.textContent].filter(Boolean).join(" "), value: i.value };
            }),
          )
          .catch(() => [] as { type: string; auto: string; label: string; value: string }[]);
        for (const x of fields) if (x.value.length >= 3 && (x.type === "password" || /\bcc-|one-time-code|password/.test(x.auto) || secretField(x.label))) out.add(x.value);
      }
    return [...out].sort((a, b) => b.length - a.length); // longest first, so one inside another is blanked whole
  }
  /** Every site it has been on (for "sites I'm signed in to" after a sign-in). */
  sites() {
    return [...this.seen];
  }

  /* ---------- the page it's on, and the pictures of it ---------- */

  follow(p: Page) {
    if (this.page === p || p.isClosed() || INTERNAL.test(p.url())) return;
    const was = this.casting;
    void this.uncast();
    this.page = p;
    const update = () => {
      if (this.page !== p) return;
      let u: URL | null = null;
      try {
        u = new URL(p.url());
      } catch {
        /* about:blank and the like */
      }
      if (INTERNAL.test(p.url())) {
        // the browser's own page (its downloads list): show the last real page instead
        const other = this.ctx?.pages().filter((x) => x !== p && !x.isClosed() && !INTERNAL.test(x.url())).at(-1);
        if (other) return this.follow(other);
      }
      const host = u && /^https?:$/.test(u.protocol) ? u.hostname : "";
      if (host) this.seen.add(siteDomain(host));
      this.set({ url: p.url(), domain: host.replace(/^www\./, ""), secure: u?.protocol === "https:" });
      void p.title().then((t) => this.page === p && t !== this.view.title && this.set({ title: t.slice(0, 200) })).catch(() => undefined);
    };
    p.on("framenavigated", (f) => f === p.mainFrame() && update());
    p.on("load", update);
    p.on("close", () => {
      if (this.page !== p) return;
      this.page = null;
      const next = this.ctx?.pages().filter((x) => !x.isClosed()).at(-1);
      if (next) this.follow(next);
    });
    update();
    if (was || watchers.size) void this.cast();
  }

  async cast() {
    const p = this.page;
    if (!p || !this.ctx || this.casting || this.stopped) return;
    this.casting = true;
    try {
      const cdp = await this.ctx.newCDPSession(p);
      this.cdp = cdp;
      cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
        this.frames++;
        const jpeg = Buffer.from(f.data, "base64");
        // a JPEG's own size, from its start-of-frame marker
        let w = 0,
          h = 0;
        for (let i = 2; i < jpeg.length - 9; ) {
          if (jpeg[i] !== 0xff) break;
          const m = jpeg[i + 1];
          if (m >= 0xc0 && m <= 0xc3) {
            h = jpeg.readUInt16BE(i + 5);
            w = jpeg.readUInt16BE(i + 7);
            break;
          }
          i += 2 + jpeg.readUInt16BE(i + 2);
        }
        this.latest = { jpeg, w, h, dw: f.metadata.deviceWidth, dh: f.metadata.deviceHeight, at: Date.now() };
        this.flush();
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
    } catch {
      this.casting = false; // the page went away; the next one is followed
    }
  }
  /**
   * Pictures go out at most FRAME_MS apart, always the newest (and the last one always goes), so a slow screen never
   * falls behind the page.
   */
  private latest: Frame | null = null;
  private sentAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flush() {
    if (this.flushTimer) return;
    const wait = this.sentAt + FRAME_MS - Date.now();
    const go = () => {
      this.flushTimer = null;
      const frame = this.latest;
      this.latest = null;
      if (!frame || this.stopped) return;
      this.sentAt = Date.now();
      this.sent++;
      for (const fn of watchers) fn({ frame });
    };
    if (wait <= 0) go();
    else this.flushTimer = setTimeout(go, wait);
  }
  async uncast() {
    const cdp = this.cdp;
    this.cdp = null;
    this.casting = false;
    if (cdp) await cdp.send("Page.stopScreencast").catch(() => undefined);
    await cdp?.detach().catch(() => undefined);
  }

  /* ---------- taking it over ---------- */

  /** He takes it: the assistant's next step waits (and the one it's in, up to DRAIN_MS, finishes first). */
  async takeOver() {
    if (this.stopped || this.view.takeover !== "off" || !this.ctx) return;
    this.set({ takeover: "pending", doing: "Handing it to you" });
    const until = Date.now() + DRAIN_MS;
    while (this.inflight > 0 && Date.now() < until && !this.stopped) await new Promise((r) => setTimeout(r, 50));
    if (this.stopped) return;
    this.epoch++;
    this.set({ takeover: "on", asking: null, doing: "You're driving" });
    audit("user", "browser.taken_over", this.view.job_id, { site: this.view.domain });
    if (!this.cdp && this.page) await this.cast(); // input goes through the same connection as the pictures
  }
  /** He gives it back: the assistant looks at the page as it is now and carries on. */
  handBack() {
    if (this.view.takeover === "off") return;
    this.set({ takeover: "off", doing: this.view.mode === "owner" ? "Done" : "Having a fresh look at the page" });
    audit("user", "browser.handed_back", this.view.job_id, { site: this.view.domain });
    for (const r of this.released.splice(0)) r();
    for (const f of this.backs) f();
    if (this.view.mode === "owner") void this.close(); // signing in: Done closes it, and the sign-in is kept
  }
  /** Resolves when he isn't driving (or it's stopped). */
  whenFree(signal?: AbortSignal) {
    if (this.view.takeover === "off" || this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.released.push(resolve);
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  /**
   * The assistant asks him to take over (a sign-in, card details, a "prove you're human" check). Resolves "back" once he
   * has taken over and handed back, "stopped", or "no_answer" after waitMs.
   */
  async ask(reason: string, waitMs = 15 * 60_000): Promise<"back" | "stopped" | "no_answer"> {
    this.set({ asking: reason.slice(0, 160), doing: "Waiting for you" });
    const start = this.epoch;
    const end = Date.now() + waitMs;
    while (!this.stopped && Date.now() < end) {
      if (this.epoch > start && this.view.takeover === "off") return "back";
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.view.asking) this.set({ asking: null });
    return this.stopped ? "stopped" : "no_answer";
  }

  /**
   * His mouse and keys, while he has it, straight to the page. Never logged, never kept, never shown to the assistant:
   * this function is the only place they pass through, and it only hands them to the browser.
   */
  async input(e: InputEvent) {
    if (this.view.takeover !== "on" || !this.cdp) return;
    const cdp = this.cdp;
    const x = clamp(e.x, 0, VIEWPORT.width),
      y = clamp(e.y, 0, VIEWPORT.height);
    try {
      if (e.t === "mouse") await cdp.send("Input.dispatchMouseEvent", { type: e.kind === "down" ? "mousePressed" : e.kind === "up" ? "mouseReleased" : "mouseMoved", x, y, button: e.kind === "move" ? (e.buttons ? "left" : "none") : (e.button ?? "left"), buttons: e.buttons ?? 0, clickCount: e.clicks ?? 1, modifiers: e.mods ?? 0 });
      else if (e.t === "wheel") await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: clamp(e.dx ?? 0, -2000, 2000), deltaY: clamp(e.dy ?? 0, -2000, 2000), modifiers: e.mods ?? 0 });
      else if (e.t === "key") {
        const printable = !!e.text && !(e.mods && e.mods & (2 | 4)); // no Ctrl or Meta
        await cdp.send("Input.dispatchKeyEvent", {
          type: e.kind === "up" ? "keyUp" : printable ? "keyDown" : "rawKeyDown",
          key: String(e.key ?? "").slice(0, 24),
          code: String(e.code ?? "").slice(0, 24),
          windowsVirtualKeyCode: e.keyCode ?? 0,
          modifiers: e.mods ?? 0,
          ...(e.kind !== "up" && printable ? { text: e.text, unmodifiedText: e.text } : {}),
          autoRepeat: !!e.repeat,
        });
      } else if (e.t === "text") await cdp.send("Input.insertText", { text: String(e.text ?? "").slice(0, 4000) });
    } catch {
      /* the page went away mid-key: nothing to do, and nothing said about it */
    }
  }

  /* ---------- stopping ---------- */

  /** Close it now. Anything the assistant was doing in it fails at once. */
  async close() {
    if (!this.view.open) return;
    this.stopped = true;
    for (const r of this.released.splice(0)) r();
    await this.uncast();
    this.view = { ...this.view, open: false, takeover: "off", asking: null, approval: null, doing: "" };
    if (current === this) current = null;
    this.emit();
    for (const f of this.onClose.splice(0)) f();
    if (this.attaching) clearInterval(this.attaching);
    if (this.browser) {
      // a job's browser (the tools started it): closed outright, so anything mid-step fails at once
      const b = this.browser;
      await b
        .newBrowserCDPSession()
        .then((s) => s.send("Browser.close"))
        .catch(() => undefined);
      await b.close().catch(() => undefined);
    } else await this.ctx?.close().catch(() => undefined);
    if (this.throwaway) {
      try {
        rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* a file the browser still had open: the job's folder is the only place it can be */
      }
    }
  }
  private attaching: ReturnType<typeof setInterval> | null = null;
  /** A job's browser: attach once the tools have started it (it writes its port into the profile as it starts). */
  watchForBrowser() {
    const portFile = path.join(this.profile, "DevToolsActivePort");
    let busy = false;
    this.attaching = setInterval(async () => {
      if (busy || this.stopped || this.ctx) return;
      let port = "";
      try {
        port = readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
      } catch {
        return;
      }
      if (!/^\d+$/.test(port)) return;
      busy = true;
      try {
        const chromiumTools = toolsPlaywright().chromium as unknown as { connectOverCDP: (url: string, o: { noDefaults: boolean; timeout: number }) => Promise<Browser> };
        const browser = await chromiumTools.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 10_000 });
        if (this.stopped) return void (await browser.close().catch(() => undefined));
        this.browser = browser;
        const ctx = browser.contexts()[0];
        this.ctx = ctx;
        if (this.attaching) clearInterval(this.attaching);
        this.attaching = null;
        browser.on("disconnected", () => void this.close());
        ctx.on("page", (p) => this.follow(p));
        const last = ctx.pages().filter((p) => !p.isClosed()).at(-1);
        if (last) this.follow(last);
        this.set({ doing: this.view.doing === "Starting the browser" ? "Opening the page" : this.view.doing });
      } catch {
        /* not ready yet: try again */
      } finally {
        busy = false;
      }
    }, 60);
  }
  whenClosed(f: () => void) {
    this.onClose.push(f);
  }
  onHandBack(f: () => void) {
    this.backs.push(f);
  }
}

export type InputEvent =
  | { t: "mouse"; kind: "move" | "down" | "up"; x: number; y: number; button?: "left" | "right" | "middle"; buttons?: number; clicks?: number; mods?: number }
  | { t: "wheel"; x: number; y: number; dx?: number; dy?: number; mods?: number }
  | { t: "key"; kind: "down" | "up"; key?: string; code?: string; keyCode?: number; text?: string; mods?: number; repeat?: boolean; x?: number; y?: number }
  | { t: "text"; text: string; x?: number; y?: number };
const clamp = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/**
 * A browser job's browser: the job's tools start it with this profile and PORT_ARGS; the gateway attaches as soon as it
 * appears. One at a time.
 */
export function jobBrowser(o: { profile: string; throwaway: boolean; job_id: string; summary: string }): Host {
  if (current) throw new Error(`The browser is busy (${current.view.summary}).`);
  if (ownersBrowserProfile(o.profile)) throw new Error("That's a browser's own profile. Tavi's browser only ever uses its own.");
  mkdirSync(o.profile, { recursive: true });
  noSavedSecrets(o.profile);
  try {
    unlinkSync(path.join(o.profile, "DevToolsActivePort")); // last time's, if any: the browser writes a fresh one as it starts
  } catch {
    /* none */
  }
  const host = new Host(null, o.profile, o.throwaway, { mode: "job", job_id: o.job_id, summary: o.summary });
  current = host;
  host.watchForBrowser();
  host.emit();
  audit("brain", "browser.opened", o.job_id, { mode: "job", profile: o.throwaway ? "throwaway" : "saved" });
  return host;
}

/**
 * Start the browser here (for him to sign in somewhere, or a test): Edge, with this profile, the header that makes the
 * gateway refuse it, and no window (it's watched in the desktop's pane). One at a time.
 */
export async function openBrowser(o: { profile: string; throwaway: boolean; mode: "job" | "owner"; job_id: string | null; summary: string; url?: string }): Promise<Host> {
  if (current) throw new Error(`The browser is busy (${current.view.summary}).`);
  if (ownersBrowserProfile(o.profile)) throw new Error("That's a browser's own profile. Tavi's browser only ever uses its own.");
  mkdirSync(o.profile, { recursive: true });
  noSavedSecrets(o.profile);
  const portFile = path.join(o.profile, "DevToolsActivePort");
  try {
    unlinkSync(portFile); // last time's, if any: the browser writes a fresh one as it starts
  } catch {
    /* none */
  }
  const ctx = await chromium.launchPersistentContext(o.profile, {
    channel: "msedge",
    headless: process.env.BROWSER_SHOW !== "1",
    viewport: VIEWPORT,
    locale: "en-AU",
    timezoneId: zone(),
    extraHTTPHeaders: { [AGENT_HEADER]: "1" },
    args: [...PORT_ARGS, "--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication", "--no-first-run"],
  });
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    try {
      port = readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!/^\d+$/.test(port)) {
    await ctx.close().catch(() => undefined);
    throw new Error("The browser started but didn't open its local connection.");
  }
  const host = new Host(ctx, o.profile, o.throwaway, o);
  host.endpoint = `http://127.0.0.1:${port}`;
  current = host;
  ctx.on("page", (p) => host.follow(p));
  ctx.on("close", () => void host.close());
  const first = ctx.pages()[0] ?? (await ctx.newPage());
  host.follow(first);
  if (o.url) await first.goto(o.url).catch(() => undefined);
  host.emit();
  audit(o.mode === "owner" ? "user" : "brain", "browser.opened", o.job_id, { mode: o.mode, profile: o.throwaway ? "throwaway" : "saved" });
  return host;
}
