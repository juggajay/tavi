import { earlier, savedValue } from "../../../src/shared/earlier";
// The app updates itself after a new version goes live (Stage 13.4). An app opened from the home screen keeps the code
// it was opened with until it's fully closed, so after an update it could be sent something only the new code knows how
// to show (Stage 12's shop drawings came up as a blank page). The gateway says which build it serves in its hello, on
// every connect and reconnect; when that isn't the build this app was loaded with, the app reloads itself at the first
// safe moment (never during a call, while typing, drawing on the pad or with a tap-to-approve up: then as soon as that's
// over, or when it's next brought back to the screen) and reopens what was up. Once per new build per session: if the
// builds still differ after reloading, it carries on as it is and says nothing.
import { assetsIn, buildIdOf } from "../../../src/shared/build";

/** This app's own build, from the page it was loaded with: read once at start, before anything is fetched later. "" on
 *  the dev server (no built files), which never updates itself. */
export const OWN_BUILD = buildIdOf(assetsIn([...document.querySelectorAll("script[src],link[href]")].map((e) => e.outerHTML).join("")));

const TRIED = "tavi-update-tried"; // the builds this session has already reloaded for
const REOPEN = "tavi-update-reopen"; // what was up, for after the reload

/** The builds already reloaded for in this session; null if the browser won't keep them (then it never reloads, so it
 *  can't loop). */
function tried(): string[] | null {
  try {
    const v = JSON.parse(savedValue(sessionStorage, TRIED) || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return null;
  }
}

export type UpdaterOpts = {
  kind: "phone" | "desktop";
  /** Whether now is a safe moment to reload (no call, no typing, no pad, no tap-to-approve up, nothing being worked on). */
  safe: () => boolean;
  /** What's up now, to reopen after the reload (anything JSON); null for nothing. */
  save: () => unknown;
};

export function createUpdater(o: UpdaterOpts) {
  let pending: string | null = null;
  let going = false;

  /** The gateway's build, from its hello. */
  function check(server: unknown) {
    if (typeof server !== "string" || !server || !OWN_BUILD || server === OWN_BUILD || going) return;
    const t = tried();
    if (!t || t.includes(server)) return; // reloaded for it once already (or can't remember): carry on, quietly
    pending = server;
    tick();
  }
  /** Something this build can't show: if the gateway has a newer one, update to it the same way. */
  async function unknownKind() {
    const r = (await fetch("/api/health")
      .then((x) => (x.ok ? x.json() : null))
      .catch(() => null)) as { build?: Record<string, string | null> } | null;
    check(r?.build?.[o.kind]);
  }
  /** Reload now if one is waiting and it's a safe moment; otherwise it's tried again shortly, and on coming back. */
  function tick() {
    if (!pending || going || !o.safe()) return;
    const t = tried();
    if (!t) return void (pending = null);
    try {
      sessionStorage.setItem(TRIED, JSON.stringify([...t, pending].slice(-10)));
      sessionStorage.setItem(REOPEN, JSON.stringify(o.save() ?? null));
    } catch {
      return void (pending = null);
    }
    going = true;
    pending = null;
    void (async () => {
      // a changed service worker is fetched and put in charge first (it takes over at once), at most a second and a half
      const sw = navigator.serviceWorker?.getRegistration().then((r) => r?.update());
      await Promise.race([sw?.catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
      location.reload();
    })();
  }
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => !document.hidden && tick());
  return {
    /** This app's build. */
    own: OWN_BUILD,
    check,
    unknownKind,
    tick,
    /** The newer build it's waiting to reload for, if any. */
    get pending() {
      return pending;
    },
  };
}

/** Just after the app reloaded itself to update: what was up then (null: nothing). undefined: it didn't just update.
 *  Read once. */
export function takeReopen<T>(): T | null | undefined {
  try {
    const s = savedValue(sessionStorage, REOPEN);
    if (s === null) return undefined;
    sessionStorage.removeItem(REOPEN);
    sessionStorage.removeItem(earlier.prefix + REOPEN.replace(/^tavi-/, ""));
    return JSON.parse(s) as T | null;
  } catch {
    return undefined;
  }
}

/** The plain line for an item kind this build doesn't know (never a blank page). */
export const NEWER_NEEDED = "This needs the newer version of the app. Close the app fully and open it again.";
