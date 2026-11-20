// Tavi alongside the older assistant: the same practice run as `npm run v3 -- --voice`, but kept running.
// It uses its own address (127.0.0.1:3100) and its own data (data-v3), and never touches the older
// assistant's port, data or start-up entry. Practice rules still apply: no real sends, no routines.
//   node scripts/tavi-alongside.mjs          start and keep running (the desktop program does this, hidden)
//   node scripts/tavi-alongside.mjs --stop   stop it cleanly
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, supervise, stopSupervisor, settings } from "./tavi-supervise.mjs";
import { checkDataFolder, voiceSettings } from "./v3-dev.mjs";
import configuration from './setup/config.cjs';

export const PORT = 3100;
/** The settings the supervisor runs with. Voice is on when the key file can be read, and quietly off when not. */
export function alongside(source = process.env, root = ROOT, voice = voiceSettings) {
  // Check old practice arguments before opening any saved file under those paths.
  for (const key of ['LH_DATA_DIR', 'LH_V3_DATA']) if (source[key]) checkDataFolder(source[key], root);
  const saved = configuration.loadRun({ ...source, TAVI_DATA_DIR: source.TAVI_DATA_DIR || source.LH_DATA_DIR || source.LH_V3_DATA || path.join(root, 'data-v3') }, root);
  if (saved.saved) return settings({ ...source, TAVI_DATA_DIR: saved.folder }, root);
  const folder = checkDataFolder(source.LH_DATA_DIR || path.join(root, "data-v3"), root);
  const keys = { ...source, LH_V3_ENV: source.LH_V3_ENV || path.join(folder, 'voice.env') };
  let speak;
  try { speak = voice(["--voice"], keys); } catch { speak = voice([], keys); }
  return { folder, port: PORT, host: "127.0.0.1", env: { ...source, LH_DEV: "1", LH_V3: "1", PORT: String(PORT), HOST: "127.0.0.1",
    LH_DATA_DIR: folder, LH_V3_DATA: folder, ...speak } };
}
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  if (process.argv.includes("--stop")) {
    stopSupervisor(alongside().folder).then(stopped => console.log(stopped ? "Tavi has stopped." : "Tavi was not running under its keeper."))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  } else {
    supervise({ config: alongside() }).catch(() => { console.error("Tavi could not be kept running. Check its logs and make sure its ports are free."); process.exitCode = 1; });
  }
}
