// Tim, the round table's guest (Stage 17.3): a second character in Pebble's family, plainly not Pebble.
// Same build as Pebble (a soft body with a lit tint, a highlight, a rim light, a soft and a contact shadow, the same
// blink, bob and breathing), but his own shape (taller than wide, an upright egg narrowing to the top), round eyes
// instead of tall ones, and his own colour from the same weekday family, chosen so it's never the one Pebble has that day.
// He lights up (a halo in his colour, full colour) when he speaks or thinks, and sits back a little dimmer otherwise.
import "./tim.css";
import { DAYS, derive, hex, type Day } from "../palette";

const NS = "http://www.w3.org/2000/svg";
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const f = (n: number) => Math.round(n * 100) / 100;
let uid = 0;

export type TimState = "idle" | "listening" | "thinking" | "speaking";

/** His colour for the day: teal, unless Pebble is teal or sky that day, then plum. */
export function timDay(pebble: Day): Day {
  const teal = DAYS.find((d) => d.name === "Teal")!;
  const plum = DAYS.find((d) => d.name === "Plum")!;
  return pebble.name === "Teal" || pebble.name === "Sky" ? plum : teal;
}
const toHex = (c: number[]) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
/** Put his colours on the page: the body's two, and his text colour for each theme (passing the same contrast as the accent). */
export function paintTim(pebble: Day) {
  const d = timDay(pebble);
  const x = derive(hex(d.base), hex(d.tint));
  const st = document.documentElement.style;
  st.setProperty("--tim-1", d.tint);
  st.setProperty("--tim-2", d.base);
  st.setProperty("--tim-ink-l", toHex(x.inkL));
  st.setProperty("--tim-ink-d", toHex(x.inkD));
  return d;
}

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

type Params = { gx: number; gy: number; eye: number; blink: number; think: number; talk: number; bob: number; breath: number; lit: number; tilt: number; t: number };

function build(svg: SVGSVGElement, id: string) {
  const defs = el("defs", {}, svg);
  const grad = (type: string, gid: string, attrs: Record<string, number>, stops: [number, string, number?][]) => {
    const g = el(type, { id: gid, ...attrs }, defs);
    stops.forEach(([o, c, op]) => el("stop", { offset: o, style: `stop-color:${c}` + (op != null ? `;stop-opacity:${op}` : "") }, g));
  };
  grad("radialGradient", id + "g", { cx: 0.38, cy: 0.24, r: 0.95 }, [
    [0, "var(--tim-1)"],
    [1, "var(--tim-2)"],
  ]);
  grad("radialGradient", id + "o", { cx: 0.5, cy: 0.5, r: 0.5 }, [
    [0, "var(--tim-2)", 0.55],
    [0.6, "var(--tim-2)", 0.18],
    [1, "var(--tim-2)", 0],
  ]);
  grad("radialGradient", id + "s", { cx: 0.5, cy: 0.5, r: 0.5 }, [
    [0, "var(--shadow)", 1],
    [0.55, "var(--shadow)", 0.55],
    [1, "var(--shadow)", 0],
  ]);
  const halo = el("ellipse", { class: "t-halo", cx: 100, cy: 108, rx: 92, ry: 96, fill: `url(#${id}o)`, opacity: 0 }, svg);
  const soft = el("ellipse", { cx: 100, cy: 179, rx: 56, ry: 8.5, fill: `url(#${id}s)` }, svg);
  const contact = el("ellipse", { class: "c-shadow", cx: 100, cy: 178.5, rx: 27, ry: 3, opacity: 0.9 }, svg);
  const g = el("g", {}, svg);
  const body = el("path", { fill: `url(#${id}g)` }, g);
  el("ellipse", { "data-detail": "", cx: 80, cy: 70, rx: 13, ry: 8, fill: "#fff", opacity: 0.3, transform: "rotate(-32 80 70)" }, g);
  el("path", { "data-detail": "", d: "M141 136C137 155 124 168 108 171", fill: "none", stroke: "#fff", "stroke-width": 3, "stroke-linecap": "round", opacity: 0.13 }, g);
  const eyes = [86, 114].map((x) => ({ x, e: el("ellipse", { class: "c-peye", cx: x, cy: 102, rx: 7, ry: 7 }, g), gl: el("circle", { class: "c-white", cx: x + 2.2, cy: 99.5, r: 2 }, g) }));
  return (P: Params) => {
    const N = 44,
      pts: [number, number][] = [];
    const wob = reduce() ? 0 : 1;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2,
        c = Math.cos(a),
        s = Math.sin(a);
      const r = 1 + wob * (0.01 * Math.sin(3 * a + P.t * 0.7) + 0.007 * Math.sin(4 * a - P.t * 0.5) + P.talk * 0.022 * Math.sin(2 * a + P.t * 8.5));
      // an upright egg: narrower at the top (s < 0), fuller and flat-bottomed below
      const taper = 1 + 0.13 * s;
      const flat = s > 0 ? 1 - 0.1 * s * s : 1;
      pts.push([100 + 51 * Math.sign(c) * Math.pow(Math.abs(c), 2 / 2.15) * r * taper, 110 + 67 * Math.sign(s) * Math.pow(Math.abs(s), 2 / 2.15) * r * flat]);
    }
    body.setAttribute("d", smoothClosed(pts));
    const st = P.breath * 0.012 - P.talk * 0.045;
    g.setAttribute("transform", `translate(${f(P.gx * 1.6)} ${f(P.bob * 0.6)}) translate(100 172) rotate(${f(P.tilt)}) scale(${f(1 - st * 0.7)} ${f(1 + st)}) translate(-100 -172)`);
    soft.setAttribute("rx", String(f(56 * (1 - st * 0.5))));
    contact.setAttribute("rx", String(f(27 * (1 - st * 0.5))));
    halo.setAttribute("opacity", String(f(P.lit * 0.9)));
    for (const e of eyes) {
      const h = Math.max(1.6, 7 * P.eye * (1 - P.blink * 0.9) * (e.x < 100 ? 1 - P.think * 0.25 : 1));
      const cx = e.x + P.gx * 8,
        cy = 102 + P.gy * 6;
      e.e.setAttribute("cx", String(f(cx)));
      e.e.setAttribute("cy", String(f(cy)));
      e.e.setAttribute("ry", String(f(h)));
      e.gl.setAttribute("cx", String(f(cx + 2.2)));
      e.gl.setAttribute("cy", String(f(cy - h + 2.6)));
      e.gl.setAttribute("r", h > 4 ? "2" : "0");
    }
  };
}

