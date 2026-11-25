import "../isolate.js";
import assert from "node:assert/strict";
import { fakeAccountProtection } from "../fake-hermes.js";
import { createBot, getBot } from "../../src/hq/bots.js";
import { installLooks } from "../../src/hq/toolbox/looks.js";
import { tryFastPath } from "../../src/gateway/fastpath.js";
import { getSettings } from "../../src/store/settings.js";

fakeAccountProtection();
const lead = createBot({ id: "pebble", name: "Pebble" });
const other = createBot({ id: "ruvo", name: "Ruvo", look: { shape: "moon", colour: "pink" } });
const changed: string[] = [];
const off = installLooks({ changed: bot => changed.push(bot.id) });
try {
  delete process.env.LH_V3;
  assert.match((await tryFastPath("go blue", null, null))!.spoken, /until tomorrow/);
  assert.equal(getSettings()["ui.colour_override"]!.colour, "blue");
  assert.deepEqual(getBot(lead.id)!.look, lead.look);
  assert.match((await tryFastPath("back to normal", null, null))!.did, /normal/);
  const before = getSettings()["ui.colour_override"];
  process.env.LH_V3 = "1";
  assert.match((await tryFastPath("go blue", null, null, other.id))!.spoken, /keep this look/);
  assert.deepEqual(getBot(other.id)!.look, { shape: "moon", colour: "blue" });
  assert.match((await tryFastPath("turn green for today", null, null, other.id))!.spoken, /Green/);
  assert.deepEqual(getBot(other.id)!.look, { shape: "moon", colour: "green" });
  assert.deepEqual(getBot(lead.id)!.look, lead.look);
  assert.deepEqual(getSettings()["ui.colour_override"], before);
  assert.equal(await tryFastPath("back to normal", null, null, other.id), null);
  assert.equal(await tryFastPath("go blue", null, null), null);
  assert.equal(await tryFastPath("go invisible", null, null, other.id), null);
  assert.deepEqual(changed, [other.id, other.id]);
  console.log("Spoken colour changes follow the bot on the call; earlier colour commands keep their earlier behaviour.");
} finally { off(); delete process.env.LH_V3; }
