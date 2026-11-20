// Rules of thumb for design, with where they came from (Stage 20.2). Each rule has an id, the rule as a figure or
// range (code works it out, never the model), plain words, the source and the place in it, and how far it has been
// checked: "read" means the builder read it in that source on the shelf (14 November 2026) and quotes its words;
// "secondary" means it came from a summary and could not be found on the shelf, so its wording isn't confirmed and the
// assistant says so if it uses it. The joint recipes take their default proportions from here, so a recipe can say why
// ("tenon 15 mm: a third of the 45 mm rail (Fairham)"). Pure code: no files, no network.
//
// The old books are rung 6 of the ladder: for how joints are made and proportioned and how timber behaves, never for
// structural sizes, spans, glues, finishes or safety. A rule here is never a claim that a joint is strong enough.

export type RuleStatus = "read" | "secondary";
export type RuleSource = { ref: string; place: string; quote?: string };
export type DesignRule = {
  id: string;
  /**
   * a joint rule's few words for a shop drawing's joint schedule ("TENON 1/3 OF RAIL"); its book is added after it, and
   * the two together fit one line of the schedule's JOINT BY column (about 53 mm at 2.5 mm text)
   */
  short?: string;
  /** what it's about: a joint recipe's name, or a topic ("movement", "screws", "shelf") */
  applies: string[];
  /** the figure: a fraction of something, a range, or a number with its unit */
  value: { fraction?: number; of?: string; min?: number; max?: number; prefer?: number; unit?: string };
  words: string;
  sources: RuleSource[];
  status: RuleStatus;
  /** what wasn't confirmed, said plainly */
  unconfirmed?: string;
  /** a caution that goes with the rule */
  note?: string;
};

const FAIRHAM = "Fairham, Woodwork Joints (c. 1930)";
const NOYES = "Noyes, Handwork in Wood (1910)";
const GRIFFITH = "Griffith, Essentials of Woodworking (1908)";
const WS_FLOORING = "WoodSolutions Technical Design Guide 09, Timber Flooring";
const WS_STAIRS = "WoodSolutions Technical Design Guide 08, Stairs, Balustrades and Handrails";

