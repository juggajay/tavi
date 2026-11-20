import { earlier, savedValue } from "../../../src/shared/earlier";
// The desktop app (DESIGN §6). Ported from mockups/v2/src/desktop.src.html and driven by the gateway: a slim sidebar
// with Pebble, one conversation (the same thread as the phone) with whatever was shown opening on the right, and the
// Activity, Memory, Connections, Files and Settings pages. Framework-free, like the phone app.
import "../shared/base.css";
import "./desktop.css";
import { $, anim, api, applySettings, esc, gw, IC, kindIcon, onStatus, PAGES, reduce, state, time, toast, type Page } from "./core";
import { SheetViewer, type Zoomable } from "../shared/sheet-viewer/viewer";
import { SketchView } from "../shared/items/sketch";
import { modelView, type ModelView } from "../shared/items/model";
import type { CamState } from "../shared/model3d-viewer/viewer";
import { createVoice } from "../shared/voice";
import * as Palette from "../shared/palette";
import { DRAFT_CHIP, linkRow, refViewer } from "../shared/items/describe";
import { NEWER_NEEDED, createUpdater, takeReopen } from "../shared/update";
import { createDesktopTable } from "./table";
// The other pages are a separate chunk, fetched the first time one is opened (or when the browser is idle).
const pages = () => import("./pages");
const renderPage: (typeof import("./pages"))["renderPage"] = async (p, nav) => { await nameReady; return (await pages()).renderPage(p, nav); };
import type { Approval, BrowserView, DraftPayload, Item, Pin, ServerBrain, ServerMessage, SheetPayload } from "../../../src/shared/protocol";
import type { LiveView } from "./browser";

import { appName, findAppName } from "../shared/app-name";
const nameReady = findAppName();

const NAV = [
  ["conversation", "Conversation", '<path d="M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H9l-3.5 3v-3a2 2 0 0 1-2-2z"/>', 'stroke-linejoin="round"'],
  ["activity", "Activity", '<circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 1.5"/>', 'stroke-linecap="round"'],
  ["memory", "Memory", '<path d="M5 3.5h8.5a1.5 1.5 0 0 1 1.5 1.5v11.5H6.5A1.5 1.5 0 0 1 5 15z"/><path d="M5 14.5a1.5 1.5 0 0 1 1.5-1.5H15M8 7h4"/>', 'stroke-linejoin="round"'],
  ["connections", "Connections", '<path d="M8.5 11.5l3-3M7 9.5 5.5 11a2.5 2.5 0 0 0 3.5 3.5l1.5-1.5M13 10.5l1.5-1.5A2.5 2.5 0 0 0 11 5.5L9.5 7"/>', 'stroke-linecap="round"'],
  ["files", "Files", '<path d="M3.5 6a1.5 1.5 0 0 1 1.5-1.5h3l1.5 2h5.5A1.5 1.5 0 0 1 16.5 8v6.5A1.5 1.5 0 0 1 15 16H5a1.5 1.5 0 0 1-1.5-1.5z"/>', 'stroke-linejoin="round"'],
] as const;
// The pane's full-screen button (Stage 13.1): out to the corners, and back in while it's full screen.
const FULL_IC = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5l-5 5M3.5 16.5l5-5"/></svg>';
const SHRINK_IC = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 8H12V3.5M3.5 12H8v4.5M12 8l4.5-4.5M8 12l-4.5 4.5"/></svg>';
const navBtn = ([id, label, path, extra]: readonly [string, string, string, string]) =>
  `<button type="button" data-go="${id}" title="${label}"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" ${extra}>${path}</svg><span class="lbl">${label}</span>${id === "activity" ? '<span class="count" id="waitCount" hidden></span>' : ""}</button>`;

document.body.innerHTML = `
<p class="narrow-note">This one is meant for a computer, so it's shown scaled down here.</p>
<div class="scaler" id="scaler">
<div class="app" id="app">
  <aside class="side">
    <div class="who"><span class="char-host" id="charSide"></span><div><b id="whoName">${appName()}</b><small id="whoState"><i></i>Ready</small></div></div>
    <nav class="nav" aria-label="Pages">${NAV.map(navBtn).join("")}</nav>
    <nav class="nav side-pins" id="sidePins" aria-label="Pinned" hidden></nav>
    <div class="side-foot nav">
      <button type="button" data-go="settings"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6h7M15 6h1M4 14h1M9 14h7"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="14" r="2"/></svg><span class="lbl">Settings</span></button>
      <div class="paired" id="paired">${IC.phone}<span>Phone</span></div>
    </div>
  </aside>
  <main class="main">
    <section class="view conv nopane on" id="v-conversation" aria-label="Conversation">
      <div class="tcol">
        <header class="thead"><h1>Conversation</h1><span class="sub">Same thread as your phone</span><span class="grow"></span>
          <input class="tsearch" id="tsearch" type="search" placeholder="Search the conversation" aria-label="Search the conversation">
          <button class="icon-btn" id="paneToggle" type="button" aria-label="Show the right pane" title="Show the right pane"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M12 3.5v13"/></svg></button>
        </header>
        <div class="thread" id="thread"><div class="tin" id="tin"></div></div>
        <button class="newpill" id="newPill" type="button">New reply</button>
        <div class="cwrap">
          <div class="firstrun" id="firstrun" hidden></div>
          <div class="workline" id="workLine" role="status" hidden><i></i><span id="workLineText"></span></div>
          <form class="composer" id="composer" autocomplete="off">
            <div class="attached" id="attached" hidden></div>
            <textarea id="cin" rows="1" placeholder="Message ${appName()}" aria-label="Message"></textarea>
            <div class="crow">
              <button class="icon-btn" type="button" id="attach" aria-label="Attach a file" title="Attach a file"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M15.5 9.5 10 15a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3l-6 6a1.2 1.2 0 0 1-1.7-1.7L12 6.2"/></svg></button>
              <button class="icon-btn" type="button" id="sketchBtn" aria-label="Draw something to show me" title="Draw something"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.6 3.9a1.6 1.6 0 0 1 2.3 2.3L7.4 14.7 4 15.9l1.2-3.4z"/><path d="m12.3 5.2 2.4 2.4"/></svg></button>
              <input type="file" id="attachIn" hidden accept=".pdf,.docx,.docm,.xlsx,.xlsm,.csv,.txt,.md,.json,.eml,.jpg,.jpeg,.png,.heic,.webp">
              <span class="grow"></span>
              <span class="hint">Enter to send</span>
              <button class="icon-btn mic" type="button" id="mic" aria-label="Talk instead" aria-pressed="false" title="Talk instead"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="7.5" y="2.5" width="5" height="9.5" rx="2.5"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"/></svg></button>
              <button class="send" type="submit" id="sendBtn" aria-label="Send" disabled><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4M5 9l5-5 5 5"/></svg></button>
            </div>
          </form>
        </div>
      </div>
      <div class="divider" id="divider" role="separator" aria-orientation="vertical" aria-label="Resize the right pane"></div>
      <aside class="pane" id="pane" aria-label="Pulled up">
        <header class="phead"><div class="ttl" id="pttl"></div><div class="zoom" id="zoomCtl" hidden><button class="icon-btn" type="button" data-z="out" aria-label="Zoom out"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 10h10"/></svg></button><output id="zpct">100%</output><button class="icon-btn" type="button" data-z="in" aria-label="Zoom in"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 10h10M10 5v10"/></svg></button><button class="icon-btn" type="button" data-z="fit" aria-label="Whole sheet" title="Whole sheet"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4"/></svg></button></div>
          <button class="icon-btn" type="button" id="paneFull" aria-label="Full screen" title="Full screen (Esc to leave)">${FULL_IC}</button>
          <button class="icon-btn" type="button" id="paneClose" aria-label="Close" title="Close"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg></button>
        </header>
        <div class="pact" id="pact" hidden></div>
        <div class="pbody" id="pbody"></div>
      </aside>
    </section>
    ${PAGES.map((p) =>
      p === "files"
        ? // the file viewer (Stage 15.1): groups, the list, and the right-hand pane moved in beside it while it's open
          `<section class="view fv nopane" id="v-files" aria-label="Files"><aside class="fv-side" id="fvSide"></aside><div class="fv-main" id="fvMain"><div class="fv-browse" id="fvBrowse"></div><div class="doc fv-manage" id="fvManage" hidden><div class="din" id="files"></div></div></div></section>`
        : `<section class="view" id="v-${p}" aria-label="${p}"><div class="doc"><div class="din" id="${p}"></div></div></section>`,
    ).join("")}
  </main>
</div>
</div>`;

