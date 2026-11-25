// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TeamBot } from "../types";
import { request } from "../lib/api";
import { useStore, set, socketId, reportError } from "../store";
import { fixtureMode } from "../dev/fixtures";
import { createVoice, type Voice } from "../lib/voice";
import { Icon } from "./Icon";
import { presence } from "../lib/presence";
const drafts = new Map<string, string>();
export function Composer({ bot, running }: { bot: TeamBot; running: boolean }) {
  const [text, edit] = useState(drafts.get(bot.id) ?? ""), [sending, busy] = useState(false);
  const draft = useStore(s => s.composeDraft);
  useEffect(() => { if (draft?.bot === bot.id) { edit(draft.text); set({ composeDraft: null }); input.current?.focus(); } }, [draft, bot.id]);
  const input = useRef<HTMLTextAreaElement>(null), voice = useRef<Voice | null>(null);
  const safety = useStore(s => s.safety.level), call = useStore(s => s.call);
  const chatBusy = useStore(s => presence(s.live[bot.id] ? { ...s.live[bot.id], work: [] } : undefined).busy);
  useEffect(() => () => { voice.current?.destroy(); set({ call: null }); }, [bot.id]);
  useEffect(() => { if (safety !== "open") { voice.current?.end(); set({ call: null }); } }, [safety]);
  useEffect(() => { if (!chatBusy) voice.current?.brainDone(); }, [chatBusy]);
  useEffect(() => { drafts.set(bot.id, text); }, [bot.id, text]);
  useLayoutEffect(() => { if (input.current) { input.current.style.height = "0px"; input.current.style.height = `${Math.min(200, input.current.scrollHeight)}px`; } }, [text]);
  const send = async () => {
    if (!text.trim() || sending) return;
    busy(true);
    try { await request(`/bots/${encodeURIComponent(bot.id)}/messages`, "POST", { text: text.trim(), client_id: socketId() }); edit(""); drafts.delete(bot.id); set({ setupBot: null }); }
    catch (error) { reportError(error); }
    finally { busy(false); input.current?.focus(); }
  };
  const startCall = () => {
    if (fixtureMode) { set({ call: { bot: bot.id, state: "Listening" } }); return; }
    if (!voice.current) voice.current = createVoice(socketId(), { onState: state => set({ call: state === "off" ? null : { bot: bot.id, state } }), onHeard: () => {}, onSaid: () => {}, onEnded: message => { set({ call: null }); if (message) reportError(new Error(message)); } }, bot.id);
    void voice.current.start();
  };
  return <>{call && <div className="voice-call-bar" role="status"><Icon name="mic" />On a call with {bot.name}<span className="quiet">{call.state}</span><button className="btn btn--secondary btn--sm" onClick={() => { voice.current?.end(); set({ call: null }); }}><Icon name="hangup" />Hang up</button></div>}<div className="composer-area"><div className={`composer${text.includes("\n") ? " is-multiline" : ""}`}><div className="composer__left"><button className="composer__btn" aria-label="New conversation" onClick={() => void request(`/bots/${encodeURIComponent(bot.id)}/fresh`, "POST").catch(reportError)}><Icon name="fresh" /></button><textarea ref={input} className="composer__input" rows={1} value={text} onChange={e => edit(e.target.value)} placeholder={`Message ${bot.name}`} aria-label={`Message ${bot.name}`} disabled={safety === "paused" || safety === "killed"} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /></div><div className="composer__right"><button className="composer__btn" aria-label={`Call ${bot.name}`} disabled={safety !== "open" || !!call} onClick={startCall}><Icon name="mic" /></button>{running && !text.trim() ? <button className="composer__cta" aria-label="Stop work" onClick={() => void request(`/bots/${encodeURIComponent(bot.id)}/stop`, "POST").catch(reportError)}><Icon name="stop" /></button> : <button className="composer__cta" aria-label="Send message" disabled={sending || !text.trim() || safety === "paused" || safety === "killed"} onClick={() => void send()}><Icon name="arrow_up" /></button>}</div></div></div></>;
}

