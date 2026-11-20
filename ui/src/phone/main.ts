// The phone app (DESIGN §4). A port of the controller in mockups/v2/src/phone.src.html, driven by the gateway instead of
// scripted scenarios: the stage with Pebble and one line of words; the pull-up that fills the screen with whatever was
// asked for (sheets, lists, tables, drafts), pages to swipe between, a back stack; the voice; typing; notices; and the
// long-press sheet. Framework-free on purpose: one screen of gestures and animation, and a small bundle.
import "../shared/base.css";
import "./phone.css";
import { startTeam, teamSend, teamBusy, teamPreviewApproval, teamVoice, teamActive, teamMore } from "./team-link";
import { Animator } from "../shared/pebble/pebble";
import * as Palette from "../shared/palette";
import { createGateway } from "../shared/gateway";
import { createVoice, speakLocal, stopLocal, type VoiceState } from "../shared/voice";
import { esc } from "../shared/items/describe";
import { PHONE_HTML } from "./markup";
import { createShots, postPicture, type Shot } from "./photos";
import { Trail } from "../shared/trail";
import { editedEmail, pagesOf, renderDraft, renderItem, type PageRec, type RenderCtx } from "./render";
import { createPins, pinPages, placeOf } from "./pins";
import { createUpdater, takeReopen } from "../shared/update";
import { decideTalk, showTalkTarget, takeTalkFlag, type TalkDecision } from "./talklink";
import type { PhoneTable } from "./table";
import type { ViewState, Zoomable } from "../shared/sheet-viewer/viewer";
import type { ModelView } from "../shared/items/model";
import type { CamState } from "../shared/model3d-viewer/viewer";
import type { Approval, CamPlace, Item, Pin, ServerBrain, ServerMessage, Settings, SurfaceCommand } from "../../../src/shared/protocol";

document.body.innerHTML = PHONE_HTML;
// The app is one fixed screen. Focusing the text box must never scroll it (it would push the caption off the top).
for (const el of [document.scrollingElement, document.getElementById("app")]) el?.addEventListener("scroll", () => el && (el.scrollTop = 0));
document.addEventListener("gesturestart", (e) => e.preventDefault());
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const app = $("app"),
  pull = $("pull"),
  track = $("track"),
  cap = $("cap");
const capText = $("capText"),
  shareBtn = $("shareBtn") as HTMLButtonElement,
  fscShare = $("fscShare") as HTMLButtonElement,
  shareMenu = $("shareMenu"),
  pos = $("pos"),
  subS = $("sub"),
  subT = $("stripSub");

/* ---------- connection ---------- */
// declared before the connection starts: it reports "connecting" straight away
let voiceReady = false;
let settings: Settings = {};
let offlineTimer: ReturnType<typeof setTimeout> | 0 = 0;
const gw = createGateway("phone", { onStatus: (s) => onStatus(s) });
function onStatus(s: string) {
  if (new URLSearchParams(location.search).has("team-fixtures")) return;
  if (s === "open") {
    if (offlineTimer) clearTimeout(offlineTimer);
    offlineTimer = 0;
    if (app.classList.contains("offline")) {
      app.classList.remove("offline");
      line("Back again.");
    }
  } else if (!offlineTimer && !app.classList.contains("offline")) {
    offlineTimer = setTimeout(() => {
      offlineTimer = 0;
      if (gw.status === "open") return;
      app.classList.add("offline");
      anim.set("idle");
      line("I can't reach your computer. Is it on?");
    }, 3000);
  }
}

