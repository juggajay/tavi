// The chair (Stage 17.2), driven by scripted speakers: what the owner's words mean, whose turn it is for each rule, the
// round limit and the close, an early end on agreement, the short version of a long turn, a guest that can't answer,
// the owner cutting in mid-exchange, echoes, and that the two never say more than the limit between the owner's turns.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { agreesOnly, Chair, classify, firstSentences, inviteWants, keepWhole, isEcho, lineLimit, planFor, startsTable, tooLong, type ChairDeps, type TableLine } from "../../src/guest/chair.js";
import type { GuestTask, PebbleTask } from "../../src/guest/brief.js";
import type { GuestReply } from "../../src/guest/guest.js";

const N = { guest: "Tim", pebble: ["Pebble", "Mate"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- bringing him in
for (const t of ["Pebble, can you bring in Tim so we can discuss this idea", "Bring Tim in", "get Tim's view", "Let's put this to Tim", "can you get Tim in on this", "what does Tim reckon about that?", "let's do a round table with Tim", "Loop Tim in", "I want Tim's take on the deck"])
  assert.ok(startsTable(t, "Tim"), t);
for (const t of ["Tim from the council rang", "Remind me to call Tim at three", "Email Tim the quote", "What's the time?", "timber prices", "bring in the washing"]) assert.ok(!startsTable(t, "Tim"), t);
assert.ok(startsTable("bring in Sam", "Sam") && !startsTable("bring in Tim", "Sam"), "the name follows the setting");

assert.equal(inviteWants("Bring in Tim", "Tim"), null);
assert.equal(inviteWants("Pebble, can you bring in Tim", "Tim"), null);
assert.equal(inviteWants("get Tim's view on this", "Tim"), "view");
assert.equal(inviteWants("Let's put this to Tim", "Tim"), "view");
assert.equal(inviteWants("Bring in Tim, should I buy a second ute or keep hiring?", "Tim"), "view");
assert.equal(inviteWants("bring in Tim and you two thrash it out", "Tim"), "discuss");
assert.equal(inviteWants("bring in Tim to play devil's advocate", "Tim"), "devil");

// ---- what the owner's words mean, at the table
const k = (t: string) => classify(t, N);
for (const t of ["Thanks Tim", "thanks, Tim.", "Cheers Tim, see you", "That's all, Tim", "that'll do Tim", "bye Tim", "end the round table", "let Tim go", "Thank you Tim, that's all for now"]) assert.equal(k(t).kind, "end", t);
assert.notEqual(k("Thanks Tim, but what about the rego on a second ute?").kind, "end", "thanks then a question isn't goodbye");
for (const t of ["What does Tim know?", "what have you told Tim", "What's Tim been told?"]) assert.equal(k(t).kind, "know", t);
for (const t of ["Ask Tim to sleep on it", "get Tim to review this properly", "can he take his time over it"]) assert.equal(k(t).kind, "deep", t);
for (const t of ["keep going", "Carry on.", "another round"]) assert.equal(k(t).kind, "keep", t);
for (const t of ["Discuss it", "you two work it through", "argue it out", "thrash it out between you", "talk it over"]) assert.equal(k(t).kind, "discuss", t);
assert.deepEqual(k("you two argue it out, Tim be the devil's advocate"), { kind: "discuss", devil: true });
assert.deepEqual(k("Tim, what do you think?"), { kind: "to", who: "guest", devil: false });
assert.deepEqual(k("What do you reckon, Tim?"), { kind: "to", who: "guest", devil: false });
assert.deepEqual(k("over to you Tim"), { kind: "to", who: "guest", devil: false });
assert.deepEqual(k("Tim, play devil's advocate"), { kind: "to", who: "guest", devil: true });
assert.deepEqual(k("Pebble, check that"), { kind: "to", who: "pebble", devil: false });
assert.deepEqual(k("Mate, look up the span for that"), { kind: "to", who: "pebble", devil: false }, "the assistant's own name too");
assert.deepEqual(k("Tim, what do you make of Pebble's idea?"), { kind: "to", who: "guest", devil: false }, "the name at the start wins");
assert.deepEqual(k("someone play devil's advocate"), { kind: "devil" });
assert.deepEqual(k("Should I buy the ute outright or lease it?"), { kind: "open" });
assert.deepEqual(k("What would you two do about the busy patch before Christmas?"), { kind: "open" }, "a question to both isn't 'discuss it'");
assert.deepEqual(k("What do you both reckon?"), { kind: "open" });
for (const t of ["mm", "Yeah.", "okay", "uh huh"]) assert.equal(k(t).kind, "filler", t);

// ---- the little rules
assert.ok(agreesOnly("I agree, nothing to add."));
assert.ok(agreesOnly("Agreed. Nothing to add."));
assert.ok(agreesOnly("I'm with Pebble, nothing to add."));
assert.ok(!agreesOnly("I agree, but the rego is the real cost."));
assert.ok(tooLong("One. Two. Three. Four. Five."));
assert.ok(!tooLong("One. Two. Three. Four."));
assert.ok(tooLong(Array(80).fill("word").join(" ") + "."));
assert.equal(firstSentences("A is 3.5 m long. B is next. C? D! E.", 4), "A is 3.5 m long. B is next. C? D!");
{
  // four sentences of 30 words each: too long to say; the fallback keeps whole sentences up to the limit
  const s30 = (n: number) => `${Array(29).fill(`w${n}`).join(" ")} end.`;
  const long4 = [1, 2, 3, 4].map(s30).join(" ");
  assert.ok(tooLong(long4));
  assert.equal(keepWhole(long4), `${s30(1)} ${s30(2)}`, "two whole sentences, 60 words");
  assert.equal(keepWhole(`${Array(90).fill("x").join(" ")}.`).split(" ").length, 90, "one sentence is kept whole even if long");
}
assert.ok(isEcho("a second ute ties up cash you could need", "I'll play devil's advocate: a second ute ties up cash you could need for wages."));
assert.ok(!isEcho("what about the rego on it", "A second ute ties up cash you could need for wages."));

// ---- the plans, and the limit
const tasks = (r: ReturnType<typeof planFor>) => r.steps.map((s) => `${s.who === "pebble" ? "P" : "T"}:${s.task}`).join(" ");
assert.equal(tasks(planFor({ kind: "open" }, 2, null)), "P:open T:respond P:close");
assert.equal(tasks(planFor({ kind: "to", who: "guest", devil: false }, 2, null)), "T:answer");
assert.equal(tasks(planFor({ kind: "to", who: "pebble", devil: false }, 2, null)), "P:answer");
assert.equal(tasks(planFor({ kind: "discuss", devil: false }, 2, null)), "P:open T:respond P:reply T:again P:close");
assert.equal(tasks(planFor({ kind: "discuss", devil: false }, 1, null)), "P:open T:respond P:close");
assert.equal(planFor({ kind: "discuss", devil: false }, 9, null).steps.length, lineLimit(4), "never more than four rounds");
assert.equal(tasks(planFor({ kind: "devil" }, 2, null)), "T:against P:close");
assert.equal(tasks(planFor({ kind: "keep" }, 2, "discuss")), "P:reply T:again P:close");
assert.equal(tasks(planFor({ kind: "keep" }, 2, "devil")), "P:reply T:against P:close");
for (const R of [1, 2, 3, 4]) for (const i of [{ kind: "open" }, { kind: "discuss", devil: false }, { kind: "discuss", devil: true }, { kind: "devil" }, { kind: "keep" }] as const) assert.ok(planFor(i, R, "discuss").steps.length <= lineLimit(R));

// ---- a scripted table
type Call = { who: "P" | "T"; task: string; at: number; fresh?: number };
function table(o: { rounds?: number; pebble?: (task: PebbleTask, n: number) => string | null; guest?: (task: GuestTask, n: number) => GuestReply; sayMs?: number; thinkMs?: number } = {}) {
  const calls: Call[] = [];
  const said: { l: TableLine; at: number; end: number }[] = [];
  const heard: TableLine[] = [];
  let gone = "";
  let np = 0,
    ng = 0;
  const deps: ChairDeps = {
    names: () => ({ guest: "Tim", pebble: "Pebble" }),
    rounds: () => o.rounds ?? 2,
    pebble: async ({ task, signal }) => {
      calls.push({ who: "P", task, at: Date.now() });
      await sleep(o.thinkMs ?? 5);
      if (signal.aborted) return null;
      return o.pebble ? o.pebble(task, ++np) : `Pebble ${task} ${++np}.`;
    },
    guest: async ({ task, fresh, signal }) => {
      calls.push({ who: "T", task, at: Date.now(), fresh: fresh.length });
      await sleep(o.thinkMs ?? 5);
      if (signal.aborted) return { ok: false, why: "failed", line: "stopped", ms: 0 };
      return o.guest ? o.guest(task, ++ng) : { ok: true, text: `Tim ${task} ${++ng}.`, ms: 5 };
    },
    deliver: async (l, signal) => {
      const at = Date.now();
      const rec = { l, at, end: at };
      said.push(rec);
      // "saying" it takes a while; it stops at once if the owner cuts in
      await new Promise<void>((res) => {
        const t = setTimeout(res, o.sayMs ?? 5);
        signal.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
      });
      rec.end = Date.now();
    },
    heard: (l) => heard.push(l),
    guestGone: (why) => (gone = why),
  };
  const chair = new Chair(deps);
  return { chair, calls, said, heard, gone: () => gone, flow: () => chair.lines.map((l) => `${l.speaker === "owner" ? "O" : l.speaker === "pebble" ? "P" : "T"}${l.kind ? `(${l.kind})` : ""}`).join(" ") };
}

{
  // an open question: the assistant first, then the guest on both, then the close; then silence
  const t = table();
  assert.equal(t.chair.owner("Should I buy the ute outright or lease it?").kind, "open");
  await t.chair.settled();
  assert.equal(t.flow(), "O P T P(close)");
  assert.deepEqual(t.calls.map((c) => `${c.who}:${c.task}`), ["P:open", "T:respond", "P:close"]);
  assert.equal(t.calls[1].fresh, 2, "the guest hears the question and the answer");
  assert.equal(t.heard.length, 1);
}
{
  // addressed by name: that one only
  const t = table();
  t.chair.owner("Tim, what do you think?");
  await t.chair.settled();
  assert.equal(t.flow(), "O T");
  const p = table();
  p.chair.owner("Pebble, check that");
  await p.chair.settled();
  assert.equal(p.flow(), "O P");
}
{
  // discuss it: two rounds then the close; with the setting at four, four; never more
  for (const [R, want] of [[2, "O P T P T P(close)"], [4, "O P T P T P T P T P(close)"], [1, "O P T P(close)"]] as const) {
    const t = table({ rounds: R });
    t.chair.owner("you two work it through");
    await t.chair.settled();
    assert.equal(t.flow(), want, `rounds ${R}`);
  }
}
{
  // devil's advocate: the guest is told to argue against, then the close
  const t = table();
  t.chair.owner("Tim, play devil's advocate");
  await t.chair.settled();
  assert.equal(t.flow(), "O T P(close)");
  assert.equal(t.calls[0].task, "against");
  // keep going: another round, still against
  t.chair.owner("keep going");
  await t.chair.settled();
  assert.deepEqual(t.calls.slice(2).map((c) => `${c.who}:${c.task}`), ["P:reply", "T:against", "P:close"]);
}
{
  // an early end: a turn that only agrees ends the exchange, with no close
  const t = table({ guest: (task, n) => ({ ok: true, text: "I agree, nothing to add.", ms: 1 }) });
  t.chair.owner("you two discuss it");
  await t.chair.settled();
  assert.equal(t.flow(), "O P T");
  assert.ok(!t.calls.some((c) => c.task === "close"));
}
{
  // too long: one ask for the short version; still long, its first four whole sentences
  const long = "One is first. Two is next. Three follows. Four is here. Five is too many. Six as well.";
  const t = table({ pebble: (task) => (task === "shorter" ? "Short version: one, two." : task === "open" ? long : "Close it."), guest: (task) => (task === "shorter" ? { ok: true, text: long, ms: 1 } : { ok: true, text: long, ms: 1 }) });
  t.chair.owner("Should I lease it?");
  await t.chair.settled();
  assert.deepEqual(t.calls.map((c) => `${c.who}:${c.task}`), ["P:open", "P:shorter", "T:respond", "T:shorter", "P:close"]);
  assert.equal(t.chair.lines[1].text, "Short version: one, two.");
  assert.equal(t.chair.lines[2].text, "One is first. Two is next. Three follows. Four is here.", "never cut mid-thought");
}
{
  // the guest can't answer: one plain line from the assistant, and the exchange stops
  const t = table({ guest: () => ({ ok: false, why: "timeout", line: "Tim's taking too long.", ms: 25_000 }) });
  t.chair.owner("Should I lease it?");
  await t.chair.settled();
  assert.equal(t.flow(), "O P P(note)");
  assert.equal(t.chair.lines[2].text, "Tim's taking too long.");
  const m = table({ guest: () => ({ ok: false, why: "missing", line: "Tim isn't available: I can't find the Codex program on this PC. I'll carry on by myself.", ms: 0 }) });
  m.chair.owner("Tim, what do you think?");
  await m.chair.settled();
  assert.equal(m.gone(), "missing", "the round table hears he's not there");
}
{
  // the next line is worked out while the one before is being said, and lines are said one after another, never at once
  const t = table({ sayMs: 120, thinkMs: 30 });
  t.chair.owner("Should I lease it?");
  await t.chair.settled();
  const [p, g] = t.said;
  const timCall = t.calls.find((c) => c.who === "T")!;
  assert.ok(timCall.at < p.end, "the guest was asked while the assistant was still talking");
  assert.ok(g.at >= p.end, "and he spoke only after it finished");
  for (let i = 1; i < t.said.length; i++) assert.ok(t.said[i].at >= t.said[i - 1].end, "no overlap");
}
{
  // the owner cutting in mid-exchange: what's being said stops, nothing more of that exchange is said, his turn goes on
  const t = table({ sayMs: 200, thinkMs: 20 });
  t.chair.owner("you two discuss it");
  await sleep(60); // the assistant's first line is being said
  assert.equal(t.said.length, 1);
  t.chair.owner("Tim, what about the rego?");
  await t.chair.settled();
  const afterCut = t.said.slice(1).map((s) => s.l.speaker);
  assert.deepEqual(afterCut, ["guest"], "only the answer to his new question");
  assert.ok(t.said[0].end - t.said[0].at < 150, "the line being said stopped");
  assert.equal(t.flow(), "O P O T");
}
{
  // bringing him in: the brief, "Tim's here", then his view if it was asked for
  const t = table({ pebble: (task) => (task === "brief" ? "He's weighing up a second ute against hiring one." : "x.") });
  t.chair.begin("Bring in Tim, should I buy a second ute or keep hiring?");
  await t.chair.settled();
  assert.equal(t.flow(), "O P(start) T");
  assert.equal(t.chair.brief, "He's weighing up a second ute against hiring one.");
  assert.equal(t.chair.lines[1].text, "Tim's here, and I've filled him in.");
  assert.equal(t.calls.at(-1)!.task, "first");
  const quiet = table({ pebble: () => "He wants a second opinion; the topic will come." });
  quiet.chair.begin("Pebble, bring in Tim");
  await quiet.chair.settled();
  assert.equal(quiet.flow(), "O P(start)", "nothing asked yet: silence after the one line");
}
{
  // an echo of what was just said isn't the owner
  const t = table({ guest: () => ({ ok: true, text: "A second ute ties up cash you could need for wages.", ms: 1 }) });
  t.chair.owner("Tim, what do you think?");
  await t.chair.settled();
  assert.equal(t.chair.owner("a second ute ties up cash you could need").kind, "echo");
  assert.equal(t.chair.lines.length, 2, "not added");
  assert.equal(t.chair.owner("mm").kind, "filler");
  assert.equal(t.chair.lines.length, 2);
}
{
  // no path where the two say more than the limit without the owner: a run of everything, in random order
  const all = ["Should I lease it?", "you two work it through", "Tim, play devil's advocate", "keep going", "Tim, what do you think?", "Pebble, check that", "argue it out", "someone play devil's advocate", "discuss it"];
  for (const R of [1, 2, 3, 4]) {
    const t = table({ rounds: R, sayMs: 1, thinkMs: 1 });
    for (let i = 0; i < 25; i++) {
      t.chair.owner(all[(i * 7 + R) % all.length]);
      if (i % 3) await t.chair.settled();
      else await sleep(3);
    }
    await t.chair.settled();
    let run = 0;
    for (const l of t.chair.lines) {
      run = l.speaker === "owner" ? 0 : run + 1;
      assert.ok(run <= lineLimit(R), `rounds ${R}: ${run} lines without the owner`);
    }
  }
}
console.log("chair: ok");
