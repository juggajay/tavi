// Stage 7.4: everyday getting-to-know-you questions. Never in the first two things said, never while the sit-down is on
// offer or under way, at most one a day, and three days apart after two in a row went unanswered (judged by the keeper,
// stubbed here) until one is answered. Also the "Names you'll hear" list the voice gets from USER.md.
import "../isolate.js"; // first: a private, throwaway data folder
import assert from "node:assert/strict";
import { db, nowIso } from "../../src/store/db.js";
import { askGapMs, curiousHistory, gettingToKnowNote, noteCuriousQuestion } from "../../src/memory/getToKnow.js";
import { keeperPass, type Plan } from "../../src/memory/keeper.js";
import { moveSitdown } from "../../src/memory/sitdown.js";
import { editUser, setAssistantName } from "../../src/profile/profile.js";
import { addCommitment } from "../../src/store/proactive.js";
import { namesLine, namesToHear } from "../../src/profile/voiceCard.js";
import { voiceInstructions } from "../../src/gateway/live.js";

const H = 3600_000;
const say = (role: "user" | "assistant", text: string) => Number(db.prepare("INSERT INTO conversation_log (ts, role, channel, text) VALUES (?, ?, 'voice', ?)").run(nowIso(), role, text).lastInsertRowid);
const empty: Plan = { about_user: [], details: [], offers: [], settled: [], gist: "" };
setAssistantName("Pebble", "test"); // named already: the name invite is out of the way
// The sit-down is done (it would hold questions back otherwise).
db.prepare("INSERT INTO settings (key, value) VALUES ('sitdown', ?)").run(JSON.stringify({ status: "done", covered: [], started_at: null, ended_at: null, offered_at: null, offers: 1 }));

// Never in the first two things said.
say("user", "What's the time?");
say("user", "Cheers.");
assert.equal(gettingToKnowNote(), null, "not in the first two");
say("user", "Show me the hardware schedule.");
const note = gettingToKnowNote() ?? "";
assert.match(note, /grows out of what|what they're doing right now/, note);
assert.match(note, /Do you organise these or just attend\?/);
assert.doesNotMatch(note, /PM, site manager|for example, about/, "no topic list");

// Never while the sit-down is on offer or under way.
db.prepare("UPDATE settings SET value = ? WHERE key = 'sitdown'").run(JSON.stringify({ status: "not_offered", covered: [], started_at: null, ended_at: null, offered_at: null, offers: 0 }));
assert.equal(gettingToKnowNote(), null, "on offer");
moveSitdown({ status: "in_progress" });
assert.equal(gettingToKnowNote(), null, "under way");
moveSitdown({ status: "done" });
assert.ok(gettingToKnowNote(), "back once it's done");

// One a day.
noteCuriousQuestion("Do you organise these or just attend?");
assert.equal(gettingToKnowNote(), null, "not again the same day");
assert.ok(gettingToKnowNote(Date.now() + 21 * H), "next day is fine");

// The keeper decides whether it was taken up. Unanswered once: still a day.
const stamp = (h: number) => curiousHistory().map((a, i, all) => ({ ...a, at: i === all.length - 1 ? new Date(Date.now() - h * H).toISOString() : a.at }));
const rewrite = (all: unknown) => db.prepare("UPDATE settings SET value = ? WHERE key = 'curious_history'").run(JSON.stringify(all));
rewrite(stamp(0.01));
say("assistant", "Here it is. Do you organise these or just attend?");
say("user", "Anyway, what's the weather tomorrow?");
await keeperPass("test", async (prompt) => (assert.match(prompt, /Getting-to-know-you questions asked ===\n\[0\] "Do you organise these/), { ...empty, questions: [{ n: 0, answered: false }] }));
assert.equal(curiousHistory().at(-1)?.answered, false);
assert.equal(askGapMs(), 20 * H, "one unanswered: still a day");

// A second one, also unanswered: three days.
noteCuriousQuestion("Do you organise the club weekend?");
rewrite(stamp(0.01));
say("assistant", "Do you organise the club weekend?");
say("user", "Show me door 7.");
await keeperPass("test", async () => ({ ...empty, questions: [{ n: 0, answered: false }] }));
assert.equal(askGapMs(), 72 * H, "two in a row unanswered: three days");
rewrite(stamp(30));
assert.equal(gettingToKnowNote(), null, "not after a day");
rewrite(stamp(73));
assert.ok(gettingToKnowNote(), "after three days");

// One answered ends the back-off.
noteCuriousQuestion("Who helps you with the club weekend?");
rewrite(stamp(0.01));
say("assistant", "Who helps you with the club weekend?");
say("user", "Ruvo Pell, he's good.");
await keeperPass("test", async () => ({ ...empty, questions: [{ n: 0, answered: true }] }));
assert.equal(askGapMs(), 20 * H, "answered: back to a day");
rewrite(stamp(21));
assert.ok(gettingToKnowNote(), "a day later is fine again");

// Names you'll hear: from Work, People and Life, and open commitments; not from Basics; at most 40 words.
const said = { trust: "user" as const, source: "you said" };
editUser({ op: "add", section: "Basics", text: "Goes by NemiOnly" }, said);
editUser({ op: "add", section: "Work", text: "Current projects: club weekend at Lumi; household project at Example Village" }, said);
editUser({ op: "add", section: "People", text: "Ruvo's my friend. Nemi at Example Club helps with bookings" }, said);
editUser({ op: "add", section: "Life", text: "Married to Ruvo; weekends at the footy, Example Club fan" }, said);
addCommitment({ title: "Order the club notebooks", owner: "user", kind: "order", site: "Lumi", counterpart: "Nemi Venn" });
const names = namesToHear();
for (const n of ["Lumi", "Lumi", "Ruvo", "Nemi", "Example Club", "Ruvo", "Example Club", "Lumi", "Nemi Venn"]) assert.ok(names.includes(n), `${n} in ${names.join(", ")}`);
for (const n of ["NemiOnly", "Current", "Married", "Order", "Goes"]) assert.ok(!names.includes(n), `${n} not in ${names.join(", ")}`);
assert.ok(voiceInstructions().includes(namesLine()), "the voice gets the list");
editUser({ op: "add", section: "People", text: "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey Xray Yankee Zulu Ace Bee Cee Dee Eff Gee" }, said);
assert.ok(namesToHear().reduce((n, x) => n + x.split(" ").length, 0) <= 40, "capped at 40 words");

console.log("curious and names: all passed");
