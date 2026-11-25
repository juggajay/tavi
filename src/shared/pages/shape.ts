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
  z.object({ type: z.literal("made"), prompt: z.string().trim().min(20, "Describe the picture in at least 20 characters.").max(600, "Keep the picture description within 600 characters."), alt: short }).strict(),
  z.object({ type: z.literal("web"), url: web, alt: short }).strict(),
  z.object({ type: z.literal("file"), file_id: short, alt: short }).strict(),
  z.object({ type: z.literal("item"), item_id: short, alt: short }).strict(),
  z.object({ type: z.literal("sheet"), sheet_id: short, box, alt: short }).strict(),
]);
const pictureData = z.string().max(2_800_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/);
const keptPicture = z.object({ alt: short, source: z.string().max(1200), data: pictureData.optional(), asset: z.string().regex(/^p\d{1,2}$/).optional(), missing: z.string().max(300).optional(), pending: z.boolean().optional(), made: z.boolean().optional() }).strict();
const fact = z.object({ label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(500) }).strict();
const inline = z.object({ text: z.string().max(6000), bold: z.boolean().optional(), url: web.optional() }).strict();
const entry = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), title: short, subtitle: z.string().max(400).optional(), facts: z.array(z.object({ label: z.string().min(1).max(60), value: z.string().max(500) }).strict()).max(12).default([]), tags: z.array(z.string().min(1).max(60)).max(12).optional(), place: placeShape.optional() }).strict();
const blocks = <P extends z.ZodType>(picture: P) => z.discriminatedUnion("type", [
  z.object({ type: z.literal("list"), title: short.optional(), style: z.enum(["tick", "bullet", "plain"]).default("tick"), groups: z.array(z.object({ title: short.optional(), items: z.array(z.object({ text, amount: short.optional(), note: z.string().max(500).optional() }).strict()).min(1).max(200, "Use at most 200 list items in a page.") }).strict()).min(1).max(200) }).strict(),
  z.object({ type: z.literal("steps"), title: short.optional(), steps: z.array(z.object({ title: short.optional(), text, label: short.optional(), picture: picture.optional(), facts: z.array(fact).max(4, "Use at most 4 facts on a step.").optional(), note: z.object({ tone: z.enum(["tip", "warning"]), text }).strict().optional() }).strict()).min(1).max(40, "Use at most 40 steps in a block.") }).strict(),
  z.object({ type: z.literal("heading"), text: short }).strict(),
  z.object({ type: z.literal("paragraph"), parts: z.array(inline).min(1).max(100) }).strict(),
  z.object({ type: z.literal("collection"), title: short.optional(), view: z.enum(["cards", "table"]), filters: z.array(z.string().min(1).max(60)).max(6).optional(), entries: z.array(entry.extend({ picture: picture.optional() })).max(2000) }).strict(),
  z.object({ type: z.literal("table"), title: short.optional(), columns: z.array(z.string().min(1).max(60)).min(1).max(12), filters: z.array(z.string().min(1).max(60)).max(6).optional(), rows: z.array(z.array(z.string().max(500)).max(12)).max(2000) }).strict(),
  z.object({ type: z.literal("picture"), picture, caption: z.string().max(500).optional() }).strict(),
  z.object({ type: z.literal("callout"), tone: z.enum(["warning", "question", "tip", "note", "pick"]), title: short, text }).strict(),
]);
const page = <P extends z.ZodType>(picture: P) => z.object({ title: short, label: z.string().trim().min(1).max(40, "Keep the page label within 40 characters.").optional(), cover: picture.optional(), facts: z.array(fact).max(6, "Use at most 6 facts at the top of a page.").optional(), picture_style: z.string().trim().max(300, "Keep the shared picture style within 300 characters.").refine(s => !/[\r\n]/.test(s), "Put the picture style on one line.").optional(), summary: z.string().max(400).optional(), source: z.string().max(300).optional(), blocks: z.array(blocks(picture)).min(1).max(40) }).strict().superRefine((p, ctx) => {
  let count = 0;
  let listCount = 0;
  const pictures: unknown[] = p.cover ? [p.cover] : [];
  const ids = new Set<string>();
  for (const [i, block] of (p.blocks as z.infer<ReturnType<typeof blocks<typeof keptPicture>>>[]).entries()) {
    if (block.type === "list") listCount += block.groups.reduce((n, g) => n + g.items.length, 0);
    if (block.type === "steps") pictures.push(...block.steps.flatMap(s => s.picture ? [s.picture] : []));
    if (block.type === "picture") pictures.push(block.picture);
    if (block.type === "collection") {
      pictures.push(...block.entries.flatMap(e => e.picture ? [e.picture] : []));
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
  if (listCount > 200) ctx.addIssue({ code: "custom", message: "Use at most 200 list items in a page. Split this into smaller pages." });
  if (pictures.filter(p => (p as { type?: string }).type === "made" || (p as { made?: boolean }).made).length > 6) ctx.addIssue({ code: "custom", message: "Use at most 6 made pictures in a page." });
  if (count > 2000) ctx.addIssue({ code: "custom", message: "A page can hold at most 2,000 entries and rows in all. Split this into smaller pages." });
});
export const PAGE_INPUT = page(pictureShape);
/** A small page in the right shape, given back with a refusal so a bot can see the parts at a glance. */
export const PAGE_EXAMPLE = JSON.stringify({ title: "Tomato soup", label: "Recipe", summary: "A quick soup for four.", picture_style: "Overhead photograph, soft daylight, pale wooden table.",
  cover: { type: "made", prompt: "A bowl of smooth tomato soup with a swirl of cream and basil leaves.", alt: "A bowl of tomato soup" },
  facts: [{ label: "Serves", value: "4" }, { label: "Time", value: "30 minutes" }],
  blocks: [
    { type: "list", title: "What you need", style: "tick", groups: [{ title: "The soup", items: [{ amount: "800 g", text: "Ripe tomatoes", note: "Halved" }] }] },
    { type: "steps", title: "Method", steps: [{ title: "Roast the tomatoes", text: "Roast the 800 g tomatoes until soft and browning at the edges.", facts: [{ label: "Oven", value: "200°C" }, { label: "Time", value: "20 min" }], note: { tone: "tip", text: "Cut side up." } }] },
    { type: "callout", tone: "tip", title: "To serve", text: "Good with toast." },
  ] });
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
