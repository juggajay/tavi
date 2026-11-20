// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useState } from "react";
import { useStore, set } from "../store";
import type { TeamBot } from "../types";
import { ComputerViewer } from "./ComputerViewer";
import { EngineMenu } from "./EngineSettings";
import { Icon } from "./Icon";
import { changeComputer, useComputer, computerWords } from "../lib/computer";
import { BotAvatarFor } from "../avatar/BotAvatar";
import { ScreenCard } from "./details/ScreenCard";
import { Upcoming } from "./details/Upcoming";
import { Tasks, Library } from "./details/Resources";

const tabs = ["Activity", "Tasks", "Library"] as const;
export function DetailsPanel({ bot }: { bot: TeamBot }) {
  const [tab, changeTab] = useState<typeof tabs[number]>("Activity");
  const [screenOpen, showScreen] = useState<false | "watch" | "control">(false), [computerError, setComputerError] = useState("");
  const computer = useComputer(bot);
  const choice = useStore(s => s.engines[bot.id]?.primary) ?? bot.primary;
  return <aside className="details" aria-label="Conversation details">
    <div className="details__top">
      <button className="icon-btn icon-btn--bordered details__gear" aria-label={`${bot.name}'s settings`} onClick={() => set({ modal: "bot" })}><Icon name="settings" /></button>
      <button className="icon-btn icon-btn--bordered" aria-label="Close details" onClick={() => set({ detailsOpen: false })}><Icon name="close" /></button>
    </div>
    <div className="details__scroll">
      <div className="details__hero">
        <ScreenCard bot={bot} computer={computer} paused={!!screenOpen} open={mode => showScreen(mode ?? "watch")} />
        <div className="details__who">
          <BotAvatarFor bot={bot} size={36} />
          <div className="details__who-text"><div className="details__who-head"><span className="details__who-name" title={bot.name}>{bot.name}</span><span className="details__model" title={choice.model}>{choice.model}</span></div><div className="details__who-sub">{computerWords(bot, computer)}</div></div>
          {bot.computer && <button className="btn btn--secondary btn--sm details__open" onClick={() => showScreen("watch")}>Open</button>}
        </div>
      </div>
      <div className="details__tabs"><div className="segmented" role="tablist" aria-label="Conversation resources">{tabs.map((name, index) => <button key={name} id={`details-tab-${name}`} role="tab" aria-controls="details-resource-panel" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} className={tab === name ? "is-active" : ""} onClick={() => changeTab(name)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (next < 0) return; event.preventDefault(); changeTab(tabs[next]); document.getElementById(`details-tab-${tabs[next]}`)?.focus();
      }}>{name}</button>)}</div></div>
      <div id="details-resource-panel" role="tabpanel" aria-labelledby={`details-tab-${tab}`} tabIndex={0}>
        {tab === "Activity" ? <div className="details__sections">
          <Upcoming bot={bot} />
          <section aria-label="Engine"><div className="section-label">Engine</div><EngineMenu bot={bot}>{bot.computer && <label className="check-label details__computer-switch"><input type="checkbox" checked={bot.computer} disabled={computer?.state === "starting"} onChange={event => { setComputerError(""); void changeComputer(bot.id, event.target.checked).catch(() => setComputerError("Couldn't change its computer. Check the safety switch and try again.")); }} />Its own computer</label>}{computerError && <p className="engine__error" role="alert">{computerError}</p>}</EngineMenu></section>
          <section aria-label="Voice chat"><div className="section-label">Voice chat</div><div className="panel-card"><div className="panel-row panel-row--setting"><span>Voice</span><span>{bot.voice ? bot.voice[0].toUpperCase() + bot.voice.slice(1) : "Not available"}</span></div><div className="engine__conn">Change it by telling {bot.name}</div></div></section>
        </div> : tab === "Tasks" ? <Tasks bot={bot} /> : <Library bot={bot} />}
      </div>
    </div>
    {screenOpen && <ComputerViewer bot={bot} initial={screenOpen} onClose={() => showScreen(false)} />}
  </aside>;
}
