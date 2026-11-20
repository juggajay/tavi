// 3D models (Stage 9.3): the common joints from tested recipes, anything else made of boards piece by piece, checked
// before they're shown; looking at what it made; changing one size by talking; saving a picture or a 3D file. The brain
// sends data (sizes in millimetres); the app draws. The functions are also used by the fake brain.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { DEV } from "../dev.js";
import { createItem, getItem, publishItem } from "../store/items.js";
import { modelProblem } from "../store/model.js";
import { checkModel, type ModelFacts } from "../shared/model3d/check.js";
import { JOINT_NAMES, RECIPES, runRecipe, sectionOf } from "../shared/model3d/recipes/index.js";
import { askPictures, askSave, clientShowing } from "../gateway/modelLink.js";
import { SHOTS as RENDER_SHOTS, blenderFiles, proposalSheet, renderModel } from "../render/blender.js";
import { screenOf } from "./showTools.js";
import { testSafe, type TurnCtx, type TurnInfo } from "./turn.js";
import type { Item, ModelMaterial, ModelPayload, ModelShot } from "../shared/protocol.js";
import { DESIGN_RULES, JOINT_RULE_IDS } from "../shared/model3d/designRules.js";
import { recordSource } from "./sourceLedger.js";
import { itemAccess, recordFileMaker } from "../hq/ownership.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const err = (message: string) => json({ error: message });
type ModelItem = Extract<Item, { kind: "model" }>;

/** What the brain gets back about a model it showed: the checks, and what to do about a clash or a floating part. */
export function factsFor(f: ModelFacts) {
  const trouble = f.clashes.length || f.floating.length || f.cuts.length;
  return {
    overall_size_mm: f.size_mm,
    parts: f.parts,
    clashes: f.clashes.length ? f.clashes : undefined,
    floating: f.floating.length ? f.floating : undefined,
    cuts_that_did_nothing_useful: f.cuts.length ? f.cuts : undefined,
    warnings: f.warnings.length ? f.warnings : undefined,
    check: trouble
      ? "Read these before you say anything: fix a clash, a floating part or a useless cut you didn't mean (show it again with replaces), or say plainly why it's meant (an exploded view, a deliberate gap)."
      : "No clashes, nothing floating.",
  };
}

/** Show a model: checked against the limits first (a plain reason back if not), then the checks; replaces swaps one. */
export function showModel(turn: TurnInfo, a: { title: string; payload: ModelPayload; replaces?: string }, via = "show_model"): { item: ModelItem; facts: ModelFacts } | { error: string } {
  const problem = modelProblem(a.payload);
  if (problem) return { error: problem };
  if (a.replaces) {
    const old = getItem(a.replaces);
    if (old) { const refusal = itemAccess(turn, old); if (refusal) return { error: refusal }; }
    if (!old || old.kind !== "model") return { error: `There's no model "${a.replaces}" on screen to replace. Leave replaces out to show a new one.` };
    // a change keeps who chose the joints, unless it says again (19.7)
    if (!a.payload.design && old.payload.design) a = { ...a, payload: { ...a.payload, design: old.payload.design } };
  }
  const facts = checkModel(a.payload);
  // a model that can't work (a bolt not in its hole, or not through both pieces; parts overlapping) is never shown
  // (Stage 19.8): the assistant fixes it first
  if (facts.errors.length)
    return {
      error: `That model can't work, so it wasn't shown. Fix these and show it again:\n- ${facts.errors.join("\n- ")}\nIf you can't get it right in two more tries, tell them plainly you couldn't model that correctly, and why.`,
    };
  const item = createItem(turn, { kind: "model", title: a.title || "Model", source: a.payload.made_by ? `3D model · ${a.payload.made_by.recipe.replace(/_/g, " ")}` : "3D model", payload: a.payload }) as ModelItem;
  publishItem(item, turn, true, true, a.replaces);
  // the design rules its joints' proportions follow (a recipe's, or the ones the assistant named) are sources of this
  // answer, for "where did you get that?" (20.3, joined with 19.7's record at the merge)
  recordRules(turn, (a.payload.design?.joints ?? []).flatMap((j) => j.rules ?? []), via);
  return { item, facts };
}

