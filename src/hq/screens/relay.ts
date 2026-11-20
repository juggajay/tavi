import { createConnection, type Socket } from "node:net";
import { WebSocket, type RawData } from "ws";
import type { Bot, SafetyLevel } from "../contract.js";
import { screenPorts } from "../../guard/fence.js";
import { ByteQueue, ClientFilter, MAX_BYTES, PIXELS, RAW_ENCODINGS, browserHandshake, png, serverMessages, upstreamHandshake } from "./rfb.js";

export type ScreenSession = { botId: string; mode: "watch" | "control"; copyFromScreen?: boolean };
export type RelayDeps = {
  bot(id: string): Bot | undefined;
  password(id: string): Promise<string> | string;
  level(): SafetyLevel;
  events(on: () => void): () => void;
  audit(id: string, control: boolean): Promise<void> | void;
  notice(id: string, text: string): Promise<void> | void;
  connect?(port: number): Socket;
  timeoutMs?: number;
};
const bytes = (data: RawData) => Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);

export function createScreenRelay(deps: RelayDeps) {
  const cache = new Map<string, { at: number; value: Buffer }>();
  const pending = new Map<string, Promise<Buffer>>();
  const active = new Set<() => void>();
  const controllers = new Set<string>();
  const sessions = new Map<() => void, string>();
  let ended = false;
  const off = deps.events(() => { if (deps.level() !== "open") { cache.clear(); for (const close of active) close(); } });
  function target(id: string) {
    if (ended) throw new Error("Screens are closed.");
    if (deps.level() !== "open") throw new Error("Open the safety switch to see this screen.");
    const bot = deps.bot(id);
    if (!bot?.computer || bot.box.user !== `bot-${id}`) throw new Error("This bot has no computer ready.");
    return screenPorts(bot.box.user, bot.box);
  }
  function connect(port: number) {
    const socket = deps.connect?.(port) ?? createConnection({ host: "127.0.0.1", port });
    socket.setNoDelay();
    return socket;
  }
  async function attach(client: WebSocket, session: ScreenSession): Promise<void> {
    let upstream: Socket | undefined, control = false, closed = false;
    let notified = false;
    let notification: Promise<void> = Promise.resolve();
    const fromClient = new ByteQueue(), fromUp = new ByteQueue();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkOpen = () => { if (closed || deps.level() !== "open") throw new Error("The screen connection ended."); };
    const close = () => {
      if (closed) return; closed = true; clearTimeout(timer);
      fromClient.close(); fromUp.close(); upstream?.destroy(); active.delete(close); sessions.delete(close);
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(1000, "The screen connection ended.");
      if (control) {
        controllers.delete(session.botId);
        if (notified) void notification.catch(() => {}).then(() => deps.audit(session.botId, false))
          .then(() => deps.notice(session.botId, "The owner has handed back the mouse and keyboard")).catch(() => {});
      }
    };
    active.add(close);
    sessions.set(close, session.botId);
    const sendClient = (b: Buffer) => { checkOpen(); if (client.bufferedAmount > MAX_BYTES) throw new Error("The viewer is falling behind."); client.send(b); };
    const sendUp = (b: Buffer) => { checkOpen(); if (!upstream || upstream.writableLength > MAX_BYTES) throw new Error("The screen is falling behind."); upstream.write(b); };
    client.on("message", (data, binary) => { if (!binary) { close(); return; } fromClient.push(bytes(data)); });
    client.once("close", close); client.once("error", close);
    timer = setTimeout(close, deps.timeoutMs ?? 10000); timer.unref();
    try {
      if (session.mode !== "watch" && session.mode !== "control") throw new Error("Choose watch or control.");
      const port = target(session.botId);
      if (session.mode === "control" && controllers.has(session.botId)) throw new Error("Another viewer already has the mouse and keyboard.");
      // Reserve control before the first wait, so two callers cannot take it together.
      if (session.mode === "control") { controllers.add(session.botId); control = true; }
      const password = await deps.password(session.botId); checkOpen();
      upstream = connect(port.vncPort);
      upstream.on("data", (b: Buffer) => fromUp.push(b)); upstream.once("error", close); upstream.once("close", close);
      const init = await upstreamHandshake(fromUp, sendUp, password);
      sendUp(Buffer.concat([Buffer.alloc(4), PIXELS]));
      PIXELS.copy(init, 4);
      checkOpen();
      await browserHandshake(fromClient, sendClient, init); checkOpen();
      if (control) {
        notified = true;
        notification = Promise.resolve().then(() => deps.audit(session.botId, true))
          .then(() => deps.notice(session.botId, "The owner has taken the mouse and keyboard"));
        await notification; checkOpen();
      }
      clearTimeout(timer);
      const filter = new ClientFilter(session.mode, (b) => {
        if (b[0] === 2) return RAW_ENCODINGS;
        if (b[0] === 0) {
          // noVNC and the still reader use opposite red and blue byte orders.
          const standard = b.subarray(4, 14).equals(PIXELS.subarray(0, 10));
          const shifts = b[15] === 8 && ((b[14] === 16 && b[16] === 0) || (b[14] === 0 && b[16] === 16));
          if (!standard || !shifts) throw new Error("The viewer chose an unsupported picture format.");
        }
        return b;
      });
      // Use raw pictures even before the viewer's first list of picture formats arrives.
      sendUp(RAW_ENCODINGS);
      const incoming = serverMessages(fromUp, { bytesPerPixel: () => 4, copy: !!session.copyFromScreen,
        send: sendClient, width: init.readUInt16BE(0), height: init.readUInt16BE(2) });
      const outgoing = (async () => {
        for (;;) {
          // Reading one byte here also handles messages already queued during sign-in.
          const first = await fromClient.read(1);
          const b = filter.feed(Buffer.concat([first, fromClient.takeAll()]));
          if (b.length) sendUp(b);
        }
      })();
      await Promise.race([incoming, outgoing]);
    } catch { /* End quietly. Access keys and remote error text never go to a viewer or log. */ }
    finally { close(); }
  }
  async function capture(id: string): Promise<Buffer> {
    const port = target(id), q = new ByteQueue();
    let socket: Socket | undefined;
    let stopped = false;
    let rejectFrame!: (e: Error) => void;
    const frame = new Promise<Buffer>((resolve, reject) => { rejectFrame = reject; void resolve; });
    // Attach a handler immediately, including while the password is being read.
    void frame.catch(() => {});
    const close = () => { stopped = true; q.close(); socket?.destroy(); rejectFrame(new Error("The screen picture could not be read.")); };
    active.add(close);
    sessions.set(close, id);
    const timer = setTimeout(close, deps.timeoutMs ?? 10000); timer.unref();
    try {
      const password = await deps.password(id);
      if (stopped) throw new Error("The screen connection ended.");
      target(id);
      socket = connect(port.vncPort); socket.on("data", (b: Buffer) => q.push(b)); socket.once("error", close); socket.once("close", close);
      const send = (b: Buffer) => { if (stopped || deps.level() !== "open") throw new Error("The screen connection ended."); socket!.write(b); };
      const init = await upstreamHandshake(q, send, password);
      const width = init.readUInt16BE(0), height = init.readUInt16BE(2);
      send(Buffer.concat([Buffer.alloc(4), PIXELS])); send(RAW_ENCODINGS);
      const request = Buffer.alloc(10); request[0] = 3; request.writeUInt16BE(width, 6); request.writeUInt16BE(height, 8); send(request);
      let resolvePicture!: (b: Buffer) => void;
      const picture = new Promise<Buffer>((resolve) => { resolvePicture = resolve; });
      const reading = serverMessages(q, { width, height, bytesPerPixel: () => 4, copy: false, send() {}, frame(f) { resolvePicture(png(f)); } });
      const value = await Promise.race([picture, frame, reading.then(() => { throw new Error("The screen picture ended early."); })]);
      target(id); return value;
    } finally { clearTimeout(timer); active.delete(close); sessions.delete(close); close(); }
  }
  async function screenshot(id: string): Promise<Buffer> {
    target(id);
    const saved = cache.get(id);
    if (saved && Date.now() - saved.at < 2000) return Buffer.from(saved.value);
    let work = pending.get(id);
    if (!work) {
      work = capture(id).then((value) => { target(id); cache.set(id, { at: Date.now(), value }); return value; }).finally(() => pending.delete(id));
      pending.set(id, work);
    }
    return Buffer.from(await work);
  }
  function invalidate(id: string) { cache.delete(id); for (const [close, bot] of sessions) if (id === bot) close(); }
  function close() { ended = true; off(); cache.clear(); for (const end of active) end(); }
  return { attach, screenshot, invalidate, close };
}

let mounted: ReturnType<typeof createScreenRelay> | undefined;
export function configureScreens(deps: RelayDeps) { mounted?.close(); mounted = createScreenRelay(deps); return mounted; }
export function attach(socket: WebSocket, session: ScreenSession): Promise<void> {
  if (!mounted) { socket.close(1000, "Screens are not ready yet."); return Promise.resolve(); }
  return mounted.attach(socket, session);
}
export function screenshot(botId: string): Promise<Buffer> {
  if (!mounted) return Promise.reject(new Error("Screens are not ready yet."));
  return mounted.screenshot(botId);
}
