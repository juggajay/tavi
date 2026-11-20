// While the owner has taken the browser over (Stage 15.2), the assistant does nothing and sees nothing. These hooks sit
// beside the guard's (guard.ts, unchanged) on every browser tool call of a job:
// - Before a call: while he's driving, it waits (it isn't refused, so the job doesn't flail); once he hands back, any
//   step it had lined up is refused until it has looked at the page again, because the page may have changed under it.
// - After a call: a result that overlapped his turn (started before he took over, finished after) is withheld whole, so
//   no picture, page text or anything he typed reaches the model. Console messages and events from his turn are dropped
//   from the first result after he hands back.
// - Text on a page aimed at the assistant ("ignore your instructions", "AI agents must...") is noted for the pane; the
//   guard's rules hold whatever the page says.
import type { HookCallbackMatcher, HookJSONOutput, PostToolUseHookInput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, rmSync } from "node:fs";
import type { Host } from "./host.js";

/** What the model is told instead of a result that overlapped his turn. */
export const WITHHELD = "The owner took over the browser while this was running, so its result is withheld. Take a fresh browser_snapshot to see the page as it is now.";
const FRESH = "The owner has just handed the browser back and the page may have changed. Take a fresh browser_snapshot first, then carry on.";
// Looking, not acting: allowed straight after a hand-back.
const LOOKS = new Set(["browser_snapshot", "browser_take_screenshot", "browser_tabs", "browser_wait_for"]);

/** Text on a page that is talking to an AI rather than to a person: noted (never obeyed). */
const AIMED = [
  /\bignore (all |any |your |the )?(previous|prior|earlier|above|other) (instructions|prompts?|directions)\b/i,
  /\bdisregard (all |any |your |the )?(previous|prior|earlier|above) /i,
  /\b(ai|llm|language model|automated|browser) (assistant|agent|model)s?\b[^.\n]{0,80}\b(must|should|need to|are required to|are instructed to)\b/i,
  /\b(attention|note to|message (to|for)|instructions? (to|for)) (the )?(ai|llm|assistant|agent|bot)\b/i,
  /\bnew (system )?instructions?\s*:/i,
  /\bsystem prompt\b/i,
];

/** A few words of the line on the page that's talking to the assistant, or null. */
export function aimedAtAssistant(text: string): string | null {
  for (const line of text.split(/\n/)) {
    const clean = line.replace(/^\s*-\s*/, "").replace(/\[ref=e\d+\]/g, "").replace(/\s+/g, " ").trim();
    if (AIMED.some((re) => re.test(clean))) {
      const said = clean.replace(/^(paragraph|text|generic|heading[^:]*|strong|emphasis|listitem|cell)\s*:?\s*/i, "").replace(/^"|"$/g, "");
      return said.length > 90 ? `${said.slice(0, 89).trimEnd()}…` : said;
    }
  }
  return null;
}

/** The text of a tool result (MCP content), as the model would get it. */
const textOf = (r: unknown) =>
  JSON.stringify(r ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");

/** Drop the sections that report what happened in the page since the last step (console, events): his turn's, here. */
export function withoutEvents(r: unknown): unknown {
  const strip = (t: string) => t.replace(/### (New console messages|Events|Console messages)[\s\S]*?(?=\n### |$)/g, "");
  if (typeof r === "string") return strip(r);
  if (Array.isArray(r)) return r.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? { ...c, text: strip(String((c as { text?: unknown }).text ?? "")) } : c));
  if (r && typeof r === "object" && Array.isArray((r as { content?: unknown }).content)) return { ...(r as object), content: withoutEvents((r as { content: unknown[] }).content) };
  return r;
}

