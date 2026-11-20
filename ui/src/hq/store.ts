import { savedValue } from "../../../src/shared/earlier";
// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { checkScreens } from "./lib/selfUpdate";
import { create } from "zustand";
import { createGateway, type Gateway } from "../shared/gateway";
import type { Approval, Item, ClientMessage, Pin } from "../../../src/shared/protocol";
import type { TeamBot, Row, Live, Safety, HqState, EngineInfo, Subscription } from "./types";
import { request, oldRequest, setFixtureRequest } from "./lib/api";
import { fixtureMode, makeFixtures, toolGroups, fixtureItems, fixtureApproval, newFixtureBot } from "./dev/fixtures";
import { installLegacyFixtures } from "./dev/legacy";
import type { Computer } from "./lib/computer";

type Transcript = { generation: number; rev: number; rows: Row[]; dropped: Record<number, number> };
export type PinnedPlace = { item: string; view: Pin["view"]; camera: Pin["camera"]; sheet?: number; save: (view: Pin["view"], camera: Pin["camera"], sheet: number) => void };
type State = {
  unread: Record<string, boolean>;
  computers: Record<string, Computer>;
  bots: TeamBot[]; selected: string | null; transcripts: Record<string, Transcript>; live: Record<string, Live>;
  safety: Safety; guard: "up" | "down"; engines: Record<string, EngineInfo>; items: Record<string, Item>;
  approvals: Record<string, Approval & { item_id?: string }>; connected: boolean; loaded: boolean; error: string | null;
  page: string; viewer: Item | null; modal: "create" | "room" | "settings" | "search" | "bot" | "bot-card" | null;
  collapsed: boolean; detailsOpen: boolean; setupBot: string | null; call: { bot: string; state: string } | null;
  room: { name: string; bots: string[] } | null;
  subscriptions: Subscription[]; composeDraft: { bot: string; text: string } | null;
  pinnedPlace?: PinnedPlace | null;
};
export const useStore = create<State>(() => ({ unread: {}, computers: {}, subscriptions: [], composeDraft: null, bots: [], selected: null, transcripts: {}, live: {}, safety: { level: "walled", until: null, pinSet: false }, guard: "down", engines: {}, items: {}, approvals: {}, connected: false, loaded: false, error: null, page: "chat", viewer: null, modal: null, collapsed: false, detailsOpen: false, setupBot: null, call: null, room: null }));
export const set = useStore.setState;
// Leave the request in the composer's draft; only the owner sends it.
export function startBotSetup(bot?: TeamBot) {
  const lead = useStore.getState().bots.find(b => b.lead);
  if (!lead) { set({ modal: "create" }); return; }
  set({ setupBot: bot?.id ?? "new" });
  void selectBot(lead.id);
  set({ modal: null, composeDraft: { bot: lead.id, text: bot ? `Help me change ${bot.name}: ` : "Set up a new bot for " } });
}
let gateway: Gateway | null = null;
let refreshNumber = 0;
// What has arrived over the live link since a load of the whole state was asked for. Kept by kind: the first build
// kept one count for everything and threw the whole load away if anything at all had arrived, so opening the app
// while a bot was working (a live update every second) left the team empty: "Add your first bot".
const wire = { bots: 0, safety: 0, live: new Map<string, number>() };
export function mergeRows(bot: string, generation: number, rows: Row[], rev = 0) {
  const current = useStore.getState().transcripts[bot];
  const known = useStore.getState().bots.find(b => b.id === bot)?.generation ?? 0;
  if (generation < Math.max(current?.generation ?? 0, known)) return;
  const previous = current?.generation === generation ? current : { generation, rev: 0, rows: [], dropped: {} };
  const bySeq = new Map(previous.rows.map(r => [r.seq, r]));
  for (const row of rows) {
    if (row.bot !== bot || row.generation !== generation || row.kind !== row.body?.kind) continue;
    const before = bySeq.get(row.seq);
    if (row.rev > (previous.dropped[row.seq] ?? -1) && (!before || row.rev >= before.rev)) bySeq.set(row.seq, row);
  }
  set(s => ({ transcripts: { ...s.transcripts, [bot]: { generation, rev: Math.max(rev, previous.rev, ...rows.map(r => r.rev)), rows: [...bySeq.values()].sort((a, b) => a.seq - b.seq), dropped: previous.dropped } } }));
}
export async function loadRows(id: string) {
  const data = await request<{ generation: number; rows: Row[]; rev: number }>(`/bots/${encodeURIComponent(id)}/rows`);
  if (!Array.isArray(data.rows)) throw new Error("The conversation couldn't be read. Please try again.");
  mergeRows(id, data.generation, data.rows, data.rev);
}
export async function selectBot(id: string) {
  set(s => ({ selected: id, page: "chat", viewer: null, unread: { ...s.unread, [id]: false } }));
  try { localStorage.setItem("tavi-hq-bot", id); } catch { /* The choice can last for this visit. */ }
  try { await loadRows(id); } catch { set({ error: "Couldn't load the conversation. Try again." }); }
}
function applyBots(bots: TeamBot[]) {
  const before = useStore.getState();
  const selected = bots.some(b => b.id === before.selected) ? before.selected : (bots.find(b => b.lead) ?? bots[0])?.id ?? null;
  const transcripts = { ...before.transcripts };
  for (const b of bots) if (transcripts[b.id] && transcripts[b.id].generation < b.generation) delete transcripts[b.id];
  set({ bots, selected, transcripts, viewer: selected === before.selected ? before.viewer : null });
}
export async function refreshSubscriptions() {
  const subscriptions = await request<Subscription[]>("/subscriptions");
  if (!Array.isArray(subscriptions)) throw new Error("Couldn't read subscriptions.");
  set({ subscriptions });
}
export async function refresh() {
  const number = ++refreshNumber, before = { bots: wire.bots, safety: wire.safety, live: new Map(wire.live) };
  try {
    const state = await request<HqState>("/state");
    if (number !== refreshNumber) return;
    if (!Array.isArray(state.bots) || !Array.isArray(state.live) || !state.safety || !["open", "paused", "walled", "killed"].includes(state.safety.level)) throw new Error();
    // Each part of the loaded state is used unless something newer of that same kind arrived while it was on its way.
    if (before.bots === wire.bots) applyBots(state.bots);
    const fresh = state.live.filter(l => (before.live.get(l.bot) ?? 0) === (wire.live.get(l.bot) ?? 0));
    set(s => ({ live: { ...s.live, ...Object.fromEntries(fresh.map(l => [l.bot, l])) }, ...(before.safety === wire.safety ? { safety: state.safety, guard: state.guard } : {}) }));
    set({ loaded: true, error: null });
    await refreshSubscriptions().catch(() => {});
    const id = useStore.getState().selected;
    if (id) await loadRows(id);
    await Promise.all(useStore.getState().bots.filter(bot => bot.id !== id).map(bot => loadRows(bot.id).catch(() => {})));
  } catch { set({ loaded: true, error: "The team isn't available just now. The safety switch is still here." }); }
}
export function handleEvent(message: unknown) {
  if (!message || typeof message !== "object") return;
  const m = message as Record<string, any>;
  if (m.type === "hq_bots") wire.bots++;
  if (m.type === "hq_safety") wire.safety++;
  if (m.type === "hq_live" && typeof m.live?.bot === "string") wire.live.set(m.live.bot, (wire.live.get(m.live.bot) ?? 0) + 1);
  switch (m.type) {
    case "hq_row": if (m.row?.body && typeof m.row.bot === "string" && Number.isInteger(m.row.generation) && Number.isInteger(m.row.seq) && Number.isInteger(m.row.rev)) {
      const before = useStore.getState();
      const previous = before.transcripts[m.row.bot]?.rows.find(row => row.seq === m.row.seq);
      mergeRows(m.row.bot, m.row.generation, [m.row]);
      const accepted = useStore.getState().transcripts[m.row.bot]?.rows.find(row => row.seq === m.row.seq);
      if (accepted !== previous && accepted?.body.kind === "message" && accepted.body.from === "bot" && (!previous || accepted.generation > previous.generation || accepted.rev > previous.rev) && (before.selected !== m.row.bot || before.page !== "chat")) set(s => ({ unread: { ...s.unread, [m.row.bot]: true } }));
    } break;
    case "hq_row_dropped": {
      const current = useStore.getState().transcripts[m.bot];
      if (current?.generation !== m.generation) break;
      set(s => ({ transcripts: { ...s.transcripts, [m.bot]: { ...current, rows: current.rows.filter(r => r.seq !== m.seq), dropped: { ...current.dropped, [m.seq]: Number.MAX_SAFE_INTEGER } } } })); break;
    }
    case "hq_live": if (m.live && typeof m.live.bot === "string") set(s => ({ live: { ...s.live, [m.live.bot]: m.live },
      ...(s.selected === m.live.bot && s.bots.find(b => b.id === m.live.bot)?.computer && /browser|computer|screen|terminal|web page/i.test(m.live.doing ?? "") ? { detailsOpen: true } : {}) })); break;
    case "hq_computer": if (typeof m.bot === "string" && typeof m.computer?.has === "boolean") set(s => ({ computers: { ...s.computers, [m.bot]: m.computer }, bots: s.bots.map(b => b.id === m.bot ? { ...b, computer: m.computer.has } : b) })); break;
    case "hq_bots": if (Array.isArray(m.bots)) applyBots(m.bots); break;
    case "hq_safety": if (["open", "paused", "walled", "killed"].includes(m.safety?.level)) set({ safety: m.safety, ...(m.guard ? { guard: m.guard } : {}) }); break;
    case "hq_engine": void refreshSubscriptions().catch(() => {}); if (m.engine && typeof m.bot === "string") set(s => ({ engines: { ...s.engines, [m.bot]: m.engine } })); break;
    case "hello": void checkScreens(); if (Array.isArray(m.approvals)) set({ approvals: Object.fromEntries(m.approvals.map((a: Approval) => [a.id, a])) }); break;
    case "approval": if (m.approval?.nonce) set(s => ({ approvals: { ...s.approvals, [m.approval.id]: m.approval } })); break;
    case "approval_gone": set(s => { const approvals = { ...s.approvals }; delete approvals[m.id]; return { approvals }; }); break;
    case "item": if (m.item?.id) set(s => ({ items: { ...s.items, [m.item.id]: m.item }, ...(m.open ? { viewer: m.item } : {}) })); break;
    case "item_update": set(s => { const before = s.items[m.id]; if (!before) return {}; const item = { ...before, ...m.patch } as Item; return { items: { ...s.items, [m.id]: item }, ...(s.viewer?.id === m.id ? { viewer: item } : {}) }; }); break;
    case "outcome": void refresh(); break;
  }
}
export function startConnection() {
  try { set({ selected: savedValue(localStorage, "tavi-hq-bot") }); } catch { /* Open the main bot first. */ }
  if (fixtureMode) { installLegacyFixtures(); setupFixtures(); void refresh(); return () => {}; }
  gateway = createGateway("desktop", { onStatus(status) {
    set({ connected: status === "open" });
    if (status === "open") {
      gateway?.send({ type: "hello", v: 2, client: "desktop", id: gateway.id, hq: true } as ClientMessage);
      void refresh();
    }
  } });
  const off = gateway.on("*", m => handleEvent(m));
  void refresh();
  return () => { off(); gateway?.close(); gateway = null; };
}
export const socketId = () => gateway?.id ?? "hq-preview";
export function sendSocket(message: ClientMessage) {
  if (fixtureMode) { fixtureSocket(message); return; }
  if (!gateway || gateway.status !== "open") throw new Error("The connection is down. Nothing was approved. Try again when it returns.");
  gateway.send(message);
}
export async function openItem(ref: string) {
  try {
    const known = useStore.getState().items[ref];
    const item = known ?? (await oldRequest<{ item: Item }>(`/api/items/${encodeURIComponent(ref)}`)).item;
    set(s => ({ viewer: item, pinnedPlace: null, items: { ...s.items, [item.id]: item } }));
  } catch { set({ error: "Couldn't open that item. Please try again." }); }
}
export function reportError(error: unknown) { set({ error: error instanceof Error ? error.message : "Couldn't do that just now." }); }

