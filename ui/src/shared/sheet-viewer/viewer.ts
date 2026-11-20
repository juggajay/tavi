// Sheet viewer (DESIGN §5; ported from mockups/v2/src/viewer.js, same model and numbers): pinch-zoom, drag-to-pan with
// momentum, double-tap zoom, wheel zoom, fly-to. It redraws by changing the SVG viewBox, never CSS transforms. At
// whole-sheet zoom a sideways or downward drag is handed to the parent (paging / dismiss).
//
// The real sheet is pictures from the gateway: the whole page at once (1024 px, then 2048), and 768 px tiles for
// whatever is in view once that isn't sharp enough (GET /api/sheets/:id/page.png, /tile/z/x/y.png). Page units are
// W = 1680 wide (the mockup's sheet width, so its tuned constants carry over) and W / aspect tall.
import "./viewer.css";
import { Trail } from "../trail";
import type { Box, Mark, SheetPayload } from "../../../../src/shared/protocol";

const NS = "http://www.w3.org/2000/svg";
const W = 1680;
const TILE = 768;
const MAX_TILES = 60;
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export type Axis = "x" | "y";
export type DelegatePhase = "can" | "start" | "move" | "end" | "cancel";
export type Delegate = (phase: DelegatePhase, axis: Axis, dx?: number, dy?: number, v?: { x: number; y: number }) => boolean | void;
/** The viewer's state as fractions: s is zoom relative to whole-sheet (1 = whole sheet), cx/cy the centre in page fractions. */
export type ViewState = { s: number; cx: number; cy: number };

// x0/y0 are in the host's own pixels; sx0/sy0 where the finger went down on the screen (a drag handed to the page is
// measured there: see move()).
type Gesture =
  | { mode: "pending" | "pan"; x0: number; y0: number; sx0: number; sy0: number; cx0: number; cy0: number; type?: string }
  | { mode: "delegate"; axis: Axis; x0: number; y0: number; sx0: number; sy0: number; cx0: number; cy0: number }
  | { mode: "pinch"; d0: number; m0: { x: number; y: number }; s0: number; cx0: number; cy0: number };

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}

export class SheetViewer {
  readonly host: HTMLElement;
  readonly sheet: SheetPayload;
  readonly H: number;
  s = 0;
  fitS = 0;
  cx: number;
  cy: number;
  marks: Mark[] = [];
  private svg: SVGSVGElement;
  private page: SVGImageElement;
  private tilesG: SVGGElement;
  private marksG: SVGGElement;
  private tiles = new Map<string, { img: SVGImageElement; z: number; loaded: boolean }>();
  private tileZ = -1;
  private maxZ = 0;
  private tileTimer = 0 as ReturnType<typeof setTimeout> | 0;
  private pts = new Map<number, { x: number; y: number }>();
  private g: Gesture | null = null;
  private raf = 0;
  private lastTap: { t: number; x: number; y: number } | null = null;
  private pending: { view?: Box; focus?: Box } | null = null;
  private vel = { x: 0, y: 0 };
  /** The finger on the screen: how fast it was going when a drag handed to the page lets go. */
  private trail = new Trail();
  private lastMove = { x: 0, y: 0, t: 0 };
  private ro: ResizeObserver;
  private dead = false;
  /** Where the page pictures come from: a drawing sheet's routes, or a reference book page's (opts.base). */
  private base: string;

