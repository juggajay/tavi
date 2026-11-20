import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Guard } from "./guard.js";
import { GuardError } from "./runner.js";
import { same } from "./store.js";

function requestRoute(req: IncomingMessage) {
  const method = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(req.method ?? "") ? req.method : "Other method";
  let route = "unknown route";
  try {
    const path = new URL(req.url ?? "/", "http://127.0.0.1:3091").pathname;
    if (/^\/(state|events|audit|level|pin|probe|team|bots|seen|trip|screen-audit|space\/(start|stop))$/.test(path)) route = path;
    else if (/^\/bots\/[^/]+\/(ports|screen(?:\/key)?)$/.test(path)) route = path.replace(/^\/bots\/[^/]+/, "/bots/:bot");
    else if (/^\/bots\/[^/]+\/file\/[^/]+$/.test(path)) route = "/bots/:bot/file/:file";
    else if (/^\/team\/file\/[^/]+$/.test(path)) route = "/team/file/:file";
    else if (/^\/bots\/[^/]+\/procs\/[^/]+\/(start|stop|log)$/.test(path)) route = path.replace(/^\/bots\/[^/]+\/procs\/[^/]+/, "/bots/:bot/procs/:kind");
    else if (/^\/subscriptions\/[^/]+(?:\/sign-in)?$/.test(path)) route = path.replace(/^\/subscriptions\/[^/]+/, "/subscriptions/:provider");
    else if (/^\/sign-in\/[^/]+(?:\/(events|input))?$/.test(path)) route = path.replace(/^\/sign-in\/[^/]+/, "/sign-in/:session");
  } catch {}
  return `${method} ${route}`;
}

