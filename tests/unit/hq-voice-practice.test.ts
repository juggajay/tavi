import "../isolate.js";
import assert from "node:assert/strict";
import path from "node:path";

// The key reader is replaced here; this test never opens a real key file.
const script = "../../scripts/v3-dev.mjs";
const { voiceSettings } = await import(script);
const read: string[] = [];
const reader = (file: string) => { read.push(file); return Buffer.from("OPENAI_API_KEY=made-up-test-key\n"); };
assert.equal(voiceSettings([], {}, reader).LH_NO_VOICE, "1");
assert.equal(read.length, 0);
const voice = voiceSettings(["--voice"], { LH_V3_ENV: path.resolve("practice-key-file") }, reader);
assert.equal(voice.LH_NO_VOICE, "0");
assert.equal(voice.OPENAI_API_KEY, "made-up-test-key");
assert.equal(read[0], path.resolve("practice-key-file"));
assert.throws(() => voiceSettings(["--voice"], {}, () => Buffer.from("")), /No voice key/);
console.log("hq-voice-practice: voice is off by default and uses the chosen key file only when asked");
