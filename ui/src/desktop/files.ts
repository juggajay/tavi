// The file viewer (Stage 15.1): everything the assistant holds, in plain groups (drawings by job, shop drawings, models,
// sketches, photos, documents, books, guides, things it made, the other computer, uploads), searchable by name, job and
// what's inside, sortable, and fast with thousands (only the rows in view are drawn, a page fetched at a time). Selecting
// one previews it in the right-hand pane with the viewers already built. Nothing here changes a file: "Rename" is a label,
// and there's no delete or move.
import { $, api, esc, IC, toast } from "./core";
import type { Item } from "../../../src/shared/protocol";

export type FilesNav = {
  openItem: (it: Item) => void;
  go: (p: string) => void;
  preview: (pv: PreviewIn) => void;
  closePreview: () => void;
  tell: (it: Item) => void;
  /** the assistant's browser, live (15.2) */
  openBrowser: () => void;
};
type Entry = { id: string; group: string; name: string; own?: string; kind: string; job: string; at: string; size: number | null; viewer: string; pages?: number; sub?: string; file: boolean; hit?: { n: number; where: string } };
type Listing = { groups: { id: string; label: string; count: number }[]; jobs: { job: string; count: number }[]; total: number; sort: string; dir: "asc" | "desc"; entries: Entry[] };
type PreviewIn = {
  entry: Entry;
  item: Item | null;
  pages?: { n: number; total: number; unit: "sheet" | "page" | "part" };
  plain?: { badge: string; what: string; lines: string[] };
  from_model?: string;
  revisions?: { rev: string; date: string; text: string }[];
  rev?: string;
  turn?: (o: { n?: number; rev?: string }) => void;
  actions?: HTMLElement;
};

const ROW = 48;
const PAGE = 200;
const s20 = (inner: string, extra = 'stroke-linecap="round" stroke-linejoin="round"') => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" ${extra}>${inner}</svg>`;
const ICONS: Record<string, string> = {
  "": s20('<rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.3"/><rect x="11" y="3.5" width="5.5" height="5.5" rx="1.3"/><rect x="3.5" y="11" width="5.5" height="5.5" rx="1.3"/><rect x="11" y="11" width="5.5" height="5.5" rx="1.3"/>'),
  drawings: s20('<rect x="3" y="3.5" width="14" height="13" rx="1.5"/><path d="M3 9.5h6v7M9 3.5v3M12 9.5h5M12 9.5V12"/>'),
  shop: s20('<path d="M4 16.5V3.5l13 13z"/><path d="M7 13.5V10l3.5 3.5z"/><path d="M4 7h1.5M4 10h1.5"/>'),
  models: s20('<path d="M10 2.8 16.5 6.5v7L10 17.2 3.5 13.5v-7z"/><path d="M3.5 6.5 10 10.2l6.5-3.7M10 10.2v7"/>'),
  sketches: s20('<path d="M13.6 3.9a1.6 1.6 0 0 1 2.3 2.3L7.4 14.7 4 15.9l1.2-3.4z"/><path d="m12.3 5.2 2.4 2.4"/>'),
  photos: s20('<rect x="3" y="4.5" width="14" height="11" rx="2"/><circle cx="7.5" cy="8.5" r="1.4"/><path d="m3.5 14 4-3.5 3 2.5 2.5-2 3.5 3"/>'),
  documents: s20('<path d="M5.5 2.5h6l4 4v10a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M11.5 2.5v4h4M7.5 10.5h5M7.5 13.5h5"/>'),
  books: s20('<path d="M10 5.5C8.5 4.3 6.3 3.8 3.5 4v11c2.8-.2 5 .3 6.5 1.5 1.5-1.2 3.7-1.7 6.5-1.5V4c-2.8-.2-5 .3-6.5 1.5zM10 5.5v11"/>'),
  guides: s20('<rect x="4.5" y="2.5" width="11" height="15" rx="1.5"/><path d="M7.5 6.5h5M7.5 9.5h5M7.5 12.5h3"/>'),
  made: s20('<path d="M10 3.2l1.5 4.6 4.6 1.5-4.6 1.5L10 15.4l-1.5-4.6L3.9 9.3l4.6-1.5z"/><path d="M15.5 13.5v3M14 15h3"/>'),
  remote: s20('<rect x="2.5" y="3.5" width="15" height="10" rx="1.5"/><path d="M7 16.5h6M10 13.5v3"/>'),
  uploads: s20('<path d="M10 13V4M6.5 7.5 10 4l3.5 3.5M4 13.5v2A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-2"/>'),
};
const SEARCH_IC = s20('<circle cx="9" cy="9" r="5"/><path d="m13 13 3.5 3.5"/>');
const ASK_IC = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H9l-3.5 3v-3a2 2 0 0 1-2-2z"/></svg>';
const PIN_IC = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.6 1.6 14.4 5.4 12.9 6.1 10.7 8.3 10.9 11.4 9.8 12.5 7 9.7 3.2 13.5 2.5 12.8 6.3 9 3.5 6.2 4.6 5.1 7.7 5.3 9.9 3.1z"/></svg>';
const SORT_IC = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6 7.5 9 4.5"/></svg>';

