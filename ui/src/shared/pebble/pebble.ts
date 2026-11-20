// Pebble: the one Tavi character (DESIGN §3; ported from mockups/v2/src/characters.js with the same numbers).
// Eyes only; expression comes from the eyes and from squash and stretch. Its colour comes from CSS (--pebble-1 /
// --pebble-2, set by palette.ts), so the day colour and the moment colours blend on every copy at once.
// One Animator drives every copy on the page (phone stage and strip, desktop sidebar) so they move as one character.
import "./pebble.css";

const NS = "http://www.w3.org/2000/svg";
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const f = (n: number) => Math.round(n * 100) / 100;
let uid = 0;

export type PebbleState = "idle" | "listening" | "thinking" | "speaking";
type Params = { gx: number; gy: number; eye: number; blink: number; smile: number; think: number; listen: number; hop: number; bob: number; breath: number; sq: number; tilt: number; work: number; scale: number; talk: number; t: number };

function el(tag: string, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}
function smoothClosed(p: [number, number][]) {
  const n = p.length;
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n],
      p1 = p[i],
      p2 = p[(i + 1) % n],
      p3 = p[(i + 2) % n];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}
function grad(defs: Element, type: string, id: string, attrs: Record<string, number>, stops: [number, string, number?][]) {
  const g = el(type, { id, ...attrs }, defs);
  stops.forEach(([o, c, op]) => el("stop", { offset: o, style: `stop-color:${c}` + (op != null ? `;stop-opacity:${op}` : "") }, g));
  return g;
}

function buildPebble(svg: SVGSVGElement, id: string) {
  const defs = el("defs", {}, svg);
  grad(defs, "radialGradient", id + "g", { cx: 0.36, cy: 0.28, r: 0.9 }, [
    [0, "var(--pebble-1)"],
    [1, "var(--pebble-2)"],
  ]);
  grad(defs, "radialGradient", id + "o", { cx: 0.5, cy: 0.5, r: 0.5 }, [
    [0, "var(--peb-glow,#E8A600)", 0.9],
    [0.55, "var(--peb-glow,#E8A600)", 0.35],
    [1, "var(--peb-glow,#E8A600)", 0],
  ]);
  grad(defs, "radialGradient", id + "s", { cx: 0.5, cy: 0.5, r: 0.5 }, [
    [0, "var(--shadow)", 1],
    [0.55, "var(--shadow)", 0.55],
    [1, "var(--shadow)", 0],
  ]);
  grad(defs, "linearGradient", id + "w", { x1: 0, y1: 0, x2: 1, y2: 0 }, [
    [0, "var(--pebble-1)", 0],
    [0.5, "var(--pebble-1)", 0.85],
    [1, "var(--pebble-1)", 0],
  ]);
  const clip = el("clipPath", { id: id + "c" }, defs);
  const clipPath = el("path", {}, clip);
  // a halo for "needs your OK" and the short washes; its strength comes from --peb-glow-a
  el("ellipse", { class: "c-halo", cx: 100, cy: 116, rx: 98, ry: 92, fill: `url(#${id}o)` }, svg);
  const soft = el("ellipse", { cx: 100, cy: 179, rx: 68, ry: 9, fill: `url(#${id}s)` }, svg);
  const contact = el("ellipse", { class: "c-shadow", cx: 100, cy: 178.5, rx: 34, ry: 3.2, opacity: 0.9 }, svg);
  const g = el("g", {}, svg);
  const body = el("path", { fill: `url(#${id}g)` }, g);
  // working in the background: a slow band of the day's own lighter tint drifting across the body
  const shimmerG = el("g", { "clip-path": `url(#${id}c)` }, g);
  const shimmer = el("rect", { x: -60, y: 40, width: 60, height: 150, fill: `url(#${id}w)`, opacity: 0, transform: "skewX(-18)" }, shimmerG);
  el("ellipse", { "data-detail": "", cx: 76, cy: 84, rx: 19, ry: 9, fill: "#fff", opacity: 0.32, transform: "rotate(-28 76 84)" }, g);
  el("path", { "data-detail": "", d: "M150 142C143 158 128 166 110 168", fill: "none", stroke: "#fff", "stroke-width": 3, "stroke-linecap": "round", opacity: 0.14 }, g);
  const eyes = [83, 117].map((x, i) => ({
    x,
    i,
    e: el("rect", { class: "c-peye", x: x - 6.5, y: 98, width: 13, height: 24, rx: 6.5 }, g),
    gl: el("circle", { class: "c-white", cx: x + 2.5, cy: 103, r: 2.2 }, g),
  }));
  return (P: Params) => {
    const N = 44,
      pts: [number, number][] = [];
    const wob = reduce() ? 0 : 1;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2,
        c = Math.cos(a),
        s = Math.sin(a);
      const r = 1 + wob * (0.012 * Math.sin(3 * a + P.t * 0.8) + 0.008 * Math.sin(5 * a - P.t * 0.55) + P.talk * 0.02 * Math.sin(2 * a + P.t * 9));
      const flat = s > 0 ? 1 - 0.08 * s * s : 1;
      pts.push([100 + 66 * Math.sign(c) * Math.pow(Math.abs(c), 2 / 2.35) * r, 116 + 60 * Math.sign(s) * Math.pow(Math.abs(s), 2 / 2.35) * r * flat]);
    }
    const d = smoothClosed(pts);
    body.setAttribute("d", d);
    clipPath.setAttribute("d", d);
    const st = -P.sq * 0.1 + P.listen * 0.055 + P.breath * 0.012 - P.talk * 0.05;
    const sx = (1 - st * 0.75) * P.scale,
      sy = (1 + st) * P.scale;
    const ty = P.bob * 0.6 - P.hop * 16;
    g.setAttribute("transform", `translate(${f(P.gx * 2)} ${f(ty)}) translate(100 172) rotate(${f(P.tilt)}) scale(${f(sx)} ${f(sy)}) translate(-100 -172)`);
    const k = (1 - P.hop * 0.3) * (1 - st * 0.5);
    soft.setAttribute("rx", String(f(68 * k)));
    contact.setAttribute("rx", String(f(34 * k)));
    soft.setAttribute("opacity", String(f(1 - P.hop * 0.45)));
    contact.setAttribute("opacity", String(f(0.9 * (1 - P.hop * 0.5))));
    for (const e of eyes) {
      const squint = e.i === 0 ? 1 - P.think * 0.32 : 1 + P.think * 0.06;
      const h = Math.max(2.2, 24 * P.eye * squint * (1 - P.blink * 0.92) * (1 - P.smile * 0.12));
      const cx = e.x + P.gx * 9,
        cy = 110 + P.gy * 6;
      e.e.setAttribute("x", String(f(cx - 6.5)));
      e.e.setAttribute("y", String(f(cy - h / 2)));
      e.e.setAttribute("height", String(f(h)));
      e.e.setAttribute("rx", String(f(Math.min(6.5, h / 2))));
      e.gl.setAttribute("cx", String(f(cx + 2.4)));
      e.gl.setAttribute("cy", String(f(cy - h / 2 + 4.6)));
      e.gl.setAttribute("r", h > 9 ? "2.2" : "0");
    }
    const sp = ((P.t * 0.16) % 1.4) / 1.4; // one slow pass every ~9 s
    shimmer.setAttribute("x", String(f(-40 + sp * 260)));
    shimmer.setAttribute("opacity", String(f(P.work * 0.75 * Math.sin(Math.min(1, sp) * Math.PI))));
  };
}

