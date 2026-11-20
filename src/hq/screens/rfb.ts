/*
Screen handshake and message framing adapted from Bot HQ.
MIT License
Copyright (c) 2026 Nick Vasilescu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { createCipheriv } from "node:crypto";
import { deflateSync } from "node:zlib";

export const VERSION = Buffer.from("RFB 003.008\n");
export const MAX_BYTES = 32 * 1024 * 1024;
export const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
export const PIXELS = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
export const RAW_ENCODINGS = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]);

// Three identical DES keys give the original DES result, using Node's supported cipher.
export function vncAuthResponse(password: string, challenge: Uint8Array): Buffer {
  if (challenge.length !== 16) throw new Error("The screen sent a damaged access check.");
  const key = Buffer.alloc(8);
  const bytes = Buffer.from(password, "latin1");
  for (let n = 0; n < 8; n++) for (let bit = 0; bit < 8; bit++) key[n] |= (((bytes[n] ?? 0) >> bit) & 1) << (7 - bit);
  const cipher = createCipheriv("des-ede3", Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

export class ByteQueue {
  private parts: Buffer[] = [];
  private size = 0;
  private waiting?: { n: number; resolve(b: Buffer): void; reject(e: Error): void };
  private error?: Error;
  push(b: Buffer) {
    if (this.error) return;
    if (this.size + b.length > MAX_BYTES) { this.close(); return; }
    this.parts.push(b); this.size += b.length; this.drain();
  }
  close() { this.error = new Error("The screen connection ended."); this.waiting?.reject(this.error); this.waiting = undefined; this.parts = []; this.size = 0; }
  read(n: number): Promise<Buffer> {
    if (!Number.isInteger(n) || n < 0 || n > MAX_BYTES) return Promise.reject(new Error("The screen sent too much at once."));
    if (this.error) return Promise.reject(this.error);
    if (this.waiting) return Promise.reject(new Error("The screen read is already waiting."));
    return new Promise((resolve, reject) => { this.waiting = { n, resolve, reject }; this.drain(); });
  }
  takeAll(): Buffer { const out = Buffer.concat(this.parts, this.size); this.parts = []; this.size = 0; return out; }
  private drain() {
    const w = this.waiting;
    if (!w || this.size < w.n) return;
    const all = Buffer.concat(this.parts, this.size);
    const out = Buffer.from(all.subarray(0, w.n));
    this.parts = [all.subarray(w.n)]; this.size -= w.n; this.waiting = undefined; w.resolve(out);
  }
}

export async function upstreamHandshake(q: ByteQueue, send: (b: Buffer) => void, password: string): Promise<Buffer> {
  if (!(await q.read(12)).equals(VERSION)) throw new Error("The screen uses an unsupported connection version.");
  send(VERSION);
  const count = (await q.read(1))[0];
  if (!count || !(await q.read(count)).includes(2)) throw new Error("The screen must ask for its access key.");
  send(Buffer.from([2]));
  send(vncAuthResponse(password, await q.read(16)));
  if ((await q.read(4)).readUInt32BE() !== 0) throw new Error("The screen refused its access key.");
  send(Buffer.from([1]));
  const head = await q.read(24), nameLength = head.readUInt32BE(20);
  if (nameLength > 4096 || !head.readUInt16BE(0) || !head.readUInt16BE(2) || head.readUInt16BE(0) * head.readUInt16BE(2) > 3840 * 2160) throw new Error("The screen sent an unsupported size.");
  return Buffer.concat([head, await q.read(nameLength)]);
}
export async function browserHandshake(q: ByteQueue, send: (b: Buffer) => void, init: Buffer) {
  send(VERSION);
  if (!(await q.read(12)).equals(VERSION)) throw new Error("The viewer uses an unsupported connection version.");
  send(Buffer.from([1, 1]));
  if ((await q.read(1))[0] !== 1) throw new Error("The viewer chose an unsupported access check.");
  send(u32(0)); await q.read(1); send(init);
}

export function messageLength(b: Buffer): number {
  switch (b[0]) {
    case 0: return 20;
    case 2: return b.length < 4 ? 0 : 4 + 4 * b.readUInt16BE(2);
    case 3: return 10;
    case 4: return 8;
    case 5: return 6;
    case 6: return b.length < 8 ? 0 : 8 + Math.abs(b.readInt32BE(4));
    case 150: return 10;
    case 248: return b.length < 9 ? 0 : 9 + b[8];
    case 251: return b.length < 8 ? 0 : 8 + 16 * b[6];
    default: return -1;
  }
}
export class ClientFilter {
  private pending: Buffer = Buffer.alloc(0);
  private skip = 0;
  private ended = false;
  constructor(private mode: "watch" | "control", private transform: (b: Buffer) => Buffer = (b) => b) {}
  feed(chunk: Buffer): Buffer {
    if (this.ended) return Buffer.alloc(0);
    if (this.skip) { const n = Math.min(chunk.length, this.skip); chunk = chunk.subarray(n); this.skip -= n; }
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > MAX_BYTES) throw new Error("The viewer sent too much at once.");
    const out: Buffer[] = [];
    while (this.pending.length) {
      const b = this.pending, len = messageLength(b);
      if (len < 0) { this.ended = true; this.pending = Buffer.alloc(0); throw new Error("The viewer sent an unsupported message."); }
      if (!len) break;
      if (b[0] === 6 && len > 8 + 65536) {
        const n = Math.min(len, b.length); this.pending = b.subarray(n); this.skip = len - n;
        if (this.skip) break;
        continue;
      }
      if (b.length < len) break;
      if (this.mode === "control" || [0, 2, 3].includes(b[0])) out.push(this.transform(Buffer.from(b.subarray(0, len))));
      this.pending = b.subarray(len);
    }
    return Buffer.concat(out);
  }
}
export class WatchFilter extends ClientFilter { constructor() { super("watch"); } }

export type Frame = { width: number; height: number; pixels: Buffer };
// Raw pictures keep message boundaries simple, so clipboard text can never hide in a picture.
export async function serverMessages(q: ByteQueue, options: {
  bytesPerPixel(): number; copy: boolean; send(b: Buffer): void; frame?(frame: Frame): void; width: number; height: number;
}) {
  const width = options.width, height = options.height;
  let pixels: Buffer | undefined;
  if (options.frame) pixels = Buffer.alloc(width * height * 4);
  const seen = options.frame ? Buffer.alloc(width * height) : undefined;
  let remaining = width * height;
  for (;;) {
    const type = (await q.read(1))[0];
    if (type === 2) { options.send(Buffer.from([2])); continue; }
    if (type === 3) {
      const head = await q.read(7), size = Math.abs(head.readInt32BE(3));
      if (size > MAX_BYTES) throw new Error("The screen sent too much text.");
      const text = await q.read(size);
      if (options.copy && size <= 65536) options.send(Buffer.concat([Buffer.from([3]), head, text]));
      continue;
    }
    if (type === 1) {
      const head = await q.read(5), colours = await q.read(6 * head.readUInt16BE(3));
      options.send(Buffer.concat([Buffer.from([1]), head, colours])); continue;
    }
    if (type !== 0) throw new Error("The screen sent an unsupported message.");
    const head = await q.read(3), count = head.readUInt16BE(1);
    options.send(Buffer.concat([Buffer.from([0]), head]));
    for (let n = 0; n < count; n++) {
      const rect = await q.read(12), x = rect.readUInt16BE(0), y = rect.readUInt16BE(2), w = rect.readUInt16BE(4), h = rect.readUInt16BE(6);
      if (rect.readInt32BE(8) !== 0 || x + w > width || y + h > height) throw new Error("The screen sent an unsupported picture.");
      const data = await q.read(w * h * options.bytesPerPixel());
      options.send(Buffer.concat([rect, data]));
      if (pixels && seen) for (let row = 0; row < h; row++) {
        const offset = (y + row) * width + x;
        data.copy(pixels, offset * 4, row * w * 4, (row + 1) * w * 4);
        for (let col = 0; col < w; col++) if (!seen[offset + col]) { seen[offset + col] = 1; remaining--; }
      }
    }
    if (pixels && remaining === 0) options.frame?.({ width, height, pixels });
  }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
export function png(frame: Frame): Buffer {
  const { width, height, pixels } = frame;
  if (pixels.length !== width * height * 4) throw new Error("The screen picture is incomplete.");
  const chunk = (name: string, data: Buffer) => { const b = Buffer.concat([Buffer.from(name), data]); return Buffer.concat([u32(data.length), b, u32(crc32(b))]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const scan = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (y * width + x) * 4, to = y * (1 + width * 3) + 1 + x * 3;
    scan[to] = pixels[from + 2]; scan[to + 1] = pixels[from + 1]; scan[to + 2] = pixels[from];
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(scan)), chunk("IEND", Buffer.alloc(0))]);
}
