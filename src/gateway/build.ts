// Which build of the apps this gateway serves (Stage 13.4), sent in every hello so an app opened before an update
// knows to reload itself (ui/src/shared/update.ts). Worked out from the built pages on disk (web/dist/phone.html and
// desktop.html name every hashed file they load), and again whenever `npm run build:ui` rewrites them.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DIST } from "./static.js";
import { assetsIn, buildIdOf } from "../shared/build.js";

const seen = new Map<string, { mtime: number; id: string | null }>();
let forTest: string | null = null;

/** The build the phone or desktop app should be on; null when the apps aren't built. */
/** "hq" is Tavi's desktop app (hq.html); "desktop" is the earlier desktop page, still served beside it. */
export function uiBuild(kind: "phone" | "desktop" | "hq"): string | null {
  if (forTest !== null) return forTest;
  const file = path.join(DIST, kind === "hq" ? "hq.html" : kind === "desktop" ? "desktop.html" : "phone.html");
  try {
    const mtime = statSync(file).mtimeMs;
    const had = seen.get(kind);
    if (had && had.mtime === mtime) return had.id;
    const id = buildIdOf(assetsIn(readFileSync(file, "utf8"))) || null;
    seen.set(kind, { mtime, id });
    return id;
  } catch {
    return null;
  }
}

/** Tests only: pretend a different build is live (null: back to the real one). */
export function setBuildForTest(id: string | null) {
  forTest = id;
}
