// Items: validation, order within a turn, pins, "shown today", trimming, and the cards → items migration.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { db, MIGRATIONS } from "../../src/store/db.js";
import { createItem, findItems, getItem, itemsForJob, pinItem, shownToday, touchItem, updateItem } from "../../src/store/items.js";
import { newTurn } from "../../src/brain/turn.js";
import { bus } from "../../src/events.js";

const turn = newTurn({ job_id: "job_test1" });
const note = createItem(turn, { kind: "note", title: "Pour times", payload: { rows: [{ label: "Slab", value: "Thursday 7am" }] } });
const table = createItem(turn, { kind: "table", title: "Timber prices", payload: { columns: ["Yard", "90x45"], rows: [["Venn Rd", "$8.40"]] } });
assert.equal(note.seq, 0);
assert.equal(table.seq, 1);
assert.deepEqual(turn.items, [note.id, table.id]);
assert.deepEqual(itemsForJob("job_test1").map((i) => i.id), [note.id, table.id]);
assert.equal(getItem(note.id)?.title, "Pour times");

// Bad payloads and outside pictures are refused.
assert.throws(() => createItem(turn, { kind: "table", title: "x", payload: { columns: "nope" } }), /Bad table item/);
assert.throws(() => createItem(turn, { kind: "image", title: "x", payload: { src: "https://evil.example/a.png", w: 1, h: 1, alt: "" } }), /Bad image item/);
assert.throws(() => createItem(turn, { kind: "made-up" as never, title: "x", payload: {} }), /Unknown item kind/);

// Test turns show items but never keep them in the database; the newest 50 are held in memory only, so a later test
// turn can still find the one on screen (Stage 9.3: "make the tenon 10 longer" on a test turn).
const t2 = newTurn({ job_id: "job_test2", persist: false });
const transient = createItem(t2, { kind: "note", title: "Test only", payload: { rows: [] } });
assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE id = ?").get(transient.id)!.n as number, 0);
assert.equal(getItem(transient.id)?.title, "Test only");
for (let i = 0; i < 50; i++) createItem(t2, { kind: "note", title: `Test ${i}`, payload: { rows: [] } });
assert.equal(getItem(transient.id), null, "only the newest 50");

// Updates are validated, saved and announced.
let announced = 0;
bus.on("item_update", () => announced++);
updateItem(table.id, { payload: { note: "Prices include GST" } });
assert.equal((getItem(table.id)!.payload as { note?: string }).note, "Prices include GST");
assert.throws(() => updateItem(table.id, { payload: { rows: "bad" } }));
assert.equal(announced, 1);

// Find, bring back, pin.
assert.equal(findItems("timber")[0].id, table.id);
assert.equal(findItems("GST")[0].id, table.id);
const old = createItem(null, { kind: "note", title: "Old note", payload: { rows: [] } });
db.prepare("UPDATE items SET shown_at = ? WHERE id = ?").run(new Date(Date.now() - 3 * 86_400_000).toISOString(), old.id);
assert.ok(!shownToday().some((i) => i.id === old.id), "three days old: not today");
pinItem(old.id, true);
assert.equal(shownToday()[0].id, old.id, "pinned comes first");
touchItem(note.id);
assert.equal(shownToday()[1].id, note.id, "then newest shown");

// Trim keeps the newest 500 unpinned and every pinned item.
const many = db.prepare("INSERT INTO items (id, kind, title, source, payload_json, origin, seq, created_at, shown_at) VALUES (?, 'note', 'filler', '', '{\"rows\":[]}', 'answer', 0, ?, ?)");
for (let i = 0; i < 520; i++) many.run(`itm_fill${String(i).padStart(8, "0")}`, new Date(Date.now() - 86_400_000 * 10 - i * 1000).toISOString(), new Date(Date.now() - 86_400_000 * 10 - i * 1000).toISOString());
createItem(null, { kind: "note", title: "Trigger trim", payload: { rows: [] } });
assert.equal((db.prepare("SELECT COUNT(*) n FROM items WHERE pinned_at IS NULL").get() as { n: number }).n, 500);
assert.ok(getItem(old.id), "pinned survives the trim");

// Migration 9 turns earlier cards into legacy items.
const scratch = new DatabaseSync(":memory:");
for (const m of MIGRATIONS.slice(0, 8)) scratch.exec(m);
scratch.prepare("INSERT INTO cards (id, title, source, images_json, rows_json, origin, created_at, shown_at) VALUES ('crd_00000000000000a1', 'Door schedule', 'A-501', ?, ?, 'answer', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')").run(
  JSON.stringify([{ src: "/api/drawings/crop/crop_00000000000000a1.png" }]),
  JSON.stringify([{ label: "D07", value: "720" }]),
);
scratch.exec(MIGRATIONS[8]);
const moved = scratch.prepare("SELECT * FROM items").get() as { id: string; kind: string; payload_json: string; origin: string };
assert.equal(moved.id, "itm_00000000000000a1");
assert.equal(moved.kind, "legacy");
assert.deepEqual(JSON.parse(moved.payload_json).rows, [{ label: "D07", value: "720" }]);
console.log("items: order, validation, test turns, updates, find, pins, today, trim, migration");