export const DESIGN_RULES: DesignRule[] = [
  /* ---------------- mortise and tenon ---------------- */
  {
    id: "tenon_third",
    short: "TENON 1/3 OF RAIL",
    applies: ["mortise_tenon"],
    value: { fraction: 1 / 3, of: "the thickness of the rail" },
    words: "A single tenon is a third of the thickness of the timber, leaving the same on each side of the mortise.",
    sources: [
      { ref: FAIRHAM, place: "The Mortise and Tenon Joint, 'General Rule' (book page 82)", quote: "the thickness of the tenon should be one-third the thickness of the timber" },
      { ref: FAIRHAM, place: "The Mortise and Tenon Joint, 'The Tenons' (book page 85)", quote: "generally one-third the thickness of the timber" },
      { ref: NOYES, place: "Chapter VII, Mortise-and-tenon Joints (book page 160)", quote: "the thickness of the tenons, which is ordinarily one-third of the thickness of the frame" },
    ],
    status: "read",
  },
  {
    id: "haunch_groove",
    short: "HAUNCH = GROOVE",
    applies: ["mortise_tenon"],
    value: { fraction: 1 / 2, of: "the rail's width less the groove (the tenon's width)" },
    words: "On a grooved frame the tenon is about half the rail's width less the groove; a haunch the groove's width and depth fills the groove at the end.",
    sources: [
      { ref: NOYES, place: "Chapter VII, Mortise-and-tenon Joints (book page 160)", quote: "the tenon should be one-half the width of the rail, minus the groove. But enough of the tenon is left full width to fill up the groove" },
      { ref: FAIRHAM, place: "The Mortise and Tenon Joint, 'A Haunched Tenon' (book page 65)", quote: "the haunch is made the same width and the same depth as the groove" },
    ],
    status: "read",
  },
  {
    id: "groove_square",
    short: "SQUARE GROOVE",
    applies: ["mortise_tenon", "panel"],
    value: { fraction: 1, of: "the groove's width (its depth)" },
    words: "A panel groove is about as deep as it is wide, and the same width as the tenon, so the mortise is the groove's width.",
    sources: [{ ref: NOYES, place: "Chapter VII, Mortise-and-tenon Joints (book page 160)", quote: "the same width as the thickness of the tenons ... The groove is approximately as deep as it is wide ... The width of the mortise is equal to the width of the groove" }],
    status: "read",
  },
  {
    id: "horn",
    short: "HORN TILL GLUED",
    applies: ["mortise_tenon"],
    value: { min: 25, max: 75, unit: "mm" },
    words: "Leave a horn on the stile past the rail until it's glued up, so the end doesn't burst when the frame is cramped and wedged; then cut it off.",
    sources: [
      { ref: FAIRHAM, place: "The Mortise and Tenon Joint, 'A Stile and Cross Rail' (book page 68)", quote: "so that there will be no tendency for the stile to burst out at the end whilst the cramping and wedging of the frame is in progress. On completing the framing the horn is cut away" },
      { ref: FAIRHAM, place: "The Dowelling Joint, 'Frame Dowelling' (book page 100)", quote: "it is not cut off until after the frame is glued up" },
    ],
    status: "read",
    unconfirmed: "The 25 to 75 mm length is from a summary: the books give the reason, not a length.",
  },
  {
    id: "stopped_mortise",
    short: "MORTISE 7/8 DEEP",
    applies: ["mortise_tenon"],
    value: { fraction: 7 / 8, of: "the stile's width (light cabinet work)" },
    words: "In light cabinet work the mortise goes about seven eighths of the way through the stile, so the edge shows no joint.",
    sources: [{ ref: FAIRHAM, place: "The Mortise and Tenon Joint, 'Removing Haunching' (book page 89)", quote: "For light-class cabinet work it is usual to cut the mortise about seven-eighths of the distance through the stile" }],
    status: "read",
    note: "Light cabinet work only; the 3D recipe's framing default (two thirds of the post) isn't from a book.",
  },
  {
    id: "twin_tenons",
    short: "TWIN TENONS",
    applies: ["mortise_tenon"],
    value: { max: 75, unit: "mm", of: "the gap between two tenons" },
    words: "Thick timber takes twin tenons side by side instead of one.",
    sources: [{ ref: FAIRHAM, place: "The Mortise and Tenon Joint, 'Twin Tenons' (book page 80)", quote: "Twin Tenons with haunch, as used when the timber is of great thickness" }],
    status: "read",
    unconfirmed: "The 75 mm figure (twin tenons when the gap between would pass it) is from a summary: the book only says 'great thickness'.",
  },
  {
    id: "drawbore",
    short: "DRAWBORE 3 MM",
    applies: ["mortise_tenon"],
    value: { prefer: 3.175, unit: "mm", of: "the offset of the tenon's hole toward the shoulder (1/8 in)" },
    words: "For a drawbored joint, bore the tenon's hole about 3 mm (1/8 in) nearer the shoulder than marked, so the pin draws the shoulders tight.",
    sources: [{ ref: FAIRHAM, place: "The Mortise and Tenon Joint, 'Drawbore Pinning' (book page 78)", quote: "the hole bored about 1/8 in. nearer to the shoulder than as marked" }],
    status: "read",
  },
  /* ---------------- bridle and halving ---------------- */
  {
    id: "bridle_thirds",
    short: "BRIDLE IN THIRDS",
    applies: ["bridle"],
    value: { fraction: 1 / 3, of: "the thickness of the timber (the slot)" },
    words: "Set out a bridle in thirds of the thickness: the tongue a third, the cheeks either side the same.",
    sources: [{ ref: FAIRHAM, place: "The Bridle Joint, 'Setting Out and Marking' (book page 39)", quote: "divide the thickness of the timber into three equal parts" }],
    status: "read",
  },
  {
    id: "halving_half",
    short: "HALF FROM EACH",
    applies: ["half_lap"],
    value: { fraction: 1 / 2, of: "the thickness of each piece" },
    words: "A halving takes half the depth out of each piece, so the faces finish flush.",
    sources: [
      { ref: FAIRHAM, place: "The Halved Joint (book page 13)", quote: "made by halving the two pieces, i.e., by cutting half the depth of the wood away" },
      { ref: NOYES, place: "Chapter VII, Halving-joints (book page 155)", quote: "half the thickness of each member is notched out" },
    ],
    status: "read",
  },
  /* ---------------- dovetails ---------------- */
  {
    id: "dovetail_slope",
    short: "DOVETAIL SLOPE",
    applies: ["dovetail"],
    value: { min: 5, max: 8, prefer: 8, unit: "1 in n" },
    words: "A dovetail's slope: Fairham says 1 in 8 is correct and never steeper than 1 in 6; Noyes sets his out at about 1 in 5.",
    sources: [
      { ref: FAIRHAM, place: "The Dovetail Joint, 'Angles' (book page 134)", quote: "An inclination of one in eight is considered correct; no hard and fast rule need be obeyed, but the variation should on no account be less than one in six" },
      { ref: NOYES, place: "Chapter VII, Dovetail Joints (book page 164)", quote: "the long side of which is 3\" and the short side ⅝\" ... a little more than one to five" },
    ],
    status: "read",
    note: "The books differ at the steep end: Noyes sets out about 1 in 5; Fairham says never steeper than 1 in 6.",
  },
  {
    id: "lap_dovetail_lap",
    short: "6 LAP ON FRONT",
    applies: ["dovetail"],
    value: { prefer: 6.35, unit: "mm", of: "the lap left on a lap-dovetailed drawer front (1/4 in)" },
    words: "On a lap-dovetailed drawer front, leave a lap of about 6 mm (1/4 in).",
    // First marked "not found": the builder's search missed "1/4-in." with its hyphen. The brain found it in the source
    // check (20.4, round 1), and it was then read in the book.
    sources: [{ ref: FAIRHAM, place: "The Dovetail Joint, 'Gauging' (book page 135)", quote: "The gauge is now readjusted so as to leave a 1/4-in. lap on the front" }],
    status: "read",
  },
  /* ---------------- dowels ---------------- */
  {
    id: "edge_dowels",
    short: "DOWELS 230-250 C/C",
    applies: ["dowel", "edge_joint"],
    value: { min: 228.6, max: 254, unit: "mm", of: "the spacing of dowels along a glued edge joint (9 to 10 in)" },
    words: "Dowels in an edge joint go about 230 to 250 mm (9 to 10 in) apart, with two at each end.",
    sources: [{ ref: FAIRHAM, place: "The Dowelling Joint, 'Making Dowels' (book page 93)", quote: "place the dowels 9 ins. to 10 ins. apart, and place two dowels at each end" }],
    status: "read",
    note: "For edge joints in tops and ends; the dowel recipe (a rail into a post) doesn't use it.",
  },
  /* ---------------- scarfs and glue ---------------- */
  {
    id: "framing_scarf",
    short: "SCARF 4-5 X DEPTH",
    applies: ["scarf"],
    // prefer: the short end, Fairham's purlin scarf ("about four times"), which the scarf recipe takes for its
    // stop-splayed and tabled kinds
    value: { min: 4, max: 5, prefer: 4, unit: "times the depth", of: "the length of a framing scarf" },
    words: "A framing scarf is about four to five times as long as the timber is deep.",
    sources: [
      { ref: FAIRHAM, place: "The Scarf Joint (book page 103), the purlin scarf", quote: "the length of the scarf is usually made about four times that of the depth of tie beam" },
      { ref: FAIRHAM, place: "The Scarf Joint (book page 103), the tabled scarf", quote: "The length of the joint should be approximately five times its thickness" },
    ],
    status: "read",
    note: "A scarf in a beam, joist or anything holding people up is an engineer's or the maker's call, never this rule's.",
  },
  {
    id: "glued_scarf",
    short: "SLOPE 1 IN 12+",
    applies: ["scarf"],
    value: { min: 12, unit: "1 in n (or flatter)" },
    words: "A glued plain scarf is 1 in 12 or flatter.",
    sources: [{ ref: "a secondary summary", place: "not found on the shelf" }],
    status: "secondary",
    unconfirmed: "Not on the shelf (it's a Wood Handbook figure, and that book isn't on it); wording not confirmed.",
  },
  {
    id: "end_grain_glue",
    applies: ["butt", "glue"],
    value: {},
    words: "End grain doesn't hold glue: a glued joint wants side grain to side grain.",
    sources: [
      { ref: NOYES, place: "Chapter V, Glue (book page 128)", quote: "Glue holds best on side grain. End grain can be made to stick only by sizing with thin glue ... such joints are seldom good" },
      { ref: GRIFFITH, place: "Chapter VII, 75. Gluing (book page 83)", quote: "Where the end grain is to form part of a glue joint, it is necessary to apply a glue size first" },
    ],
    status: "read",
    note: "The principle only: which glue to use comes from the glue maker's sheet, never the old books.",
  },
  /* ---------------- movement ---------------- */
  {
    id: "panel_float",
    short: "PANEL FLOATS",
    applies: ["movement", "panel"],
    value: {},
    words: "A panel floats in its groove, free to shrink and swell; it isn't glued in.",
    sources: [
      { ref: NOYES, place: "Chapter VIII, (3) Panel Structures (book page 192)", quote: "a thin board or panel which is free to shrink or swell ... in which the panel is to lie and have free play" },
      { ref: NOYES, place: "Chapter VII, Mortise-and-tenon Joints (book page 160)", quote: "put soap or tallow on the corners of the panel to prevent its being glued to the frame" },
    ],
    status: "read",
  },
  {
    id: "top_buttoned",
    short: "TOP ON BUTTONS",
    applies: ["movement", "table"],
    value: {},
    words: "A table top is held with buttons at the sides and back, not screwed down tight, so it can shrink without splitting.",
    sources: [{ ref: FAIRHAM, place: "Miscellaneous Joints, 'Buttoning' (book page 184)", quote: "buttons should be employed ... so that the top is free to shrink. It is otherwise liable to split if immovably fixed" }],
    status: "read",
  },
  {
    id: "cleat_slots",
    short: "SLOTTED HOLES",
    applies: ["movement", "screws"],
    value: {},
    words: "Screw holes through a cleat across a wide board are slotted (or oversize), so the screws can move as it shrinks.",
    sources: [
      { ref: FAIRHAM, place: "Miscellaneous Joints, 'Battening' (book page 187)", quote: "slots are cut so as to allow the screws to move along the slots when shrinkage takes place" },
      { ref: NOYES, place: "Chapter VIII, (2) Board Structures (book page 184)", quote: "the screw holes being large enough to allow for shrinkage" },
    ],
    status: "read",
  },
  {
    id: "tangential_radial",
    applies: ["movement"],
    value: { prefer: 2, unit: "times", of: "tangential shrinkage over radial (general)" },
    words: "Timber moves more along the growth rings (tangential, a backsawn board's width) than across them (radial, quartersawn).",
    sources: [
      { ref: GRIFFITH, place: "Chapter X, 117. Shrinkage (book page 122)", quote: "a log shrinks more circumferentially, that is along the rings, than it does radially" },
      // WoodSolutions' terms are personal use (held by the owner's decision), so its words aren't copied here: the place only
      { ref: WS_FLOORING, place: "Appendix A4 (page 92): a backsawn board's cover width moves tangentially, a quartersawn board's radially" },
    ],
    status: "read",
    unconfirmed: "'About twice' is from a summary: the books say only 'more'. Use the species' own tangential and radial figures from the Queensland data.",
  },
  {
    id: "movement_formula",
    applies: ["movement"],
    value: {},
    words: "Movement = width × unit shrinkage (% per 1% change in moisture content) × the change in moisture content ÷ 100.",
    sources: [{ ref: WS_FLOORING, place: "Appendix A4 (page 92): unit tangential movement, and its worked example for an 80 mm board" }],
    status: "read",
    note: "The guide adds that real movement is often less than this estimate.",
  },
  /* ---------------- screws ---------------- */
  {
    id: "screw_clearance",
    short: "CLEARANCE HOLE",
    applies: ["screws"],
    value: { fraction: 1, of: "the screw's shank" },
    words: "The hole through the top piece is the shank's size, so the screw pulls the pieces together.",
    sources: [{ ref: GRIFFITH, place: "Chapter VII, 72. Fastening with Screws (book page 79)", quote: "a hole just large enough to take in the shank of the screw must be bored in the upper part" }],
    status: "read",
    note: "The screw maker's own hole sizes win over this.",
  },
  {
    id: "screw_pilot",
    short: "PILOT 70-90%",
    applies: ["screws"],
    value: { min: 0.7, max: 0.9, of: "the screw's root (core): about 70% in softwood, 90% in hardwood" },
    words: "The pilot hole in the bottom piece is about 70% of the screw's root in softwood and 90% in hardwood.",
    sources: [
      { ref: "a secondary summary", place: "not found on the shelf" },
      { ref: GRIFFITH, place: "Chapter VII, 72. Fastening with Screws (book page 79)", quote: "In the lower part, a hole should be bored just large enough to take in the core of the screw snugly ... In soft woods, the boring of a hole in the lower piece may be omitted" },
    ],
    status: "secondary",
    unconfirmed: "The 70% and 90% figures are not on the shelf. Griffith (1908) says a hole the core's size in hardwood and none needed in softwood. The screw maker's own pilot sizes win over both.",
  },
  /* ---------------- shelves ---------------- */
  {
    id: "beam_sag",
    applies: ["shelf"],
    value: {},
    words: "Sag of a shelf resting on its ends under an even load: 5 × w × L⁴ ÷ (384 × E × I), with I = b × d³ ÷ 12.",
    sources: [{ ref: "standard beam theory (simply supported, uniform load)", place: "not looked up on the shelf" }],
    status: "secondary",
    unconfirmed: "The textbook beam formula; no book on the shelf prints it.",
  },
  {
    id: "shelf_sag_target",
    applies: ["shelf"],
    value: { prefer: 1.7, unit: "mm per metre of span", of: "the sag when first loaded" },
    words: "A shelf that sags less than about 1.7 mm per metre of span looks flat.",
    sources: [{ ref: "a secondary summary (a woodworkers' shelf-sag rule of thumb)", place: "not found on the shelf" }],
    status: "secondary",
    unconfirmed: "Not on the shelf; wording and figure not confirmed.",
  },
  {
    id: "shelf_creep",
    applies: ["shelf"],
    value: { prefer: 1.5, unit: "times the first sag", of: "the sag after a long time under load" },
    words: "Left loaded for a long time, a timber shelf keeps sagging: allow about half as much again.",
    sources: [{ ref: "a secondary summary", place: "not found on the shelf" }],
    status: "secondary",
    unconfirmed: "Not on the shelf; wording and figure not confirmed.",
  },
  {
    id: "stiffness_groups",
    applies: ["shelf"],
    value: {},
    words: "General stiffness (modulus of elasticity) figures for three groups of timber, used when the species' own figure isn't on the shelf: hardwood 16,000 MPa, Australian softwood 9,100 MPa, imported softwood 6,900 MPa.",
    sources: [{ ref: WS_STAIRS, place: "page 32, the notes to Table 6.1 (the three groups, their stiffness and the species named for each)" }],
    status: "read",
    note: "WoodSolutions' figures for the materials in its handrail tables, cited as theirs: a general figure, not the species' own. It also says softwood not certified as Australian grown takes the imported figure.",
  },
];