  constructor(host: HTMLElement, sheet: SheetPayload, private opts: { onDelegate?: Delegate; onTap?: (p: { x: number; y: number }) => void; onView?: (v: SheetViewer) => void; minSpan?: number; base?: string; missing?: string; bands?: boolean } = {}) {
    this.host = host;
    this.sheet = sheet;
    this.H = W / (sheet.aspect || Math.SQRT2);
    this.cx = W / 2;
    this.cy = this.H / 2;
    host.classList.add("sv");
    this.svg = el("svg", { class: "sheet", viewBox: `0 0 ${W} ${this.H}`, preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": `${sheet.sheet_no ?? ""} ${sheet.title ?? ""}`.trim() });
    el("rect", { class: "sheet-paper", width: W, height: this.H }, this.svg);
    this.page = el("image", { x: 0, y: 0, width: W, height: this.H, preserveAspectRatio: "none" }, this.svg);
    this.tilesG = el("g", { class: "sv-tiles" }, this.svg);
    el("rect", { class: "sv-dim", width: W, height: this.H }, this.svg); // dark mode: the white paper a touch greyer
    this.marksG = el("g", { class: "sv-marks" }, this.svg);
    host.appendChild(this.svg);
    // the small page first, then the sharper one once it's here
    const base = (this.base = opts.base ?? `/api/sheets/${encodeURIComponent(sheet.sheet_id)}`);
    this.page.setAttribute("href", `${base}/page.png?w=1024`);
    // The drawing's file has gone (moved or deleted) and nothing was kept: say so instead of showing blank paper.
    this.page.addEventListener("error", () => {
      if (this.dead || host.querySelector(".sv-missing")) return;
      host.insertAdjacentHTML("beforeend", `<div class="sv-missing" role="status">${opts.missing ?? "I can't find that drawing file any more."}</div>`);
    });
    // decoded off to the side first, so swapping it in never stalls a frame (e.g. mid-bloom)
    const better = new Image();
    better.src = `${base}/page.png?w=2048`;
    better
      .decode()
      .then(() => !this.dead && this.page.setAttribute("href", better.src))
      .catch(() => undefined);
    fetch(base)
      .then((r) => (r.ok ? r.json() : null))
      .then((info: { max_z?: number } | null) => {
        this.maxZ = info?.max_z ?? 0;
        this.updateTiles();
      })
      .catch(() => undefined);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    host.addEventListener("pointerdown", (e) => this.down(e));
    host.addEventListener("pointermove", (e) => this.move(e));
    host.addEventListener("pointerup", (e) => this.up(e));
    host.addEventListener("pointercancel", (e) => this.up(e));
    host.addEventListener("lostpointercapture", (e) => {
      if (this.pts.has(e.pointerId)) this.up(e);
    });
    host.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    host.addEventListener("dblclick", (e) => e.preventDefault());
    host.addEventListener("contextmenu", (e) => {
      if ((e as PointerEvent).pointerType !== "mouse") e.preventDefault();
    });
  }

  private dims() {
    return { w: this.host.clientWidth, h: this.host.clientHeight };
  }
  /** Pointer position in the host's own pixels, even while an ancestor is scaled (the bloom animation; DESIGN §8). */
  private local(e: { clientX: number; clientY: number }) {
    const r = this.host.getBoundingClientRect();
    const k = r.width / (this.host.clientWidth || 1) || 1;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  }
  get maxS() {
    return Math.max(this.fitS * 14, 3);
  }
  private computeFit() {
    const { w, h } = this.dims();
    return Math.min(w / W, h / this.H) * 0.95;
  }
  private resize() {
    const { w, h } = this.dims();
    if (!w || !h) return;
    const f = this.computeFit();
    if (!this.fitS) {
      this.fitS = f;
      this.s = f;
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        this.show(p, false);
        return;
      }
    } else {
      const ratio = this.s / this.fitS;
      this.fitS = f;
      this.s = f * ratio;
      const c = this.constrain(this.s, this.cx, this.cy);
      this.cx = c.cx;
      this.cy = c.cy;
    }
    this.apply();
  }
  apply() {
    const { w, h } = this.dims();
    if (!w || !this.s) return;
    const vw = w / this.s,
      vh = h / this.s;
    this.svg.setAttribute("viewBox", `${(this.cx - vw / 2).toFixed(2)} ${(this.cy - vh / 2).toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}`);
    this.opts.onView?.(this);
    // during a gesture, pick tiles at most every 150 ms; always once it settles
    if (!this.tileTimer) this.tileTimer = setTimeout(() => ((this.tileTimer = 0), this.updateTiles()), this.raf || this.g ? 150 : 0);
  }
  private constrain(s: number, cx: number, cy: number) {
    const { w, h } = this.dims(),
      pad = 36;
    const vw = w / s,
      vh = h / s;
    const c = (v: number, view: number, len: number) => (view >= len + pad * 2 ? len / 2 : clamp(v, view / 2 - pad, len + pad - view / 2));
    return { cx: c(cx, vw, W), cy: c(cy, vh, this.H) };
  }
  private rubber(cx: number, cy: number) {
    const c = this.constrain(this.s, cx, cy);
    return { cx: c.cx + (cx - c.cx) * 0.32, cy: c.cy + (cy - c.cy) * 0.32 };
  }
  private softScale(s: number) {
    const lo = this.fitS,
      hi = this.maxS;
    if (s < lo) s = Math.max(lo * 0.7, lo - (lo - s) * 0.4);
    if (s > hi) s = hi + (s - hi) * 0.25;
    return s;
  }
  /** Where a view box (page fractions) or a box to focus on puts the camera. */
  private targetFor(o: { view?: Box; focus?: Box }) {
    const { w, h } = this.dims(),
      f = this.fitS;
    if (o.focus) {
      const b = o.focus,
        bw = (b[2] - b[0]) * W,
        bh = (b[3] - b[1]) * this.H;
      const span = Math.max(500, Math.max(bw, bh) * 4);
      return { s: clamp(Math.max(Math.min(w, h * 1.1) / span, f * 1.6), f, this.maxS), cx: ((b[0] + b[2]) / 2) * W, cy: ((b[1] + b[3]) / 2) * this.H };
    }
    const v = o.view;
    if (v && !(v[0] <= 0 && v[1] <= 0 && v[2] >= 1 && v[3] >= 1)) {
      const vw = Math.max(1e-3, v[2] - v[0]) * W,
        vh = Math.max(1e-3, v[3] - v[1]) * this.H;
      // never open closer than the mockup's door close-up (a 500-unit span on the phone, 900 on the desktop), so there's context around it
      const close = Math.max(Math.min(w, h * 1.1) / (this.opts.minSpan ?? 500), f * 1.6);
      return { s: clamp(Math.min(w / vw, h / vh, close), f, this.maxS), cx: ((v[0] + v[2]) / 2) * W, cy: ((v[1] + v[3]) / 2) * this.H };
    }
    return { s: f, cx: W / 2, cy: this.H / 2 };
  }
  /** Open at a view (page fractions) or fly to a box. Before the first layout it waits and does it then. */
  show(o: { view?: Box; focus?: Box } = {}, animate = true) {
    if (!this.fitS) {
      this.pending = o;
      return;
    }
    const tg = this.targetFor(o);
    if (animate) this.animateTo(tg);
    else {
      this.stop();
      this.s = tg.s;
      const c = this.constrain(tg.s, tg.cx, tg.cy);
      this.cx = c.cx;
      this.cy = c.cy;
      this.apply();
    }
  }
  /** Rings, in page fractions. The pulse restarts each time. */
  setMarks(marks: Mark[]) {
    this.marks = marks;
    this.marksG.replaceChildren();
    for (const m of marks) {
      const [x0, y0, x1, y1] = m.box;
      const cx = ((x0 + x1) / 2) * W,
        cy = ((y0 + y1) / 2) * this.H;
      const rx = Math.max(24, ((x1 - x0) * W) / 2 + 16),
        ry = Math.max(24, ((y1 - y0) * this.H) / 2 + 16);
      const r = Math.max(rx, ry);
      const g = el("g", { class: "sv-ring" }, this.marksG);
      // A row of a table (reference pages): a band round it, not a circle that would swallow the rows either side.
      if (this.opts.bands) {
        const pad = 10;
        const box = { x: x0 * W - pad, y: y0 * this.H - pad / 2, width: (x1 - x0) * W + pad * 2, height: Math.max(18, (y1 - y0) * this.H + pad), rx: 10 };
        for (const cls of ["r0", "r2", "r1"]) el("rect", { class: cls, ...box }, g);
        continue;
      }
      for (const cls of ["r0", "r2", "r1"]) el("ellipse", { class: cls, cx, cy, rx: r, ry: r }, g);
    }
  }
  focus(box: Box, mark?: Mark) {
    if (mark) this.setMarks([mark]);
    this.show({ focus: box }, true);
  }
  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
  animateTo(tg: { s: number; cx: number; cy: number }, ms = 620) {
    this.stop();
    if (reduce()) ms = 0;
    const from = { s: this.s, cx: this.cx, cy: this.cy };
    const c = this.constrain(tg.s, tg.cx, tg.cy);
    const { w } = this.dims();
    const dist = Math.hypot(c.cx - from.cx, c.cy - from.cy) * Math.min(from.s, tg.s);
    const bump = dist > w * 0.8 ? Math.log(dist / (w * 0.8)) * 0.55 + 0.25 : 0;
    const t0 = performance.now();
    const ls0 = Math.log(from.s),
      ls1 = Math.log(tg.s);
    const step = (now: number) => {
      const p = ms ? Math.min(1, (now - t0) / ms) : 1;
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      this.s = Math.exp(ls0 + (ls1 - ls0) * e - bump * Math.sin(Math.PI * e));
      this.cx = from.cx + (c.cx - from.cx) * e;
      this.cy = from.cy + (c.cy - from.cy) * e;
      this.apply();
      if (p < 1) this.raf = requestAnimationFrame(step);
      else {
        this.raf = 0;
        this.updateTiles();
      }
    };
    this.raf = requestAnimationFrame(step);
  }
  zoomBy(k: number, p?: { x: number; y: number }) {
    const { w, h } = this.dims();
    p = p || { x: w / 2, y: h / 2 };
    const ns = clamp(this.s * k, this.fitS, this.maxS);
    const Px = this.cx + (p.x - w / 2) / this.s,
      Py = this.cy + (p.y - h / 2) / this.s;
    this.animateTo({ s: ns, cx: Px - (p.x - w / 2) / ns, cy: Py - (p.y - h / 2) / ns }, 360);
  }
  /** "Zoom out": the whole sheet. */
  zoomOut() {
    this.animateTo(this.targetFor({}), 560);
  }
  /** "Zoom in": closer by 1.8, about the first ring if one is in view, else the middle. */
  zoomIn() {
    const { w, h } = this.dims();
    const m = this.marks[0];
    if (m) {
      const mx = ((m.box[0] + m.box[2]) / 2) * W,
        my = ((m.box[1] + m.box[3]) / 2) * this.H;
      const p = { x: w / 2 + (mx - this.cx) * this.s, y: h / 2 + (my - this.cy) * this.s };
      if (p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h) return this.zoomBy(1.8, p);
    }
    this.zoomBy(1.8);
  }
  isAtFit() {
    return this.s <= this.fitS * 1.06;
  }
  getView(): ViewState {
    return { s: this.fitS ? this.s / this.fitS : 1, cx: this.cx / W, cy: this.cy / this.H };
  }
  setView(v: ViewState) {
    const go = () => {
      this.s = this.fitS * v.s;
      const c = this.constrain(this.s, v.cx * W, v.cy * this.H);
      this.cx = c.cx;
      this.cy = c.cy;
      this.apply();
    };
    if (this.fitS) go();
    else requestAnimationFrame(() => requestAnimationFrame(go));
  }
  get zoomPct() {
    return this.fitS ? Math.round((this.s / this.fitS) * 100) : 100;
  }
  private settle() {
    const s = clamp(this.s, this.fitS, this.maxS);
    if (s <= this.fitS * 1.001) return this.animateTo({ s: this.fitS, cx: W / 2, cy: this.H / 2 }, 380);
    const c = this.constrain(s, this.cx, this.cy);
    if (Math.abs(s - this.s) > 1e-4 || Math.abs(c.cx - this.cx) > 0.5 || Math.abs(c.cy - this.cy) > 0.5) this.animateTo({ s, cx: c.cx, cy: c.cy }, 380);
    else this.updateTiles();
  }
  private fling(v: { x: number; y: number }) {
    this.stop();
    if (reduce() || Math.hypot(v.x, v.y) < 0.05) return this.settle();
    let last = performance.now(),
      vx = v.x,
      vy = v.y;
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      this.cx -= (vx * dt) / this.s;
      this.cy -= (vy * dt) / this.s;
      const c = this.constrain(this.s, this.cx, this.cy);
      const out = Math.abs(c.cx - this.cx) > 1 || Math.abs(c.cy - this.cy) > 1;
      const decay = Math.exp(-dt / (out ? 60 : 325));
      vx *= decay;
      vy *= decay;
      this.apply();
      if (Math.hypot(vx, vy) > 0.02) this.raf = requestAnimationFrame(step);
      else {
        this.raf = 0;
        this.settle();
      }
    };
    this.raf = requestAnimationFrame(step);
  }
  private doubleTap(p: { x: number; y: number }) {
    if (this.s > this.fitS * 1.5) this.animateTo({ s: this.fitS, cx: W / 2, cy: this.H / 2 }, 460);
    else this.zoomBy(3.2, p);
  }
  private down(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {}
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    this.stop();
    if (this.pts.size === 1) {
      this.g = { mode: "pending", x0: p.x, y0: p.y, sx0: e.clientX, sy0: e.clientY, cx0: this.cx, cy0: this.cy, type: e.pointerType };
      this.vel = { x: 0, y: 0 };
      this.trail.start(e.clientX, e.clientY);
      this.lastMove = { x: p.x, y: p.y, t: performance.now() };
    } else if (this.pts.size === 2) {
      if (this.g && this.g.mode === "delegate") this.opts.onDelegate?.("cancel", this.g.axis, 0, 0, { x: 0, y: 0 });
      const [a, b] = [...this.pts.values()];
      this.g = { mode: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, s0: this.s, cx0: this.cx, cy0: this.cy };
      this.host.classList.add("grabbing");
    }
  }
  private move(e: PointerEvent) {
    if (!this.pts.has(e.pointerId)) return;
    const g = this.g;
    // A drag handed to the page (paging, putting it away) moves this sheet with the finger, so it's measured on the
    // screen. Measured against the sheet, every step would come out short by however far the sheet had already moved:
    // the sheet went half as far as the finger, in stops and starts, and a quick flick didn't turn the page (12.0).
    if (g?.mode === "delegate") {
      const dx = e.clientX - g.sx0,
        dy = e.clientY - g.sy0;
      this.pts.set(e.pointerId, { x: g.x0 + dx, y: g.y0 + dy }); // where it would be on the sheet at rest, for a pinch that takes over
      this.track(e);
      this.opts.onDelegate?.("move", g.axis, dx, dy, this.trail.velocity());
      return;
    }
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    if (!g) return;
    const { w, h } = this.dims();
    if (g.mode === "pinch") {
      if (this.pts.size < 2) return;
      const [a, b] = [...this.pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1,
        m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = this.softScale((g.s0 * d) / g.d0);
      const Px = g.cx0 + (g.m0.x - w / 2) / g.s0,
        Py = g.cy0 + (g.m0.y - h / 2) / g.s0;
      this.s = s;
      const r = this.rubber(Px - (m.x - w / 2) / s, Py - (m.y - h / 2) / s);
      this.cx = r.cx;
      this.cy = r.cy;
      this.apply();
      return;
    }
    const dx = p.x - g.x0,
      dy = p.y - g.y0;
    this.track(e, p);
    if (g.mode === "pending") {
      if (Math.hypot(dx, dy) < 7) return;
      const d = this.opts.onDelegate;
      let next: Gesture = g;
      if (this.isAtFit() && d) {
        if (Math.abs(dy) > Math.abs(dx) * 1.15 && dy > 0 && d("can", "y")) next = { ...g, mode: "delegate", axis: "y" };
        else if (Math.abs(dx) > Math.abs(dy) * 1.15 && d("can", "x")) next = { ...g, mode: "delegate", axis: "x" };
      }
      if (next.mode === "pending") {
        next = { ...g, mode: "pan" };
        this.host.classList.add("grabbing");
      }
      this.g = next;
      if (next.mode === "delegate") {
        const sdx = e.clientX - g.sx0,
          sdy = e.clientY - g.sy0;
        const v = this.trail.velocity();
        d!("start", next.axis, sdx, sdy, v);
        d!("move", next.axis, sdx, sdy, v);
        return;
      }
    }
    const cur = this.g!;
    if (cur.mode === "pan") {
      const r = this.rubber(cur.cx0 - dx / this.s, cur.cy0 - dy / this.s);
      this.cx = r.cx;
      this.cy = r.cy;
      this.apply();
    }
  }
  /** The finger's speed: smoothed on the sheet (p, for panning), and its trail on the screen (for a drag handed to the page). */
  private track(e: PointerEvent, p?: { x: number; y: number }) {
    const now = performance.now(),
      dtm = Math.max(1, now - this.lastMove.t);
    const m = this.lastMove;
    if (p) this.vel = { x: this.vel.x * 0.25 + ((p.x - m.x) / dtm) * 0.75, y: this.vel.y * 0.25 + ((p.y - m.y) / dtm) * 0.75 };
    this.trail.add(e.clientX, e.clientY);
    this.lastMove = { x: p?.x ?? m.x, y: p?.y ?? m.y, t: now };
  }
  private up(e: PointerEvent) {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    const g = this.g;
    if (!g) return;
    if (g.mode === "pinch" && this.pts.size === 1) {
      const p = [...this.pts.values()][0];
      this.g = { mode: "pan", x0: p.x, y0: p.y, sx0: 0, sy0: 0, cx0: this.cx, cy0: this.cy }; // a pan never goes to the page
      this.lastMove = { x: p.x, y: p.y, t: performance.now() };
      this.vel = { x: 0, y: 0 };
      return;
    }
    if (this.pts.size) return;
    this.host.classList.remove("grabbing");
    const p = this.local(e),
      stale = performance.now() - this.lastMove.t > 90;
    if (g.mode === "delegate") this.opts.onDelegate?.("end", g.axis, e.clientX - g.sx0, e.clientY - g.sy0, stale || e.type === "pointercancel" ? { x: 0, y: 0 } : this.trail.velocity());
    else if (g.mode === "pending" && e.type === "pointerup") {
      const now = performance.now();
      if (this.lastTap && now - this.lastTap.t < 320 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 34) {
        this.lastTap = null;
        this.doubleTap(p);
      } else {
        this.lastTap = { t: now, x: p.x, y: p.y };
        this.opts.onTap?.(p);
      }
    } else if (g.mode === "pan") this.fling(stale ? { x: 0, y: 0 } : this.vel);
    else if (g.mode === "pinch") this.settle();
    this.g = null;
  }
  private wheel(e: WheelEvent) {
    e.preventDefault();
    this.stop();
    const { w, h } = this.dims(),
      p = this.local(e);
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const c = this.constrain(this.s, this.cx + e.deltaX / this.s, this.cy);
      this.cx = c.cx;
      this.apply();
      return;
    }
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022));
    const ns = clamp(this.s * k, this.fitS, this.maxS);
    const Px = this.cx + (p.x - w / 2) / this.s,
      Py = this.cy + (p.y - h / 2) / this.s;
    this.s = ns;
    const c = this.constrain(ns, Px - (p.x - w / 2) / ns, Py - (p.y - h / 2) / ns);
    this.cx = c.cx;
    this.cy = c.cy;
    this.apply();
  }

  /* ---------- tiles ---------- */
  /** Load the tiles that make the part in view sharp; keep the previous level's until the new ones are in. */
  private updateTiles() {
    if (this.dead || !this.s) return;
    const { w, h } = this.dims();
    const need = W * this.s * (devicePixelRatio || 1); // screen pixels across the whole page
    const z = Math.min(this.maxZ, Math.max(0, Math.ceil(Math.log2(need / TILE))));
    if (need <= 2048 * 1.05 || z < 2) {
      // the 2048 page picture is sharp enough here
      for (const [, t] of this.tiles) t.img.remove();
      this.tiles.clear();
      this.tileZ = -1;
      return;
    }
    const n = 2 ** z;
    const vx0 = (this.cx - w / this.s / 2) / W,
      vy0 = (this.cy - h / this.s / 2) / this.H;
    const vx1 = (this.cx + w / this.s / 2) / W,
      vy1 = (this.cy + h / this.s / 2) / this.H;
    const want = new Set<string>();
    const base = `${this.base}/tile`;
    for (let x = Math.max(0, Math.floor(vx0 * n) - 1); x <= Math.min(n - 1, Math.floor(vx1 * n) + 1); x++)
      for (let y = Math.max(0, Math.floor(vy0 * n) - 1); y <= Math.min(n - 1, Math.floor(vy1 * n) + 1); y++) {
        const key = `${z}/${x}/${y}`;
        want.add(key);
        if (this.tiles.has(key)) continue;
        const img = el("image", { x: (x / n) * W, y: (y / n) * this.H, width: W / n + 0.5, height: this.H / n + 0.5, preserveAspectRatio: "none", opacity: 0 }, this.tilesG);
        const rec = { img, z, loaded: false };
        img.addEventListener("load", () => {
          rec.loaded = true;
          img.setAttribute("opacity", "1");
          this.dropOldLevels(z, want);
        });
        img.setAttribute("href", `${base}/${key}.png`);
        this.tiles.set(key, rec);
      }
    this.tileZ = z;
    // too many: drop the furthest from the middle of the view
    if (this.tiles.size > MAX_TILES) {
      const mid = { x: (vx0 + vx1) / 2, y: (vy0 + vy1) / 2 };
      const far = [...this.tiles.entries()]
        .filter(([k]) => !want.has(k))
        .map(([k, t]) => {
          const [tz, tx, ty] = k.split("/").map(Number);
          const m = 2 ** tz;
          return { k, t, d: Math.hypot((tx + 0.5) / m - mid.x, (ty + 0.5) / m - mid.y) };
        })
        .sort((a, b) => b.d - a.d);
      for (const f of far.slice(0, this.tiles.size - MAX_TILES)) {
        f.t.img.remove();
        this.tiles.delete(f.k);
      }
    }
  }
  /** Once every wanted tile at level z is in, tiles from other levels can go. */
  private dropOldLevels(z: number, want: Set<string>) {
    if (z !== this.tileZ) return;
    for (const k of want) if (!this.tiles.get(k)?.loaded) return;
    for (const [k, t] of this.tiles)
      if (t.z !== z) {
        t.img.remove();
        this.tiles.delete(k);
      }
  }
  /** Tiles currently on the page (tests). */
  get tileCount() {
    return this.tiles.size;
  }

  destroy() {
    this.dead = true;
    this.stop();
    if (this.tileTimer) clearTimeout(this.tileTimer);
    this.ro.disconnect();
  }
}

