// Phone and desktop apps, built into ../web/dist and served by the gateway under /app/ (see src/gateway/server.ts).
// Dev server: npm run dev:ui (port 5178), talking to the dev gateway on 3078.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { keepHqApart } from "./src/hq/build";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const gateway = process.env.LH_GATEWAY ?? "http://127.0.0.1:3078";

export default defineConfig({
  plugins: [react(), keepHqApart()],
  base: "/app/",
  build: {
    outDir: path.resolve(here, "../web/dist"),
    emptyOutDir: true,
    assetsDir: "assets",
    rollupOptions: {
      input: {
        phone: path.resolve(here, "phone.html"),
        desktop: path.resolve(here, "desktop.html"),
        gallery: path.resolve(here, "gallery.html"),
        hq: path.resolve(here, "hq.html"),
      },
    },
  },
  server: {
    port: 5178,
    strictPort: true,
    fs: { allow: [here, path.resolve(here, "../src/shared")] },
    proxy: {
      "/api": gateway,
      "/oauth": gateway,
      "/ws": { target: gateway.replace(/^http/, "ws"), ws: true },
    },
  },
});
