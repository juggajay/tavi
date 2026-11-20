// Node 24 can read TypeScript. This keeps the command independent of a build step.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = new URL("../", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (specifier.endsWith(".js") && specifier.startsWith(".") && context.parentURL?.startsWith(project)) {
        const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      }
      throw error;
    }
  },
});

export async function main(args = process.argv.slice(2)) {
  // The helper runs in its own process so the app only opens the prepared copy.
  if (args[0] === "--prepare-copy") {
    try {
      const { prepareCopy } = await import("../src/hq/carryOver.ts");
      await prepareCopy(JSON.parse(args[1]));
      return 0;
    } catch {
      console.error("The prepared copy could not be checked. No private details were printed.");
      return 3;
    }
  }
  try {
    let from, to, yes = false, dryRun = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if ((arg === "--from" || arg === "--to") && args[i + 1] && !args[i + 1].startsWith("--")) {
        if (arg === "--from" && from === undefined) from = args[++i];
        else if (arg === "--to" && to === undefined) to = args[++i];
        else throw new Error();
      } else if (arg === "--yes") yes = true;
      else if (arg === "--dry-run") dryRun = true;
      else throw new Error();
    }
    if (!from || !to) throw new Error();
    const { carryOver } = await import("../src/hq/carryOver.ts");
    const result = await carryOver({ from, to, yes: yes && !dryRun });
    console.log(result.report);
    return result.code;
  } catch {
    console.error("Use: node scripts/carry-over.mjs --from <live data folder> --to <Tavi data folder> [--dry-run] [--yes]");
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
