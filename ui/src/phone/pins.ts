import { copyEarlierCache } from "../../../src/shared/earlier";
// Pins on the phone (Stage 13.2): a small row of thumbnails low on the home screen, under Pebble, one per pin, with a
// short label. No pins, no row. A tap opens it where he left it; press and hold shows a small remove control; a sixth
// asks which one goes. Each pin's pages are kept on the phone, in the service worker's cache "tavi-pins-1" (the list
// itself, the pinned page's pictures, the pages either side of it, and the tiles that make where he left it sharp), so
// a pin opens at once and still opens with no reception. Unpinning lets them go. A set of shop drawings (Stage 12) is
// one item shown as a page per sheet: it's pinned once, with the sheet he's on, and its sheets are kept like a set of
// drawing sheets (the one he left it on and the ones either side).
import { ICONS, esc } from "../shared/items/describe";
import { tileUrlsFor, type ViewState } from "../shared/sheet-viewer/viewer";
import { pagesOf } from "./render";
import type { CamPlace, Item, Pin } from "../../../src/shared/protocol";

export const PINS_CACHE = "tavi-pins-1";
const LIST = "/api/pins"; // the list, as the gateway last sent it, kept under its own address
const THUMB = 44;
const CUBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9z"/><path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9"/></svg>';
const PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.8 4.6a2 2 0 0 1 2.9 2.9L8.4 17.8l-4.1 1.4 1.4-4.1z"/><path d="m14.2 6.2 3.6 3.6"/></svg>';
const X = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6.5 6.5l7 7M13.5 6.5l-7 7"/></svg>';

export type PinsDeps = {
  row: HTMLElement;
  pick: HTMLElement;
  pickScrim: HTMLElement;
  pickBody: HTMLElement;
  /** Open it in the viewer, blooming out of its thumbnail. */
  open: (p: Pin, from: HTMLElement) => void;
  /** One line under Pebble. */
  say: (text: string) => void;
  /** Any change to the list (the viewer's pin button follows it). */
  onChange: () => void;
};
export type OnScreen = { items: Item[]; idx: number; view: ViewState | null; camera: CamPlace | null };

const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const page = (it: Item) =>
  it.kind === "sheet"
    ? `/api/sheets/${encodeURIComponent(it.payload.sheet_id)}`
    : it.kind === "reference"
      ? `/api/reference/${encodeURIComponent(it.payload.book_id)}/${it.payload.page}`
      : it.kind === "shopdrawing"
        ? `/api/shopdrawings/${encodeURIComponent(it.payload.drawing_id)}/${encodeURIComponent(it.payload.rev)}/${it.payload.sheet ?? 1}`
        : null;
const aspectOf = (it: Item) =>
  it.kind === "sheet" || it.kind === "reference" ? it.payload.aspect : it.kind === "shopdrawing" ? (it.payload.sheets[(it.payload.sheet ?? 1) - 1]?.aspect ?? 420 / 297) : it.kind === "image" ? it.payload.w / it.payload.h : 1;

/** The pages a pin opens with, as they're shown (a set of shop drawings spread into its sheets), and the one he left it on. */
export function pinPages(p: Pick<Pin, "items" | "idx" | "sheet">): { pages: Item[]; at: number } {
  const pages = p.items.flatMap(pagesOf);
  const it = p.items[p.idx] ?? p.items[0];
  const at = pages.findIndex((pg) => pg.id === it?.id && (pg.kind !== "shopdrawing" || pg.payload.sheet === (p.sheet ?? 1)));
  return { pages, at: Math.max(0, at) };
}
/** What's on screen as a pin keeps it: each item once, the one it's on, and a set of shop drawings' sheet. */
export function placeOf(on: OnScreen) {
  const it = on.items[on.idx];
  const ids = [...new Set(on.items.map((i) => i.id))];
  return { item_ids: ids, idx: Math.max(0, ids.indexOf(it?.id)), view: it?.kind === "model" ? null : on.view, camera: on.camera, ...(it?.kind === "shopdrawing" ? { sheet: it.payload.sheet ?? 1 } : {}) };
}

