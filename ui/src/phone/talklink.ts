// "Open <name>" (Stage 14.3): the app opened from a Shortcut with ?talk=1 starts listening. If the microphone was
// already allowed and the browser lets sound play without a tap, the call starts by itself; otherwise one clear tap
// target fills the screen ("Tap to talk"). The flag is taken off the address at once, so a reload doesn't call again.

export type TalkDecision = "start" | "tap" | "no-voice" | "none";

/** Was the app opened to talk? Takes the flag off the address either way. */
export function takeTalkFlag(): boolean {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has("talk")) return false;
    u.searchParams.delete("talk");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    return true;
  } catch {
    return false;
  }
}

/** The microphone permission as the browser reports it: granted, prompt, denied, or unknown. */
async function micState(): Promise<string> {
  try {
    return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch {
    return "unknown";
  }
}

/** Would sound play without a tap? A fresh audio context only runs when the browser allows it. */
async function soundAllowed(): Promise<boolean> {
  try {
    const ctx = new AudioContext();
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    const ok = ctx.state === "running";
    void ctx.close().catch(() => undefined);
    return ok;
  } catch {
    return false;
  }
}

export async function decideTalk(voiceReady: boolean): Promise<TalkDecision> {
  if (!voiceReady) return "no-voice";
  const [mic, sound] = await Promise.all([micState(), soundAllowed()]);
  return mic === "granted" && sound ? "start" : "tap";
}

/** One big button over everything; gone after the tap. */
export function showTalkTarget(host: HTMLElement, onTap: () => void) {
  if (document.getElementById("talkTarget")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.id = "talkTarget";
  b.className = "talk-target";
  b.setAttribute("aria-label", "Tap to talk");
  b.innerHTML = '<span class="tt-ring"></span><span class="tt-words">Tap to talk</span>';
  b.addEventListener(
    "click",
    () => {
      b.remove();
      onTap();
    },
    { once: true },
  );
  host.appendChild(b);
}
