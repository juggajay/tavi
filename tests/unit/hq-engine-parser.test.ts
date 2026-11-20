import "../isolate.js";
import assert from "node:assert/strict";
import { parseEngineChunks } from "../../src/hq/engines/parser.js";
import { resetTime } from "../../src/hq/engines/failures.js";
import { DEFAULT_CHOICES } from "../../src/hq/bots.js";
import { frame, scripts, completed } from "../fake-hermes.js";
import { SseDecoder } from "../../src/hq/engines/sse.js";

const choice = DEFAULT_CHOICES.anthropic;
for (const script of Object.values(scripts).filter((s): s is string => typeof s === "string")) {
  const bytes = Buffer.from(script);
  const expected = parseEngineChunks([bytes], choice);
  for (let split = 0; split <= bytes.length; split++) assert.deepEqual(parseEngineChunks([bytes.subarray(0, split), bytes.subarray(split)], choice), expected);
  assert.deepEqual(parseEngineChunks([...bytes].map((b) => Uint8Array.of(b)), choice), expected);
  assert.deepEqual(parseEngineChunks([script.replace(/\n/g, "\r\n")], choice), expected);
}
const plain = parseEngineChunks([scripts.plain], choice);
assert.deepEqual(plain, [ { type: "text", delta: "Ready ✨." }, { type: "usage", input: 8, output: 3, engine: choice }, { type: "done", text: "Ready ✨.", engine: choice } ]);
const tools = parseEngineChunks([scripts.tools], choice).filter((e) => e.type === "tool");
assert.equal(tools.length, 4);
assert.deepEqual(tools[0], { type: "tool", phase: "start", id: "a", name: "mcp__calc__sum", input: { a: 2 } });
assert.equal(tools[1].ok, true);
assert.equal(tools[3].ok, false);
const duplicate = scripts.tools.replace(frame("response.output_text.delta", { delta: "Two checks done." }), frame("response.output_item.added", { item: { type: "function_call_output", call_id: "a", output: "error: too late" } }));
assert.equal(parseEngineChunks([duplicate], choice).filter((e) => e.type === "tool").length, 4);
const commentary = parseEngineChunks([scripts.commentary], choice);
assert.equal(commentary.filter((e) => e.type === "status").length, 1);
assert.deepEqual(commentary.find((e) => e.type === "done"), { type: "done", text: "All checked.", engine: choice });
const latePhase = scripts.commentary.replace(',"phase":"commentary"', "");
const lateRows = parseEngineChunks([latePhase], choice);
assert.equal(lateRows.filter((e) => e.type === "status").length, 1);
assert.equal(lateRows.find((e) => e.type === "done")?.text, "All checked.");
const extras = parseEngineChunks([
  ": keepalive\n\nevent: odd\ndata: broken\n\ndata: [DONE]\n\n",
  frame("response.reasoning_summary_text.delta", { delta: "First" }), frame("response.reasoning_summary_part.delta", { delta: "Second" }),
  frame("response.reasoning_text.delta", { delta: "Third" }), frame("hermes.status", { text: "Reading" }),
  frame("unknown"), frame("response.output_item.done", { item: { type: "message", phase: "commentary", content: [{ text: "Still reading" }] } }),
  frame("response.output_item.done", { item: { type: "message", content: [{ text: "Done" }] } }), completed("Done"), scripts.plain,
], choice);
assert.deepEqual(extras.filter((e) => e.type === "thinking").map((e) => e.delta), ["First", "Second", "Third"]);
assert.deepEqual(extras.filter((e) => e.type === "status").map((e) => e.text), ["Reading", "Still reading"]);
assert.equal(extras.filter((e) => e.type === "done").length, 1);
const signed = parseEngineChunks([scripts.notSignedIn], choice);
assert.ok(signed.some((e) => e.type === "text"));
assert.ok(!signed.some((e) => e.type === "done"));
assert.equal(signed.at(-1)?.type, "failed");
assert.equal((signed.at(-1) as { reason: string }).reason, "not_signed_in");
for (const [message, reason] of [["not logged in", "not_signed_in"], ["please re-authenticate", "not_signed_in"], ["HTTP 401 from upstream", "not_signed_in"], ["quota reached", "limit"], ["429", "limit"], ["Something else", "error"]]) {
  assert.equal((parseEngineChunks([frame("response.failed", { response: { error: { message } } })], choice).at(-1) as { reason: string }).reason, reason);
}
assert.equal((parseEngineChunks([frame("response.cancelled")], choice).at(-1) as { reason: string }).reason, "stopped");
assert.equal(parseEngineChunks([scripts.cutOff], choice).filter((e) => e.type === "done").length, 0);
assert.equal(parseEngineChunks([completed("Whole answer")], choice).filter((e) => e.type === "text").length, 1);
const decoder = new SseDecoder();
assert.deepEqual(decoder.push("event: words\r\ndata: first\r\ndata: second\r\n\r\n"), [{ event: "words", data: "first\nsecond" }]);
assert.deepEqual(decoder.push("data: unfinished", true), []);
const now = Date.parse("2026-11-18T00:00:00Z");
assert.equal(resetTime("Retry in 2 minutes", null, now), "2026-11-18T00:02:00.000Z");
assert.equal(resetTime("resets at 2026-11-19T00:00:00Z", null, now), "2026-11-19T00:00:00.000Z");
assert.equal(resetTime("You've hit your weekly limit · resets Nov 19, 9pm (Australia/Sydney)", "Nov 19, 9pm", now), "2026-11-19T10:00:00.000Z");
assert.equal(resetTime("nothing", null, now), null);
console.log("engine stream reader: ok");
