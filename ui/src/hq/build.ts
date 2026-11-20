// Keep HQ's reused pages in its own bundle, so the phone's first load stays the same size.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
const hq = fileURLToPath(new URL("./", import.meta.url)).replaceAll("\\", "/");
const ui = path.resolve(hq, "../").replaceAll("\\", "/") + "/";
const shared = path.resolve(hq, "../../../src/shared").replaceAll("\\", "/") + "/";
const copy = "?lh-hq";
const firstPages = new Set(["pebble/pebble.ts", "palette.ts", "trail.ts", "sheet-viewer/viewer.ts", "items/sketch.ts", "items/model.ts", "base.css", "pebble/pebble.css", "sheet-viewer/viewer.css", "items/sketch.css"]);
const updates = new Set(["gateway.ts", "voice.ts", "items/describe.ts", "update.ts"]);
export function keepHqApart(): Plugin {
  return {
    name: "tavi-hq-pages",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes(copy)) return;
      // The kept pages get Tavi's words only in this app's copy.
      let next = code
        .replace(/Shop drawings/g, "Drawing sets").replace(/shop drawings/g, "drawing sets")
        .replace(/the weather for site/g, "the weather for my day")
        .replace(/sk-timber/g, "sk-solid")
        .replace(/(\w+)\s*===\s*["'`]timber["'`]/g, '/^tim[b]er$/.test($1 ?? "")');
      if (id.replaceAll("\\", "/").endsWith("/desktop/core.ts" + copy)) {
        // The kept pages may receive settings, but the app owns its colours.
        const start = next.indexOf('  const theme = String(state.settings["ui.theme"]');
        const end = next.indexOf('\n}', start);
        if (start < 0 || end < start) throw new Error("Check how the kept pages receive settings.");
        next = next.slice(0, start) + next.slice(end);
      }
      if (id.replaceAll("\\", "/").endsWith("/desktop/pages.ts" + copy)) {
        // HQ engines belong to individual bots. Keep the old page's work limits,
        // but remove its single-assistant effort presets from HQ's copy only.
        const start = next.indexOf('${sec("How hard it thinks")}');
        const end = next.indexOf('<div class="row"><div class="t"><b>The most one job may take</b>', start);
        if (start < 0 || end < start) throw new Error("Tavi's copied Settings page has changed; check its engine controls.");
        next = next.slice(0, start) + '${sec("Work limits")}<div class="panel">' + next.slice(end);
      }
      return next === code ? undefined : { code: next, map: null };
    },
    async resolveId(source, importer) {
      if (!importer || source.includes("?")) return;
      const from = importer.replaceAll("\\", "/");
      if (!from.startsWith(hq) && !from.endsWith(copy)) return;
      if (source.startsWith("\0")) return;
      const found = await this.resolve(source, importer.replace(copy, ""), { skipSelf: true });
      if (!found) return;
      const id = found.id.replaceAll("\\", "/");
      if (id.startsWith(hq) || !/\.(?:[cm]?[jt]sx?|css)$/.test(id)) return;
      if (id.startsWith(ui) || id.startsWith(shared) || id.includes("/node_modules/three/")) return { ...found, id: found.id + copy };
    },
    outputOptions(options) {
      return { ...options, manualChunks(id) {
        const file = id.replaceAll("\\", "/");
        if (file.includes(copy)) return;
        if (file === "\0vite/preload-helper.js" || file === "\0vite/modulepreload-polyfill.js") return "model";
        const relative = file.startsWith(ui + "shared/") ? file.slice((ui + "shared/").length) : "";
        if (firstPages.has(relative)) return "model";
        if (updates.has(relative) || file === shared + "build.ts") return "update";
      } };
    },
    generateBundle(_options, bundle) {
      const files = Object.values(bundle).filter(file => file.type === "chunk" && Object.keys(file.modules).some(id => id.replaceAll("\\", "/").startsWith(hq) || id.includes(copy))).map(file => file.fileName);
      files.push(...Object.keys(bundle).filter(file => /^assets\/hq-.*\.css$/.test(file)));
      this.emitFile({ type: "asset", fileName: "hq-files.json", source: JSON.stringify(files) });
    },
  };
}
