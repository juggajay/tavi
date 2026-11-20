// Design references (Stage 20.1): a third kind of book on the reference shelf, beside the standards books and the
// makers' guides. Everything under the shelf's "Design" folder (Design\<Source>\...) is one: old joinery books (HTML or
// text from Project Gutenberg), Queensland's timber data, a handbook. What each is (title, author, year, its rung on the
// ladder, units, region, licence and the evidence for it, cautions) comes from the manifest.json beside it, written when
// it was fetched; one dropped in without a manifest is marked as uncited ("one source says").
//
// PDFs are read by the shelf's usual engine, page by page. Text and HTML are read here, by chapter and section, so a
// place can be cited the stable way ("Fairham, Woodwork Joints, The Mortise and Tenon Joint, 'General Rule'") and the
// passage put on screen. Pages a manifest leaves out (ones that copy Australian Standards design values) are never
// indexed, read or shown. The shelf is only ever read.
//
// The "Code" folder (Code\<edition>\...) holds the National Construction Code when the owner downloads it (rung 2),
// each copy cited with its edition.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { referenceDir } from "./dir.js";
import { rungFacts, type Rung } from "./rungs.js";
import { decodeEntities } from "./species.js";
import { imperialFigures } from "../shared/calc/units.js";

export const DESIGN = "Design";
export const CODE = "Code";
export const isDesignShelf = (shelf: string) => shelf.toLowerCase() === DESIGN.toLowerCase();
export const isCodeShelf = (shelf: string) => shelf.toLowerCase() === CODE.toLowerCase();
/** A text or HTML design reference: indexed by chapter and section (its "pages" are sections). */
export const isTextRef = (p: string) => /\.(html?|txt)$/i.test(p);

export type DesignDoc = {
  file: string;
  title?: string;
  short?: string;
  author?: string;
  year?: string;
  publisher?: string;
  rung?: number;
  authority?: string;
  units?: string;
  region?: string;
  licence?: string;
  licence_evidence?: string[];
  cautions?: string[];
  good_for?: string[];
  not_for?: string[];
  skip_sections?: string[];
  leave_out_pages?: number[];
  leave_out_why?: string;
  source?: string;
  found_on?: string;
  fetched?: string;
  /** The National Construction Code only: its edition ("NCC 2022 Amendment 2"), volume and attribution line. */
  edition?: string;
  volume?: string;
  attribution?: string;
};
export type DesignManifest = { source: string; documents: DesignDoc[]; data?: DesignDoc; terms?: unknown; skipped?: unknown[] };

/* ---------------- the manifest beside each source ---------------- */

const cache = new Map<string, { mtime: number; m: DesignManifest }>();
/** A source folder's manifest (cached until the file changes), or an empty one named after the folder. Never throws. */
export function readDesignManifest(dir: string): DesignManifest {
  const file = path.join(dir, "manifest.json");
  try {
    const mtime = statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.m;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DesignManifest>;
    const m: DesignManifest = { ...raw, source: typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : path.basename(dir), documents: Array.isArray(raw.documents) ? raw.documents.filter((d) => d && typeof d.file === "string") : [] };
    cache.set(file, { mtime, m });
    return m;
  } catch {
    return { source: path.basename(dir), documents: [] };
  }
}

/** The source folder (Design\<Source> or Code\<Edition>) a file sits in, or null. */
function sourceDir(file: string, root: string, shelf: string) {
  const rel = path.relative(path.join(root, shelf), path.dirname(file)).split(path.sep).filter(Boolean);
  return rel.length && rel[0] !== ".." ? path.join(root, shelf, rel[0]) : null;
}

const slashes = (p: string) => p.replace(/\\/g, "/").toLowerCase();

