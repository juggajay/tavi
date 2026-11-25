// Pulled-up pages, one per item kind (DESIGN §4.3–4.8). Markup and classes follow mockups/v2/src/phone.src.html
// renderItem(); the content is the item's own data.
import { SheetViewer, type Delegate, type Zoomable } from "../shared/sheet-viewer/viewer";
import { SketchView } from "../shared/items/sketch";
import { modelView } from "../shared/items/model";
import type { CamState } from "../shared/model3d-viewer/viewer";
import { DRAFT_CHIP, ICONS, esc, iconFor, linkRow, refViewer, sendLabel } from "../shared/items/describe";
import { NEWER_NEEDED } from "../shared/update";
import type { Approval, DraftPayload, Item, SheetPayload } from "../../../src/shared/protocol";

export type PageRec = { item: Item; page: HTMLElement; viewer: Zoomable | null };

export type RenderCtx = {
  delegate: Delegate;
  attachGestures: (page: HTMLElement, scroller: HTMLElement) => void;
  onRow: (list: Item, rowId: string) => void;
  onSend: (rec: PageRec, btn: HTMLButtonElement) => void;
  onNotNow: (rec: PageRec) => void;
  /** The live approval for a draft (it has the nonce), or null when its buttons can't work any more. */
  approvalFor: (approvalId: string) => Approval | null;
  onViewerView: (v: Zoomable) => void;
  /** A model was pulled apart or its sizes turned on or off. */
  onModelState: () => void;
  /** What a drawing or book page says when its picture can't be had: with no reception, that it isn't kept on the phone (13.2). */
  missing?: () => string | undefined;
  /** A kind of item this build can't show (13.4): a newer build has probably gone live. */
  onUnknown?: () => void;
};

const loadPage = () => import("../shared/items/page");
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const isNum = (s: string) => /^[\s$€£]*[-+]?[\d.,]+\s*(mm|m|kg|%|×.*)?$/.test(s) || /^\$/.test(s.trim());

function scrollPage(page: HTMLElement, html: string, ctx: RenderCtx) {
  page.innerHTML = `<div class="scroll">${html}</div>`;
  const sc = page.firstElementChild as HTMLElement;
  ctx.attachGestures(page, sc);
  return sc;
}

/** A set of shop drawings is a page per sheet (Stage 12.6); anything else is one page. */
export const pagesOf = (it: Item): Item[] => {
  if (it.kind === "page") void loadPage().catch(() => {});
  return (it.kind === "shopdrawing" && it.payload.sheet === undefined ? it.payload.sheets.map((_, i) => ({ ...it, payload: { ...it.payload, sheet: i + 1 } })) : [it]);
};

