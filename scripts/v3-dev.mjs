// A separate practice run: both programs stay on this PC and use data-v3.
import { existsSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import configuration from './setup/config.cjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function resolved(value) {
  const full = path.resolve(value);
  if (existsSync(full)) return realpathSync(full);
  const parent = path.dirname(full);
  return parent === full ? full : path.join(resolved(parent), path.basename(full));
}
export function checkDataFolder(value, root = repo) {
  const full = path.resolve(value).toLowerCase();
  const lives = [path.join(root, "data"), ...(process.env.TAVI_PROTECTED_DATA_DIRS || "").split(path.delimiter).filter(Boolean)].map((p) => path.resolve(p).toLowerCase());
  const isLive = (p) => lives.some((live) => p === live || p.startsWith(live + path.sep));
  if (isLive(full)) throw new Error("The practice run cannot use the live data folder. Use data-v3.");
  const inside = (p) => p.startsWith(path.resolve(root).toLowerCase() + path.sep);
  if (!inside(full)) throw new Error("The practice run cannot use a live data folder outside this project. Keep the practice data inside this project, in data-v3.");
  const target = resolved(value).toLowerCase();
  if (isLive(target)) throw new Error("The practice run cannot use the live data folder. Use data-v3.");
  if (!inside(target)) throw new Error("Keep the practice data inside this project, in data-v3.");
  return path.resolve(value);
}
export function voiceSettings(args = process.argv.slice(2), source = process.env, read = readFileSync) {
  if (!args.includes("--voice")) return { LH_NO_VOICE: "1", DOTENV_CONFIG_PATH: path.join(repo, "data-v3", "no-env-file") };
  const file = path.resolve(source.LH_V3_ENV || path.join(source.TAVI_DATA_DIR || source.LH_DATA_DIR || path.join(repo, 'data-v3'), 'voice.env'));
  let savedVoiceKey = '';
  try { savedVoiceKey = configuration.voiceKey(read(file)); } catch { throw new Error("The voice key file could not be read. Set LH_V3_ENV to the key file for this practice run."); }
  const key = (source.OPENAI_API_KEY || savedVoiceKey || '').trim();
  if (!key) throw new Error("No voice key was found. Add OPENAI_API_KEY to the practice key file.");
  return { LH_NO_VOICE: "0", OPENAI_API_KEY: key, DOTENV_CONFIG_PATH: path.join(repo, "data-v3", "no-env-file") };
}
export async function main() {
  const { alongside } = await import('./tavi-alongside.mjs');
  const { supervise } = await import('./tavi-supervise.mjs');
  return supervise({ config: alongside(process.env, repo, (args, source) => voiceSettings(process.argv.slice(2), source)) });
}
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
