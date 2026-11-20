// What every trade calculator gives back (Stage 14.2): the numbers, the working as steps, the checks with their source
// clause, warnings, the sources, a table of the working for the screen and, where shape matters, a dimensioned sketch.
// Pure code: no network, no files, no model. Millimetres and degrees throughout.
import type { SketchShape } from "../protocol.js";

export type Check = { what: string; value: string; limit: string; ok: boolean; source: string };
export type Sketch = { title: string; shapes: SketchShape[]; note?: string };

export type CalcResult = {
  title: string;
  /** One short line for the voice, in plain words ("Fourteen risers at 189, going 250. That passes."). */
  say: string;
  /** The key figures, by name. */
  answer: Record<string, number | string | boolean | null>;
  /** The working, a line a step: what was done, with the figures. */
  steps: string[];
  checks: Check[];
  warnings: string[];
  /** Where the rules came from (document, edition or date, clause or page). */
  sources: string[];
  /** For the screen: the working as a table. */
  table: { columns: string[]; rows: string[][] };
  sketch?: Sketch;
};

/** Bad or missing input: a plain sentence the brain can turn into a question. */
export class CalcInputError extends Error {}

export const RAD = Math.PI / 180;
/** Rounded for reading: whole mm above 100, one place below; angles to one place. */
export const mm = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
export const r1 = (v: number) => Math.round(v * 10) / 10;
export const r2 = (v: number) => Math.round(v * 100) / 100;
export const r3 = (v: number) => Math.round(v * 1000) / 1000;
export const deg = (v: number) => `${r1(v)}°`;
/** 3,600 style, as the owner would write it. */
export const fmt = (v: number, places = 0) => v.toLocaleString("en-AU", { minimumFractionDigits: places, maximumFractionDigits: places });

/** A positive number, or a plain error naming what's wrong. */
export function need(v: number | undefined, name: string, what: string): number {
  if (v === undefined || v === null) throw new CalcInputError(`I need ${what}.`);
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new CalcInputError(`${name} needs to be a number above zero.`);
  return v;
}
export function opt(v: number | undefined, name: string, zeroOk = false): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (!zeroOk && v === 0)) throw new CalcInputError(`${name} needs to be a number${zeroOk ? " of zero or more" : " above zero"}.`);
  return v;
}

/** The table on screen: the working steps, then each check with its source. */
export function workingTable(steps: string[], checks: Check[]): CalcResult["table"] {
  return {
    columns: ["", "Working", "Limit", "Source"],
    rows: [...steps.map((s, i) => [String(i + 1), s, "", ""]), ...checks.map((c) => [c.ok ? "✓" : "✗", `${c.what}: ${c.value}`, c.limit, c.source])],
  };
}

/** Waste, as a stated percentage the owner can change (default given by each calculator). */
export function wasteOf(pct: number | undefined, def: number) {
  const w = pct ?? def;
  if (!Number.isFinite(w) || w < 0 || w > 100) throw new CalcInputError("Waste needs to be a percentage from 0 to 100.");
  return w;
}
