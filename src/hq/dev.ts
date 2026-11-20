import { isAgentRequest } from "../browser/sites.js";
// The trial uses the same running server, with a separate, read-only comparison route.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Hq } from "./hq.js";
import type { BackgroundResult } from "../brain/brain.js";
import { leadBot } from "./bots.js";
import { adequacyClaim, RESAY, withoutClaimSentences } from "../brain/claims.js";

export async function runRoutineTurn(hq: Hq, task: string): Promise<BackgroundResult> {
  const started = Date.now();
  const result = await new Promise<import("./turns/index.js").TurnResult>((resolve) => hq.ask(leadBot()!.id, {
    text: task, via: "routine", background: true, origin: { kind: "routine" }, onDone: resolve,
  }));
  if (!result.ok) throw new Error(result.text);
  return { notify: true, title: "Team update", spoken: result.spoken, priority: "normal", ms: Date.now() - started };
}

export async function handleTrial(req: IncomingMessage, res: ServerResponse, url: URL,
  checks: { isLocal(req: IncomingMessage): boolean; sameOrigin(req: IncomingMessage): boolean }, hq?: Hq) {
  if (!["/api/hq-trial/builtin", "/api/hq-trial/state", "/api/hq-trial/ensure"].includes(url.pathname)) return false;
  const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  if (process.env.LH_DEV !== "1" || process.env.LH_V3 !== "1" || !checks.isLocal(req) || !checks.sameOrigin(req) || isAgentRequest(req.headers)) {
    send(403, { error: "The comparison is only available on the development PC." }); return true;
  }
  if (url.pathname === "/api/hq-trial/state" && req.method === "GET") { send(200, hq?.trialState() ?? {}); return true; }
  if (url.pathname === "/api/hq-trial/ensure" && req.method === "POST") {
    if (!hq) send(503, { error: "The team is not available." });
    else { const bot = leadBot()!; hq.ensure(bot); send(202, { ok: true }); }
    return true;
  }
  if (req.method !== "POST") { send(405, { error: "Send a test message here." }); return true; }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100000) { send(413, { error: "That test message is too long." }); return true; }
    chunks.push(Buffer.from(chunk));
  }
  let data: { text?: unknown; test?: unknown };
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { send(400, { error: "Send a plain test message." }); return true; }
  if (!data || data.test !== true || typeof data.text !== "string" || !data.text.trim()) { send(400, { error: "This comparison only accepts test turns." }); return true; }
  const controller = new AbortController();
  res.once("close", () => controller.abort());
  const { think } = await import("../brain/brain.js");
  const started = Date.now(); let first: number | null = null;
  const tools: string[] = [];
  try {
    const ask = (text: string) => think(text, { test: true, signal: controller.signal,
      onSpoken: (text) => { if (text && first === null) first = Date.now() - started; },
      onProgress: (_label, tool) => { if (tool) tools.push(tool); } });
    let result = await ask(data.text);
    const claim = adequacyClaim(result.spoken);
    if (claim) result = await ask(RESAY(claim)).catch(() => result);
    if (adequacyClaim(result.spoken)) result = { ...result, spoken: withoutClaimSentences(result.spoken) };
    send(200, { first_word_s: first === null ? null : first / 1000, done_s: (Date.now() - started) / 1000,
      tools, steps: tools.length, spoken: result.spoken });
  } catch { send(500, { error: "The built-in brain could not finish the comparison." }); }
  return true;
}