/* ---------- phone-sized screens: scale the whole window down (as the mockup). 600-1099 px is the compact layout (CSS). ---------- */
const app = $("app");
function fitNarrow() {
  if (innerWidth < 600) {
    const s = (innerWidth - 32) / 1280;
    app.style.setProperty("--ds", s.toFixed(4));
    $("scaler").style.height = 800 * s + 28 + "px";
  } else {
    app.style.removeProperty("--ds");
    $("scaler").style.height = "";
  }
}
addEventListener("resize", fitNarrow);
fitNarrow();

/* ---------- Pebble in the sidebar ---------- */
anim.mount($("charSide"));
Palette.setNow(Palette.colourFor({}));
let thinking = 0;
/** The opening line after a quiet spell (hello.say): shown under the name instead of "Ready" until something happens. */
let opening = "";
let opened = false;
function setWho() {
  const el = $("whoState");
  const waiting = state.approvals.size;
  el.title = gw.status !== "open" ? "Can't reach the assistant on this PC. It keeps trying." : "";
  el.classList.toggle("say", false);
  if (gw.status !== "open") el.innerHTML = `<i style="background:var(--bad)"></i>Reconnecting…`;
  else if (thinking) el.innerHTML = `<i class="busy"></i>Working on it`;
  else if (waiting) el.innerHTML = `<i class="busy"></i>${waiting} waiting for your OK`;
  else if (opening) (el.classList.toggle("say", true), (el.innerHTML = `<i></i><span>${esc(opening)}</span>`));
  else el.innerHTML = `<i></i>Ready`;
}
onStatus(() => setWho());

/* ---------- navigation ---------- */
const go = (p: string, o: { keepPane?: boolean } = {}) => {
  if (!["conversation", ...PAGES].includes(p)) p = "conversation";
  // The right-hand pane goes beside the file viewer while it's open (15.1), and comes back to the conversation as it was.
  if (p === "files" && host === "conversation") {
    convSaved = { open: pane.open, item: pane.item };
    clearPane();
    hostPaneIn("files");
  } else if (p === "conversation" && host === "files") {
    clearPane();
    hostPaneIn("conversation");
    const saved = convSaved;
    convSaved = null;
    if (!o.keepPane && saved?.open && saved.item) openItem(saved.item);
    else if (!o.keepPane) pane.item = saved?.item ?? null;
  }
  state.page = p;
  if (location.hash !== `#/${p}`) history.replaceState(null, "", `#/${p}`);
  document.querySelectorAll<HTMLElement>("[data-go]").forEach((b) => (b.dataset.go === p ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === "v-" + p));
  document.title = p === "conversation" ? appName() : `${p[0].toUpperCase() + p.slice(1)} · ${appName()}`;
  if (p !== "conversation") Palette.hold(null);
  else syncHold();
  if (p !== "conversation") void renderPage(p as Page, nav);
  if (p === "conversation") void firstRunSteps();
  if (p === "conversation" || p === "files") requestAnimationFrame(() => (pane.viewer as unknown as { resize?: () => void } | null)?.resize?.());
};
const nav = { openItem, go: (p: string) => go(p), preview: showPreview, closePreview: () => void (host === "files" && pane.open && closePane()), tell: tellAbout, openBrowser: () => void openBrowserPane() };
document.querySelectorAll<HTMLElement>("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go!)));
addEventListener("hashchange", () => go(location.hash.replace(/^#\/?/, "")));
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && /^[1-6]$/.test(e.key)) {
    e.preventDefault();
    go(["conversation", ...PAGES][Number(e.key) - 1]);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    go("conversation");
    $("cin").focus();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && state.page === "conversation") {
    e.preventDefault();
    toggleSearch(true);
  } else if (e.key === "Escape") {
    if (document.fullscreenElement || Date.now() - fullLeftAt < 400) return; // Esc that leaves full screen does only that
    if ($("tsearch").classList.contains("on")) toggleSearch(false);
    else if (pane.open && state.page === "conversation" && (document.activeElement as HTMLElement)?.tagName !== "TEXTAREA") closePane();
    else if (pane.open && state.page === "files" && !(document.activeElement as HTMLElement)?.matches?.("input,textarea,select")) closePane();
  }
});

/* ---------- the thread ---------- */
type LineView = { id: number; role: string; channel: string; text: string; at: string; job_id: string | null; started_by: string; items: Item[]; trace: { summary: string; steps: { label: string; ms: number }[] } | null };
const lines = new Map<number, LineView>();
const jobItems = new Map<string, Item[]>(); // items that arrived before their line
let oldest: number | null = null;
let loadingOlder = false;
let allLoaded = false;
const thread = $("thread"),
  tin = $("tin");
const atBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
/** Jump without the CSS smooth scroll, so a second update straight after doesn't think the reader scrolled away. */
function jump(top: number) {
  thread.style.scrollBehavior = "auto";
  thread.scrollTop = top;
  thread.style.scrollBehavior = "";
}

function dayOf(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
}
const chip = (it: Item) => {
  const small = it.kind === "sheet" ? `${it.payload.sheet_no ?? ""} · Rev ${it.payload.revision ?? "?"}` : it.kind === "shopdrawing" ? `${it.payload.number} · Rev ${it.payload.rev} · shop drawing` : it.kind === "draft" ? DRAFT_CHIP[it.payload.status].text : it.source || it.kind;
  const on = pane.open && pane.item?.id === it.id;
  return `<button class="chip${on ? " is-open" : ""}" type="button" data-item="${it.id}"><span class="ico">${kindIcon(it.kind, it.kind === "draft" ? it.payload.operation : undefined)}</span><span class="ct"><b>${esc(it.title)}</b><small>${esc(small)}</small></span><span class="st">${on ? "Showing" : "Open"}</span></button>`;
};
function approvalCard(it: Extract<Item, { kind: "draft" }>) {
  const p = it.payload;
  const live = p.status === "pending" && state.approvals.has(p.approval_id);
  const pill = live ? '<span class="pill need"><i></i>Waiting for your OK</span>' : p.status === "sent" || p.status === "done" ? `<span class="pill ok">${DRAFT_CHIP[p.status].text}</span>` : `<span class="pill off">${DRAFT_CHIP[p.status === "pending" ? "expired" : p.status].text}</span>`;
  const body = p.operation === "email.send" ? `<small>To ${esc(p.to.join(", "))} · ${esc(p.subject)}</small>${esc(p.body.slice(0, 220))}${p.body.length > 220 ? "…" : ""}` : `${esc(p.details.map((d) => `${d.label}: ${d.value}`).join(" · ").slice(0, 240))}`;
  return `<div class="appr" data-appr="${it.id}"><div class="appr-h">${kindIcon("draft", p.operation).replace("<svg", '<svg width="16" height="16"')}<b>${esc(p.summary)}</b><span class="grow"></span>${pill}</div>
    <div class="appr-b">${body}</div>
    ${live ? `<div class="appr-f"><button class="btn accent sm" type="button" data-send="${it.id}">${IC.send}${p.operation === "email.send" ? "Send" : "Go ahead"}</button><button class="btn sm" type="button" data-item="${it.id}">Review</button><button class="btn quiet sm" type="button" data-later="${it.id}">Not now</button></div>` : ""}</div>`;
}
function lineHtml(l: LineView) {
  const said = table.lineHtml(l); // a line said at a round table (Stage 17.3)
  if (said !== null) return said;
  if (l.role === "user") return `<div class="you" data-line="${l.id}">${esc(l.text)}</div><div class="you-time">${time(l.at)}${l.channel === "voice" ? " · said" : l.channel === "siri" ? " · by Siri" : ""}</div>`;
  const items = l.items ?? [];
  const drafts = items.filter((i): i is Extract<Item, { kind: "draft" }> => i.kind === "draft");
  const shown = items.filter((i) => i.kind !== "draft");
  const trace = l.trace ? `<button class="trace" type="button" aria-expanded="false">${IC.chev}${esc(l.trace.summary)}</button><div class="steps">${l.trace.steps.map((s) => `<div>${esc(s.label)} <span class="mono">${(s.ms / 1000).toFixed(1)}s</span></div>`).join("")}</div>` : "";
  const self = l.started_by === "assistant";
  return `<div class="msg${self ? " self" : ""}" data-line="${l.id}">${self ? `<div class="meta"><span class="tag">${IC.bell}Started by ${appName()}</span><span>${time(l.at)}</span></div>` : ""}${trace}${l.text
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("")}${shown.length ? `<div class="chips">${shown.map(chip).join("")}</div>` : ""}${drafts.map(approvalCard).join("")}</div>`;
}
function renderThread(keepBottom = atBottom()) {
  const before = thread.scrollHeight - thread.scrollTop;
  const ids = [...lines.keys()].sort((a, b) => a - b);
  let html = allLoaded && !ids.length ? '<p class="empty">Nothing here yet. Say hello.</p>' : "";
  let day = "";
  for (const id of ids) {
    const l = lines.get(id)!;
    const d = dayOf(l.at);
    if (d !== day) {
      day = d;
      html += `<div class="dayline">${esc(d)}</div>`;
    }
    html += lineHtml(l);
  }
  html += thinkingHtml() + table.thinkingHtml();
  tin.innerHTML = html;
  jump(keepBottom ? thread.scrollHeight : thread.scrollHeight - before);
}
async function loadOlder() {
  if (loadingOlder || allLoaded) return;
  loadingOlder = true;
  const { lines: page } = await api<{ lines: LineView[] }>(`/api/v2/conversation?limit=50${oldest ? `&before=${oldest}` : ""}`, { method: "GET" }).catch(() => ({ lines: [] as LineView[] }));
  if (page.length < 50) allLoaded = true;
  const first = oldest === null;
  for (const l of page) lines.set(l.id, l);
  if (page.length) oldest = Math.min(...page.map((l) => l.id));
  renderThread(first);
  loadingOlder = false;
}
thread.addEventListener("scroll", () => {
  if (thread.scrollTop < 200) void loadOlder();
  if (atBottom()) $("newPill").classList.remove("on");
});
$("newPill").addEventListener("click", () => {
  jump(thread.scrollHeight);
  $("newPill").classList.remove("on");
});
let tailTimer: ReturnType<typeof setTimeout> | 0 = 0;
/** After new lines: fetch the newest few again, so replies get their items and the steps taken. */
function refreshTail() {
  if (tailTimer) clearTimeout(tailTimer);
  tailTimer = setTimeout(async () => {
    const bottom = atBottom();
    const { lines: page } = await api<{ lines: LineView[] }>("/api/v2/conversation?limit=12", { method: "GET" }).catch(() => ({ lines: [] as LineView[] }));
    for (const l of page) lines.set(l.id, l);
    for (const [id, l] of lines) if (id < 0 && page.some((p) => p.role === "user" && p.text === l.text)) lines.delete(id);
    renderThread(bottom);
    if (!bottom) $("newPill").classList.add("on");
  }, 250);
}

/* the round table (Stage 17.3): Tim in the sidebar while it's on, its lines in the thread with who said them */
const table = createDesktopTable({
  gw,
  anim,
  esc,
  time,
  soundOn: () => state.settings["ui.sound"] !== false,
  context: () => voice.audioContext,
  pebbleDay: () => Palette.colourFor(state.settings),
  onChange: () => {
    renderThread(atBottom());
    anim.set(table.pebbleState() ?? (thinking ? "thinking" : voice.on ? "listening" : "idle"));
  },
});

/* the thinking row */
const turns = new Map<string, string>(); // job id -> progress label
function thinkingHtml() {
  if (!turns.size) return "";
  const label = [...turns.values()].pop() ?? "Thinking";
  return `<div class="msg thinking"><span class="shimmer">${esc(label === "Working on it" ? "Thinking" : label)}</span></div>`;
}
function onBrain(m: ServerBrain) {
  if (m.phase === "thinking") turns.set(m.job_id, m.label ?? "Thinking");
  else turns.delete(m.job_id);
  thinking = turns.size;
  anim.set(turns.size ? "thinking" : voice.on ? "listening" : "idle");
  setWho();
  if (m.phase === "error" && "client" in m.origin && m.origin.id === gw.id) {
    Palette.flash("error", 2200);
    toast(m.say ?? "Sorry, I hit a snag on that one.");
  }
  const bottom = atBottom();
  const holder = tin.querySelector(".msg.thinking");
  if (holder) holder.remove();
  tin.insertAdjacentHTML("beforeend", thinkingHtml());
  if (bottom) jump(thread.scrollHeight);
}

/* thread clicks: traces, chips, approval buttons */
tin.addEventListener("click", (e) => {
  const t = (e.target as Element).closest(".trace");
  if (t) {
    const on = t.getAttribute("aria-expanded") !== "true";
    t.setAttribute("aria-expanded", String(on));
    t.nextElementSibling?.classList.toggle("on", on);
    return;
  }
  const c = (e.target as Element).closest<HTMLElement>("[data-item]");
  if (c) return void openItemById(c.dataset.item!);
  const s = (e.target as Element).closest<HTMLElement>("[data-send]");
  if (s) return void sendDraft(findItem(s.dataset.send!) as Extract<Item, { kind: "draft" }>);
  const l = (e.target as Element).closest<HTMLElement>("[data-later]");
  if (l) return notNow(findItem(l.dataset.later!) as Extract<Item, { kind: "draft" }>);
  const f = (e.target as Element).closest<HTMLElement>("[data-found]");
  if (f) {
    toggleSearch(false);
    const el = tin.querySelector(`[data-line="${f.dataset.found}"]`);
    el?.scrollIntoView({ block: "center", behavior: reduce() ? "auto" : "smooth" });
  }
});
function findItem(id: string): Item | null {
  if (pane.item?.id === id) return pane.item;
  for (const l of lines.values()) for (const i of l.items ?? []) if (i.id === id) return i;
  for (const list of jobItems.values()) for (const i of list) if (i.id === id) return i;
  return null;
}
async function openItemById(id: string) {
  const it = findItem(id) ?? (await api<{ item: Item }>(`/api/items/${id}`, { method: "GET" }).then((b) => b.item).catch(() => null));
  if (it) openItem(it);
}

/* ---------- search (Ctrl+F) ---------- */
function toggleSearch(on: boolean) {
  const s = $<HTMLInputElement>("tsearch");
  s.classList.toggle("on", on);
  if (on) s.focus();
  else {
    s.value = "";
    renderThread(true);
  }
}
$("tsearch").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const q = (e.target as HTMLInputElement).value.trim();
  if (!q) return;
  const { lines: found } = await api<{ lines: LineView[] }>(`/api/v2/conversation/search?q=${encodeURIComponent(q)}`, { method: "GET" });
  tin.innerHTML = `<div class="dayline">${found.length} found for “${esc(q)}”</div>${found.map((l) => `<div class="found" data-found="${l.id}"><small>${l.role === "user" ? "You" : l.role === "guest" ? "Tim, at a round table" : l.channel === "table" ? "Pebble, at a round table" : appName()} · ${esc(dayOf(l.at))}, ${time(l.at)}</small>${esc(l.text.slice(0, 300))}</div>`).join("")}<button class="btn" type="button" id="backToThread">Back to the conversation</button>`;
  $("backToThread").onclick = () => toggleSearch(false);
});

