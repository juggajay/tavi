import { createHash } from "node:crypto";
import type { Page } from "../shared/pages/shape.js";
import { mountPage, PAGE_CSS } from "../shared/pages/render.js";

/** Only our own search code runs. The file never needs the app or a connection. */
export function pageFile(page: Page): string {
  const portable = structuredClone(page);
  const pictures = [...(portable.cover ? [portable.cover] : []), ...portable.blocks.flatMap(b => b.type === "picture" ? [b.picture] : b.type === "steps" ? b.steps.flatMap(s => s.picture ? [s.picture] : []) : b.type === "collection" ? b.entries.flatMap(e => e.picture ? [e.picture] : []) : [])];
  for (const p of pictures) if (p.pending) { delete p.pending; p.made = true; p.missing = "Not included in this saved page."; }
  for (const block of portable.blocks) {
    if (block.type === "paragraph") for (const part of block.parts) delete part.url;
    if (block.type === "collection") for (const entry of block.entries) {
      if (entry.place?.type === "web") { entry.subtitle = [entry.subtitle, entry.place.url.replace(/^https?:\/\//, "")].filter(Boolean).join(" · "); delete entry.place; }
    }
  }
  // Source addresses stay readable, without becoming requests or links in a saved file.
  const data = JSON.stringify(portable).replace(/https?:\/\//g, "").replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const script = `const __name=(fn)=>fn;(${mountPage.toString()})(document.getElementById('page'),${data},{offline:true});`;
  const hash = createHash("sha256").update(script).digest("base64");
  const title = page.title.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; connect-src 'none'"><title>${title}</title><style>html,body{margin:0;background:#F5EEE5}body{min-height:100vh}@media(prefers-color-scheme:dark){html,body{background:#17181D}}${PAGE_CSS}</style></head><body><main id="page"></main><noscript>This page needs scripts turned on for its search and entries.</noscript><script>${script}</script></body></html>`;
}
