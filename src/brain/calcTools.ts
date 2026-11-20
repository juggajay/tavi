// The calculator (Stage 8.3) and the trade calculators (Stage 14.2): thin wrappers over src/calc and src/shared/calc.
// Every figure worked out beyond adding two round numbers goes through here (rules.ts), so the brain never does
// arithmetic in its head. All of it only computes and shows; allowed in test turns.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { calculate, CalcError } from "../calc/expr.js";
import { roofGeometry, setOut } from "../calc/geometry.js";
import { CalcInputError, type CalcResult } from "../shared/calc/result.js";
import { barrierCalc, stairCalc } from "../shared/calc/stairs.js";
import { roofCalc } from "../shared/calc/roof.js";
import { setoutCalc } from "../shared/calc/setout.js";
import { quantityCalc } from "../shared/calc/quantity.js";
import { NCC_ATTRIBUTION } from "../shared/calc/ncc.js";
import { movementCalc } from "../shared/calc/movement.js";
import { shelfCalc } from "../shared/calc/shelf.js";
import { STIFFNESS_GROUPS, type StiffnessGroup } from "../shared/model3d/designRules.js";
import { findSpecies, speciesTable, type Species } from "../reference/species.js";
import { getSettings } from "../store/settings.js";
import { showSketch, showTable } from "./showTools.js";
import { testSafe, type TurnCtx, type TurnInfo } from "./turn.js";
import { recordSource } from "./sourceLedger.js";
import type { Rung } from "../reference/rungs.js";

/** A calculator's source line as a rung on the ladder (20.3): the code 2, a maker's guide 4, Australian data 5, an old book 6, a summary 7. */
function rungOfSource(s: string): Rung | null {
  if (/arithmetic only/i.test(s)) return null;
  if (/\bNCC\b|abcb\.gov\.au|Housing Provisions/i.test(s)) return 2;
  if (/WoodSolutions|Queensland|Business Queensland/i.test(s)) return 5;
  if (/Fairham|Noyes|Griffith|Handbook/i.test(s)) return 6;
  if (/guide|maker/i.test(s)) return 4;
  return 7;
}

