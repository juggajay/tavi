// The helper's settings: helper.json beside it, written by `npm run helper:pair` on the main PC and then edited by the
// owner on the second PC (only to list the folders it may show). The helper only ever READS this file.
//
// Uses only what comes with Node, like everything in src/helper/: it is shipped to the second PC as one file.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export const VERSION = "1.0";
export const DEFAULT_MAX_MB = 50;

/** One folder the helper may show: the short name the assistant uses ("Documents"), and where it is. */
export type Root = { name: string; dir: string };

export type Config = {
  /** The name this computer was paired under (helper:pair <name>). */
  computer: string;
  /** Where the assistant's gateway is: wss://<main PC>.ts.net/helper (ws:// only to this same PC, for testing). */
  gateway: string;
  secret: string;
  folders: Root[];
  maxFileBytes: number;
  /** Folders listed in helper.json that can't be used, in plain words (shown when it starts). */
  problems: string[];
};

/**
 * JSON that copes with Windows paths pasted straight from File Explorer ("C:\Users\you\Documents"): JSON needs every
 * backslash doubled, so a lone one (not already \\ or \") is doubled before parsing. The secret and the address have
 * no backslashes, so only folder paths are touched.
 */
export function parseLoose(text: string): unknown {
  const fixed = text.replace(/^\uFEFF/, "").replace(/\\(["\\])|\\/g, (m, k: string | undefined) => (k ? m : "\\\\"));
  return JSON.parse(fixed);
}

const driveName = (dir: string) => {
  const m = dir.match(/^([A-Za-z]):[\\/]*$/);
  return m ? `${m[1].toUpperCase()} drive` : null;
};

/** A short name for a folder: its own name, made safe to say and to put in a path ("Jobs", "D drive"). */
function nameFor(dir: string, given: unknown): string {
  const raw = typeof given === "string" && given.trim() ? given.trim() : (driveName(dir) ?? path.basename(dir.replace(/[\\/]+$/, "")));
  return raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Folder";
}

/** The folder list from helper.json: plain paths, or { "name": "...", "path": "..." }. Names are made unique. */
export function foldersFrom(list: unknown): { folders: Root[]; problems: string[] } {
  const folders: Root[] = [];
  const problems: string[] = [];
  if (list === undefined || list === null) return { folders, problems };
  if (!Array.isArray(list)) return { folders, problems: ['"folders" should be a list, like ["C:\\\\Users\\\\you\\\\Documents"].'] };
  for (const f of list) {
    const dir = typeof f === "string" ? f : f && typeof f === "object" ? (f as { path?: unknown }).path : undefined;
    if (typeof dir !== "string" || !dir.trim()) {
      problems.push(`A folder entry isn't a path: ${JSON.stringify(f).slice(0, 80)}`);
      continue;
    }
    const clean = dir.trim();
    if (!path.isAbsolute(clean) || !/^([A-Za-z]:[\\/]|\\\\)/.test(clean)) {
      problems.push(`"${clean}" needs to be a full folder path, like C:\\Users\\you\\Documents.`);
      continue;
    }
    let name = nameFor(clean, typeof f === "object" ? (f as { name?: unknown }).name : undefined);
    const taken = (n: string) => folders.some((r) => r.name.toLowerCase() === n.toLowerCase());
    for (let i = 2; taken(name); i++) name = `${nameFor(clean, undefined)} ${i}`;
    folders.push({ name, dir: clean });
  }
  return { folders, problems };
}

/** Reads and checks helper.json. Throws, in plain words, if the helper can't run with it. */
export function readConfig(file: string): Config {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Can't find helper.json beside the helper (looked for ${file}).`);
  }
  let j: Record<string, unknown>;
  try {
    j = parseLoose(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`helper.json isn't written right, so the helper can't read it (${e instanceof Error ? e.message : String(e)}). Check for a missing comma or quote.`);
  }
  if (!j || typeof j !== "object") throw new Error("helper.json is empty.");
  const computer = typeof j.computer === "string" ? j.computer.trim() : "";
  const gateway = typeof j.gateway === "string" ? j.gateway.trim() : "";
  const secret = typeof j.secret === "string" ? j.secret.trim() : "";
  if (!computer || !gateway || !secret) throw new Error("helper.json is missing the computer name, the gateway address or the secret. Make a new one with helper:pair on the main computer.");
  checkGateway(gateway);
  const mb = Number(j.max_file_mb ?? DEFAULT_MAX_MB);
  const maxFileBytes = Math.round((Number.isFinite(mb) && mb > 0 ? Math.min(mb, 4096) : DEFAULT_MAX_MB) * 1024 * 1024);
  const { folders, problems } = foldersFrom(j.folders);
  return { computer, gateway, secret, folders, maxFileBytes, problems };
}

/** wss:// to anywhere (Tailscale Serve's HTTPS, the same as the phone uses); plain ws:// only to this same PC. */
export function checkGateway(gateway: string) {
  let u: URL;
  try {
    u = new URL(gateway);
  } catch {
    throw new Error(`The gateway address in helper.json isn't a web address: ${gateway}`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol === "wss:" || (u.protocol === "ws:" && loopback)) return u;
  throw new Error("The gateway address must start with wss:// (an encrypted link). Plain ws:// is only allowed to this same computer.");
}

/**
 * helper.json as it is now, re-read when it changes, so a folder added or removed counts from the next request. If the
 * file stops making sense, no folder is shown until it's fixed (the address and secret stay as they started).
 */
export function watchConfig(file: string, first: Config, onChange?: (c: Config, problem: string | null) => void) {
  let current = first;
  let stamp = mtimeOf(file);
  return () => {
    const now = mtimeOf(file);
    if (now === stamp) return current;
    stamp = now;
    try {
      const next = readConfig(file);
      current = { ...current, folders: next.folders, maxFileBytes: next.maxFileBytes, problems: next.problems };
      onChange?.(current, null);
    } catch (e) {
      current = { ...current, folders: [], problems: [e instanceof Error ? e.message : String(e)] };
      onChange?.(current, current.problems[0]);
    }
    return current;
  };
}

function mtimeOf(file: string) {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}
