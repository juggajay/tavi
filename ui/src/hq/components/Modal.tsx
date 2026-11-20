// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
const windows: HTMLElement[] = [];
function holdBackground(held: boolean) {
  const root = document.querySelector<HTMLElement>(".app")!;
  for (const part of root.children) {
    if (!part.classList.contains("sidebar")) { (part as HTMLElement).inert = held; continue; }
    for (const section of part.children) {
      if (section.classList.contains("sidebar__titlebar")) {
        for (const control of section.children) if (!control.classList.contains("safety-anchor")) (control as HTMLElement).inert = held;
      } else (section as HTMLElement).inert = held;
    }
  }
}
export function Modal({ onClose, label, children, wide = false }: { onClose: () => void; label: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    // Leave the safety switch reachable while a window is open.
    holdBackground(true);
    const previousWindow = windows.at(-1); if (previousWindow) previousWindow.inert = true;
    const currentWindow = ref.current!; windows.push(currentWindow);
    ref.current?.querySelector<HTMLElement>("input, textarea, button, select")?.focus();
    const key = (e: KeyboardEvent) => {
      if (windows.at(-1) !== currentWindow) return;
      if (e.key === "Escape") {
        if (document.querySelector(".safety-popover") && label !== "Switch back on") return;
        e.preventDefault(); e.stopImmediatePropagation(); close.current();
      }
      if (e.key === "Tab") {
        const controls = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';
        const all = [...ref.current!.querySelectorAll<HTMLElement>(controls), ...document.querySelectorAll<HTMLElement>(".safety-anchor :is(" + controls + ")")].filter(el => el.getClientRects().length && !el.closest("[inert]"));
        const first = all[0], last = all.at(-1);
        const index = all.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        (e.shiftKey ? all[(index - 1 + all.length) % all.length] ?? last : all[(index + 1) % all.length] ?? first)?.focus();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => { windows.splice(windows.indexOf(currentWindow), 1); const parent = windows.at(-1); if (parent) parent.inert = false; holdBackground(windows.length > 0); document.removeEventListener("keydown", key, true); (before?.isConnected && before !== document.body ? before : document.querySelector<HTMLElement>(".chat__pill, .more-trigger"))?.focus(); };
  }, []);
  return createPortal(<div className="modal-root"><div className="modal-scrim" onClick={onClose} /><div ref={ref} className={`modal hq-modal${wide ? " hq-modal--wide" : ""}`} role="dialog" aria-modal="true" aria-label={label}><header><h2>{label}</h2><button className="icon-btn" onClick={onClose} aria-label="Close window"><Icon name="close" /></button></header>{children}</div></div>, document.body);
}
