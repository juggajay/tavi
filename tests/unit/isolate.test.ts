// The isolate helper must point every test at a throwaway folder in the OS temp directory, never the repo's data/.
import { TEST_DIR } from "../isolate.js"; // first
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../../src/store/db.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const inside = (child: string, parent: string) => !path.relative(parent, child).startsWith("..") && !path.isAbsolute(path.relative(parent, child));
assert.equal(DATA_DIR, TEST_DIR);
assert.ok(inside(DATA_DIR, tmpdir()), `${DATA_DIR} should be under ${tmpdir()}`);
assert.ok(!inside(DATA_DIR, repo), `${DATA_DIR} must not be inside the repo`);
assert.equal(process.env.LH_DEV, "1");
assert.ok(inside(process.env.LH_BRAIN_CWD!, TEST_DIR));
console.log("isolate: data folder is a throwaway temp folder");
