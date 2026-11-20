// Typed settings the apps can read and change, on top of the settings table (store/proactive.ts getSetting/setSetting).
// The existing keys keep their stored format (plain strings; workdays as JSON), so older readers are unaffected.
// Internal bookkeeping in the same table (keeper position, nightly flag) is not a setting and isn't listed here.
import { z } from "zod";
import { bus } from "../events.js";
import { audit } from "./log.js";
import { getSetting, setSetting } from "./proactive.js";
import { CODE_EDITION_DEFAULT } from "../shared/calc/ncc.js";

export const COLOURS = ["blue", "teal", "orange", "pink", "sky", "plum", "slate"] as const; // Mon..Sun as in palette.js
export type Colour = (typeof COLOURS)[number];

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/; // "7:00" too: older settings were saved that way
const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Each setting: its schema, its default, and whether it's stored as a plain string or as JSON. */
const DEFS = {
  "web.first": { schema: z.enum(["codex", "claude"]), def: "codex", raw: true },
  "finds.enabled": { schema: z.boolean(), def: true, raw: false },
  "finds.dev_schedule": { schema: z.boolean(), def: false, raw: false },
  "finds.looks_day": { schema: z.number().int().min(0).max(12), def: 3, raw: false },
  "finds.minutes": { schema: z.number().min(0.1).max(20), def: 8, raw: false },
  "finds.daily_tokens": { schema: z.number().int().min(1000).max(2_000_000_000), def: 150_000_000, raw: false },
  "finds.look_tokens": { schema: z.number().int().min(1000).max(2_000_000_000), def: 50_000_000, raw: false },
  "finds.pause_until": { schema: z.string().datetime().nullable(), def: null, raw: false },
  brief_time: { schema: z.string().regex(HHMM), def: "06:00", raw: true },
  lunch_time: { schema: z.string().regex(HHMM), def: "12:00", raw: true },
  wrap_time: { schema: z.string().regex(HHMM), def: "15:30", raw: true },
  quiet_start: { schema: z.union([z.literal(""), z.string().regex(HHMM)]), def: "", raw: true },
  quiet_end: { schema: z.union([z.literal(""), z.string().regex(HHMM)]), def: "", raw: true },
  workdays: { schema: z.array(z.number().int().min(0).max(6)).max(7), def: [1, 2, 3, 4, 5], raw: false },
  max_interruptions: { schema: z.number().int().min(0).max(100), def: 0, raw: false },
  "ui.pebble_colour_mode": { schema: z.enum(["daily", "fixed"]), def: "daily", raw: true },
  "ui.pebble_fixed_colour": { schema: z.enum(COLOURS), def: "blue", raw: true },
  "ui.colour_override": { schema: z.object({ colour: z.enum(COLOURS), until: z.string().datetime() }).nullable(), def: null, raw: false },
  "ui.theme": { schema: z.enum(["system", "light", "dark"]), def: "system", raw: true },
  "ui.sound": { schema: z.boolean(), def: true, raw: false },
  "brain.mode": { schema: z.enum(["fast", "balanced", "best"]), def: "balanced", raw: true },
  /** The most one piece of work (a job it takes away to do, Stage 21.1) may take and use: guards against a runaway, not
   *  a cap on ordinary work. When it reaches either, it stops and tells him what it has and what's left. */
  "work.max_minutes": { schema: z.number().int().min(5).max(240), def: 30, raw: false },
  "work.max_usd": { schema: z.number().min(0.5).max(100), def: 6, raw: false },
  /** The owner's reference books folder (Stage 8). Empty: the default (reference/dir.ts). */
  "reference.dir": { schema: z.string().max(500), def: "", raw: true },
  /** Blender for polished renders (Stage 9.6b): its folder or blender.exe. Empty: the newest under Program Files. */
  "blender.path": { schema: z.string().max(500), def: "", raw: true },
  /** Shop drawings' title block (Stage 12): the business name, one line under it, and a logo (a PNG or JPEG's path), all
   *  optional and set by talking (12.10); and the initials for "drawn" and the revision table (else LH). */
  "drawings.company": { schema: z.string().max(80), def: "", raw: true },
  "drawings.company_line": { schema: z.string().max(80), def: "", raw: true },
  "drawings.logo": { schema: z.string().max(500), def: "", raw: true },
  "drawings.drawn_by": { schema: z.string().max(6), def: "", raw: true },
  "time.zone": { schema: z.string().refine(validZone, "not a time zone"), def: process.env.TZ_LOCAL || "Australia/Sydney", raw: true },
  /** The building code edition in force where he works, and the next one with the day it takes over (Stage 14.2). The
   *  trade calculators warn once that day comes until their figures are reviewed for it (src/shared/calc/ncc.ts). */
  "code.edition": {
    schema: z.object({ current: z.string().min(1).max(40), next: z.object({ edition: z.string().min(1).max(40), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).nullable() }),
    def: CODE_EDITION_DEFAULT,
    raw: false,
  },
  /** How long a Siri Shortcut is kept waiting for the answer before "Working on it, I'll send it to your phone" (14.3). */
  "shortcut.wait_s": { schema: z.number().int().min(3).max(120), def: 20, raw: false },
  /** The Brain (separate service): whether the assistant may start it when a job needs it, where it lives (empty:
   *  not set up), and the day's spend after which each step needs his OK again (US dollars, as it reports). */
  "brainlink.autostart": { schema: z.boolean(), def: true, raw: false },
  "brainlink.home": { schema: z.string().max(500), def: "", raw: true },
  "brainlink.daily_usd": { schema: z.number().min(0).max(10_000), def: 60, raw: false },
  /** The round table (Stage 17): a second assistant, run through the Codex program on the owner's OpenAI plan. */
  "guest.enabled": { schema: z.boolean(), def: true, raw: false },
  "guest.name": { schema: z.string().min(1).max(24).regex(/^\p{L}[\p{L} '-]*$/u, "letters only"), def: "Echo", raw: true },
  /** For talking at the table (quick), and for "sleep on it" reviews in the background (slow and careful). */
  "guest.model": { schema: z.string().regex(/^[\w.-]{1,40}$/, "a model name"), def: "gpt-6.1-terra", raw: true },
  "guest.effort": { schema: z.enum(["minimal", "low", "medium", "high", "xhigh"]), def: "low", raw: true },
  "guest.deep_model": { schema: z.string().regex(/^[\w.-]{1,40}$/, "a model name"), def: "gpt-6-astra", raw: true },
  "guest.deep_effort": { schema: z.enum(["minimal", "low", "medium", "high", "xhigh"]), def: "xhigh", raw: true },
  /** "Discuss it": how many rounds of the two of them before the close (at most four). */
  "guest.rounds": { schema: z.number().int().min(1).max(4), def: 2, raw: false },
  /** The most one of his turns may take before "Tim's taking too long". */
  "guest.timeout_s": { schema: z.number().int().min(5).max(120), def: 25, raw: false },
  /** His speaking voice (the voice service's text-to-speech), plainly not the assistant's own. */
  "guest.voice": { schema: z.enum(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]), def: "cedar", raw: true },
} as const;

type Defs = typeof DEFS;
export type SettingKey = keyof Defs;
export type Settings = { [K in SettingKey]: z.infer<Defs[K]["schema"]> };
export type By = "phone" | "desktop" | "brain" | "local" | "remote";

export const SETTING_KEYS = Object.keys(DEFS) as SettingKey[];
export const isUiKey = (k: string) => k.startsWith("ui.");

function read<K extends SettingKey>(key: K): Settings[K] {
  const d = DEFS[key];
  const stored = getSetting(key);
  if (stored === "") return d.def as Settings[K];
  let value: unknown = stored;
  if (!d.raw) {
    try {
      value = JSON.parse(stored);
    } catch {
      return d.def as Settings[K];
    }
  }
  const ok = d.schema.safeParse(value);
  return (ok.success ? ok.data : d.def) as Settings[K];
}

/** Every setting, with defaults filled in. An expired colour override reads as null. */
export function getSettings(now = new Date()): Settings {
  const out = Object.fromEntries(SETTING_KEYS.map((k) => [k, read(k)])) as Settings;
  const o = out["ui.colour_override"];
  if (o && new Date(o.until) <= now) out["ui.colour_override"] = null;
  return out;
}

/** What the phone over Tailscale may read: the ui.* settings, plus the time zone (read-only; its weekday colour uses it). */
export const uiSettings = (s: Settings = getSettings()) => Object.fromEntries(Object.entries(s).filter(([k]) => isUiKey(k) || k === "time.zone")) as Partial<Settings>;

export class SettingsError extends Error {}

/**
 * Validate and save a partial change. Unknown keys and bad values are refused as a whole (nothing is saved).
 * `remote` callers (the phone through Tailscale) may only change ui.* settings.
 */
export function updateSettings(patch: Record<string, unknown>, by: By): Settings {
  const clean: Partial<Record<SettingKey, unknown>> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFS)) throw new SettingsError(`Unknown setting: ${k}`);
    if (by === "remote" && !isUiKey(k)) throw new SettingsError(`${k} can only be changed on the PC.`);
    const r = DEFS[k as SettingKey].schema.safeParse(v);
    if (!r.success) throw new SettingsError(`Bad value for ${k}: ${r.error.issues[0]?.message ?? "invalid"}`);
    clean[k as SettingKey] = r.data;
  }
  const before = getSettings();
  const changed: string[] = [];
  for (const [k, v] of Object.entries(clean) as [SettingKey, unknown][]) {
    if (JSON.stringify(before[k]) === JSON.stringify(v)) continue;
    const stored = DEFS[k].raw ? String(v) : v === null ? "" : JSON.stringify(v);
    setSetting(k, stored);
    changed.push(k);
  }
  const after = getSettings();
  if (changed.length) {
    audit(by === "brain" ? "brain" : "user", "settings.changed", null, { keys: changed, by });
    bus.emit("settings", after);
  }
  return after;
}
