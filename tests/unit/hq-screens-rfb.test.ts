import "../isolate.js";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { ByteQueue, ClientFilter, WatchFilter, PIXELS, messageLength, png, serverMessages, u32, vncAuthResponse } from "../../src/hq/screens/rfb.js";

const format = Buffer.concat([Buffer.alloc(4), PIXELS]);
const encodings = Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 255, 255, 255, 33]);
const request = Buffer.from([3, 1, 0, 0, 0, 0, 5, 160, 3, 132]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
const pointer = Buffer.from([5, 1, 0, 40, 0, 60]);
const clip = Buffer.concat([Buffer.from([6, 0, 0, 0]), u32(4), Buffer.from([0, 2, 3, 4])]);
const continuous = Buffer.from([150, 1, 0, 0, 0, 0, 0, 100, 0, 100]);
const fence = Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2]);
const resize = Buffer.from([251, 0, 5, 160, 3, 132, 1, 0, ...Buffer.alloc(16)]);
const recorded = Buffer.concat([format, encodings, request, key, pointer, clip, continuous, fence, resize, request]);
const expected = Buffer.concat([format, encodings, request, request]);
for (let split = 0; split <= recorded.length; split++) {
  const filter = new WatchFilter();
  assert.deepEqual(Buffer.concat([filter.feed(recorded.subarray(0, split)), filter.feed(recorded.subarray(split))]), expected);
}
{
  const filter = new WatchFilter();
  assert.deepEqual(Buffer.concat([...recorded].map((byte) => filter.feed(Buffer.from([byte])))), expected);
}
for (const msg of [format, encodings, request, key, pointer, clip, continuous, fence, resize]) {
  assert.equal(messageLength(msg), msg.length);
  for (let split = 1; split < msg.length; split++) {
    const filter = new ClientFilter("control");
    assert.deepEqual(Buffer.concat([filter.feed(msg.subarray(0, split)), filter.feed(msg.subarray(split))]), msg);
  }
}
const poisoned = new WatchFilter();
assert.throws(() => poisoned.feed(Buffer.from([255, 3])));
assert.equal(poisoned.feed(request).length, 0);
for (const mode of ["watch", "control"] as const) {
  const filter = new ClientFilter(mode);
  const large = Buffer.concat([Buffer.from([6, 0, 0, 0]), u32(65537), Buffer.alloc(65537, 3)]);
  for (let n = 0; n < large.length; n += 17) assert.equal(filter.feed(large.subarray(n, n + 17)).length, 0);
  assert.deepEqual(filter.feed(request), request);
  const signed = Buffer.concat([Buffer.from([6, 0, 0, 0]), Buffer.from([255, 255, 255, 252]), Buffer.from([3, 3, 3, 3]), request]);
  assert.deepEqual(filter.feed(signed), mode === "watch" ? request : signed);
}
assert.equal(vncAuthResponse("", Buffer.alloc(16)).toString("hex"), "8ca64de9c1b123a78ca64de9c1b123a7");
const classicPassword = Buffer.from(Buffer.from("133457799bbcdff1", "hex").map((x) => {
  let result = 0; for (let n = 0; n < 8; n++) result |= ((x >> n) & 1) << (7 - n); return result;
})).toString("latin1");
assert.equal(vncAuthResponse(classicPassword, Buffer.from("0123456789abcdef0123456789abcdef", "hex")).toString("hex"), "85e813540f0ab40585e813540f0ab405");
assert.throws(() => vncAuthResponse("", Buffer.alloc(15)));
assert.deepEqual(vncAuthResponse("12345678extra", Buffer.alloc(16)), vncAuthResponse("12345678", Buffer.alloc(16)));

const pixels = Buffer.from([3, 10, 20, 0, 200, 100, 50, 0]);
const image = png({ width: 2, height: 1, pixels });
assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(image.readUInt32BE(16), 2); assert.equal(image.readUInt32BE(20), 1);
const dataLength = image.readUInt32BE(33);
assert.deepEqual(inflateSync(image.subarray(41, 41 + dataLength)), Buffer.from([0, 20, 10, 3, 50, 100, 200]));
for (const copy of [false, true]) {
  const q = new ByteQueue(), sent: Buffer[] = [];
  const rect = Buffer.alloc(12); rect.writeUInt16BE(2, 4); rect.writeUInt16BE(1, 6);
  const picture = Buffer.concat([Buffer.from([0, 0, 0, 1]), rect, pixels]);
  const text = Buffer.concat([Buffer.from([3, 0, 0, 0]), u32(4), Buffer.from("test")]);
  const running = serverMessages(q, { width: 2, height: 1, bytesPerPixel: () => 4, copy, send: (b) => sent.push(b) });
  for (const byte of Buffer.concat([text, picture, text])) { q.push(Buffer.from([byte])); await new Promise<void>((r) => setImmediate(r)); }
  q.close(); await assert.rejects(running);
  assert.deepEqual(Buffer.concat(sent), copy ? Buffer.concat([text, picture, text]) : picture);
}
{
  const q = new ByteQueue(), frames: Buffer[] = [];
  const running = serverMessages(q, { width: 2, height: 1, bytesPerPixel: () => 4, copy: false, send() {}, frame(f) { frames.push(Buffer.from(f.pixels)); } });
  const rect = Buffer.alloc(12); rect.writeUInt16BE(1, 4); rect.writeUInt16BE(1, 6);
  q.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), rect, pixels.subarray(0, 4)]));
  await new Promise<void>((r) => setImmediate(r)); assert.equal(frames.length, 0);
  rect.writeUInt16BE(1, 0);
  q.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), rect, pixels.subarray(4)]));
  await new Promise<void>((r) => setImmediate(r)); assert.deepEqual(frames, [pixels]);
  q.close(); await assert.rejects(running);
}
console.log("screen messages, access checks and pictures: ok");
