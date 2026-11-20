// The sketch pad (Stage 8.5 Part B): a full-screen page the owner draws on with a finger (or a mouse or pen on the PC),
// on blank paper or over a photo he just sent, to get across what he means. Send flattens it to a picture and hands it
// to the caller, which posts it to the assistant. Loaded only when first opened (the phone's first load stays small).
//
// Bare on purpose: five controls along the bottom (Close, Undo, Clear, the ink, Send) and, if the assistant asked for
// something, its question in one small line at the top that fades once drawing starts.
//   - Blank paper is always white with dark ink, whatever the theme, so the picture the model sees is always the same.
//   - One finger draws. A second finger down cancels the stroke in progress (no pinch-zoom here).
//   - Strokes are kept as points and redrawn, so turning the phone or resizing the window never stretches them.
//   - A failed send keeps everything on screen: nothing he drew is ever lost to a failed send.
import "./pad.css";

export type PadOver = { file: string; src: string; w: number; h: number };
export type PadOpts = {
  prompt?: string;
  over?: PadOver;
  /** Post the picture. Throw (or reject) to keep the pad open with "Couldn't send it." */
  onSend: (picture: Blob, info: { w: number; h: number; over?: string }) => Promise<void>;
  onClose?: () => void;
  /** Told when the pad opens and closes, so the app can report "the sketch pad is open". */
  onState?: (open: boolean) => void;
};

type P = [number, number];
type Stroke = { ink: "dark" | "red"; pts: P[] };

const INK = { dark: "#15181B", red: "#D7261E" };
const BLANK_LONG = 2048;
const PHOTO_LONG = 2560;
const ICON = {
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  undo: '<path d="M9 7 4.5 11.5 9 16"/><path d="M5 11.5h9.5a5 5 0 0 1 0 10H12"/>',
  clear: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
};
const svg = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

let current: Pad | null = null;
export const padOpen = () => !!current;

/** Open the pad (one at a time: opening again replaces what's there only if nothing is drawn). */
export function openPad(o: PadOpts) {
  if (current && current.strokes.length) return current;
  current?.close(true);
  current = new Pad(o);
  return current;
}

class Pad {
  readonly root: HTMLElement;
  strokes: Stroke[] = [];
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ink: "dark" | "red" = "dark";
  private live: Stroke | null = null;
  private pointers = new Set<number>();
  private blocked = false; // a second finger came down: nothing draws until every finger is up
  private photo: HTMLImageElement | null = null;
  private sending = false;
  private ro: ResizeObserver;

