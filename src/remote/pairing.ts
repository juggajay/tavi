// Pairing a computer (Stage 11.3): a long random secret (only its hash kept here), and a ready folder for that computer:
// the helper, its double-click files, and helper.json with the gateway's address and the secret, the folders left empty
// for the owner to choose. The secret is written into helper.json and nowhere else: never printed, logged or committed.
import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkGateway, DEFAULT_MAX_MB } from "../helper/config.js";
import { DEV } from "../dev.js";
import { audit } from "../store/log.js";
import { pairComputer, unpairComputer, validName } from "./computers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileP = promisify(execFile);

/** This PC's Tailscale https name, as the phone uses it: wss://<name>.ts.net/helper. Read-only: `tailscale status`. */
export async function tailscaleGateway(): Promise<string> {
  try {
    const { stdout } = await execFileP("C:\\Program Files\\Tailscale\\tailscale.exe", ["status", "--json"], { windowsHide: true, timeout: 5000 });
    const dns = String(JSON.parse(stdout)?.Self?.DNSName ?? "").replace(/\.$/, "");
    if (dns) return `wss://${dns}/helper`;
  } catch {}
  throw new Error("Couldn't find this PC's Tailscale name. Is Tailscale running? (Or give the address: --gateway wss://<this PC>.ts.net/helper)");
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export function helperSettings(name: string, gateway: string, secret: string) {
  return {
    about:
      "Settings for the Tavi helper on this computer. List the folders it may show under folders, " +
      "like the example: each one in quotes, with a comma between them. Nothing is shown until a folder is listed. " +
      "Keep this file private: the secret in it is what lets this computer in.",
    folders: [] as string[],
    example: ["C:\\Users\\you\\Documents", "C:\\Users\\you\\Desktop", "C:\\Users\\you\\Downloads", "D:\\Jobs"],
    computer: name,
    gateway,
    secret,
    max_file_mb: DEFAULT_MAX_MB,
  };
}

/**
 * Pairs a computer and makes its folder. out: where (default: Downloads\Tavi helper - <name>; in dev, the temp
 * folder). Never inside this repo. again: pair one that's already paired (it gets a new secret; the old stops working).
 */
export async function pairHelper(o: { name: string; gateway?: string; out?: string; again?: boolean }) {
  const name = o.name.trim().toLowerCase();
  if (!validName(name)) throw new Error("A computer's name is letters, numbers and dashes, like office-pc.");
  const gateway = o.gateway ?? (DEV ? `ws://127.0.0.1:${process.env.PORT ?? "3078"}/helper` : await tailscaleGateway());
  checkGateway(gateway);
  const out = path.resolve(o.out ?? (DEV ? path.join(tmpdir(), `lh-helper-${name}`) : path.join(homedir(), "Downloads", `Tavi helper - ${name}`)));
  if (inside(out, REPO)) throw new Error("The helper's folder can't be inside the Tavi folder (its secret must never be committed). Choose another place.");
  if (existsSync(path.join(out, "helper.json")) && !o.again) throw new Error(`There's already a helper.json in ${out}. Use another folder, or --again to replace it.`);
  const built = spawnSync(process.execPath, [path.join(REPO, "scripts", "build-helper.mjs")], { cwd: REPO, encoding: "utf8" });
  if (built.status !== 0) throw new Error(`Couldn't build the helper: ${built.stderr || built.stdout}`);
  const { secret } = pairComputer(name, { again: o.again });
  mkdirSync(out, { recursive: true });
  const dist = path.join(REPO, "dist", "helper");
  for (const f of readdirSync(dist)) copyFileSync(path.join(dist, f), path.join(out, f));
  writeFileSync(path.join(out, "helper.json"), JSON.stringify(helperSettings(name, gateway, secret), null, 2) + "\n", "utf8");
  audit("user", "computer.paired", name, { folder: out, gateway, again: !!o.again });
  return { name, folder: out, gateway, files: readdirSync(out).sort() };
}

export function unpairHelper(name: string) {
  const n = name.trim().toLowerCase();
  const gone = unpairComputer(n);
  if (gone) audit("user", "computer.unpaired", n, null);
  return gone;
}
