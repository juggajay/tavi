// Quick check of the brain without voice: npm run brain:test -- "your question"
import { think } from "./brain.js";

const question = process.argv.slice(2).join(" ") || "What's the fire rating and hardware on door D2.14?";
console.log(`> ${question}`);
const res = await think(question, { onProgress: (l) => console.log(`  … ${l}`) });
console.log(JSON.stringify(res, null, 2));
const again = await think("And what about D2.13?", { onProgress: (l) => console.log(`  … ${l}`) });
console.log(`second (warm) answer in ${again.ms} ms: ${again.spoken}`);
process.exit(0);
