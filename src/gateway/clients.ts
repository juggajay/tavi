// Who is connected over /ws, and sending to them. A socket that never says hello is a v1 client (the original phone
// page) and gets exactly the messages it always got. A v2 client says hello { v: 2, client: "phone" | "desktop", id }
// and gets v2 messages, some only meant for it (src/shared/protocol.ts, docs/v2/PROTOCOL.md).
import { WebSocket } from "ws";
import type { ClientKind, ScreenState } from "../shared/protocol.js";

export type ClientInfo = { v: 1 | 2; kind: ClientKind | "legacy"; id: string; screen: ScreenState | null; connectedAt: number };

export const clients = new Map<WebSocket, ClientInfo>();
let legacyCount = 0;

export function addClient(ws: WebSocket): ClientInfo {
  const info: ClientInfo = { v: 1, kind: "legacy", id: `legacy-${++legacyCount}`, screen: null, connectedAt: Date.now() };
  clients.set(ws, info);
  return info;
}

/** What a v1 client gets instead of a message: the same message (default), a different one, or nothing (null). */
type V1 = Record<string, unknown> | null | undefined;

function deliver(ws: WebSocket, msg: Record<string, unknown> | null) {
  if (msg && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Every client. v1 clients get v1 (the same message when omitted; nothing when null). */
export function toAll(msg: Record<string, unknown>, v1?: V1) {
  for (const [ws, c] of clients) deliver(ws, c.v === 2 ? msg : v1 === undefined ? msg : v1);
}

/** Every v2 client of one kind (v1 clients are never "phone" or "desktop"). */
export function toKind(kind: ClientKind, msg: Record<string, unknown>) {
  for (const [ws, c] of clients) if (c.v === 2 && c.kind === kind) deliver(ws, msg);
}

/** One v2 client, by the id it gave in hello (it may have several sockets open, e.g. two tabs). */
export function toClient(id: string, msg: Record<string, unknown>) {
  for (const [ws, c] of clients) if (c.v === 2 && c.id === id) deliver(ws, msg);
}

/** Each client gets what make(client) returns (nothing for null). */
export function toEach(make: (c: ClientInfo) => Record<string, unknown> | null) {
  for (const [ws, c] of clients) deliver(ws, make(c));
}

export const clientById = (id: string) => [...clients.values()].find((c) => c.id === id);
