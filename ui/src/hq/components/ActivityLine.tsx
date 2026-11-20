// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useRef, useState } from "react";
import type { Live, TeamBot, Row } from "../types";
import { usePresence } from "../lib/phrases";
import { BotAvatarFor } from "../avatar/BotAvatar";
import { WorkActions } from "./WorkActions";
import { Icon } from "./Icon";
export function duration(ms: number) { const secs = Math.max(0, Math.floor(ms / 1000)); return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`; }
function Caption({ text }: { text: string }) {
  const last = useRef(text);
  const [leaving, setLeaving] = useState<string | null>(null);
  useEffect(() => {
    const old = last.current; last.current = text;
    if (old === text) return;
    setLeaving(old);
    const timer = setTimeout(() => setLeaving(null), 320);
    return () => clearTimeout(timer);
  }, [text]);
  return <span className="thinking__caption"><span key={text} className="thinking__caption-line is-in">{text}</span>{leaving !== null && leaving !== text && <span key={`out:${leaving}`} className="thinking__caption-line is-out" aria-hidden>{leaving}</span>}</span>;
}
export function ThinkingBlock({ bot, live, rows = [] }: { bot: TeamBot; live: Live; rows?: Row[] }) {
  const current = usePresence(live, rows);
  if (!current.busy) return null;
  const job = live.work?.find(job => job.id === current.job);
  const timer = current.since ? `${current.waiting ? "Waiting" : current.state === "queued" ? "Queued" : "Working"} for ${duration(current.now - Date.parse(current.since))}` : "";
  return <div className={`thinking${current.waiting ? " is-waiting" : ""}`}><div className="thinking__badge"><span className="thinking__mascot"><BotAvatarFor bot={bot} size={36} /></span>{current.waiting ? <span className="thinking__alert" aria-hidden /> : <span className="thinking__idea"><Icon name="idea" size={16} /></span>}<div className="thinking__pill" role="status" aria-live="polite"><span className="thinking__name">{bot.name}</span><span className="thinking__status" key={current.status}>{current.status}</span></div></div><div className="thinking__side"><Caption text={current.caption} /><div className="thinking__footer">{(timer || current.steps > 0) && <span className="thinking__meta">{timer}{timer && current.steps > 0 ? " · " : ""}{current.steps > 0 ? `${current.steps} ${current.steps === 1 ? "step" : "steps"}` : ""}</span>}{job && <WorkActions bot={bot} job={job} />}</div></div></div>;
}
