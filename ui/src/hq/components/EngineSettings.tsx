// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useState } from "react";
import type { TeamBot, EngineChoice, EngineInfo, Provider, Effort } from "../types";
import { request } from "../lib/api";
import { providerName } from "./Subscriptions";
import { useStore, set } from "../store";

import { Icon } from "./Icon";
export function Choice({ value, change, label }: { value: EngineChoice; change: (choice: EngineChoice) => void; label: string }) {
  const subscriptions = useStore(s => s.subscriptions);
  const engines = useStore(s => s.engines);
  const models = subscriptions.find(s => s.provider === value.provider)?.models ?? Object.values(engines).find(e => e.models?.[value.provider])?.models?.[value.provider] ?? [];
  const [other, setOther] = useState(false);
  const known = models.some(m => m.id === value.model);
  const signedIn = subscriptions.find(s => s.provider === value.provider)?.signedIn;
  return <fieldset className="choice-fields" aria-label={label}><legend>{label}</legend><label>Company<select aria-label={label + ' company'} value={value.provider} onChange={e => {
    const provider = e.target.value as Provider, offered = subscriptions.find(s => s.provider === provider)?.models ?? Object.values(engines).find(i => i.models?.[provider])?.models?.[provider] ?? [];
    setOther(false); change({ ...value, provider, model: offered[0]?.id ?? '' });
  }}>{(['anthropic', 'openai-codex'] as const).map(p => <option key={p} value={p}>{subscriptions.find(s => s.provider === p)?.signedIn ? '●' : '○'} {providerName(p)}</option>)}{!['anthropic', 'openai-codex'].includes(value.provider) && <option value={value.provider}>{providerName(value.provider)}</option>}</select></label><span className="choice-signin"><span className={'subscription-dot' + (signedIn ? ' is-signed-in' : '')} />{signedIn === undefined ? 'Checking sign-in' : signedIn ? 'Signed in' : 'Not signed in'}</span><label>Model<select required aria-label={label + ' model'} value={other || !known ? '__other' : value.model} onChange={e => { setOther(e.target.value === '__other'); if (e.target.value !== '__other') change({ ...value, model: e.target.value }); }}>{models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}<option value="__other">Other…</option></select></label>{(other || !known) && <label>Other model<input className="text-input" required aria-label={label + ' other model'} value={value.model} onChange={e => change({ ...value, model: e.target.value })} placeholder="Enter a model name" /></label>}<label>Effort<select aria-label={label + ' effort'} value={value.effort ?? ''} onChange={e => change({ ...value, effort: (e.target.value || undefined) as Effort | undefined })}><option value="">Default</option>{(['minimal', 'low', 'medium', 'high', 'xhigh'] as const).map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label></fieldset>;
}
export function EngineSettings({ bot }: { bot: TeamBot }) {
  const [primary, edit] = useState(bot.primary), [fallbacks, editFallbacks] = useState(bot.fallbacks);
  const signedIn = useStore(s => s.subscriptions.find(subscription => subscription.provider === primary.provider)?.signedIn);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const load = async () => { try { const engine = await request<EngineInfo>(`/bots/${encodeURIComponent(bot.id)}/engine`); if (!cancelled) { set(s => ({ engines: { ...s.engines, [bot.id]: engine } })); edit(engine.primary); editFallbacks(engine.fallbacks); } } catch { if (!cancelled) setError("Couldn't read the engine. Try again."); } finally { if (!cancelled) setLoading(false); } };
    void load(); return () => { cancelled = true; };
  }, [bot.id]);
  const move = (from: number, to: number) => editFallbacks(current => { const next = [...current]; next.splice(to, 0, next.splice(from, 1)[0]); return next; });
  return <div className="panel-card engine-settings"><form onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError(null); setSaved(false);
    try { await request(`/bots/${encodeURIComponent(bot.id)}/engine`, "PATCH", { primary, fallbacks });
      set(state => ({ bots: state.bots.map(before => before.id === bot.id ? { ...before, primary, fallbacks } : before), engines: { ...state.engines, [bot.id]: { ...(state.engines[bot.id] ?? { status: 'ready' as const }), primary, fallbacks } } })); setSaved(true); }
    catch { setError("Couldn't save the engine. Your previous choices are still in use."); }
    finally { setBusy(false); }
  }}><fieldset className="engine-form-fields" disabled={loading || busy}><Choice value={primary} change={choice => { edit(choice); setSaved(false); }} label="First choice" /><div className="section-label">If unavailable</div><ol className="fallbacks">{fallbacks.map((choice, index) => <li key={index} draggable onDragStart={() => setDrag(index)} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (drag !== null) move(drag, index); setDrag(null); }}><div className="fallback-head"><Icon name="grip" /><span>{index + 1}. {providerName(choice.provider)}</span><button type="button" className="link-btn" disabled={index === 0} onClick={() => move(index, index - 1)} aria-label={`Move fallback ${index + 1} up`}><Icon name="arrow_up" size={13} /></button><button type="button" className="link-btn" disabled={index === fallbacks.length - 1} onClick={() => move(index, index + 1)} aria-label={`Move fallback ${index + 1} down`}><Icon name="arrow_down" size={13} /></button><button type="button" className="link-btn" onClick={() => editFallbacks(fallbacks.filter((_, i) => i !== index))} aria-label={`Remove fallback ${index + 1}`}><Icon name="close" size={13} /></button></div><Choice value={choice} change={next => editFallbacks(fallbacks.map((old, i) => i === index ? next : old))} label={`Fallback ${index + 1}`} /></li>)}</ol><div className="button-row"><button type="button" className="link-btn" onClick={() => editFallbacks([...fallbacks, { provider: "openai-codex", model: useStore.getState().subscriptions.find(s => s.provider === "openai-codex")?.models?.[0]?.id ?? "", effort: "medium" }])}>Add fallback</button><button className="btn btn--bot" disabled={busy}>Save</button><small className="quiet">Applies from the bot's next message.</small></div></fieldset>{saved && <p role="status">Engine saved.</p>}</form>
    {error && <p role="alert" className="error">{error}</p>}
    {(signedIn === false) && <p className="quiet">{providerName(primary.provider)} is not signed in. <button className="link-btn" onClick={() => set({ page: "subscriptions", modal: null, viewer: null })}>Open Subscriptions</button></p>}
  </div>;
}