/* ---------- Pebble ---------- */
const anim = new Animator();
anim.mount($("charStage"), () => state.open); // under the pull-up: nothing to see, so nothing to draw (12.0)
anim.mount($("charStrip"), () => app.classList.contains("fs")); // off the screen in full screen (13.1)
anim.onState = (s) => {
  app.dataset.state = s;
};
Palette.setNow(Palette.colourFor({}));
function applySettings(s: Settings, first = false) {
  settings = { ...settings, ...s };
  const theme = String(settings["ui.theme"] ?? "system");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const c = Palette.colourFor(settings);
  if (first) Palette.setNow(c);
  else Palette.blendTo(c, 1200);
  voice.setSound(settings["ui.sound"] !== false);
}
// midnight: a new day's colour
setInterval(() => Palette.blendTo(Palette.colourFor(settings), 1500), 60_000);
setInterval(() => pins.refresh(), 60_000); // "for today" pins go at midnight, reception or not (13.2)
app.addEventListener("pointermove", (e) => {
  const host = state.open ? $("charStrip") : $("charStage");
  const r = host.getBoundingClientRect();
  const x = (e.clientX - (r.left + r.width / 2)) / (state.open ? 220 : r.width * 1.2),
    y = (e.clientY - (r.top + r.height / 2)) / (state.open ? 300 : r.height * 1.2);
  anim.look(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
});

/* ---------- subtitles ---------- */
let token = 0;
function setSub(html: string, cls = "") {
  for (const el of [subS, subT]) {
    el.className = (el === subS ? "sub " : "strip-sub ") + cls;
    el.innerHTML = html;
  }
  signUpdate();
}
const words = (t: string) => t.split(/\s+/).filter(Boolean);
async function revealWords(text: string, cls: string, per: number, my: number) {
  const ws = words(text);
  setSub(ws.map((w) => `<span class="w">${esc(w)}</span> `).join(""), cls);
  const spans = [subS, subT].map((el) => [...el.querySelectorAll(".w")]);
  for (let i = 0; i < ws.length; i++) {
    if (my !== token) return false;
    spans.forEach((list) => list[i]?.classList.add("on"));
    await sleep(reduce() ? 0 : per);
  }
  return true;
}
/** Say a line: words appear in step, Pebble talks; the phone's own voice reads it if no call is on and sound is on. */
async function speak(text: string, opts: { aloud?: boolean; owned?: boolean } = {}) {
  if (teamActive() && !opts.owned) return;
  const my = ++token;
  anim.set("speaking");
  const aloud = opts.aloud && !voice.on;
  const audio = aloud ? speakLocal(text, settings["ui.sound"] !== false) : null;
  const ok = await revealWords(text, "", reduce() ? 0 : 95, my);
  if (!ok) return;
  if (audio) await audio;
  else await sleep(Math.max(700, words(text).length * 150));
  if (my === token) anim.set(voiceAnim());
}
/** A line with no speaking. (It cuts off any line being spoken, so Pebble stops speaking too: before Stage 21.3 a line
 * shown mid-speech left it "speaking" for good, and notices then waited behind it.) */
function line(text: string, cls = "", owned = false) {
  if (teamActive() && !owned) { document.dispatchEvent(new CustomEvent("phone-feedback", { detail: text })); return; }
  ++token;
  setSub(esc(text), cls);
  if (anim.state === "speaking") anim.set(voiceAnim());
}
function hint(label: string) {
  setSub(`<span class="shimmer">${esc(label)}</span>`, "hint");
}
/** In full screen the strip is off the screen: what Pebble says shows as one quiet line at the top until it goes quiet. */
let signTimer: ReturnType<typeof setTimeout> | 0 = 0;
function signUpdate() {
  const sign = document.getElementById("fsSign");
  if (!sign) return;
  const t = (subT.textContent ?? "").trim();
  sign.classList.toggle("on", !!t);
  if (!t) return;
  $("fsSignText").textContent = t;
  armSign();
}
function armSign() {
  if (signTimer) clearTimeout(signTimer);
  signTimer = setTimeout(() => {
    signTimer = 0;
    if (anim.state === "speaking" || anim.state === "thinking") return armSign(); // still talking or working it out
    $("fsSign").classList.remove("on");
  }, 3500);
}

/* ---------- state ---------- */
type Entry = { set: Item[]; idx: number; view: ViewState | null; pin: string | null };
const state = {
  open: false,
  set: [] as Item[],
  idx: 0,
  pages: [] as PageRec[],
  history: [] as Entry[],
  working: false,
  workTitle: "",
  /** The pin these pages were opened from (13.2): leaving them saves where he left it. */
  pinId: null as string | null,
};
const approvals = new Map<string, Approval>(); // live approvals by id (they carry the nonce)
const draftItem = new Map<string, string>(); // approval id -> item id
const cur = () => (state.open ? state.set[state.idx] : null);
const curRec = () => (state.open ? state.pages[state.idx] : null);
const curViewer = (): Zoomable | null => curRec()?.viewer ?? null;

/* ---------- caption ---------- */
function updateCap() {
  const it = state.set[state.idx]; // as the mockup: the page being put up, even before the surface counts as open
  if (!it) return;
  if (it.kind === "sheet") {
    const p = it.payload;
    capText.innerHTML = `<b>${esc(p.title ?? it.title)}</b><span class="m">${esc(p.sheet_no ?? "")} · Rev ${esc(p.revision ?? "?")}</span>${p.status === "superseded" ? '<span class="old">Superseded</span>' : ""}`;
  } else if (it.kind === "shopdrawing") {
    // a sheet of a set of shop drawings (Stage 12.6): its number, revision and which sheet; its status if issued
    const p = it.payload;
    capText.innerHTML = `<b>${esc(it.title)}</b><span class="m">${esc(p.number)} ${esc(p.rev)} · ${p.sheet ?? 1}/${p.sheets.length}</span>${p.status !== "PRELIMINARY" ? `<span class="need">${p.status === "FOR APPROVAL" ? "For approval" : "For construction"}</span>` : ""}`;
  } else if (it.kind === "sketch" || it.kind === "model") capText.innerHTML = `<b>${esc(it.title)}</b><span class="m">${it.kind === "model" ? "3D model" : "Sketch"}</span>`;
  else if (it.kind === "reference") capText.innerHTML = `<b>${esc(it.title)}</b><span class="m">${esc(it.source)}</span>`;
  else capText.innerHTML = `<b>${esc(it.title)}</b>`;
  capText.classList.toggle("two", it.kind === "reference"); // a reference page names its book, table and page underneath
  cap.classList.toggle("bare", it.kind !== "sheet" && it.kind !== "reference" && it.kind !== "sketch" && it.kind !== "model" && it.kind !== "shopdrawing");
  shareBtn.hidden = fscShare.hidden = it.kind !== "shopdrawing"; // the caption's, and full screen's controls' (13.1)
  if (it.kind !== "shopdrawing") closeShare();
  cap.classList.toggle("pinned", it.pinned);
  pos.innerHTML = state.set.length > 1 ? state.set.map((_, i) => `<i class="${i === state.idx ? "on" : ""}"></i>`).join("") : "";
  syncPinButtons();
  if (app.classList.contains("fs-ctl")) renderControls(); // full screen's controls follow the page (13.1)
}
/** The pin buttons (the caption's and full screen's) say whether what's on screen is pinned. */
function syncPinButtons() {
  const it = state.set[state.idx];
  const on = !!(it && pins.pinFor(it.id));
  for (const b of [$("pinBtn"), $("fscPin")]) {
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", on ? "Unpin" : "Pin");
  }
}
/** What's on screen, for pinning it: the page, the pages beside it, and where it's looking (a model: its camera). The
 *  pages as they're shown: a set of shop drawings once per sheet (pins.ts keeps it once, with the sheet). */
function onScreen() {
  const it = cur();
  const v = curViewer();
  const camera = it?.kind === "model" ? ((v as ModelView | null)?.camera() ?? null) : null;
  return { items: state.set, idx: state.idx, view: it?.kind === "model" ? null : (v?.getView() ?? null), camera };
}
$("pinBtn").addEventListener("click", async () => {
  if (!cur()) return;
  const pin = await pins.toggle(onScreen());
  if (pin) state.pinId = pin.id; // leaving now saves where he left it
  syncPinButtons();
});
// A sideways drag: the pages sit exactly under the finger (dx is measured on the screen), and letting go glides on at
// the finger's speed. raw is how far the drag has gone (from + the finger's travel); off is where the pages are put
// (raw, with the give past the first and last page). A drag that starts while the pages are still gliding from the last
// swipe picks them up where they are, so swiping quickly through several sheets never jumps. (12.0)
let swipe: { from: number; dx0: number; raw: number; off: number } | null = null;
const GIVE = 0.3; // past the first or last page, the pages move this much for each px of finger
/** Put the pages in place, dx px off the current one. transition: "" the stylesheet's own glide (.46 s, for "next one"),
 *  "none" straight there (under the finger), or a glide worked out from the finger (settle()). */
function placeTrack(dx = 0, transition = "") {
  track.style.transition = transition;
  track.style.transform = `translateX(calc(${-state.idx * 100}% + ${dx}px))`;
}
/** Where the pages are on the screen right now, in px off the current one's place: 0 at rest, else part-way through a glide. */
function trackOffset() {
  const t = getComputedStyle(track).transform;
  return t && t !== "none" ? new DOMMatrixReadOnly(t).m41 + state.idx * track.clientWidth : 0;
}
/** After letting go: the pages carry on at the finger's speed (v, px/ms on the screen) and slow to a stop on the page,
 *  from `from` px off it. About a third of a second, less after a quick flick, never past the page. It's a transition
 *  the phone's compositor runs, so nothing else the page does at that moment can make it catch. Reduced motion: straight
 *  there. (12.0) */
function settle(from: number, v: number) {
  const d = Math.abs(from);
  if (reduce() || d < 0.5) return placeTrack(0, "none");
  const toward = Math.max(0, -Math.sign(from) * v); // the finger's speed toward where the page comes to rest
  const ms = Math.max(180, Math.min(180 + d * 0.5, 380, toward > 0.01 ? (2.4 * d) / toward : Infinity));
  // cubic-bezier(x1, y1, …) sets off with slope y1 / x1: matched to the finger, so there's no jolt as it lets go
  const y1 = Math.min(1, (0.3 * toward * ms) / d);
  placeTrack(0, `transform ${Math.round(ms)}ms cubic-bezier(.3,${y1.toFixed(3)},.25,1)`);
}
// A finger landing on the pages while they're still gliding stops them where they are, as on an iPhone: a drag carries
// on from there, and a tap lets them finish settling. (12.0)
let held = false;
track.addEventListener(
  "pointerdown",
  () => {
    if (swipe) return;
    const off = trackOffset();
    if (Math.abs(off) < 0.5) return;
    placeTrack(off, "none");
    held = true;
  },
  { capture: true },
);
const letGo = () => {
  if (!held || swipe) return; // a drag that took over settles itself
  held = false;
  settle(trackOffset(), 0);
};
track.addEventListener("pointerup", letGo, { capture: true });
track.addEventListener("pointercancel", letGo, { capture: true });

/* ---------- sharing a shop drawing (Stage 12.6): the phone's share sheet with the file, else a plain download ---------- */
// The files are fetched as the menu opens, so the share sheet opens straight from the tap (iOS needs that).
// In full screen (13.1) the same menu opens from the Share button in the tap-to-show controls, under them, and keeps
// the controls up until it's closed.
let shareFiles: Record<"pdf" | "dxf", Promise<File | null>> | null = null;
function closeShare() {
  const was = !shareMenu.hidden;
  shareMenu.hidden = true;
  for (const b of [shareBtn, fscShare]) b.setAttribute("aria-expanded", "false");
  if (was && app.classList.contains("fs-ctl")) showControls(); // the controls go three seconds after
}
const fetchFile = async (url: string, type: string): Promise<File | null> => {
  const r = await fetch(url).catch(() => null);
  if (!r || !r.ok) return null;
  const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? url.split("/").pop()!;
  return new File([await r.blob()], name, { type });
};
function toggleShare(e: Event) {
  e.stopPropagation();
  const it = cur();
  if (!it || it.kind !== "shopdrawing") return;
  if (!shareMenu.hidden) return closeShare();
  shareFiles = { pdf: fetchFile(it.payload.pdf, "application/pdf"), dxf: fetchFile(it.payload.dxf, "application/dxf") };
  shareMenu.hidden = false;
  (e.currentTarget as HTMLElement).setAttribute("aria-expanded", "true");
  if (app.classList.contains("fs-ctl")) showControls(); // held up while the menu is open
}
shareBtn.addEventListener("click", toggleShare);
fscShare.addEventListener("click", toggleShare);
shareMenu.addEventListener("click", async (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-share]");
  if (!b || !shareFiles) return;
  const kind = b.dataset.share as "pdf" | "dxf";
  closeShare();
  const file = await shareFiles[kind];
  if (!file) return line("I couldn't get that file just now.");
  // only ever on the owner's tap: the system share sheet (Mail, Messages, Files, AirDrop), or a download where there's none
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return;
    } catch (err) {
      if ((err as Error).name === "AbortError") return; // they closed the share sheet
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
});
document.addEventListener("pointerdown", (e) => {
  if (!shareMenu.hidden && !(e.target as Element).closest("#shareMenu,#shareBtn,#fscShare")) closeShare();
});

