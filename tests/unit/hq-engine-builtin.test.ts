import "../isolate.js";
import assert from "node:assert/strict";
import { BuiltinEngine } from "../../src/hq/engines/builtin.js";
import { configureEngines, engineFor, chatOnlyEngine } from "../../src/hq/engines/index.js";
import { createBot, DEFAULT_CHOICES } from "../../src/hq/bots.js";
import type { EngineEvent, SafetyLevel, TurnInput } from "../../src/hq/contract.js";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { fakeAccountProtection } from "../fake-hermes.js";

fakeAccountProtection();

const bot = createBot({ id: "builtin", name: "Builtin", engine: "builtin" });
const input: TurnInput = { text: "Hello", instructions: "Use plain words", conversation: "builtin-g0", choice: bot.primary };
let level: SafetyLevel = "open";
const listeners = new Set<() => void>();
const guard = { level: () => level, events: (on: () => void) => { listeners.add(on); return () => { listeners.delete(on); }; } };
let asked = 0;
const engine = new BuiltinEngine({ guard, ask: async (_request, opts) => {
  asked++;
  opts?.onProgress?.("Reading", "mcp__drawings__read_sheet");
  opts?.onSpoken?.("Hello"); opts?.onSpoken?.("Hello there.");
  return { spoken: "Hello there.", ms: 1, model: bot.primary.model };
} });
const collect = async (current = engine, signal = new AbortController().signal, request = input) => {
  const rows: EngineEvent[] = [];
  await current.run(bot, request, (e) => rows.push(e), signal);
  assert.equal(rows.filter((e) => e.type === "done" || e.type === "failed").length, 1);
  return rows;
};
assert.equal((await engine.ready(bot)).ok, true);
const rows = await collect();
assert.equal(asked, 1);
assert.equal(rows.filter((e) => e.type === "tool").length, 2);
assert.equal(rows.filter((e) => e.type === "text").map((e) => e.delta).join(""), "Hello there.");
assert.equal(rows.find((e) => e.type === "done")?.text, "Hello there.");
const calls: { prompt: string; options: Options }[] = [];
const chat = new BuiltinEngine({ guard, ask: async () => { throw new Error("The normal brain must not be called while walled off."); },
  query: ({ prompt, options }) => {
    calls.push({ prompt, options });
    return { async *[Symbol.asyncIterator]() {
      yield { type: "assistant", message: { content: [{ type: "text", text: "Chat only." }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "Chat only.", usage: { input_tokens: 3, output_tokens: 2 }, session_id: "chat" } as SDKMessage;
    } };
  },
});
level = "walled";
assert.equal((await chat.ready(bot)).ok, true);
assert.equal((await collect(chat)).find((e) => e.type === "done")?.text, "Chat only.");
const options = calls[0].options;
assert.deepEqual(options.tools, []); assert.deepEqual(options.mcpServers, {}); assert.deepEqual(options.allowedTools, []);
assert.deepEqual(options.settingSources, []); assert.deepEqual(options.disallowedTools, ["*"]); assert.equal(options.strictMcpConfig, true);
assert.equal((await options.canUseTool!("anything", {}, { signal: new AbortController().signal, toolUseID: "x", requestId: "test" }))?.behavior, "deny");
await collect(chat);
assert.ok(calls[1].prompt.includes("Bot: Chat only."), "chat remembers its own earlier answer without borrowing the tool session");
await collect(chat, new AbortController().signal, { ...input, conversation: "fresh" });
assert.ok(!calls[2].prompt.includes("Bot: Chat only."));
const otherProvider = await collect(chat, new AbortController().signal, { ...input, choice: DEFAULT_CHOICES.openai });
assert.equal(calls.at(-1)?.options.model, DEFAULT_CHOICES.anthropic.model);
assert.deepEqual(otherProvider.find((e) => e.type === "done")?.engine, DEFAULT_CHOICES.anthropic);
for (const stopped of ["paused", "killed"] as const) {
  level = stopped;
  assert.equal((await engine.ready(bot)).reason, "stopped");
  assert.equal((await collect()).find((e) => e.type === "failed")?.reason, "stopped");
}
level = "open";
const aborted = new AbortController(); aborted.abort();
assert.equal((await collect(engine, aborted.signal)).find((e) => e.type === "failed")?.reason, "stopped");
const error = new BuiltinEngine({ guard, ask: async () => { throw new Error("No credentials stored"); } });
assert.equal((await collect(error)).find((e) => e.type === "failed")?.reason, "not_signed_in");
const limited = new BuiltinEngine({ guard, ask: async () => { throw new Error("Usage limit reached"); } });
assert.equal((await collect(limited)).find((e) => e.type === "failed")?.reason, "limit");
const stopping = new BuiltinEngine({ guard, ask: async (_text, opts) => {
  await new Promise<void>((resolve) => { opts!.signal!.addEventListener("abort", () => resolve(), { once: true }); level = "walled"; for (const on of listeners) on(); });
  return { spoken: "Must not be said", ms: 1 };
} });
assert.equal((await collect(stopping)).find((e) => e.type === "failed")?.reason, "stopped");
configureEngines({ hermes: { guard: { level: guard.level, makeTeam: async () => ({ home: "" }), writeTeamFile: async () => {}, makeBot: async () => ({ home: "" }), writeBotFile: async () => {}, startProcess: async () => ({ kind: "gateway", state: "running", pid: 1, restarts: 0, startedAt: null }), stopProcess: async () => {} } }, builtin: { guard } });
assert.equal(engineFor(bot).kind, "builtin");
assert.equal(engineFor({ ...bot, engine: "hermes" }).kind, "hermes");
assert.equal(chatOnlyEngine().kind, "builtin");
assert.notEqual(chatOnlyEngine(), engineFor(bot));
console.log("built-in engine: ok");
