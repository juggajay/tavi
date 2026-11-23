// A bare hello on a call is answered at once; anything more than a greeting is left to the bots.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { bareGreeting } from "../../src/gateway/greeting.js";

// Only a greeting: answered at once.
for (const said of ["Hello", "Hello?", "hey", "Hi there.", "Hello, hello?", "Are you there?", "Hello, are you there?", "Can you hear me?", "Hey, can you hear me now?", "You there?", "Is anyone there?", "Testing", "Testing, one two three", "G'day", "Hello Mira", "Hey Mira, are you there?", "Mira?", "Mira, hello"])
  assert.equal(bareGreeting(said, "Mira"), "I'm here.", said);

// The time of day comes back as it was said.
assert.equal(bareGreeting("Good morning", "Mira"), "Morning.");
assert.equal(bareGreeting("Morning, Mira."), null, "a name it wasn't told about is not part of a greeting");
assert.equal(bareGreeting("Morning, Mira.", "Mira"), "Morning.");
assert.equal(bareGreeting("Hello, good afternoon"), "Afternoon.");
assert.equal(bareGreeting("Good evening."), "Evening.");

// Anything more than a greeting, another bot's name, or nothing at all: left to the bots.
for (const said of ["", "   ", "Hello, how did the search go?", "Hey, what's on today?", "Hello Ruvo", "Can you hear the music?", "Are you there yet with that page?", "How are you?", "Good morning, what's the weather?", "Test the new page", "Hi, it's me again, quick question", "yes", "okay", "Mira, show me the page"])
  assert.equal(bareGreeting(said, "Mira"), null, said);

console.log("voice-greeting: a bare hello is answered at once, and anything more goes to the bots");
