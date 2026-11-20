// One mind (Stage 21.1, replacing Stage 10.4's two brains and their word-matching). Every request goes to the same
// session, whatever the words: "is it going to rain" isn't sent to the careful brain because "going" looks like a stair
// word, and "redesign it with a better one" isn't sent to the quick one because it has no trade word. The setting picks
// the model and how deep it may go: Balanced is Opus with adaptive thinking at medium effort (its work at high), Best the same at xhigh,
// Quick is Haiku at low (its background work on Sonnet). Sessions are stubbed.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import * as brain from "../../src/brain/brain.js";
import { askMind, brainInfo, brainModels, cleanSpoken, workLimits, workModel, type BrainResult } from "../../src/brain/brain.js";
import { getSettings, updateSettings } from "../../src/store/settings.js";

const mode = (m: "fast" | "balanced" | "best") => updateSettings({ "brain.mode": m }, "local");

/* ---------- no word-matching left to choose a brain ---------- */
assert.ok(!("chooseBrain" in brain) && !("routeThink" in brain), "nothing picks a model by matching his words");
await assert.rejects(import("../../src/brain/routing.js" as string), "the word lists are gone");

/* ---------- the models under each setting ---------- */
mode("balanced");
assert.deepEqual(brainModels(), { mind: "claude-opus-5-5", effort: "medium", work: "claude-opus-5-5", work_effort: "high", routine: "claude-opus-5-5" }, "balanced: one Opus mind at medium effort (adaptive), its work at high, routines on Opus too");
assert.equal(brainInfo.model, "claude-opus-5-5");
assert.equal(workModel("claude-sonnet-5-5"), "claude-sonnet-5-5", "web jobs in its browser stay on Sonnet (unchanged)");
mode("best");
assert.deepEqual(brainModels(), { mind: "claude-opus-5-5", effort: "xhigh", work: "claude-opus-5-5", work_effort: "xhigh", routine: "claude-opus-5-5" }, "best: the same mind, deeper");
assert.equal(workModel("claude-sonnet-5-5"), "claude-opus-5-5", "and web jobs on Opus, as before");
mode("fast");
assert.deepEqual(brainModels(), { mind: "claude-haiku-5-5", effort: "low", work: "claude-sonnet-5-5", work_effort: "medium", routine: "claude-haiku-5-5" }, "quick: speed over depth");
assert.equal(brainInfo.model, "claude-haiku-5-5");
// the environment overrides still win
process.env.BRAIN_MODEL = "model-a";
process.env.BRAIN_MODEL_STRONG = "model-b";
mode("balanced");
assert.equal(brainModels().mind, "model-a");
assert.equal(brainModels().work, "model-b");
delete process.env.BRAIN_MODEL;
delete process.env.BRAIN_MODEL_STRONG;

/* ---------- room to work: the most one piece of work may take and use is a setting ---------- */
assert.deepEqual(workLimits(), { ms: 30 * 60_000, usd: 6 }, "defaults: half an hour, US$6 of plan usage");
updateSettings({ "work.max_minutes": 45, "work.max_usd": 10 }, "local");
assert.deepEqual(workLimits(), { ms: 45 * 60_000, usd: 10 });
assert.throws(() => updateSettings({ "work.max_minutes": 1 }, "local"), /Bad value/, "not so low it cuts ordinary work short");
assert.throws(() => updateSettings({ "work.max_usd": 0 }, "remote"), /only be changed on the PC/, "and only on the PC");
assert.equal(getSettings()["work.max_minutes"], 45);

/* ---------- every request goes to the one session, as asked ---------- */
mode("balanced");
const calls: string[] = [];
const mind = {
  think: async (request: string) => {
    calls.push(request);
    return { spoken: "Okay, it's the mind's answer.", ms: 1 } as BrainResult;
  },
};
const PHRASES = [
  // what Stage 10.4 sent to the careful brain
  "think harder about the doors",
  "What size rafter do I need to span three point six metres?",
  "put up the ground floor plan",
  "show me a mortise and tenon in 3D",
  // and to the talking brain
  "what's the time in Lumi?",
  "remind me to ring the certifier at two tomorrow",
  "I mostly do decks and pergolas, some framing",
  // the 21.0 replay's misfires, both ways
  "How's your arvo going?",
  "Is it going to rain tomorrow?",
  "No, it needs to be sound for the downward force",
  "Redesign it with a better one",
];
for (const p of PHRASES) {
  const r = await askMind(mind, `Context...\nThe user typed: "${p}"`, { said: p });
  assert.equal(r.spoken, "Okay, it's the mind's answer.", "typed answers are untouched");
}
assert.equal(calls.length, PHRASES.length, "one session answered every one, once");
assert.ok(calls.every((c, i) => c === `Context...\nThe user typed: "${PHRASES[i]}"`), "nothing added to the request: no closer-look note, no pass-up");
// a voice turn still loses a stock opening (the voice already said its "okay")
const v = await askMind(mind, "x", { said: "what's the time in Lumi?", voice: true });
assert.equal(v.spoken, "It's the mind's answer.");

// Markup the model leaks into its answer never reaches the voice.
assert.equal(cleanSpoken("I've put them on screen with map links.</spoken>\n</invoke>"), "I've put them on screen with map links.");
assert.equal(cleanSpoken('<parameter name="spoken">Door 7 is 720 wide.'), "Door 7 is 720 wide.");
assert.equal(cleanSpoken("Use a 90 < 100 mm stud."), "Use a 90 < 100 mm stud.", "ordinary text is left alone");

console.log("brain-mind: ok");