export type JointArgs = { type: string; title: string; members?: unknown; params?: Record<string, unknown>; material?: ModelMaterial; replaces?: string; by?: "owner" | "assistant" };

/**
 * A joint from its recipe. With replaces naming a model a recipe made, anything not given carries over from it, so
 * "make the tenon 10 longer" is the one size changed and the rest the same.
 */
export function jointModel(turn: TurnInfo, a: JointArgs) {
  if (a.replaces) { const old = getItem(a.replaces); if (old) { const refusal = itemAccess(turn, old); if (refusal) return { error: refusal }; } }
  let members = a.members;
  let params = { ...(a.params ?? {}) };
  let material = a.material;
  if (a.replaces) {
    const old = getItem(a.replaces);
    const made = old?.kind === "model" ? old.payload.made_by : undefined;
    if (made && made.recipe === a.type) {
      const spec = RECIPES.find((r) => r.name === a.type)!;
      const names = spec.members.map((m) => m.split(" ")[0]);
      if (members === undefined) members = names.map((n) => sectionOf(made.params[n])).filter(Boolean);
      const carried = Object.fromEntries(Object.entries(made.params).filter(([k]) => !names.includes(k) && k !== "material"));
      params = { ...carried, ...params };
      material ??= made.params.material as ModelMaterial;
    }
  }
  const r = runRecipe(a.type, { members, params, material });
  if ("error" in r) return { error: r.error };
  // whose joint it is (19.7): the one he named, unless the assistant chose it
  const by = a.by ?? "owner";
  const names = [...new Set(r.payload.parts.map((p) => p.name))].slice(0, 2);
  // and the design rules its proportions came from (20.2), so the shop drawing can name them under a suggestion
  const payload = { ...r.payload, design: { by, joints: [{ parts: names, kind: a.type.replace(/_/g, " "), by, ...(r.rules.length ? { rules: r.rules } : {}) }] } };
  const shown = showModel(turn, { title: a.title, payload, replaces: a.replaces }, "joint_model");
  if ("error" in shown) return shown;
  return { ...shown, assumed: r.assumed, basis: r.basis, rules: r.rules };
}

/** Where a model's proportions came from (Stage 20.2): each design rule's sources, for "where did you get that?". */
function recordRules(turn: TurnInfo, ids: string[], tool: string) {
  for (const id of new Set(ids)) {
    const r = DESIGN_RULES.find((x) => x.id === id);
    if (r) for (const s of r.sources) recordSource(turn, { rung: 6, kind: "rule", what: s.ref, place: s.place, ...(r.status === "secondary" ? { note: "from a summary; not confirmed on the shelf" } : {}), tool });
  }
}

const SHOTS = ["hero", "apart", "top", "front", "side", "back"] as const;

/** The model on the asking screen, or the one named. */
function modelFor(turn: TurnInfo, id?: string, look = false): ModelItem | { error: string } {
  const ref = id ?? screenOf(turn).itemId;
  if (!ref) return { error: "There's no model on their screen; say which item." };
  const it = getItem(ref);
  if (!it || it.kind !== "model") return { error: `"${ref}" isn't a model.` };
  const refusal = itemAccess(turn, it, look);
  if (refusal) return { error: refusal };
  return it;
}

const memberLine = (s: string) => s.replace(/\s*\(default .*\)$/, "");

// The shapes the tools take, for the brain's guidance only: the real checks (limits, outlines that cross, plain reasons
// naming the part) are modelProblem's, so a mistake comes back as a sentence it can act on.
const num = z.number();
const v3 = z.tuple([num, num, num]);
const solid = z.discriminatedUnion("type", [
  z.object({ type: z.literal("box"), size: v3, at: v3.optional(), rot: v3.optional() }),
  z.object({ type: z.literal("cyl"), r: num, h: num, axis: z.enum(["x", "y", "z"]), at: v3 }),
  z.object({ type: z.literal("prism"), points: z.array(z.tuple([num, num])), plane: z.enum(["xy", "xz", "yz"]), depth: num, at: v3.optional() }),
]);
const partArg = z.object({
  id: z.string(),
  name: z.string(),
  material: z.enum(["pine", "hardwood", "oak", "walnut", "ply", "mdf", "steel", "concrete", "plain"]),
  stock: solid,
  cuts: z.array(solid).optional(),
  at: v3.optional(),
  rot: v3.optional(),
  grain: z.enum(["x", "y", "z"]).optional(),
  apart: v3.optional(),
});
const dimArg = z.object({ a: v3, b: v3, text: z.string().optional(), part: z.string().optional(), show: z.enum(["together", "apart"]).optional() });

