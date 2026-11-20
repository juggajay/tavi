// The checks a sketch passes on the way in (Stage 8.5): what the brain may describe, and the limits. A sketch that breaks
// one is refused with a plain reason, so the brain can fix it and try again. Used by show_sketch and the items store.
import { z } from "zod";

export const MAX_SHAPES = 200;
export const MAX_COORD = 200_000;
export const MAX_TEXT = 60;
export const MAX_NOTE = 200;

const n = z.number({ error: "must be a real number" }).refine(Number.isFinite, "must be a real number").refine((v) => Math.abs(v) <= MAX_COORD, `must be within ±${MAX_COORD.toLocaleString("en-AU")} mm`);
const pos = n.refine((v) => v > 0, "must be above zero");
const pt = z.tuple([n, n]);
const text = z.string().max(MAX_TEXT, `text is ${MAX_TEXT} characters at most`);
const fill = z.enum(["none", "timber", "hatch"]).optional();
const deg = z.number({ error: "must be a real number" }).refine(Number.isFinite, "must be a real number");

export const SHAPE = z.discriminatedUnion("type", [
  z.object({ type: z.literal("line"), a: pt, b: pt, style: z.enum(["solid", "dashed"]).optional(), weight: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }),
  z.object({ type: z.literal("rect"), x: n, y: n, w: pos, h: pos, fill }),
  z.object({ type: z.literal("poly"), points: z.array(pt).min(2).max(200), fill }),
  z.object({ type: z.literal("arc"), c: pt, r: pos, from_deg: deg, to_deg: deg }),
  z.object({ type: z.literal("dim"), a: pt, b: pt, offset: n, text: text.optional() }),
  z.object({ type: z.literal("angle"), at: pt, from_deg: deg, to_deg: deg, text: text.optional() }),
  z.object({ type: z.literal("label"), at: pt, text, leader: pt.optional() }),
]);

export const SKETCH = z.object({
  shapes: z.array(SHAPE).min(1, "a sketch needs at least one shape").max(MAX_SHAPES, `at most ${MAX_SHAPES} shapes`),
  note: z.string().max(MAX_NOTE, `the note is ${MAX_NOTE} characters at most`).optional(),
});

/** Null when the sketch is fine; otherwise one plain sentence about the first thing wrong, naming the shape. */
export function sketchProblem(p: unknown): string | null {
  const shapes = (p as { shapes?: unknown[] })?.shapes;
  if (Array.isArray(shapes) && shapes.length > MAX_SHAPES) return `That's ${shapes.length} shapes; a sketch takes ${MAX_SHAPES} at most. Keep it to what helps.`;
  const r = SKETCH.safeParse(p);
  if (r.success) return null;
  const i = r.error.issues[0];
  const where = i.path[0] === "shapes" && typeof i.path[1] === "number" ? `Shape ${i.path[1] + 1}${i.path.length > 2 ? ` (${i.path.slice(2).join(".")})` : ""}` : String(i.path.join(".") || "The sketch");
  return `${where}: ${i.message}.`;
}

/** The true length of a dimension, in whole millimetres: what's written when the brain gives no text. */
export const dimLength = (a: [number, number], b: [number, number]) => Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]));
