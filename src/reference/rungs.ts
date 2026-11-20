// The ladder (Stage 20.3): how much each kind of source counts. Higher wins (1 is highest); when two disagree, the
// assistant says so and follows the higher. One place for it, used by the shelf (every reference tool's result carries
// its source's rung) and by the brain's rules (src/brain/sourceRules.ts).

export type Rung = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const RUNGS: Record<Rung, { name: string; say: string; settles_structure: boolean }> = {
  1: { name: "the job's own documents (engineer's and architect's drawings and specifications, approval conditions)", say: "it's on the job's drawings", settles_structure: true },
  2: { name: "the building code (NCC), in the edition that applies to the job", say: "that's the building code", settles_structure: true },
  3: { name: "an Australian Standard the job calls up (the owner's own copy)", say: "that's from the standard", settles_structure: true },
  4: { name: "the maker's current guide for the product actually used", say: "that's from the maker's guide", settles_structure: true },
  5: { name: "Australian design guides and data", say: "that's from Queensland's timber data", settles_structure: false },
  6: { name: "a general reference (an old joinery book, a handbook): how joints are made and proportioned, how timber behaves, principles", say: "that's traditional practice", settles_structure: false },
  7: { name: "its own judgement, said as such", say: "that's my own call", settles_structure: false },
};

/** The rung of a shelf book by its kind: the job's documents aren't on the shelf; a design reference says its own. */
export function rungOfKind(kind: string, own?: number | null): Rung {
  if (kind === "code") return 2;
  if (kind === "book") return 3;
  if (kind === "guide") return 4;
  if (kind === "design") return own && own >= 5 && own <= 6 ? (own as Rung) : 6;
  return 7;
}

/** What travels with a citation: the rung, in words, and whether that rung may settle a structural question. */
export const rungFacts = (r: Rung) => ({ rung: r, rung_is: RUNGS[r].name, ...(RUNGS[r].settles_structure ? {} : { structural: "This rung never settles a structural or safety-critical question (sizes, spans, bracing, tie-down, balustrade strength): that's the code, the standard, the maker or an engineer." }) });
