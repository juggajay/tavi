// Timber species as data (Stage 20.1): a small table per species from the Queensland Government's "Wood properties and
// uses of Australian timbers" pages (Business Queensland, CC BY 4.0), each with the page's address and dates as its
// citation. The table lives on the reference shelf (Design\Queensland Timber Species\species.json), never in the repo;
// it is only ever read here. Only the facts the stage allows are kept: names, density, shrinkage, unit shrinkage,
// durability (with lyctid and termite), hardness and uses. Strength groups, stress grades and joint groups are left
// out: they are Australian Standards classifications.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { referenceDir } from "./dir.js";

export const SPECIES_SOURCE = "Queensland Timber Species";
export const SPECIES_FILE = "species.json";
export const SPECIES_RUNG = 5;

export type Pair = { tangential: number; radial: number } | null;
export type Species = {
  name: string;
  slug: string;
  url: string;
  scientific: string;
  other_names: string;
  density: { kg_m3: number | null; range: [number, number] | null; text: string } | null;
  shrinkage: (Pair & { text: string }) | { text: string } | null;
  unit_shrinkage: (Pair & { text: string }) | { text: string } | null;
  durability: { above_ground: number | null; in_ground: number | null; text: string };
  lyctine: string | null;
  termite: string | null;
  /** The pages' 6-class scale, 1 hardest: one class, or a range when the page gives two (or several species). */
  hardness: { class: number | null; range?: [number, number] | null; word: string | null; text: string } | null;
  uses: string | null;
  last_updated: string | null;
  last_reviewed: string | null;
  fetched: string | null;
  sha256?: string | null;
};
export type SpeciesTable = {
  source: string;
  publisher: string;
  licence: string;
  attribution: string;
  licence_evidence?: string[];
  left_out?: string;
  fetched?: string;
  species: Species[];
};

/* ---------------- reading a species page (used once, when the pages were fetched) ---------------- */

const ENTITIES: Record<string, string> = { mdash: "—", ndash: "–", nbsp: " ", amp: "&", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", deg: "°", quot: '"', apos: "'", lt: "<", gt: ">", times: "×", frac12: "½", frac14: "¼", frac34: "¾" };
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? all)));

