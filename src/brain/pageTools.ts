import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { newTurn, type TurnCtx, type TurnInfo } from "./turn.js";
import { createItem, getItem, publishItem } from "../store/items.js";
import { fileAccess, itemAccess, itemBot } from "../hq/ownership.js";
import { getDoc, MODELS_DIR, registerMadeFile } from "../files/library.js";
import { cropPath } from "../drawings/library.js";
import { sheetById } from "../drawings/tiles.js";
import { imageForScreen, pyCrop } from "../drawings/engine.js";
import { PAGE, PAGE_INPUT, type Page, type PageInput, type Picture, type KeptPicture } from "../shared/pages/shape.js";
import { checkedImage, webPicture, PictureProblem } from "../pages/pictures.js";
import { pageFile } from "../pages/export.js";
import { madePictures, keptPictures, type PictureQueue } from "../pages/made.js";
import { DATA_DIR } from "../store/db.js";
import type { Item } from "../shared/protocol.js";

function checkReference(turn: TurnInfo, picture: Picture) {
  if (picture.type === "item") { const item = getItem(picture.item_id); if (!item) throw new Error(`The shown item ${picture.item_id} isn't kept any more.`); const refusal = itemAccess(turn, item); if (refusal) throw new Error(refusal); }
  if (picture.type === "file") { const file = getDoc(picture.file_id); if (!file) throw new Error(`The file ${picture.file_id} isn't kept any more.`); const refusal = fileAccess(turn, file); if (refusal) throw new Error(refusal); }
}
async function ownPicture(turn: TurnInfo, picture: Exclude<Picture, { type: "web" | "made" }>): Promise<KeptPicture> {
  const folder = await mkdtemp(path.join(tmpdir(), "tavi-page-picture-"));
  const out = path.join(folder, "picture.jpg");
  try {
    let source = "", bytes: Buffer;
    if (picture.type === "file") {
      const doc = getDoc(picture.file_id)!;
      if (doc.type !== "image") throw new PictureProblem("That file isn't a picture.");
      await imageForScreen(doc.path, out, 1200); source = doc.name; bytes = await readFile(out);
    } else if (picture.type === "sheet") {
      const sheet = sheetById(picture.sheet_id); if (!sheet) throw new PictureProblem("That sheet isn't kept any more.");
      await pyCrop(sheet.path!, sheet.page, picture.box, out, 1200); source = `Sheet ${sheet.sheet_no ?? sheet.id}, area ${picture.box.join(", ")}`; bytes = await readFile(out);
    } else {
      const item = getItem(picture.item_id)!;
      if (item.kind === "sheet") return await ownPicture(turn, { type: "sheet", sheet_id: item.payload.sheet_id, box: item.payload.view, alt: picture.alt });
      if (item.kind !== "image") throw new PictureProblem("That shown item isn't a picture or sheet.");
      const file = /^\/api\/files\/(doc_[a-f0-9]{16})\/image-\d+\.jpg$/.exec(item.payload.src);
      const crop = /^\/api\/drawings\/crop\/(crop_[a-f0-9]{16})/.exec(item.payload.src);
      const shot = /^\/api\/browser\/shot\/(shot_[a-f0-9]{16}\.png)$/.exec(item.payload.src);
      if (file) { const ref = { type: "file" as const, file_id: file[1], alt: picture.alt }; checkReference(turn, ref); return await ownPicture(turn, ref); }
      const kept = crop ? cropPath(crop[1]) : shot ? path.join(DATA_DIR, "browser", "shots", shot[1]) : undefined;
      if (!kept) throw new PictureProblem("This picture can't be copied. Use its file or sheet reference.");
      bytes = await readFile(kept); source = item.title;
    }
    return { alt: picture.alt, source, data: checkedImage(bytes) };
  } catch (e) { return { alt: picture.alt, source: picture.type === "file" ? picture.file_id : picture.type === "item" ? picture.item_id : picture.sheet_id, missing: e instanceof PictureProblem ? e.message : "The picture couldn't be opened. Try another file or sheet." }; }
  finally { await rm(folder, { recursive: true, force: true }); }
}

/**
 * A list or a set of steps written inside one paragraph: the wall of text that the list and steps blocks replace. A
 * bot that made pages before those blocks existed repeats the old shape from memory (the engine does not show it a
 * tool's shape again unless it looks), so the tool itself says no and says what to use. Ordinary writing, however
 * long, is left alone: only several short lines, or numbered lines, count.
 */
