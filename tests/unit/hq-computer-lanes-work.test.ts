import "../isolate.js";
import assert from "node:assert/strict";
import { rig, until } from "./hq-api-fixture.test.js";
import type { Engine, TurnInput } from "../../src/hq/contract.js";
import { botTurn } from "../../src/hq/toolbox/turns.js";
import { getBot, toolboxToken } from "../../src/hq/bots.js";
import { twinName, twinSecret } from "../../src/hq/toolbox/lanes.js";
import { standingFor } from "../../src/hq/engines/standing.js";
import { createJob } from "../../src/store/jobs.js";
import { rowsOf } from "../../src/hq/rows.js";
import { memoryScope } from "../../src/memory/scope.js";
import { ScreenGuardClient } from "../../src/hq/screens/guard.js";
import type { ScreenPorts } from "../../src/guard/fence.js";

class Screens extends ScreenGuardClient {
  constructor() { super({} as ConstructorParameters<typeof ScreenGuardClient>[0]); }
  override async setPorts(ports: ScreenPorts) { return { applied: true, ports }; }
  override async prepare() {}
  override async fence() { return { applied: true, ports: null }; }
  override async drop() {}
}

const gates = new Map<string, () => void>();
const seen: { input: TurnInput; job: string; signal: AbortSignal }[] = [];
let repeat = false;
const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), async run(bot, input, on, signal) {
  const ctx = botTurn(bot.id, input.lane)!;
  assert.ok(ctx); assert.equal(ctx.bot, bot.id); assert.equal(ctx.turn.bot, bot.id);
  assert.equal(memoryScope(ctx), "bot:tim");
  seen.push({ input, job: ctx.turn.job_id!, signal });
  const work = input.conversation.includes("-work-");
  if (work) on({ type: "status", text: "Checking the second page" });
  if (work || input.text === "Hold this reply") await new Promise<void>((resolve) => {
    const finish = () => { gates.delete(ctx.turn.job_id!); signal.removeEventListener("abort", finish); resolve(); };
    gates.set(ctx.turn.job_id!, finish); signal.addEventListener("abort", finish, { once: true }); if (signal.aborted) finish();
  });
  if (signal.aborted) { on({ type: "failed", reason: "stopped", message: "Stopped." }); return; }
  on({ type: "usage", input: 10, output: 5, engine: input.choice });
  on({ type: "done", text: work ? repeat ? "One part is ready. [MORE]" : "The browser check is finished." : `Reply to ${input.text}`, engine: input.choice });
} };
const r = await rig(engine, { screenGuard: new Screens(), screenReady: async () => {} });
const bot = () => getBot("tim")!;
const ask = (text: string, via: "typed" | "voice" = "typed") => r.hq.answer(text, { bot: "tim", via, origin: { kind: "voice" } });
function work(title: string, signal?: AbortSignal) {
  const id = createJob("task", title, title);
  return { id, done: r.hq.work("tim", { id, title, brief: title, origin: null }, signal) };
}
async function tool(address: string, token: string, server: string, line: string) {
  const response = await fetch(`${r.hq.trialState().toolboxAddress}/mcp/${address}/${server}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "progress", arguments: { now: line } } }),
  });
  return { status: response.status, text: await response.text() };
}
try {
  await r.hq.setComputer("tim", true); await r.hq.ensure(bot());
  await ask("Remember the blue heading");
  assert.equal(seen.at(-1)!.input.lane, "chat");
  repeat = true;
  const first = work("Check public dates in the browser"); await until(() => gates.has(first.id));
  assert.equal(seen.at(-1)!.input.lane, "chat");
  assert.ok(botTurn("tim")!.background);
  const second = work("Check another date");
  for (const via of ["typed", "voice"] as const) {
    const reply = await ask(`How is it going by ${via}?`, via);
    assert.equal(reply.ok, true); assert.ok(gates.has(first.id)); assert.ok(!gates.has(second.id));
    const input = seen.at(-1)!.input;
    assert.equal(input.lane, "work");
    assert.match(input.instructions, /Remember the blue heading/);
    assert.match(input.instructions, /Reply to Remember the blue heading/);
    assert.match(input.instructions, /Check public dates in the browser/);
    assert.match(input.instructions, /Checking the second page/);
    assert.match(input.instructions, /computer is busy/);
  }
  await ask("Open another page on your computer");
  assert.equal(seen.at(-1)!.input.lane, "work");
  assert.equal(seen.filter((s) => s.input.conversation.includes("-work-")).length, 1);
  assert.match(standingFor(bot()), /offer to do it when the job finishes or stop the job first/);
  const held = ask("Hold this reply"); await until(() => !!botTurn("tim", "work"));
  const chatId = botTurn("tim", "work")!.turn.job_id!;
  assert.notEqual(botTurn("tim"), botTurn("tim", "work"));
  assert.equal((await tool("tim", toolboxToken("tim"), "actions", "Job progress only")).status, 200);
  assert.equal((await tool(twinName("tim"), twinSecret("tim", "toolbox-token")!, "actions", "Reply progress only")).status, 200);
  assert.equal(r.hq.turns.live("tim").doing, "Reply progress only");
  assert.equal(r.hq.turns.live("tim").work?.find((w) => w.id === first.id)?.doing, "Job progress only");
  assert.equal((await tool(twinName("tim"), twinSecret("tim", "toolbox-token")!, "computers", "Cannot drive the computer")).status, 404);
  gates.get(chatId)!(); await held;
  gates.get(first.id)!();
  await until(() => seen.filter((s) => s.job === first.id).length === 2);
  assert.match(seen.at(-1)!.input.instructions, /Reply to How is it going by voice/);
  repeat = false; gates.get(first.id)!(); await first.done;
  await until(() => gates.has(second.id)); gates.get(second.id)!(); await second.done;
  assert.equal(rowsOf("tim", bot().generation).filter((r) => r.body.kind === "message" && r.body.text === "The browser check is finished.").length, 2);
  await ask("What did we say meanwhile?");
  assert.equal(seen.at(-1)!.input.lane, "chat");
  assert.match(seen.at(-1)!.input.instructions, /Reply to How is it going by voice/);
  assert.match(seen.at(-1)!.input.instructions, /Reply to Open another page on your computer/);
  assert.equal(r.hq.turns.usage("tim").today[bot().primary.provider]?.input, seen.length * 10);

  const controller = new AbortController();
  const cancelled = work("Stop only the job", controller.signal); await until(() => gates.has(cancelled.id));
  const chat = ask("Hold this reply"); await until(() => !!botTurn("tim", "work"));
  const heldId = botTurn("tim", "work")!.turn.job_id!;
  controller.abort(); await cancelled.done;
  assert.equal(seen.find((s) => s.job === heldId)!.signal.aborted, false);
  gates.get(heldId)!(); await chat;
  for (const stop of ["bot", "paused", "walled", "killed"] as const) {
    const running = work("Stopping both places"); await until(() => gates.has(running.id));
    const answering = ask("Hold this reply"); await until(() => !!botTurn("tim", "work"));
    const replyId = botTurn("tim", "work")!.turn.job_id!;
    if (stop === "bot") r.hq.stopBot("tim");
    else await r.request("/safety", "POST", { level: stop });
    await running.done; await answering;
    assert.equal(seen.find((s) => s.job === running.id)!.signal.aborted, true);
    assert.equal(seen.find((s) => s.job === replyId)!.signal.aborted, true);
    assert.equal(botTurn("tim"), null); assert.equal(botTurn("tim", "work"), null);
    if (stop !== "bot") { await r.request("/safety", "POST", { level: "open", pin: "1357" }); await until(() => r.guard.level() === "open"); }
  }
  console.log("Computer work keeps running while typed and spoken replies share the conversation, tools stay apart, queued work waits and stopping reaches the right requests.");
} finally { for (const release of gates.values()) release(); await r.close(); }
