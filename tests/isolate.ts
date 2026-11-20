// Import this FIRST in any test: it points Tavi at a private, throwaway data folder, so a test can never touch
// the real database or profile files (the live gateway reads those, and its memory keeper would treat a test's made-up
// conversation as real).
//
// By default the folder starts empty and the code creates a fresh database in it. Set LH_TEST_SOURCE to a data folder
// to start from a copy of that instead (a consistent snapshot via VACUUM INTO, plus profile and secrets). The source is
// only ever read.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY = 24 * 60 * 60 * 1000;

// Sweep folders left behind by earlier runs (a crash, or Windows refusing to delete a file still in use).
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith("lh-test-")) continue;
  const p = path.join(tmpdir(), name);
  try {
    if (Date.now() - statSync(p).mtimeMs > DAY) rmSync(p, { recursive: true, force: true });
  } catch {}
}

export const TEST_DIR = mkdtempSync(path.join(tmpdir(), `lh-test-${process.pid}-`));

const source = process.env.LH_TEST_SOURCE ? path.resolve(process.env.LH_TEST_SOURCE) : null;
if (source) {
  const live = new DatabaseSync(path.join(source, "harness.db"), { readOnly: true });
  live.exec(`VACUUM INTO '${path.join(TEST_DIR, "harness.db").replace(/'/g, "''")}'`); // consistent even while the gateway writes
  live.close();
  for (const sub of ["profile", "secrets"]) if (existsSync(path.join(source, sub))) cpSync(path.join(source, sub), path.join(TEST_DIR, sub), { recursive: true });
}

process.env.LH_DATA_DIR = TEST_DIR;
process.env.LH_BRAIN_CWD = path.join(TEST_DIR, "brain");
process.env.LH_BROWSER_DIR = path.join(TEST_DIR, "browser");
process.env.LH_DEV = "1";
process.env.LH_FAKE_BRAIN ??= "1";
mkdirSync(process.env.LH_BRAIN_CWD, { recursive: true });
if (!process.env.LH_QUIET) console.log(`(testing on a private ${source ? "copy of the data" : "empty data folder"}: ${TEST_DIR})`);

// Open the database now that the folder is set, so it can be closed before the folder is deleted on exit.
const { db } = await import("../src/store/db.js");
process.on("exit", () => {
  try {
    db.close();
  } catch {}
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {} // swept on a later run
});
