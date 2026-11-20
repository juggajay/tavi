// Never answer the same thing twice (Stage 10.3). A hand-over with no new words while the last one is still being
// answered (or was answered under 30 seconds ago) is closed quietly, not run again from the last thing said. A first
// hand-over whose words come late still works; a real second question is answered; a correction while the first is
// still running replaces it (one answer, for both). Scripted calls, a stand-in brain, a clock the test moves.
//
// Steady under load (Stage 21): it waits for what it's checking to have happened (the answer sent, the repeat closed)
// instead of sleeping a fixed time and hoping, and the stand-in brain answers when the test lets it, so "still being
// answered" and "already answered" are exactly that. The filler is off here (the stream-voice test covers it): under a
// heavy load a real 6 s could pass and its "Still on it." would be counted as an answer.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { db } from "../../src/store/db.js";
import { VoiceCall } from "../../src/gateway/voiceCall.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, what: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (ok()) return;
  throw new Error(`timed out waiting for: ${what}`);
};
let clock = 1_000_000;
type Asked = { utterance: string; corrects?: string; jobId: string };

/** held: the stand-in brain answers only when release() is called (or the turn is stopped). */
function setup(o: { held?: boolean; lateMs?: number } = {}) {
  const sent: Record<string, unknown>[] = [];
  const asked: Asked[] = [];
  const cancelled: string[] = [];
  let open: () => void = () => {};
  const gate = o.held ? new Promise<void>((r) => (open = r)) : Promise.resolve();
  const call = new VoiceCall({
    answer: async (t) => {
      asked.push({ utterance: t.utterance, corrects: t.corrects, jobId: t.jobId });
      const stopped = new Promise<void>((r) => t.signal?.addEventListener("abort", () => r()));
      await Promise.race([gate, stopped]);
      if (t.signal?.aborted) return null;
      return { spoken: `Answer to: ${t.utterance}` };
    },
    cancel: (jobId) => cancelled.push(jobId),
    now: () => clock,
    settleMs: 10,
    lateMs: o.lateMs ?? 150,
    lineIdleMs: 50,
    fillerMs: 0,
  });
  call.attach({ send: (e) => (sent.push(e), `ev_${sent.length}`) });
  const answers = () => sent.filter((e) => e.type === "session.commentary.append");
  const ev = (type: string, more: Record<string, unknown>) => call.onEvent({ type, ...more });
  return { call, sent, asked, cancelled, answers, ev, release: () => open() };
}
const audits = (event: string) => db.prepare("SELECT ref, detail FROM audit_log WHERE actor = 'voice' AND event = ? ORDER BY id").all(event) as { ref: string; detail: string }[];
const ignored = (ref: string) => audits("ignored_repeat").some((a) => a.ref === ref);

// 1. Two hand-overs 10 s apart, the second with no new words: one brain turn, one spoken answer.
{
  const { call, asked, answers, ev } = setup();
  ev("session.input_transcript.delta", { delta: "When does the dining credit expire?", start_ms: 1000, end_ms: 2600 });
  ev("session.delegation.created", { delegation: { id: "item_a" }, offset_ms: 2800 });
  await until(() => answers().length === 1, "the first answer");
  clock += 10_000;
  ev("session.delegation.created", { delegation: { id: "item_b" }, offset_ms: 12_800 });
  await until(() => ignored("item_b"), "the repeat closed");
  assert.equal(asked.length, 1, "one brain turn");
  assert.equal(answers().length, 1, "one spoken answer");
  assert.equal(answers()[0].delegation_id, "item_a");
  const ig = audits("ignored_repeat");
  assert.equal(ig.length, 1);
  assert.equal(ig[0].ref, "item_b");
  assert.equal(JSON.parse(ig[0].detail).previous, "item_a");
  call.end();
}

// ...and the same while the first is still being worked on (the brain hasn't answered yet): still one of each.
{
  const { call, asked, answers, sent, ev, release } = setup({ held: true });
  ev("session.input_transcript.delta", { delta: "What's in the door schedule?", start_ms: 1000, end_ms: 2000 });
  ev("session.delegation.created", { delegation: { id: "item_c" }, offset_ms: 2200 });
  await until(() => asked.length === 1, "the first turn under way");
  clock += 3_000;
  ev("session.delegation.created", { delegation: { id: "item_d" }, offset_ms: 5200 });
  await until(() => ignored("item_d"), "the repeat closed while the first was still being answered");
  assert.equal(answers().length, 0, "the first still being answered");
  release();
  await until(() => answers().length === 1, "the first answer");
  assert.equal(asked.length, 1);
  assert.equal(answers()[0].delegation_id, "item_c");
  // the repeat hand-over is closed quietly: a silent note for it, never something to say
  assert.ok(sent.some((e) => e.type === "session.thinking.append" && e.delegation_id === "item_d" && String(e.content).length > 0));
  assert.ok(!sent.some((e) => e.type === "session.commentary.append" && e.delegation_id === "item_d"));
  call.end();
}

