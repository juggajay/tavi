// Stage 7.2: save freely, ask rarely. The memory keeper with a stubbed model plan (no model calls): what the owner's own
// lines carry is saved, what rests only on the assistant's lines is dropped (never held), weak removals are dropped, and
// a brain-tool write from a turn that read email is still held, then lapses after three days. Background Contexts never
// carry held writes.
import "../isolate.js"; // first: a private, throwaway data folder
import assert from "node:assert/strict";
import { db, nowIso } from "../../src/store/db.js";
import { editUser, heldWrites, readUser, rememberChecked } from "../../src/profile/profile.js";
import { fold, keeperPass, supportShare, type Plan } from "../../src/memory/keeper.js";
import { buildContext } from "../../src/brain/context.js";
import { newTurnCtx, noteOutsideReads, trustOf } from "../../src/brain/turn.js";

const say = (role: "user" | "assistant", text: string) => Number(db.prepare("INSERT INTO conversation_log (ts, role, channel, text) VALUES (?, ?, 'voice', ?)").run(nowIso(), role, text).lastInsertRowid);
const pass = (plan: Plan) => keeperPass("test", async () => plan);
const empty: Plan = { about_user: [], details: [], offers: [], settled: [], gist: "" };
const dropped = () => (db.prepare("SELECT COUNT(*) n FROM audit_log WHERE event = 'keeper.dropped'").get() as { n: number }).n;
const held = () => (db.prepare("SELECT COUNT(*) n FROM profile_changes WHERE status = 'held'").get() as { n: number }).n;

// The voice's spelling folds onto the written one.
assert.equal(fold("Lummee"), fold("Lum"));
assert.ok(supportShare(["Lummee job"], "Working on the Lum job") >= 0.4);

// 1. "Lummee job" plus "show me the hardware schedule" saves "Working on the Lum job" under Work.
const u1 = say("user", "Lummee job");
const u2 = say("user", "show me the hardware schedule");
const a1 = say("assistant", "Here's the hardware schedule for Lum. HW-04 is on the doors to the stairs.");
await pass({ ...empty, about_user: [{ op: "add", section: "Work", text: "Working on the Lum job", evidence: [u1, u2] }] });
assert.match(readUser(), /## Work\n- Working on the Lum job \(\d{4}-\d{2}-\d{2} · picked up in conversation\)/, readUser());
assert.equal(held(), 0, "nothing held");

// Nearly all of it in their words: "you said".
const u3 = say("user", "My brother Ruvo helps organise club events in Example Village");
await pass({ ...empty, about_user: [{ op: "add", section: "People", text: "Brother Ruvo helps organise club events in Example Village", evidence: [u3] }] });
assert.match(readUser(), /- Brother Ruvo helps organise club events in Example Village \(\d{4}-\d{2}-\d{2} · you said\)/);

// 2. A fact that appears only in an assistant line is dropped, not held.
const before = dropped();
const a2 = say("assistant", "The email from Example Store B says their yard closes at noon on Saturdays.");
await pass({
  ...empty,
  details: [{ kind: "project", subject: "Example Store B", fact: "Yard closes at noon on Saturdays", evidence: [a2] }],
  about_user: [{ op: "add", section: "Work", text: "Uses HW-04 hardware on stair doors", evidence: [a1] }],
});
assert.equal(dropped(), before + 2, "both dropped");
assert.equal(held(), 0, "and not held");
assert.ok(!db.prepare("SELECT 1 FROM memories WHERE subject = 'Example Store B'").get());
assert.doesNotMatch(readUser(), /HW-04/);

// 3. A remove with weak support is dropped; with strong support it goes.
const u4 = say("user", "Yeah nah, not that one");
await pass({ ...empty, about_user: [{ op: "remove", match: "Working on the Lum job", evidence: [u4] }] });
assert.match(readUser(), /Working on the Lum job/, "weak remove dropped");
const u5 = say("user", "We finished the Lum job, I'm not working on it any more");
await pass({ ...empty, about_user: [{ op: "remove", match: "Working on the Lum job", evidence: [u5] }] });
assert.doesNotMatch(readUser(), /Lum/, "strong remove applied");

// A gist that says nothing happened is saved as empty.
say("user", "cheers");
await pass({ ...empty, gist: "Nothing new to keep." });
assert.equal((db.prepare("SELECT COUNT(*) n FROM day_notes").get() as { n: number }).n, 0);

// 4. A brain-tool write from a turn that read email is still held, and lapses after three days.
const ctx = newTurnCtx();
await noteOutsideReads(ctx).hooks[0]({ hook_event_name: "PreToolUse", tool_name: "mcp__claude_ai_Gmail__search_threads", tool_input: {} } as never, undefined, { signal: new AbortController().signal });
const h = editUser({ op: "add", section: "People", text: "Ruvo Pell, certifier" }, trustOf(ctx));
const m = rememberChecked({ kind: "person", subject: "Ruvo Pell", fact: "Owes the reo sign-off" }, trustOf(ctx));
assert.equal(h.status, "held");
assert.equal(m.status, "held");
assert.equal(heldWrites().length, 2);
// The live Context shows one, only when what they said relates to it.
assert.doesNotMatch(buildContext("what's the weather tomorrow"), /Held for the user's yes/);
const live = buildContext("did Pell get back to me");
assert.match(live, /Held for the user's yes/);
assert.equal(live.split("\n").filter((l) => /^- \[pchg_/.test(l)).length, 1, "at most one");
// The background Context never carries them.
assert.doesNotMatch(buildContext("", undefined, { background: true }), /Held for the user's yes/);
assert.doesNotMatch(buildContext("Pell", undefined, { background: true }), /Held for the user's yes/);
// Three days on, they're let go.
assert.equal(heldWrites(new Date(Date.now() + 2 * 86_400_000)).length, 2, "still there after two days");
assert.equal(heldWrites(new Date(Date.now() + 3 * 86_400_000 + 60_000)).length, 0, "gone after three");
assert.equal((db.prepare("SELECT COUNT(*) n FROM profile_changes WHERE status = 'expired'").get() as { n: number }).n, 2);
assert.doesNotMatch(readUser(), /Ruvo Pell/, "never applied");

// 5. Stage 8.6: a value it looked up in a span table is never saved as a fact about the owner, not even when he says it
// back. A standing fact he tells it ("we're always N2", "I stock MGP10") is kept.
const a3 = say("assistant", "A 90x45 MGP10 rafter spans 2,700 at 600 centres, from Table 29, page 214.");
const u6 = say("user", "Right, so a 90x45 MGP10 rafter spans 2700 at 600 centres");
const d0 = dropped();
await pass({
  ...empty,
  about_user: [{ op: "add", section: "Work", text: "90x45 MGP10 rafters span 2,700 at 600 centres", evidence: [a3] }],
  details: [{ kind: "project", subject: "Rafters", fact: "A 90x45 MGP10 rafter spans 2700 at 600 centres", evidence: [u6] }],
});
assert.equal(dropped(), d0 + 2, "both dropped, even the one he said back");
assert.doesNotMatch(readUser(), /2,?700/);
assert.ok(!db.prepare("SELECT 1 FROM memories WHERE fact LIKE '%2700%'").get());
const u7 = say("user", "We're always N2 round here and I stock MGP10");
await pass({ ...empty, about_user: [{ op: "add", section: "Work", text: "Always N2 round here; stocks MGP10", evidence: [u7] }] });
assert.match(readUser(), /Always N2 round here; stocks MGP10/, readUser());

console.log("keeper trust: all passed");
