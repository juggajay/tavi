// Stage 7.5: quiet when there's nothing new. The morning brief runs with a stubbed background brain (no model calls) that
// does what the instructions ask: it reports open commitments it hasn't already told them about, and nothing otherwise.
// Nothing due and nothing new: no notification. The same open item two mornings running: told once. Its due day: told
// again. And the built-in wording updates on start-up when unedited, and is left alone when the owner changed it.
import "../isolate.js"; // first: a private, throwaway data folder
import assert from "node:assert/strict";
import { db } from "../../src/store/db.js";
import { addCommitment, BUILTIN_WORDING, ensureBuiltinRoutines, OLD_BUILTIN_WORDING, updateCommitment, type Routine } from "../../src/store/proactive.js";
import { runRoutine } from "../../src/proactive/scheduler.js";
import type { BackgroundResult } from "../../src/brain/brain.js";
import { addDays, atLocal, localDay } from "../../src/time.js";

ensureBuiltinRoutines();
const brief = () => db.prepare("SELECT * FROM routines WHERE builtin = 'morning_brief'").get() as Routine;
const notices = () => (db.prepare("SELECT COUNT(*) n FROM notifications WHERE source LIKE 'routine:%'").get() as { n: number }).n;
const contexts: string[] = [];
const TOLD = "Already told them (leave out unless it has changed):";

/** Stands in for the model: tells them about open commitments not under "Already told them", or stays quiet. */
async function stub(task: string): Promise<BackgroundResult> {
  contexts.push(task);
  const [before, told = ""] = task.split(TOLD); // (the instructions mention the heading too)
  const open = [...before.matchAll(/^- \[(cmt_[a-f0-9]+)\] /gm)].map((m) => m[1]);
  const fresh = open.filter((id) => !told.includes(`[${id}]`));
  if (!fresh.length) return { notify: false, priority: "low", title: "", spoken: "", ms: 1 };
  return { notify: true, priority: "normal", title: "Morning", spoken: `${fresh.length} thing(s) on.`, ms: 1, told_commitments: fresh, told_points: ["Weather fine all day"] };
}

// The brief's wording says to stay quiet with no reason, and no longer "Always notify".
assert.doesNotMatch(brief().instructions, /Always notify/);
assert.match(brief().instructions, /notify false/);

// Nothing due and nothing new: no notification.
await runRoutine(brief(), { run: stub });
assert.equal(notices(), 0, "no reason, no brief");

// Something new: told once.
const today = localDay();
const due = addDays(today, 2);
const id = addCommitment({ title: "Book the crane for the Lumi roof", owner: "user", kind: "book", site: "Lumi", due_at: atLocal(due, 9, 0).toISOString() });
await runRoutine(brief(), { run: stub });
assert.equal(notices(), 1, "new item: brief sent");

// The next morning, nothing has changed: it's listed as already told, and nothing is sent.
const tomorrow = atLocal(addDays(today, 1), 6, 0);
await runRoutine(brief(), { run: stub, now: tomorrow });
assert.match(contexts.at(-1)!, /Already told them \(leave out unless it has changed\):\n- \[cmt_[a-f0-9]+\] Book the crane for the Lumi roof\n- Weather fine all day/);
assert.equal(notices(), 1, "the same item two mornings running is told once");

// On its due day it comes back.
await runRoutine(brief(), { run: stub, now: atLocal(due, 6, 0) });
assert.doesNotMatch(contexts.at(-1)!.split(TOLD)[1] ?? "", new RegExp(`\\[${id}\\]`), "not listed on its due day");
assert.equal(notices(), 2, "told again on its due day");

// A change of state brings it back too.
await runRoutine(brief(), { run: stub, now: atLocal(due, 7, 0) });
assert.equal(notices(), 2, "not twice on the due day");
updateCommitment(id, { due_at: atLocal(addDays(due, 3), 9, 0).toISOString() });
await runRoutine(brief(), { run: stub, now: atLocal(due, 8, 0) });
assert.equal(notices(), 3, "moved: fair to mention");

// Built-in wording: every earlier unedited version is updated on start-up; an edited one is left alone.
for (const old of OLD_BUILTIN_WORDING.morning_brief) {
  db.prepare("UPDATE routines SET instructions = ? WHERE builtin = 'morning_brief'").run(old);
  ensureBuiltinRoutines();
  assert.equal(brief().instructions, BUILTIN_WORDING.morning_brief);
}
for (const old of OLD_BUILTIN_WORDING.wrap_up) {
  db.prepare("UPDATE routines SET instructions = ? WHERE builtin = 'wrap_up'").run(old);
  ensureBuiltinRoutines();
  assert.equal((db.prepare("SELECT instructions FROM routines WHERE builtin = 'wrap_up'").get() as { instructions: string }).instructions, BUILTIN_WORDING.wrap_up);
}
const mine = `${OLD_BUILTIN_WORDING.morning_brief[2]} And always mention the weather.`;
db.prepare("UPDATE routines SET instructions = ? WHERE builtin = 'morning_brief'").run(mine);
ensureBuiltinRoutines();
assert.equal(brief().instructions, mine, "the owner's own wording is kept");

console.log("brief quiet: all passed");
