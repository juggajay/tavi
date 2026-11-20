// A voice call fed a scripted run of live events (Stage 10.1): what the owner and the voice said, the hand-over and the
// answer are written to audit_log in the order they happened, each voice line tagged with its hand-over and whether it
// came before or after the answer. No voice service, no brain.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { db } from "../../src/store/db.js";
import { VoiceCall } from "../../src/gateway/voiceCall.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, why: string) => {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await sleep(5);
  assert.ok(check(), why);
};
type Row = { actor: string; event: string; ref: string | null; d: Record<string, unknown> };
const rows = (): Row[] =>
  (db.prepare("SELECT actor, event, ref, detail FROM audit_log WHERE actor IN ('voice','user') ORDER BY id").all() as { actor: string; event: string; ref: string | null; detail: string | null }[]).map((r) => ({
    ...r,
    d: r.detail ? JSON.parse(r.detail) : {},
  }));

const sent: Record<string, unknown>[] = [];
const sb = { send: (e: Record<string, unknown>) => (sent.push(e), `ev_${sent.length}`) };
const asked: string[] = [];
const call = new VoiceCall({
  answer: async ({ utterance }) => {
    asked.push(utterance);
    await sleep(40);
    return { spoken: "Door 7 is 720 wide." };
  },
  settleMs: 10,
  lineIdleMs: 60,
});
call.attach(sb, "sess_test");

// The owner: "how wide is door seven"; the voice: "One sec."; the hand-over; then the answer read out.
const ev = (type: string, more: Record<string, unknown>) => call.onEvent({ type, ...more });
ev("session.input_transcript.delta", { delta: "How wide is", start_ms: 1000, end_ms: 1400 });
ev("session.input_transcript.delta", { delta: " door seven?", start_ms: 1400, end_ms: 1900 });
ev("session.output_transcript.delta", { delta: "One sec.", start_ms: 2300, end_ms: 2700 });
ev("session.delegation.created", { delegation: { id: "item_d1" }, offset_ms: 2200 });
await until(() => sent.some(e => e.type === "session.commentary.append"), "the answer reaches the voice");
const commentary = sent.find((e) => e.type === "session.commentary.append");
assert.ok(commentary, "the answer went to the voice");
assert.equal(commentary!.content, "Door 7 is 720 wide.");
assert.equal(commentary!.delegation_id, "item_d1");
assert.ok(!sent.some((e) => e.type === "session.thinking.append"), "nothing cancels the automatic acknowledgement (it's the one acknowledgement)");
assert.deepEqual(asked, ["How wide is door seven?"]);
// the service's receipt for the answer, then the voice reading it
ev("session.commentary.appended", { client_event_id: "ev_1", start_ms: 4200, end_ms: 4300 });
ev("session.output_transcript.delta", { delta: "Door 7 is ", start_ms: 4400, end_ms: 4900 });
ev("session.output_transcript.delta", { delta: "720 wide.", start_ms: 4900, end_ms: 5600 });
await sleep(100); // the line goes quiet: it's finished

// Then small talk the voice answers itself.
ev("session.input_transcript.delta", { delta: "Thanks.", start_ms: 7000, end_ms: 7400 });
ev("session.output_transcript.delta", { delta: "No worries.", start_ms: 7800, end_ms: 8300 });
call.end({ seconds: 9 }, "hung up");

const got = rows();
const shape = got.map((r) => `${r.actor} ${r.event}${r.event === "said" ? ` ${r.d.when ?? "-"} ${r.d.text}` : r.event === "heard" ? ` ${r.d.text}` : ""}`);
// (written in this order; the trace script puts them in timeline order by at_ms)
assert.deepEqual(shape, [
  "voice call.start",
  "user heard How wide is door seven?",
  "voice delegation",
  "voice said before One sec.",
  "voice commentary",
  "voice answered",
  "voice appended",
  "voice said after Door 7 is 720 wide.",
  "user heard Thanks.",
  "voice said - No worries.",
  "voice call.end",
]);
const said = got.filter((r) => r.event === "said");
assert.equal(said[0].ref, "item_d1", "the acknowledgement belongs to the hand-over");
assert.equal(said[1].ref, "item_d1", "and so does the answer read out");
assert.equal(said[2].ref, null, "small talk belongs to no hand-over");
const heard = got.filter((r) => r.event === "heard");
assert.equal(heard[0].d.handed, true);
assert.equal(heard[1].d.handed, false);
const del = got.find((r) => r.event === "delegation")!;
assert.equal(del.d.new_words, true);
const com = got.find((r) => r.event === "commentary")!;
assert.equal(com.d.chars, "Door 7 is 720 wide.".length);
assert.equal(typeof com.d.ms, "number");
assert.ok((com.d.ms as number) >= 40, "ms since the hand-over");
assert.equal(got.at(-1)!.d.reason, "hung up");
assert.deepEqual(got.at(-1)!.d.usage, { seconds: 9 });
// every row has a place on the call's timeline, in order
const at = got.filter((r) => r.event !== "call.end").map((r) => r.d.at_ms as number);
assert.ok(at.every((x) => typeof x === "number"), "every row has at_ms");
assert.equal(said[1].d.start_ms, 4400);

// Nothing about the call went into the conversation thread except the hand-over's words (the thread is as it was).
const thread = db.prepare("SELECT role, channel, text FROM conversation_log ORDER BY id").all().map((r) => ({ ...r }));
assert.deepEqual(thread, [{ role: "user", channel: "voice", text: "How wide is door seven?" }]);

// A second call: the hand-over comes first and the voice says nothing; the owner keeps talking while it waits. The
// answer read out is still that hand-over's (seen in the first live run: it was put down as small talk).
db.exec("DELETE FROM audit_log");
call.attach(sb, "sess_test2");
ev("session.input_transcript.delta", { delta: "I help at a club.", start_ms: 1000, end_ms: 1800 });
ev("session.delegation.created", { delegation: { id: "item_d2" }, offset_ms: 2000 });
await sleep(30);
ev("session.input_transcript.delta", { delta: " I run a small business.", start_ms: 2600, end_ms: 4000 });
await sleep(60); // answered
ev("session.output_transcript.delta", { delta: "Good trade.", start_ms: 4500, end_ms: 5000 });
call.end();
const two = rows().filter((r) => r.event === "said");
assert.equal(two.length, 1);
assert.equal(two[0].ref, "item_d2");
assert.equal(two[0].d.when, "after");
assert.equal(rows().filter((r) => r.event === "delegation")[0].d.new_words, true);

console.log("voice-call: ok");
