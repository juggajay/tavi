// A small WebSocket client (RFC 6455) using only what comes with Node, so the helper runs on any Node the second PC has
// (the built-in WebSocket only arrived in Node 22). It opens one connection OUT to the gateway; it never listens.
// Text messages only (the helper speaks JSON); pings are answered; no extensions.
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** The most one message from the gateway may be (its requests are small). */
const MAX_MESSAGE = 8 * 1024 * 1024;

export type WsHandlers = {
  onMessage: (text: string) => void;
  onClose: (code: number, reason: string) => void;
};

export type WsConn = {
  send: (text: string) => void;
  ping: () => void;
  close: (code?: number, reason?: string) => void;
  /** When anything last arrived from the gateway (any frame, including a pong). */
  lastHeard: () => number;
};

/** Connects to a ws:// or wss:// address. Resolves once the gateway has accepted the WebSocket; rejects otherwise. */
export function connectWs(address: string, headers: Record<string, string>, h: WsHandlers, timeoutMs = 15_000): Promise<WsConn> {
  const u = new URL(address);
  const key = randomBytes(16).toString("base64");
  const secure = u.protocol === "wss:";
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    const req = (secure ? httpsRequest : httpRequest)({
      host: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || (secure ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: "GET",
      servername: secure ? u.hostname : undefined,
      headers: { ...headers, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" },
    });
    req.setTimeout(timeoutMs, () => (req.destroy(), fail(new Error("timed out connecting"))));
    req.on("error", (e) => fail(e));
    req.on("response", (res: IncomingMessage) => {
      res.resume();
      fail(new Error(`the gateway answered ${res.statusCode} instead of opening the line`));
    });
    req.on("upgrade", (res: IncomingMessage, sock: Duplex, head: Buffer) => {
      const expect = createHash("sha1").update(key + GUID).digest("base64");
      if (res.statusCode !== 101 || res.headers["sec-websocket-accept"] !== expect) {
        sock.destroy();
        return fail(new Error("the gateway's answer wasn't a proper WebSocket"));
      }
      settled = true;
      resolve(wrap(sock, head, h));
    });
    req.end();
  });
}

function wrap(sock: Duplex, head: Buffer, h: WsHandlers): WsConn {
  let buf: Buffer = Buffer.alloc(0);
  let parts: Buffer[] = [];
  let partsLen = 0;
  let heard = Date.now();
  let closed = false;
  let closeSent = false;
  const s = sock as Duplex & { setNoDelay?: (on: boolean) => void; setKeepAlive?: (on: boolean, ms: number) => void };
  s.setNoDelay?.(true);
  s.setKeepAlive?.(true, 30_000);

  const frame = (opcode: number, payload: Buffer) => {
    if (closed) return;
    const mask = randomBytes(4);
    const len = payload.length;
    const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (len < 126) header[1] = 0x80 | len;
    else if (len < 65536) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
    sock.write(Buffer.concat([header, mask, body]));
  };

  /** gentle: let a close frame just written reach the gateway before the line is cut. */
  const finish = (code: number, reason: string, gentle = false) => {
    if (closed) return;
    closed = true;
    if (gentle) {
      sock.end();
      setTimeout(() => sock.destroy(), 500).unref();
    } else sock.destroy();
    h.onClose(code, reason);
  };

  const sendClose = (code: number, reason = "") => {
    if (closeSent || closed) return;
    closeSent = true;
    const r = Buffer.from(reason.slice(0, 100), "utf8");
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    frame(0x8, p);
  };

  const onData = (chunk: Buffer) => {
    heard = Date.now();
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 2) {
      const b0 = buf[0],
        b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if (b0 & 0x70) return protocolError("extensions aren't used");
      if (b1 & 0x80) return protocolError("the gateway must not mask");
      let len = b1 & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return protocolError("message too big");
        len = Number(big);
        at = 10;
      }
      if (len > MAX_MESSAGE) return protocolError("message too big");
      if (buf.length < at + len) return;
      const payload = buf.subarray(at, at + len);
      buf = buf.subarray(at + len);
      if (opcode >= 0x8) {
        if (!fin || len > 125) return protocolError("bad control frame");
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
          sendClose(code === 1005 || code < 1000 || code >= 5000 ? 1000 : code);
          return finish(code, reason, true);
        }
        if (opcode === 0x9) frame(0xa, Buffer.from(payload));
        continue; // a pong only says it's still there
      }
      if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) return protocolError("unknown frame");
      if (opcode !== 0x0 && parts.length) return protocolError("a new message started inside another");
      if (opcode === 0x0 && !parts.length) return protocolError("a continuation with nothing to continue");
      partsLen += len;
      if (partsLen > MAX_MESSAGE) return protocolError("message too big");
      parts.push(Buffer.from(payload));
      if (fin) {
        const text = Buffer.concat(parts).toString("utf8");
        parts = [];
        partsLen = 0;
        try {
          h.onMessage(text);
        } catch {}
      }
    }
  };

  const protocolError = (why: string) => {
    sendClose(1002, why);
    finish(1002, why);
  };

  sock.on("data", onData);
  sock.on("close", () => finish(1006, "the line dropped"));
  sock.on("error", () => finish(1006, "the line dropped"));
  if (head.length) onData(head);

  return {
    send: (text) => frame(0x1, Buffer.from(text, "utf8")),
    ping: () => frame(0x9, Buffer.alloc(0)),
    close: (code = 1000, reason = "") => {
      sendClose(code, reason);
      finish(code, reason, true);
    },
    lastHeard: () => heard,
  };
}