/** The page as lines of plain text (tags gone, entities decoded, superscript 3 joined back on). */
function linesOf(html: string) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<sup>\s*3\s*<\/sup>/gi, "³")
      .replace(/<\/(p|li|h[1-6]|div|tr|dt|dd|ul|ol|section|table)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const num = (s: string | undefined) => (s === undefined ? null : Number(s));
/** The first "a% (tangential), b% (radial)" pair in a value. */
function pairOf(text: string): Pair {
  const m = /(\d+(?:\.\d+)?)\s*%\s*\(tangential\)[,;]?\s*(\d+(?:\.\d+)?)\s*%\s*\(radial\)/i.exec(text);
  return m ? { tangential: Number(m[1]), radial: Number(m[2]) } : null;
}

/** "Durability above-ground: Class 1 (...)" and the like, from the Properties part of a species page. */
export function extractSpecies(html: string, url: string, fetched: string | null = null): Species {
  const lines = linesOf(html);
  const start = lines.findIndex((l) => /^Scientific name$/i.test(l));
  const end = lines.findIndex((l, i) => i > start && /^(Identification features|Research and resources)$/i.test(l));
  const body = lines.slice(start < 0 ? 0 : start, end < 0 ? undefined : end);
  const flat = body.join(" ");
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const name = decodeEntities((h1?.[1] ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() || url.split("/").pop()!.replace(/-/g, " ");
  // A label's value runs to the next known label. The distinctive labels end a value even without their colon (some
  // pages leave it off); the one-word ones only with it.
  const STRONG = ["Air dry density", "Strength groups?", "Stress grades?", "Joint groups?", "Shrinkage to 12% MC", "Unit shrinkage", "Durability above[- ]ground", "Durability in[- ]ground", "Lyctine susceptibility", "Termite resistance"];
  const WEAK = ["Density", "Preservation", "Seasoning", "Hardness", "Machining", "Fixing", "Gluing", "Finishing", "Other properties"];
  const props = flat.slice(Math.max(0, flat.search(/\bProperties\b/)));
  const value = (label: RegExp) => {
    const re = new RegExp(`(?:^|\\s)(?:${label.source})(?:\\s*:\\s*|\\s+(?=at\\b))`, "i");
    const m = re.exec(props);
    if (!m) return null;
    const rest = props.slice(m.index + m[0].length);
    const next = new RegExp(`\\s(?:(?:${STRONG.join("|")})\\b\\s*:?|(?:${WEAK.join("|")})\\s*:)`, "i").exec(rest);
    return (
      (next ? rest.slice(0, next.index) : rest)
        .trim()
        .replace(/\s+([,.;])/g, "$1")
        // a page's stray line about stress grading (an Australian Standards matter) isn't kept with a figure
        .replace(/,?\s*when visually stress-graded according to [^:;.]*[:;.]?/gi, "")
        .trim() || null
    );
  };
  const section = (head: string, stop: string[]) => {
    const i = body.findIndex((l) => l.toLowerCase() === head.toLowerCase());
    if (i < 0) return null;
    const j = body.findIndex((l, k) => k > i && stop.some((s) => l.toLowerCase() === s.toLowerCase()));
    return body
      .slice(i + 1, j < 0 ? undefined : j)
      .join(" ")
      .replace(/\s+([,.;])/g, "$1")
      .trim();
  };
  const densityText = value(/Air dry density|Density/);
  // every density figure on the line ("675-770kg/m³", "1010kgm³", "L. leefeana 480kg/m³ ... C. baileyanum 560kg/m³")
  const figs = densityText ? [...densityText.matchAll(/(\d{3,4})\s*(?:[-–]\s*(\d{3,4}))?\s*kg\s*\/?\s*m/gi)].flatMap((m) => [Number(m[1]), ...(m[2] ? [Number(m[2])] : [])]) : [];
  const dm = figs.length ? { lo: Math.min(...figs), hi: Math.max(...figs) } : null;
  const shrinkText = value(/Shrinkage to 12% MC/);
  const unitText = value(/Unit shrinkage/);
  const above = value(/Durability above[- ]ground/);
  const inGround = value(/Durability in[- ]ground/);
  const hardText = value(/Hardness/);
  // "very hard (rated 1 on a 6-class scale)", "(class 1 on ...)", "(rated 3 and 4 ...)", "(rated 5 to 4 ...)", "(1 on ...)"
  const classes = hardText ? [...hardText.matchAll(/(?:rated|class)?\s*(\d)(?:\s*(?:and|to|-|–)\s*(\d))?\s*on a 6-class scale/gi)].flatMap((m) => [Number(m[1]), ...(m[2] ? [Number(m[2])] : [])]) : [];
  const hm = classes.length ? { lo: Math.min(...classes), hi: Math.max(...classes), word: /^([a-z][a-z -]*?)\s*\(/i.exec(hardText ?? "")?.[1]?.trim().toLowerCase() ?? null } : null;
  const sp = shrinkText ? pairOf(shrinkText) : null;
  const up = unitText ? pairOf(unitText) : null;
  const updated = /Last updated:\s*([0-9]{1,2} [A-Za-z]+ [0-9]{4})/.exec(lines.join("\n"));
  const reviewed = /Last reviewed:\s*([0-9]{1,2} [A-Za-z]+ [0-9]{4})/.exec(lines.join("\n"));
  return {
    name,
    slug: url.split("/").pop() ?? name,
    url,
    scientific: section("Scientific name", ["Other names", "Description"])?.replace(/\s*Family:.*$/i, "") ?? "",
    other_names: section("Other names", ["Description", "Occurrence"]) ?? "",
    density: densityText ? { kg_m3: dm && dm.lo === dm.hi ? dm.lo : null, range: dm && dm.lo !== dm.hi ? [dm.lo, dm.hi] : null, text: densityText } : null,
    shrinkage: shrinkText ? { ...(sp ?? {}), text: shrinkText } : null,
    unit_shrinkage: unitText ? { ...(up ?? {}), text: unitText } : null,
    durability: {
      above_ground: num(/Class\s*(\d)/i.exec(above ?? "")?.[1]),
      in_ground: num(/Class\s*(\d)/i.exec(inGround ?? "")?.[1]),
      text: [above && `above ground: ${above}`, inGround && `in ground: ${inGround}`].filter(Boolean).join("; "),
    },
    lyctine: value(/Lyctine susceptibility/),
    termite: value(/Termite resistance/),
    hardness: hardText ? { class: hm && hm.lo === hm.hi ? hm.lo : null, range: hm && hm.lo !== hm.hi ? [hm.lo, hm.hi] : null, word: hm?.word ?? null, text: hardText } : null,
    uses: section("Uses", ["Properties"]),
    last_updated: updated?.[1] ?? null,
    last_reviewed: reviewed?.[1] ?? null,
    fetched,
  };
}

/* ---------------- the table on the shelf ---------------- */

export const speciesPath = (root = referenceDir()) => path.join(root, "Design", SPECIES_SOURCE, SPECIES_FILE);
let cache: { file: string; mtime: number; table: SpeciesTable } | null = null;

/** The species table on the shelf, or null when it isn't there (or can't be read). */
export function speciesTable(file = speciesPath()): SpeciesTable | null {
  try {
    const mtime = statSync(file).mtimeMs;
    if (cache && cache.file === file && cache.mtime === mtime) return cache.table;
    const t = JSON.parse(readFileSync(file, "utf8")) as SpeciesTable;
    if (!Array.isArray(t.species)) return null;
    cache = { file, mtime, table: t };
    return t;
  } catch {
    return null;
  }
}

const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/\btas\b|\btassie\b/g, "tasmanian")
    .replace(/\bvic\b/g, "victorian")
    .replace(/\bqld\b/g, "queensland")
    .replace(/\bwrc\b/g, "western red cedar")
    .replace(/[^a-z]+/g, " ")
    .trim();

/** A species by its name, another name it goes by ("merbau", "Vic ash") or its botanical name; best match first. */
export function findSpecies(query: string, t = speciesTable()): Species[] {
  if (!t) return [];
  const q = squash(query);
  if (!q) return [];
  const words = q.split(" ").filter((w) => w.length > 1);
  const scored = t.species.map((s) => {
    const name = squash(s.name);
    const other = squash(s.other_names);
    const sci = squash(s.scientific);
    let score = 0;
    if (name === q) score = 100;
    else if (name.replace(/ /g, "") === q.replace(/ /g, "")) score = 95;
    else if (new RegExp(`(^| )${q}( |$)`).test(other)) score = 80;
    else if (new RegExp(`(^| )${q}( |$)`).test(sci)) score = 70;
    else if (words.length && words.every((w) => name.includes(w))) score = 60;
    else if (words.length && words.every((w) => other.includes(w))) score = 40;
    return { s, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .map((x) => x.s);
}

/** "Wood properties and uses of Australian timbers: Spotted gum, Business Queensland (last updated 17 May 2021)". */
export const speciesCitation = (s: Species, t: Pick<SpeciesTable, "publisher">) =>
  `${t.publisher}, "Wood properties and uses of Australian timbers": ${s.name}${s.last_updated ? ` (page last updated ${s.last_updated})` : ""}, ${s.url}`;

/** A species' hardness class as [hardest, softest] on the pages' scale, or null when the page doesn't rate it. */
export const hardnessSpan = (s: Species): [number, number] | null => (s.hardness?.class ? [s.hardness.class, s.hardness.class] : s.hardness?.range ? [s.hardness.range[0], s.hardness.range[1]] : null);
const spanText = (r: [number, number]) => (r[0] === r[1] ? `${r[0]}` : `${r[0]} to ${r[1]}`);

/** Hardness on the pages' own scale: class 1 is the hardest of six. Overlapping ranges are not called either way. */
export function harderOf(a: Species, b: Species): { harder: Species | null; why: string } {
  const ha = hardnessSpan(a);
  const hb = hardnessSpan(b);
  if (!ha || !hb) return { harder: null, why: `The page doesn't rate ${!ha ? a.name : b.name}'s hardness on its 6-class scale.` };
  const say = (s: Species, r: [number, number]) => `${s.name} is rated ${spanText(r)}${s.hardness?.word ? ` (${s.hardness.word})` : ""}`;
  if (ha[1] < hb[0] || hb[1] < ha[0]) {
    const [harder, hr, softer, sr] = ha[1] < hb[0] ? [a, ha, b, hb] : [b, hb, a, ha];
    return { harder, why: `${say(harder, hr)} and ${say(softer, sr)} on the pages' 6-class scale, where 1 is hardest.` };
  }
  return { harder: null, why: `${say(a, ha)} and ${say(b, hb)} on the pages' 6-class scale (1 is hardest), so the pages don't put one clearly harder.` };
}
