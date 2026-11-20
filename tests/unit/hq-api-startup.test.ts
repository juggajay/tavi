import "../isolate.js";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { rig, until } from "./hq-api-fixture.test.js";
import { getBot } from "../../src/hq/bots.js";
import { db } from "../../src/store/db.js";

const r = await rig(undefined, {}, 4);
try {
  await until(() => r.calls.some((c) => c.route.includes("/file/")));
  const start = r.calls.findIndex((c) => c.route === "/space/start");
  const make = r.calls.findIndex((c) => c.route === "/team");
  assert.ok(start >= 0 && make > start);
  assert.ok(r.calls.slice(start + 1, make).filter((c) => c.route === "/state").length >= 3);
  await until(() => db.prepare("SELECT value FROM settings WHERE key='team:restart-needed'").get()?.value === "no");
  await Promise.all([r.hq.ensure(getBot("pebble")!), r.hq.ensure(getBot("tim")!)]);
  let release!: (result: { ok: true }) => void;
  const block = new Promise<Awaited<ReturnType<typeof r.hq.hermes.ensure>>>((resolve) => { release = resolve; });
  const setup = mock.method(r.hq.hermes, "ensure", async () => block);
  try {
    const pending = r.hq.ensure(getBot("tim")!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await r.hq.engineState(getBot("pebble")!)).status, "ready", "another bot still being set up must not hold this one at starting");
    assert.equal((await r.hq.engineState(getBot("tim")!)).status, "ready", "a healthy gateway settles the status immediately");
    release({ ok: true }); await pending;
  } finally { setup.mock.restore(); }
  const lines: string[] = [];
  const warning = mock.method(console, "warn", (...words: unknown[]) => { lines.push(words.join(" ")); });
  const fetchOriginal = globalThis.fetch;
  const refused = mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => String(args[0]).endsWith("/bots/tim/file/config.yaml")
    ? new Response("private reply words", { status: 503 }) : fetchOriginal(...args));
  try {
    await assert.rejects(r.guard.writeBotFile("tim", "config.yaml", "private request words"));
    assert.deepEqual(lines, ["The safety switch refused /bots/tim/file/config.yaml (503)."]);
  } finally { warning.mock.restore(); refused.mock.restore(); }
  console.log("Startup: no file write before the space is ready; a healthy gateway promptly clears starting.");
} finally { await r.close(); }