const rowsHtml = (rows: { label: string; value: string }[]) =>
  rows.length ? `<dl class="fields">${rows.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`).join("")}</dl>` : "";

export function renderItem(item: Item, animateIn: boolean, ctx: RenderCtx, camera?: CamState): PageRec {
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.item = item.id;
  const rec: PageRec = { item, page, viewer: null };

  // A drawing sheet, or a reference book page (Stage 8.2): both zoom in the sheet viewer.
  const viewerPage = (sheet: SheetPayload, base?: string) => {
    const host = document.createElement("div");
    host.className = "sv-host";
    page.appendChild(host);
    const offline = ctx.missing?.();
    const v = new SheetViewer(host, sheet, { onDelegate: ctx.delegate, onView: ctx.onViewerView, ...(base ? { base, missing: "I can't open that page right now.", bands: true } : {}), ...(offline ? { missing: offline } : {}) });
    v.setMarks(sheet.marks);
    const whole: [number, number, number, number] = [0, 0, 1, 1];
    const close = sheet.view.some((x, i) => x !== whole[i]);
    // opened by asking: start from the whole sheet and fly in, as the mockup does
    if (close && animateIn && !reduce()) {
      v.show({ view: whole }, false);
      setTimeout(() => v.show({ view: sheet.view }, true), 420);
    } else v.show({ view: sheet.view }, false);
    rec.viewer = v;
  };

  switch (item.kind) {
    case "sheet":
      viewerPage(item.payload);
      break;
    case "reference": {
      const r = refViewer(item);
      viewerPage(r.sheet, r.base);
      break;
    }
    case "shopdrawing": {
      // one sheet of a set of shop drawings (Stage 12.6): the sheet viewer, its pictures and tiles from the drawing's routes
      const p = item.payload;
      const n = p.sheet ?? 1;
      const sheet: SheetPayload = { sheet_id: `${p.drawing_id}-${p.rev}-${n}`, sheet_no: p.number, title: p.sheets[n - 1]?.title ?? item.title, revision: p.rev, status: p.status, project: p.project, aspect: p.sheets[n - 1]?.aspect ?? 420 / 297, marks: [], view: [0, 0, 1, 1] };
      viewerPage(sheet, `/api/shopdrawings/${p.drawing_id}/${p.rev}/${n}`);
      break;
    }
    case "sketch": {
      // a sketch the assistant drew (Stage 8.5): zooms like a sheet; at the whole sketch a drag goes to the page
      const host = document.createElement("div");
      page.appendChild(host);
      rec.viewer = new SketchView(host, item.payload, { onDelegate: ctx.delegate, onView: ctx.onViewerView });
      break;
    }
    case "model": {
      // a 3D model (Stage 9.4): the viewer loads the first time; it takes every gesture on it
      const host = document.createElement("div");
      host.style.cssText = "width:100%;height:100%";
      page.appendChild(host);
      const v = (rec.viewer = modelView(host, item.id, item.payload, { title: item.title, camera, phone: true, onView: () => ctx.onViewerView(v), onState: ctx.onModelState }));
      break;
    }
    case "page": {
      const sc = scrollPage(page, "", ctx);
      void loadPage().then(m => {
        if (sc.isConnected) m.phonePageView(sc, rec, ctx.onRow);
      }).catch(() => { sc.textContent = "Connect once to open this page."; });
      break;
    }
    case "list": {
      const p = item.payload;
      const shownToday = p.heading === "Shown today" && p.rows.every((r) => r.target?.type === "item");
      if (shownToday) {
        const row = (r: (typeof p.rows)[number]) =>
          `<li><button class="row trow" type="button" data-row="${esc(r.id)}"><span class="ico">${iconFor(r.cells[2] ?? "")}</span><span class="main"><b>${esc(r.cells[0])}</b><span>${esc(r.cells[2] ?? "")}</span></span><time>${esc(r.cells[1] === "Kept handy" ? "" : r.cells[1] ?? "")}</time></button></li>`;
        const pins = p.rows.filter((r) => r.cells[1] === "Kept handy");
        const rest = p.rows.filter((r) => r.cells[1] !== "Kept handy");
        scrollPage(
          page,
          `<h2 class="ph">Shown today</h2><p class="ps">${p.rows.length ? "Tap one to bring it back." : "Nothing yet today."}</p>
          ${pins.length ? `<div class="sec">${ICONS.pin}Kept handy</div><ul class="list">${pins.map(row).join("")}</ul>` : ""}
          ${rest.length ? `<div class="sec">Today</div><ul class="list">${rest.map(row).join("")}</ul>` : ""}`,
          ctx,
        );
      } else if (p.rows.some((r) => r.url)) {
        scrollPage(page, `<h2 class="ph">${esc(p.heading)}</h2>${p.sub || item.source ? `<p class="ps">${esc(p.sub ?? item.source)}</p>` : ""}<ul class="lks">${p.rows.map((r) => `<li>${linkRow(r)}</li>`).join("")}</ul>`, ctx);
      } else {
        const row = (r: (typeof p.rows)[number]) => {
          const [first, second, ...more] = r.cells;
          const single = r.cells.length === 1;
          const tag = r.target ? "button" : "div";
          return `<li><${tag} class="row"${r.target ? ` type="button" data-row="${esc(r.id)}"` : ""}${single ? ' style="grid-template-columns:minmax(0,1fr) auto"' : ""}>${single ? "" : `<span class="id">${esc(first)}</span>`}<span class="main"><b>${esc(single ? first : second ?? "")}</b>${more.length ? `<span>${esc(more.join(" · "))}</span>` : ""}</span>${r.target ? ICONS.chev : "<span></span>"}</${tag}></li>`;
        };
        scrollPage(page, `<h2 class="ph">${esc(p.heading)}</h2>${p.sub || item.source ? `<p class="ps">${esc(p.sub ?? item.source)}</p>` : ""}<ul class="list">${p.rows.map(row).join("")}</ul>`, ctx);
      }
      page.addEventListener("click", (e) => {
        const b = (e.target as Element).closest("[data-row]") as HTMLElement | null;
        if (b) ctx.onRow(item, b.dataset.row!);
      });
      break;
    }
    case "table": {
      const p = item.payload;
      const hl = new Set((p.highlight ?? []).map((h) => `${h.row}:${h.col}`));
      scrollPage(
        page,
        `<h2 class="ph">${esc(item.title)}</h2>${item.source ? `<p class="ps">${esc(item.source)}</p>` : ""}
        <div class="tbl-wrap"><table class="tbl"><thead><tr>${p.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${p.rows.map((r, ri) => `<tr>${r.map((c, ci) => `<td class="${ci && isNum(c) ? "n" : ""}${hl.has(`${ri}:${ci}`) ? " hl" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        ${p.note ? `<p class="foot">${esc(p.note)}</p>` : ""}`,
        ctx,
      );
      break;
    }
    case "note": {
      const p = item.payload;
      scrollPage(page, `<h2 class="ph">${esc(item.title)}</h2>${rowsHtml(p.rows)}${p.text ? `<p class="note-text">${esc(p.text)}</p>` : ""}${item.source ? `<p class="src">${esc(item.source)}</p>` : ""}`, ctx);
      break;
    }
    case "image": {
      const p = item.payload;
      scrollPage(page, `<h2 class="ph">${esc(item.title)}</h2><img class="legacy-img" src="${esc(p.src)}" width="${p.w}" height="${p.h}" alt="${esc(p.alt)}">${item.source ? `<p class="src">${esc(item.source)}</p>` : ""}`, ctx);
      break;
    }
    case "legacy": {
      const p = item.payload;
      scrollPage(page, `<h2 class="ph">${esc(item.title)}</h2>${p.images.map((i) => `<img class="legacy-img" src="${esc(i.src)}" alt="${esc(i.caption ?? "")}">`).join("")}${rowsHtml(p.rows)}${item.source ? `<p class="src">${esc(item.source)}</p>` : ""}`, ctx);
      break;
    }
    case "doc": {
      const p = item.payload;
      scrollPage(page, `<h2 class="ph">${esc(p.name)}</h2><p class="ps">${esc(p.part_label)}</p><div class="doc-text">${esc(p.text)}</div>${p.more ? '<p class="foot">There\'s more in this file. Ask for the next part, or open it on the desktop.</p>' : ""}`, ctx);
      break;
    }
    case "draft":
      renderDraft(rec, ctx);
      break;
    default: {
      // Sent by a newer build of the gateway than this app (13.4): never a blank page. The app updates itself when it can.
      const it = item as Item;
      scrollPage(page, `<h2 class="ph">${esc(it.title ?? "")}</h2><p class="ps unknown-kind">${esc(NEWER_NEEDED)}</p>`, ctx);
      ctx.onUnknown?.();
    }
  }
  if (animateIn) page.classList.add("in");
  return rec;
}

