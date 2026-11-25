// Keep the safety relay independent of the team, its tools and its saved conversations.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hq } from "./hq.js";
import { toolGroups } from "./team/groups.js";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { attach, screenshot } from "./screens/index.js";
import { clientById } from "../gateway/clients.js";

const screenSockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024,
  handleProtocols: protocols => protocols.has("binary") ? "binary" : false });
export function handleScreenUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, hq: Hq | undefined, helpers: Helpers): boolean {
  const url = new URL(req.url ?? "/", "http://local");
  const match = /^\/api\/hq\/bots\/([a-z0-9][a-z0-9-]{0,24})\/screen$/.exec(url.pathname);
  if (!match) return false;
  socket.on("error", () => socket.destroy());
  const refuse = () => { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return true; };
  const mode = url.searchParams.get("mode");
  if (!hq || req.method !== "GET" || !req.headers.origin || !helpers.sameOrigin(req) || screenshot.isAgentRequest(req.headers) ||
    (mode !== "watch" && mode !== "control") || (mode === "control" && !helpers.isLocal(req)) || hq.guard.level() !== "open") return refuse();
  try {
    const computer = hq.computer(match[1]);
    if (!computer.has || computer.state !== "ready") return refuse();
    screenSockets.handleUpgrade(req, socket, head, ws => { hq.seen(); void attach(ws, { botId: match[1], mode }); });
  } catch { return refuse(); }
  return true;
}

