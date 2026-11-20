// How the assistant uses what is on its shelf (Stage 20.3): the ladder and the rules, in one place, applied to every
// answer that draws on a reference, a maker's guide, the code, a calculator or its own judgement. Registered with the
// standing rules in rules.ts (one import). The ladder's rungs themselves are src/reference/rungs.ts, which every
// reference tool's result quotes, so the model never has to remember them.
//
// The code edition (codeEdition): in NSW the edition for a job is set by when the application for its Construction
// Certificate or Complying Development Certificate was lodged. Checked 14 November 2026 on the NSW Government's "How
// to comply with the National Construction Code" (last updated 13 May 2026):
//   https://www.nsw.gov.au/housing-and-construction/compliance-and-regulation/how-to-comply-national-construction-code
//   "Applications for a Complying Development Certificate that are lodged on or after 29 July 2025" and "Applications
//   for most Construction Certificates that are lodged on or after 29 July 2025" are assessed against NCC 2022
//   Amendment 2; "NSW will adopt NCC 2025 on 1 May 2027". The page doesn't say which edition applies before 29 July
//   2025, how applications around 1 May 2027 are treated, or anything about modified certificates; nor does it give
//   other states' dates. So none of that is in here: the assistant says it hasn't checked.
// Amendments 1 and 2 to NCC 2022 don't change Housing Provisions Parts 10.3, 11.2 or 11.3 (read in Stage 14; see
// src/shared/calc/ncc.ts), so the stair and barrier calculators' figures hold for NCC 2022 in any amendment.
import { RUNGS } from "../reference/rungs.js";

const ladder = ([1, 2, 3, 4, 5, 6, 7] as const).map((r) => `${r} ${RUNGS[r].name.replace(/^its own judgement/, "your own judgement")}`).join("; ");

export const SOURCE_RULES = `How you use your sources (the ladder; this is the one place for it):
- The ladder, higher wins: ${ladder}. When two disagree, say so and follow the higher. Every reference and calculator
  result says its rung, cautions and what it's never to be used for: read them, don't rely on memory.
- Say where it came from, every time, even for a figure given in passing to compare: by voice a few words ("that's from Hardie's Linea guide", "that's the old rule
  from Fairham", "that's Queensland's timber data", "that's my own call"); on screen in full (source, edition or date,
  place, and the passage or page). "Where did you get that?": how_do_you_know.
- Never a figure from nowhere. A figure comes from a page or passage read this turn, a tool's result, or the user. If
  you have none of those, either say plainly it's your own judgement ("my own rough call, not from anything on my
  shelf") or say you don't have it, and say what would settle it. Never round a remembered number into an answer that
  sounds looked up. "Just give me a number" doesn't change this: give your own call, said as such, or none. Side
  remarks too: a regulation, a limit or a date said in passing needs its source, or leave it out.
- Use each source for what it's good for. The old joinery books (rung 6): joint types, proportions, setting out, why a
  joint suits a job, how timber behaves. Never structural sizes, spans, glues, finishes, preservatives or safety
  practice, and nothing the code or a maker covers: for those say the book is the wrong source and use the right one.
  Their inches come already in millimetres: give the millimetres with the inches in brackets once. A US handbook:
  principles only; its species, grades and codes are not ours. A maker's guide: only for that maker's product, never
  blended with another maker's. Design rules (design_rules): proportions with their source; one "from a summary" is
  said as such.
- Structural or safety-critical things (member sizes, spans, bracing, tie-down, balustrade strength, anything holding
  people up) are never settled by rungs 5 to 7. Only the job's documents, the code, a standard on the shelf, the
  maker's tables, or an engineer: if none on the shelf covers it, say an engineer (or the maker) is needed. A joint
  modelled or drawn is not a claim that it's strong enough.
- Check old against new: when you take something from rung 5 to 7 and a higher rung also speaks to it (a maker's guide
  for that product, the code), check the higher one and say if they differ.
- Know the edition and the date. The building code: the edition for a job is set by its state and, in NSW, when the
  application for its Construction Certificate or Complying Development Certificate was lodged. When a code answer
  depends on it, use code_edition with the state and lodgement date from the job's documents or the user; if you
  weren't told, ask once, or say plainly you're assuming the edition in force today in NSW. Never assume the newest
  edition. Outside NSW, say you haven't checked that state's adoption dates, unless you check that state's own
  government page now (then name it, and still say the certifier confirms). The NCC names Australian Standards: name
  the standard and stop (their content is only on the shelf as the user's own standards books). A maker's guide: its
  date in every citation, and say if it's over two years old. An old book: its year, said once.
- Doubt what deserves doubt: a source marked uncited, or a rule from a summary, is checked against a second source
  before it's used, or offered as "one source says".
- A web page stands where its publisher does: a maker's own site counts as that maker's guide, a government page as
  that body's. Anything else (a supplier, a forum, Wikipedia) is "one source says": name who published it, say it's
  from the web, not your shelf, check it against a second, and never use it to settle anything structural.
- Design choices carry their reason (said here only; the 3D model rules point here): when you design something (a
  piece and how it goes together, a set-out), each choice you report has a one-line reason and where it came from: the
  user's instruction, a design rule with its source (design_rules: "a third of the rail, Fairham's rule"), or your own
  judgement, said as such ("my own call"). What you record says the same, so the drawing says what you said.
- Don't lecture: one short line of source by voice, the detail on screen for when they want it.`;

