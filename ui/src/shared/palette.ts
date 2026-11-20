export { derive, contrast, report } from "./brand/colour-checks";
// Bot colours can change with the day. Buttons and links keep the brand accent in tokens.css.

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

export const hex = (h: string): RGB => h.match(/[a-f\d]{2}/gi)!.map(n => parseInt(n, 16)) as RGB;
const toHex = (c: RGB) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (a: RGB, b: RGB, t: number) => a.map((v, i) => v + (b[i] - v) * t) as RGB;
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

function paint() {
  const root = document.documentElement;
  const st = root.style;
  const k = S.moodK * S.moodCol.mix;
  const mb = hex(S.moodCol.base),
    mt = hex(S.moodCol.tint);
  st.setProperty("--peb-1", toHex(mix(S.cur.tint, mt, k)));
  st.setProperty("--peb-2", toHex(mix(S.cur.base, mb, k)));
  st.setProperty("--peb-glow", toHex(mb));
  st.setProperty("--peb-glow-a", (S.moodK * S.moodCol.glow).toFixed(3));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(root).getPropertyValue("--bg").trim());
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
  if (S.moodK !== S.moodTo) {
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
  S.from = S.cur;
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
