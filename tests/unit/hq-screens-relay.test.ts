import "../isolate.js";
import assert from "node:assert/strict";
import { createServer, createConnection, type Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { createScreenRelay } from "../../src/hq/screens/relay.js";
import { ByteQueue, PIXELS, VERSION, browserHandshake, u32, upstreamHandshake, vncAuthResponse } from "../../src/hq/screens/rfb.js";
import type { Bot, SafetyLevel } from "../../src/hq/contract.js";

const turn = () => new Promise<void>((r) => setImmediate(r));
async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("The test connection did not answer.")), 3000); })]); }
  finally { clearTimeout(timer); }
}
const init = Buffer.alloc(24); init.writeUInt16BE(2, 0); init.writeUInt16BE(1, 2); PIXELS.copy(init, 4);
const rect = Buffer.alloc(12); rect.writeUInt16BE(2, 4); rect.writeUInt16BE(1, 6);
const picture = Buffer.concat([Buffer.from([0, 0, 0, 1]), rect, Buffer.from([3, 10, 20, 0, 90, 80, 70, 0])]);
const clipboard = Buffer.concat([Buffer.from([3, 0, 0, 0]), u32(4), Buffer.from("copy")]);
const sockets = new Set<Socket>();
let connections = 0, keys = 0, clips = 0, auths = 0, none = false;
const password = "test1234";
const vnc = createServer((socket) => {
  connections++; sockets.add(socket);
  const q = new ByteQueue(); socket.on("data", (b: Buffer) => q.push(b)); socket.once("close", () => { sockets.delete(socket); q.close(); }); socket.on("error", () => q.close());
  void (async () => {
    for (const byte of VERSION) socket.write(Buffer.from([byte]));
    assert.deepEqual(await q.read(12), VERSION);
    if (none) { socket.write(Buffer.from([1, 1])); return; }
    socket.write(Buffer.from([1, 2])); assert.equal((await q.read(1))[0], 2);
    const challenge = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"); socket.write(challenge);
    assert.deepEqual(await q.read(16), vncAuthResponse(password, challenge)); auths++;
    socket.write(u32(0)); await q.read(1); socket.write(init);
    for (;;) {
      const type = (await q.read(1))[0];
      if (type === 0) await q.read(19);
      else if (type === 2) { const head = await q.read(3); await q.read(4 * head.readUInt16BE(1)); }
      else if (type === 3) { await q.read(9); socket.write(clipboard); socket.write(picture); socket.write(clipboard); }
      else if (type === 4) { await q.read(7); keys++; }
      else if (type === 5) await q.read(5);
      else if (type === 6) { const head = await q.read(7); await q.read(head.readUInt32BE(3)); clips++; }
      else throw new Error("The fake screen received an unexpected message.");
    }
  })().catch(() => socket.destroy());
});
await new Promise<void>((resolve) => vnc.listen(0, "127.0.0.1", resolve));
const port = (vnc.address() as { port: number }).port;
let level: SafetyLevel = "open", event: () => void = () => {};
const notices: string[] = [], audits: boolean[] = [];
const bot: Bot = { id: "test", name: "Test", role: "", soul: "", look: { shape: "pebble", colour: "blue" }, engine: "hermes", primary: { provider: "anthropic", model: "test" }, fallbacks: [], servers: [], computer: true, voice: "marin", box: { user: "bot-test", display: 1, vncPort: 5911, cdpPort: 9211 }, generation: 0, lead: true, createdAt: "" };
const relay = createScreenRelay({ bot: (id) => id === "test" ? bot : undefined, password: () => password, level: () => level,
  events(on) { event = on; return () => { event = () => {}; }; }, audit(_id, control) { audits.push(control); }, notice(_id, text) { notices.push(text); },
  connect: () => createConnection({ host: "127.0.0.1", port }), timeoutMs: 1000 });
