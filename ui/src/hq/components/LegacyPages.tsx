import { useEffect, useRef, useState } from "react";
import { useStore, set, reportError } from "../store";
import { oldRequest } from "../lib/api";
import type { Item, Pin } from "../../../../src/shared/protocol";
import type { FilesNav } from "../../desktop/files";
import { fixtureMode, fixtureItems, drawingUrl } from "../dev/fixtures";
import { legacySettings } from "../dev/legacy";
import { createPins } from "../../phone/pins";
import { Markdown } from "./Markdown";
import { TeamSettings } from "./TeamSettings";
import changelog from "../../../../docs/v3/CHANGELOG.md?raw";
type Preview = Parameters<FilesNav["preview"]>[0];
const pageFor: Record<string, "files" | "memory" | "activity"> = { files: "files", brain: "memory" };
export function LegacyPages({ preview }: { preview: (value: Preview | null) => void }) {
  const page = useStore(s => s.page), selected = useStore(s => s.selected);
  const [started, setStarted] = useState(false);
  const files = useRef<HTMLDivElement>(null), memory = useRef<HTMLDivElement>(null), activity = useRef<HTMLDivElement>(null);
  const elements = { files, memory, activity };
  const panes = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (!pageFor[page]) return;
    let cancelled = false;
    const go = (name: string) => set({ page: ({ memory: "brain", activity: "new", conversation: "chat" } as Record<string, string>)[name] ?? name });
    const nav: FilesNav = { openItem: item => { set({ viewer: item }); preview(null); }, go, preview, closePreview: () => preview(null), tell: item => { set({ viewer: item, page: "chat" }); }, openBrowser: () => { reportError(new Error("Choose a bot with a computer, then press Open beside its screen.")); } };
    void Promise.all([import("../../desktop/pages"), import("../../desktop/core")]).then(async ([pages, core]) => {
      if (cancelled) return;
      const target = pageFor[page]; core.state.page = target;
      if (fixtureMode) { core.gw.close(); core.state.settings = legacySettings; core.state.name = "Nemi"; }
      if (!started) {
        core.gw.on("hello", message => { core.state.name = message.name; core.state.voiceReady = message.voiceReady; core.applySettings(message.settings, true); });
        core.gw.on("approval", message => core.state.approvals.set(message.approval.id, message.approval));
        core.gw.on("approval_gone", message => core.state.approvals.delete(message.id));
        setStarted(true);
      }
      const host = elements[target].current!;
      const existing = panes.current.get(target);
      if (existing && !host.contains(existing)) host.appendChild(existing);
      if (target === "files" && !panes.current.has(target)) {
        const shell = document.createElement("section"); shell.className = "view fv nopane on"; shell.id = "v-files";
        shell.innerHTML = '<aside class="fv-side" id="fvSide"></aside><div class="fv-main" id="fvMain"><div class="fv-browse" id="fvBrowse"></div><div class="doc fv-manage" id="fvManage" hidden><div class="din" id="files"></div></div></div>';
        host.appendChild(shell); panes.current.set(target, shell);
      }
      await pages.renderPage(target, nav);
    }).catch(() => { if (!cancelled) reportError(new Error("Couldn't open this page. Please try again.")); });
    return () => { cancelled = true; };
  }, [page]);
  return <main className="legacy-desktop legacy-pages" hidden={!Object.hasOwn(pageFor, page) && page !== "pins" && page !== "new" && page !== "settings"} aria-label="Your pages">
    <div ref={files} hidden={page !== "files"} className="legacy-page" />
    <div hidden={page !== "brain"} className="legacy-page"><div className="doc"><div className="din" id="memory" ref={memory} /></div></div>
    <div hidden={page !== "new"} className="legacy-page"><div className="doc"><div className="din"><Markdown text={changelog} /></div></div></div>
    <div hidden={page !== "settings"} className="legacy-page">{page === "settings" && <TeamSettings />}</div>
    <div hidden={page !== "pins"} className="legacy-page"><PinsPage selected={selected} /></div>
  </main>;
}
function PinsPage({ selected }: { selected: string | null }) {
  const row = useRef<HTMLDivElement>(null), pick = useRef<HTMLDivElement>(null), scrim = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null);
  const page = useStore(s => s.page);
  const [empty, setEmpty] = useState(true);
  const manager = useRef<ReturnType<typeof createPins> | null>(null);
  useEffect(() => {
    if (page !== "pins") return;
    let cancelled = false;
    const pins = manager.current ?? createPins({ row: row.current!, pick: pick.current!, pickScrim: scrim.current!, pickBody: body.current!, open(pin) {
      const item = pin.items[pin.idx] ?? pin.items[0];
      if (item) set({ viewer: item, pinnedPlace: { item: item.id, view: pin.view, camera: pin.camera, sheet: pin.sheet, save(view, camera, sheet) {
        if (fixtureMode) return;
        const items = pin.items.map(before => before.id === item.id && before.kind === "shopdrawing" ? { ...before, payload: { ...before.payload, sheet } } : before);
        manager.current?.savePlace(pin.id, { items, idx: pin.idx, view, camera });
      } } });
    }, say: text => reportError(new Error(text)), onChange: () => setEmpty(manager.current?.list.length === 0) });
    manager.current = pins;
    if (fixtureMode) {
      const item = fixtureItems[0];
      pins.set([{ id: "preview-pin", item_ids: [item.id], items: [item], idx: 0, view: { s: 2, cx: .6, cy: .4 }, camera: null, label: "Shape study", pinned_at: new Date().toISOString(), until: null }]);
      row.current?.querySelectorAll<HTMLElement>(".pin-th").forEach(thumb => { thumb.style.backgroundImage = `url("${drawingUrl}")`; });
    } else void oldRequest<{ pins: Pin[] } | Pin[]>("/api/pins").then(result => { if (!cancelled) pins.set(Array.isArray(result) ? result : result.pins); }).catch(() => { if (!cancelled) reportError(new Error("Couldn't load your pins. Try again.")); });
    return () => { cancelled = true; pins.disarm(); };
  }, [page, selected]);
  return <div className="pin-page"><h1>Pins</h1><p>Your drawings and notes, kept close.</p>{empty && <p>No pins yet. Open an item from Files and choose Pin.</p>}<div ref={row} className="pin-row" /><div ref={scrim} className="pin-pick-scrim" /><div ref={pick} className="pin-pick"><div ref={body} /></div></div>;
}
