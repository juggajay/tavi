import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
const short = z.string().trim().min(1).max(200);
const web = z.string().max(1000).refine(value => { try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; } }, "Use a normal web address without a sign-in.");
const box = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).refine(b => b[2] > b[0] && b[3] > b[1], "The picture's area must have a width and height.");
export const placeShape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("web"), url: web }).strict(),
  z.object({ type: z.literal("item"), item_id: short }).strict(),
  z.object({ type: z.literal("sheet"), sheet_id: short, sheet_name: short.optional(), box, label: short }).strict(),
]);
export const pictureShape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("web"), url: web, alt: short }).strict(),
  z.object({ type: z.literal("file"), file_id: short, alt: short }).strict(),
  z.object({ type: z.literal("item"), item_id: short, alt: short }).strict(),
  z.object({ type: z.literal("sheet"), sheet_id: short, box, alt: short }).strict(),
]);
const pictureData = z.string().max(2_800_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/);
const keptPicture = z.object({ alt: short, source: z.string().max(1200), data: pictureData.optional(), asset: z.string().regex(/^p\d{1,2}$/).optional(), missing: z.string().max(300).optional() }).strict();
const inline = z.object({ text: z.string().max(6000), bold: z.boolean().optional(), url: web.optional() }).strict();
const entry = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), title: short, subtitle: z.string().max(400).optional(), facts: z.array(z.object({ label: z.string().min(1).max(60), value: z.string().max(500) }).strict()).max(12).default([]), tags: z.array(z.string().min(1).max(60)).max(12).optional(), place: placeShape.optional() }).strict();
const blocks = <P extends z.ZodType>(picture: P) => z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), text: short }).strict(),
  z.object({ type: z.literal("paragraph"), parts: z.array(inline).min(1).max(100) }).strict(),
  z.object({ type: z.literal("collection"), title: short.optional(), view: z.enum(["cards", "table"]), filters: z.array(z.string().min(1).max(60)).max(6).optional(), entries: z.array(entry.extend({ picture: picture.optional() })).max(2000) }).strict(),
  z.object({ type: z.literal("table"), title: short.optional(), columns: z.array(z.string().min(1).max(60)).min(1).max(12), filters: z.array(z.string().min(1).max(60)).max(6).optional(), rows: z.array(z.array(z.string().max(500)).max(12)).max(2000) }).strict(),
  z.object({ type: z.literal("picture"), picture, caption: z.string().max(500).optional() }).strict(),
  z.object({ type: z.literal("callout"), tone: z.enum(["warning", "question"]), title: short, text }).strict(),
]);
const page = <P extends z.ZodType>(picture: P) => z.object({ title: short, summary: z.string().max(400).optional(), source: z.string().max(300).optional(), blocks: z.array(blocks(picture)).min(1).max(40) }).strict().superRefine((p, ctx) => {
  let count = 0;
  const ids = new Set<string>();
  for (const [i, block] of (p.blocks as z.infer<ReturnType<typeof blocks<typeof keptPicture>>>[]).entries()) {
    if (block.type === "collection") {
      count += block.entries.length;
      for (const e of block.entries) {
        if (ids.has(e.id)) ctx.addIssue({ code: "custom", path: ["blocks", i, "entries"], message: `Entry name ${e.id} is repeated. Give every entry its own name.` }); ids.add(e.id);
        if (new Set(e.facts.map(f => f.label)).size !== e.facts.length) ctx.addIssue({ code: "custom", path: ["blocks", i, "entries", e.id, "facts"], message: "Give each fact its own label within an entry." });
      }
      const labels = new Set(["Tags", ...block.entries.flatMap(e => e.facts.map(f => f.label))]);
      for (const f of block.filters ?? []) if (!labels.has(f)) ctx.addIssue({ code: "custom", path: ["blocks", i, "filters"], message: `There is no fact called ${f}.` });
    }
    if (block.type === "table") {
      count += block.rows.length;
      if (new Set(block.columns).size !== block.columns.length || block.rows.some(r => r.length !== block.columns.length)) ctx.addIssue({ code: "custom", path: ["blocks", i], message: "Give each column its own name and each row one value per column." });
      for (const f of block.filters ?? []) if (!block.columns.includes(f)) ctx.addIssue({ code: "custom", path: ["blocks", i, "filters"], message: `There is no column called ${f}.` });
    }
  }
  if (count > 2000) ctx.addIssue({ code: "custom", message: "A page can hold at most 2,000 entries and rows in all. Split this into smaller pages." });
});
export const PAGE_INPUT = page(pictureShape);
export const PAGE = page(keptPicture).safeExtend({ pictures: z.record(z.string().regex(/^p\d{1,2}$/), pictureData).optional() });
export type PageInput = z.infer<typeof PAGE_INPUT>;
export type Page = z.infer<typeof PAGE>;
export type Picture = z.infer<typeof pictureShape>;
export type KeptPicture = z.infer<typeof keptPicture>;
export type Place = z.infer<typeof placeShape>;
export function pageProblem(value: unknown): string | null {
  const result = PAGE_INPUT.safeParse(value);
  return result.success ? null : "Please fix the page: " + result.error.issues.map(i => `${i.path.join(".") || "Page"}: ${i.message}`).join("; ");
}