export const modelTools = (ctx: TurnCtx) =>
  testSafe(
    ctx,
    [
      ...renderTools(ctx),
      tool(
        "list_joints",
        "The joints you can build from a tested recipe (joint_model): each one's name, what it is, its two members and its sizes with defaults.",
        {},
        async () => json(RECIPES.map((r) => ({ name: r.name, what: r.what, members: r.members.map(memberLine), sizes: r.params }))),
      ),
      tool(
        "joint_model",
        "Show a 3D model of a joint from its tested recipe, so it's right first time. type is one of: " +
          JOINT_NAMES.join(", ") +
          " (list_joints gives each one's sizes). members: the two members' sections [[width, thickness], [width, thickness]] in mm, in the " +
          "recipe's order (e.g. mortise_tenon: [rail, post] = [[90, 45], [90, 90]]); params: its own sizes. Anything not given takes a usual " +
          "proportion: the result lists what was assumed, and you say so in one sentence. To change one by talking ('make the tenon 10 " +
          "longer'), call it again with replaces: the model's item id and only the size that changed (the rest carries over; the item's " +
          "made_by has them). The checks come back with it.",
        {
          type: z.string().describe("The joint, e.g. mortise_tenon"),
          title: z.string().max(120).describe("e.g. 'Mortise and tenon, 90 × 45 rail into 90 × 90 post'"),
          members: z.array(z.array(z.number()).length(2)).max(2).optional(),
          params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
          material: z.enum(["pine", "hardwood", "oak", "walnut", "ply", "mdf", "steel", "concrete", "plain"]).optional(),
          replaces: z.string().optional().describe("Item id of the model on screen this takes the place of"),
          by: z.enum(["owner", "assistant"]).optional().describe("Whose joint: owner (he named it, the default) or assistant (you chose it for him)"),
        },
        async (a) => {
          const r = jointModel(ctx.turn, a);
          if ("error" in r) return err(r.error);
          return json({ shown: r.item.title, item: r.item.id, assumed: Object.keys(r.assumed).length ? r.assumed : "nothing", ...(r.basis.length ? { why: r.basis, why_note: "Traditional proportions from the old joinery books (rung 6): say the reason in a few words if it helps ('a third of the rail, the old rule'); they never say a joint is strong enough." } : {}), sizes_used: r.item.payload.made_by?.params, ...factsFor(r.facts) });
        },
      ),
      tool(
        "show_model",
        "Show a 3D model of something made of boards that isn't one of the joints: a frame, a bench, a gate, a stair flight, a " +
          "carcass. For a joint use joint_model, not this. Build it from boards at their real sizes in mm (z up), using the member sizes " +
          "the owner gave; a size they didn't give: ask, or use a usual proportion and say so. Place the parts so they touch. Each part: " +
          "{id, name, material (pine|hardwood|oak|walnut|ply|mdf|steel|concrete|plain), stock (a solid), cuts? (solids taken away), at? " +
          "[x,y,z], rot? [deg x, y, z], grain? (x|y|z, the way the grain runs in the part's own frame; default its longest side), apart? " +
          "[x,y,z] (how far and which way it slides when pulled apart: set it so it pulls apart the way it goes together)}. Solids: box " +
          "{size [x,y,z], at? (its min corner), rot?}; cyl {r, h, axis x|y|z, at (centre of its base)}; prism {points [[u,v],...] 3 to 24, " +
          "plane xy|xz|yz, depth, at?} (an outline pushed through a depth: xy pushes along z, xz along y, yz along x). Stock and cuts are " +
          "in the part's own frame; at and rot place the finished part. dims: [{a, b, text?, part?, show? together|apart}] for the sizes " +
          "that matter (no text: the true length). Up to 60 parts, 24 cuts a part, 40 dims. Read the checks that come back and fix a " +
          "clash or a floating part before you speak. replaces: the item id of the model it takes the place of (the viewer keeps its angle).",
        {
          title: z.string().max(120),
          parts: z.array(partArg),
          dims: z.array(dimArg).optional(),
          note: z.string().max(200).optional().describe("One line under it, e.g. 'Legs 90 × 90, rails 90 × 45, 19 ply top'"),
          design: z
            .object({
              by: z.enum(["owner", "assistant", "mixed"]),
              joints: z
                .array(
                  z.object({
                    parts: z.array(z.string().max(40)).min(1).max(4),
                    kind: z.string().max(60),
                    fixing: z.string().max(60).optional(),
                    by: z.enum(["owner", "assistant"]),
                    rules: z.array(z.enum(JOINT_RULE_IDS)).max(4).optional().describe("The design rules (design_rules ids) this joint's proportions follow; leave it out when they're your own call"),
                  }),
                )
                .max(30)
                .optional(),
            })
            .optional()
            .describe("Who chose how it goes together: by owner (he said), assistant (you designed it) or mixed; joints: each joint by the parts it joins, what it is, how it's held as he said it, whose it was, and the rules its proportions came from"),
          replaces: z.string().optional(),
        },
        async (a) => {
          const r = showModel(ctx.turn, { title: a.title, payload: { parts: a.parts, ...(a.dims ? { dims: a.dims } : {}), ...(a.note ? { note: a.note } : {}), ...(a.design ? { design: a.design } : {}) }, replaces: a.replaces });
          return "error" in r ? err(r.error) : json({ shown: r.item.title, item: r.item.id, ...factsFor(r.facts) });
        },
      ),
      tool(
        "look_at_model",
        "See the model you made. With an app showing it, the usual two pictures are a three-quarter view and the same pulled apart. " +
          "Without an app, or after 8 seconds with no answer, line drawings are made here: front, side, iso (three-quarter) and apart " +
          "(top instead of apart for one part). views: front, side, top, iso, apart; hero and back also work; at most 4. " +
          "Use it after building or changing a model, before saying it is ready: check overall size, every part present, nothing floating " +
          "or passing through another part. No item: the model on their screen.",
        { item: z.string().optional(), views: z.array(z.enum([...SHOTS, "iso"])).min(1).max(4).optional() },
        async ({ item, views }) => {
          const m = modelFor(ctx.turn, item, true);
          if ("error" in m) return err(m.error);
          const checked = checkModel(m.payload);
          const facts = factsFor(checked);
          const client = clientShowing(m.id, screenOf(ctx.turn).clientId);
          const want = (views ?? ["hero", "apart"]).map((view) => view === "iso" ? "hero" : view) as ModelShot[];
          let pics = client ? await askPictures(m.id, client, want) : null;
          if (!pics) {
            const note = (client ? "The app showing it didn't send pictures within 8 seconds. " : "No phone or PC app is showing that model right now. ") +
              "These are line drawings made without the app, rather than the shaded picture the owner sees. " +
              "Check overall size, that every part is present, and that nothing is floating or passing through another part. " +
              "The pulled-apart view moves parts deliberately; read the checks for the model put together.";
            try {
              const { modelLinePictures } = await import("../render/look.js");
              pics = await modelLinePictures(m.payload, views);
            } catch {
              return json({ note: note + " The line drawings could not be made. Read the checks below; the model has not been looked at.", ...facts, errors: checked.errors });
            }
            return {
              content: [
                { type: "text" as const, text: JSON.stringify({ model: m.title, views: pics.map((p) => p.view), note, ...facts, errors: checked.errors, ...(views?.includes("apart") && m.payload.parts.length === 1 ? { omitted: "A one-part model has no pulled-apart view." } : {}) }) },
                ...pics.map((p) => ({ type: "image" as const, data: p.png.toString("base64"), mimeType: "image/png" })),
              ],
            };
          }
          return {
            content: [
              { type: "text" as const, text: `${m.title}: ${pics.map((p) => p.view).join(", ")} (1024 px, as the owner's screen draws it).\n${JSON.stringify(facts)}` },
              ...pics.map((p) => ({ type: "image" as const, data: p.png.toString("base64"), mimeType: "image/png" })),
            ],
          };
        },
      ),
      tool(
        "save_model",
        "Save a model as a file the owner keeps: as 'picture' (a PNG of the view on screen), 'glb' (a 3D file with its materials, " +
          "opens in most 3D viewers), 'stl' (a 3D file in millimetres, for CAD or a 3D printer), 'blend' (the Blender scene, to polish " +
          "further by hand) or 'usdz' (opens in 3D on an iPhone straight from a message or email). It goes in the models folder under " +
          "today's date, named from the title, and you get its file id. No item: the model on their screen.",
        { item: z.string().optional(), as: z.enum(["picture", "glb", "stl", "blend", "usdz"]) },
        async ({ item, as }) => {
          const m = modelFor(ctx.turn, item);
          if ("error" in m) return err(m.error);
          if (as === "blend" || as === "usdz") {
            const r = await blenderFiles(m, [as]);
            return "error" in r ? err(r.error) : json({ saved: r.files[0].name, file: r.files[0].file, folder: "models (in the folder the app manages), under today's date" });
          }
          const client = clientShowing(m.id, screenOf(ctx.turn).clientId);
          if (!client) return err("The model has to be open on the phone or the PC to make the file. Put it back up (show_again) and try again.");
          const r = await askSave(m.id, client, as, m.title);
          if (!r) return err("The app didn't make the file within 20 seconds. Nothing was saved.");
          recordFileMaker(r.file, ctx.turn);
          return json({ saved: r.name, file: r.file, folder: "models (in the folder the app manages), under today's date" });
        },
      ),
    ],
    // Showing and looking only read. Saving and rendering write files: on a test turn only in dev (the dev data folder).
    ["list_joints", "joint_model", "show_model", "look_at_model", ...(DEV ? ["save_model", "render_model", "proposal_sheet"] : [])],
  );