let previewData: ReturnType<typeof makeFixtures>;
function setupFixtures() {
  previewData = makeFixtures();
  set({ connected: true, approvals: { [fixtureApproval.id]: fixtureApproval }, items: Object.fromEntries(fixtureItems.map(it => [it.id, it])) });
  setFixtureRequest(async (path, method, value) => {
    const body = value as any;
    const id = path.split("/")[2];
    if (path === "/subscriptions") return structuredClone(previewData.subscriptions);
    if (path === "/tool-groups") return structuredClone(toolGroups);
    if (path.startsWith("/subscriptions/") && method === "DELETE") {
      const provider = path.split("/")[2];
      const subscription = previewData.subscriptions.find(s => s.provider === provider); if (subscription) subscription.signedIn = false;
      return {};
    }
    if (path === "/state") return structuredClone(previewData.state);
    if (path.endsWith("/rows")) return { generation: previewData.state.bots.find(b => b.id === id)?.generation ?? 1, rev: 100, rows: previewData.rows.filter(r => r.bot === id) };
    if (path.endsWith("/engine")) {
      if (method === "PATCH") { previewData.engines[id] = { ...previewData.engines[id], ...body }; previewData.state.bots = previewData.state.bots.map(b => b.id === id ? { ...b, ...body } : b); applyBots(previewData.state.bots); handleEvent({ type: "hq_engine", bot: id, engine: previewData.engines[id] }); }
      return structuredClone(previewData.engines[id]);
    }
    if (path.endsWith("/messages")) {
      addPreviewRow(id, { kind: "message", from: "owner", text: body.text });
      addPreviewRow(id, { kind: "message", from: "bot", text: "I'll check that with you before anything is changed." });
      return { job_id: "preview-job", position: 0 };
    }
    if (path.endsWith("/fresh")) {
      const bot = previewData.state.bots.find(b => b.id === id)!; bot.generation++;
      previewData.rows = previewData.rows.filter(r => r.bot !== id);
      applyBots(previewData.state.bots.map(b => ({ ...b }))); mergeRows(id, bot.generation, []); return {};
    }
    if (path === "/safety") {
      if (body.level === "open" && body.pin !== "1234") throw new Error("That PIN wasn't right. The switch is still off.");
      previewData.state.safety = { ...previewData.state.safety, level: body.level, since: new Date().toISOString(), until: body.minutes ? new Date(Date.now() + body.minutes * 60_000).toISOString() : null };
      handleEvent({ type: "hq_safety", safety: previewData.state.safety }); return { safety: previewData.state.safety };
    }
    if (path.endsWith("/sign-in")) return { session: "preview-sign-in" };
    if (path.startsWith("/sign-in/")) return {};
    if (path === "/rooms/ask") {
      for (const member of body.bots) {
        addPreviewRow(member, { kind: "message", from: "owner", text: body.text });
        addPreviewRow(member, { kind: "message", from: "bot", text: "I'll compare the options and bring back a short answer." });
      }
      return { ok: true };
    }
    if (path === "/bots" && method === "POST") {
      const bot: TeamBot = { ...newFixtureBot(body.id, body.name, body.role), ...body, lead: previewData.state.bots.length === 0, generation: 1 };
      previewData.engines[bot.id] = { status: previewData.subscriptions.find(s => s.provider === bot.primary.provider)?.signedIn ? "ready" : "not_signed_in", primary: bot.primary, fallbacks: bot.fallbacks };
      previewData.state.bots.push(bot); applyBots([...previewData.state.bots]); return { bot };
    }
    if (path.startsWith("/bots/") && method === "PATCH") {
      previewData.state.bots = previewData.state.bots.map(b => b.id === id ? { ...b, ...body } : b); applyBots(previewData.state.bots); return {};
    }
    return {};
  });
}
function addPreviewRow(bot: string, body: Row["body"]) {
  const seq = Math.max(0, ...previewData.rows.filter(r => r.bot === bot).map(r => r.seq)) + 1;
  const row: Row = { bot, generation: previewData.state.bots.find(b => b.id === bot)!.generation, seq, rev: 100 + seq, ts: new Date().toISOString(), kind: body.kind, body };
  previewData.rows.push(row); handleEvent({ type: "hq_row", row });
}
function fixtureSocket(message: ClientMessage) {
  if (message.type === "decide") {
    previewData.rows = previewData.rows.map(r => r.body.kind === "card" && r.body.ref === message.id ? { ...r, rev: r.rev + 1, body: { ...r.body, state: message.decision === "approve" ? "approved" : "declined" } } : r);
    for (const row of previewData.rows) handleEvent({ type: "hq_row", row });
    handleEvent({ type: "approval_gone", id: message.id });
  }
  if (message.type === "revise") {
    const approval = useStore.getState().approvals[message.id];
    if (!approval) return;
    handleEvent({ type: "approval", approval: { ...approval, ...message, nonce: "preview-revised" } });
  }
}
