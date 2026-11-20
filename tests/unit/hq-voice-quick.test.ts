import "../isolate.js"; // first
import assert from "node:assert/strict";
import { ALOUD, quickChoice } from "../../src/hq/turns/index.js";

// A spoken turn thinks at medium at most; lower settings and other parts of the choice are left alone.
const high = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" } as const;
assert.deepEqual(quickChoice(high), { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" });
assert.equal(quickChoice({ ...high, effort: "xhigh" }).effort, "medium");
assert.equal(quickChoice({ ...high, effort: "medium" }).effort, "medium");
assert.equal(quickChoice({ ...high, effort: "low" }).effort, "low");
assert.equal(quickChoice({ provider: "openai-codex", model: "gpt-6.1-sol" }).effort, undefined);
assert.equal(high.effort, "high", "the bot's own setting is not changed");
// What it is told when read aloud: the answer first and short, the rest on screen.
for (const part of ["one or two short sentences", "on screen", "do not recap"]) assert.ok(ALOUD.includes(part), part);
console.log("hq-voice-quick: a spoken turn thinks at medium at most and is told to keep it short");
