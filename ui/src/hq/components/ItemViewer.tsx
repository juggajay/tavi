import { pageView, updatePageView } from "../../shared/items/page";
import { useEffect, useRef, useState } from "react";
import type { Item, SheetPayload } from "../../../../src/shared/protocol";
import { SheetViewer, type Zoomable } from "../../shared/sheet-viewer/viewer";
import { SketchView } from "../../shared/items/sketch";
import { modelView, type ModelView } from "../../shared/items/model";
import { refViewer } from "../../shared/items/describe";
import { fixtureMode, drawingUrl, fixtureItems } from "../dev/fixtures";
import { set, sendSocket, reportError, useStore } from "../store";
import { oldRequest } from "../lib/api";
import { safeLink } from "./Markdown";
import { ApprovalCard } from "./cards/Cards";
import { Icon } from "./Icon";
import "../../shared/sheet-viewer/viewer.css";
type Preview = Parameters<import("../../desktop/files").FilesNav["preview"]>[0];
export function ItemViewer({ item, preview }: { item: Item | null; preview?: Preview | null }) {
  const host = useRef<HTMLDivElement>(null), pane = useRef<HTMLElement>(null), viewer = useRef<Zoomable | null>(null);
  const saved = useStore(s => s.pinnedPlace);
  const place = saved?.item === item?.id ? saved : null;
  const [sheet, changeSheet] = useState(item?.kind === "shopdrawing" ? place?.sheet ?? item.payload.open_at ?? item.payload.sheet ?? 1 : 1);
  const [zoom, setZoom] = useState(100);
  useEffect(() => {
    const parent = host.current;
    if (!parent || !item) return;
    const el = document.createElement("div"); el.className = "viewer-canvas"; parent.appendChild(el);
    let view: Zoomable | null = null;
    const onView = () => {
      setZoom(view?.zoomPct ?? 100);
      if (view && !fixtureMode && useStore.getState().connected) {
        sendSocket({ type: "screen", item_id: item.id, view: view.getView(), stack_depth: 0, page_index: sheet - 1, page_count: item.kind === "shopdrawing" ? item.payload.sheets.length : 1 });
      }
    };
    let payload: SheetPayload | null = null, base: string | undefined;
    if (item.kind === "sheet") payload = item.payload;
    if (item.kind === "reference") ({ sheet: payload, base } = refViewer(item));
    if (item.kind === "shopdrawing") {
      const p = item.payload, page = p.sheets[sheet - 1];
      payload = { sheet_id: `${p.drawing_id}-${p.rev}-${sheet}`, sheet_no: p.number, title: page?.title ?? item.title, revision: p.rev, status: p.status, project: p.project, aspect: page?.aspect ?? 420 / 297, marks: [], view: [0, 0, 1, 1] };
      base = `/api/shopdrawings/${encodeURIComponent(p.drawing_id)}/${encodeURIComponent(p.rev)}/${sheet}`;
    }
    if (payload) {
      const mounted = new SheetViewer(el, payload, { minSpan: 900, ...(base ? { base, bands: item.kind === "reference" } : {}), ...(fixtureMode ? { base: `${drawingUrl}#` } : {}), onView });
      mounted.setMarks(payload.marks); mounted.show({ view: payload.view }, false); view = mounted;
    }
    if (item.kind === "sketch") view = new SketchView(el, item.payload, { onView });
    if (item.kind === "model") view = modelView(el, item.id, item.payload, { title: item.title, ...(place?.camera ? { camera: place.camera } : {}), onView });
    if (view && place?.view && item.kind !== "model") view.setView(place.view);
    viewer.current = view;
    onView();
    return () => { if (view && place) place.save(view.getView(), item.kind === "model" ? (view as ModelView).camera() ?? null : null, sheet); view?.destroy(); viewer.current = null; el.remove(); };
  }, [item, sheet]);
  const zoomable = !!item && ["sheet", "reference", "shopdrawing", "sketch", "model"].includes(item.kind);
  const close = () => { set({ viewer: null }); document.dispatchEvent(new CustomEvent("lh-preview-closed")); };
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const fallback = document.querySelector<HTMLElement>(".more-trigger");
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".modal-root, .safety-popover, .team-menu")) { e.preventDefault(); close(); } };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); (before?.isConnected ? before : fallback)?.focus(); };
  }, []);
  return <aside ref={pane} className="item-viewer" aria-label="Item viewer"><header><span><b title={item?.title ?? preview?.entry.name}>{item?.title ?? preview?.entry.name ?? "File"}</b><small title={item?.source ?? preview?.entry.kind}>{item?.source ?? preview?.entry.kind}</small></span><div className="button-row">{zoomable && <><button className="icon-btn" aria-label="Zoom out" onClick={() => viewer.current?.zoomBy(1 / 1.6)}><Icon name="zoom_out" /></button><button className="link-btn" aria-label="Whole sheet" onClick={() => viewer.current?.zoomOut()}>{zoom}%</button><button className="icon-btn" aria-label="Zoom in" onClick={() => viewer.current?.zoomBy(1.6)}><Icon name="zoom_in" /></button></>}<button className="icon-btn" aria-label="Full screen" onClick={() => void pane.current?.requestFullscreen().catch(() => reportError(new Error("Full screen isn't available here.")))}><Icon name="full" /></button><button className="icon-btn" aria-label="Close viewer" onClick={close}><Icon name="close" /></button></div></header>
    {zoomable ? <div ref={host} className="item-viewer-host sv-host" /> : <div className="item-content">{item ? <ItemContent item={item} /> : preview?.plain && <><h2>{preview.plain.badge}</h2><p>{preview.plain.what}</p><ul>{preview.plain.lines.map(line => <li key={line}>{line}</li>)}</ul></>}</div>}
    {item?.kind === "shopdrawing" && <footer className="button-row"><button className="btn btn--secondary btn--sm" disabled={sheet <= 1} aria-label="Previous sheet" onClick={() => changeSheet(sheet - 1)}>Previous</button><span>Sheet {sheet} of {item.payload.sheets.length}</span><button className="btn btn--secondary btn--sm" disabled={sheet >= item.payload.sheets.length} aria-label="Next sheet" onClick={() => changeSheet(sheet + 1)}>Next</button>{[ [item.payload.pdf, "PDF"], [item.payload.dxf, "DXF"] ].map(([href, label]) => <a key={label} href={safeLink(href)} download>{label}</a>)}</footer>}
    {preview?.pages && preview.turn && <footer className="button-row"><button className="btn btn--secondary btn--sm" disabled={preview.pages.n <= 1} onClick={() => preview.turn?.({ n: preview.pages!.n - 2 })}>Previous {preview.pages.unit}</button><span>{preview.pages.n} of {preview.pages.total}</span><button className="btn btn--secondary btn--sm" disabled={preview.pages.n >= preview.pages.total} onClick={() => preview.turn?.({ n: preview.pages!.n })}>Next {preview.pages.unit}</button></footer>}
    {preview?.actions && <MountedElement element={preview.actions} />}
  </aside>;
}
function MountedElement({ element }: { element: HTMLElement }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { host.current?.appendChild(element); return () => element.remove(); }, [element]);
  return <div className="file-actions legacy-desktop" ref={host} />;
}
function SafeImage({ src, alt }: { src: string; alt: string }) {
  const allowed = src.startsWith("/api/") || (fixtureMode && src.startsWith("data:image/"));
  return allowed ? <img className="item-image" src={src} alt={alt} /> : <p>{alt || "Picture unavailable"}</p>;
}
function PageContent({ item }: { item: Extract<Item, { kind: "page" }> }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { if (host.current) return pageView(host.current, item, id => { void oldRequest<{ item: Item }>(`/api/items/${encodeURIComponent(item.id)}/rows/${encodeURIComponent(id)}/open`, { method: "POST" }).then(result => set({ viewer: result.item })).catch(reportError); }); }, [item.id]);
  useEffect(() => { if (host.current) updatePageView(host.current, item); }, [item]);
  return <div ref={host} />;
}
function ItemContent({ item }: { item: Item }) {
  switch (item.kind) {
    case "page": return <PageContent item={item} />;
    case "list": return <><p>{item.payload.sub}</p><ul className="item-list">{item.payload.rows.map(row => <li key={row.id}>{row.target ? <button onClick={() => { if (fixtureMode) { const found = fixtureItems.find(candidate => row.target?.type === "item" && candidate.id === row.target.item_id); if (found) set({ viewer: found }); } else void oldRequest<{ item: Item }>(`/api/items/${encodeURIComponent(item.id)}/rows/${encodeURIComponent(row.id)}/open`, { method: "POST" }).then(result => set({ viewer: result.item })).catch(reportError); }}>{row.cells.join(" · ")} <Icon name="chev_right" /></button> : row.url ? <a href={safeLink(row.url)} target="_blank" rel="noopener noreferrer">{row.cells.join(" · ")}</a> : row.cells.join(" · ")}</li>)}</ul></>;
    case "table": return <><div className="md-table"><table><thead><tr>{item.payload.columns.map((column, i) => <th key={i}>{column}</th>)}</tr></thead><tbody>{item.payload.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td className={item.payload.highlight?.some(mark => mark.row === i && mark.col === j) ? "highlight" : ""} key={j}>{cell}</td>)}</tr>)}</tbody></table></div><p>{item.payload.note}</p></>;
    case "note": return <><dl>{item.payload.rows.map((row, i) => <div key={i}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl><p className="preserve-lines">{item.payload.text}</p></>;
    case "legacy": return <>{item.payload.images.map((image, i) => <SafeImage key={i} src={image.src} alt={image.caption ?? item.title} />)}<dl>{item.payload.rows.map((row, i) => <div key={i}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></>;
    case "image": return <SafeImage src={item.payload.src} alt={item.payload.alt} />;
    case "doc": return <><p className="quiet">{item.payload.part_label}</p><div className="preserve-lines">{item.payload.text}</div>{item.payload.more && <p className="quiet">There's more in this file. Ask for the next part.</p>}</>;
    case "draft": return <ApprovalCard card={{ kind: "card", card: "approval", ref: item.payload.approval_id, title: item.title, state: item.payload.status === "pending" ? "waiting" : item.payload.status === "sent" || item.payload.status === "done" ? "approved" : "declined" }} />;
    default: return <p>This item needs a newer version of the app.</p>;
  }
}
