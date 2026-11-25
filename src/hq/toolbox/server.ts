import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { ALL_SERVERS, describeTool, listedTools } from "./tools.js";
import { runTool, type SafetyLevel } from "./calls.js";
import type { TurnLane } from "./lanes.js";

export type ToolboxOptions = {
  host: string;
  port: number;
  tokenFor(botId: string): string | null;
  serversFor?(botId: string): string[] | "all";
  level(): SafetyLevel;
  resolveAddress?(address: string): { bot: string; lane: TurnLane } | null;
};

const BODY_LIMIT = 4 * 1024 * 1024;
type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  if (body === undefined) res.end();
  else {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let chunks: Buffer[] = [];
    let refused = false;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (refused) return;
      if (bytes > BODY_LIMIT) {
        refused = true;
        chunks = [];
        send(res, 413);
        resolve(null);
      } else chunks.push(chunk);
    });
    req.on("end", () => { if (!refused) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("The request was cut short.")));
  });
}

async function answer(value: unknown, botId: string, server: string, o: ToolboxOptions, lane: TurnLane) {
  if (!object(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" ||
      (Object.hasOwn(value, "id") && value.id !== null && typeof value.id !== "string" && typeof value.id !== "number") ||
      (value.params !== undefined && !object(value.params) && !Array.isArray(value.params))) {
    return rpcError(null, -32600, "That request is not in the right form.");
  }
  // Notifications never run tools, even if they contain the name of a writing tool.
  if (!Object.hasOwn(value, "id")) return null;
  const id = value.id;
  let result: unknown;
  switch (value.method) {
    case "initialize":
      result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: server, version: "0.1.0" } };
      break;
    case "ping": result = {}; break;
    case "tools/list": result = { tools: listedTools(server, botId).map(describeTool) }; break;
    case "tools/call": {
      if (!object(value.params) || typeof value.params.name !== "string" || !value.params.name) return rpcError(id, -32602, "Please give the tool's name.");
      result = await runTool(botId, server, value.params.name, value.params.arguments, o.level, lane);
      break;
    }
    default: return rpcError(id, -32601, "That method is not available.");
  }
  return { jsonrpc: "2.0", id, result };
}

async function handle(req: IncomingMessage, res: ServerResponse, o: ToolboxOptions) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    send(res, 405);
    return;
  }
  const match = /^\/mcp\/([^/]+)\/([^/]+)$/.exec((req.url ?? "").split("?")[0]);
  if (!match) return send(res, 404);
  let botId: string;
  let server: string;
  try {
    botId = decodeURIComponent(match[1]);
    server = decodeURIComponent(match[2]);
  } catch { return send(res, 404); }
  const token = o.tokenFor(botId);
  const header = req.headers.authorization;
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  // Fixed-size hashes keep the comparison constant time even for different token lengths.
  const digest = (text: string) => createHash("sha256").update(text).digest();
  const same = timingSafeEqual(digest(supplied), digest(token ?? ""));
  if (!token || !supplied || !same) return send(res, 401);
  const target = o.resolveAddress ? o.resolveAddress(botId) : { bot: botId, lane: "chat" as const };
  if (!target) return send(res, 404);
  const servers = o.serversFor?.(botId) ?? "all";
  if (!ALL_SERVERS.includes(server) || (server !== "team" && servers !== "all" && !servers.includes(server))) return send(res, 404);
  const body = await readBody(req, res);
  if (body === null) return;
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { return send(res, 400, rpcError(null, -32700, "That request could not be read.")); }
  if (Array.isArray(value)) {
    if (!value.length) return send(res, 200, rpcError(null, -32600, "The request list is empty."));
    const replies = [];
    // Keep calls in order so later calls see what earlier ones have done.
    for (const entry of value) {
      const reply = await answer(entry, target.bot, server, o, target.lane);
      if (reply !== null) replies.push(reply);
    }
    send(res, replies.length ? 200 : 202, replies.length ? replies : undefined);
  } else {
    const reply = await answer(value, target.bot, server, o, target.lane);
    send(res, reply === null ? 202 : 200, reply ?? undefined);
  }
}

/** Listen on one given address. The caller owns the server and closes it at shutdown. */
export async function startToolbox(o: ToolboxOptions) {
  // The Linux space uses IPv4. Requiring a literal address also avoids a name resolving to every interface.
  if (isIP(o.host) !== 4 || o.host === "0.0.0.0") throw new Error("Please choose one IPv4 address for the toolbox.");
  const server = createServer((req, res) => {
    void handle(req, res, o).catch(() => {
      console.error("The toolbox could not finish a request.");
      if (!res.headersSent) send(res, 500, rpcError(null, -32603, "The request could not finish."));
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    host: o.host,
    port,
    baseUrl: `http://${o.host}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}