/* ---------- what's on screen, for the gateway ---------- */
let screenTimer: ReturnType<typeof setTimeout> | 0 = 0;
function reportScreen() {
  if (screenTimer) clearTimeout(screenTimer);
  screenTimer = setTimeout(() => {
    const it = cur();
    const v = curViewer();
    const model = (v as ModelView | null)?.state?.();
    const camera = model ? (v as ModelView).camera() : undefined;
    const set = state.open && state.set.length > 1 ? { set: state.set.map((i) => i.id) } : {}; // "pin this" keeps the pages beside it (13.2)
    gw.send({ type: "screen", item_id: it?.id ?? null, view: v?.getView(), stack_depth: state.history.length, page_index: state.idx, page_count: state.set.length, ...(padIsOpen ? { pad: true } : {}), ...(model ? { model } : {}), ...(camera ? { camera } : {}), ...set });
  }, 200);
}

/* ---------- open / page / close (DESIGN §4.2) ---------- */
function originFromCharacter(from?: HTMLElement) {
  const host = (from ?? $("charStage")).getBoundingClientRect(),
    a = app.getBoundingClientRect();
  if (!host.width) return;
  pull.style.setProperty("--ox", host.left + host.width / 2 - a.left + "px");
  pull.style.setProperty("--oy", host.top + host.height / 2 - a.top + "px");
}
const ctx: RenderCtx = {
  delegate: (phase, axis, dx = 0, dy = 0, v = { x: 0, y: 0 }) => delegate(phase, axis, dx, dy, v),
  attachGestures: (page, sc) => attachPageGestures(page, sc),
  onRow: (list, rowId) => void openRow(list, rowId),
  onSend: (rec, btn) => void send(rec, btn),
  onNotNow: (rec) => notNow(rec),
  approvalFor: (id) => approvals.get(id) ?? null,
  onViewerView: () => reportScreen(),
  onModelState: () => reportScreen(),
  missing: () => (offline() ? "This page isn't kept on the phone, and there's no reception." : undefined),
  onUnknown: () => void updater.unknownKind(), // something only a newer build can show (13.4)
};
/** No reception (or the computer can't be reached): pins still open from what's kept on the phone (13.2). */
const offline = () => !navigator.onLine || gw.status !== "open";
function snapshotView(): ViewState | null {
  return curViewer()?.getView() ?? null;
}
/** pin: opened from that pin (13.2); still: exactly where it was left, no fly-in; camera: a model's; from: bloom out of this.
 *  idx counts pages, after a shop drawing is spread into its sheets. */
function openSet(items: Item[], idx = 0, opts: { push?: boolean; view?: ViewState | null; pin?: string | null; still?: boolean; camera?: CamState | null; from?: HTMLElement } = {}) {
  items = items.flatMap(pagesOf);
  savePinPlace();
  if (state.open && opts.push !== false && state.set.length) state.history.push({ set: state.set, idx: state.idx, view: snapshotView(), pin: state.pinId });
  state.pinId = opts.pin ?? pinOfSet(items)?.id ?? null; // a pinned set opened any way remembers where he leaves it
  state.pages.forEach((p) => p.viewer?.destroy());
  track.innerHTML = "";
  state.set = items;
  state.idx = idx;
  const wasOpen = state.open;
  state.pages = items.map((it, i) => renderItem(it, !opts.still, ctx, i === idx ? (opts.camera ?? undefined) : undefined));
  state.pages.forEach((p) => track.appendChild(p.page));
  swipe = null;
  placeTrack(0, "none");
  void track.offsetWidth;
  updateCap();
  syncMoments();
  if (!wasOpen) {
    originFromCharacter(opts.from);
    pull.classList.remove("drop");
    pull.style.transform = "";
    pull.style.opacity = "";
    state.open = true;
    pull.classList.add("open");
    pull.setAttribute("aria-hidden", "false");
    app.classList.add("pulled");
  }
  syncFull();
  if (opts.view && state.pages[idx].viewer) state.pages[idx].viewer!.setView(opts.view);
  reportScreen();
}
/** Another page from the same turn (several results): add it without disturbing the page being looked at. */
function addPage(item: Item) {
  for (const it of pagesOf(item)) {
    const rec = renderItem(it, true, ctx);
    state.set = [...state.set, it];
    state.pages.push(rec);
    track.appendChild(rec.page);
  }
  updateCap();
  syncMoments();
  reportScreen();
}
function gotoPage(i: number) {
  i = Math.max(0, Math.min(state.set.length - 1, i));
  swipe = null; // "next one" said mid-drag: the finger lets go of the pages
  state.idx = i;
  placeTrack();
  updateCap();
  reportScreen();
}
function closePull(how: "voice" | "swipe" = "voice") {
  if (!state.open) return;
  savePinPlace();
  state.pinId = null;
  state.open = false;
  state.history = [];
  fs.user = fs.optOut = false;
  hideControls(); // full screen itself stays until it's gone from view, so the page doesn't change size as it goes
  app.classList.remove("pulled");
  pull.setAttribute("aria-hidden", "true");
  const done = () => {
    if (state.open) return;
    syncFull();
    state.pages.forEach((p) => p.viewer?.destroy());
    state.pages = [];
    track.innerHTML = "";
    state.set = [];
  };
  if (how === "swipe") {
    pull.classList.remove("dragging");
    pull.style.transition = "transform .32s var(--ease-out)";
    pull.style.transform = "translateY(100%)";
    setTimeout(() => {
      pull.style.transition = "none";
      pull.classList.remove("open");
      pull.style.transform = "";
      void pull.offsetWidth;
      pull.style.transition = "";
      done();
    }, 340);
  } else {
    originFromCharacter();
    pull.classList.remove("open");
    setTimeout(done, 600);
  }
  syncMoments();
  reportScreen();
}
function goBack() {
  const h = state.history.pop();
  if (!h) return false;
  openSet(h.set, h.idx, { push: false, view: h.view, pin: h.pin });
  return true;
}

