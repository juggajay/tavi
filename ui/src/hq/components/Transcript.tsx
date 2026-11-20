// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Row, TeamBot, Live } from "../types";
import { useStore, set, openItem } from "../store";
import { Markdown } from "./Markdown";
import { ThinkingBlock, duration } from "./ActivityLine";
import { ApprovalCard } from "./cards/Cards";
import { Icon } from "./Icon";
import { BotAvatarFor } from "../avatar/BotAvatar";
type Message = Extract<Row["body"], { kind: "message" }>;
function isWorkEndingNotice(body: Row["body"]) {
  return body.kind === "notice" && !body.action && /: (?:I stopped at this job's|Stopped)/.test(body.text);
}
export function isConversationNotice(row: Row) {
  const body = row.body;
  return body.kind === "notice" && !isWorkEndingNotice(body) && (body.action === "sign_in" || /(?:usage limit|(?:Claude|OpenAI|subscription|\bplan\b).*(?:limit|sign[ -]?in|signed in))/i.test(body.text));
}
export function ConversationNotices({ rows }: { rows: Row[] }) {
  const connected = useStore(s => s.connected);
  const notices = rows.filter(isConversationNotice);
  if (connected && !notices.length) return null;
  return <div className="conversation-notices" aria-label="Conversation notices">
    {!connected && <p className="notice is-warn">The connection is down. Waiting to reconnect.</p>}
    {notices.map(row => row.body.kind === "notice" && <div key={row.seq} className={`notice is-${row.body.tone === "stop" ? "error" : row.body.tone}`}>{row.body.text}{row.body.action === "sign_in" && <button className="link-btn" onClick={() => set({ page: "subscriptions", viewer: null })}>Open Subscriptions</button>}</div>)}
  </div>;
}
function TeamLine({ body }: { body: Message }) {
  const [open, show] = useState(false);
  const first = body.text.trim().split(/(?<=[.!?])\s|\n/)[0];
  return <div className="team-line"><button className="team-line__toggle" aria-expanded={open} onClick={() => show(!open)}><span>{body.who || "System"}</span><span className="team-line__summary">{first}</span><Icon name="chev_right" size={12} /></button>{open && <div className="team-line__text"><Markdown text={body.text} /></div>}</div>;
}
type Group = { kind: "steps"; rows: Row[] } | { kind: "row"; row: Row };
export function buildItems(rows: Row[]): Group[] {
  const items: Group[] = [];
  const jobs = new Map<string, Extract<Group, { kind: "steps" }>>();
  for (const row of rows) {
    const last = items.at(-1);
    if (row.body.kind === "step" && row.body.job) {
      let group = jobs.get(row.body.job);
      if (!group) { group = { kind: "steps", rows: [] }; jobs.set(row.body.job, group); items.push(group); }
      group.rows.push(row);
    }
    else if (row.kind === "step") { if (last?.kind === "steps" && last.rows[0].body.kind === "step" && !last.rows[0].body.job) last.rows.push(row); else items.push({ kind: "steps", rows: [row] }); }
    else items.push({ kind: "row", row });
  }
  return items;
}
export function Steps({ rows, live }: { rows: Row[]; live?: Live }) {
  const [open, show] = useState(false);
  const calls = rows.flatMap(r => r.body.kind === "step" ? [r.body] : []);
  const running = calls.find(c => c.state === "running");
  // The time from the first step starting to the last one ending: the tools themselves take milliseconds, the thinking
  // between them takes the minutes ("Worked for 1s · 72 steps" was shown for nearly four minutes of work).
  const tools = calls.reduce((total, c) => total + (c.ms ?? 0), 0);
  const wall = rows.length ? Date.parse(rows[rows.length - 1].ts) + (calls[calls.length - 1]?.ms ?? 0) - Date.parse(rows[0].ts) : 0;
  const ms = Math.max(tools, Number.isFinite(wall) ? wall : 0);
  const job = calls[0]?.job;
  const ended = calls.find(c => c.jobEndedAt)?.jobEndedAt;
  const active = job && live?.work?.some(work => work.id === job);
  const elapsed = ended && calls[0]?.jobSince ? Date.parse(ended) - Date.parse(calls[0].jobSince) : ms;
  const title = job ? `${calls[0].jobTitle || "Finished work"}${!active && !running && elapsed >= 1000 ? ` · ${duration(elapsed)}` : ""}` : running?.label || (ms >= 1000 ? `Worked for ${duration(ms)}` : "");
  return <div className={`steps${open ? " is-open" : ""}`} data-job={job}><button className="steps__toggle" aria-expanded={open} onClick={() => show(!open)}>{(active || running) && <span className="step__dot is-running" />}{title && <><span className="steps__title">{title}</span><span className="steps__sep">·</span></>}<span className="steps__count">{calls.length} {calls.length === 1 ? "step" : "steps"}</span><Icon name="chev_right" size={10} className="steps__chev" /></button>{open && <ul className="steps__list" tabIndex={0} aria-label={job ? `Steps for ${calls[0].jobTitle || "this work"}` : "Steps in this answer"}>{calls.map(c => <li className={`step is-${c.state === "ok" ? "done" : c.state === "failed" ? "error" : "running"}`} key={c.id}><div className="step__row"><span className="step__dot" /><span className="step__label">{c.label}</span>{c.state === "failed" && <span className="error">Didn't finish</span>}</div></li>)}</ul>}</div>;
}
export function Transcript({ bot, rows, live }: { bot: TeamBot; rows: Row[]; live?: Live }) {
  const scroll = useRef<HTMLDivElement>(null), stick = useRef(true);
  const movedByOwner = useRef(0);
  const [jump, showJump] = useState(false);
  const bots = useStore(s => s.bots);
  useEffect(() => {
    const el = scroll.current!;
    const resize = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    resize.observe(el); if (el.firstElementChild) resize.observe(el.firstElementChild);
    return () => resize.disconnect();
  }, []);
  useLayoutEffect(() => { if (stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [rows, live]);
  return <div className="transcript-wrap"><div ref={scroll} className="transcript" role="log" aria-label={`Conversation with ${bot.name}`} onWheel={() => { movedByOwner.current = performance.now() + 1500; }} onPointerDown={() => { movedByOwner.current = performance.now() + 1500; }} onKeyDown={() => { movedByOwner.current = performance.now() + 1500; }} onScroll={() => { const el = scroll.current!; if (performance.now() < movedByOwner.current) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; showJump(el.scrollHeight - el.scrollTop - el.clientHeight >= 70); }}><div className="transcript__inner">
    {!rows.length && <div className="empty-chat"><h2>{bot.name}</h2><p>{bot.role}. Tell {bot.name} what needs doing.</p></div>}
    {buildItems(rows.filter(row => !isConversationNotice(row))).map(group => {
      if (group.kind === "steps") return <Steps key={`steps-${group.rows[0].seq}`} rows={group.rows} live={live} />;
      const row = group.row, body = row.body;
      if (body.kind === "message" && (body.from === "system" || body.from === "other-bot" && /^(team|system)$/i.test(body.who ?? ""))) return <TeamLine key={row.seq} body={body} />;
      const sender = body.kind === "message" && body.from === "other-bot" ? bots.find(other => other.id === body.who || other.name === body.who) : undefined;
      if (body.kind === "message") return <div className={`bubble-wrap is-${body.from === "owner" ? "right" : "left"}`} key={row.seq}>{body.from === "other-bot" && <span className="sender-label">{sender && <BotAvatarFor bot={sender} size={24} />}{body.who ?? "Another bot"}</span>}<div className={`bubble is-${body.from === "owner" ? "user" : "agent"}${body.streaming ? " is-streaming" : ""}`}>{body.from === "owner" ? <div className="bubble__plain">{body.text}</div> : <Markdown text={body.text} />}</div><span className="bubble__time">{new Date(row.ts).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}</span></div>;
      if (body.kind === "card") return body.card === "approval" ? <ApprovalCard key={row.seq} card={body} /> : <button className="item-card" key={row.seq} onClick={() => void openItem(body.ref)}><Icon name="file" size={22} /><span><b>{body.title}</b><small>Open beside the conversation</small></span><Icon name="chev_right" /></button>;
      if (body.kind === "notice") {
        const workEnding = isWorkEndingNotice(body);
        const split = workEnding ? body.text.search(/(?<=[.!?])\s/) : -1;
        return <div key={row.seq} className={`notice-group${workEnding ? " is-work-ending" : ""}`} title={workEnding ? body.text : undefined}><div className={`notice is-${workEnding ? "info" : body.tone === "stop" ? "error" : body.tone}`}>{split >= 0 ? body.text.slice(0, split) : body.text}{body.action && <button className="link-btn" onClick={() => body.action === "sign_in" ? set({ page: "subscriptions", viewer: null }) : document.querySelector<HTMLButtonElement>(".safety-button")?.click()}>{body.action === "sign_in" ? "Open Subscriptions" : "Open safety switch"}</button>}</div>{split >= 0 && <div className="bubble is-agent"><Markdown text={body.text.slice(split).trim()} /></div>}</div>;
      }
      return null;
    })}
    {live && <ThinkingBlock bot={bot} live={live} rows={rows} />}
  </div></div>{jump && <button className="jump-btn" aria-label="Scroll to bottom" onClick={() => { stick.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }}><Icon name="arrow_down" /></button>}</div>;
}
