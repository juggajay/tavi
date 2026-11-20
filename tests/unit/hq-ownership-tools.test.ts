import "../isolate.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { fakeAccountProtection } from "../fake-hermes.js";
import { DATA_DIR, db, newId, nowIso } from "../../src/store/db.js";
import { createBot } from "../../src/hq/bots.js";
import { createItem, getItem, publishItem, updateItem } from "../../src/store/items.js";
import { newTurn, newTurnCtx, type TurnCtx } from "../../src/brain/turn.js";
import { itemBot, mayUseItem } from "../../src/hq/ownership.js";
import { modelTools } from "../../src/brain/modelTools.js";
import { showTools } from "../../src/brain/showTools.js";
import { fileTools } from "../../src/brain/fileTools.js";
import { shopTools } from "../../src/brain/shopTools.js";
import { actionTools } from "../../src/brain/actionTools.js";
import { referenceTools } from "../../src/brain/referenceTools.js";
import { teamTools } from "../../src/hq/team/index.js";
import { brainLinkTools } from "../../src/brainlink/tools.js";
import { buildContext } from "../../src/brain/context.js";
import { clients, type ClientInfo } from "../../src/gateway/clients.js";
import { deliverPicture } from "../../src/gateway/modelLink.js";
import { describeScreen } from "../../src/gateway/surface.js";
import { bus } from "../../src/events.js";
import { addPin } from "../../src/store/pins.js";
import { saveRevision, type Drawing } from "../../src/store/shopdrawings.js";
import { ensureManagedFolder, getDoc, MODELS_DIR, registerMadeFile, scanFolder } from "../../src/files/library.js";
import { ALL_SERVERS, argumentSchema, toolsFor } from "../../src/hq/toolbox/tools.js";
import { z } from "zod";

fakeAccountProtection();
const lead = createBot({ id: "main", name: "Main" });
const a = createBot({ id: "pebble", name: "Pebble" });
const b = createBot({ id: "tim", name: "Tim" });
function context(bot?: string) { const ctx = newTurnCtx(); ctx.bot = bot; ctx.turn.job_id = bot ? `lh-${bot}-${randomUUID()}` : null; return ctx; }
const aCtx = context(a.id), bCtx = context(b.id), leadCtx = context(lead.id);
const call = async (factory: typeof modelTools, ctx: TurnCtx, name: string, args: Record<string, unknown> = {}) => {
  const tool = factory(ctx).find((t) => t.name === name); assert.ok(tool, name);
  return tool.handler(args, {});
};
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
const parsed = (r: unknown) => JSON.parse(text(r));
const parts = [{ id: "one", name: "Display", material: "plain", stock: { type: "box", size: [100, 80, 20] } }];
const made = parsed(await call(modelTools, aCtx, "show_model", { title: "Private blue display 91275", parts }));
const model = getItem(made.item)!; assert.equal(model.kind, "model");
const list = await call(showTools, aCtx, "show_list", { heading: "Private choices 41728", rows: [{ cells: ["First choice"], item_id: model.id }] });
assert.equal(parsed(list).shown, "Private choices 41728");
const aList = getItem(aCtx.turn.items.at(-1)!)!;
assert.equal(itemBot(model), a.id);
assert.equal(itemBot(aList), a.id);
assert.equal((JSON.parse((db.prepare("SELECT payload_json FROM items WHERE id=?").get(model.id) as { payload_json: string }).payload_json))._meta.made_by_bot, a.id);
assert.ok(!("_meta" in getItem(model.id)!.payload), "the apps receive the same item shape");
updateItem(model.id, { source: "A display" });
assert.equal(itemBot(getItem(model.id)!), a.id);

const old = createItem(newTurn(), { kind: "note", title: "Earlier note", payload: { rows: [] } });
assert.equal(itemBot(old), null);
const work = newId("job");
db.prepare("INSERT INTO jobs(id,kind,source,request,status,attempts,created_at,updated_at,summary) VALUES(?,'task','test','test','done',0,?,?,?)").run(work, nowIso(), nowIso(), JSON.stringify({ bot: a.id }));
const workItem = createItem(newTurn({ job_id: work }), { kind: "note", title: "Private work note", payload: { rows: [] } });
publishItem(workItem, newTurn({ job_id: work }));
db.prepare("DELETE FROM jobs WHERE id=?").run(work);
assert.equal(itemBot(getItem(workItem.id)!), a.id, "the saved maker survives removal of the job");
const hyphen = createItem(newTurn({ job_id: `lh-two-parts-${randomUUID()}` }), { kind: "note", title: "Separate note", payload: { rows: [] } });
assert.equal(itemBot(hyphen), "two-parts");

