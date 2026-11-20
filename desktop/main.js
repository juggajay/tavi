// Tavi for Windows: the desktop app window (/desktop), and a tray icon that shows whether Tavi is running.
// This app is only a window onto the local gateway. Tavi itself runs in the background
// (scripts/tavi-supervise.mjs, started at Windows sign-in) whether or not this app is open; the app starts it if needed.
const { app, BrowserWindow, Tray, Menu, shell, clipboard, Notification, nativeTheme, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
// { root, url }, written by scripts/build-desktop.mjs. Running from the repo without it (development), use the repo and
// the dev gateway; LH_DESKTOP_BASE points the window at another gateway without rebuilding.
let config;
try {
  config = require("./app-config.json");
} catch {
  config = { root: path.resolve(__dirname, ".."), url: "http://127.0.0.1:3078" };
}

// The installed program reads the same run file as the keeper on every launch.
let runConfig = null;
if (config.data || config.alongside) {
  runConfig = require(path.join(config.root, 'scripts', 'setup', 'config.cjs')).loadRun({ ...process.env,
    TAVI_DATA_DIR: config.data || path.join(config.root, 'data-v3') }, config.root);
}
const BASE = process.env.LH_DESKTOP_BASE || (runConfig ? `http://127.0.0.1:${runConfig.port}` : config.url);
const APP = `${BASE}/desktop`;
// A program built to sit alongside the older assistant says so in its settings: its own name, icon, starter and data.
const ALONGSIDE = config.alongside === true || !!runConfig;
const ICON = path.join(__dirname, "assets", "tavi.ico");
const ICON_OFF = path.join(__dirname, "assets", "tavi-off.ico");
const startHidden = process.argv.includes("--hidden");
let win = null;
let tray = null;
let running = null;
let quitting = false;
let appName = 'Tavi';
let startingURL = "";
let opening = false; // true while the app's own page is loading, so the starting page is not put back over it
const launchSettings = () => {
  try { return JSON.parse(fs.readFileSync(path.join(config.root, "tavi-launch.json"), "utf8")); } catch { return null; }
};
function showStarting(failed = false) {
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const folder = runConfig?.folder || process.env.LH_DATA_DIR || launchSettings()?.data || path.join(config.root, 'data');
  let reason = "Getting things going on this PC.";
  if (failed) {
    try { reason = JSON.parse(fs.readFileSync(path.join(folder, "logs", "tavi-status.json"), "utf8")).reason; }
    catch { reason = `Check the logs in ${path.join(folder, "logs")}, then try Start ${appName} from the tray icon.`; }
  }
  startingURL = "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(appName)}</title><style>body{font:16px/1.5 'Segoe UI',sans-serif;background:#161615;color:#ededea;display:grid;place-content:center;height:100vh;margin:0;padding:0 40px}p{max-width:640px;color:#aaa}</style></head><body><h1>${escape(failed ? `${appName} didn't start` : `Starting ${appName}`)}</h1><p>${escape(reason)}</p></body></html>`);
  return win.loadURL(startingURL);
}
/** Opens Tavi's own page in the window. */
function openApp() {
  opening = true;
  return Promise.resolve(win.loadURL(APP)).catch(() => {}).finally(() => { opening = false; });
}
async function refreshName() {
  const before = appName;
  try {
    const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    const reported = health.ok ? (await health.json()).name : null;
    const reply = await fetch(`${BASE}/api/hq/state`, { signal: AbortSignal.timeout(1500) });
    const state = reply.ok ? await reply.json() : null;
    appName = 'Tavi';
    win?.setTitle(appName);
    if (appName !== before && !opening && win?.webContents.getURL().startsWith("data:")) void showStarting();
  } catch {}
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showWindow());
app.setAppUserModelId("app.tavi.desktop");
// The program keeps its settings in its own folder, named after the program (Tavi). Nothing is copied from the
// earlier stand-alone program: that is a different program with its own settings, and may still be installed.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function healthy() {
  try {
    return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** Start Tavi's engine (the same hidden supervisor Windows starts at sign-in). */
function startEngine() {
  // Only the installed app starts the engine. Run from a development copy it must never start one: that copy's
  // scripts would bring up a second assistant on the live port with the real data.
  if (!app.isPackaged || process.env.LH_DESKTOP_BASE) return;
  const launcher = runConfig?.saved || config.data ? 'tavi-start-hidden.vbs' : ALONGSIDE ? 'tavi-alongside-hidden.vbs' : launchSettings() ? 'tavi-start-hidden.vbs' : 'tavi-start-hidden.vbs';
  spawn("wscript.exe", [path.join(config.root, "scripts", launcher)], { cwd: config.root, detached: true, stdio: "ignore", windowsHide: true }).unref();
}
async function ensureRunning() {
  if (await healthy()) return true;
  startEngine();
  for (let i = 0; i < (ALONGSIDE ? 120 : 40); i++) {
    await sleep(500);
    if (await healthy()) return true;
  }
  return false;
}
/** Alongside, Tavi is stopped by asking its keeper, so the bots' space is closed down properly too. */
function stopEngine() {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(config.root, 'scripts', 'tavi.mjs'), 'stop', '--data', runConfig?.folder || path.join(config.root, 'data-v3')], { cwd: config.root, stdio: 'ignore', windowsHide: true });
    child.once("error", resolve);
    child.once("exit", resolve);
  });
}
async function restartEngine() {
  if (ALONGSIDE) await stopEngine();
  else try {
    await fetch(`${BASE}/api/setup/restart`, { method: "POST", signal: AbortSignal.timeout(3000) });
  } catch {
    /* it's going down */
  }
  await sleep(1500);
  const ok = await ensureRunning();
  await refreshTray();
  if (ok && win && win.isVisible()) void openApp();
}