/** Rendering, and the proposal page (Stage 9.6b): background jobs in Blender, added to the model tools. */
const renderTools = (ctx: TurnCtx) => [
  tool(
    "render_model",
    "Polished pictures of a model for a client, made in Blender on the PC in the background (about a minute; carry on talking). " +
      "shots: any of " +
      RENDER_SHOTS.join(", ") +
      " (hero: three-quarter put together; apart: pulled apart; detail: closer in on the joint; turntable: a 6 second turning video). " +
      "Default hero and apart. backdrop: light (default, prints well) or dark. size: screen (1,920 px, default) or print (3,840 px). " +
      "labels: the main sizes drawn on the front and side shots (default on). When it's done the hero picture goes on their screen " +
      "and they're told what was made. Only when they ask, or say yes to your one offer.",
    {
      item: z.string().optional(),
      shots: z.array(z.string()).max(7).optional(),
      backdrop: z.string().optional(),
      size: z.string().optional(),
      labels: z.boolean().optional(),
    },
    async (a) => {
      const m = modelFor(ctx.turn, a.item);
      if ("error" in m) return err(m.error);
      const r = renderModel(ctx.turn, m, a);
      return "error" in r ? err(r.error) : json({ started: r.shots, job: r.job, note: "Rendering in the background: about a minute. Say so and carry on; they'll be told when it's ready." });
    },
  ),
  tool(
    "proposal_sheet",
    "One A4 PDF page for a proposal, made from a model's polished pictures: the main picture large, the pulled-apart one and a " +
      "dimensioned front view below, the title, up to six short lines in the owner's own words, and the date. No logo, prices or " +
      "terms, and nothing about strength or compliance. Renders what it needs first, in the background.",
    { item: z.string().optional(), title: z.string().max(80), lines: z.array(z.string().max(140)).max(6).optional() },
    async (a) => {
      const m = modelFor(ctx.turn, a.item);
      if ("error" in m) return err(m.error);
      const r = proposalSheet(ctx.turn, m, a.title, a.lines ?? []);
      return "error" in r ? err(r.error) : json({ started: "the proposal page", job: r.job, note: "In the background; they'll be told when it's ready." });
    },
  ),
];


export const makeModelServer = (ctx: TurnCtx) => createSdkMcpServer({ name: "model", version: "0.1.0", alwaysLoad: true, tools: modelTools(ctx) });