/** A species' unit shrinkage for the way it's cut, from the Queensland data, or why it can't be had. */
function unitShrinkage(s: Species, cut: "backsawn" | "quartersawn"): { pct: number } | { error: string } {
  const u = s.unit_shrinkage;
  if (!u) return { error: `The Queensland page for ${s.name} gives no unit shrinkage. Say so; ask for a figure (unit_shrinkage_pct) or use a species that has one. Don't give one from memory.` };
  if ("tangential" in u && typeof u.tangential === "number" && typeof u.radial === "number") return { pct: cut === "quartersawn" ? u.radial : u.tangential };
  return { error: `The Queensland page for ${s.name} gives its unit shrinkage as: "${u.text.slice(0, 300)}". Say what it gives; ask which figure to use (unit_shrinkage_pct). Don't pick one yourself.` };
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
/** A plain error for bad input; anything else is a real fault and is thrown. */
const run = (f: () => unknown) => {
  try {
    return json(f());
  } catch (err) {
    if (err instanceof CalcError || err instanceof CalcInputError) return json({ error: err.message });
    throw err;
  }
};
const mm = (d: string) => z.number().describe(d);
const num = () => z.number().optional();

/**
 * A trade calculator's answer: the sketch and the working (a table with the checks and their sources) go on the screen
 * the turn came from; the brain gets the figures, the checks and a short line to say.
 */
export function publishCalc(turn: TurnInfo, r: CalcResult, show = true) {
  const shown: string[] = [];
  if (show) {
    if (r.sketch) {
      const s = showSketch(turn, { title: r.sketch.title, shapes: r.sketch.shapes, note: r.sketch.note });
      if (!("error" in s)) shown.push(`sketch "${r.sketch.title}"`);
    }
    const nccUsed = r.sources.some((s) => s.includes("abcb.gov.au"));
    // the warnings as rows (they can be long, and the edition one matters); the note is the ABCB's attribution
    const width = r.table.columns.length;
    const warn = r.warnings.map((w) => ["!", w, ...Array(Math.max(0, width - 2)).fill("")].slice(0, width));
    showTable(turn, {
      title: r.title,
      columns: r.table.columns,
      rows: [...r.table.rows, ...warn].map((row) => row.map((c) => (c.length > 500 ? `${c.slice(0, 497)}...` : c))),
      ...(nccUsed ? { note: NCC_ATTRIBUTION } : {}),
      source: nccUsed ? "NCC 2022 Housing Provisions (ABCB), as in force in NSW" : r.sources.join("; ").slice(0, 200),
    });
    shown.push(`table "${r.title}"`);
  }
  // what this answer drew on, for "where did you get that?" (20.3)
  for (const s of r.sources) {
    const rung = rungOfSource(s);
    if (rung) recordSource(turn, { rung, kind: "calculator", what: s.slice(0, 200), place: r.title, tool: "calculator" });
  }
  return {
    say: r.say,
    answer: r.answer,
    checks: r.checks.map((c) => `${c.ok ? "passes" : "FAILS"}: ${c.what} ${c.value} (limit ${c.limit}; ${c.source})`),
    warnings: r.warnings,
    working: r.steps,
    sources: r.sources,
    on_screen: shown.length ? `${shown.join(" and ")} (already up: don't show them again)` : "nothing",
  };
}

const runCalc = (turn: TurnInfo, f: () => CalcResult, show?: boolean) => run(() => publishCalc(turn, f(), show !== false));
const edition = () => getSettings()["code.edition"];

const SHOW = z.boolean().optional().describe("Put the sketch and the working on screen (default true)");

export const calcTools = (ctx: TurnCtx) =>
  testSafe(
    ctx,
    [
      tool(
        "calculate",
        "Work out an arithmetic expression exactly: numbers, + - * / ^, brackets, sqrt abs round floor ceil min max pi, and " +
          "sin cos tan (degrees) and asin acos atan (giving degrees). Returns the exact result and a sensibly rounded one. " +
          "Use it for every figure beyond adding two round numbers. Write 3600, not 3,600.",
        { expression: z.string().max(300) },
        async ({ expression }) => run(() => calculate(expression)),
      ),
      tool(
        "roof_geometry",
        "Quick roof figures from the run (ridge centre to outside of the wall plate) or the span, and the pitch or the rise: " +
          "rise, pitch, rafter length (with and without a level overhang), plumb and seat cut angles. For framing a roof " +
          "(commons, hips, valleys, creepers, birdsmouth, cutting list, sketch) use roof_calc.",
        {
          run_mm: mm("Ridge centre line to the outside of the wall plate, level").optional(),
          span_mm: mm("Wall to wall (outside of the plates); the run is half").optional(),
          pitch_deg: z.number().optional(),
          rise_mm: mm("Height from the top of the wall plate line to the ridge centre line").optional(),
          overhang_mm: mm("Eaves overhang measured level out from the wall plate").optional(),
          rafter_depth_mm: mm("Rafter depth, to give its plumb depth").optional(),
          hip: z.boolean().optional(),
        },
        async (a) => run(() => roofGeometry(a)),
      ),
      tool(
        "set_out",
        "How many members, and the actual spacing, to fill a length without going over a maximum spacing (joists, " +
          "rafters, battens, pickets). ends 'both' (default): a member at each end. ends 'none': the ends are already " +
          "there (posts), count the ones between. For a stud wall (exact centres, openings, plates, noggings) use setout_calc.",
        { length_mm: z.number(), max_spacing_mm: z.number(), member_mm: z.number().optional(), ends: z.enum(["both", "none"]).optional() },
        async (a) => run(() => setOut(a)),
      ),
      tool(
        "stair_calc",
        "Stairs and barriers, checked against the NCC Housing Provisions in force in NSW (Parts 11.2, 11.3, 10.3). mode " +
          "'stair' (default): from the total rise (finished floor to finished floor) and the run available, the workable " +
          "stairs (risers, rise, going), 2R + G, the stringer's pitch line, cut angles, step-off marks, headroom (give the " +
          "ceiling or floor depth above), barrier and handrail, balusters per tread. mode 'barrier': from the fall, whether " +
          "a barrier's needed, its height, the 125 mm sphere, the no-climb zone, and even baluster spacing for a run. Puts " +
          "a dimensioned sketch and the working on screen. Ask for a missing input (the total rise above all) rather than assume it.",
        {
          mode: z.enum(["stair", "barrier"]).optional(),
          total_rise_mm: mm("Finished floor to finished floor").optional(),
          run_available_mm: mm("Horizontal room for the flight: bottom riser face to top riser face").optional(),
          going_mm: num(),
          risers: z.number().int().optional(),
          kind: z.enum(["standard", "spiral", "attic"]).optional().describe("attic: a stair to a non-habitable room not used daily"),
          width_mm: num(),
          open_risers: z.boolean().optional(),
          tread_thickness_mm: num(),
          ceiling_mm: mm("Height of the ceiling or floor underside above the lower floor where the stair passes under it").optional(),
          upper_floor_depth_mm: mm("Or the upper floor's depth at the opening").optional(),
          door_at_top: z.boolean().optional(),
          winders: z.number().int().optional(),
          turn: z.enum(["quarter", "half"]).optional(),
          open_side: z.boolean().optional(),
          fall_mm: mm("barrier: from the floor to the surface beneath").optional(),
          where: z.enum(["stair", "floor", "landing"]).optional(),
          run_mm: mm("barrier: clear run between posts, for balusters").optional(),
          baluster_mm: num(),
          max_gap_mm: mm("Gap to aim at between balusters (default 120; the test is a 125 mm sphere)").optional(),
          landing_edge_mm: num(),
          attic: z.boolean().optional(),
          show: SHOW,
        },
        async (a) =>
          runCalc(
            ctx.turn,
            () =>
              a.mode === "barrier"
                ? barrierCalc({ fall_mm: a.fall_mm as number, where: a.where, run_mm: a.run_mm, baluster_mm: a.baluster_mm, max_gap_mm: a.max_gap_mm, landing_edge_mm: a.landing_edge_mm, attic: a.attic }, edition())
                : stairCalc({ ...a, total_rise_mm: a.total_rise_mm as number }, edition()),
            a.show,
          ),
      ),
      tool(
        "roof_calc",
        "Roof framing geometry. kind 'common' (a gable: span or run, pitch or rise), 'hip' (span and length of the building, " +
          "pitch, end_pitch_deg if the ends differ), 'valley' (main span and pitch, wing_span_mm and wing_pitch_deg). " +
          "Lengths to the birdsmouth and overall with the eave, plumb, level, edge and backing angles, birdsmouth seat and " +
          "depth (give rafter_depth_mm and seat_mm, usually the plate's width), hip drop (hip_thickness_mm), creeper steps " +
          "and lengths (spacing_mm), ridge length and wall-plate set-out. Pure geometry: it never chooses member sizes. " +
          "Puts a sketch and the cutting figures on screen.",
        {
          kind: z.enum(["common", "hip", "valley"]),
          span_mm: num(),
          run_mm: num(),
          length_mm: num(),
          pitch_deg: num(),
          rise_mm: num(),
          end_pitch_deg: num(),
          wing_span_mm: num(),
          wing_pitch_deg: num(),
          overhang_mm: mm("Eave overhang, measured level from the outside of the wall").optional(),
          spacing_mm: num(),
          rafter_depth_mm: num(),
          seat_mm: num(),
          ridge_thickness_mm: num(),
          hip_thickness_mm: num(),
          show: SHOW,
        },
        async ({ show, ...a }) => runCalc(ctx.turn, () => roofCalc(a), show),
      ),
      tool(
        "setout_calc",
        "Setting out. kind 'square' (length and width: the diagonals; give both measured diagonals to see how far out), " +
          "'345' (a square corner by 3-4-5, sized to the room available), 'fall' (length and one of fall_mm, ratio (1 in n), " +
          "percent or degrees), 'levels' (benchmark_rl_m and readings in metres, in order: the first a backsight on the " +
          "benchmark, then intermediates (is) and foresights (fs), a change point has fs and bs; design_rl_m for cut or " +
          "fill), 'studs' (wall length and centres; openings with from_mm and width_mm; frame_height_mm for stud length; " +
          "plates, plate_mm, nogging_rows, stock_mm, waste_pct). Puts the working (and a sketch) on screen.",
        {
          kind: z.enum(["square", "345", "fall", "levels", "studs"]),
          length_mm: num(),
          width_mm: num(),
          diagonal1_mm: num(),
          diagonal2_mm: num(),
          fall_mm: num(),
          ratio: num(),
          percent: num(),
          degrees: num(),
          benchmark_rl_m: num(),
          readings: z.array(z.object({ label: z.string().max(40), bs: num(), is: num(), fs: num(), design_rl_m: num() })).max(60).optional(),
          centres_mm: num(),
          stud_mm: num(),
          frame_height_mm: num(),
          plates: num(),
          plate_mm: num(),
          nogging_rows: num(),
          openings: z.array(z.object({ width_mm: z.number(), from_mm: z.number(), kind: z.enum(["door", "window"]).optional() })).max(20).optional(),
          stock_mm: num(),
          waste_pct: num(),
          show: SHOW,
        },
        async ({ show, ...a }) => runCalc(ctx.turn, () => setoutCalc(a), show),
      ),
      tool(
        "quantity_calc",
        "Quantities (never prices). kind 'concrete' (pours: piers square or round with count, size_mm and depth_mm; slab " +
          "or strip with length, width, depth; rounded up to order_step_m3, default 0.2), 'decking' (length along the " +
          "boards, width across, board_mm, gap_mm, board_length_mm, joist_spacing_mm for screws), 'cladding' (wall length " +
          "and height less openings; cover_mm is the board's effective cover FROM THE MAKER'S GUIDE: look it up with " +
          "find_in_reference first and pass cover_source as maker, guide, date and page; or sheet_mm for sheets), " +
          "'plasterboard' (surfaces: walls and ceilings, by real sheet lengths). waste_pct is shown in the answer; the " +
          "defaults are stated. Puts the working on screen.",
        {
          kind: z.enum(["concrete", "decking", "cladding", "plasterboard"]),
          waste_pct: num(),
          pours: z
            .array(z.object({ shape: z.enum(["pier_square", "pier_round", "slab", "strip"]), count: num(), size_mm: num(), length_mm: num(), width_mm: num(), depth_mm: z.number(), label: z.string().max(40).optional() }))
            .max(30)
            .optional(),
          order_step_m3: num(),
          length_mm: num(),
          width_mm: num(),
          board_mm: num(),
          gap_mm: num(),
          board_length_mm: num(),
          joist_spacing_mm: num(),
          screws_per_joist: num(),
          height_mm: num(),
          openings: z.array(z.object({ width_mm: z.number(), height_mm: z.number(), count: num() })).max(40).optional(),
          cover_mm: num(),
          cover_source: z.string().max(200).optional(),
          sheet_mm: z.tuple([z.number(), z.number()]).optional(),
          surfaces: z.array(z.object({ kind: z.enum(["wall", "ceiling"]), length_mm: z.number(), height_mm: z.number(), count: num(), label: z.string().max(40).optional() })).max(60).optional(),
          sheet_width_mm: num(),
          sheet_lengths_mm: z.array(z.number()).max(20).optional(),
          show: SHOW,
        },
        async ({ show, ...a }) => runCalc(ctx.turn, () => quantityCalc(a), show),
      ),
      tool(
        "movement_calc",
        "How much a board, panel or top moves across its width when its moisture content changes, and so the gap to " +
          "leave (Stage 20.2): width × unit shrinkage × the change ÷ 100, the formula from WoodSolutions' flooring guide. " +
          "Give the species (its unit shrinkage comes from the Queensland data on the shelf) or unit_shrinkage_pct; cut " +
          "backsawn (tangential, the bigger) or quartersawn (radial); and the moisture content it's at and the one it'll " +
          "reach (e.g. made at 10%, will see 15% in a humid summer). Ask for the moisture contents if not given; don't " +
          "assume them. Puts the working on screen.",
        {
          width_mm: mm("Width across the grain"),
          species: z.string().max(80).optional(),
          unit_shrinkage_pct: z.number().optional().describe("% per 1% change in moisture content, if not from the species data"),
          cut: z.enum(["backsawn", "quartersawn"]).optional().describe("Default backsawn (the bigger movement)"),
          mc_from_pct: z.number().describe("Moisture content now (or when made), %"),
          mc_to_pct: z.number().describe("Moisture content it will reach, %"),
          what: z.string().max(40).optional().describe("e.g. 'tabletop', 'panel'"),
          show: SHOW,
        },
        async ({ species, unit_shrinkage_pct, cut, show, ...a }) => {
          const c = cut ?? "backsawn";
          let unit = unit_shrinkage_pct;
          let source = "given by you";
          if (unit === undefined) {
            if (!species) return json({ error: "I need the species (to read its unit shrinkage from the Queensland data) or the unit shrinkage itself." });
            const t = speciesTable();
            const s = t ? findSpecies(species, t)[0] : undefined;
            if (!t || !s) return json({ error: `"${species}" isn't in the Queensland species data on the shelf, so I don't have its unit shrinkage. Say so; ask for a figure. Don't give one from memory.` });
            const u = unitShrinkage(s, c);
            if ("error" in u) return json({ error: u.error });
            unit = u.pct;
            source = `${t.publisher}, "${t.source}": ${s.name}${s.last_updated ? `, page updated ${s.last_updated}` : ""}`;
            recordSource(ctx.turn, { rung: 5, kind: "species", what: `${t.publisher}, "${t.source}": ${s.name}`, place: s.url, ...(s.last_updated ? { date: `page last updated ${s.last_updated}` } : {}), tool: "movement_calc" });
          }
          const res = run(() => publishCalc(ctx.turn, movementCalc({ ...a, unit_pct: unit!, unit_source: source, cut: c }), show !== false));
          if (cut === undefined) {
            const body = JSON.parse(res.content[0].text);
            if (!body.error) body.assumed = "backsawn (tangential), the bigger movement: say so in a few words";
            return json(body);
          }
          return res;
        },
      ),
      tool(
        "shelf_calc",
        "How far a shelf resting on its two ends sags under an even load (Stage 20.2): the standard beam formula, against " +
          "about 1.7 mm per metre of span when first loaded and half as much again over time (rules of thumb, not " +
          "confirmed on the shelf: say so). Give span, depth (front to back), thickness, and the load in kg (books are " +
          "heavy: ask, don't guess). Stiffness: e_mpa if they know it; otherwise stiffness_group, or a species WoodSolutions " +
          "names for a group (spotted gum, ironbark, blackbutt, kwila, merbau: hardwood; radiata, hoop, slash pine: " +
          "softwood, taken as imported unless they say it's Australian grown). That's a general figure for the group, and " +
          "the answer says so. Furniture and joinery shelves only; never for anything people stand on or that holds up the " +
          "building. Puts the working on screen.",
        {
          span_mm: mm("Clear span between the supports"),
          depth_mm: mm("Front to back"),
          thickness_mm: mm("Thickness"),
          load_kg_per_m: z.number().optional(),
          load_kg: z.number().optional().describe("The whole load, spread evenly"),
          species: z.string().max(80).optional(),
          stiffness_group: z.enum(["hardwood", "australian_softwood", "imported_softwood"]).optional(),
          e_mpa: z.number().optional().describe("Stiffness (modulus of elasticity), MPa, if they know it"),
          show: SHOW,
        },
        async ({ species, stiffness_group, e_mpa, show, ...a }) => {
          let E: number;
          let source: string;
          let general: boolean;
          let group: StiffnessGroup | undefined = stiffness_group;
          let note: string | undefined;
          const t = speciesTable();
          const s = species && t ? findSpecies(species, t)[0] : undefined;
          if (e_mpa !== undefined) {
            E = e_mpa;
            source = "given by you";
            general = false;
          } else {
            if (!group && species) {
              const q = species.toLowerCase();
              if ((STIFFNESS_GROUPS.hardwood.examples as readonly string[]).some((x) => q.includes(x))) group = "hardwood";
              else if (/radiata|hoop|slash|meranti/.test(q)) {
                group = /australian|aussie|\baus\b/.test(q) || /meranti/.test(q) ? "australian_softwood" : "imported_softwood";
                if (group === "imported_softwood") note = "taken as imported softwood (WoodSolutions: softwood not certified Australian grown takes the imported figure): say so";
              }
            }
            if (!group) return json({ error: `There's no stiffness figure for ${species ? `"${species}"` : "this shelf"} on the shelf. Ask whether it's a hardwood or a softwood (or its stiffness in MPa), then I'll use WoodSolutions' general figure for that group. Don't give a figure from memory.` });
            E = STIFFNESS_GROUPS[group].e_mpa;
            source = `WoodSolutions TDG 08, Stairs, Balustrades and Handrails, page 32: ${STIFFNESS_GROUPS[group].words}`;
            general = true;
            recordSource(ctx.turn, { rung: 5, kind: "design", what: "WoodSolutions TDG 08, Stairs, Balustrades and Handrails", place: "page 32", date: "2019", note: "a general stiffness figure for the group", tool: "shelf_calc" });
          }
          const dens = s?.density ? (s.density.kg_m3 ?? (s.density.range ? (s.density.range[0] + s.density.range[1]) / 2 : undefined)) : undefined;
          const dsrc = s && dens && t ? `${t.publisher}: ${s.name}${s.density?.range ? " (the middle of the page's range)" : ""}` : undefined;
          const res = run(() => publishCalc(ctx.turn, shelfCalc({ ...a, e_mpa: E, e_source: source, e_general: general, density_kg_m3: dens, density_source: dsrc }), show !== false));
          if (note) {
            const body = JSON.parse(res.content[0].text);
            if (!body.error) body.assumed = note;
            return json(body);
          }
          return res;
        },
      ),
    ],
    ["calculate", "roof_geometry", "set_out", "stair_calc", "roof_calc", "setout_calc", "quantity_calc", "movement_calc", "shelf_calc"],
  );

export const makeCalcServer = (ctx: TurnCtx) => createSdkMcpServer({ name: "calc", version: "0.1.0", alwaysLoad: true, tools: calcTools(ctx) });
