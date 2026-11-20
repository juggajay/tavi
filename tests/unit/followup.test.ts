// Tests for the follow-up loop: when it asks, what it asks, answers, stop controls, bundling and pause.
// Uses the real database; removes everything it created (and restores the user's controls) at the end.
import "../isolate.js"; // first: a private copy of the data, never the real one
import { db, nowIso } from "../../src/store/db.js";
import { addCommitment } from "../../src/store/proactive.js";
import { answerFollowUp, askFollowUp, awaitingAnswers, isMuted, nextWindow, planFirstCheck, questionFor, setControls, type FollowUp } from "../../src/proactive/followups.js";
import { addChannel, deliverDue, queueNotification, setBundlePush } from "../../src/proactive/notify.js";
import { buildContext } from "../../src/brain/context.js";

const started = nowIso();
const savedControls = db.prepare("SELECT key, value, set_at FROM controls").all() as { key: string; value: string; set_at: string }[];
const created: string[] = [];
let fails = 0;
const check = (name: string, ok: boolean, extra = "") => (console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`), ok || fails++);
const get = (id: string) => db.prepare("SELECT * FROM commitments WHERE id = ?").get(id) as FollowUp;
const local = (d: Date) => d.toLocaleString("en-AU", { weekday: "short", hour: "numeric", minute: "2-digit" });
const add = (c: Parameters<typeof addCommitment>[0]) => {
  const id = addCommitment(c);
  created.push(id);
  return id;
};
const inDays = (n: number, hh = 7) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hh, 0, 0, 0);
  return d;
};

try {
  // When to ask
  const w = nextWindow(new Date());
  check("next window is a 6:00 / 12:00 / 15:30 slot", ["6:00", "12:00", "3:30"].some((t) => local(w).includes(t)), local(w));
  const pour = inDays(6); // well out
  const bookCheck = planFirstCheck({ kind: "book", event_at: pour.toISOString(), due_at: pour.toISOString() });
  const wd = (d: Date) => [1, 2, 3, 4, 5].includes(d.getDay());
  check("booking: asked at a morning brief, two working days before", bookCheck.getHours() === 6 && wd(bookCheck) && bookCheck < pour, local(bookCheck));
  const insp = inDays(3, 10);
  const inspCheck = planFirstCheck({ kind: "inspect", event_at: insp.toISOString() });
  check("inspection: asked the morning of", inspCheck.getDate() === insp.getDate() && inspCheck.getHours() === 6, local(inspCheck));
  const noDate = planFirstCheck({ kind: "call" });
  check("no date: today's wrap or the next window", noDate > new Date(), local(noDate));

  // Asking, far away: shares a buzz. Close: straight away.
  const far = add({ title: "Book the pump", owner: "user", kind: "book", site: "Testville", due_at: pour.toISOString(), event_at: pour.toISOString(), ask_before: "Pump for the Testville slab. Booked yet?", next_check_at: nowIso() });
  askFollowUp(get(far));
  const farNote = db.prepare("SELECT * FROM notifications WHERE source = ? ORDER BY created_at DESC").get(`commitment:${far}`) as { bundle: number; spoken: string; title: string };
  check("asks the question it was given", farNote.spoken.startsWith("Pump for the Testville slab. Booked yet?") && farNote.title === "Testville");
  check("far from due: can share a buzz", farNote.bundle === 1);
  check("then waits for overdue, after the due date", get(far).stage === "overdue" && new Date(get(far).next_check_at!) > pour);
  const soon = add({ title: "Confirm crane", owner: "user", kind: "book", site: "Testville", due_at: inDays(0, 23).toISOString(), next_check_at: nowIso() });
  askFollowUp(get(soon));
  const soonNote = db.prepare("SELECT bundle FROM notifications WHERE source = ?").get(`commitment:${soon}`) as { bundle: number };
  check("inside 24 hours: its own buzz, straight away", soonNote.bundle === 0);
  check("default wording names the thing and the site", questionFor(get(soon), "before").startsWith("Confirm crane at Testville. Sorted yet?"));
  check("context tells the brain what was asked", awaitingAnswers().some((a) => a.id === far) && buildContext().includes("You asked the user"));

  // Answers
  answerFollowUp(far, "done", { note: "confirmed 7am" });
  check("done closes it and records the answer", get(far).status === "done" && !!db.prepare("SELECT 1 FROM proactive_log WHERE item_id = ? AND answer = 'done'").get(far));
  answerFollowUp(soon, "not_yet");
  check("not yet: asks again at the next window", new Date(get(soon).next_check_at!).getTime() === nextWindow(new Date()).getTime());
  answerFollowUp(soon, "later", { when: inDays(3, 6).toISOString() });
  check("later: when they said", new Date(get(soon).next_check_at!).getTime() === inDays(3, 6).getTime());
  answerFollowUp(soon, "stop_asking");
  check("stop asking: muted, still open", !!get(soon).muted && get(soon).status === "open" && isMuted(get(soon)));
  const ins = add({ title: "Frame inspection", owner: "user", kind: "inspect", site: "Testville", event_at: insp.toISOString(), ask_before: "Frame inspection's booked for Thursday at Testville. Still on?", ask_after: "Frame inspection at Testville. Did it pass?" });
  answerFollowUp(ins, "done");
  check("inspection confirmed early: still asks how it went afterwards", get(ins).status === "open" && get(ins).stage === "after" && new Date(get(ins).next_check_at!) > insp);
  check("after question is the Dot-style one", questionFor(get(ins), "after") === "Frame inspection at Testville. Did it pass?");

  // Controls
  setControls({ mute_kinds: ["order"], mute_sites: ["Testville"] });
  const ord = add({ title: "Order bricks", owner: "user", kind: "order", site: "Elsewhere" });
  check("muted kind", isMuted(get(ord)));
  check("muted site", isMuted(get(ins)));
  setControls({ unmute_kinds: ["order"], unmute_sites: ["Testville"] });
  check("unmuted again", !isMuted(get(ord)) && !isMuted(get(ins)));

  // Delivery: bundling and pause (only if nothing real is waiting, so a real notice is never swallowed here)
  const realQueued = (db.prepare("SELECT COUNT(*) n FROM notifications WHERE status = 'queued' AND created_at < ?").get(started) as { n: number }).n;
  if (realQueued) console.log(`SKIP delivery checks: ${realQueued} real notification(s) queued`);
  else {
    db.prepare("UPDATE notifications SET status = 'dismissed' WHERE created_at >= ?").run(started); // clear this test's earlier ones
    const delivered: { title: string; push: boolean }[] = [];
    const bundles: string[] = [];
    addChannel((n, o) => void delivered.push({ title: n.spoken, push: o.push }));
    setBundlePush(async (t, b) => void bundles.push(`${t}: ${b}`));
    queueNotification({ title: "A", spoken: "Thing one. Sorted?", priority: "normal", source: "test", bundle: true });
    queueNotification({ title: "B", spoken: "Thing two. Sorted?", priority: "normal", source: "test", bundle: true });
    await deliverDue(new Date());
    check("two follow-ups at once share one buzz", bundles.length === 1 && bundles[0].startsWith("2 things to check") && delivered.every((d) => !d.push), bundles[0]);
    setControls({ pause_until: inDays(2, 6).toISOString() });
    delivered.length = 0;
    queueNotification({ title: "C", spoken: "Paused one", priority: "normal", source: "test", bundle: true });
    queueNotification({ title: "Reminder", spoken: "Ring the pump company", priority: "normal", source: "test", exact: true });
    await deliverDue(new Date());
    check("paused: follow-up waits, timed reminder still comes", delivered.length === 1 && delivered[0].title === "Ring the pump company");
    setControls({ resume: true });
  }
} finally {
  for (const id of created) {
    db.prepare("DELETE FROM commitments WHERE id = ?").run(id);
    db.prepare("DELETE FROM proactive_log WHERE item_id = ?").run(id);
  }
  db.prepare("DELETE FROM notifications WHERE created_at >= ? AND (source = 'test' OR source LIKE 'commitment:%')").run(started);
  db.prepare("DELETE FROM controls").run();
  for (const c of savedControls) db.prepare("INSERT INTO controls (key, value, set_at) VALUES (?, ?, ?)").run(c.key, c.value, c.set_at);
}
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