// 2. A first hand-over whose words come late (after the hand-over itself) still works.
{
  const { call, asked, answers, ev } = setup({ lateMs: 3000 });
  ev("session.delegation.created", { delegation: { id: "item_e" }, offset_ms: 2200 });
  await sleep(60); // past the settle, the words still not here
  ev("session.input_transcript.delta", { delta: "Put up the ground floor plan.", start_ms: 900, end_ms: 2100 });
  await until(() => answers().length === 1, "the answer");
  assert.deepEqual(asked.map((a) => a.utterance), ["Put up the ground floor plan."]);
  const d = audits("delegation").at(-1)!;
  assert.equal(JSON.parse(d.detail).new_words, true);
  call.end();
}

// ...and when they never come in time, the fallback to the last thing said still answers it (it wasn't handed over before).
{
  const { call, asked, ev } = setup();
  ev("session.input_transcript.delta", { delta: "Has Ruvo sent the sizes?", start_ms: 900, end_ms: 2000 });
  ev("session.output_transcript.delta", { delta: "One sec.", start_ms: 2300, end_ms: 2700 });
  await sleep(120); // the voice's line finishes before its hand-over arrives (it's finished after 50 ms quiet)
  ev("session.delegation.created", { delegation: { id: "item_f" }, offset_ms: 2600 });
  await until(() => asked.length === 1, "the turn");
  assert.deepEqual(asked.map((a) => a.utterance), ["Has Ruvo sent the sizes?"]);
  call.end();
}

// 3. A real second question 10 s later is answered.
{
  const { call, asked, answers, ev } = setup();
  ev("session.input_transcript.delta", { delta: "What's the time in Lumi?", start_ms: 1000, end_ms: 2000 });
  ev("session.delegation.created", { delegation: { id: "item_g" }, offset_ms: 2200 });
  await until(() => answers().length === 1, "the first answer");
  ev("session.output_transcript.delta", { delta: "Answer to: What's the time in Lumi?", start_ms: 3000, end_ms: 5000 });
  await until(() => audits("said").some((a) => a.ref === "item_g"), "the answer read out");
  clock += 10_000;
  ev("session.input_transcript.delta", { delta: "And in Example Village?", start_ms: 12_000, end_ms: 12_800 });
  ev("session.delegation.created", { delegation: { id: "item_h" }, offset_ms: 13_000 });
  await until(() => answers().length === 2, "the second answer");
  assert.deepEqual(asked.map((a) => a.utterance), ["What's the time in Lumi?", "And in Example Village?"]);
  assert.deepEqual(answers().map((a) => a.delegation_id), ["item_g", "item_h"]);
  call.end();
}

// 4. New words while the first is still running: one answer, for both, and the first job is stopped.
{
  const { call, asked, answers, cancelled, ev, release } = setup({ held: true });
  ev("session.input_transcript.delta", { delta: "Show me the first floor plan.", start_ms: 1000, end_ms: 2000 });
  ev("session.delegation.created", { delegation: { id: "item_i" }, offset_ms: 2200 });
  await until(() => asked.length === 1, "the first turn under way");
  clock += 2_000;
  ev("session.input_transcript.delta", { delta: "No, the ground floor.", start_ms: 4000, end_ms: 4800 });
  ev("session.delegation.created", { delegation: { id: "item_j" }, offset_ms: 5000 });
  await until(() => asked.length === 2, "the correction handed in");
  release();
  await until(() => answers().length === 1, "one answer");
  assert.equal(asked[1].utterance, "No, the ground floor.");
  assert.equal(asked[1].corrects, "Show me the first floor plan.", "the second is handed in as a correction to the first");
  assert.deepEqual(cancelled, [asked[0].jobId], "the first job is stopped");
  await sleep(100);
  assert.deepEqual(answers().map((a) => a.delegation_id), ["item_j"], "one spoken answer");
  assert.equal(audits("superseded").at(-1)!.ref, "item_i");
  call.end();
}

// 5. Handed over at the first pause of a two-sentence answer (seen in the "before" call): when they've carried on by the
// time the words are gathered, the hand-over waits until they stop, and a second hand-over at the next pause finds
// nothing new. One brain turn, with all of it. (If the rest comes later with its own hand-over, that's case 4.)
{
  const { call, asked, answers, ev } = setup();
  ev("session.input_transcript.delta", { delta: "I help at a club.", start_ms: 1000, end_ms: 1800 });
  ev("session.delegation.created", { delegation: { id: "item_k" }, offset_ms: 2300 });
  ev("session.input_transcript.delta", { delta: " We meet every week", start_ms: 2600, end_ms: 4200 });
  await sleep(100); // he's still talking: within the gap a hand-over waits through (600 ms)
  ev("session.input_transcript.delta", { delta: " with two friends.", start_ms: 4200, end_ms: 5000 });
  ev("session.delegation.created", { delegation: { id: "item_l" }, offset_ms: 5400 });
  await until(() => answers().length === 1 && ignored("item_l"), "one answer, and the second hand-over closed");
  assert.deepEqual(asked.map((a) => a.utterance), ["I help at a club. We meet every week with two friends."]);
  assert.deepEqual(answers().map((a) => a.delegation_id), ["item_k"]);
  assert.equal(audits("ignored_repeat").at(-1)!.ref, "item_l");
  call.end();
}

console.log("no-repeat: ok");
