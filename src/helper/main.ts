// Tavi helper: the one file that runs on the second PC (bundled to dist/helper/tavi-helper.mjs).
//
//   node tavi-helper.mjs     run it in a window, showing each request (close the window to stop it)
//
// It reads helper.json beside it, writes only helper.log beside it, and opens one line out to the assistant. It can
// list, find and read files in the folders named in helper.json. It has no code to change, delete, move or run anything.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, VERSION, watchConfig, type Config } from "./config.js";
import { startHelper } from "./helper.js";
import { makeLog } from "./log.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsFile = path.join(here, "helper.json");
const logFile = path.join(here, "helper.log");
const log = makeLog(logFile, true);
/** Only for trying it on a scratch folder, which lives in the temp folder under AppData; never set on the second PC. */
const allowTemp = process.env.LH_HELPER_ALLOW_TEMP === "1";
const say = (s = "") => process.stdout.write(`${s}\n`);

const major = Number(process.versions.node.split(".")[0]);
if (major < 18) {
  say(`This computer has Node ${process.versions.node}. The helper needs Node 18 or newer.`);
  process.exit(1);
}

let first: Config;
try {
  first = readConfig(settingsFile);
} catch (e) {
  const why = e instanceof Error ? e.message : String(e);
  log(`can't start: ${why}`);
  process.exit(1);
}

const showFolders = (c: Config) => {
  if (!c.folders.length) say("No folders are listed in helper.json yet, so there is nothing to show. Add them under \"folders\".");
  else for (const f of c.folders) say(`  ${f.name}: ${f.dir}`);
  for (const p of c.problems) say(`  Skipped: ${p}`);
};

say(`Tavi helper ${VERSION}. This computer is "${first.computer}".`);
say("It can list, find and read files in these folders, and nothing else:");
showFolders(first);
say("");
log(`started (version ${VERSION}, ${first.folders.length} ${first.folders.length === 1 ? "folder" : "folders"})`);

const config = watchConfig(settingsFile, first, (c, problem) => {
  if (problem) log(`helper.json can't be read now, so no folder is shown until it's fixed: ${problem}`);
  else {
    log(`helper.json changed: ${c.folders.length} ${c.folders.length === 1 ? "folder" : "folders"}`);
    showFolders(c);
  }
});

let told = false;
if (allowTemp) say("(Test mode: a folder inside the temp folder may be shown.)");
const helper = startHelper({
  config,
  log,
  safety: { allowTemp, self: [settingsFile, logFile] },
  onState: (s, detail) => {
    if (s === "connected" && !told) {
      told = true;
      say("Connected. Leave this running; close the window to stop it.");
    }
    if (s === "waiting") log(`trying again in ${detail}`);
  },
});
const quit = () => void helper.stop().then(() => process.exit(0));
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
void helper.done.then((why) => {
  if (why === "replaced") process.exit(0);
});
