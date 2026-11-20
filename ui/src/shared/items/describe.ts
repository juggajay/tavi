// What phone and desktop both need to say about an item: its caption, a short line, its icon, and the HTML-safe text
// helpers. No DOM, no framework.
import type { DraftPayload, Item, ReferencePayload, SheetPayload } from "../../../../src/shared/protocol";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const ICONS = {
  chev: '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  pin: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.6 1.6 14.4 5.4 12.9 6.1 10.7 8.3 10.9 11.4 9.8 12.5 7 9.7 3.2 13.5 2.5 12.8 6.3 9 3.5 6.2 4.6 5.1 7.7 5.3 9.9 3.1z"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 11h7v8.5M10.5 4.5V8M14 11h6.5M14 11v3"/></svg>',
  table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9h17M3.5 13.5h17M9 4.5v15"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" /></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.4"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 20 4l-6 16-3-7z"/></svg>',
  ext: '<svg class="ext" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5h6v6M12.5 3.5 4 12"/></svg>',
  tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
};

/** A web address as people read it: "pellegrino2000.com.au". */
export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A row of a web-results list (places, businesses, pages): the name, a line about it, short facts, and the site it opens. */
export function linkRow(r: { cells: string[]; url?: string }) {
  const [name, desc, ...facts] = r.cells;
  const safe = r.url && /^https?:\/\//i.test(r.url) ? r.url : null;
  const inner =
    `<span class="lk-t"><b>${esc(name)}</b>${desc ? `<span class="lk-d">${esc(desc)}</span>` : ""}` +
    `${facts.length ? `<span class="lk-m">${esc(facts.join(" · "))}</span>` : ""}${safe ? `<span class="lk-u">${esc(hostOf(safe))}</span>` : ""}</span>${safe ? ICONS.ext : ""}`;
  return safe ? `<a class="lk" href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<div class="lk">${inner}</div>`;
}

/** Icon for an item kind, or for the label "Shown today" rows carry. */
export function iconFor(kindOrLabel: string, operation?: string) {
  const k = kindOrLabel.toLowerCase();
  if (k === "sheet" || k === "drawing" || k === "sketch" || k === "model" || k === "3d model") return ICONS.plan;
  if (k === "table" || k === "reference") return ICONS.table;
  if (k === "draft") return operation && !operation.startsWith("email") ? ICONS.cal : ICONS.mail;
  if (k === "list") return ICONS.list;
  return ICONS.list;
}

export const isPending = (it: Item) => it.kind === "draft" && it.payload.status === "pending";

export const DRAFT_CHIP: Record<DraftPayload["status"], { text: string; cls: string }> = {
  pending: { text: "Waiting for your OK", cls: "" },
  sent: { text: "Sent", cls: "ok" },
  done: { text: "Done", cls: "ok" },
  declined: { text: "Not sent", cls: "off" },
  expired: { text: "Expired", cls: "off" },
  failed: { text: "Didn't go through", cls: "bad" },
};

/** The button that approves it: Send for email, Send request for a calendar change, Go ahead for anything else. */
export function sendLabel(p: DraftPayload) {
  if (p.operation === "email.send") return "Send";
  if (/calendar/i.test(p.summary + p.details.map((d) => d.label).join(" ")) || /calendar/i.test(p.account)) return "Send request";
  return "Go ahead";
}

/** One line under a title: a sheet's number and revision, a list's source, a draft's state. */
export function metaOf(it: Item) {
  switch (it.kind) {
    case "sheet":
      return `${it.payload.sheet_no ?? ""} · Rev ${it.payload.revision ?? "?"}`;
    case "draft":
      return it.payload.status === "pending" ? "Needs your OK" : DRAFT_CHIP[it.payload.status].text;
    default:
      return it.source;
  }
}

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).replace(/\s?([ap])\.?m\.?/i, " $1m");

/** A reference book page (Stage 8.2) as the sheet viewer takes it: the same zoom, tiles and rings, from the book's own routes. */
export function refViewer(it: { title: string; source: string; payload: ReferencePayload }): { sheet: SheetPayload; base: string } {
  const p = it.payload;
  return {
    sheet: { sheet_id: `${p.book_id}-${p.page}`, sheet_no: it.source, title: it.title, revision: null, status: "current", project: "", aspect: p.aspect, marks: p.marks, view: p.view },
    base: `/api/reference/${encodeURIComponent(p.book_id)}/${p.page}`,
  };
}
