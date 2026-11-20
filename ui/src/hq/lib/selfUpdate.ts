// The desktop app refreshes itself when newer screens have been built. A window left open keeps the screens it was
// opened with, and the installed program has no reload button, so without this a change never shows up until the
// program is closed and opened again. It asks the server which screens it is serving (when the link to it opens, when
// the window comes back to the front, and every minute), and when they are newer it reloads at the first safe moment:
// never during a call, with words typed in a box, with a window open over the app, while he is using a bot's computer,
// or while there is something waiting for his OK. After the reload the same bot's conversation is showing.
import { createUpdater, takeReopen } from "../../shared/update";
import { useStore, set } from "../store";

type Kept = { selected: string | null };

function typing(): boolean {
  const at = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (at && /^(INPUT|TEXTAREA)$/.test(at.tagName) && at.value?.trim()) return true;
  return [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].some(box => box.value.trim());
}
const updater = createUpdater({
  kind: "desktop",
  safe: () => {
    const s = useStore.getState();
    return !s.call && !s.modal && !typing() && !document.fullscreenElement
      && !document.querySelector(".modal-root, .safety-popover, .team-menu, .approval-card")
      && !Object.values(s.computers).some(computer => (computer as { controlledBy?: string | null } | undefined)?.controlledBy);
  },
  save: (): Kept => ({ selected: useStore.getState().selected }),
});

/** Ask the server which screens it is serving now (also called whenever the link to it opens again). */
export async function checkScreens() {
  try {
    const reply = await fetch("/api/health", { cache: "no-store" });
    if (reply.ok) updater.check(((await reply.json()) as { build?: { hq?: string | null } }).build?.hq);
  } catch { /* the server is restarting; the greeting will say when it is back */ }
}
export function startSelfUpdate() {
  setInterval(() => void checkScreens(), 60_000);
  addEventListener("focus", () => void checkScreens());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void checkScreens(); });
  // Just reloaded for newer screens: go back to the conversation that was showing, once the team has loaded.
  const kept = takeReopen<Kept>();
  if (kept?.selected) {
    const stop = useStore.subscribe(state => {
      if (!state.bots.length) return;
      stop();
      if (state.bots.some(bot => bot.id === kept.selected) && state.selected !== kept.selected) set({ selected: kept.selected });
    });
  }
}