/* ---------- the right pane ---------- */
const conv = $("v-conversation"),
  pbody = $("pbody");
const mainEl = document.querySelector<HTMLElement>(".main")!;
/** preview: what the file viewer has up (15.1). Never reported as on screen: "Ask about this" makes it a real item first. */
const pane = { open: false, item: null as Item | null, viewer: null as Zoomable | null, preview: null as Preview | null, live: null as LiveView | null };
const paneSheet = new Map<string, number>(); // which sheet of a set of shop drawings is showing (Stage 12.6)
try {
  const w = savedValue(localStorage, "tavi-pane-width");
  if (w) mainEl.style.setProperty("--pw", w); // shared by the conversation and the file viewer
} catch {}
/* the pane lives beside the conversation, or beside the file viewer while that's open (15.1) */
let host: "conversation" | "files" = "conversation";
let convSaved: { open: boolean; item: Item | null } | null = null;
const hostEl = () => (host === "files" ? $("v-files") : conv);
function hostPaneIn(where: "conversation" | "files") {
  if (host === where) return;
  host = where;
  hostEl().append($("divider"), $("pane"));
  conv.classList.toggle("nopane", where === "files" || !pane.open);
  $("v-files").classList.add("nopane");
}
/** Take whatever is in the pane down, without saying anything changed. */
function clearPane() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  pane.viewer?.destroy();
  pane.viewer = null;
  pane.live?.destroy();
  pane.live = null;
  pane.open = false;
  pane.preview = null;
  $("pact").hidden = true;
  hostEl().classList.add("nopane");
}
function syncHold() {
  const waiting = pane.open && pane.item?.kind === "draft" && pane.item.payload.status === "pending" && state.approvals.has(pane.item.payload.approval_id);
  Palette.hold(waiting ? "ok" : null);
}
function markChips() {
  tin.querySelectorAll<HTMLElement>(".chip").forEach((c) => {
    const on = pane.open && c.dataset.item === pane.item?.id;
    c.classList.toggle("is-open", on);
    const st = c.querySelector(".st");
    if (st) st.textContent = on ? "Showing" : "Open";
  });
}
function openItem(it: Item, camera?: CamState) {
  if (state.page !== "conversation") go("conversation", { keepPane: true });
  pane.preview = null;
  $("pact").hidden = true;
  pane.item = it;
  pane.open = true;
  conv.classList.remove("nopane");
  renderPane(camera);
  $("paneToggle").setAttribute("aria-label", "Hide the right pane");
}
function closePane() {
  const wasPreview = !!pane.preview;
  const wasLive = !!pane.live;
  clearPane();
  if (wasPreview || wasLive) pane.item = null;
  markChips();
  syncHold();
  $("paneToggle").setAttribute("aria-label", "Show the right pane");
  reportScreen();
  if (wasPreview) document.dispatchEvent(new CustomEvent("tavi-preview-closed"));
}

