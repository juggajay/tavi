// A stand-in for the Codex program (Stage 17 tests): answers in Codex's JSON-lines format and records how it was run.
//   FAKE_CODEX_LOG   a file: one JSON line per run ({ args, cwd, prompt, env })
//   FAKE_CODEX_MODE  how to answer: "" (a short echo), slow, tool, signedout, lost, agree, long, against, fail
// Never reads or writes anything else.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? "";
const log = (o) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(o) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args[0] === "archive") {
  log({ args, cwd: process.cwd(), prompt: null, env: Object.keys(process.env).sort() });
  process.stdout.write(`Archived session ${args[1]}.\n`);
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  log({ args, cwd: process.cwd(), prompt, env: Object.keys(process.env).sort() });
  const r = args.indexOf("resume");
  const resumed = r >= 0 ? args[r + 1] : null;
  if (mode === "signedout") {
    process.stderr.write("Error: not logged in. Run `codex login` to sign in.\n");
    process.exit(1);
  }
  if (mode === "fail") {
    out({ type: "turn.failed", error: { message: "model overloaded" } });
    process.exit(1);
  }
  if (mode === "lost" && resumed) {
    process.stderr.write(`Error: no conversation found for session ${resumed}\n`);
    process.exit(1);
  }
  const thread = resumed ?? `fake-${randomUUID()}`;
  out({ type: "thread.started", thread_id: thread });
  out({ type: "turn.started" });
  if (mode === "slow") await new Promise((res) => setTimeout(res, 8000));
  if (mode === "tool") out({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "dir", status: "completed" } });
  const chair = /The chair: (.*)$/m.exec(prompt)?.[1] ?? "";
  const lastLine = prompt.split("\n").filter((l) => /^(Owner|Pebble|[A-Z][a-z]+): /.test(l)).pop() ?? "";
  let text = `Fair enough, but I'd want the cost pinned down first. (${chair.slice(0, 40)})`;
  // "demo": the lines a guest might really say, for the screens' pictures (made up)
  const DEMO = {
    first: "I'd hire one for a month first and count the days it's actually out. If it's most days, buy. If not, you've kept the cash.",
    respond: "Fair on the cash, but don't forget the racks and tool boxes. Fitting out a hire ute every time costs you half a morning.",
    answer: "I'd want to see the last three months of jobs first. Count the days the second crew sat waiting on a vehicle.",
    against: "I'm playing devil's advocate: a second ute costs you every month, busy or not. Until the work's steady, that money's safer in the bank.",
    again: "Then lease rather than buy, so you're not stuck with it if the work dries up.",
  };
  const task = /just been brought in/.test(chair) ? "first" : /devil's advocate/.test(chair) ? "against" : /asked you directly/.test(chair) ? "answer" : /your turn again/.test(chair) ? "again" : "respond";
  if (mode === "demo") text = DEMO[task];
  else if (mode === "agree") text = "I agree, nothing to add.";
  else if (mode === "long") text = "One. Two. Three. Four. Five. Six. Seven. Eight. That is far too many sentences for one turn at a table.";
  else if (mode === "against" || /devil's advocate/.test(chair)) text = "I'm playing devil's advocate here: it costs more than it saves. Think about the hire first.";
  else if (/too long/.test(chair)) text = "Shorter: it costs more than it saves.";
  else if (lastLine) text = `On that last point: ${lastLine.slice(0, 60)}. I'd check the cost first.`;
  out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
  out({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } });
  process.exit(0);
});
