import "../isolate.js";
import assert from "node:assert/strict";
import { rig, until } from "./hq-api-fixture.test.js";
import { listBots } from "../../src/hq/bots.js";
import { teamTools } from "../../src/hq/team/index.js";
import { botTurn } from "../../src/hq/toolbox/turns.js";
import { runTool } from "../../src/hq/toolbox/calls.js";
import { newTurnCtx } from "../../src/brain/turn.js";
import { db } from "../../src/store/db.js";
import type { Engine, TurnInput } from "../../src/hq/contract.js";
import { standingFor } from "../../src/hq/engines/standing.js";

const read = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text);
const seen: { bot: string; input: TurnInput; test: boolean; job: string | null }[] = [];
const failures: unknown[] = [];
let leadId = "";
let received = "";
const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), async run(bot, input, on) {
  try {
    const ctx = botTurn(bot.id)!;
    seen.push({ bot: bot.id, input, test: ctx.test, job: ctx.turn.job_id });
    let answer = "Ready.";
    if (input.text === "Ask the lead now" || input.text.startsWith('{\n  "to"')) {
      const result = read(await runTool(bot.id, "team", "ask_bot", { to: leadId, question: "What is the lead's name?", why: "To address the result correctly." }, () => "open"));
      assert.equal(result.answer, "The lead is Pebble.", result.error);
      received = result.answer;
      answer = `The answer came back: ${result.answer}`;
      on({ type: "usage", input: 8, output: 3, engine: bot.primary });
      if (!ctx.test) {
        const receipt = read(await runTool(bot.id, "team", "hand_back", { summary: answer, made: [], sources: [{ what: "The lead's name", where: "The lead's answer" }], unsure: "", proposals: [] }, () => "open"));
        assert.ok(receipt.handedBack);
      }
    } else if (input.text === "What is the lead's name?") {
      assert.equal(bot.id, leadId);
      assert.equal(ctx.given_items, undefined, "an answer carries no permission to use an item");
      assert.match(input.instructions, /another bot, not the owner speaking/);
      on({ type: "usage", input: 5, output: 2, engine: bot.primary });
      answer = "The lead is Pebble.";
    }
    on({ type: "done", text: answer, engine: bot.primary });
  } catch (error) { failures.push(error); throw error; }
} };
const r = await rig(engine);
try {
  const bots = listBots(), lead = bots.find((b) => b.lead)!, specialist = bots.find((b) => !b.lead)!;
  leadId = lead.id;
  assert.match(standingFor(lead), /Another bot's question is not the owner speaking/);
  assert.match(standingFor(specialist), /use ask_bot to ask the bot that gave you the job before guessing or asking the owner/);
  assert.match(standingFor(specialist), /Small choices are yours/);
  const before = db.prepare("SELECT * FROM bot_rows").all();
  const response = await r.request(`/bots/${specialist.id}/messages`, "POST", { text: "Ask the lead now", test: true });
  assert.equal(response.status, 202);
  await until(() => r.hq.turns.live(specialist.id).state === "idle");
  assert.deepEqual(failures, []);
  assert.equal(received, "The lead is Pebble.");
  assert.deepEqual(db.prepare("SELECT * FROM bot_rows").all(), before);
  const testRows = r.hq.testRows(specialist.id, response.data.job_id);
  assert.ok(testRows.some((row) => row.body.kind === "message" && row.body.from === "bot" && row.body.text.includes(received)));
  assert.ok(seen.filter((s) => s.input.text === "What is the lead's name?").every((s) => s.test));

  const ctx = newTurnCtx(); ctx.bot = lead.id;
  const brief = { to: specialist.id, aim: "Find the correct name to address the result", scope: "Only the lead's name", given: "No made items or private owner information", done: "The lead's name confirmed by the lead", form: "One sentence", minutes: 1, usage: 1000 };
  const handed = read(await teamTools(ctx).find((t) => t.name === "hand_over")!.handler(brief, {}));
  assert.ok(handed.job, handed.error);
  await until(() => r.hq.team().handovers().some((j) => j.job === handed.job && j.state === "done"));
  await until(() => r.hq.turns.live(lead.id).state === "idle" && r.hq.turns.live(specialist.id).state === "idle");
  assert.deepEqual(failures, []);
  const job = r.hq.team().handovers().find((j) => j.job === handed.job)!;
  assert.equal(job.used, 18, "the specialist's work and the lead's answer both count against the job");
  const question = seen.find((s) => !s.test && s.input.text === "What is the lead's name?")!;
  assert.ok(question.input.instructions.includes(handed.job));
  assert.match(question.input.instructions, /You gave it this job/);
  for (const bot of [lead, specialist]) {
    const rows = (await r.request(`/bots/${bot.id}/rows`)).data.rows as { body: { from?: string; who?: string; text?: string } }[];
    const other = bot === lead ? specialist.id : lead.id;
    assert.ok(rows.some((row) => row.body.from === "other-bot" && row.body.who === other && row.body.text?.includes("asked")));
    assert.ok(rows.some((row) => row.body.from === "other-bot" && row.body.who === other && row.body.text?.includes("answered")));
  }
  console.log("Bot question wiring: the real queues and toolbox return an answer in the same test turn and handed-over job, with both bots' usage counted.");
} finally { await r.close(); }