/* ---------- the file viewer's previews (15.1): the viewers already built, in the same pane, beside the list ---------- */
type Preview = {
  entry: { id: string; name: string; own?: string; kind: string; job: string; at: string; size: number | null; group: string; file: boolean; viewer: string };
  item: Item | null;
  pages?: { n: number; total: number; unit: "sheet" | "page" | "part" };
  plain?: { badge: string; what: string; lines: string[] };
  from_model?: string;
  revisions?: { rev: string; date: string; text: string }[];
  rev?: string;
  /** set by the viewer: go to another sheet, page or part, or another revision of a shop drawing */
  turn?: (o: { n?: number; rev?: string }) => void;
  actions?: HTMLElement;
};
function showPreview(pv: Preview) {
  if (host !== "files") return;
  pane.viewer?.destroy();
  pane.viewer = null;
  pane.preview = pv;
  pane.open = true;
  $("v-files").classList.remove("nopane");
  if (pv.item) {
    pane.item = pv.item;
    renderPane();
  } else {
    pane.item = null;
    $("zoomCtl").hidden = true;
    $("pttl").innerHTML = `<b>${esc(pv.entry.name)}</b><span>${esc(pv.entry.kind)}</span>`;
    const p = pv.plain ?? { badge: "?", what: "", lines: [] };
    pbody.innerHTML = `<div class="pscroll fv-plain"><div class="fv-card fade-in"><span class="fv-badge" aria-hidden="true">${esc(p.badge)}</span><h2>${esc(pv.entry.name)}</h2>${pv.entry.own ? `<p class="fv-own">${esc(pv.entry.own)}</p>` : ""}<p class="fv-what">${esc(p.what)}</p>${p.lines.length ? `<ul class="fv-lines">${p.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}<div class="dactions">${pv.entry.file ? `<a class="btn" href="/api/v2/everything/${encodeURIComponent(pv.entry.id)}/file" download>Save a copy</a>` : ""}${pv.from_model ? `<button class="btn quiet" type="button" data-model="${esc(pv.from_model)}">Show the model it came from</button>` : ""}</div></div></div>`;
    pbody.querySelector<HTMLElement>("[data-model]")?.addEventListener("click", async (e) => {
      const id = (e.currentTarget as HTMLElement).dataset.model!;
      const r = await api<Preview>(`/api/v2/everything/${encodeURIComponent(id)}`, { method: "GET" }).catch(() => null);
      if (r) showPreview({ ...r, turn: pv.turn, actions: pv.actions });
    });
  }
  // a sheet, page or part of something longer: the previous and next, in the shop drawings' footer style
  if (pv.pages && pv.turn) {
    const n = pv.pages.n,
      total = pv.pages.total;
    let foot = pbody.querySelector<HTMLElement>(".pfoot");
    if (!foot) {
      foot = document.createElement("div");
      foot.className = "pfoot";
      pbody.appendChild(foot);
    }
    pbody.querySelector(".doctext + .foot, .pscroll > .foot:last-child")?.remove(); // "ask for the next part": not here
    foot.classList.add("sd-foot", "fv-foot");
    foot.innerHTML = `<button type="button" data-step="-1" ${n <= 1 ? "disabled" : ""} aria-label="Previous ${pv.pages.unit}">‹</button><span class="sd-n">${pv.pages.unit === "sheet" ? "Sheet" : pv.pages.unit === "page" ? "Page" : "Part"} ${n} of ${total.toLocaleString("en-AU")}</span><button type="button" data-step="1" ${n >= total ? "disabled" : ""} aria-label="Next ${pv.pages.unit}">›</button>`;
    foot.onclick = (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-step]");
      if (b && !(b as HTMLButtonElement).disabled) pv.turn!({ n: n - 1 + Number(b.dataset.step) });
    };
  }
  const act = $("pact");
  if (pv.actions) {
    act.replaceChildren(pv.actions);
    act.hidden = false;
  } else act.hidden = true;
  reportScreen();
}
/* ---------- the assistant's browser, live (15.2): beside the conversation, with Stop, Take over and Hand back ---------- */
let lastBrowser: BrowserView | null = null;
async function openBrowserPane() {
  if (state.page !== "conversation") go("conversation", { keepPane: true });
  const { mountBrowser } = await import("./browser");
  pane.viewer?.destroy();
  pane.viewer = null;
  pane.live?.destroy();
  pane.preview = null;
  pane.item = null;
  pane.open = true;
  conv.classList.remove("nopane");
  $("zoomCtl").hidden = true;
  $("pact").hidden = true;
  pane.live = mountBrowser(pbody, $("pttl"), { onReview: reviewGoAhead });
  $("paneToggle").setAttribute("aria-label", "Hide the right pane");
  markChips();
  syncHold();
  reportScreen();
}
/** The go-ahead the browser is waiting on, opened for review (the same draft as in the thread). */
function reviewGoAhead() {
  const a = [...state.approvals.values()].find((x) => x.operation === "browser.submit") as (Approval & { item_id?: string }) | undefined;
  if (a?.item_id) void openItemById(a.item_id);
  else go("activity");
}
function onBrowserView(v: BrowserView) {
  const was = lastBrowser;
  lastBrowser = v;
  // it needs him (a sign-in, card details, a "prove you're human" check): the live view comes up and says so
  if (v.asking && !was?.asking) {
    if (!pane.live) void openBrowserPane();
    toast(`I need you in the browser: ${v.asking}`);
    anim.attention(2);
  }
  if (v.open && !was?.open && v.mode === "owner" && !pane.live) void openBrowserPane(); // he asked to sign in somewhere
  if (state.page === "activity" && was?.open !== v.open) void renderPage("activity", nav);
}

/** "Ask about this": the real thing goes up beside the conversation, so "this" in the next sentence means it. */
function tellAbout(it: Item) {
  openItem(it);
  $("cin").focus();
  toast("It's up beside the conversation. Ask away.");
}
/* ---------- pins (Stage 13.2): the phone's pins, as a short list in the sidebar; a click opens one where it was left ---------- */
const PIN_IC = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.6 1.6 14.4 5.4 12.9 6.1 10.7 8.3 10.9 11.4 9.8 12.5 7 9.7 3.2 13.5 2.5 12.8 6.3 9 3.5 6.2 4.6 5.1 7.7 5.3 9.9 3.1z"/></svg>';
let pinList: Pin[] = [];
function renderPins(list: Pin[]) {
  pinList = list.filter((p) => !p.until || Date.parse(p.until) > Date.now());
  const el = $("sidePins");
  el.hidden = !pinList.length;
  el.innerHTML = pinList.length ? `<div class="side-lab">Pinned</div>${pinList.map((p) => `<button type="button" data-pin="${esc(p.id)}" title="${esc(p.items[p.idx]?.title ?? p.label)}${p.until ? " (for today)" : ""}">${PIN_IC}<span class="lbl">${esc(p.label)}</span></button>`).join("")}` : "";
}
$("sidePins").addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-pin]");
  const p = pinList.find((x) => x.id === b?.dataset.pin);
  const it = p && (p.items[p.idx] ?? p.items[0]);
  if (!p || !it) return;
  if (it.kind === "shopdrawing") paneSheet.set(it.id, p.sheet ?? 1); // a set of shop drawings: the sheet it was left on
  openItem(it, it.kind === "model" ? (p.camera ?? undefined) : undefined);
  if (it.kind !== "model" && p.view && pane.viewer) pane.viewer.setView(p.view);
});
setInterval(() => renderPins(pinList), 60_000); // "for today" pins go at midnight

$("paneClose").onclick = () => (document.fullscreenElement ? void document.exitFullscreen().finally(closePane) : closePane());
// Full screen (Stage 13.1): the pane takes the whole screen (the window goes full screen with it); Esc leaves, as always.
let fullLeftAt = 0;
$("paneFull").onclick = () => void (document.fullscreenElement ? document.exitFullscreen() : $("pane").requestFullscreen().catch(() => toast("Full screen isn't available here.")));
document.addEventListener("fullscreenchange", () => {
  const on = document.fullscreenElement === $("pane");
  if (!on) fullLeftAt = Date.now();
  $("paneFull").innerHTML = on ? SHRINK_IC : FULL_IC;
  $("paneFull").setAttribute("aria-label", on ? "Leave full screen" : "Full screen");
  $("paneFull").title = on ? "Leave full screen (Esc)" : "Full screen (Esc to leave)";
});
$("paneToggle").onclick = () => (pane.open ? closePane() : pane.item ? openItem(pane.item) : toast("Nothing has been shown yet."));
$("zoomCtl").addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-z]");
  if (!b || !pane.viewer) return;
  const z = b.dataset.z;
  if (z === "fit") pane.viewer.zoomOut();
  else pane.viewer.zoomBy(z === "in" ? 1.6 : 1 / 1.6);
});
(function () {
  const d = $("divider");
  let st: { x: number; w: number; total: number } | null = null;
  d.addEventListener("pointerdown", (e) => {
    // beside the file viewer, its groups column isn't the thread: the list keeps at least 420 too
    const total = hostEl().getBoundingClientRect().width - (host === "files" ? ($("fvSide").getBoundingClientRect().width || 0) : 0);
    st = { x: e.clientX, w: $("pane").getBoundingClientRect().width, total };
    d.setPointerCapture(e.pointerId);
    d.classList.add("drag");
  });
  d.addEventListener("pointermove", (e) => {
    if (!st) return;
    const w = Math.max(360, Math.min(st.total - 420, st.w - (e.clientX - st.x)));
    mainEl.style.setProperty("--pw", w + "px");
  });
  const end = () => {
    if (st)
      try {
        localStorage.setItem("tavi-pane-width", mainEl.style.getPropertyValue("--pw"));
      } catch {}
    st = null;
    d.classList.remove("drag");
  };
  d.addEventListener("pointerup", end);
  d.addEventListener("pointercancel", end);
})();
let screenTimer: ReturnType<typeof setTimeout> | 0 = 0;
function reportScreen() {
  if (screenTimer) clearTimeout(screenTimer);
  // a preview in the file viewer isn't shown to the assistant: "Ask about this" puts it up for real (15.1)
  const shown = pane.open && !pane.preview && !pane.live && host === "conversation";
  const model = shown && pane.item?.kind === "model" ? (pane.viewer as ModelView | null)?.state() : null;
  screenTimer = setTimeout(() => gw.send({ type: "screen", item_id: shown ? (pane.item?.id ?? null) : null, view: shown ? pane.viewer?.getView() : undefined, stack_depth: 0, ...(shown && pane.item?.kind === "shopdrawing" ? { page_index: (paneSheet.get(pane.item.id) ?? 1) - 1, page_count: pane.item.payload.sheets.length } : { page_index: 0, page_count: shown ? 1 : 0 }), ...(padIsOpen ? { pad: true } : {}), ...(model ? { model } : {}) }), 200);
}
function renderPane(camera?: CamState) {
  const it = pane.item;
  if (!it) return;
  pane.live?.destroy();
  pane.live = null;
  pane.viewer?.destroy();
  pane.viewer = null;
  $("zoomCtl").hidden = it.kind !== "sheet" && it.kind !== "reference" && it.kind !== "sketch" && it.kind !== "model" && it.kind !== "shopdrawing";
  const ttl = $("pttl");
  // A drawing sheet, or a reference book page (Stage 8.2): both in the zoomable viewer.
  const viewerPane = (p: SheetPayload, base?: string) => {
    pbody.innerHTML = '<div class="sv-host"></div><div class="pfoot"><span>Scroll or pinch to zoom · drag to move · double-click to zoom in</span></div>';
    const v = new SheetViewer(pbody.firstElementChild as HTMLElement, p, {
      minSpan: 900,
      ...(base ? { base, missing: "I can't open that page right now.", bands: true } : {}),
      onView: (v) => {
        $("zpct").textContent = v.zoomPct + "%";
        reportScreen();
      },
    });
    v.setMarks(p.marks);
    v.show({ view: p.view }, false);
    pane.viewer = v;
  };
  if (it.kind === "sheet") {
    const p = it.payload;
    ttl.innerHTML = `<b>${esc(it.title)}</b><span class="mono">${esc(p.sheet_no ?? "")} · Rev ${esc(p.revision ?? "?")}${p.status === "superseded" ? " · superseded" : ""}</span>`;
    viewerPane(p);
  } else if (it.kind === "reference") {
    ttl.innerHTML = `<b>${esc(it.title)}</b><span class="mono">${esc(it.source)}</span>`;
    const r = refViewer(it);
    viewerPane(r.sheet, r.base);
  } else if (it.kind === "sketch") {
    ttl.innerHTML = `<b>${esc(it.title)}</b><span>Sketch</span>`;
    pbody.innerHTML = '<div class="sk-pane"></div>';
    pane.viewer = new SketchView(pbody.firstElementChild as HTMLElement, it.payload, {
      onView: (v) => {
        $("zpct").textContent = v.zoomPct + "%";
        reportScreen();
      },
    });
  } else if (it.kind === "model") {
    // a 3D model (Stage 9.4): the viewer is fetched the first time one is opened
    ttl.innerHTML = `<b>${esc(it.title)}</b><span>3D model</span>`;
    pbody.innerHTML = '<div class="sk-pane"></div>';
    const v = modelView(pbody.firstElementChild as HTMLElement, it.id, it.payload, {
      title: it.title,
      camera,
      onView: () => {
        $("zpct").textContent = v.zoomPct + "%";
        reportScreen();
      },
      onState: () => reportScreen(),
    });
    pane.viewer = v;
  } else if (it.kind === "shopdrawing") {
    // a set of shop drawings (Stage 12.6): a sheet at a time in the viewer, the previous and next sheet, the files to save
    const p = it.payload;
    const n = Math.min(Math.max(1, paneSheet.get(it.id) ?? 1), p.sheets.length);
    paneSheet.set(it.id, n);
    ttl.innerHTML = `<b>${esc(it.title)}</b><span class="mono">${esc(p.number)} · Rev ${esc(p.rev)} · sheet ${n} of ${p.sheets.length}${p.status !== "PRELIMINARY" ? ` · ${p.status === "FOR APPROVAL" ? "for approval" : "for construction"}` : ""}</span>`;
    viewerPane({ sheet_id: `${p.drawing_id}-${p.rev}-${n}`, sheet_no: p.number, title: p.sheets[n - 1]?.title ?? it.title, revision: p.rev, status: p.status, project: p.project, aspect: p.sheets[n - 1]?.aspect ?? 420 / 297, marks: [], view: [0, 0, 1, 1] }, `/api/shopdrawings/${p.drawing_id}/${p.rev}/${n}`);
    const foot = pbody.querySelector(".pfoot")!;
    foot.classList.add("sd-foot");
    foot.innerHTML = `<button type="button" data-sheet="-1" ${n <= 1 ? "disabled" : ""} aria-label="Previous sheet">‹</button><span class="sd-n">${n} / ${p.sheets.length}</span><button type="button" data-sheet="1" ${n >= p.sheets.length ? "disabled" : ""} aria-label="Next sheet">›</button><a href="${esc(p.pdf)}" download>PDF</a><a href="${esc(p.dxf)}" download>DXF</a>`;
    foot.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-sheet]");
      if (!b) return;
      paneSheet.set(it.id, n + Number(b.dataset.sheet));
      renderPane();
    });
  } else if (it.kind === "draft") {
    renderDraftPane(it);
  } else if (it.kind === "list" && it.payload.rows.some((r) => r.url)) {
    const p = it.payload;
    ttl.innerHTML = `<b>${esc(it.title)}</b><span>${esc(p.sub ?? it.source)}</span>`;
    pbody.innerHTML = `<div class="pscroll"><ul class="lks">${p.rows.map((r) => `<li>${linkRow(r)}</li>`).join("")}</ul></div>`;
  } else if (it.kind === "list") {
    const p = it.payload;
    ttl.innerHTML = `<b>${esc(it.title)}</b><span>${esc(p.sub ?? it.source)}</span>`;
    pbody.innerHTML = `<div class="pscroll"><ul class="plist">${p.rows
      .map((r) => {
        const [a, b, ...rest] = r.cells;
        const single = r.cells.length === 1;
        const inner = `${single ? "" : `<span class="id">${esc(a)}</span>`}<span class="v"><b>${esc(single ? a : (b ?? ""))}</b>${rest.length ? `<span>${esc(rest.join(" · "))}</span>` : ""}</span>${r.target ? IC.chev : "<span></span>"}`;
        return r.target ? `<li><button class="lr" type="button" data-row="${esc(r.id)}"${single ? ' style="grid-template-columns:minmax(0,1fr) auto"' : ""}>${inner}</button></li>` : `<li><div class="lr">${inner}</div></li>`;
      })
      .join("")}</ul></div>`;
    pbody.querySelector(".plist")!.addEventListener("click", async (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-row]");
      if (!b) return;
      const r = await api<{ item: Item }>(`/api/items/${it.id}/rows/${encodeURIComponent(b.dataset.row!)}/open`, { method: "POST" }).catch(() => null);
      if (r) openItem(r.item);
    });
  } else if (it.kind === "table") {
    const p = it.payload;
    const hl = new Set((p.highlight ?? []).map((h) => `${h.row}:${h.col}`));
    const num = (s: string) => /^[\s$€£]*[-+]?[\d.,]+/.test(s);
    ttl.innerHTML = `<b>${esc(it.title)}</b><span>${esc(it.source)}</span>`;
    pbody.innerHTML = `<div class="pscroll"><table class="ptable"><thead><tr>${p.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${p.rows.map((r, ri) => `<tr>${r.map((c, ci) => `<td class="${ci && num(c) ? "n" : ""}${hl.has(`${ri}:${ci}`) ? " hl" : ""}">${ci === 0 ? `<b>${esc(c)}</b>` : esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>${p.note ? `<p class="foot">${esc(p.note)}</p>` : ""}</div>`;
  } else if (it.kind === "note" || it.kind === "legacy") {
    const rows = it.payload.rows;
    const imgs = it.kind === "legacy" ? it.payload.images.map((i) => `<img class="legacy-img" src="${esc(i.src)}" alt="${esc(i.caption ?? "")}">`).join("") : "";
    const text = it.kind === "note" && it.payload.text ? `<p class="notetext">${esc(it.payload.text)}</p>` : "";
    ttl.innerHTML = `<b>${esc(it.title)}</b><span>${esc(it.source)}</span>`;
    pbody.innerHTML = `<div class="pscroll">${imgs}${rows.length ? `<dl class="fields">${rows.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`).join("")}</dl>` : ""}${text}</div>`;
  } else if (it.kind === "image") {
    ttl.innerHTML = `<b>${esc(it.title)}</b><span>${esc(it.source)}</span>`;
    pbody.innerHTML = `<div class="pscroll"><img class="legacy-img" src="${esc(it.payload.src)}" alt="${esc(it.payload.alt)}"></div>`;
  } else if (it.kind === "doc") {
    ttl.innerHTML = `<b>${esc(it.payload.name)}</b><span>${esc(it.payload.part_label)}</span>`;
    pbody.innerHTML = `<div class="pscroll"><div class="doctext">${esc(it.payload.text)}</div>${it.payload.more ? '<p class="foot">There\'s more in this file. Ask for the next part.</p>' : ""}</div>`;
  } else {
    // sent by a newer build of the gateway than this app (13.4): a plain line, never a blank pane; it updates itself
    ttl.innerHTML = `<b>${esc((it as Item).title ?? "")}</b>`;
    pbody.innerHTML = `<div class="pscroll"><p class="foot unknown-kind">${esc(NEWER_NEEDED)}</p></div>`;
    void updater.unknownKind();
  }
  markChips();
  syncHold();
  reportScreen();
}
function renderDraftPane(it: Extract<Item, { kind: "draft" }>) {
  const p = it.payload as DraftPayload;
  const live = p.status === "pending" && state.approvals.has(p.approval_id);
  $("pttl").innerHTML = `<b>${esc(p.summary)}</b><span>${live ? "Waiting for your OK" : DRAFT_CHIP[p.status === "pending" ? "expired" : p.status].text}</span>`;
  if (!live) {
    const ok = p.status === "sent" || p.status === "done";
    pbody.innerHTML = `<div class="pscroll draft"><div class="sent-state fade-in"><span class="pill ${ok ? "ok" : "off"}">${ok ? IC.tick.replace("<svg", '<svg width="13" height="13"') : ""}${DRAFT_CHIP[p.status === "pending" ? "expired" : p.status].text}</span>${p.outcome_message ? `<b>${esc(p.outcome_message)}</b>` : ""}</div>
      ${p.operation === "email.send" ? `<dl class="fields" style="margin-top:16px"><dt>To</dt><dd>${esc(p.to.join(", "))}</dd><dt>Subject</dt><dd>${esc(p.subject)}</dd></dl><div class="notetext">${esc(p.body)}</div>` : `<dl class="fields" style="margin-top:16px">${p.details.map((d) => `<dt>${esc(d.label)}</dt><dd>${esc(d.value)}</dd>`).join("")}</dl>`}</div>`;
    return;
  }
  if (p.operation === "email.send") {
    pbody.innerHTML = `<div class="pscroll draft"><h2 contenteditable="true" spellcheck="true" id="dSubject">${esc(p.subject)}</h2>
      <dl class="fields"><dt>To</dt><dd>${esc(p.to.join(", "))}${p.cc.length ? ` <span>· cc ${esc(p.cc.join(", "))}</span>` : ""}</dd><dt>From</dt><dd>${esc(p.account)}</dd></dl>
      <textarea class="body-edit" id="dBody" aria-label="Email text">${esc(p.body)}</textarea>
      <div class="dactions"><button class="btn accent" type="button" id="pSend">${IC.send}Send</button><button class="btn quiet" type="button" id="pLater">Not now</button><span class="note">Nothing goes out until you press Send.</span></div></div>`;
  } else {
    pbody.innerHTML = `<div class="pscroll draft"><h2>${esc(p.summary)}</h2>${p.image ? `<img class="legacy-img" src="${esc(p.image)}" alt="The page it's about to submit">` : ""}
      <dl class="fields"><dt>Using</dt><dd>${esc(p.account)}</dd>${p.details.map((d) => `<dt>${esc(d.label)}</dt><dd>${esc(d.value)}</dd>`).join("")}</dl>
      <div class="dactions"><button class="btn accent" type="button" id="pSend">${IC.send}Go ahead</button><button class="btn quiet" type="button" id="pLater">Not now</button><span class="note">Nothing happens until you press Go ahead.</span></div></div>`;
  }
  $("pSend").onclick = () => void sendDraft(it);
  $("pLater").onclick = () => notNow(it);
}

/* ---------- approvals ---------- */
function waitFor<T>(pred: (m: ServerMessage) => T | null, ms: number) {
  return new Promise<T | null>((resolve) => {
    const t = setTimeout(() => (off(), resolve(null)), ms);
    const off = gw.on("*", (m) => {
      const v = pred(m);
      if (v) {
        clearTimeout(t);
        off();
        resolve(v);
      }
    });
  });
}
async function sendDraft(it: Extract<Item, { kind: "draft" }> | null) {
  if (!it) return;
  let a = state.approvals.get(it.payload.approval_id);
  if (!a) return toast("That one isn't waiting any more.");
  const btn = pane.item?.id === it.id ? ($("pSend") as HTMLButtonElement | null) : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending";
  }
  if (pane.item?.id === it.id && it.payload.operation === "email.send") {
    const body = ($("dBody") as HTMLTextAreaElement | null)?.value ?? it.payload.body;
    const subject = $("dSubject")?.innerText.trim() ?? it.payload.subject;
    if (body !== it.payload.body || subject !== it.payload.subject) {
      gw.send({ type: "revise", id: a.id, nonce: a.nonce, subject, body });
      const next = await waitFor((m) => (m.type === "approval" && m.approval.item_id === it.id && m.approval.id !== a!.id ? m.approval : null), 5000);
      if (!next) {
        if (btn) btn.disabled = false;
        return toast("I couldn't save your changes. Nothing was sent.");
      }
      a = next;
    }
  }
  const outcome = waitFor((m) => (m.type === "outcome" && m.outcome.approvalId === a!.id ? m.outcome : null), 60_000);
  gw.send({ type: "decide", id: a.id, nonce: a.nonce, decision: "approve" });
  const o = await outcome;
  if (o && ["accepted", "verified"].includes(o.status)) {
    Palette.hold(null);
    Palette.flash("done", 1000);
    toast(o.message);
  } else {
    Palette.flash("error", 2200);
    toast(o?.message ?? "That didn't go through.");
  }
}
function notNow(it: Extract<Item, { kind: "draft" }> | null) {
  if (!it) return;
  const a = state.approvals.get(it.payload.approval_id);
  if (a) gw.send({ type: "decide", id: a.id, nonce: a.nonce, decision: "reject" });
  Palette.hold(null);
  toast("Okay. I'll keep it for later.");
}

/* ---------- composer ---------- */
const cin = $<HTMLTextAreaElement>("cin"),
  sendBtn = $<HTMLButtonElement>("sendBtn");
const grow = () => {
  cin.style.height = "auto";
  cin.style.height = Math.min(180, cin.scrollHeight) + "px";
  sendBtn.disabled = !cin.value.trim();
};
cin.addEventListener("input", grow);
cin.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $<HTMLFormElement>("composer").requestSubmit();
  }
});
/* attach: the file goes into the drawings folder's inbox (job "Unsorted"), and the message says so */
let attached: string[] = [];
$("attach").onclick = () => $("attachIn").click();
$("attachIn").addEventListener("change", async () => {
  const input = $<HTMLInputElement>("attachIn");
  for (const f of [...(input.files ?? [])]) {
    const box = $("attached");
    box.hidden = false;
    box.insertAdjacentHTML("beforeend", `<span data-up="${esc(f.name)}">${IC.list.replace("<svg", '<svg width="14" height="14"')}${esc(f.name)} · sending</span>`);
    try {
      const r = await fetch("/api/v2/upload", { method: "POST", headers: { "x-file-name": encodeURIComponent(f.name), "Content-Type": "application/octet-stream" }, body: f });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Couldn't attach it.");
      attached.push(body.name);
      box.querySelector(`[data-up="${CSS.escape(f.name)}"]`)!.innerHTML = `${IC.list.replace("<svg", '<svg width="14" height="14"')}${esc(body.name)}`;
      sendBtn.disabled = false;
    } catch (err) {
      box.querySelector(`[data-up="${CSS.escape(f.name)}"]`)?.remove();
      if (!box.children.length) box.hidden = true;
      toast(err instanceof Error ? err.message : String(err));
    }
  }
  input.value = "";
});

