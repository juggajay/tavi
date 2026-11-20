// Builds the Tavi program for Windows as its own program, alongside the older assistant's.
// It has its own name, icon, install folder, settings folder and start-up entry, so installing it changes
// nothing about the older program. Its window and keeper use the chosen run file.
//   node scripts/tavi-desktop.mjs --install
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import configuration from './setup/config.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "desktop");
const modules = path.join(desktop, 'node_modules');
const builder = path.join(modules, "electron-builder", "cli.js");
if (!existsSync(builder)) { console.error('The program builder was not found. Run npm ci --prefix desktop in this project.'); process.exit(1); }
for (const icon of ["tavi.ico", "tavi-off.ico"]) if (!existsSync(path.join(desktop, "assets", icon))) { console.error("Make the icons first: node scripts/tavi-icon.mjs"); process.exit(1); }

const config = configuration.loadRun(process.env, root);
writeFileSync(path.join(desktop, 'app-config.json'), JSON.stringify({ root, data: config.folder, url: `http://127.0.0.1:${config.port}`, alongside: true }, null, 2));
const version = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8")).devDependencies.electron;
const made = spawnSync(process.execPath, [builder, "--win", "nsis", "--publish", "never", "--config", "tavi-builder.json", `-c.electronVersion=${version}`], { cwd: desktop, stdio: "inherit" });
if (made.status !== 0) process.exit(made.status ?? 1);

const installer = readdirSync(path.join(desktop, "dist-tavi")).find(file => /^Tavi Setup .*\.exe$/.test(file));
if (!installer) { console.error('The Windows installer was not made. Check the desktop build output and run setup again.'); process.exit(1); }
console.log(`\nBuilt: desktop\\dist-tavi\\${installer}`);
if (process.argv.includes("--install") && installer) {
  execFileSync(path.join(desktop, "dist-tavi", installer), ["/S"], { stdio: "inherit" });
  console.log("Installed: the Start menu and desktop shortcuts are called \"Tavi\".");
}