function makeCharacter(host: Element) {
  const svg = el("svg", { viewBox: "0 14 200 186", class: "lh-char", "aria-hidden": "true" }) as SVGSVGElement;
  host.appendChild(svg);
  return { svg, update: buildPebble(svg, "lhc" + ++uid), host };
}

/** The animation brain: one per page, driving every mounted copy. */
export class Animator {
  slots: { host: Element; inst: ReturnType<typeof makeCharacter>; hidden?: () => boolean }[] = [];
  state: PebbleState = "idle";
  working = false;
  P: Params = { gx: 0, gy: 0, eye: 1, blink: 0, smile: 0.55, think: 0, listen: 0, hop: 0, bob: 0, breath: 0, sq: 0, tilt: 0, work: 0, scale: 1, talk: 0, t: 0 };
  /** 0..1 from the live voice audio; drives the speaking wobble when set. */
  level = 0;
  onState: ((s: PebbleState) => void) | null = null;
  private sacc = { x: 0, y: 0, next: 0 };
  private blinkAt = 1;
  private blinkStart = -9;
  private hopStart = -9;
  private hops = 1;
  private sqv = 0;
  private pointer = { x: 0, y: 0, t: -99 };
  private last = performance.now() / 1000;
  private raf = 0;

  constructor() {
    const loop = () => {
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    // Nothing to animate while the page is hidden; pick up where it was when it's back.
    document.addEventListener("visibilitychange", () => {
      cancelAnimationFrame(this.raf);
      if (!document.hidden) {
        this.last = performance.now() / 1000;
        this.raf = requestAnimationFrame(loop);
      }
    });
  }
  /** hidden: while it says so, this copy is covered by something else, so it isn't drawn (it picks up again after). */
  mount(host: Element, hidden?: () => boolean) {
    host.innerHTML = "";
    const inst = makeCharacter(host);
    this.slots.push({ host, inst, hidden });
    inst.update(this.P);
    return inst;
  }
  set(state: PebbleState) {
    if (this.state === state) return;
    this.state = state;
    this.onState?.(state);
  }
  attention(times = 2) {
    this.hopStart = this.P.t;
    this.hops = times;
  }
  press() {
    this.sqv += 3.2;
  }
  look(x: number, y: number) {
    this.pointer = { x, y, t: this.P.t };
  }
  tick() {
    const now = performance.now() / 1000,
      dt = Math.min(0.05, Math.max(0.001, now - this.last));
    this.last = now;
    const P = this.P,
      t = (P.t += dt),
      s = this.state,
      rm = reduce();
    const k = (r: number) => 1 - Math.exp(-dt * r);
    let gx = 0,
      gy = 0,
      eye = 1,
      smile = 0.55,
      think = 0,
      listen = 0,
      tilt = 0,
      talk = 0;
    const fresh = t - this.pointer.t < 2.2;
    if (s === "listening") {
      gx = fresh ? this.pointer.x * 0.45 : Math.sin(t * 0.7) * 0.12;
      gy = fresh ? this.pointer.y * 0.35 : 0.12;
      eye = 1.14;
      listen = 1;
      smile = 0.4;
      tilt = rm ? 0 : -3 + Math.sin(t * 1.1) * 3.2;
    } else if (s === "thinking") {
      gx = Math.sin(t * 0.8) * 0.6;
      gy = -0.8;
      eye = 0.88;
      think = 1;
      smile = 0.2;
      tilt = rm ? 0 : Math.sin(t * 0.75) * 5.5;
    } else {
      if (t > this.sacc.next) {
        const glance = this.working && Math.random() < 0.35;
        this.sacc.x = glance ? 0.75 : (Math.random() * 2 - 1) * 0.55;
        this.sacc.y = glance ? -0.85 : (Math.random() * 2 - 1) * 0.32;
        this.sacc.next = t + (glance ? 1.1 : 1.6 + Math.random() * 2.6);
      }
      gx = fresh ? this.pointer.x : this.sacc.x;
      gy = fresh ? this.pointer.y : this.sacc.y;
      if (s === "speaking") {
        gx *= 0.25;
        gy = gy * 0.2 + 0.05;
        smile = 0.75;
        talk = this.level > 0.01 ? Math.min(0.75, 0.12 + this.level * 6) : 0.12 + 0.6 * Math.abs(Math.sin(t * 10.7) * Math.sin(t * 3.3 + 0.6));
      }
    }
    P.gx += (gx - P.gx) * k(s === "thinking" ? 3 : 9);
    P.gy += (gy - P.gy) * k(9);
    P.eye += (eye - P.eye) * k(8);
    P.smile += (smile - P.smile) * k(6);
    P.think += (think - P.think) * k(4);
    P.listen += (listen - P.listen) * k(6);
    P.tilt += (tilt - P.tilt) * k(4);
    P.work += ((this.working ? 1 : 0) - P.work) * k(2);
    P.talk += (talk - P.talk) * k(18);
    if (t > this.blinkAt) {
      this.blinkStart = t;
      this.blinkAt = t + 2.2 + Math.random() * 3.6;
      if (Math.random() < 0.18) this.blinkAt = t + 0.3;
    }
    const b = t - this.blinkStart;
    P.blink = b < 0.07 ? b / 0.07 : b < 0.18 ? 1 - (b - 0.07) / 0.11 : 0;
    const h = t - this.hopStart,
      hd = 0.42;
    P.hop = !rm && h >= 0 && h < hd * this.hops ? Math.abs(Math.sin((Math.PI * h) / hd)) * (1 - (h / (hd * this.hops)) * 0.4) : 0;
    if (h >= 0 && h < 0.05) this.sqv += 1.5;
    this.sqv += (-P.sq * 220 - this.sqv * 14) * dt;
    P.sq += this.sqv * dt;
    P.bob = rm ? 0 : Math.sin(t * 1.25) * 2.2;
    P.breath = rm ? 0 : Math.sin(t * 1.9);
    P.scale = 1 + P.listen * 0.035 + P.breath * 0.006;
    for (const sl of this.slots) if (sl.host.isConnected && !sl.hidden?.() && sl.host.getClientRects().length) sl.inst.update(P);
  }
}