/* gestures handed up from pages: sideways = next result, down = put it away (DESIGN §5.5) */
function delegate(phase: string, axis: "x" | "y", dx: number, dy: number, v: { x: number; y: number }): boolean {
  if (phase === "can") return axis === "x" ? state.set.length > 1 : true;
  const h = pull.clientHeight,
    w = track.clientWidth;
  if (axis === "x") {
    const last = state.set.length - 1;
    const beyond = (raw: number) => (state.idx === 0 && raw > 0) || (state.idx === last && raw < 0);
    if (phase === "start") {
      held = false;
      let from = trackOffset(); // 0 at rest; mid-glide, measured from the page it was heading for
      if (Math.abs(from) < 0.5) from = 0;
      if (beyond(from)) from /= GIVE;
      swipe = { from, dx0: from ? dx : 0, raw: from, off: from };
    }
    if (!swipe) return true;
    if (phase === "move") {
      swipe.raw = swipe.from + dx - swipe.dx0;
      swipe.off = beyond(swipe.raw) ? swipe.raw * GIVE : swipe.raw;
      placeTrack(swipe.off, "none");
    }
    if (phase === "end" || phase === "cancel") {
      const { raw, off, from: start } = swipe;
      swipe = null;
      // Which page: a flick goes one on from the page it was on (or heading for, mid-glide: so quick flicks one after
      // another each turn one more page); otherwise the next one the finger was heading for, once a fifth of it is in
      // view. From rest that's as before: a flick, or a fifth of the way across, turns the page.
      const p = state.idx - raw / w; // the page in the middle of the screen, as a fraction
      const travel = raw - start;
      let i: number;
      if (phase === "cancel") i = Math.round(p);
      else if (v.x < -0.45) i = Math.max(state.idx + 1, Math.floor(p) + 1);
      else if (v.x > 0.45) i = Math.min(state.idx - 1, Math.ceil(p) - 1);
      else if (travel < 0) i = p - Math.floor(p) > 0.2 ? Math.ceil(p) : Math.floor(p);
      else i = Math.ceil(p) - p > 0.2 ? Math.floor(p) : Math.ceil(p);
      i = Math.max(0, Math.min(last, i));
      const from = off + (i - state.idx) * w;
      if (i !== state.idx) {
        state.idx = i;
        updateCap();
        reportScreen();
      }
      settle(from, phase === "end" ? v.x : 0);
    }
  } else {
    if (phase === "start") pull.classList.add("dragging");
    if (phase === "move") pull.style.transform = `translateY(${Math.max(0, dy)}px)`;
    if (phase === "end" || phase === "cancel") {
      if (phase === "end" && (dy > h * 0.2 || v.y > 0.55)) {
        closePull("swipe");
        setSub("", "");
        anim.set(voiceAnim());
      } else {
        pull.classList.remove("dragging");
        pull.style.transition = "transform .4s var(--ease)";
        pull.style.transform = "";
        setTimeout(() => {
          pull.style.transition = "";
        }, 420);
      }
    }
  }
  return true;
}
function attachPageGestures(page: HTMLElement, scroller: HTMLElement) {
  type PSt = { id: number; x0: number; y0: number; axis: "x" | "y" | null; type: string; lt: number };
  let st: PSt | null = null;
  let ts: { x0: number; y0: number; top: boolean; axis: "y" | null; ly: number; lt: number; vy: number } | null = null;
  const trail = new Trail(); // how fast the finger was going as it lets go (12.0)
  page.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as Element).closest(".sv-host,[contenteditable='true'],.tbl-wrap")) return; // the viewer, text and wide tables handle their own
    st = { id: e.pointerId, x0: e.clientX, y0: e.clientY, axis: null, type: e.pointerType, lt: performance.now() };
    trail.start(e.clientX, e.clientY);
  });
  page.addEventListener("pointermove", (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x0,
      dy = e.clientY - st.y0;
    st.lt = performance.now();
    trail.add(e.clientX, e.clientY);
    const vel = trail.velocity();
    if (!st.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.15 && delegate("can", "x", 0, 0, vel)) st.axis = "x";
      else if (st.type !== "touch" && dy > 0 && Math.abs(dy) > Math.abs(dx) && scroller.scrollTop <= 0) st.axis = "y";
      else {
        st = null;
        return;
      }
      try {
        page.setPointerCapture(e.pointerId);
      } catch {}
      delegate("start", st.axis, dx, dy, vel);
    }
    delegate("move", st.axis, dx, dy, vel);
  });
  const end = (e: PointerEvent) => {
    if (!st || e.pointerId !== st.id) return;
    if (st.axis) {
      delegate(e.type === "pointercancel" ? "cancel" : "end", st.axis, e.clientX - st.x0, e.clientY - st.y0, performance.now() - st.lt > 90 ? { x: 0, y: 0 } : trail.velocity());
      page.addEventListener("click", (ev) => ev.stopPropagation(), { capture: true, once: true });
    }
    st = null;
  };
  page.addEventListener("pointerup", end);
  page.addEventListener("pointercancel", end);
  // Touch: a downward drag from the top of the page dismisses; needs a non-passive touchmove (DESIGN §8).
  page.addEventListener(
    "touchstart",
    (e) => {
      if ((e.target as Element).closest(".sv-host")) return void (ts = null);
      ts = e.touches.length === 1 ? { x0: e.touches[0].clientX, y0: e.touches[0].clientY, top: scroller.scrollTop <= 0, axis: null, ly: e.touches[0].clientY, lt: performance.now(), vy: 0 } : null;
    },
    { passive: true },
  );
  page.addEventListener(
    "touchmove",
    (e) => {
      if (!ts || !ts.top || e.touches.length !== 1) return;
      const t = e.touches[0],
        dx = t.clientX - ts.x0,
        dy = t.clientY - ts.y0,
        now = performance.now();
      ts.vy = (t.clientY - ts.ly) / Math.max(1, now - ts.lt);
      ts.ly = t.clientY;
      ts.lt = now;
      if (!ts.axis) {
        if (Math.hypot(dx, dy) < 8) return;
        if (dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.15) {
          ts.axis = "y";
          delegate("start", "y", dx, dy, { x: 0, y: ts.vy });
        } else {
          ts = null;
          return;
        }
      }
      e.preventDefault();
      delegate("move", "y", dx, dy, { x: 0, y: ts.vy });
    },
    { passive: false },
  );
  page.addEventListener("touchend", (e) => {
    if (ts && ts.axis) {
      const t = e.changedTouches[0];
      delegate("end", "y", t.clientX - ts.x0, t.clientY - ts.y0, { x: 0, y: performance.now() - ts.lt > 90 ? 0 : ts.vy });
    }
    ts = null;
  });
}
// the caption bar always drags the whole thing down
(function () {
  let st: { id: number; y0: number; ly: number; lt: number; vy: number; started: boolean } | null = null;
  cap.addEventListener("pointerdown", (e) => {
    if ((e.target as Element).closest("button")) return; // the pin and full-screen buttons are tapped, not dragged
    st = { id: e.pointerId, y0: e.clientY, ly: e.clientY, lt: performance.now(), vy: 0, started: false };
    try {
      cap.setPointerCapture(e.pointerId);
    } catch {}
  });
  cap.addEventListener("pointermove", (e) => {
    if (!st || st.id !== e.pointerId) return;
    const dy = e.clientY - st.y0,
      now = performance.now();
    st.vy = (e.clientY - st.ly) / Math.max(1, now - st.lt);
    st.ly = e.clientY;
    st.lt = now;
    if (!st.started) {
      if (Math.abs(dy) < 6) return;
      st.started = true;
      delegate("start", "y", 0, dy, { x: 0, y: 0 });
    }
    delegate("move", "y", 0, dy, { x: 0, y: st.vy });
  });
  const end = (e: PointerEvent) => {
    if (st && st.started) delegate("end", "y", 0, e.clientY - st.y0, { x: 0, y: performance.now() - st.lt > 90 ? 0 : st.vy });
    st = null;
  };
  cap.addEventListener("pointerup", end);
  cap.addEventListener("pointercancel", end);
})();