/** The general stiffness figures (stiffness_groups), MPa, with the example species the guide names for each. */
export const STIFFNESS_GROUPS = {
  hardwood: { e_mpa: 16000, words: "hardwood (WoodSolutions' F22 example)", examples: ["spotted gum", "ironbark", "blackbutt", "kwila", "merbau"] },
  australian_softwood: { e_mpa: 9100, words: "Australian softwood (WoodSolutions' example)", examples: ["radiata", "hoop", "slash pine", "meranti"] },
  imported_softwood: { e_mpa: 6900, words: "imported softwood (WoodSolutions' example)", examples: ["new zealand radiata"] },
} as const;
export type StiffnessGroup = keyof typeof STIFFNESS_GROUPS;

export function rule(id: string): DesignRule {
  const r = DESIGN_RULES.find((x) => x.id === id);
  if (!r) throw new Error(`no design rule ${id}`);
  return r;
}

/** "Fairham, Woodwork Joints (c. 1930), The Mortise and Tenon Joint, 'General Rule' (book page 82)": a rule's first source, in one line. */
export const ruleCite = (r: DesignRule) => `${r.sources[0].ref}${r.sources[0].place && r.sources[0].place !== "not found on the shelf" ? `, ${r.sources[0].place}` : ""}${r.status === "secondary" ? " (from a summary; not confirmed on the shelf)" : ""}`;