mkdirSync(MODELS_DIR, { recursive: true });
const saved = path.join(MODELS_DIR, "private-display-72419.glb"); writeFileSync(saved, "test file");
const doc = await registerMadeFile(saved, { item: model.id });
assert.equal(JSON.parse(doc.meta_json!).made_by_bot, a.id);
writeFileSync(saved, "changed test file content");
await scanFolder(ensureManagedFolder());
assert.equal(JSON.parse(getDoc(doc.id)!.meta_json!).made_by_bot, a.id, "a scan keeps the maker");
db.prepare("UPDATE docs SET project = ? WHERE id = ?").run(model.title, doc.id);
const photoId = newId("doc"), photoName = "private-view-73128.jpg";
db.prepare("INSERT INTO docs(id,folder_id,project,path,name,type,mtime,size,parts,meta_json,indexed_at) VALUES(?,?,?,?,?,'image',?,8,0,?,?)").run(photoId, ensureManagedFolder(), model.title, path.join(DATA_DIR, "drawings", "inbox", photoName), photoName, Date.now(), JSON.stringify({ by: "assistant", made_by_bot: a.id, item: model.id }), nowIso());
db.prepare("INSERT INTO docs(id,folder_id,project,path,name,type,mtime,size,parts,meta_json,indexed_at) VALUES(?,?,?,?,?,'text',1,8,1,NULL,?)").run("doc_owner", ensureManagedFolder(), "Personal", path.join(DATA_DIR, "owner.txt"), "Owner's note.txt", nowIso());
db.prepare("INSERT INTO doc_parts(doc_id,n,label,text) VALUES('doc_owner',0,'Note','Owner words')").run();

