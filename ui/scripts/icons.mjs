// Draws the home-screen icons from Pebble itself (orange, the mockup's default day, on the dark page colour) into
// ui/public/icons, copies them over the original pages' icons in web/icons, and draws web/icons/pebble-512.png
// (Pebble alone on a transparent background) for the Windows app icon. Run from the repo root after changing Pebble:
//   node ui/scripts/icons.mjs && node scripts/make-icon.mjs
import { chromium } from "playwright-core";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../public/icons");
mkdirSync(out, { recursive: true });

// Pebble's body at rest (same shape maths as pebble.ts with no wobble), eyes, highlight; nothing else.
const pts = [];
for (let i = 0; i < 44; i++) {
  const a = (i / 44) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
  const flat = s > 0 ? 1 - 0.08 * s * s : 1;
  pts.push([100 + 66 * Math.sign(c) * Math.pow(Math.abs(c), 2 / 2.35), 116 + 60 * Math.sign(s) * Math.pow(Math.abs(s), 2 / 2.35) * flat]);
}
const f = (n) => Math.round(n * 100) / 100;
let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
for (let i = 0; i < 44; i++) {
  const p0 = pts[(i + 43) % 44], p1 = pts[i], p2 = pts[(i + 1) % 44], p3 = pts[(i + 2) % 44];
  d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
}
d += "Z";
const pebble = (scale, bg = true) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%">
  <defs><radialGradient id="g" cx=".36" cy=".28" r=".9"><stop offset="0" stop-color="#FFC08F"/><stop offset="1" stop-color="#E8611A"/></radialGradient>
  <radialGradient id="l" cx=".5" cy=".42" r=".6"><stop offset="0" stop-color="#1B2126"/><stop offset="1" stop-color="#0C0E10"/></radialGradient></defs>
  ${bg ? '<rect width="200" height="200" fill="url(#l)"/>' : ""}
  <g transform="translate(100 104) scale(${scale}) translate(-100 -116)">
    <path d="${d}" fill="url(#g)"/>
    <ellipse cx="76" cy="84" rx="19" ry="9" fill="#fff" opacity=".32" transform="rotate(-28 76 84)"/>
    <rect x="76.5" y="98" width="13" height="24" rx="6.5" fill="#1A120C"/><rect x="110.5" y="98" width="13" height="24" rx="6.5" fill="#1A120C"/>
    <circle cx="85.5" cy="103" r="2.2" fill="#fff"/><circle cx="119.5" cy="103" r="2.2" fill="#fff"/>
  </g></svg>`;

const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage();
for (const [name, px, scale] of [["icon-192.png", 192, 1.05], ["icon-512.png", 512, 1.05], ["maskable-512.png", 512, 0.78], ["apple-touch-icon.png", 180, 1.0]]) {
  await p.setViewportSize({ width: px, height: px });
  await p.setContent(`<html><body style="margin:0;background:#0C0E10">${pebble(scale)}</body></html>`);
  await p.screenshot({ path: path.join(out, name), omitBackground: false });
}
// The original phone page and Setup use /icons/*: same Pebble.
const web = path.resolve(here, "../../web/icons");
for (const name of ["icon-192.png", "icon-512.png", "apple-touch-icon.png"]) copyFileSync(path.join(out, name), path.join(web, name));
// Windows: Pebble alone, filling the square, no background (the taskbar and desktop supply their own).
await p.setViewportSize({ width: 512, height: 512 });
await p.setContent(`<html><body style="margin:0;background:transparent">${pebble(1.38, false)}</body></html>`);
await p.screenshot({ path: path.join(web, "pebble-512.png"), omitBackground: true });
await b.close();
console.log(`icons written to ${out} and ${web}`);