/** What the viewer is looking at; kept while the app is open, so coming back finds it where it was. */
const st = {
  built: false,
  manage: false,
  group: "",
  job: "",
  q: "",
  sort: "" as string,
  dir: "" as "" | "asc" | "desc",
  total: 0,
  listing: null as Listing | null,
  pages: new Map<number, Entry[]>(),
  loading: new Set<number>(),
  gen: 0,
  selected: null as string | null,
  selIndex: -1,
};
let navRef: FilesNav | null = null;

const sizeText = (n: number | null) => (n == null ? "" : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function dateText(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).replace(/\s?([ap])\.?m\.?/i, " $1m");
  return d.toLocaleDateString("en-AU", d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}
const query = (o: { offset?: number; limit?: number } = {}) => {
  const u = new URLSearchParams();
  if (st.group) u.set("group", st.group);
  if (st.job) u.set("job", st.job);
  if (st.q) u.set("q", st.q);
  if (st.sort) u.set("sort", st.sort);
  if (st.dir) u.set("dir", st.dir);
  u.set("offset", String(o.offset ?? 0));
  u.set("limit", String(o.limit ?? PAGE));
  return `/api/v2/everything?${u}`;
};

/** Open the viewer at a group, a job or words (the assistant's show_files, the fast path, a first-run step). */
export function openFiles(o: { group?: string; job?: string; q?: string; manage?: boolean }, nav: FilesNav) {
  st.manage = !!o.manage;
  if (!o.manage) {
    st.group = o.group ?? "";
    st.job = o.job ?? "";
    st.q = o.q ?? "";
    st.sort = "";
    st.dir = "";
    st.selected = null;
    if (st.built) ($("fvQ") as HTMLInputElement).value = st.q;
  }
  navRef = nav;
  nav.closePreview();
  nav.go("files");
}

/** The Files page: the viewer, or the folders it reads and the reference shelf ("Folders and books"). */
export async function renderFiles(nav: FilesNav, renderFolders: () => Promise<void>) {
  navRef = nav;
  if (!st.built) build();
  $("fvBrowse").hidden = st.manage;
  $("fvManage").hidden = !st.manage;
  if (st.manage) {
    nav.closePreview();
    sideNav();
    return renderFolders();
  }
  await reload(false);
}

function build() {
  st.built = true;
  $("fvSide").innerHTML = `<div class="fv-sidehead"><h1>Files</h1></div><nav class="fv-groups" id="fvGroups" aria-label="Groups"></nav><div class="fv-jobs" id="fvJobs" hidden></div><div class="fv-sidefoot"><button type="button" data-fv="manage">${IC.folder}<span>Folders and books</span></button></div>`;
  $("fvBrowse").innerHTML = `<header class="thead fv-head"><h1 id="fvTitle">Everything</h1><span class="sub" id="fvCount"></span><span class="grow"></span><label class="fv-search">${SEARCH_IC}<input id="fvQ" type="search" placeholder="Search files and what's in them" aria-label="Search your files" autocomplete="off" spellcheck="false"></label></header>
    <div class="fv-cols" id="fvCols" role="presentation">${(
      [
        ["name", "Name"],
        ["kind", "Kind"],
        ["job", "Job"],
        ["date", "Date"],
        ["size", "Size"],
      ] as const
    )
      .map(([k, l]) => `<button type="button" class="c-${k}" data-sort="${k}">${l}<i>${SORT_IC}</i></button>`)
      .join("")}</div>
    <div class="fv-list" id="fvList" tabindex="0" role="listbox" aria-label="Files"><div class="fv-spacer" id="fvSpacer"><div class="fv-rows" id="fvRows"></div></div><div class="fv-empty" id="fvEmpty" hidden></div></div>`;
  ($("fvQ") as HTMLInputElement).value = st.q;

  $("fvSide").addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-g],[data-job],[data-fv]");
    if (!b) return;
    if (b.dataset.fv === "manage") {
      st.manage = true;
      return void navRef?.go("files");
    }
    if (b.dataset.g !== undefined) {
      const was = st.manage;
      st.manage = false;
      st.group = b.dataset.g;
      st.job = "";
      st.selected = null;
      navRef?.closePreview();
      if (was) return void navRef?.go("files");
    } else if (b.dataset.job !== undefined) st.job = st.job === b.dataset.job ? "" : b.dataset.job;
    void reload(true);
  });
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  const q = $("fvQ") as HTMLInputElement;
  q.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      st.q = q.value.trim();
      st.sort = "";
      st.dir = "";
      void reload(true);
    }, 200);
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && q.value) {
      e.stopPropagation();
      q.value = "";
      st.q = "";
      void reload(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      $("fvList").focus();
      move(st.selIndex < 0 ? 0 : 1);
    }
  });
  $("fvCols").addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-sort]");
    if (!b) return;
    const k = b.dataset.sort!;
    const cur = st.listing?.sort ?? "date";
    const curDir = st.listing?.dir ?? "desc";
    st.sort = k;
    st.dir = k === cur ? (curDir === "asc" ? "desc" : "asc") : k === "date" || k === "size" ? "desc" : "asc";
    void reload(true);
  });
  const list = $("fvList");
  let raf = 0;
  list.addEventListener("scroll", () => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), draw()));
  });
  addEventListener("resize", () => draw());
  list.addEventListener("click", (e) => {
    const r = (e.target as Element).closest<HTMLElement>("[data-i]");
    if (r) void select(Number(r.dataset.i));
  });
  list.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      void select(e.key === "Home" ? 0 : st.total - 1);
    }
  });
  // the pane's close button (or Esc) clears the selection
  document.addEventListener("lh-preview-closed", () => {
    st.selected = null;
    st.selIndex = -1;
    draw();
  });
}

