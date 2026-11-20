// The /app/ file server never reaches outside web/dist, and caches hashed assets for good but never HTML.
import "../isolate.js"; // first
import assert from "node:assert/strict";
import path from "node:path";
import { DIST, appFile, cacheControl } from "../../src/gateway/static.js";

// Exactly what the gateway does with a request path before routing.
const resolve = (raw: string) => appFile(new URL(raw, "http://local").pathname);

for (const raw of [
  "/app/../package.json",
  "/app/%2e%2e/.env",
  "/app/..%2f.env",
  "/app/..%5c.env",
  "/app/assets/..%5c..%5c.env",
  "/app/%2e%2e%2f%2e%2e%2fsrc/gateway/server.ts",
  "/app/C:%5cWindows%5cwin.ini",
  "/app/assets//phone.js",
  "/app/phone.html%00.js",
  "/app/.env",
  "/app/server.ts",
  "/app/",
  "/app/%E0%A4%A",
]) assert.equal(resolve(raw), null, `must refuse ${raw}`);

const html = resolve("/app/phone.html");
assert.equal(html, path.join(DIST, "phone.html"));
assert.equal(cacheControl(html!), "no-cache");
const asset = resolve("/app/assets/phone-abc123.js");
assert.equal(asset, path.join(DIST, "assets", "phone-abc123.js"));
assert.equal(cacheControl(asset!), "public, max-age=31536000, immutable");
assert.equal(cacheControl(resolve("/app/assets/geist-latin-400-normal-x.woff2")!), "public, max-age=31536000, immutable");
console.log("static: traversal refused, html revalidated, hashed assets immutable");
