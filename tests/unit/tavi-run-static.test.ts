import "../isolate.js";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { DIST, entryPage, appFile } from "../../src/gateway/static.js";

for (const team of [false, true]) {
  for (const route of ["/", "/index.html", "/v2"]) assert.deepEqual(entryPage(route, team), { file: path.join(DIST, "phone.html"), local: false });
  assert.deepEqual(entryPage("/desktop", team), { file: path.join(DIST, team ? "hq.html" : "desktop.html"), local: true });
  assert.deepEqual(entryPage("/app/desktop.html", team), { file: path.join(DIST, "desktop.html"), local: true });
  assert.equal(appFile("/app/hq.html"), path.join(DIST, "hq.html"));
  assert.equal(entryPage("/something-else", team), null);
}
assert.equal(entryPage("/desktop-classic", false), null);
assert.deepEqual(entryPage("/desktop-classic", true), { file: path.join(DIST, "desktop.html"), local: true });
assert.equal(entryPage("/desktop/../.env", true), null);
// Check the saved start-up result without starting a real team or opening its sign-ins.
const serverSource = readFileSync(new URL("../../src/gateway/server.ts", import.meta.url), "utf8");
const saveBlock = serverSource.match(/  if \(process.env.LH_V3 === "1" && DEV\) \{[\s\S]+?^  \}/m)?.[0];
assert.ok(saveBlock);
for (const team of [false, true]) {
  let saved = "", refreshed: (() => void) | undefined;
  let signedIn = true;
  runInNewContext(saveBlock, {
    process: { env: { LH_V3: team ? "1" : "0" } }, DEV: true, path, DATA_DIR: path.resolve("made-up-practice"),
    hq: { subscriptions: async () => [{ provider: "anthropic", signedIn, privateDetails: "Leave private details out." }, { provider: "openai-codex", signedIn }] },
    mkdir: async () => {}, writeFile: async (_file: string, value: string) => { saved = value; }, rename: async () => {},
    setInterval: (callback: () => void, ms: number) => { assert.equal(ms, 5000); refreshed = callback; return { unref: () => {} }; },
    server: { once: () => {} }, clearInterval: () => {}, console,
  });
  await new Promise(resolve => setImmediate(resolve));
  if (team) {
    const status = JSON.parse(saved); assert.equal(status.data, path.resolve("made-up-practice")); assert.ok(Number.isFinite(Date.parse(status.at)));
    assert.deepEqual(status.subscriptions, { anthropic: true, "openai-codex": true }); assert.equal(saved.includes("private"), false);
    signedIn = false; refreshed!(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(saved).subscriptions, { anthropic: false, "openai-codex": false });
  } else assert.equal(saved, "");
}
console.log("Tavi pages: phone, desktop, previous desktop and the ordinary switch-off routes passed.");