/** The short author for a recipe's "why" ("Fairham"), or "a summary" for an unconfirmed rule. */
const who = (r: DesignRule) => (r.status === "secondary" ? "a summary, not confirmed" : r.sources[0].ref.split(",")[0]);

/**
 * A fraction rule applied to a size, the way the recipes use it, with the reason in words: tenon(45) -> 15, "a third of
 * the 45 mm rail (Fairham)". Rounded as the recipe rounds (round: whole millimetres; exact: as it comes).
 */
export function fractionOf(id: string, size: number, o: { round?: boolean; what?: string } = {}) {
  const r = rule(id);
  if (r.value.fraction === undefined) throw new Error(`design rule ${id} has no fraction`);
  const v = size * r.value.fraction;
  const out = o.round === false ? v : Math.round(v);
  const frac = r.value.fraction === 1 / 3 ? "a third" : r.value.fraction === 1 / 2 ? "half" : r.value.fraction === 7 / 8 ? "seven eighths" : `${r.value.fraction}`;
  return { value: out, why: `${frac} of the ${Math.round(size * 10) / 10} mm ${o.what ?? r.value.of ?? ""}`.replace(/\s+/g, " ").trim() + ` (${who(r)})`, rule: r };
}

/**
 * A multiple rule applied to a size, the way the scarf recipe uses it, with the reason in words: framing_scarf(90) ->
 * 360, "four times the 90 mm depth (Fairham)". Takes the rule's preferred multiple, else its least.
 */