/* ---------- full screen (13.1) ----------
   Turned sideways with something up, the page takes the whole screen; upright, the button in the caption does the same.
   Pebble's strip, the caption and every button go; one tap on the page brings the controls back for three seconds. The
   page itself is untouched: the viewers keep their zoom and place when the space they have changes. */
const sidewaysQ = matchMedia("(orientation: landscape) and (max-height: 500px)"); // a phone on its side, not a wide window
const fs = { user: false, optOut: false }; // asked for upright; turned off while sideways (until it's turned upright)
const isFull = () => state.open && (fs.user || (sidewaysQ.matches && !fs.optOut));
function syncFull() {
  const on = isFull();
  if (app.classList.contains("fs") === on) return;
  app.classList.toggle("fs", on);
  if (!on) hideControls();
  else if (anim.state === "speaking" || anim.state === "thinking") signUpdate(); // only what's being said now, nothing stale
  else $("fsSign").classList.remove("on");
}
function toggleFull() {
  if (isFull()) (fs.user = false), (fs.optOut = sidewaysQ.matches);
  else if (sidewaysQ.matches) fs.optOut = false;
  else fs.user = true;
  syncFull();
}
sidewaysQ.addEventListener("change", () => {
  fs.user = false; // turned upright: the normal view; turned sideways: full screen again
  fs.optOut = false;
  syncFull();
});
$("fsBtn").addEventListener("click", toggleFull);
$("fscExit").addEventListener("click", toggleFull);
$("fscClose").addEventListener("click", () => closePull("voice"));
$("fscPin").addEventListener("click", () => {
  $("pinBtn").click();
  showControls();
});
const fsc = $("fsc");
let ctlTimer: ReturnType<typeof setTimeout> | 0 = 0;
/** What the controls say: the sheet (or the item's name), which of how many, and whether it's pinned. */
function renderControls() {
  const it = cur();
  if (!it) return;
  const label = it.kind === "sheet" ? (it.payload.sheet_no ?? it.payload.title ?? it.title) : it.title;
  $("fscMid").innerHTML = `<b>${esc(label)}</b>${state.set.length > 1 ? `<span class="m">${state.idx + 1} of ${state.set.length}</span>` : ""}`;
  syncPinButtons();
}
function showControls(ms = 3000) {
  if (!cur()) return;
  renderControls();
  app.classList.add("fs-ctl");
  fsc.inert = false;
  if (ctlTimer) clearTimeout(ctlTimer);
  ctlTimer = setTimeout(() => (shareMenu.hidden ? hideControls() : showControls(ms)), ms); // not while Share's menu is open
}
function hideControls() {
  if (ctlTimer) clearTimeout(ctlTimer);
  ctlTimer = 0;
  app.classList.remove("fs-ctl");
  fsc.inert = true;
}
fsc.addEventListener("pointerdown", () => ctlTimer && showControls()); // using them keeps them up
// One tap shows them. Watched from outside, never taken: pinch, pan, double-tap and the sideways swipe all carry on as
// before. A tap only counts once no second tap follows (that's a double-tap, the viewer's zoom), so it waits 330 ms.
(function () {
  const pagesEl = $("pages");
  let t: { id: number; x: number; y: number; at: number; spoilt: boolean } | null = null;
  let wait: ReturnType<typeof setTimeout> | 0 = 0;
  const opts = { capture: true, passive: true };
  pagesEl.addEventListener(
    "pointerdown",
    (e) => {
      if (!app.classList.contains("fs")) return;
      if (wait) {
        clearTimeout(wait); // a second tap: the viewer's double-tap
        wait = 0;
        t = null;
        return;
      }
      if (t) return void (t.spoilt = true); // a second finger: a pinch
      const busy = (e.target as Element).closest("button,a,input,textarea,[contenteditable='true'],[data-row],.m3-bar,.m3-offer");
      t = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now(), spoilt: !!busy || Math.abs(trackOffset()) > 0.5 };
    },
    opts,
  );
  pagesEl.addEventListener("pointermove", (e) => t && e.pointerId === t.id && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10 && (t.spoilt = true), opts);
  pagesEl.addEventListener("pointercancel", () => (t = null), opts);
  pagesEl.addEventListener(
    "pointerup",
    (e) => {
      if (!t || e.pointerId !== t.id) return;
      const tap = !t.spoilt && performance.now() - t.at < 350;
      t = null;
      if (!tap) return;
      wait = setTimeout(() => {
        wait = 0;
        if (!app.classList.contains("fs")) return;
        if (app.classList.contains("fs-ctl")) hideControls();
        else showControls();
      }, 330);
    },
    opts,
  );
})();

/* ---------- pins (13.2): a small row under Pebble, only when something's pinned; one tap opens it where he left it ---------- */
const pins = createPins({
  row: $("pins"),
  pick: $("pick"),
  pickScrim: $("pickScrim"),
  pickBody: $("pickBody"),
  open: (p, from) => void openPin(p, from),
  say: (t) => line(t),
  onChange: () => {
    syncPinButtons();
    if (state.pinId && !pins.list.some((p) => p.id === state.pinId)) state.pinId = null; // unpinned while it was up
    if (state.open && !state.pinId) state.pinId = pinOfSet(state.set)?.id ?? null; // pinned by voice while it's up
  },
});
/** The pin holding exactly these pages, if there is one (a set of shop drawings counts once, however many sheets). */
function pinOfSet(items: Item[]) {
  const ids = [...new Set(items.map((i) => i.id))].join();
  return pins.list.find((p) => p.item_ids.join() === ids) ?? null;
}
async function openPin(p: Pin, from: HTMLElement) {
  if (state.open) return;
  // With no reception, a pin opens from what's kept on the phone; if its page isn't kept (yet), say so plainly.
  if (offline() && !(await pins.stored(p))) return line("That one isn't kept on the phone yet, and there's no reception. It'll open once you're back in range.");
  const { pages, at } = pinPages(p); // a set of shop drawings opens at the sheet he left it on
  const model = pages[at]?.kind === "model";
  openSet(pages, at, { pin: p.id, still: true, view: model ? null : p.view, camera: model ? p.camera : null, from });
}
/** Leaving pages opened from a pin (closing them, opening something else, or putting the phone down): where he left it. */
function savePinPlace() {
  if (!state.pinId || !state.open || !state.set.length) return;
  pins.savePlace(state.pinId, onScreen());
}
addEventListener("visibilitychange", () => document.hidden && savePinPlace());

