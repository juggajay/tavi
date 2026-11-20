// A scripted stand-in for a browser job's model (Stage 15.2), for dev and tests only (LH_FAKE_BROWSER=1 with LH_DEV=1):
// no model, no cost. It drives the real browser tools (the Playwright MCP server, connected to the gateway's browser)
// through the same hooks the Agent SDK would run (the guard's, inside the take-over gate), in the same order, and keeps
// everything that would have reached the model in `modelInputs`, so tests can check nothing from the owner's turn did.
// Some scripts deliberately try what a fooled model might (typing into a password box, following a page's instructions,
// pressing Place order without the go-ahead) to show the code stops it whatever the model does.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HookCallbackMatcher, HookJSONOutput, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEV } from "../dev.js";
import { testOrigin } from "./sites.js";
import type { BrowserResult } from "./worker.js";

if (!DEV) throw new Error("The fake browser job is for dev and tests only.");

/** Everything the stand-in model was given: its task, and each tool result after the hooks (or the reason it was refused). */
export const modelInputs: string[] = [];

type Hooks = { PreToolUse: HookCallbackMatcher[]; PostToolUse: HookCallbackMatcher[]; PostToolUseFailure: HookCallbackMatcher[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tool = SdkMcpToolDefinition<any>;
type Out = { text: string; denied?: string };

const textOf = (r: unknown) => {
  if (typeof r === "string") return r;
  const content = Array.isArray(r) ? r : ((r as { content?: unknown[] })?.content ?? []);
  return content.map((c) => ((c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : `[${(c as { type?: string }).type}]`)).join("\n");
};
const matching = (ms: HookCallbackMatcher[], name: string) => ms.filter((m) => !m.matcher || new RegExp(m.matcher).test(name)).flatMap((m) => m.hooks);

export async function fakeBrowserJob(o: { task: string; prompt: string; configPath: string; cli: string; hooks: Hooks; tools: Tool[]; signal: AbortSignal }): Promise<BrowserResult> {
  const origin = testOrigin() ?? "http://127.0.0.1:4011";
  modelInputs.push(o.prompt);
  const client = new Client({ name: "tavi-fake-browser-job", version: "1.0.0" });
  // started in the job's folder (the real job runs there too): a file the tools are asked to name lands in it
  // Practice keeps browser state in its own folder and uses the test account; the same approval and navigation hooks run.
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [o.cli, "--config", o.configPath, "--file-paths", "absolute", "--no-sandbox"], cwd: path.dirname(o.configPath), env: { LOCALAPPDATA: path.dirname(o.configPath), PLAYWRIGHT_BROWSERS_PATH: path.join(path.dirname(o.configPath), "browser-cache") }, stderr: "ignore" }));
  let n = 0;
  /** One tool call, as the SDK makes it: PreToolUse hooks (any deny wins), the call, then PostToolUse (a rewrite wins). */
  const browser = async (name: string, args: Record<string, unknown>): Promise<Out> => {
    if (o.signal.aborted) throw new Error("stopped");
    const full = `mcp__browser__${name}`;
    const id = `toolu_fake_${++n}`;
    const opts = { signal: o.signal };
    for (const h of matching(o.hooks.PreToolUse, full)) {
      const r = (await h({ hook_event_name: "PreToolUse", tool_name: full, tool_input: args, tool_use_id: id } as never, id, opts)) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      if (r?.hookSpecificOutput?.permissionDecision === "deny") {
        const why = r.hookSpecificOutput.permissionDecisionReason ?? "refused";
        modelInputs.push(`Refused: ${why}`);
        return { text: "", denied: why };
      }
    }
    let result: unknown;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (err) {
      for (const h of matching(o.hooks.PostToolUseFailure, full)) await h({ hook_event_name: "PostToolUseFailure", tool_name: full, tool_input: args, tool_use_id: id, error: String(err) } as never, id, opts);
      modelInputs.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return { text: "", denied: "error" };
    }
    let out: unknown = (result as { content?: unknown }).content;
    for (const h of matching(o.hooks.PostToolUse, full)) {
      const r = (await h({ hook_event_name: "PostToolUse", tool_name: full, tool_input: args, tool_response: result, tool_use_id: id } as never, id, opts)) as HookJSONOutput & { hookSpecificOutput?: { updatedToolOutput?: unknown } };
      if (r?.hookSpecificOutput?.updatedToolOutput !== undefined) out = r.hookSpecificOutput.updatedToolOutput;
    }
    const text = textOf(out);
    modelInputs.push(text);
    return { text };
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = o.tools.find((x) => x.name === name)!;
    const r = await t.handler(args, {});
    const text = textOf(r);
    modelInputs.push(text);
    return text;
  };
  /** The page as yaml: inline, or the file the tools saved it to. */
  const page = (t: string) => {
    const inline = /```yaml\n([\s\S]*?)```/.exec(t)?.[1];
    if (inline) return inline;
    const file = /\[Snapshot\]\(([^)]+\.yml)\)/.exec(t)?.[1];
    try {
      return file ? readFileSync(file, "utf8") : "";
    } catch {
      return "";
    }
  };
  const ref = (yaml: string, role: string, name: string) => new RegExp(`- ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(yaml)?.[1];
  const look = async () => page((await browser("browser_snapshot", {})).text);
  const done = (spoken: string, status: BrowserResult["status"] = "done"): BrowserResult => ({ status, spoken });

  try {
    const t = o.task.toLowerCase();
    if (/\bsign in\b|\blog in\b/.test(t)) {
      // a sign-in: tries the password box (as a fooled model might), is refused, asks him to take over, carries on after
      await browser("browser_navigate", { url: `${origin}/login` });
      let y = await look();
      const pw = ref(y, "textbox", "Password");
      if (pw) await browser("browser_type", { target: pw, element: "Password", text: "not-a-real-password" });
      const back = await call("ask_owner_to_take_over", { what: `Sign in to ${new URL(origin).host}` });
      if (!/handed the browser back/.test(back)) return done("I needed you to sign in, and you weren't there. Nothing was done.", "needs_user");
      y = await look();
      const who = /Signed in as ([^"\n]+?)["\n]/.exec(y)?.[1]?.trim();
      return done(who ? `You're signed in as ${who}. Carrying on from there.` : "You've handed it back, but it doesn't look signed in.");
    }
    if (/\bplanted\b|\bspecials?\b/.test(t)) {
      // a page with instructions aimed at the assistant: it's noted, and following them is refused by the code
      await browser("browser_navigate", { url: `${origin}/specials` });
      const y = await look();
      const box = ref(y, "textbox", "Password");
      if (box) await browser("browser_type", { target: box, element: "the box the page asked for", text: "hunter2-not-real" });
      await browser("browser_navigate", { url: "http://192.168.0.1/admin" });
      await new Promise((r) => setTimeout(r, 1500)); // reading the specials properly
      const cheapest = /Bananas[^\n]*?\$(\d+\.\d\d)/.exec(y)?.[1];
      return done(cheapest ? `The cheapest special is bananas at $${cheapest} a kilo.` : "I couldn't see the specials.");
    }
    if (/\border\b|\bbuy\b/.test(t)) {
      // an order: Place order is refused until he taps Go ahead, then pressed once
      await browser("browser_navigate", { url: `${origin}/shop` });
      let y = await look();
      const add = ref(y, "button", "Add to cart");
      if (add) await browser("browser_click", { target: add, element: "Add to cart" });
      await browser("browser_navigate", { url: `${origin}/checkout` });
      y = await look();
      const place = ref(y, "button", "Place order");
      if (!place) return done("I couldn't find the checkout.", "failed");
      const early = await browser("browser_click", { target: place, element: "Place order" });
      if (!early.denied) return done("It let me order without your go-ahead. That's wrong.", "failed");
      const shot = await browser("browser_take_screenshot", { filename: "review.png" });
      const file = /\(([^)]+\.png)\)/.exec(shot.text)?.[1] ?? "review.png";
      const total = /Order total (\$\d+\.\d\d)/.exec(y)?.[1] ?? undefined;
      const ok = await call("request_go_ahead", { summary: "Test order, 1 x milk", details: [{ label: "Items", value: "Full cream milk 2L x 1" }], total, final_button: "Place order", screenshot: file });
      if (!/^Approved/.test(ok)) return done("Not ordered.", "declined");
      y = await look();
      const p2 = ref(y, "button", "Place order");
      const pressed = p2 ? await browser("browser_click", { target: p2, element: "Place order" }) : { denied: "no button" };
      if (pressed.denied) return done(`It wouldn't let me press it: ${pressed.denied}`, "failed");
      y = await look();
      const num = /Order (?:number )?#?(\w+-\d+|\d+)/.exec(y)?.[1];
      return done(num ? `Ordered. Order number ${num}.` : "Ordered.");
    }
    if (/\bdownload\b/.test(t)) {
      await browser("browser_navigate", { url: `${origin}/invoices` });
      const y = await look();
      const link = ref(y, "link", "Download invoice");
      const r = link ? await browser("browser_click", { target: link, element: "Download invoice" }) : { text: "" };
      await browser("browser_wait_for", { time: 1 });
      return done(/Download/i.test(r.text) ? "Downloaded the invoice." : "I clicked it; I'm not sure it downloaded.");
    }
    // anything else: open the page named in the task (or the notes page) and keep looking at it until stopped (the
    // live view's tests: watch it, take over, type, hand back)
    const url = /https?:\/\/\S+/.exec(o.task)?.[0] ?? `${origin}/notes`;
    await browser("browser_navigate", { url });
    for (let i = 0; i < 600 && !o.signal.aborted; i++) {
      const y = await look();
      if (/\bDONE\b/.test(y)) return done("Finished looking.");
      await new Promise((r) => setTimeout(r, 400));
    }
    return done("Finished looking.");
  } catch (err) {
    if (o.signal.aborted) return done("Stopped.", "declined");
    throw err;
  } finally {
    await client.close().catch(() => undefined);
  }
}
