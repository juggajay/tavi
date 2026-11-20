import { db } from "../store/db.js";
import { ownerNames, readUser } from "../profile/profile.js";
import { namesToHear } from "../profile/voiceCard.js";
import { aboutCard } from "../hq/about.js";

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** `own` is how many of the first texts are his own notes; the rest are files. Left out, every text counts as his own notes. */
export type PrivateWords = { names: string[]; texts: string[] | (() => Iterable<string>); own?: number };
export const namesInContext = (text: string) => text.split(/\r?\n/).flatMap((line) => namesToHear(`## People\n- ${line}`)).flatMap((name) => [name, ...name.split(/\s+/).filter((w) => w.length >= 3)]);

export function privateWords(): PrivateWords {
  const notes = db.prepare("SELECT kind, subject, fact FROM memories WHERE status = 'active'").all() as { kind: string; subject: string; fact: string }[];
  const about = aboutCard();
  const user = readUser();
  const names = [...ownerNames(user), ...namesToHear(user),
    ...about.split(/\r?\n/).flatMap((line) => namesToHear(`## People\n- ${line}`)),
    ...notes.flatMap((n) => [...(n.kind === "person" ? [n.subject] : namesToHear(`## People\n- ${n.subject}`)), ...namesToHear(`## People\n- ${n.fact}`)])];
  // Read one stored passage at a time. Large files must not all be held in memory.
  function* texts() {
    yield user; yield about;
    for (const n of notes) yield n.fact;
    for (const row of db.prepare("SELECT text FROM doc_parts").iterate()) yield String(row.text);
    for (const row of db.prepare("SELECT body FROM sheet_fts").iterate()) yield String(row.body);
  }
  return { names: [...new Set(names.flatMap((n) => [n, ...n.split(/\s+/).filter((w) => w.length >= 3)]))], texts, own: 2 + notes.length };
}

// How much of his own words must be repeated before a query is refused. Three ordinary words in a row turn up in any
// long document, so short matches refused plain public questions ("fire door inspection" is in every door schedule).
const OWN_WORDS = { run: 5, letters: 24 };   // his profile, about card and memory notes
const FILE_WORDS = { run: 8, letters: 40 };  // his files and drawings
const PHONE = /(?<![\d.])(?:\+\d{1,3}[\s().-]*\d(?:[\s().-]*\d){7,11}|\(?0\d\)?(?:[\s.-]?\d){8})(?![\d.])|(?<![\d.])\d{10,}(?![\d.])/;
// A number, a name, then a street word. Words that are also everyday words (way, place, court, drive) count only when
// written as part of a name, with a capital, so "2026 changes to court rules" is not taken for an address.
const STREET = /\b\d{1,5}[a-z]?\s+(?:[\p{L}'-]+\s+){1,3}(?:street|st|road|rd|avenue|ave|lane|crescent|cres|parade|pde|terrace|tce|highway|hwy|boulevard|blvd)\b/iu;
const STREET_NAMED = /\b\d{1,5}[A-Za-z]?\s+(?:\p{Lu}[\p{L}'-]*\s+){1,3}(?:Way|Place|Pl|Court|Ct|Drive|Dr|Ln|Close|Cl)\b/u;

/** Why these words may not leave the PC, or null when they may. `address` is for a web address, where only names,
 *  contact details and hidden text are looked for: an address is not his own writing. */
export function privacyReason(raw: string, known: PrivateWords, kind: "words" | "address" = "words"): string | null {
  let s = raw.normalize("NFKC");
  try { s = decodeURIComponent(s); } catch { return "Use plain words without hidden or encoded text."; }
  if (/%[0-9a-f]{2}|[​-‏‪-‮⁦-⁩]/i.test(s)) return "Use plain words without hidden or encoded text.";
  if (/@|\b[\w.+-]+\s*\bat\b\s*[\w.-]+\s*\bdot\b\s*\w+/i.test(s)) return "Leave out email addresses and ask about the public subject only.";
  if (PHONE.test(s)) return "Leave out phone numbers and ask about the public subject only.";
  if (kind === "words" && (STREET.test(s) || STREET_NAMED.test(s))) return "Leave out street addresses and ask about the public subject only.";
  const q = ` ${fold(s)} `;
  if (known.names.some((n) => fold(n).length >= 2 && q.includes(` ${fold(n)} `))) return "That includes a private name. Replace it with words about the public subject.";
  if (kind === "address") return null;
  const words = fold(s).split(" ");
  if (words.length < OWN_WORDS.run) return null;
  const all = typeof known.texts === "function" ? known.texts() : known.texts;
  const own = known.own ?? Infinity;
  let seen = 0;
  for (const text of all) {
    const need = seen++ < own ? OWN_WORDS : FILE_WORDS;
    if (words.length < need.run) continue;
    const t = ` ${fold(text)} `;
    for (let i = 0; i + need.run <= words.length; i++) {
      const part = words.slice(i, i + need.run).join(" ");
      if (part.length >= need.letters && t.includes(` ${part} `)) return "That repeats private notes or file text. Write a general question in fresh words.";
    }
  }
  return null;
}
