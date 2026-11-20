// A sketch the assistant described (Stage 8.5 Part A), drawn by the app: lines, members at real size, arcs, dimensions,
// angles and labels, in millimetres with y up. Built with createElementNS and textContent only (no HTML from the brain,
// the content security policy unchanged). Everything is redrawn in screen pixels at each zoom, so line weights and text
// stay the same size whatever the scale. Fits the screen with a margin; pinch, drag, wheel and double-tap zoom it; at
// the whole-sketch zoom a sideways or downward drag goes to the page (next result, put it away), like a sheet.
// Under every sketch the app writes one fixed line: "Sketch only. Check the sizes before you rely on it."
import "./sketch.css";
import type { Pt, SketchPayload, SketchShape } from "../../../../src/shared/protocol";
import type { Delegate, ViewState } from "../sheet-viewer/viewer";
import { Trail } from "../trail";

const NS = "http://www.w3.org/2000/svg";
export const SKETCH_FOOT = "Sketch only. Check the sizes before you rely on it.";
const MARGIN = 34;
const FONT = 13;
const RAD = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** What a dimension says: its text, or its true length in whole millimetres. */
export const dimText = (s: Extract<SketchShape, { type: "dim" }>) => s.text ?? String(Math.round(Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1])));

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}

/** The drawing's extent in millimetres, dimension lines included. */
function bounds(shapes: SketchShape[]) {
  const xs: number[] = [],
    ys: number[] = [];
  const add = (p: Pt) => (xs.push(p[0]), ys.push(p[1]));
  for (const s of shapes) {
    if (s.type === "line") (add(s.a), add(s.b));
    else if (s.type === "rect") (add([s.x, s.y]), add([s.x + s.w, s.y + s.h]));
    else if (s.type === "poly") s.points.forEach(add);
    else if (s.type === "arc") (add([s.c[0] - s.r, s.c[1] - s.r]), add([s.c[0] + s.r, s.c[1] + s.r]));
    else if (s.type === "dim") {
      const [nx, ny] = normal(s.a, s.b);
      (add(s.a), add(s.b), add([s.a[0] + nx * s.offset, s.a[1] + ny * s.offset]), add([s.b[0] + nx * s.offset, s.b[1] + ny * s.offset]));
    } else if (s.type === "angle") add(s.at);
    else if (s.type === "label") (add(s.at), s.leader && add(s.leader));
  }
  if (!xs.length) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
/** The unit normal to the left of a→b (with y up). */
function normal(a: Pt, b: Pt): [number, number] {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    l = Math.hypot(dx, dy) || 1;
  return [-dy / l, dx / l];
}

export class SketchView {
  readonly host: HTMLElement;
  private svg: SVGSVGElement;
  private box: ReturnType<typeof bounds>;
  private fit = 1; // px per mm at the whole-sketch zoom
  private k = 1; // zoom relative to that
  cx: number; // the centre in view, in mm
  cy: number;
  private pts = new Map<number, { x: number; y: number }>();
  // x0/y0 in the host's pixels; sx0/sy0 on the screen, where a drag handed to the page is measured (see move())
  private g: { mode: "pending" | "pan" | "delegate" | "pinch"; x0: number; y0: number; sx0: number; sy0: number; cx0: number; cy0: number; k0?: number; d0?: number; axis?: "x" | "y" } | null = null;
  /** The finger on the screen: how fast it was going when a drag handed to the page lets go. */
  private trail = new Trail();
  private lastTap = 0;
  private ro: ResizeObserver;

  constructor(
    host: HTMLElement,
    readonly sketch: SketchPayload,
    private opts: { onDelegate?: Delegate; onView?: (v: SketchView) => void } = {},
  ) {
    this.host = host;
    host.classList.add("sv-host", "sk-host");
    this.box = bounds(sketch.shapes);
    this.cx = (this.box.x0 + this.box.x1) / 2;
    this.cy = (this.box.y0 + this.box.y1) / 2;
    this.svg = el("svg", { class: "sk", role: "img", "aria-label": "Sketch" });
    host.appendChild(this.svg);
    const foot = document.createElement("div");
    foot.className = "sk-foot";
    if (sketch.note) {
      const note = document.createElement("p");
      note.className = "sk-note";
      note.textContent = sketch.note;
      foot.appendChild(note);
    }
    const fixed = document.createElement("p");
    fixed.className = "sk-fixed";
    fixed.textContent = SKETCH_FOOT;
    foot.appendChild(fixed);
    host.appendChild(foot);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(host);
    host.addEventListener("pointerdown", (e) => this.down(e));
    host.addEventListener("pointermove", (e) => this.move(e));
    host.addEventListener("pointerup", (e) => this.up(e));
    host.addEventListener("pointercancel", (e) => this.up(e));
    host.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    host.addEventListener("dblclick", (e) => e.preventDefault());
    this.draw();
  }

  /* ---------- the view (same names as the sheet viewer, so the apps treat both alike) ---------- */
  get zoomPct() {
    return Math.round(this.k * 100);
  }
  getView(): ViewState {
    return { s: this.k, cx: this.cx, cy: this.cy };
  }
  setView(v: ViewState) {
    this.k = clamp(v.s, 1, 12);
    this.cx = v.cx;
    this.cy = v.cy;
    this.draw();
  }
  zoomBy(f: number, at?: { x: number; y: number }) {
    const { w, h } = this.dims();
    const p = at ?? { x: w / 2, y: h / 2 };
    const before = this.toMm(p.x, p.y);
    this.k = clamp(this.k * f, 1, 12);
    if (this.k === 1) {
      this.cx = this.home.cx;
      this.cy = this.home.cy;
    } else {
      const after = this.toMm(p.x, p.y);
      this.cx += before[0] - after[0];
      this.cy += before[1] - after[1];
    }
    this.paint(w, h);
  }
  zoomIn() {
    this.zoomBy(2);
  }
  zoomOut() {
    this.k = 1;
    this.zoomBy(1);
  }
  show() {
    this.zoomOut();
  }
  focus() {}
  setMarks() {}
  destroy() {
    this.ro.disconnect();
  }

  private dims() {
    const foot = (this.host.querySelector(".sk-foot") as HTMLElement | null)?.offsetHeight ?? 0;
    return { w: this.host.clientWidth, h: Math.max(10, this.host.clientHeight - foot) };
  }
  private scale() {
    return this.fit * this.k;
  }
  private toPx(p: Pt): [number, number] {
    const { w, h } = this.dims();
    const s = this.scale();
    return [w / 2 + (p[0] - this.cx) * s, h / 2 - (p[1] - this.cy) * s];
  }
  private toMm(x: number, y: number): Pt {
    const { w, h } = this.dims();
    const s = this.scale();
    return [this.cx + (x - w / 2) / s, this.cy - (y - h / 2) / s];
  }

  /* ---------- drawing ---------- */
  /**
   * Draw at the current zoom. At the whole-sketch zoom it first fits the shapes with a margin, then measures what it
   * drew (text included, which keeps its size) and, if anything runs off the edge, shrinks the drawing and re-centres
   * it, up to three times. That fit is remembered, so zooming back out returns to it.
   */
  private draw() {
    const { w, h } = this.dims();
    if (!w || !h) return;
    if (this.k > 1 && this.fitFor === `${w}x${h}`) return this.paint(w, h);
    const bw = Math.max(1, this.box.x1 - this.box.x0),
      bh = Math.max(1, this.box.y1 - this.box.y0);
    this.fit = Math.min((w - MARGIN * 2) / bw, (h - MARGIN * 2) / bh);
    const keep = { k: this.k, cx: this.cx, cy: this.cy };
    this.k = 1;
    this.cx = (this.box.x0 + this.box.x1) / 2;
    this.cy = (this.box.y0 + this.box.y1) / 2;
    for (let i = 0; i < 3; i++) {
      this.paint(w, h, true);
      const bb = this.all?.getBBox();
      if (!bb || !bb.width) break;
      const pad = 10;
      const over = bb.x < pad || bb.y < pad || bb.x + bb.width > w - pad || bb.y + bb.height > h - pad;
      if (!over) break;
      const shrink = Math.min(1, (w - pad * 2) / bb.width, (h - pad * 2) / bb.height);
      this.cx += (bb.x + bb.width / 2 - w / 2) / this.fit;
      this.cy -= (bb.y + bb.height / 2 - h / 2) / this.fit;
      this.fit *= shrink < 1 ? shrink * 0.98 : 1;
    }
    this.home = { cx: this.cx, cy: this.cy };
    this.fitFor = `${w}x${h}`;
    if (keep.k > 1) {
      Object.assign(this, keep);
      this.paint(w, h);
    } else this.opts.onView?.(this);
  }
  private all: SVGGElement | null = null;
  private fitFor = "";
  private home = { cx: 0, cy: 0 };

  private paint(w: number, h: number, quiet = false) {
    this.svg.setAttribute("width", String(w));
    this.svg.setAttribute("height", String(h));
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.svg.replaceChildren();
    const defs = el("defs", {}, this.svg);
    const pat = el("pattern", { id: "sk-hatch", width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    el("line", { x1: 0, y1: 0, x2: 0, y2: 7, class: "sk-hl" }, pat);
    this.all = el("g", { class: "sk-all" }, this.svg);
    const body = el("g", { class: "sk-body" }, this.all);
    const dims = el("g", { class: "sk-dims" }, this.all);
    const texts = el("g", { class: "sk-texts" }, this.all);
    for (const s of this.sketch.shapes) this.shape(s, body, dims, texts);
    if (!quiet) this.opts.onView?.(this);
  }

  private shape(s: SketchShape, body: SVGGElement, dims: SVGGElement, texts: SVGGElement) {
    const P = (p: Pt) => this.toPx(p);
    const fillClass = (f?: string) => (f === "timber" ? "sk-timber" : f === "hatch" ? "sk-hatch" : "sk-nofill");
    switch (s.type) {
      case "line": {
        const [x1, y1] = P(s.a),
          [x2, y2] = P(s.b);
        el("line", { x1, y1, x2, y2, class: `sk-line w${s.weight ?? 2}${s.style === "dashed" ? " dash" : ""}` }, body);
        return;
      }
      case "rect":
      case "poly": {
        const pts: Pt[] = s.type === "rect" ? [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]] : s.points;
        el("polygon", { points: pts.map((p) => P(p).join(",")).join(" "), class: `sk-shape ${fillClass(s.fill)}` }, body);
        return;
      }
      case "arc": {
        const a0 = s.from_deg * RAD,
          a1 = s.to_deg * RAD;
        const p0 = P([s.c[0] + s.r * Math.cos(a0), s.c[1] + s.r * Math.sin(a0)]);
        const p1 = P([s.c[0] + s.r * Math.cos(a1), s.c[1] + s.r * Math.sin(a1)]);
        const sweep = (((s.to_deg - s.from_deg) % 360) + 360) % 360;
        const r = s.r * this.scale();
        el("path", { d: `M${p0[0]},${p0[1]} A${r},${r} 0 ${sweep > 180 ? 1 : 0} 0 ${p1[0]},${p1[1]}`, class: "sk-line w2" }, body);
        return;
      }
      case "dim":
        return this.dim(s, dims, texts);
      case "angle": {
        const at = P(s.at);
        const R = 30;
        const a0 = s.from_deg * RAD,
          a1 = s.to_deg * RAD;
        const q0 = [at[0] + R * Math.cos(a0), at[1] - R * Math.sin(a0)],
          q1 = [at[0] + R * Math.cos(a1), at[1] - R * Math.sin(a1)];
        const sweep = (((s.to_deg - s.from_deg) % 360) + 360) % 360;
        el("path", { d: `M${q0[0]},${q0[1]} A${R},${R} 0 ${sweep > 180 ? 1 : 0} 0 ${q1[0]},${q1[1]}`, class: "sk-dimline" }, dims);
        const mid = (a0 + a1) / 2;
        const label = s.text ?? `${Math.round(sweep * 10) / 10}°`;
        this.text(label, at[0] + (R + 14) * Math.cos(mid), at[1] - (R + 14) * Math.sin(mid), 0, texts, "sk-dimtext", Math.cos(mid) >= 0 ? "start" : "end");
        return;
      }
      case "label": {
        const at = P(s.at);
        if (s.leader) {
          const l = P(s.leader);
          el("line", { x1: at[0], y1: at[1], x2: l[0], y2: l[1], class: "sk-leader" }, dims);
          el("circle", { cx: l[0], cy: l[1], r: 2.6, class: "sk-dot" }, dims);
        }
        const right = !s.leader || s.leader[0] <= s.at[0];
        this.text(s.text, at[0] + (s.leader ? (right ? 5 : -5) : 0), at[1], 0, texts, "sk-label", s.leader ? (right ? "start" : "end") : "middle");
        return;
      }
    }
  }

  /** A dimension: extension lines, the dimension line with ticks, and its text beside the line (never on it). */
  private dim(s: Extract<SketchShape, { type: "dim" }>, g: SVGGElement, texts: SVGGElement) {
    const [nx, ny] = normal(s.a, s.b);
    const a = this.toPx(s.a),
      b = this.toPx(s.b);
    const A = this.toPx([s.a[0] + nx * s.offset, s.a[1] + ny * s.offset]),
      B = this.toPx([s.b[0] + nx * s.offset, s.b[1] + ny * s.offset]);
    // the screen direction from the object out to the dimension line (y flips)
    let ox = A[0] - a[0],
      oy = A[1] - a[1];
    const ol = Math.hypot(ox, oy);
    if (ol < 0.5) {
      ox = nx;
      oy = -ny;
    } else {
      ox /= ol;
      oy /= ol;
    }
    const ext = (p: number[], q: number[]) => el("line", { x1: p[0] + ox * 3, y1: p[1] + oy * 3, x2: q[0] + ox * 5, y2: q[1] + oy * 5, class: "sk-ext" }, g);
    if (ol > 4) (ext(a, A), ext(b, B));
    el("line", { x1: A[0], y1: A[1], x2: B[0], y2: B[1], class: "sk-dimline" }, g);
    const dx = B[0] - A[0],
      dy = B[1] - A[1],
      L = Math.hypot(dx, dy) || 1;
    for (const p of [A, B]) {
      // architectural ticks: short slashes at 45° across the line
      const t = 5;
      const ux = dx / L,
        uy = dy / L;
      el("line", { x1: p[0] - (ux + ox) * t, y1: p[1] - (uy + oy) * t, x2: p[0] + (ux + ox) * t, y2: p[1] + (uy + oy) * t, class: "sk-tick" }, g);
    }
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    // the text sits on the outer side of the line, clear of it, centred along it
    const off = FONT * 0.55 + 4;
    const mx = (A[0] + B[0]) / 2 + ox * off,
      my = (A[1] + B[1]) / 2 + oy * off;
    this.text(dimText(s), mx, my, ang, texts, "sk-dimtext", "middle");
  }

  private text(t: string, x: number, y: number, rot: number, parent: SVGGElement, cls: string, anchor: "start" | "middle" | "end") {
    const e = el("text", { x, y, class: cls, "text-anchor": anchor, "dominant-baseline": "middle", ...(rot ? { transform: `rotate(${rot} ${x} ${y})` } : {}) }, parent);
    e.textContent = t;
  }

  /* ---------- gestures ---------- */
  private local(e: { clientX: number; clientY: number }) {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private down(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    this.pts.set(e.pointerId, this.local(e));
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {}
    if (this.pts.size === 2) {
      if (this.g?.mode === "delegate") this.opts.onDelegate?.("cancel", this.g.axis!, 0, 0, { x: 0, y: 0 });
      const [p, q] = [...this.pts.values()];
      this.g = { mode: "pinch", x0: (p.x + q.x) / 2, y0: (p.y + q.y) / 2, sx0: e.clientX, sy0: e.clientY, cx0: this.cx, cy0: this.cy, k0: this.k, d0: Math.hypot(p.x - q.x, p.y - q.y) || 1 };
      return;
    }
    const p = this.local(e);
    const now = performance.now();
    if (now - this.lastTap < 300) {
      this.lastTap = 0;
      if (this.k > 1.05) this.zoomOut();
      else this.zoomBy(2.5, p);
      this.g = null;
      return;
    }
    this.lastTap = now;
    this.g = { mode: "pending", x0: p.x, y0: p.y, sx0: e.clientX, sy0: e.clientY, cx0: this.cx, cy0: this.cy };
    this.trail.start(e.clientX, e.clientY);
  }
  private move(e: PointerEvent) {
    if (!this.pts.has(e.pointerId) || !this.g) return;
    const g = this.g;
    this.trail.add(e.clientX, e.clientY);
    // A drag handed to the page moves this sketch with the finger, so it's measured on the screen, not against the
    // sketch (which would shrink each step by however far the sketch had already moved: 12.0).
    if (g.mode === "delegate") {
      this.pts.set(e.pointerId, { x: g.x0 + e.clientX - g.sx0, y: g.y0 + e.clientY - g.sy0 });
      return void this.opts.onDelegate?.("move", g.axis!, e.clientX - g.sx0, e.clientY - g.sy0, this.trail.velocity());
    }
    this.pts.set(e.pointerId, this.local(e));
    if (g.mode === "pinch" && this.pts.size >= 2) {
      const [p, q] = [...this.pts.values()];
      const d = Math.hypot(p.x - q.x, p.y - q.y) || 1;
      this.k = g.k0!;
      this.cx = g.cx0;
      this.cy = g.cy0;
      this.zoomBy(d / g.d0!, { x: g.x0, y: g.y0 });
      return;
    }
    const p = this.local(e);
    const dx = p.x - g.x0,
      dy = p.y - g.y0;
    if (g.mode === "pending") {
      if (Math.hypot(dx, dy) < 8) return;
      if (this.k <= 1.02) {
        const axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (this.opts.onDelegate && (axis === "x" || dy > 0) && this.opts.onDelegate("can", axis, 0, 0, { x: 0, y: 0 }) !== false) {
          g.mode = "delegate";
          g.axis = axis;
          this.opts.onDelegate("start", axis, e.clientX - g.sx0, e.clientY - g.sy0, this.trail.velocity());
          return void this.opts.onDelegate("move", axis, e.clientX - g.sx0, e.clientY - g.sy0, this.trail.velocity());
        } else return;
      } else g.mode = "pan";
    }
    const s = this.scale();
    this.cx = g.cx0 - dx / s;
    this.cy = g.cy0 + dy / s;
    this.draw();
  }
  private up(e: PointerEvent) {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    const g = this.g;
    const v = e.type === "pointercancel" ? { x: 0, y: 0 } : this.trail.velocity(); // 0 if it stopped before lifting
    if (g?.mode === "delegate") this.opts.onDelegate?.(e.type === "pointercancel" ? "cancel" : "end", g.axis!, e.clientX - g.sx0, e.clientY - g.sy0, v);
    if (!this.pts.size) this.g = null;
    else if (g?.mode === "pinch") {
      const [q] = [...this.pts.values()];
      this.g = { mode: "pan", x0: q.x, y0: q.y, sx0: 0, sy0: 0, cx0: this.cx, cy0: this.cy }; // a pan never goes to the page
    }
  }
  private wheel(e: WheelEvent) {
    e.preventDefault();
    this.zoomBy(Math.exp(-e.deltaY * 0.0022), this.local(e));
  }
}
