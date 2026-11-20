import { useEffect } from "react";
import { request } from "./api";
import { set, useStore } from "../store";
import type { TeamBot } from "../types";
import { fixtureMode, fixtureComputer, rememberFixtureComputer } from "../dev/fixtures";
export type Computer = { has: boolean; state: "off" | "starting" | "ready" | "stopped" | "error"; why: string; width: number; height: number; controlledBy: "owner" | null; changeError?: string };
export function keepComputer(bot: string, computer: Computer) { set(s => ({ computers: { ...s.computers, [bot]: { ...computer, changeError: s.computers[bot]?.changeError } } })); }
export function computerWords(bot: TeamBot, computer?: Computer) {
  if (!bot.computer) return "No computer";
  const state = useStore.getState();
  if (state.safety.level !== "open" || state.guard !== "up") return "Computer asleep";
  return computer?.state === "ready" ? "Computer awake" : computer?.state === "error" ? "Computer needs attention" : computer?.state === "stopped" || computer?.state === "off" ? "Computer asleep" : "Computer starting…";
}
export function useComputer(bot: TeamBot) {
  const computer = useStore(s => s.computers[bot.id]);
  useEffect(() => {
    let ended = false;
    const read = () => {
      if (fixtureMode) { if (!useStore.getState().computers[bot.id]) keepComputer(bot.id, fixtureComputer(bot)); return; }
      void request<Computer>(`/bots/${bot.id}/computer`).then(c => { if (!ended && typeof c.has === "boolean") keepComputer(bot.id, c); }).catch(() => {});
    };
    read(); const timer = setInterval(read, 2000);
    return () => { ended = true; clearInterval(timer); };
  }, [bot.id, bot.computer]);
  return computer;
}
export async function changeComputer(bot: string, on: boolean) {
  const panelWasOpen = useStore.getState().detailsOpen && useStore.getState().selected === bot;
  const before = useStore.getState().bots.find(b => b.id === bot)?.computer ?? false;
  const previous = useStore.getState().computers[bot];
  set(s => ({ computers: { ...s.computers, ...(previous ? { [bot]: { ...previous, changeError: undefined } } : {}) } }));
  set(s => ({ bots: s.bots.map(b => b.id === bot ? { ...b, computer: on } : b) }));
  keepComputer(bot, { has: on, state: on ? "starting" : "off", why: on ? "Setting up its screen…" : "This bot has no computer.", width: 1440, height: 900, controlledBy: null });
  try {
    if (fixtureMode) {
      await new Promise(resolve => setTimeout(resolve, 1100));
      if (new URLSearchParams(location.search).has("computer-failure")) throw new Error("Its computer couldn't start. Check the safety switch and try again.");
      rememberFixtureComputer(bot, on);
      keepComputer(bot, { has: on, state: on ? "ready" : "off", why: "", width: 1440, height: 900, controlledBy: null }); return;
    }
    keepComputer(bot, await request<Computer>(`/bots/${bot}/computer`, "POST", { on }));
  } catch (error) {
    set(s => ({ bots: s.bots.map(b => b.id === bot ? { ...b, computer: before } : b) }));
    keepComputer(bot, previous ?? { has: before, state: before ? "error" : "off", why: "Its computer couldn't start. Please try again.", width: 1440, height: 900, controlledBy: null });
    set(s => ({ computers: { ...s.computers, [bot]: { ...s.computers[bot], changeError: error instanceof Error ? error.message : "Couldn't change its computer. Please try again." } } }));
    throw error;
  } finally {
    // The desktop closes details when a computer goes off. Keep this change and any error in view.
    if (panelWasOpen) requestAnimationFrame(() => {
      if (useStore.getState().selected === bot && useStore.getState().page === "chat") set({ detailsOpen: true });
    });
  }
}
