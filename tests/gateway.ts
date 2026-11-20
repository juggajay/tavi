// Runs the real gateway inside a test, on a random port, with the fake brain and the fixture data. Import isolate.ts
// first. Returns the port and helpers to open WebSocket clients that record what they receive.
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { TEST_DIR } from "./isolate.js";

export async function startGateway(opts: { seed?: boolean } = {}) {
  process.env.LH_FAKE_BRAIN = "1";
  process.env.LH_FAKE_DELAY_MS ??= "30";
  process.env.LH_NO_VOICE = "1";
  process.env.PORT = "0";
  process.env.HOST = "127.0.0.1";
  if (opts.seed !== false) await (await import("./fixtures/seed.js")).seed(TEST_DIR);
  const { server } = await import("../src/gateway/server.js");
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const opened: WebSocket[] = [];
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    client: async (o: { hello?: Record<string, unknown> } = {}) => {
      const c = await openClient(port, o.hello);
      opened.push(c.ws);
      return c;
    },
    /** Close every socket and the server, then exit. Exiting with sockets still open can crash Node on Windows. */
    async stop(code = 0) {
      for (const ws of opened) ws.terminate();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      setTimeout(() => process.exit(code), 50);
    },
  };
}

export type Received = Record<string, unknown> & { type: string };

/** A WebSocket client that keeps every message. hello: send this first (a v2 client); omit for a v1 client. */
export async function openClient(port: number, hello?: Record<string, unknown>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const got: Received[] = [];
  const waiters: { pred: (m: Received) => boolean; resolve: (m: Received) => void }[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as Received;
    got.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
  });
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  if (hello) ws.send(JSON.stringify({ type: "hello", ...hello }));
  return {
    ws,
    got,
    send: (m: Record<string, unknown>) => ws.send(JSON.stringify(m)),
    /** Resolves with the first message (already received or still to come) matching pred. */
    waitFor: (pred: (m: Received) => boolean, ms = 5000) =>
      new Promise<Received>((resolve, reject) => {
        const seen = got.find(pred);
        if (seen) return resolve(seen);
        const t = setTimeout(() => reject(new Error(`timed out; got ${got.map((g) => g.type).join(", ")}`)), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
    close: () => ws.close(),
  };
}

/** A message reduced to what must stay the same between runs (no ids, nonces or times). */
export function shape(m: Received): unknown {
  const keep = (v: unknown, k = ""): unknown => {
    if (Array.isArray(v)) return v.map((x) => keep(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((key) => [key, keep((v as Record<string, unknown>)[key], key)]));
    if (typeof v === "string" && /(^id$|_id$|nonce|_at$|^at$|ms$)/.test(k)) return `<${k}>`;
    if (typeof v === "number" && /(ms$|_at$)/.test(k)) return `<${k}>`;
    return v;
  };
  return keep(m);
}
