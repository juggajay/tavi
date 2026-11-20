import type { Page, Place } from "./shape.js";

export const PAGE_CSS = `
.page>.scroll.page-surface{padding:0;touch-action:pan-x pan-y}.item-content:has(.page-surface){padding:0}.tavi-page .pg-status:empty{display:none}.tavi-page .pg-table-hint{display:none}.tavi-page td,.tavi-page th{white-space:normal}
.tavi-page{--pg-bg:#fff;--pg-text:#222d33;--pg-muted:#63717b;--pg-line:#e1e7e9;--pg-wash:#f4f7f7;--pg-accent:#236c64;color-scheme:light;background:var(--pg-bg);color:var(--pg-text);font:15px/1.55 system-ui,sans-serif;max-width:1140px;margin:auto;padding:40px;box-sizing:border-box;min-height:100%;text-align:left}
[data-theme=dark] .tavi-page,.dark .tavi-page{--pg-bg:#181d21;--pg-text:#e7edef;--pg-muted:#a2afb7;--pg-line:#354047;--pg-wash:#222a30;--pg-accent:#9ed2c4;color-scheme:dark}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]) .tavi-page{--pg-bg:#181d21;--pg-text:#e7edef;--pg-muted:#a2afb7;--pg-line:#354047;--pg-wash:#222a30;--pg-accent:#9ed2c4;color-scheme:dark}}
.tavi-page *{box-sizing:border-box}.tavi-page.pg-searching .pg-block:not(.pg-entries){display:none}.tavi-page h1{font-size:32px;line-height:1.18;letter-spacing:-1px;margin:8px 0 14px;font-weight:650}.tavi-page h2{font-size:21px;line-height:1.3;letter-spacing:-.35px;margin:0}.tavi-page p{white-space:pre-wrap;margin:10px 0}.tavi-page .pg-eyebrow{text-transform:uppercase;letter-spacing:1.8px;font-size:10px;font-weight:700;color:var(--pg-accent)}.tavi-page .pg-summary{font-size:16px;max-width:700px;color:var(--pg-muted)}.tavi-page .pg-source{font-size:11px;color:var(--pg-muted);overflow-wrap:anywhere}.tavi-page .pg-tools{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0}.tavi-page button,.tavi-page input,.tavi-page select{font:inherit;color:inherit;background:var(--pg-bg);border:1px solid var(--pg-line);border-radius:8px;min-height:40px;padding:8px 12px}.tavi-page button,.tavi-page a{cursor:pointer}.tavi-page button:hover{border-color:var(--pg-accent);background:var(--pg-wash)}.tavi-page button:focus-visible,.tavi-page input:focus,.tavi-page select:focus{outline:2px solid var(--pg-accent);outline-offset:2px}.tavi-page a{color:var(--pg-accent);text-underline-offset:3px}.tavi-page .pg-search{display:block;width:100%;font-size:15px;padding:12px 14px;min-height:46px;background:var(--pg-wash)}.tavi-page .pg-filters{display:flex;flex-wrap:wrap;align-items:end;gap:12px;margin:12px 0}.tavi-page label{font-size:11px;display:grid;gap:4px;color:var(--pg-muted)}.tavi-page select{font-size:13px;max-width:220px;min-width:110px}.tavi-page .pg-count{font-size:12px;color:var(--pg-muted);margin:14px 0 20px}.tavi-page .pg-block{margin-top:26px}.tavi-page .pg-block-head{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:14px}.tavi-page .pg-switch{display:flex;gap:4px;flex:none}.tavi-page .pg-switch button{font-size:12px;min-height:34px;padding:5px 10px}.tavi-page button[aria-pressed=true]{background:var(--pg-wash);color:var(--pg-accent);border-color:var(--pg-accent)}.tavi-page .pg-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:18px}.tavi-page .pg-card{border:1px solid var(--pg-line);border-radius:12px;overflow:hidden;min-width:0;background:var(--pg-bg)}.tavi-page .pg-card-body{padding:17px}.tavi-page h3{font-size:17px;margin:0 0 5px;line-height:1.35}.tavi-page .pg-subtitle{font-size:13px;color:var(--pg-muted);margin:4px 0 12px}.tavi-page .pg-picture{margin:0}.tavi-page .pg-picture img{display:block;width:100%;max-height:520px;object-fit:cover;background:var(--pg-wash)}.tavi-page .pg-card .pg-picture img{aspect-ratio:16/10;max-height:250px}.tavi-page .pg-missing{display:grid;place-content:center;text-align:center;gap:5px;aspect-ratio:16/10;background:var(--pg-wash);color:var(--pg-muted);padding:20px;font-size:12px}.tavi-page .pg-missing span:first-child{font-size:25px;opacity:.5}.tavi-page figcaption{padding:9px 0;color:var(--pg-muted);font-size:12px}.tavi-page .pg-card .pg-source{padding:0 17px 12px;margin:0}.tavi-page dl{margin:12px 0;display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:12px}.tavi-page dt{color:var(--pg-muted)}.tavi-page dd{margin:0;text-align:right;overflow-wrap:anywhere}.tavi-page .pg-tags{display:flex;gap:5px;flex-wrap:wrap;margin:12px 0}.tavi-page .pg-tag{background:var(--pg-wash);color:var(--pg-muted);border-radius:5px;padding:3px 7px;font-size:10px}.tavi-page .pg-open{display:inline-block;font-size:12px;margin-top:10px}.tavi-page .pg-table-wrap{overflow:auto;border:1px solid var(--pg-line);border-radius:10px}.tavi-page table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.45;white-space:normal}.tavi-page th{text-align:left;background:var(--pg-wash);color:var(--pg-muted);font-size:11px;letter-spacing:.2px;font-weight:600}.tavi-page td,.tavi-page th{padding:12px 15px;border-bottom:1px solid var(--pg-line);vertical-align:top;min-width:85px;max-width:380px;overflow-wrap:anywhere}.tavi-page tr:last-child td{border:0}.tavi-page td:first-child{font-weight:550;min-width:130px}.tavi-page td .pg-open{border:0;padding:0;min-height:24px;text-align:left;color:var(--pg-accent);margin:0;background:transparent}.tavi-page td small{display:block;font-weight:400;color:var(--pg-muted);margin-top:3px}.tavi-page .pg-callout{border:1px solid #d8bc79;border-left:3px solid #bd903a;border-radius:9px;padding:18px 20px;background:color-mix(in srgb,var(--pg-bg) 94%,#deb34c)}.tavi-page .pg-callout h2{font-size:15px}.tavi-page .pg-callout p{font-size:13px;margin-bottom:0}.tavi-page .pg-question{border-color:var(--pg-accent);background:var(--pg-wash)}.tavi-page .pg-more{margin-top:16px;font-size:12px}.tavi-page .pg-empty{padding:28px;text-align:center;color:var(--pg-muted);background:var(--pg-wash);border-radius:8px}.tavi-page .pg-status{font-size:12px;color:var(--pg-muted)}
@media(max-width:600px){.tavi-page{padding:20px 18px}.tavi-page h1{font-size:24px;letter-spacing:-.6px;margin:6px 0 10px}.tavi-page .pg-summary{font-size:14px;margin:8px 0}.tavi-page .pg-cards{grid-template-columns:1fr;gap:16px}.tavi-page .pg-filters{gap:10px;margin:10px 0}.tavi-page .pg-tools{margin:14px 0}.tavi-page .pg-count{margin:10px 0 14px}.tavi-page .pg-block{margin-top:18px}.tavi-page td,.tavi-page th{padding:10px 12px;font-size:12px}.tavi-page .pg-tools button{font-size:12px}.tavi-page .pg-block-head h2{font-size:18px}.tavi-page .pg-table-hint{display:block;color:var(--pg-muted);font-size:10px;margin:0 0 8px}}
`;

