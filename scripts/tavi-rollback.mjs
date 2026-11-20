// Returns to v2 without putting Tavi's data over v2's data.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argumentsFor, checkFolders, recordFile, saveRecord, systemOperations } from "./tavi-switch.mjs";

export async function rollbackTavi(options, supplied = {}, print = console.log) {
  checkFolders(options);
  const file = recordFile(options);
  if (!existsSync(file)) throw new Error("No saved switch record was found for that Tavi data folder. Nothing changed.");
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (record.live !== options.live || record.taviData !== options.taviData || record.port !== options.port || !record.before)
    throw new Error("The folders or port do not match the saved switch record. Nothing changed.");
  const ops = { ...systemOperations(options), ...supplied };
  print(`1. Found the switch record, last step ${record.step}, for ${options.live}. Keep both data folders.`);
  print("2. Stop Tavi and its safety switch; the bots' Linux space stops too.");
  print("3. Point Windows sign-in back at v2 and restore the old code from pre-tavi.");
  print("4. Build the old apps, start v2 and check its health, phone and desktop pages.");
  print("5. Keep Tavi's data and the backup. v2 uses its own unchanged data folder.");
  if (!options.yes) { print("Dry run only. Nothing changed. Add --yes to return to v2."); return; }
  try {
    await ops.stop(); await ops.stopGuard();
    // Read the saved old commit as well: a moved tag must never select different code.
    if (record.tagged && await ops.git("rev-parse", "pre-tavi^{commit}") !== record.before) throw new Error();
    const current = await ops.git("rev-parse", "HEAD");
    if (current !== record.before && current !== record.commit) throw new Error();
    await ops.git("diff", "--quiet"); await ops.git("diff", "--cached", "--quiet");
    await ops.autostart(false);
    if (current !== record.before) await ops.git("checkout", "--detach", "pre-tavi");
    const configFile = path.join(options.live, "tavi-launch.json");
    if (record.originalConfig === null) rmSync(configFile, { force: true }); else writeFileSync(configFile, record.originalConfig);
    await ops.build(); await ops.start(false); await ops.verify(false);
    record.rolledBack = new Date().toISOString(); saveRecord(file, record);
    print(`Restored v2 at ${record.before}. Health, phone and desktop passed. Tavi's data was kept. Record: ${file}`);
  } catch { throw new Error(`The way back stopped. Both data folders are kept. Fix the failed command and run this same rollback again. Record: ${file}`); }
}
export async function main(args = process.argv.slice(2), supplied, print = console.log) {
  try { await rollbackTavi(argumentsFor(args), supplied, print); return 0; }
  catch (error) { print(error.message); return 2; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
