// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useRef, useState } from "react";
import { startConnection, useStore, set } from "./store";
import { Subscriptions } from "./components/Subscriptions";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { DetailsPanel } from "./components/DetailsPanel";
import { SafetyBanner, SafetySwitch } from "./components/SafetySwitch";
import { presence } from "./lib/presence";
import { botAccent } from "./lib/colours";
import { ConfigLayer } from "./components/ConfigLayer";
import { ItemViewer } from "./components/ItemViewer";
import { LegacyPages } from "./components/LegacyPages";
import { RoomChat } from "./components/RoomChat";
import { Icon } from "./components/Icon";
import { PageBack } from "./components/PageBack";
import { Welcome, useWelcome } from "./onboarding/Welcome";
import { Conversation } from "./onboarding/Conversation";
import { Later } from "./onboarding/Later";
type Preview = Parameters<import("../desktop/files").FilesNav["preview"]>[0];
export function App() {
  const welcome = useWelcome();
  const { selected, bots, live, viewer, page, error, collapsed, detailsOpen, modal } = useStore();
  const [preview, showPreview] = useState<Preview | null>(null);
  const pageOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (page === "chat") { if (pageOpener.current?.isConnected) pageOpener.current.focus(); pageOpener.current = null; return; }
    pageOpener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : document.querySelector(".more-trigger");
    document.querySelector<HTMLElement>(".page-bar button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('.modal-root, .team-menu, .safety-popover, .item-viewer')) { e.preventDefault(); set({ page: "chat", viewer: null }); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [page]);
  useEffect(startConnection, []);
  useEffect(() => { showPreview(null); }, [page]);
  useEffect(() => { const close = () => showPreview(null); document.addEventListener("lh-preview-closed", close); return () => document.removeEventListener("lh-preview-closed", close); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "k") { e.preventDefault(); set({ modal: "search" }); }
      if (e.key.toLowerCase() === "b") { e.preventDefault(); set({ collapsed: !useStore.getState().collapsed }); }
      if (e.key === ",") { e.preventDefault(); set({ modal: "settings" }); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  const bot = bots.find(b => b.id === selected);
  const active = presence(live[selected ?? ""]).busy;
  const workIds = (live[selected ?? ""]?.work ?? []).map(work => work.id).join(",");
  // Reopen for new things to look at, while respecting a manual close during the same work.
  useEffect(() => { set({ detailsOpen: !!bot && (bot.computer || active || !!workIds) }); }, [bot?.id, bot?.computer, active, workIds]);
  if (welcome.checking || welcome.error) return <div className="welcome-shell"><header className="welcome-top"><span>Tavi</span><SafetySwitch /></header><div className="app welcome-app"><main className="welcome"><div className="welcome-copy"><h1>{welcome.error ? "Your place is kept" : "Opening Tavi…"}</h1>{welcome.error && <><p role="alert">{welcome.error}</p><button className="btn btn--primary" onClick={() => void welcome.load()}>Try again</button></>}</div></main></div></div>;
  if (welcome.welcome && !welcome.welcome.opened) return <Welcome state={welcome.welcome} change={welcome.change} finish={() => void welcome.load()} />;
  return <div className="hq-window" style={botAccent(bot?.look.colour)}><SafetyBanner /><div className={`app${collapsed ? " is-sidebar-collapsed" : ""}${detailsOpen && bot && page === "chat" ? " has-details" : ""}`}><Sidebar /><div className={"work-area" + (page !== "chat" ? " has-page" : "")}>{page !== "chat" && <PageBack />}{page === "subscriptions" && <Subscriptions />}{page === "welcome-options" && <Later />}{page === "chat" && <><Conversation /><ChatView /></>}{page === "room" && <RoomChat key={useStore.getState().room?.name} />}<LegacyPages preview={value => { showPreview(value); set({ viewer: value?.item ?? null }); }} /></div>{bot && detailsOpen && page === "chat" && !viewer && !preview && <DetailsPanel key={bot.id} bot={bot} />}{(viewer || preview) && <ItemViewer key={viewer?.id ?? preview?.entry.id} item={viewer} preview={preview} />}{error && <div className="hq-error" role="alert">{error}<button className="icon-btn" aria-label="Dismiss message" onClick={() => set({ error: null })}><Icon name="close" /></button></div>}</div>{modal && <ConfigLayer />}</div>;
}
