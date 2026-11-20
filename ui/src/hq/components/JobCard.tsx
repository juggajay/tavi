import { useEffect, useState } from "react";
import { useStore, set, selectBot, refresh, startBotSetup } from "../store";
import { request, RequestError } from "../lib/api";
import { toolGroups } from "../dev/fixtures";
import { LookPicker, unusedIcon } from "../avatar/LookPicker";
import { BotAvatar } from "../avatar/BotAvatar";
import type { EngineChoice, ToolGroup } from "../types";
import { Modal } from "./Modal";
import { Choice } from "./EngineSettings";
const starters = [
  { name: "Researcher", purpose: "Read the web and compare options with sources.", outside: "Making purchases or decisions for me.", result: "A short report with links, a comparison and a recommendation.", ask: "Before using private information or signing in anywhere.", groups: ["computers", "show"] },
  { name: "Writer", purpose: "Draft and edit clear writing in my voice.", outside: "Publishing or sending anything.", result: "A draft I can review, with a short note about changes.", ask: "When facts are missing or before sharing a draft.", groups: ["files", "show"] },
  { name: "Organiser", purpose: "Help with my inbox, calendar and reminders.", outside: "Sending messages or changing dates without my OK.", result: "A short plan, draft replies and proposed reminders.", ask: "Before sending, booking or changing anything.", groups: ["mail", "actions", "show"] },
];
export function JobCard({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState(""), [purpose, setPurpose] = useState(""), [outside, setOutside] = useState(""), [result, setResult] = useState(""), [ask, setAsk] = useState("Ask before changing or sharing anything.");
  const [shape, setShape] = useState(() => unusedIcon(useStore.getState().bots.map(bot => bot.look.shape))), [colour, setColour] = useState("orange"), [computer, setComputer] = useState(false);
  const [groups, setGroups] = useState<ToolGroup[]>([]), [allowed, setAllowed] = useState<string[]>([]), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const subscriptions = useStore(s => s.subscriptions), lead = useStore(s => s.bots.find(b => b.lead));
  const [primary, setPrimary] = useState<EngineChoice>(() => ({ provider: "anthropic", model: subscriptions.find(s => s.provider === "anthropic")?.models?.[0]?.id ?? (lead?.primary.provider === "anthropic" ? lead.primary.model : ""), effort: "medium" }));
  useEffect(() => { let stopped = false; void request<ToolGroup[]>("/tool-groups").then(value => {
    if (!Array.isArray(value) || value.some(g => !g.id || !g.name || !g.description)) throw new Error();
    if (!stopped) setGroups(value);
  }).catch(error => { if (stopped) return; if (error instanceof RequestError && [404, 501].includes(error.status)) setGroups(toolGroups); else setError("Couldn't read the available tools. Close this card and try again."); }); return () => { stopped = true; }; }, []);
  const talk = () => startBotSetup();
  return <Modal label="Add a bot" onClose={onClose} wide><div className="job-card-intro"><p>Start with a job card, then make it your own.</p><button className="link-btn" disabled={!lead} onClick={() => void talk()}>Set it up by talking instead</button>{!lead && <small>Add your first bot to set up the next one by talking.</small>}</div><div className="starter-cards">{starters.map(card => <button className="starter-card" key={card.name} onClick={() => { setName(card.name); setPurpose(card.purpose); setOutside(card.outside); setResult(card.result); setAsk(card.ask); setAllowed(card.groups.filter(id => groups.some(g => g.id === id))); setComputer(card.name === "Researcher"); }}><b>{card.name}</b><span>{card.purpose}</span></button>)}</div><form onSubmit={async e => {
    e.preventDefault(); setError(null);
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 25).replace(/-$/, "");
    if (!id) { setError("Use a name with at least one letter or number."); return; }
    if (!primary.model.trim()) { setError("Choose a model for this bot."); return; }
    setBusy(true);
    const soul = `What it is for: ${purpose.trim()}\nNot for: ${outside.trim()}\nWhat it hands back: ${result.trim()}\nStop and ask: ${ask.trim()}`;
    try {
      await request("/bots", "POST", { id, name: name.trim(), role: purpose.trim(), soul, look: { shape, colour }, computer, servers: allowed, primary, fallbacks: [] });
      await refresh(); await selectBot(id); set({ setupBot: null }); onClose();
    } catch { setError("Couldn't save this bot. Check its name is different and try again."); } finally { setBusy(false); }
  }}><div className="job-card-grid"><section><label>Name<input className="text-input" required maxLength={60} value={name} onChange={e => setName(e.target.value)} /></label><label>What it is for<textarea aria-label="What it is for" required value={purpose} onChange={e => setPurpose(e.target.value)} /></label><label>What it is not for<textarea aria-label="What it is not for" required value={outside} onChange={e => setOutside(e.target.value)} /></label><label>What it hands back<textarea aria-label="What it hands back" required value={result} onChange={e => setResult(e.target.value)} /></label><label>When it must stop and ask<textarea aria-label="When it must stop and ask" required value={ask} onChange={e => setAsk(e.target.value)} /></label></section><section><LookPicker shape={shape} colour={colour} setShape={setShape} setColour={setColour} used={useStore.getState().bots.map(bot => bot.look.shape)} /><fieldset><legend>What it may use</legend>{!groups.length && <p className="quiet">Checking the available tools…</p>}{groups.map(group => <label className="tool-group" key={group.id}><input type="checkbox" checked={allowed.includes(group.id)} onChange={e => setAllowed(e.target.checked ? [...allowed, group.id] : allowed.filter(id => id !== group.id))} /><span><b>{group.name}</b><small>{group.description}</small></span></label>)}</fieldset><Choice value={primary} change={setPrimary} label="Engine" /><label className="check-label"><input type="checkbox" checked={computer} onChange={e => setComputer(e.target.checked)} />Give this bot its own computer</label></section></div>{error && <p role="alert" className="error">{error}</p>}<button className="btn btn--primary" disabled={busy || !groups.length}>Add bot</button></form></Modal>;
}