/* ---------------- the window ---------------- */

/** Tavi's own pages: this gateway, on 127.0.0.1 or localhost. */
const ours = (url) => {
  try {
    const u = new URL(url), b = new URL(BASE);
    return u.protocol === b.protocol && u.port === b.port && (u.hostname === b.hostname || ["127.0.0.1", "localhost"].includes(u.hostname));
  } catch {
    return false;
  }
};

/* the window remembers its size and place */
const boundsFile = () => path.join(app.getPath("userData"), "window.json");
function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
    if (b && b.width >= 1100 && b.height >= 700) return b;
  } catch {}
  return { width: 1440, height: 900 };
}
function saveBounds() {
  try {
    if (win && !win.isMinimized() && !win.isMaximized()) fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds()));
  } catch {}
}
/** Anything that isn't Tavi's own page opens in the normal browser (claude.ai to connect, Google, etc.). */
function openOutside(url) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

/** Tavi's window has no title bar: the page reaches the top edge and Windows draws its three buttons over the corner. */
const dark = () => !!nativeTheme.shouldUseDarkColors;
const corner = () => ({ color: "#00000000", symbolColor: dark() ? "#F5F5F5" : "#1C1C1C", height: 44 });

function createWindow() {
  win = new BrowserWindow({
    ...(ALONGSIDE ? { titleBarStyle: "hidden", titleBarOverlay: corner() } : {}),
    ...savedBounds(),
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: appName,
    icon: ICON,
    backgroundColor: ALONGSIDE ? (dark() ? "#121212" : "#FFFFFF") : nativeTheme.shouldUseDarkColors ? "#0C0E10" : "#F3F4F2",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "preload.js") },
  });
  win.removeMenu();
  if (ALONGSIDE) nativeTheme.on?.("updated", () => { try { win.setTitleBarOverlay(corner()); } catch {} });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  const guard = (e, url) => {
    if (!ours(url) && url !== startingURL && !url.startsWith("file:")) {
      e.preventDefault();
      openOutside(url);
    }
  };
  win.webContents.on("will-navigate", guard);
  win.webContents.on("will-redirect", guard);
  // F5 or Ctrl+R loads the app's page afresh (there is no menu to do it from).
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || !(input.key === "F5" || (input.control && String(input.key).toLowerCase() === "r"))) return;
    e.preventDefault();
    if (ours(win.webContents.getURL())) win.webContents.reload(); else void ensureRunning().then((ok) => ok && openApp());
  });
  win.on("page-title-updated", (e) => e.preventDefault()); // Keep the app name chosen from the server.
  win.on("resized", saveBounds);
  win.on("moved", saveBounds);
  // Closing the window tucks it into the tray; "Quit" in the tray menu really quits.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.once("ready-to-show", () => {
    if (!startHidden) win.show();
  });
  void showStarting();
  void ensureRunning().then((ok) => {
    if (ok) void refreshName().then(openApp);
    else void showStarting(true);
    void refreshTray();
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // If it was showing the "starting" page or an error, try the app again.
  if (!ours(win.webContents.getURL())) void ensureRunning().then((ok) => ok && openApp());
}

/* ---------------- the tray ---------------- */

async function copyPhoneLink() {
  try {
    const s = await (await fetch(`${BASE}/api/setup/status`, { signal: AbortSignal.timeout(3000) })).json();
    if (s.phoneUrl) {
      clipboard.writeText(s.phoneUrl);
      new Notification({ title: appName, body: "Phone link copied. Open it on your iPhone with Tailscale on.", icon: ICON }).show();
    }
  } catch {
    /* nothing to copy */
  }
}

async function refreshTray() {
  if (!tray) return;
  const ok = await healthy();
  if (ok) await refreshName();
  if (ok !== running) {
    running = ok;
    tray.setImage(ok ? ICON : ICON_OFF);
  }
  tray.setToolTip(ok ? `${appName} is running` : `${appName} is stopped`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: ok ? `${appName} is running` : `${appName} is stopped`, enabled: false },
      { label: `Open ${appName}`, click: showWindow },
      { label: "Copy phone link", enabled: ok, click: () => void copyPhoneLink() },
      { type: "separator" },
      ok
        ? { label: `Restart ${appName}`, click: () => void restartEngine() }
        : { label: `Start ${appName}`, click: () => void ensureRunning().then(refreshTray) },
      {
        label: "Open this app at Windows sign-in",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] }),
      },
      { type: "separator" },
      {
        label: `Quit this app (${appName} keeps running)`,
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/** First run of the installed app: sit in the tray from Windows sign-in (the user can untick it). */
function firstRunDefaults() {
  const marker = path.join(app.getPath("userData"), "first-run-done");
  if (fs.existsSync(marker)) return;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, new Date().toISOString());
}

// Files → Add folder: the Windows folder picker, only for Tavi's own page.
ipcMain.handle("lh:pick-folder", async (e) => {
  if (!e.senderFrame || !ours(e.senderFrame.url)) return null;
  const r = await dialog.showOpenDialog(win, { title: `Choose a folder for ${appName} to read`, properties: ["openDirectory"] });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

app.whenReady().then(() => {
  firstRunDefaults();
  tray = new Tray(ICON_OFF);
  tray.setToolTip("Tavi");
  tray.on("click", showWindow);
  createWindow();
  void refreshTray();
  setInterval(() => void refreshTray(), 15_000);
});
app.on("before-quit", () => {
  quitting = true;
});
app.on("window-all-closed", () => {
  /* stay in the tray */
});
