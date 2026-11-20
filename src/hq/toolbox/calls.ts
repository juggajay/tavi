import { audit } from "../../store/log.js";
import { noteOutsideRead } from "../../brain/turn.js";
import { noteSourceCall } from "../../brain/sourceLedger.js";
import { argumentSchema, toolsFor, type ToolboxTool } from "./tools.js";
import { botTurn } from "./turns.js";
import type { TurnLane } from "./lanes.js";

export type SafetyLevel = "open" | "paused" | "walled" | "killed";
export type ToolResult = Awaited<ReturnType<ToolboxTool["handler"]>>;
export const refused = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });
export const NO_TURN = "No request is in progress, so nothing was done.";
const switchedOff = (level: SafetyLevel) => refused(`The safety switch is on (${level}), so nothing was done.`);

/**
 * Hermes passes on at most four pictures from one tool result. A fifth reaches the model's service as a picture
 * that cannot be read: Claude refused the whole request ("invalid base64 data") part-way through a real job and
 * Hermes fell back to the other subscription (the owner's first night, a bot looking at six drawing sheets).
 * So a result keeps its first four pictures and says plainly that there were more.
 */
export const PICTURES_PER_RESULT = 4;
export function fourPictures(result: ToolResult): ToolResult {
  const parts = (result as { content?: unknown }).content;
  if (!Array.isArray(parts)) return result;
  let seen = 0, dropped = 0;
  const kept = parts.filter((p) => {
    if (!p || typeof p !== "object" || (p as { type?: unknown }).type !== "image") return true;
    seen++;
    if (seen <= PICTURES_PER_RESULT) return true;
    dropped++;
    return false;
  });
  if (!dropped) return result;
  kept.push({ type: "text", text: `(${dropped} more ${dropped === 1 ? "picture was" : "pictures were"} left out: only ${PICTURES_PER_RESULT} can be passed on at once. Ask again for just those, for example the next sheets, to see them.)` });
  return { ...result, content: kept } as ToolResult;
}

/** Check a call, run its existing tool, and check again before handing back the answer. */
export async function runTool(botId: string, server: string, name: string, args: unknown, level: () => SafetyLevel, lane: TurnLane = "chat"): Promise<ToolResult> {
  const started = Date.now();
  const ctx = botTurn(botId, lane);
  const fullName = `mcp__${server}__${name}`;
  let result: ToolResult = refused("That tool could not finish. Please try again.");
  try {
    const before = level();
    if (before !== "open") return (result = switchedOff(before));
    if (!ctx) return (result = refused(NO_TURN));
    const tool = toolsFor(ctx, server).find((t) => t.name === name);
    if (!tool) return (result = refused("That tool is not available here, so nothing was done."));
    const parsed = argumentSchema(tool.inputSchema).safeParse(args === undefined ? {} : args);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join(".") || "arguments";
      return (result = refused(`Please check the ${field} field and try again.`));
    }
    // WEB_GUARDS and CONNECTOR_GUARDS cover Claude's own tools. Hermes does not have those tools.
    noteOutsideRead(ctx, fullName);
    noteSourceCall(ctx, fullName, parsed.data);
    result = fourPictures(await tool.handler(parsed.data, {}));
    const after = level();
    if (after !== "open") result = switchedOff(after);
    else if (botTurn(botId, lane) !== ctx) result = refused(NO_TURN);
    return result;
  } catch (err) {
    // Do not put inputs, results or fault messages in the log: they may hold private words.
    // Keep only the stack's call sites, without the message that can contain a key or token.
    const heading = err instanceof Error ? `${err.name}: ${err.message}` : "";
    const stack = err instanceof Error && err.stack?.startsWith(heading)
      ? err.stack.slice(heading.length).split("\n").filter((line) => /^\s+at /.test(line)).join("\n")
      : "";
    console.error("A toolbox tool could not finish.", stack ?? "");
    const after = level();
    result = after !== "open" ? switchedOff(after) : refused("That tool could not finish. Please try again.");
    return result;
  } finally {
    // The log accepts any actor text, though its older type lists only the original actors.
    if (!ctx?.test) audit(`bot:${botId}` as Parameters<typeof audit>[0], "tool", fullName, { ok: !result.isError, ms: Date.now() - started });
  }
}