function move(by: number) {
  if (!st.total) return;
  const i = Math.min(st.total - 1, Math.max(0, (st.selIndex < 0 ? -1 : st.selIndex) + by));
  void select(i);
}

/** Fetch the list again for what's chosen. reset: back to the top (a new group, job, search or sort). */
async function reload(reset: boolean) {
  const gen = ++st.gen;
  const list = $("fvList");
  const keep = reset ? 0 : list.scrollTop;
  const first = Math.max(0, Math.floor(keep / ROW / PAGE) * PAGE);
  const l = await api<Listing>(query({ offset: first }), { method: "GET" }).catch((err) => {
    toast(err instanceof Error ? err.message : String(err));
    return null;
  });
  if (!l || gen !== st.gen) return;
  st.listing = l;
  st.total = l.total;
  st.pages = new Map([[first / PAGE, l.entries]]);
  st.loading.clear();
  if (st.group && !l.groups.some((g) => g.id === st.group)) st.group = ""; // that group has nothing left in it
  if (reset) list.scrollTop = 0;
  sideNav();
  head();
  draw();
}

function sideNav() {
  const l = st.listing;
  const all = l ? l.groups.reduce((n, g) => n + g.count, 0) : 0;
  const row = (id: string, label: string, n: number) =>
    `<button type="button" data-g="${id}" ${!st.manage && st.group === id ? 'aria-current="true"' : ""}${st.q && !n ? ' class="zero"' : ""}>${ICONS[id] ?? ""}<span class="lbl">${esc(label)}</span><span class="n">${n.toLocaleString("en-AU")}</span></button>`;
  $("fvGroups").innerHTML = row("", "Everything", all) + (l?.groups ?? []).map((g) => row(g.id, g.label, g.count)).join("");
  const jobs = $("fvJobs");
  const showJobs = !st.manage && !!l && l.jobs.length > 1 && !!st.group;
  jobs.hidden = !showJobs;
  jobs.innerHTML = showJobs ? `<div class="side-lab">Jobs</div>${l!.jobs.map((j) => `<button type="button" data-job="${esc(j.job)}" ${st.job.toLowerCase() === j.job.toLowerCase() ? 'aria-current="true"' : ""}><span class="lbl">${esc(j.job)}</span><span class="n">${j.count}</span></button>`).join("")}` : "";
  $("fvSide").querySelector<HTMLElement>('[data-fv="manage"]')!.toggleAttribute("aria-current", st.manage);
}

