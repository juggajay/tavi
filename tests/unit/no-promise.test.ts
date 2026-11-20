// No promise without a hand-over (Stage 18.2), with made-up scripted calls (the
// owner in these examples is "Nemi"). A promise, a refusal or a claim the voice makes by itself, or words only the brain
// may answer (naming it), with no hand-over within the wait: the brain gets his words once, told what the voice said.
// Harmless replies from the record start nothing, nor does the voice reading on with its answer after a noise of his; a
// real hand-over plus the backstop for the same words is one turn.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { db } from "../../src/store/db.js";
import { VoiceCall, type HandOver } from "../../src/gateway/voiceCall.js";
import { startsTable } from "../../src/guest/chair.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ACT = 60;
const WAIT = 90;

function setup(o: { table?: boolean; echo?: (t: string) => boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const asked: HandOver[] = [];
  const state = { table: !!o.table };
  const call = new VoiceCall({
    answer: async (t) => {
      asked.push(t);
      await sleep(20);
      // the round table says its own lines: a quiet close; anything else, the brain's answer
      return state.table || t.by === "table-start" ? { silent: "(round table)" } : { spoken: `Answer to: ${t.utterance}` };
    },
    table: () => state.table,
    startsTable: (text) => !state.table && startsTable(text, "Tim"),
    guest: () => "Tim",
    echo: (text) => o.echo?.(text) ?? false,
    actMs: ACT,
    promiseWaitMs: WAIT,
    settleMs: 10,
    lateMs: 100,
    lineIdleMs: 50,
  });
  call.attach({ send: (e) => (sent.push(e), `ev_${sent.length}`) }, "sess_acts");
  let t = 1000;
  /** He says it (the words land now); the voice may say something of its own a moment later. */
  const owner = (text: string) => {
    const start = (t += 2000);
    call.onEvent({ type: "session.input_transcript.delta", delta: text, start_ms: start, end_ms: (t += 900) });
  };
  const voice = (text: string) => call.onEvent({ type: "session.output_transcript.delta", delta: text, start_ms: (t += 300), end_ms: (t += 600) });
  const handOver = (id: string) => call.onEvent({ type: "session.delegation.created", delegation: { id }, offset_ms: (t += 200) });
  const spoken = () => sent.filter((e) => e.type === "session.commentary.append");
  return { call, sent, asked, state, owner, voice, handOver, spoken };
}
type Row = { event: string; ref: string | null; d: Record<string, unknown> };
const rows = (event: string): Row[] =>
  (db.prepare("SELECT event, ref, detail FROM audit_log WHERE event = ? ORDER BY id").all(event) as { event: string; ref: string | null; detail: string }[]).map((r) => ({ ...r, d: JSON.parse(r.detail) }));
const clear = () => db.exec("DELETE FROM audit_log");

/* ---------------- 18.2: no promise without a hand-over ---------------- */

// The voice answers by itself, and no hand-over comes: the brain gets his words once, told what the voice said, and its
// answer goes to the voice for the session (there's no hand-over to answer).
for (const [said, reply, by] of [
  ["Just call yourself Shadrach please", "I can't do that. If you wanna name me, it's your call. What's on your mind?", "naming"],
  ["And they're what?", "Sorry, let me check that.", "promise"],
  ["Can you pull up the door schedule there, will ya", "Sure, one sec.", "promise"],
  ["Can it make PDFs?", "I'm not able to do that from here.", "claim"],
] as const) {
  clear();
  const s = setup();
  s.owner(said);
  s.voice(reply);
  await sleep(WAIT / 2);
  assert.equal(s.asked.length, 0, "a hand-over still has a moment to come");
  await sleep(WAIT + 150);
  assert.equal(s.asked.length, 1, `one brain turn for "${said}"`);
  assert.equal(s.asked[0].by, by);
  assert.equal(s.asked[0].utterance, said);
  assert.equal(s.asked[0].voiceSaid, reply, "the brain is told what the voice said");
  assert.equal(s.spoken().length, 1);
  assert.equal(s.spoken()[0].delegation_id, null, "said for the session as a whole");
  assert.equal(s.spoken()[0].content, `Answer to: ${said}`);
  assert.equal(rows("heard").filter((r) => r.d.text === said).length, 1, "his words are in the record once");
  assert.equal(rows("heard")[0].d.handed, true);
  s.call.end();
}

// None of the harmless replies from the record start a turn (and nor does the voice reading on with its answer after a
// noise of his).
{
  clear();
  const s = setup();
  for (const [said, reply] of [
    ["Okay cool", "You're welcome, Sam."],
    ["uh, Give me a sec. Read this", "Take your time."],
    ["Hey", "Morning, Sam."],
    ["No, stop", "Okay."],
    ["Hello, hear", "Yep, I'm here."],
    ["No, it worked. I can see it now", "Good, if that's the right one."],
    ["No, no. No, all good. Thank you", "Right."],
    ["[lip smack ]Okay, one second", "Sure."],
  ]) {
    s.owner(said);
    s.voice(reply);
    await sleep(WAIT + 120);
  }
  assert.equal(s.asked.length, 0, `no turns: ${s.asked.map((a) => a.utterance).join(" | ")}`);
  // a real hand-over, its answer read out, then a noise of his and the voice reading on: still its answer, not its own
  s.owner("Can you write code?");
  s.handOver("item_code");
  await sleep(120);
  assert.equal(s.asked.length, 1);
  s.voice("Answer to: Can you write code?");
  await sleep(80);
  s.owner("[tongue click");
  s.voice("Not in here, no. I can't write or run code for you.");
  await sleep(WAIT + 150);
  assert.equal(s.asked.length, 1, "the voice reading on isn't a refusal of its own");
  s.call.end();
}

// A real hand-over plus the backstop for the same words: one turn. (a) The hand-over comes just after the voice's "One
// sec." (as in Stage 10's scripted call); (b) it comes after the gateway has already sent his words on.
{
  clear();
  const s = setup();
  s.owner("How wide is door seven?");
  s.voice("One sec.");
  await sleep(10);
  s.handOver("item_d7");
  await sleep(WAIT + 200);
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0].delegationId, "item_d7", "the hand-over's");
  assert.equal(s.spoken().length, 1);
  assert.equal(s.spoken()[0].delegation_id, "item_d7");
  s.call.end();
}
{
  clear();
  const s = setup();
  s.owner("Has Ruvo sent the sizes?");
  s.voice("Checking now.");
  await sleep(WAIT + 100);
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0].by, "promise");
  s.handOver("item_pat");
  await sleep(300);
  assert.equal(s.asked.length, 1, "the late hand-over found nothing new");
  assert.equal(rows("ignored_repeat").at(-1)!.ref, "item_pat");
  assert.equal(s.spoken().length, 1, "one answer");
  s.call.end();
}

console.log("no-promise: ok");
