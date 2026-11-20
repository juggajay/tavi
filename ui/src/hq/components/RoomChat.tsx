// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useState } from "react";
import { request } from "../lib/api";
import { useStore, reportError } from "../store";
import { Markdown } from "./Markdown";
import { BotAvatarFor } from "../avatar/BotAvatar";
export function RoomChat() {
  const { room, bots, transcripts, safety } = useStore();
  const [text, edit] = useState(""), [busy, setBusy] = useState(false), [sent, setSent] = useState<string[]>([]);
  if (!room) return null;
  const members = bots.filter(b => room.bots.includes(b.id));
  return <main className="room-chat"><header><h1>{room.name}</h1><p>{members.map(b => b.name).join(" and ")}</p></header><div className="room-messages" role="log" aria-label="Room conversation">{sent.map((message, i) => <div className="bubble is-user" key={i}>{message}</div>)}{members.map(bot => <section key={bot.id}><h2><BotAvatarFor bot={bot} size={28} />{bot.name}</h2>{!(transcripts[bot.id]?.rows ?? []).some(r => r.body.kind === "message" && r.body.from !== "owner") && <p className="quiet">Ready when you are. Send a message below to bring {bot.name} into the conversation.</p>}{(transcripts[bot.id]?.rows ?? []).filter(r => r.body.kind === "message" && r.body.from !== "owner").map(row => <Markdown key={row.seq} text={row.body.kind === "message" ? row.body.text : ""} />)}</section>)}</div><form className="room-composer" onSubmit={async e => { e.preventDefault(); if (!text.trim()) return; setBusy(true); try { await request("/rooms/ask", "POST", { bots: room.bots, text: text.trim() }); setSent([...sent, text.trim()]); edit(""); } catch (error) { reportError(error); } finally { setBusy(false); } }}><label>Message the room<textarea value={text} onChange={e => edit(e.target.value)} required /></label><button className="btn btn--primary" disabled={busy || safety.level === "paused" || safety.level === "killed"}>Ask the room</button></form></main>;
}