type Helpers = { isLocal(req: IncomingMessage): boolean; sameOrigin(req: IncomingMessage): boolean };
export type RelayOptions = { baseUrl?: string; secretPath?: string; timeoutMs?: number };
export const guardFolder = () => path.join(process.env.LH_V3_DATA ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data-v3"), "guard");
export async function guardRequest(route: string, method = "GET", body?: unknown, options: RelayOptions = {}, local = false, signal?: AbortSignal) {
  const secret = (await readFile(local ? path.join(guardFolder(), "secret-local") : options.secretPath ?? path.join(guardFolder(), "secret-relay"), "utf8")).trim();
  if (!/^[a-f\d]{64}$/i.test(secret)) throw new Error("The safety switch's access key is not available.");
  return fetch((options.baseUrl ?? "http://127.0.0.1:3091") + route, {
    method, redirect: "error", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error("That request is too large. Send fewer pictures or words.");
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new Error("Send the request as a plain JSON object."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Send the request as a plain JSON object.");
  return value as Record<string, unknown>;
}
function only(data: Record<string, unknown>, keys: string[]) {
  if (Object.keys(data).some((k) => !keys.includes(k))) throw new Error("That setting cannot be changed here.");
}
function message(data: Record<string, unknown>) {
  only(data, ["text", "images", "test", "client_id"]);
  if (typeof data.text !== "string" || !data.text.trim() || data.text.length > 50000) throw new Error("Write a message of up to 50000 letters.");
  if (data.test !== undefined && typeof data.test !== "boolean") throw new Error("The test setting must be true or false.");
  if (data.images !== undefined && (!Array.isArray(data.images) || data.images.length > 4 || data.images.some((s) => typeof s !== "string" || !/^(?:https:\/\/|data:image\/(?:png|jpeg|webp);base64,)/i.test(s))))
    throw new Error("Send up to four pictures as secure addresses or picture data.");
  return { text: data.text.trim(), images: data.images as string[] | undefined, test: data.test === true };
}
export async function handleHq(req: IncomingMessage, res: ServerResponse, url: URL, hq: Hq | undefined, helpers: Helpers, relay: RelayOptions = {}): Promise<boolean> {
  if (!url.pathname.startsWith("/api/hq/") && url.pathname !== "/api/hq") return false;
  if ((await import("../browser/sites.js")).isAgentRequest(req.headers) || !helpers.sameOrigin(req)) { send(res, 403, { error: "This page cannot use the bot team." }); return true; }
  const route = url.pathname.slice(7);
  const method = req.method ?? "GET";
  const local = helpers.isLocal(req);
  const pc = () => { if (!local) { send(res, 403, { error: "Do that on this PC." }); return false; } return true; };
  try {
    // Nothing above this branch loads bots, tools, turns or the database.
    if ((route === "/safety" && method === "POST") || (route === "/safety/pin" && method === "POST")) {
      const pin = route.endsWith("/pin");
      if (pin && !pc()) return true;
      const data = await body(req);
      let response: Response;
      try { response = await guardRequest(pin ? "/pin" : "/level", method, data, relay, pin); }
      catch {
        // Closing this side never pretends to have stopped Linux.
        await hq?.emergencyStop().catch(() => undefined);
        send(res, 503, { ok: false, guard: "down", did: "stopped everything on this side",
          warning: "The Linux space may still be running. On this PC run npm run guard -- kill." });
        return true;
      }
      const result = await response.json();
      if (response.ok) {
        // The relay's success does not wait for the team. Its event connection reads the new level.
        void hq?.refreshSafety();
      }
      send(res, response.status, result); return true;
    }
    if (route === "/safety" && method === "GET") {
      const response = await guardRequest("/state", "GET", undefined, relay);
      if (!response.ok) { send(res, response.status, await response.json()); return true; }
      const state = await response.json();
      send(res, 200, { level: state.level, until: state.until, pinSet: state.pinSet, ownerUbuntuRunning: state.ownerUbuntuRunning }); return true;
    }
    if (!hq) { send(res, 503, { error: "The team could not start. The safety switch is still available." }); return true; }
    const { cardHistory, currentCard } = await import("./cards/index.js");
    const { isActive } = await import("./team/state.js");
    const { db } = await import("../store/db.js");
    if (method !== "GET" && method !== "HEAD") hq.seen();
    if (route === "/onboarding" && method === "GET") {
      const { welcomeState } = await import("./onboarding/api.js");
      send(res, 200, welcomeState()); return true;
    }
    if (route === "/onboarding" && method === "POST") {
      if (!pc()) return true;
      const { onboardingAction } = await import("./onboarding/api.js");
      send(res, 200, await onboardingAction(hq, await body(req), async () => {
        const response = await guardRequest("/state", "GET", undefined, relay);
        if (!response.ok) throw new Error("The safety switch is not answering. Try again.");
        return (await response.json()).pinSet === true;
      })); return true;
    }
    if (route === "/onboarding/review" && method === "GET") {
      if (!pc()) return true;
      const { reviewState } = await import("./onboarding/api.js"); send(res, 200, reviewState(hq, url.searchParams.get("session") ?? undefined)); return true;
    }
    if (route === "/onboarding/review" && method === "POST") {
      if (!pc()) return true;
      const { reviewTurn } = await import("./onboarding/api.js"); send(res, 202, await reviewTurn(hq, await body(req))); return true;
    }
    if ((route === "/onboarding/conversation" || route === "/onboarding/material") && method === "POST") {
      if (!pc()) return true;
      const { conversationAction, bringMaterial } = await import("./onboarding/api.js");
      send(res, 200, route.endsWith("/material") ? bringMaterial(hq, await body(req)) : conversationAction(hq, await body(req))); return true;
    }
    if (route === "/state" && method === "GET") { send(res, 200, await hq.snapshot()); return true; }
    if (route === "/tool-groups" && method === "GET") { send(res, 200, toolGroups.map(g => ({ ...g, description: g.what }))); return true; }
    if (route === "/handovers" && method === "GET") { send(res, 200, hq.team().handovers()); return true; }
    if (route === "/about" && (method === "GET" || method === "PUT")) {
      if (method === "PUT") {
        if (!pc()) return true;
        const data = await body(req); only(data, ["text"]);
        if (typeof data.text !== "string" || data.text.trim().length > 1500) throw new Error("Write an about card of up to 1,500 characters.");
        db.prepare("UPDATE about_card SET text=?, revision=revision+1 WHERE id=1").run(data.text.trim());
      }
      send(res, 200, db.prepare("SELECT text, revision FROM about_card WHERE id=1").get()); return true;
    }
    if (route === "/subscriptions" && method === "GET") { send(res, 200, await hq.subscriptions()); return true; }
    const subscription = /^\/subscriptions\/(anthropic|openai-codex)(\/sign-in)?$/.exec(route);
    if (subscription && ((method === "POST" && subscription[2]) || (method === "DELETE" && !subscription[2]))) {
      if (!pc()) return true;
      // Starting a sign-in first re-runs the guard's lock-down check, which takes about eight seconds on the real
      // space. With the usual five-second limit this side gave up while the guard carried on and opened the session,
      // leaving a sign-in nobody could see (found on the real server). So: a long limit here.
      const response = await guardRequest(route, method, method === "POST" ? {} : undefined, { ...relay, timeoutMs: Math.max(relay.timeoutMs ?? 0, 120_000) });
      send(res, response.status, await response.json()); return true;
    }
    const signin = /^\/sign-in\/([a-zA-Z0-9_-]{1,100})(?:\/(events|input))?$/.exec(route);
    if (signin) {
      if (!pc()) return true;
      if (method === "GET" && signin[2] === "events") {
        const controller = new AbortController();
        res.once("close", () => controller.abort());
        const firstByte = setTimeout(() => controller.abort(), relay.timeoutMs ?? 5000);
        let response: Response;
        try { response = await guardRequest(route, "GET", undefined, relay, false, controller.signal); }
        finally { clearTimeout(firstByte); }
        if (!response.ok || !response.body) { send(res, response.status, { error: "The sign-in window is not available." }); return true; }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.flushHeaders();
        const reader = response.body.getReader();
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read(); if (done) break;
            if (res.writableLength > 512 * 1024) { controller.abort(); break; }
            res.write(value);
          }
        } finally { controller.abort(); await reader.cancel().catch(() => undefined); res.end(); }
        return true;
      }
      if ((method === "POST" && signin[2] === "input") || (method === "DELETE" && !signin[2])) {
        const data = method === "POST" ? await body(req) : undefined;
        // These words go straight to the guard and are never recorded here.
        const response = await guardRequest(route, method, data, relay);
        send(res, response.status, await response.json()); return true;
      }
    }
    if (route === "/rooms/ask" && method === "POST") {
      const data = await body(req); only(data, ["bots", "text"]);
      if (!Array.isArray(data.bots) || !data.bots.length || data.bots.some((id) => typeof id !== "string") || typeof data.text !== "string" || !data.text.trim()) throw new Error("Choose the bots and write their question.");
      if (data.bots.some((id) => !isActive(id as string))) throw new Error("That bot is still waiting for its trials to pass.");
      send(res, 200, await hq.turns.askRoom(data.bots as string[], data.text)); return true;
    }
    const bots = await import("./bots.js");
    if (route === "/bots" && method === "POST") {
      if (!pc()) return true;
      const data = await body(req); only(data, ["id", "name", "look", "card"]);
      const result = await hq.team().create(data);
      send(res, result.status === "refused" ? 409 : 201, result); return true;
    }
    const match = /^\/bots\/([a-z0-9][a-z0-9-]{0,24})(?:\/(rows|messages|stop|fresh|engine|computer|screen\.png|card(?:\/restore)?))?$/.exec(route);
    if (!match) { send(res, 404, { error: "That team page was not found." }); return true; }
    const bot = bots.getBot(match[1]);
    if (!bot) { send(res, 404, { error: "That bot is no longer on the team." }); return true; }
    const action = match[2];
    if (action === "computer" && method === "GET") { send(res, 200, hq.computer(bot.id)); return true; }
    if (action === "computer" && method === "POST") {
      if (!pc()) return true;
      if (hq.guard.level() !== "open") { send(res, 409, { error: "The safety switch is on." }); return true; }
      const data = await body(req); only(data, ["on"]);
      if (typeof data.on !== "boolean") throw new Error("Choose whether its computer is on or off.");
      send(res, 202, await hq.setComputer(bot.id, data.on)); return true;
    }
    if (action === "screen.png" && method === "GET") {
      if (!bot.computer) { send(res, 404, { error: "This bot has no computer." }); return true; }
      if (hq.guard.level() !== "open") { send(res, 409, { error: "The safety switch is on." }); return true; }
      try {
        const picture = await screenshot(bot.id);
        if (hq.guard.level() !== "open") { send(res, 409, { error: "The safety switch is on." }); return true; }
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(picture);
      } catch { send(res, hq.guard.level() === "open" ? 503 : 409, { error: "Its screen is not ready. Wait a moment and try again." }); }
      return true;
    }
    if (action === "card" && method === "GET") { send(res, 200, { card: currentCard(bot.id), versions: cardHistory(bot.id) }); return true; }
    if ((action === "card" && method === "PUT") || (action === "card/restore" && method === "POST")) {
      if (!pc()) return true;
      const data = await body(req);
      let result;
      if (action === "card/restore") {
        only(data, ["version"]);
        if (!Number.isSafeInteger(data.version) || Number(data.version) < 1) throw new Error("Choose a saved card version.");
        result = await hq.team().restore(bot.id, Number(data.version));
      } else result = await hq.team().change(bot.id, data);
      send(res, result.status === "refused" ? 409 : 200, result); return true;
    }
    if (!isActive(bot.id) && action !== "rows" && !(method === "DELETE" && !action)) { send(res, 409, { error: "That bot is still waiting for its trials to pass." }); return true; }
    if (action === "rows" && method === "GET") {
      const { rowsOf, changedSince } = await import("./rows.js");
      const n = (name: string, fallback: number) => {
        const value = url.searchParams.get(name); if (value === null) return fallback;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Choose a whole conversation number from zero.");
        return Number(value);
      };
      const generation = n("generation", bot.generation), after = n("after", 0);
      const job = url.searchParams.get("job");
      const all = job === null ? rowsOf(bot.id, generation) : hq.testRows(bot.id, job);
      const rows = url.searchParams.has("after") ? (job === null ? changedSince(bot.id, after).filter((r) => r.generation === generation) : all.filter((r) => r.rev > after)) : all.slice(-200);
      send(res, 200, { generation, rev: Math.max(after, ...all.map((r) => r.rev), 0), rows }); return true;
    }
    if (action === "messages" && method === "POST") {
      const data = await body(req);
      const client = typeof data.client_id === "string" ? clientById(data.client_id) : undefined;
      const origin = client?.v === 2 ? { client: client.kind, id: client.id } : null;
      send(res, 202, hq.ask(bot.id, { ...message(data), via: "typed", origin })); return true;
    }
    if (action === "stop" && method === "POST") { hq.stopBot(bot.id); send(res, 200, { ok: true }); return true; }
    if (action === "fresh" && method === "POST") { send(res, 200, hq.fresh(bot.id)); return true; }
    if (action === "engine" && method === "GET") { send(res, 200, await hq.engineState(bot)); return true; }
    if ((action === "engine" || !action) && method === "PATCH") {
      const data = await body(req);
      const allowed = action === "engine" ? ["primary", "fallbacks"] : local ? ["name", "role", "soul", "look", "computer", "voice", "primary", "fallbacks", "servers", "engine", "lead"] : ["name", "role", "look", "voice"];
      if (action === "engine" && !pc()) return true;
      if (!local && Object.keys(data).some((k) => !allowed.includes(k))) { send(res, 403, { error: "Change those bot settings on this PC." }); return true; }
      only(data, allowed);
      const next = bots.updateBot(bot.id, data); hq.ensure(next); hq.botsChanged();
      send(res, 200, action === "engine" ? await hq.engineState(next) : (await import("./hq.js")).publicBot(next)); return true;
    }
    if (!action && method === "DELETE") {
      if (!pc()) return true;
      if (hq.members().length <= 1) { send(res, 409, { error: "Keep at least one bot on the team." }); return true; }
      if (bot.lead) bots.updateBot(hq.members().find((member) => member.id !== bot.id)!.id, { lead: true });
      hq.stopBot(bot.id); await hq.hermes.remove(bot); bots.removeBot(bot.id); hq.botsChanged(); send(res, 200, { ok: true }); return true;
    }
    send(res, 405, { error: "That action is not available on this team page." }); return true;
  } catch (error) {
    if (res.headersSent) res.end();
    else send(res, 400, { error: error instanceof Error && !(error instanceof TypeError) && !("code" in error) ? error.message : "That request could not finish. Check that the safety switch is running." });
    return true;
  }
}