/** A write waiting for the owner's OK (DESIGN §4.5, §4.7), or the record of what happened to it. */
export function renderDraft(rec: PageRec, ctx: RenderCtx) {
  const it = rec.item as Extract<Item, { kind: "draft" }>;
  const p = it.payload as DraftPayload;
  const live = p.status === "pending" ? ctx.approvalFor(p.approval_id) : null;
  const chip = live ? DRAFT_CHIP.pending : DRAFT_CHIP[p.status === "pending" ? "expired" : p.status];
  const email = p.operation === "email.send";
  const head = email
    ? `<dl class="fields"><dt>To</dt><dd>${esc(p.to.join(", "))}${p.cc.length ? `<small>Cc ${esc(p.cc.join(", "))}</small>` : ""}</dd><dt>From</dt><dd>${esc(p.account)}</dd><dt>Subject</dt><dd class="subj" ${live ? 'contenteditable="true" spellcheck="true"' : ""}>${esc(p.subject)}</dd></dl>
       <div class="body" ${live ? 'contenteditable="true" spellcheck="true"' : 'contenteditable="false"'}>${esc(p.body)}</div>
       <p class="edit-hint">${live ? "Tap the words to change them." : ""}</p>`
    : `<h2 class="ph">${esc(p.summary)}</h2><p class="ps">Using ${esc(p.account)}</p>${p.image ? `<img class="shot" src="${esc(p.image)}" alt="The page it's about to submit">` : ""}${rowsHtml(p.details)}`;
  rec.page.innerHTML = `<div class="appr"><div class="scroll">
      <div class="need-chip ${chip.cls}"><i></i>${chip.text}</div>
      ${head}
      ${!live && p.outcome_message ? `<p class="outcome">${esc(p.outcome_message)}</p>` : ""}
    </div>
    ${live ? `<div class="act"><button class="btn-send" type="button" data-act="send">${ICONS.send}${sendLabel(p)}</button><button class="btn-quiet" type="button" data-act="later">Not now</button></div>` : ""}</div>`;
  ctx.attachGestures(rec.page, rec.page.querySelector(".scroll") as HTMLElement);
  if (live) {
    rec.page.querySelector<HTMLButtonElement>('[data-act="send"]')!.addEventListener("click", (e) => ctx.onSend(rec, e.currentTarget as HTMLButtonElement));
    rec.page.querySelector('[data-act="later"]')!.addEventListener("click", () => ctx.onNotNow(rec));
  }
}

/** The edited words of an email draft on screen (null when unchanged). */
export function editedEmail(rec: PageRec) {
  if (rec.item.kind !== "draft") return null;
  const p = rec.item.payload;
  const body = (rec.page.querySelector(".body") as HTMLElement | null)?.innerText.replace(/\n$/, "") ?? p.body;
  const subject = (rec.page.querySelector(".subj") as HTMLElement | null)?.innerText.trim() ?? p.subject;
  if (body === p.body && subject === p.subject) return null;
  return { body, subject };
}