/** This same drawing function also travels inside the saved file. Keep it complete in itself. */
export function mountPage(host: HTMLElement, page: Page, options: { offline?: boolean; onOpen?: (id: string, place: Place) => void; onSave?: () => Promise<void>; onShare?: () => Promise<void> } = {}) {
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const safe = (u: string) => /^https?:\/\//i.test(u) ? esc(u) : "";
  const root = document.createElement("article"); root.className = "tavi-page";
  // A table scroll or a control belongs to the page, rather than the phone's page swipe.
  for (const event of ["pointerdown", "touchstart"]) root.addEventListener(event, e => { if ((e.target as Element).closest(".pg-table-wrap,input,select,button,a")) e.stopPropagation(); }, { passive: true });
  host.append(root);
  root.innerHTML = `<header><div class="pg-eyebrow">${options.offline ? "Saved page" : "Your page"}</div><h1>${esc(page.title)}</h1>${page.summary ? `<p class="pg-summary">${esc(page.summary)}</p>` : ""}${page.source ? `<p class="pg-source">${esc(page.source)}</p>` : ""}</header>`;
  if (options.onSave || options.onShare) {
    const tools = document.createElement("div"); tools.className = "pg-tools";
    const status = document.createElement("p"); status.className = "pg-status"; status.setAttribute("role", "status");
    for (const [label, action] of [["Save as a file", options.onSave], ["Share", options.onShare]] as const) if (action) {
      const b = document.createElement("button"); b.textContent = label;
      b.onclick = async () => { b.disabled = true; status.textContent = ""; try { await action(); status.textContent = label === "Share" ? "Ready to share." : "Saved as a page file you can search."; } catch (e) { status.textContent = e instanceof Error ? e.message : "That didn't finish. Please try again."; } finally { b.disabled = false; } };
      tools.append(b);
    }
    root.append(tools, status);
  }
  type Entry = Extract<Page["blocks"][number], { type: "collection" }>["entries"][number];
  type RecordRow = { bi: number; text: string; facts: Record<string, string[]>; entry: Entry | null; cells: string[] };
  const records: RecordRow[] = page.blocks.flatMap<RecordRow>((b, bi) => b.type === "collection" ? b.entries.map(e => ({ bi, text: [e.title, e.subtitle, ...e.facts.flatMap(f => [f.label, f.value]), ...(e.tags ?? []), e.picture?.alt, e.picture?.source, e.place?.type === "web" ? e.place.url : "", e.place?.type === "sheet" ? e.place.label : ""].join(" ").toLocaleLowerCase(), facts: Object.fromEntries(e.facts.map(f => [f.label, [f.value]]).concat([["Tags", e.tags ?? []]])), entry: e, cells: [] as string[] })) : b.type === "table" ? b.rows.map(cells => ({ bi, text: cells.join(" ").toLocaleLowerCase(), facts: Object.fromEntries(b.columns.map((c, i) => [c, [cells[i]]])), entry: null, cells })) : []);
  let query = "";
  const chosen: Record<string, string> = {};
  const choices = new Map<string, Set<string>>();
  page.blocks.forEach((b, bi) => { if (b.type === "collection" || b.type === "table") for (const f of b.filters ?? []) { if (!choices.has(f)) choices.set(f, new Set()); for (const r of records) if (r.bi === bi) for (const value of r.facts[f] ?? []) if (value) choices.get(f)!.add(value); } });
  const count = document.createElement("p"); count.className = "pg-count"; count.setAttribute("role", "status");
  const areas: { bi: number; host: HTMLElement; view: string; limit: number; draw: () => void }[] = [];
  const matches = (r: typeof records[number]) => query.split(/\s+/).every(w => r.text.includes(w)) && Object.entries(chosen).every(([f, value]) => !value || r.facts[f]?.includes(value));
  const refresh = () => { const n = records.filter(matches).length; count.textContent = `${n.toLocaleString()} of ${records.length.toLocaleString()} ${records.length === 1 ? "entry" : "entries"}`; for (const a of areas) { a.limit = 60; a.draw(); } root.classList.toggle("pg-searching", !!query || Object.values(chosen).some(Boolean)); };
  if (page.blocks.some(b => b.type === "collection" || b.type === "table")) {
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "Search this page"; search.setAttribute("aria-label", "Search this page"); search.className = "pg-search";
    search.oninput = () => { query = search.value.trim().toLocaleLowerCase(); refresh(); };
    const filters = document.createElement("div"); filters.className = "pg-filters";
    for (const [f, values] of choices) {
      const label = document.createElement("label"); label.textContent = f;
      const select = document.createElement("select"); select.setAttribute("aria-label", f); select.innerHTML = `<option value="">Any ${esc(f.toLowerCase())}</option>` + [...values].sort().map(v => `<option>${esc(v)}</option>`).join("");
      select.onchange = () => { chosen[f] = select.value; refresh(); }; label.append(select); filters.append(label);
    }
    root.append(search, filters, count);
  }
  const picture = (p: NonNullable<Extract<Page["blocks"][number], { type: "picture" }>["picture"]>) => { const data = p.asset ? page.pictures?.[p.asset] : p.data; return `<figure class="pg-picture">${data && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(data) ? `<img src="${data}" alt="${esc(p.alt)}" loading="lazy">` : `<div class="pg-missing" role="img" aria-label="${esc(p.alt)}"><span aria-hidden="true">▧</span><span>Picture unavailable</span></div>`}</figure>`; };
  const place = (id: string, p: Place | undefined, title: string) => {
    if (!p) return "";
    if (options.offline) return `${esc(title.replace(/^Open /, ""))}<small class="pg-source">${p.type === "sheet" ? `Sheet ${esc(p.sheet_name ?? p.sheet_id)} · ${esc(p.label)}` : p.type === "item" ? "Notes available in Tavi" : esc(p.url.replace(/^https?:\/\//, ""))}</small>`;
    if (p.type === "web") return `<a class="pg-open" href="${safe(p.url)}" target="_blank" rel="noopener noreferrer">${esc(title)} ↗</a>`;
    return `<button class="pg-open" data-entry="${esc(id)}">${esc(title)} →</button>`;
  };
  for (const [bi, b] of page.blocks.entries()) {
    const section = document.createElement("section"); section.className = "pg-block"; root.append(section);
    if (b.type === "heading") section.innerHTML = `<h2>${esc(b.text)}</h2>`;
    if (b.type === "paragraph") section.innerHTML = `<p>${b.parts.map(p => { const t = p.bold ? `<strong>${esc(p.text)}</strong>` : esc(p.text); return p.url && !options.offline ? `<a href="${safe(p.url)}" target="_blank" rel="noopener noreferrer">${t}</a>` : t; }).join("")}</p>`;
    if (b.type === "picture") section.innerHTML = picture(b.picture) + (b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : "") + `<p class="pg-source">Picture: ${esc(b.picture.source)}</p>`;
    if (b.type === "callout") section.innerHTML = `<aside class="pg-callout ${b.tone === "question" ? "pg-question" : ""}"><h2>${esc(b.title)}</h2><p>${esc(b.text)}</p></aside>`;
    if (b.type !== "collection" && b.type !== "table") continue;
    section.classList.add("pg-entries");
    const head = document.createElement("div"); head.className = "pg-block-head"; head.innerHTML = `<h2>${esc(b.title ?? (b.type === "collection" ? "The collection" : "Details"))}</h2>`;
    const content = document.createElement("div"); section.append(head, content);
    const own = records.filter(r => r.bi === bi);
    const area = { bi, host: content, view: b.type === "collection" ? b.view : "table", limit: 60, draw: () => {} };
    area.draw = () => {
      const all = own.filter(matches), visible = all.slice(0, area.limit);
      if (!all.length) { content.innerHTML = '<p class="pg-empty">No matches. Try another word or choose a different filter.</p>'; return; }
      if (b.type === "collection" && area.view === "cards") content.innerHTML = `<div class="pg-cards">${visible.map(r => { const e = r.entry!; return `<article class="pg-card">${e.picture ? picture(e.picture) : ""}<div class="pg-card-body"><h3>${esc(e.title)}</h3>${e.subtitle ? `<p class="pg-subtitle">${esc(e.subtitle)}</p>` : ""}<dl>${e.facts.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join("")}</dl>${e.tags?.length ? `<div class="pg-tags">${e.tags.map(t => `<span class="pg-tag">${esc(t)}</span>`).join("")}</div>` : ""}${place(e.id, e.place, "Open " + e.title)}</div>${e.picture ? `<p class="pg-source">Picture: ${esc(e.picture.source)}</p>` : ""}</article>`; }).join("")}</div>`;
      else {
        const columns = b.type === "table" ? b.columns : ["Name", ...[...new Set(b.entries.flatMap(e => e.facts.map(f => f.label)))].slice(0, 12), ...(b.entries.some(e => e.tags?.length) ? ["Tags"] : [])];
        content.innerHTML = `<p class="pg-table-hint">Swipe across to see every column</p><div class="pg-table-wrap" tabindex="0" aria-label="Scrollable table"><table><thead><tr>${columns.map(c => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>${visible.map(r => `<tr>${(r.entry ? columns.map((c, ci) => ci === 0 ? (r.entry!.place ? place(r.entry!.id, r.entry!.place, r.entry!.title) : esc(r.entry!.title)) + (r.entry!.subtitle ? `<small>${esc(r.entry!.subtitle)}</small>` : "") : c === "Tags" ? esc(r.entry!.tags?.join(", ")) : esc(r.entry!.facts.find(f => f.label === c)?.value ?? "—")) : r.cells.map(esc)).map(v => `<td>${v}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      }
      if (all.length > area.limit) {
        const more = document.createElement("button"); more.className = "pg-more"; more.textContent = `Show ${Math.min(60, all.length - area.limit)} more (${all.length - area.limit} left)`; more.onclick = () => { area.limit += 60; area.draw(); }; content.append(more);
      }
    };
    if (b.type === "collection") {
      const toggle = document.createElement("div"); toggle.className = "pg-switch"; toggle.setAttribute("aria-label", "Collection view");
      for (const v of ["cards", "table"] as const) { const button = document.createElement("button"); button.textContent = v === "cards" ? "Cards" : "Table"; button.setAttribute("aria-pressed", String(area.view === v)); button.onclick = () => { area.view = v; for (const btn of toggle.querySelectorAll("button")) btn.setAttribute("aria-pressed", String(btn === button)); area.draw(); }; toggle.append(button); } head.append(toggle);
    }
    areas.push(area);
  }
  root.onclick = event => { const button = (event.target as Element).closest<HTMLElement>("[data-entry]"); if (!button) return; const e = records.find(r => r.entry?.id === button.dataset.entry)?.entry; if (e?.place) options.onOpen?.(e.id, e.place); };
  root.addEventListener("error", event => { const img = event.target; if (img instanceof HTMLImageElement) { const missing = document.createElement("div"); missing.className = "pg-missing"; missing.textContent = "Picture unavailable"; img.replaceWith(missing); } }, true);
  refresh();
  return () => root.remove();
}
