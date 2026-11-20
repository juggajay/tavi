// What the helper will show, and what it never will (Stage 11.2). This is the part that must be right.
//
// A request names a folder by its short name and a path inside it ("Jobs/Example Lake/Quote.pdf"). It is served only if:
//   1. the path as asked is a plain one: no "..", no drive letter or colon (other drives, alternate streams), no \\?\
//      or UNC form, no device name (CON, NUL, COM1...), no name Windows would quietly change (a trailing dot or space);
//   2. after Windows has resolved it fully (junctions, links, 8.3 short names, capitals), the REAL path is still inside
//      the folder's own real path; and
//   3. no part of the real path below the folder, and no part of the path as asked, is on the never-shown list, and it
//      isn't the helper's own settings or log, and it isn't a hard link (a second name for a file that may live outside).
// Anything refused gets the same answer as a path that isn't there, so nothing is learned by asking.
//
// Windows' "hidden" and "system" flags can't be read with Node alone (it would take running a program, which the helper
// never does), so hidden and system files are recognised by name: names starting with "." or "~$" or "$", and the
// usual system names (desktop.ini, Thumbs.db, System Volume Information, NTUSER.DAT ...). A file the owner hid himself
// with the hidden flag, under a plain name, inside a folder he chose, would still show.
import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Root } from "./config.js";

export type SafetyOpts = {
  /** Allow a folder that is itself inside the system temp folder (which is under AppData). Only for tests and checks on
   * a scratch folder; set by LH_HELPER_ALLOW_TEMP=1. AppData anywhere below such a folder is still refused. */
  allowTemp?: boolean;
  /** The helper's own files (helper.json, helper.log): never served, wherever they are. */
  self?: string[];
};

/** A request that passed: the folder it's in, where it really is, and how to name it back to the assistant. */
export type Place = { root: Root; rootReal: string; real: string; shown: string; parts: string[] };

/** True when child is parent or inside it (both already resolved). Windows paths don't care about capitals. */
export function within(child: string, parent: string) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

const NEVER_NAMES = new Set([
  // Windows system and hidden files and folders
  "desktop.ini", "thumbs.db", "ehthumbs.db", "ehthumbs_vista.db", "iconcache.db", "system volume information", "recovery",
  "config.msi", "msocache", "pagefile.sys", "hiberfil.sys", "swapfile.sys", "ntuser.ini", "ntuser.pol", "usrclass.dat",
  // a user's application data, and its old names
  "appdata", "application data", "local settings",
  // browser profiles and the files that hold a browser's passwords, cookies and history
  "user data", "mozilla", "login data", "login data for account", "cookies", "web data", "local state", "logins.json",
  "key3.db", "key4.db", "cert8.db", "cert9.db", "signons.sqlite", "cookies.sqlite", "formhistory.sqlite", "places.sqlite",
  // stored credentials
  "credentials", "credentials.json", "_netrc",
  // the helper's own settings and log
  "helper.json", "helper.log",
]);
const NEVER_PATTERNS: RegExp[] = [
  /^\./, // hidden by convention: .env, .env.local, .ssh, .aws, .gnupg, .git, .npmrc, .netrc ...
  /^~\$/, // Office's hidden lock files
  /^\$/, // $RECYCLE.BIN, $WinREAgent and other system folders
  /^ntuser\.dat/,
  /\.env$/, // prod.env
  /^id_(rsa|dsa|ecdsa|ed25519)/, // SSH keys, and their .pub halves
  /wallet/,
  /^client_secret.*\.json$/,
  /\.default(-[a-z-]+)?$/, // a Firefox or Thunderbird profile folder (ab12cd.default-release)
  /\.(pem|key|kdbx|kdb|pfx|p12|ppk|jks|keystore|keychain|psafe3|opvault|agilekeychain|1pux|ovpn)$/, // keys and password stores
  /\.lnk$/, // a shortcut is a pointer, never followed and never served
];

