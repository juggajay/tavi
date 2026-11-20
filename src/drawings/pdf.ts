// A sheet set as a PDF (Stage 12.4), written here: real A3 pages (420 × 297 mm), real line widths, dashes in paper
// millimetres, hatches as real lines, text in the built-in Helvetica (no font file). Everything is vector; the only
// picture there can be is the company's logo (a JPEG or PNG from the profile). Server only (it compresses with zlib).
import { deflateSync, inflateSync } from "node:zlib";
import { CAP, EXTRA, PAGE, type Prim, type Sheet, textWidth } from "../shared/drawing/prims.js";

const PT = 72 / 25.4; // points per mm

const n = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

/** Text to a PDF string in WinAnsi: brackets and backslashes escaped; anything it can't show becomes "?". */
function pdfString(s: string) {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    let b: number;
    if (c >= 32 && c <= 126) b = c;
    else if (EXTRA[ch]) b = EXTRA[ch][0];
    else b = 63;
    if (b === 40 || b === 41 || b === 92) out += "\\" + String.fromCharCode(b);
    else if (b < 128) out += String.fromCharCode(b);
    else out += "\\" + b.toString(8).padStart(3, "0");
  }
  return `(${out})`;
}

export type Logo = { kind: "jpeg" | "png"; data: Uint8Array };

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number, move = true) {
  const parts: string[] = [];
  const total = a1 - a0;
  const steps = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2)));
  const d = total / steps;
  const k = (4 / 3) * Math.tan(d / 4);
  let a = a0;
  if (move) parts.push(`${n(cx + r * Math.cos(a))} ${n(cy + r * Math.sin(a))} m`);
  for (let i = 0; i < steps; i++) {
    const b = a + d;
    const p1 = [cx + r * (Math.cos(a) - k * Math.sin(a)), cy + r * (Math.sin(a) + k * Math.cos(a))];
    const p2 = [cx + r * (Math.cos(b) + k * Math.sin(b)), cy + r * (Math.sin(b) - k * Math.cos(b))];
    parts.push(`${n(p1[0])} ${n(p1[1])} ${n(p2[0])} ${n(p2[1])} ${n(cx + r * Math.cos(b))} ${n(cy + r * Math.sin(b))} c`);
    a = b;
  }
  return parts.join("\n");
}

function content(sheet: Sheet, logo: { name: string; at: [number, number, number, number] } | null): string {
  const out: string[] = [];
  // work in millimetres from here on
  out.push(`${PT.toFixed(9)} 0 0 ${PT.toFixed(9)} 0 0 cm`, "1 j"); // exactly: a rounded factor would make 100 mm read 100.01
  let curW = -1,
    curDash = "",
    curCap = -1;
  const style = (w: number, dash?: readonly number[]) => {
    if (w !== curW) out.push(`${n(w)} w`), (curW = w);
    const d = dash ? `[${dash.map(n).join(" ")}] 0 d` : "[] 0 d";
    if (d !== curDash) out.push(d), (curDash = d);
    const cap = dash ? 0 : 1;
    if (cap !== curCap) out.push(`${cap} J`), (curCap = cap);
  };
  for (const p of sheet.prims) out.push(...primPdf(p, style));
  if (logo) out.push(`q ${n(logo.at[2])} 0 0 ${n(logo.at[3])} ${n(logo.at[0])} ${n(logo.at[1])} cm /${logo.name} Do Q`);
  return out.join("\n");
}

function primPdf(p: Prim, style: (w: number, dash?: readonly number[]) => void): string[] {
  switch (p.t) {
    case "line":
      style(p.w, p.dash);
      return [`${n(p.a[0])} ${n(p.a[1])} m ${n(p.b[0])} ${n(p.b[1])} l S`];
    case "poly": {
      if (p.pts.length < 2) return [];
      const path = p.pts.map((q, i) => `${n(q[0])} ${n(q[1])} ${i ? "l" : "m"}`).join(" ");
      if (p.fill) return [`${path} h f`];
      style(p.w, p.dash);
      return [`${path} ${p.closed ? "s" : "S"}`];
    }
    case "circle":
      if (p.fill) return [arcPath(p.c[0], p.c[1], p.r, 0, 2 * Math.PI) + " h f"];
      style(p.w, p.dash);
      return [arcPath(p.c[0], p.c[1], p.r, 0, 2 * Math.PI) + " h S"];
    case "arc":
      style(p.w, p.dash);
      return [arcPath(p.c[0], p.c[1], p.r, (p.a0 * Math.PI) / 180, (p.a1 * Math.PI) / 180) + " S"];
    case "text": {
      const size = p.h / CAP;
      const w = textWidth(p.s, p.h, p.bold);
      const dx = p.anchor === "start" ? 0 : p.anchor === "middle" ? -w / 2 : -w;
      const dy = p.base === "baseline" ? 0 : p.base === "middle" ? -p.h / 2 : -p.h;
      const font = p.bold ? "F2" : "F1";
      if (p.rot === 90) {
        // reading upwards: the text's x runs up the page, its y to the left
        return [`BT /${font} ${n(size)} Tf 0 1 -1 0 ${n(p.at[0] - dy)} ${n(p.at[1] + dx)} Tm ${pdfString(p.s)} Tj ET`];
      }
      return [`BT /${font} ${n(size)} Tf 1 0 0 1 ${n(p.at[0] + dx)} ${n(p.at[1] + dy)} Tm ${pdfString(p.s)} Tj ET`];
    }
  }
}