/**
 * The tile pictures a viewer w × h px would load to show a page at this view, by the same rule as updateTiles() (one
 * tile's margin round what's in view; none when the 2048 picture is sharp enough). For keeping a pinned sheet on the
 * phone (Stage 13.2). base: the page's route; maxZ: from its details (GET base).
 */
export function tileUrlsFor(base: string, aspect: number, maxZ: number, view: ViewState, w: number, h: number, dpr: number): string[] {
  const H = W / (aspect || Math.SQRT2);
  const s = Math.min(w / W, h / H) * 0.95 * Math.max(1, view.s);
  const need = W * s * (dpr || 1);
  const z = Math.min(maxZ, Math.max(0, Math.ceil(Math.log2(need / TILE))));
  if (need <= 2048 * 1.05 || z < 2) return [];
  const n = 2 ** z;
  const cx = view.cx * W,
    cy = view.cy * H;
  const vx0 = (cx - w / s / 2) / W,
    vy0 = (cy - h / s / 2) / H,
    vx1 = (cx + w / s / 2) / W,
    vy1 = (cy + h / s / 2) / H;
  const out: string[] = [];
  for (let x = Math.max(0, Math.floor(vx0 * n) - 1); x <= Math.min(n - 1, Math.floor(vx1 * n) + 1); x++)
    for (let y = Math.max(0, Math.floor(vy0 * n) - 1); y <= Math.min(n - 1, Math.floor(vy1 * n) + 1); y++) out.push(`${base}/tile/${z}/${x}/${y}.png`);
  return out;
}

/** What the apps need from anything that zooms on a page: a drawing sheet or reference page, or a sketch (Stage 8.5). */
export type Zoomable = Pick<SheetViewer, "zoomIn" | "zoomOut" | "zoomBy" | "getView" | "setView" | "zoomPct" | "destroy" | "cx" | "cy"> & {
  focus(box: Box, mark?: Mark): void;
  setMarks(marks: Mark[]): void;
};