/** One Tim per page (mounted wherever he's shown); his own state, separate from Pebble's. */
export class TimAnimator {
  state: TimState = "idle";
  /** 0..1, his speech's loudness while he's talking. */
  level = 0;
  private slots: { host: Element; update: (P: Params) => void }[] = [];
  private P: Params = { gx: 0, gy: 0, eye: 1, blink: 0, think: 0, talk: 0, bob: 0, breath: 0, lit: 0, tilt: 0, t: 0 };
  private last = performance.now() / 1000;
  private blinkAt = 1.4;
  private blinkStart = -9;
  private sacc = { x: 0, y: 0, next: 0 };
  private raf = 0;

  mount(host: Element) {
    host.innerHTML = "";
    const svg = el("svg", { viewBox: "0 14 200 186", class: "lh-char lh-tim", "aria-hidden": "true" }) as SVGSVGElement;
    host.appendChild(svg);
    const update = build(svg, "tim" + ++uid);
    this.slots.push({ host, update });
    update(this.P);
    this.run();
  }
  set(s: TimState) {
    this.state = s;
    for (const sl of this.slots) (sl.host as HTMLElement).dataset.tim = s;
  }
  private run() {
    if (this.raf) return;
    const loop = () => {
      this.raf = 0;
      if (!this.slots.some((s) => s.host.isConnected && (s.host as HTMLElement).getClientRects().length)) return; // nothing showing him
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  /** Shown again after being hidden: pick up the motion. */
  wake() {
    this.last = performance.now() / 1000;
    this.run();
  }
  private tick() {
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
      think = 0,
      talk = 0,
      lit = 0,
      tilt = 0;
    if (s === "thinking") {
      gx = Math.sin(t * 0.8) * 0.5;
      gy = -0.85;
      eye = 0.9;
      think = 1;
      lit = 0.55 + 0.25 * Math.sin(t * 2.2);
      tilt = rm ? 0 : Math.sin(t * 0.7) * 4;
    } else {
      if (t > this.sacc.next) {
        this.sacc = { x: (Math.random() * 2 - 1) * 0.5, y: (Math.random() * 2 - 1) * 0.3, next: t + 1.8 + Math.random() * 2.8 };
      }
      gx = this.sacc.x;
      gy = this.sacc.y;
      if (s === "speaking") {
        gx *= 0.2;
        gy = gy * 0.2 + 0.05;
        lit = 1;
        talk = this.level > 0.01 ? Math.min(0.75, 0.12 + this.level * 6) : 0.12 + 0.6 * Math.abs(Math.sin(t * 9.6) * Math.sin(t * 3.1 + 0.4));
      } else if (s === "listening") {
        // looking across to whoever's talking
        gx = -0.55;
        gy = 0.05;
        eye = 1.08;
      }
    }
    P.gx += (gx - P.gx) * k(s === "thinking" ? 3 : 8);
    P.gy += (gy - P.gy) * k(8);
    P.eye += (eye - P.eye) * k(8);
    P.think += (think - P.think) * k(4);
    P.talk += (talk - P.talk) * k(18);
    P.lit += (lit - P.lit) * k(5);
    P.tilt += (tilt - P.tilt) * k(4);
    if (t > this.blinkAt) {
      this.blinkStart = t;
      this.blinkAt = t + 2.6 + Math.random() * 3.8;
    }
    const b = t - this.blinkStart;
    P.blink = b < 0.07 ? b / 0.07 : b < 0.18 ? 1 - (b - 0.07) / 0.11 : 0;
    P.bob = rm ? 0 : Math.sin(t * 1.1 + 1.3) * 2;
    P.breath = rm ? 0 : Math.sin(t * 1.7 + 0.8);
    for (const sl of this.slots) {
      (sl.host as HTMLElement).style.setProperty("--tim-lit", P.lit.toFixed(3));
      if (sl.host.isConnected && (sl.host as HTMLElement).getClientRects().length) sl.update(P);
    }
  }
}
