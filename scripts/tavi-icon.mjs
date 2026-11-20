// Builds the Windows icons for the Tavi program from the app's own picture (ui/public/icons/icon-512.png):
// desktop/assets/tavi.ico, and tavi-off.ico (greyed) for the tray when Tavi isn't running.
// Each size is drawn by Edge as a rounded tile and stored as a PNG inside the ICO, which Windows supports.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(root, "ui", "public", "icons", "icon-512.png")).toString("base64");
const SIZES = [256, 64, 48, 32, 24, 16];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
async function render(filter) {
  const pngs = [];
  for (const s of SIZES) {
    // Small sizes show the face larger inside the tile so it still reads in the taskbar.
    const zoom = s <= 32 ? 1.35 : 1.12;
    await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${s}px;height:${s}px;border-radius:${Math.round(s * 0.23)}px;overflow:hidden;filter:${filter}"><img src="data:image/png;base64,${src}" width="${s}" height="${s}" style="display:block;transform:scale(${zoom})"></div></body></html>`);
    await page.waitForTimeout(50);
    pngs.push(await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } }));
  }
  return pngs;
}
const on = await render("none");
const off = await render("grayscale(1) opacity(0.6)");
await browser.close();

// ICO: 6-byte header, a 16-byte entry per image, then the PNG bytes.
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(SIZES.length, 4);
  let offset = 6 + 16 * SIZES.length;
  const entries = SIZES.map((s, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0);
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs]);
}
for (const [name, pngs] of [["tavi.ico", on], ["tavi-off.ico", off]]) {
  const out = path.join(root, "desktop", "assets", name);
  writeFileSync(out, ico(pngs));
  console.log(`wrote ${out} (${SIZES.join(", ")} px)`);
}
