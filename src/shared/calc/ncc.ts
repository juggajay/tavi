// The National Construction Code figures the trade calculators check against (Stage 14.2). Every figure here was read
// from the ABCB's own published code on 14 November 2026, and each says the clause, the edition and the page address.
// Nothing here comes from a Standards Australia document: where the code points to a standard, the calculators name
// the standard and never read or quote it.
//
// The edition: in NSW the code in force is NCC 2022 (as amended by Amendment 2, in effect from 29 July 2025), until NSW
// adopts NCC 2025 on 1 May 2027. Checked on 14 November 2026 at:
//   https://www.nsw.gov.au/housing-and-construction/compliance-and-regulation/how-to-comply-national-construction-code
//     ("The current edition of the Code is NCC 2022 Amendment 2, which came into effect on 29 July 2025"; "NSW will
//     adopt NCC 2025 on 1 May 2027"; page last updated 13 May 2026)
//   https://www.nsw.gov.au/ministerial-releases/nsw-to-adopt-new-national-construction-code-may-2027 (25 March 2026)
// The ABCB publishes NCC 2022's Housing Provisions online as first adopted (1 May 2023); the amendments are separate:
//   Amendment 1 (in effect 1 May 2025) changes Housing Provisions Parts 3.2, 6.3, 7.4, 8.2, 13.2 and 13.3 only:
//     https://ncc.abcb.gov.au/sites/default/files/resources/2025/NCC%202022%20Amdt%201%20v1.1.pdf
//   Amendment 2 (in effect 29 July 2025) changes only the AS 1428.1 references and Volumes One and Three:
//     https://www.abcb.gov.au/sites/default/files/resources/2025/NCC%202022%20Amdt%202_0.pdf
// so Parts 10.3, 11.2 and 11.3 below read the same in NCC 2022 as amended.
//
// Licence: the ABCB's notice says CC BY-ND 4.0 (no derivatives; a verbatim copy only), with this attribution:
//   https://ncc.abcb.gov.au/editions/ncc-2022/adopted/housing-provisions/front-matter/copyright-and-licence-notice
// So only the figures and clause numbers are used here (facts), never the code's wording, and every answer carries the
// attribution line.

/** The edition these figures were read from, and every edition they have been reviewed for. */
export const NCC_EDITION = "NCC 2022";
export const NCC_REVIEWED_FOR = ["NCC 2022"] as const;
export const NCC_READ_ON = "2026-11-14";
export const NCC_ATTRIBUTION = "© Commonwealth of Australia and the States and Territories 2022, published by the Australian Building Codes Board (CC BY-ND 4.0).";

const HP = "https://ncc.abcb.gov.au/editions/ncc-2022/adopted/housing-provisions";
export const NCC_PAGES = {
  stairs: `${HP}/11-safe-movement-and-access/part-112-stairway-and-ramp-construction`,
  barriers: `${HP}/11-safe-movement-and-access/part-113-barriers-and-handrails`,
  heights: `${HP}/10-health-and-amenity/part-103-room-heights`,
} as const;

/** The edition of the code and where it was read, for an answer's source line. */
export const nccSource = (clause: string) => `${NCC_EDITION} Housing Provisions ${clause}`;

export type StairKind = "standard" | "spiral" | "attic";

export const NCC_STAIRS = {
  /** 11.2.2(1)(b): each flight not more than 18 and not less than 2 risers. NCC 2022, NCC_PAGES.stairs */
  risersPerFlight: { min: 2, max: 18, clause: "11.2.2(1)(b)" },
  /**
   * Table 11.2.2a, riser (R), going (G) and slope relationship (2R + G), mm. NCC 2022, NCC_PAGES.stairs
   *   Stairs (other than spiral): R 115 to 190, G 240 to 355, 2R+G 550 to 700
   *   Spiral: R 140 to 220, G 210 to 370, 2R+G 590 to 680
   * Table 11.2.2b, stairs serving only non-habitable rooms (attics, storerooms) not used regularly or daily, by 11.2.2(2):
   *   R 130 to 225, G 215 to 355, 2R+G 540 to 700 (and the constancy rule in 11.2.2(1)(d) doesn't apply)
   */
  dims: {
    standard: { riser: [115, 190], going: [240, 355], twoRG: [550, 700], clause: "Table 11.2.2a" },
    spiral: { riser: [140, 220], going: [210, 370], twoRG: [590, 680], clause: "Table 11.2.2a (spiral)" },
    attic: { riser: [130, 225], going: [215, 355], twoRG: [540, 700], clause: "Table 11.2.2b" },
  } satisfies Record<StairKind, { riser: [number, number]; going: [number, number]; twoRG: [number, number]; clause: string }>,
  /** 11.2.2(1)(d): adjacent risers or goings differ by 5 mm at most; the largest and smallest in a flight by 10 mm at most. NCC 2022, NCC_PAGES.stairs */
  variation: { adjacent: 5, flight: 10, clause: "11.2.2(1)(d)" },
  /** 11.2.2(1)(e): open risers must not let a 125 mm sphere through between the treads. NCC 2022, NCC_PAGES.stairs */
  openRiserSphere: { mm: 125, clause: "11.2.2(1)(e)" },
  /** 11.2.2(3): in a flight, up to 3 consecutive winders in place of a quarter landing, up to 6 in place of a half. NCC 2022, NCC_PAGES.stairs */
  winders: { quarter: 3, half: 6, clause: "11.2.2(3)" },
  /**
   * 11.2.2(4): a tapered tread's going (not spiral) is measured at the middle of the unobstructed width when that's 1 m
   * or less, and 400 mm in from each side when it's over 1 m; a spiral's at 0.7 of the width from the centre pole.
   * NCC 2022, NCC_PAGES.stairs
   */
  taperedGoing: { narrowMax: 1000, inFromSide: 400, spiralFraction: 0.7, clause: "11.2.2(4)" },
  /** 11.2.5(1)(a): a landing at least 750 mm long (where it turns, measured 500 mm from the inside edge); 600 for an attic stair. NCC 2022, NCC_PAGES.stairs */
  landing: { length: 750, lengthAttic: 600, turnMeasuredFromInside: 500, gradient: 50, clause: "11.2.5(1)" },
  /** 11.2.5(3): a landing where a doorway opens onto a stair that rises or falls more than 3 risers or 570 mm. NCC 2022, NCC_PAGES.stairs */
  thresholdLanding: { risers: 3, mm: 570, clause: "11.2.5(3)" },
} as const;