export type DesignMeta = {
  listed: boolean;
  source: string;
  title: string | null;
  short: string;
  author: string | null;
  year: string | null;
  publisher: string | null;
  rung: Rung;
  authority: string;
  units: string | null;
  region: string | null;
  licence: string | null;
  licence_evidence: string[];
  cautions: string[];
  good_for: string[];
  not_for: string[];
  skip_sections: string[];
  leave_out: Set<number>;
  leave_out_why: string | null;
  source_url: string | null;
  fetched: string | null;
  edition: string | null;
  volume: string | null;
  attribution: string | null;
};

const UNCITED = "Nobody has recorded what this is, who wrote it or its licence (it has no manifest): treat it as one source says, and check it against a second before using it.";

/** What a design reference (or a code book) is, from the manifest beside it; a file with none is marked uncited. */
export function designMetaFor(file: string, root = referenceDir(), shelf = DESIGN): DesignMeta {
  const dir = sourceDir(file, root, shelf);
  const m = dir ? readDesignManifest(dir) : { source: path.basename(path.dirname(file)), documents: [] };
  const rel = dir ? slashes(path.relative(dir, file)) : slashes(path.basename(file));
  const d = m.documents.find((x) => slashes(x.file) === rel) ?? m.documents.find((x) => slashes(path.basename(x.file)) === slashes(path.basename(file)));
  const code = isCodeShelf(shelf);
  const edition = d?.edition ?? (code ? editionFromName(`${path.basename(dir ?? "")} ${path.basename(file)}`) : null);
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  const rung = (code ? 2 : d?.rung === 5 ? 5 : 6) as Rung;
  return {
    listed: !!d,
    source: m.source,
    title: d?.title ?? null,
    short: d?.short ?? (code && edition ? `${edition}${d?.volume ? ` ${d.volume}` : ""}` : d?.title ?? `${m.source}, ${base}`),
    author: d?.author ?? (code ? "Australian Building Codes Board" : null),
    year: d?.year ?? null,
    publisher: d?.publisher ?? null,
    rung,
    authority: d?.authority ?? (code ? "the building code" : "not recorded"),
    units: d?.units ?? null,
    region: d?.region ?? null,
    licence: d?.licence ?? null,
    licence_evidence: d?.licence_evidence ?? [],
    cautions: d ? (d.cautions ?? []) : [UNCITED],
    good_for: d?.good_for ?? [],
    not_for: d?.not_for ?? [],
    skip_sections: d?.skip_sections ?? [],
    leave_out: new Set(d?.leave_out_pages ?? []),
    leave_out_why: d?.leave_out_why ?? null,
    source_url: d?.source && /^https?:\/\//i.test(d.source) ? d.source : null,
    fetched: d?.fetched ?? null,
    edition,
    volume: d?.volume ?? null,
    attribution: d?.attribution ?? null,
  };
}

/** A shelf book's details by its own shelf (Design or Code). */
export const metaOf = (b: { path: string; shelf: string }) => designMetaFor(b.path, referenceDir(), isCodeShelf(b.shelf) ? CODE : DESIGN);

/** "NCC 2022 Amendment 2", "NCC 2025", from a file or folder name; null when it doesn't say. */
export function editionFromName(s: string): string | null {
  const m = /\bNCC[\s_-]*(\d{4})(?:[\s_-]*(?:Amendment|Amdt)[\s_-]*(\d))?/i.exec(s);
  return m ? `NCC ${m[1]}${m[2] ? ` Amendment ${m[2]}` : ""}` : null;
}

/** A page a manifest leaves off the shelf (it copies Australian Standards design values): never indexed, read or shown. */
export const leftOut = (b: { path: string; shelf: string; kind: string }, page: number) => b.kind === "design" && designMetaFor(b.path).leave_out.has(page);
export const leftOutReason = (b: { path: string }) => designMetaFor(b.path).leave_out_why ?? "That page is left off the shelf.";

/* ---------------- how one is named in an answer, and what travels with it ---------------- */

const yearPart = (m: DesignMeta) => (m.year ? ` (${m.year})` : "");

