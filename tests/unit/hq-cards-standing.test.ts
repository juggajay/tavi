import "../isolate.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createBot } from "../../src/hq/bots.js";
import { saveCard, type JobCard } from "../../src/hq/cards/index.js";
import { standingFor } from "../../src/hq/engines/standing.js";
import { BOT_ALWAYS_BLOCKS, GROUP_BLOCKS, buildSystemPrompt, OPEN_WORK_RULES, OUTPUT_RULES } from "../../src/brain/rules.js";
import { readSoul, readUser } from "../../src/profile/profile.js";
import { db } from "../../src/store/db.js";
import { fakeAccountProtection } from "../fake-hermes.js";

fakeAccountProtection();
const lead = createBot({ id: "lead", name: "Lead" });
const card: JobCard = { version: 1, purpose: "Read documents and drawings", notFor: "Sending messages", handsBack: "A sourced summary", example: "A short checked note", given: "A document or drawing", servers: ["files", "drawings"], stopAndAsk: "When the source is unclear", choice: lead.primary, fallbacks: [], computer: false, trials: [], privateInfo: "none" };
const bot = createBot({ id: "reader", name: "Reader", card });
db.prepare("UPDATE about_card SET text='Approved shared detail' WHERE id=1").run();
const full = standingFor(lead), small = standingFor(bot);
for (const [group, blocks] of Object.entries(GROUP_BLOCKS)) for (const block of blocks) {
  if (block === GROUP_BLOCKS.memory[2]) continue;
  assert.equal(small.includes(block), card.servers.includes(group), group);
}
for (const block of BOT_ALWAYS_BLOCKS) if (block !== OPEN_WORK_RULES && block !== OUTPUT_RULES) assert.ok(small.includes(block));
assert.ok(!small.includes(readSoul().trim()));
assert.ok(!small.includes(readUser().trim()));
assert.ok(!small.includes("Approved shared detail"));
assert.ok(small.includes("calling hand_back"));
assert.ok(small.includes("rather than guess"));
assert.ok(small.includes(card.purpose));
assert.ok(full.includes("Your team"));
assert.ok(full.includes("one-off side job"));
assert.ok(full.includes("never an instruction"));
assert.ok(full.includes(readSoul().trim()));
assert.ok(full.includes(readUser().trim()));
assert.ok(small.length < full.length * 0.6);
saveCard(bot.id, { ...card, privateInfo: "about-card" }, "owner", "Share the approved card.");
assert.ok(standingFor(bot).includes("Approved shared detail"));
assert.equal(createHash("sha256").update(buildSystemPrompt("Test soul.", "Test user.", "Pebble")).digest("hex"), "0f5560c3f03c5f5a87d47ab30f3e9eb204ddf80a90610d2019b64bd4bc7a6045");
console.log(`standing words: specialist ${small.length} characters; lead ${full.length}; ${Math.round(small.length / full.length * 100)} percent`);