const drawing: Drawing = { id: "sd_1234abcd", number: "PRIVATE-91275", title: "Private drawing 81247", job: "Personal", project: "Personal", client: "Owner", status: "PRELIMINARY", rev: "P1", model_item: model.id, created_at: nowIso(), updated_at: nowIso() };
const drawingItem = createItem(aCtx.turn, { kind: "shopdrawing", title: drawing.title, payload: { drawing_id: drawing.id, number: drawing.number, rev: "P1", status: drawing.status, project: drawing.project, client: drawing.client, model_item: model.id, sheets: [{ title: "Display", aspect: 1 }], revisions: [], pdf: `/api/shopdrawings/${drawing.id}/P1/file.pdf`, dxf: `/api/shopdrawings/${drawing.id}/P1/file.dxf` } });
saveRevision(drawing, { drawing_id: drawing.id, rev: "P1", status: drawing.status, text: "First version", date: "2026-11-18", model: model.payload, input: { title: drawing.title }, sheets: [{ title: "Display", aspect: 1 }], pdf: path.join(DATA_DIR, "private.pdf"), dxf: path.join(DATA_DIR, "private.dxf"), parts_dir: DATA_DIR, item_id: drawingItem.id, made_at: nowIso() }, true);
const pin = addPin({ item_ids: [model.id, aList.id] }); assert.ok("pin" in pin);
const secrets = [model.id, model.title, aList.id, aList.title, doc.id, doc.name, photoId, photoName, drawing.id, drawing.title, drawing.number, drawingItem.id];
const privateResult = (r: unknown, label: string) => { for (const secret of secrets) assert.ok(!JSON.stringify(r).includes(secret), `${label} keeps ${secret} private`); };
const refuse = async (factory: typeof modelTools, name: string, args: Record<string, unknown>) => {
  const r = await call(factory, bCtx, name, args); privateResult(r, name); assert.match(text(r), /made by Pebble.*hand/s, name); return r;
};
let reopened = 0;
const onItem = (e: { item: { id: string } }) => { if ([model.id, aList.id, drawingItem.id].includes(e.item.id)) reopened++; };
bus.on("item", onItem);
try {
  // The exact sequence that caused the two designs to become one.
  bCtx.test = true;
  privateResult(await call(actionTools, bCtx, "start_work", { title: "Another display", understood: "Make a new design", how_long: "a minute" }), "start_work");
  bCtx.test = false;
  await refuse(modelTools, "look_at_model", { item: model.id });
  privateResult(await call(referenceTools, bCtx, "design_rules", { about: "all" }), "design_rules");
  privateResult(await call(fileTools, bCtx, "list_files"), "list_files");
  privateResult(await call(showTools, bCtx, "list_shown"), "list_shown");
  await refuse(modelTools, "look_at_model", { item: model.id });
  await refuse(showTools, "show_again", { query: model.id });
  await refuse(showTools, "show_again", { query: aList.id });
  await refuse(modelTools, "look_at_model", { item: model.id });
  await refuse(modelTools, "save_model", { item: model.id, as: "glb" });
  await refuse(showTools, "show_list", { heading: "Another display", rows: [{ cells: ["A choice"], item_id: model.id }] });
  privateResult(await call(teamTools, bCtx, "hand_back", { summary: "No design made", made: [], sources: [], unsure: "", proposals: [] }), "hand_back");
  assert.equal(reopened, 0);
  const ownShown = parsed(await call(modelTools, bCtx, "show_model", { title: "Tim's new display", parts }));
  assert.notEqual(ownShown.item, model.id); assert.equal(itemBot(getItem(ownShown.item)!), b.id);
  assert.equal(mayUseItem(newTurn({ bot: b.id }), getItem(ownShown.item)!), true);

  for (const name of ["show_again", "show_card_again"]) privateResult(await call(showTools, bCtx, name, { query: model.title }), name);
  for (const name of ["save_model", "render_model", "proposal_sheet"]) await refuse(modelTools, name, { item: model.id, as: "glb", title: "A page" });
  for (const name of ["joint_model", "show_model"]) await refuse(modelTools, name, { replaces: model.id, type: "butt", title: "Changed display", parts });
  for (const name of ["read_file", "view_file", "show_file"]) for (const ref of [doc.id, doc.name]) await refuse(fileTools, name, { file: ref });
  for (const ref of [doc.id, doc.name]) {
    await refuse(referenceTools, "add_guide", { file: ref, maker: "Example" });
    await refuse(brainLinkTools, "brain_start_job", { mode: "read", drawings: [{ file: ref }] });
  }
  privateResult(await call(fileTools, bCtx, "search_files", { query: "private" }), "search_files");
  bCtx.given_items = [model.id];
  const sharedFile = text(await call(fileTools, bCtx, "read_file", { file: doc.id }));
  assert.ok(sharedFile.startsWith("This was made by Pebble."));
  assert.ok(!sharedFile.includes("I made"), "a handed-over file is not described as this bot's own");
  bCtx.given_items = undefined;
  for (const group of [undefined, "models", "shop", "made"]) privateResult(await call(fileTools, bCtx, "show_files", { group }), `show_files ${group}`);
  for (const name of ["show_shop_drawing", "look_at_drawing", "set_drawing_status", "add_drawing_view", "remove_drawing_view", "export_shop_drawing"]) {
    await refuse(shopTools, name, { drawing: drawing.number, query: drawing.number, status: "FOR APPROVAL", kind: "section", view: "last" });
  }
  privateResult(await call(shopTools, bCtx, "show_shop_drawing"), "show_shop_drawing list");
  await refuse(shopTools, "make_shop_drawing", { model: model.id });
  await refuse(shopTools, "set_drawing_details", { logo: saved });
  privateResult(await call(showTools, bCtx, "list_pins"), "list_pins");
  await refuse(showTools, "pin_item", { item_id: model.id });
  privateResult(await call(showTools, bCtx, "unpin_item", { pin_id: pin.pin.id }), "unpin_item");

  // An open screen grants a look only. A tiny stand-in app answers pictures immediately.
  const socket = {} as WebSocket;
  const client: ClientInfo = { id: "owner-screen", v: 2, kind: "desktop", screen: { item_id: model.id, set: [model.id, aList.id] }, connectedAt: Date.now() };
  clients.set(socket, client);
  bCtx.turn.items = [];
  bCtx.turn.origin = { client: "desktop", id: client.id };
  const onSurface = (event: Parameters<typeof bus.emit<"surface">>[1]) => {
    const cmd = event.cmd;
    if (cmd.cmd === "model_pictures") cmd.views.forEach((view, n) => deliverPicture(cmd.req, model.id, n, view, Buffer.from("test picture")));
  };
  bus.on("surface", onSurface);
  try {
    const looked = await call(modelTools, bCtx, "look_at_model", { item: model.id });
    assert.ok(text(looked).startsWith("This was made by Pebble.\n"));
    await refuse(modelTools, "save_model", { as: "glb" });
    await refuse(modelTools, "show_model", { title: "Changed", parts, replaces: model.id });
    await refuse(shopTools, "make_shop_drawing", {});
    await refuse(showTools, "pin_item", {});
    const screenContext = buildContext("Explain this", describeScreen(client.id), { bot: b.id });
    assert.match(screenContext, /On screen now:.*This was made by Pebble/);
    assert.ok(!screenContext.includes(aList.title), "nearby pages are not permission");
    client.screen = null;
    await refuse(modelTools, "look_at_model", { item: model.id });
    const ownContext = buildContext("Make a display", undefined, { bot: b.id }); privateResult(ownContext, "specialist context");
  } finally { bus.off("surface", onSurface); clients.delete(socket); }

  assert.ok(JSON.stringify(await call(fileTools, leadCtx, "list_files")).includes(doc.name));
  assert.ok(JSON.stringify(await call(showTools, leadCtx, "list_shown")).includes(model.id));
  assert.ok(text(await call(showTools, leadCtx, "show_again", { query: model.id })).startsWith("This was made by Pebble."));
  assert.match(buildContext("", undefined, { bot: lead.id }), /Private blue display 91275 This was made by Pebble/);

  // The older assistant's replies keep their exact words and spacing.
  const legacy = context();
  assert.equal(text(await call(showTools, legacy, "show_again", { query: model.title })), JSON.stringify({ shown: model.title }, null, 2));
  assert.equal(text(await call(fileTools, legacy, "read_file", { file: doc.id })), JSON.stringify({ error: `${doc.name} is a file I made from a model (a 3D file, a video or a page). It isn't read as text; to see the model again, use show_again.` }, null, 2));
  assert.equal(text(await call(fileTools, legacy, "read_file", { file: "doc_owner" })), JSON.stringify({ file: "doc_owner", name: "Owner's note.txt", part: 0, of: 1, section: "Note", text: "Owner words" }, null, 2));
  assert.ok(!buildContext().includes("Recent things shown:"));
  assert.equal(parsed(await call(fileTools, bCtx, "read_file", { file: "doc_owner" })).text, "Owner words");
  const builtinCtx = context(); builtinCtx.turn.bot = b.id;
  assert.match(text(await call(modelTools, builtinCtx, "look_at_model", { item: model.id })), /made by Pebble.*hand/s, "the built-in engine also carries the bot on its turn");
  privateResult(await call(showTools, builtinCtx, "list_pins"), "built-in bot pins");

  // Every server is walked, including tools which do not use saved work. No outside service is contacted.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No outside service is used in this test."); };
  const walk = context(b.id); walk.test = true; walk.turn.persist = false;
  const input = (s: Record<string, unknown>): unknown => {
    if ("const" in s) return s.const;
    if (Array.isArray(s.enum)) return s.enum[0];
    if (Array.isArray(s.anyOf)) return input(s.anyOf[0]);
    if (s.type === "object") return Object.fromEntries(Object.entries(s.properties as Record<string, Record<string, unknown>> ?? {}).filter(([k]) => (s.required as string[] ?? []).includes(k)).map(([k, v]) => [k, input(v)]));
    if (s.type === "array") return Array.from({ length: Number(s.minItems ?? 0) }, () => input(s.items as Record<string, unknown>));
    if (s.type === "boolean") return false;
    if (s.type === "number" || s.type === "integer") return Number(s.minimum ?? 1);
    return "Nothing requested";
  };
  const overrides: Record<string, Record<string, unknown>> = { "reference/design_rules": { about: "all" }, "model/show_model": { title: "New display", parts }, "show/show_sketch": { title: "A circle", shapes: [{ type: "label", at: [0, 0], text: "Circle" }] }, "shop/set_drawing_details": {} };
  let checked = 0;
  try {
    for (const server of ALL_SERVERS) for (const tool of toolsFor(walk, server)) {
      const args = overrides[`${server}/${tool.name}`] ?? input(z.toJSONSchema(argumentSchema(tool.inputSchema))) as Record<string, unknown>;
      const result = await tool.handler(args, {});
      privateResult(result, `${server}/${tool.name}`); checked++;
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.ok(checked > 100);
  console.log(`Saved work: replay, screen access, lead access, files, drawings, old replies and all ${checked} tools checked.`);
} finally { bus.off("item", onItem); clients.clear(); }
