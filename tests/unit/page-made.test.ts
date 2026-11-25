import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PictureQueue, closePendingPictures, keptPictures, madePictures, MadeProblem, picturePrompt, createPictureQueue } from "../../src/pages/made.js";
import { showPage, savePage } from "../../src/brain/pageTools.js";
import { newTurn } from "../../src/brain/turn.js";
import { createItem, getItem, updateItem } from "../../src/store/items.js";
import { updateSettings } from "../../src/store/settings.js";
import { db } from "../../src/store/db.js";
import { bus } from "../../src/events.js";
import { pageFile } from "../../src/pages/export.js";
import { PAGE_INPUT } from "../../src/shared/pages/shape.js";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const pic = { type: "made" as const, prompt: "A bowl of rich tomato stew in soft natural light.", alt: "A bowl of stew" };
let on = true, limit = 10, count = 0, available = true, probes = 0;
const started: number[] = [], completed: number[] = [], finish: (() => void)[] = [];
const queue = new PictureQueue({
  private: () => ({ names: ["Private Example"], texts: [] }), settings: () => ({ on, limit, model: "" }), count: () => count,
  available: async () => { probes++; return available; },
  make: async ({ prompt }) => { const n = Number(prompt); started.push(n); await new Promise<void>(resolve => finish.push(resolve)); return image; },
  patch: job => { completed.push(Number(job.prompt)); }, record: () => count++,
});
for (let n = 0; n < 4; n++) { assert.ok(!("reason" in await queue.prepare(pic, ""))); queue.enqueue({ page: "page", asset: `p${n}`, prompt: String(n), style: "", width: 900, model: "" }); }
assert.deepEqual(started, [0, 1], "Only two pictures run at a time.");
finish.shift()!(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, [0, 1, 2]);
finish.shift()!(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, [0, 1, 2, 3]);
finish.splice(0).forEach(f => f()); await queue.drain(); assert.deepEqual(completed, [0, 1, 2, 3]); assert.equal(probes, 1);
limit = 4; assert.match((await queue.prepare(pic, "")).reason!, /day's picture limit/);
on = false; assert.match((await queue.prepare(pic, "")).reason!, /switched off/); on = true;
assert.match((await queue.prepare({ ...pic, prompt: "A meal made for Private Example at home." }, "")).reason!, /private name/);
assert.match((await queue.prepare(pic, "Send to example@example.test")).reason!, /email addresses/);
assert.ok(!picturePrompt("hello\u0000" + "x".repeat(900), "s".repeat(500)).includes("\u0000"));
assert.equal(JSON.parse(picturePrompt("x".repeat(900), "s".repeat(500)).split("\n")[1]).picture.length, 600);
const signedOut = new PictureQueue({ private: () => ({ names: [], texts: [] }), settings: () => ({ on: true, limit: 20, model: "" }), count: () => 0, available: async () => true, make: async () => { throw new MadeProblem("signed_out", "Sign in first."); }, record: () => {}, patch: () => {} });
await signedOut.prepare(pic, ""); signedOut.enqueue({ page: "page", asset: "p0", prompt: pic.prompt, style: "", width: 900, model: "" }); await signedOut.drain();
assert.match((await signedOut.prepare(pic, "")).reason!, /sign in/);
available = false;
let clock = 0;
const missing = new PictureQueue({ now: () => clock, private: () => ({ names: [], texts: [] }), settings: () => ({ on: true, limit: 10, model: "" }), count: () => 0, available: async () => available, make: async () => image, record: () => {}, patch: () => {} });
assert.match((await missing.prepare(pic, "")).reason!, /Install/);
available = true; assert.match((await missing.prepare(pic, "")).reason!, /Install/);
clock = 600_001; assert.ok(!("reason" in await missing.prepare(pic, ""))); missing.cancelReservation();

const recipe = JSON.parse(readFileSync(new URL("../fixtures/pages/recipe.json", import.meta.url), "utf8")); PAGE_INPUT.parse(recipe);
let release!: () => void;
const updates: string[] = [];
const handler = (event: { id: string }) => updates.push(event.id); bus.on("item_update", handler);
const live = new PictureQueue({ private: () => ({ names: [], texts: [] }), settings: () => ({ on: true, limit: 10, model: "" }), count: () => 0, available: async () => true,
  make: async () => { await new Promise<void>(resolve => release = resolve); return image; }, record: () => {},
  patch: (job, data) => { const item = getItem(job.page)!; if (item.kind !== "page") return; const payload = structuredClone(item.payload); for (const p of keptPictures(payload)) if (p.asset === job.asset) delete p.pending; payload.pictures = { ...payload.pictures, [job.asset]: data! }; updateItem(item.id, { payload }); },
});
const turn = newTurn({ bot: "page-maker" });
const shown = await showPage(turn, { title: "A recipe", cover: pic, blocks: [{ type: "paragraph", parts: [{ text: "Ready before the picture." }] }] }, live); assert.ok("item" in shown); assert.equal(shown.pending, 1);
assert.equal(shown.item.payload.cover?.pending, true);
const saved = await savePage(turn, shown.item.id); assert.ok("file_id" in saved); assert.match(saved.message!, /not included/);
const doc = db.prepare("SELECT path FROM docs WHERE id = ?").get(saved.file_id!) as { path: string };
assert.ok(!readFileSync(doc.path, "utf8").includes('"pending":true'));
release(); await live.drain(); const landed = getItem(shown.item.id)!; assert.equal(landed.kind, "page"); if (landed.kind === "page") assert.equal(landed.payload.pictures?.p0, image); assert.ok(updates.includes(shown.item.id));
const stale = createItem(turn, { kind: "page", title: "After a restart", payload: { title: "After a restart", cover: { source: "Made picture", alt: "Stew", pending: true, made: true }, blocks: [{ type: "steps", steps: [{ text: "Stir.", picture: { source: "Made picture", alt: "Sauce", pending: true, made: true } }] }] } });
closePendingPictures(); const closed = getItem(stale.id)!; if (closed.kind === "page") assert.ok(keptPictures(closed.payload).every(p => !p.pending));
const practice = newTurn({ bot: "page-maker", persist: false }); const test = createItem(practice, { kind: "page", title: "Practice", payload: { title: "Practice", blocks: [{ type: "paragraph", parts: [{ text: "Ready." }] }] } }); updateItem(test.id, { title: "Practice updated" }); assert.equal(getItem(test.id)!.title, "Practice updated"); assert.equal(db.prepare("SELECT id FROM items WHERE id = ?").get(test.id), undefined);
assert.ok(pageFile(shown.item.payload).includes('"made":true'));
updateSettings({ "pages.pictures": "off" }, "local"); assert.match((await madePictures.prepare(pic, "")).reason!, /switched off/);
bus.off("item_update", handler);
updateSettings({ "pages.pictures": "on", "pages.pictures_per_day": 1 }, "local");
// Replace both the program check and maker, while exercising the real record and page storage.
const recorded = createPictureQueue(async () => image, async () => true);
const recordedPage = await showPage(practice, { title: "Practice picture", cover: pic, blocks: [{ type: "paragraph", parts: [{ text: "A test picture." }] }] }, recorded); assert.ok("item" in recordedPage);
await recorded.drain();
const log = db.prepare("SELECT detail FROM audit_log WHERE event = 'page.picture' AND ref = ?").all(recordedPage.item.id) as { detail: string }[];
assert.equal(log.length, 1); assert.equal(JSON.parse(log[0].detail).worked, true); assert.equal(JSON.parse(log[0].detail).description, pic.prompt);
assert.match((await recorded.prepare(pic, "")).reason!, /day's picture limit/);
const recordedItem = getItem(recordedPage.item.id)!; if (recordedItem.kind === "page") assert.equal(recordedItem.payload.pictures?.p0, image);
assert.ok(TEST_DIR && path.isAbsolute(TEST_DIR));
console.log("Pictures queue in order two at a time, check privacy and limits, update pages, save without pending pictures and close them after restart.");