/** Closed by default. A bot's set-up (its engine, and whether it has a computer) lives in here, out of the way. */
export function EngineMenu({ bot, children }: { bot: TeamBot; children?: import("react").ReactNode }) {
  const choice = useStore(s => s.engines[bot.id]?.primary) ?? bot.primary;
  const engine = useStore(s => s.engines[bot.id]);
  const signedIn = useStore(s => s.subscriptions.find(subscription => subscription.provider === choice.provider)?.signedIn) ?? engine?.signedIn?.[choice.provider];
  const [open, show] = useState(false);
  const status = <div className={`engine__conn${signedIn ? " is-on" : ""}`}><i />{signedIn ? "Connected · Subscription" : signedIn === false || engine?.status === "not_signed_in" ? <><span>Not signed in</span><button className="link-btn" onClick={() => set({ page: "subscriptions", modal: null, viewer: null })}>Subscriptions</button></> : "Checking sign-in…"}</div>;
  return <div className="panel-card details-engine"><details className="engine-menu" onToggle={e => show(e.currentTarget.open)}><summary role="button" aria-label={`Engine: ${providerName(choice.provider)}, ${choice.model}, ${choice.effort ?? 'default'}`}><small title={`${providerName(choice.provider)} · ${choice.model} · ${choice.effort ?? 'default'}`}>{providerName(choice.provider)} &middot; {choice.model} &middot; {choice.effort ?? 'default'}</small><Icon name="chev_down" /></summary>{open && <>{status}<EngineSettings bot={bot} />{children}</>}</details>{!open && status}</div>;
}