  constructor(private o: PadOpts) {
    const r = document.createElement("div");
    this.root = r;
    r.className = `pad${o.over ? " over" : ""}`;
    r.setAttribute("role", "dialog");
    r.setAttribute("aria-label", "Sketch pad");
    r.dataset.strokes = "0";
    r.innerHTML =
      `<canvas class="pad-c" aria-label="Draw here"></canvas>` +
      (o.prompt ? `<p class="pad-q"></p>` : "") +
      `<p class="pad-msg" role="status" hidden></p>` +
      `<div class="pad-ask" hidden><p>Throw this away?</p><div><button type="button" data-a="keep">Keep it</button><button type="button" data-a="toss" class="danger">Throw away</button></div></div>` +
      `<nav class="pad-bar">` +
      `<button type="button" data-a="close" aria-label="Close">${svg(ICON.close)}</button>` +
      `<button type="button" data-a="undo" aria-label="Undo">${svg(ICON.undo)}</button>` +
      `<button type="button" data-a="clear" aria-label="Clear">${svg(ICON.clear)}</button>` +
      `<button type="button" data-a="ink" class="ink" aria-label="Ink: dark. Tap for red" data-ink="dark"><i></i></button>` +
      `<button type="button" data-a="send" class="send" aria-label="Send">${svg(ICON.send)}<svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="16"/></svg></button>` +
      `</nav>`;
    if (o.prompt) r.querySelector(".pad-q")!.textContent = o.prompt;
    document.body.appendChild(r);
    this.canvas = r.querySelector("canvas")!;
    this.ctx = this.canvas.getContext("2d")!;
    if (o.over) {
      const img = new Image();
      img.onload = () => this.draw();
      img.src = o.over.src;
      this.photo = img;
    }
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("pointercancel", (e) => this.up(e, true));
    // belt and braces with touch-action:none: the page must never scroll, zoom or bounce while drawing
    for (const t of ["touchstart", "touchmove"]) this.canvas.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    r.querySelector(".pad-bar")!.addEventListener("click", (e) => this.act((e.target as Element).closest<HTMLElement>("[data-a]")?.dataset.a));
    r.querySelector(".pad-ask")!.addEventListener("click", (e) => this.act((e.target as Element).closest<HTMLElement>("[data-a]")?.dataset.a));
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.canvas);
    requestAnimationFrame(() => r.classList.add("in"));
    o.onState?.(true);
  }

  /* ---------- where things are: paper units, so a resize or turn never stretches anything ---------- */
  // Blank: points are relative to the canvas centre in units of its shorter side. Photo: points are in the photo's pixels.
  private box() {
    const w = this.canvas.clientWidth,
      h = this.canvas.clientHeight;
    if (this.o.over) {
      const s = Math.min(w / this.o.over.w, h / this.o.over.h);
      return { w, h, s, x0: (w - this.o.over.w * s) / 2, y0: (h - this.o.over.h * s) / 2 };
    }
    const s = Math.min(w, h);
    return { w, h, s, x0: w / 2, y0: h / 2 };
  }
  private toPaper(x: number, y: number): P {
    const b = this.box();
    return [(x - b.x0) / b.s, (y - b.y0) / b.s];
  }
  /** Line width in paper units: about 4 px on screen. */
  private lineWidth() {
    return 4 / this.box().s;
  }

  /* ---------- drawing ---------- */
  private draw() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const b = this.box();
    if (this.canvas.width !== Math.round(b.w * dpr) || this.canvas.height !== Math.round(b.h * dpr)) {
      this.canvas.width = Math.round(b.w * dpr);
      this.canvas.height = Math.round(b.h * dpr);
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, b.w, b.h);
    if (this.o.over) {
      c.fillStyle = "#0B0D0E";
      c.fillRect(0, 0, b.w, b.h);
      if (this.photo?.complete && this.photo.naturalWidth) c.drawImage(this.photo, b.x0, b.y0, this.o.over.w * b.s, this.o.over.h * b.s);
    } else {
      c.fillStyle = "#FFFFFF";
      c.fillRect(0, 0, b.w, b.h);
    }
    c.save();
    c.translate(b.x0, b.y0);
    c.scale(b.s, b.s);
    this.paint(c, this.lineWidth());
    c.restore();
  }
  /** All strokes, smoothed with midpoint curves; over a photo each gets a thin white edge so it shows on anything. */
  private paint(c: CanvasRenderingContext2D, lw: number) {
    const all = this.live ? [...this.strokes, this.live] : this.strokes;
    c.lineCap = "round";
    c.lineJoin = "round";
    for (const pass of this.o.over ? ["edge", "ink"] : ["ink"]) {
      for (const s of all) {
        c.strokeStyle = pass === "edge" ? "#FFFFFF" : INK[s.ink];
        c.lineWidth = pass === "edge" ? lw * 1.9 : lw;
        c.beginPath();
        const p = s.pts;
        c.moveTo(p[0][0], p[0][1]);
        if (p.length === 1) c.lineTo(p[0][0] + 0.0001, p[0][1]);
        for (let i = 1; i < p.length - 1; i++) c.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
        if (p.length > 1) c.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
        c.stroke();
      }
    }
  }

  /* ---------- the finger ---------- */
  private local(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return this.toPaper(e.clientX - r.left, e.clientY - r.top);
  }
  private down(e: PointerEvent) {
    if (this.sending) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    this.pointers.add(e.pointerId);
    if (this.pointers.size > 1) {
      // a second finger: that's not drawing (a palm, or trying to zoom). Drop the stroke in progress.
      this.live = null;
      this.blocked = true;
      this.draw();
      return;
    }
    if (this.blocked) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {}
    this.live = { ink: this.ink, pts: [this.local(e)] };
    this.root.classList.add("drawing");
    this.draw();
  }
  private move(e: PointerEvent) {
    if (!this.live || this.blocked || !this.pointers.has(e.pointerId)) return;
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) {
      const p = this.local(ev);
      const last = this.live.pts[this.live.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) * this.box().s >= 1.2) this.live.pts.push(p);
    }
    this.draw();
  }
  private up(e: PointerEvent, cancelled = false) {
    this.pointers.delete(e.pointerId);
    if (this.live && !this.blocked && !cancelled) {
      this.strokes.push(this.live);
      this.changed();
    }
    this.live = null;
    if (!this.pointers.size) this.blocked = false;
    this.draw();
  }
  private changed() {
    this.root.dataset.strokes = String(this.strokes.length);
    this.say("");
  }

  /* ---------- the controls ---------- */
  private act(a: string | undefined) {
    if (!a || (this.sending && a !== "keep")) return;
    const ask = this.root.querySelector<HTMLElement>(".pad-ask")!;
    if (a === "close") {
      if (!this.strokes.length) return this.close();
      ask.hidden = false;
      (ask.querySelector('[data-a="keep"]') as HTMLElement).focus();
    } else if (a === "keep") ask.hidden = true;
    else if (a === "toss") this.close();
    else if (a === "undo") {
      this.strokes.pop();
      this.changed();
      this.draw();
    } else if (a === "clear") {
      this.strokes = [];
      this.changed();
      this.draw();
    } else if (a === "ink") {
      this.ink = this.ink === "dark" ? "red" : "dark";
      const b = this.root.querySelector<HTMLElement>('[data-a="ink"]')!;
      b.dataset.ink = this.ink;
      b.setAttribute("aria-label", this.ink === "dark" ? "Ink: dark. Tap for red" : "Ink: red. Tap for dark");
    } else if (a === "send") void this.send();
  }
  private say(t: string) {
    const m = this.root.querySelector<HTMLElement>(".pad-msg")!;
    m.textContent = t;
    m.hidden = !t;
  }

  /** The drawing as a picture: blank paper as PNG (2,048 px at most on its long side), or the photo at its own size
   *  (2,560 px at most) with the marks on it, as JPEG. The photo itself is never changed. */
  async picture(): Promise<{ blob: Blob; w: number; h: number }> {
    const c = document.createElement("canvas");
    const x = c.getContext("2d")!;
    if (this.o.over) {
      const k = Math.min(1, PHOTO_LONG / Math.max(this.o.over.w, this.o.over.h));
      c.width = Math.round(this.o.over.w * k);
      c.height = Math.round(this.o.over.h * k);
      if (this.photo?.complete && this.photo.naturalWidth) x.drawImage(this.photo, 0, 0, c.width, c.height);
      x.scale(k, k);
      // the same thickness relative to the photo as on screen
      this.paint(x, this.lineWidth());
      return { blob: await toBlob(c, "image/jpeg", 0.9), w: c.width, h: c.height };
    }
    // Blank: everything he can see now, and anything drawn outside it (after turning the phone).
    const b = this.box();
    let x0 = -b.x0 / b.s,
      y0 = -b.y0 / b.s,
      x1 = (b.w - b.x0) / b.s,
      y1 = (b.h - b.y0) / b.s;
    for (const s of this.strokes) for (const [px, py] of s.pts) (x0 = Math.min(x0, px - 0.03), y0 = Math.min(y0, py - 0.03), x1 = Math.max(x1, px + 0.03), y1 = Math.max(y1, py + 0.03));
    const k = BLANK_LONG / Math.max(x1 - x0, y1 - y0);
    c.width = Math.round((x1 - x0) * k);
    c.height = Math.round((y1 - y0) * k);
    x.fillStyle = "#FFFFFF";
    x.fillRect(0, 0, c.width, c.height);
    x.scale(k, k);
    x.translate(-x0, -y0);
    this.paint(x, this.lineWidth());
    return { blob: await toBlob(c, "image/png"), w: c.width, h: c.height };
  }

  private async send() {
    if (!this.strokes.length) return this.say("Draw something first.");
    this.sending = true;
    this.root.classList.add("sending");
    this.say("");
    try {
      const p = await this.picture();
      await this.o.onSend(p.blob, { w: p.w, h: p.h, over: this.o.over?.file });
      this.close();
    } catch {
      this.say("Couldn't send it. Tap Send to try again.");
    } finally {
      this.sending = false;
      this.root.classList.remove("sending");
    }
  }

  close(quiet = false) {
    this.ro.disconnect();
    this.root.remove();
    if (current === this) current = null;
    if (!quiet) this.o.onClose?.();
    this.o.onState?.(false);
  }
}

const toBlob = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("no picture"))), type, q));