function head() {
  const l = st.listing!;
  const g = l.groups.find((x) => x.id === st.group);
  $("fvTitle").textContent = g ? g.label : "Everything";
  $("fvCount").textContent = `${st.job ? `${st.job} · ` : ""}${st.q ? `${l.total.toLocaleString("en-AU")} found` : `${l.total.toLocaleString("en-AU")} ${l.total === 1 ? "thing" : "things"}`}`;
  $("fvCols")
    .querySelectorAll<HTMLElement>("[data-sort]")
    .forEach((b) => {
      const on = b.dataset.sort === l.sort;
      b.classList.toggle("on", on);
      b.classList.toggle("asc", on && l.dir === "asc");
      b.setAttribute("aria-sort", on ? (l.dir === "asc" ? "ascending" : "descending") : "none");
    });
  const empty = $("fvEmpty");
  empty.hidden = l.total > 0;
  empty.innerHTML = st.q ? `<b>Nothing matches “${esc(st.q)}”.</b><span>I looked in names, jobs and the words inside every file I've read.</span>` : `<b>Nothing here yet.</b>`;
}

/** Draw only the rows in view (and a few either side), fetching their page when it isn't here yet. */
function draw() {
  if (!st.listing || st.manage) return;
  const list = $("fvList");
  const total = st.total;
  $("fvSpacer").style.height = `${total * ROW}px`;
  const first = Math.max(0, Math.floor(list.scrollTop / ROW) - 6);
  const last = Math.min(total - 1, Math.ceil((list.scrollTop + list.clientHeight) / ROW) + 6);
  const html: string[] = [];
  for (let i = first; i <= last; i++) {
    const page = Math.floor(i / PAGE);
    const e = st.pages.get(page)?.[i - page * PAGE];
    if (!e) {
      void fetchPage(page);
      html.push(`<div class="fv-row loading" style="height:${ROW}px"><span class="tile"></span><span class="nm"><b></b></span></div>`);
      continue;
    }
    html.push(rowHtml(e, i));
  }
  const rows = $("fvRows");
  rows.style.transform = `translateY(${first * ROW}px)`;
  rows.innerHTML = html.join("");
}

async function fetchPage(page: number) {
  if (st.pages.has(page) || st.loading.has(page)) return;
  st.loading.add(page);
  const gen = st.gen;
  const l = await api<Listing>(query({ offset: page * PAGE }), { method: "GET" }).catch(() => null);
  st.loading.delete(page);
  if (!l || gen !== st.gen) return;
  st.pages.set(page, l.entries);
  draw();
}

function rowHtml(e: Entry, i: number) {
  const sub = e.hit ? `Found inside: ${e.hit.where}` : e.sub ?? (e.own ? e.own : "");
  const on = st.selected === e.id;
  // the second line in a narrow list (the pane open): what it is and the job
  const meta = [e.kind, e.job].filter(Boolean).join(" · ");
  return `<div class="fv-row${on ? " on" : ""}" role="option" aria-selected="${on}" data-i="${i}" data-id="${esc(e.id)}" title="${esc(e.own ? `${e.name} (${e.own})` : e.name)}">
    <span class="tile">${ICONS[e.group] ?? ICONS.documents}</span>
    <span class="nm"><b>${esc(e.name)}</b><small class="sub-wide">${esc(sub)}</small><small class="sub-narrow">${esc(e.hit ? sub : meta)}</small></span>
    <span class="c-kind">${esc(e.kind)}</span><span class="c-job">${esc(e.job)}</span><span class="c-date">${esc(dateText(e.at))}</span><span class="c-size">${esc(sizeText(e.size))}</span></div>`;
}

/** Select a row: highlight it, scroll it into view, preview it on the right. */
async function select(i: number) {
  const page = Math.floor(i / PAGE);
  if (!st.pages.has(page)) await fetchPage(page);
  const e = st.pages.get(page)?.[i - page * PAGE];
  if (!e) return;
  st.selected = e.id;
  st.selIndex = i;
  const list = $("fvList");
  if (i * ROW < list.scrollTop) list.scrollTop = i * ROW;
  else if ((i + 1) * ROW > list.scrollTop + list.clientHeight) list.scrollTop = (i + 1) * ROW - list.clientHeight;
  draw();
  await previewEntry(e, { n: e.hit?.n ?? 0 });
}

async function previewEntry(e: Entry, o: { n?: number; rev?: string }) {
  const id = e.id;
  const pv = await api<PreviewIn>(`/api/v2/everything/${encodeURIComponent(id)}?n=${o.n ?? 0}${o.rev ? `&rev=${encodeURIComponent(o.rev)}` : ""}`, { method: "GET" }).catch((err) => {
    toast(err instanceof Error ? err.message : String(err));
    return null;
  });
  if (!pv || st.selected !== id) return; // they've moved on
  const at = { n: (pv.pages?.n ?? 1) - 1, rev: pv.rev };
  navRef?.preview({ ...pv, turn: (t) => void previewEntry(e, { n: t.n ?? at.n, rev: t.rev ?? at.rev }), actions: actionsFor(pv, at) });
}

