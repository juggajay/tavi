import "../isolate.js";
import assert from "node:assert/strict";
import { fakeAccountProtection } from "../fake-hermes.js";
import { createBot, getBot } from "../../src/hq/bots.js";
import { getSetting } from "../../src/store/proactive.js";
import { advanceWelcome, initializeWelcome, openFirstConversation, readWelcome, STEPS, welcomeState } from "../../src/hq/onboarding/setup.js";
import { onboardingAction, reviewTurn, conversationAction, reviewState } from "../../src/hq/onboarding/api.js";
import { readMap } from "../../src/hq/onboarding/map.js";
import { db } from "../../src/store/db.js";
import { audit } from "../../src/store/log.js";
import type { Hq } from "../../src/hq/hq.js";

fakeAccountProtection();
const bot = createBot({ id: "mira", name: "Mira" });
initializeWelcome(false);
assert.equal(readWelcome(), null, "An existing team has no welcome");
initializeWelcome(true);
assert.equal(readWelcome()?.step, "hello");
assert.throws(() => advanceWelcome("pin"));
assert.throws(() => advanceWelcome("hello", { skip: true }));
let signed = false, pin = false, computerCalls = 0, calls = 0;
const hq = {
  subscriptions: async () => [{ provider: "openai-codex", signedIn: signed }],
  botsChanged() {}, guard: { level: () => "open" },
  setComputer: async () => { computerCalls++; return { state: "ready" }; },
  ask: () => { calls++; return { job_id: "first-conversation" }; },
  members: () => [bot], turns: { live: () => ({ state: "idle", queued: 0 }) },
  stopBot() {},
} as unknown as Hq;
const next = (step: string, rest = {}) => onboardingAction(hq, { step, ...rest }, async () => pin);
await next("hello");
assert.equal(getSetting("finds.enabled"), "false", "Unasked looking waits for a yes");
assert.equal(readWelcome()?.step, "bot");
initializeWelcome(true);
assert.equal(readWelcome()?.step, "bot", "Returning keeps the same step");
await assert.rejects(next("bot", { name: "Mira", shape: "unknown", colour: "blue" }));
await next("bot", { name: "Mira", shape: "moon", colour: "blue" });
assert.equal(getBot(bot.id)?.look.shape, "moon");
await assert.rejects(next("subscription"));
assert.equal(readWelcome()?.step, "subscription");
signed = true; await next("subscription");
assert.equal(getBot(bot.id)?.primary.provider, "openai-codex");
assert.deepEqual(getBot(bot.id)?.fallbacks, [], "An unsigned subscription is not a fallback");
await assert.rejects(next("pin"));
pin = true; await next("pin");
for (const step of ["voice", "phone", "computer"] as const) await next(step, { skip: true });
assert.equal(computerCalls, 0);
assert.deepEqual(readWelcome()?.options, { voice: "skipped", phone: "skipped", computer: "skipped" });
assert.equal(readWelcome()?.step, "ready");
await next("ready"); await next("ready");
assert.equal(calls, 1, "The opening is accepted once across repeated requests");
assert.equal(readMap().status, "active");
assert.equal(openFirstConversation(() => { throw new Error("Must not run"); }).opened, false);
conversationAction(hq, { action: "pause" }); assert.equal(readMap().status, "paused");
conversationAction(hq, { action: "resume" }); assert.equal(readMap().status, "active");
assert.equal(welcomeState().welcome?.opened, true);
assert.deepEqual(STEPS, ["hello", "bot", "subscription", "pin", "voice", "phone", "computer", "ready"]);
const fingerprint = reviewState(hq).fingerprint;
await assert.rejects(reviewTurn(hq, { text: "get to know me better", test: false }));
audit("system", "call.start");
assert.equal(reviewState(hq).idle, false);
await assert.rejects(reviewTurn(hq, { text: "get to know me better", test: true }));
assert.equal(reviewState(hq).fingerprint, fingerprint);
console.log("Welcome order, return, required steps, optional skips, one opening, pause and review refusal passed.");
