import "../isolate.js";
import assert from "node:assert/strict";
import { webPicture, publicAddress, MAX_PICTURE_BYTES, type PictureFetch } from "../../src/pages/pictures.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const resolve = async () => ["93.184.215.14"];
const response = (type: string, bytes: Buffer, extra = {}) => ({ status: 200, type, body: (async function* () { yield bytes; })(), ...extra });
const fetch: PictureFetch = async () => response("image/png", png);
assert.ok((await webPicture("https://pictures.example/one.png", "An album", { resolve, fetch })).data);
assert.match((await webPicture("https://pictures.example/text", "An album", { resolve, fetch: async () => response("text/html", Buffer.from("<html>")) })).missing!, /supported picture/);
assert.match((await webPicture("https://pictures.example/false.png", "An album", { resolve, fetch: async () => response("image/png", Buffer.from("not a picture")) })).missing!, /supported picture/);
assert.match((await webPicture("https://pictures.example/large.png", "An album", { resolve, fetch: async () => response("image/png", png, { length: MAX_PICTURE_BYTES + 1 }) })).missing!, /2 MB/);
assert.match((await webPicture("https://pictures.example/stream.png", "An album", { resolve, fetch: async () => response("image/png", Buffer.alloc(MAX_PICTURE_BYTES + 1)) })).missing!, /2 MB/);
let called = 0;
for (const host of ["127.0.0.1", "10.0.0.2", "192.168.2.1", "100.64.0.1", "[::1]", "[::ffff:127.0.0.1]", "[fd00::1]", "localhost"]) {
  const r = await webPicture(`http://${host}/a.png`, "A picture", { resolve, fetch: async (...args) => { called++; return fetch(...args); } }); assert.ok(r.missing, host);
}
assert.equal(called, 0);
assert.ok(!publicAddress("169.254.1.1") && publicAddress("2606:4700:4700::1111"));
const dns = await webPicture("https://pictures.example/a.png", "A picture", { resolve: async () => ["93.184.215.14", "127.0.0.1"], fetch }); assert.match(dns.missing!, /private/);
const redirect = await webPicture("https://pictures.example/a.png", "A picture", { resolve, fetch: async () => response("image/png", png, { status: 302, location: "http://127.0.0.1/a.png" }) }); assert.match(redirect.missing!, /private/);
const timeout = await webPicture("https://pictures.example/a.png", "A picture", { resolve, fetch: async () => new Promise(() => {}), timeoutMs: 15 }); assert.match(timeout.missing!, /too long/);
console.log("Pictures are checked for type, bytes, time, public addresses and redirects through a fake fetch.");
