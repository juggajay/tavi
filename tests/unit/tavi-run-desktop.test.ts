import "../isolate.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";

const source = readFileSync(new URL("../../desktop/main.js", import.meta.url), "utf8");
for (const team of [false, true]) {
  let page = "", title = "", launcher = "";
  const configRoot = path.resolve("made-up-desktop");
  const electron = {
    app: { requestSingleInstanceLock: () => true, on: () => {}, setAppUserModelId: () => {}, getPath: () => configRoot, setPath: () => {}, whenReady: () => ({ then: () => {} }), isPackaged: true },
    ipcMain: { handle: () => {} },
  };
  const files = {
    existsSync: (file: string) => file.endsWith("tavi-launch.json") && team,
    readFileSync: (file: string) => {
      if (file.endsWith("tavi-launch.json") && team) return JSON.stringify({ data: "made-up-practice" });
      if (file.endsWith("tavi-status.json")) return JSON.stringify({ reason: "The safety switch will not stay up." });
      throw new Error("Not a test file.");
    },
  };
  const api: { name?: () => Promise<void>; starting?: () => Promise<void>; start?: () => void; app?: string } = {};
  runInNewContext(source + "\nwin = { loadURL: async url => { captured.page(url); }, setTitle: value => captured.title(value), webContents: { getURL: () => '' } }; captured.api.name = refreshName; captured.api.starting = () => showStarting(true); captured.api.start = startEngine; captured.api.app = APP;", {
    require: (name: string) => {
      if (name === "electron") return electron;
      if (name === "./earlier.cjs") return { dashed: ["leading", "hand"].join("-") };
      if (name === "node:path") return path;
      if (name === "node:fs") return files;
      if (name === "./app-config.json") return { root: configRoot, url: "http://127.0.0.1:4321" };
      if (name === "node:child_process") return { spawn: (_: string, args: string[]) => { launcher = args[0]; return { unref: () => {} }; } };
      throw new Error("Unknown test part.");
    },
    process: { env: {}, argv: [] }, __dirname: configRoot, URL, AbortSignal,
    fetch: async (url: string) => ({ ok: true, json: async () => url.endsWith("/api/health") ? { name: team ? "Tavi" : undefined } : { on: team } }),
    captured: { api, page: (value: string) => { page = value; }, title: (value: string) => { title = value; } },
  });
  await api.name!(); await api.starting!(); api.start!();
  const html = decodeURIComponent(page.split(",").slice(1).join(",")).replaceAll("&#39;", "'");
  assert.ok(html.includes("Tavi didn't start"));
  assert.ok(html.includes("The safety switch will not stay up."));
  assert.equal(title, 'Tavi');
  assert.equal(api.app, "http://127.0.0.1:4321/desktop");
  assert.equal(path.basename(launcher), "tavi-start-hidden.vbs");
}
console.log("Tavi desktop: the server's name, starting page, saved failure reason and correct launcher passed.");
