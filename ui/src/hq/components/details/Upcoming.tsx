// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import type { TeamBot } from "../../types";
import { oldRequest, readPanelRoutines, type PanelRoutine } from "../../lib/api";
import { set } from "../../store";
import { fixtureMode, fixtureRoutines } from "../../dev/fixtures";

function manage() {
  set({ page: "settings", modal: null });
  const observer = new MutationObserver(() => {
    const section = document.querySelector<HTMLElement>('.team-settings [aria-label="Routines"]');
    if (!section) return;
    section.scrollIntoView({ block: "center" }); section.tabIndex = -1; section.focus({ preventScroll: true }); observer.disconnect(); clearTimeout(timer);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = setTimeout(() => observer.disconnect(), 10000);
}
function RoutineRow({ routine }: { routine: PanelRoutine }) {
  const [enabled, change] = useState(routine.enabled), [busy, wait] = useState(false), [error, say] = useState("");
  useEffect(() => change(routine.enabled), [routine.enabled]);
  const toggle = async () => {
    wait(true); say("");
    try {
      if (fixtureMode) { const r = fixtureRoutines.find(r => r.id === routine.id); if (r) r.status = enabled ? "paused" : "active"; }
      else await oldRequest(`/api/hq/routines/${encodeURIComponent(routine.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
      change(!enabled);
    } catch { say("Couldn't change this routine. Please try again."); } finally { wait(false); }
  };
  return <div><div className="panel-row panel-row--routine"><span className="panel-row__icon"><Clock size={16} strokeWidth={1.6} opacity={0.52} aria-hidden="true" /></span><span className="panel-row__text"><span className="panel-row__title">{routine.title}</span><span className="panel-row__sub">{enabled ? routine.when : `Paused · ${routine.when}`}</span></span>{routine.switchable && <button className={`toggle${enabled ? " is-on" : ""}`} role="switch" aria-label={routine.title} aria-checked={enabled} disabled={busy} onClick={() => void toggle()}><span className="toggle__knob" /></button>}</div>{error && <p className="engine__error" role="alert">{error}</p>}</div>;
}
export function Upcoming({ bot }: { bot: TeamBot }) {
  const [routines, keep] = useState<PanelRoutine[] | null>(null), [error, say] = useState("");
  useEffect(() => {
    let ended = false;
    const read = () => void readPanelRoutines(bot).then(rows => { if (!ended) { keep(rows); say(""); } }).catch(() => { if (!ended) say("Couldn't read scheduled things. Please try again."); });
    read(); const timer = setInterval(read, 30000);
    return () => { ended = true; clearInterval(timer); };
  }, [bot.id, bot.lead]);
  return <section aria-label="Upcoming"><div className="section-label section-label--row"><span>Upcoming</span><button className="link-btn link-btn--small" onClick={manage}>Manage</button></div><div className="panel-card">{error ? <p className="panel-empty" role="status">{error}</p> : routines === null ? <p className="panel-empty">Reading scheduled things…</p> : routines.length ? routines.map(r => <RoutineRow key={r.id} routine={r} />) : <p className="panel-empty">Nothing scheduled. Ask in chat, for example “send me a summary every weekday at 8”.</p>}</div></section>;
}
