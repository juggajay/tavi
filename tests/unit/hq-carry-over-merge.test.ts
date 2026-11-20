import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { mock } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { MIGRATIONS } from "../../src/store/db.js";
import { carryOver } from "../../src/hq/carryOver.js";

const connection = mock.method(net, "createConnection", () => {
  const socket = new net.Socket();
  queueMicrotask(() => socket.emit("error", Object.assign(new Error("The test port is closed."), { code: "ECONNREFUSED" })));
  return socket;
});
syncBuiltinESMExports();
const from = path.join(TEST_DIR, "earlier"), to = path.join(TEST_DIR, "tavi");
const at = "2026-11-19T00:00:00.000Z";
const drawing = "sd_aaaaaaaa", model = "itm_1111111111111111", card = "itm_2222222222222222";
const doc = "doc_1111111111111111", pin = "pin_1111111111111111";
const number = "COF-SD-001";
const drawingFile = (folder: string, rev: string, ext = "pdf") => path.join(folder, "models", "shop-drawings", number, `${number} ${rev}.${ext}`);
function make(folder: string, version: number) {
  mkdirSync(folder, { recursive: true });
  const db = new DatabaseSync(path.join(folder, "harness.db"));
  MIGRATIONS.slice(0, version).forEach((sql) => db.exec(sql));
  db.exec(`PRAGMA user_version=${version}`);
  return db;
}
function file(full: string, text: string) {
  mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, text);
}
function item(db: DatabaseSync, id: string, kind: string, payload: object, bot?: string) {
  db.prepare("INSERT INTO items(id,kind,title,payload_json,origin,created_at,shown_at,job_id) VALUES(?,?,?,?,'answer',?,?,?)")
    .run(id, kind, "The same title on purpose", JSON.stringify(bot ? { ...payload, _meta: { made_by_bot: bot, based_on: [model] } } : payload), at, at, bot ? `lh-${bot}-00000000-0000-0000-0000-000000000000` : null);
}
function rows(folder: string) {
  const db = new DatabaseSync(path.join(folder, "harness.db"), { readOnly: true });
  try {
    return Object.fromEntries((db.prepare("PRAGMA table_list").all() as { name: string; type: string }[])
      .filter((t) => t.type === "table" && !t.name.startsWith("sqlite_")).map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}"`).all()]));
  } finally { db.close(); }
}
function hashes(folder: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name), relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? Object.entries(hashes(full, relative)) : [[relative, createHash("sha256").update(readFileSync(full)).digest("hex")]];
  }));
}
function set(db: DatabaseSync, folder: string, own: boolean) {
  item(db, model, "model", { title: "A model", file: path.join(folder, "models", "model.glb") }, own ? "tim" : undefined);
  db.prepare("INSERT INTO shop_drawings VALUES(?,?, 'COF','Project','Owner','A set','PRELIMINARY',?,?,?,?)")
    .run(drawing, number, own ? "C" : "A", model, at, at);
  for (const rev of own ? ["A", "B", "C"] : ["A"]) {
    const id = rev === "C" || !own ? card : `itm_${rev === "A" ? "3333333333333333" : "4444444444444444"}`;
    item(db, id, "shopdrawing", { drawing_id: drawing, number, model_item: model, rev, pdf: `/api/shopdrawings/${drawing}/${rev}/file.pdf` }, own ? "tim" : undefined);
    const parts = path.join(folder, "models", "shop-drawings", number, `${number} ${rev} parts`);
    db.prepare("INSERT INTO shop_drawing_revs VALUES(?,?,'PRELIMINARY','A change','19.11.26',?,'{}','[]',?,?,?,?,?)")
      .run(drawing, rev, JSON.stringify({ item_id: model }), drawingFile(folder, rev), drawingFile(folder, rev, "dxf"), parts, id, at);
    file(drawingFile(folder, rev), `${own ? "Tavi" : "Earlier"} PDF ${rev}`);
    file(drawingFile(folder, rev, "dxf"), `${own ? "Tavi" : "Earlier"} DXF ${rev}`);
    file(path.join(parts, "1 part.dxf"), `${own ? "Tavi" : "Earlier"} part ${rev}`);
  }
  db.prepare("INSERT INTO docs(id,path,name,type,meta_json,indexed_at) VALUES(?,?,?,'made',?,?)")
    .run(doc, drawingFile(folder, own ? "C" : "A"), "A drawing.pdf", JSON.stringify({ item: card, drawing, ...(own ? { made_by_bot: "tim" } : {}) }), at);
  db.prepare("INSERT INTO doc_parts VALUES(?,1,'First','Saved words',NULL)").run(doc);
  db.prepare("INSERT INTO pins(id,item_ids,pinned_at,updated_at) VALUES(?,?,?,?)").run(pin, JSON.stringify([model, card]), at, at);
  file(path.join(folder, "models", "model.glb"), own ? "Tavi model bytes" : "Earlier model bytes");
}
try {
  let source = make(from, 18), target = make(to, 21);
  set(source, from, false); set(target, to, true);
  // Older items may name their bot only through the work record that made them.
  for (const [db, own] of [[source, false], [target, true]] as const) {
    db.prepare("INSERT INTO jobs(id,kind,request,status,created_at,updated_at,summary) VALUES('task_kept','task','A job','done',?,?,?)")
      .run(at, at, JSON.stringify(own ? { from_turn: "lh-tim-00000000-0000-0000-0000-000000000000" } : {}));
    item(db, "itm_8888888888888888", "note", { text: "The work result" });
    db.prepare("UPDATE items SET job_id='task_kept' WHERE id='itm_8888888888888888'").run();
  }
  source.prepare("INSERT INTO shop_drawings VALUES('sd_cccccccc','COF-SD-002','COF','Project','Owner','Reserved','PRELIMINARY','A',NULL,?,?)").run(at, at);
  // Files without a bot and without a source counterpart still belong to Tavi.
  item(target, "itm_5555555555555555", "note", { text: "An owner's note" });
  file(path.join(to, "made", "owner.txt"), "The owner's file");
  // A plain file path collision uses the next free name and keeps its card linked.
  file(path.join(from, "made", "report-001.txt"), "Earlier report");
  file(path.join(to, "made", "report-001.txt"), "Tavi report");
  item(target, "itm_6666666666666666", "doc", { file_id: "doc_2222222222222222", path: path.join(to, "made", "report-001.txt") }, "main");
  target.prepare("INSERT INTO docs(id,path,name,type,meta_json,indexed_at) VALUES('doc_2222222222222222',?,'report-001.txt','made',?,?)")
    .run(path.join(to, "made", "report-001.txt"), JSON.stringify({ item: "itm_6666666666666666", made_by_bot: "main" }), at);
  const choice = JSON.stringify({ provider: "anthropic", model: "test" });
  for (const [id, lead] of [["main", 1], ["tim", 0]] as const) target.prepare("INSERT INTO bots(id,name,role,soul,look,engine,\"primary\",fallbacks,servers,computer,voice,box,lead,created_at) VALUES(?,?,'A job','','{}','hermes',?,'[]','\"all\"',0,'marin','{}',?,?)").run(id, id, choice, lead, at);
  const body = { kind: "item", item: { id: card, kind: "shopdrawing", payload: { drawing_id: drawing, number, model_item: model, pdf: `/api/shopdrawings/${drawing}/C/file.pdf`, _meta: { made_by_bot: "tim" } } }, given_items: [model, card] };
  target.prepare("INSERT INTO bot_rows VALUES('tim',0,1,1,?,'item',?)").run(at, JSON.stringify(body));
  target.prepare("INSERT INTO bot_cards VALUES('tim',1,?,?,'owner','Accepted example',0)").run(JSON.stringify({ example: { item_id: card } }), at);
  source.close(); target.close();
  const beforeSource = hashes(from), beforeTarget = hashes(to);
  let result = await carryOver({ from, to });
  assert.equal(result.code, 0, result.report);
  assert.match(result.report, /COF-SD-001 becomes COF-SD-003/);
  assert.match(result.report, /by kind:.*models: 1/);
  assert.match(result.report, /by bot:.*tim:/);
  assert.deepEqual(hashes(from), beforeSource); assert.deepEqual(hashes(to), beforeTarget);

  result = await carryOver({ from, to, yes: true }); assert.equal(result.code, 0, result.report);
  target = new DatabaseSync(path.join(to, "harness.db"));
  const ownDrawing = target.prepare("SELECT * FROM shop_drawings WHERE number='COF-SD-003'").get() as { id: string; model_item: string };
  assert.match(ownDrawing.id, /^sd_[a-f0-9]{8}$/); assert.notEqual(ownDrawing.id, drawing);
  assert.match(ownDrawing.model_item, /^itm_[a-f0-9]{16}$/); assert.notEqual(ownDrawing.model_item, model);
  const revs = target.prepare("SELECT * FROM shop_drawing_revs WHERE drawing_id=? ORDER BY rev").all(ownDrawing.id) as { rev: string; item_id: string; model_json: string; pdf: string; dxf: string; parts_dir: string }[];
  assert.deepEqual(revs.map((r) => r.rev), ["A", "B", "C"]);
  for (const rev of revs) {
    assert.equal(readFileSync(rev.pdf, "utf8"), `Tavi PDF ${rev.rev}`);
    assert.equal(readFileSync(rev.dxf, "utf8"), `Tavi DXF ${rev.rev}`);
    assert.equal(readFileSync(path.join(rev.parts_dir, "1 part.dxf"), "utf8"), `Tavi part ${rev.rev}`);
    assert.ok(rev.pdf.includes("COF-SD-003"));
    assert.equal(JSON.parse(rev.model_json).item_id, ownDrawing.model_item);
    const payload = JSON.parse((target.prepare("SELECT payload_json FROM items WHERE id=?").get(rev.item_id) as { payload_json: string }).payload_json);
    assert.equal(payload._meta.made_by_bot, "tim"); assert.equal(payload.drawing_id, ownDrawing.id); assert.equal(payload.number, "COF-SD-003");
  }
  const ownModel = JSON.parse((target.prepare("SELECT payload_json FROM items WHERE id=?").get(ownDrawing.model_item) as { payload_json: string }).payload_json);
  assert.equal(readFileSync(ownModel.file, "utf8"), "Tavi model bytes");
  assert.equal(JSON.parse((target.prepare("SELECT payload_json FROM items WHERE id=?").get(model) as { payload_json: string }).payload_json)._meta.made_by_bot, null);
  const movedBody = JSON.parse((target.prepare("SELECT body_json FROM bot_rows WHERE bot='tim'").get() as { body_json: string }).body_json);
  assert.equal(movedBody.item.id, revs[2].item_id); assert.equal(movedBody.item.payload.drawing_id, ownDrawing.id);
  assert.equal(movedBody.item.payload.number, "COF-SD-003"); assert.ok(movedBody.item.payload.pdf.includes(ownDrawing.id));
  assert.equal(movedBody.item.payload._meta.made_by_bot, "tim");
  assert.deepEqual(movedBody.given_items, [ownDrawing.model_item, revs[2].item_id]);
  const ownPin = target.prepare("SELECT item_ids FROM pins WHERE id<>?").get(pin) as { item_ids: string };
  assert.deepEqual(JSON.parse(ownPin.item_ids), movedBody.given_items);
  const movedDoc = target.prepare("SELECT id,path FROM docs WHERE json_extract(meta_json,'$.made_by_bot')='main'").get() as { id: string; path: string };
  assert.equal(movedDoc.id, "doc_" + createHash("sha256").update(movedDoc.path.toLowerCase()).digest("hex").slice(0, 16));
  assert.equal(JSON.parse((target.prepare("SELECT payload_json FROM items WHERE id='itm_6666666666666666'").get() as { payload_json: string }).payload_json).file_id, movedDoc.id);
  assert.equal(JSON.parse((target.prepare("SELECT card_json FROM bot_cards").get() as { card_json: string }).card_json).example.item_id, revs[2].item_id);
  assert.equal((target.prepare("SELECT count(*) n FROM items").get() as { n: number }).n, 10);
  const keptWorkItem = target.prepare("SELECT job_id,payload_json FROM items WHERE kind='note' AND job_id<> 'task_kept'").get() as { job_id: string; payload_json: string };
  assert.equal(JSON.parse(keptWorkItem.payload_json)._meta, undefined);
  assert.match(JSON.parse((target.prepare("SELECT summary FROM jobs WHERE id=?").get(keptWorkItem.job_id) as { summary: string }).summary).from_turn, /^lh-tim-/);
  assert.equal((target.prepare("SELECT count(*) n FROM doc_fts WHERE text MATCH 'Saved'").get() as { n: number }).n, 2);
  assert.equal((target.prepare("SELECT count(*) n FROM doc_fts WHERE doc_fts MATCH 'report'").get() as { n: number }).n, 1);
  assert.equal(target.prepare("PRAGMA foreign_key_check").all().length, 0);
  target.close();
  assert.equal(readFileSync(path.join(to, "made", "report-002.txt"), "utf8"), "Tavi report");
  assert.equal(readFileSync(path.join(to, "made", "report-001.txt"), "utf8"), "Earlier report");
  assert.equal(readFileSync(path.join(to, "made", "owner.txt"), "utf8"), "The owner's file");
  assert.deepEqual(hashes(from), beforeSource);

  const afterRows = rows(to), afterFiles = hashes(to);
  result = await carryOver({ from, to, yes: true }); assert.equal(result.code, 0, result.report);
  assert.match(result.report, /Already up to date/);
  assert.deepEqual(rows(to), afterRows); assert.deepEqual(hashes(to), afterFiles);

  source = new DatabaseSync(path.join(from, "harness.db"));
  source.prepare("UPDATE items SET title='The changed earlier model' WHERE id=?").run(model);
  source.prepare("UPDATE shop_drawings SET title='The changed earlier set' WHERE id=?").run(drawing);
  source.prepare("UPDATE shop_drawing_revs SET text='An earlier revision changed' WHERE drawing_id=? AND rev='A'").run(drawing);
  source.close(); file(path.join(from, "models", "model.glb"), "Updated earlier model bytes");
  result = await carryOver({ from, to, yes: true }); assert.equal(result.code, 0, result.report);
  target = new DatabaseSync(path.join(to, "harness.db"));
  assert.equal((target.prepare("SELECT title FROM items WHERE id=?").get(model) as { title: string }).title, "The changed earlier model");
  assert.equal((target.prepare("SELECT title FROM items WHERE id=?").get(ownDrawing.model_item) as { title: string }).title, "The same title on purpose");
  assert.equal((target.prepare("SELECT count(*) n FROM items").get() as { n: number }).n, 10);
  assert.equal((target.prepare("SELECT title FROM shop_drawings WHERE id=?").get(drawing) as { title: string }).title, "The changed earlier set");
  assert.equal((target.prepare("SELECT text FROM shop_drawing_revs WHERE drawing_id=? AND rev='A'").get(ownDrawing.id) as { text: string }).text, "A change");
  target.close();
  assert.equal(readFileSync(ownModel.file, "utf8"), "Tavi model bytes");
  assert.equal(readFileSync(path.join(to, "models", "model.glb"), "utf8"), "Updated earlier model bytes");

  // No safe next number exists here. Both dry and real runs must leave every byte alone.
  source = new DatabaseSync(path.join(from, "harness.db")); source.prepare("UPDATE shop_drawings SET number='NO-RUNNING-NUMBER' WHERE id=?").run(drawing); source.close();
  target = new DatabaseSync(path.join(to, "harness.db")); target.prepare("UPDATE shop_drawings SET number='NO-RUNNING-NUMBER' WHERE id=?").run(ownDrawing.id); target.close();
  const stopped = hashes(to), stoppedSource = hashes(from);
  for (const yes of [false, true]) {
    result = await carryOver({ from, to, yes }); assert.equal(result.code, 3, result.report);
    assert.match(result.report, /Could not place a drawing set/);
    assert.deepEqual(hashes(to), stopped); assert.deepEqual(hashes(from), stoppedSource);
  }
  // The next run also refuses a missing Tavi file, before saving even a backup.
  target = new DatabaseSync(path.join(to, "harness.db")); target.prepare("UPDATE shop_drawings SET number='COF-SD-003' WHERE id=?").run(ownDrawing.id); target.close();
  rmSync(revs[2].pdf);
  const missingBefore = hashes(to);
  result = await carryOver({ from, to, yes: true }); assert.equal(result.code, 3, result.report);
  assert.match(result.report, /Could not place a saved file:.*missing from Tavi/);
  assert.deepEqual(hashes(to), missingBefore);

  // The older carry-over left maker marks but no list of carried records.
  // Those marks are enough to refresh its model and drawing without copying them twice.
  const legacyFrom = path.join(TEST_DIR, "older-source"), legacyTo = path.join(TEST_DIR, "older-tavi");
  source = make(legacyFrom, 18); target = make(legacyTo, 21);
  set(source, legacyFrom, false); set(target, legacyTo, false);
  target.exec("UPDATE items SET payload_json=json_set(payload_json,'$._meta.made_by_bot',NULL); UPDATE docs SET meta_json=json_set(meta_json,'$.made_by_bot',NULL)");
  target.prepare("INSERT INTO bots(id,name,role,soul,look,engine,\"primary\",fallbacks,servers,computer,voice,box,lead,created_at) VALUES('main','Main','A job','','{}','hermes',?,'[]','\"all\"',0,'marin','{}',1,?)").run(choice, at);
  source.prepare("UPDATE items SET title='A newer earlier model' WHERE id=?").run(model);
  source.prepare("UPDATE shop_drawings SET title='A newer earlier drawing' WHERE id=?").run(drawing);
  item(source, "itm_7777777777777777", "note", { text: "Already the same saved thing" });
  item(target, "itm_7777777777777777", "note", { text: "Already the same saved thing" });
  file(path.join(legacyFrom, "models", "model.glb"), "New legacy model bytes");
  source.close(); target.close();
  result = await carryOver({ from: legacyFrom, to: legacyTo, yes: true }); assert.equal(result.code, 0, result.report);
  target = new DatabaseSync(path.join(legacyTo, "harness.db"));
  assert.equal((target.prepare("SELECT count(*) n FROM items").get() as { n: number }).n, 3);
  assert.equal((target.prepare("SELECT count(*) n FROM shop_drawings").get() as { n: number }).n, 1);
  assert.equal((target.prepare("SELECT title FROM shop_drawings").get() as { title: string }).title, "A newer earlier drawing");
  target.close();
  assert.equal(readFileSync(path.join(legacyTo, "models", "model.glb"), "utf8"), "New legacy model bytes");
  assert.ok(!existsSync(path.join(legacyTo, "models", "model-tavi-1.glb")));
  // A local change to a carried made file is also kept, even without a bot maker.
  file(drawingFile(legacyTo, "A"), "A local edit worth keeping");
  file(drawingFile(legacyFrom, "A"), "The newer source PDF");
  result = await carryOver({ from: legacyFrom, to: legacyTo, yes: true }); assert.equal(result.code, 0, result.report);
  target = new DatabaseSync(path.join(legacyTo, "harness.db"));
  const editedFile = (target.prepare("SELECT path FROM docs WHERE id<>?").get(doc) as { path: string }).path;
  assert.equal((target.prepare("SELECT count(*) n FROM shop_drawings").get() as { n: number }).n, 2);
  target.close();
  assert.equal(readFileSync(editedFile, "utf8"), "A local edit worth keeping");
  assert.equal(readFileSync(drawingFile(legacyTo, "A"), "utf8"), "The newer source PDF");
  source = new DatabaseSync(path.join(legacyFrom, "harness.db")); source.prepare("UPDATE items SET title='Changed again' WHERE id=?").run(model); source.close();
  result = await carryOver({ from: legacyFrom, to: legacyTo, yes: true }); assert.equal(result.code, 0, result.report);
  target = new DatabaseSync(path.join(legacyTo, "harness.db"));
  assert.equal((target.prepare("SELECT count(*) n FROM shop_drawings").get() as { n: number }).n, 2); target.close();
  assert.equal(readFileSync(editedFile, "utf8"), "A local edit worth keeping");
  file(path.join(legacyFrom, "made", "a-file"), "A source file");
  file(path.join(legacyTo, "made", "a-file", "inside.txt"), "A Tavi file");
  const beforeBlocked = hashes(legacyTo);
  result = await carryOver({ from: legacyFrom, to: legacyTo, yes: true });
  assert.equal(result.code, 2); assert.match(result.report, /both a file and a folder/);
  assert.deepEqual(hashes(legacyTo), beforeBlocked);
  assert.ok(existsSync(path.join(to, "backup")));
  console.log("Carry-over merge checks passed: both copies, three revisions, files, cards, pins, makers, exact repeat, refresh and refused placement.");
} finally {
  connection.mock.restore(); syncBuiltinESMExports();
}