/** True for a name (one part of a path) that is never shown, whatever folder it's in. */
export function neverShown(name: string): boolean {
  const n = name.toLowerCase();
  return NEVER_NAMES.has(n) || NEVER_PATTERNS.some((re) => re.test(n));
}

const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i;

/** One part of a path as asked: a plain file or folder name, or not. */
function plainPart(s: string) {
  if (!s || s.length > 255) return false;
  if (/[\u0000-\u001f<>:"|?*]/.test(s)) return false; // a colon means a drive or a stream; ? and * are \\?\ or wildcards
  if (s === "." || s === "..") return false;
  if (/[. ]$/.test(s)) return false; // Windows would drop it and open a different name
  if (DEVICE.test(s.trim())) return false;
  return true;
}

/** "Jobs/Example Lake/Quote.pdf" (either slash) → the folder's name and the parts after it. Null unless it's a plain path. */
export function splitRequest(p: unknown): { rootName: string; parts: string[] } | null {
  if (typeof p !== "string" || !p.trim() || p.length > 1000) return null;
  if (/^[\\/]/.test(p)) return null; // \\?\..., \\server\share, /x: never relative to a folder
  const segs = p.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (!segs.length || !segs.every(plainPart)) return null;
  return { rootName: segs[0], parts: segs.slice(1) };
}

export const rootByName = (roots: Root[], name: string) => roots.find((r) => r.name.toLowerCase() === name.toLowerCase());

let tmpReal: string | null | undefined;
async function systemTemp() {
  if (tmpReal === undefined) tmpReal = await realpath(tmpdir()).catch(() => null);
  return tmpReal;
}

/** The parts of a real path below a folder: "Jobs", "Example Lake", "Quote.pdf". */
const below = (real: string, top: string) => path.relative(top, real).split(path.sep).filter(Boolean);

/**
 * A folder's own real path, or null when it isn't there or may not be shared: a folder inside AppData (or any other
 * never-shown name) is refused even when it's listed in helper.json. With allowTemp, the system temp folder (inside
 * AppData) may hold one, for tests.
 */
export async function rootReal(root: Root, o: SafetyOpts = {}): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(root.dir);
    if (!(await stat(real)).isDirectory()) return null;
  } catch {
    return null;
  }
  const tmp = o.allowTemp ? await systemTemp() : null;
  const from = tmp && within(real, tmp) ? tmp : path.parse(real).root;
  if (below(real, from).some(neverShown)) return null;
  return real;
}

const ownReal = new Map<string, string>();
/** The helper's own file, resolved once. */
async function own(s: string) {
  let r = ownReal.get(s);
  if (!r) {
    r = (await realpath(s).catch(() => path.resolve(s))).toLowerCase();
    ownReal.set(s, r);
  }
  return r;
}

/** True when a resolved path may be shown: inside the folder, nothing on the never list below it, not the helper's own. */
export async function mayShow(real: string, top: string, o: SafetyOpts = {}): Promise<boolean> {
  if (!within(real, top)) return false;
  if (below(real, top).some(neverShown)) return false;
  for (const s of o.self ?? []) if ((await own(s)) === real.toLowerCase()) return false;
  return true;
}

/** Where a requested path really is, if it's one the helper may show; null otherwise (the same as "not there"). */
export async function placeOf(roots: Root[], requested: unknown, o: SafetyOpts = {}): Promise<Place | null> {
  const req = splitRequest(requested);
  if (!req) return null;
  if (req.parts.some(neverShown)) return null; // as asked, before anything is touched
  const root = rootByName(roots, req.rootName);
  if (!root) return null;
  const top = await rootReal(root, o);
  if (!top) return null;
  let real: string;
  try {
    real = await realpath(path.join(top, ...req.parts));
  } catch {
    return null;
  }
  if (!(await mayShow(real, top, o))) return null;
  // A hard link is a second name for a file that may live anywhere on the drive: never served.
  const st = await stat(real).catch(() => null);
  if (st && st.isFile() && st.nlink > 1) return null;
  return { root, rootReal: top, real, shown: [root.name, ...req.parts].join("/"), parts: req.parts };
}
