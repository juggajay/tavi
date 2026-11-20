import { useEffect, useState } from "react";
import { BotFace } from "../avatar/BotAvatar";
import { LookPicker } from "../avatar/LookPicker";
import { Subscriptions } from "../components/Subscriptions";
import { SafetySwitch } from "../components/SafetySwitch";
import { oldRequest, request } from "../lib/api";
import { useStore, set, selectBot, refreshSubscriptions } from "../store";
import { fixtureMode } from "../dev/fixtures";
import { onboardingRequest } from "./api";
import type { Welcome as WelcomeState } from "../../../../src/hq/onboarding/setup";
import "../styles/onboarding.css";

export function useWelcome() {
  const [welcome, change] = useState<WelcomeState | null>(null), [checking, check] = useState(!fixtureMode), [error, fail] = useState("");
  const load = async () => {
    try { const result = await onboardingRequest<{ welcome: WelcomeState | null }>(); change(result.welcome); fail(""); }
    catch { if (!fixtureMode) fail("Could not read your welcome steps. Your place is kept. Please try again."); }
    finally { check(false); }
  };
  useEffect(() => { void load(); }, []);
  return { welcome, change, checking, error, load };
}
export function Welcome({ state, change, finish }: { state: WelcomeState; change: (next: WelcomeState) => void; finish: () => void }) {
  const bots = useStore(s => s.bots), signed = useStore(s => s.subscriptions.some(s => s.signedIn)), safety = useStore(s => s.safety);
  const [name, nameIt] = useState(() => localStorage.getItem("tavi-welcome-name") || "Mira"), [shape, faceIt] = useState(() => localStorage.getItem("tavi-welcome-shape") || "pebble"), [colour, colourIt] = useState(() => localStorage.getItem("tavi-welcome-colour") || "blue");
  const [busy, wait] = useState(false), [error, fail] = useState(""), [pin, pinIt] = useState(""), [again, repeatPin] = useState("");
  const [setup, setupIt] = useState<{ phoneUrl?: string | null; voice?: { ready: boolean } } | null>(null);
  const [phoneCopied, copied] = useState(false);
  const step = state.step;
  useEffect(() => { localStorage.setItem("tavi-welcome-name", name); localStorage.setItem("tavi-welcome-shape", shape); localStorage.setItem("tavi-welcome-colour", colour); }, [name, shape, colour]);
  useEffect(() => { fail(""); document.querySelector<HTMLElement>(".welcome h1")?.focus({ preventScroll: true }); document.querySelector(".welcome-shell")?.scrollTo(0, 0); if (["voice", "phone"].includes(step)) void oldRequest<typeof setup>("/api/setup/status").then(setupIt).catch(() => fail("Could not read this setting. Try again, or choose later.")); if (step === "subscription") void refreshSubscriptions().catch(() => {}); }, [step]);
  // Once the last optional choice is saved, the main bot opens the conversation itself.
  useEffect(() => { if (step === "ready" && !state.opened) void next(); }, [step]);
  async function next(skip = false) {
    if (busy) return;
    wait(true); fail("");
    try {
      const result = await onboardingRequest<WelcomeState>("", { step, ...(skip ? { skip: true } : {}), ...(step === "bot" ? { name, shape, colour } : {}) });
      if (step === "ready") { if (state.bot) await selectBot(state.bot); finish(); }
      else change(result);
    } catch (e) { fail(e instanceof Error ? e.message : "Could not finish this step. Try again."); }
    finally { wait(false); }
  }
  const bot = bots.find(b => b.id === state.bot), title = { hello: "Welcome to Tavi", bot: "Your main bot", subscription: "A subscription to think with", pin: "Your safety PIN", voice: "Talk as well as type", phone: "Take Tavi with you", computer: "A computer for your bot", ready: "Let's get to know you" }[step];
  const action = step === "hello" ? "Make it yours" : step === "computer" ? "Give it a computer" : step === "ready" ? "Try opening the conversation again" : "Continue";
  return <div className="welcome-shell"><header className="welcome-top"><span>Tavi</span><SafetySwitch /></header><div className="app welcome-app"><main className={`welcome welcome--${step}`} aria-label="Welcome to Tavi"><div className="welcome-art"><BotFace shape={step === "hello" ? "pebble" : shape} colour={colour} size={step === "hello" ? 112 : 76} /></div><div className="welcome-copy"><p className="welcome-kicker">{step === "hello" ? "A little help, every day" : ["voice", "phone", "computer"].includes(step) ? "If you would like" : "Make yourself at home"}</p><h1 tabIndex={-1}>{title}</h1>
    {step === "hello" && <><p>Tavi is your personal assistant, with a main bot to talk to and a team when you need one. It learns what matters to you so its help fits your life.</p><div className="welcome-note"><b>Kept on this PC</b><p>What it learns about you is kept here. To answer, it sends your words and the context it needs to the model company you sign in to.</p><p>It does not upload your PC or sign-ins. If you ask it to use another service, it will tell you what needs to be shared.</p></div></>}
    {step === "bot" && <><p>Your everyday point of contact. Keep this name and face, or choose ones you like. You can change them later.</p><label className="welcome-label">Name<input className="text-input" value={name} maxLength={24} onChange={e => nameIt(e.target.value)} /></label><details className="welcome-face"><summary>Choose a face and colour</summary><LookPicker shape={shape} colour={colour} setShape={faceIt} setColour={colourIt} /></details></>}
    {step === "subscription" && <><p>Your bot needs a model to think with. Sign in to your own Claude or OpenAI subscription.</p><p className="welcome-hint">One is enough. With both, your bot can carry on with the other if one reaches its limit.</p><Subscriptions /></>}
    {step === "pin" && <><p>The safety switch stops the team whenever you need. Your PIN lets you switch it back on. Keep it to yourself.</p>{safety.pinSet ? <div className="welcome-note">Your PIN is already set. You can carry on.</div> : <form id="welcome-pin" onSubmit={async e => {
      e.preventDefault(); wait(true); fail("");
      try { await request("/safety/pin", "POST", { pin }); await request("/safety", "POST", { level: "open", pin }); const result = await request<{ level: "open"; pinSet: boolean; until: string | null }>("/safety"); set({ safety: result, guard: "up" }); pinIt(""); repeatPin(""); }
      catch { fail("Could not save your PIN and switch on. Try again using the safety switch above."); } finally { await request<{ level: "open"; pinSet: boolean; until: string | null }>("/safety").then(safety => set({ safety })).catch(() => {}); wait(false); }
    }}><label className="welcome-label">Choose a PIN<input type="password" inputMode="numeric" autoComplete="new-password" className="text-input" value={pin} onChange={e => pinIt(e.target.value)} /></label><label className="welcome-label">The same PIN again<input type="password" inputMode="numeric" autoComplete="new-password" className="text-input" value={again} onChange={e => repeatPin(e.target.value)} /></label><p className="welcome-hint">Four to twelve digits. It is saved only on this PC.</p></form>}</>}
    {step === "voice" && <><p>You can get to know {bot?.name ?? name} by talking, or keep typing. Both use the same conversation and notes.</p><div className="welcome-note"><b>{setup?.voice?.ready ? "Voice is ready" : "What you need"}</b><p>A microphone and an OpenAI voice key are needed. Voice is charged separately from your chat subscription; the words you speak go to the voice service.</p><p>{setup?.voice?.ready ? "Use the call button in your conversation when you are ready." : "The chat subscription alone does not include voice. You can arrange the voice key on this PC later."}</p></div><p className="welcome-hint">Find this later in More → Make Tavi yours → Voice.</p></>}
    {step === "phone" && <><p>Use the same team from your phone. This PC needs to stay on, and your phone needs access to its private connection.</p><div className="welcome-note"><b>Your phone link</b>{setup?.phoneUrl ? <><p className="welcome-address">{setup.phoneUrl}</p><button className="btn btn--secondary" onClick={async () => { try { await navigator.clipboard.writeText(setup.phoneUrl!); copied(true); } catch { fail("Could not copy the link. You can select it above."); } }}>{phoneCopied ? "Copied" : "Copy phone link"}</button><p>Open this address on your phone, pair it when asked, then add it to your home screen.</p></> : <p>A phone address is not available yet. Set up the private connection on this PC, then find the link under Make Tavi yours.</p>}</div><p className="welcome-hint">Find this later in More → Make Tavi yours → Phone.</p></>}
    {step === "computer" && <><p>{bot?.name ?? name} can have its own screen and browser. You can watch it work and take control whenever you like.</p><div className="welcome-note"><b>Its own space</b><p>Its computer is separate from this PC's files and sign-ins. It uses extra memory while it is on.</p></div><p className="welcome-hint">Find this later beside your conversation, under Computer.</p></>}
    {step === "ready" && <p>{busy ? "Opening your conversation…" : "Your place is kept. We can open the conversation when you are ready."}</p>}
    {error && <p className="error" role="alert">{error}</p>}<div className="welcome-actions">{step === "pin" && !safety.pinSet ? <button form="welcome-pin" className="btn btn--primary" disabled={busy || !/^\d{4,12}$/.test(pin) || pin !== again}>Save PIN and switch on</button> : <button className="btn btn--primary" disabled={busy || (step === "bot" && !name.trim()) || (step === "subscription" && !signed) || (step === "voice" && !setup?.voice?.ready) || (step === "phone" && !setup?.phoneUrl)} onClick={() => void next()}>{busy ? "One moment…" : action}</button>}{["voice", "phone", "computer"].includes(step) && <button className="link-btn" disabled={busy} onClick={() => void next(true)}>Maybe later</button>}</div><p className="welcome-saved">You can close Tavi and carry on here later.</p></div></main></div></div>;
}
