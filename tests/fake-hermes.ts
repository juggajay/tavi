import "./isolate.js";
import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";

/** Windows sign-in protection needs a loaded owner account. Only that outer wrapping is replaced in unit tests. */
export function fakeAccountProtection() {
  const original = childProcess.execFileSync;
  const handle = mock.method(childProcess, "execFileSync", ((...args: Parameters<typeof original>) => {
    const [file, argv] = args;
    if (String(file).toLowerCase() === "powershell.exe" && Array.isArray(argv)) {
      const script = argv.at(-1) || "";
      if (script.includes("Security.Cryptography.ProtectedData")) {
        const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
        if (!encoded) throw new Error("The test's account protection received no data.");
        return script.includes("::Unprotect") ? encoded.replace(/^test-only:/, "") : `test-only:${encoded}`;
      }
    }
    return Reflect.apply(original, childProcess, args);
  }) as typeof original);
  syncBuiltinESMExports();
  return () => { handle.mock.restore(); syncBuiltinESMExports(); };
}

export const frame = (type: string, data: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
export const completed = (text: string) => frame("response.completed", { response: { usage: { input_tokens: 8, output_tokens: 3 }, output: [{ type: "message", content: [{ text }] }] } });
export const scripts = {
  plain: frame("response.output_text.delta", { delta: "Ready ✨." }) + completed("Ready ✨."),
  tools: [
    frame("response.output_item.added", { item: { type: "function_call", id: "item-a", call_id: "a", name: "mcp__calc__sum", arguments: '{"a":2}' } }),
    frame("response.output_item.done", { item: { type: "function_call", call_id: "a", name: "mcp__calc__sum" } }),
    frame("response.output_item.done", { item: { type: "function_call_output", call_id: "a", output: '{"result":4}' } }),
    frame("response.output_item.added", { item: { type: "function_call", call_id: "b", name: "mcp__drawings__read_sheet", arguments: {} } }),
    frame("response.output_item.done", { item: { type: "function_call_output", call_id: "b", output: { isError: true } } }),
    frame("response.output_text.delta", { delta: "Two checks done." }), completed("Two checks done."),
  ].join(""),
  commentary: frame("response.output_item.added", { output_index: 0, item: { type: "message", id: "working", phase: "commentary" } })
    + frame("response.output_text.delta", { item_id: "working", output_index: 0, delta: "Checking the sheet." })
    + frame("response.output_item.done", { output_index: 0, item: { type: "message", id: "working", phase: "commentary", content: [{ text: "Checking the sheet." }] } })
    + frame("response.output_text.delta", { item_id: "answer", output_index: 1, delta: "All checked." }) + completed("All checked."),
  notSignedIn: readFileSync(new URL("./fixtures/hermes/responses-not-signed-in.sse", import.meta.url), "utf8"),
  limit: frame("response.failed", { response: { error: { message: "Usage limit reached. Retry in 2 minutes." } } }),
  cutOff: frame("response.output_text.delta", { delta: "Half an answer" }),
  never: null,
};
export type FakeReply = { script?: string | null; status?: number; chunkBytes?: number; delayMs?: number; firstDelayMs?: number; cutAt?: number };
export type FakeHermesOptions = FakeReply & {
  authenticated?: boolean | Record<string, boolean>; health?: boolean;
  rootKey?: string;
  profiles?: Record<string, { key: string; tools: string[] }>;
  reply?: (body: Record<string, unknown>, index: number) => FakeReply;
};
export async function fakeHermes(options: FakeHermesOptions = {}) {
  const requests: { method: string; path: string; body: Record<string, unknown>; authorization: string | undefined }[] = [];
  const connections = new Set<ServerResponse>();
  let disconnected = 0;
  let replies = 0;
  const server = createServer(async (req, res) => {
    connections.add(res);
    res.on("close", () => { connections.delete(res); if (!res.writableEnded) disconnected++; });
    const chunks: Buffer[] = [];
    try { for await (const chunk of req) chunks.push(Buffer.from(chunk)); }
    catch { res.destroy(); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* An empty request has no choices. */ }
    requests.push({ method: req.method || "GET", path: req.url || "", body, authorization: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    const profile = /^\/p\/([^/]+)(\/.*)$/.exec(req.url || "");
    const route = profile ? profile[2] : req.url;
    const settings = profile ? options.profiles?.[profile[1]] : undefined;
    if ((options.profiles && profile && (!settings || req.headers.authorization !== `Bearer ${settings.key}`)) ||
      (!profile && options.rootKey && route !== "/health" && req.headers.authorization !== `Bearer ${options.rootKey}`)) {
      res.writeHead(401); res.end("{}"); return;
    }
    if (req.url === "/health") { res.writeHead(options.health === false ? 503 : 200); res.end('{"ok":true}'); return; }
    if (route === "/api/model/options") {
      const signed = typeof options.authenticated === "object" ? options.authenticated : { anthropic: options.authenticated ?? true, "openai-codex": options.authenticated ?? true };
      res.end(JSON.stringify({ providers: Object.entries(signed).map(([id, authenticated]) => ({ slug: id, name: id, authenticated, auth_type: "oauth" })) })); return;
    }
    if (route === "/v1/toolsets") { res.end(JSON.stringify({ tools: settings?.tools || [] })); return; }
    if (route !== "/v1/responses") { res.writeHead(404); res.end(); return; }
    const reply = { ...options, ...options.reply?.(body, replies++) };
    if (reply.script === null) return;
    const bytes = Buffer.from(reply.script ?? scripts.plain);
    let position = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    res.on("close", () => clearTimeout(timer));
    const write = () => {
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(reply.status ?? 200, { "Content-Type": "text/event-stream" });
      const end = Math.min(bytes.length, reply.cutAt ?? bytes.length);
      if (position >= end) { res.end(); return; }
      const next = Math.min(end, position + (reply.chunkBytes ?? bytes.length));
      res.write(bytes.subarray(position, next));
      position = next;
      timer = setTimeout(write, reply.delayMs ?? 0);
    };
    timer = setTimeout(write, reply.firstDelayMs ?? 0);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test engine could not open its local port.");
  return {
    url: `http://127.0.0.1:${address.port}`, port: address.port, requests, options,
    get disconnected() { return disconnected; },
    async close() { for (const res of connections) res.destroy(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
