import "../isolate.js";
import assert from "node:assert/strict";
import { createJob, startJob } from "../../src/store/jobs.js";
import { db } from "../../src/store/db.js";
import { onStop } from "../../src/brain/tasks.js";
import { tryFastPath } from "../../src/gateway/fastpath.js";

process.env.LH_V3 = "1";
const stopped: string[] = [];
for (const bot of ["pebble", "tim"]) {
  const id = createJob("task", bot, "A longer job");
  startJob(id, { current: false });
  db.prepare("UPDATE jobs SET summary=? WHERE id=?").run(JSON.stringify({ bot }), id);
  onStop(id, () => stopped.push(bot));
}
assert.equal((await tryFastPath("stop that", null, null, "tim"))?.spoken, "Stopped.");
assert.deepEqual(stopped, ["tim"]);
assert.equal(await tryFastPath("stop that", null, null), null, "without a chosen bot the request goes to the bot to sort out");
assert.deepEqual(stopped, ["tim"]);
console.log("hq-voice-stop: stopping Tim's work leaves Pebble's work alone");
