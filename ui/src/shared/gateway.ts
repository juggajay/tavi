import { savedValue } from "../../../src/shared/earlier";
// The app's connection to the gateway (/ws, protocol v2). Says hello, reconnects with backoff, keeps a few typed
// messages while offline, and hands each incoming message to whoever subscribed to its type. No UI here.
import type { ClientKind, ClientMessage, ServerMessage } from "../../../src/shared/protocol";

export type GatewayStatus = "connecting" | "open" | "closed";
type Handler<T extends ServerMessage["type"]> = (m: Extract<ServerMessage, { type: T }>) => void;

const QUEUE_MAX = 5;

/** A stable id for this browser and app, kept across reloads (a fresh one if storage is unavailable). */
export function clientId(kind: ClientKind): string {
  const key = `tavi-client-id-${kind}`;
  try {
    const saved = savedValue(localStorage, key);
    if (saved && /^[\w-]{1,64}$/.test(saved)) return saved;
    const id = `${kind}-${crypto.randomUUID().slice(0, 12)}`;
    localStorage.setItem(key, id);
    return id;
  } catch {
    return `${kind}-${crypto.randomUUID().slice(0, 12)}`;
  }
}

export function createGateway(kind: ClientKind, opts: { url?: string; onStatus?: (s: GatewayStatus) => void } = {}) {
  const id = clientId(kind);
  const url = opts.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  const handlers = new Map<string, Set<(m: ServerMessage) => void>>();
  const queue: ClientMessage[] = [];
  let ws: WebSocket | null = null;
  let status: GatewayStatus = "closed";
  let delay = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const setStatus = (s: GatewayStatus) => {
    status = s;
    opts.onStatus?.(s);
  };

  function connect() {
    if (stopped) return;
    setStatus("connecting");
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      delay = 500;
      sock.send(JSON.stringify({ type: "hello", v: 2, client: kind, id } satisfies ClientMessage));
      setStatus("open");
      while (queue.length && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(queue.shift()));
    };
    sock.onmessage = (e) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      for (const h of handlers.get(m.type) ?? []) h(m);
      for (const h of handlers.get("*") ?? []) h(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setStatus("closed");
      if (stopped) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 10_000);
    };
    sock.onerror = () => sock.close();
  }

  connect();

  return {
    id,
    get status() {
      return status;
    },
    /** Subscribe to one message type ("*" for all). Returns an unsubscribe function. */
    on<T extends ServerMessage["type"]>(type: T | "*", h: Handler<T>) {
      const set = handlers.get(type) ?? new Set();
      set.add(h as (m: ServerMessage) => void);
      handlers.set(type, set);
      return () => set.delete(h as (m: ServerMessage) => void);
    },
    /** Send now if connected. Typed messages wait (up to 5, oldest dropped) while offline; anything else is dropped. */
    send(m: ClientMessage) {
      if (ws?.readyState === WebSocket.OPEN) return ws.send(JSON.stringify(m));
      if (m.type === "typed") {
        queue.push(m);
        if (queue.length > QUEUE_MAX) queue.shift();
      }
    },
    /** Drop the line and connect again at once (it says hello again). */
    reconnect() {
      delay = 50;
      ws?.close();
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}

export type Gateway = ReturnType<typeof createGateway>;
