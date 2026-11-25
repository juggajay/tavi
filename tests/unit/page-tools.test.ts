import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { newTurn, newTurnCtx } from "../../src/brain/turn.js";
import { showTools, showAgain, listShown } from "../../src/brain/showTools.js";
import { showPage, savePage } from "../../src/brain/pageTools.js";
import { getItem } from "../../src/store/items.js";
import { db } from "../../src/store/db.js";
import { itemBot } from "../../src/hq/ownership.js";
import { addPin, listPins } from "../../src/store/pins.js";
import { listEverything } from "../../src/files/everything.js";

const description = { title: "Evening listening", source: "Your listening notes", blocks: [{ type: "collection", view: "table", filters: ["Year", "Tags"], entries: [{ id: "first", title: "Slow mornings", facts: [{ label: "Year", value: "2025" }], tags: ["Quiet"] }] }, { type: "callout", tone: "question", title: "Which version?", text: "Check the release before sharing." }] };
const maker = newTurn({ bot: "one" });
const result = await showPage(maker, description); assert.ok("item" in result);
const item = result.item;
assert.equal(itemBot(getItem(item.id)!), "one");
assert.equal(showAgain(newTurn({ bot: "one" }), item.id).item?.id, item.id);
assert.match(showAgain(newTurn({ bot: "two" }), item.id).error!, /made by/);
const shown = listShown(newTurn({ bot: "one" })).item; assert.equal(shown.kind, "list"); if (shown.kind === "list") assert.ok(shown.payload.rows.some(r => r.id === item.id && r.cells[2] === "Page"));
assert.ok("error" in await savePage(newTurn({ bot: "two" }), item.id));
const saved = await savePage(maker, item.id); assert.ok("file_id" in saved);
const doc = db.prepare("SELECT path,meta_json FROM docs WHERE id=?").get(saved.file_id!) as { path: string; meta_json: string };
assert.ok(existsSync(doc.path)); assert.equal(JSON.parse(doc.meta_json).made_by_bot, "one"); assert.ok(readFileSync(doc.path, "utf8").includes("Search this page"));
assert.ok(listEverything().entries.some(e => e.id === saved.file_id && e.group === "made"));
addPin({ item_ids: [item.id] }); assert.equal(listPins()[0].items[0].kind, "page");
const counts = () => [db.prepare("SELECT count(*) n FROM items").get(), db.prepare("SELECT count(*) n FROM docs").get(), readdirSync(TEST_DIR, { recursive: true }).map(String).sort()];
const before = counts();
const testCtx = newTurnCtx(); testCtx.test = true; testCtx.turn = newTurn({ persist: false, bot: "one" }); testCtx.bot = "one";
const tools = showTools(testCtx);
const response = await tools.find(t => t.name === "show_page")!.handler({ page: description }, {});
assert.equal(response.content[0].type, "text");
const shownTest = JSON.parse(response.content[0].text); assert.ok(shownTest.item_id);
await tools.find(t => t.name === "save_page")!.handler({ item_id: shownTest.item_id }, {});
assert.deepEqual(counts(), before, "Test turns change no records or files.");
const bad = await showPage(maker, { ...description, html: "anything" }); assert.ok("error" in bad);
console.log("Pages keep their maker, reopen, appear in lists and Things made, pin, and save nothing on test turns.");

// A list or steps squeezed into a paragraph is refused, with what to use instead; ordinary writing is left alone.
{
  const { crammedParagraph } = await import("../../src/brain/pageTools.js");
  const { readFileSync } = await import("node:fs");
  const page = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/pages/${name}.json`, import.meta.url), "utf8"));
  const asked = crammedParagraph(page("recipe-asked"));
  assert.match(asked ?? "", /paragraph holding/); assert.match(asked ?? "", /list block/); assert.match(asked ?? "", /steps block/);
  for (const name of ["recipe", "comparison", "plan"]) assert.equal(crammedParagraph(page(name)), null, name);
  const prose = "A long piece of ordinary writing that explains one idea at a comfortable length, well past ninety characters in every paragraph of it.";
  assert.equal(crammedParagraph({ title: "Notes", blocks: [{ type: "paragraph", parts: [{ text: [prose, prose, prose, prose, prose, prose].join("\n\n") }] }] }), null, "long writing is not a list");
  assert.match(crammedParagraph({ title: "Steps", blocks: [{ type: "paragraph", parts: [{ text: "1. Heat the pan.\n2. Add the oil." }] }] }) ?? "", /numbered steps/);
  const refused = await showPage(maker, page("recipe-asked"));
  assert.ok("error" in refused && /Please fix the page/.test(refused.error), "the tool refuses the wall of text");
  console.log("page-tools: a list or steps inside a paragraph is refused with what to use instead");
}
