import { useEffect, useState } from "react";
import type { Provider, Usage } from "../types";
import { request } from "../lib/api";
import { fixtureMode } from "../dev/fixtures";
import { useStore, refreshSubscriptions } from "../store";
import { Modal } from "./Modal";

export const providerName = (provider: Provider) => ({ anthropic: "Claude", "openai-codex": "OpenAI", "openai-api": "OpenAI · pay as you go", openrouter: "Other models" })[provider];
export function usageText(value: Usage["today"]) {
  if (value === undefined) return null;
  const amount = typeof value === "number" ? value : value.input + value.output;
  return Number.isFinite(amount) ? `${amount.toLocaleString("en-AU")} tokens` : null;
}
export function Subscriptions() {
  const { subscriptions, bots } = useStore();
  const [signin, showSignin] = useState<Provider | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { void refreshSubscriptions().catch(() => setError("Couldn't read your subscriptions. Please try again.")); }, []);
  return <main className="subscriptions-page"><header><h1>Subscriptions</h1><p>Sign in once. Choose which subscription each bot thinks on.</p></header>{error && <p role="alert" className="error">{error}<button className="link-btn" onClick={() => void refreshSubscriptions().then(() => setError(null)).catch(() => {})}>Try again</button></p>}<div className="subscription-cards">{(["anthropic", "openai-codex"] as const).map(provider => {
    const info = subscriptions.find(s => s.provider === provider);
    return <section className="subscription-card" key={provider} aria-label={`${providerName(provider)} subscription`}><h2>{providerName(provider)}</h2><p><span className={`subscription-dot${info?.signedIn ? " is-signed-in" : ""}`} />{info ? info.signedIn ? "Signed in" : "Not signed in" : "Checking sign-in…"}</p><p className="quiet">Used by {info ? info.usedBy.map(id => bots.find(b => b.id === id)?.name ?? "Another bot").join(", ") || "no bots yet" : "…"}</p><details className="subscription-models"><summary>Models</summary>{info?.models?.length ? <ul>{info.models.map(model => <li key={model.id}>{model.id}</li>)}</ul> : <p className="quiet">The model list is not available yet.</p>}</details><dl>{([["Today", info?.usage?.today], ["This week", info?.usage?.week]] as const).map(([label, value]) => usageText(value) !== null && <div key={label}><dt>{label}</dt><dd>{usageText(value)}</dd></div>)}</dl>{info?.limitedUntil && <p className="notice is-warn">Limit reached · available again {new Date(info.limitedUntil).toLocaleString("en-AU")}</p>}<div className="button-row"><button className="btn btn--primary" disabled={busy} onClick={() => showSignin(provider)}>{info?.signedIn ? "Sign in again" : "Sign in"}</button><button className="btn btn--secondary" disabled={!info?.signedIn || busy} onClick={async () => {
      setBusy(true); setError(null);
      try { await request(`/subscriptions/${provider}`, "DELETE"); await refreshSubscriptions(); }
      catch { setError("Couldn't sign out. Please try again."); } finally { setBusy(false); }
    }}>Sign out</button></div><small>Signing out ends access for every bot using this subscription.</small></section>;
  })}</div>{signin && <SignInPane provider={signin} onClose={() => { showSignin(null); void refreshSubscriptions().catch(() => {}); }} />}</main>;
}
export function SignInPane({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const [session, setSession] = useState<string | null>(null), [output, setOutput] = useState("Starting sign-in…"), [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false, stream: EventSource | null = null, sessionId: string | null = null;
    void request<{ session: string }>(`/subscriptions/${encodeURIComponent(provider)}/sign-in`, "POST").then(result => {
      sessionId = result.session;
      if (stopped) { void request(`/sign-in/${encodeURIComponent(sessionId)}`, "DELETE").catch(() => {}); return; }
      setSession(sessionId);
      if (fixtureMode) { setOutput("Open the sign-in page for your account.\nEnter the code from that page below.\nThis is a preview; no account will be changed."); return; }
      stream = new EventSource(`/api/hq/sign-in/${encodeURIComponent(sessionId)}/events`);
      setOutput("");
      const append = (event: MessageEvent) => {
        try { const value = JSON.parse(event.data); const line = typeof value === "string" ? value : value.text ?? value.data ?? value.chunk ?? ""; if (typeof line === "string") setOutput(before => (before + line).slice(-24000)); } catch { setOutput(before => (before + event.data).slice(-24000)); }
      };
      stream.onmessage = append;
      stream.addEventListener("output", append as EventListener);
      // The guard sends each line of Hermes' own sign-in text as a "line" event, and "ended" when it is over (found on the real server: nothing showed).
      stream.addEventListener("line", ((event: MessageEvent) => { try { const value = JSON.parse(event.data); if (typeof value === "string") setOutput(before => (before + value + "\n").slice(-24000)); } catch { /* not a line of text */ } }) as EventListener);
      stream.addEventListener("ended", () => { stream?.close(); setOutput(before => before + "\nSign-in finished. You can close this window."); void refreshSubscriptions().catch(() => {}); });
      stream.addEventListener("done", () => { stream?.close(); setOutput(before => before + "\nSign-in finished. You can close this window."); void refreshSubscriptions().catch(() => {}); });
      stream.onerror = () => { stream?.close(); if (!stopped) setError("The sign-in connection ended. Close this window and try again if sign-in is unfinished."); };
    }).catch(() => { if (!stopped) setError("Couldn't start sign-in. Please try again."); });
    return () => { stopped = true; stream?.close(); if (sessionId) void request(`/sign-in/${encodeURIComponent(sessionId)}`, "DELETE").catch(() => {}); };
  }, [provider]);
  return <Modal label={`Sign in · ${providerName(provider)}`} onClose={onClose}><p>You are signing in to your own account; every bot you choose can use this subscription.</p><pre className="sign-in-output" role="log" aria-label="Sign-in instructions">{output}</pre><form onSubmit={async e => { e.preventDefault(); if (!session || !input.trim()) return; setBusy(true); try { await request(`/sign-in/${encodeURIComponent(session)}/input`, "POST", { text: input }); setInput(""); } catch { setError("Couldn't send the code. Please try again."); } finally { setBusy(false); } }}><label>Code from the sign-in page<input className="text-input" autoComplete="off" type="password" value={input} onChange={e => setInput(e.target.value)} /></label><button className="btn btn--primary" disabled={!session || busy || !input.trim()}>Send code</button>{error && <p role="alert" className="error">{error}</p>}</form></Modal>;
}
