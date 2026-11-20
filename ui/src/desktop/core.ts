// Shared bits of the desktop app: the connection, Pebble, settings, live approvals, small helpers.
import { createGateway } from "../shared/gateway";
import { Animator } from "../shared/pebble/pebble";
import * as Palette from "../shared/palette";
import type { Approval, Settings } from "../../../src/shared/protocol";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export { esc } from "../shared/items/describe";
export const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const statusListeners = new Set<(s: string) => void>(); // before the connection: it reports "connecting" at once
export const gw = createGateway("desktop", { onStatus: (s) => statusListeners.forEach((f) => f(s)) });
export const onStatus = (f: (s: string) => void) => statusListeners.add(f);

export const anim = new Animator();

/** Settings as the gateway has them (the desktop sees all of them). */
export const state = {
  settings: {} as Settings,
  name: null as string | null,
  voiceReady: false,
  /** Live approvals by id; they carry the nonce that makes Send work. */
  approvals: new Map<string, Approval>(),
  page: "conversation",
};

export function applySettings(s: Settings, first = false) {
  state.settings = { ...state.settings, ...s };
  const theme = String(state.settings["ui.theme"] ?? "system");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const c = Palette.colourFor(state.settings);
  if (first) Palette.setNow(c);
  else Palette.blendTo(c, 900);
}

export async function saveSettings(patch: Settings) {
  applySettings(patch);
  const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).catch(() => null);
  if (!r?.ok) toast("Couldn't save that.");
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const r = await fetch(path, json === undefined ? rest : { ...rest, method: rest.method ?? "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

let toastTimer: ReturnType<typeof setTimeout> | 0 = 0;
export function toast(text: string) {
  let el = document.querySelector(".toast") as HTMLElement | null;
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("on");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove("on"), 2600);
}

export const time = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).replace(/\s?([ap])\.?m\.?/i, " $1m") : "");
export const when = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso),
    today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yest = new Date(today.getTime() - 86_400_000).toDateString() === d.toDateString();
  if (sameDay) return time(iso);
  if (yest) return `Yesterday ${time(iso)}`;
  return `${d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}, ${time(iso)}`;
};

export const IC = {
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 11h7v8.5M10.5 4.5V8M14 11h6.5M14 11v3"/></svg>',
  table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9h17M3.5 13.5h17M9 4.5v15"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.4"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  chev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  bell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3zM6.8 14h2.4"/></svg>',
  send: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10 16.5 3.5l-5 13-2.5-5.5z"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  folder: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3.5 6a1.5 1.5 0 0 1 1.5-1.5h3l1.5 2h5.5A1.5 1.5 0 0 1 16.5 8v6.5A1.5 1.5 0 0 1 15 16H5a1.5 1.5 0 0 1-1.5-1.5z"/></svg>',
  tick: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>',
  doc: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4.5 4.5A1.5 1.5 0 0 1 6 3h9.5v12H6a1.5 1.5 0 0 0-1.5 1.5zM4.5 16.5A1.5 1.5 0 0 0 6 18h9.5v-3"/><path d="M7.5 6.5h5" stroke-linecap="round"/></svg>',
  phone: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4.5" y="1.5" width="7" height="13" rx="1.6"/><path d="M7 12.5h2"/></svg>',
  globe: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5c2 2.2 2 10.8 0 13M10 3.5c-2 2.2-2 10.8 0 13"/></svg>',
  pc: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="10" rx="1.5"/><path d="M7 16.5h6M10 13.5v3"/></svg>',
};
export const kindIcon = (kind: string, op?: string) => (kind === "sheet" || kind === "sketch" || kind === "model" || kind === "shopdrawing" ? IC.plan : kind === "table" || kind === "reference" ? IC.table : kind === "draft" ? (op && op !== "email.send" ? IC.cal : IC.mail) : IC.list);

/** The pages besides the conversation. Their code (pages.ts) loads on first visit, so the conversation opens first. */
export const PAGES = ["activity", "memory", "connections", "files", "settings"] as const;
export type Page = (typeof PAGES)[number];
