// Pebble's colour of the day, and the app accent that follows it (DESIGN §3.5–3.8; ported from mockups/v2/src/palette.js
// with the same numbers). Each day is two hand-picked colours (a lit tint and a base). Everything else (button fill,
// button text, accent text, the ring on a drawing) is derived and pushed until it passes contrast: ring on white paper
// >= 3:1, button text >= 4.5:1, accent text >= 4.5:1 on the page. Colour changes and moments blend, never jump.

type RGB = [number, number, number];
export type Day = { day: string; short: string; name: string; base: string; tint: string };
export type MoodName = "ok" | "done" | "error";

const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// index = Date.getDay(): 0 Sunday ... 6 Saturday
export const DAYS: Day[] = [
  { day: "Sunday", short: "Sun", name: "Slate", base: "#4F7191", tint: "#C2D5E6" },
  { day: "Monday", short: "Mon", name: "Blue", base: "#2F68DA", tint: "#ADC8FF" },
  { day: "Tuesday", short: "Tue", name: "Teal", base: "#0C8A8E", tint: "#8EE2DC" },
  { day: "Wednesday", short: "Wed", name: "Orange", base: "#E8611A", tint: "#FFC08F" },
  { day: "Thursday", short: "Thu", name: "Pink", base: "#D1479C", tint: "#FFBCE2" },
  { day: "Friday", short: "Fri", name: "Sky", base: "#1B8CD0", tint: "#A6DDFA" },
  { day: "Saturday", short: "Sat", name: "Plum", base: "#9450B4", tint: "#DDBDF0" },
];
/** Setting names (store/settings.ts COLOURS) to their day. */
export const COLOUR_DAY: Record<string, Day> = Object.fromEntries(DAYS.map((d) => [d.name.toLowerCase(), d]));

// meaning colours, kept out of the weekday family: gold-amber, true green, true red
export const MOODS: Record<MoodName, { base: string; tint: string; mix: number; glow: number }> = {
  ok: { base: "#E8A600", tint: "#FFE38A", mix: 0.78, glow: 0.62 },
  done: { base: "#1FA45A", tint: "#A6EDC0", mix: 0.85, glow: 0.45 },
  error: { base: "#DA2B2B", tint: "#FFB0A8", mix: 0.85, glow: 0.45 },
};

