// The calculators' code figures against the code on the shelf (Stage 20). The Stage 14 calculators keep their own
// checked figures (src/shared/calc/ncc.ts, each with its clause). When the owner puts the National Construction Code on
// the shelf (Code\<edition>\, rung 2), this finds each clause in the copy of the edition the figures were read from and
// checks every figure is printed there, so the shelf copy and the calculators cite the same clause with the same
// numbers. A figure of a metre or more may be printed in metres ("1 m", "2.0 m"). Only read; nothing is changed.
import { NCC_BARRIERS, NCC_EDITION, NCC_HEADROOM, NCC_STAIRS } from "../shared/calc/ncc.js";
import { db } from "../store/db.js";
import { readyCode, type Book } from "./library.js";
import { metaOf } from "./design.js";

export type ClauseFigures = { clause: string; what: string; figures: number[] };

/** Every figure in an ncc.ts entry, with its clause. */
function figuresOf(what: string, entry: Record<string, unknown>): ClauseFigures {
  const nums: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number") nums.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => k !== "clause" && walk(x));
  };
  walk(entry);
  return { clause: String(entry.clause), what, figures: [...new Set(nums)] };
}

/** The calculators' figures by clause, straight from ncc.ts (so a figure changed there is checked here too). */
export function calculatorClauses(): ClauseFigures[] {
  const out: ClauseFigures[] = [];
  const { dims, ...stairs } = NCC_STAIRS;
  for (const [k, v] of Object.entries(stairs)) out.push(figuresOf(`stairs: ${k}`, v as Record<string, unknown>));
  for (const [k, v] of Object.entries(dims)) out.push(figuresOf(`stairs: ${k} riser, going, 2R+G`, v as Record<string, unknown>));
  out.push(figuresOf("headroom", NCC_HEADROOM as unknown as Record<string, unknown>));
  for (const [k, v] of Object.entries(NCC_BARRIERS)) out.push(figuresOf(`barriers: ${k}`, v as Record<string, unknown>));
  return out;
}

/** "11.2.2(1)(b)" -> "11.2.2"; "Table 11.2.2a (spiral)" -> "Table 11.2.2a". What to look for on the page. */
export const clauseKey = (c: string) => c.replace(/\s*\(.*$/, "").replace(/\(\d+\).*$/, "").trim();

const printed = (text: string, v: number) => {
  const t = text.replace(/,(?=\d{3}\b)/g, "");
  const forms = [String(v)];
  if (v >= 1000 && v % 100 === 0) forms.push(`${v / 1000} m`, `${(v / 1000).toFixed(1)} m`, `${v / 1000}m`, `${(v / 1000).toFixed(1)}m`);
  return forms.some((f) => new RegExp(`(?<![\\d.])${f.replace(".", "\\.")}(?![\\d.])`).test(t));
};

export type ClauseCheck = ClauseFigures & { page: number | null; missing: number[] };

/**
 * Each calculator clause in one code book: the first page that prints the clause number, and which of its figures that
 * page and the next don't print. page null: the clause isn't found in that copy.
 */
export function checkCodeBook(b: Pick<Book, "id">, clauses = calculatorClauses()): ClauseCheck[] {
  const pages = db.prepare("SELECT page, text FROM ref_pages WHERE book_id = ? ORDER BY page").all(b.id) as { page: number; text: string }[];
  return clauses.map((c) => {
    const k = clauseKey(c.clause);
    const re = new RegExp(`(?<![\\d.])${k.replace(/[.]/g, "\\.")}(?![\\d])`, "i");
    const hits = pages.map((p, i) => (re.test(p.text) ? i : -1)).filter((i) => i >= 0);
    if (!hits.length) return { ...c, page: null, missing: c.figures };
    // every page that prints the clause, and the page after each (a sub-clause or table can run over)
    const text = [...new Set(hits.flatMap((i) => [i, i + 1]))]
      .filter((i) => i < pages.length)
      .map((i) => pages[i].text)
      .join("\n");
    return { ...c, page: pages[hits[0]].page, missing: c.figures.filter((v) => !printed(text, v)) };
  });
}

/** For the brain's shelf list: do the calculators' figures match the shelf's copy of the edition they were read from? */
export function codeShelfCheck() {
  const books = readyCode().filter((b) => (metaOf(b).edition ?? "").startsWith(NCC_EDITION));
  if (!books.length) return null;
  const all = books.flatMap((b) => checkCodeBook(b).map((c) => ({ ...c, book: b.title || b.name })));
  // a clause counts as checked when some copy prints it with all its figures
  const byClause = new Map<string, (typeof all)[number][]>();
  for (const c of all) byClause.set(c.clause, [...(byClause.get(c.clause) ?? []), c]);
  const rows = [...byClause.values()].map((list) => list.find((c) => c.page !== null && !c.missing.length) ?? list.find((c) => c.page !== null) ?? list[0]);
  const ok = rows.filter((c) => c.page !== null && !c.missing.length);
  return {
    edition: NCC_EDITION,
    matched: `${ok.length} of ${rows.length} calculator clauses print the same figures in the shelf copy`,
    differ: rows.filter((c) => c.page !== null && c.missing.length).map((c) => ({ clause: c.clause, book: c.book, page: c.page, not_printed: c.missing })),
    not_found: rows.filter((c) => c.page === null).map((c) => c.clause),
  };
}
