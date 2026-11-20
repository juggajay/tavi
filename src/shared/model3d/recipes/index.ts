// The joint recipes (Stage 9.2): tested functions that take sizes and return a correct model, with apart set so it
// pulls apart the way it would in the hand and the sizes that matter shown. RECIPES is what the assistant is handed.
import type { ModelMaterial, ModelPayload } from "../../protocol.js";
import { type Recipe, type RecipeInput, Reader, RecipeError, finish } from "./kit.js";
import { RECIPE_RULES } from "../designRules.js";
import { butt } from "./butt.js";
import { mitre } from "./mitre.js";
import { halfLap } from "./half_lap.js";
import { housing } from "./housing.js";
import { mortiseTenon } from "./mortise_tenon.js";
import { bridle } from "./bridle.js";
import { dovetail } from "./dovetail.js";
import { boxJoint } from "./box_joint.js";
import { dowel } from "./dowel.js";
import { tongueGroove } from "./tongue_groove.js";
import { birdsmouth } from "./birdsmouth.js";
import { scarf } from "./scarf.js";

const ALL: Recipe[] = [butt, mitre, halfLap, housing, mortiseTenon, bridle, dovetail, boxJoint, dowel, tongueGroove, birdsmouth, scarf];
export const JOINT_NAMES = ALL.map((r) => r.name);

/** The list the assistant gets: each joint, one line, what its members are, and its sizes with their defaults. */
export const RECIPES = ALL.map((r) => ({
  name: r.name,
  what: r.what,
  members: r.members.map((m) => `${m.name} ${m.what} (default ${m.default[0]} x ${m.default[1]})`),
  params: r.params.map((p) => {
    const d = typeof p.default === "function" ? p.defaultText : p.default !== undefined ? String(p.default) : undefined;
    return `${p.name}: ${p.what}${p.choices ? ` (${p.choices.join(" | ")})` : ""}${d !== undefined ? `; default ${d}` : ""}`;
  }),
}));

/** basis: for each size taken from a design rule, why, with its source (Stage 20.2); rules: those rules' ids. */
export type JointResult = { payload: ModelPayload; assumed: Record<string, number | string | boolean>; basis: string[]; rules: string[] } | { error: string };

/** Run a recipe. A size that can't work comes back as { error } in plain words, never thrown. */
export function runRecipe(name: string, input: RecipeInput & { material?: ModelMaterial } = {}): JointResult {
  const recipe = ALL.find((r) => r.name === name);
  if (!recipe) return { error: `There's no "${name}" joint. The joints are: ${JOINT_NAMES.join(", ")}.` };
  try {
    const r = new Reader(recipe, input);
    const made = recipe.make(r);
    const gap = r.num("fit_gap");
    const body = finish(made, gap);
    const params: Record<string, number | string | boolean> = { ...r.used, material: r.material };
    const rules = Object.keys(r.basis)
      .map((p) => RECIPE_RULES[recipe.name]?.[p])
      .filter((x): x is string => !!x);
    return { payload: { ...body, made_by: { recipe: recipe.name, params } }, assumed: r.assumed, basis: Object.values(r.basis), rules };
  } catch (e) {
    if (e instanceof RecipeError) return { error: `That ${recipe.name.replace(/_/g, " ")} can't work: ${e.message.replace(/\.$/, "")}.` };
    throw e;
  }
}

/** The members as made_by keeps them ("90 x 45"), back as sections, for changing one size and running it again. */
export const sectionOf = (s: unknown): [number, number] | undefined => {
  const m = /^\s*([\d.]+)\s*x\s*([\d.]+)\s*$/i.exec(String(s ?? ""));
  return m ? [Number(m[1]), Number(m[2])] : undefined;
};
