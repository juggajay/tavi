import "../isolate.js"; // first
import assert from "node:assert/strict";
import { inWords } from "../../src/hq/turns/index.js";

// A bot's own words arrive a few letters at a time; the line shown is always whole words.
const said = { text: "" };
const seen: (string | null)[] = [];
for (const piece of ["I'm", " sett", "ing out the", " page now", ". The door", " closers", " come next"]) seen.push(inWords(said, piece));
assert.deepEqual(seen, [null, "I'm", "I'm setting out the", "I'm setting out the page", "The door", "The door", "The door closers come"]);
for (const line of seen) if (line) assert.ok(!/\b(sett|clos)$/.test(line), line);
// A line that arrives whole (a status from the engine) is shown whole.
assert.equal(inWords({ text: "" }, "Considering the plan"), "Considering the plan");
// Long thoughts are cut at a word.
const long = { text: "" };
const line = inWords(long, "word ".repeat(60))!;
assert.ok(line.length <= 111 && line.endsWith("…") && !/ …$/.test(line));
assert.equal(inWords({ text: "" }, "ok"), null, "too little to show");
console.log("hq-doing-words: the working line shows whole words and the sentence in progress");