function count(url: URL) {
  const text = url.searchParams.get("lines") ?? "200";
  if (!/^\d{1,5}$/.test(text) || +text < 1 || +text > 10000) throw new GuardError(400, "Choose from one to 10000 lines.");
  return +text;
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw new GuardError(413, "That request is too large. The limit is 512 KB.");
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new GuardError(400, "Send a plain JSON object."); }
}
function json(res: ServerResponse, code: number, value: unknown) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
function stream(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Content-Type-Options": "nosniff" });
  res.flushHeaders();
  const send = (event: string, detail: unknown) => {
    if (res.destroyed) return;
    if (res.writableLength > 512 * 1024) { res.destroy(); return; }
    res.write(`event: ${event}\ndata: ${JSON.stringify(detail)}\n\n`);
  };
  const timer = setInterval(() => { if (!res.destroyed) res.write(": still here\n\n"); }, 15000); timer.unref();
  res.on("close", () => clearInterval(timer));
  return send;
}
export function createGuardServer(guard: Guard) {
  const server = createServer(async (req, res) => {
    let who: "local" | "relay" | undefined;
    try {
      const host = req.headers.host;
      if (host !== "127.0.0.1:3091" && host !== "localhost:3091") throw new GuardError(403, "Use the guard on this PC.");
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) throw new GuardError(403, "This page cannot use the safety switch.");
      const authorization = req.headers.authorization ?? "";
      if (same(authorization, `Bearer ${guard.store.local}`)) who = "local";
      else if (same(authorization, `Bearer ${guard.store.relay}`)) who = "relay";
      else {
        guard.audit("refused", "unknown", `${requestRoute(req)}: A request did not have a valid secret.`);
        res.writeHead(401, { "Cache-Control": "no-store" }); res.end(); return;
      }
      if (Number(req.headers["content-length"] ?? 0) > 512 * 1024) throw new GuardError(413, "That request is too large. The limit is 512 KB.");
      if ((req.method === "GET" || req.method === "HEAD") && (req.headers["transfer-encoding"] || Number(req.headers["content-length"] ?? 0) > 0)) throw new GuardError(400, "Read requests must have an empty body.");
      const url = new URL(req.url ?? "/", "http://127.0.0.1:3091");
      const method = req.method;
      if (method === "GET" && url.pathname === "/state") { json(res, 200, await guard.state()); return; }
      if (method === "GET" && url.pathname === "/events") {
        const send = stream(res);
        const listener = (change: { event: string; detail: unknown }) => send(change.event, change.detail);
        guard.on("change", listener); const close = () => res.end(); guard.on("closed", close);
        res.on("close", () => { guard.off("change", listener); guard.off("closed", close); }); return;
      }
      if (method === "GET" && url.pathname === "/audit") { json(res, 200, { lines: guard.store.tail("audit.jsonl", count(url)) }); return; }
      if (method === "POST" && url.pathname === "/level") { const data = await body(req); json(res, 200, await guard.changeLevel({ ...data, level: data.level }, who)); return; }
      if (method === "POST" && url.pathname === "/pin") {
        if (who !== "local") throw new GuardError(403, "Only this PC can change the PIN.");
        const data = await body(req); await guard.setPin(data.pin, data.old, who); json(res, 200, { ok: true }); return;
      }
      if (method === "POST" && url.pathname === "/space/start") { await body(req); json(res, 200, await guard.startSpace()); return; }
      if (method === "POST" && url.pathname === "/space/stop") { await body(req); await guard.stopSpace(); json(res, 200, { ok: true }); return; }
      // The CLI's probe uses this small extra route; it does the same check as space/start.
      if (method === "POST" && url.pathname === "/probe") { await body(req); json(res, 200, await guard.probe()); return; }
      if (method === "POST" && url.pathname === "/team") { await body(req); json(res, 200, await guard.makeTeam()); return; }
      if (method === "POST" && url.pathname === "/bots") { const data = await body(req); json(res, 200, await guard.makeBot(data.id)); return; }
      if (method === "POST" && url.pathname === "/seen") { await body(req); guard.markSeen(); json(res, 200, { ok: true }); return; }
      if (method === "POST" && url.pathname === "/trip") {
        const data = await body(req);
        if (guard.saved.level !== "killed") await guard.changeLevel({ level: "walled", reason: data.reason, by: who }, who);
        json(res, 200, { level: guard.saved.level }); return;
      }
      const parts = url.pathname.split("/").slice(1).map((part) => { try { return decodeURIComponent(part); } catch { throw new GuardError(400, "That address could not be read."); } });
      if (parts[0] === "bots" && parts.length === 3 && parts[2] === "ports") {
        if (method === "PUT") { json(res, 200, await guard.setPorts(parts[1], await body(req))); return; }
        if (method === "GET") { json(res, 200, guard.fenceState(parts[1])); return; }
        if (method === "DELETE") { await body(req); await guard.dropPorts(parts[1]); json(res, 200, { ok: true }); return; }
      }
      if (method === "PUT" && parts[0] === "bots" && parts.length === 3 && parts[2] === "screen") {
        await guard.prepareScreen(parts[1], await body(req)); json(res, 200, { ok: true }); return;
      }
      if (method === "GET" && parts[0] === "bots" && parts.length === 4 && parts[2] === "screen" && parts[3] === "key") {
        json(res, 200, { password: guard.getScreenPassword(parts[1]) }); return;
      }
      if (method === "POST" && url.pathname === "/screen-audit") {
        const data = await body(req);
        if (typeof data.botId !== "string" || !/^[a-z0-9][a-z0-9-]{0,24}$/.test(data.botId) || typeof data.control !== "boolean") throw new GuardError(400, "Choose a bot and whether the owner has control.");
        guard.audit("screen-control", who, `${data.botId}: ${data.control ? "The owner has taken the mouse and keyboard" : "The owner has handed back the mouse and keyboard"}`);
        json(res, 200, { ok: true }); return;
      }
      if (method === "PUT" && parts[0] === "team" && parts[1] === "file" && parts.length === 3) {
        const data = await body(req); await guard.writeTeamFile(parts[2], data.content); json(res, 200, { ok: true }); return;
      }
      if (parts[0] === "bots" && parts[2] === "file" && parts.length === 4) {
        if (method === "GET") { json(res, 200, await guard.readBotFile(parts[1], parts[3])); return; }
        if (method === "PUT") { const data = await body(req); await guard.writeBotFile(parts[1], parts[3], data.content); json(res, 200, { ok: true }); return; }
      }
      if (parts[0] === "bots" && parts[2] === "procs" && parts.length === 5) {
        if (method === "POST" && parts[4] === "start") { await body(req); json(res, 200, await guard.startProcess(parts[1], parts[3])); return; }
        if (method === "POST" && parts[4] === "stop") { await body(req); await guard.stopProcess(parts[1], parts[3]); json(res, 200, { ok: true }); return; }
        if (method === "GET" && parts[4] === "log") { json(res, 200, { lines: guard.logs(parts[1], parts[3], count(url)) }); return; }
      }
      if (method === "POST" && parts[0] === "subscriptions" && parts[2] === "sign-in" && parts.length === 3) {
        await body(req); json(res, 200, await guard.signIn(parts[1])); return;
      }
      if (method === "DELETE" && parts[0] === "subscriptions" && parts.length === 2) {
        await body(req); await guard.signOut(parts[1]); json(res, 200, { ok: true }); return;
      }
      if (parts[0] === "sign-in" && (parts.length === 2 || parts.length === 3)) {
        const session = guard.session(parts[1]);
        if (method === "GET" && parts[2] === "events") {
          const send = stream(res);
          for (const line of session.lines) send("line", line);
          if (session.ended) { send("ended", {}); res.end(); return; }
          const line = (text: string) => send("line", text), end = () => { send("ended", {}); res.end(); };
          session.events.on("line", line); session.events.once("ended", end);
          res.on("close", () => { session.events.off("line", line); session.events.off("ended", end); }); return;
        }
        if (method === "POST" && parts[2] === "input") { const data = await body(req); guard.signInInput(parts[1], data.text); json(res, 200, { ok: true }); return; }
        if (method === "DELETE" && parts.length === 2) { await body(req); guard.endSignIn(session); json(res, 200, { ok: true }); return; }
      }
      throw new GuardError(404, "That guard command was not found.");
    } catch (error) {
      const fault = error instanceof GuardError ? error : new GuardError(500, "The guard could not finish that request.");
      try { guard.audit("refused", who ?? "unknown", `${requestRoute(req)}: A request was refused (${fault.status}).`); } catch {}
      if (!res.headersSent && !res.destroyed) json(res, fault.status, { error: fault.message, ...(fault.lines ? { lines: fault.lines } : {}) });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return server;
}
