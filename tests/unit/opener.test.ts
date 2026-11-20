// Stage 7.4: the opening line under Pebble. Written by a stubbed writer (no model calls): no material means no line and
// no call; a line that names nothing from the material is dropped; a line is never used twice; it shows only after four
// quiet hours, and lapses at local midnight. Also the "Names you'll hear" list the voice gets.
// Everything runs at a fixed time of day (local noon today), passed in, so it doesn't depend on the wall clock: run late
// in the evening, "four quiet hours later" would cross midnight, when the line rightly lapses.
import "../isolate.js"; // first: a private, throwaway data folder
import assert from "node:assert/strict";
import { db } from "../../src/store/db.js";
import { addCommitment } from "../../src/store/proactive.js";
import { openerFor, openerMaterial, writeOpener } from "../../src/memory/opener.js";
import { addDays, atLocal, localDay, nextLocalMidnight } from "../../src/time.js";

let calls = 0;
const writer = (line: string) => async () => (calls++, line);
const stored = () => db.prepare("SELECT value FROM settings WHERE key = 'opener'").get() as { value: string } | undefined;
const NOW = atLocal(localDay(), 12, 0); // local noon today
const at = (hours: number) => new Date(NOW.getTime() + hours * 3600_000);

// Nothing due, nothing waiting: no line, and the model isn't even asked.
assert.deepEqual(openerMaterial(NOW).lines, []);
assert.equal(await writeOpener("test", writer("Morning! Big day ahead."), NOW), null);
assert.equal(calls, 0, "no material, no model call");
assert.equal(openerFor(NOW), null);

// Something due tomorrow.
addCommitment({ title: "Book the concrete pump for the Lumi slab", owner: "user", kind: "book", site: "Lumi", due_at: atLocal(addDays(localDay(NOW), 1), 12, 0).toISOString() });
const m = openerMaterial(NOW);
assert.equal(m.lines.length, 1);
assert.match(m.lines[0], /^Commitment due tomorrow: Book the concrete pump for the Lumi slab \(at Lumi\)$/);

// A line that names nothing from it (a greeting) is dropped.
assert.equal(await writeOpener("test", writer("Morning! Hope you have a great day out there."), NOW), null);
assert.equal(stored(), undefined, "nothing kept");
assert.equal(await writeOpener("test", writer(""), NOW), null, "an empty answer is no line");

// One that names the job is kept.
const good = "Pump for the Lumi slab is due tomorrow. Booked yet?";
assert.equal(await writeOpener("test", writer(good), NOW), good);
assert.equal(openerFor(NOW), good, "shows when nothing's been said");

// Only after four quiet hours.
db.prepare("INSERT INTO conversation_log (ts, role, channel, text) VALUES (?, 'user', 'voice', 'hi')").run(at(-3).toISOString());
assert.equal(openerFor(NOW), null, "not within four hours of talking");
assert.equal(openerFor(at(1.5)), good, "back after four quiet hours");
db.prepare("INSERT INTO conversation_log (ts, role, channel, text) VALUES (?, 'user', 'test', 'test line')").run(NOW.toISOString());
assert.equal(openerFor(at(1.5)), good, "test lines don't count");

// It lapses at local midnight.
db.prepare("DELETE FROM conversation_log WHERE text = 'hi'").run();
const midnight = new Date(nextLocalMidnight(NOW));
assert.equal(midnight.getTime() - NOW.getTime(), 12 * 3600_000, "the line lapses at tonight's midnight, twelve hours after noon");
assert.equal(openerFor(new Date(midnight.getTime() - 60_000)), good, "still there a minute before midnight");
assert.equal(openerFor(midnight), null, "gone at midnight");

// Never the same line twice (even reworded only in case and punctuation).
assert.equal(await writeOpener("test", writer("pump for the Lumi slab is due tomorrow - booked yet"), NOW), null, "a repeat is dropped");
assert.equal(stored(), undefined, "and the old one is cleared rather than kept");
const other = "Lumi pump still needs booking for tomorrow's slab.";
assert.equal(await writeOpener("test", writer(other), NOW), other, "a new line is fine");

console.log("opener: all passed");