/** How a step reads in the pane, in plain words: never what's typed. */
export function describeStep(short: string, a: Record<string, unknown>): string | null {
  const el = String(a.element ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  switch (short) {
    case "browser_navigate":
      try {
        return `Opening ${new URL(String(a.url)).hostname.replace(/^www\./, "")}`;
      } catch {
        return "Opening a page";
      }
    case "browser_navigate_back":
      return "Going back a page";
    case "browser_snapshot":
      return "Reading the page";
    case "browser_take_screenshot":
      return "Taking a picture of the page";
    case "browser_find":
      return "Looking for something on the page";
    case "browser_click":
      return el ? `Clicking “${el}”` : "Clicking";
    case "browser_type":
    case "browser_fill_form":
      return el ? `Filling in “${el}”` : "Filling in the form";
    case "browser_select_option":
      return el ? `Choosing in “${el}”` : "Choosing an option";
    case "browser_press_key":
      return "Pressing a key";
    case "browser_hover":
      return "Pointing at something";
    case "browser_wait_for":
      return "Waiting for the page";
    case "browser_tabs":
      return "Switching tabs";
    case "browser_handle_dialog":
      return "Answering a pop-up";
    default:
      return null;
  }
}

type Hooks = { PreToolUse: HookCallbackMatcher[]; PostToolUse: HookCallbackMatcher[] };
/** A copy of a page the browser tools wrote for the guard: gone once the guard has read it, so nothing typed stays on disk. */
function drop(file: string | undefined) {
  if (file && /[\\/]browser[\\/]jobs[\\/][^\\/]+[\\/]page-[^\\/]+\.yml$/.test(file)) rmSync(file, { force: true });
}
/** Every copy of these values (what's in the password boxes) blanked out of a result. */
export function redact(r: unknown, secrets: string[]): unknown {
  const blank = (t: string) => secrets.reduce((acc, v) => acc.split(v).join("••••••"), t);
  if (typeof r === "string") return blank(r);
  if (Array.isArray(r)) return r.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? { ...c, text: blank(String((c as { text?: unknown }).text ?? "")) } : c));
  if (r && typeof r === "object" && Array.isArray((r as { content?: unknown }).content)) return { ...(r as object), content: redact((r as { content: unknown[] }).content, secrets) };
  return r;
}
const denied = (r: HookJSONOutput | undefined) => (r as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput?.permissionDecision === "deny";

/**
 * The guard's hooks (unchanged, and every one still runs) with the take-over rules around them. The guard's check runs
 * after any wait, so it judges the page as it is once he's handed back. Its PostToolUse hooks run as they always did,
 * first, except on a result withheld from his turn (the page as it was while he drove isn't learned from).
 */
export function takeoverHooks(host: Host, guard: Hooks): { PreToolUse: HookCallbackMatcher[]; PostToolUse: HookCallbackMatcher[]; PostToolUseFailure: HookCallbackMatcher[] } {
  const guardPre = async (input: PreToolUseHookInput, id: string | undefined, opts: { signal: AbortSignal }): Promise<HookJSONOutput> => {
    let last: HookJSONOutput = {};
    for (const m of guard.PreToolUse)
      if (!m.matcher || new RegExp(m.matcher).test(input.tool_name))
        for (const h of m.hooks) {
          const r = await h(input, id, opts);
          if (denied(r)) return r;
          last = r ?? {};
        }
    return last;
  };
  const startedAt = new Map<string, number>(); // tool call → the take-over count when it started
  let lookedAt = 0; // the take-over count when it last looked at the page
  let lastResult = 0; // the take-over count at the last result it was given
  return {
    PreToolUse: [
      {
        matcher: "^mcp__browser__",
        timeout: 60 * 60, // a take-over can take a while; the call waits through it
        onFailure: "block",
        hooks: [
          async (input, toolUseID, { signal }) => {
            const { tool_name, tool_input } = input as PreToolUseHookInput;
            const short = tool_name.replace("mcp__browser__", "");
            const deny = (why: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: why } });
            if (host.stopped) return deny("Stopped.");
            if (host.view.takeover !== "off") await host.whenFree(signal);
            if (host.stopped || signal.aborted) return deny("Stopped.");
            if (host.epoch !== lookedAt && !LOOKS.has(short)) return deny(FRESH);
            const verdict = await guardPre(input as PreToolUseHookInput, toolUseID, { signal });
            if (denied(verdict)) return verdict;
            if (host.stopped || host.view.takeover !== "off") return deny(host.stopped ? "Stopped." : FRESH); // he took it while the guard looked
            startedAt.set(toolUseID ?? "", host.epoch);
            host.inflight++;
            const said = describeStep(short, (tool_input ?? {}) as Record<string, unknown>);
            if (said) host.doing(said);
            return verdict;
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "^mcp__browser__",
        hooks: [
          async (input, toolUseID, opts) => {
            const { tool_name, tool_response } = input as PostToolUseHookInput;
            const short = tool_name.replace("mcp__browser__", "");
            const began = startedAt.get(toolUseID ?? "");
            startedAt.delete(toolUseID ?? "");
            host.inflight = Math.max(0, host.inflight - 1);
            const replace = (out: unknown) => ({ hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: out, updatedMCPToolOutput: out } });
            const pageFile = /\[Snapshot\]\(([^)]+[\\/]page-[^)\\/]+\.yml)\)/.exec(textOf(tool_response))?.[1];
            // overlapped his turn (or he's driving now): nothing from it goes to the model, or to the guard's notes
            if (began === undefined || began !== host.epoch || host.view.takeover !== "off") {
              drop(pageFile);
              return replace([{ type: "text", text: WITHHELD }]);
            }
            // the guard learns the page first (its hooks, unchanged, in their order); then the copy of the page goes
            for (const m of guard.PostToolUse) if (!m.matcher || new RegExp(m.matcher).test(tool_name)) for (const h of m.hooks) await h(input, toolUseID, opts);
            let seen = textOf(tool_response);
            if (pageFile) {
              try {
                seen += `\n${readFileSync(pageFile, "utf8")}`;
              } catch {
                /* already gone */
              }
              drop(pageFile);
            }
            if (short === "browser_snapshot" || short === "browser_take_screenshot") lookedAt = host.epoch;
            const aimed = aimedAtAssistant(seen);
            if (aimed) host.note(`This page said: “${aimed}” I ignored it.`);
            // what's in a password box is never shown to the model, whoever typed it
            const secrets = (await host.secrets()).filter((v) => seen.includes(v));
            // the first result since he had it: what the page logged while he drove stays out
            const since = lastResult !== host.epoch;
            lastResult = host.epoch;
            if (!secrets.length && !since) return {};
            let out: unknown = since ? withoutEvents(tool_response) : tool_response;
            if (secrets.length) out = redact(out, secrets);
            return replace(out);
          },
        ],
      },
    ],
    // a step that failed: it's finished, so a take-over needn't wait for it
    PostToolUseFailure: [
      {
        matcher: "^mcp__browser__",
        hooks: [
          async (_input, toolUseID) => {
            if (startedAt.delete(toolUseID ?? "")) host.inflight = Math.max(0, host.inflight - 1);
            return {};
          },
        ],
      },
    ],
  };
}