/* ---------------- the edition of the code for a job ---------------- */

export const NSW_EDITION_PAGE = "NSW Government, How to comply with the National Construction Code (updated 13 May 2026)";
export const NSW_EDITION_URL = "https://www.nsw.gov.au/housing-and-construction/compliance-and-regulation/how-to-comply-national-construction-code";
/** The NSW dates the page gives (lodgement of the CC or CDC application). */
export const NSW_EDITIONS = [
  { from: "2025-07-29", edition: "NCC 2022 Amendment 2" },
  { from: "2027-05-01", edition: "NCC 2025" },
] as const;

const STATES: Record<string, string> = { nsw: "NSW", "new south wales": "NSW", qld: "Queensland", queensland: "Queensland", vic: "Victoria", victoria: "Victoria", act: "the ACT", tas: "Tasmania", tasmania: "Tasmania", sa: "South Australia", "south australia": "South Australia", wa: "Western Australia", "western australia": "Western Australia", nt: "the Northern Territory", "northern territory": "the Northern Territory" };

export type EditionAnswer = { edition: string | null; known: boolean; assumed: boolean; why: string; calculators: string; source: string };

/**
 * The code edition for a job, from its state and the day its CC or CDC application was lodged (NSW only, from the NSW
 * page above). No date: the edition in force today, said as an assumption. Before 29 July 2025, or another state: not
 * checked, said plainly.
 */
export function codeEdition(o: { state?: string; lodged?: string }, today = new Date()): EditionAnswer {
  const st = o.state ? STATES[o.state.trim().toLowerCase().replace(/\.$/, "")] ?? o.state.trim() : "NSW";
  const assumedState = !o.state;
  const source = `${NSW_EDITION_PAGE}, ${NSW_EDITION_URL}`;
  const calcNote = "The stair and barrier calculators' figures are from NCC 2022 Housing Provisions Parts 10.3, 11.2 and 11.3, which Amendments 1 and 2 didn't change.";
  if (st !== "NSW")
    return { edition: null, known: false, assumed: false, why: `I haven't checked which edition ${st} applies or when it changed: ask the certifier, or check the state's own adoption dates. Don't assume NSW's.`, calculators: `${calcNote} They haven't been checked against any other edition.`, source };
  const day = o.lodged && /^\d{4}-\d{2}-\d{2}$/.test(o.lodged) ? o.lodged : null;
  if (o.lodged && !day) return { edition: null, known: false, assumed: false, why: "Give the lodgement date as a full date (2025-08-14).", calculators: calcNote, source };
  const at = day ?? today.toISOString().slice(0, 10);
  const hit = [...NSW_EDITIONS].reverse().find((e) => at >= e.from);
  const where = assumedState ? " (assuming the job is in NSW)" : "";
  if (!hit)
    return {
      edition: null,
      known: false,
      assumed: false,
      why: `Lodged ${at}, before NCC 2022 Amendment 2 took effect for NSW applications (29 July 2025)${where}, so an earlier edition applies. Which one isn't on the NSW page I checked: ask the certifier, or read it off the certificate.`,
      calculators: `${calcNote} So they hold if it's NCC 2022 with an earlier amendment; for NCC 2019 they haven't been checked.`,
      source,
    };
  const late = hit.edition === "NCC 2025";
  return {
    edition: hit.edition,
    known: !!day,
    assumed: !day,
    why: day
      ? `In NSW a job's edition is set by when its CC or CDC application was lodged: lodged ${day}${where}, it's ${hit.edition}.${late ? " How applications around 1 May 2027 are treated hadn't been published when I checked: confirm with the certifier." : ""}`
      : `I wasn't told when the application was lodged, so I'm assuming today's NSW edition, ${hit.edition}${where}. If the CC or CDC application went in earlier, the edition may be different.`,
    calculators: late ? `${calcNote} They haven't been checked against NCC 2025.` : calcNote,
    source,
  };
}
