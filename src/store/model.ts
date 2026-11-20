// The checks a 3D model passes on the way in (Stage 9.1): what the brain may describe, and the limits. A model that
// breaks one is refused with a plain reason naming the part, so the brain can fix it and try again. Used by the model
// tools and the items store. The shapes themselves are checked after (src/shared/model3d/check.ts): those are facts
// for the brain, not refusals.
import { z } from "zod";
import { outlineProblem } from "../shared/model3d/solids.js";

export const MAX_PARTS = 60;
export const MAX_CUTS = 24;
export const MAX_DIMS = 40;
export const MAX_COORD = 50_000;
export const MAX_NAME = 40;
export const MAX_NOTE = 200;

const n = z.number({ error: "must be a real number" }).refine(Number.isFinite, "must be a real number").refine((v) => Math.abs(v) <= MAX_COORD, `must be within ±${MAX_COORD.toLocaleString("en-AU")} mm`);
const pos = n.refine((v) => v > 0, "must be above zero");
const v3 = z.tuple([n, n, n], { error: "must be three numbers [x, y, z]" });
const deg = z.tuple([n, n, n], { error: "must be three angles in degrees [x, y, z]" });
const axis = z.enum(["x", "y", "z"], { error: 'must be "x", "y" or "z"' });

export const SOLID = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("box"), size: z.tuple([pos, pos, pos], { error: "must be three sizes above zero [x, y, z]" }), at: v3.optional(), rot: deg.optional() }),
    z.object({ type: z.literal("cyl"), r: pos, h: pos, axis, at: v3 }),
    z.object({
      type: z.literal("prism"),
      points: z
        .array(z.tuple([n, n]), { error: "must be a list of [u, v] points" })
        .min(3, "an outline needs 3 points at least")
        .max(24, "an outline takes 24 points at most")
        .superRefine((pts, ctx) => {
          const p = outlineProblem(pts);
          if (p) ctx.addIssue({ code: "custom", message: p });
        }),
      plane: z.enum(["xy", "xz", "yz"], { error: 'must be "xy", "xz" or "yz"' }),
      depth: pos,
      at: v3.optional(),
    }),
  ],
  { error: 'type must be "box", "cyl" or "prism"' },
);

export const PART = z.object({
  id: z.string().min(1, "needs an id").max(MAX_NAME, `id is ${MAX_NAME} characters at most`),
  name: z.string().min(1, "needs a name").max(MAX_NAME, `name is ${MAX_NAME} characters at most`),
  material: z.enum(["pine", "hardwood", "oak", "walnut", "ply", "mdf", "steel", "concrete", "plain"], { error: "material must be pine, hardwood, oak, walnut, ply, mdf, steel, concrete or plain" }),
  stock: SOLID,
  cuts: z.array(SOLID).max(MAX_CUTS, `a part takes ${MAX_CUTS} cuts at most`).optional(),
  at: v3.optional(),
  rot: deg.optional(),
  grain: axis.optional(),
  apart: v3.optional(),
});

export const DIM = z.object({ a: v3, b: v3, text: z.string().max(MAX_NAME, `text is ${MAX_NAME} characters at most`).optional(), part: z.string().max(MAX_NAME).optional(), show: z.enum(["together", "apart"], { error: 'show is "together" or "apart"' }).optional() });

export const MODEL = z
  .object({
    parts: z.array(PART).min(1, "a model needs at least one part").max(MAX_PARTS, `a model takes ${MAX_PARTS} parts at most`),
    dims: z.array(DIM).max(MAX_DIMS, `a model takes ${MAX_DIMS} sizes at most`).optional(),
    note: z.string().max(MAX_NOTE, `the note is ${MAX_NOTE} characters at most`).optional(),
    made_by: z.object({ recipe: z.string().max(MAX_NAME), params: z.record(z.string(), z.union([z.number(), z.string().max(200), z.boolean()])) }).optional(),
    // who chose how it goes together (Stage 19.7)
    design: z
      .object({
        by: z.enum(["owner", "assistant", "mixed"]),
        // rules: the design rules its proportions follow (ids; one the drawing doesn't know is left out there)
        joints: z.array(z.object({ parts: z.array(z.string().max(MAX_NAME)).min(1).max(4), kind: z.string().max(60), fixing: z.string().max(60).optional(), by: z.enum(["owner", "assistant"]), rules: z.array(z.string().max(40)).max(6).optional() })).max(30).optional(),
      })
      .optional(),
  })
  .superRefine((m, ctx) => {
    const ids = new Set<string>();
    m.parts.forEach((p, i) => {
      if (ids.has(p.id)) ctx.addIssue({ code: "custom", path: ["parts", i, "id"], message: `"${p.id}" is used by two parts; each part needs its own id` });
      ids.add(p.id);
    });
    (m.dims ?? []).forEach((d, i) => {
      if (d.part && !ids.has(d.part)) ctx.addIssue({ code: "custom", path: ["dims", i, "part"], message: `there's no part "${d.part}"` });
      if (Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1], d.b[2] - d.a[2]) < 1e-6) ctx.addIssue({ code: "custom", path: ["dims", i], message: "its two ends are the same point" });
    });
  });

/** Null when the model is fine; otherwise one plain sentence about the first thing wrong, naming the part. */
export function modelProblem(p: unknown): string | null {
  const m = p as { parts?: unknown[]; dims?: unknown[] };
  if (Array.isArray(m?.parts) && m.parts.length > MAX_PARTS) return `That's ${m.parts.length} parts; a model takes ${MAX_PARTS} at most. Leave out the small bits that don't change how it goes together.`;
  if (Array.isArray(m?.dims) && m.dims.length > MAX_DIMS) return `That's ${m.dims.length} sizes; a model takes ${MAX_DIMS} at most. Keep the ones that matter.`;
  const r = MODEL.safeParse(p);
  if (r.success) return null;
  const i = r.error.issues[0];
  const path = i.path;
  const parts = (p as { parts?: { name?: unknown }[] })?.parts;
  let where = "The model";
  if (path[0] === "parts" && typeof path[1] === "number") {
    const nm = parts?.[path[1]]?.name;
    where = `Part ${path[1] + 1}${typeof nm === "string" && nm ? ` (${nm.slice(0, MAX_NAME)})` : ""}`;
    if (path[2] === "cuts" && typeof path[3] === "number") where += `, cut ${path[3] + 1}${path.length > 4 ? ` (${path.slice(4).join(".")})` : ""}`;
    else if (path.length > 2) where += ` (${path.slice(2).join(".")})`;
  } else if (path[0] === "dims" && typeof path[1] === "number") where = `Size ${path[1] + 1}${path.length > 2 ? ` (${path.slice(2).join(".")})` : ""}`;
  else if (path.length) where = String(path.join("."));
  return `${where}: ${i.message}.`;
}