/** Its picture for the thumbnail: the page itself (the copy kept on the phone), or a photo. */
function pictureOf(it: Item): string | null {
  const base = page(it);
  if (base) return `${base}/page.png?w=1024`;
  if (it.kind === "image") return it.payload.src;
  if (it.kind === "legacy") return it.payload.images.find((i) => i.src.startsWith("/api/"))?.src ?? null;
  return null;
}
function iconOf(it: Item) {
  if (it.kind === "model") return CUBE;
  if (it.kind === "sketch") return PENCIL;
  if (it.kind === "table") return ICONS.table;
  if (it.kind === "draft") return ICONS.mail;
  return ICONS.list;
}
/** The thumbnail: the page, a little closer than the whole sheet, centred where he left it, so each pin looks like its own. */
function thumb(p: Pin) {
  const { pages, at } = pinPages(p);
  const it = pages[at];
  const src = pictureOf(it);
  if (!src) return `<span class="pin-th">${iconOf(it)}</span>`;
  if (it.kind === "image" || it.kind === "legacy") return `<span class="pin-th pic" style="background-image:url('${esc(src)}');background-size:cover;background-position:center"></span>`;
  const a = aspectOf(it) || Math.SQRT2;
  const z = Math.min(2.6, Math.max(1.4, (p.view?.s ?? 1) * 0.8));
  const w = (a >= 1 ? THUMB : THUMB * a) * z,
    h = (a >= 1 ? THUMB / a : THUMB) * z;
  const fit = (len: number, c: number) => (len >= THUMB ? Math.min(0, Math.max(THUMB - len, THUMB / 2 - c * len)) : (THUMB - len) / 2);
  const x = fit(w, p.view?.cx ?? 0.5),
    y = fit(h, p.view?.cy ?? 0.5);
  return `<span class="pin-th pic" style="background-image:url('${esc(src)}');background-size:${w.toFixed(1)}px ${h.toFixed(1)}px;background-position:${x.toFixed(1)}px ${y.toFixed(1)}px"></span>`;
}