export function crammedParagraph(page: PageInput): string | null {
  for (const [index, block] of page.blocks.entries()) {
    if (block.type !== "paragraph") continue;
    const lines = block.parts.map(p => p.text).join("").split(/\n+/).map(l => l.trim()).filter(Boolean);
    const numbered = lines.filter(l => /^(?:\d{1,2}[.)]\s|step \d)/i.test(l)).length;
    const short = lines.filter(l => l.length <= 90).length;
    if (numbered < 2 && short < 5) continue;
    return `Please fix the page: block ${index + 1} is a paragraph holding ${numbered >= 2 ? "numbered steps" : `a list of ${short} lines`}. Put things that are needed in a list block (groups of items, each with amount, text and note) and things to do in a steps block (one action for each step, with title, text, facts and note). Look up the shape of show_page if you have not used these blocks, then send the whole page again.`;
  }
  return null;
}

export async function showPage(turn: TurnInfo, value: unknown, queue: PictureQueue = madePictures): Promise<{ item: Extract<Item, { kind: "page" }>; missing: { picture: string; reason: string }[]; pending: number } | { error: string }> {
  const parsed = PAGE_INPUT.safeParse(value);
  if (!parsed.success) return { error: "Please fix the page: " + parsed.error.issues.map(i => `${i.path.join(".") || "Page"}: ${i.message}`).join("; ") };
  const input = parsed.data;
  const crammed = crammedParagraph(input);
  if (crammed) return { error: crammed };
  let reservations = 0;
  try {
    const pictures: Picture[] = input.cover ? [input.cover] : [];
    for (const block of input.blocks) {
      if (block.type === "steps") for (const step of block.steps) if (step.picture) pictures.push(step.picture);
      if (block.type === "picture") pictures.push(block.picture);
      if (block.type === "collection") for (const entry of block.entries) {
        if (entry.picture) pictures.push(entry.picture);
        if (entry.place?.type === "item") { const it = getItem(entry.place.item_id); if (!it) throw new Error(`The shown item ${entry.place.item_id} isn't kept any more.`); const refusal = itemAccess(turn, it); if (refusal) throw new Error(refusal); }
        if (entry.place?.type === "sheet") { const sheet = sheetById(entry.place.sheet_id); if (!sheet) throw new Error(`The sheet ${entry.place.sheet_id} isn't kept any more.`); entry.place.sheet_name = sheet.sheet_no ?? sheet.title ?? sheet.id; }
      }
    }
    for (const picture of pictures) checkReference(turn, picture);
    const keys = [...new Set(pictures.map(p => JSON.stringify(p)))];
    if (keys.length > 50) return { error: "A page can hold up to 50 different pictures. Use fewer pictures or split the page." };
    const kept = new Map<string, KeptPicture>(); let total = 0;
    const assets: Record<string, string> = {};
    const jobs: { asset: string; prompt: string; style: string; width: number; model: string }[] = [];
    for (const key of keys) {
      const p = JSON.parse(key) as Picture;
      if (p.type === "made") {
        const planned = await queue.prepare(p, input.picture_style ?? "");
        const image: KeptPicture = { alt: p.alt, source: "Made picture", made: true };
        if (planned.reason) image.missing = planned.reason;
        else { const asset = `p${kept.size}`; image.asset = asset; image.pending = true; reservations++; jobs.push({ asset, prompt: p.prompt, style: input.picture_style ?? "", width: input.cover && JSON.stringify(input.cover) === key ? 1400 : 900, model: planned.model ?? "" }); }
        kept.set(key, image); continue;
      }
      const image = p.type === "web" ? await webPicture(p.url, p.alt) : await ownPicture(turn, p);
      total += image.data?.length ?? 0;
      if (total > 20 * 1024 * 1024) { delete image.data; image.missing = "The page has reached its picture size limit. Use smaller pictures."; }
      if (image.data) { const asset = `p${kept.size}`; assets[asset] = image.data; image.asset = asset; delete image.data; }
      kept.set(key, image);
    }
    const payload = PAGE.parse({ ...input, ...(input.cover ? { cover: kept.get(JSON.stringify(input.cover)) } : {}), pictures: assets, blocks: input.blocks.map(b => b.type === "picture" ? { ...b, picture: kept.get(JSON.stringify(b.picture)) } : b.type === "steps" ? { ...b, steps: b.steps.map(s => s.picture ? { ...s, picture: kept.get(JSON.stringify(s.picture)) } : s) } : b.type === "collection" ? { ...b, entries: b.entries.map(e => e.picture ? { ...e, picture: kept.get(JSON.stringify(e.picture)) } : e) } : b) });
    const item = createItem(turn, { kind: "page", title: payload.title, source: payload.source, payload }) as Extract<Item, { kind: "page" }>;
    publishItem(item, turn);
    for (const job of jobs) { queue.enqueue({ ...job, page: item.id }); reservations--; }
    return { item, pending: jobs.length, missing: [...kept.values()].filter(p => p.missing).map(p => ({ picture: p.alt, reason: p.missing! })) };
  } catch (e) { while (reservations-- > 0) queue.cancelReservation(); return { error: e instanceof Error ? e.message : "The page couldn't be made." }; }
}

