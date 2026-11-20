// At a round table the voice is ears only (Stage 18.1), with made-up scripted calls
// (the example owner is "Nemi"). One line of his is exactly one turn: never none, never two.
//   - At a round table the voice answers by itself instead of handing over: the round table still gets his line, once,
//     and what the voice said (into a muted call) is in the record as unheard.
//   - A hand-over and the gateway's own transcript path for the same words are one turn, whichever comes first.
//   - The round table's own line coming back through the microphone starts nothing (and a late hand-over for it doesn't
//     bring back an old question).
//   - "Pull up Tim there, will ya" and "Okay, bring in Tim" start a round table with no hand-over at all.
//   - Outside a round table, ordinary hand-overs are untouched.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { db } from "../../src/store/db.js";
import { HUSH, VoiceCall, type HandOver } from "../../src/gateway/voiceCall.js";
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

/* ---------------- 18.1: at a round table the voice is ears only ---------------- */

// The record, call of 8:17 pm: the round table is on, the call's voice muted; he speaks to "Tim" and the voice answers
// by itself every time ("Hey Nemi. What's on?", "Yeah. I'm Tim. Go on."), never handing over. Each line reaches the round
// table once, by the gateway; nothing is sent for the voice to say; what it said is marked unheard; it's told to stop.
{
  clear();
  const s = setup({ table: true });
  s.call.muted = true;
  for (const [said, reply] of [
    ["Hey, Tim", "Hey Nemi. What's on?"],
    ["Ah. Who am I speaking to", "You're speaking with me in Tavi, and Tim's here with us as an extra brain and sounding board."],
    ["Is this Tim I'm speaking to", "Yeah. I'm Tim. Go on."],
  ]) {
    const before = s.asked.length;
    s.owner(said);
    s.voice(reply);
    await sleep(ACT + 150);
    assert.equal(s.asked.length, before + 1, `one turn for "${said}"`);
    assert.equal(s.asked.at(-1)!.utterance, said);
    assert.equal(s.asked.at(-1)!.by, "table", "started by the gateway, with no hand-over");
  }
  await sleep(100);
  assert.equal(s.spoken().length, 0, "the voice is never given anything to say at the table");
  const said = rows("said");
  assert.equal(said.length, 3);
  assert.ok(said.every((r) => r.d.unheard === true), "what the voice said into the muted call is marked unheard");
  assert.ok(s.sent.filter((e) => e.type === "session.instructions.append" && e.content === HUSH).length >= 3, "told to stop each time");
  assert.equal(rows("acted").length, 3);
  assert.equal(rows("heard").filter((r) => r.d.handed === true && r.d.acted === "table").length, 3);
  s.call.end();
}

// A hand-over and the transcript path for the same words are one turn. (a) The gateway first, the hand-over late (in the
// record "we need a male voice for Tim" was handed over 2 s after his last word): one turn, the hand-over closed quietly,
// its acknowledgement held off.
{
  clear();
  const s = setup({ table: true });
  s.owner("Okay, we need a male voice for Tim because I can't tell the two of you apart");
  await sleep(ACT + 60);
  assert.equal(s.asked.length, 1);
  s.handOver("item_late");
  await sleep(250);
  assert.equal(s.asked.length, 1, "still one turn");
  assert.ok(s.sent.some((e) => e.type === "session.thinking.append" && e.delegation_id === "item_late" && e.content === ""), "its acknowledgement held off");
  assert.ok(s.sent.some((e) => e.type === "session.thinking.append" && e.delegation_id === "item_late" && String(e.content).length > 0), "closed quietly");
  assert.equal(rows("ignored_repeat").at(-1)!.ref, "item_late");
  s.call.end();
}
// (b) The hand-over first: it has the words, and the gateway leaves them to it.
{
  clear();
  const s = setup({ table: true });
  s.owner("Tim, what do you reckon?");
  s.handOver("item_first");
  await sleep(ACT + 300);
  assert.equal(s.asked.length, 1, "one turn");
  assert.equal(s.asked[0].delegationId, "item_first");
  assert.equal(s.asked[0].by, undefined, "through the hand-over");
  s.call.end();
}

// The round table's own line coming back through the microphone starts nothing, and a hand-over the voice makes for it
// afterwards doesn't bring back his last question ("the last thing said" is never used at a round table).
{
  clear();
  const line = "A second ute ties up cash you could need for wages or a quiet patch.";
  const s = setup({ table: true, echo: (t) => t.length > 10 && line.toLowerCase().includes(t.toLowerCase().replace(/[.,]/g, "").slice(0, 20)) });
  s.owner("Should I buy a second ute?");
  await sleep(ACT + 80);
  assert.equal(s.asked.length, 1);
  s.owner("ties up cash you could need for wages");
  await sleep(ACT + 80);
  assert.equal(s.asked.length, 1, "the echo started nothing");
  assert.ok(rows("heard").some((r) => r.d.echo === true && r.d.handed === false), "in the record as an echo");
  s.handOver("item_echo");
  await sleep(250);
  assert.equal(s.asked.length, 1, "the late hand-over for the echo found nothing new: no old question again");
  assert.equal(rows("ignored_repeat").at(-1)!.ref, "item_echo");
  // a filler of his at the table isn't a turn either
  s.owner("Mm.");
  await sleep(ACT + 80);
  assert.equal(s.asked.length, 1);
  s.call.end();
}

// "Hey, pull up Tim there, will ya" (the record: "One sec." and no hand-over for 56 seconds) and "Okay, bring in Tim"
// (the record: "Sure, bringing him in." and no hand-over at all): each starts a round table, from the transcript alone.
for (const [said, reply] of [
  ["Hey, pull up Tim there, will ya", "One sec."],
  ["Okay, bring in Tim", "Sure, bringing him in."],
]) {
  clear();
  const s = setup();
  s.owner(said);
  s.voice(reply);
  await sleep(ACT + WAIT + 200);
  assert.equal(s.asked.length, 1, `one turn for "${said}"`);
  assert.equal(s.asked[0].by, "table-start");
  assert.equal(s.asked[0].utterance, said);
  assert.equal(rows("delegation").length, 0, "no hand-over");
  assert.equal(s.spoken().length, 0, "nothing for the voice to say: the round table says its own lines");
  s.call.end();
}

// Outside a round table, ordinary hand-overs are untouched: the gateway never acts on words that don't start one.
{
  clear();
  const s = setup();
  s.owner("What's the time in Lumi?");
  await sleep(ACT + 100);
  assert.equal(s.asked.length, 0, "left to the voice");
  s.handOver("item_perth");
  await sleep(200);
  assert.deepEqual(s.asked.map((a) => [a.utterance, a.by]), [["What's the time in Lumi?", undefined]]);
  s.call.end();
}

console.log("voice-acts: ok");