export function timesOf(id: string, size: number, o: { what?: string } = {}) {
  const r = rule(id);
  const k = r.value.prefer ?? r.value.min;
  if (k === undefined) throw new Error(`design rule ${id} has no multiple`);
  const words = ["", "once", "twice", "three times", "four times", "five times", "six times"][k] ?? `${k} times`;
  return { value: k * size, why: `${words} the ${Math.round(size * 10) / 10} mm ${o.what ?? "depth"} (${who(r)})`, rule: r };
}

/** A check of a value against a range rule: inside it, or which way it's out and what the sources say. */
export function checkRange(id: string, v: number): { ok: boolean; words: string } {
  const r = rule(id);
  const { min, max, unit } = r.value;
  const inside = (min === undefined || v >= min) && (max === undefined || v <= max);
  return { ok: inside, words: `${v}${unit ? ` ${unit}` : ""} is ${inside ? "inside" : "outside"} ${min ?? "-"} to ${max ?? "-"}${unit ? ` ${unit}` : ""}: ${r.words} (${ruleCite(r)})` };
}

/** The rules for a recipe or a topic, as the brain is handed them. */
export const rulesFor = (what: string) =>
  DESIGN_RULES.filter((r) => r.applies.includes(what)).map((r) => ({ id: r.id, rule: r.words, source: ruleCite(r), checked: r.status === "read" ? "read in the source by the builder" : "from a secondary summary; wording not confirmed", ...(r.unconfirmed ? { not_confirmed: r.unconfirmed } : {}), ...(r.note ? { note: r.note } : {}) }));

