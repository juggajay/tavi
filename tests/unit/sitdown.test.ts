// Stage 7.3: the sit-down's state machine. Offered once (after three things said), again at least two days later, never a
// third time; "later" and silence both leave it at "offered"; asking for it starts it from any state except when it's on.
import "../isolate.js"; // first: a private, throwaway data folder
import assert from "node:assert/strict";
import { db, nowIso } from "../../src/store/db.js";
import { getSitdown, moveSitdown, sitdownBusy, sitdownNote, OFFER_MARK, JUST_OFFERED_MARK } from "../../src/memory/sitdown.js";
import { buildContext } from "../../src/brain/context.js";
import { voiceInstructions, SITDOWN_VOICE_LINE } from "../../src/gateway/live.js";
import { bus } from "../../src/events.js";

const DAY = 86_400_000;
const say = (text: string) => db.prepare("INSERT INTO conversation_log (ts, role, channel, text) VALUES (?, 'user', 'voice', ?)").run(nowIso(), text);
const reset = () => db.prepare("DELETE FROM settings WHERE key = 'sitdown'").run();
const at = (ms: number) => new Date(Date.now() + ms);
const throws = (fn: () => unknown) => assert.throws(fn);

// Not offered before they've said three things.
assert.equal(getSitdown().status, "not_offered");
say("What's on today?");
say("Righto.");
assert.equal(sitdownNote(), null, "too early");
say("Can you remind me about the pump?");
assert.ok(sitdownNote()?.startsWith(OFFER_MARK), "offer due after three things");
assert.match(buildContext("hello"), /Sit-down offer:/, "the Context carries it");
assert.doesNotMatch(buildContext("hello"), /Getting to know them/, "instead of the everyday note");
assert.doesNotMatch(buildContext("", undefined, { background: true }), /Sit-down/, "never in the background");

// Offered. Right after, the Context says how to take the answer.
moveSitdown({ status: "offered" });
assert.equal(getSitdown().offers, 1);
assert.ok(sitdownNote()?.startsWith(JUST_OFFERED_MARK));
// "Later" (or no answer) leaves it at offered: nothing more for two days, and no everyday questions meanwhile.
assert.equal(sitdownNote(at(3 * 3600_000)), null, "quiet after the offer");
assert.equal(sitdownNote(at(DAY)), null, "not again within two days");
assert.ok(sitdownBusy(at(DAY)), "no other questions while the second offer is to come");
// Two days later: once more, and the note says it's the last time.
const second = sitdownNote(at(2 * DAY + 60_000));
assert.ok(second?.startsWith(OFFER_MARK) && /last time/.test(second), second ?? "");
moveSitdown({ status: "offered" }, at(2 * DAY + 60_000));
assert.equal(getSitdown().offers, 2);
// Never a third time.
assert.equal(sitdownNote(at(10 * DAY)), null, "never a third offer");
assert.ok(!sitdownBusy(at(10 * DAY)), "everyday questions carry on");
moveSitdown({ status: "offered" }, at(10 * DAY));
assert.equal(getSitdown().offers, 2, "offering again changes nothing");

// "No" declines.
reset();
moveSitdown({ status: "offered" });
moveSitdown({ status: "declined" });
assert.equal(getSitdown().status, "declined");
assert.equal(sitdownNote(at(5 * DAY)), null);

// Asking for it starts it from any state except when it's already on.
const events: string[] = [];
bus.on("sitdown", (e) => events.push(`${e.was}>${e.status}`));
for (const from of ["not_offered", "offered", "done", "declined"]) {
  reset();
  if (from !== "not_offered") moveSitdown({ status: "offered" });
  if (from === "done") (moveSitdown({ status: "in_progress" }), moveSitdown({ status: "done" }));
  if (from === "declined") moveSitdown({ status: "declined" });
  assert.equal(getSitdown().status, from);
  moveSitdown({ status: "in_progress" });
  assert.equal(getSitdown().status, "in_progress", `starts from ${from}`);
}
throws(() => moveSitdown({ status: "in_progress" }));

// While it's on: the rules are in the Context, covered topics build up, and the voice hands everything over.
moveSitdown({ covered: ["what to call them"] });
moveSitdown({ covered: ["work", "What to call them"] });
assert.deepEqual(getSitdown().covered, ["what to call them", "work"]);
const ctx = buildContext("I help at a local club");
assert.match(ctx, /The sit-down is ON/);
assert.match(ctx, /Covered so far: what to call them, work/);
assert.ok(voiceInstructions().includes(SITDOWN_VOICE_LINE), "voice delegates everything while it's on");
moveSitdown({ status: "done" });
assert.equal(getSitdown().status, "done");
assert.ok(getSitdown().ended_at);
assert.ok(!voiceInstructions().includes(SITDOWN_VOICE_LINE), "and stops when it ends");
assert.ok(events.includes("in_progress>done"));
assert.equal(moveSitdown({ status: "done" }).status, "done", "saying done twice changes nothing");
throws(() => moveSitdown({ status: "declined" }));
throws(() => moveSitdown({ status: "offered" }));

console.log("sitdown: all passed");