export const hex = (h: string): RGB => {
  h = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
};
const toHex = (c: RGB) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const mix = (a: RGB, b: RGB, t: number) => a.map((v, i) => v + (b[i] - v) * t) as RGB;
const lin = (v: number) => {
  v /= 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const lum = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export const contrast = (a: RGB, b: RGB) => {
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const BLACK: RGB = [0, 0, 0],
  WHITE: RGB = [255, 255, 255];
const PAPER = hex("#FFFFFF"),
  PAPER_DARK = hex("#E5E6E2"),
  BG_L = hex("#F3F4F2"),
  RAISED_D = hex("#15181B");
const DARK_TEXT = hex("#160E08");
const push = (c: RGB, toward: RGB, ok: (x: RGB) => boolean) => {
  let x = c;
  for (let i = 0; i < 60 && !ok(x); i++) x = mix(x, toward, 0.04);
  return x;
};

export function derive(base: RGB, tint: RGB) {
  const ring = push(base, BLACK, (c) => contrast(c, PAPER) >= 3.1 && contrast(c, PAPER_DARK) >= 3);
  // light theme button: whichever text colour needs the smaller nudge
  const wFill = push(ring, BLACK, (c) => contrast(c, WHITE) >= 4.6);
  const dFill = push(ring, WHITE, (c) => contrast(c, DARK_TEXT) >= 4.6 && contrast(c, BG_L) >= 1.6);
  const useWhite = contrast(ring, WHITE) >= contrast(ring, DARK_TEXT) || contrast(dFill, BG_L) < 1.6;
  const fillL = useWhite ? wFill : dFill,
    onL = useWhite ? WHITE : DARK_TEXT;
  const inkL = push(base, BLACK, (c) => contrast(c, BG_L) >= 4.7 && contrast(c, WHITE) >= 4.9);
  // dark theme: a brighter fill with dark text, and a lighter text accent
  const fillD = push(mix(base, tint, 0.22), WHITE, (c) => contrast(c, DARK_TEXT) >= 4.8);
  const inkD = push(mix(base, tint, 0.35), WHITE, (c) => contrast(c, RAISED_D) >= 5);
  return {
    ring,
    fillL,
    onL,
    inkL,
    fillD,
    onD: DARK_TEXT,
    inkD,
    base,
    tint,
    checks: {
      ringWhite: contrast(ring, PAPER),
      ringPaperDark: contrast(ring, PAPER_DARK),
      btnL: contrast(fillL, onL),
      btnD: contrast(fillD, DARK_TEXT),
      inkL: contrast(inkL, BG_L),
      inkD: contrast(inkD, RAISED_D),
    },
  };
}

const S = {
  cur: { base: hex(DAYS[3].base), tint: hex(DAYS[3].tint) },
  from: null as null | { base: RGB; tint: RGB },
  to: null as null | { base: RGB; tint: RGB },
  t0: 0,
  dur: 900,
  mood: null as MoodName | null,
  moodK: 0,
  moodFrom: 0,
  moodTo: 0,
  moodT0: 0,
  moodDur: 400,
  moodCol: MOODS.ok,
  raf: 0,
  hold: 0 as ReturnType<typeof setTimeout> | 0,
  held: null as MoodName | null,
};
const rgba = (c: RGB, a: number) => `rgba(${c.map(Math.round).join(",")},${a})`;

function paint() {
  const root = document.documentElement;
  const d = derive(S.cur.base, S.cur.tint);
  const st = root.style;
  st.setProperty("--d-ring", toHex(d.ring));
  st.setProperty("--d-accent-l", toHex(d.fillL));
  st.setProperty("--d-on-l", toHex(d.onL));
  st.setProperty("--d-ink-l", toHex(d.inkL));
  st.setProperty("--d-soft-l", rgba(d.base, 0.13));
  st.setProperty("--d-accent-d", toHex(d.fillD));
  st.setProperty("--d-on-d", toHex(d.onD));
  st.setProperty("--d-ink-d", toHex(d.inkD));
  st.setProperty("--d-soft-d", rgba(d.fillD, 0.16));
  const k = S.moodK * (S.moodCol.mix || 0.8);
  const mb = hex(S.moodCol.base),
    mt = hex(S.moodCol.tint);
  st.setProperty("--peb-1", toHex(mix(S.cur.tint, mt, k)));
  st.setProperty("--peb-2", toHex(mix(S.cur.base, mb, k)));
  st.setProperty("--peb-glow", toHex(mb));
  st.setProperty("--peb-glow-a", (S.moodK * (S.moodCol.glow || 0.5)).toFixed(3));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getComputedStyle(root).getPropertyValue("--bg").trim() || "#F3F4F2");
}
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
function loop(now: number) {
  let busy = false;
  if (S.to && S.from) {
    const p = Math.min(1, (now - S.t0) / S.dur),
      e = ease(p);
    S.cur = { base: mix(S.from.base, S.to.base, e), tint: mix(S.from.tint, S.to.tint, e) };
    if (p >= 1) S.to = null;
    else busy = true;
  }
  if (S.moodFrom !== S.moodTo || S.moodK !== S.moodTo) {
    const p = Math.min(1, (now - S.moodT0) / S.moodDur);
    S.moodK = S.moodFrom + (S.moodTo - S.moodFrom) * ease(p);
    if (p >= 1) {
      S.moodK = S.moodTo;
      S.moodFrom = S.moodTo;
      if (S.moodTo === 0) S.mood = null;
    } else busy = true;
  }
  paint();
  S.raf = busy ? requestAnimationFrame(loop) : 0;
}
const kick = () => {
  if (!S.raf) S.raf = requestAnimationFrame(loop);
};

export function blendTo(c: { base: string; tint: string }, ms = 900) {
  const target = { base: hex(c.base), tint: hex(c.tint) };
  if (reduce()) ms = 1;
  S.from = { base: [...S.cur.base] as RGB, tint: [...S.cur.tint] as RGB };
  S.to = target;
  S.t0 = performance.now();
  S.dur = ms;
  kick();
}
function moodTo(k: number, ms: number) {
  S.moodFrom = S.moodK;
  S.moodTo = k;
  S.moodT0 = performance.now();
  S.moodDur = reduce() ? 1 : ms;
  kick();
}
/** Hold a meaning colour (needs your OK) until cleared with hold(null). */
export function hold(name: MoodName | null) {
  if (S.hold) clearTimeout(S.hold);
  S.held = name;
  if (!name) {
    if (S.mood === "ok") moodTo(0, 700);
    return;
  }
  S.mood = name;
  S.moodCol = MOODS[name];
  moodTo(1, 600);
}
/** A short wash (done, went wrong), then ease back to the day colour, or to the held colour if one is held. */
export function flash(name: MoodName, ms = 1000) {
  if (S.hold) clearTimeout(S.hold);
  S.mood = name;
  S.moodCol = MOODS[name];
  moodTo(1, 280);
  S.hold = setTimeout(() => {
    if (S.held) hold(S.held);
    else moodTo(0, 800);
  }, 280 + ms);
}
export function setNow(c: { base: string; tint: string }) {
  S.cur = { base: hex(c.base), tint: hex(c.tint) };
  S.to = null;
  paint();
}
export const currentMood = () => S.mood;

/** Every day's contrast measurements, for tests and the gallery. */
export function report() {
  return DAYS.map((d) => ({ day: d.short, name: d.name, ...derive(hex(d.base), hex(d.tint)).checks }));
}

/**
 * The colour Pebble should be now, from the settings (DESIGN §3.6 order: a "today only" override, then a fixed colour,
 * then the weekday's colour in the owner's time zone).
 */
export function colourFor(settings: Record<string, unknown>, now = new Date()): Day {
  const o = settings["ui.colour_override"] as { colour: string; until: string } | null | undefined;
  if (o && new Date(o.until) > now && COLOUR_DAY[o.colour]) return COLOUR_DAY[o.colour];
  if (settings["ui.pebble_colour_mode"] === "fixed" && COLOUR_DAY[String(settings["ui.pebble_fixed_colour"])]) return COLOUR_DAY[String(settings["ui.pebble_fixed_colour"])];
  return DAYS[weekday(now, String(settings["time.zone"] ?? ""))];
}

/** Day of the week (0 Sunday) in a time zone; the device's own if the zone is unknown. */
export function weekday(now: Date, tz: string) {
  try {
    const name = now.toLocaleDateString("en-AU", { timeZone: tz || undefined, weekday: "long" });
    const i = DAYS.findIndex((d) => d.day === name);
    if (i >= 0) return i;
  } catch {}
  return now.getDay();
}
