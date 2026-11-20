// Serves the built phone and desktop apps (web/dist, from ui/) under /app/. Only files inside web/dist, only known
// types; hashed assets are cached for good, HTML is always revalidated so a new build shows up on the next open.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

export const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");

export function entryPage(pathname: string, team = process.env.LH_V3 === "1"): { file: string; local: boolean } | null {
  if (["/", "/index.html", "/v2"].includes(pathname)) return { file: path.join(DIST, "phone.html"), local: false };
  if (pathname === "/desktop") return { file: path.join(DIST, team ? "hq.html" : "desktop.html"), local: true };
  if (pathname === "/app/desktop.html" || team && pathname === "/desktop-classic") return { file: path.join(DIST, "desktop.html"), local: true };
  return null;
}

/**
 * Security headers for every page. The new apps load nothing from anywhere else: scripts and fonts are bundled, voice
 * is WebRTC set up through this gateway (not covered by connect-src), so 'self' and this host's WebSocket are enough.
 * Inline style attributes are allowed (the apps build some markup with them); inline scripts are not.
 * legacy: the original phone and Setup pages, which load GSAP, three.js and fonts from CDNs, until they're retired.
 */
export function pageHeaders(host: string | undefined, legacy = false): Record<string, string> {
  const ws = host && /^[\w.:[\]-]+$/.test(host) ? ` ws://${host} wss://${host}` : " ws: wss:";
  const csp = legacy
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        `connect-src 'self'${ws} https://cdn.jsdelivr.net`,
        "media-src 'self' blob: data:",
        "worker-src 'self'",
      ]
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: blob:",
        `connect-src 'self'${ws}`,
        "media-src 'self' blob: data:",
        "worker-src 'self'",
        "manifest-src 'self'",
      ];
  csp.push("object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'");
  return { "Content-Security-Policy": csp.join("; "), "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/**
 * The file a /app/... request maps to, or null. Takes the pathname exactly as `new URL()` gives it (still
 * percent-encoded, dot segments already removed) and refuses anything that could reach outside web/dist.
 */
export function appFile(pathname: string): string | null {
  if (!pathname.startsWith("/app/")) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice("/app/".length));
  } catch {
    return null;
  }
  if (!rel || rel.includes("\0") || rel.includes("\\") || rel.includes(":")) return null;
  if (rel.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return null;
  if (!TYPES[path.extname(rel).toLowerCase()]) return null;
  const file = path.resolve(DIST, rel);
  return file.startsWith(DIST + path.sep) ? file : null;
}

export function cacheControl(file: string) {
  if (file.endsWith(".html")) return "no-cache";
  return path.relative(DIST, file).startsWith("assets" + path.sep) ? "public, max-age=31536000, immutable" : "public, max-age=3600";
}

/** Sends one built file, or 404 / 503 (not built yet). */
export async function serveApp(res: ServerResponse, file: string | null, host?: string) {
  if (!existsSync(DIST)) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return res.end("UI not built. Run npm run build:ui.");
  }
  if (!file || !existsSync(file)) {
    res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ error: "not found" }));
  }
  const page = file.endsWith(".html") ? pageHeaders(host) : {};
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()], "Cache-Control": cacheControl(file), "X-Content-Type-Options": "nosniff", ...page });
  res.end(await readFile(file));
}
