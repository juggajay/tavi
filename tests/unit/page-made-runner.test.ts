import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMadePicture, takeMadePicture } from "../../src/pages/made.js";

const home = path.join(TEST_DIR, "picture-home"); mkdirSync(home);
const log = path.join(TEST_DIR, "picture-runs.jsonl");
process.env.CODEX_HOME = home; process.env.TAVI_CODEX_BIN = fileURLToPath(new URL("../fixtures/pages/maker.mjs", import.meta.url)); process.env.FAKE_CODEX_LOG = log;
const widths: number[] = [];
const resize = async (src: string, out: string, width: number) => { widths.push(width); await writeFile(out, await readFile(src)); return { w: width, h: 1 }; };
const request = { prompt: "A warm bowl of tomato stew, close view.", style: "Soft natural light.", width: 1400 };
const deps = { resize, timeoutMs: 3000 };
process.env.FAKE_CODEX_MODE = "ok";
assert.match(await runMadePicture(request, deps), /^data:image\/png;base64,/); assert.deepEqual(widths, [1400]);
assert.ok(!existsSync(path.join(home, "generated_images", "page-test-picture")));
const unrelated = path.join(home, "generated_images", "another-run"); mkdirSync(unrelated); writeFileSync(path.join(unrelated, "keep.png"), "untouched");
process.env.FAKE_CODEX_MODE = "model"; await runMadePicture({ ...request, model: "unavailable", width: 900 }, deps); assert.equal(widths.at(-1), 900);
const rows = readFileSync(log, "utf8").trim().split("\n").map(s => JSON.parse(s)); assert.equal(rows.length, 3); assert.ok(rows[1].args.includes("-m") && !rows[2].args.includes("-m"));
assert.match(rows[0].prompt, /exactly one picture/); assert.ok(rows[0].args.includes("--ephemeral") && rows[0].args.includes("read-only")); assert.ok(!rows[0].args.includes(request.prompt)); assert.ok(!existsSync(rows[0].cwd));
for (const mode of ["fail", "missing", "signed_out"]) { process.env.FAKE_CODEX_MODE = mode; await assert.rejects(runMadePicture(request, deps)); }
process.env.FAKE_CODEX_MODE = "timeout";
await assert.rejects(runMadePicture(request, { ...deps, timeoutMs: 600 }), /stopped/);
await new Promise(resolve => setTimeout(resolve, 1900)); assert.ok(!existsSync(path.join(home, "child-survived")), "The whole stand-in tree was stopped.");
assert.equal(readFileSync(path.join(unrelated, "keep.png"), "utf8"), "untouched");
await assert.rejects(takeMadePicture(home, "../another-run", path.join(TEST_DIR, "out.jpg"), 900, resize));
assert.deepEqual(readdirSync(unrelated), ["keep.png"]);
if (process.platform === "win32") {
  const batch = path.join(TEST_DIR, "picture maker.cmd");
  writeFileSync(batch, `@echo off\n"${process.execPath}" "${process.env.TAVI_CODEX_BIN}" %*\n`);
  process.env.FAKE_CODEX_MODE = "ok";
  await runMadePicture(request, { ...deps, program: async () => batch });
  const batchRun = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);
  assert.deepEqual(batchRun.args, rows[0].args, "A Windows command file receives the same fixed options.");
}
console.log("The runner uses stdin, retries a model once, checks files, removes only its picture and stops a timed-out process tree.");
