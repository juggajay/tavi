// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BotAvatarFor } from "../avatar/BotAvatar";
import { useStore, set, selectBot, startBotSetup } from "../store";
import { fixtureMode, fixtureItems } from "../dev/fixtures";
import { Icon } from "./Icon";
import { SafetySwitch } from "./SafetySwitch";
import { usePresence } from "../lib/phrases";
import type { Live, Row, TeamBot } from "../types";

function BotTile({ bot, live, rows, unread, selected, collapsed, pinned, choose }: { bot: TeamBot; live?: Live; rows: Row[]; unread: boolean; selected: boolean; collapsed: boolean; pinned?: boolean; choose: () => void }) {
  const current = usePresence(live, rows);
  const message = [...rows].reverse().find(row => row.body.kind === "message" && row.body.text.trim())?.body;
  const preview = current.waiting ? "Needs you" : current.busy ? current.caption : message?.kind === "message" ? message.text.replace(/[*_#`\n]+/g, " ") : "No messages yet";
  return <button className={`${pinned ? "pinned__tile" : "bot-row"}${selected ? " is-selected" : ""}`} onClick={choose} aria-label={"Chat with " + bot.name} aria-current={selected ? "page" : undefined} title={collapsed ? `${bot.name} · ${current.busy ? current.status + ": " : ""}${preview}` : undefined}>
    <span className={pinned ? "pinned__avatar" : "bot-row__avatar"}><BotAvatarFor bot={bot} size={pinned ? collapsed ? 44 : 60 : 36} />{(current.busy || unread) && <span className={`status-dot ${current.waiting ? "is-attention" : current.busy ? "is-working" : "is-unread"}${pinned ? " pinned__dot" : ""}`} aria-label={current.waiting ? "Needs you" : current.busy ? current.status : "Unread message"} />}{unread && current.busy && <span className="unread-mark" aria-label="Unread message" />}</span>
    {!collapsed && <span className={pinned ? "pinned__text" : "bot-row__text"}><span className={pinned ? "pinned__label" : "bot-row__name"}>{bot.name}</span>{(!pinned || current.busy) && <span className={`bot-row__preview${current.busy && !current.waiting ? " is-shimmering" : ""}`} title={pinned ? preview : undefined}>{pinned ? current.waiting ? "Needs you" : current.status : preview}</span>}</span>}
  </button>;
}
export function Sidebar() {
  const { bots, live, selected, page, collapsed, transcripts, unread } = useStore();
  const lead = bots.find(b => b.lead);
  const [menu, showMenu] = useState<"add" | "more" | null>(null);
  const [position, place] = useState({ left: 16, top: 140 });
  const root = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!menu) return;
    const align = () => {
      const button = trigger.current?.getBoundingClientRect(), box = menuBox.current?.getBoundingClientRect();
      if (!button || !box) return;
      place({ left: Math.max(8, Math.min(button.left, innerWidth - box.width - 8)), top: menu === "more" ? button.top : Math.max(8, Math.min(button.bottom, innerHeight - box.height - 8)) });
    };
    align(); window.addEventListener("resize", align);
    const observer = new ResizeObserver(align); if (menuBox.current) observer.observe(menuBox.current);
    return () => { window.removeEventListener("resize", align); observer.disconnect(); };
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) showMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { showMenu(null); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); };
  }, [menu]);
  const toggle = (which: "add" | "more", button: HTMLButtonElement) => {
    const box = button.getBoundingClientRect(); trigger.current = button;
    place({ left: Math.max(8, Math.min(box.left, innerWidth - 236)), top: which === "more" ? box.top : box.bottom });
    showMenu(menu === which ? null : which);
  };
  return <aside ref={root} className={"sidebar" + (collapsed ? " is-collapsed" : "")} aria-label="Your team">
    <div className="sidebar__titlebar"><SafetySwitch /><div className="sidebar__controls"><button className="icon-btn icon-btn--plain" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => set({ collapsed: !collapsed })}><Icon name="sidebar" /></button><button className="icon-btn" aria-label="Add to team" aria-expanded={menu === "add"} aria-controls="team-add-menu" onClick={e => toggle("add", e.currentTarget)}><Icon name="plus" /></button></div></div>
    <div className="sidebar__scroll">
      {lead && <div className="pinned"><BotTile bot={lead} live={live[lead.id]} rows={transcripts[lead.id]?.rows ?? []} unread={!!unread[lead.id]} selected={selected === lead.id && page === "chat"} collapsed={collapsed} pinned choose={() => { showMenu(null); void selectBot(lead.id); }} /></div>}
      <div className="bot-list">{bots.filter(b => !b.lead).sort((a, b) => {
        const activity = (id: string) => Math.max(Date.parse(transcripts[id]?.rows.at(-1)?.ts ?? "") || 0, Date.parse(live[id]?.since ?? "") || 0, ...((live[id]?.work ?? []).map(job => Date.parse(job.since) || 0)));
        return activity(b.id) - activity(a.id);
      }).map(bot => <BotTile key={bot.id} bot={bot} live={live[bot.id]} rows={transcripts[bot.id]?.rows ?? []} unread={!!unread[bot.id]} selected={selected === bot.id && page === "chat"} collapsed={collapsed} choose={() => { showMenu(null); void selectBot(bot.id); }} />)}</div>
    </div>
    <div className="sidebar__footer"><span className="account__name">{!collapsed && "Tavi"}</span><button className="more-trigger" aria-label="More" aria-expanded={menu === "more"} aria-controls="team-more-menu" onClick={e => toggle("more", e.currentTarget)}><Icon name="more" />{!collapsed && "More"}</button></div>
    {menu && <div ref={menuBox} className="team-menu" id={menu === "add" ? "team-add-menu" : "team-more-menu"} style={{ left: position.left, ...(menu === "more" ? { bottom: innerHeight - position.top, maxHeight: Math.max(0, position.top - 8) } : { top: position.top, maxHeight: "calc(100dvh - 16px)" }) }}>
      {menu === "add" ? <><button onClick={() => { showMenu(null); void startBotSetup(); }}><Icon name="plus" />New bot</button><button disabled={bots.length < 2} onClick={() => { trigger.current?.focus(); showMenu(null); set({ modal: "room" }); }}><Icon name="users" />Ask several bots</button></> : <>
        <nav aria-label="Your pages">{([ ["files", "Files", "folder"], ["brain", "The Brain", "brain"], ["pins", "Pins", "pin"], ["new", "What's new", "bell"], ["subscriptions", "Subscriptions", "users"], ["settings", "Settings", "settings"], ["welcome-options", "Make Tavi yours", "users"] ] as const).map(([key, label, icon]) => <button key={key} aria-current={page === key ? "page" : undefined} onClick={() => { trigger.current?.focus(); showMenu(null); set({ page: key, viewer: null }); }}><Icon name={icon} />{label}</button>)}</nav>
        {fixtureMode && <details className="fixture-shelf"><summary>Preview items</summary>{fixtureItems.map(item => <button key={item.id} onClick={() => { set({ viewer: item }); showMenu(null); }}>{item.id === "preview-calendar" ? "calendar" : item.kind}</button>)}</details>}
      </>}
    </div>}
  </aside>;
}