/** The short line under a passage or page: "Fairham, Woodwork Joints (c. 1930) · The Mortise and Tenon Joint › General Rule · book page 82". */
export function designSourceLine(b: { path: string; shelf: string }, page: number, heading: string, printed: string | null) {
  const m = designMetaFor(b.path, referenceDir(), b.shelf);
  if (isCodeShelf(b.shelf)) return [m.short || "National Construction Code (edition not known)", `page ${page}`].join(" · ");
  if (isTextRef(b.path)) return [`${m.short}${yearPart(m)}`, heading, printed ? `book page ${printed}` : null].filter(Boolean).join(" · ");
  return [`${m.short}${yearPart(m)}`, `page ${page}`].join(" · ");
}

/** The stable way to cite a place in a text reference: "Fairham, Woodwork Joints, The Mortise and Tenon Joint, 'General Rule'". */
export function designCitation(b: { path: string; shelf: string }, heading: string) {
  const m = designMetaFor(b.path, referenceDir(), b.shelf);
  const parts = heading.split(" › ").filter(Boolean);
  const last = parts.length > 1 ? parts.pop()! : null;
  return [m.short, ...parts, last ? `'${last.replace(/ \(part \d+\)$/, "")}'` : null].filter(Boolean).join(", ");
}

/**
 * What the brain is told with every result from a design reference or the code: what it is, its rung, units, region,
 * and its cautions. So it never has to remember them.
 */
export function designFacts(b: { path: string; shelf: string; kind: string }) {
  const m = designMetaFor(b.path, referenceDir(), b.shelf);
  return {
    kind: b.kind === "code" ? "the building code" : "design reference",
    title: m.title ?? m.short,
    cite_as: m.short,
    ...(m.author ? { author: m.author } : {}),
    ...(m.year ? { year: m.year } : {}),
    ...(m.edition ? { edition: m.edition } : {}),
    ...rungFacts(m.rung),
    ...(m.authority !== "not recorded" ? { authority: m.authority } : {}),
    ...(m.units ? { units: m.units } : {}),
    ...(m.region ? { region: m.region } : {}),
    ...(m.good_for.length ? { good_for: m.good_for } : {}),
    ...(m.not_for.length ? { never_for: m.not_for } : {}),
    cautions: m.cautions,
    ...(m.attribution ? { attribution: m.attribution } : {}),
    ...(!m.listed ? { doubt: "uncited: offer anything from it as 'one source says' unless a second source agrees" } : {}),
  };
}

/** Imperial figures in a passage, worked out in millimetres by code, for the brain to give with the original once. */
export function millimetresFor(text: string) {
  return imperialFigures(text).map((c) => c.text);
}

/* ---------------- reading a text or HTML reference by chapter and section ---------------- */

export type Section = { trail: string[]; printed: string | null; text: string };
export type ParsedBook = { title: string | null; sections: Section[] };

