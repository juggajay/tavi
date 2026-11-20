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
import { PAGE, PAGE_INPUT, type Page, type Picture, type KeptPicture } from "../shared/pages/shape.js";
import { checkedImage, webPicture, PictureProblem } from "../pages/pictures.js";
import { pageFile } from "../pages/export.js";
import { DATA_DIR } from "../store/db.js";
import type { Item } from "../shared/protocol.js";

function checkReference(turn: TurnInfo, picture: Picture) {
  if (picture.type === "item") { const item = getItem(picture.item_id); if (!item) throw new Error(`The shown item ${picture.item_id} isn't kept any more.`); const refusal = itemAccess(turn, item); if (refusal) throw new Error(refusal); }
  if (picture.type === "file") { const file = getDoc(picture.file_id); if (!file) throw new Error(`The file ${picture.file_id} isn't kept any more.`); const refusal = fileAccess(turn, file); if (refusal) throw new Error(refusal); }
}
async function ownPicture(turn: TurnInfo, picture: Exclude<Picture, { type: "web" }>): Promise<KeptPicture> {
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

export async function showPage(turn: TurnInfo, value: unknown): Promise<{ item: Extract<Item, { kind: "page" }>; missing: { picture: string; reason: string }[] } | { error: string }> {
  const parsed = PAGE_INPUT.safeParse(value);
  if (!parsed.success) return { error: "Please fix the page: " + parsed.error.issues.map(i => `${i.path.join(".") || "Page"}: ${i.message}`).join("; ") };
  const input = parsed.data;
  try {
    const pictures: Picture[] = [];
    for (const block of input.blocks) {
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
    for (const key of keys) {
      const p = JSON.parse(key) as Picture;
      const image = p.type === "web" ? await webPicture(p.url, p.alt) : await ownPicture(turn, p);
      total += image.data?.length ?? 0;
      if (total > 20 * 1024 * 1024) { delete image.data; image.missing = "The page has reached its picture size limit. Use smaller pictures."; }
      if (image.data) { const asset = `p${kept.size}`; assets[asset] = image.data; image.asset = asset; delete image.data; }
      kept.set(key, image);
    }
    const payload = PAGE.parse({ ...input, pictures: assets, blocks: input.blocks.map(b => b.type === "picture" ? { ...b, picture: kept.get(JSON.stringify(b.picture)) } : b.type === "collection" ? { ...b, entries: b.entries.map(e => e.picture ? { ...e, picture: kept.get(JSON.stringify(e.picture)) } : e) } : b) });
    const item = createItem(turn, { kind: "page", title: payload.title, source: payload.source, payload }) as Extract<Item, { kind: "page" }>;
    publishItem(item, turn);
    return { item, missing: [...kept.values()].filter(p => p.missing).map(p => ({ picture: p.alt, reason: p.missing! })) };
  } catch (e) { return { error: e instanceof Error ? e.message : "The page couldn't be made." }; }
}

export async function savePage(turn: TurnInfo, id: string) {
  const item = getItem(id);
  if (!item || item.kind !== "page") return { error: "Choose a page that has already been shown." };
  const refusal = itemAccess(turn, item); if (refusal) return { error: refusal };
  if (!turn.persist) return { test: true, kind: "a page file you can search", message: "Nothing was saved on this test turn." };
  const folder = path.join(MODELS_DIR, "pages"); await mkdir(folder, { recursive: true });
  const name = item.title.replace(/[^a-zA-Z0-9 -]/g, " ").trim().replace(/\s+/g, " ").slice(0, 80) || "Your page";
  const file = path.join(folder, `${name} - ${item.id.slice(-6)}.html`);
  await writeFile(file, pageFile(item.payload), "utf8");
  const doc = await registerMadeFile(file, { item: item.id, made_by_bot: itemBot(item), kind: "page", format: "html" });
  return { file_id: doc.id, name: doc.name, kind: "a page file you can search", download: `/api/items/${item.id}/page-file?file=${doc.id}` };
}

export function pageTools(ctx: TurnCtx) {
  const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
  return [
    tool("show_page", "Make a page to keep, search, look through or hand on, with pictures and useful filters. Give a structured page, never HTML. Paragraphs use parts with text, optional bold and url; line breaks are newlines. Collections have entries with unique ids, title, facts, tags, picture and place. Filters name facts or Tags. A place uses the same sheet id, box and label as a list target, an item_id, or a web url. Pictures name a file_id, item_id, sheet_id and box, or a public web url, and alt text. Up to 40 blocks, 2,000 entries in all, 50 pictures. On a call say briefly that it is on screen.", { page: PAGE_INPUT }, async a => {
      if (a.page.blocks.some(b => b.type === "picture" || b.type === "collection" && b.entries.some(e => e.picture))) ctx.external.add("page pictures");
      const result = await showPage(ctx.test ? { ...ctx.turn, persist: false } : ctx.turn, a.page);
      return json("error" in result ? result : { shown: result.item.title, item_id: result.item.id, missing_pictures: result.missing });
    }),
    tool("save_page", "Save a shown page as one page file you can search, with its pictures and search inside. It is an HTML file, not a PDF. Use when asked for a document or file. Say plainly which kind of file you made.", { item_id: z.string() }, async a => json(await savePage(ctx.test ? { ...ctx.turn, persist: false } : ctx.turn, a.item_id))),
  ];
}

/** Saving from the owner's screen keeps the original maker. */
export function ownerPageTurn(item: Item) { return newTurn({ bot: itemBot(item) ?? undefined }); }
