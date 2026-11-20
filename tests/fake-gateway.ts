// A stand-in for the gateway's /helper line, for the helper's own tests (Stage 11.1, 11.2): it says yes (or no) to a
// helper's hello, then sends requests down the line and waits for the answers. The real gateway side is src/remote/.
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export type Hello = { type: "hello"; name: string; version: string; secret: string; max_file_mb?: number };

export async function fakeGateway(o: { accept?: (h: Hello, n: number) => boolean } = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/helper", maxPayload: 4 * 1024 * 1024 });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as AddressInfo).port;
  const hellos: Hello[] = [];
  let current: WebSocket | null = null;
  let seq = 0;
  const pending = new Map<string, (m: Record<string, unknown>) => void>();
  const connectedWaiters: (() => void)[] = [];
  wss.on("connection", (ws) => {
    let greeted = false;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!greeted) {
        greeted = true;
        hellos.push(m as Hello);
        if (o.accept && !o.accept(m as Hello, hellos.length)) {
          ws.send(JSON.stringify({ type: "refused" }));
          return ws.close(4003, "refused");
        }
        current = ws;
        ws.send(JSON.stringify({ type: "welcome" }));
        for (const w of connectedWaiters.splice(0)) w();
        return;
      }
      if (m.type === "res" && typeof m.id === "string") pending.get(m.id)?.(m);
    });
    ws.on("close", () => {
      if (current === ws) current = null;
    });
  });
  return {
    port,
    url: `ws://127.0.0.1:${port}/helper`,
    hellos,
    get socket() {
      return current;
    },
    connected: (ms = 5000) =>
      new Promise<void>((resolve, reject) => {
        if (current) return resolve();
        const t = setTimeout(() => reject(new Error("the helper never connected")), ms);
        connectedWaiters.push(() => (clearTimeout(t), resolve()));
      }),
    /** One request down the line, and its answer. */
    ask: (op: string, args: Record<string, unknown> = {}, ms = 15_000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (!current) return reject(new Error("no helper connected"));
        const id = `r${++seq}`;
        const t = setTimeout(() => (pending.delete(id), reject(new Error(`no answer to ${op}`))), ms);
        pending.set(id, (m) => (clearTimeout(t), pending.delete(id), resolve(m)));
        current.send(JSON.stringify({ type: "req", id, op, ...args }));
      }),
    send: (m: Record<string, unknown>) => current?.send(JSON.stringify(m)),
    /** Drop the helper's line from this end. */
    drop: (code?: number) => (code ? current?.close(code) : current?.terminate()),
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };
}