/**
 * The rules a joint's design record may name (Stage 19.7's record, connected at the merge): the joint rules, which have a
 * few words for the drawing. A model's design says, for each joint, the rules its proportions follow; the shop drawing's
 * joint schedule names them under a suggestion.
 */
export const JOINT_RULE_IDS = DESIGN_RULES.filter((r) => r.short).map((r) => r.id) as [string, ...string[]];

/**
 * A rule as the joint schedule names it, in a few words with where it came from: "TENON 1/3 OF RAIL, FAIRHAM". A rule
 * not confirmed on the shelf says so instead of a source ("SLOPE 1 IN 12+, UNCONFIRMED"). Null: not a joint rule.
 */
export function scheduleLabel(id: string): string | null {
  const r = DESIGN_RULES.find((x) => x.id === id);
  if (!r?.short) return null;
  return `${r.short}, ${r.status === "secondary" ? "UNCONFIRMED" : r.sources[0].ref.split(",")[0].toUpperCase()}`;
}

/** Which recipe defaults come from which rule (a recipe's param -> rule id): what each recipe can say about why. */
export const RECIPE_RULES: Record<string, Record<string, string>> = {
  mortise_tenon: { tenon: "tenon_third" },
  bridle: { slot: "bridle_thirds" },
  half_lap: { depth: "halving_half" },
  dovetail: { slope: "dovetail_slope" },
  // scarf (Stage 19's kinds; connected at the merge): a stop-splayed or tabled scarf's length is framing_scarf's four
  // times the depth (Fairham). The halved splice's three times and the plain scarf's 1 in 8 are the recipe's own, from
  // no rule on the shelf (glued_scarf, not confirmed, says 1 in 12 or flatter for a glued one), so they give no reason;
  // and the bolts' spacing (4 diameters) stays a rule of thumb with no source, said so in the recipe and its note.
  scarf: { length: "framing_scarf" },
};
