import type { Item } from "../../../../src/shared/protocol";
import { mountPage, PAGE_CSS } from "../../../../src/shared/pages/render";
const views = new WeakMap<HTMLElement, ReturnType<typeof mountPage>>();
export function updatePageView(host: HTMLElement, item: Extract<Item, { kind: "page" }>) { views.get(host)?.update(item.payload); }

/** A phone record keeps receiving pictures while its page stays in place. */
export function phonePageView(host: HTMLElement, rec: { item: Item }, onRow: (item: Item, id: string) => void) {
  if (rec.item.kind !== "page") return;
  let current: Item = rec.item;
  const close = pageView(host, rec.item, id => onRow(current, id));
  Object.defineProperty(rec, "item", { configurable: true, get: () => current, set: (next: Item) => { current = next; if (next.kind === "page") close.update(next.payload); } });
  const observer = new MutationObserver(() => { if (!host.isConnected) { close(); observer.disconnect(); } });
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Both apps use the same page, including its saved-file and sharing buttons. */
export function pageView(host: HTMLElement, item: Extract<Item, { kind: "page" }>, onOpen: (id: string) => void) {
  host.classList.add("page-surface");
  const style = document.createElement("style"); style.textContent = PAGE_CSS; host.append(style);
  const save = async () => {
    const response = await fetch(`/api/items/${encodeURIComponent(item.id)}/page-file`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "The page couldn't be saved. Please try again when connected.");
    if (!/^\/api\/items\/itm_\w{1,40}\/page-file\?file=doc_[a-f0-9]{16}$/.test(result.download)) throw new Error("The saved file isn't available yet.");
    return result as { download: string; name: string };
  };
  const remove = mountPage(host, item.payload, {
    pageKey: item.id,
    onOpen: id => onOpen(id),
    onSave: async () => { const file = await save(); const link = document.createElement("a"); link.href = file.download; link.download = file.name; link.click(); },
    ...(typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([""], "page.html", { type: "text/html" })] }) ? { onShare: async () => {
      const saved = await save(); const response = await fetch(saved.download); if (!response.ok) throw new Error("The saved file couldn't be opened.");
      const file = new File([await response.blob()], saved.name, { type: "text/html" });
      if (!navigator.canShare({ files: [file] })) throw new Error("This device can't share this file here. Choose Save as a file instead.");
      await navigator.share({ title: item.title, files: [file] });
    } } : {}),
  });
  views.set(host, remove);
  const close = () => { remove(); views.delete(host); style.remove(); host.classList.remove("page-surface"); };
  close.update = remove.update;
  return close;
}
