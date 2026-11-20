import "../isolate.js";
import assert from "node:assert/strict";
import { fakeAccountProtection } from "../fake-hermes.js";
import { createBot } from "../../src/hq/bots.js";
import { beginBotTurn, botTurn, endBotTurn, noteBuiltinTool } from "../../src/hq/toolbox/turns.js";
import { runTool, fourPictures, NO_TURN } from "../../src/hq/toolbox/calls.js";
import { memoryScope, rememberInScope, recallInScope } from "../../src/memory/scope.js";
import { mayUseItem } from "../../src/hq/ownership.js";
import { createItem } from "../../src/store/items.js";
import { twinName } from "../../src/hq/toolbox/lanes.js";

fakeAccountProtection();
createBot({ id: "lead", name: "Lead" });
const bot = createBot({ id: "helper", name: "Helper" });
const details = (job_id: string) => ({ job_id, origin: null, test: true, background: false });
const chat = beginBotTurn(bot.id, details("chat"));
const work = beginBotTurn(bot.id, { ...details("work"), background: true }, "work");
try {
  assert.notEqual(chat, work);
  assert.equal(chat.bot, bot.id); assert.equal(work.bot, bot.id);
  assert.equal(chat.turn.bot, bot.id); assert.equal(work.turn.bot, bot.id);
  assert.equal(chat.turn.job_id, "chat"); assert.equal(work.turn.job_id, "work");
  assert.equal(chat.turn.persist, false); assert.equal(work.turn.persist, false);
  assert.equal(memoryScope(chat), "bot:helper"); assert.equal(memoryScope(work), "bot:helper");
  rememberInScope(chat, { kind: "project", subject: "Test", fact: "The notebook is shared by the two lanes." });
  assert.deepEqual(recallInScope(chat, "notebook"), recallInScope(work, "notebook"));
  const item = createItem(work.turn, { kind: "note", title: "Test note", payload: { rows: [] } });
  assert.equal(mayUseItem(chat.turn, item), true);
  assert.throws(() => beginBotTurn(bot.id, details("again")));
  assert.throws(() => beginBotTurn(bot.id, details("again"), "work"));
  noteBuiltinTool(bot.id, "web_search", "work");
  assert.equal(chat.external.size, 0); assert.equal(work.external.has("the web"), true);
  const text = (r: unknown) => JSON.stringify(r);
  assert.match(text(await runTool(bot.id, "actions", "progress", { now: "Chat progress" }, () => "open")), /Chat progress/);
  const lines: string[] = []; work.note = (line) => lines.push(line);
  await runTool(bot.id, "actions", "progress", { now: "Work progress" }, () => "open", "work");
  assert.deepEqual(lines, ["Work progress"]);
  for (const lane of ["chat", "work"] as const) for (const level of ["paused", "walled", "killed"] as const)
    assert.match(text(await runTool(bot.id, "actions", "progress", { now: "Hidden" }, () => level, lane)), /safety switch/);
  const pictures = fourPictures({ content: Array.from({ length: 6 }, () => ({ type: "image" as const, data: "AA==", mimeType: "image/png" })) });
  assert.equal(pictures.content.filter((p) => p.type === "image").length, 4);
  endBotTurn(bot.id, "work");
  assert.equal(botTurn(bot.id), chat);
  assert.match(text(await runTool(bot.id, "actions", "progress", { now: "Hidden" }, () => "open", "work")), new RegExp(NO_TURN));
  assert.throws(() => createBot({ id: twinName(bot.id), name: "Reserved" }));
  assert.equal(twinName("a".repeat(25)).length, 22);
} finally { endBotTurn(bot.id); endBotTurn(bot.id, "work"); }
console.log("Both lanes keep their own request and share only their bot's ownership and notebook.");
