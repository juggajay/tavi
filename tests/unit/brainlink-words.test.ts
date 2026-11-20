// The gate rule (Stage 16), the safety-critical part: only the owner answers The Brain. What goes back is his own words
// from the turn he's having now, read from the conversation log, never the brain's text; nothing that could change his
// answer may be left out; a turn he didn't start (a routine, a background task, a test script) has no words of his.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { createJob } from "../../src/store/jobs.js";
import { logConversation } from "../../src/store/log.js";
import { excerpt, ownerLineFor, tokens } from "../../src/brainlink/words.js";

/* ---------- whose words: only his, only this turn ---------- */
const typed = createJob("ask", "typed", "x");
logConversation("user", "typed", "Tell it the external walls are 90 by 45, go on.", typed);
logConversation("assistant", "typed", "Sent.", typed);
assert.equal(ownerLineFor(typed)?.text, "Tell it the external walls are 90 by 45, go on.");
assert.equal(ownerLineFor(typed)?.channel, "typed");

const voice = createJob("ask", "voice", "x");
logConversation("user", "voice", "yeah go on", voice);
assert.equal(ownerLineFor(voice)?.text, "yeah go on");

const siri = createJob("ask", "siri", "x");
logConversation("user", "siri", "Go with seventy studs", siri);
assert.equal(ownerLineFor(siri)?.text, "Go with seventy studs");
const shared = createJob("ask", "siri", "x");
logConversation("user", "siri", "(shared something from another app)", shared);
assert.equal(ownerLineFor(shared), null, "Siri's stand-in for a share isn't his words");

const test = createJob("ask", "typed", "x");
logConversation("user", "test", "go on", test);
assert.equal(ownerLineFor(test), null, "a test script's line is never the owner");

const routine = createJob("routine", "rtn_1", "Morning brief");
logConversation("assistant", "proactive", "The Brain is waiting on you: 90 or 70 studs?", routine);
assert.equal(ownerLineFor(routine), null, "a routine has no words of his");
assert.equal(ownerLineFor(null), null, "no turn, no words");
assert.equal(ownerLineFor("job_doesnotexist"), null);

const other = createJob("ask", "typed", "x");
logConversation("user", "typed", "What's the weather tomorrow?", other);
assert.notEqual(ownerLineFor(other)?.text, ownerLineFor(typed)?.text, "each turn has only its own words");

/* ---------- what may be sent ---------- */
const ok = (said: string, pick?: string) => {
  const r = excerpt(said, pick);
  assert.ok(r.ok, `expected ok for "${pick}" from "${said}": ${!r.ok ? r.why : ""}`);
  return r.text;
};
const no = (said: string, pick?: string) => {
  const r = excerpt(said, pick);
  assert.ok(!r.ok, `expected a refusal for "${pick}" from "${said}"`);
  return r.why;
};

// All of it, exactly as he said it (the default).
assert.equal(ok("Go on."), "Go on.");
assert.equal(ok("  yeah go on  "), "yeah go on");
assert.equal(ok("Go on.", "go on"), "Go on.", "the whole of it, with his own punctuation");
// Words to the assistant at the start can go; the answer is cut from what he said, never from the brain's copy.
assert.equal(ok("Tell it the external walls are 90 by 45, go on.", "the external walls are 90 by 45, go on"), "the external walls are 90 by 45, go on.");
assert.equal(ok("tell the brain go with MGP10 at 450 centres", "GO WITH mgp10 at 450 centres"), "go with MGP10 at 450 centres", "his casing, not the brain's");
assert.equal(ok("Answer it: 4.2m lengths, 90x45.", "4.2m lengths, 90x45"), "4.2m lengths, 90x45.");
// A separate sentence at the end can be left off, if it has no doubt in it.
assert.equal(ok("Go with 90s. Also what's on tomorrow?", "go with 90s"), "Go with 90s.");
assert.equal(ok("Is the deck in? Go with 90s.", "go with 90s"), "Go with 90s.");

// Never his words? Refused.
assert.match(no("Go on.", "yes, go ahead"), /aren't his words/);
assert.match(no("What's the weather tomorrow?", "go on"), /aren't his words/);
assert.match(no("", "go on"), /hasn't said anything/);
assert.match(no("   "), /hasn't said anything/);
assert.match(no("Go on.", "!!!"), /aren't words he said/);
// A yes he didn't give: a negation left out before it, or after it.
assert.match(no("Don't go on yet.", "go on"), /could change his answer/);
assert.match(no("do not go on", "go on"), /could change his answer/);
assert.match(no("Yeah nah, go on", "go on"), /could change his answer/);
assert.match(no("No, go on", "go on"), /could change his answer/);
assert.match(no("Go on. Actually, wait.", "go on"), /could change his answer/);
assert.match(no("Go on. No hang on, use 70s.", "go on"), /could change his answer/);
assert.match(no("go on but use 70s", "go on"), /could change his answer/);
assert.match(no("Maybe go on", "go on"), /could change his answer/);
// Words in the middle of a sentence can't be cut off the end ("make it 90s" would be lost).
assert.match(no("Go on and make it 90s", "go on"), /cut his answer off/);
assert.match(no("90s on the externals, 70s inside", "90s on the externals"), /cut his answer off/);
// The pick must be a run of his words in order, not a reordering.
assert.match(no("go with 90s", "90s go with"), /aren't his words/);
assert.match(no("go with 90s", "go with 70s"), /aren't his words/);

// Tokens keep sizes whole.
assert.deepEqual(tokens("90x45 MGP10, 4.2m, don't, 1/2").map((t) => t.norm), ["90x45", "mgp10", "4.2m", "dont", "1/2"]);

console.log("brainlink-words: only his words, only this turn; nothing that could change his answer is left out");