/** 10.3.1(1)(f): 2.0 m above a stair, measured vertically above the nosing line. NCC 2022, NCC_PAGES.heights */
export const NCC_HEADROOM = { mm: 2000, clause: "10.3.1(1)(f)" } as const;

export const NCC_BARRIERS = {
  /** 11.3.3: a barrier wherever it's possible to fall 1 m or more (trafficable surface to the surface beneath). NCC 2022, NCC_PAGES.barriers */
  requiredFall: { mm: 1000, clause: "11.3.3" },
  /**
   * 11.3.4(2): at least 865 mm above the nosings of a stair (or a ramp's floor); 1 m above a floor, landing, balcony or
   * deck; 865 mm above a landing where the barrier is on the landing's inside edge and no more than 500 mm long.
   * NCC 2022, NCC_PAGES.barriers
   */
  height: { stair: 865, floor: 1000, landingInsideEdge: 865, landingInsideEdgeMaxLength: 500, clause: "11.3.4(2)" },
  /** 11.3.4(4): openings must not let a 125 mm sphere through (on a stair, measured above the nosing line). NCC 2022, NCC_PAGES.barriers */
  sphere: { mm: 125, clause: "11.3.4(4)" },
  /** 11.3.4(5),(6): a barrier fixed to the edge face: no more than 40 mm from the edge to its nearest inside face. NCC 2022, NCC_PAGES.barriers */
  edgeGap: { mm: 40, clause: "11.3.4(5)" },
  /** 11.3.4(7): an attic stair's barrier may let a 300 mm sphere through, or have a top and middle rail 460 mm apart at most. NCC 2022, NCC_PAGES.barriers */
  attic: { sphere: 300, railGap: 460, clause: "11.3.4(7)" },
  /** 11.3.4(8): where the fall is more than 4 m, nothing between 150 and 760 mm above the floor may help climbing. NCC 2022, NCC_PAGES.barriers */
  climb: { fallOver: 4000, from: 150, to: 760, clause: "11.3.4(8)" },
  /**
   * 11.3.5: a handrail on at least one side of each flight, the full length, its top at least 865 mm above the nosings,
   * continuous (newel posts and the like excepted); not needed where the stair's change in level is under 1 m.
   * NCC 2022, NCC_PAGES.barriers
   */
  handrail: { height: 865, notNeededUnder: 1000, clause: "11.3.5" },
} as const;

/** The edition setting: the edition in force and, when known, the next one and the day it takes over. */
export type CodeEdition = { current: string; next: { edition: string; from: string } | null };

/** NSW today: NCC 2022 until 1 May 2027, then NCC 2025 (see the addresses at the top). */
export const CODE_EDITION_DEFAULT: CodeEdition = { current: "NCC 2022", next: { edition: "NCC 2025", from: "2027-05-01" } };

/** Which edition is in force on a day, by the setting. */
export function editionInForce(s: CodeEdition, now = new Date()): string {
  if (s.next && now.getTime() >= Date.parse(`${s.next.from}T00:00:00+10:00`)) return s.next.edition;
  return s.current;
}

/**
 * What an answer says about the edition: nothing extra while the figures were reviewed for the edition in force; a
 * plain warning once the setting says another edition is in force that these figures weren't reviewed for.
 */
export function editionNote(s: CodeEdition, now = new Date()): string | null {
  const inForce = editionInForce(s, now);
  if ((NCC_REVIEWED_FOR as readonly string[]).includes(inForce)) return null;
  return `These limits were read from ${NCC_EDITION}, but ${inForce} is in force now${s.next && inForce === s.next.edition ? ` (from ${s.next.from})` : ""} and they haven't been checked against it. Check the current code before relying on them.`;
}