export async function savePage(turn: TurnInfo, id: string) {
  const item = getItem(id);
  if (!item || item.kind !== "page") return { error: "Choose a page that has already been shown." };
  const refusal = itemAccess(turn, item); if (refusal) return { error: refusal };
  const message = keptPictures(item.payload).some(p => p.pending) ? "Pictures still on their way were not included." : undefined;
  if (!turn.persist) return { test: true, kind: "a page file you can search", message: ["Nothing was saved on this test turn.", message].filter(Boolean).join(" ") };
  const folder = path.join(MODELS_DIR, "pages"); await mkdir(folder, { recursive: true });
  const name = item.title.replace(/[^a-zA-Z0-9 -]/g, " ").trim().replace(/\s+/g, " ").slice(0, 80) || "Your page";
  const file = path.join(folder, `${name} - ${item.id.slice(-6)}.html`);
  await writeFile(file, pageFile(item.payload), "utf8");
  const doc = await registerMadeFile(file, { item: item.id, made_by_bot: itemBot(item), kind: "page", format: "html" });
  return { file_id: doc.id, name: doc.name, kind: "a page file you can search", download: `/api/items/${item.id}/page-file?file=${doc.id}`, ...(message ? { message } : {}) };
}

export function pageTools(ctx: TurnCtx) {
  const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
  return [
    tool("show_page", "Make a page for something to follow, keep, choose from or look through: recipes, instructions, plans, comparisons, shortlists, guides and checklists. Never squeeze lists into paragraphs or repeat the page in the conversation. Start with label, title, one-line summary, cover and up to 6 facts, including long waits. Use list blocks with style tick, bullet or plain, groups and items with text, amount and note apart. Use steps blocks with one action per step, title, text, optional day or time label, picture, up to 4 facts, and a tip or warning note before the action. Repeat amounts where used and say how to tell it is done. Put tips, swaps and storage after steps. Lead comparisons with a pick callout, then a table of at most five options or shortlist cards. Other callout tones: warning, question, tip, note. Use pictures where seeing helps. Real things need real web, file_id, item_id or sheet_id and box pictures, with alt text. Generic dishes and method stages can use type made, prompt (20 to 600 characters) and alt. Give one picture_style for matching view, light, surface and colours. At most 6 made pictures: a cover and a few hard-to-judge moments, never every step. Never make pictures of real people, products, places, maps or exact drawings, or send private details. Pictures arrive by themselves in about a minute; show the page now and briefly say they are on their way. Check missing_pictures for a plain reason and describe differently or use a real picture. Paragraphs use parts with text, optional bold and url. Collections have unique entry ids, title, facts, tags, picture and place; filters name facts or Tags. Places use sheet_id, box and label, item_id or web url. Up to 40 blocks, 200 list items, 40 steps per block, 2,000 entries and rows, 50 different pictures. Use save_page for a page file you can search, never promise a PDF. Never say something cannot be made when a page would serve. On a call say briefly what is on screen.", { page: PAGE_INPUT }, async a => {
      if (a.page.cover || a.page.blocks.some(b => b.type === "picture" || b.type === "steps" && b.steps.some(s => s.picture) || b.type === "collection" && b.entries.some(e => e.picture))) ctx.external.add("page pictures");
      const result = await showPage(ctx.test ? { ...ctx.turn, persist: false } : ctx.turn, a.page);
      return json("error" in result ? result : { shown: result.item.title, item_id: result.item.id, missing_pictures: result.missing, pictures_on_their_way: result.pending });
    }),
    tool("save_page", "Save a shown page as one page file you can search, with its pictures and search inside. It is an HTML file, not a PDF. Use when asked for a document or file. Say plainly which kind of file you made.", { item_id: z.string() }, async a => json(await savePage(ctx.test ? { ...ctx.turn, persist: false } : ctx.turn, a.item_id))),
  ];
}

/** Saving from the owner's screen keeps the original maker. */
export function ownerPageTurn(item: Item) { return newTurn({ bot: itemBot(item) ?? undefined }); }