/* ---------- items arriving ---------- */
let lastTurnJob: string | null = null;
function onItem(item: Item, open: boolean, replaces?: string) {
  if (item.kind === "draft") draftItem.set(item.payload.approval_id, item.id);
  // a changed model takes the old one's place, seen from where it was being looked at (Stage 9.3)
  const at = replaces ? state.set.findIndex((i) => i.id === replaces) : -1;
  if (at >= 0) {
    const old = state.pages[at];
    const rec = (state.pages[at] = renderItem((state.set[at] = item), false, ctx, (old.viewer as ModelView).camera()));
    old.viewer?.destroy();
    old.page.replaceWith(rec.page);
    updateCap();
    return reportScreen();
  }
  if (!open) return syncMoments();
  // more results from the turn already up: another page to swipe to
  // (a shop drawing opens as its own set even after a model in the same turn: "reissue it" should show the drawing)
  if (state.open && item.job_id && item.job_id === lastTurnJob && item.kind !== "shopdrawing" && state.set.some((i) => i.job_id === item.job_id) && !state.set.some((i) => i.id === item.id)) return addPage(item);
  lastTurnJob = item.job_id;
  // a shop drawing opens at the sheet a view he just asked for went on (19.3)
  openSet([item], item.kind === "shopdrawing" && item.payload.open_at ? Math.min(item.payload.open_at, item.payload.sheets.length) - 1 : 0);
}
function onItemUpdate(id: string, patch: Partial<Item>) {
  const i = state.set.findIndex((x) => x.id === id);
  if (i < 0) return;
  const next = { ...state.set[i], ...patch } as Item;
  state.set[i] = next;
  const rec = state.pages[i];
  rec.item = next;
  if (next.kind === "draft") {
    if (!rec.page.classList.contains("sentcover")) renderDraft(rec, ctx);
  } else if ((next.kind === "sheet" || next.kind === "reference") && rec.viewer && patch.payload) {
    rec.viewer.setMarks(next.payload.marks);
  }
  if (i === state.idx) updateCap();
  syncMoments();
}
async function openRow(list: Item, rowId: string) {
  const r = await fetch(`/api/items/${list.id}/rows/${encodeURIComponent(rowId)}/open`, { method: "POST" }).catch(() => null);
  const body = r && r.ok ? ((await r.json()) as { item: Item }) : null;
  if (!body) return line("I couldn't open that one.");
  openSet([body.item]);
  if (list.kind === "list" && list.title !== "Shown today") line('Say "go back" for the list.');
}
function onSurface(cmd: SurfaceCommand) {
  const v = curViewer();
  switch (cmd.cmd) {
    case "model":
    case "model_pictures":
    case "model_save":
      return void ((cmd.cmd === "model" ? v : state.pages.find((p) => p.item.id === cmd.item_id)?.viewer) as ModelView | undefined)?.handle?.(cmd);
    case "pad":
      return void openSketchPad({ prompt: cmd.prompt, over: cmd.over });
    case "clear":
      return closePull("voice");
    case "back":
      return void goBack();
    case "next":
      return gotoPage(state.idx + 1);
    case "prev":
      return gotoPage(state.idx - 1);
    case "zoom_out":
      return v?.zoomOut();
    case "zoom_in":
      return v?.zoomIn();
    case "focus":
      return v?.focus(cmd.box, cmd.mark);
    case "open":
      return void fetch(`/api/items/${cmd.item_id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { item: Item } | null) => b && openSet([b.item]));
  }
}

/* ---------- approvals (DESIGN §4.5) ---------- */
function waitForApproval(itemId: string, notId: string, ms = 5000) {
  return new Promise<Approval | null>((resolve) => {
    const t = setTimeout(() => (off(), resolve(null)), ms);
    const off = gw.on("approval", (m) => {
      const a = m.approval;
      if (a.item_id === itemId && a.id !== notId) {
        clearTimeout(t);
        off();
        resolve(a);
      }
    });
  });
}
function waitForOutcome(approvalId: string) {
  return new Promise<{ status: string; message: string }>((resolve) => {
    const off = gw.on("outcome", (m) => {
      if (m.outcome.approvalId === approvalId) {
        off();
        resolve(m.outcome);
      }
    });
  });
}
async function send(rec: PageRec, btn: HTMLButtonElement) {
  if (btn.disabled || rec.item.kind !== "draft") return;
  if (teamPreviewApproval(btn)) return;
  const my = ++token;
  let a = approvals.get(rec.item.payload.approval_id);
  if (!a) return;
  btn.disabled = true;
  btn.innerHTML = "Sending";
  const edit = editedEmail(rec);
  if (edit) {
    gw.send({ type: "revise", id: a.id, nonce: a.nonce, subject: edit.subject, body: edit.body });
    const next = await waitForApproval(rec.item.id, a.id);
    if (!next) return failSend(rec, "I couldn't save your changes. Nothing was sent.");
    a = next;
  }
  const outcome = waitForOutcome(a.id);
  const t0 = performance.now();
  gw.send({ type: "decide", id: a.id, nonce: a.nonce, decision: "approve" });
  const o = await outcome;
  await sleep(Math.max(0, (reduce() ? 0 : 450) - (performance.now() - t0)));
  if (!["accepted", "verified"].includes(o.status)) return failSend(rec, o.message);
  btn.classList.add("sent");
  btn.innerHTML = `${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'}Sent`;
  rec.page.classList.add("sentcover");
  Palette.hold(null);
  Palette.flash("done", 1000);
  await sleep(reduce() ? 200 : 950);
  if (my !== token) return;
  closePull("voice");
  await sleep(reduce() ? 0 : 450);
  void speak(o.message, { aloud: true });
}
function failSend(rec: PageRec, message: string) {
  Palette.flash("error", 2200);
  renderDraft(rec, ctx);
  line(message);
}
function notNow(rec: PageRec) {
  if (rec.item.kind !== "draft") return;
  const a = approvals.get(rec.item.payload.approval_id);
  if (a) gw.send({ type: "decide", id: a.id, nonce: a.nonce, decision: "reject" });
  Palette.hold(null);
  closePull("voice");
  void speak("Okay. I'll keep it for later.", { aloud: true });
}

/* ---------- moments (DESIGN §3.7): amber while something waits for an OK; green and red washes come from events ---------- */
function syncMoments() {
  // as the mockup: amber while a draft that can still be sent is up on screen
  const waiting = state.open && state.set.some((i) => i.kind === "draft" && i.payload.status === "pending" && approvals.has(i.payload.approval_id));
  if (waiting && Palette.currentMood() !== "done" && Palette.currentMood() !== "error") Palette.hold("ok");
  else if (!waiting) Palette.hold(null);
}

/* ---------- the voice ---------- */
let voiceState: VoiceState = "off";
/** The round table (Stage 17.3), when one is on: it has a say in Pebble's state and in what the call hears. */
let table: PhoneTable | null = null;
const voiceAnim = () => table?.pebbleState() ?? (voiceState === "listening" ? "listening" : voiceState === "thinking" || voiceState === "connecting" ? "thinking" : voiceState === "speaking" ? "speaking" : "idle");
const voice = createVoice(gw.id, {
  onState: (s) => {
    voiceState = s;
    anim.set(voiceAnim());
    if (s === "connecting" && !teamActive()) hint("Connecting…");
    else if (s === "listening" && !subS.textContent) line("Go ahead.", "hint");
    else if (s === "muted") line("Muted. Tap to talk.", "hint");
  },
  onHeard: (t) => (teamVoice("heard", t), table?.ownerHeard(t), t && !teamActive() && setSub(esc(`“${t}”`), "you")),
  onSaid: (t) => t && (++token, setSub(esc(t))),
  onLevel: (l) => (teamVoice("level", l), table?.liveLevel(l) ? undefined : (anim.level = l)),
  onEnded: (msg) => {
    teamVoice("end", "");
    anim.set("idle");
    if (msg) line(msg);
  },
});
/* "Open <name>" from a Shortcut (14.3): opened with ?talk=1, start listening, or one big "Tap to talk" */
const testing = import.meta.env.DEV || new URLSearchParams(location.search).has("test");
let talkFlag = takeTalkFlag();
let talkDecision: TalkDecision = "none";
async function talkFromLink() {
  talkFlag = false;
  if (voice.on) return;
  talkDecision = await decideTalk(voiceReady);
  if (talkDecision === "no-voice") line("Voice isn't set up yet. You can type to me in the meantime.");
  else if (talkDecision === "start") tapToTalk();
  else showTalkTarget(app, tapToTalk);
}
function tapToTalk() {
  anim.press();
  if (app.classList.contains("offline")) return;
  if (!voice.on && !voiceReady) return void line("Voice isn't set up yet. You can type to me in the meantime.");
  stopLocal();
  voice.tap();
}
/* The round table (Stage 17.3): its screen and voices are loaded the first time one is on (nothing of it otherwise). */
let tableLoad: Promise<PhoneTable> | null = null;
function tableMessage(m: ServerMessage) {
  // while a round table is on, the call's own voice is muted here: only the table's lines are heard (18.1)
  if (m.type === "table") voice.muteVoice(m.on);
  if (table) return table.message(m);
  if (!tableLoad && (m.type !== "table" || !m.on)) return; // nothing to show for one that isn't on
  // (anything that comes while it's loading waits its turn behind the first)
  tableLoad ??= import("./table").then(({ createPhoneTable }) =>
    (table = createPhoneTable({
      app,
      stage: $("stage"),
      anim,
      gw,
      tapToTalk,
      soundOn: () => settings["ui.sound"] !== false,
      callOn: () => voice.on,
      context: () => voice.audioContext,
      pebbleDay: () => Palette.colourFor(settings),
      onPebble: () => anim.set(voiceAnim()),
      onEnd: (last) => (last ? line(last) : undefined),
    })),
  );
  void tableLoad.then((t) => t.message(m));
}
gw.on("table", tableMessage);
gw.on("table_say", tableMessage);
gw.on("table_hush", tableMessage);
gw.on("call_voice", (m) => voice.muteVoice(m.muted));
let pressTimer: ReturnType<typeof setTimeout> | 0 = 0;
let longPressed = false;
for (const id of ["charBtn", "stripTalk"]) {
  const b = $(id);
  b.addEventListener("pointerdown", () => {
    anim.press();
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      openQuick();
    }, 500);
  });
  const cancel = () => pressTimer && clearTimeout(pressTimer);
  b.addEventListener("pointerup", cancel);
  b.addEventListener("pointerleave", cancel);
  b.addEventListener("pointercancel", cancel);
  b.addEventListener("contextmenu", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    if (longPressed) return;
    tapToTalk();
  });
}

