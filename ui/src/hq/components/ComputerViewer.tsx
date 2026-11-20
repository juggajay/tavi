// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useRef, useState } from "react";
import type { TeamBot } from "../types";
import { fixtureMode, desktopUrl } from "../dev/fixtures";
import { useStore } from "../store";
import { useComputer } from "../lib/computer";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
export type ScreenMode = "watch" | "control";
export function ComputerScreen({ bot, mode = "watch", active = true, fit = true, onMode }: { bot: TeamBot; mode?: ScreenMode; active?: boolean; fit?: boolean; onMode?: (mode: ScreenMode) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState("Connecting to the computer…"), [attempt, retry] = useState(0);
  const safety = useStore(s => s.safety.level), guard = useStore(s => s.guard);
  const computer = useComputer(bot);
  const ready = fixtureMode || computer?.state === "ready";
  const modeChange = useRef(onMode); modeChange.current = onMode;
  useEffect(() => {
    if (safety !== "open" || guard !== "up" || !active || !ready) modeChange.current?.("watch");
  }, [safety, guard, active, ready]);
  useEffect(() => {
    if (!active || !bot.computer || fixtureMode || !ready || safety !== "open" || guard !== "up") return;
    let disposed = false, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rfb: import("@novnc/novnc").default | null = null;
    const host = ref.current!;
    const connect = async () => {
      setConnection(failures ? "Connecting to the screen again…" : "Connecting to the computer…");
      try {
        const { default: RFB } = await import("@novnc/novnc"); if (disposed) return;
        host.replaceChildren();
        const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/hq/bots/${encodeURIComponent(bot.id)}/screen?mode=${mode}`;
        const options = { shared: true, wsProtocols: ["binary"] };
        rfb = new RFB(host, url, options);
        rfb.viewOnly = mode === "watch"; rfb.scaleViewport = fit; rfb.resizeSession = false; rfb.focusOnClick = mode === "control";
        rfb.addEventListener("connect", () => { if (!disposed) { failures = 0; setConnection(""); if (mode === "control") rfb?.focus(); } });
        rfb.addEventListener("disconnect", () => {
          if (disposed) return;
          // A lost control connection always returns to watching.
          if (mode === "control" && modeChange.current) { modeChange.current("watch"); return; }
          setConnection("The screen connection ended. Trying again…");
          timer = setTimeout(() => void connect(), Math.min(10000, 500 * 2 ** failures++));
        });
        rfb.addEventListener("securityfailure", () => { if (!disposed) setConnection("The screen couldn't be opened on this device."); });
      } catch { if (!disposed) { setConnection("Couldn't open the screen. Trying again…"); timer = setTimeout(() => void connect(), Math.min(10000, 500 * 2 ** failures++)); } }
    };
    void connect();
    return () => { disposed = true; clearTimeout(timer); rfb?.disconnect(); host.replaceChildren(); };
  }, [bot.id, bot.computer, mode, active, fit, safety, guard, ready, attempt]);
  if (!bot.computer) return null;
  if (safety !== "open" || guard !== "up") return <div className="computer-empty" role="status"><Icon name="shield" size={32} /><b>Computer stopped</b><span>The safety switch is {safety === "open" ? "being checked" : "on"}.</span></div>;
  if (!ready) return <div className="computer-empty" role="status"><b>{computer?.state === "stopped" ? "Computer stopped" : computer?.state === "error" ? "Computer needs attention" : "Setting up its screen…"}</b><span>{computer?.why}</span></div>;
  if (fixtureMode) return <div className="screen-picture"><img src={desktopUrl} alt="A made-up web page comparing three laptops" /><span>{mode === "control" ? "Taking over · preview picture" : "Watch · preview picture"}</span></div>;
  return <div className="screen-live" style={{ width: "100%", flexShrink: 0 }}><div ref={ref} className="vnc-host" aria-label={`${bot.name}'s computer`} />{connection && <div className="screen-status" role="status">{connection}<button className="btn btn--secondary" onClick={() => retry(attempt + 1)}>Try screen again</button></div>}</div>;
}
export function ComputerViewer({ bot, onClose, initial = "watch" }: { bot: TeamBot; onClose: () => void; initial?: ScreenMode }) {
  const [mode, change] = useState<ScreenMode>(initial);
  const [fit, setFit] = useState(true);
  const safety = useStore(s => s.safety.level), computer = useComputer(bot);
  return <Modal label={`${bot.name}'s computer`} onClose={onClose} wide><div style={{ outline: mode === "control" ? "3px solid var(--accent, #D65918)" : undefined, outlineOffset: -3 }} data-control={mode}>
    <div className="button-row screen-tools"><button className="btn btn--primary" disabled={safety !== "open" || (!fixtureMode && computer?.state !== "ready")} onClick={() => change(mode === "control" ? "watch" : "control")}>{mode === "control" ? "Hand back" : "Take control"}</button><button className="btn btn--secondary" disabled={mode === "control"} onClick={() => setFit(!fit)}>{fit ? "Full size" : "Fit to panel"}</button><span className="quiet">{mode === "watch" ? "You are watching. Your keys stay here." : "Your mouse and keys now go to this computer."}</span></div><ComputerScreen bot={bot} mode={mode} fit={fit} onMode={change} />
  </div></Modal>;
}
