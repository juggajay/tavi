// A sheet as SVG (Stage 12.4): for the tests and for looking at. Page millimetres, y flipped for the screen. Text in
// Helvetica (Arial has the same widths, so boxes measured for the PDF hold here too).
import { CAP, PAGE, type Prim, type Sheet } from "./prims.js";

const f = (v: number) => (Math.round(v * 1000) / 1000).toString();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function sheetSvg(sheet: Sheet, opts: { px?: number } = {}): string {
  const H = PAGE[1];
  const Y = (y: number) => f(H - y);
  const stroke = (p: { w: number; dash?: readonly number[] }) => `stroke="#000" stroke-width="${f(p.w)}"${p.dash ? ` stroke-dasharray="${p.dash.map(f).join(" ")}" stroke-linecap="butt"` : ' stroke-linecap="round"'} stroke-linejoin="round"`;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE[0]} ${PAGE[1]}" width="${opts.px ?? PAGE[0]}${opts.px ? "" : "mm"}" height="${opts.px ? Math.round((opts.px * PAGE[1]) / PAGE[0]) : PAGE[1] + "mm"}">`);
  out.push(`<rect width="${PAGE[0]}" height="${PAGE[1]}" fill="#fff"/>`);
  for (const p of sheet.prims) out.push(primSvg(p, Y, stroke));
  out.push("</svg>");
  return out.join("\n");
}

function primSvg(p: Prim, Y: (y: number) => string, stroke: (p: { w: number; dash?: readonly number[] }) => string): string {
  switch (p.t) {
    case "line":
      return `<line x1="${f(p.a[0])}" y1="${Y(p.a[1])}" x2="${f(p.b[0])}" y2="${Y(p.b[1])}" ${stroke(p)}/>`;
    case "poly": {
      const pts = p.pts.map((q) => `${f(q[0])},${Y(q[1])}`).join(" ");
      if (p.fill) return `<polygon points="${pts}" fill="#000" stroke="none"/>`;
      return `<${p.closed ? "polygon" : "polyline"} points="${pts}" fill="none" ${stroke(p)}/>`;
    }
    case "circle":
      return `<circle cx="${f(p.c[0])}" cy="${Y(p.c[1])}" r="${f(p.r)}" ${p.fill ? 'fill="#000" stroke="none"' : `fill="none" ${stroke(p)}`}/>`;
    case "arc": {
      const a0 = (p.a0 * Math.PI) / 180,
        a1 = (p.a1 * Math.PI) / 180;
      if (a1 - a0 >= 2 * Math.PI - 1e-6) return `<circle cx="${f(p.c[0])}" cy="${Y(p.c[1])}" r="${f(p.r)}" fill="none" ${stroke(p)}/>`;
      const x0 = p.c[0] + p.r * Math.cos(a0),
        y0 = p.c[1] + p.r * Math.sin(a0),
        x1 = p.c[0] + p.r * Math.cos(a1),
        y1 = p.c[1] + p.r * Math.sin(a1);
      return `<path d="M${f(x0)},${Y(y0)} A${f(p.r)},${f(p.r)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 0 ${f(x1)},${Y(y1)}" fill="none" ${stroke(p)}/>`;
    }
    case "text": {
      const size = p.h / CAP;
      const dy = p.base === "baseline" ? 0 : p.base === "middle" ? p.h / 2 : p.h;
      const anchor = p.anchor === "start" ? "start" : p.anchor === "middle" ? "middle" : "end";
      // the baseline sits dy below the anchor (in the text's own direction)
      const bx = p.rot === 90 ? p.at[0] + dy : p.at[0],
        by = p.rot === 90 ? p.at[1] : p.at[1] - dy;
      const rot = p.rot === 90 ? ` transform="rotate(-90 ${f(bx)} ${Y(by)})"` : "";
      return `<text x="${f(bx)}" y="${Y(by)}" font-family="Helvetica, Arial, sans-serif" font-size="${f(size)}"${p.bold ? ' font-weight="bold"' : ""} text-anchor="${anchor}"${rot}>${esc(p.s)}</text>`;
    }
  }
}
