// One answer, one card: a drawing shown mid-answer and the summary the brain finishes with land on the same card (the
// bug was the summary replacing the drawing a second later). Cards are kept, found again, and test turns aren't saved.
import "../isolate.js"; // first: a private copy of the data, never the real one
import { beginTurn, cardShown, endTurn, findCards, getCard, noticeCard, recentCards, reopenCard } from "../../src/store/cards.js";

let fails = 0;
const check = (name: string, ok: boolean, extra = "") => (console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`), ok || fails++);
const IMG = "/api/drawings/crop/crop_00000000000000a1.png", IMG2 = "/api/drawings/crop/crop_00000000000000b2.png";
const summary = { title: "Lumi fire stair doors", rows: [{ label: "D03.0", value: "-/90/30" }], source: "A-9100 Door Schedule-01, Rev F" };

// The drawing, then the summary: one card with both
beginTurn();
const shown = cardShown({ title: "D03 row, door schedule", image: IMG, source: "A-9100 Rev F" });
const done = endTurn(summary)!;
check("summary joins the drawing (same card)", done.id === shown.id);
check("the card keeps the drawing", done.images.length === 1 && done.images[0].src === IMG && done.images[0].caption === "D03 row, door schedule");
check("and gets the summary rows and title", done.rows.length === 1 && done.title === summary.title && done.source === summary.source);
check("saved", getCard(done.id)?.rows.length === 1);

// Two drawings in one answer: one card, two pictures
beginTurn();
const a = cardShown({ title: "Level 1 plan", image: IMG, source: "A-1001 Rev C" });
const b = cardShown({ title: "Level 2 plan", image: IMG2, source: "A-1002 Rev C" });
const both = endTurn(null)!;
check("two drawings, one card", a.id === b.id && both.id === a.id && both.images.length === 2);

// A plain answer with no drawing: its own card
beginTurn();
const plain = endTurn({ title: "Pour on Thursday", rows: [{ label: "Pump", value: "Booked 6:30" }], source: "Calendar" })!;
check("text-only answer is its own card", !!plain && plain.images.length === 0 && plain.id !== done.id);

// No card at all
beginTurn();
check("no card, nothing saved", endTurn(null) === null);

// Bring one back: it moves to the top and the answer's own summary doesn't overwrite it
const before = recentCards()[0].id;
beginTurn();
const again = reopenCard(done.id)!;
const after = endTurn({ title: "Something else", rows: [{ label: "x", value: "y" }], source: "z" })!;
check("reopened card goes to the top", recentCards()[0].id === done.id && before !== done.id);
check("and is left as it was", after.id === again.id && getCard(done.id)?.title === summary.title && getCard(done.id)?.rows[0].label === "D03.0");

// Finding cards by words
check("find by title words", findCards("fire stair")[0]?.id === done.id);
check("find by sheet number", findCards("A-9100")[0]?.id === done.id);
check("find by picture caption", findCards("level 2")[0]?.id === both.id);
check("no words: the latest", findCards("")[0]?.id === done.id);
check("no match: nothing", findCards("scaffold tag").length === 0);

// Test messages: shown on the phone, never saved
const count = recentCards(500).length;
beginTurn(false);
const t1 = cardShown({ title: "Test drawing", image: IMG, source: "T-1" });
const t2 = endTurn(summary)!;
check("test turn: still one card for the phone", t1.id === t2.id && t2.rows.length === 1);
check("test turn: nothing saved", recentCards(500).length === count && !getCard(t2.id));

// A drawing shown by a background run doesn't join the conversation's answer
beginTurn();
const fg = cardShown({ title: "Asked for", image: IMG, source: "A-1" });
const bg = cardShown({ title: "Routine", image: IMG2, source: "A-2", background: true });
const fgDone = endTurn(null)!;
check("background drawing is its own card", bg.id !== fg.id && fgDone.images.length === 1);

// Notices: kept once, under the notice's id
const n1 = noticeCard({ id: "ntf_test1", card: { title: "Frame inspection", rows: [{ label: "When", value: "Tomorrow 8am" }], source: "Follow-up" } })!;
const n2 = noticeCard({ id: "ntf_test1", card: { title: "Frame inspection", rows: [], source: "" } })!;
check("notice card kept once", n1.id === "crd_ntf_test1" && n2.id === n1.id && n2.rows.length === 1 && n1.origin === "notice");
check("notice without a card: none", noticeCard({ id: "ntf_x", card: null }) === null);

// Only our own pictures
beginTurn();
const evil = cardShown({ title: "x", image: "https://evil.example/x.png", source: "" });
endTurn(null);
check("outside images are dropped", evil.images.length === 0);

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
