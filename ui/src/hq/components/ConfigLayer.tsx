import { savedValue } from "../../../../src/shared/earlier";
// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useState, useRef } from "react";
import { useStore, set, selectBot, refresh, startBotSetup } from "../store";
import { request } from "../lib/api";
import { LookPicker } from "../avatar/LookPicker";
import { BotAvatar, BotAvatarFor } from "../avatar/BotAvatar";
import type { TeamBot } from "../types";
import { providerName } from "./Subscriptions";
import type { SavedJobCard } from "../types";
import { JobCard } from "./JobCard";
import { Modal } from "./Modal";
export function ConfigLayer() {
  const { modal, bots, selected } = useStore();
  const close = () => set({ modal: null });
  if (modal === "settings") return <Modal label="Appearance" onClose={close}><p>Choose what is easiest on your eyes.</p><div className="button-row">{["light", "dark", "system"].map(theme => <button className="btn btn--secondary" key={theme} onClick={() => { localStorage.setItem("tavi-hq-theme", theme); document.documentElement.dataset.theme = theme === "system" ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : theme; }}>{theme[0].toUpperCase() + theme.slice(1)}</button>)}</div></Modal>;
  if (modal === "create") return <JobCard onClose={close} />;
  if (modal === "bot" || modal === "bot-card") { const bot = bots.find(b => b.id === selected); return bot ? <BotSettings key={bot.id + modal} bot={bot} onClose={close} manual={modal === "bot-card"} /> : null; }
  if (modal === "room") return <CreateGroupModal onClose={close} />;
  if (modal === "search") return <SearchModal onClose={close} />;
  return null;
}
function SearchModal({ onClose }: { onClose: () => void }) {
  const bots = useStore(s => s.bots), [query, search] = useState("");
  return <Modal label="Find a bot" onClose={onClose}><input className="text-input" type="search" aria-label="Bot name or job" value={query} onChange={e => search(e.target.value)} /><div className="search-results">{bots.filter(b => `${b.name} ${b.role}`.toLowerCase().includes(query.toLowerCase())).map(b => <button className="bot-row" key={b.id} onClick={() => { void selectBot(b.id); onClose(); }}><BotAvatar {...b.look} /><span>{b.name} · {b.role}</span></button>)}</div></Modal>;
}
function BotSettings({ bot, onClose, manual = false }: { bot: TeamBot; onClose: () => void; manual?: boolean }) {
  const [view, show] = useState<"about" | "card" | "look" | "remove">(manual ? "card" : "about");
  const lead = useStore(s => s.bots.find(b => b.lead));
  const choice = useStore(s => s.engines[bot.id]?.primary) ?? bot.primary;
  const [name, setName] = useState(bot.name), [purpose, setPurpose] = useState(bot.card?.purpose ?? bot.role);
  const [outside, setOutside] = useState(bot.card?.notFor ?? ""), [result, setResult] = useState(bot.card?.handsBack ?? ""), [ask, setAsk] = useState(bot.card?.stopAndAsk ?? "");
  const [soul, setSoul] = useState(bot.soul);
  const [shape, setShape] = useState(bot.look.shape), [colour, setColour] = useState(bot.look.colour);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const action = useRef<HTMLButtonElement | null>(null);
  const open = (next: typeof view, button: HTMLButtonElement) => { action.current = button; setError(null); show(next); };
  const back = () => { show("about"); setError(null); requestAnimationFrame(() => action.current?.focus()); };
  const perform = async (work: () => Promise<void>) => { setBusy(true); setError(null); try { await work(); } catch { setError("Couldn't save that. Please try again."); } finally { setBusy(false); } };
  return <Modal label={bot.name + "'s settings"} onClose={onClose}>
    {view !== "about" && <button className="link-btn bot-settings-back" onClick={back}>&larr; Back to {bot.name}</button>}
    {view === "about" && <><div className="bot-identity"><BotAvatarFor bot={bot} size={68} /><div><h3>{bot.name}</h3>{bot.lead && <p className="quiet">Your main bot</p>}</div></div><dl className="bot-card-summary">
      <div><dt>What it is for</dt><dd title={bot.card?.purpose ?? bot.role}>{bot.card?.purpose ?? bot.role}</dd></div>
      {bot.card?.notFor && <div><dt>What it is not for</dt><dd title={bot.card.notFor}>{bot.card.notFor}</dd></div>}
      {bot.card?.handsBack && <div><dt>What it hands back</dt><dd title={bot.card.handsBack}>{bot.card.handsBack}</dd></div>}
    </dl><p className="bot-engine-line" title={[providerName(choice.provider), choice.model, choice.effort ?? "default"].join(" / ")}>{providerName(choice.provider)} &middot; {choice.model} &middot; {choice.effort ?? "default"}</p>
    <div className="bot-settings-actions"><button disabled={!lead} onClick={() => void startBotSetup(bot)}>Ask {lead?.name ?? "the main bot"} to change this</button><button onClick={e => open("card", e.currentTarget)}>Fill in the card myself</button><button onClick={e => open("look", e.currentTarget)}>Change its look</button><button disabled={busy} onClick={() => void perform(async () => { await request(`/bots/${encodeURIComponent(bot.id)}/fresh`, "POST"); await refresh(); await selectBot(bot.id); onClose(); })}>New conversation</button>{!bot.lead && <button className="error" onClick={e => open("remove", e.currentTarget)}>Remove from the team</button>}</div></>}
    {view === "card" && <form onSubmit={e => { e.preventDefault(); void perform(async () => {
      if (bot.card) {
        const card: SavedJobCard = { ...bot.card, purpose: purpose.trim(), notFor: outside.trim(), handsBack: result.trim(), stopAndAsk: ask.trim() };
        const changed = await request<{ passed?: boolean; status?: string }>(`/bots/${encodeURIComponent(bot.id)}/card`, "PUT", card);
        if (changed.passed === false || changed.status === "refused") throw new Error();
        if (name.trim() !== bot.name) await request(`/bots/${encodeURIComponent(bot.id)}`, "PATCH", { name: name.trim() });
      } else await request(`/bots/${encodeURIComponent(bot.id)}`, "PATCH", { name: name.trim(), role: purpose.trim(), soul });
      await refresh(); onClose();
    }); }}><label>Name<input className="text-input" required maxLength={60} value={name} onChange={e => setName(e.target.value)} /></label><label>What it is for<textarea aria-label="What it is for" required value={purpose} onChange={e => setPurpose(e.target.value)} /></label>{bot.card ? <><label>What it is not for<textarea aria-label="What it is not for" required value={outside} onChange={e => setOutside(e.target.value)} /></label><label>What it hands back<textarea aria-label="What it hands back" required value={result} onChange={e => setResult(e.target.value)} /></label><label>When it must stop and ask<textarea aria-label="When it must stop and ask" required value={ask} onChange={e => setAsk(e.target.value)} /></label><p className="quiet">Saving checks its trial examples before the new card goes live.</p></> : <label>Standing instructions<textarea aria-label="Standing instructions" value={soul} onChange={e => setSoul(e.target.value)} /></label>}<button className="btn btn--primary" disabled={busy}>Save bot</button></form>}
    {view === "look" && <form onSubmit={e => { e.preventDefault(); void perform(async () => { await request(`/bots/${encodeURIComponent(bot.id)}`, "PATCH", { look: { shape, colour } }); await refresh(); back(); }); }}><LookPicker shape={shape} colour={colour} setShape={setShape} setColour={setColour} used={useStore.getState().bots.map(b => b.look.shape)} /><button className="btn btn--primary" disabled={busy}>Save look</button></form>}
    {view === "remove" && <div className="bot-remove-confirm"><p>Remove {bot.name} from the team?</p><p className="quiet">Its work stops and it leaves the team.</p><div className="button-row"><button className="btn btn--secondary" onClick={back}>Keep {bot.name}</button><button className="btn btn--primary" disabled={busy} onClick={() => void perform(async () => { await request(`/bots/${encodeURIComponent(bot.id)}`, "DELETE"); await refresh(); onClose(); })}>Remove {bot.name}</button></div></div>}
    {busy && <p role="status">Saving…</p>}{error && <p className="error" role="alert">{error}</p>}
  </Modal>;
}
function CreateGroupModal({ onClose }: { onClose: () => void }) {
  const bots = useStore(s => s.bots);
  const [members, choose] = useState<string[]>(bots.slice(0, 2).map(b => b.id)), [name, changeName] = useState("Team room");
  return <Modal label="Start a room" onClose={onClose}><p>Bring at least two bots together to look at a job.</p><form onSubmit={e => { e.preventDefault(); set({ room: { name: name.trim(), bots: members }, page: "room", modal: null, viewer: null }); for (const id of members) void selectBotRows(id); }}><label>Room name<input className="text-input" required value={name} onChange={e => changeName(e.target.value)} /></label>{bots.map(bot => <label className="check-label" key={bot.id}><input type="checkbox" checked={members.includes(bot.id)} onChange={e => choose(e.target.checked ? [...members, bot.id] : members.filter(id => id !== bot.id))} /><BotAvatar {...bot.look} size={28} />{bot.name}</label>)}<button className="btn btn--primary" disabled={members.length < 2 || !name.trim()}>Start room</button></form></Modal>;
}
async function selectBotRows(id: string) { const { loadRows } = await import("../store"); await loadRows(id).catch(reportError); }
