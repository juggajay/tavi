import { useEffect, useState } from "react";
import { request, RequestError } from "../lib/api";
import { useStore, set } from "../store";
import type { Safety, SafetyLevel } from "../types";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
const levels = { open: "Open", paused: "Paused", walled: "Walled off", killed: "Killed" };
const explanation = { open: "Everything is on", paused: "Everything stopped where it was", walled: "Bots cut off from this PC; chat only", killed: "Everything off; sign-ins withdrawn" };
export function SafetyBanner() {
  const safety = useStore(s => s.safety), guard = useStore(s => s.guard);
  const since = safety.since ?? safety.changedAt;
  if (safety.level === "open" && guard === "up") return null;
  return <div className={`safety-band is-${guard === "down" ? "killed" : safety.level}`} role="status"><Icon name="shield" /><span>{guard === "down" ? <>The safety guard isn't answering. The bots' computers may still be running. Stop them by hand: <code>npm run guard -- kill</code></> : <>{explanation[safety.level]}{since ? ` · since ${new Date(since).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}` : " · start time unavailable"}{safety.until ? ` · until ${new Date(safety.until).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}` : ""}</>}</span></div>;
}
export function SafetySwitch() {
  const safety = useStore(s => s.safety), guard = useStore(s => s.guard);
  const [open, show] = useState(false), [pinOpen, showPin] = useState(false), [pin, setPin] = useState(""), [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [position, place] = useState({ left: 12, top: 58 });
  useEffect(() => {
    if (!open || pinOpen) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); show(false); document.querySelector<HTMLElement>(".safety-button")?.focus(); } };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [open, pinOpen]);
  const digits = (value: string) => value.length >= 4 && value.length <= 12 && [...value].every(c => c >= "0" && c <= "9");
  // Saving a first PIN is only possible on this PC; the switch itself checks that.
  const choose = async () => {
    setBusy(true); setError(null);
    try { await request("/safety/pin", "POST", { pin }); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't save the PIN. Try again."); setBusy(false); return; }
    await change("open", undefined, pin); setAgain("");
  };
  const change = async (level: SafetyLevel, minutes?: number, code?: string) => {
    setBusy(true); setError(null);
    try {
      const result = await request<{ ok?: boolean; guard?: "up" | "down"; safety?: Safety } & Partial<Safety>>("/safety", "POST", { level, ...(minutes ? { minutes } : {}), ...(code ? { pin: code } : {}) });
      if (result.guard === "down" || result.ok === false) { set({ guard: "down" }); setError("Stopped everything on this side. The bots' computers may still be running."); return; }
      const next = result.safety ?? (result.level ? result as Safety : await request<Safety>("/safety"));
      set({ safety: next, guard: "up" }); showPin(false); setPin("");
      if (level === "open" || level === "killed") show(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the switch. Try again.");
      if (level !== "open" && !(err instanceof RequestError && [401, 403].includes(err.status))) set({ guard: "down" });
    } finally { setBusy(false); }
  };
  return <>
    <div className="safety-anchor"><button className="btn btn--secondary safety-button" aria-label={`Safety switch: ${levels[safety.level]}`} aria-expanded={open} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); place({ left: Math.min(Math.max(12, box.left), Math.max(12, innerWidth - 372)), top: Math.min(box.bottom + 8, innerHeight - 100) }); show(!open); }}><Icon name="shield" />{levels[safety.level]}</button>
      {open && <section className="safety-popover" style={{ ...position, maxHeight: `calc(100dvh - ${position.top + 16}px)` }} aria-label="Safety choices"><div className="section-label">Safety switch</div>
        {([ ["paused", "Pause", "Everything stops where it is", "pause"], ["walled", "Wall off", "Bots cut off from this PC; chat only", "wall"], ["killed", "Kill", "Everything off, sign-ins withdrawn", "kill"] ] as const).map(([level, title, text, icon]) => <button className={`safety-choice is-${level}`} key={level} disabled={busy} onClick={() => void change(level)}><Icon name={icon} size={23} /><span><b>{title}</b><small>{text}</small></span></button>)}
        {(["paused", "walled"] as string[]).includes(safety.level) && <div className="safety-time"><span>Keep it this way</span><div>{[[30, "30 min"], [120, "2 h"], [0, "Until I say"]].map(([minutes, label]) => <button className="btn btn--secondary btn--sm" disabled={busy} key={label} onClick={() => void change(safety.level, Number(minutes))}>{label}</button>)}</div></div>}
        {safety.level !== "open" && <button className="btn btn--primary" disabled={busy || guard === "down"} onClick={() => { setError(null); showPin(true); }}>Switch back on</button>}
        {error && <p role="alert" className="error">{error}</p>}
        <button className="link-btn" onClick={() => show(false)}>Close switch</button>
      </section>}
    </div>
    {pinOpen && <Modal label="Switch back on" onClose={() => { showPin(false); setPin(""); setAgain(""); }}>{safety.pinSet
      ? <form onSubmit={e => { e.preventDefault(); void change("open", undefined, pin); }}><p>Enter your PIN to let the team work again.</p><label>PIN<input className="text-input" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={e => setPin(e.target.value)} /></label>{error && <p className="error" role="alert">{error}</p>}<button className="btn btn--primary" disabled={busy || !pin}>Switch on</button></form>
      // No PIN has ever been chosen: there is nothing to ask for, and the switch itself refuses to be switched back on
      // from the app without one. So the first time, he chooses it here (saved on this PC only) and it switches on.
      : <form onSubmit={e => { e.preventDefault(); void choose(); }}><p>You haven't chosen a PIN yet, and the team can only be switched back on with one. Choose it now: four to twelve digits. You'll be asked for it each time.</p><label>New PIN<input className="text-input" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={e => setPin(e.target.value)} /></label><label>The same PIN again<input className="text-input" type="password" inputMode="numeric" autoComplete="off" value={again} onChange={e => setAgain(e.target.value)} /></label>{error && <p className="error" role="alert">{error}</p>}<button className="btn btn--primary" disabled={busy || !digits(pin) || pin !== again}>Save PIN and switch on</button></form>}</Modal>}
  </>;
}
