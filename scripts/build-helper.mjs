// Builds the helper for the second PC (Stage 11): src/helper/ bundled into ONE file, dist/helper/tavi-helper.mjs,
// that runs with plain `node` and needs nothing installed (it only uses what comes with Node). Beside it go the small
// double-click files the owner uses on that PC. helper.json (the settings, with the secret) is NOT made here: that's
// `npm run helper:pair -- <name>`, which copies this folder and adds it.
//   node scripts/build-helper.mjs        (npm run build:helper)
// The bundler is esbuild, the copy that comes with tsx (already installed); nothing new is added.
import { build } from "esbuild";
import { earlier } from "./earlier.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = path.join(root, "dist", "helper");
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "helper", "main.ts")],
  outfile: path.join(OUT_DIR, "tavi-helper.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: false, // kept readable, so anyone can check what it does
  legalComments: "none",
  logLevel: "warning",
  banner: {
    js: [
      "// Tavi helper, for the second computer. Built from src/helper/ in the Tavi repo.",
      "// It reads helper.json beside it, writes only helper.log beside it, and opens one line out to the assistant.",
      "// It can list, find and read files in the folders named in helper.json. It cannot change, delete, move or run anything.",
    ].join("\n"),
  },
});

// Windows batch files need CRLF line endings.
const cmd = (lines) => lines.join("\r\n") + "\r\n";
const NEEDS_NODE = [
  'set "NODE="',
  "for /f \"delims=\" %%N in ('where node 2^>nul') do if not defined NODE set \"NODE=%%N\"",
  "if not defined NODE (",
  "  echo Node isn't installed on this computer, so the helper can't run.",
  "  pause",
  "  exit /b 1",
  ")",
];
// LH_STARTUP_DIR is only for checking these files on a test machine; normally it's the owner's own Startup folder.
const STARTUP = ['set "STARTUP=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"', 'if defined LH_STARTUP_DIR set "STARTUP=%LH_STARTUP_DIR%"', 'set "ENTRY=%STARTUP%\\Tavi helper.vbs"', `set "EARLIER_ENTRY=%STARTUP%\\${earlier.words} helper.vbs"`];
const STOP_PS =
  "$f = $env:LH_HELPER_FILE.ToLower(); $old = $env:LH_HELPER_EARLIER_FILE.ToLower(); " +
  "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and ($_.CommandLine.ToLower().Replace('/', '\\').Contains($f) -or $_.CommandLine.ToLower().Replace('/', '\\').Contains($old)) }); " +
  "$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; " +
  "if ($p.Count) { 'Stopped the helper.' } else { 'The helper was not running.' }";

const files = {
  "Try it.cmd": cmd([
    "@echo off",
    "rem Runs the Tavi helper in this window, showing what it does. Close the window to stop it.",
    "setlocal EnableExtensions DisableDelayedExpansion",
    "title Tavi helper",
    'cd /d "%~dp0"',
    ...NEEDS_NODE,
    '"%NODE%" "%~dp0tavi-helper.mjs"',
    "echo.",
    "echo The helper has stopped.",
    "pause",
  ]),
  "Start at login.cmd": cmd([
    "@echo off",
    "rem Makes the helper start by itself, hidden, each time you log in: one small file in your Startup folder.",
    "rem It also starts it now. Nothing else on this computer is changed.",
    "setlocal EnableExtensions DisableDelayedExpansion",
    'cd /d "%~dp0"',
    ...NEEDS_NODE,
    'set "HELPER=%~dp0tavi-helper.mjs"',
    ...STARTUP,
    "setlocal EnableDelayedExpansion",
    '> "!ENTRY!" echo CreateObject("WScript.Shell").Run """!NODE!"" ""!HELPER!""", 0, False',
    "if errorlevel 1 (",
    "  echo Couldn't write the start-at-login file in your Startup folder.",
    "  pause",
    "  exit /b 1",
    ")",
    'start "" wscript.exe "!ENTRY!"',
    // Only replace an earlier helper entry that points at this same helper folder.
    'if exist "!EARLIER_ENTRY!" findstr /I /L /C:"%~dp0" "!EARLIER_ENTRY!" >nul && del "!EARLIER_ENTRY!"',
    "echo.",
    "echo Done. The helper will start by itself each time you log in, and it is running now in the background.",
    "echo To stop it, double-click Stop.cmd. To take it off completely, double-click Remove.cmd.",
    'if not "%~1"=="nopause" pause',
  ]),
  "Stop.cmd": cmd([
    "@echo off",
    "rem Stops the helper if it's running, in a window or in the background. It starts again at your next login if",
    "rem Start at login was used; Remove.cmd stops that too.",
    "setlocal EnableExtensions",
    'set "LH_HELPER_FILE=%~dp0tavi-helper.mjs"',
    // Stop either installed filename in this same folder during an update.
    `set "LH_HELPER_EARLIER_FILE=%~dp0${earlier.dashed}-helper.mjs"`,
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "${STOP_PS}"`,
    'if not "%~1"=="nopause" pause',
  ]),
  "Remove.cmd": cmd([
    "@echo off",
    "rem Stops the helper and takes away the start-at-login file. Then delete this folder to remove the helper completely.",
    "setlocal EnableExtensions DisableDelayedExpansion",
    'call "%~dp0Stop.cmd" nopause',
    ...STARTUP,
    'if exist "%ENTRY%" del "%ENTRY%"',
    'if exist "%EARLIER_ENTRY%" findstr /I /L /C:"%~dp0" "%EARLIER_ENTRY%" >nul && del "%EARLIER_ENTRY%"',
    "echo The helper won't start at login any more.",
    "echo To finish, delete this whole folder. On the main computer, the other computer can then be unpaired.",
    'if not "%~1"=="nopause" pause',
  ]),
};
for (const [name, text] of Object.entries(files)) writeFileSync(path.join(OUT_DIR, name), text, "utf8");

console.log(`Built the helper: ${path.relative(root, OUT_DIR)}\\ (tavi-helper.mjs and ${Object.keys(files).length} double-click files)`);
