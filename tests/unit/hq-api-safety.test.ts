import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { rig, until } from "./hq-api-fixture.test.js";
import type { Engine } from "../../src/hq/contract.js";

let aborted = false, started = false;
const engine: Engine = { kind: "hermes", ready: async () => ({ ok: true }), async run(_bot, _input, on, signal) {
  started = true;
  await new Promise<void>((resolve) => {
    const stop = () => { aborted = true; resolve(); };
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
  });
  on({ type: "failed", reason: "stopped", message: "Stopped." });
} };
const r = await rig(engine);
try {
  const address = r.hq.trialState().toolboxAddress!;
  await r.request("/bots/pebble/messages", "POST", { text: "Keep working", test: true });
  await until(() => started);
  await r.stopGuard();
  const stopAll = r.hq.turns.stopAll;
  r.hq.turns.stopAll = () => { throw new Error("A broken queue must not hold the safety switch up."); };
  const raised = await r.request("/safety", "POST", { level: "killed", reason: "Stop now" });
  r.hq.turns.stopAll = stopAll;
  assert.equal(raised.status, 503);
  assert.deepEqual({ ok: raised.data.ok, guard: raised.data.guard, did: raised.data.did }, { ok: false, guard: "down", did: "stopped everything on this side" });
  assert.match(raised.data.warning, /Linux space may still be running.*npm run guard -- kill/);
  await until(() => aborted);
  assert.equal((await r.request("/state")).data.toolbox, "off");
  await assert.rejects(fetch(address, { signal: AbortSignal.timeout(500) }));
  assert.equal((await r.request("/bots/pebble/messages", "POST", { text: "Try again" })).status, 400);
  const script = path.resolve("scripts/v3-dev.mjs");
  const bad = spawnSync(process.execPath, [script], { env: { ...process.env, LH_DATA_DIR: path.resolve("data") }, encoding: "utf8", windowsHide: true });
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /cannot use the live data folder/);
  const { checkDataFolder } = await import("../../scripts/v3-dev.mjs" as string);
  assert.throws(() => checkDataFolder(path.resolve("data/inside")), /live data folder/);
  assert.equal(checkDataFolder(path.join(TEST_DIR, "practice"), TEST_DIR), path.join(TEST_DIR, "practice"));
  assert.throws(() => checkDataFolder("C:\\Users\\you\\other-app\\data"), /live data folder/);
  console.log("hq-api-safety: ok (a lost guard stops this side and the practice run refuses live data)");
} finally { await r.close(); }
