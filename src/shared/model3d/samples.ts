// Four example models (Stage 9.4): a mortise and tenon, a through dovetail and a birdsmouth from their recipes, and a
// small free-form workbench built board by board. Used by the gallery page and the fake brain. Made-up sizes.
import type { ModelPart, ModelPayload } from "../protocol.js";
import { runRecipe } from "./recipes/index.js";

const joint = (type: string, input: Parameters<typeof runRecipe>[1] = {}): ModelPayload => {
  const r = runRecipe(type, input);
  if ("error" in r) throw new Error(r.error);
  return r.payload;
};

/**
 * A workbench 1800 long, 600 deep, 900 high: four 90 × 45 legs inside a 90 × 45 frame under a 19 ply top, with
 * stretchers low down between the legs. Butted (fixings not shown). Pulled apart, the top lifts, the frame and the
 * legs move out, and the stretchers stay in the middle.
 */
export function workbench(L = 1800, D = 600, H = 900, top = 19): ModelPayload {
  const w = 90,
    t = 45;
  const fz = H - top; // underside of the top
  const z0 = fz - w; // underside of the frame
  const sz = 150; // underside of the stretchers
  const parts: ModelPart[] = [];
  const box = (id: string, name: string, size: [number, number, number], at: [number, number, number], grain: "x" | "y" | "z", apart: [number, number, number], material: ModelPart["material"] = "pine") =>
    parts.push({ id, name, material, grain, stock: { type: "box", size }, at, apart });
  box("top", "Top", [L, D, top], [0, 0, fz], "x", [0, 0, 320], "ply");
  box("rail-front", "Front rail", [L, t, w], [0, 0, z0], "x", [0, -220, 140]);
  box("rail-back", "Back rail", [L, t, w], [0, D - t, z0], "x", [0, 220, 140]);
  box("rail-left", "Left end rail", [t, D - 2 * t, w], [0, t, z0], "y", [-220, 0, 140]);
  box("rail-right", "Right end rail", [t, D - 2 * t, w], [L - t, t, z0], "y", [220, 0, 140]);
  const legX = [t, L - t - w],
    legY = [t, D - 2 * t];
  const names = [
    ["Front left leg", "Back left leg"],
    ["Front right leg", "Back right leg"],
  ];
  legX.forEach((x, i) => legY.forEach((y, j) => box(`leg-${i}${j}`, names[i][j], [w, t, fz], [x, y, 0], "z", [i ? 130 : -130, j ? 90 : -90, 0])));
  box("str-front", "Front stretcher", [L - 2 * (t + w), t, w], [t + w, t, sz], "x", [0, -40, 0]);
  box("str-back", "Back stretcher", [L - 2 * (t + w), t, w], [t + w, D - 2 * t, sz], "x", [0, 40, 0]);
  box("str-left", "Left stretcher", [t, D - 4 * t, w], [t, 2 * t, sz], "y", [-40, 0, 0]);
  box("str-right", "Right stretcher", [t, D - 4 * t, w], [L - 2 * t, 2 * t, sz], "y", [40, 0, 0]);
  return {
    parts,
    dims: [
      { a: [0, -90, 0], b: [L, -90, 0], show: "together" },
      { a: [L + 90, 0, 0], b: [L + 90, D, 0], show: "together" },
      { a: [-90, 0, 0], b: [-90, 0, H], show: "together" },
      { a: [L + 60, D + 40, fz], b: [L + 60, D + 40, H], part: "top" },
    ],
    note: "Legs, rails and stretchers 90 × 45, top 19 ply. Butted; fixings not shown.",
  };
}

export const SAMPLE_MODELS = [
  { title: "Mortise and tenon, 90 × 45 rail into 90 × 90 post", payload: joint("mortise_tenon", { members: [[90, 45], [90, 90]], material: "hardwood" }) },
  { title: "Through dovetail, three tails", payload: joint("dovetail", { members: [[140, 19], [140, 19]], params: { tails: 3 }, material: "oak" }) },
  { title: "Birdsmouth on a top plate, 22.5°", payload: joint("birdsmouth", { members: [[140, 45], [90, 45]], params: { pitch: 22.5, overhang: 250, rafter_run: 450 }, material: "pine" }) },
  { title: "Workbench, 1800 × 600 × 900", payload: workbench() },
] as const;