/* ---------- brain replies ---------- */
const mine = (m: ServerBrain) => ("client" in m.origin ? m.origin.id === gw.id : m.origin.kind === "voice");
function onBrain(m: ServerBrain & { fast?: boolean }) {
  if (!mine(m)) return;
  if (m.phase === "thinking") {
    if (voiceState !== "speaking") anim.set("thinking");
    hint(m.label && m.label !== "Working on it" ? m.label : "Thinking");
  } else if (m.phase === "done") {
    voice.brainDone();
    shots.clearSent(); // the answer came: the photo thumbnails have done their job
    if (m.source === "typed") void speak(m.spoken ?? "", { aloud: true });
    else if (!voice.on) void speak(m.spoken ?? "");
  } else {
    voice.brainDone();
    Palette.flash("error", 2200);
    line(m.say ?? "Sorry, I hit a snag on that one.");
    anim.set(voiceAnim());
  }
}

/* ---------- typing (DESIGN §4.9) ---------- */
const typer = $<HTMLFormElement>("typer"),
  typeIn = $<HTMLInputElement>("typeIn");
function placeTyper() {
  // sit on top of the iPhone keyboard
  const vv = window.visualViewport;
  if (!vv) return;
  const lift = Math.max(0, innerHeight - vv.height - vv.offsetTop);
  typer.style.transform = typer.classList.contains("open") && lift > 0 ? `translateY(${-lift}px)` : "";
}
window.visualViewport?.addEventListener("resize", placeTyper);
window.visualViewport?.addEventListener("scroll", placeTyper);
function openTyper() {
  if (app.classList.contains("offline")) return;
  typer.classList.add("open");
  app.classList.add("typing"); // the pins row steps aside for the typing field and photos (13.2)
  setTimeout(() => typeIn.focus({ preventScroll: true }), 60);
}
function closeTyper() {
  typer.classList.remove("open");
  app.classList.remove("typing");
  typer.style.transform = "";
  typeIn.blur();
}
$("kbdStage").addEventListener("click", openTyper);
$("kbdStrip").addEventListener("click", openTyper);
$("typeClose").addEventListener("click", closeTyper);

/* ---------- photos (Stage 8.4): the camera button at the end of the type field ---------- */
const shots = createShots($("shots"), { say: (t) => line(t), onOpen: (s) => openPadFor(s) });
const camIn = $<HTMLInputElement>("camIn");
$("camBtn").addEventListener("click", () => camIn.click());
/* ---------- the sketch pad (Stage 8.5): asked for, or a sent photo tapped; loaded only when first opened ---------- */
let padIsOpen = false;
async function openSketchPad(o: { prompt?: string; over?: { file: string; src: string; w: number; h: number } } = {}) {
  closeTyper();
  const { openPad } = await import("../shared/pad");
  openPad({
    ...o,
    onState: (open) => ((padIsOpen = open), reportScreen()),
    onSend: async (blob, info) => {
      const r = await postPicture(blob, "sketch", () => undefined, info.over);
      // On a call the voice is told and hands it to the brain itself; otherwise the sketch starts a turn of its own.
      if (voice.on) return;
      ++token;
      setSub(esc("“Here's my sketch.”"), "you");
      anim.set("thinking");
      teamSend(gw, { type: "typed", text: "Here's my sketch.", request_id: `r-${Date.now().toString(36)}`, files: [r.file] });
    },
  });
}
/** Tapping a sent photo opens it in the pad, ready to draw on. */
async function openPadFor(s: Shot) {
  if (!s.file) return;
  let { w, h } = s;
  if (!w || !h) {
    const img = new Image();
    img.src = s.url;
    await img.decode().catch(() => undefined);
    (w = img.naturalWidth), (h = img.naturalHeight);
  }
  if (w && h) void openSketchPad({ over: { file: s.file, src: s.url, w, h } });
}
camIn.addEventListener("change", () => {
  if (camIn.files?.length) void shots.add(camIn.files);
  camIn.value = "";
});
typer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = typeIn.value.trim();
  if (!v) return; // photos on their own start nothing: they wait for him to say or type what he wants
  typeIn.value = "";
  closeTyper();
  ++token;
  if (!teamActive()) setSub(esc(`“${v}”`), "you");
  anim.set("thinking");
  const files = shots.count ? await shots.forMessage() : []; // the words go with the photos, as one message
  teamSend(gw, { type: "typed", text: v, request_id: `r-${Date.now().toString(36)}`, ...(files.length ? { files } : {}) });
});
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (quick.classList.contains("open")) closeQuick();
  else if (typer.classList.contains("open")) closeTyper();
  else if (state.open) closePull("voice");
});

/* ---------- speaks first (DESIGN §4.10) ---------- */
const seen = new Set<string>();
async function onNotices(items: { id: string; spoken: string }[]) {
  const fresh = items.filter((n) => !seen.has(n.id));
  if (!fresh.length) return;
  fresh.forEach((n) => seen.add(n.id));
  // mid-conversation: wait for the turn to finish
  for (let i = 0; i < 40 && (anim.state === "thinking" || anim.state === "speaking"); i++) await sleep(500);
  anim.attention(2);
  app.classList.remove("nudge");
  void app.offsetWidth;
  app.classList.add("nudge");
  setTimeout(() => app.classList.remove("nudge"), 2000);
  await sleep(reduce() ? 0 : 450);
  const newest = fresh[fresh.length - 1];
  void speak(fresh.length > 1 ? `${newest.spoken} And ${fresh.length - 1} more.` : newest.spoken);
  gw.send({ type: "seen", ids: fresh.map((n) => n.id) });
}

/* ---------- background work: a quiet line at the top, Pebble's shimmer ---------- */
/** Stage 21.3: the line says what the work is doing now, in plain words, updated at its real steps; a tap says which job. */
function setWorking(on: boolean, label = "", title = "") {
  state.working = on;
  state.workTitle = title;
  anim.working = on;
  app.classList.toggle("working", on);
  $("work").hidden = !on;
  $("workText").textContent = label;
}

