// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { BotAvatarFor } from "../avatar/BotAvatar";
import { useStore, set } from "../store";
import { WorkStrip } from "./WorkStrip";
import { Composer } from "./Composer";
import { Transcript, ConversationNotices } from "./Transcript";
import { presence } from "../lib/presence";
import { Icon } from "./Icon";
export function ChatView() {
  const { bots, selected, transcripts, live, loaded, detailsOpen, engines, setupBot } = useStore();
  const bot = bots.find(b => b.id === selected);
  if (!bot) return <main className="chat chat--empty"><div className="first-run"><h1>Your team starts here</h1><p>Add your first bot, then sign in to your own Claude or OpenAI account. Give it a job and it will work alongside you.</p><button className="btn btn--primary" onClick={() => set({ modal: "create" })}>{loaded ? "Add your first bot" : "Add a bot"}</button></div></main>;
  return <main className="chat" aria-label="Chat"><header className="chat__header"><button className="chat__pill" aria-label={`Settings for ${bot.name}`} onClick={() => set({ modal: "bot" })}><BotAvatarFor bot={bot} size={24} /><span className="chat__pill-name">{bot.name}</span></button><div className="chat__header-right">{!detailsOpen && <button className="icon-btn" aria-label="Show details" onClick={() => set({ detailsOpen: true })}><Icon name="sidebar" /></button>}</div></header><ConversationNotices rows={transcripts[bot.id]?.rows ?? []} />{(engines[bot.id]?.status === "not_signed_in" || useStore.getState().subscriptions.find(s => s.provider === bot.primary.provider)?.signedIn === false) && <div className="sign-in-start"><p>{bot.name}'s subscription is not signed in.</p><button className="link-btn" onClick={() => set({ page: "subscriptions", viewer: null })}>Open Subscriptions</button></div>}{setupBot && bot.lead && <div className="setup-conversation"><span>{setupBot === "new" ? "Tell me what your new bot is for." : "Tell me what you'd like to change."}</span><button className="link-btn" onClick={async () => { if (setupBot === "new") set({ modal: "create" }); else { const target = setupBot; await import("../store").then(store => store.selectBot(target)); set({ modal: "bot-card" }); } }}>Fill in the card myself</button></div>}<Transcript key={`transcript-${bot.id}`} bot={bot} rows={transcripts[bot.id]?.rows ?? []} live={live[bot.id]} /><WorkStrip key={`work-${bot.id}`} bot={bot} live={live[bot.id]} /><Composer key={bot.id} bot={bot} running={presence(live[bot.id]).busy && !presence(live[bot.id]).waiting} /></main>;
}
