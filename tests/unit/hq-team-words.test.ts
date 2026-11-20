import "../isolate.js";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildBotPrompt } from "../../src/hq/engines/standing.js";

const unwanted = new RegExp(["work" + "shop", "car" + "pent", "join" + "er", "tim" + "ber", "tra" + "die", "chi" + "sel", "site" + " shed"].join("|"), "i");
const walk = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(folder, entry.name);
  return entry.isDirectory() ? walk(file) : file.endsWith(".ts") ? [file] : [];
});
const root = path.resolve("src/hq");
const tests = readdirSync("tests/unit").filter((f) => /^hq-.*\.test\.ts$/.test(f)).map((f) => path.resolve("tests/unit", f));
for (const file of [...walk(root), ...tests]) assert.ok(!unwanted.test(readFileSync(file, "utf8")), `Use everyday words in ${path.relative(process.cwd(), file)}.`);
const prompt = buildBotPrompt("A calm assistant", "Lives in Australia", "Pebble");
assert.ok(prompt.includes("Tavi"));
assert.ok(!prompt.includes("Leading" + " Hand"));
console.log("Team words: everyday examples and Tavi in the bot's instructions pass.");
