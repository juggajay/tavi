// Imperial figures in an old book, given in millimetres (Stage 20.1). The old joinery books on the shelf work in inches
// and feet ("a 3/8-in. iron rod", "1 1/4 in. thick", "3 ft. 6 in."); the owner works in millimetres. The code reads each
// figure, converts it exactly (1 in = 25.4 mm), and hands back "10 mm (3/8 in)", so the assistant says the millimetres
// with the original in brackets once and never does the sum itself. Pure code.

export const MM_PER_INCH = 25.4;
export const MM_PER_FOOT = 304.8;

const VULGAR: Record<string, number> = { "½": 1 / 2, "¼": 1 / 4, "¾": 3 / 4, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8, "⅓": 1 / 3, "⅔": 2 / 3, "⅙": 1 / 6, "⅚": 5 / 6, "⅕": 1 / 5 };
const VULGAR_CHARS = Object.keys(VULGAR).join("");

/** A number as an old book writes it: "3", "1 1/4", "1-1/4", "3/8", "1¼", "¾", "2.5". Null if it isn't one. */
export function readAmount(s: string): number | null {
  const t = s.trim().replace(/[⁄∕]/g, "/");
  let m = new RegExp(`^(\\d+)?\\s*([${VULGAR_CHARS}])$`).exec(t);
  if (m) return (m[1] ? Number(m[1]) : 0) + VULGAR[m[2]];
  m = /^(\d+)[\s-]+(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[3]) ? Number(m[1]) + Number(m[2]) / Number(m[3]) : null;
  m = /^(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
  m = /^\d+(\.\d+)?$/.exec(t);
  return m ? Number(t) : null;
}

/** Millimetres for reading: one decimal under 10 mm, whole millimetres from there. */
export const mmText = (mm: number) => (Math.abs(mm) < 10 ? `${Math.round(mm * 10) / 10} mm` : `${Math.round(mm)} mm`);

/** "3/8 in", "1 1/4 in", "3 ft 6 in": the original, tidied (no full stops, the book's fraction kept). */
const tidy = (s: string) =>
  s
    .replace(/[⁄∕]/g, "/")
    .replace(/\binch(es)?\b|\bin\.|"|″|”/gi, " in")
    .replace(/\bfeet\b|\bfoot\b|\bft\.|'|′|’/gi, " ft")
    .replace(/-(?=\s*(in|ft)\b)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export type Conversion = { original: string; mm: number; text: string };

const AMOUNT = `(?:\\d+[\\s-]+\\d+[/⁄∕]\\d+|\\d+[/⁄∕]\\d+|\\d*[${VULGAR_CHARS}]|\\d+(?:\\.\\d+)?)`;
// "in" alone only when no word follows it, so "3 in the morning" isn't a measurement
const INCH = `(?:inches|inch|in\\.|in(?![ \\t]*[a-z])|"|″)`;
const FOOT = `(?:feet|foot|ft\\.|ft\\b)`;
// feet and inches together ("3 ft. 6 in."), or feet alone, or inches alone; "-" between a figure and its unit is allowed
const FIGURE = new RegExp(`(?<![\\w/⁄.])(?:(${AMOUNT})\\s*-?\\s*${FOOT}\\s*(?:(${AMOUNT})\\s*-?\\s*${INCH})?|(${AMOUNT})\\s*-?\\s*${INCH})`, "gi");

/** One figure in millimetres with the original after it: "10 mm (3/8 in)". */
export function inMm(original: string): Conversion | null {
  FIGURE.lastIndex = 0;
  const m = FIGURE.exec(original);
  if (!m) return null;
  return convert(m);
}

function convert(m: RegExpExecArray): Conversion | null {
  let mm: number;
  if (m[1] !== undefined) {
    const ft = readAmount(m[1]);
    const inch = m[2] !== undefined ? readAmount(m[2]) : 0;
    if (ft === null || inch === null) return null;
    mm = ft * MM_PER_FOOT + inch * MM_PER_INCH;
  } else {
    const inch = readAmount(m[3]);
    if (inch === null) return null;
    mm = inch * MM_PER_INCH;
  }
  if (!(mm > 0)) return null;
  const original = tidy(m[0]);
  return { original, mm: Math.round(mm * 100) / 100, text: `${mmText(mm)} (${original})` };
}

/**
 * Every imperial figure in a passage, in the order it first appears, each once: what the assistant is handed with an
 * old book's text, so it can give millimetres without working them out. At most `max` (default 40).
 */
export function imperialFigures(text: string, max = 40): Conversion[] {
  const out: Conversion[] = [];
  const seen = new Set<string>();
  FIGURE.lastIndex = 0;
  for (let m = FIGURE.exec(text); m && out.length < max; m = FIGURE.exec(text)) {
    const c = convert(m);
    if (!c || seen.has(c.original)) continue;
    seen.add(c.original);
    out.push(c);
  }
  return out;
}
