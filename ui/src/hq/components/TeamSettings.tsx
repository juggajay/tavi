import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import { oldRequest } from "../lib/api";
import { useStore, set } from "../store";

type Settings = Record<string, string | number | boolean | null>;
type Profile = { soul: string; user: string; voiceCard: string; changes: { created_at?: string; at?: string; target: string; source: string }[] };
type Shortcut = { name: string; made_at: string; last_used: string | null };
const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-section" aria-label={title}><h2>{title}</h2><div className="settings-rows">{children}</div></section>;
}
function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <div className="settings-row"><div><b>{title}</b>{hint && <p>{hint}</p>}</div><div className="settings-value">{children}</div></div>;
}
export function TeamSettings() {
  const bots = useStore(s => s.bots);
  const [settings, update] = useState<Settings | null>(null), [profile, setProfile] = useState<Profile | null>(null);
  const [address, setAddress] = useState<string | null>(null), [keys, setKeys] = useState<Shortcut[]>([]);
  const [events, setEvents] = useState<{ ts: string; actor: string; event: string }[]>([]);
  const [error, setError] = useState(""), [notice, say] = useState(""), [busy, setBusy] = useState(false);
  const [phoneName, setPhoneName] = useState("iphone"), [madeKey, showKey] = useState<{ name: string; key: string } | null>(null), [remove, setRemove] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    void Promise.all([
      oldRequest<Settings>("/api/settings"), oldRequest<Profile>("/api/setup/profile"),
      oldRequest<{ phoneUrl?: string | null }>("/api/setup/status"),
      oldRequest<{ shortcuts: Shortcut[] }>("/api/v2/shortcuts"),
      oldRequest<{ events: typeof events }>("/api/setup/activity"),
    ]).then(([s, p, status, shortcuts, log]) => {
      if (stopped) return;
      update(s); setProfile(p); setAddress(status.phoneUrl ? status.phoneUrl.replace(/\/$/, "") + "/api/shortcut" : null); setKeys(shortcuts.shortcuts); setEvents(log.events);
    }).catch(() => { if (!stopped) setError("Couldn't read Settings. Close this page and try again."); });
    return () => { stopped = true; };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); say("");
    try { await action(); say("Saved."); } catch { setError("Couldn't save that. Please try again."); } finally { setBusy(false); }
  };
  const save = (patch: Settings) => run(async () => { await oldRequest("/api/settings", json(patch, "PUT")); update(s => ({ ...s, ...patch })); });
  const val = (key: string, fallback = "") => String(settings?.[key] ?? fallback);
  const field = (key: string, value: string) => update(s => ({ ...s, [key]: value }));
  const submit = (action: () => void) => (e: FormEvent) => { e.preventDefault(); action(); };
  const copy = async (value: string) => { setError(""); say(""); try { await navigator.clipboard.writeText(value); say("Copied."); } catch { setError("Couldn't copy that. Please try again."); } };
  return <div className="team-settings page-content"><header className="page-heading"><h1>Settings</h1><p>How Tavi looks, sounds and behaves.</p><button className="btn btn--secondary" onClick={() => set({ modal: "settings" })}>Appearance</button></header>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="settings-notice" role="status">{notice}</p>}
    {!settings || !profile ? !error && <p className="quiet">Reading your settings…</p> : <fieldset className="settings-body" disabled={busy}>
      <Section title="Work limits"><Row title="Time for one job" hint="At the limit, the bot stops and tells you what is finished and what is left."><form className="inline-form" onSubmit={submit(() => void save({ "work.max_minutes": Number(val("work.max_minutes", "30")) }))}><label>One job may take up to <input type="number" min="5" max="240" required aria-label="Minutes" value={val("work.max_minutes", "30")} onChange={e => field("work.max_minutes", e.target.value)} /> minutes.</label><button className="btn btn--secondary">Save</button></form></Row></Section>
      <Section title="Voice"><dl className="bot-voices">{bots.map(bot => <div key={bot.id}><dt>{bot.name}</dt><dd>{bot.voice || "Not available"}</dd></div>)}</dl><details className="settings-detail"><summary>What the voice is told</summary><pre>{profile.voiceCard}</pre></details></Section>
      <Section title="Alerts"><Row title="Quiet hours" hint="No alerts unless something is urgent. Leave both empty for none."><form className="inline-form" onSubmit={submit(() => {
        if (!!val("quiet_start") !== !!val("quiet_end")) { setError("Set both times, or leave both empty."); return; }
        void run(async () => { await oldRequest("/api/setup/rules", json({ quiet_start: val("quiet_start"), quiet_end: val("quiet_end"), max_interruptions: val("max_interruptions", "0") })); });
      })}><input type="time" aria-label="From" value={val("quiet_start")} onChange={e => field("quiet_start", e.target.value)} /><span>to</span><input type="time" aria-label="To" value={val("quiet_end")} onChange={e => field("quiet_end", e.target.value)} /><button className="btn btn--secondary">Save</button></form></Row>
        <Row title="Alerts a day" hint="0 means no limit. Urgent alerts always come through."><form className="inline-form" onSubmit={submit(() => void save({ max_interruptions: Number(val("max_interruptions", "0")) }))}><input type="number" min="0" max="100" required aria-label="Alerts a day" value={val("max_interruptions", "0")} onChange={e => field("max_interruptions", e.target.value)} /><button className="btn btn--secondary">Save</button></form></Row></Section>
      <Section title="Siri on your iPhone"><Row title="Address for the Shortcut" hint={address ?? "No phone address yet."}>{address && <button className="btn btn--secondary" onClick={() => copy(address)}>Copy address</button>}</Row>
        {keys.map(key => <div key={key.name}><Row title={key.name} hint={key.last_used ? `Last used ${new Date(key.last_used).toLocaleDateString("en-AU")}` : "Not used yet"}><button className="link-btn" onClick={() => setRemove(key.name)}>Take away</button></Row>{remove === key.name && <div className="settings-confirm"><p>Take this key away? That Shortcut stops working.</p><button className="btn btn--secondary error" onClick={() => void run(async () => { await oldRequest(`/api/v2/shortcuts/${encodeURIComponent(key.name)}`, { method: "DELETE" }); setKeys(keys.filter(k => k.name !== key.name)); setRemove(null); })}>Take away key</button><button className="link-btn" onClick={() => setRemove(null)}>Keep key</button></div>}</div>)}
        <Row title="Make a key" hint="One for each phone. It is shown once, so have the Shortcut open."><form className="inline-form" onSubmit={submit(() => void run(async () => { const key = await oldRequest<{ name: string; key: string }>("/api/v2/shortcuts", json({ name: phoneName.trim() || "iphone" })); showKey(key); setKeys(before => [...before.filter(k => k.name !== key.name), { name: key.name, made_at: new Date().toISOString(), last_used: null }]); }))}><input aria-label="Name for the phone" maxLength={60} value={phoneName} onChange={e => setPhoneName(e.target.value)} /><button className="btn btn--secondary">Make a key</button></form></Row>
        {madeKey && <div className="settings-key"><b>Key for {madeKey.name}</b><code>{madeKey.key}</code><p>Shown once. Put it in the Shortcut’s Key box now.</p><button className="btn btn--secondary" onClick={() => copy(madeKey.key)}>Copy key</button></div>}</Section>
      <Section title="Routines">{([["brief_time", "Morning brief"], ["lunch_time", "Midday check"], ["wrap_time", "Wrap-up"]] as const).map(([key, title]) => <Row key={key} title={title}><form className="inline-form" onSubmit={submit(() => void save({ [key]: val(key) }))}><input type="time" required aria-label={title} value={val(key)} onChange={e => field(key, e.target.value)} /><button className="btn btn--secondary">Save</button></form></Row>)}</Section>
      <Section title="Sound"><Row title="Sound on the phone" hint="Read typed replies aloud when there is no call."><button className="settings-switch" role="switch" aria-label="Sound on the phone" aria-checked={settings["ui.sound"] !== false} onClick={() => void save({ "ui.sound": settings["ui.sound"] === false })}><span /></button></Row></Section>
      <Section title="More settings"><details className="settings-detail"><summary>The main bot’s standing instructions</summary><form onSubmit={submit(() => void run(async () => { await oldRequest("/api/setup/profile/soul", json({ text: profile.soul })); }))}><label>Standing instructions<textarea aria-label="Standing instructions" value={profile.soul} onChange={e => setProfile({ ...profile, soul: e.target.value })} /></label><button className="btn btn--secondary">Save instructions</button></form></details>
        <details className="settings-detail"><summary>About you</summary><form onSubmit={submit(() => void run(async () => { await oldRequest("/api/setup/profile/user", json({ text: profile.user })); }))}><label>What the main bot knows about you<textarea aria-label="What the main bot knows about you" value={profile.user} onChange={e => setProfile({ ...profile, user: e.target.value })} /></label><button className="btn btn--secondary">Save about you</button></form></details>
        <details className="settings-detail"><summary>Activity log</summary><pre>{events.map(e => `${new Date(e.ts).toLocaleString("en-AU")} · ${e.actor} · ${e.event}`).join("\n") || "Nothing yet."}</pre></details>
        <details className="settings-detail"><summary>Recent changes</summary><pre>{profile.changes.map(c => `${c.target} · ${c.source}`).join("\n") || "None yet."}</pre></details></Section>
    </fieldset>}
  </div>;
}