const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"]);
/** "THE MORTISE AND TENON JOINT." -> "The Mortise and Tenon Joint" (only for headings in capitals). */
export function headingCase(s: string) {
  const t = s
    .replace(/\s+/g, " ")
    .replace(/[.:;,\s]+$/, "")
    .trim();
  if (/[a-z]/.test(t)) return t;
  return t
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : /^[ivxlc]+\.?$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

const strip = (s: string) =>
  decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The book's text as decoded characters: Latin-1 when it says so (older Gutenberg files), UTF-8 otherwise. */
export function decodeBook(buf: Buffer) {
  const head = buf.subarray(0, 4000).toString("latin1");
  return /charset\s*=\s*["']?(iso-8859-1|latin-?1|windows-1252)|Character set encoding:\s*ISO-8859-1/i.test(head) ? buf.toString("latin1") : buf.toString("utf8");
}

const MAX_SECTION = 5000;

/**
 * An HTML book (as Project Gutenberg publishes them) in sections: a new section at each heading and at each bold
 * run-in heading that opens a paragraph ("General Rule.—In practically all cases..."). The trail is the chapter and the
 * headings within it; printed is the book's own page where the section starts. Gutenberg's licence text, the contents,
 * the index and anything the manifest names in skip are left out.
 */
export function parseHtmlBook(raw: string, skip: string[] = []): ParsedBook {
  let html = raw;
  const title = strip(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/^The Project Gutenberg e-?Book of\s*/i, "").replace(/,\s*by .*$/i, "").replace(/\.$/, "") || null;
  const start = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^*]*\*\*\*/i.exec(html);
  if (start) html = html.slice(start.index + start[0].length);
  const end = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i.exec(html);
  if (end) html = html.slice(0, end.index);
  html = html
    .replace(/\r?\n/g, " ") // line breaks in HTML source mean nothing; paragraphs come from the tags
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    // a fraction set as raised and lowered figures ("1<sup>3</sup>&frasl;<sub>8</sub>") -> "1 3/8"
    .replace(/(\d)?((?:<[^>]+>\s*)+)(\d+)((?:\s*<\/[^>]+>)+)\s*(?:&#8260;|&frasl;|&#x2044;|⁄)\s*((?:<[^>]+>\s*)*)(\d+)((?:\s*<\/[^>]+>)*)/gi, (_m, whole: string | undefined, _a, n: string, _b, _c, d: string) => `${whole ? `${whole} ` : ""}${n}/${d}`)
    .replace(/&#8260;|&frasl;|&#x2044;|⁄/gi, "/")
    // the book's page numbers
    .replace(/<span\b[^>]*class=["'][^"']*\bpagen(?:um|o)\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi, (m, inner: string) => {
      const n = /\[\s*(?:Pg\.?\s*|p\.\s*|page\s*)?([0-9]+|[ivxlc]+)\s*\]/i.exec(strip(inner))?.[1] ?? /(?:id|name)=["'](?:page|pg)[_-]?([0-9]+|[ivxlc]+)["']/i.exec(m)?.[1];
      return n ? `\u0002${n}\u0002` : " ";
    })
    .replace(/<(p|div|span)\b[^>]*class=["'][^"']*\bcaption\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `\n[${strip(inner).replace(/[.\s]+$/, "")}]\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l: string, inner: string) => `\n\u0001H${l} ${strip(inner.replace(/<br\s*\/?>/gi, " "))}\n`)
    // a bold run-in heading opening a paragraph starts a section (the words stay in the paragraph too)
    .replace(/<p\b[^>]*>\s*((?:<a\b[^>]*>\s*<\/a>\s*)*)<(b|strong)>([\s\S]{2,90}?)<\/\2>/gi, (m, _a, _t, bold: string) => `\n\u0001R ${strip(bold).replace(/[.:—–-]+$/, "").trim()}\n${m}`)
    .replace(/<\/(p|div|li|tr|blockquote|pre|table|dd|dt)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/td>/gi, "  ")
    // inline tags go without a trace ("<a>Fig. 224</a>." stays "Fig. 224."); any other tag is a space
    .replace(/<\/?(?:a|span|i|b|em|strong|sup|sub|small|font|u|abbr|cite)\b[^>]*>/gi, "");
  const lines = decodeEntities(html.replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim());
  const skipKeys = new Set([...["contents", "index", "list of illustrations", "illustrations", "transcriber s note", "transcriber s notes"], ...skip.map(key)]);
  const out: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let runIn: string | null = null;
  let buf: string[] = [];
  let printed: string | null = null;
  let sectionPage: string | null = null;
  let lastHeading: { level: number; empty: boolean } | null = null;
  const trail = () => [...stack.map((s) => s.text), ...(runIn ? [runIn] : [])];
  const skipped = () => stack.some((s) => skipKeys.has(key(s.text)));
  const flush = () => {
    const text = buf.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    buf = [];
    if (!stack.length || skipped() || text.replace(/\[[^\]]*\]/g, "").trim().length < 40) return;
    const t = trail();
    if (text.length <= MAX_SECTION) return void out.push({ trail: t, printed: sectionPage, text });
    // a long section in parts, at paragraph breaks
    const paras = text.split(/\n\n+/);
    let part: string[] = [];
    let n = 1;
    const push = () => {
      if (!part.length) return;
      out.push({ trail: n === 1 ? t : [...t.slice(0, -1), `${t.at(-1)} (part ${n})`], printed: sectionPage, text: part.join("\n\n") });
      n++;
      part = [];
    };
    for (const p of paras) {
      if (part.length && part.join("\n\n").length + p.length > MAX_SECTION) push();
      part.push(p);
    }
    push();
  };
  for (const raw of lines) {
    // page markers can sit anywhere in a line: the page in force moves on, and the marker goes
    let line = raw;
    line = line.replace(/\u0002([^\u0002]*)\u0002/g, (_m, n: string, at: number, all: string) => {
      printed = n;
      // the section starts on this page only if no words of it came before the marker
      if (!buf.join("").trim() && !all.slice(0, at).replace(/\u0002[^\u0002]*\u0002/g, "").trim()) sectionPage = n;
      return " ";
    });
    line = line.replace(/\s+/g, " ").trim();
    const h = /^\u0001H([1-6]) (.*)$/.exec(line);
    const r = /^\u0001R (.*)$/.exec(line);
    if (h) {
      const level = Number(h[1]);
      const text = headingCase(h[2]);
      if (!text) continue;
      if (level === 1) {
        lastHeading = null;
        continue; // the book's title
      }
      // two headings in a row at the same level ("Chapter I." then "LOGGING.") are one heading
      if (lastHeading && lastHeading.level === level && lastHeading.empty && stack.length && stack[stack.length - 1].level === level) {
        stack[stack.length - 1].text = `${stack[stack.length - 1].text}. ${text}`;
        continue;
      }
      flush();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text });
      runIn = null;
      sectionPage = printed;
      lastHeading = { level, empty: true };
      continue;
    }
    if (r) {
      flush();
      runIn = headingCase(r[1]).slice(0, 80);
      sectionPage = printed;
      lastHeading = null;
      continue;
    }
    if (line) {
      if (lastHeading) lastHeading.empty = false;
      buf.push(line);
    } else if (buf.length && buf[buf.length - 1] !== "") buf.push("");
  }
  flush();
  return { title, sections: out };
}

/** A plain-text book in sections: chapters at lines in capitals (or "CHAPTER ..."), parts of about 3,000 characters. */
export function parseTextBook(raw: string, skip: string[] = []): ParsedBook {
  let text = raw.replace(/\r\n?/g, "\n");
  const start = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^*]*\*\*\*/i.exec(text);
  if (start) text = text.slice(start.index + start[0].length);
  const end = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i.exec(text);
  if (end) text = text.slice(0, end.index);
  const skipKeys = new Set([...["contents", "index"], ...skip.map(key)]);
  const out: Section[] = [];
  let chapter: string | null = null;
  let paras: string[] = [];
  let part = 1;
  const flush = (force = false) => {
    const body = paras.join("\n\n").trim();
    if (!chapter || skipKeys.has(key(chapter)) || body.length < 40) {
      if (force) paras = [];
      return;
    }
    if (!force && body.length < 3000) return;
    out.push({ trail: [chapter, part === 1 ? "" : `part ${part}`].filter(Boolean), printed: null, text: body });
    paras = [];
    part++;
  };
  for (const block of text.split(/\n\s*\n/)) {
    const b = block.replace(/\s+/g, " ").trim();
    if (!b) continue;
    if ((/^[A-Z0-9][A-Z0-9 ,.'’:;—-]{2,60}$/.test(b) && /[A-Z]{3}/.test(b)) || /^chapter\s+[\divxlc]+\b/i.test(b)) {
      flush(true);
      chapter = headingCase(b);
      part = 1;
      continue;
    }
    paras.push(b);
    flush();
  }
  flush(true);
  return { title: null, sections: out };
}
