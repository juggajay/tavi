// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useRef, useState } from "react";
import type { TeamBot } from "../../types";
import { useStore } from "../../store";
import { changeComputer, type Computer } from "../../lib/computer";
import { ComputerScreen } from "../ComputerViewer";
import { BotAvatarFor } from "../../avatar/BotAvatar";

export function ScreenCard({ bot, computer, paused, open }: { bot: TeamBot; computer?: Computer; paused: boolean; open: (mode?: "watch" | "control") => void }) {
  const [busy, setBusy] = useState(false);
  const view = useRef<HTMLDivElement>(null);
  const [screenRatio, setScreenRatio] = useState<number | null>(null);
  // Follow the screen itself if its size changes after connecting.
  useEffect(() => {
    const host = view.current;
    if (!host) return;
    const measure = () => {
      const canvas = host.querySelector<HTMLCanvasElement>(".screen-live canvas");
      if (canvas && canvas.width > 0 && canvas.height > 0) setScreenRatio(canvas.width / canvas.height);
    };
    const observer = new MutationObserver(measure);
    observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["width", "height"] });
    measure();
    return () => observer.disconnect();
  }, [bot.id]);
  const ratio = screenRatio ?? (computer?.width && computer?.height ? computer.width / computer.height : 16 / 10);
  const error = computer?.changeError;
  const safety = useStore(s => s.safety.level), guard = useStore(s => s.guard);
  const ready = bot.computer && computer?.state === "ready" && safety === "open" && guard === "up";
  const starting = bot.computer && (!computer || computer.state === "starting");
  const failed = computer?.state === "error";
  const stopped = bot.computer && (safety !== "open" || guard !== "up");
  // The live screen is four times the width of this card. Left to the browser, a shrunken canvas is jagged and its
  // words unreadable, so a second canvas the size of the card is redrawn a few times a second with proper smoothing.
  const sharp = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ready || paused) return;
    const draw = () => {
      const host = view.current, out = sharp.current;
      const source = host?.querySelector<HTMLCanvasElement>(".screen-live canvas");
      if (!host || !out || !source || !source.width || !source.height) return;
      const box = host.getBoundingClientRect(), dots = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
      const width = Math.max(1, Math.round(box.width * dots)), height = Math.max(1, Math.round(box.height * dots));
      if (out.width !== width || out.height !== height) { out.width = width; out.height = height; }
      const paint = out.getContext("2d"); if (!paint) return;
      paint.imageSmoothingEnabled = true; paint.imageSmoothingQuality = "high";
      paint.drawImage(source, 0, 0, width, height);
      out.dataset.drawn = "1";
    };
    const timer = setInterval(draw, 250); draw();
    return () => clearInterval(timer);
  }, [ready, paused, bot.id]);
  const give = async () => {
    setBusy(true);
    try { await changeComputer(bot.id, true); }
    catch { /* The computer keeps the reason visible even if this card opens again. */ }
    finally { setBusy(false); }
  };
  return <section className={`details__screen screen screen--panel${ready ? " is-live" : ""}`} aria-label={`${bot.name}'s screen`}>
    <div className="screen__body"><div ref={view} className="screen__view" style={{ aspectRatio: ratio }}>
      {ready ? <><ComputerScreen bot={bot} active={!paused} /><canvas ref={sharp} className="screen__sharp" aria-hidden="true" /><button className="screen__expand" aria-label={`Open ${bot.name}'s computer`} onClick={() => open("watch")} /><button className="screen__control" onClick={() => open("control")}>Take control</button><span className="screen__badge"><BotAvatarFor bot={bot} size={16} /><span>Live</span><i className="screen__live-dot" /></span></> :
        <div className={`screen__state${starting && !stopped ? " is-waking" : ""}${error || failed ? " has-error" : ""}`} role={error || failed ? "alert" : "status"}>
          {starting && !stopped && <span className="screen__sweep" />}
          <span className={`screen__mascot${starting && !stopped ? " is-bobbing" : bot.computer ? " is-asleep" : ""}`}><BotAvatarFor bot={bot} size={48} /></span>
          <span className="screen__text">{!bot.computer ? "No computer yet" : stopped ? "Computer stopped" : failed ? "Computer needs attention" : starting ? "Setting up its screen…" : "Computer asleep"}</span>
          {(error || (bot.computer && (computer?.why || stopped))) && computer?.why !== "Setting up its screen…" && <span className="screen__sub">{error || (stopped ? "The safety switch is on." : computer?.why)}</span>}
          {(!bot.computer || failed || (!starting && !ready && !stopped)) && <button className="screen__action" disabled={busy} onClick={() => void give()}>{busy ? "Setting up…" : error || failed ? "Try again" : !bot.computer ? `Give ${bot.name} a computer` : "Wake computer"}</button>}
        </div>}
    </div></div>
    {ready && error && <p className="engine__error" role="alert">{error}</p>}
  </section>;
}