/* ---------- long-press sheet: end call, sound, alerts, colour ---------- */
const quick = $("quick"),
  quickScrim = $("quickScrim");
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function openQuick() {
  if (teamMore()) return;
  openSettings();
}
function openSettings() {
  renderQuick();
  quick.classList.add("open");
  quickScrim.classList.add("open");
  quick.inert = false;
  quick.setAttribute("aria-hidden", "false");
}
function closeQuick() {
  quick.classList.remove("open");
  quickScrim.classList.remove("open");
  quick.inert = true;
  quick.setAttribute("aria-hidden", "true");
}
quickScrim.addEventListener("click", closeQuick);
document.addEventListener("phone-settings", openSettings);
function renderQuick() {
  const alerts = pushSupported && Notification.permission !== "granted";
  void import("./quick").then(({ quickHtml, bindQuick }) => {
    $("quickBody").innerHTML = quickHtml(settings, voice.on, alerts);
    bindQuick($("quickBody"), { settings: () => settings, voice, close: closeQuick, save: saveSettings, alerts: turnOnAlerts, refresh: renderQuick });
  });
}
async function saveSettings(patch: Settings) {
  applySettings(patch);
  const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).catch(() => null);
  if (!r?.ok) line("I couldn't save that just now.");
}

/* ---------- alerts (web push), as the original page ---------- */
const subscribePush = () => import("./push").then(m => m.subscribePush());
async function turnOnAlerts() {
  if (!pushSupported) return line("For alerts on iPhone: tap Share, then Add to Home Screen. Open me from there and turn alerts on.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return line("No worries, alerts are off. You can turn them on later in your iPhone settings.");
  line(await (await import("./push")).enableAlerts());
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .then(() => {
      if (pushSupported && Notification.permission === "granted") subscribePush().catch(() => {});
    })
    .catch((e) => console.warn("service worker", e));
}

/* ---------- updating itself after a new version goes live (13.4) ----------
   An app opened from the home screen keeps the code it was opened with until it's fully closed. When the gateway's
   hello names a newer build, it reloads at the first safe moment and reopens what was up (src/shared/update.ts). */
let callForTest = false; // the UI tests stand in for a call with this (a real one needs the voice service)
/** A tap-to-approve on screen: a draft that can still be sent. */
const approvalUp = () => state.open && state.set.some((i) => i.kind === "draft" && i.payload.status === "pending" && approvals.has(i.payload.approval_id));
const updater = createUpdater({
  kind: "phone",
  // not on a call, while typing, drawing on the pad, with a tap-to-approve, Share's menu or the pin chooser up, or while
  // it's answering
  safe: () =>
    !teamBusy() && voiceState === "off" && !callForTest && !table?.on && !typer.classList.contains("open") && !padIsOpen && !approvalUp() && shareMenu.hidden && !$("pick").classList.contains("open") && anim.state !== "thinking" && anim.state !== "speaking",
  save: () => (savePinPlace(), state.open && state.set.length ? placeOf(onScreen()) : null), // a pin keeps where he left it too
});
type Reopen = { item_ids: string[]; idx: number; view: ViewState | null; camera: CamPlace | null; sheet?: number };
/** Just updated: what was up comes back where it was (the sheet, the zoom), fetched from the computer. */
async function reopenAfterUpdate(r: Reopen | null) {
  if (!r?.item_ids?.length) return line("Updated to the new version.", "hint");
  const got = await Promise.all(r.item_ids.map((id) => fetch(`/api/items/${encodeURIComponent(id)}`).then((x) => (x.ok ? (x.json() as Promise<{ item: Item }>) : null), () => null)));
  const items = got.map((b) => b?.item).filter((i): i is Item => !!i);
  if (!items.length || state.open) return line(state.open ? "Updated to the new version." : "Updated to the new version. Ask for that again: it didn't come back up.", "hint");
  const { pages, at } = pinPages({ items, idx: Math.max(0, items.findIndex((i) => i.id === r.item_ids[r.idx])), sheet: r.sheet });
  const model = pages[at]?.kind === "model";
  openSet(pages, at, { still: true, view: model ? null : r.view, camera: model ? r.camera : null });
  line("Updated to the new version.", "hint");
}
const reopen = takeReopen<Reopen>();
if (reopen !== undefined) void reopenAfterUpdate(reopen);

/* ---------- messages from the gateway ---------- */
gw.on("*", (m: ServerMessage) => {
  if (teamActive() && ["background", "notice", "notices", "brain", "heard"].includes(m.type)) {
    if (m.type === "brain" && m.phase !== "thinking") { voice.brainDone(); shots.clearSent(); }
    return;
  }
  switch (m.type) {
    case "hello":
      updater.check("build" in m ? m.build : null); // a newer build live: reload when it's safe (13.4)
      voiceReady = !!m.voiceReady || (testing && (window as unknown as { __lhVoiceReadyForTest?: boolean }).__lhVoiceReadyForTest === true);
      if (talkFlag) void talkFromLink();
      applySettings(("settings" in m ? m.settings : {}) ?? {}, true);
      if (m.notice) line(m.notice);
      // On opening: the line written ahead for after a quiet spell (text only, never spoken), else the usual greeting.
      else if (!subS.textContent) line("first_run" in m && m.first_run ? "Tap me and say hello." : ("say" in m && m.say) || greeting());
      break;
    case "settings":
      applySettings(m.values);
      break;
    case "item":
      onItem(m.item, m.open, m.replaces);
      break;
    case "item_update":
      onItemUpdate(m.id, m.patch);
      break;
    case "surface":
      onSurface(m as SurfaceCommand);
      break;
    case "approval": {
      approvals.set(m.approval.id, m.approval);
      if (m.approval.item_id) draftItem.set(m.approval.id, m.approval.item_id);
      // a draft on screen gets its buttons back (after an edit made a new approval)
      const i = state.set.findIndex((x) => x.id === m.approval.item_id);
      if (i >= 0 && !state.pages[i].page.classList.contains("sentcover")) renderDraft(state.pages[i], ctx);
      syncMoments();
      break;
    }
    case "pins":
      pins.set(m.pins);
      break;
    case "approval_gone": {
      approvals.delete(m.id);
      syncMoments();
      if (m.reason === "expired" && state.set.some((x) => x.id === m.item_id)) line("That one timed out. Ask me again and I'll redo it.");
      break;
    }
    case "outcome": {
      const o = m.outcome;
      if (o.status !== "refused") approvals.delete(o.approvalId);
      if (o.status === "failed" || o.status === "unknown") Palette.flash("error", 2200);
      syncMoments();
      break;
    }
    case "brain":
      onBrain(m);
      break;
    case "heard":
      if (voice.on) setSub(esc(`“${m.text}”`), "you");
      break;
    case "notices":
      void onNotices(m.items);
      break;
    case "notice":
      void onNotices([m.notice]);
      break;
    case "background":
      setWorking(m.phase === "start", m.doing || m.title, m.title);
      break;
    case "live":
      if (m.state === "closed") voice.end();
      else if (m.state === "degraded" && m.message) line(m.message);
      break;
  }
});
$("work").addEventListener("click", () => {
  if (!state.working) return;
  const doing = $("workText").textContent ?? "";
  line(state.workTitle && state.workTitle !== doing ? `${state.workTitle}: ${doing}` : doing);
});

function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
  return `${part}. Tap me when you need something.`;
}

setTimeout(() => anim.attention(1), 500);
void pins.loadKept(); // the row at once, from what's kept on the phone; the gateway's list follows when it connects
startTeam(gw, anim, voice, item => openSet([item]), approvals, text => { stopLocal(); line(text, "", true); }, text => void speak(text, { aloud: true, owned: true }));

/* dev only: a handle for tests */
if (import.meta.env.DEV || new URLSearchParams(location.search).has("test")) {
  (window as unknown as { __lh: unknown }).__lh = { state, approvals, gw, anim, voice: () => voiceState, viewer: curViewer, openPad: openSketchPad, pins, update: updater, callForTest: (on: boolean) => (callForTest = on), talk: () => talkDecision, table: () => table, callMuted: () => voice.voiceMuted };
}
