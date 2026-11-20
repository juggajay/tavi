import "./team.css";
import type { Bot, Row, Live, SafetyLevel } from "../../../../src/hq/contract";
import type { Item, Approval, ClientMessage } from "../../../../src/shared/protocol";
import type { Gateway } from "../gateway";
import type { Animator } from "../pebble/pebble";
import type { Voice } from "../voice";
import { esc } from "../items/describe";
import { dress, face } from "./character";
import { createLayers } from "./layers";
import { elapsed, stepCount, stepJob, stepSummary } from "./progress";
import { phoneWelcome } from "./onboarding";

type TeamBot = Omit<Bot, "box">;
type Safety = { level: SafetyLevel; until?: string | null; pinSet?: boolean };
type State = { on: boolean; bots: TeamBot[]; live: Live[]; safety: Safety; guard: "up" | "down" };
type Hooks = { gateway: Gateway; animator: Animator; voice: Voice; open: (item: Item) => void; approvals: Map<string, Approval>; line: (text: string) => void; say: (text: string) => void; fixtures: boolean };
type Work = { id: string; bot: string; title: string; since: string; doing?: string | null; steps?: number; observed?: boolean };
type Fixture = typeof import("./fixtures");
const shield = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3 20 6v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/></svg>`;
const rank = { open: 0, paused: 1, walled: 2, killed: 3 };
const levelText = { open: "On", paused: "Paused · All bots are paused", walled: "Walled off · Computers and tools are off", killed: "Killed · The bots' space is stopped" };

export function createTeamPhone(h: Hooks) {
  const app = document.getElementById("app")!;
  const wear = dress(h.animator);
  const root = document.createElement("div"); root.className = "team";
  root.innerHTML = `<header class="team-top"><nav aria-label="Your team"></nav><button class="team-shield" aria-label="Safety switch">${shield}</button></header><button class="team-band" hidden></button><div class="team-home" hidden><button class="team-more" aria-label="More"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button><button class="team-conversation" aria-label="Conversation">―</button></div><div class="team-work" hidden></div><div class="team-shade" hidden></div><section class="team-panel" role="dialog" aria-modal="true" hidden tabindex="-1"><header><h2></h2><button class="team-close" aria-label="Close team panel">×</button></header><div class="team-body"></div></section>`;
  app.append(root);
  if (!h.fixtures) void fetch("/api/hq/onboarding").then(r => r.ok ? r.json() : null).then(value => {
    if (value?.welcome && !value.welcome.opened) {
      const screen = phoneWelcome(); app.append(screen);
      const teamNav = root.querySelector<HTMLElement>("nav")!; teamNav.inert = true;
      const retry = () => { if (!document.hidden) void fetch("/api/hq/onboarding").then(r => r.ok ? r.json() : null).then(next => { if (next?.welcome?.opened) { screen.remove(); teamNav.inert = false; document.removeEventListener("visibilitychange", retry); } }).catch(() => {}); };
      document.addEventListener("visibilitychange", retry);
    }
  }).catch(() => {});
  const find = <T extends HTMLElement = HTMLElement>(s: string) => (root.querySelector<T>(s) ?? app.querySelector<T>(s))!;
  document.getElementById("sub")!.after(find(".team-work"));
  const panel = find(".team-panel"), body = find(".team-body"), shade = find(".team-shade");
  let bots: TeamBot[] = [], lives: Live[] = [], selected = "", safety: Safety = { level: "walled" }, guard = "up";
  let fixture: Fixture | undefined, screenClose: (() => void) | undefined, pictureTimer: ReturnType<typeof setInterval> | undefined;
  let mode = "", focusBack: HTMLElement | null = null, rowsRequest = 0, safetyRequest = 0, joined = false;
  let visibleRows = 50, historyLoaded = false, following = true, roomMembers: string[] = [];
  const rows = new Map<string, Row[]>(), generations = new Map<string, number>(), work = new Map<string, Work>();
  const engines = new Map<string, { status?: string; why?: string }>();
  const engineNotices = new Map<string, string>();
  const firstSeen = new Map<string, string>();
  const chips = new Map<string, Row[]>();
  const path = (id: string) => `/api/hq/bots/${encodeURIComponent(id)}`;
  const bot = () => bots.find(b => b.id === selected);
  const send = (message: Record<string, unknown>) => h.gateway.send(message as ClientMessage);
  const error = (text: string) => { let p = body.querySelector<HTMLElement>(".team-error"); if (!p) { p = document.createElement("p"); p.className = "team-error"; p.role = "alert"; body.prepend(p); } p.textContent = text; };
  async function request(url: string, data?: unknown, method = "POST") {
    let response: Response;
    try { response = await fetch(url, { ...(data === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }), signal: AbortSignal.timeout(10_000) }); }
    catch { throw new Error("Couldn't reach the PC. Check it is on and try again."); }
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || value.warning || "That didn't go through. Please try again."), { status: response.status, guard: value.guard });
    return value;
  }
  function cleanup() { screenClose?.(); screenClose = undefined; clearInterval(pictureTimer); pictureTimer = undefined; }
  function close() { cleanup(); if (mode === "room") { void audio.then(a => a.hush()); h.voice.muteVoice(false); } mode = ""; panel.querySelector(".team-compose")?.remove(); body.onscroll = null; panel.hidden = shade.hidden = true; panel.classList.remove("team-full"); app.classList.remove("team-sheet"); focusBack?.focus({ preventScroll: true }); }
  function show(title: string, nextMode: string) {
    cleanup(); panel.querySelector(".team-compose")?.remove(); body.onscroll = null; if (panel.hidden) focusBack = document.activeElement as HTMLElement;
    if (mode === "room" && nextMode !== "room") { void audio.then(a => a.hush()); h.voice.muteVoice(false); }
    app.classList.add("team-sheet");
    mode = nextMode; panel.hidden = shade.hidden = false; panel.classList.toggle("team-full", mode === "screen");
    panel.dataset.layer = nextMode;
    find("h2").textContent = title; body.replaceChildren(); panel.focus({ preventScroll: true });
  }
  find(".team-close").onclick = close; shade.onclick = close;
  const keyboard = () => { const view = visualViewport; root.style.setProperty("--team-lift", `${view && panel.contains(document.activeElement) ? Math.max(0, innerHeight - view.height - view.offsetTop) : 0}px`); };
  visualViewport?.addEventListener("resize", keyboard); panel.addEventListener("focusin", keyboard); panel.addEventListener("focusout", () => setTimeout(keyboard, 0));
  panel.addEventListener("keydown", e => {
    if (e.key === "Escape") return close();
    if (e.key !== "Tab") return;
    const targets = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled),input,textarea,summary,[tabindex='0']")].filter(el => el.getClientRects().length);
    const first = targets[0], last = targets.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  function paintSafety() {
    const band = find<HTMLButtonElement>(".team-band");
    band.hidden = safety.level === "open" && guard === "up";
    band.dataset.level = safety.level;
    band.textContent = guard === "down" ? "Safety guard is down · Tap for help" : levelText[safety.level] + (safety.until ? ` · Until ${new Date(safety.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "");
    app.classList.toggle("team-stopped", !band.hidden);
    find(".team-shield").setAttribute("aria-label", `Safety switch: ${guard === "down" ? "Guard down" : levelText[safety.level].split(" · ")[0]}`);
    if (guard === "down" || safety.level !== "open") {
      screenClose?.(); screenClose = undefined; h.voice.end();
      const status = body.querySelector<HTMLElement>(".team-screen-status");
      if (status) status.textContent = "The computer is stopped by the safety switch.";
    }
    updateLive(false);
  }
  function acceptSafety(value: Safety | { safety?: Safety; guard?: string; level?: SafetyLevel }) {
    if ("guard" in value && value.guard) guard = value.guard;
    const next = "safety" in value ? value.safety : "level" in value && value.level ? value as Safety : undefined;
    if (next) safety = next;
    paintSafety();
  }
  async function setSafety(level: SafetyLevel, extra: { minutes?: number; pin?: string } = {}) {
    const order = ++safetyRequest;
    try {
      if (fixture && level === "open" && extra.pin !== "2468") throw new Error("That PIN wasn't accepted. Try again.");
      const result = fixture ? { safety: { level, until: extra.minutes ? new Date(Date.now() + extra.minutes * 60_000).toISOString() : null, pinSet: true } } : await request("/api/hq/safety", { level, ...extra });
      if (order !== safetyRequest) return;
      acceptSafety(result);
      if (result.guard === "down" || result.ok === false) { guard = "down"; paintSafety(); safetyPanel(); return; }
      safetyPanel(level !== "open");
    } catch (e) { if (order === safetyRequest) { if ((e as { guard?: string }).guard === "down") { guard = "down"; paintSafety(); safetyPanel(); } else error((e as Error).message); } }
  }
  function safetyPanel(timer = false) {
    show("Safety switch", "safety");
    body.innerHTML = `${guard === "down" ? `<p class="team-warning">The safety guard isn't answering. Tavi can stop work on this side, but the bots' space may still be running. On the PC, run <code>npm run guard -- kill</code> to stop it.</p>` : `<p class="team-muted">${esc(levelText[safety.level])}</p>`}<div class="team-safety-choices">${([['paused','Pause','Freeze every bot where it is.'],['walled','Wall off','Turn off computers and tools.'],['killed','Kill','Stop the whole bots’ space.']] as const).map(([level,title,words]) => `<button data-level="${level}"><b>${title}</b><span>${words}</span></button>`).join("")}</div>${safety.level !== "open" ? `<button class="team-primary" data-on>Switch back on</button>` : ""}${timer ? `<p>How long?</p><div class="team-timers"><button data-minutes="15">15 min</button><button data-minutes="30">30 min</button><button data-minutes="60">1 hour</button></div><p class="team-muted">Without a timer, it stays off until you switch it back on.</p>` : ""}`;
    body.querySelectorAll<HTMLButtonElement>("[data-level]").forEach(b => b.onclick = () => {
      const level = b.dataset.level as SafetyLevel;
      if (rank[level] < rank[safety.level]) return pinPanel(level);
      void setSafety(level);
    });
    body.querySelectorAll<HTMLButtonElement>("[data-minutes]").forEach(b => b.onclick = () => void setSafety(safety.level, { minutes: Number(b.dataset.minutes) }));
    body.querySelector<HTMLButtonElement>("[data-on]")?.addEventListener("click", () => pinPanel("open"));
  }
  function pinPanel(level: SafetyLevel) {
    show("Enter your PIN", "pin");
    body.innerHTML = `<p>Your PIN is needed to turn things back on.</p><form class="team-pin"><label for="team-pin">PIN</label><input id="team-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="64" required><button class="team-primary">Continue</button></form>`;
    body.querySelector("form")!.onsubmit = e => { e.preventDefault(); const input = body.querySelector("input")!; const pin = input.value; input.value = ""; void setSafety(level, { pin }); };
    body.querySelector("input")!.focus();
  }
  find(".team-shield").onclick = () => safetyPanel(); find(".team-band").onclick = () => safetyPanel();
  function paintTeam() {
    const nav = find("nav"); nav.hidden = bots.length < 2; nav.innerHTML = bots.map(b => `<button class="team-face" data-bot="${esc(b.id)}" aria-label="Talk to ${esc(b.name)}" aria-pressed="${b.id === selected}">${face(b.look)}<span>${esc(b.name)}</span></button>`).join("");
    nav.querySelectorAll<HTMLButtonElement>("button").forEach(button => {
      let timer: ReturnType<typeof setTimeout> | undefined, long = false;
      const cancel = () => clearTimeout(timer);
      button.onpointerdown = () => { long = false; timer = setTimeout(() => { long = true; botCard(button.dataset.bot!); }, 500); };
      button.onpointerup = cancel; button.onpointercancel = cancel; button.onpointerleave = cancel;
      button.onclick = () => { if (!long) choose(button.dataset.bot!); };
      button.oncontextmenu = e => { e.preventDefault(); cancel(); long = true; botCard(button.dataset.bot!); };
    });
    find(".team-home").hidden = !bots.length;
  }
  function choose(id: string) {
    const next = bots.find(b => b.id === id); if (!next) { selected = ""; paintTeam(); return; }
    const switched = selected && selected !== id;
    selected = id; wear(next.look); paintTeam();
    document.getElementById("charBtn")!.setAttribute("aria-label", `Talk to ${next.name}`);
    document.getElementById("stripTalk")!.setAttribute("aria-label", `Talk to ${next.name}`);
    (document.getElementById("typeIn") as HTMLInputElement).placeholder = `Message ${next.name}`;
    if (switched) {
      if (h.voice.on) { h.voice.end(); void h.voice.start(); }
    }
    caption();
    updateLive(); void loadRows(id);
    if (mode === "conversation") conversation();
  }
  function merge(row: Row) {
    const generation = generations.get(row.bot) ?? 0;
    if (row.generation < generation) return;
    if (row.generation > generation) { rows.set(row.bot, []); generations.set(row.bot, row.generation); }
    const list = rows.get(row.bot) ?? [], old = list.findIndex(r => r.seq === row.seq);
    if (old >= 0 && list[old].rev >= row.rev) return;
    if (old >= 0) list[old] = row; else list.push(row);
    rows.set(row.bot, list.sort((a,b) => a.seq - b.seq));
  }
  async function loadRows(id: string) {
    const order = ++rowsRequest;
    try {
      const result = fixture ? { generation: 1, rows: fixture.rows.filter(r => r.bot === id) } : await request(`${path(id)}/rows`);
      if (order !== rowsRequest || id !== selected) return;
      if (result.generation < (generations.get(id) ?? 0)) return;
      if (result.generation > (generations.get(id) ?? 0)) { rows.set(id, []); generations.set(id, result.generation); }
      result.rows.forEach(merge); caption(); updateLive();
      if (mode === "conversation") renderRows();
    } catch { if (mode === "conversation" && id === selected) error("Couldn't load the conversation. Close it and try again."); }
  }
  function conversation() {
    show(`${bot()?.name ?? "Bot"} · Conversation`, "conversation");
    visibleRows = 50; historyLoaded = false; following = true;
    const footer = document.createElement("form"); footer.className = "team-compose";
    footer.innerHTML = `<button type="button" aria-label="Conversation menu">•••</button><input aria-label="Reply" placeholder="Message ${esc(bot()?.name ?? "the bot")}" required><button aria-label="Send reply">↑</button>`;
    panel.append(footer);
    footer.querySelector("button")!.onclick = conversationMenu;
    footer.onsubmit = e => { e.preventDefault(); const input = footer.querySelector("input")!; if (input.value.trim()) { const message = { type: "typed", bot: selected, text: input.value.trim(), request_id: crypto.randomUUID() }; if (!api.previewTyped(message as ClientMessage)) send(message); input.value = ""; following = true; } };
    body.onscroll = () => { following = body.scrollHeight - body.scrollTop - body.clientHeight < 48; if (body.scrollTop < 12) void older(); };
    renderRows(true);
  }
  async function older() {
    if (mode !== "conversation") return;
    const id = selected, before = body.scrollHeight;
    if (!historyLoaded && !fixture) {
      historyLoaded = true;
      try { const result = await request(`${path(id)}/rows?generation=${generations.get(id) ?? bot()?.generation ?? 1}&after=0`); if (selected !== id || mode !== "conversation") return; result.rows.forEach(merge); }
      catch { error("Couldn't load older words. Scroll up to try again."); historyLoaded = false; return; }
    }
    if (visibleRows >= (rows.get(id)?.length ?? 0)) return;
    visibleRows += 50; renderRows(); body.scrollTop += body.scrollHeight - before;
  }
  function conversationMenu() {
    show("Conversation", "conversation-menu");
    body.innerHTML = `<button class="team-card" data-fresh>New conversation</button><button class="team-card" data-more>More</button>`;
    body.querySelector<HTMLButtonElement>("[data-fresh]")!.onclick = () => void fresh(selected);
    body.querySelector<HTMLButtonElement>("[data-more]")!.onclick = morePanel;
  }
  async function fresh(id: string) {
    show("New conversation", "fresh");
    body.innerHTML = `<p>Start a fresh conversation with ${esc(bots.find(b => b.id === id)?.name ?? "this bot")}? Your earlier words are kept.</p><button class="team-primary">Start fresh</button>`;
    body.querySelector("button")!.onclick = async () => {
      try { const result = fixture ? { generation: (generations.get(id) ?? 1) + 1 } : await request(`${path(id)}/fresh`, {}); rows.set(id, []); generations.set(id, result.generation); choose(id); conversation(); }
      catch (e) { error((e as Error).message); }
    };
  }
  function renderRows(bottom = false) {
    const openEntries = new Set([...body.querySelectorAll<HTMLDetailsElement>("details[open]")].map(d => d.dataset.entry));
    const scroll = body.scrollTop;
    const list = (rows.get(selected) ?? []).slice(-visibleRows);
    const grouped = new Map<string, Row[]>();
    for (const row of list) { const job = stepJob(row); if (job) grouped.set(job, [...(grouped.get(job) ?? []), row]); }
    const shown = new Set<string>(); chips.clear();
    let html = "";
    for (let i = 0; i < list.length; i++) {
      const row = list[i], b = row.body;
      if (b.kind === "step") {
        const job = stepJob(row), key = job ? `job-${job}` : `steps-${row.seq}`;
        if (shown.has(key)) continue;
        shown.add(key);
        const steps = job ? grouped.get(job)! : [row];
        if (!job) while (list[i + 1]?.body.kind === "step" && !stepJob(list[i + 1])) steps.push(list[++i]);
        chips.set(key, steps);
        html += `<details data-entry="${esc(key)}" data-steps="${row.seq}" ${job ? `data-job="${esc(job)}"` : ""} ${openEntries.has(key) ? "open" : ""}><summary>${esc(stepSummary(steps, jobs().find(j => j.id === job)))}</summary><ol>${steps.map(r => r.body.kind === "step" ? `<li>${esc(r.body.label)} <span class="team-muted">${r.body.state === "running" ? "Working" : r.body.state === "failed" ? "Couldn't finish" : "Done"}</span></li>` : "").join("")}</ol></details>`;
      } else if (b.kind === "message") {
        const text = b.text.trim();
        if (b.from === "system" || b.from === "other-bot") {
          const key = `team-${row.seq}`;
          html += `<details class="team-entry" data-entry="${key}" ${openEntries.has(key) ? "open" : ""}><summary><span>${esc(b.who || (b.from === "system" ? "Tavi" : "Team"))} · ${esc(text.split("\n")[0])}</span></summary><p>${esc(text)}</p></details>`;
        } else html += `<article class="team-message ${b.from === "owner" ? "team-you" : "team-bot"}"><small>${esc(b.from === "owner" ? "You" : b.who || bot()?.name || "Bot")}</small><p>${esc(text)}</p></article>`;
      }
      else if (b.kind === "notice") html += `<aside class="team-notice"><p>${esc(b.text)}</p>${b.action === "sign_in" ? "<small>Sign in on the PC.</small>" : b.action === "open_switch" ? '<button data-switch>Open safety switch</button>' : ""}</aside>`;
      else html += `<button class="team-card" data-ref="${esc(b.ref)}" data-card="${b.card}" ${b.card === "approval" && b.state && b.state !== "waiting" ? "disabled" : ""}><small>${b.card === "approval" ? "Needs your OK" : "Open page"}</small><b>${esc(b.title)}</b>${b.state && b.state !== "waiting" ? `<span>${esc(b.state)}</span>` : ""}</button>${b.card === "approval" && b.state === "waiting" ? `<div class="team-work-actions"><button data-decide="approve" data-approval="${esc(b.ref)}">Approve</button><button data-decide="reject" data-approval="${esc(b.ref)}">Don't</button></div>` : ""}`;
    }
    const engineNotice = engineNotices.get(selected);
    if (engineNotice && !list.some(r => r.body.kind === "notice" && r.body.text === engineNotice)) html += `<aside class="team-notice"><p>${esc(engineNotice)}</p><small>Sign in on the PC.</small></aside>`;
    body.innerHTML = html || `<p class="team-muted">Your conversation with ${esc(bot()?.name ?? "this bot")} will appear here.</p>`;
    body.scrollTop = bottom || following ? body.scrollHeight : scroll;
    body.querySelectorAll<HTMLButtonElement>("[data-ref]").forEach(b => b.onclick = () => void openCard(b.dataset.ref!, b.dataset.card!));
    body.querySelectorAll<HTMLButtonElement>("[data-switch]").forEach(b => b.onclick = () => safetyPanel());
    body.querySelectorAll<HTMLButtonElement>("[data-decide]").forEach(b => b.onclick = () => {
      const approval = h.approvals.get(b.dataset.approval!);
      if (!approval) return error("That approval is no longer waiting. Open its page to check.");
      if (fixture) { h.approvals.delete(approval.id); for (const list of rows.values()) for (const row of list) if (row.body.kind === "card" && row.body.ref === approval.id) row.body.state = b.dataset.decide === "approve" ? "approved" : "declined"; renderRows(); updateLive(); }
      else { b.disabled = true; send({ type: "decide", id: approval.id, nonce: approval.nonce, decision: b.dataset.decide }); }
    });
  }
  async function openCard(ref: string, kind: string) {
    try {
      let item: Item;
      if (fixture) item = kind === "approval" ? fixture.draft : fixture.plan;
      else {
        const approval = h.approvals.get(ref) as (Approval & { item_id?: string }) | undefined;
        if (kind === "approval" && !approval) throw new Error("That approval is no longer waiting. Ask the bot to show it again.");
        const id = kind === "approval" ? approval?.item_id : ref;
        if (!id) throw new Error("The approval's page hasn't arrived yet. Please try again.");
        item = (await request(`/api/items/${encodeURIComponent(id)}`)).item;
      }
      close(); h.open(item);
    } catch (e) { error((e as Error).message); }
  }
  find(".team-conversation").onclick = conversation;
  // Pull the conversation up from its handle, as well as tapping it.
  let pullY = 0;
  find(".team-conversation").onpointerdown = e => { pullY = e.clientY; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  find(".team-conversation").onpointerup = e => { if (pullY - e.clientY > 25) conversation(); };
  function jobs(): Work[] {
    const all = new Map(work);
    for (const live of lives) {
      for (const job of live.work ?? []) { if (!firstSeen.has(job.id)) firstSeen.set(job.id, new Date().toISOString()); all.set(job.id, { ...job, bot: live.bot, since: job.since || firstSeen.get(job.id)!, observed: !job.since }); }
      const key = `live-${live.bot}`;
      if (["queued", "thinking", "working"].includes(live.state)) { if (!firstSeen.has(key)) firstSeen.set(key, new Date().toISOString()); all.set(key, { id: key, bot: live.bot, title: live.state === "thinking" ? "Thinking" : live.state === "queued" ? "Waiting to start" : "Your request", doing: live.doing, since: live.since || firstSeen.get(key)!, steps: live.steps }); }
      else firstSeen.delete(key);
    }
    return [...all.values()];
  }
  function caption() {
    const message = [...(rows.get(selected) ?? [])].reverse().find(r => r.body.kind === "message" && r.body.from === "bot" && !r.body.streaming);
    h.line(message?.body.kind === "message" ? message.body.text.trim() : "");
  }
  function workText(job: Work) { return `${job.doing || job.title} · ${job.observed ? "Seen for " : ""}${elapsed(job.since)}${job.steps ? " · " + stepCount(job.steps) : ""}`; }
  function updateLive(_words = true) {
    const live = lives.find(l => l.bot === selected);
    const all = jobs(), own = all.filter(w => w.bot === selected), stopped = safety.level !== "open" || guard === "down";
    const longer = own.filter(w => !w.id.startsWith("live-")), shown = longer.length ? longer : own;
    const attention = (id: string) => lives.find(l => l.bot === id)?.state === "waiting_for_owner" || (rows.get(id) ?? []).some(r => r.body.kind === "card" && r.body.card === "approval" && r.body.state === "waiting" && h.approvals.has(r.body.ref));
    const state = stopped || live?.reason === "engine_down" ? "stopped" : attention(selected) ? "needs-you" : h.animator.state === "speaking" ? "speaking" : own.length ? (live?.state === "thinking" && !live.work?.length ? "thinking" : "working") : h.voice.on ? h.animator.state : "idle";
    app.dataset.teamState = state;
    h.animator.working = !stopped && own.length > 0;
    document.getElementById("charBtn")!.classList.toggle("team-working", !stopped && own.length > 0);
    if (!h.voice.on && h.animator.state !== "speaking") h.animator.set(state === "thinking" ? "thinking" : "idle");
    document.getElementById("charBtn")!.setAttribute("aria-description", state.replaceAll("-", " "));
    root.querySelectorAll<HTMLElement>("[data-bot]").forEach(el => { el.dataset.busy = String(!stopped && all.some(w => w.bot === el.dataset.bot)); el.dataset.needs = String(attention(el.dataset.bot!)); });
    const host = find(".team-work"); host.hidden = !own.length || stopped;
    if (shown.length) { let button = host.querySelector<HTMLButtonElement>("[data-list]"); if (!button) { button = document.createElement("button"); button.dataset.list = ""; host.append(button); button.onclick = workPanel; } button.textContent = workText(shown[0]) + (shown.length > 1 ? ` · +${shown.length - 1} more` : ""); }
    else host.replaceChildren();
  }
  function workButtons(job: Work) { return `<button data-work="progress" data-job="${esc(job.id)}">How's it going</button><button data-work="quick" data-job="${esc(job.id)}">Quick version</button><button data-work="stop" data-job="${esc(job.id)}">Stop</button>`; }
  function bindWork(host: HTMLElement) {
    host.querySelectorAll<HTMLButtonElement>("[data-work]").forEach(b => b.onclick = async () => {
      const job = jobs().find(j => j.id === b.dataset.job); if (!job) return;
      b.disabled = true;
      try {
        const action = b.dataset.work;
        if (fixture) { error(action === "stop" ? "Stopped that work." : action === "quick" ? "The gallery is open. Lunch details are still being checked." : "The plan is almost ready. Checking the opening hours now."); }
        else if (action === "stop" && !job.id.startsWith("live-")) send({ type: "cancel", job_id: job.id });
        else if (action === "stop") await request(`${path(job.bot)}/stop`, {});
        else send({ type: "typed", bot: job.bot, request_id: crypto.randomUUID(), text: `${action === "quick" ? "Give me the quick version of" : "How's it going with"} this work: ${job.title}` });
        if (action === "stop" && fixture) { work.delete(job.id); lives = lives.map(l => l.bot === job.bot ? job.id.startsWith("live-") ? { ...l, state: "idle" as const, doing: null } : { ...l, work: l.work?.filter(w => w.id !== job.id) } : l); updateLive(); }
      } catch (e) { error((e as Error).message); } finally { b.disabled = false; }
    });
  }
  function workPanel() {
    show("Work in progress", "work");
    renderWork();
  }
  function renderWork() {
    const scroll = body.scrollTop;
    body.innerHTML = jobs().filter(j => j.bot === selected).map(j => {
      const allSteps = (rows.get(j.bot) ?? []).filter(r => r.body.kind === "step");
      const namedSteps = allSteps.filter(r => stepJob(r) === j.id);
      const steps = namedSteps.length ? namedSteps : allSteps.filter(r => !stepJob(r) && Date.parse(r.ts) >= Date.parse(j.since));
      const shared = !j.id.startsWith("live-") && steps.some(r => !stepJob(r));
      return `<article class="team-job"><small data-time="${esc(j.id)}">${esc(workText(j))}</small><h3>${esc(j.title)}</h3><div class="team-work-actions">${workButtons(j)}</div>${shared ? '<p class="team-muted">Steps from this bot since the work started. Older steps do not say which piece of work they belong to.</p>' : ""}<ol>${steps.map(r => r.body.kind === "step" ? `<li>${esc(r.body.label)}<span class="team-muted">${r.body.state === "running" ? "Working" : r.body.state === "ok" ? "Done" : "Couldn't finish"}</span></li>` : "").join("")}</ol>${!steps.length ? '<p class="team-muted">This work has not shared its individual steps yet.</p>' : ""}</article>`;
    }).join("") || "<p>Nothing is running.</p>";
    bindWork(body); body.scrollTop = scroll;
  }
  function botCard(id: string) { void layers.botCard(id); }
  async function screen(b: TeamBot) {
    show(`${b.name}'s computer · Watch only`, "screen");
    if (safety.level !== "open" || guard === "down") { error("The computer is stopped by the safety switch."); return; }
    body.innerHTML = `<p class="team-muted">Pinch to zoom. Turn sideways for a wider view. Taking control stays on the PC.</p><div class="team-screen-host"></div><p class="team-screen-status" role="status">Connecting to the computer…</p>`;
    const host = body.querySelector<HTMLElement>(".team-screen-host")!, status = body.querySelector<HTMLElement>(".team-screen-status")!;
    let disposed = false; screenClose = () => { disposed = true; host.replaceChildren(); };
    try {
      const { watch } = await import("./screen"); if (disposed) return;
      const stop = await watch(host, b.id, fixture?.still, text => status.textContent = text);
      if (disposed) stop(); else screenClose = () => { disposed = true; stop(); };
    } catch { if (!disposed) status.textContent = "Couldn't open the screen. Close it and try again."; }
  }
  function roomPanel() {
    show("Ask the team", "room");
    body.innerHTML = `<p>Choose two to four bots. Each answers in its own words.</p><form class="team-room-form"><div class="team-members">${bots.map((b,i) => `<label>${face(b.look)}<span>${esc(b.name)}</span><input type="checkbox" name="bot" value="${esc(b.id)}" ${i < 2 ? "checked" : ""}></label>`).join("")}</div><label for="team-question">Your question</label><textarea id="team-question" required maxlength="12000" placeholder="What shall we do on Sunday?"></textarea><button class="team-primary">Ask once</button></form><button type="button" data-end class="team-card">End</button><p class="team-muted">End closes the room. Replies already started finish in each bot's conversation.</p><div class="team-room-answers" aria-live="polite"></div>`;
    body.querySelector<HTMLButtonElement>("[data-end]")!.onclick = () => { roomMembers = []; close(); };
    body.querySelector("form")!.onsubmit = async e => {
      e.preventDefault(); const members = [...body.querySelectorAll<HTMLInputElement>("input:checked")].map(i => i.value);
      if (members.length < 2 || members.length > 4) return error("Choose two to four bots.");
      roomMembers = members;
      const text = body.querySelector("textarea")!.value.trim(); if (!text) return;
      const button = body.querySelector<HTMLButtonElement>("form button")!; button.disabled = true;
      try {
        if (fixture) { for (const id of members) roomAnswer(id, `${bots.find(b => b.id === id)?.name === "Scout" ? "The gallery opens at ten. I'd start there." : "Leave the afternoon free for a walk and a quiet coffee."}`); }
        else { await request("/api/hq/rooms/ask", { bots: members, text }); }
      } catch (e) { error((e as Error).message); } finally { button.disabled = false; }
    };
  }
  function roomAnswer(id: string, text: string) {
    const answers = body.querySelector(".team-room-answers"); if (!answers) return;
    let article = answers.querySelector<HTMLElement>(`[data-answer="${CSS.escape(id)}"]`);
    if (!article) { article = document.createElement("article"); article.className = "team-message"; article.dataset.answer = id; answers.append(article); }
    article.innerHTML = `<small>${esc(bots.find(b => b.id === id)?.name ?? id)}</small><p>${esc(text)}</p>`;
    answers.scrollIntoView({ block: "end", behavior: "smooth" });
  }
  const layers = createLayers({ bots: () => bots, rows, engines, selected: () => selected, fixture: () => fixture, body, show, close, request, error, choose, conversation, fresh, screen, roomPanel, safetyPanel, openCard, open: h.open,
    settings: () => {
      close(); document.dispatchEvent(new Event("phone-settings"));
      const quick = document.getElementById("quick")!;
      if (!quick.querySelector(".team-settings-header")) { const header = document.createElement("header"); header.className = "team-settings-header"; header.innerHTML = '<h2>Settings</h2><button aria-label="Close settings">×</button>'; header.querySelector("button")!.onclick = () => document.getElementById("quickScrim")!.click(); quick.prepend(header); }
    },
    tell: text => { const lead = bots.find(b => b.lead) ?? bots[0]; if (!lead) return; choose(lead.id); conversation(); const input = panel.querySelector<HTMLInputElement>(".team-compose input")!; input.value = text; input.focus(); },
  });
  function morePanel() { layers.more(); }
  find(".team-more").onclick = morePanel;
  let swipeX = 0, swipeY = 0;
  const stage = document.getElementById("stage")!;
  stage.addEventListener("pointerdown", e => { swipeX = e.clientX; swipeY = e.clientY; });
  stage.addEventListener("pointerup", e => { if (swipeX - e.clientX > 65 && Math.abs(swipeY - e.clientY) < 60 && panel.hidden) setTimeout(morePanel, 80); });
  find(".team-conversation").oncontextmenu = e => { e.preventDefault(); morePanel(); };
  const audio = import("../table-audio").then(({ createTableAudio }) => createTableAudio({ send, context: () => h.voice.audioContext, soundOn: () => h.voice.on, onSpeaking: who => h.animator.set(who ? "speaking" : "listening") }));
  // The voice code asks for the microphone inside the original tap. Add only the chosen bot to its session request.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url, location.href).pathname === "/api/session" && selected && typeof options?.body === "string") {
      options = { ...options, body: JSON.stringify({ ...JSON.parse(options.body), bot: selected }) };
    }
    return nativeFetch(input, options);
  };
  function hello() { if (!fixture && bots.length) send({ type: "hello", v: 2, client: "phone", id: h.gateway.id, hq: true }); }
  // A phone goes to sleep and its line drops. What it showed when it slept may no longer be true (a job finished, another
  // started), and updates sent meanwhile are gone. So on every rejoin, and whenever the app comes back into view, ask for
  // the whole state again rather than trusting what is on screen.
  let syncing = false;
  // Counts of what has arrived over the live link, so a state that was asked for earlier never replaces something newer.
  const seen = { bots: 0, safety: 0, live: new Map<string, number>() };
  async function resync() {
    if (fixture || syncing || !bots.length) return;
    syncing = true;
    try {
      const before = { bots: seen.bots, safety: seen.safety, live: new Map(seen.live) };
      const reply = await fetch("/api/hq/state", { signal: AbortSignal.timeout(4000) });
      const s = reply.ok ? await reply.json() as State : null;
      if (!s?.on) return;
      if (before.bots === seen.bots) bots = s.bots;
      const unchanged = (id: string) => (before.live.get(id) ?? 0) === (seen.live.get(id) ?? 0);
      lives = lives.filter(l => !unchanged(l.bot)).concat(s.live.filter(l => unchanged(l.bot)));
      for (const [id, job] of work) if (unchanged(job.bot)) work.delete(id);
      if (before.safety === seen.safety) { guard = s.guard; acceptSafety({ safety: s.safety, guard: s.guard }); }
      if (!bots.some(b => b.id === selected)) choose(bots.find(b => b.lead)?.id ?? bots[0]?.id ?? "");
      updateLive(); if (mode === "work") renderWork();
    } catch { /* The next rejoin tries again. */ } finally { syncing = false; }
  }
  h.gateway.on("hello", () => { if (bots.length) { void resync(); void loadRows(selected); } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void resync(); });
  // Rejoin after a dropped line without changing the shared connection used by the older apps.
  let wasOpen = h.gateway.status === "open";
  setInterval(() => { const open = h.gateway.status === "open"; if (open && !wasOpen) hello(); wasOpen = open; if (!document.hidden) updateWorkTime(); }, 1000);
  function updateWorkTime() {
    updateLive(false);
    if (mode === "work") body.querySelectorAll<HTMLElement>("[data-time]").forEach(el => { const job = jobs().find(j => j.id === el.dataset.time); if (job) el.textContent = workText(job); });
    if (mode === "conversation") body.querySelectorAll<HTMLDetailsElement>("details[data-steps]").forEach(el => { const steps = chips.get(el.dataset.entry!); if (steps) el.querySelector("summary")!.textContent = stepSummary(steps, jobs().find(j => j.id === el.dataset.job)); });
  }
  h.gateway.on("*", raw => {
    const m = raw as unknown as { type: string; row?: Row; live?: Live; bots?: TeamBot[]; safety?: Safety; guard?: string; bot?: string; engine?: { status?: string; why?: string; resetsAt?: string; limits?: { resetsAt?: string } }; generation?: number; seq?: number; phase?: string; title?: string; doing?: string; job_id?: string; speaker?: string; text?: string; audio?: string; id?: string };
    if (m.type === "hq_row" && m.row) { merge(m.row); if (mode === "conversation" && m.row.bot === selected) renderRows(); if (m.row.bot === selected && m.row.body.kind === "message" && m.row.body.from === "bot") { caption(); if (m.row.body.via === "typed" && !m.row.body.streaming && !h.voice.on) h.say(m.row.body.text); } updateLive(); if (mode === "work") renderWork(); if (mode === "room" && roomMembers.includes(m.row.bot) && m.row.body.kind === "message" && m.row.body.from === "bot") roomAnswer(m.row.bot, m.row.body.text); }
    else if (m.type === "hq_row_dropped" && m.bot) { rows.set(m.bot, (rows.get(m.bot) ?? []).filter(r => r.generation !== m.generation || r.seq !== m.seq)); if (mode === "conversation") renderRows(); }
    else if (m.type === "hq_live" && m.live) { seen.live.set(m.live.bot, (seen.live.get(m.live.bot) ?? 0) + 1); lives = lives.filter(l => l.bot !== m.live!.bot).concat(m.live); for (const [id, job] of work) if (job.bot === m.live.bot && m.live.work) work.delete(id); updateLive(); if (mode === "work") renderWork(); if (mode === "conversation" && m.live.bot === selected) renderRows(); }
    else if (m.type === "hq_bots" && m.bots) { seen.bots++; bots = m.bots; choose(bot()?.id ?? bots.find(b => b.lead)?.id ?? bots[0]?.id ?? ""); }
    else if (m.type === "hq_safety" && m.safety) { seen.safety++; acceptSafety({ safety: m.safety, guard: m.guard }); if (mode === "safety") safetyPanel(); }
    else if (m.type === "hq_engine" && m.bot && m.engine) {
      engines.set(m.bot, m.engine);
      if (!["not_signed_in", "limit", "limited"].includes(m.engine.status ?? "")) { engineNotices.delete(m.bot); if (mode === "conversation" && m.bot === selected) renderRows(); return; }
      const until = m.engine.resetsAt || m.engine.limits?.resetsAt;
      const text = m.engine.status === "not_signed_in" ? "This subscription isn't signed in. Sign in on the PC." : `This subscription has reached its limit.${until ? ` Try again after ${new Date(until).toLocaleString()}.` : " The subscription hasn't given a reset time yet."}`;
      engineNotices.set(m.bot, text); engines.set(m.bot, { ...m.engine, why: text });
      if (mode === "conversation" && m.bot === selected) renderRows();
    } else if (m.type === "background" && m.job_id) {
      if (m.phase === "end") { work.delete(m.job_id); firstSeen.delete(m.job_id); } else if (m.bot) work.set(m.job_id, { id: m.job_id, bot: m.bot, title: m.title || "Your request", doing: m.doing, since: work.get(m.job_id)?.since || new Date().toISOString(), observed: true }); updateLive(); if (mode === "work") renderWork();
    // Another bot's words on a call are a recording in that bot's voice. Play it whatever is on screen, not only in a room:
    // if the phone does not play and confirm it, the server waits out a long timer before the next thing is said.
    } else if (m.type === "table_say" && h.voice.on && m.audio && m.text) { h.voice.muteVoice(true); void audio.then(a => a.say({ id: m.id!, speaker: m.speaker === "pebble" ? "pebble" : "guest", text: m.text!, audio: m.audio! })); }
    else if (m.type === "table_hush") void audio.then(a => a.hush());
  });
  document.addEventListener("phone-feedback", event => { const text = (event as CustomEvent<string>).detail; if (/^(Morning\.|Afternoon\.|Evening\.|Tap me and say hello\.|Go ahead\.|Muted\. Tap to talk\.)/.test(text)) return; if (mode) error(text); else { show("A message", "feedback"); error(text); } });
  document.addEventListener("visibilitychange", () => { if (document.hidden && mode === "screen") close(); });
  const api = {
    get selected() { return selected; }, get busy() { return !panel.hidden; },
    previewTyped(message: ClientMessage) {
      if (!fixture || message.type !== "typed") return false;
      const seq = Math.max(0, ...(rows.get(selected) ?? []).map(r => r.seq)) + 1;
      merge(fixture.row(selected, seq, { kind: "message", from: "owner", text: message.text }));
      const text = "I'll compare the options and bring you a short answer.";
      merge(fixture.row(selected, seq + 1, { kind: "message", from: "bot", text }));
      h.line(text); if (mode === "conversation") renderRows(); return true;
    },
    voice(kind: "heard" | "level" | "end", value: string | number) { if (mode !== "room") return; void audio.then(a => { if (kind === "heard") a.ownerHeard(String(value)); else if (kind === "level") a.liveLevel(Number(value)); else { a.hush(); h.voice.muteVoice(false); } }); },
    more: morePanel,
    safety: acceptSafety,
    previewApproval(button: HTMLButtonElement) { if (!fixture) return false; button.disabled = true; button.textContent = "Preview: approved";  h.approvals.delete(fixture.approval.id); for (const list of rows.values()) for (const row of list) if (row.body.kind === "card" && row.body.ref === fixture.approval.id) row.body.state = "approved"; return true; },
    state(s: State) { if (!s.on) return; bots = s.bots; lives = s.live; guard = s.guard; acceptSafety(s.safety); app.classList.add("team-on"); choose(selected || bots.find(b => b.lead)?.id || bots[0]?.id || ""); if (!joined) { joined = true; hello(); } },
    async preview() {
      fixture = await import("./fixtures"); h.approvals.set(fixture.approval.id, fixture.approval);
      fixture.rows.forEach(merge);
      const params = new URLSearchParams(location.search), level = params.get("safety");
      this.state({ on: true, bots: fixture.bots, live: fixture.live, safety: { level: level && level in rank ? level as SafetyLevel : "open", pinSet: true }, guard: params.has("guard-down") ? "down" : "up" });
    },
  };
  return api;
}
export type TeamPhone = ReturnType<typeof createTeamPhone>;