let mode: "watch" | "control" = "watch", copy = false;
const wsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise<void>((r) => wsServer.once("listening", r));
const wsPort = (wsServer.address() as { port: number }).port;
wsServer.on("connection", (socket) => { void relay.attach(socket, { botId: "test", mode, copyFromScreen: copy }); });
const viewers = new Set<WebSocket>();
async function viewer() {
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`), q = new ByteQueue(); viewers.add(socket);
  socket.on("message", (b: Buffer) => q.push(b)); socket.once("close", () => { viewers.delete(socket); q.close(); }); socket.on("error", () => q.close());
  await within(new Promise<void>((r, j) => { socket.once("open", r); socket.once("error", j); }));
  return { socket, q };
}
async function viewerReady() {
  const v = await viewer();
  // The viewer sees None. Its access key never crosses this connection.
  const header = await within(upstreamHandshake(v.q, (b) => v.socket.send(b), password).then(() => false, () => true));
  assert.equal(header, true);
  v.socket.close(); return v;
}
async function ready() {
  const v = await viewer();
  assert.deepEqual(await within(v.q.read(12)), VERSION); v.socket.send(VERSION);
  assert.deepEqual(await within(v.q.read(2)), Buffer.from([1, 1])); v.socket.send(Buffer.from([1]));
  assert.deepEqual(await within(v.q.read(4)), u32(0)); v.socket.send(Buffer.from([1]));
  assert.deepEqual(await within(v.q.read(24)), init); return v;
}
const request = Buffer.from([3, 0, 0, 0, 0, 0, 0, 2, 0, 1]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
try {
  const a = await ready();
  for (const byte of key) a.socket.send(Buffer.from([byte]));
  a.socket.send(request); assert.deepEqual(await within(a.q.read(picture.length)), picture);
  await turn(); assert.equal(a.q.takeAll().length, 0); assert.equal(keys, 0); assert.equal(clips, 0);
  a.socket.close();
  mode = "control";
  const b = await ready();
  b.socket.send(key); b.socket.send(request);
  assert.deepEqual(await within(b.q.read(picture.length)), picture);
  assert.equal(keys, 1); assert.deepEqual(audits, [true]);
  assert.equal(notices[0], "The owner has taken the mouse and keyboard");
  const occupiedCount = connections;
  const occupied = await viewer();
  await within(new Promise<void>((r) => occupied.socket.once("close", () => r())));
  assert.equal(connections, occupiedCount);
  assert.deepEqual(audits, [true]);
  const large = Buffer.concat([Buffer.from([6, 0, 0, 0]), u32(65537), Buffer.alloc(65537)]);
  b.socket.send(large.subarray(0, 101)); b.socket.send(Buffer.concat([large.subarray(101), key, request]));
  assert.deepEqual(await within(b.q.read(picture.length)), picture); assert.equal(keys, 2); assert.equal(clips, 0);
  level = "paused"; event(); await within(new Promise<void>((r) => b.socket.once("close", () => r())));
  await turn(); assert.deepEqual(audits, [true, false]); assert.equal(notices[1], "The owner has handed back the mouse and keyboard");
  const beforeRefusal = connections;
  const blocked = await viewer(); await within(new Promise<void>((r) => blocked.socket.once("close", () => r())));
  assert.equal(connections, beforeRefusal);
  await assert.rejects(relay.screenshot("test"));
  level = "open"; event(); mode = "watch"; copy = true;
  const c = await ready(); c.socket.send(request);
  assert.deepEqual(await within(c.q.read(clipboard.length + picture.length + clipboard.length)), Buffer.concat([clipboard, picture, clipboard])); c.socket.close();
  const beforeShot = connections;
  const [one, two] = await within(Promise.all([relay.screenshot("test"), relay.screenshot("test")]));
  assert.deepEqual(one, two); assert.equal(one.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(connections, beforeShot + 1); assert.deepEqual(await relay.screenshot("test"), one); assert.equal(connections, beforeShot + 1);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 2100;
    await relay.screenshot("test"); assert.equal(connections, beforeShot + 2);
  } finally { Date.now = realNow; }
  assert(auths >= 4);
  level = "walled"; event(); await assert.rejects(relay.screenshot("test")); level = "open"; event();
  await relay.screenshot("test"); assert.equal(connections, beforeShot + 3);
  none = true;
  await viewerReady();
  await assert.rejects(relay.screenshot("missing"));
  const q = new ByteQueue(); q.push(Buffer.from("RFB 003.003\n")); await assert.rejects(upstreamHandshake(q, () => {}, password));
  const browser = new ByteQueue(); browser.push(Buffer.concat([VERSION, Buffer.from([2])]));
  await assert.rejects(browserHandshake(browser, () => {}, init));
} finally {
  relay.close(); for (const client of viewers) client.terminate(); for (const socket of wsServer.clients) socket.terminate();
  await new Promise<void>((r) => wsServer.close(() => r()));
  for (const socket of sockets) socket.destroy(); await new Promise<void>((r) => vnc.close(() => r()));
}
console.log("screen relay and safety switch: ok");
