// A bot sees, steers and stops only its own longer work. Found the first night two bots were given the same job:
// asked to "continue", Tim passed the owner's words into Pebble's running job and said his own was carrying on.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, nowIso } from "../../src/store/db.js";
import { jobBot, latestRunningTask, workLines } from "../../src/brain/tasks.js";
import { actionTools } from "../../src/brain/actionTools.js";
import { newTurnCtx } from "../../src/brain/turn.js";

function job(id: string, title: string, bot: string | null, status = "running", at = nowIso()) {
  const summary = bot === null ? {} : { understood: "x", from_turn: `lh-${bot}-${randomUUID()}` };
  db.prepare("INSERT INTO jobs (id, kind, source, request, status, attempts, created_at, updated_at, summary) VALUES (?, 'task', ?, ?, ?, 0, ?, ?, ?)").run(id, title, title, status, at, at, JSON.stringify(summary));
}
job("job_pebble_1", "Pebble's table", "pebble", "running", "2026-11-18T12:11:03.000Z");
job("job_tim_old", "Tim's table", "tim", "done", "2026-11-18T11:53:15.000Z");
job("job_brain_1", "The old brain's own work", null, "running", "2026-11-18T12:12:00.000Z");
job("job_two-part_1", "A bot with a hyphen in its name", "site-scout", "running", "2026-11-18T12:10:00.000Z");

assert.equal(jobBot("job_pebble_1"), "pebble");
assert.equal(jobBot("job_tim_old"), "tim");
assert.equal(jobBot("job_two-part_1"), "site-scout", "a bot id with a hyphen is read whole");
assert.equal(jobBot("job_brain_1"), null, "the built-in brain's work belongs to no bot");
db.prepare("UPDATE jobs SET summary = ? WHERE id = 'job_tim_old'").run(JSON.stringify({ bot: "tim" }));
assert.equal(jobBot("job_tim_old"), "tim", "once a job has ended its summary names the bot outright");

assert.equal(latestRunningTask(), "job_brain_1", "with no bot given it is as before: the most recent running job");
assert.equal(latestRunningTask("pebble"), "job_pebble_1");
assert.equal(latestRunningTask("tim"), null, "Tim has nothing running, whatever Pebble is doing");

const timSees = workLines(Date.parse("2026-11-18T12:13:00.000Z"), "tim").join("\n");
assert.ok(!timSees.includes("Pebble's table"), "Tim is not told about Pebble's work");
assert.ok(!/Work in progress/.test(timSees), "and is not told anything of his is in progress");
const pebbleSees = workLines(Date.parse("2026-11-18T12:13:00.000Z"), "pebble").join("\n");
assert.ok(pebbleSees.includes("Pebble's table") && !pebbleSees.includes("old brain"));

// through the tools a bot actually calls
const text = (r: unknown) => JSON.stringify(r);
const tool = (bot: string, name: string) => { const ctx = newTurnCtx(); ctx.bot = bot; return actionTools(ctx).find((t) => t.name === name)!; };
const steer = await tool("tim", "update_work").handler({ say: "carry on with the table" }, {} as never);
assert.match(text(steer), /Nothing of yours is being worked on/, "Tim's 'carry on' goes nowhere, and he is told so");
const reach = await tool("tim", "update_work").handler({ job: "job_pebble_1", say: "make it round" }, {} as never);
assert.match(text(reach), /belongs to another bot/, "naming Pebble's job outright is refused");
const stop = await tool("tim", "cancel_task").handler({ job_id: "job_pebble_1" }, {} as never);
assert.match(text(stop), /belongs to another bot/);
assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job_pebble_1'").get() as { status: string }).status, "running", "Pebble's job was not touched");
console.log("work scope: a bot sees, steers and stops only its own work");
