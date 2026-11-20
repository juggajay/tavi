// The brain's web-fetch guard: public pages open; local, private-network, file and data-smuggling addresses don't.
import "../isolate.js"; // first: a private, throwaway data folder
import assert from "node:assert/strict";
import { webFetchBlockReason } from "../../src/brain/guards.js";

const allowed = ["https://weather.example.com/forecast", "http://example.com/page?q=door+hardware"];
const blocked = [
  "http://localhost:3077/api/setup/status",
  "http://127.0.0.1:3078/api/health",
  "http://192.168.0.10/admin",
  "https://device.example.ts.net/",
  "http://device.example.local/",
  "https://user:pass@example.com/",
  "https://evil.example/collect?d=" + "x".repeat(200),
  "file:///C:/Users/you/.env",
  "not a url",
];
for (const u of allowed) assert.equal(webFetchBlockReason(u), null, `should allow ${u}`);
for (const u of blocked) assert.notEqual(webFetchBlockReason(u), null, `should block ${u}`);
console.log(`guard: ${allowed.length} allowed, ${blocked.length} blocked, all as expected`);
