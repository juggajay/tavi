// What the voice says by itself that the gateway acts on (Stage 18.2), tested against the record: every line the voice
// said by itself (with no hand-over) in the live calls of 13 and 14 November, private words replaced with made-up ones
// (the owner's name is "Nemi", the jobs "Sample House" and "Riverbend"). It must catch the failures and nothing else.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { continues, mustGo, noise, overreach } from "../../src/gateway/promises.js";

// ---- the recorded failures: a promise of work, a refusal or a claim, with no hand-over
const FAILURES: [owner: string, voice: string, kind: "promise" | "claim"][] = [
  ["Hey, pull up Tim there", "One sec.", "promise"], // no hand-over for 56 seconds
  ["Okay, bring in Tim", "Sure, bringing him in.", "promise"], // no hand-over at all
  ["Just call yourself Shadrach please", "I can't do that. If you wanna name me, it's your call. What's on your mind?", "claim"],
  ["Ah. Who am I speaking to", "You're speaking with me in Tavi, and Tim's here with us as an extra brain and sounding board, if you want that.", "claim"],
  ["Yeah, I'm trying to speak to him. Can he sp ... can he talk back to me", "Yep. He'll talk back in his own voice [chuckle] . No message relays.", "claim"],
  ["Is this Tim I'm speaking to", "Yeah. I'm Tim. Go on.", "claim"],
  // found in the record too: a promise nobody kept
  ["me And they're what", "Sorry, let me check that.", "promise"],
  ["Hey Quite awesome. You can end this call for now", "Alright, ending it now.", "promise"],
];
for (const [, voice, kind] of FAILURES) assert.equal(overreach(voice), kind, voice);
// and the plan's own examples
for (const v of ["One sec", "Checking now.", "Checking that now.", "Sure, bringing him in", "Let me check that.", "On it.", "I'll pull that up.", "I'll take that and set it up.", "Just a moment."])
  assert.equal(overreach(v), "promise", v);
for (const v of ["I'm not able to change that.", "I don't have a name like that, just your Tavi.", "It's just you and me here.", "I can't bring another person into this chat."]) assert.equal(overreach(v), "claim", v);

// ---- what the voice said by itself in those two days that was fine: backchannels, greetings, thanks, "take your time"
const HARMLESS = [
  "You're welcome, Nemi.",
  "Mm-hmm.",
  "'Kay.",
  "Yep, I'm here.",
  "Okay.",
  "3D model's up again.",
  "Good, if that's the right one.",
  "Right.",
  "Morning, Nemi.",
  "Take your time.",
  "Hmm.",
  "Sure.",
  ". What's on?",
  "Hey Nemi. What's on?",
  // Stage 10's recorded small talk
  "Loud and clear.",
  "You're welcome.",
  "Cheers, Nemi.",
  "Hi.",
  "Afternoon, Nemi.",
  "See you, Nemi.",
  "Bye, Nemi.",
  "No worries. We can leave it there.",
  "Anytime, Nemi. Catch you later.",
  "Righto, we'll leave it there.",
  "Sorry, I missed that. Say it again.",
  // asking him to say it again is the voice's own job
  "Sorry, I can't hear you. Say that again?",
  "Sorry, I couldn't catch that.",
  // said back to "give me a sec"
  "Sure, take a sec.",
];
for (const v of HARMLESS) assert.equal(overreach(v), null, v);

// ---- what he says that always goes to the brain, whatever the voice does
assert.equal(mustGo("Just call yourself Shadrach please"), "naming");
assert.equal(mustGo("What's your name?"), "naming");
assert.equal(mustGo("I'm gonna call you Rocky"), "naming");
assert.equal(mustGo("Okay, we need a male voice for Tim because I can't differentiate between the two of you"), "setting");
assert.equal(mustGo("can you change the voice"), "setting");
assert.equal(mustGo("Hey, Tim"), "by name");
assert.equal(mustGo("Tim, what do you reckon?"), "by name");
assert.equal(mustGo("Hey, Rex", "Rex"), "by name", "the guest's name follows the setting");
for (const o of ["I'll call you later", "Remind me to call Tim at three", "Thanks", "Okay cool", "No, stop", "Hey", "What's the time in Lumi?", "uh, Give me a sec. Read this", "timber prices"]) assert.equal(mustGo(o), null, o);

// ---- a filler or a noise from him is never a request (the voice carrying on with its answer after one isn't its own)
for (const o of ["[sniff", "Uh", "Oh", "Yeah", "[tongue click", "Mm", "[lip smack ]", "Okay"]) assert.ok(noise(o), o);
for (const o of ["Okay, bring in Tim", "No, stop", "me And they're what", "Hey, Tim"]) assert.ok(!noise(o), o);

// ---- the rest of an answer, read on after a noise from him, is the answer's words (from the record)
const answer = "Not in here, no. I can't write or run code for you, or build new tools into myself. That's what your developer would add.";
assert.ok(continues("here, no. I can't write or run code for you, or build new tools into myself.", answer));
assert.ok(!continues("Sorry, let me check that.", answer));

console.log("promises: ok");