/** The pane's action strip for a selected file: ask about it, pin it, rename it, save a copy, an earlier revision. */
function actionsFor(pv: PreviewIn, at: { n: number; rev?: string }) {
  const e = pv.entry;
  const el = document.createElement("div");
  el.className = "pact-in";
  const plain = !pv.item;
  const normal = () =>
    `<button class="btn accent sm" type="button" data-pa="ask" title="Puts it up beside the conversation, so 'this' means it">${ASK_IC}Ask about this</button><button class="btn sm" type="button" data-pa="pin">${PIN_IC}Pin</button><button class="btn sm" type="button" data-pa="rename">Rename</button>${e.file && !plain ? `<a class="btn sm" data-pa="save" href="/api/v2/everything/${encodeURIComponent(e.id)}/file" download>Save a copy</a>` : ""}<span class="grow"></span>${
      pv.revisions && pv.revisions.length > 1
        ? `<select class="sel sm" data-pa="rev" aria-label="Revision">${[...pv.revisions]
            .reverse()
            .map((r, k) => `<option value="${esc(r.rev)}" ${r.rev === pv.rev ? "selected" : ""}>Rev ${esc(r.rev)}${k === 0 ? " (newest)" : ""} · ${esc(r.text)}</option>`)
            .join("")}</select>`
        : `<span class="pact-meta">${esc([sizeText(e.size), dateText(e.at)].filter(Boolean).join(" · "))}</span>`
    }`;
  el.innerHTML = normal();
  const real = async () => api<{ item: Item }>(`/api/v2/everything/${encodeURIComponent(e.id)}/item`, { json: { n: at.n, rev: at.rev } }).then((r) => r.item);
  el.addEventListener("change", (ev) => {
    const s = (ev.target as Element).closest<HTMLSelectElement>('[data-pa="rev"]');
    if (s) pv.turn?.({ rev: s.value, n: 0 });
  });
  el.addEventListener("click", async (ev) => {
    const b = (ev.target as Element).closest<HTMLElement>("[data-pa]");
    if (!b || b.tagName === "A" || b.tagName === "SELECT") return;
    const a = b.dataset.pa;
    try {
      if (a === "ask") {
        (b as HTMLButtonElement).disabled = true;
        navRef?.tell(await real());
      } else if (a === "pin") {
        (b as HTMLButtonElement).disabled = true;
        const it = await real();
        const r = await fetch("/api/pins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item_ids: [it.id] }) });
        (b as HTMLButtonElement).disabled = false;
        if (r.status === 409) return toast("There are five pins already. Unpin one first.");
        if (!r.ok) throw new Error("Couldn't pin that.");
        toast("Pinned. It's in the sidebar and on your phone.");
      } else if (a === "rename") {
        el.innerHTML = `<input class="fv-rename" value="${esc(e.name)}" aria-label="New name" maxlength="120"><button class="btn accent sm" type="button" data-pa="save-name">Save</button><button class="btn quiet sm" type="button" data-pa="cancel">Cancel</button><span class="pact-note">Only the name here. The file keeps its own.</span>`;
        const inp = el.querySelector<HTMLInputElement>("input")!;
        inp.focus();
        inp.select();
        inp.onkeydown = (k) => {
          if (k.key === "Enter") el.querySelector<HTMLElement>('[data-pa="save-name"]')!.click();
          if (k.key === "Escape") (k.stopPropagation(), el.querySelector<HTMLElement>('[data-pa="cancel"]')!.click());
        };
      } else if (a === "cancel") el.innerHTML = normal();
      else if (a === "save-name") {
        const v = el.querySelector<HTMLInputElement>("input")!.value.trim();
        const r = await api<{ entry: Entry }>(`/api/v2/everything/${encodeURIComponent(e.id)}/label`, { json: { label: v === (e.own ?? e.name) ? "" : v } });
        Object.assign(e, { name: r.entry.name, own: r.entry.own });
        el.innerHTML = normal();
        $("pttl").querySelector("b")!.textContent = r.entry.name;
        toast(r.entry.own ? "Renamed. The file itself keeps its name." : "Back to its own name.");
        void reload(false);
      }
    } catch (err) {
      (b as HTMLButtonElement).disabled = false;
      toast(err instanceof Error ? err.message : String(err));
    }
  });
  return el;
}