export function createPins(d: PinsDeps) {
  let list: Pin[] = [];
  const live = () => list.filter((p) => !p.until || Date.parse(p.until) > Date.now()); // "for today" goes at midnight, even with no reception

  /* ---------- the row ---------- */
  function render() {
    const shown = live();
    d.row.hidden = !shown.length;
    d.row.innerHTML = shown
      .map(
        (p) =>
          `<div class="pin" data-pin="${esc(p.id)}"><button class="pin-open" type="button" aria-label="${esc(p.label)}, pinned${p.until ? " for today" : ""}. Press and hold to unpin.">${thumb(p)}<span class="pin-l">${esc(p.label)}</span></button>` +
          `<button class="pin-x" type="button" tabindex="-1" aria-label="Unpin ${esc(p.label)}">${X}</button></div>`,
      )
      .join("");
  }
  let armed: HTMLElement | null = null;
  let armTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const disarm = () => {
    armed?.classList.remove("arm");
    armed = null;
    if (armTimer) clearTimeout(armTimer);
  };
  let press: { x: number; y: number; t: ReturnType<typeof setTimeout> } | null = null;
  let held = false;
  const cancelPress = () => press && (clearTimeout(press.t), (press = null));
  d.row.addEventListener("pointerdown", (e) => {
    const pin = (e.target as Element).closest<HTMLElement>(".pin");
    if (!pin || (e.target as Element).closest(".pin-x")) return;
    held = false;
    cancelPress();
    press = {
      x: e.clientX,
      y: e.clientY,
      t: setTimeout(() => {
        press = null;
        held = true;
        disarm();
        armed = pin;
        pin.classList.add("arm");
        navigator.vibrate?.(8);
        armTimer = setTimeout(disarm, 5000);
      }, 500),
    };
  });
  d.row.addEventListener("pointermove", (e) => press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10 && cancelPress());
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) d.row.addEventListener(t, cancelPress);
  d.row.addEventListener("contextmenu", (e) => e.preventDefault());
  d.row.addEventListener("click", (e) => {
    const pin = (e.target as Element).closest<HTMLElement>(".pin");
    if (!pin) return;
    const p = list.find((x) => x.id === pin.dataset.pin);
    if ((e.target as Element).closest(".pin-x")) return void (p && remove(p, pin));
    if (held) return void (held = false); // the hold that showed the remove control
    if (armed) return disarm();
    if (p) d.open(p, pin.querySelector(".pin-th") as HTMLElement);
  });
  document.addEventListener("pointerdown", (e) => armed && !armed.contains(e.target as Node) && disarm(), true);

  async function remove(p: Pin, el: HTMLElement) {
    disarm();
    el.classList.add("gone");
    const r = await fetch(`/api/pins/${encodeURIComponent(p.id)}`, { method: "DELETE" }).catch(() => null);
    if (!r?.ok) {
      el.classList.remove("gone");
      return d.say(r ? "I couldn't unpin that just now." : "I can't reach your computer, so that stays pinned for now.");
    }
    await new Promise((res) => setTimeout(res, reduce() ? 0 : 240));
    set(list.filter((x) => x.id !== p.id));
  }

  /* ---------- a sixth: which one goes ---------- */
  function choose(pins: Pin[], body: Record<string, unknown>): Promise<Pin | null> {
    return new Promise((resolve) => {
      d.pickBody.innerHTML =
        `<div class="quick-label">Five pinned. Which one goes?</div>` +
        pins.map((p) => `<button class="quick-row pick-row" type="button" data-replace="${esc(p.id)}">${thumb(p)}<span class="pick-l">${esc(p.label)}</span><span class="v">${esc(ago(p.pinned_at))}</span></button>`).join("") +
        `<button class="quick-row pick-keep" type="button" data-keep="1">Keep them all</button>`;
      const close = (pin: Pin | null) => {
        d.pick.classList.remove("open");
        d.pickScrim.classList.remove("open");
        d.pick.inert = true;
        d.pick.setAttribute("aria-hidden", "true");
        d.pickBody.onclick = d.pickScrim.onclick = null;
        resolve(pin);
      };
      d.pickScrim.onclick = () => close(null);
      d.pickBody.onclick = async (e) => {
        const b = (e.target as Element).closest<HTMLElement>("button");
        if (!b) return;
        if (!b.dataset.replace) return close(null);
        const r = await post("/api/pins", { ...body, replace: b.dataset.replace }).catch(() => null);
        if (!r?.ok) {
          d.say("I couldn't pin that just now.");
          return close(null);
        }
        const { pin } = (await r.json()) as { pin: Pin };
        set([...list.filter((x) => x.id !== b.dataset.replace && x.id !== pin.id), pin]);
        d.say("Pinned.");
        close(pin);
      };
      d.pick.inert = false;
      d.pick.setAttribute("aria-hidden", "false");
      d.pick.classList.add("open");
      d.pickScrim.classList.add("open");
    });
  }

  /* ---------- kept on the phone ---------- */
  /** Every address a pin needs with no reception: the pinned page and the ones either side (their details and both
   *  pictures), the tiles for where he left the pinned one, and a photo's picture. */
  async function addressesFor(p: Pin, unsure: Set<string>): Promise<string[]> {
    const out: string[] = [];
    const { pages, at } = pinPages(p);
    for (let i = Math.max(0, at - 1); i <= Math.min(pages.length - 1, at + 1); i++) {
      const it = pages[i];
      const base = page(it);
      if (base) {
        out.push(base, `${base}/page.png?w=1024`, `${base}/page.png?w=2048`);
        if (i === at && p.view) {
          const info = (await fetch(base)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)) as { max_z?: number } | null;
          if (info?.max_z) out.push(...tileUrlsFor(base, aspectOf(it), info.max_z, p.view, innerWidth, innerHeight, devicePixelRatio || 1).slice(0, 48));
          else if (!info) unsure.add(new URL(`${base}/`, location.href).href); // can't tell which tiles: keep what's kept
        }
      } else {
        const pic = pictureOf(it);
        if (pic) out.push(pic);
      }
    }
    return out;
  }
  let keeping: Promise<void> = Promise.resolve();
  /** Bring what's kept in line with the pins: keep the list, fetch anything missing, let go of anything not needed. */
  const keep = () => (keeping = keeping.then(keepNow, keepNow));
  async function keepNow() {
    if (!("caches" in window)) return;
    const c = await copyEarlierCache(caches, PINS_CACHE);
    const pins = [...list];
    await c.put(LIST, new Response(JSON.stringify(pins), { headers: { "Content-Type": "application/json" } }));
    const want = new Set([new URL(LIST, location.href).href]);
    const unsure = new Set<string>();
    for (const p of pins) for (const u of await addressesFor(p, unsure)) want.add(new URL(u, location.href).href);
    for (const req of await c.keys()) if (!want.has(req.url) && ![...unsure].some((b) => req.url.startsWith(b))) await c.delete(req);
    for (const u of want) {
      if (await c.match(u)) continue;
      const r = await fetch(u).catch(() => null);
      if (r?.ok) await c.put(u, r).catch(() => undefined);
    }
  }

  function set(pins: Pin[]) {
    list = pins;
    render();
    d.onChange();
    void keep();
  }

  return {
    get list() {
      return live();
    },
    /** From the gateway (on connecting, and whenever they change). */
    set,
    /** At start, before the gateway answers (or with no reception): the list as it was last kept. */
    async loadKept() {
      if (!("caches" in window) || list.length) return;
      const r = await (await copyEarlierCache(caches, PINS_CACHE)).match(LIST).catch(() => undefined);
      const kept = r ? ((await r.json().catch(() => null)) as Pin[] | null) : null;
      if (kept && !list.length) {
        list = kept;
        render();
        d.onChange();
      }
    },
    /** The pin this item is in, if any. */
    pinFor: (itemId: string) => live().find((p) => p.item_ids.includes(itemId)) ?? null,
    /** The viewer's pin button: pin what's on screen (and the pages beside it, where it's looking), or unpin it. */
    async toggle(on: OnScreen): Promise<Pin | null> {
      const it = on.items[on.idx];
      if (!it) return null;
      const had = live().find((p) => p.item_ids.includes(it.id));
      if (had) {
        const r = await fetch(`/api/pins/${encodeURIComponent(had.id)}`, { method: "DELETE" }).catch(() => null);
        if (!r?.ok) {
          d.say(r ? "I couldn't unpin that just now." : "I can't reach your computer, so that stays pinned for now.");
          return had;
        }
        set(list.filter((x) => x.id !== had.id));
        d.say("Unpinned.");
        return null;
      }
      const body = placeOf(on);
      const r = await post("/api/pins", body).catch(() => null);
      if (!r || (!r.ok && r.status !== 409)) {
        d.say(r ? "I couldn't pin that just now." : "I can't reach your computer, so I can't pin that right now.");
        return null;
      }
      if (r.status === 409) return choose(((await r.json()) as { pins: Pin[] }).pins, body);
      const { pin } = (await r.json()) as { pin: Pin };
      set([...list.filter((x) => x.id !== pin.id), pin]);
      d.say("Pinned.");
      return pin;
    },
    /** Leaving the viewer: where he left it, on the computer and here (so it opens there next time, reception or not). */
    savePlace(id: string, on: OnScreen) {
      const p = list.find((x) => x.id === id);
      if (!p) return;
      const { idx, view, camera, sheet } = placeOf(on);
      const place = { idx, view, camera, ...(sheet ? { sheet } : {}) };
      Object.assign(p, { idx, view, camera, sheet, label: p.label });
      render();
      void keep();
      void fetch(`/api/pins/${encodeURIComponent(id)}/place`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(place), keepalive: true }).catch(() => undefined);
    },
    /** Whether the page it opens on is kept on the phone (pages with nothing to fetch always are). */
    async stored(p: Pin) {
      const { pages, at } = pinPages(p);
      const it = pages[at];
      const pic = it && pictureOf(it);
      if (!pic || !("caches" in window)) return true;
      return !!(await (await copyEarlierCache(caches, PINS_CACHE)).match(pic).catch(() => undefined));
    },
    /** What's kept on the phone for pins: how many files and how many bytes (tests, and the notes). */
    async usage() {
      await keeping;
      if (!("caches" in window)) return { files: 0, bytes: 0 };
      const c = await copyEarlierCache(caches, PINS_CACHE);
      let bytes = 0;
      const keys = await c.keys();
      for (const k of keys) bytes += (await (await c.match(k))?.blob())?.size ?? 0;
      return { files: keys.length, bytes, urls: keys.map((k) => new URL(k.url).pathname + new URL(k.url).search) };
    },
    /** Draw the row again ("for today" ones go at midnight with no word from the computer). */
    refresh: render,
    disarm,
  };
}

/** How long ago, for the chooser: "today", "yesterday", "3 days ago". */
function ago(iso: string) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}