/** A PNG's pixels to what a PDF image wants: samples (RGB or grey) and, if it has one, the alpha as a separate mask. */
function readPng(data: Uint8Array): { w: number; h: number; colors: 1 | 3; rgb: Uint8Array; alpha?: Uint8Array } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8,
    w = 0,
    h = 0,
    depth = 0,
    ctype = 0,
    interlace = 0;
  const idat: Uint8Array[] = [];
  while (o < data.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...data.subarray(o + 4, o + 8));
    const body = data.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      const b = new DataView(body.buffer, body.byteOffset, body.byteLength);
      w = b.getUint32(0);
      h = b.getUint32(4);
      depth = body[8];
      ctype = body[9];
      interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (depth !== 8 || interlace || ![0, 2, 4, 6].includes(ctype)) throw new Error("logo PNG must be 8-bit, not interlaced, grey or RGB");
  const ch = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 4 ? 2 : 4;
  const raw = inflateSync(Buffer.concat(idat.map((b) => Buffer.from(b))));
  const stride = w * ch;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x];
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0;
      let v = cur;
      if (f === 1) v = cur + a;
      else if (f === 2) v = cur + b;
      else if (f === 3) v = cur + ((a + b) >> 1);
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a),
          pb = Math.abs(pp - b),
          pc = Math.abs(pp - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * stride + x] = v & 255;
    }
  }
  const colors = ch <= 2 ? 1 : 3;
  const rgb = new Uint8Array(w * h * colors);
  const alpha = ch === 2 || ch === 4 ? new Uint8Array(w * h) : undefined;
  for (let i = 0; i < w * h; i++) {
    for (let k = 0; k < colors; k++) rgb[i * colors + k] = px[i * ch + k];
    if (alpha) alpha[i] = px[i * ch + ch - 1];
  }
  return { w, h, colors, rgb, alpha };
}

function jpegSize(data: Uint8Array): { w: number; h: number; colors: number } {
  let o = 2;
  while (o < data.length) {
    if (data[o] !== 0xff) break;
    const m = data[o + 1];
    const len = (data[o + 2] << 8) | data[o + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (data[o + 5] << 8) | data[o + 6], w: (data[o + 7] << 8) | data[o + 8], colors: data[o + 9] };
    o += 2 + len;
  }
  throw new Error("couldn't read the logo JPEG");
}

export type PdfInfo = { title: string; subject?: string; author?: string; date?: Date };

/**
 * The whole set as one PDF. logo, if given, is placed at logoAt (x, y, width, height in mm) on every sheet, its shape
 * kept. Returns the file's bytes.
 */
export function setPdf(sheets: Sheet[], info: PdfInfo, logo?: Logo & { at: [number, number, number, number] }): Uint8Array {
  const objs: (string | Uint8Array)[] = [];
  const add = (o: string | Uint8Array) => (objs.push(o), objs.length);
  const enc = new TextEncoder();
  const stream = (dict: string, body: Uint8Array) => {
    const head = enc.encode(`<< ${dict} /Length ${body.length} >>\nstream\n`);
    const tail = enc.encode("\nendstream");
    const out = new Uint8Array(head.length + body.length + tail.length);
    out.set(head, 0);
    out.set(body, head.length);
    out.set(tail, head.length + body.length);
    return out;
  };
  const catalog = add(""); // filled in below
  const pages = add("");
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  let logoRef = 0;
  let logoPlace: [number, number, number, number] | null = null;
  if (logo) {
    let w: number, h: number;
    if (logo.kind === "jpeg") {
      const s = jpegSize(logo.data);
      w = s.w;
      h = s.h;
      logoRef = add(stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${s.colors === 1 ? "DeviceGray" : s.colors === 4 ? "DeviceCMYK" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode`, logo.data));
    } else {
      const png = readPng(logo.data);
      w = png.w;
      h = png.h;
      const mask = png.alpha ? add(stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(png.alpha))) : 0;
      logoRef = add(stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${png.colors === 1 ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 /Filter /FlateDecode${mask ? ` /SMask ${mask} 0 R` : ""}`, deflateSync(png.rgb)));
    }
    // fit inside the box, keeping its shape, centred
    const [bx, by, bw, bh] = logo.at;
    const s = Math.min(bw / w, bh / h);
    logoPlace = [bx + (bw - w * s) / 2, by + (bh - h * s) / 2, w * s, h * s];
  }
  const kids: number[] = [];
  for (const sh of sheets) {
    const c = add(stream("/Filter /FlateDecode", deflateSync(enc.encode(content(sh, logoRef ? { name: "Logo", at: logoPlace! } : null)))));
    const page = add(
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${n(PAGE[0] * PT)} ${n(PAGE[1] * PT)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${logoRef ? ` /XObject << /Logo ${logoRef} 0 R >>` : ""} >> /Contents ${c} 0 R >>`,
    );
    kids.push(page);
  }
  objs[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  const d = info.date ?? new Date();
  const pd = `D:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}00Z`;
  const infoRef = add(`<< /Title ${pdfString(info.title)} /Producer (Tavi) /Creator (Tavi shop drawings)${info.subject ? ` /Subject ${pdfString(info.subject)}` : ""}${info.author ? ` /Author ${pdfString(info.author)}` : ""} /CreationDate (${pd}) >>`);
  // the file: header, objects, cross-reference table, trailer
  const chunks: Uint8Array[] = [enc.encode("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let off = chunks[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(off);
    const head = enc.encode(`${i + 1} 0 obj\n`);
    const body = typeof o === "string" ? enc.encode(o) : o;
    const tail = enc.encode("\nendobj\n");
    chunks.push(head, body, tail);
    off += head.length + body.length + tail.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  chunks.push(enc.encode(xref), enc.encode(`trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoRef} 0 R >>\nstartxref\n${off}\n%%EOF\n`));
  const total = chunks.reduce((t, c) => t + c.length, 0);
  const file = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) (file.set(c, p), (p += c.length));
  return file;
}
