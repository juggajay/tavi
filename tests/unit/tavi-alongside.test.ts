import "../isolate.js"; // first
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
// @ts-expect-error a plain script with no types
import { alongside, PORT } from "../../scripts/tavi-alongside.mjs";

// The starter: Tavi's own address and data, practice rules on, and never the older assistant's data.
const root = path.resolve("made-up-root");
const voiceOn = () => ({ LH_NO_VOICE: "0", OPENAI_API_KEY: "made-up" });
const run = alongside({}, root, voiceOn);
assert.equal(PORT, 3100);
assert.equal(run.port, 3100);
assert.equal(run.host, "127.0.0.1");
assert.equal(run.folder, path.join(root, "data-v3"));
assert.equal(run.env.LH_DEV, "1");
assert.equal(run.env.LH_V3, "1");
assert.equal(run.env.LH_DATA_DIR, run.folder);
assert.equal(run.env.LH_V3_DATA, run.folder);
assert.equal(run.env.LH_NO_VOICE, "0");
assert.throws(() => alongside({ LH_DATA_DIR: path.join(root, "data") }, root, voiceOn), /live data folder/);
assert.throws(() => alongside({ LH_DATA_DIR: path.resolve("somewhere-else") }, root, voiceOn), /inside this project/);
// When the voice key cannot be read, Tavi still starts, with voice off.
const quiet = alongside({}, root, (args: string[]) => { if (args.includes("--voice")) throw new Error("no key"); return { LH_NO_VOICE: "1" }; });
assert.equal(quiet.env.LH_NO_VOICE, "1");

// The program: built to sit alongside, it uses its own name, icon and starter, and a window with no title bar.
const source = readFileSync(new URL("../../desktop/main.js", import.meta.url), "utf8");
for (const side of [true, false]) {
  let launcher = "", id = "";
  const made: { options?: Record<string, unknown> } = {};
  class Window {
    webContents = { setWindowOpenHandler() {}, on() {}, getURL: () => "" };
    constructor(options: Record<string, unknown>) { made.options = options; }
    removeMenu() {} on() {} once() {} loadURL() { return Promise.resolve(); } setTitle() {} setTitleBarOverlay() {}
  }
  const electron = {
    app: { requestSingleInstanceLock: () => true, on: () => {}, setAppUserModelId: (value: string) => { id = value; }, getPath: () => path.resolve('example-app-settings'), setPath() {}, whenReady: () => ({ then: () => {} }), isPackaged: true },
    ipcMain: { handle: () => {} }, BrowserWindow: Window, nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  };
  const api: { start?: () => void; window?: () => void; icon?: string } = {};
  runInNewContext(source + "\ncaptured.api.start = startEngine; captured.api.window = createWindow; captured.api.icon = ICON;", {
    require: (name: string) => {
      if (name === "electron") return electron;
      if (name === "./earlier.cjs") return { dashed: ["leading", "hand"].join("-") };
      if (name === "node:path") return path;
      if (name.endsWith('config.cjs')) return { loadRun: () => ({ port: 3100, folder: path.join(root, 'data-v3'), saved: false }) };
      if (name === "node:fs") return { existsSync: () => false, readFileSync: () => { throw new Error("Not a test file."); } };
      if (name === "./app-config.json") return { root, url: "http://127.0.0.1:3100", ...(side ? { alongside: true } : {}) };
      if (name === "node:child_process") return { spawn: (_: string, args: string[]) => { launcher = args[0]; return { unref: () => {} }; } };
      throw new Error("Unknown test part.");
    },
    process: { env: {}, argv: [] }, __dirname: root, URL, AbortSignal, setTimeout, encodeURIComponent,
    fetch: async () => ({ ok: false, json: async () => ({}) }), captured: { api },
  });
  api.start!(); api.window!();
  assert.equal(path.basename(launcher), side ? "tavi-alongside-hidden.vbs" : "tavi-start-hidden.vbs");
  assert.equal(id, "app.tavi.desktop");
  assert.equal(path.basename(api.icon!), "tavi.ico");
  assert.equal(made.options!.titleBarStyle, side ? "hidden" : undefined);
  assert.equal(made.options!.title, 'Tavi');
}
// Both current build entrypoints describe the same program identity.
const builder = JSON.parse(readFileSync(new URL("../../desktop/tavi-builder.json", import.meta.url), "utf8"));
const older = JSON.parse(readFileSync(new URL("../../desktop/package.json", import.meta.url), "utf8"));
assert.equal(builder.appId, older.build.appId);
assert.equal(builder.extraMetadata.name, older.name);
assert.equal(builder.productName, "Tavi");
console.log("tavi-alongside: the chosen address, data, name, icon and keeper, with current installer settings");