let tempId = -1;
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  let v = cin.value.trim();
  if (attached.length) v = `${v || "Have a look at this."}

(I've attached ${attached.join(", ")}. It's in your files under Unsorted.)`;
  attached = [];
  $("attached").innerHTML = "";
  $("attached").hidden = true;
  if (!v) return;
  cin.value = "";
  grow();
  // shown at once; the saved line replaces it when it arrives
  lines.set(tempId--, { id: tempId + 1, role: "user", channel: "typed", text: v, at: new Date().toISOString(), job_id: null, started_by: "you", items: [], trace: null });
  renderThread(true);
  gw.send({ type: "typed", text: v, request_id: `d-${Date.now().toString(36)}` });
});

/* the sketch pad (Stage 8.5): the pencil beside the paperclip, or the assistant opening it; loaded when first opened */
let padIsOpen = false;
async function openSketchPad(o: { prompt?: string; over?: { file: string; src: string; w: number; h: number } } = {}) {
  const { openPad } = await import("../shared/pad");
  openPad({
    ...o,
    onState: (open) => ((padIsOpen = open), reportScreen()),
    onSend: async (blob, info) => {
      const r = await fetch(`/api/v2/upload?as=sketch${info.over ? `&over=${encodeURIComponent(info.over)}` : ""}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blob });
      if (!r.ok) throw new Error("not sent");
      const { file } = (await r.json()) as { file: string };
      if (voice.on) return; // on a call the voice is told and hands it to the brain itself
      const v = "Here's my sketch.";
      lines.set(tempId--, { id: tempId + 1, role: "user", channel: "typed", text: v, at: new Date().toISOString(), job_id: null, started_by: "you", items: [], trace: null });
      renderThread(true);
      gw.send({ type: "typed", text: v, request_id: `d-${Date.now().toString(36)}`, files: [file] });
    },
  });
}
$("sketchBtn").onclick = () => void openSketchPad();

/* the mic: a voice call from the PC (same voice code as the phone) */
const voice = createVoice(gw.id, {
  onState: (s) => {
    $("mic").setAttribute("aria-pressed", String(s !== "off"));
    $("mic").classList.toggle("on", s !== "off");
    anim.set(s === "listening" ? "listening" : s === "thinking" || s === "connecting" ? "thinking" : s === "speaking" ? "speaking" : "idle");
  },
  onHeard: (t) => table.ownerHeard(t), // the round table's speech stops when he talks (17.3)
  onSaid: () => undefined,
  onLevel: (l) => (table.liveLevel(l) ? undefined : (anim.level = l)),
  onEnded: (msg) => msg && toast(msg),
});
// while a round table is on, the call's own voice is muted here: only the table's lines are heard (Stage 18.1)
gw.on("table", (m) => voice.muteVoice(m.on));
gw.on("call_voice", (m) => voice.muteVoice(m.muted));
$("mic").onclick = () => {
  if (!voice.on && !state.voiceReady) return toast("Voice isn't set up yet. Type instead.");
  if (voice.on) voice.end();
  else void voice.start();
};

/* ---------- updating itself after a new version goes live (13.4) ----------
   When the gateway's hello names a newer build than this window was loaded with, it reloads at the first safe moment
   (no call, nothing typed in the box, the pad shut, no tap-to-approve up, nothing being worked on) and reopens what was
   in the pane (src/shared/update.ts). */
const updater = createUpdater({
  kind: "desktop",
  safe: () =>
    !voice.on &&
    !table.on &&
    !padIsOpen &&
    !cin.value.trim() &&
    thinking === 0 &&
    !(pane.open && pane.item?.kind === "draft" && pane.item.payload.status === "pending" && state.approvals.has(pane.item.payload.approval_id)) &&
    !(state.page === "activity" && state.approvals.size) &&
    lastBrowser?.takeover !== "on", // never while he's driving the browser
  save: () =>
    pane.open && pane.item && !pane.preview
      ? {
          item_id: pane.item.id,
          sheet: pane.item.kind === "shopdrawing" ? (paneSheet.get(pane.item.id) ?? 1) : undefined,
          view: pane.item.kind === "model" ? null : (pane.viewer?.getView() ?? null),
          camera: pane.item.kind === "model" ? ((pane.viewer as ModelView | null)?.camera() ?? null) : null,
        }
      : null,
});
type Reopen = { item_id: string; sheet?: number; view: { s: number; cx: number; cy: number } | null; camera: CamState | null };
const reopen = takeReopen<Reopen>();
if (reopen) {
  void api<{ item: Item }>(`/api/items/${encodeURIComponent(reopen.item_id)}`)
    .then(({ item }) => {
      if (pane.open) return;
      if (item.kind === "shopdrawing" && reopen.sheet) paneSheet.set(item.id, reopen.sheet);
      openItem(item, item.kind === "model" ? (reopen.camera ?? undefined) : undefined);
      if (item.kind !== "model" && reopen.view && pane.viewer) pane.viewer.setView(reopen.view);
    })
    .catch(() => toast("Updated to the new version. Open that again: it didn't come back up."));
}

/* ---------- messages from the gateway ---------- */
gw.on("*", (m: ServerMessage) => {
  switch (m.type) {
    case "hello":
      updater.check("build" in m ? m.build : null); // a newer build live: reload when it's safe (13.4)
      state.voiceReady = m.voiceReady;
      if (m.name) {
        state.name = m.name;
        $("whoName").textContent = (m.name === "Tavi" || m.name === earlier.words) ? appName() : m.name;
      }
      applySettings(("settings" in m ? m.settings : {}) ?? {}, true);
      if (!opened) opening = ("say" in m && m.say) || ""; // only when the app opens, not on a reconnect
      opened = true;
      setWho();
      break;
    case "name":
      if (m.name) $("whoName").textContent = (m.name === "Tavi" || m.name === earlier.words) ? appName() : m.name;
      break;
    case "settings":
      applySettings(m.values);
      if (state.page === "settings") void renderPage("settings", nav);
      break;
    case "line":
      if (m.role === "user" || m.role === "assistant" || m.role === "guest") {
        if (m.role === "user") for (const [id, l] of lines) if (id < 0 && l.text === m.text) lines.delete(id);
        lines.set(m.id, { id: m.id, role: m.role, channel: m.channel, text: m.text, at: m.at, job_id: m.job_id, started_by: m.channel === "proactive" ? "assistant" : "you", items: (m.job_id && jobItems.get(m.job_id)) || [], trace: null });
        const bottom = atBottom();
        renderThread(bottom);
        if (!bottom && m.role === "assistant") $("newPill").classList.add("on");
        refreshTail();
        if (opening) ((opening = ""), setWho()); // the conversation has moved on
      }
      break;
    case "item":
      if (m.item.job_id) jobItems.set(m.item.job_id, [...(jobItems.get(m.item.job_id) ?? []).filter((i) => i.id !== m.item.id), m.item]);
      // a changed model takes the old one's place, seen from where it was being looked at (Stage 9.3)
      if (m.replaces && pane.open && pane.item?.id === m.replaces) {
        const cam = pane.item.kind === "model" ? (pane.viewer as ModelView | null)?.camera() : undefined;
        pane.item = m.item;
        renderPane(cam);
      } else if (m.open) {
        // a shop drawing opens at the sheet a view he just asked for went on (19.3)
        if (m.item.kind === "shopdrawing" && m.item.payload.open_at) paneSheet.set(m.item.id, m.item.payload.open_at);
        openItem(m.item);
      }
      break;
    case "item_update": {
      for (const l of lines.values()) l.items = (l.items ?? []).map((i) => (i.id === m.id ? ({ ...i, ...m.patch } as Item) : i));
      if (pane.item?.id === m.id) {
        pane.item = { ...pane.item, ...m.patch } as Item;
        if (pane.item.kind === "draft") renderPane();
        else if ((pane.item.kind === "sheet" || pane.item.kind === "reference") && pane.viewer && m.patch.payload) pane.viewer.setMarks(pane.item.payload.marks);
      }
      renderThread();
      break;
    }
    case "surface":
      // one place for every screen command (the sketch pad's had its own case, which hid all the others from Stage 8)
      if (m.cmd === "pad") void openSketchPad({ prompt: m.prompt, over: m.over });
      else if (m.cmd === "clear") closePane();
      else if (m.cmd === "model" && pane.item?.kind === "model") void (pane.viewer as ModelView | null)?.handle(m);
      else if ((m.cmd === "model_pictures" || m.cmd === "model_save") && pane.item?.id === m.item_id) void (pane.viewer as ModelView | null)?.handle(m);
      else if ((m.cmd === "next" || m.cmd === "prev") && pane.item?.kind === "shopdrawing") {
        paneSheet.set(pane.item.id, (paneSheet.get(pane.item.id) ?? 1) + (m.cmd === "next" ? 1 : -1));
        renderPane();
      } else if (m.cmd === "zoom_out") pane.viewer?.zoomOut();
      else if (m.cmd === "zoom_in") pane.viewer?.zoomIn();
      else if (m.cmd === "focus") pane.viewer?.focus(m.box, m.mark);
      else if (m.cmd === "open") void openItemById(m.item_id);
      else if (m.cmd === "files") void pages().then((p) => p.openFiles({ group: m.group, job: m.job, q: m.q }, nav));
      else if (m.cmd === "browser") void openBrowserPane();
      break;
    case "pins":
      renderPins(m.pins);
      break;
    case "browser":
      onBrowserView(m.view);
      break;
    case "approval":
      state.approvals.set(m.approval.id, m.approval as Approval);
      setWho();
      updateBadge();
      if (pane.item?.kind === "draft" && pane.item.id === m.approval.item_id) renderPane();
      renderThread();
      break;
    case "approval_gone":
      state.approvals.delete(m.id);
      setWho();
      updateBadge();
      renderThread();
      break;
    case "outcome":
      if (m.outcome.status !== "refused") state.approvals.delete(m.outcome.approvalId);
      setWho();
      updateBadge();
      break;
    case "brain":
      onBrain(m);
      break;
    case "background":
      // Stage 21.3: a quiet line over the composer, what the work is doing now (its title on hover)
      anim.working = m.phase === "start";
      $("workLine").hidden = m.phase !== "start";
      $("workLineText").textContent = m.phase === "start" ? m.doing || m.title : "";
      $("workLine").title = m.phase === "start" ? m.title : "";
      break;
    case "activity":
      updateBadge();
      void firstRunSteps();
      if (state.page === "activity") void renderPage("activity", nav);
      break;
    case "memory":
      if (state.page === "memory") void renderPage("memory", nav);
      break;
    case "drawings":
    case "files":
      if (state.page === "files") void renderPage("files", nav);
      void firstRunSteps();
      break;
    case "accounts":
      if (state.page === "connections") void renderPage("connections", nav);
      break;
  }
});
function updateBadge() {
  const n = state.approvals.size;
  const b = $("waitCount");
  b.textContent = n ? String(n) : "";
  b.hidden = !n;
}

/* the phone line at the bottom of the sidebar */
api<{ pushDevices?: number }>("/api/setup/proactive", { method: "GET" })
  .then((r) => {
    $("paired").innerHTML = `${IC.phone}<span>${r.pushDevices ? "Phone · alerts on" : "Phone not set up for alerts yet"}</span>`;
  })
  .catch(() => undefined);

void loadOlder();
go(location.hash.replace(/^#\/?/, "") || "conversation");
setTimeout(() => anim.attention(1), 500);
if (import.meta.env.DEV || new URLSearchParams(location.search).has("test")) (window as unknown as { __lh: unknown }).__lh = { pane, lines, state, gw, update: updater };
// Fetch the other pages once things are quiet, so the first visit to one is instant.
(window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500)))(() => void pages());

/* ---------- first run (6.5): three quiet steps under the thread until each is done ---------- */
type FirstRun = { phone: { done: boolean; url: string | null }; account: { done: boolean }; folder: { done: boolean } };
async function firstRunSteps() {
  const box = $("firstrun");
  const f = await api<FirstRun>("/api/v2/firstrun", { method: "GET" }).catch(() => null);
  let hidden = false;
  try {
    hidden = savedValue(localStorage, "tavi-firstrun-hidden") === "1";
  } catch {}
  if (!f || hidden || (f.phone.done && f.account.done && f.folder.done)) return void (box.hidden = true);
  const step = (n: number, title: string, sub: string, button: string) =>
    `<div class="fr"><span class="n">${n}</span><div class="t"><b>${title}</b><span${n === 1 && f.phone.url ? ' class="mono"' : ""}>${sub}</span></div>${button}</div>`;
  const parts = [];
  if (!f.phone.done)
    parts.push(
      f.phone.url
        ? step(1, "Open me on your phone", esc(f.phone.url), `<button class="btn sm" type="button" data-step="copy">Copy link</button>`)
        : step(1, "Open me on your phone", "It needs Tailscale on this PC and the phone.", `<button class="btn sm" type="button" data-step="connections">How</button>`),
    );
  if (!f.account.done) parts.push(step(2, "Connect an account", "Gmail, Calendar or Drive, so I can check them for you.", `<button class="btn sm" type="button" data-step="connections">Connect</button>`));
  if (!f.folder.done) parts.push(step(3, "Add a folder", "Where your job files live. I only ever read it.", `<button class="btn sm" type="button" data-step="files">Add</button>`));
  box.innerHTML = parts.join("") + `<button class="fr-hide" type="button" data-step="hide">Hide these</button>`;
  box.hidden = false;
  box.onclick = (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-step]");
    if (!b) return;
    if (b.dataset.step === "hide") {
      try {
        localStorage.setItem("tavi-firstrun-hidden", "1");
      } catch {}
      box.hidden = true;
    } else if (b.dataset.step === "copy" && f.phone.url) void navigator.clipboard.writeText(f.phone.url).then(() => toast("Copied. Open it on your phone."), () => toast(f.phone.url!));
    else if (b.dataset.step === "files") void pages().then((p) => p.openFiles({ manage: true }, nav)); // where folders are added
    else go(b.dataset.step!);
  };
}
void firstRunSteps();

// Keep the connection ready while checking which app this server is running.
void nameReady.then(() => {
  const p = state.page;
  document.title = p === "conversation" ? appName() : `${p[0].toUpperCase() + p.slice(1)} · ${appName()}`;
  ($("cin") as HTMLTextAreaElement).placeholder = `Message ${appName()}`;
  if (!state.name || (state.name === "Tavi" || state.name === earlier.words)) $("whoName").textContent = appName();
});
